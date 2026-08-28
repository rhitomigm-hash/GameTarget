// 第二チェイスカー(2号車)の実装前検証: 離陸地点 → ターゲット手前まで走らせるのに
// z14 の道路タイルが何枚要るか。総数上限 48枚(prototype/road.js の maxTilesTotal)に収まるか。
//
// 使い捨ての検証コード。prototype/ には一切触れない。
//   node probe-target-run.mjs [距離km,...] [方位deg,...]
//   例) node probe-target-run.mjs 3,5,8 0,90,180,270
//
// 測るもの(tmp/チェイスカー仕様メモ.md「6. 実装より前に実データで確かめること」):
//   1. 離陸地点まわり + ターゲットまわり + その間の経路帯 で何枚になるか
//   2. その範囲だけで A* が離陸地点 → ターゲット手前(100m以上離れたノード)まで引けるか
//   3. ターゲットから 100m 以上離れた最寄りノードが、実際には何m手前になるか
//
// 前提の確認もひとつ含む: prototype/road.js の初期読み込みは ensureAround(0,0,radius) で
// **世界原点(=ターゲット)まわり**を読む。main.js のコメントは「離陸地点まわり」だが実際は違う。
// 離陸地点が遠いと出発点側が未読になるので、その枚数も別に出す。
import { readLayers, fetchTile } from './mvt.mjs';

const ROAD_Z = 14;
const EARTH_CIRC = 40075016.686;
const INIT_RADIUS_M = 3000;      // road.js の radiusM
// 経路帯の幅(タイル中心までの距離で判定)。第4引数で変えられる —
// 「到達できない」原因が道の有無か、経路帯が狭くて迂回路が未読なだけかを切り分けるため
const CORRIDOR_M = Number(process.argv[4] ?? 1500);
const KEEP_OUT_M = 100;          // ターゲットの手前で止まる距離の目安(田んぼ1枚ぶん)
const MAX_TILES = 48;            // road.js の maxTilesTotal
const MAX_SPEED_MPS = 50 / 3.6;

// 幅員区分ごとの走行速度の目安(km/h)。chasecar.js と同じ値
const SPEED_KMH = [20, 30, 40, 50, 50, 30, 30];
const isMotorway = (p) => p.motorway === 1 || p.rdCtg === 3 || p.tollSect === 1;
const speedMps = (p) => ((SPEED_KMH[p.rnkWidth] ?? 30) * 1000) / 3600;

const PRESET_AREAS = [
  { name: '佐賀・嘉瀬川', lon: 130.25, lat: 33.27 },
  { name: '渡良瀬遊水地', lon: 139.68, lat: 36.22 },
  { name: '佐久・千曲川', lon: 138.48, lat: 36.25 },
  { name: '一関・平泉', lon: 141.13, lat: 38.93 },
  { name: '上士幌(北海道)', lon: 143.30, lat: 43.23 },
];

const DISTS = (process.argv[2] ?? '3,5,8').split(',').map(Number);
const BEARINGS = (process.argv[3] ?? '0,90,180,270').split(',').map(Number);

