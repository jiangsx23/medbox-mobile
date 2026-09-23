/**
 * `make-icons.js` 的公开面 —— 只服务一件事：让 `test/icons.test.ts`
 * 能拿**故意编坏**的数据去证伪 `verifyPng` 里那道自检。
 * （脚本本来是个命令行工具，这几个导出纯粹是给它开一扇能被测试戳的窗。）
 *
 * ⚠️ 参数和返回值写成 `Uint8Array` 而不是 `Buffer`：这份声明会被**主** tsconfig
 *    一并检查（它的 `include` 收全部 `.ts`），而主配置面向 App 代码、不保证有 node 类型。
 *    `Buffer` 本来就是 `Uint8Array` 的子类，这样写不损失运行时含义；
 *    测试里要用 `readUInt32BE` / `indexOf` 这类 Buffer 方法时，
 *    自己 `Buffer.from(...)` 一下即可。
 */

/** 把 RGBA / RGB 像素编成一张 PNG。**编码后立刻自检**，任何一条不过就抛错。 */
export function encodePng(size: number, channels: 3 | 4, pixels: Uint8Array): Uint8Array;

/**
 * 把编好的 PNG 解回像素逐项核对：签名、每个 chunk 的 CRC、IHDR 的尺寸与颜色类型、
 * IDAT 解压后的长度（必须正好是「每行多一个 filter 字节」的总长）、以及逐像素比对。
 * 不通过就抛。返回入参本身，好在 `encodePng` 里直接 return。
 */
export function verifyPng(
  buf: Uint8Array,
  size: number,
  channels: 3 | 4,
  pixels: Uint8Array,
): Uint8Array;

/** 渲染全部图标并编码，返回 `{ 文件名: PNG 字节 }`。 */
export function buildIcons(): Record<string, Uint8Array>;
