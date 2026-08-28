// 第二チェイスカー(2号車)の初期位置の検証。
//
// 案: 1号車は「離陸地点にいちばん近い辺」、2号車は「次に近い**別の**辺」に最初から置く。
//     別の辺が無ければ、同じ辺の**反対側の端**に置く。
//     道路グラフの外にいる状態も、道なりでない移動も足さずに済むのが利点。
//
// 弱点は「道が疎な場所で2号車が離れすぎないか」。それを実データで測る。
//   node probe-second-car-spawn.mjs [距離km,...] [方位刻み度]
//
// 置き方は prototype/chasecar.js:199-211 に合わせる:
//   辺の**頂点**との距離でいちばん近い辺を選び、その辺の離陸地点に近いほうの**端点**に置く。
import { readLayers, fetchTile } from './mvt.mjs';

const ROAD_Z = 14;
const EARTH_CIRC = 40075016.686;
const LOAD_RADIUS_M = 2000;   // 近くの道を2本見つけるには十分
// 2台を離しておく最小間隔(m)。車体は 4.4m なので、余裕をみて車1台ぶん空ける
const MIN_SEP_M = Number(process.argv[4] ?? 20);
const isMotorway = (p) => p.motorway === 1 || p.rdCtg === 3 || p.tollSect === 1;

const PRESET_AREAS = [
  { name: '佐賀・嘉瀬川', lon: 130.25, lat: 33.27 },
  { name: '渡良瀬遊水地', lon: 139.68, lat: 36.22 },
  { name: '佐久・千曲川', lon: 138.48, lat: 36.25 },
  { name: '一関・平泉', lon: 141.13, lat: 38.93 },
  { name: '上士幌(北海道)', lon: 143.30, lat: 43.23 },
];

const DISTS = (process.argv[2] ?? '2,3,5,8').split(',').map(Number);
const BRG_STEP = Number(process.argv[3] ?? 45);
const BEARINGS = [];
for (let b = 0; b < 360; b += BRG_STEP) BEARINGS.push(b);

const fTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const fTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

