import * as THREE from 'three';
import { lonToU, latToV, metresPerUnit, centroid } from './geo.js';

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMAGERY = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const ELEV_ZOOM = 13;
const IMG_ZOOM = 14;
const TEX = 2048;
const GRID = 320;
const EXAGGERATION = 4;          // vertical exaggeration
const UNIT = 1000;               // scene unit = 1 km

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryLoad = (url) => new Promise((res) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => res(img);
  img.onerror = () => res(null);
  img.src = url;
});
// Tile servers throttle bursts, so retry with backoff.
async function loadImage(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const img = await tryLoad(url);
    if (img) return img;
    await sleep(400 * 2 ** attempt);
  }
  return null;
}
// Run async jobs with limited concurrency.
async function pool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

// Fetch a block of tiles covering [u0,u1]x[v0,v1] and stitch them onto a canvas.
async function mosaic(urlFor, z, u0, u1, v0, v1) {
  const n = 2 ** z;
  const tx0 = Math.floor(u0 * n), tx1 = Math.floor(u1 * n);
  const ty0 = Math.floor(v0 * n), ty1 = Math.floor(v1 * n);
  const canvas = document.createElement('canvas');
  canvas.width = (tx1 - tx0 + 1) * 256;
  canvas.height = (ty1 - ty0 + 1) * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(() => loadImage(urlFor(z, tx, ty)).then((img) => {
      if (img) ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
      return !!img;
    }));
  }
  const ok = (await pool(jobs, 4)).filter(Boolean).length;
  return { canvas, ctx, z, tx0, ty0, ok, total: jobs.length };
}

