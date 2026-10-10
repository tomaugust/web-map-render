import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { createPicker } from './pick.js';

const TIME_LAPSE = 30;       // simulated seconds per real second
const SIDE = Math.min(768, Math.max(64, +new URLSearchParams(location.search).get('n') || 384)); // particles = SIDE^2
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

const NOISE = `
  float hash3(vec3 p) { p = mod(p, 61.0); return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // Value noise with analytic derivatives (Inigo Quilez): returns (value, d/dx, d/dy, d/dz).
  vec4 noised(vec3 x) {
    vec3 p = floor(x), w = fract(x);
    vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
    vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
    float a = hash3(p), b = hash3(p + vec3(1, 0, 0)), c = hash3(p + vec3(0, 1, 0)), d = hash3(p + vec3(1, 1, 0));
    float e = hash3(p + vec3(0, 0, 1)), f = hash3(p + vec3(1, 0, 1)), g = hash3(p + vec3(0, 1, 1)), h = hash3(p + vec3(1, 1, 1));
    float k0 = a, k1 = b - a, k2 = c - a, k3 = a - b - c + d, k4 = e - a, k5 = a - b - e + f, k6 = a - c - e + g, k7 = -a + b + c - d + e - f - g + h;
    return vec4(-1.0 + 2.0 * (k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y + k4 * u.z + k5 * u.z * u.x + k6 * u.y * u.z + k7 * u.x * u.y * u.z),
      2.0 * du * vec3(k1 + k3 * u.y + k5 * u.z + k7 * u.y * u.z, k2 + k3 * u.x + k6 * u.z + k7 * u.x * u.z, k4 + k5 * u.x + k6 * u.y + k7 * u.x * u.y));
  }
`;

