// チェイスカー: 全域 z14 で足りるかの検証。
// 同一地域を z14 と z16 で取り、道路の総延長・本数・幅員区分の分布を比較する。
//   node probe-zoom.mjs [lat] [lon]
import { readLayers, tileX, tileY, fetchTile } from './mvt.mjs';

const lat = Number(process.argv[2] ?? 33.27);
const lon = Number(process.argv[3] ?? 130.25);

// z14 タイル1枚と、それを覆う z16 タイル16枚を比較する
const z14x = tileX(lon, 14), z14y = tileY(lat, 14);

// タイル座標 → メートル換算(そのズームの1単位が何メートルか)
const unitMeters = (z, extent) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (2 ** z * extent);

async function collect(z, xs, ys) {
  const feats = [];
  let bytes = 0, tiles = 0;
  for (const x of xs) for (const y of ys) {
    const buf = await fetchTile(z, x, y);
    if (!buf) continue;
    bytes += buf.length; tiles++;
    const road = readLayers(buf)['road'];
    if (!road) continue;
    const u = unitMeters(z, road.extent);
    for (const f of road.features) {
      if (f.type !== 2) continue;
      // タイル本体(0..extent)の内側だけを数える。バッファの重複を二重計上しない
      let len = 0;
      for (const ln of f.lines) {
        for (let i = 1; i < ln.length; i++) {
          const [ax, ay] = ln[i - 1], [bx, by] = ln[i];
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          if (mx < 0 || mx >= road.extent || my < 0 || my >= road.extent) continue;
          len += Math.hypot(bx - ax, by - ay) * u;
        }
      }
      if (len > 0) feats.push({ len, props: f.props });
    }
  }
  return { feats, bytes, tiles };
}

const a = await collect(14, [z14x], [z14y]);
const b = await collect(16, [0, 1, 2, 3].map((i) => z14x * 4 + i), [0, 1, 2, 3].map((i) => z14y * 4 + i));

const sum = (fs) => fs.reduce((s, f) => s + f.len, 0);
const hist = (fs, key) => {
  const m = new Map();
  for (const f of fs) {
    const k = String(f.props[key] ?? '(なし)');
    const c = m.get(k) || { n: 0, len: 0 };
    c.n++; c.len += f.len; m.set(k, c);
  }
  return m;
};

console.log(`比較地域: z14 タイル ${z14x}/${z14y} 1枚ぶん (lat=${lat}, lon=${lon})`);
console.log(`  z14: ${a.tiles}枚 ${(a.bytes / 1024).toFixed(0)}KB  road ${a.feats.length}本  総延長 ${(sum(a.feats) / 1000).toFixed(2)}km`);
console.log(`  z16: ${b.tiles}枚 ${(b.bytes / 1024).toFixed(0)}KB  road ${b.feats.length}本  総延長 ${(sum(b.feats) / 1000).toFixed(2)}km`);
console.log(`  → z14 は z16 の総延長の ${(sum(a.feats) / sum(b.feats) * 100).toFixed(1)}%\n`);

for (const key of ['rnkWidth', 'rdCtg']) {
  console.log(`=== ${key} の分布(総延長km / 本数)===`);
  const ha = hist(a.feats, key), hb = hist(b.feats, key);
  const keys = [...new Set([...ha.keys(), ...hb.keys()])].sort();
  console.log('  ' + '区分'.padEnd(28) + 'z14'.padEnd(20) + 'z16');
  for (const k of keys) {
    const A = ha.get(k) || { n: 0, len: 0 }, B = hb.get(k) || { n: 0, len: 0 };
    const ratio = B.len > 0 ? `${(A.len / B.len * 100).toFixed(0)}%` : '-';
    console.log(`  ${k.padEnd(24)} ${(A.len / 1000).toFixed(2)}km/${A.n}本`.padEnd(52) + `${(B.len / 1000).toFixed(2)}km/${B.n}本  (${ratio})`);
  }
  console.log('');
}

// 20km四方(既存の TILE_RADIUS=2 相当)を全域 z14 で覆うと何枚・何MBか
const perTile = a.bytes / Math.max(a.tiles, 1);
const kmPerTile = 40075.016686 * Math.cos(lat * Math.PI / 180) / 2 ** 14;
const n = Math.ceil(20 / kmPerTile) ** 2;
console.log(`=== 全域 z14 の読み込み量(20km四方)===`);
console.log(`  z14 タイル1枚 = ${kmPerTile.toFixed(2)}km四方 / 実測 ${(perTile / 1024).toFixed(0)}KB`);
console.log(`  20km四方 = 約${n}枚 = 約${(n * perTile / 1024 / 1024).toFixed(1)}MB`);
