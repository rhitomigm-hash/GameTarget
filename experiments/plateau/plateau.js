// PLATEAU(3D都市モデル)の建築物LOD1を読み込み、
// prototype/terrain.js と同じローカル座標系(x:東+, y:標高, z:南+, 単位m)に載せる。
//
// 実データで確認した前提(2026-08-18):
//   - 配信は https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/<spec>/tileset.json
//     認証不要・CORS `*`・Range リクエスト可
//   - b3dm はサイズの約76%が使わない属性JSON(batchTable)。glTF はファイル末尾にあるので
//     先頭28バイトのヘッダだけ先に読んでオフセットを求め、glTF 部分だけを Range で取る
//   - ジオメトリは KHR_draco_mesh_compression で圧縮されている
//   - LOD1 はテクスチャを持たない(仕様上、高さだけの箱)。写真テクスチャが要るなら LOD2。
//     LOD2 は EXT_texture_webp で、タイルごとにアトラス1枚(three の GLTFLoader が対応済み)
//   - 座標は CESIUM_RTC 拡張(中心からの相対値)。Three.js の GLTFLoader はこれを無視するため
//     JSONチャンクから自前で読んで平行移動する
//   - 高さは「楕円体高」。地理院DEMの「標高」とは日本で約30〜40mずれる(ジオイド高)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/';

// WGS84
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// 経緯度(度)+楕円体高(m) → 地球中心直交座標(ECEF)
export function lonLatToEcef(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + h) * cosLat * Math.cos(lon),
    (n + h) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + h) * sinLat,
  ];
}

// 基準点(lon,lat)を原点とする ECEF → ゲーム内座標(x:東+, y:上+, z:南+) の変換行列。
// y は「基準点の楕円体高0からの高さ」になる。標高に直すにはジオイド高を引く(呼び出し側で調整)。
export function makeEcefToLocalMatrix(lonDeg, latDeg) {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);

  // 基準点における東・北・上の単位ベクトル(ECEF成分)
  const east  = [-sinLon, cosLon, 0];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const up    = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const o = lonLatToEcef(lonDeg, latDeg, 0);

  // 行 = 各基底との内積。z は南+なので north を反転する
  const m = new THREE.Matrix4();
  m.set(
    east[0],   east[1],   east[2],  0,
    up[0],     up[1],     up[2],    0,
    -north[0], -north[1], -north[2], 0,
    0, 0, 0, 1,
  );
  // 平行移動(原点を基準点へ)を先に適用する
  const t = new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]);
  return m.multiply(t);
}

// --- b3dm の解析 -----------------------------------------------------------

// b3dm ヘッダ(28バイト)から glTF の位置と長さを求める
function parseB3dmHeader(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'b3dm') throw new Error(`b3dm ではない: ${magic}`);
  const byteLength = dv.getUint32(8, true);
  const ftJson = dv.getUint32(12, true);
  const ftBin  = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin  = dv.getUint32(24, true);
  const glbOffset = 28 + ftJson + ftBin + btJson + btBin;
  return { byteLength, glbOffset, glbLength: byteLength - glbOffset };
}

// glb の JSONチャンクを読んで CESIUM_RTC の中心座標(ECEF)を取り出す。無ければ null
function readRtcCenter(glb) {
  const dv = new DataView(glb);
  if (dv.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  return json.extensions?.CESIUM_RTC?.center ?? null;
}

// --- tileset.json のツリー走査 --------------------------------------------

function resolveUri(baseUrl, uri) {
  return /^https?:/.test(uri) ? uri : new URL(uri, baseUrl).href;
}

// region [west, south, east, north, minH, maxH] (経緯度はラジアン、高さはm)
function regionInfo(region) {
  const [w, s, e, n, minH, maxH] = region;
  const toDeg = 180 / Math.PI;
  return {
    lon: ((w + e) / 2) * toDeg,
    lat: ((s + n) / 2) * toDeg,
    west: w * toDeg, south: s * toDeg, east: e * toDeg, north: n * toDeg,
    minH, maxH,
  };
}

// tileset を再帰的にたどり、実データ(b3dm)を持つ末端タイルの一覧を返す。
// 外部 tileset (.json を content に持つノード) は展開する。
async function collectLeafTiles(tilesetUrl, depth = 0, out = []) {
  if (depth > 6) return out;
  const res = await fetch(tilesetUrl);
  if (!res.ok) throw new Error(`tileset 取得失敗 ${res.status}: ${tilesetUrl}`);
  const tileset = await res.json();

  const walk = async (node) => {
    const uri = node.content?.uri ?? node.content?.url;
    const children = node.children ?? [];
    if (uri && /\.json(\?|$)/.test(uri)) {
      // 外部 tileset。そちらを開いて続きを拾う
      await collectLeafTiles(resolveUri(tilesetUrl, uri), depth + 1, out);
      return;
    }
    if (children.length === 0) {
      // 末端。ここが実際に描く対象
      if (uri && node.boundingVolume?.region) {
        out.push({
          url: resolveUri(tilesetUrl, uri),
          region: regionInfo(node.boundingVolume.region),
        });
      }
      return;
    }
    // 中間ノードは refine:REPLACE で子に置き換わるため、自身の content は使わない
    for (const c of children) await walk(c);
  };

  await walk(tileset.root);
  return out;
}

// --- 読み込み本体 ----------------------------------------------------------

let gltfLoader = null;
function getLoader() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(draco);
  return gltfLoader;
}

