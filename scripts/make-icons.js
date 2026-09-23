#!/usr/bin/env node
'use strict';

/**
 * 生成 `assets/` 下的全部图标（药箱字形 + 品牌绿）。
 *
 * 为什么要有个脚本，而不是丢几个二进制文件：
 *   图标的几何是**算出来的**，不是画出来的 —— 自适应图标的安全区是个圆
 *   （108dp 里只有中间 72dp 一定可见，四角会被启动器的蒙版切掉），
 *   字形该多大、居中后四角会不会被切，都是一次乘法的事。
 *   没有源码的话，下次「嫌小/嫌偏」就只能重画一遍。
 *
 * 🔴 **不引入 `sharp` / `canvas`** —— 为了几张图标给全项目加一个原生依赖，
 *    换来的只是「Png 编码器别人写过」。这里手写 PNG 的三个 chunk + `zlib.deflateSync`，
 *    零依赖，跑 `node scripts/make-icons.js` 即可重新生成。
 *
 * ⚠️ 生成物**要提交**（`assets/` 是进仓库的），这个脚本是给「下次改」用的。
 * ⚠️ 改完必须重新出包才生效：图标是 prebuild 时写进 `android/` 的
 *    （见 AGENTS.md「构建配置」—— 手改 `android/` 会被 prebuild 整个删掉）。
 *
 * ✅ 每张图**出图前先自证**：把刚编好的字节重新解一遍（签名 / chunk CRC /
 *    IHDR 尺寸 / IDAT 解压长度 / 逐像素跟源缓冲比对），任何一条不过就抛错、
 *    **一张都不写**。理由见下面 `verifyPng` 顶上那段。自检装在 `encodePng` 里，
 *    也就是唯一的出口 —— 绕不过去。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG 编码（三个 chunk + deflate，别的一概不需要）──────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param channels 3 = RGB（iOS 图标要的，不能带 alpha）、4 = RGBA */
function encodePng(size, channels, pixels) {
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // 每行前面那个 filter 字节，用 none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = channels === 4 ? 6 : 2; // 颜色类型
  return verifyPng(
    Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
    size,
    channels,
    pixels,
  );
}

// ── 自检：出图前先把自己的产物解一遍 ─────────────────────────────────────
//
// 🔴 为什么非要有这一步：手写 PNG 最容易漏掉的，是「**每行开头那个 filter 字节**」。
//    它不起眼，但漏了以后 IHDR 声明的尺寸跟 IDAT 里的数据就对不上 —— 文件看着
//    有模有样，宽松的解码器说不定还能糊弄过去，严格的解码器则直接拒收。
//    2026-09-23 真栽过一次：临时另写的一份编码器漏了这个字节，
//    生成的通知图标对照图被 API 拒收，而报错是
//    「unsupported image, please make sure your image is valid」——
//    读起来像「格式不对」，实际跟格式毫无关系，完全指不到病根。
//    ⇒ 所以这里不靠「小心点」，改成**自证**：解不开、或解出来跟源像素对不上，
//      就抛错，一张图都不写。

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 把刚编出来的 PNG 解回像素，逐项核对。不通过就抛。
 * @returns 原样返回 `buf`，好在 `encodePng` 里当 return 用。
 */
function verifyPng(buf, size, channels, pixels) {
  const fail = (why) => {
    throw new Error(`图标自检没过（${size}×${size}，${channels} 通道）：${why}`);
  };

  if (buf.length < 8 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) fail('PNG 签名不对');

  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  let idat = null;
  let sawIend = false;

  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (p + 12 + len > buf.length) fail('chunk 越界（文件被截断了？）');
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    // CRC 是算在「类型 + 数据」上的
    if (buf.readUInt32BE(p + 8 + len) !== crc32(buf.subarray(p + 4, p + 8 + len))) {
      fail(`chunk ${type} 的 CRC 对不上`);
    }
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
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

  if (!idat) fail('没有 IDAT 块');
  if (!sawIend) fail('没有 IEND 块');
  if (w !== size || h !== size) fail(`IHDR 声明的是 ${w}×${h}`);
  if (depth !== 8) fail(`位深是 ${depth}`);
  const gotChannels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (gotChannels !== channels) {
    fail(`颜色类型 ${colorType}（${gotChannels} 通道）跟要写的 ${channels} 通道不符`);
  }

  // 🔴 这一条正是上面那段注释说的东西：解压出来必须**正好**是
  //    「每行多一个 filter 字节」的总长。漏掉 filter 字节时，
  //    这里会短整整 h 个字节 —— 而 h 就是图像高度。
  const stride = size * channels;
  const raw = zlib.inflateSync(idat); // 流本身坏了会在这儿自己抛
  const want = (stride + 1) * size;
  if (raw.length !== want) {
    fail(
      `IDAT 解压出 ${raw.length} 字节，IHDR 要求 ${want} 字节（差 ${want - raw.length}）` +
        '——每行那个 filter 字节漏了？',
    );
  }

  // 最后再对一遍像素：确认「写出去的文件」解回来就是「本来要画的那张图」
  for (let y = 0; y < size; y++) {
    if (raw[y * (stride + 1)] !== 0) fail(`第 ${y} 行的 filter 字节不是 0`);
    for (let i = 0; i < stride; i++) {
      if (raw[y * (stride + 1) + 1 + i] !== pixels[y * stride + i]) {
        fail(`第 ${y} 行第 ${i} 个字节解回来跟源像素不一致`);
      }
    }
  }

  return buf;
}

