import { lonToU, latToV } from './geo.js';

// OpenStreetMap vector layers (data/vectors.geojson, made by scripts/fetch-vectors.mjs) and helpers that
// rasterise them onto the map's grid. All sizes below are generic, assumed values: OSM has no widths or
// depths for these features, and no open dataset covers river or small-lake depth here.

export async function loadVectors(url = 'data/vectors.geojson') {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn('vector data unavailable, falling back to the map picture:', e);
    return null;
  }
}

// --- Generic hydraulic assumptions -------------------------------------------------------------
export const WATERWAY = {            // width and bed depth (m) of a channel by OSM class
  river: { w: 14, d: 1.6 }, canal: { w: 10, d: 1.8 }, stream: { w: 2.2, d: 0.5 },
  ditch: { w: 1.4, d: 0.4 }, drain: { w: 1.4, d: 0.4 },
};
const DEFAULT_WATERWAY = { w: 1.5, d: 0.4 };
const THAMES_DEPTH = 3.0;            // the river proper (wide water polygons)
const lakeDepth = (areaHa) => Math.min(3.5, Math.max(0.8, 0.8 + 0.55 * Math.log(areaHa + 1)));

function makeProjector(bbox, W, H) {
  const du = bbox.u1 - bbox.u0, dv = bbox.v1 - bbox.v0;
  return ([lon, lat]) => [((lonToU(lon) - bbox.u0) / du) * W, ((latToV(lat) - bbox.v0) / dv) * H];
}
const mPerPixel = (widthM, W) => widthM / W;

function* polygons(g) {
  if (g.type === 'Polygon') yield g.coordinates;
  else if (g.type === 'MultiPolygon') for (const p of g.coordinates) yield p;
}
function* lines(g) {
  if (g.type === 'LineString') yield g.coordinates;
  else if (g.type === 'MultiLineString') for (const l of g.coordinates) yield l;
}
function fillPolys(ctx, g, proj) {
  for (const rings of polygons(g)) {
    ctx.beginPath();
    for (const ring of rings) ring.forEach((c, i) => { const [x, y] = proj(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.fill('evenodd');
  }
}
function strokeLines(ctx, g, proj) {
  for (const l of lines(g)) {
    ctx.beginPath();
    l.forEach((c, i) => { const [x, y] = proj(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
}
function ringAreaHa(rings, proj, mpp) {
  let a = 0;
  rings.forEach((ring, k) => {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = proj(ring[i]), [x1, y1] = proj(ring[(i + 1) % ring.length]);
      s += x0 * y1 - x1 * y0;
    }
    a += (k === 0 ? 1 : -1) * Math.abs(s / 2);
  });
  return (a * mpp * mpp) / 1e4;
}
const makeCanvas = (W, H) => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };

/** Mean bed lowering (m) per pixel: lakes, ponds and the river as bowls, streams and ditches as trenches. */
export function waterDepthMap(vec, bbox, W, H, widthM) {
  const mpp = mPerPixel(widthM, W), proj = makeProjector(bbox, W, H);
  const DMAX = 5;
  const c = makeCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  const code = (d) => `rgb(${Math.round((d / DMAX) * 255)},0,0)`;
  const read = () => {
    const px = ctx.getImageData(0, 0, W, H).data, a = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = (px[i * 4] / 255) * DMAX;
    return a;
  };
  const reset = () => { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighten'; };
  // 1. Lakes, ponds and the river itself: bowls, with the shores tapered.
  reset();
  for (const f of vec.features) {
    const { layer, class: cls } = f.properties;
    if (layer !== 'water') continue;
    for (const rings of polygons(f.geometry)) {
      const ha = ringAreaHa(rings, proj, mpp);
      ctx.fillStyle = code(cls === 'river' ? THAMES_DEPTH : cls === 'pond' ? 0.8 : lakeDepth(ha));
      ctx.beginPath();
      for (const ring of rings) ring.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.fill('evenodd');
    }
  }
  const out = read();
  boxBlur(out, W, H, Math.max(1, Math.round(6 / mpp)));
  // 2. Streams, ditches, canals and river centre lines: narrow trenches, left crisp.
  reset();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const f of vec.features) {
    const { layer, class: cls, intermittent, brunnel } = f.properties;
    if (layer !== 'waterway' || brunnel === 'tunnel' || brunnel === 'culvert') continue;
    const w = WATERWAY[cls] || DEFAULT_WATERWAY;
    ctx.strokeStyle = code(w.d * (intermittent ? 0.6 : 1));
    ctx.lineWidth = Math.max(0.3, w.w / mpp);
    strokeLines(ctx, f.geometry, proj);
  }
  const trench = read();
  for (let i = 0; i < out.length; i++) if (trench[i] > out[i]) out[i] = trench[i];
  return out;
}

function boxBlur(a, W, H, r) {
  const t = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {            // horizontal
      let sum = 0, o = y * W;
      for (let x = -r; x <= r; x++) sum += a[o + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        t[o + x] = sum / (2 * r + 1);
        sum += a[o + Math.min(W - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {            // vertical
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += t[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / (2 * r + 1);
        sum += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x];
      }
    }
  }
}

/** Mean and max of a W x H map over a gw x gh grid of cells. */
export function poolMap(map, W, H, gw, gh) {
  const mean = new Float32Array(gw * gh), max = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const y0 = Math.floor((j * H) / gh), y1 = Math.max(y0 + 1, Math.floor(((j + 1) * H) / gh));
    for (let i = 0; i < gw; i++) {
      const x0 = Math.floor((i * W) / gw), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * W) / gw));
      let s = 0, m = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = map[y * W + x]; s += v; if (v > m) m = v; n++; }
      mean[j * gw + i] = s / n; max[j * gw + i] = m;
    }
  }
  return { mean, max };
}

/** A transparent RGBA canvas with the water drawn on it (for display; streams get a minimum visible width). */
export function waterLayerCanvas(vec, bbox, W, H, widthM) {
  const mpp = mPerPixel(widthM, W), proj = makeProjector(bbox, W, H);
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgb(45,115,215)'; ctx.strokeStyle = 'rgb(45,115,215)';
  for (const f of vec.features) if (f.properties.layer === 'water') fillPolys(ctx, f.geometry, proj);
  for (const f of vec.features) {
    const { layer, class: cls, brunnel } = f.properties;
    if (layer !== 'waterway' || brunnel === 'tunnel' || brunnel === 'culvert') continue;
    ctx.lineWidth = Math.max(1.6, (WATERWAY[cls] || DEFAULT_WATERWAY).w / mpp);
    strokeLines(ctx, f.geometry, proj);
  }
  return c;
}

/**
 * Per-cell coverage (0..1) of several feature classes on a gw x gh grid.
 * specs: [{ id, draw(ctx, proj, mpp) }]; draws white-on-transparent, antialiased, then box-averages the alpha.
 */
export function classCoverages(vec, bbox, widthM, gw, gh, specs, ss = 3) {
  const W = gw * ss, H = gh * ss, mpp = mPerPixel(widthM, W), proj = makeProjector(bbox, W, H);
  const out = {};
  const c = makeCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  for (const spec of specs) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    spec.draw(ctx, proj, mpp);
    const a = ctx.getImageData(0, 0, W, H).data;
    const cov = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      let s = 0;
      for (let y = 0; y < ss; y++) { let o = ((j * ss + y) * W + i * ss) * 4 + 3; for (let x = 0; x < ss; x++, o += 4) s += a[o]; }
      cov[j * gw + i] = s / (255 * ss * ss);
    }
    out[spec.id] = cov;
  }
  return out;
}
export const vectorDraw = { fillPolys, strokeLines };
