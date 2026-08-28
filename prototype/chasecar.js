// チェイスカー(地上クルー)の第2段階: road.js が組んだ道路グラフの上を車が走る。
//
// **走らせるだけ。**風にも高度計算にも当たり判定にも一切関与しない。
// 報告内容(第3段階)や指示(第4段階)はまだ実装していない。
//
// 設計の要点(tmp/チェイスカー仕様メモ.md):
//   - 既定は自動追尾。プレイヤーは何もしなくてよい
//   - **経路探索は毎フレーム回さない**
//   - 高速道路は走らない(`isMotorway`)。気球を追えないため
//
// 実装してみて外れた想定(2026-08-27):
//   当初は「交差点で気球の方向に最も近い辺を選ぶだけで追尾が成立する」と考えたが、
//   **成立しなかった**。30分の走行で 渡良瀬は11km走って出発点から586m しか進めず、
//   気球との距離は平均5,050m・最大9,546m。角度だけを見ると細街路の格子で堂々巡りになる。
//   そこで A*(コストは所要時間)で経路を出し、**数秒おきに引き直す**方式にした。
//   毎フレームではないので負荷は軽い(実測は下の PATHFIND_INTERVAL の注記を参照)
import * as THREE from 'three';
import { isMotorway } from './road.js';

// 幅員区分(rnkWidth)ごとの走行速度の**目安**(km/h)。
// 実測に基づく基準ではないので、UI に出すときも「目安」と明示すること。
//   0:3m未満 / 1:3〜5.5m / 2:5.5〜13m / 3:13〜19.5m / 4:19.5m以上 / 5:その他 / 6:不明
const SPEED_KMH = [20, 30, 40, 50, 50, 30, 30];
const DEFAULT_SPEED_KMH = 30;

const CAR_LIFT = 0.6;      // 路面から浮かせる量(m)
const TURN_RATE = 3.0;     // 車体の向きが追従する速さ(rad/s)。カクつきを抑える見た目だけの処理
const MAX_SPEED_MPS = 50 / 3.6;  // A* のヒューリスティックに使う上限速度
const PATHFIND_INTERVAL = 5;     // 経路を引き直す間隔(ゲーム内秒)。毎フレームではない
const ARRIVE_M = 150;            // 気球の真下にこれだけ近づいたら、その場で待つ

// 2点間の方位(x:東+, z:南+ なので atan2(dx, -dz) が北基準の時計回り)
const bearing = (dx, dz) => Math.atan2(dx, -dz);

// 角度差を -π〜π に畳む
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

function speedMps(props) {
  const kmh = SPEED_KMH[props.rnkWidth] ?? DEFAULT_SPEED_KMH;
  return (kmh * 1000) / 3600;
}

// --- 経路探索 --------------------------------------------------------------

// 最小ヒープ(A* の open set)。依存を増やさないため最小限だけ書く
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* で startNode から goalNode までの辺の並びを求める。コストは**所要時間**(秒)で、
 * 幅の広い道ほど速いので、遠回りでも走りやすい道が選ばれる。
 *
 * 道路網は連結成分が1つとは限らない(上士幌のような疎な地域では実測で71%)。
 * 気球の真下が別の成分にあると経路は引けないが、そこで諦めると角度による選択に落ちて
 * 堂々巡りになる。**到達できた範囲でいちばん気球に近いノードまでの経路を返す**。
 * 実際のチェイスカーも、道が続いていなければ行けるところまで行って待つ。
 *
 * @returns {string[]|null} 辺キーの配列。1歩も進めないときだけ null
 */
function findRoute(nodes, edges, startKey, goalKey) {
  if (startKey === goalKey) return [];
  const goal = nodes.get(goalKey);
  if (!goal) return null;

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();      // nodeKey -> {from, edgeKey}
  const closed = new Set();
  const open = new MinHeap();
  const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) / MAX_SPEED_MPS;
  open.push({ key: startKey, f: h(nodes.get(startKey)) });

  // 到達できた中でいちばん目的地に近かったノード(経路が引けなかったときの行き先)
  let bestKey = startKey, bestH = h(nodes.get(startKey));

  const reconstruct = (endKey) => {
    const route = [];
    let k = endKey;
    while (cameFrom.has(k)) { const c = cameFrom.get(k); route.push(c.edgeKey); k = c.from; }
    return route.reverse();
  };

  let guard = 0;
  while (open.size > 0 && guard++ < 60000) {
    const cur = open.pop();
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    if (cur.key === goalKey) return reconstruct(goalKey);
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
      const cost = e.lengthM / speedMps(e.props);
      const g = base + cost;
      if (gScore.has(next) && gScore.get(next) <= g) continue;
      gScore.set(next, g);
      cameFrom.set(next, { from: cur.key, edgeKey: ek });
      const nn = nodes.get(next);
      if (nn) open.push({ key: next, f: g + h(nn) });
    }
  }
  // 目的地に届かなかった。行けるところまでの経路を返す
  return bestKey === startKey ? null : reconstruct(bestKey);
}

