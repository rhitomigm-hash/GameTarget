// PLATEAU 検証ページ(第0段階)。ゲーム本体には一切影響しない。
//
// ここで確かめたいこと:
//   1. PLATEAU の建物を prototype/terrain.js の地形の上に、位置ずれなく重ねられるか
//   2. 楕円体高と標高の差(ジオイド高)が実際に何mか。自動推定は使えるか
//   3. Range で glTF だけ取る節約がどれくらい効くか
//   4. 描画負荷(頂点数・FPS)は熱気球の飛行に耐えるか
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTerrain } from '../../prototype/terrain.js';
// 本体と同じものを使う(第1段階で prototype/ へ移した)
import { loadBuildings, estimateGeoidOffset } from '../../prototype/plateau.js';

// 検証地点。既定は千代田区(大手町付近)
const PRESETS = {
  '13101': { name: '東京都千代田区(大手町)', lon: 139.7516, lat: 35.6861 },
  '13104': { name: '東京都新宿区(新宿駅)',   lon: 139.7005, lat: 35.6896 },
  '14100': { name: '神奈川県横浜市(みなとみらい)', lon: 139.6317, lat: 35.4574 },
  '27100': { name: '大阪府大阪市(梅田)',     lon: 135.4959, lat: 34.7025 },
};

const params = new URLSearchParams(location.search);
const cityCode = params.get('city') || '13101';
const preset = PRESETS[cityCode] || PRESETS['13101'];
const centerLon = Number(params.get('lon')) || preset.lon;
const centerLat = Number(params.get('lat')) || preset.lat;
const radiusM = Number(params.get('r')) || 2500;
// LOD2 はテクスチャ付きだが、タイルが小さく枚数が多い(千代田区で末端463枚、1枚 0.1〜1.1MB)。
// LOD1 は1枚が重い(同 約20枚、1枚 12.9MB)ので、既定の枚数を変える
const lod = Number(params.get('lod')) === 2 ? 2 : 1;
const maxTiles = Number(params.get('n')) || (lod === 2 ? 40 : 4);

const el = (id) => document.getElementById(id);
const setLog = (msg) => { el('log').textContent = msg; };

// --- シーン ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4e8);
scene.fog = new THREE.Fog(0x9fc4e8, 3000, 12000);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 40000);
camera.position.set(0, 900, 1400);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI / 2.05;
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdff0ff, 0x707060, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-1500, 2500, -1200);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- 読み込み -------------------------------------------------------------
let buildingGroup = null;
let terrainApi = null;
let autoOffset = null;

async function boot() {
  el('site').textContent =
    `${preset.name} / ${cityCode} / LOD${lod}${lod === 2 ? '(テクスチャ付き)' : '(箱のみ)'}`;

  setLog('地形(地理院タイル)を読み込み中…');
  const t0 = performance.now();
  terrainApi = await buildTerrain(centerLon, centerLat, 1,
    (d, t) => setLog(`地形を読み込み中… ${d}/${t}`));
  scene.add(terrainApi.group);
  const terrainMs = Math.round(performance.now() - t0);

  setLog('PLATEAU の建物を読み込み中…');
  let result;
  try {
    result = await loadBuildings({
      cityCode, centerLon, centerLat, radiusM, maxTiles, lod,
      onProgress: (d, t, m) => setLog(`${m}(${d}/${t})`),
    });
  } catch (err) {
    setLog(`建物の読み込みに失敗: ${err.message}`);
    console.error(err);
    return;
  }
  if (!result.stats.covered) {
    setLog('この範囲に PLATEAU の整備データがありません。地点を変えてください');
    return;
  }

  buildingGroup = result.group;
  scene.add(buildingGroup);

  // ジオイド高を推定して、建物を標高基準に合わせる
  const est = estimateGeoidOffset(buildingGroup, terrainApi.getHeight);
  if (est) {
    autoOffset = est.offset;
    applyOffset(est.offset);
    el('offset').value = est.offset.toFixed(1);
    el('offsetOut').textContent = `${est.offset.toFixed(1)} m`;
    el('estimate').textContent =
      `推定 ${est.offset.toFixed(2)} m(標本 ${est.samples} / ばらつき(四分位範囲) ${est.spread.toFixed(2)} m)`;
  } else {
    el('estimate').textContent = '推定できず(標本不足)。手動で合わせてください';
  }

  const s = result.stats;
  const saved = s.fullBytes > 0 ? (1 - s.fetchedBytes / s.fullBytes) * 100 : 0;
  el('stats').innerHTML = [
    `地形: ${terrainMs} ms`,
    `tileset 内の末端タイル: ${s.tilesInTileset} 枚 / 読み込み: ${s.tilesLoaded} 枚(${s.ms} ms)`,
    `建物: ${s.buildings.toLocaleString()} 棟 / 頂点: ${s.vertices.toLocaleString()}`,
    `テクスチャ付きメッシュ: ${s.textured} 個`
      + (lod === 1 ? ' <span class="muted">(LOD1 は仕様上テクスチャを持たない)</span>' : ''),
    `通信量: ${(s.fetchedBytes / 1048576).toFixed(1)} MB`
      + ` (b3dm 全体なら ${(s.fullBytes / 1048576).toFixed(1)} MB → <b>${saved.toFixed(0)}% 削減</b>)`,
    s.rangeMisses > 0 ? `<span class="warn">Range 不可のタイル: ${s.rangeMisses} 枚</span>` : '',
  ].filter(Boolean).join('<br>');

  setLog('読み込み完了。ドラッグで回転、ホイールで拡大縮小');
}

function applyOffset(offset) {
  if (buildingGroup) buildingGroup.position.y = -offset;
}

el('offset').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  el('offsetOut').textContent = `${v.toFixed(1)} m`;
  applyOffset(v);
});
el('reset').addEventListener('click', () => {
  if (autoOffset == null) return;
  el('offset').value = autoOffset.toFixed(1);
  el('offsetOut').textContent = `${autoOffset.toFixed(1)} m`;
  applyOffset(autoOffset);
});
el('wire').addEventListener('change', (e) => {
  if (!buildingGroup) return;
  buildingGroup.traverse((o) => { if (o.isMesh) o.material.wireframe = e.target.checked; });
});
el('hideTerrain').addEventListener('change', (e) => {
  if (terrainApi) terrainApi.group.visible = !e.target.checked;
});

// --- 切り替えリンク(いま見ている条件を引き継ぐ) --------------------------
const linkTo = (over) => {
  const q = new URLSearchParams({ city: cityCode, lod: String(lod), ...over });
  return `?${q}`;
};
const mark = (text, href, active) =>
  active ? `<b>${text}</b>` : `<a href="${href}">${text}</a>`;

el('lodLinks').innerHTML = [1, 2]
  .map((v) => mark(`LOD${v}`, linkTo({ lod: String(v) }), v === lod))
  .join(' / ');
el('cityLinks').innerHTML = Object.entries(PRESETS)
  .map(([code, p]) => mark(p.name.replace(/[(（].*/, ''), linkTo({ city: code }), code === cityCode))
  .join(' / ');

// --- 描画ループ -----------------------------------------------------------
let frames = 0;
let lastFpsAt = performance.now();
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsAt >= 500) {
    el('fps').textContent = `${Math.round((frames * 1000) / (now - lastFpsAt))} fps`;
    frames = 0;
    lastFpsAt = now;
  }

  // カメラ直下の地形テクスチャを段階的に上げる(本体と同じ挙動を確認するため)
  if (terrainApi) terrainApi.updateDetail(controls.target.x, controls.target.z);
}

animate();
boot();
