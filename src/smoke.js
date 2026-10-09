import * as THREE from 'three';
import { createPicker } from './pick.js';

const TIME_LAPSE = 30;       // simulated seconds per real second
const MAX = 3600;            // particle pool
const EMIT_RATE = 120;       // puffs per real second
const LIFE = 720;            // simulated seconds a puff lives
const EXAG = 4;              // matches the terrain's vertical exaggeration
const DIR_TAU = 150;         // s: how quickly wind direction wanders
const DIR_SIGMA = 70;        // deg: wander at 0% constancy
const GUST_SIGMA = 0.4;      // fraction of speed at 0% constancy

const randn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const CARDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = (deg) => CARDS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function makeFactory() {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: 0xc9ccd3, roughness: 0.8 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x6d7683, roughness: 0.9 });
  const brick = new THREE.MeshStandardMaterial({ color: 0xb5503c, roughness: 0.9 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.9 });
  const box = (w, h, d, m, x, y, z) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y + h / 2, z); g.add(b); return b;
  };
  box(0.5, 0.02, 0.36, new THREE.MeshStandardMaterial({ color: 0x8a8f98 }), 0, -0.005, 0);      // slab
  box(0.34, 0.14, 0.22, wall, -0.04, 0.015, 0);                                                    // main hall
  box(0.36, 0.02, 0.24, roof, -0.04, 0.155, 0);
  box(0.14, 0.09, 0.14, wall, 0.17, 0.015, 0.08);                                                  // annexe
  const stack = (x, z, h, r) => {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 20), brick);
    s.position.set(x, 0.015 + h / 2, z); g.add(s);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8 + 0.001, r * 0.84, h * 0.1, 20), stripe);
    band.position.set(x, 0.015 + h * 0.9, z); g.add(band);
  };
  stack(-0.12, -0.05, 0.42, 0.028);   // main stack — emission point
  stack(0.0, -0.05, 0.3, 0.02);
  g.userData.top = new THREE.Vector3(-0.12, 0.015 + 0.42, -0.05);
  return g;
}

