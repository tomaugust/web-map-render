import * as THREE from 'three';
import { createPicker } from './pick.js';
import { createGpuParticles } from './gpuParticles.js';
import { classCoverages, vectorDraw, WATERWAY } from './vectors.js';

// ---------------------------------------------------------------------------------------------
// Wildfire: a stochastic cellular automaton over a fuel map read from the map picture itself.
//   fuel:  forest / grass / farmland burn well; gardens and bare land less; roads, rail, water and
//          built-up areas hardly at all (fire has to creep or throw embers across them).
//   rates: spread depends on the target's fuel, wind (fast downwind, slow upwind) and slope (uphill faster).
// Burning cells drive two GPU particle systems (flames and smoke) and an overlay (glowing front, charred ground).
// ---------------------------------------------------------------------------------------------

const FW = 448;               // fire grid width (cells), ~16 m each across the parish
const FIRE_LAPSE = 45;        // fire seconds per real second
const R0 = 0.02;              // base spread: per neighbour, per fire second, at fuel 1 in calm air
const WIND_K = 0.17;          // exp(WIND_K * wind m/s * cos) boosts spread downwind
const COARSE = matchMedia('(pointer: coarse)').matches;

// [r, g, b, kind, fuel]   kinds: 1 vegetation / open land, 2 built-up, 3 water, 4 road or rail
const PALETTE = [
  [173, 209, 158, 1, 1.00], [200, 215, 171, 1, 0.90], [205, 235, 176, 1, 0.95], [200, 250, 204, 1, 0.85],
  [238, 240, 213, 1, 0.80], [214, 217, 159, 1, 0.90], [174, 223, 163, 1, 0.80], [201, 225, 191, 1, 0.80],
  [174, 224, 203, 1, 0.60], [170, 203, 175, 1, 0.50], [242, 239, 233, 1, 0.35],
  [224, 223, 223, 2, 0.06], [235, 219, 232, 2, 0.06], [255, 214, 209, 2, 0.06], [217, 208, 201, 2, 0.05],
  [221, 221, 221, 2, 0.06], [197, 195, 195, 2, 0.06], [238, 238, 238, 2, 0.06],
  [170, 211, 223, 3, 0.00],
  [255, 255, 255, 4, 0.02], [247, 250, 191, 4, 0.02], [252, 214, 164, 4, 0.02], [249, 178, 156, 4, 0.02],
  [232, 146, 162, 4, 0.02], [187, 187, 187, 4, 0.02], [153, 153, 153, 4, 0.02],
];
const MAX_DIST2 = 20 * 20;