export function createSmoke({ terrain, pivot, camera, renderer, ui, lightDir }) {
  const pick = createPicker({ terrain, pivot, camera });

  // --- Factory ---
  const factory = makeFactory();
  const fpos = new THREE.Vector2(0, 0);
  function place(x, z) {
    fpos.set(x, z);
    factory.position.set(x, terrain.surfaceY(x, z), z);
  }
  place(terrain.centroidXZ[0], terrain.centroidXZ[1]);
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

  // --- GPU particle simulation ---
  // State lives in two float textures (one texel per particle):
  //   position: xyz (scene units, km), w = age in simulated seconds (negative = not yet released)
  //   velocity: xyz (m/s, mean motion of the puff), w = excess temperature (1 = fresh exhaust)
  // Every frame: relax toward the wind, buoyancy lifts hot smoke while entrainment cools it,
  // and a curl-noise field (divergence-free, so it swirls) shreds the plume, with larger eddies
  // switching on as a puff ages so the plume billows more the further downwind it goes.
  const N = SIDE * SIDE;
  const gpu = new GPUComputationRenderer(SIDE, SIDE, renderer);
  const emitPos = new THREE.Vector3();
  const sharedUniforms = {
    uDt: { value: 0 }, uTime: { value: 0 }, uLife: { value: LIFE }, uEmit: { value: emitPos },
    uWindSpeed: { value: 5 }, uWindDir: { value: new THREE.Vector2(1, 0) }, uDrift: { value: new THREE.Vector3() },
    uExag: { value: EXAG }, uHalfW: { value: terrain.widthKm / 2 + 1.2 }, uHalfD: { value: terrain.depthKm / 2 + 1.2 },
    tHeight: { value: null }, uMapA: { value: new THREE.Vector4() },
  };

  // Terrain height as a small half-float texture, plus the affine map from local x,z to its uv.
  {
    const HS = 160;
    const [f0u, f0v] = terrain.bboxFrac(0, 0), [f1u] = terrain.bboxFrac(1, 0), [, f1v] = terrain.bboxFrac(0, 1);
    const su = f1u - f0u, sv = f1v - f0v;
    const data = new Uint16Array(HS * HS);
    for (let j = 0; j < HS; j++) for (let i = 0; i < HS; i++) {
      const x = ((i + 0.5) / HS - f0u) / su, z = ((j + 0.5) / HS - f0v) / sv;
      data[j * HS + i] = THREE.DataUtils.toHalfFloat(terrain.surfaceY(x, z));
    }
    const ht = new THREE.DataTexture(data, HS, HS, THREE.RedFormat, THREE.HalfFloatType);
    ht.minFilter = ht.magFilter = THREE.LinearFilter; ht.needsUpdate = true;
    sharedUniforms.tHeight.value = ht;
    sharedUniforms.uMapA.value.set(f0u, f0v, su, sv);
  }

  const COMMON = `
    uniform float uDt, uTime, uLife, uExag, uHalfW, uHalfD; uniform vec3 uEmit, uDrift; uniform vec2 uWindDir; uniform float uWindSpeed;
    uniform sampler2D tHeight; uniform vec4 uMapA;
    float ground(vec2 xz) {
      vec2 t = vec2(uMapA.x + xz.x * uMapA.z, uMapA.y + xz.y * uMapA.w);
      return texture2D(tHeight, clamp(t, 0.0, 1.0)).r + 0.006;
    }
    ${NOISE}
    float lifeOf(vec2 uv) { return uLife * (0.85 + 0.3 * hash2(uv * 91.7)); }
    bool spawning(vec4 P, vec2 uv) {
      bool oob = abs(P.x) > uHalfW || abs(P.z) > uHalfD;
      return (P.w < 0.0 && P.w + uDt >= 0.0) || (P.w >= 0.0 && (P.w + uDt > lifeOf(uv) || oob));
    }
  `;

  const velShader = COMMON + `
    uniform float uBuoy, uTauT, uTauD, uTauH;
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 P = texture2D(texturePosition, uv);
      vec4 V = texture2D(textureVelocity, uv);
      if (P.w < 0.0 && P.w + uDt < 0.0) { gl_FragColor = vec4(0.0); return; }   // still waiting
      vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y) * uWindSpeed;
      if (spawning(P, uv)) {                                                     // released from the stack
        float j = hash2(uv * 13.3 + uTime);
        gl_FragColor = vec4(wind.x * 0.25, 4.0 + 3.0 * j, wind.z * 0.25, 1.0);
        return;
      }
      float aglM = max(0.0, (P.y - uEmit.y) / (uExag * 0.001));
      vec3 w = wind * (1.0 + 0.3 * tanh(aglM / 90.0));                           // faster wind aloft
      V.xz += (w.xz - V.xz) * (1.0 - exp(-uDt / uTauH));                         // dragged up to wind speed
      V.y += uBuoy * V.w * uDt - V.y * (1.0 - exp(-uDt / uTauD));                // buoyancy vs entrainment drag
      V.w *= exp(-uDt / uTauT);                                                  // cooling by mixing
      if (P.y <= ground(P.xz) + 0.002) V.y = max(V.y, 0.0);
      gl_FragColor = V;
    }`;

  const posShader = COMMON + `
    uniform float uSigma;
    // Divergence-free turbulence (m/s) from the curl of three noise fields, four eddy sizes.
    vec3 turbulence(vec3 p, float age) {
      vec3 sum = vec3(0.0);
      for (int j = 0; j < 4; j++) {
        float L = 0.9 * pow(0.46, float(j));                    // eddy size, km
        float A = uSigma * pow(L / 0.9, 0.33) * 1.6;            // Kolmogorov-ish: bigger eddies are faster
        float tau = L * 1000.0 / A;                             // turnover time, s
        float wgt = smoothstep(0.0, 1.0, age / (0.5 * tau));     // eddy only acts once the puff is big enough
        if (wgt <= 0.0) continue;
        vec3 q = (p - uDrift) / L + vec3(float(j) * 13.1, float(j) * 7.7, float(j) * 3.3) + vec3(0.3, 0.5, 0.2) * uTime / tau;
        vec4 n0 = noised(q), n1 = noised(q + vec3(31.4, 17.2, 5.9)), n2 = noised(q + vec3(11.7, 43.1, 23.5));
        vec3 curl = vec3(n2.z - n1.w, n0.w - n2.y, n1.y - n0.z);
        sum += A * wgt * curl * 0.35;
      }
      return sum;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 P = texture2D(texturePosition, uv);
      vec4 V = texture2D(textureVelocity, uv);
      if (P.w < 0.0 && P.w + uDt < 0.0) { gl_FragColor = vec4(uEmit, P.w + uDt); return; }
      if (spawning(P, uv)) {
        float a = hash2(uv * 7.1 + uTime) * 6.2831853;
        gl_FragColor = vec4(uEmit + vec3(cos(a), 0.0, sin(a)) * 0.006 * hash2(uv + 3.0), 0.0);
        return;
      }
      vec3 t = turbulence(P.xyz, P.w);
      vec3 vel = V.xyz + t * vec3(1.0, 0.6, 1.0);
      vec3 p = P.xyz + vec3(vel.x, vel.y * uExag, vel.z) * (uDt * 0.001);
      p.y = max(p.y, ground(p.xz));
      gl_FragColor = vec4(p, P.w + uDt);
    }`;

  function fill(posTex, velTex) {
    const pd = posTex.image.data, vd = velTex.image.data;
    for (let i = 0; i < N; i++) {
      pd[i * 4] = emitPos.x; pd[i * 4 + 1] = emitPos.y; pd[i * 4 + 2] = emitPos.z;
      pd[i * 4 + 3] = -Math.random() * LIFE;       // released evenly over one lifetime -> steady emission
      vd[i * 4] = vd[i * 4 + 1] = vd[i * 4 + 2] = vd[i * 4 + 3] = 0;
    }
  }
  const pos0 = gpu.createTexture(), vel0 = gpu.createTexture();
  const velVar = gpu.addVariable('textureVelocity', velShader, vel0);
  const posVar = gpu.addVariable('texturePosition', posShader, pos0);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  for (const v of [velVar, posVar]) for (const [k, u] of Object.entries(sharedUniforms)) v.material.uniforms[k] = u;
  velVar.material.uniforms.uBuoy = { value: 0.095 };
  velVar.material.uniforms.uTauT = { value: 70 };
  velVar.material.uniforms.uTauD = { value: 15 };
  velVar.material.uniforms.uTauH = { value: 10 };
  posVar.material.uniforms.uSigma = { value: 1.5 };

  function topWorld() {
    const top = factory.userData.top;
    emitPos.set(factory.position.x + top.x, factory.position.y + top.y, factory.position.z + top.z);
  }
  topWorld();
  fill(pos0, vel0);
  const gpuErr = gpu.init();
  if (gpuErr) console.error('smoke GPU init:', gpuErr);

  // --- Rendering: one point per particle, fetching its state from the textures ---
  const ref = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { ref[i * 2] = ((i % SIDE) + 0.5) / SIDE; ref[i * 2 + 1] = (Math.floor(i / SIDE) + 0.5) / SIDE; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const density = 0.085 * Math.pow(384 / SIDE, 2);   // keep overall opacity similar at other particle counts
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { tPos: { value: null }, tVel: { value: null }, uScale: { value: 1 }, uLife: { value: LIFE },
      uDensity: { value: density }, uEmitY: { value: 0 }, uExag: { value: EXAG }, uLight: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: `
      attribute vec2 aRef; uniform sampler2D tPos, tVel; uniform float uScale, uLife, uDensity, uEmitY;
      varying float vA; varying float vAge; varying float vH;
      void main() {
        vec4 P = texture2D(tPos, aRef);
        float f = P.w / uLife;
        if (P.w < 0.0 || f >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
        gl_Position = projectionMatrix * mv;
        float r = 0.016 + 0.12 * pow(f, 0.6);                    // puffs thin out as they spread
        gl_PointSize = clamp(r * uScale / -mv.z, 1.5, 60.0);
        float fadeIn = smoothstep(0.0, 8.0, P.w);
        vA = uDensity * fadeIn * pow(1.0 - f, 1.6) * (0.4 + 0.6 * (1.0 - pow(f, 0.5)));
        vAge = f;
        vH = clamp((P.y - uEmitY) * 2.0, 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uLight; varying float vA; varying float vAge; varying float vH;
      void main() {
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        float d2 = dot(q, q);
        if (d2 > 1.0) discard;
        float a = exp(-d2 * 3.2) * vA;
        // Young smoke is dense and dark; it lightens as it dilutes, and the upper, sunnier side of the plume is brighter.
        vec3 col = mix(vec3(0.16, 0.16, 0.17), vec3(0.70, 0.72, 0.76), smoothstep(0.0, 0.8, vAge));
        col *= 0.8 + 0.35 * vH;
        float lit = 0.5 + 0.5 * clamp(dot(normalize(vec3(q * 0.7, sqrt(max(0.0, 1.0 - 0.49 * d2)))), uLight), -1.0, 1.0);
        col *= 0.75 + 0.35 * lit;
        gl_FragColor = vec4(col, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  pivot.add(points);

  let simT = 0, active = false, statClock = 0;
  const drift = new THREE.Vector3();
  const sunView = new THREE.Vector3();
  const sz = new THREE.Vector2();

  function update(dt) {
    if (!active) return;
    const dtS = dt * TIME_LAPSE;
    windStep(dtS);
    simT += dtS;
    drift.x += (cur.x * cur.speed * dtS) / 1000; drift.z += (cur.z * cur.speed * dtS) / 1000;
    topWorld();
    const U = sharedUniforms;
    U.uDt.value = dtS; U.uTime.value = simT;
    U.uWindSpeed.value = cur.speed; U.uWindDir.value.set(cur.x, cur.z); U.uDrift.value.copy(drift);
    // Stronger wind mixes the plume faster: it bends over, cools sooner and rises less.
    velVar.material.uniforms.uTauT.value = 70 / (1 + cur.speed / 5);
    posVar.material.uniforms.uSigma.value = 0.9 + 0.2 * cur.speed;
    gpu.compute();
    mat.uniforms.tPos.value = gpu.getCurrentRenderTarget(posVar).texture;
    mat.uniforms.tVel.value = gpu.getCurrentRenderTarget(velVar).texture;
    mat.uniforms.uEmitY.value = emitPos.y;
    sunView.copy(lightDir).normalize().transformDirection(camera.matrixWorldInverse);
    mat.uniforms.uLight.value.copy(sunView);
    renderer.getDrawingBufferSize(sz);
    mat.uniforms.uScale.value = sz.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
    statClock += dt;
    if (statClock > 0.15) {
      statClock = 0;
      ui.onWind?.({ speed: cur.speed, fromDeg: cur.fromDeg, nominalFrom: wind.from, text:
        `Wind now ${cur.speed.toFixed(1)} m/s from ${cardinal(cur.fromDeg)} (${Math.round(((cur.fromDeg % 360) + 360) % 360)}°)` });
    }
  }

  function clear() {
    const p = gpu.createTexture(), v = gpu.createTexture();
    topWorld(); fill(p, v);
    gpu.renderTexture(p, posVar.renderTargets[0]); gpu.renderTexture(p, posVar.renderTargets[1]);
    gpu.renderTexture(v, velVar.renderTargets[0]); gpu.renderTexture(v, velVar.renderTargets[1]);
    p.dispose(); v.dispose();
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
    clear,
    TIME_LAPSE,
  };
}
