// 使い捨ての最小 MVT デコーダ(属性つき)。チェイスカー検証専用。
export class Reader {
  constructor(buf, end = buf.length) { this.b = buf; this.p = 0; this.end = end; }
  varint() { let r = 0, s = 0, b; do { b = this.b[this.p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; }
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

const zz = (v) => (v >> 1) ^ (-(v & 1));

function decodeGeom(gr) {
  const lines = []; let cur = null, x = 0, y = 0;
  while (gr.p < gr.end) {
    const cmd = gr.varint(), id = cmd & 7, count = cmd >> 3;
    for (let i = 0; i < count; i++) {
      if (id === 1) { x += zz(gr.varint()); y += zz(gr.varint()); cur = [[x, y]]; lines.push(cur); }
      else if (id === 2) { x += zz(gr.varint()); y += zz(gr.varint()); cur.push([x, y]); }
      else break;
    }
  }
  return lines;
}

function readValue(vr) {
  while (vr.p < vr.end) {
    const t = vr.varint(), f = t >> 3, w = t & 7;
    if (f === 1 && w === 2) return vr.str();
    if ((f === 4 || f === 5) && w === 0) return vr.varint();
    if (f === 6 && w === 0) return zz(vr.varint());
    if (f === 7 && w === 0) return vr.varint() !== 0;
    if (f === 2 && w === 5) { const v = vr.b.readFloatLE(vr.p); vr.p += 4; return v; }
    if (f === 3 && w === 1) { const v = vr.b.readDoubleLE(vr.p); vr.p += 8; return v; }
    vr.skip(w);
  }
  return null;
}

function readFeature(fr) {
  const feat = { type: 0, lines: [], tags: [] };
  while (fr.p < fr.end) {
    const t = fr.varint(), f = t >> 3, w = t & 7;
    if (f === 3) feat.type = fr.varint();
    else if (f === 4) feat.lines = decodeGeom(fr.sub());
    else if (f === 2 && w === 2) { const tr = fr.sub(); while (tr.p < tr.end) feat.tags.push(tr.varint()); }
    else fr.skip(w);
  }
  return feat;
}

export function readLayers(buf) {
  const out = {};
  const r = new Reader(buf);
  while (r.p < r.end) {
    const tag = r.varint();
    if (tag >> 3 === 3) {
      const lr = r.sub();
      const layer = { name: '', extent: 4096, features: [], keys: [], values: [] };
      while (lr.p < lr.end) {
        const lt = lr.varint(), f = lt >> 3;
        if (f === 1) layer.name = lr.str();
        else if (f === 5) layer.extent = lr.varint();
        else if (f === 2) layer.features.push(readFeature(lr.sub()));
        else if (f === 3) layer.keys.push(lr.str());
        else if (f === 4) layer.values.push(readValue(lr.sub()));
        else lr.skip(lt & 7);
      }
      // tags を属性オブジェクトに展開
      for (const ft of layer.features) {
        ft.props = {};
        for (let i = 0; i + 1 < ft.tags.length; i += 2) ft.props[layer.keys[ft.tags[i]]] = layer.values[ft.tags[i + 1]];
      }
      out[layer.name] = layer;
    } else r.skip(tag & 7);
  }
  return out;
}

export const tileX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
export const tileY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};

export async function fetchTile(z, x, y) {
  const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${z}/${x}/${y}.pbf`);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
