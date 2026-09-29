// 生成 PWA 图标 src/icons.js（base64 PNG，192/512）——零依赖手写 PNG 编码
// 设计与 /favicon.svg 同款：brand 色圆角方块 + 白色声波（圆点 + 三段弧）
// 用法：node scripts/gen-icons.mjs   （改设计后重跑，产物 src/icons.js 入库）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ---- 最小 PNG 编码器（RGBA8，filter 0） ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 设计：圆角方块 + 声波 ----
const BRAND = [14, 122, 95];    // #0E7A5F
const WHITE = [255, 255, 255];
function roundedRectInside(x, y, s, r) { // 点是否在圆角矩形内
  const rx = Math.min(x, s - x), ry = Math.min(y, s - y);
  return rx >= r || ry >= r || (rx - r) ** 2 + (ry - r) ** 2 <= r * r;
}
function render(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const cx = size * 0.33, cy = size * 0.5;          // 声波圆心（偏左，弧朝右）
  const dotR = size * 0.055;
  const arcs = [size * 0.145, size * 0.24, size * 0.335]; // 三段弧半径
  const halfStroke = size * 0.033;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let color = null, alpha = 255;
      if (!roundedRectInside(x, y, size, size * 0.22)) {
        alpha = 0; // 圆角外透明
      } else {
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx); // -PI..PI，弧取右侧 -64°..64°
        if (d <= dotR) color = WHITE;
        else if (Math.abs(ang) < (64 * Math.PI) / 180 && arcs.some(r => Math.abs(d - r) <= halfStroke)) color = WHITE;
        if (!color) color = BRAND;
      }
      px[i] = color ? color[0] : 0;
      px[i + 1] = color ? color[1] : 0;
      px[i + 2] = color ? color[2] : 0;
      px[i + 3] = alpha;
    }
  }
  return encodePng(Buffer.from(px.buffer), size, size);
}

const png192 = render(192);
const png512 = render(512);
mkdirSync(new URL('../src/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../src/icons.js', import.meta.url),
  '// 由 scripts/gen-icons.mjs 生成，勿手改（改设计后重跑生成器）\n' +
  'export const ICON_192_PNG = \'' + png192.toString('base64') + '\';\n' +
  'export const ICON_512_PNG = \'' + png512.toString('base64') + '\';\n'
);
console.log(`src/icons.js 写入完成：icon-192 ${png192.length}B (base64 ${Math.round(png192.length * 1.37)}), icon-512 ${png512.length}B (base64 ${Math.round(png512.length * 1.37)})`);
