// 第二チェイスカー(2号車)の**実装そのもの**を実データで動かす検証(2026-08-28)。
//
// probe-target-run.mjs は「A* がターゲット手前まで引けるか」を、この検証用に書き直した
// 経路探索で測ったもの。こちらは **prototype/chasecar.js を書き換えずにそのまま読み込んで**
// 走らせる。確かめたいのは仕様メモ 6/7/10節が実装で成立しているか:
//
//   1. 2号車が1号車と重ならない位置に置かれるか(20m以上)
//   2. ターゲットの手前(100m以上離れた最寄りの端点)に着いて、そこで**止まったままか**
//   3. **タイルを走りながら足す**条件下でも着けるか(先に全域を読まない)
//   4. 「これ以上進めない」を**出発直後に言ってしまわないか**(仕様メモ10節の落とし穴)
//
// 使い方:
//   node probe-second-car-drive.mjs [距離km,...] [方位刻み度]
//
// three.js と road.js は Node に無いので、chasecar.js のソースの import 行だけを
// 差し替えて読み込む。**ロジックには一切手を触れない**(触ると検証にならない)。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLayers, fetchTile } from './mvt.mjs';

const ROAD_Z = 14;
const EARTH_CIRC = 40075016.686;
const INIT_RADIUS_M = 3000;     // road.js の初期読み込み(**世界原点=ターゲットまわり**)
const STREAM_RADIUS_M = 2500;   // 走行中の先読み
const MAX_TILES = 64;           // main.js の maxTilesTotal
const STREAM_INTERVAL_S = 3;    // main.js は3秒に1回、気球と2号車で交互に足す
const STANDOFF_M = 100;
const MIN_SEP_M = 20;
const SIM_S = 30 * 60;          // 30分(第2段階の追尾検証と同じ長さ)
const DT = 0.2;

const PRESET_AREAS = [
  { name: '佐賀・嘉瀬川', lon: 130.25, lat: 33.27 },
  { name: '渡良瀬遊水地', lon: 139.68, lat: 36.22 },
  { name: '佐久・千曲川', lon: 138.48, lat: 36.25 },
  { name: '一関・平泉', lon: 141.13, lat: 38.93 },
  { name: '上士幌(北海道)', lon: 143.30, lat: 43.23 },
];

const DISTS = (process.argv[2] ?? '3,5,8').split(',').map(Number);
const BRG_STEP = Number(process.argv[3] ?? 90);
const BEARINGS = [];
for (let b = 0; b < 360; b += BRG_STEP) BEARINGS.push(b);

const fTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const fTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// --- prototype/chasecar.js を、import 行だけ差し替えて読み込む -----------------
// three.js は車体メッシュを組み立てるためだけに使われているので、最小限の張りぼてで足りる
const STUB = `
class Obj3D {
  constructor() { this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.rotation = { x: 0, y: 0, z: 0 }; this.children = []; this.userData = {}; this.visible = true; }
  add(o) { this.children.push(o); }
}
const THREE = {
  Group: Obj3D, Mesh: Obj3D,
  BoxGeometry: class {}, CylinderGeometry: class {},
  MeshLambertMaterial: class {}, MeshBasicMaterial: class {},
};
const isMotorway = (p) => p.motorway === 1 || p.rdCtg === 3 || p.tollSect === 1;
const DRAPE_LIFT = 1.5;
`;

async function loadChaseCar() {
  const srcPath = new URL('../../prototype/chasecar.js', import.meta.url);
  let src = readFileSync(srcPath, 'utf8');
  src = src.replace("import * as THREE from 'three';", '');
  src = src.replace("import { isMotorway, DRAPE_LIFT } from './road.js';", '');
  const dir = mkdtempSync(join(tmpdir(), 'chasecar-'));
  const out = join(dir, 'chasecar-under-test.mjs');
  writeFileSync(out, STUB + src, 'utf8');
  return (await import(pathToFileURL(out).href)).createChaseCar;
}

