import * as THREE from 'three';
import { createPicker } from './pick.js';
import { waterLayerCanvas } from './vectors.js';

// Shallow-water ("virtual pipes") simulation over the parish heights.
const G = 9.8;
const DAMP = 0.97;        // friction on the flux between steps
const INFILTRATE = 2e-5;  // m of water soaked away per simulated second
const SIM_DT = 1;         // simulated seconds per substep
const SUBSTEPS = 5;       // substeps per rendered frame (time-lapse)
const GRID_W = 220;
const CHANNEL_RELAX = 0.004;   // rivers and lakes drift back to their normal level (upstream supply / outflow)

class WaterSim {
  constructor({ gw, gh, heights, inside, cellM, waterMean, waterMax }) {
    this.gw = gw; this.gh = gh; this.dx = cellM; this.inside = inside;
    const n = gw * gh;
    // Light smoothing: the 19 m elevation tiles are stepped and would leave artificial pits.
    const sm = new Float32Array(n);
    let low = Infinity;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      let sum = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj, ii = i + di;
        if (jj < 0 || ii < 0 || jj >= gh || ii >= gw) continue;
        sum += heights[jj * gw + ii]; c++;
      }
      sm[j * gw + i] = sum / c;
      if (inside[j * gw + i]) low = Math.min(low, sm[j * gw + i]);
    }
    // Everything outside the parish is a drain well below the lowest ground.
    for (let i = 0; i < n; i++) if (!inside[i]) sm[i] = low - 30;
    // Rivers, ponds and lakes: cut the channel into the ground and start it with standing water.
    this.chan = new Uint8Array(n);        // 1 = river / lake cell
    this.base = new Float32Array(n);      // normal standing water depth there (m)
    this.baseIn = new Float32Array(n);    // steady upstream inflow into stream cells (m per simulated second)
    if (waterMax) {
      for (let k = 0; k < n; k++) {
        if (!inside[k] || waterMax[k] < 0.04) continue;
        const bed = Math.max(0.45, waterMax[k]);                        // a cell-wide trench is the sim's smallest channel
        const lakeLike = Math.min(1, waterMean[k] / Math.max(waterMax[k], 1e-3));
        sm[k] -= bed;
        this.chan[k] = 1;
        this.base[k] = bed * (0.5 + 0.45 * lakeLike);
        if (lakeLike < 0.5) this.baseIn[k] = 6e-5;
      }
    }
    this.z = sm;
    this.d = Float32Array.from(this.base);
    this.qW = new Float32Array(n); this.qE = new Float32Array(n);
    this.qN = new Float32Array(n); this.qS = new Float32Array(n);
    this.offMap = 0;   // m^3 that ran off the edge
    this.rained = 0;   // m^3 added
  }

  addRain(i, j, depth) {
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return;
    const k = j * this.gw + i;
    if (!this.inside[k]) return;
    this.d[k] += depth;
    this.rained += depth * this.dx * this.dx;
  }

  step(dt) {
    const { gw, gh, z, d, qW, qE, qN, qS, dx, inside } = this;
    const lim = dx / dt;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (!inside[k]) continue;
        const h = z[k] + d[k];
        let w = 0, e = 0, n = 0, s = 0;
        if (i > 0)      w = Math.max(0, qW[k] * DAMP + dt * G * (h - z[k - 1] - d[k - 1]) / dx);
        if (i < gw - 1) e = Math.max(0, qE[k] * DAMP + dt * G * (h - z[k + 1] - d[k + 1]) / dx);
        if (j > 0)      n = Math.max(0, qN[k] * DAMP + dt * G * (h - z[k - gw] - d[k - gw]) / dx);
        if (j < gh - 1) s = Math.max(0, qS[k] * DAMP + dt * G * (h - z[k + gw] - d[k + gw]) / dx);
        const out = w + e + n + s;
        const K = out > 0 ? Math.min(1, (d[k] * lim) / out) : 1;
        qW[k] = w * K; qE[k] = e * K; qN[k] = n * K; qS[k] = s * K;
      }
    }
    const f = dt / dx;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (!inside[k]) {
          // Drain cell: whatever arrives has left the map.
          let runoff = 0;                                  // not counting what the rivers themselves carry
          if (i > 0 && !this.chan[k - 1]) runoff += qE[k - 1];
          if (i < gw - 1 && !this.chan[k + 1]) runoff += qW[k + 1];
          if (j > 0 && !this.chan[k - gw]) runoff += qS[k - gw];
          if (j < gh - 1 && !this.chan[k + gw]) runoff += qN[k + gw];
          this.offMap += runoff * f * dx * dx;
          continue;
        }
        let inflow = 0;
        if (i > 0) inflow += qE[k - 1];
        if (i < gw - 1) inflow += qW[k + 1];
        if (j > 0) inflow += qS[k - gw];
        if (j < gh - 1) inflow += qN[k + gw];
        const v = d[k] + f * (inflow - qW[k] - qE[k] - qN[k] - qS[k]) - (this.chan[k] ? 0 : INFILTRATE) * dt;
        d[k] = this.chan[k] ? Math.max(0, v + (this.base[k] - v) * CHANNEL_RELAX * dt) : (v > 0 ? v : 0);
      }
    }
  }

  volume() {
    let v = 0;
    for (let k = 0; k < this.d.length; k++) v += Math.max(0, this.d[k] - this.base[k]);   // water beyond the normal river and lake levels
    return v * this.dx * this.dx;
  }

  clear() {
    this.d.set(this.base); this.qW.fill(0); this.qE.fill(0); this.qN.fill(0); this.qS.fill(0);
    this.offMap = 0; this.rained = 0;
  }
}