// b3dm を Range で「glTF部分だけ」取得する。Range が使えない場合は全体を取りに行く
async function fetchGlb(url, stats) {
  const head = await fetch(url, { headers: { Range: 'bytes=0-27' } });
  if (head.status === 206) {
    const { byteLength, glbOffset, glbLength } = parseB3dmHeader(await head.arrayBuffer());
    const res = await fetch(url, {
      headers: { Range: `bytes=${glbOffset}-${glbOffset + glbLength - 1}` },
    });
    if (res.status === 206) {
      const glb = await res.arrayBuffer();
      stats.fullBytes += byteLength;
      stats.fetchedBytes += glb.byteLength + 28;
      return glb;
    }
  }
  // フォールバック: 全部読む
  const buf = await (await fetch(url)).arrayBuffer();
  const { byteLength, glbOffset, glbLength } = parseB3dmHeader(buf);
  stats.fullBytes += byteLength;
  stats.fetchedBytes += buf.byteLength;
  stats.rangeMisses++;
  return buf.slice(glbOffset, glbOffset + glbLength);
}

/**
 * PLATEAU の建築物 LOD1 を読み込む。
 *
 * @param {object} opts
 * @param {string} opts.cityCode   5桁市区町村コード(例 '13101' = 千代田区)
 * @param {number} opts.centerLon  基準点の経度(terrain と同じ値を渡すこと)
 * @param {number} opts.centerLat  基準点の緯度
 * @param {number} opts.radiusM    この距離内のタイルを読む(m)
 * @param {number} opts.maxTiles   読み込むタイル数の上限(負荷の保険)
 * @param {number} [opts.lod=1]    1 = 箱のみ(テクスチャ無し) / 2 = 写真テクスチャ付き
 * @param {boolean} [opts.texture=true] LOD2 のときテクスチャ付きの配信を選ぶか
 * @param {(done:number,total:number,msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{group:THREE.Group, stats:object}>}
 *   group.position.y にジオイド高の補正を入れると標高基準に揃う
 */