// --- road.js と同じグラフの組み方(タイルを足すと同じグラフに繋がる) -----------
function makeRoads(area) {
  const tileMeters = (EARTH_CIRC / 2 ** ROAD_Z) * Math.cos((area.lat * Math.PI) / 180);
  const c = { x: fTileX(area.lon, ROAD_Z), y: fTileY(area.lat, ROAD_Z) };
  const nodes = new Map();
  const edges = new Map();
  const loadedTiles = new Set();
  let bytes = 0;

  async function addTile(tx, ty) {
    const id = `${tx}_${ty}`;
    if (loadedTiles.has(id)) return;
    loadedTiles.add(id);
    let road = null;
    try {
      const buf = await fetchTile(ROAD_Z, tx, ty);
      if (!buf) return;
      bytes += buf.length;
      road = readLayers(buf)['road'];
    } catch { return; }
    if (!road) return;
    const ext = road.extent;
    for (const f of road.features) {
      if (f.type !== 2) continue;
      if (f.props.rnkWidth === undefined) continue;   // 道路の縁は走行グラフに入れない
      for (const ln of f.lines) {
        if (ln.length < 2) continue;
        const pts = [];
        for (const [px, py] of ln) pts.push(tx * ext + px, ty * ext + py);
        const a = `${pts[0]}_${pts[1]}`;
        const b = `${pts[pts.length - 2]}_${pts[pts.length - 1]}`;
        if (a === b) continue;
        const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (edges.has(ek)) continue;
        const world = new Float64Array(pts.length);
        for (let k = 0; k < pts.length; k += 2) {
          world[k] = (pts[k] / ext - c.x) * tileMeters;
          world[k + 1] = (pts[k + 1] / ext - c.y) * tileMeters;
        }
        let len = 0;
        for (let k = 2; k < world.length; k += 2) {
          len += Math.hypot(world[k] - world[k - 2], world[k + 1] - world[k - 1]);
        }
        edges.set(ek, { key: ek, a, b, world, lengthM: len, props: f.props });
        for (const [key, ix] of [[a, 0], [b, world.length - 2]]) {
          if (!nodes.has(key)) nodes.set(key, { x: world[ix], z: world[ix + 1], deg: 0, edgeKeys: [] });
          const n = nodes.get(key);
          n.deg++;
          n.edgeKeys.push(ek);
        }
      }
    }
  }

  function wantTiles(x, z, r) {
    const fx = c.x + x / tileMeters, fy = c.y + z / tileMeters;
    const span = Math.ceil(r / tileMeters);
    const want = [];
    for (let ty = Math.floor(fy) - span; ty <= Math.floor(fy) + span; ty++) {
      for (let tx = Math.floor(fx) - span; tx <= Math.floor(fx) + span; tx++) {
        if (loadedTiles.has(`${tx}_${ty}`)) continue;
        const d = Math.hypot((tx + 0.5 - fx) * tileMeters, (ty + 0.5 - fy) * tileMeters);
        if (d <= r) want.push({ tx, ty, d });
      }
    }
    want.sort((p, q) => p.d - q.d);
    return want;
  }

  async function ensureAround(x, z, r = STREAM_RADIUS_M) {
    const want = wantTiles(x, z, r);
    let capped = false;
    for (const t of want) {
      if (loadedTiles.size >= MAX_TILES) { capped = true; break; }
      await addTile(t.tx, t.ty);
    }
    return capped;
  }

  return {
    graph: { nodes, edges },
    ensureAround,
    pendingAround: (x, z, r = STREAM_RADIUS_M) => wantTiles(x, z, r).length,
    stat: () => ({ tiles: loadedTiles.size, bytes }),
  };
}

// 地形(DEM)の範囲。main.js は terrain.map から同じものを渡す。
// prototype/terrain.js は DEM_Z=13、main.js の TILE_RADIUS=2 で (2*2+1)^2 = 25枚。
// **この外へ出ると getHeight が 0(海面)を返し、車が地面の下に埋まる**
const DEM_Z = 13, TILE_RADIUS = 2;
function terrainBounds(area) {
  const tm = (EARTH_CIRC / 2 ** DEM_Z) * Math.cos((area.lat * Math.PI) / 180);
  const cx = fTileX(area.lon, DEM_Z), cy = fTileY(area.lat, DEM_Z);
  const n = TILE_RADIUS * 2 + 1;
  const minX = (Math.floor(cx) - TILE_RADIUS - cx) * tm;
  const minZ = (Math.floor(cy) - TILE_RADIUS - cy) * tm;
  return { minX, minZ, maxX: minX + n * tm, maxZ: minZ + n * tm };
}

