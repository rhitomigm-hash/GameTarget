// チェイスカー 第0段階: 地理院ベクトルタイル road レイヤが接続グラフに組めるかの実データ検証。
// 使い捨ての検証コード。prototype/ には一切触れない。
//   node probe-graph.mjs [lat] [lon] [zoom]
// 依存なし(MVT の必要部分だけ自前デコード)。

const URL_TMPL = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf';

const lat = Number(process.argv[2] ?? 33.27);
const lon = Number(process.argv[3] ?? 130.25);
const z = Number(process.argv[4] ?? 16);

const tileX = (lo, zz) => Math.floor((lo + 180) / 360 * 2 ** zz);
const tileY = (la, zz) => {
  const r = la * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** zz);
};

// ---- 最小限の protobuf リーダ ----
class Reader {
  constructor(buf, end = buf.length) { this.b = buf; this.p = 0; this.end = end; }
  varint() {
    let r = 0, s = 0, b;
    do { b = this.b[this.p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else if (wire === 1) this.p += 8;
    else throw new Error('wire ' + wire);
  }
  sub() { const len = this.varint(); const r = new Reader(this.b, this.p + len); r.p = this.p; this.p += len; return r; }
  str() { const len = this.varint(); const s = this.b.toString('utf8', this.p, this.p + len); this.p += len; return s; }
}

// road レイヤの LineString ジオメトリだけ取り出す(タイル内整数座標のまま)
function readLayers(buf) {
  const out = {};
  const r = new Reader(buf);
  while (r.p < r.end) {
    const tag = r.varint();
    if (tag >> 3 === 3) {
      const lr = r.sub();
      const layer = { name: '', extent: 4096, features: [] };
      while (lr.p < lr.end) {
        const lt = lr.varint(), f = lt >> 3;
        if (f === 1) layer.name = lr.str();
        else if (f === 5) layer.extent = lr.varint();
        else if (f === 2) layer.features.push(readFeature(lr.sub()));
        else lr.skip(lt & 7);
      }
      out[layer.name] = layer;
    } else r.skip(tag & 7);
  }
  return out;
}

function readFeature(fr) {
  const feat = { type: 0, lines: [] };
  while (fr.p < fr.end) {
    const t = fr.varint(), f = t >> 3;
    if (f === 3) feat.type = fr.varint();
    else if (f === 4) feat.lines = decodeGeom(fr.sub());
    else fr.skip(t & 7);
  }
  return feat;
}

function decodeGeom(gr) {
  const lines = [];
  let cur = null, x = 0, y = 0;
  while (gr.p < gr.end) {
    const cmd = gr.varint();
    const id = cmd & 7, count = cmd >> 3;
    for (let i = 0; i < count; i++) {
      if (id === 1) { // MoveTo
        const dx = zz(gr.varint()), dy = zz(gr.varint());
        x += dx; y += dy;
        cur = [[x, y]]; lines.push(cur);
      } else if (id === 2) { // LineTo
        const dx = zz(gr.varint()), dy = zz(gr.varint());
        x += dx; y += dy;
        cur.push([x, y]);
      } else break; // ClosePath は道路には出ない想定
    }
  }
  return lines;
}
const zz = (v) => (v >> 1) ^ (-(v & 1));

async function fetchTile(x, y) {
  const url = URL_TMPL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// ---- 本体 ----
const cx = tileX(lon, z), cy = tileY(lat, z);
console.log(`地理院 experimental_bvmap  z=${z}  中心タイル ${cx}/${cy}  (lat=${lat}, lon=${lon})`);
console.log('取得範囲: 3x3 タイル\n');

const tiles = new Map(); // "x,y" -> {lines:[[gx,gy],...][], extent}
let totalBytes = 0;

for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    const tx = cx + dx, ty = cy + dy;
    const buf = await fetchTile(tx, ty);
    if (!buf) { console.log(`  ${tx}/${ty}: 取得失敗`); continue; }
    totalBytes += buf.length;
    const layers = readLayers(buf);
    const road = layers['road'];
    if (!road) { console.log(`  ${tx}/${ty}: ${buf.length}B road レイヤなし  (layers: ${Object.keys(layers).join(',')})`); continue; }
    // タイル内座標 → 全体整数座標(extent 単位で並べる)。継ぎ目が一致すれば完全一致するはず
    const ext = road.extent;
    const lines = [];
    for (const f of road.features) {
      if (f.type !== 2) continue; // LineString のみ
      for (const ln of f.lines) lines.push(ln.map(([px, py]) => [tx * ext + px, ty * ext + py]));
    }
    tiles.set(`${tx},${ty}`, { lines, ext, tx, ty, bytes: buf.length, feats: road.features.length });
    console.log(`  ${tx}/${ty}: ${buf.length}B  extent=${ext}  road地物=${road.features.length}  線分=${lines.length}`);
  }
}
console.log(`\n合計 ${(totalBytes / 1024).toFixed(1)} KB\n`);

// === 検証1: 交差点で線分が分割されているか ===
// 頂点座標ごとに「端点として現れた回数」「中間点として現れた回数」を数える。
// 端点が3本以上集まる点が多ければ、交差点で分割されている(端点突き合わせでグラフが組める)。
// 中間点として他線の端点と重なる点(T字)が多ければ、線分の分割が要る。
console.log('=== 検証1: 交差点の分割 (中心タイル単体で判定) ===');
const center = tiles.get(`${cx},${cy}`);
if (center) {
  const endpt = new Map(), midpt = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const ln of center.lines) {
    if (ln.length < 2) continue;
    bump(endpt, ln[0].join(','));
    bump(endpt, ln[ln.length - 1].join(','));
    for (let i = 1; i < ln.length - 1; i++) bump(midpt, ln[i].join(','));
  }
  const deg = { 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const c of endpt.values()) deg[c >= 4 ? '4+' : c]++;
  let tJunction = 0;
  for (const k of endpt.keys()) if (midpt.has(k)) tJunction++;
  console.log(`  端点の異なり座標数: ${endpt.size}`);
  console.log(`  端点次数 1本(行き止まり/タイル端): ${deg[1]}`);
  console.log(`  端点次数 2本(単純な繋ぎ)        : ${deg[2]}`);
  console.log(`  端点次数 3本(T字交差点)         : ${deg[3]}`);
  console.log(`  端点次数 4本以上(十字交差点)     : ${deg['4+']}`);
  console.log(`  端点が他線の「中間点」と重なる数  : ${tJunction}  ← 多いと線分分割が必要`);