export async function loadBuildings({
  cityCode, centerLon, centerLat, radiusM = 3000, maxTiles = 6,
  lod = 1, texture = true, onProgress,
}) {
  const stats = {
    tilesInTileset: 0, tilesLoaded: 0, buildings: 0, vertices: 0, textured: 0,
    fullBytes: 0, fetchedBytes: 0, rangeMisses: 0, ms: 0,
  };
  const t0 = performance.now();
  const report = (done, total, msg) => onProgress && onProgress(done, total, msg);

  // 配信の spec は <市区町村コード>-bldg-lod<N>[-texture|-notexture]-latest。
  // LOD1 はテクスチャ指定を受け付けない(そもそも持っていない)
  const spec = lod >= 2
    ? `${cityCode}-bldg-lod${lod}-${texture ? 'texture' : 'notexture'}-latest`
    : `${cityCode}-bldg-lod${lod}-latest`;

  report(0, 1, 'tileset.json を取得中');
  const all = await collectLeafTiles(`${CATALOG}/${spec}/tileset.json`);
  stats.tilesInTileset = all.length;

  // 基準点からの距離でタイルを絞る(緯度の縮尺を考慮した簡易距離)
  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const withDist = all.map((t) => ({
    ...t,
    dist: Math.hypot((t.region.lon - centerLon) * mPerDegLon, (t.region.lat - centerLat) * mPerDegLat),
  })).sort((a, b) => a.dist - b.dist);

  const targets = withDist.filter((t) => t.dist <= radiusM).slice(0, maxTiles);
  if (targets.length === 0) {
    throw new Error(
      `基準点から ${radiusM}m 以内に建物タイルがありません` +
      `(最寄り ${Math.round(withDist[0]?.dist ?? -1)}m)。市区町村コードか基準点を見直してください`);
  }

  const toLocal = makeEcefToLocalMatrix(centerLon, centerLat);
  // 3D Tiles の glTF は Y-up。ECEF(Z-up)に合わせるため X 軸まわりに +90度回す
  const yUpToZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const loader = getLoader();
  const group = new THREE.Group();
  group.name = 'plateau-buildings';

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    report(i, targets.length, `建物タイル ${i + 1}/${targets.length}`);
    try {
      const glb = await fetchGlb(t.url, stats);
      const rtc = readRtcCenter(glb);
      const gltf = await loader.parseAsync(glb, '');

      // CESIUM_RTC 中心を足してから、ECEF→ローカルへ落とす
      const place = new THREE.Matrix4().copy(toLocal);
      if (rtc) place.multiply(new THREE.Matrix4().makeTranslation(rtc[0], rtc[1], rtc[2]));
      place.multiply(yUpToZUp);

      gltf.scene.applyMatrix4(place);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        stats.vertices += o.geometry.attributes.position.count;
        // GLTFLoader は未知の属性名を小文字化するため、両方の綴りを見る
        const batchId = o.geometry.attributes._batchid || o.geometry.attributes._BATCHID;
        if (batchId) stats.buildings += new Set(batchId.array).size;

        // テクスチャを持つマテリアル(LOD2)はそのまま使う。上書きすると写真が消える。
        // 持たないもの(LOD1、LOD2の一部の面)だけ、見やすい単色に差し替える
        if (o.material?.map) {
          stats.textured++;
        } else {
          o.material = new THREE.MeshLambertMaterial({
            color: 0xc8c8c0,
            vertexColors: !!o.geometry.attributes.color,
          });
        }
        o.castShadow = false;
        o.receiveShadow = false;
      });
      group.add(gltf.scene);
      stats.tilesLoaded++;
    } catch (err) {
      console.warn('建物タイルの読み込みに失敗:', t.url, err);
    }
  }

  report(targets.length, targets.length, '完了');
  stats.ms = Math.round(performance.now() - t0);
  return { group, stats };
}

/**
 * 建物の底面と地形の標高を突き合わせて、ジオイド高(楕円体高 - 標高)を推定する。
 *
 * 建物は地面に建っているので「格子内で最も低い頂点 ≒ その場所の地面の楕円体高」とみなし、
 * 地理院DEMの標高との差の中央値をとる。中央値なので一部の外れ値には影響されない。
 *
 * @param {THREE.Group} group      loadBuildings が返した group(まだ y をずらしていない状態)
 * @param {(x:number,z:number)=>number} getHeight  terrain.js の getHeight
 * @param {number} [cell=100]      格子の一辺(m)
 * @returns {{offset:number, samples:number, spread:number}|null}
 *   offset: 推定ジオイド高(m)。group.position.y = -offset で標高基準に揃う
 *   spread: サンプルのばらつき(四分位範囲)。大きいときは推定を信用しない
 */
export function estimateGeoidOffset(group, getHeight, cell = 100) {
  const lowest = new Map(); // "gx_gz" -> {x, z, y}
  const v = new THREE.Vector3();

  group.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const key = `${Math.floor(v.x / cell)}_${Math.floor(v.z / cell)}`;
      const cur = lowest.get(key);
      if (!cur || v.y < cur.y) lowest.set(key, { x: v.x, z: v.z, y: v.y });
    }
  });

  const diffs = [];
  for (const p of lowest.values()) {
    const ground = getHeight(p.x, p.z);
    if (Number.isFinite(ground)) diffs.push(p.y - ground);
  }
  if (diffs.length < 4) return null;

  diffs.sort((a, b) => a - b);
  const q = (f) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * f))];
  return { offset: q(0.5), samples: diffs.length, spread: q(0.75) - q(0.25) };
}