// --- 1件ぶんの走行 ---------------------------------------------------------
async function run(createChaseCar, area, km, brg) {
  const roads = makeRoads(area);
  // road.js の初期読み込みは ensureAround(0, 0, radiusM) = **ターゲットまわり**
  await roads.ensureAround(0, 0, INIT_RADIUS_M);

  const rad = (brg * Math.PI) / 180;
  const lx = Math.sin(rad) * km * 1000, lz = -Math.cos(rad) * km * 1000;
  // 離陸地点まわりが未読なら、そこも読む(main.js は飛行中に足していく)
  await roads.ensureAround(lx, lz, STREAM_RADIUS_M);

  const getHeight = () => 0;                 // 走行は2Dなので高さは結果に効かない
  const TERRAIN_BOUNDS = terrainBounds(area);
  const car1 = createChaseCar({
    graph: roads.graph, getHeight, startX: lx, startZ: lz, kind: 'van', bounds: TERRAIN_BOUNDS,
  });
  if (!car1) return { skip: '走れる道が無い' };
  const i1 = car1.info();
  const car2 = createChaseCar({
    graph: roads.graph, getHeight, startX: lx, startZ: lz, kind: 'car',
    goal: { x: 0, z: 0, standoffM: STANDOFF_M },
    spawnAwayFrom: { x: i1.x, z: i1.z, minM: MIN_SEP_M },
    bounds: TERRAIN_BOUNDS,
  });
  if (!car2) return { skip: '2号車を置けない' };

  const s0 = car2.info();
  const sep = Math.hypot(s0.x - i1.x, s0.z - i1.z);

  // 気球は第2段階の検証と同じく 5m/s で流す(2号車は追わないが、タイルの取り合いは再現する)
  let bx = lx, bz = lz;
  const bvx = 5 * Math.sin(rad + Math.PI / 2), bvz = -5 * Math.cos(rad + Math.PI / 2);

  let t = 0, lastStream = 0, turn = 0, capped = false;
  let dist = 0, px = s0.x, pz = s0.z;
  let arrivedAt = null;
  // 画面で見つかった不具合の再現用(2026-08-28):
  //   - 2号車がターゲットを通り過ぎる → 最接近したあと離れていく
  //   - 2台とも消える → 座標が NaN になる / stuck で止まる
  let minGoal = s0.goalDistM, minGoalAt = 0, maxAfterMin = 0;
  let nan1 = false, nan2 = false;
  // 「これ以上進めない」と言ってしまった最初の時刻(仕様メモ10節の落とし穴の検出)
  let firstBlockedAt = null;
  let blockedThenMoved = false;

  while (t < SIM_S) {
    car1.update(DT, bx, bz);
    car2.update(DT);
    bx += bvx * DT; bz += bvz * DT;
    t += DT;

    const c = car2.info();
    const a = car1.info();
    if (!Number.isFinite(a.x) || !Number.isFinite(a.z)) nan1 = true;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) nan2 = true;
    if (nan1 || nan2) break;
    dist += Math.hypot(c.x - px, c.z - pz);
    px = c.x; pz = c.z;
    if (c.arrived && arrivedAt === null) arrivedAt = t;
    // 最接近したあと、どれだけ離れていったか(「通り過ぎた」の量)
    if (c.goalDistM < minGoal) { minGoal = c.goalDistM; minGoalAt = t; maxAfterMin = 0; }
    else if (c.goalDistM - minGoal > maxAfterMin) maxAfterMin = c.goalDistM - minGoal;

    // main.js と同じ判定(secondCarState)
    const blocked = !c.arrived && c.halted && !capped && roads.pendingAround(c.x, c.z) === 0;
    if (blocked && firstBlockedAt === null) firstBlockedAt = t;
    if (firstBlockedAt !== null && !c.halted) blockedThenMoved = true;

    if (t - lastStream >= STREAM_INTERVAL_S) {
      lastStream = t;
      const useCar2 = !c.arrived && (turn++ & 1) === 1;
      capped = await roads.ensureAround(useCar2 ? c.x : bx, useCar2 ? c.z : bz) || capped;
    }
    if (c.arrived) break;      // 到着したら以後は何も起きない(その確認は下で行う)
  }

  // 到着後に**動かない**ことを確かめる(追尾に戻らない)
  const after = car2.info();
  for (let k = 0; k < 500; k++) car2.update(DT);
  const post = car2.info();
  const drift = Math.hypot(post.x - after.x, post.z - after.z);

  const st = post.arrived ? 'arrived'
    : (post.halted && !capped && roads.pendingAround(post.x, post.z) === 0) ? 'blocked' : 'moving';

  return {
    sep, goalDistM: post.goalDistM, state: st, arrivedAt, drift, dist,
    firstBlockedAt, blockedThenMoved, capped,
    minGoal, minGoalAt, maxAfterMin, nan1, nan2,
    stuck1: car1.info().stuck, stuck2: post.stuck,
    ...roads.stat(),
  };
}

// --- 実行 ------------------------------------------------------------------
const createChaseCar = await loadChaseCar();

