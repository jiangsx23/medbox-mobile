/**
 * 时刻（epoch 毫秒）的解析与格式化 —— 导入与导出互为逆运算，所以放在一起。
 *
 * ── 为什么要手写解析，不用 `new Date(string)` ──────────────────────────
 * 网页版导出的 `created_at` 是 `'2026-09-16T05:23:53'`：**UTC 的值，但字符串里
 * 没有任何时区标记**。而 JS 的 `new Date('2026-09-16T05:23:53')` 按 ES 规范
 * 会把这种「无时区的日期时间形式」当成**本地时间**解析（只有纯日期
 * `'2026-09-16'` 才是 UTC）。在 UTC+8 的机器上这正好差 8 小时 ——
 * 而 8 小时足以把一条事件推过日期边界，于是时间线上「今天取用的药」
 * 显示成昨天或明天。这正是 DESIGN.md §6.2 记的那颗雷。
 *
 * 所以这里按 DESIGN.md §7.2 的硬编码规则来：**naive 字符串一律当 UTC 解析**。
 * 带 `Z` 或 `±HH:MM` 后缀的则尊重后缀。
 */

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * 解析一个时刻字符串 → epoch 毫秒。
 * 无法解析返回 null（调用方负责报错，不静默兜底成「现在」——
 * 那会让一条坏数据看起来像一条新数据）。
 */
export function parseInstant(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const m = INSTANT_RE.exec(s.trim());
  if (!m) return null;

  const [, ys, mos, ds, hs, mis, ss, fracs, tz] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const sec = ss ? Number(ss) : 0;
  // 毫秒：'.411989' → 411（截断到毫秒精度，SQLite 也是这样）
  const ms = fracs ? Number(fracs.slice(0, 3).padEnd(3, '0')) : 0;

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 60) return null;

  let epoch = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  if (Number.isNaN(epoch)) return null;

  // 显式时区后缀：把偏移从 UTC 里扣掉，得到真正的瞬间
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const tzNorm = tz.slice(1).replace(':', '');
    const offMin = Number(tzNorm.slice(0, 2)) * 60 + Number(tzNorm.slice(2, 4));
    epoch -= sign * offMin * 60_000;
  }
  return epoch;
}

/**
 * epoch 毫秒 → naive UTC 字符串 `'YYYY-MM-DDTHH:mm:ss'`。
 * 这是**导出**用的格式，与网页版 `/export/all.json` 的 `created_at` 完全一致，
 * 保证 `version: 1` 双向兼容（硬约束 5）。
 */
export function toNaiveUtcString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/**
 * epoch 毫秒 → 设备本地的 `'YYYY-MM-DD HH:mm'`，给时间线展示用。
 * 用本地分量，因为用户看的是自己手表上的时间（§2.6 规则 4）。
 */
export function toLocalDisplay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 现在这个瞬间。 */
export function nowInstant(): number {
  return Date.now();
}