// ── 字形：一只药箱（把手 + 箱体，正面挖掉一个十字）────────────────────────
//
// 全部用 0..1 的「字形坐标系」；调用方负责把它映射到画布上的方框里。
// 挖十字而不是画十字，是为了让底色透出来 —— 前景层挖出来的是背景层的颜色，
// 传统图标里画出来的是箱体的底色，两种用法都不需要第二个颜色。

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

//             x0   y0    x1   y1    r
const BODY = [0.0, 0.30, 1.0, 1.0, 0.10];
const HANDLE_OUT = [0.30, 0.0, 0.70, 0.32, 0.07];
const HANDLE_IN = [0.40, 0.09, 0.60, 0.30, 0.03]; // 往上收到箱体顶边为止，别把箱体挖穿

const CROSS_ARM = 0.17; // 十字臂长（半长）
const CROSS_TH = 0.055; // 十字臂粗（半宽）
const CROSS_CY = 0.66; // 视觉重心比箱体几何中心略高一点

function inCross(x, y) {
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - CROSS_CY);
  return (dx <= CROSS_ARM && dy <= CROSS_TH) || (dx <= CROSS_TH && dy <= CROSS_ARM);
}

function inGlyph(x, y) {
  const solid =
    inRoundRect(x, y, ...BODY) || (inRoundRect(x, y, ...HANDLE_OUT) && !inRoundRect(x, y, ...HANDLE_IN));
  return solid && !inCross(x, y);
}

// ── 渲染 ────────────────────────────────────────────────────────────────

/**
 * 把字形渲染进 RGBA 缓冲。
 *
 * @param size 画布边长
 * @param box  字形外接方框的边长（像素），居中 —— 其余是留白
 * @param fg   字形颜色 `[r,g,b]`
 * @param bgAt 底色；`(x, y, size) => [r,g,b]`，传 `null` = 透明底
 * @param ss   超采样倍数（每像素 ss×ss 个采样点）
 */
function render(size, box, { fg, bgAt = null, ss = 4 }) {
  const px = new Uint8Array(size * size * 4);
  const x0 = (size - box) / 2;
  const y0 = (size - box) / 2;
  const step = 1 / ss;
  const total = ss * ss;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let cov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const gx = (pxi + (sx + 0.5) * step - x0) / box;
          const gy = (py + (sy + 0.5) * step - y0) / box;
          if (inGlyph(gx, gy)) cov++;
        }
      }
      cov /= total;

      const i = (py * size + pxi) * 4;
      const base = bgAt ? bgAt(pxi, py, size) : null;
      if (base) {
        for (let c = 0; c < 3; c++) px[i + c] = Math.round(fg[c] * cov + base[c] * (1 - cov));
        px[i + 3] = 255;
      } else {
        px[i] = fg[0];
        px[i + 1] = fg[1];
        px[i + 2] = fg[2];
        px[i + 3] = Math.round(255 * cov);
      }
    }
  }
  return px;
}

/** 纯底色（背景层，没有字形）。 */
function renderSolid(size, colorAt) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colorAt(x, y, size);
      const i = (y * size + x) * 4;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

function toRgb(rgba) {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i];
    out[j + 1] = rgba[i + 1];
    out[j + 2] = rgba[i + 2];
  }
  return out;
}

// ── 配色（与 src/ui/theme.ts 一致）──────────────────────────────────────

const BRAND = [0x0e, 0x6e, 0x55]; // theme.color.brand —— 与 app.json 的频道色同一个值
const CREAM = [0xf7, 0xf3, 0xec]; // theme.color.bg
const GREY = [0x7d, 0x7d, 0x7d]; // 单色层：只取 alpha，颜色随便但别用透明
const WHITE = [0xff, 0xff, 0xff];