console.log(`prototype/chasecar.js をそのまま走らせる(z${ROAD_Z} / 上限${MAX_TILES}枚 / ${SIM_S / 60}分)`);
console.log(`離陸地点: ターゲットから ${DISTS.join('/')}km × 方位 ${BRG_STEP}°刻み(${BEARINGS.length}方向)`);
console.log(`目的地: ターゲットから ${STANDOFF_M}m 以上離れた最寄りの端点 / 2号車は1号車から ${MIN_SEP_M}m 以上\n`);

const all = [];
for (const area of PRESET_AREAS) {
  console.log(`■ ${area.name}`);
  for (const km of DISTS) {
    for (const brg of BEARINGS) {
      const r = await run(createChaseCar, area, km, brg);
      const label = `  ${km}km ${String(brg).padStart(3)}°`;
      if (r.skip) { console.log(`${label}: — ${r.skip}`); continue; }
      all.push({ area: area.name, km, brg, ...r });
      const state = r.state === 'arrived' ? '到着・待機'
        : r.state === 'blocked' ? 'これ以上進めない' : '移動中(まだ着かない)';
      console.log(
        `${label}: ${state.padEnd(9)} ターゲットまで ${String(Math.round(r.goalDistM)).padStart(5)}m`
        + ` / 2台の間隔 ${String(Math.round(r.sep)).padStart(4)}m`
        + ` / 走行 ${(r.dist / 1000).toFixed(1)}km`
        + ` / ${r.arrivedAt !== null ? `${Math.round(r.arrivedAt / 60)}分で到着` : '未到着'}`
        + ` / タイル ${r.tiles}枚 ${(r.bytes / 1024 / 1024).toFixed(2)}MB`
        + (r.drift > 0.5 ? ` / **到着後に ${r.drift.toFixed(1)}m 動いた**` : '')
        + (r.capped ? ' / 上限' : '')
        + (r.maxAfterMin > 50 ? ` / **最接近${Math.round(r.minGoal)}m のあと ${Math.round(r.maxAfterMin)}m 離れた**` : '')
        + (r.nan1 || r.nan2 ? ` / **座標がNaN(${r.nan1 ? '1号車' : ''}${r.nan2 ? '2号車' : ''})**` : '')
        + (r.stuck1 ? ' / **1号車 stuck**' : '')
        + (r.stuck2 ? ' / **2号車 stuck**' : ''),
      );
    }
  }
  console.log('');
}

console.log('=== まとめ ===');
const n = all.length;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`全 ${n}件`);
console.log(`  到着・待機         ${all.filter((r) => r.state === 'arrived').length}件`);
console.log(`  これ以上進めない   ${all.filter((r) => r.state === 'blocked').length}件`);
console.log(`  30分でまだ移動中   ${all.filter((r) => r.state === 'moving').length}件`);
console.log(`2台の間隔: 中央値 ${Math.round(med(all.map((r) => r.sep)))}m / 最小 ${Math.round(Math.min(...all.map((r) => r.sep)))}m`);
console.log(`  **${MIN_SEP_M}m未満(重なる恐れ): ${all.filter((r) => r.sep < MIN_SEP_M).length}件**`);
const arr = all.filter((r) => r.state === 'arrived');
if (arr.length > 0) {
  console.log(`到着時のターゲットまでの実距離: ${Math.round(Math.min(...arr.map((r) => r.goalDistM)))}〜${Math.round(Math.max(...arr.map((r) => r.goalDistM)))}m(中央値 ${Math.round(med(arr.map((r) => r.goalDistM)))}m)`);
  console.log(`到着までの時間: 中央値 ${Math.round(med(arr.map((r) => r.arrivedAt)) / 60)}分 / 最大 ${Math.round(Math.max(...arr.map((r) => r.arrivedAt)) / 60)}分`);
}
console.log(`到着後に動いた件数(0であること): ${all.filter((r) => r.drift > 0.5).length}件`);
console.log(`タイル: 最大 ${Math.max(...all.map((r) => r.tiles))}枚 / ${(Math.max(...all.map((r) => r.bytes)) / 1024 / 1024).toFixed(2)}MB / 上限に達した ${all.filter((r) => r.capped).length}件`);
console.log('');
console.log('--- 仕様メモ10節の落とし穴(「これ以上進めない」を早く言いすぎていないか)---');
const early = all.filter((r) => r.firstBlockedAt !== null && r.blockedThenMoved);
console.log(`一度「これ以上進めない」と言ったのに、その後また動いた: ${early.length}件(0であるべき)`);
for (const r of early.slice(0, 8)) {
  console.log(`  ${r.area} ${r.km}km ${r.brg}°: ${Math.round(r.firstBlockedAt)}秒後に blocked → その後 移動`);
}
