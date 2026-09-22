/**
 * 日历日算术 —— `'YYYY-MM-DD'` 字符串上的纯函数。
 *
 * 为什么不用 `Date` 做这件事：JS 的 `Date` 是**瞬间**，不是日历日。一旦用它
 * 表示「印刷效期」这类值，就必然要回答「这个日期的零点在哪个时区」——
 * 于是 `(a - b) / 86400` 在跨夏令时或设备时区变化时会算出 23 小时或 25 小时，
 * `Math.floor` 之后差一天。requirements.md §2.6 记的正是网页版踩过的这个坑。
 *
 * 这里改用「距 1970-01-01 的天数」这个整数来承载日历日（Howard Hinnant 的
 * civil-from-days 算法）。全程整数运算，没有时区、没有夏令时、没有浮点，
 * 「相差几天」就是一次减法。
 */
import type { CalendarDay } from '../db/schema';

export type { CalendarDay };

const DAY_MS = 86_400_000;

/** 平闰年判断 */
function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : MONTH_LENGTHS[m - 1];
}

/**
 * 天数 → 日历日（Hinnant 算法，1970-01-01 起算，纪元前为负）。
 * 思路：把 3 月当作一年的开头，于是闰日落在年末，不用特判。
 */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]，3 月为 0
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** 日历日 → 天数（civilFromDays 的逆运算）。 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const mp = m > 2 ? m - 3 : m + 9; // 3 月为 0
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析 `'YYYY-MM-DD'`。格式或日期不合法（如 2026-02-30）返回 null。 */
export function parseDay(s: string | null | undefined): CalendarDay | null {
  if (!s) return null;
  const m = DAY_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  return formatDay(y, mo, d);
}

/** 组装 `'YYYY-MM-DD'`，补零。 */
export function formatDay(y: number, m: number, d: number): CalendarDay {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 日历日 → 距 1970-01-01 的天数。调用前必须已通过 parseDay 校验。 */
export function toDays(day: CalendarDay): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`不是合法的日历日：${day}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 距 1970-01-01 的天数 → 日历日。 */
export function fromDays(days: number): CalendarDay {
  const { y, m, d } = civilFromDays(days);
  return formatDay(y, m, d);
}

/** 日历日加减天数（可为负）。 */
export function addDays(day: CalendarDay, n: number): CalendarDay {
  return fromDays(toDays(day) + n);
}

/**
 * `b - a`，单位「天」的整数。
 * 这就是 requirements.md §2.6 要求的「日历日相减」——
 * 绝不要写成 `(时刻b - 时刻a) / 86400000`。
 */
export function diffDays(a: CalendarDay, b: CalendarDay): number {
  return toDays(b) - toDays(a);
}

export function compareDays(a: CalendarDay, b: CalendarDay): number {
  return toDays(a) - toDays(b);
}

/** a < b */
export function isBefore(a: CalendarDay, b: CalendarDay): boolean {
  return toDays(a) < toDays(b);
}

/**
 * **设备本地的今天**（requirements.md §2.6 规则 1）。
 * 取本地年月日分量，所以「今天」永远是用户手表上的今天，
 * 不会在 UTC+8 的傍晚被 UTC 日期抢跑。
 */
export function today(now: Date = new Date()): CalendarDay {
  return formatDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** 校验用：是不是一个格式合法的日历日。 */
export function isValidDay(s: unknown): s is CalendarDay {
  return typeof s === 'string' && parseDay(s) !== null;
}

/**
 * 「某天的本地墙上时间」→ epoch 毫秒。与 `today()` 互为逆运算。
 *
 * 推送（M5）用它算「9 月 23 日早 9:00」那个闹钟时刻。用户要的是**墙上时间**，
 * 不是「距纪元多少毫秒」——所以必须走本地分量拼 `Date`，不能 `Date.UTC`
 * （后者在 UTC+8 会让闹钟早响 8 小时，正是 §6.2 那颗雷的形状）。
 *
 * ⚠️ 夏令时：若那天那个钟点本地不存在（春季前跳），`Date` 会把它推到跳变之后。
 * 中国没有夏令时，且我们排的是 9:00 这种整点，实际碰不到；但这是「本地时间」的
 * 固有代价，不是实现疏漏。
 */
export function localDayAt(day: CalendarDay, hour: number, minute: number): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`不是合法的日历日：${day}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0, 0).getTime();
}

// ── 时刻（epoch 毫秒）────────────────────────────────────────────────
export { DAY_MS };
