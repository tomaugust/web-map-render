import * as THREE from 'three';
import { buildTerrain } from './terrain.js';

const canvas = document.getElementById('scene');
const popout = document.getElementById('popout');
const loading = document.getElementById('loading');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0xffffff, 1);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc8b8, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-6, 8, 5);
scene.add(sun);

// Everything that turns lives in `pivot`; the camera stays still.
const pivot = new THREE.Group();
pivot.rotation.order = 'XYZ';           // yaw about the map's own up axis, then tilt toward the camera
scene.add(pivot);

const MIN_PITCH = 0.15, MAX_PITCH = 1.45;
const state = { yaw: 0.4, pitch: 0.78, yawVel: 0, dist: 14, dragging: false, idleFor: 99 };
const AUTO_SPEED = reduceMotion ? 0 : 0.12; // rad/s

function makePin() {
  const pin = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xe0352b, roughness: 0.35, metalness: 0.1 });
  const r = 0.17, h = 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), red);
  head.position.y = h;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 0.93, h, 32), red);
  tip.rotation.x = Math.PI;               // point down
  tip.position.y = h / 2 - 0.0;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(r * 0.4, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  dot.position.set(0, h, r * 0.62);
  const hit = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8),
    new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = h;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.17, 40),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  pin.add(tip, head, dot, hit, ring);
  pin.userData = { hit, body: [tip, head, dot], h };
  return pin;
}

let pin, terrain, popOpen = false;
const pinTopWorld = new THREE.Vector3();

async function init() {
  const geo = await (await fetch('data/cholsey-parish.geojson')).json();
  terrain = await buildTerrain(geo, renderer);
  console.log('tiles', terrain.tilesOk);
  pivot.add(terrain.group);
  pin = makePin();
  pin.position.set(0, terrain.pinY, 0);
  pivot.add(pin);
  state.dist = Math.max(10, terrain.radius * 2.6);
  const [lon, lat] = terrain.centroidLonLat;
  document.getElementById('po-coords').textContent = `${lat.toFixed(4)}° N, ${Math.abs(lon).toFixed(4)}° W`;
  document.getElementById('po-elev').textContent = `${Math.round(terrain.pinHeightM)} m above sea level`;
  loading.classList.add('done');
  window.__ready = true;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // On tall/narrow screens pull back so the whole parish still fits.
  camera.userData.fit = Math.max(1, 1.15 / camera.aspect);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- Interaction: grab and turn, wheel / pinch zoom, tap pin ----
const pointers = new Map();
let down = null, pinchStart = 0, distStart = 0;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

function pinUnder(e) {
  if (!pin) return false;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObject(pin.userData.hit, false).length > 0;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, moved: 0 };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y); distStart = state.dist; down = null;
  }
  state.dragging = true; state.yawVel = 0; state.idleFor = 0;
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) { canvas.classList.toggle('pointing', pinUnder(e)); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    state.dist = clampDist(distStart * pinchStart / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)));
    return;
  }
  if (down) down.moved += Math.abs(dx) + Math.abs(dy);
  const k = 0.0055;
  state.yaw += dx * k;
  state.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, state.pitch + dy * k));
  const dt = Math.max(0.008, 0.016);
  state.yawVel = Math.max(-2.5, Math.min(2.5, state.yawVel * 0.6 + (dx * k / dt) * 0.4));   // for a flick on release
});

function end(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (!pointers.size) {
    state.dragging = false; state.idleFor = 0;
    canvas.classList.remove('dragging');
    if (down && down.moved < 6) setPopout(pinUnder(e)); // a tap, not a drag
    down = null;
  }
}
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);

const clampDist = (d) => Math.min(terrain ? terrain.radius * 6 : 40, Math.max(terrain ? terrain.radius * 1.6 : 6, d));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.dist = clampDist(state.dist * Math.exp(e.deltaY * 0.001));
}, { passive: false });

function setPopout(open) {
  popOpen = open;
  popout.hidden = !open;
}
document.getElementById('popout-close').addEventListener('click', () => setPopout(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape') setPopout(false); });

// ---- Loop ----
let last = performance.now();
const v = new THREE.Vector3();
function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const t = now / 1000;
  if (!state.dragging) {
    state.idleFor += dt;
    // Flick momentum eases toward the slow auto-spin (or stops while the popout is open).
    const target = popOpen ? 0 : AUTO_SPEED;
    state.yawVel += (target - state.yawVel) * (1 - Math.exp(-dt / 1.2));
    state.yaw += state.yawVel * dt;
  }
  pivot.rotation.set(state.pitch, state.yaw, 0);
  camera.position.set(0, 0, state.dist * (camera.userData.fit || 1));
  camera.lookAt(0, 0, 0);
  if (pin) {
    pin.position.y = terrain.pinY + Math.sin(t * 2) * 0.03 + 0.03;
    if (popOpen) {
      pivot.updateMatrixWorld(true);
      v.set(0, pin.userData.h + 0.17, 0);
      pin.localToWorld(pinTopWorld.copy(v));
      pinTopWorld.project(camera);
      const x = (pinTopWorld.x * 0.5 + 0.5) * innerWidth;
      const y = (-pinTopWorld.y * 0.5 + 0.5) * innerHeight;
      popout.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 12px))`;
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
init().catch((err) => { console.error(err); loading.textContent = 'Could not load the map.'; });
window.__state = state;

// Test helper: screen position of the pin head.
window.__pinScreen = () => {
  const p = pin.localToWorld(new THREE.Vector3(0, pin.userData.h, 0)).project(camera);
  return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight };
};