export function createSmoke({ terrain, pivot, camera, renderer, ui }) {
  const pick = createPicker({ terrain, pivot, camera });

  // --- Factory ---
  const factory = makeFactory();
  const fpos = new THREE.Vector2(0, 0);
  function place(x, z) {
    fpos.set(x, z);
    factory.position.set(x, terrain.surfaceY(x, z), z);
  }
  place(0, 0);
  factory.visible = false;
  pivot.add(factory);

  // --- Wind: uniform speed + direction with slow OU meander scaled by (1 - constancy) ---
  const wind = { speed: 5, from: 225, constancy: 0.7, devDeg: 0, gust: 0 };
  const cur = { speed: 5, fromDeg: 225, x: 0, z: 0 }; // x,z: unit vector the air moves towards, map space
  function windStep(dtS) {
    const a = Math.exp(-dtS / DIR_TAU), k = Math.sqrt(1 - a * a);
    const loose = 1 - wind.constancy;
    wind.devDeg = wind.devDeg * a + DIR_SIGMA * loose * k * randn();
    wind.gust = wind.gust * a + GUST_SIGMA * loose * k * randn();
    cur.speed = Math.max(0, wind.speed * (1 + wind.gust));
    cur.fromDeg = wind.from + wind.devDeg;
    const to = ((cur.fromDeg + 180) * Math.PI) / 180;   // compass: 0 = north, clockwise
    cur.x = Math.sin(to); cur.z = -Math.cos(to);        // north is -z on the map
  }

  // --- Puffs ---
  const pos = new Float32Array(MAX * 3), size = new Float32Array(MAX), alpha = new Float32Array(MAX), shade = new Float32Array(MAX);
  const age = new Float32Array(MAX), vx = new Float32Array(MAX), vz = new Float32Array(MAX), rise = new Float32Array(MAX);
  const live = new Uint8Array(MAX);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uScale: { value: 1 } },
    vertexShader: `
      attribute float aSize; attribute float aAlpha; attribute float aShade;
      uniform float uScale; varying float vA; varying float vS;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / -mv.z;
        vA = aAlpha; vS = aShade;
      }`,
    fragmentShader: `
      varying float vA; varying float vS;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float soft = (1.0 - d) * (1.0 - d);
        vec3 col = mix(vec3(0.22, 0.23, 0.26), vec3(0.62, 0.64, 0.68), vS);
        gl_FragColor = vec4(col, vA * soft);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  pivot.add(points);

  let next = 0, acc = 0, active = false, statClock = 0;
  const hw = terrain.widthKm / 2 + 1.2, hd = terrain.depthKm / 2 + 1.2;

  function emit() {
    for (let t = 0; t < MAX; t++) {
      const k = next; next = (next + 1) % MAX;
      if (live[k]) continue;
      const top = factory.userData.top;
      pos[k * 3] = factory.position.x + top.x + (Math.random() - 0.5) * 0.02;
      pos[k * 3 + 1] = factory.position.y + top.y;
      pos[k * 3 + 2] = factory.position.z + top.z + (Math.random() - 0.5) * 0.02;
      const v = cur.speed / 1000;                       // km/s
      vx[k] = cur.x * v; vz[k] = cur.z * v;
      rise[k] = 1.5 / (1 + cur.speed / 6);              // plume bends over in strong wind
      age[k] = 0; live[k] = 1;
      return;
    }
  }

  function updatePuffs(dtS) {
    const K = 20 + 3 * cur.speed;                       // eddy diffusivity, m^2/s
    const sig = Math.sqrt(2 * K * dtS) / 1000;
    for (let k = 0; k < MAX; k++) {
      if (!live[k]) { size[k] = 0; alpha[k] = 0; continue; }
      age[k] += dtS;
      const a = age[k] / LIFE;
      const x0 = pos[k * 3], z0 = pos[k * 3 + 2];
      if (a >= 1 || Math.abs(x0) > hw || Math.abs(z0) > hd) { live[k] = 0; size[k] = 0; alpha[k] = 0; continue; }
      // Mostly carried by the wind it was released into (so the plume snakes), partly by today's wind.
      const bx = 0.78 * vx[k] + 0.22 * cur.x * cur.speed / 1000;
      const bz = 0.78 * vz[k] + 0.22 * cur.z * cur.speed / 1000;
      const x = x0 + bx * dtS + randn() * sig;
      const z = z0 + bz * dtS + randn() * sig;
      let y = pos[k * 3 + 1] + (rise[k] * Math.exp(-age[k] / 90) * dtS * EXAG) / 1000 + (randn() * sig * 0.5 * EXAG);
      const ground = terrain.surfaceY(x, z) + 0.006;
      if (y < ground) y = ground;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      size[k] = 0.045 + 0.3 * Math.pow(a, 0.65);
      alpha[k] = 0.5 * Math.pow(1 - a, 1.3) * Math.min(1, age[k] / 15);
      shade[k] = Math.min(1, a * 1.4);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aShade.needsUpdate = true;
  }

  function update(dt) {
    if (!active) return;
    const dtS = dt * TIME_LAPSE;
    windStep(dtS);
    acc += EMIT_RATE * dt;
    while (acc >= 1) { emit(); acc -= 1; }
    updatePuffs(dtS);
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    mat.uniforms.uScale.value = sz.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
    statClock += dt;
    if (statClock > 0.15) {
      statClock = 0;
      ui.onWind?.({ speed: cur.speed, fromDeg: cur.fromDeg, nominalFrom: wind.from, text:
        `Wind now ${cur.speed.toFixed(1)} m/s from ${cardinal(cur.fromDeg)} (${Math.round(((cur.fromDeg % 360) + 360) % 360)}°)` });
    }
  }

  return {
    enter() { active = true; factory.visible = points.visible = true; },
    exit() { active = false; factory.visible = points.visible = false; },
    update,
    click(clientX, clientY, rect) {
      const hit = pick(clientX, clientY, rect);
      if (hit) place(hit[0], hit[1]);
    },
    setSpeed(v) { wind.speed = v; },
    setFrom(deg) { wind.from = deg; },
    setConstancy(c) { wind.constancy = c; },
    clear() { live.fill(0); },
    TIME_LAPSE,
  };
}
