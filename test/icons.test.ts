/**
 * 图标：① 已提交的 `assets/*.png` 结构是否完好；② 生成脚本的自检**能不能被证伪**。
 *
 * ── 为什么值得单独一个套件 ──────────────────────────────────────────────
 * 2026-09-23：一张临时生成的 PNG 被 API 拒收，报的却是
 * 「unsupported image，请用 webp/png/jpeg/gif」—— 读起来像「格式不对」，
 * 实际跟格式毫无关系。真正的原因在编码：**每行漏了一个 filter 字节**，
 * 于是 IHDR 声明的尺寸跟 IDAT 里的数据对不上。文件看着有模有样，
 * 只有严格的解码器看得出来。
 * 事后 `encodePng` 里长出了一道自检，但这个套件是给那道自检**上保险**的 ——
 * AGENTS.md 里那条「守卫不能永远为真」（M6 踩过：正则写错、路径写错，
 * 测试照样绿）在这里同样成立：一个从没红过的自检，跟没有自检是一回事。
 *
 * ── 为什么要两份实现 ────────────────────────────────────────────────────
 * ① 下面这个 `inspectPng` 是**独立另写**的，只读文件、不 import 脚本 ——
 *    同 `test/helpers.ts` 里 `insertId` 刻意另写一份的理由：共用同一个实现，
 *    就只能证明「它和自己一致」，证明不了它自己对。所以哪怕哪天 `verifyPng`
 *    被人整个删掉，① 这一半照样会拦住一个坏掉的 `assets/`。
 * ② 拿**故意编坏**的缓冲喂给脚本自己的 `verifyPng`，断言它抛错，
 *    而且抛的是**那一条**分支 —— 只断言「抛了」，会被任何一处误报糊弄过去。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { encodePng, verifyPng } from '../scripts/make-icons.js';

const ASSETS = join(__dirname, '..', 'assets');

// ── ① 独立实现：只认 8 位深、非隔行、颜色类型 2/6 的 PNG（本项目自己产的那几种）──

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PngShape {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  /** 3 或 4；颜色类型认不出来时是 0 */
  channels: number;
  /** IDAT 解压出来的实际字节数 */
  rawLength: number;
  /** IHDR 要求的字节数 = 高 × (宽 × 通道数 + 1)，每行那个 filter 字节算在内 */
  expectedRawLength: number;
  sawIend: boolean;
}

