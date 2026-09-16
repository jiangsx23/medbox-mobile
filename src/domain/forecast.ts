/**
 * 补货预测纯函数 —— 移植自 `medbox-app/app/services/forecast.py` 的前两个函数。
 * 聚合查询（`in_stock_rows` / `dashboard_stats`）在 `src/data/queries.ts`，
 * 不在这里：那是数据形状问题，不是领域规则。
 */

/**
 * 预计可用天数 = 在库合计 ÷ 每日用量。
 * 没设每日用量、或用量 ≤0（非法值）→ null = 不参与预测。
 */
export function daysOfSupply(totalQty: number, dailyDose: number | null | undefined): number | null {
  if (dailyDose === null || dailyDose === undefined || dailyDose <= 0) return null;
  return totalQty / dailyDose;
}

/**
 * 需补货 ⟺ 预计可用天数 **≤** 阈值。
 *
 * 边界是 `≤` 不是 `<`：恰好等于阈值（比如正好还能吃 15 天、阈值也是 15）即需补货。
 * 0 库存 → 可用天数 0 → 0 ≤ 阈值 → 需补货，所以「0 库存也算」是自然成立的，
 * 不需要额外特判。无预测（null）返回 false。
 */
export function needsRestock(dos: number | null | undefined, restockDays: number): boolean {
  if (dos === null || dos === undefined) return false;
  return dos <= restockDays;
}

/**
 * 展示用：把可用天数格式化成 '34' / '6.5'，避免 '34.0' 这种尾巴。
 * 对应网页版模板里的 `'%g'|format(x)`。
 */
export function formatDos(dos: number): string {
  return Number.isInteger(dos) ? String(dos) : String(Number(dos.toFixed(1)));
}

/** 展示用：每日用量同样的去尾处理（模板里的 `num()`）。 */
export function formatDose(dose: number): string {
  return Number.isInteger(dose) ? String(dose) : String(Number(dose.toFixed(2)));
}