// 小数タイル座標(road.js の lonLatToTile と同じ意味)
const fTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const fTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// --- 最小ヒープ(A* 用。chasecar.js と同じ構造) ---
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// エリアごとにタイルを1回だけ取得して使い回す(同じ範囲を何度も叩かない)
function makeArea(area) {
  const tileMeters = (EARTH_CIRC / 2 ** ROAD_Z) * Math.cos((area.lat * Math.PI) / 180);
  const c = { x: fTileX(area.lon, ROAD_Z), y: fTileY(area.lat, ROAD_Z) };
  const cache = new Map();   // "tx_ty" -> {bytes, lines:[{pts, props}]}

  // 世界座標(m, 原点=ターゲット)→ 小数タイル座標
  const toTile = (x, z) => ({ fx: c.x + x / tileMeters, fy: c.y + z / tileMeters });

  async function getTile(tx, ty) {
    const id = `${tx}_${ty}`;
    if (cache.has(id)) return cache.get(id);
    let entry = { bytes: 0, lines: [] };
    try {
      const buf = await fetchTile(ROAD_Z, tx, ty);
      if (buf) {
        entry.bytes = buf.length;
        const road = readLayers(buf)['road'];
        if (road) {
          const ext = road.extent;
          for (const f of road.features) {
            if (f.type !== 2) continue;
            if (f.props.rnkWidth === undefined) continue;   // 道路の縁は除く
            for (const ln of f.lines) {
              if (ln.length < 2) continue;
              entry.lines.push({
                // グローバル整数座標。継ぎ目はこの一致だけで縫える
                pts: ln.map(([px, py]) => [tx * ext + px, ty * ext + py]),
                ext, props: f.props,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('  タイル取得に失敗:', tx, ty, err.message);
    }
    cache.set(id, entry);
    return entry;
  }

  return { area, tileMeters, c, toTile, getTile, cache };
}

// タイル中心が「点」または「線分」からどれだけ離れているか(m)
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// 読むべきタイルの集合を決める。road.js の ensureAround と同じく「タイル中心までの距離」で判定
function planTiles(ctx, launch, target) {
  const { tileMeters, toTile } = ctx;
  const L = toTile(launch.x, launch.z);
  const T = toTile(target.x, target.z);

  const groups = { target: new Set(), launch: new Set(), corridor: new Set() };
  const span = Math.ceil((Math.hypot(L.fx - T.fx, L.fy - T.fy) + INIT_RADIUS_M / tileMeters) + 2);
  const baseX = Math.floor(T.fx), baseY = Math.floor(T.fy);

  for (let ty = baseY - span; ty <= baseY + span; ty++) {
    for (let tx = baseX - span; tx <= baseX + span; tx++) {
      const cxm = (tx + 0.5 - T.fx) * tileMeters;   // タイル中心の世界座標(m)
      const czm = (ty + 0.5 - T.fy) * tileMeters;
      const id = `${tx}_${ty}`;
      if (Math.hypot(cxm - target.x, czm - target.z) <= INIT_RADIUS_M) groups.target.add(id);
      else if (Math.hypot(cxm - launch.x, czm - launch.z) <= INIT_RADIUS_M) groups.launch.add(id);
      else if (distToSegment(cxm, czm, launch.x, launch.z, target.x, target.z) <= CORRIDOR_M) groups.corridor.add(id);
    }
  }
  return groups;
}

// タイル群からグラフを組む(road.js と同じ組み方)
async function buildGraph(ctx, tileIds) {
  const nodes = new Map(), edges = new Map();
  let bytes = 0, fetched = 0;
  for (const id of tileIds) {
    const [tx, ty] = id.split('_').map(Number);
    const t = await ctx.getTile(tx, ty);
    bytes += t.bytes; fetched++;
    for (const ln of t.lines) {
      const { pts, ext, props } = ln;
      const world = pts.map(([gx, gy]) => [
        (gx / ext - ctx.c.x) * ctx.tileMeters,
        (gy / ext - ctx.c.y) * ctx.tileMeters,
      ]);
      const a = `${pts[0][0]}_${pts[0][1]}`;
      const b = `${pts[pts.length - 1][0]}_${pts[pts.length - 1][1]}`;
      if (a === b) continue;
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edges.has(ek)) continue;
      let len = 0;
      for (let k = 1; k < world.length; k++) len += Math.hypot(world[k][0] - world[k - 1][0], world[k][1] - world[k - 1][1]);
      edges.set(ek, { key: ek, a, b, world, lengthM: len, props });
      for (const [key, ix] of [[a, 0], [b, world.length - 1]]) {
        if (!nodes.has(key)) nodes.set(key, { x: world[ix][0], z: world[ix][1], edgeKeys: [] });
        nodes.get(key).edgeKeys.push(ek);
      }
    }
  }
  return { nodes, edges, bytes, fetched };
}

// chasecar.js の findRoute と同じ(到達できた範囲で最も目的地に近いノードまでを返す)
function findRoute(nodes, edges, startKey, goalKey) {
  if (startKey === goalKey) return { route: [], reached: true, endKey: startKey };
  const goal = nodes.get(goalKey);
  if (!goal) return { route: null, reached: false, endKey: startKey };
  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  const open = new MinHeap();
  const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) / MAX_SPEED_MPS;
  open.push({ key: startKey, f: h(nodes.get(startKey)) });
  let bestKey = startKey, bestH = h(nodes.get(startKey));
  const reconstruct = (endKey) => {
    const route = []; let k = endKey;
    while (cameFrom.has(k)) { const c = cameFrom.get(k); route.push(c.edgeKey); k = c.from; }
    return route.reverse();
  };
  let guard = 0;
  while (open.size > 0 && guard++ < 200000) {
    const cur = open.pop();
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    if (cur.key === goalKey) return { route: reconstruct(goalKey), reached: true, endKey: goalKey };
    const node = nodes.get(cur.key);
    if (!node) continue;
    const hc = h(node);
    if (hc < bestH) { bestH = hc; bestKey = cur.key; }
    const base = gScore.get(cur.key);
    for (const ek of node.edgeKeys) {
      const e = edges.get(ek);
      if (!e || isMotorway(e.props)) continue;
      const next = e.a === cur.key ? e.b : e.a;
      if (next === cur.key || closed.has(next)) continue;
      const g = base + e.lengthM / speedMps(e.props);
      if (gScore.has(next) && gScore.get(next) <= g) continue;
      gScore.set(next, g);
      cameFrom.set(next, { from: cur.key, edgeKey: ek });
      const nn = nodes.get(next);
      if (nn) open.push({ key: next, f: g + h(nn) });
    }
  }
  return { route: reconstruct(bestKey), reached: false, endKey: bestKey };
}

// 走行可能な辺に接するノードだけを対象に、点にいちばん近いノード
function nearestNode(nodes, edges, x, z, minDist = 0) {
  let key = null, bd = Infinity;
  for (const [k, n] of nodes) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < minDist) continue;
    if (!n.edgeKeys.some((ek) => { const e = edges.get(ek); return e && !isMotorway(e.props); })) continue;
    if (d < bd) { bd = d; key = k; }
  }
  return { key, dist: bd };
}

// --- 本体 ---
console.log(`z${ROAD_Z} 道路タイル  初期半径 ${INIT_RADIUS_M}m / 経路帯 ±${CORRIDOR_M}m / 上限 ${MAX_TILES}枚`);
console.log(`ターゲットは各エリアの中心(世界原点)。離陸地点 ${DISTS.join('/')}km × 方位 ${BEARINGS.join('/')}°\n`);

const summary = [];

for (const area of PRESET_AREAS) {
  const ctx = makeArea(area);
  console.log(`■ ${area.name}  (lon=${area.lon}, lat=${area.lat})`);
  console.log('  距離  方位 | ターゲット側 離陸側 経路帯 = 合計 |    容量 | 経路 | 手前 | 走行距離');
  console.log('  -----------|-----------------------------------|---------|------|------|---------');

  for (const km of DISTS) {
    for (const brg of BEARINGS) {
      const rad = (brg * Math.PI) / 180;
      // 方位は北基準の時計回り。x:東+, z:南+
      const launch = { x: Math.sin(rad) * km * 1000, z: -Math.cos(rad) * km * 1000 };
      const target = { x: 0, z: 0 };

      const g = planTiles(ctx, launch, target);
      const ids = [...g.target, ...g.launch, ...g.corridor];
      const total = ids.length;

      const { nodes, edges, bytes } = await buildGraph(ctx, ids);

      let line = `  ${String(km).padStart(2)}km ${String(brg).padStart(4)}° | `
        + `${String(g.target.size).padStart(11)} ${String(g.launch.size).padStart(6)} `
        + `${String(g.corridor.size).padStart(5)} = ${String(total).padStart(4)}${total > MAX_TILES ? '*' : ' '}| `
        + `${(bytes / 1024 / 1024).toFixed(2).padStart(5)}MB |`;

      if (nodes.size === 0) {
        console.log(`${line} 道路なし`);
        summary.push({ area: area.name, km, brg, total, bytes, ok: false, reason: '道路なし' });
        continue;
      }

      const start = nearestNode(nodes, edges, launch.x, launch.z);
      const goal = nearestNode(nodes, edges, target.x, target.z, KEEP_OUT_M);
      if (!start.key || !goal.key) {
        console.log(`${line} 起点/終点なし`);
        summary.push({ area: area.name, km, brg, total, bytes, ok: false, reason: '起点/終点なし' });
        continue;
      }

      const t0 = performance.now();
      const r = findRoute(nodes, edges, start.key, goal.key);
      const ms = performance.now() - t0;

      let runM = 0;
      for (const ek of (r.route || [])) { const e = edges.get(ek); if (e) runM += e.lengthM; }
      const end = nodes.get(r.endKey);
      const endDist = Math.hypot(end.x - target.x, end.z - target.z);

      line += ` ${r.reached ? '到達' : '途中'} | ${String(Math.round(endDist)).padStart(4)}m |`
        + ` ${(runM / 1000).toFixed(1).padStart(5)}km  (A* ${ms.toFixed(1)}ms)`;
      console.log(line);

      summary.push({
        area: area.name, km, brg, total, bytes,
        ok: r.reached, endDist, runM, ms,
        startDist: start.dist, goalDist: goal.dist,
      });
    }
  }
  console.log('');
}

// --- まとめ ---
console.log('=== まとめ ===');
const over = summary.filter((s) => s.total > MAX_TILES);
const maxTiles = Math.max(...summary.map((s) => s.total));
const maxBytes = Math.max(...summary.map((s) => s.bytes));
console.log(`タイル枚数 最大 ${maxTiles}枚 / 上限 ${MAX_TILES}枚  → 超過した組み合わせ ${over.length}/${summary.length}`);
console.log(`容量 最大 ${(maxBytes / 1024 / 1024).toFixed(2)}MB`);
const notReached = summary.filter((s) => !s.ok);
console.log(`ターゲット手前まで到達できなかった組み合わせ: ${notReached.length}/${summary.length}`);
for (const s of notReached) {
  console.log(`  ${s.area} ${s.km}km ${s.brg}°: ${s.reason ?? `途中止まり(ターゲットまで ${Math.round(s.endDist)}m)`}`);
}
const dists = summary.filter((s) => s.ok).map((s) => Math.round(s.endDist)).sort((a, b) => a - b);
if (dists.length > 0) {
  console.log(`ターゲット手前で止まる実距離(${KEEP_OUT_M}m以上の最寄りノード): `
    + `中央値 ${dists[dists.length >> 1]}m / 最小 ${dists[0]}m / 最大 ${dists[dists.length - 1]}m`);
}
if (over.length > 0) {
  console.log('\n枚数が上限を超えた組み合わせ:');
  for (const s of over) console.log(`  ${s.area} ${s.km}km ${s.brg}°: ${s.total}枚 ${(s.bytes / 1024 / 1024).toFixed(2)}MB`);
}
