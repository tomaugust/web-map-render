import * as THREE from 'three';

// Mouse -> terrain: march the pointer ray (in map space) until it dips below the surface.
export function createPicker({ terrain, pivot, camera }) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const p = new THREE.Vector3(), dir = new THREE.Vector3();
  const hw = terrain.widthKm / 2 + 0.3, hd = terrain.depthKm / 2 + 0.3;
  return function pick(clientX, clientY, rect) {
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    pivot.updateMatrixWorld(true);
    const a = pivot.worldToLocal(ray.ray.origin.clone());
    const b = pivot.worldToLocal(ray.ray.origin.clone().add(ray.ray.direction));
    dir.copy(b).sub(a).normalize();
    for (let s = 0; s < 1800; s++) {
      p.copy(a).addScaledVector(dir, s * 0.04);
      if (Math.abs(p.x) > hw || Math.abs(p.z) > hd) continue;
      if (p.y <= terrain.surfaceY(p.x, p.z)) return [p.x, p.z];
    }
    return null;
  };
}
