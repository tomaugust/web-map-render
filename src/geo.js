// Normalised Web Mercator: u,v in [0,1], v grows southwards.
export const lonToU = (lon) => (lon + 180) / 360;
export const latToV = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const uToLon = (u) => u * 360 - 180;
export const vToLat = (v) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;

// Metres per normalised-mercator unit at a latitude.
export const metresPerUnit = (lat) => 40075016.686 * Math.cos((lat * Math.PI) / 180);

// Polygon centroid (shoelace) in any planar coordinates.
export function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}
