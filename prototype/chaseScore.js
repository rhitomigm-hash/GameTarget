// 回収レース専用。道路利用をゲーム用の距離として数える（交通法規の判定ではない）。
export const CATCH_POINTS = 1000;
export const GROUND_CATCH_POINTS = 500;
export const WIND_REPORT_POINTS = 50;
export const ROAD_METERS_PER_POINT = 100;
const CELL_M = 64;
// 幅員区分の上限側の半幅 + 中心線の簡略化・位置ずれの許容2m。
// 19.5m以上は半幅12m、その他/不明は半幅3mを仮置きする。
const HALF_WIDTH_M = [1.5, 2.75, 6.5, 9.75, 12, 3, 3];
export function chasePoints(caught, roadMeters, afterLanding = false, windReported = false) {
  const road = Math.floor(Math.max(0, roadMeters) / ROAD_METERS_PER_POINT);
  const recovery = caught ? (afterLanding ? GROUND_CATCH_POINTS : CATCH_POINTS) : 0;
  const windReport = windReported ? WIND_REPORT_POINTS : 0;
  return { recovery, road, windReport, total: recovery + road + windReport };
}

export function createRoadMeter(graph) {
  const cells = new Map(), seen = new Set();
  function sync() {
    if (seen.size === graph.edges.size) return;
    for (const [key, edge] of graph.edges) {
      if (seen.has(key)) continue;
      seen.add(key);
      const p = edge.props;
      // 地上クルーと同じ対象。高速道路・道路縁は加点しない。
      if (p.rnkWidth === undefined || p.motorway === 1 || p.rdCtg === 3 || p.tollSect === 1) continue;
      const r = (HALF_WIDTH_M[p.rnkWidth] ?? 3) + 2;
      const w = edge.world;
      for (let i = 2; i < w.length; i += 2) {
        const s = { x: w[i - 2], z: w[i - 1], dx: w[i] - w[i - 2], dz: w[i + 1] - w[i - 1], r };
        s.len2 = s.dx * s.dx + s.dz * s.dz;
        if (!s.len2) continue;
        for (let x = Math.floor((Math.min(s.x, w[i]) - r) / CELL_M); x <= Math.floor((Math.max(s.x, w[i]) + r) / CELL_M); x++) {
          for (let z = Math.floor((Math.min(s.z, w[i + 1]) - r) / CELL_M); z <= Math.floor((Math.max(s.z, w[i + 1]) + r) / CELL_M); z++) {
            const id = `${x},${z}`;
            if (!cells.has(id)) cells.set(id, []);
            cells.get(id).push(s);
          }
        }
      }
    }
  }
  function onRoad(x, z) {
    const nearby = cells.get(`${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`) || [];
    return nearby.some(s => {
      const t = Math.max(0, Math.min(1, ((x - s.x) * s.dx + (z - s.z) * s.dz) / s.len2));
      return Math.hypot(x - s.x - t * s.dx, z - s.z - t * s.dz) <= s.r;
    });
  }
  function measure(from, to) {
    sync();
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    if (!Number.isFinite(d) || d <= 0) return 0;
    // 横断時も道路内の部分だけ数える。各サンプルは最大0.5m。
    const n = Math.ceil(d / 0.5);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      if (onRoad(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) hits++;
    }
    return d * hits / n;
  }
  return { measure };
}