  // 中間点どうしの重なり(貫通交差)も見る
  let midShared = 0;
  for (const [k, c] of midpt) if (c >= 2) midShared++;
  console.log(`  中間点どうしが重なる座標数        : ${midShared}`);
}

// === 検証2: タイル境界の継ぎ目 ===
// 隣接タイルどうしで、境界上の端点座標が完全一致するか。
console.log('\n=== 検証2: タイル境界の継ぎ目 ===');
const pairs = [[[cx, cy], [cx + 1, cy], 'x'], [[cx, cy], [cx, cy + 1], 'y']];
for (const [a, b, axis] of pairs) {
  const A = tiles.get(a.join(',')), B = tiles.get(b.join(','));
  if (!A || !B) continue;
  const boundary = axis === 'x' ? (a[0] + 1) * A.ext : (a[1] + 1) * A.ext;
  const onBoundary = (lines, idx) => {
    const s = new Set();
    for (const ln of lines) for (const p of [ln[0], ln[ln.length - 1]]) if (p && p[idx] === boundary) s.add(p.join(','));
    return s;
  };
  const idx = axis === 'x' ? 0 : 1;
  const sa = onBoundary(A.lines, idx), sb = onBoundary(B.lines, idx);
  let hit = 0;
  for (const k of sa) if (sb.has(k)) hit++;
  console.log(`  ${a.join('/')} ↔ ${b.join('/')} (${axis}方向)`);
  console.log(`    境界ちょうどに乗る端点: A側 ${sa.size} / B側 ${sb.size}  完全一致 ${hit}`);
  // バッファ越しの重複(境界の外にはみ出した頂点)があるかも見る
  const outside = A.lines.flat().filter((p) => p[idx] > boundary).length;
  console.log(`    A が境界の外へはみ出す頂点数: ${outside}  (>0 ならバッファあり)`);

  // バッファ重複域で、同じ道路の頂点が両タイルに完全一致で入っているか
  const setB = new Set(B.lines.flat().map((p) => p.join(',')));
  const aOver = A.lines.flat().filter((p) => p[idx] > boundary - 64);
  let match = 0;
  for (const p of aOver) if (setB.has(p.join(','))) match++;
  console.log(`    重複域(境界±)のA頂点 ${aOver.length} のうち B にも同座標で存在: ${match}`);

  // 重複域で「A の端点」が B の線の頂点と一致する数 = 継ぎ目を縫える候補
  let seam = 0, seamTotal = 0;
  for (const ln of A.lines) {
    for (const p of [ln[0], ln[ln.length - 1]]) {
      if (!p || p[idx] <= boundary - 64) continue;
      seamTotal++;
      if (setB.has(p.join(','))) seam++;
    }
  }
  console.log(`    重複域にあるAの端点 ${seamTotal} のうち B の頂点と一致: ${seam}`);
}