/** 结构上站不住就直接抛 —— 这几条是「文件坏了」，每个用例都该先过。 */
function inspectPng(file: string): PngShape {
  const buf = readFileSync(file);
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file}: 不是 PNG（签名不对）`);

  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let idat: Buffer | null = null;
  let sawIend = false;

  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error(`${file}: chunk ${type} 越界（文件被截断了？）`);
    const data = buf.subarray(p + 8, p + 8 + len);
    // CRC 算在「类型 + 数据」上
    if (buf.readUInt32BE(p + 8 + len) !== crc32(buf.subarray(p + 4, p + 8 + len))) {
      throw new Error(`${file}: chunk ${type} 的 CRC 对不上`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat = idat ? Buffer.concat([idat, data]) : data;
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    p += 12 + len;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  return {
    width,
    height,
    depth,
    colorType,
    channels,
    rawLength: idat ? inflateSync(idat).length : 0,
    expectedRawLength: channels ? height * (width * channels + 1) : 0,
    sawIend,
  };
}

// ── ① 的用例 ────────────────────────────────────────────────────────────

/**
 * 尺寸与通道数是**规格**，不是从脚本抄来的：改图标时要么改这里、要么被这里拦住。
 * `icon.png` 那一条尤其别顺手改成 4 —— iOS 不收带 alpha 的图标（见脚本里的注释）。
 */
const EXPECTED_ICONS = [
  { file: 'android-icon-foreground.png', size: 512, channels: 4 },
  { file: 'android-icon-background.png', size: 512, channels: 4 },
  { file: 'android-icon-monochrome.png', size: 432, channels: 4 }, // 与改动前一致，等比缩上去
  { file: 'icon.png', size: 1024, channels: 3 }, // 传统图标：**不带 alpha**，iOS 要的
  { file: 'favicon.png', size: 48, channels: 4 },
  { file: 'notification-icon.png', size: 96, channels: 4 },
  { file: 'splash-icon.png', size: 1024, channels: 4 },
];

describe('assets/ 里已提交的图标', () => {
  it('正好是这 7 个（不多不少）', () => {
    // 非空转断言：目录扫空、或新增图标忘了同步到这张表，这条都会红
    const onDisk = readdirSync(ASSETS)
      .filter((f) => f.endsWith('.png'))
      .sort();
    expect(onDisk).toEqual(EXPECTED_ICONS.map((e) => e.file).sort());
  });

  it.each(EXPECTED_ICONS)('$file：$size×$size、$channels 通道、结构完整', ({ file, size, channels }) => {
    const png = inspectPng(join(ASSETS, file));
    expect(png.width).toBe(size);
    expect(png.height).toBe(size);
    expect(png.channels).toBe(channels);
    expect(png.depth).toBe(8);
    expect(png.sawIend).toBe(true);
    // 🔴 就是 2026-09-23 那个 bug 的形状：每行漏一个 filter 字节 ⇒
    //    解压出来短整整「高度」个字节。
    expect(png.rawLength).toBe(png.expectedRawLength);
  });
});

// ── ② 证伪脚本自己那道自检 ──────────────────────────────────────────────

const S = 16; // 小画布就够：这几条验的是结构，不是图形

function solid(value: number, channels: 3 | 4): Uint8Array {
  const a = new Uint8Array(S * S * channels);
  for (let i = 0; i < S * S; i++) {
    a[i * channels] = value;
    if (channels === 4) a[i * channels + 3] = 255;
  }
  return a;
}

/**
 * 复刻 2026-09-23 那个坏掉的编码器：IHDR 声明 S×S，IDAT 却**直接 deflate 像素缓冲**，
 * 每行那个 filter 字节没写。这是本套件唯一一处「故意写错」的代码。
 */
function buggyEncodePng(size: number, channels: 3 | 4, pixels: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(pixels))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('make-icons.js 的自检：拿坏数据证伪它', () => {
  it('正向：正常产物不该抛（否则下面那些「抛错」就没意义了）', () => {
    const pixels = solid(200, 4);
    expect(() => verifyPng(encodePng(S, 4, pixels), S, 4, pixels)).not.toThrow();
  });

  it('正向：3 通道（RGB）产物同样通过 —— icon.png 走的就是这条路', () => {
    const pixels = solid(14, 3);
    expect(() => verifyPng(encodePng(S, 3, pixels), S, 3, pixels)).not.toThrow();
  });

  it('每行漏 filter 字节 → 必须抛，且指出短了多少', () => {
    const pixels = solid(200, 4);
    expect(() => verifyPng(buggyEncodePng(S, 4, pixels), S, 4, pixels)).toThrow(`差 ${S}`);
  });

  it('IDAT 被篡改 → 必须抛，且指出是 CRC', () => {
    const pixels = solid(200, 4);
    const png = Buffer.from(encodePng(S, 4, pixels));
    // 从 33 起找：跳过签名(8) + IHDR(25)，免得撞上压缩数据里碰巧出现的同样字节
    const at = png.indexOf(Buffer.from('IDAT', 'ascii'), 33) + 4;
    png[at] ^= 0xff; // 动数据的第一位
    expect(() => verifyPng(png, S, 4, pixels)).toThrow('CRC');
  });

  it('IDAT 中途被截断 → 必须抛「越界」', () => {
    const pixels = solid(200, 4);
    const png = Buffer.from(encodePng(S, 4, pixels));
    const at = png.indexOf(Buffer.from('IDAT', 'ascii'), 33);
    expect(() => verifyPng(png.subarray(0, at + 9), S, 4, pixels)).toThrow('越界');
  });

  it('IEND 块缺失 → 必须抛「没有 IEND」（跟截断是两条不同的分支）', () => {
    const pixels = solid(200, 4);
    const png = Buffer.from(encodePng(S, 4, pixels));
    expect(() => verifyPng(png.subarray(0, png.length - 12), S, 4, pixels)).toThrow('没有 IEND');
  });

  it('结构对但画的不是我要的图 → 必须抛「像素不一致」', () => {
    expect(() => verifyPng(encodePng(S, 4, solid(10, 4)), S, 4, solid(200, 4))).toThrow(
      '跟源像素不一致',
    );
  });

  it('颜色类型跟期望的通道数不符 → 必须抛', () => {
    expect(() => verifyPng(encodePng(S, 3, solid(14, 3)), S, 4, solid(200, 4))).toThrow('不符');
  });
});
