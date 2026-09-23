import * as THREE from 'three';

export const TARGET_STANDOFF_M = 100;
export const REPORT_MAX_DISTANCE_M = 400;
export const REPORT_STOP_SPEED_MPS = 0.05;

// 距離はターゲットからの水平距離。表示用に丸めた速度で停車を判定しない。
export function groundWindReportStatus({ active, distance, speedMps }) {
  if (!active) return 'inactive';
  if (!Number.isFinite(distance) || distance < TARGET_STANDOFF_M) return 'too-close';
  if (distance > REPORT_MAX_DISTANCE_M) return 'too-far';
  if (!Number.isFinite(speedMps) || Math.abs(speedMps) > REPORT_STOP_SPEED_MPS) return 'moving';
  return 'ready';
}

// 橙のXの中心と腕を確認。画面外・UI・地形・建物・車体に隠れた点は見えていると扱わない。
export function isTargetVisible({ camera, target, scene, width, height, screenVisible = () => true }) {
  if (!target.visible || width <= 0 || height <= 0) return false;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();
  const center = target.getWorldPosition(new THREE.Vector3());
  const ray = new THREE.Raycaster();
  const occluders = scene.children.filter(object => object !== target);
  for (const [x, z] of [[0, 0], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
    const point = center.clone().add(new THREE.Vector3(x, 0.1, z));
    const projected = point.clone().project(camera);
    if (![projected.x, projected.y, projected.z].every(Number.isFinite)
      || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) continue;
    if (!screenVisible((projected.x + 1) * width / 2, (1 - projected.y) * height / 2)) continue;
    const distance = camera.position.distanceTo(point);
    if (scene.fog?.isFog && distance >= scene.fog.far) continue;
    ray.set(camera.position, point.clone().sub(camera.position).normalize());
    ray.near = camera.near;
    ray.far = Math.max(camera.near, distance - 0.25);
    const blocked = ray.intersectObjects(occluders, true).some(hit => {
      if (!hit.object.isMesh) return false;
      for (let object = hit.object; object; object = object.parent) if (!object.visible) return false;
      const material = Array.isArray(hit.object.material)
        ? hit.object.material[hit.face?.materialIndex || 0] : hit.object.material;
      return material?.visible !== false && material?.depthTest !== false
        && (!material?.transparent || material.opacity > 0.9);
    });
    if (!blocked) return true;
  }
  return false;
}