// Bilinear height sampler (metres) over normalised mercator coordinates.
function heightSampler(m) {
  const { canvas, ctx, z, tx0, ty0 } = m;
  const w = canvas.width, h = canvas.height;
  const px = ctx.getImageData(0, 0, w, h).data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    H[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }
  const n = 2 ** z;
  return (u, v) => {
    const x = Math.min(w - 1.001, Math.max(0, (u * n - tx0) * 256 - 0.5));
    const y = Math.min(h - 1.001, Math.max(0, (v * n - ty0) * 256 - 0.5));
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
    const a = H[yi * w + xi], b = H[yi * w + xi + 1];
    const c = H[(yi + 1) * w + xi], d = H[(yi + 1) * w + xi + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

// Crop a mosaic to the bbox (normalised mercator) into a TEX-sized canvas at its aspect ratio.
function cropTo(m, u0, u1, v0, v1, w, h) {
  const n = 2 ** m.z;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(m.canvas, (u0 * n - m.tx0) * 256, (v0 * n - m.ty0) * 256,
    (u1 - u0) * n * 256, (v1 - v0) * n * 256, 0, 0, w, h);
  return c;
}

/**
 * Builds the parish terrain: a displaced, boundary-clipped top surface with
 * side walls and a base. Origin is the polygon centroid; units are km.
 */
export async function buildTerrain(geojson, renderer) {
  const ring = geojson.features[0].geometry.coordinates[0]; // [lon,lat]
  const uv = ring.map(([lon, lat]) => [lonToU(lon), latToV(lat)]);
  const us = uv.map((p) => p[0]), vs = uv.map((p) => p[1]);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const [cu, cv] = centroid(uv);
  const lat0 = (ring.reduce((s, p) => s + p[1], 0)) / ring.length;
  const M = metresPerUnit(lat0) / UNIT;           // km per mercator unit
  const toXZ = ([u, v]) => [(u - cu) * M, (v - cv) * M];

  const [elev, img] = await Promise.all([
    mosaic(TERRARIUM, ELEV_ZOOM, u0, u1, v0, v1),
    mosaic(IMAGERY, IMG_ZOOM, u0, u1, v0, v1),
  ]);
  const sample = elev.ok === elev.total ? heightSampler(elev) : () => 50;

  // Heights over the ring to choose a base level.
  const ringH = uv.map(([u, v]) => sample(u, v));
  let hMin = Infinity;
  const GRIDH = [];
  const widthKm = (u1 - u0) * M, depthKm = (v1 - v0) * M;
  for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) {
    const h = sample(u0 + (u1 - u0) * i / GRID, v0 + (v1 - v0) * j / GRID);
    GRIDH.push(h);
  }
  for (const h of ringH) hMin = Math.min(hMin, h);
  const baseM = hMin - 12;
  const yOf = (hm) => ((hm - baseM) * EXAGGERATION) / UNIT;

  // Top surface: regular grid over the bbox, clipped by alpha mask.
  const pos = new Float32Array((GRID + 1) ** 2 * 3);
  const uvs = new Float32Array((GRID + 1) ** 2 * 2);
  let k = 0;
  for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++, k++) {
    const s = i / GRID, t = j / GRID;
    const [x, z] = toXZ([u0 + (u1 - u0) * s, v0 + (v1 - v0) * t]);
    pos.set([x, yOf(GRIDH[k]), z], k * 3);
    uvs.set([s, 1 - t], k * 2);
  }
  const idx = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);   // counter-clockwise seen from +y
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  topGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  topGeo.setIndex(idx);
  topGeo.computeVertexNormals();

  const aspect = depthKm / widthKm;
  const tw = aspect <= 1 ? TEX : Math.round(TEX / aspect);
  const th = aspect <= 1 ? Math.round(TEX * aspect) : TEX;

  const mask = document.createElement('canvas');
  mask.width = tw; mask.height = th;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, tw, th);
  mctx.fillStyle = '#fff'; mctx.beginPath();
  uv.forEach(([u, v], i) => {
    const x = (u - u0) / (u1 - u0) * tw, y = (v - v0) / (v1 - v0) * th;
    i ? mctx.lineTo(x, y) : mctx.moveTo(x, y);
  });
  mctx.closePath(); mctx.fill();

  const colour = new THREE.CanvasTexture(cropTo(img, u0, u1, v0, v1, tw, th));
  colour.colorSpace = THREE.SRGBColorSpace;
  colour.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const alpha = new THREE.CanvasTexture(mask);

  const top = new THREE.Mesh(topGeo, new THREE.MeshStandardMaterial({
    map: colour, alphaMap: alpha, alphaTest: 0.5, roughness: 0.95, metalness: 0,
  }));

  // Side walls following the boundary, from terrain down to the base.
  const wallPos = [], wallIdx = [];
  ring.forEach((_, i) => {
    const [x, z] = toXZ(uv[i]);
    wallPos.push(x, yOf(ringH[i]) + 0.0004, z, x, 0, z);
  });
  for (let i = 0; i < ring.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    wallIdx.push(a, b, c, c, b, d);
  }
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wallGeo.setIndex(wallIdx);
  wallGeo.computeVertexNormals();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c3, roughness: 1, side: THREE.DoubleSide });
  const walls = new THREE.Mesh(wallGeo, wallMat);

  // Base cap.
  const shape = new THREE.Shape(uv.slice(0, -1).map((p) => new THREE.Vector2(...toXZ(p))));
  const baseGeo = new THREE.ShapeGeometry(shape);
  baseGeo.rotateX(Math.PI / 2);
  const base = new THREE.Mesh(baseGeo, wallMat);

  const group = new THREE.Group();
  group.add(top, walls, base);

  // Pin location = polygon centroid (origin in local XZ).
  const pinHeightM = sample(cu, cv);
  // Sim-resolution view of the same data: heights (m) and an inside-the-parish mask per cell.
  function gridData(gw) {
    const gh = Math.max(2, Math.round(gw * depthKm / widthKm));
    const heights = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      heights[j * gw + i] = sample(u0 + (u1 - u0) * (i + 0.5) / gw, v0 + (v1 - v0) * (j + 0.5) / gh);
    }
    const c = document.createElement('canvas');
    c.width = gw; c.height = gh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.beginPath();
    uv.forEach(([u, v], i) => {
      const px = (u - u0) / (u1 - u0) * gw, py = (v - v0) / (v1 - v0) * gh;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.closePath(); x.fill();
    const a = x.getImageData(0, 0, gw, gh).data;
    const inside = new Uint8Array(gw * gh);
    for (let i = 0; i < inside.length; i++) inside[i] = a[i * 4] > 127 ? 1 : 0;
    return { gw, gh, heights, inside, cellM: (widthKm * UNIT) / gw };
  }

  return {
    top,
    gridData,
    // Scene-space terrain height at local (x,z) km, for ray picking and placing objects.
    surfaceY: (x, z) => yOf(sample(cu + x / M, cv + z / M)),
    // Local (x,z) km -> fraction across the bounding box (0..1 each way, z grows south).
    bboxFrac: (x, z) => [(cu + x / M - u0) / (u1 - u0), (cv + z / M - v0) / (v1 - v0)],
    widthKm,
    depthKm,
    group,
    pinY: yOf(pinHeightM),
    pinHeightM,
    centroidLonLat: [(cu * 360 - 180), (Math.atan(Math.sinh(Math.PI * (1 - 2 * cv))) * 180) / Math.PI],
    radius: Math.max(widthKm, depthKm) / 2,
    heightKm: yOf(Math.max(...GRIDH)),
    tilesOk: { elevation: `${elev.ok}/${elev.total}`, imagery: `${img.ok}/${img.total}` },
  };
}
