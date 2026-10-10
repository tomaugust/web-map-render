import * as THREE from 'three';

// A virtual river-flow gauge on a stream or river. It reads the discharge (m^3/s) passing through its
// cell of the water simulation, draws a small post on the map, a tag line to a chart in the corner, and
// scrolls the chart as simulated time passes. Tap another river to move it.

const WINDOW_S = 5 * 3600;          // chart shows the last five simulated hours
const SMOOTH = 0.25;                // chart smoothing per sample (the raw flux flickers a little)
const EDGE_CELLS = 3;               // keep clear of the parish boundary (the sim drains there)
const REACH = 3;                    // the gauge averages river cells within this many cells (about 100 m) of the post
const REACH_SIGMA = 1.8;            // ... weighted towards the middle

export function createGauge({ terrain, pivot, camera, sim, grid, ui }) {
  const { gw, gh } = grid, n = gw * gh;
  const [f0u, f0v] = terrain.bboxFrac(0, 0);
  const su = terrain.bboxFrac(1, 0)[0] - f0u, sv = terrain.bboxFrac(0, 1)[1] - f0v;
  const cellXZ = (k) => {
    const i = k % gw, j = (k / gw) | 0;
    return [((i + 0.5) / gw - f0u) / su, ((j + 0.5) / gh - f0v) / sv];
  };

  // ---- Where to put it: the stream cell that drains the biggest area (D8 flow accumulation) ----
  function bestSite() {
    const { z, inside, chan, baseIn } = sim;
    const order = [];
    for (let k = 0; k < n; k++) if (inside[k]) order.push(k);
    order.sort((a, b) => z[b] - z[a]);
    const acc = new Float32Array(n).fill(1);
    for (const k of order) {
      const i = k % gw, j = (k / gw) | 0;
      let low = z[k], t = -1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const kk = jj * gw + ii;
        if (z[kk] < low) { low = z[kk]; t = kk; }
      }
      if (t >= 0 && inside[t]) acc[t] += acc[k];
    }
    const interior = (k) => {
      const i = k % gw, j = (k / gw) | 0;
      for (let dj = -EDGE_CELLS; dj <= EDGE_CELLS; dj++) for (let di = -EDGE_CELLS; di <= EDGE_CELLS; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh || !inside[jj * gw + ii]) return false;
      }
      return true;
    };
    let best = -1, bestStream = -1;
    for (let k = 0; k < n; k++) {
      if (!chan[k] || !interior(k)) continue;
      if (best < 0 || acc[k] > acc[best]) best = k;
      if (baseIn[k] > 0 && (bestStream < 0 || acc[k] > acc[bestStream])) bestStream = k;   // prefer a stream over the big river
    }
    return bestStream >= 0 ? bestStream : best;
  }

  // ---- The post on the map ----
  const marker = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.6 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.12, 12), steel);
  post.position.y = 0.06;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.012), new THREE.MeshStandardMaterial({ color: 0x00897b, roughness: 0.5 }));
  head.position.set(0.03, 0.115, 0);
  // The ring marks the reach the gauge averages over.
  const reachKm = ((REACH + 0.5) * grid.cellM) / 1000;
  const ring = new THREE.Mesh(new THREE.RingGeometry(reachKm * 0.86, reachKm, 48), new THREE.MeshBasicMaterial({ color: 0x00897b, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; ring.renderOrder = 6;
  marker.add(post, head, ring);
  marker.visible = false;
  pivot.add(marker);
  const topLocal = new THREE.Vector3(0, 0.13, 0);

  let site = -1, visible = false;
  function place(k) {
    site = k;
    const [x, z] = cellXZ(k);
    marker.position.set(x, terrain.surfaceY(x, z), z);
    marker.visible = visible;
    samples.length = 0;
  }

  // ---- Measurement ----
  const samples = [];               // { t: simulated seconds, q: m^3/s }
  let simT = 0, smooth = 0, yMax = 2, peak = 0;
  // Discharge leaving one cell (m^3/s). Flux is per unit width (m^2/s), so multiply by the cell width.
  const cellOut = (k) => (sim.qW[k] + sim.qE[k] + sim.qN[k] + sim.qS[k]) * sim.dx;
  // One cell flickers and depends on exactly how the flow splits between neighbours, so the gauge reads a
  // weighted average over the river cells around the post (not hillslope cells, which carry sheet flow).
  const kernel = [];
  for (let dj = -REACH; dj <= REACH; dj++) for (let di = -REACH; di <= REACH; di++) {
    const d2 = di * di + dj * dj;
    if (d2 <= REACH * REACH) kernel.push({ di, dj, w: Math.exp(-d2 / (2 * REACH_SIGMA * REACH_SIGMA)) });
  }
  const discharge = (k = site) => {
    const ci = k % gw, cj = (k / gw) | 0;
    let sum = 0, wsum = 0;
    for (const { di, dj, w } of kernel) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const kk = j * gw + i;
      if (!sim.chan[kk] || !sim.inside[kk]) continue;
      sum += w * cellOut(kk); wsum += w;
    }
    return wsum > 0 ? sum / wsum : cellOut(k);
  };

  function sample(simDt) {
    if (site < 0) return;
    simT += simDt;
    smooth += (discharge() - smooth) * SMOOTH;
    samples.push({ t: simT, q: smooth });
    while (samples.length && samples[0].t < simT - WINDOW_S - 60) samples.shift();
    if (smooth > peak) peak = smooth;
  }

  // ---- Chart ----
  const cvs = ui.chart, c2 = cvs.getContext('2d');
  const niceCeil = (v) => { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
  const fmt = (q) => (q >= 100 ? q.toFixed(0) : q >= 10 ? q.toFixed(1) : q.toFixed(2));
  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = cvs.clientWidth, ch = cvs.clientHeight;
    if (!cw || !ch) return;
    if (cvs.width !== Math.round(cw * dpr)) { cvs.width = Math.round(cw * dpr); cvs.height = Math.round(ch * dpr); }
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.clearRect(0, 0, cw, ch);
    const L = 38, R = 8, T = 8, B = 20, pw = cw - L - R, ph = ch - T - B;
    let mx = 0;
    for (const s of samples) if (s.q > mx) mx = s.q;
    const target = niceCeil(Math.max(0.5, mx * 1.15));
    yMax += (target - yMax) * 0.08;
    const X = (t) => L + ((t - (simT - WINDOW_S)) / WINDOW_S) * pw;
    const Y = (q) => T + ph - (Math.min(q, yMax) / yMax) * ph;
    c2.font = '10px system-ui, sans-serif'; c2.textBaseline = 'middle';
    // grid and y axis
    c2.strokeStyle = '#e4e7ec'; c2.lineWidth = 1; c2.fillStyle = '#7a8493'; c2.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const q = (yMax * i) / 4, y = Y(q);
      c2.beginPath(); c2.moveTo(L, y); c2.lineTo(cw - R, y); c2.stroke();
      c2.fillText(fmt(q), L - 5, y);
    }
    // x axis: hours back from now
    c2.textAlign = 'center'; c2.textBaseline = 'top';
    for (let h = 0; h <= 5; h++) {
      const x = L + (pw * (5 - h)) / 5;
      c2.strokeStyle = '#eef0f3'; c2.beginPath(); c2.moveTo(x, T); c2.lineTo(x, T + ph); c2.stroke();
      c2.fillText(h === 0 ? 'now' : `-${h} h`, x, T + ph + 4);
    }
    if (samples.length > 1) {
      c2.beginPath();
      samples.forEach((s, i) => { const x = Math.max(L, X(s.t)), y = Y(s.q); i ? c2.lineTo(x, y) : c2.moveTo(x, y); });
      const last = samples[samples.length - 1];
      c2.lineTo(X(last.t), T + ph); c2.lineTo(Math.max(L, X(samples[0].t)), T + ph); c2.closePath();
      c2.fillStyle = 'rgba(45,115,215,0.16)'; c2.fill();
      c2.beginPath();
      samples.forEach((s, i) => { const x = Math.max(L, X(s.t)), y = Y(s.q); i ? c2.lineTo(x, y) : c2.moveTo(x, y); });
      c2.strokeStyle = '#2d73d7'; c2.lineWidth = 2; c2.lineJoin = 'round'; c2.stroke();
      c2.fillStyle = '#2d73d7'; c2.beginPath(); c2.arc(X(last.t), Y(last.q), 3.5, 0, Math.PI * 2); c2.fill();
    }
    ui.now.textContent = `${fmt(smooth)} m³/s`;
    ui.peak.textContent = `peak ${fmt(peak)}`;
  }

  // ---- Tag line from the post to the chart card ----
  const v3 = new THREE.Vector3();
  function drawLink() {
    const line = ui.line, dot = ui.dot;
    if (!visible || site < 0 || !marker.visible) { ui.svg.style.display = 'none'; return; }
    marker.updateWorldMatrix(true, false);
    v3.copy(topLocal).applyMatrix4(marker.matrixWorld).project(camera);
    if (v3.z > 1) { ui.svg.style.display = 'none'; return; }
    const mx = (v3.x * 0.5 + 0.5) * innerWidth, my = (-v3.y * 0.5 + 0.5) * innerHeight;
    const r = ui.card.getBoundingClientRect();
    const ex = Math.min(r.right, Math.max(r.left, mx)), ey = Math.min(r.bottom, Math.max(r.top, my));   // nearest point on the card
    ui.svg.style.display = '';
    line.setAttribute('x1', mx); line.setAttribute('y1', my); line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    dot.setAttribute('cx', mx); dot.setAttribute('cy', my);
  }

  return {
    ready: () => site >= 0,
    init() { const k = bestSite(); if (k >= 0) place(k); return k >= 0; },
    show(v) {
      visible = v && site >= 0;
      marker.visible = visible;
      ui.card.hidden = !visible;
      if (!visible) ui.svg.style.display = 'none';
    },
    /** Called every frame the tab is active; simDt = simulated seconds advanced this frame. */
    update(simDt) { if (!visible) return; sample(simDt); draw(); drawLink(); },
    /** Move to the nearest river/stream cell to local map point (x, z) if there is one close by. */
    moveTo(x, z) {
      const fu = (terrain.bboxFrac(x, z)[0]), fv = terrain.bboxFrac(x, z)[1];
      const ci = Math.floor(fu * gw), cj = Math.floor(fv * gh);
      let best = -1, bd = 36;
      for (let dj = -6; dj <= 6; dj++) for (let di = -6; di <= 6; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const k = j * gw + i;
        if (!sim.chan[k] || !sim.inside[k]) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = k; }
      }
      if (best < 0) return false;
      place(best); peak = 0; smooth = discharge();
      return true;
    },
    reset() { samples.length = 0; peak = 0; smooth = 0; },
    /** test helper: single-cell and averaged readings at a cell, and the site and its river neighbours */
    _probe() {
      const ci = site % gw, cj = (site / gw) | 0, out = [];
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const k = (cj + dj) * gw + ci + di;
        if (sim.chan[k]) out.push({ single: cellOut(k), averaged: discharge(k) });
      }
      return out;
    },
  };
}