const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const CARDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function createWildfire({ terrain, pivot, camera, renderer, lightDir, ui }) {
  const pick = createPicker({ terrain, pivot, camera });
  const wind = { speed: 4, from: 225, x: 0, z: 0 };
  function setWindVec() {
    const to = ((wind.from + 180) * Math.PI) / 180;
    wind.x = Math.sin(to); wind.z = -Math.cos(to);          // map space: north is -z
  }
  setWindVec();

  let ready = false, active = false;
  let FH, cellM, fuelKind, fuel, burnT, state, timer, height, inside;
  let colourPx, fireTex, fuelTex, fuelPx, overlay, fuelOverlay;
  let activeList = [], burntCount = 0, showFuel = false;
  let flames, smoke, f0u, f0v, su, sv;
  let acc = 0, emitClock = 0, statClock = 0;
  const emitSmoke = new Float32Array(4096 * 4), emitFlame = new Float32Array(4096 * 4);

  // ---- Fuel from the vector data: exact roads, rail, water and land cover (preferred) ----
  const ROAD_WIDTH = { motorway: 22, trunk: 18, primary: 14, secondary: 12, tertiary: 9, minor: 6, residential: 6, service: 4.5, track: 3.5, rail: 5, transit: 5 };
  const URBAN_LAND = ['residential', 'industrial', 'commercial', 'retail', 'garages', 'school', 'hospital', 'library', 'kindergarten', 'stadium', 'religious', 'university', 'college', 'railway'];
  const VEG_FUEL = { wood: 1.0, grass: 0.95, farmland: 0.8, wetland: 0.4, pitch: 0.6, cemetery: 0.5, quarry: 0.02 };
  function fillFromVectors(grid) {
    const vec = terrain.vectors, { gw, gh } = grid, n = gw * gh;
    const feats = vec.features;
    const polys = (pred) => (ctx, proj) => { for (const f of feats) if (pred(f.properties)) vectorDraw.fillPolys(ctx, f.geometry, proj); };
    const stroke = (pred, widthOf) => (ctx, proj, mpp) => {
      for (const f of feats) {
        const p = f.properties;
        if (!pred(p) || p.brunnel === 'tunnel') continue;
        const w = widthOf(p); if (!w) continue;
        ctx.lineWidth = w / mpp; vectorDraw.strokeLines(ctx, f.geometry, proj);
      }
    };
    const specs = [
      { id: 'water', draw: (ctx, proj, mpp) => { polys((p) => p.layer === 'water')(ctx, proj); stroke((p) => p.layer === 'waterway' && (p.class === 'river' || p.class === 'canal'), (p) => WATERWAY[p.class].w)(ctx, proj, mpp); } },
      { id: 'stream', draw: stroke((p) => p.layer === 'waterway' && p.class !== 'river' && p.class !== 'canal', (p) => (WATERWAY[p.class] || { w: 1.5 }).w) },
      { id: 'road', draw: stroke((p) => p.layer === 'transportation', (p) => ROAD_WIDTH[p.class] || 0) },
      { id: 'build', draw: polys((p) => p.layer === 'building') },
      { id: 'urban', draw: polys((p) => p.layer === 'landuse' && URBAN_LAND.includes(p.class)) },
      ...Object.keys(VEG_FUEL).map((id) => ({ id, draw: polys((p) => (p.layer === 'landcover' || p.layer === 'landuse') && p.class === id) })),
    ];
    const cov = classCoverages(vec, terrain.bbox, terrain.widthM, gw, gh, specs);
    const vegIds = Object.keys(VEG_FUEL);
    for (let k = 0; k < n; k++) {
      if (!inside[k]) continue;
      if (cov.water[k] >= 0.3) { fuelKind[k] = 3; fuel[k] = 0; continue; }
      if (cov.road[k] >= 0.2) { fuelKind[k] = 4; fuel[k] = 0.05; continue; }
      if (cov.build[k] >= 0.3 || cov.urban[k] >= 0.5) { fuelKind[k] = 2; fuel[k] = 0.06; continue; }
      let best = 0, bf = 0.35;                                          // unmapped ground (gardens, verges): weak fuel
      for (const id of vegIds) if (cov[id][k] > best && cov[id][k] >= 0.25) { best = cov[id][k]; bf = VEG_FUEL[id]; }
      let f = bf;
      if (cov.road[k] >= 0.1) f *= 0.5;                                 // a lane or track: slows the fire
      if (cov.stream[k] >= 0.08) f *= 0.25;                             // a stream or ditch: a firebreak that leaks
      fuelKind[k] = 1; fuel[k] = f;
    }
  }

  // ---- Fallback: guess from the colours of the map picture ----
  function fillFromRaster(grid) {
    const { gw: FW_, gh: FH_ } = grid;
    const src = terrain.imagery, tw = src.width, th = src.height;
    const px = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, tw, th).data;
    const cache = new Int8Array(64 * 64 * 64).fill(-2);          // quantised colour -> palette index (-1 = none)
    const classify = (r, g, b) => {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let c = cache[key];
      if (c !== -2) return c;
      let best = -1, bd = MAX_DIST2;
      for (let k = 0; k < PALETTE.length; k++) {
        const p = PALETTE[k], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      return (cache[key] = best);
    };
    for (let j = 0; j < FH; j++) for (let i = 0; i < FW; i++) {
      const k = j * FW + i;
      if (!inside[k]) continue;                                  // outside the parish: nothing to burn
      const x0 = Math.floor((i * tw) / FW), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * tw) / FW));
      const y0 = Math.floor((j * th) / FH), y1 = Math.max(y0 + 1, Math.floor(((j + 1) * th) / FH));
      let cntV = 0, sumV = 0, cntU = 0, cntW = 0, cntR = 0, tot = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * tw + x) * 4, c = classify(px[o], px[o + 1], px[o + 2]);
        tot++;
        if (c < 0) continue;                                     // labels, symbols: no opinion
        const p = PALETTE[c];
        if (p[3] === 1) { cntV++; sumV += p[4]; } else if (p[3] === 2) cntU++; else if (p[3] === 3) cntW++; else cntR++;
      }
      // A thin line (road, rail, stream) only covers part of a cell, so give barriers priority at modest coverage.
      if (cntW >= 0.3 * tot) { fuelKind[k] = 3; fuel[k] = 0; }
      else if (cntR >= 0.2 * tot) { fuelKind[k] = 4; fuel[k] = 0.05; }
      else if (cntU >= 0.45 * tot) { fuelKind[k] = 2; fuel[k] = 0.06; }
      else { fuelKind[k] = 1; fuel[k] = cntV > 0 ? sumV / cntV : 0.3; }
    }
  }

  // ---- Fuel map ----
  function buildFuel() {
    const grid = terrain.gridData(FW);
    FH = grid.gh; cellM = grid.cellM; height = grid.heights; inside = grid.inside;
    const n = FW * FH;
    fuelKind = new Uint8Array(n); fuel = new Float32Array(n);
    if (terrain.vectors) fillFromVectors(grid); else fillFromRaster(grid);
    burnT = new Float32Array(n);
    for (let k = 0; k < n; k++) burnT[k] = 25 + 60 * fuel[k];
    state = new Uint8Array(n); timer = new Float32Array(n);
  }

  // ---- Overlays (one texel per cell, one for fire/char, one to show the fuel map) ----
  function buildOverlays() {
    const n = FW * FH;
    colourPx = new Uint8Array(n * 4);
    fireTex = new THREE.DataTexture(colourPx, FW, FH, THREE.RGBAFormat);
    fuelPx = new Uint8Array(n * 4);
    fuelTex = new THREE.DataTexture(fuelPx, FW, FH, THREE.RGBAFormat);
    for (const t of [fireTex, fuelTex]) { t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.LinearFilter; }
    const mk = (tex, order, offset) => {
      const m = new THREE.Mesh(terrain.top.geometry, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset,
      }));
      m.renderOrder = order; m.visible = false; terrain.group.add(m); return m;
    };
    fuelOverlay = mk(fuelTex, 0, -2);
    overlay = mk(fireTex, 1, -3);
    for (let j = 0; j < FH; j++) for (let i = 0; i < FW; i++) {
      const k = j * FW + i, o = ((FH - 1 - j) * FW + i) * 4;      // texture row 0 is the south edge
      let r = 0, g = 0, b = 0, a = 0;
      if (inside[k]) {
        a = 150;
        if (fuelKind[k] === 1) { r = 255 - 200 * fuel[k]; g = 200 + 40 * fuel[k]; b = 60; }       // flammable: greener = more fuel
        else if (fuelKind[k] === 2) { r = 150; g = 150; b = 160; }
        else if (fuelKind[k] === 3) { r = 60; g = 120; b = 230; }
        else { r = 240; g = 110; b = 40; }
      }
      fuelPx[o] = r; fuelPx[o + 1] = g; fuelPx[o + 2] = b; fuelPx[o + 3] = a;
    }
    fuelTex.needsUpdate = true;
  }

  const paint = (k, r, g, b, a) => {
    const i = k % FW, j = (k / FW) | 0, o = ((FH - 1 - j) * FW + i) * 4;
    colourPx[o] = r; colourPx[o + 1] = g; colourPx[o + 2] = b; colourPx[o + 3] = a;
  };

  // ---- Fire spread ----
  function ignite(k) {
    state[k] = 1; timer[k] = burnT[k] * (0.8 + 0.4 * Math.random());
    activeList.push(k);
  }

  function step(dtF) {
    const U = wind.speed, spot = 0.0006 * U;
    const n0 = activeList.length;          // cells lit during this step wait until the next one
    const next = [];
    for (let a = 0; a < n0; a++) {
      const k = activeList[a];
      const i = k % FW, j = (k / FW) | 0;
      const kind = fuelKind[k];
      const strength = kind === 1 ? 0.55 + 0.45 * fuel[k] : 0.25;          // a burning road verge throws far less heat than a forest
      for (let m = 0; m < 8; m++) {
        const nx = i + NB[m][0], ny = j + NB[m][1];
        if (nx < 0 || ny < 0 || nx >= FW || ny >= FH) continue;
        const t = ny * FW + nx;
        if (state[t] !== 0 || fuel[t] <= 0) continue;
        const dist = m === 0 || m === 2 || m === 5 || m === 7 ? 1.414 : 1;
        const cosA = (NB[m][0] * wind.x + NB[m][1] * wind.z) / dist;
        const windF = Math.exp(WIND_K * U * cosA);
        const slope = (height[t] - height[k]) / (dist * cellM);
        const slopeF = Math.min(3, Math.max(0.4, Math.exp(2.5 * slope)));
        const rate = (R0 * fuel[t] * strength * windF * slopeF) / dist;
        if (Math.random() < 1 - Math.exp(-rate * dtF)) ignite(t);
      }
      // Embers: carried downwind, they can land beyond a road, railway or river.
      if (spot > 0 && kind === 1 && Math.random() < spot * fuel[k] * dtF * 6) {
        const d = -Math.log(1 - Math.random()) * (3 + 2.5 * U);              // cells
        const ang = Math.atan2(wind.z, wind.x) + (Math.random() - 0.5) * 0.7;
        const tx = Math.round(i + Math.cos(ang) * d), ty = Math.round(j + Math.sin(ang) * d);
        if (tx >= 0 && ty >= 0 && tx < FW && ty < FH) {
          const t = ty * FW + tx;
          if (state[t] === 0 && fuel[t] > 0 && Math.random() < fuel[t] * 0.6) ignite(t);
        }
      }
      timer[k] -= dtF;
      if (timer[k] <= 0) {
        state[k] = 2; burntCount++;
        const c = kind === 1 ? 1 : 0.6;
        paint(k, 38 * c, 32 * c, 30 * c, 175);                              // charred ground
      } else next.push(k);
    }
    for (let a = n0; a < activeList.length; a++) next.push(activeList[a]);
    activeList = next;
  }

  function paintBurning(timeMs) {
    const flick = timeMs * 0.012;
    for (let a = 0; a < activeList.length; a++) {
      const k = activeList[a], life = timer[k] / burnT[k];                  // 1 fresh .. 0 burnt out
      const f = 0.75 + 0.25 * Math.sin(flick + k * 12.9898);
      const heat = Math.min(1, life * 1.25) * f;
      paint(k, 255, 70 + 170 * heat, 10 + 70 * heat * heat, 245);            // red -> orange -> yellow
    }
    fireTex.needsUpdate = true;
  }

  // ---- Emitters for the particle systems: a random sample of the burning cells ----
  function gatherEmitters() {
    const n = activeList.length;
    let nf = 0, ns = 0;
    const pAll = n > 4096 ? 4096 / n : 1;
    for (let a = 0; a < n; a++) {
      const k = activeList[a], life = timer[k] / burnT[k];
      if (Math.random() > pAll) continue;
      const i = k % FW, j = (k / FW) | 0;
      const x = ((i + Math.random()) / FW - f0u) / su, z = ((j + Math.random()) / FH - f0v) / sv;
      const y = terrain.surfaceY(x, z);
      if (ns < 4096) { emitSmoke.set([x, y + 0.004, z, 0.6 + 0.4 * life], ns * 4); ns++; }
      if (life > 0.35 && nf < 4096 && Math.random() < 0.3 + 0.7 * life) { emitFlame.set([x, y + 0.004, z, 1], nf * 4); nf++; }
    }
    smoke.setEmitters(emitSmoke, ns, Math.min(1, Math.max(0.03, n / 1800)));
    flames.setEmitters(emitFlame, nf, Math.min(1, Math.max(0.04, n / 350)));
  }

  function init() {
    buildFuel();
    buildOverlays();
    [f0u, f0v] = terrain.bboxFrac(0, 0);
    su = terrain.bboxFrac(1, 0)[0] - f0u; sv = terrain.bboxFrac(0, 1)[1] - f0v;
    smoke = createGpuParticles({
      terrain, pivot, camera, renderer, lightDir, side: COARSE ? 160 : 224, life: 320, timeLapse: 30,
      params: { buoy: 0.16, tauT: 80, tauD: 15, tauH: 10, spawnUp: 5, spawnJit: 1.2, sigma: 1.0, sigmaWind: 0.14, K: 3, Kwind: 0.5, windMix: true, eddyRamp: 0.3 },
      look: { density: COARSE ? 0.16 : 0.1, size0: 0.012, sizeGrow: 0.07, fadePow: 1.6, fadeIn: 8, lightAmt: 1, adapt: true, renderOrder: 2,
        col0: [0.2, 0.19, 0.19], col1: [0.48, 0.46, 0.45], col2: [0.78, 0.78, 0.8] },
    });
    flames = createGpuParticles({
      terrain, pivot, camera, renderer, lightDir, side: COARSE ? 96 : 128, life: 14, timeLapse: 8,
      params: { buoy: 0, tauT: 1e4, tauD: 1e3, tauH: 4, spawnUp: 1.4, spawnJit: 0.6, windScale: 0.35, sigma: 0.5, K: 0.5, eddyRamp: 0.1 },
      look: { density: 0.6, size0: 0.026, sizeGrow: -0.012, fadePow: 0.8, fadeIn: 0.8, lightAmt: 0, adapt: false, renderOrder: 3,
        col0: [1.0, 0.93, 0.45], col1: [1.0, 0.45, 0.08], col2: [0.5, 0.07, 0.03] },
    });
    ready = true;
  }

  function igniteAt(x, z) {
    const [fu, fv] = terrain.bboxFrac(x, z);
    const ci = Math.floor(fu * FW), cj = Math.floor(fv * FH);
    let any = false;
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      if (di * di + dj * dj > 10) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= FW || j >= FH) continue;
      const k = j * FW + i;
      if (state[k] === 0 && fuel[k] > 0.02) { ignite(k); any = true; }
    }
    return any;
  }

  function reset() {
    if (!ready) return;
    state.fill(0); activeList = []; burntCount = 0; colourPx.fill(0); fireTex.needsUpdate = true;
    smoke.clear(); flames.clear();
  }

  function update(dt) {
    if (!active || !ready) return;
    acc += dt * FIRE_LAPSE;
    let guard = 0;
    while (acc >= 0.7 && guard++ < 3) { step(0.7); acc -= 0.7; }
    if (activeList.length || burntCount) paintBurning(performance.now());
    emitClock += dt;
    if (emitClock > 0.12) { emitClock = 0; gatherEmitters(); }
    smoke.update(dt, wind);
    flames.update(dt, wind);
    statClock += dt;
    if (statClock > 0.3) {
      statClock = 0;
      const ha = ((burntCount + activeList.length) * cellM * cellM) / 1e4;
      ui.onStats?.(`Burning ${activeList.length.toLocaleString('en-GB')} cells · burnt area ${Math.round(ha).toLocaleString('en-GB')} ha · wind ${wind.speed.toFixed(0)} m/s from ${CARDS[Math.round(wind.from / 22.5) % 16]}`);
    }
  }

  return {
    enter() {
      if (!ready) init();
      active = true; overlay.visible = true; fuelOverlay.visible = showFuel;
      smoke.show(true); flames.show(true);
    },
    exit() { active = false; overlay.visible = fuelOverlay.visible = false; smoke.show(false); flames.show(false); },
    update,
    click(cx, cy, rect) {
      if (!ready) return;
      const hit = pick(cx, cy, rect);
      if (hit) igniteAt(hit[0], hit[1]);
    },
    setWindSpeed(v) { wind.speed = v; },
    setWindFrom(d) { wind.from = d; setWindVec(); },
    setShowFuel(v) { showFuel = v; if (ready) fuelOverlay.visible = v && active; },
    reset,
    /** test helper */ _ignite: (x, z) => igniteAt(x, z),
  };
}
