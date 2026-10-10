// One-off: download OpenStreetMap vector tiles (via OpenFreeMap, free, no key) covering the parish and
// save the layers the app needs as data/vectors.geojson. Re-run with `npm run data:vectors`.
//   Map data © OpenStreetMap contributors (ODbL). Tiles from OpenFreeMap.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PbfReader } = require('pbf');
const { VectorTile } = require('@mapbox/vector-tile');

const Z = 14;
const parish = JSON.parse(fs.readFileSync(new URL('../data/cholsey-parish.geojson', import.meta.url)));
const ring = parish.features[0].geometry.coordinates[0];
const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
const bbox = [Math.min(...lons) - 0.004, Math.min(...lats) - 0.003, Math.max(...lons) + 0.004, Math.max(...lats) + 0.003];

const n = 2 ** Z;
const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
const ty = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
const x0 = tx(bbox[0]), x1 = tx(bbox[2]), y0 = ty(bbox[3]), y1 = ty(bbox[1]);

const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const template = tj.tiles[0];
console.log('tiles', x1 - x0 + 1, 'x', y1 - y0 + 1, 'from', template);

// What to keep: [layer, classes to keep or null for all]
const KEEP = {
  water: null, waterway: null, transportation: null, landcover: null, landuse: null, building: null, park: null,
};
const round = (c) => (Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]);
const features = [];
// Keep only what touches the parish box (tiles overshoot), and skip tiny swimming pools.
const touches = (c) => {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const walk = (a) => { if (typeof a[0] === 'number') { minx = Math.min(minx, a[0]); maxx = Math.max(maxx, a[0]); miny = Math.min(miny, a[1]); maxy = Math.max(maxy, a[1]); } else a.forEach(walk); };
  walk(c);
  return maxx >= bbox[0] && minx <= bbox[2] && maxy >= bbox[1] && miny <= bbox[3];
};
for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
  const url = template.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
  let buf;
  for (let a = 0; a < 4 && !buf; a++) {
    try { const r = await fetch(url); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch {}
    if (!buf) await new Promise((r) => setTimeout(r, 500 * 2 ** a));
  }
  if (!buf) { console.warn('missing tile', x, y); continue; }
  const tile = new VectorTile(new PbfReader(buf));
  for (const layerName of Object.keys(KEEP)) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i).toGeoJSON(x, y, Z);
      const p = layer.feature(i).properties;
      const g = f.geometry;
      if (!g || g.type === 'Point' || g.type === 'MultiPoint') continue;
      if (layerName === 'water' && p.class === 'swimming_pool') continue;
      if (!touches(g.coordinates)) continue;
      features.push({ type: 'Feature', properties: { layer: layerName, class: p.class, subclass: p.subclass, brunnel: p.brunnel, name: p.name, intermittent: p.intermittent }, geometry: { type: g.type, coordinates: round(g.coordinates) } });
    }
  }
}
const counts = {};
for (const f of features) { const k = `${f.properties.layer}/${f.properties.class ?? '-'}`; counts[k] = (counts[k] || 0) + 1; }
console.log(counts);
const out = new URL('../data/vectors.geojson', import.meta.url);
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', bbox, attribution: '© OpenStreetMap contributors (ODbL), via OpenFreeMap', features }));
console.log('wrote', Math.round(fs.statSync(out).size / 1024), 'KB,', features.length, 'features');
