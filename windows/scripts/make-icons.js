'use strict';
/**
 * 生成 Windows 端需要的图标：`assets/icon.ico`（安装包 / 任务栏 / 窗口）
 * 与 `assets/tray.png`（托盘）。
 *
 * ## 为什么不直接放一张 PNG 进仓库
 *
 * - `electron-builder` 的 `win.icon` **只认 .ico**，给 PNG 它会静默退回
 *   Electron 默认图标 —— 安装包看起来就是个 Electron 空壳。
 * - .ico 可以内嵌 PNG 数据（不必是 BMP），所以只要会写 PNG 就能写 .ico。
 *
 * 所以这里手写了一个极小的 PNG/ICO 编码器，不引入任何依赖 ——
 * 一个「盯着 DSH 的小挂件」不该为了画图标拖进图像处理库。
 *
 * 用法：`node scripts/make-icons.js`
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ─────────────────────────── 绘制 ───────────────────────────

const SS = 3;   // 超采样倍数（抗锯齿）

/** 点是否在圆角矩形内。 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * 画一枚图标：深底圆角方块 + 一条渐变「岛」。
 * @param {number} size 边长
 * @returns {Buffer} RGBA 像素（size*size*4）
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const bg = [0x16, 0x16, 0x1c, 0xff];
  const gradA = [0x4e, 0x7c, 0xff];   // 思考
  const gradB = [0x00, 0xd2, 0xaa];   // 执行

  const outerR = Math.round(size * 0.22);
  // 岛：居中偏上，宽 0.62、高 0.25、圆角到全圆（胶囊）
  const pillW = size * 0.62;
  const pillH = size * 0.25;
  const px0 = (size - pillW) / 2;
  const py0 = (size - pillH) / 2;
  const px1 = px0 + pillW;
  const py1 = py0 + pillH;
  const pillR = pillH / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      let pill = 0;
      let tSum = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (inRoundRect(fx, fy, 0, 0, size - 1, size - 1, outerR)) inside += 1;
          if (inRoundRect(fx, fy, px0, py0, px1, py1, pillR)) {
            pill += 1;
            tSum += (fx - px0) / pillW;
          }
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (inside === 0) continue;   // 保持透明

      let r = bg[0], g = bg[1], b = bg[2];
      const aBase = (inside / n) * 255;

      if (pill > 0) {
        const t = tSum / pill;
        const pr = lerp(gradA[0], gradB[0], t);
        const pg = lerp(gradA[1], gradB[1], t);
        const pb = lerp(gradA[2], gradB[2], t);
        const pc = pill / n;
        r = lerp(r, pr, pc);
        g = lerp(g, pg, pc);
        b = lerp(b, pb, pc);
      }

      px[o] = Math.round(r);
      px[o + 1] = Math.round(g);
      px[o + 2] = Math.round(b);
      px[o + 3] = Math.round(aBase);
    }
  }
  return px;
}

// ─────────────────────────── PNG 编码 ───────────────────────────

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素 → PNG。逐行 filter=0（不压缩差分，图标无所谓体积）。 */
function encodePng(px, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * PNG → .ico（单帧，内嵌 PNG 数据）。
 * 256×256 在 ICONDIRENTRY 里要写成 0（1 字节存不下 256）。
 */
function encodeIco(pngBuf, size) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);      // reserved
  dir.writeUInt16LE(1, 2);      // type: icon
  dir.writeUInt16LE(1, 4);      // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;                 // color count
  entry[3] = 0;                 // reserved
  entry.writeUInt16LE(1, 4);    // planes
  entry.writeUInt16LE(32, 6);   // bit count
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);  // offset = 6 + 16

  return Buffer.concat([dir, entry, pngBuf]);
}

// ─────────────────────────── 输出 ───────────────────────────

function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [
    { size: 256, file: 'icon.png' },
    { size: 64, file: 'tray.png' },
  ];
  let icoPng = null;
  for (const s of sizes) {
    const px = draw(s.size);
    const png = encodePng(px, s.size);
    fs.writeFileSync(path.join(outDir, s.file), png);
    console.log('write assets/' + s.file + ' (' + s.size + '×' + s.size + ', ' + png.length + ' B)');
    if (s.size === 256) icoPng = png;
  }

  const ico = encodeIco(icoPng, 256);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log('write assets/icon.ico (' + ico.length + ' B)');
}

main();