export function createRain({ terrain, pivot, camera, statsEl }) {
  const grid = terrain.gridData(GRID_W);
  const sim = new WaterSim(grid);
  const { gw, gh } = grid;

  // Water overlay: one RGBA texel per sim cell, draped over the terrain mesh.
  const px = new Uint8Array(gw * gh * 4);
  const tex = new THREE.DataTexture(px, gw, gh, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const overlay = new THREE.Mesh(terrain.top.geometry, new THREE.MeshLambertMaterial({
    map: tex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  overlay.visible = false;
  overlay.renderOrder = 2;
  terrain.group.add(overlay);

  // The rivers, lakes and ponds themselves (vector data), always visible in this tab.
  let waterLayer = null;
  if (terrain.vectors && terrain.carve) {
    const tex2 = new THREE.CanvasTexture(waterLayerCanvas(terrain.vectors, terrain.bbox, terrain.carve.W, terrain.carve.H, terrain.widthM));
    tex2.colorSpace = THREE.SRGBColorSpace; tex2.anisotropy = 4;
    waterLayer = new THREE.Mesh(terrain.top.geometry, new THREE.MeshLambertMaterial({
      map: tex2, transparent: true, opacity: 0.9, depthWrite: false, alphaMap: terrain.top.material.alphaMap, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -1.5,
    }));
    waterLayer.renderOrder = 1; waterLayer.visible = false;
    terrain.group.add(waterLayer);
  }

  function paintWater() {
    const d = sim.d;
    for (let j = 0; j < gh; j++) {
      const row = (gh - 1 - j) * gw;
      for (let i = 0; i < gw; i++) {
        const dep = Math.max(0, d[j * gw + i] - sim.base[j * gw + i]), o = (row + i) * 4;   // only water above the usual river level
        const t = Math.min(1, dep / 0.6);
        px[o] = 70 - 45 * t; px[o + 1] = 150 - 70 * t; px[o + 2] = 240 - 40 * t;
        px[o + 3] = dep < 0.004 ? 0 : Math.min(235, 80 + Math.sqrt(dep) * 260);
      }
    }
    tex.needsUpdate = true;
  }

  // Rain cloud.
  const cloud = new THREE.Group();
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0x8793a8, roughness: 1, flatShading: true });
  [[0, 0, 0, 0.34], [0.3, -0.04, 0.05, 0.26], [-0.3, -0.05, -0.04, 0.27], [0.1, 0.06, -0.2, 0.24], [-0.08, 0.05, 0.22, 0.25]]
    .forEach(([x, y, z, r]) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), cloudMat);
      m.position.set(x, y, z); m.scale.y = 0.72; cloud.add(m);
    });
  cloud.visible = false;
  pivot.add(cloud);
  const RAIN_RADIUS = 0.4;
  const cloudPos = new THREE.Vector2(0, 0), cloudTarget = new THREE.Vector2(0, 0);
  const cloudHeight = terrain.heightKm + 0.8;

  // Raindrops: short streaks falling from the cloud, landing adds water to the cell below.
  const MAX_DROPS = 1400;
  const dropX = new Float32Array(MAX_DROPS), dropY = new Float32Array(MAX_DROPS), dropZ = new Float32Array(MAX_DROPS);
  const dropOn = new Uint8Array(MAX_DROPS);
  const streak = new Float32Array(MAX_DROPS * 6);
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute('position', new THREE.BufferAttribute(streak, 3));
  const drops = new THREE.LineSegments(dropGeo, new THREE.LineBasicMaterial({ color: 0x2f7fe0 }));
  drops.frustumCulled = false;
  drops.visible = false;
  pivot.add(drops);

  const FALL = 5;                 // scene units per second
  const DROP_DEPTH = 0.035;       // metres of water per drop
  let intensity = 1, spawnAcc = 0, next = 0, active = false, statClock = 0;

  function spawn() {
    for (let tries = 0; tries < MAX_DROPS; tries++) {
      const k = next; next = (next + 1) % MAX_DROPS;
      if (dropOn[k]) continue;
      const a = Math.random() * Math.PI * 2, r = RAIN_RADIUS * Math.sqrt(Math.random());
      dropX[k] = cloudPos.x + Math.cos(a) * r;
      dropZ[k] = cloudPos.y + Math.sin(a) * r;
      dropY[k] = cloud.position.y - 0.1;
      dropOn[k] = 1;
      return;
    }
  }

  function updateDrops(dt) {
    spawnAcc += 700 * intensity * dt;
    while (spawnAcc >= 1) { spawn(); spawnAcc -= 1; }
    for (let k = 0; k < MAX_DROPS; k++) {
      const o = k * 6;
      if (!dropOn[k]) { streak[o + 1] = streak[o + 4] = -100; continue; }
      dropY[k] -= FALL * dt;
      const ground = terrain.surfaceY(dropX[k], dropZ[k]);
      if (dropY[k] <= ground) {
        const [fu, fv] = terrain.bboxFrac(dropX[k], dropZ[k]);
        sim.addRain(Math.floor(fu * gw), Math.floor(fv * gh), DROP_DEPTH);
        dropOn[k] = 0; streak[o + 1] = streak[o + 4] = -100;
        continue;
      }
      streak[o] = streak[o + 3] = dropX[k];
      streak[o + 2] = streak[o + 5] = dropZ[k];
      streak[o + 1] = dropY[k];
      streak[o + 4] = dropY[k] + 0.09;
    }
    dropGeo.attributes.position.needsUpdate = true;
  }

  const pick = createPicker({ terrain, pivot, camera });
  function aim(clientX, clientY, rect) {
    const hit = pick(clientX, clientY, rect);
    if (hit) cloudTarget.set(hit[0], hit[1]);
  }

  function update(dt) {
    if (!active) return;
    cloudPos.lerp(cloudTarget, 1 - Math.exp(-dt * 8));
    cloud.position.set(cloudPos.x, cloudHeight + Math.sin(performance.now() / 700) * 0.03, cloudPos.y);
    updateDrops(dt);
    for (let s = 0; s < SUBSTEPS; s++) sim.step(SIM_DT);
    paintWater();
    statClock += dt;
    if (statClock > 0.25 && statsEl) {
      statClock = 0;
      const m3 = (v) => Math.round(v).toLocaleString('en-GB');
      statsEl.textContent = `Held on map ${m3(sim.volume())} m³ · Ran off the edge ${m3(sim.offMap)} m³`;
    }
  }

  return {
    enter() { active = true; overlay.visible = cloud.visible = drops.visible = true; if (waterLayer) waterLayer.visible = true; },
    exit() { active = false; overlay.visible = cloud.visible = drops.visible = false; if (waterLayer) waterLayer.visible = false; dropOn.fill(0); },
    aim, update,
    reset() { sim.clear(); paintWater(); },
    setIntensity(v) { intensity = v; },
    sim,
  };
}