// 車体(見た目)。上空から探せるように、細い目印を1本立てておく
function buildCarMesh() {
  const group = new THREE.Group();
  group.name = 'chase-car';

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1.4, 4.4),
    new THREE.MeshLambertMaterial({ color: 0xf0f0f0 }),
  );
  body.position.y = 0.7;
  group.add(body);

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.7, 2.2),
    new THREE.MeshLambertMaterial({ color: 0x2a3442 }),
  );
  roof.position.set(0, 1.7, -0.2);
  group.add(roof);

  // 上空からの目印。1000ft を超えると車そのものは1px にもならないので、
  // 見つけるための細い柱を立てる(地形には隠れる = 尾根の向こうなら見えない)
  const mark = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 60, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffd24a, transparent: true, opacity: 0.55, depthWrite: false,
    }),
  );
  mark.position.y = 30;
  group.add(mark);

  return group;
}

/**
 * 道路グラフの上を走るチェイスカーを作る。
 *
 * @param {object} opts
 * @param {{nodes:Map, edges:Map}} opts.graph   loadRoads が返した graph
 * @param {(x:number,z:number)=>number} opts.getHeight terrain.js の getHeight
 * @param {number} opts.startX  初期位置(この点に最も近い道路から走り始める)
 * @param {number} opts.startZ
 * @returns {{group:THREE.Group, update:Function, info:Function}|null}
 *   走れる道路が無ければ null
 */
