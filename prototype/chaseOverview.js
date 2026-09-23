// 回収モード専用。南側の斜め上から、実際の気球・車・マーカーを同時に収める。
import * as THREE from 'three';

export function createChaseOverview({ camera, scene, getHeight }) {
  const back = new THREE.Vector3(0, 1, 1).normalize();
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, -1).normalize();
  const center = new THREE.Vector3();
  const box = new THREE.Box3();
  const desired = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const originalFog = scene.fog, originalFar = camera.far;
  let distance = 120, initialized = false;
  function reset() { initialized = false; }
  const labels = document.createElement('div');
  labels.id = 'chase-overview-labels';
  labels.hidden = true;
  const items = new Map();
  for (const [id, text] of [['balloon', '気球'], ['car', '車'], ['marker', 'マーカー']]) {
    const el = document.createElement('span');
    el.className = `chase-map-label chase-map-${id}`;
    el.textContent = text;
    labels.appendChild(el);
    items.set(id, el);
  }
  document.body.appendChild(labels);

  function hide() {
    labels.hidden = true;
    reset();
    camera.clearViewOffset();
    camera.far = originalFar;
    camera.updateProjectionMatrix();
    scene.fog = originalFog;
  }

  function update(points, dt, insets) {
    const width = innerWidth, height = innerHeight;
    const left = insets.left + 40, top = insets.top + 32;
    const safeWidth = Math.max(80, width - left - insets.right - 40);
    const safeHeight = Math.max(80, height - top - insets.bottom - 32);
    box.makeEmpty();
    const corners = [];
    const marker = points.find(p => p.id === 'marker');
    for (const { pos, radius } of points) {
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const p = new THREE.Vector3(pos.x + x * radius, pos.y + y * radius, pos.z + z * radius);
        corners.push(p);
        box.expandByPoint(p);
      }
    }
    box.getCenter(desired);
    const alpha = 1 - Math.exp(-Math.max(0, dt) * 4);
    if (!initialized) center.copy(desired);
    else center.lerp(desired, alpha);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * width / height;
    let required = 120;
    for (const p of corners) {
      delta.subVectors(p, center);
      required = Math.max(required, delta.dot(back) + Math.max(
        Math.abs(delta.dot(right)) / (tanH * safeWidth / width),
        Math.abs(delta.dot(up)) / (tanV * safeHeight / height),
      ));
    }
    // 引くときは枠外に出さず、寄るときは滑らかに追う。
    distance = required;
    camera.position.copy(center).addScaledVector(back, distance);
    const ground = getHeight(camera.position.x, camera.position.z);
    distance = Math.max(distance, (ground + 60 - center.y) / back.y);
    camera.position.copy(center).addScaledVector(back, distance);
    camera.lookAt(center);
    camera.far = Math.max(originalFar, distance + box.min.distanceTo(box.max) + 1000);
    // UIを除いた矩形の中心に光軸をずらす。縦画面でも上下を同じように扱う。
    camera.setViewOffset(width, height, width / 2 - (left + safeWidth / 2),
      height / 2 - (top + safeHeight / 2), width, height);
    camera.updateMatrixWorld();
    scene.fog = null; // 遠距離の俯瞰で地形が一面の霧に埋もれないようにする
    labels.hidden = false;
    for (const el of items.values()) el.hidden = true;
    for (const { id, pos } of points) {
      projected.copy(pos).project(camera);
      const el = items.get(id);
      if (id === 'marker') el.textContent = marker?.landed ? 'マーカー着地点' : 'マーカー';
      el.hidden = projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1;
      el.style.left = `${(projected.x + 1) * width / 2}px`;
      el.style.top = `${(1 - projected.y) * height / 2}px`;
    }
    initialized = true;
  }
  return { update, hide, reset };
}