function makeArea(area) {
  const tileMeters = (EARTH_CIRC / 2 ** ROAD_Z) * Math.cos((area.lat * Math.PI) / 180);
  const c = { x: fTileX(area.lon, ROAD_Z), y: fTileY(area.lat, ROAD_Z) };
  const cache = new Map();

  async function getTile(tx, ty) {
    const id = `${tx}_${ty}`;
    if (cache.has(id)) return cache.get(id);
    const entry = { bytes: 0, edges: [] };
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
            if (isMotorway(f.props)) continue;              // 走れない
            for (const ln of f.lines) {
              if (ln.length < 2) continue;
              const pts = ln.map(([px, py]) => [tx * ext + px, ty * ext + py]);
              const world = pts.map(([gx, gy]) => [
                (gx / ext - c.x) * tileMeters, (gy / ext - c.y) * tileMeters,
              ]);
              const a = `${pts[0][0]}_${pts[0][1]}`;
              const b = `${pts[pts.length - 1][0]}_${pts[pts.length - 1][1]}`;
              if (a === b) continue;
              entry.edges.push({ key: a < b ? `${a}|${b}` : `${b}|${a}`, world, props: f.props });
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

  // 点のまわりの走行可能な辺を集める(重複は辺キーで落とす)
  async function edgesAround(x, z, r = LOAD_RADIUS_M) {
    const fx = c.x + x / tileMeters, fy = c.y + z / tileMeters;
    const span = Math.ceil(r / tileMeters);
    const seen = new Map();
    for (let ty = Math.floor(fy) - span; ty <= Math.floor(fy) + span; ty++) {
      for (let tx = Math.floor(fx) - span; tx <= Math.floor(fx) + span; tx++) {
        const t = await getTile(tx, ty);
        for (const e of t.edges) if (!seen.has(e.key)) seen.set(e.key, e);
      }
    }
    return [...seen.values()];
  }

  return { edgesAround, cache };
}

// chasecar.js と同じ選び方: 頂点距離で辺を選び、近いほうの端点に置く
function placeOn(edge, x, z) {
  const w = edge.world;
  const head = w[0], tail = w[w.length - 1];
  const dh = Math.hypot(head[0] - x, head[1] - z);
  const dt = Math.hypot(tail[0] - x, tail[1] - z);
  return dh <= dt ? { pos: head, other: tail } : { pos: tail, other: head };
}

function nearestVertexDist(edge, x, z) {
  let best = Infinity;
  for (const [vx, vz] of edge.world) {
    const d = (vx - x) ** 2 + (vz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

console.log(`z${ROAD_Z} 走行可能な道路(高速道路・道路縁を除く)  探索半径 ${LOAD_RADIUS_M}m`);
console.log(`離陸地点: ターゲットから ${DISTS.join('/')}km × 方位 ${BRG_STEP}°刻み(${BEARINGS.length}方向)\n`);
console.log('  d1 = 離陸地点 → 1号車 / d2 = 離陸地点 → 2号車 / 間隔 = 1号車 ↔ 2号車\n');

const all = [];

for (const area of PRESET_AREAS) {
  const ctx = makeArea(area);
  const rows = [];
  let sameEdgeFallback = 0, noRoad = 0;

  for (const km of DISTS) {
    for (const brg of BEARINGS) {
      const rad = (brg * Math.PI) / 180;
      const lx = Math.sin(rad) * km * 1000, lz = -Math.cos(rad) * km * 1000;
      const edges = await ctx.edgesAround(lx, lz);
      if (edges.length === 0) { noRoad++; continue; }

      // 1号車: いちばん近い辺
      let e1 = null, d1v = Infinity;
      for (const e of edges) { const d = nearestVertexDist(e, lx, lz); if (d < d1v) { d1v = d; e1 = e; } }
      const p1 = placeOn(e1, lx, lz);

      // 2号車: **1号車から MIN_SEP 以上離れた**端点のうち、離陸地点にいちばん近いもの。
      //
      // 当初は「次に近い**別の**辺」にしようとしたが、実データで破綻した(160件中98件が
      // 間隔10m未満・中央値0m)。次に近い辺はたいてい**同じ交差点に接している別の辺**で、
      // 辺が違っても端点は同じ座標になる。「別の辺」は「別の場所」を意味しない。
      let pos2 = null, d2v = Infinity;
      for (const e of edges) {
        for (const p of [e.world[0], e.world[e.world.length - 1]]) {
          if (Math.hypot(p[0] - p1.pos[0], p[1] - p1.pos[1]) < MIN_SEP_M) continue;
          const d = Math.hypot(p[0] - lx, p[1] - lz);
          if (d < d2v) { d2v = d; pos2 = p; }
        }
      }
      let fallback = false;
      if (!pos2) { pos2 = p1.other; fallback = true; sameEdgeFallback++; }  // 端点が1つしか無い

      const d1 = Math.hypot(p1.pos[0] - lx, p1.pos[1] - lz);
      const d2 = Math.hypot(pos2[0] - lx, pos2[1] - lz);
      const sep = Math.hypot(pos2[0] - p1.pos[0], pos2[1] - p1.pos[1]);
      rows.push({ km, brg, d1, d2, sep, fallback });
      all.push({ area: area.name, km, brg, d1, d2, sep, fallback });
    }
  }

  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; };
  const fmt = (v) => String(Math.round(v)).padStart(5);
  console.log(`■ ${area.name}`);
  if (rows.length === 0) { console.log('  近くに走行可能な道路が無い\n'); continue; }
  console.log(`  試行 ${rows.length}件  (道路なし ${noRoad}件 / 同じ辺の反対端に落ちた ${sameEdgeFallback}件)`);
  console.log(`  d1   中央値 ${fmt(med(rows.map((r) => r.d1)))}m  最大 ${fmt(Math.max(...rows.map((r) => r.d1)))}m`);
  console.log(`  d2   中央値 ${fmt(med(rows.map((r) => r.d2)))}m  最大 ${fmt(Math.max(...rows.map((r) => r.d2)))}m`);
  console.log(`  間隔 中央値 ${fmt(med(rows.map((r) => r.sep)))}m  最小 ${fmt(Math.min(...rows.map((r) => r.sep)))}m  最大 ${fmt(Math.max(...rows.map((r) => r.sep)))}m`);
  const far = rows.filter((r) => r.d2 > 300).sort((a, b) => b.d2 - a.d2);
  if (far.length > 0) {
    console.log(`  2号車が離陸地点から300m超: ${far.length}件`);
    for (const r of far.slice(0, 5)) {
      console.log(`    ${r.km}km ${String(r.brg).padStart(3)}°: d1=${Math.round(r.d1)}m d2=${Math.round(r.d2)}m 間隔=${Math.round(r.sep)}m${r.fallback ? ' (同じ辺)' : ''}`);
    }
  }
  const close = rows.filter((r) => r.sep < MIN_SEP_M);
  if (close.length > 0) console.log(`  **間隔${MIN_SEP_M}m未満(車体が重なる恐れ): ${close.length}件**`);
  console.log('');
}

console.log('=== まとめ ===');
const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; };
console.log(`全 ${all.length}件`);
console.log(`d1(1号車)   中央値 ${Math.round(med(all.map((r) => r.d1)))}m / 最大 ${Math.round(Math.max(...all.map((r) => r.d1)))}m`);
console.log(`d2(2号車)   中央値 ${Math.round(med(all.map((r) => r.d2)))}m / 最大 ${Math.round(Math.max(...all.map((r) => r.d2)))}m`);
console.log(`2台の間隔     中央値 ${Math.round(med(all.map((r) => r.sep)))}m / 最小 ${Math.round(Math.min(...all.map((r) => r.sep)))}m`);
console.log(`同じ辺の反対端に落ちた: ${all.filter((r) => r.fallback).length}件`);
console.log(`間隔${MIN_SEP_M}m未満(重なる恐れ): ${all.filter((r) => r.sep < MIN_SEP_M).length}件`);
console.log(`2号車が離陸地点から300m超: ${all.filter((r) => r.d2 > 300).length}件 / 500m超: ${all.filter((r) => r.d2 > 500).length}件`);
