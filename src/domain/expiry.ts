/**
 * 效期领域纯函数 —— 逐行移植自 `medbox-app/app/services/expiry.py`。
 *
 * 与网页版的唯一差别：日期用日历日字符串（`src/domain/calendar.ts`）而不是
 * Python `date`，所以 `+ timedelta(days=n)` 变成 `addDays(...)`，
 * `<` / `<=` 的语义完全不变。
 */
import { addDays, compareDays, type CalendarDay } from './calendar';
import {
  EXPIRY_EXPIRED,
  EXPIRY_EXPIRING,
  EXPIRY_NONE,
  EXPIRY_OK,
  type ExpiryStatus,
} from './constants';

/** `effective_expiry` / `classify` 需要的最小批次形状。 */
export type ExpiryInput = {
  expiryDate: CalendarDay | null;
  openedAt: CalendarDay | null;
  openLifeDays: number | null;
};

/**
 * 返回用于提醒/排序的「实际提醒日」。
 *
 * ```
 * 候选 = []
 * 如果填了印刷效期:                候选.加入(印刷效期)
 * 如果填了拆封日期 且 填了开封天数:  候选.加入(拆封日期 + 开封天数)
 * 提醒日 = 候选中的最小值；候选为空则「未填效期」
 * ```
 * 注意「拆封日期」和「开封天数」必须**同时**填了才进候选 ——
 * 只填一个不算（requirements.md §2.2 对 `开封后有效期` 的约束）。
 */
export function effectiveExpiry(b: ExpiryInput): CalendarDay | null {
  let best: CalendarDay | null = null;
  if (b.expiryDate) best = b.expiryDate;
  if (b.openedAt && b.openLifeDays) {
    const opened = addDays(b.openedAt, b.openLifeDays);
    if (best === null || compareDays(opened, best) < 0) best = opened;
  }
  return best;
}

/**
 * 把批次分成 已过期 / 快过期 / 正常 / 未填效期（requirements.md §3.4）。
 *
 * 边界是本模块最容易写错的地方，抄自上游的两处不对称：
 * - 已过期是 `提醒日 < 今天`（**严格小于**，今天到期不算过期）
 * - 快过期是 `今天 ≤ 提醒日 ≤ 今天 + nearDays`（**两端都含**，
 *   所以 `nearDays = 0` 时「今天到期」仍算快过期）
 */
export function classify(b: ExpiryInput, today: CalendarDay, nearDays: number): ExpiryStatus {
  const eff = effectiveExpiry(b);
  if (eff === null) return EXPIRY_NONE;
  if (compareDays(eff, today) < 0) return EXPIRY_EXPIRED;
  if (compareDays(eff, addDays(today, nearDays)) <= 0) return EXPIRY_EXPIRING;
  return EXPIRY_OK;
}

/**
 * 是否过期（供自动扣减把过期盒排到最后用，§3.6「过期盒排到最后」）。
 * 未填效期也算「该排到最后」—— 上游 `_fefo_key` 把两者归为同一类。
 */
export function isExpiredOrUnknown(b: ExpiryInput, today: CalendarDay): boolean {
  const eff = effectiveExpiry(b);
  return eff === null || compareDays(eff, today) < 0;
}