export function createChaseCar({ graph, getHeight, startX = 0, startZ = 0 }) {
  const { nodes, edges } = graph;

  // 走行可能な辺だけを対象にする(高速道路は除く)
  const drivable = [...edges.values()].filter((e) => !isMotorway(e.props));
  if (drivable.length === 0) return null;

  // 出発点に最も近い辺を選ぶ。頂点との距離で足りる(辺は数十m刻みなので)
  let best = null, bestD = Infinity;
  for (const e of drivable) {
    const w = e.world;
    for (let k = 0; k < w.length; k += 2) {
      const d = (w[k] - startX) ** 2 + (w[k + 1] - startZ) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  // 辺のどちら側から走り始めるか。出発点(離陸地点)に近い端から始める
  const bw = best.world;
  const startForward =
    (bw[0] - startX) ** 2 + (bw[1] - startZ) ** 2
    <= (bw[bw.length - 2] - startX) ** 2 + (bw[bw.length - 1] - startZ) ** 2;

  const group = buildCarMesh();

  // 走行状態。edge を a→b または b→a のどちらかの向きに進む
  const car = {
    edge: best,
    forward: startForward,
    seg: 0,        // 今いる区間の番号(world の頂点インデックス / 2)
    t: 0,          // 区間内の進捗 0〜1
    x: 0, z: 0,
    heading: 0,
    speed: 0,
    stuck: false,   // 走れる道が見つからない状態(袋小路の行き止まりなど)
    route: [],      // これから通る辺キーの並び(A* の結果)
    sinceFind: 1e9, // 前回経路を引いてからのゲーム内秒。初回は即引く
    waiting: false, // 気球の近くに着いたので待機中
    findMs: 0, findCount: 0,
  };

  // 進行方向に沿った区間の端点を取り出す
  const segPoints = (e, forward, seg) => {
    const w = e.world;
    const n = w.length / 2 - 1;              // 区間数
    const i = forward ? seg : n - 1 - seg;
    const a = forward ? i : i + 1;
    const b = forward ? i + 1 : i;
    return [w[a * 2], w[a * 2 + 1], w[b * 2], w[b * 2 + 1]];
  };
  const segCount = (e) => e.world.length / 2 - 1;

  // 今の辺の終点ノード
  const endNodeKey = () => (car.forward ? car.edge.b : car.edge.a);

  // 目的地(気球の真下)にいちばん近いノードを探す。ノード数は数千なので総当たりで足りる
  function nearestNode(x, z) {
    let key = null, bd = Infinity;
    for (const [k, n] of nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; key = k; }
    }
    return key;
  }

  // 経路を引き直す。**毎フレームではなく PATHFIND_INTERVAL 秒おき**
  function replan(fromNodeKey, targetX, targetZ) {
    const goal = nearestNode(targetX, targetZ);
    if (!goal) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const route = findRoute(nodes, edges, fromNodeKey, goal);
    car.findMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    car.findCount++;
    car.sinceFind = 0;
    // 経路が引けなければ route は空のまま。交差点では下の角度による選択に落ちる
    car.route = route || [];
  }

  // 交差点で次の辺を選ぶ。経路があればそれに従い、無ければ気球の方向に最も近い辺を取る。
  // 角度だけの選択は細街路の格子で堂々巡りになるため、あくまで経路が引けないときの保険
  function chooseNext(nodeKey, targetX, targetZ) {
    const node = nodes.get(nodeKey);
    if (!node) return false;

    // 経路の先頭が、今いる交差点に接している辺なら、それを取る
    while (car.route.length > 0) {
      const ek = car.route[0];
      const e = edges.get(ek);
      if (!e || (e.a !== nodeKey && e.b !== nodeKey)) { car.route.shift(); continue; }
      car.route.shift();
      car.edge = e;
      car.forward = e.a === nodeKey;
      car.seg = 0;
      car.t = 0;
      return true;
    }

    const want = bearing(targetX - node.x, targetZ - node.z);
    let pick = null, pickScore = Infinity, fallback = null, fallbackScore = Infinity;
    for (const ek of node.edgeKeys) {
      const e = edges.get(ek);
      if (!e || isMotorway(e.props)) continue;
      const forward = e.a === nodeKey;
      if (!forward && e.b !== nodeKey) continue;
      // その辺に入った直後の進行方向
      const w = e.world;
      const [x0, z0] = forward ? [w[0], w[1]] : [w[w.length - 2], w[w.length - 1]];
      const [x1, z1] = forward ? [w[2], w[3]] : [w[w.length - 4], w[w.length - 3]];
      const score = Math.abs(wrapPi(bearing(x1 - x0, z1 - z0) - want));

      // 来た道は「他に選択肢が無いとき」だけ使う(行き止まりでのUターン)
      if (ek === car.edge.key) {
        if (score < fallbackScore) { fallbackScore = score; fallback = { e, forward }; }
        continue;
      }
      if (score < pickScore) { pickScore = score; pick = { e, forward }; }
    }

    const next = pick || fallback;
    if (!next) return false;
    car.edge = next.e;
    car.forward = next.forward;
    car.seg = 0;
    car.t = 0;
    return true;
  }

  // 車体を今の走行状態の位置へ置く。
  // **待機中も含めて必ず呼ぶこと。**呼ばないと group が原点(y=0)のまま地面に埋まる
  function place() {
    group.position.set(car.x, getHeight(car.x, car.z) + CAR_LIFT, car.z);
    group.rotation.y = car.heading;
  }

  // 初期位置を辺の先頭に置く
  const p0 = segPoints(car.edge, car.forward, 0);
  car.x = p0[0]; car.z = p0[1];
  car.heading = bearing(p0[2] - p0[0], p0[3] - p0[1]);
  place();

  /**
   * @param {number} dt      経過秒(ゲーム内時間。時間加速が掛かっていてよい)
   * @param {number} targetX 追う相手(気球)の位置
   * @param {number} targetZ
   */
  function update(dt, targetX, targetZ) {
    if (!dt || car.stuck) return;

    // 経路の引き直し。交差点に着いたときではなく、時間で区切る
    car.sinceFind += dt;
    if (car.sinceFind >= PATHFIND_INTERVAL) replan(endNodeKey(), targetX, targetZ);

    // 気球の真下まで来ていたら、その場で待つ。無意味に走り回らせない
    car.waiting = Math.hypot(targetX - car.x, targetZ - car.z) < ARRIVE_M && car.route.length === 0;
    if (car.waiting) { car.speed = 0; place(); return; }

    car.speed = speedMps(car.edge.props);

    let remain = car.speed * dt;
    let guard = 0;
    while (remain > 0 && guard++ < 64) {   // 時間加速でも1フレームで暴走しないよう上限を置く
      const [ax, az, bx, bz] = segPoints(car.edge, car.forward, car.seg);
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1e-6) {                 // 長さ0の区間は飛ばす
        if (!advanceSeg(targetX, targetZ)) { place(); return; }
        continue;
      }
      const left = (1 - car.t) * segLen;
      if (remain < left) {
        car.t += remain / segLen;
        remain = 0;
      } else {
        remain -= left;
        if (!advanceSeg(targetX, targetZ)) { place(); return; }
        continue;
      }
      const [nx, nz, mx, mz] = segPoints(car.edge, car.forward, car.seg);
      car.x = nx + (mx - nx) * car.t;
      car.z = nz + (mz - nz) * car.t;
      const want = bearing(mx - nx, mz - nz);
      car.heading = wrapPi(car.heading + wrapPi(want - car.heading) * Math.min(1, dt * TURN_RATE));
    }

    place();
  }

  // 次の区間へ。辺の端まで来ていたら交差点で次の辺を選ぶ
  function advanceSeg(targetX, targetZ) {
    car.seg++;
    car.t = 0;
    if (car.seg < segCount(car.edge)) return true;
    if (!chooseNext(endNodeKey(), targetX, targetZ)) { car.stuck = true; return false; }
    return true;
  }

  // 現在の状態(第3段階の報告や UI 表示で使う)
  function info() {
    return {
      x: car.x, z: car.z,
      headingDeg: ((car.heading * 180) / Math.PI + 360) % 360,
      speedKmh: Math.round((car.speed * 3600) / 1000),
      rnkWidth: car.edge.props.rnkWidth,
      rdCtg: car.edge.props.rdCtg,
      stuck: car.stuck,
      waiting: car.waiting,
      routeLeft: car.route.length,
      findMs: car.findMs,
      findCount: car.findCount,
    };
  }

  return { group, update, info, drivableEdges: drivable.length };
}