/** 背景层的柔和渐变：左上亮 → 右下深，都在品牌绿的浅色区里。 */
const BG_TOP = [0xea, 0xf5, 0xf0];
const BG_BOTTOM = [0xcd, 0xe2, 0xd8];
const bgAt = (x, y, size) => {
  const t = (x / size + y / size) / 2;
  return [0, 1, 2].map((c) => Math.round(BG_TOP[c] + (BG_BOTTOM[c] - BG_TOP[c]) * t));
};

// ── 各图标的尺寸 ────────────────────────────────────────────────────────
//
// 🔴 自适应图标（foreground / monochrome）的字形大小是**算出来的**，别拍脑袋调大：
//    画布 512，蒙版能盖到的半径 = 512 × (72/108) ÷ 2 = 170.7；
//    方框边长 box 的四角到中心距离 = box × √2 ÷ 2。要求它 ≤ 170.7 ⇒ box ≤ 241。
//    取 230 留一点余量。**调大这个数 = 启动器切掉箱子角**。

const ADAPTIVE = 512;
const ADAPTIVE_BOX = 230;
const MONO = 432; // 与改动前一致；等比缩上去
const MONO_BOX = Math.round((ADAPTIVE_BOX / ADAPTIVE) * MONO);

const LEGACY = 1024;
const LEGACY_BOX = Math.round(LEGACY * 0.62); // 传统图标没有安全区圆，但 iOS 会把四角磨圆

const NOTIF = 96;
const NOTIF_BOX = Math.round(NOTIF * 0.9); // 通知小图标相反：要**填满**，否则状态栏里显得小

/**
 * 渲染全部图标并编码，返回 `{ 文件名: PNG 字节 }`。
 *
 * ⚠️ 刻意做成**函数**，而不是模块顶层的 `const files = {...}`：
 *    写在顶层就意味着「`require` 一下这个文件」会顺带跑完 7 张图的全部渲染
 *    （约 2 秒）。`test/icons.test.ts` 只想要 `encodePng` / `verifyPng` 两个函数，
 *    不该付这个代价。渲染只该发生在真的要出图的时候。
 */
function buildIcons() {
  return {
    // 自适应图标的前景层：透明底 + 品牌绿字形
    'android-icon-foreground.png': encodePng(
      ADAPTIVE,
      4,
      render(ADAPTIVE, ADAPTIVE_BOX, { fg: BRAND }),
    ),
    // 背景层：纯渐变，没有字形
    'android-icon-background.png': encodePng(ADAPTIVE, 4, renderSolid(ADAPTIVE, bgAt)),
    // 单色层：Android 13+ 的「主题图标」用，只取 alpha 通道再自己染色
    'android-icon-monochrome.png': encodePng(MONO, 4, render(MONO, MONO_BOX, { fg: GREY })),
    // 传统图标（API 24/25 与 iOS）：绿底 + 米白箱子 —— 不带 alpha，iOS 不收透明图标
    'icon.png': encodePng(LEGACY, 3, toRgb(render(LEGACY, LEGACY_BOX, { fg: CREAM, bgAt: () => BRAND }))),
    // 网页图标
    'favicon.png': encodePng(
      48,
      4,
      render(48, 30, { fg: CREAM, bgAt: () => BRAND, ss: 8 }),
    ),
    // 通知小图标：白色字形 + 透明底（Android 用 alpha 当蒙版，自己染成 app.json 里的 color）
    'notification-icon.png': encodePng(NOTIF, 4, render(NOTIF, NOTIF_BOX, { fg: WHITE, ss: 8 })),
    // 启动图（目前 app.json 还没引用，但别再留着 Expo 模板的标志）
    'splash-icon.png': encodePng(LEGACY, 4, render(LEGACY, LEGACY_BOX, { fg: BRAND, ss: 2 })),
  };
}

function main() {
  const dir = path.join(__dirname, '..', 'assets');
  for (const [name, buf] of Object.entries(buildIcons())) {
    fs.writeFileSync(path.join(dir, name), buf);
    console.log(`${name.padEnd(32)} ${String(buf.length).padStart(8)} 字节`);
  }
}

if (require.main === module) main();

// 导出只为一件事：**让自检能被证伪**。
// AGENTS.md 里那条「守卫不能永远为真」（M6 踩过：断言写错、路径写错，测试照样绿）
// 同样适用于这里 —— 一个从没红过的自检，跟没有自检是一回事。
// `test/icons.test.ts` 拿**故意编坏**的缓冲喂给 `verifyPng`，断言它真的抛错，
// 并且断言具体是哪一条不过；再用正常产物做正向对照。
// 顺带：导出 + `require.main` 分流之后，`require` 这个文件是**零副作用且瞬时**的，
// 不会渲染、不会写盘。
module.exports = { encodePng, verifyPng, buildIcons };
