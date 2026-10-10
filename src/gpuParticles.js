import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

// A GPU particle system (smoke, flames ...). State lives in two float textures, one texel per particle:
//   position: xyz (scene units, km), w = age in simulated seconds (negative = waiting to be released)
//   velocity: xyz (m/s, mean motion), w = excess temperature (1 = fresh)
// Particles are released from a list of emitter points (a small texture the caller fills), relax toward the
// wind, rise on buoyancy, are shredded by divergence-free curl-noise eddies that grow with age, and are
// drawn as soft noise-eroded sprites. The hashes avoid sin() on purpose: sin() of big arguments is
// unreliable on mobile GPUs.

const NOISE = `
  float hash3(vec3 p) { p = fract(mod(p, 61.0) * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float hash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  // Value noise with analytic derivatives (Inigo Quilez): (value, d/dx, d/dy, d/dz).
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

const EMIT_SIDE = 64;   // emitter texture is 64 x 64 = 4096 points

export function createGpuParticles({ terrain, pivot, camera, renderer, lightDir, side, life, timeLapse, exag = 4, params, look }) {
  const N = side * side;
  const gpu = new GPUComputationRenderer(side, side, renderer);

  const emitData = new Float32Array(EMIT_SIDE * EMIT_SIDE * 4);
  const emitTex = new THREE.DataTexture(emitData, EMIT_SIDE, EMIT_SIDE, THREE.RGBAFormat, THREE.FloatType);
  emitTex.needsUpdate = true;

  const U = {
    uDt: { value: 0 }, uTime: { value: 0 }, uSeed: { value: 0 }, uLife: { value: life },
    uWindSpeed: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) }, uDrift: { value: new THREE.Vector3() },
    uExag: { value: exag }, uHalfW: { value: terrain.widthKm / 2 + 1.2 }, uHalfD: { value: terrain.depthKm / 2 + 1.2 },
    tHeight: { value: null }, uMapA: { value: new THREE.Vector4() },
    tEmit: { value: emitTex }, uEmitCount: { value: 0 }, uSpawnProb: { value: 1 },
    uBuoy: { value: params.buoy }, uTauT: { value: params.tauT }, uTauD: { value: params.tauD }, uTauH: { value: params.tauH },
    uSpawnUp: { value: params.spawnUp }, uSpawnJit: { value: params.spawnJit }, uWindScale: { value: params.windScale ?? 1 },
    uSigma: { value: params.sigma }, uK: { value: params.K }, uEdy: { value: params.eddyRamp ?? 0.3 },
  };

  // Terrain heights as a small half-float texture plus the affine map from local x,z to its uv.
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
    U.tHeight.value = ht;
    U.uMapA.value.set(f0u, f0v, su, sv);
  }

  const COMMON = `
    uniform float uDt, uTime, uSeed, uLife, uExag, uHalfW, uHalfD; uniform vec3 uDrift; uniform vec2 uWindDir; uniform float uWindSpeed;
    uniform sampler2D tHeight, tEmit; uniform vec4 uMapA; uniform float uEmitCount, uSpawnProb;
    float ground(vec2 xz) {
      vec2 t = vec2(uMapA.x + xz.x * uMapA.z, uMapA.y + xz.y * uMapA.w);
      return texture2D(tHeight, clamp(t, 0.0, 1.0)).r + 0.004;
    }
    ${NOISE}
    float lifeOf(vec2 uv) { return uLife * (0.85 + 0.3 * hash2(uv * 91.7)); }
    bool spawning(vec4 P, vec2 uv) {
      bool oob = abs(P.x) > uHalfW || abs(P.z) > uHalfD;
      return (P.w < 0.0 && P.w + uDt >= 0.0) || (P.w >= 0.0 && (P.w + uDt > lifeOf(uv) || oob));
    }
    bool mayRelease(vec2 uv) { return uEmitCount >= 0.5 && hash2(uv * 29.1 + uSeed * 1.3) <= uSpawnProb; }
    vec4 pickEmitter(vec2 uv) {
      float idx = min(floor(hash2(uv * 17.3 + uSeed) * uEmitCount), uEmitCount - 1.0);
      return texture2D(tEmit, (vec2(mod(idx, ${EMIT_SIDE}.0), floor(idx / ${EMIT_SIDE}.0)) + 0.5) / ${EMIT_SIDE}.0);
    }
  `;

  const velShader = COMMON + `
    uniform float uBuoy, uTauT, uTauD, uTauH, uSpawnUp, uSpawnJit, uWindScale;
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 P = texture2D(texturePosition, uv);
      vec4 V = texture2D(textureVelocity, uv);
      if (P.w < 0.0 && P.w + uDt < 0.0) { gl_FragColor = vec4(0.0); return; }
      vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y) * uWindSpeed * uWindScale;
      if (spawning(P, uv)) {
        float j = hash2(uv * 13.3 + uSeed);
        vec3 rj = vec3(hash2(uv * 5.1 + uSeed), hash2(uv * 8.7 - uSeed), hash2(uv * 3.3 + uSeed * 1.7)) - 0.5;
        float heat = mayRelease(uv) ? pickEmitter(uv).w : 1.0;
        gl_FragColor = vec4(wind.x * 0.25 + rj.x * uSpawnJit, uSpawnUp * (0.6 + 0.8 * j) + rj.y * uSpawnJit, wind.z * 0.25 + rj.z * uSpawnJit, heat);
        return;
      }
      float aglM = max(0.0, (P.y - ground(P.xz)) / (uExag * 0.001));
      vec3 w = wind * (1.0 + 0.3 * tanh(aglM / 90.0));
      V.xz += (w.xz - V.xz) * (1.0 - exp(-uDt / uTauH));
      V.y += uBuoy * V.w * uDt - V.y * (1.0 - exp(-uDt / uTauD));
      V.w *= exp(-uDt / uTauT);
      if (P.y <= ground(P.xz) + 0.002) V.y = max(V.y, 0.0);
      gl_FragColor = V;
    }`;

  const posShader = COMMON + `
    uniform float uSigma, uK, uEdy;
    vec3 turbulence(vec3 p, float age) {
      vec3 sum = vec3(0.0);
      for (int j = 0; j < 5; j++) {
        float L = 0.9 * pow(0.46, float(j));
        float A = uSigma * pow(L / 0.9, 0.33) * 1.6;
        float tau = L * 1000.0 / A;
        float wgt = smoothstep(0.0, 1.0, age / (uEdy * tau + 4.0));
        if (wgt <= 0.0) continue;
        vec3 q = (p - uDrift) / L + vec3(float(j) * 13.1, float(j) * 7.7, float(j) * 3.3) + vec3(0.3, 0.5, 0.2) * uTime / tau;
        q = mod(q, 61.0);
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
      if (P.w < 0.0 && P.w + uDt < 0.0) { gl_FragColor = vec4(0.0, -50.0, 0.0, P.w + uDt); return; }
      if (spawning(P, uv)) {
        if (!mayRelease(uv)) { gl_FragColor = vec4(0.0, -50.0, 0.0, -uLife * (0.2 + 0.8 * hash2(uv * 5.5 + uSeed))); return; }
        float over = P.w < 0.0 ? P.w + uDt : 0.0;
        float a = hash2(uv * 7.1 + uSeed) * 6.2831853;
        vec3 em = pickEmitter(uv).xyz;
        vec3 p0 = em + vec3(cos(a), 0.0, sin(a)) * 0.008 * hash2(uv + 3.0) + vec3(V.x, V.y * uExag, V.z) * (over * 0.001);
        gl_FragColor = vec4(p0, over);
        return;
      }
      vec3 t = turbulence(P.xyz, P.w);
      vec3 vel = V.xyz + t * vec3(1.0, 0.6, 1.0);
      vec3 g = vec3(hash2(uv * 4.3 + uSeed) + hash2(uv * 9.1 - uSeed) + hash2(uv * 2.7 + uSeed * 1.3),
                    hash2(uv * 6.7 + uSeed * 0.7) + hash2(uv * 1.9 - uSeed) + hash2(uv * 8.3 + uSeed * 2.1),
                    hash2(uv * 3.1 - uSeed * 0.9) + hash2(uv * 7.7 + uSeed) + hash2(uv * 5.9 - uSeed * 1.6)) * 2.0 - 3.0;
      float K = uK * smoothstep(0.0, 60.0, P.w);
      vec3 jump = g * sqrt(2.0 * K * uDt) * 0.001 * vec3(1.0, 0.5 * uExag, 1.0);
      vec3 p = P.xyz + vec3(vel.x, vel.y * uExag, vel.z) * (uDt * 0.001) + jump;
      p.y = max(p.y, ground(p.xz));
      gl_FragColor = vec4(p, P.w + uDt);
    }`;

  const pos0 = gpu.createTexture(), vel0 = gpu.createTexture();
  function fill(posTex, velTex) {
    const pd = posTex.image.data, vd = velTex.image.data;
    for (let i = 0; i < N; i++) {
      pd[i * 4] = 0; pd[i * 4 + 1] = -50; pd[i * 4 + 2] = 0;
      pd[i * 4 + 3] = -Math.random() * life;       // released evenly over one lifetime -> steady emission
      vd[i * 4] = vd[i * 4 + 1] = vd[i * 4 + 2] = vd[i * 4 + 3] = 0;
    }
  }
  fill(pos0, vel0);
  const velVar = gpu.addVariable('textureVelocity', velShader, vel0);
  const posVar = gpu.addVariable('texturePosition', posShader, pos0);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  for (const v of [velVar, posVar]) for (const [k, u] of Object.entries(U)) v.material.uniforms[k] = u;
  const err = gpu.init();
  if (err) console.error('particle GPU init:', err);

  // --- Rendering ---
  const gl = renderer.getContext();
  const maxPoint = Math.floor(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
  const ref = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { ref[i * 2] = ((i % side) + 0.5) / side; ref[i * 2 + 1] = (Math.floor(i / side) + 0.5) / side; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const col = (c) => new THREE.Vector3(...c);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      tPos: { value: null }, uScale: { value: 1 }, uLife: { value: life }, uMaxPt: { value: Math.min(60, maxPoint) }, uKeep: { value: 1 },
      uDensity: { value: look.density }, uSize0: { value: look.size0 }, uSizeGrow: { value: look.sizeGrow }, uFadePow: { value: look.fadePow },
      uFadeIn: { value: look.fadeIn }, uLightAmt: { value: look.lightAmt }, uLight: { value: new THREE.Vector3(0, 1, 0) },
      uCol0: { value: col(look.col0) }, uCol1: { value: col(look.col1) }, uCol2: { value: col(look.col2) },
    },
    vertexShader: `
      attribute vec2 aRef; uniform sampler2D tPos; uniform float uScale, uLife, uMaxPt, uKeep, uDensity, uSize0, uSizeGrow, uFadePow, uFadeIn;
      varying float vA; varying float vAge; varying float vSeed;
      float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main() {
        vec4 P = texture2D(tPos, aRef);
        float f = P.w / uLife;
        if (P.w < 0.0 || f >= 1.0 || h21(aRef * 57.1) > uKeep) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        vSeed = h21(aRef * 97.3);
        vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
        gl_Position = projectionMatrix * mv;
        float r = (uSize0 + uSizeGrow * pow(f, 0.6)) * (0.65 + 0.7 * vSeed);
        gl_PointSize = clamp(r * uScale / -mv.z, 1.5, uMaxPt);
        vA = uDensity * smoothstep(0.0, uFadeIn, P.w) * pow(1.0 - f, uFadePow) * (0.6 + 0.8 * h21(aRef * 41.7)) * pow(1.0 / uKeep, 0.85);
        vAge = f;
      }`,
    fragmentShader: `
      uniform vec3 uLight, uCol0, uCol1, uCol2; uniform float uLightAmt;
      varying float vA; varying float vAge; varying float vSeed;
      float hh(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hh(i), hh(i + vec2(1.0, 0.0)), f.x), mix(hh(i + vec2(0.0, 1.0)), hh(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        float ang = vSeed * 6.2831853, cs = cos(ang), sn = sin(ang);
        vec2 r = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
        float n1 = vn(r * 2.4 + vSeed * 31.0), n2 = vn(r * 5.1 + vSeed * 17.0 + 7.3);
        float d2 = dot(q, q) * (0.65 + 0.9 * n1);
        if (d2 > 1.0) discard;
        float a = exp(-d2 * 3.4) * vA * (0.45 + 0.9 * n2);
        vec3 c = mix(uCol0, uCol1, smoothstep(0.0, 0.35, vAge));
        c = mix(c, uCol2, smoothstep(0.3, 1.0, vAge));
        float lit = 0.5 + 0.5 * clamp(dot(normalize(vec3(q * 0.7, sqrt(max(0.0, 1.0 - 0.49 * d2)))), uLight), -1.0, 1.0);
        c *= mix(1.0, 0.75 + 0.35 * lit, uLightAmt);
        gl_FragColor = vec4(c, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = look.renderOrder ?? 0;
  pivot.add(points);

  let simT = 0, fps = 60, keep = 1, keepClock = 0;
  const drift = new THREE.Vector3();
  const sunView = new THREE.Vector3();
  const sz = new THREE.Vector2();
  const maxAdapt = look.adapt ?? true;

  return {
    object: points,
    count: N,
    /** emitters: Float32Array of (x, y, z, heat) in scene units; spawnProb 0..1 scales how many puffs are released. */
    setEmitters(list, count, spawnProb) {
      const n = Math.min(count, EMIT_SIDE * EMIT_SIDE);
      emitData.set(list.subarray(0, n * 4));
      emitTex.needsUpdate = true;
      U.uEmitCount.value = n;
      U.uSpawnProb.value = spawnProb;
    },
    update(dtReal, wind) {
      const dtS = dtReal * timeLapse;
      simT += dtS;
      drift.x += (wind.x * wind.speed * dtS) / 1000; drift.z += (wind.z * wind.speed * dtS) / 1000;
      U.uDt.value = dtS; U.uTime.value = simT; U.uSeed.value = Math.random() * 50;
      U.uWindSpeed.value = wind.speed; U.uWindDir.value.set(wind.x, wind.z); U.uDrift.value.copy(drift);
      if (params.windMix) { U.uTauT.value = params.tauT / (1 + wind.speed / 5); }
      U.uSigma.value = params.sigma + (params.sigmaWind || 0) * wind.speed;
      U.uK.value = params.K + (params.Kwind || 0) * wind.speed;
      gpu.compute();
      mat.uniforms.tPos.value = gpu.getCurrentRenderTarget(posVar).texture;
      sunView.copy(lightDir).normalize().transformDirection(camera.matrixWorldInverse);
      mat.uniforms.uLight.value.copy(sunView);
      renderer.getDrawingBufferSize(sz);
      mat.uniforms.uScale.value = sz.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
      // Draw a smaller share of the particles if the frame rate drops.
      fps += (1 / Math.max(dtReal, 1e-3) - fps) * 0.05;
      keepClock += dtReal;
      if (maxAdapt && keepClock > 1) {
        keepClock = 0;
        if (fps < 28) keep = Math.max(0.2, keep * 0.8);
        else if (fps > 52 && keep < 1) keep = Math.min(1, keep * 1.1);
        mat.uniforms.uKeep.value = keep;
      }
    },
    show(v) { points.visible = v; },
    clear() {
      const p = gpu.createTexture(), v = gpu.createTexture();
      fill(p, v);
      gpu.renderTexture(p, posVar.renderTargets[0]); gpu.renderTexture(p, posVar.renderTargets[1]);
      gpu.renderTexture(v, velVar.renderTargets[0]); gpu.renderTexture(v, velVar.renderTargets[1]);
      p.dispose(); v.dispose();
      U.uEmitCount.value = 0;
    },
    info: () => ({ keep, fps }),
  };
}
