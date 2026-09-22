/**
 * 库 → 纯数据。推送对账的输入侧（M5）。
 *
 * **不 import expo**，所以能被 jest 覆盖在真 SQLite 上（`test/notify-snapshot.test.ts`）。
 * 这一层刻意做得很薄：**零新领域逻辑** —— 提醒日直接要 `effectiveExpiry` 的结果，
 * 在库合计与单位冲突直接要 `aggregateByMedicine` 的结果，本文件不做任何加减。
 *
 * 为什么要单独一层、而不是让 `src/domain/notify.ts` 直接吃 drizzle 的行：
 * domain 层不认识 `MedboxDb`，于是那 31 条调度测试可以在**没有数据库**的情况下
 * 穷举各种组合。这和 `src/exporter/report.ts` 是同一种分法。
 *
 * ⚠️ **必须在结算之后调用**（`DbProvider` 的闸门里，`settleAll` 之后）——
 * 前瞻吃的是结算后的库存，早一步算出来的是昨天的数。
 */
import type { MedboxDb } from '../db/client';
import type { CalendarDay } from '../db/schema';
import { type BatchRow, type Thresholds, aggregateByMedicine, inStockRows } from '../data/queries';
import type { NotifyBatch, NotifyMedicine, NotifySnapshot } from '../domain/notify';

/**
 * 读一份「推送用」的库快照。
 *
 * 批次侧直接复用 `inStockRows` —— 它已经 join 好了药与成员，且 `batch.status`
 * 恒为 `in_stock`（它的 where 就写着这个），所以不必再筛一遍。
 *
 * 药侧只收**有在库批次的**药：库存已经归零的药 `k₀` 与 `k₁` 都是 0，按
 * DESIGN.md §7.7 的规则 4 本来就推不出东西来 —— 它的「已用完」那条早在前一天
 * 库存还剩 1 的时候就排好了。所以这里少几味药不影响行为，
 * 首页照常把它们算进「需补货」（那条刻意的页面/推送不对称就这么来的）。
 */
export function loadNotifySnapshot(
  db: MedboxDb,
  today: CalendarDay,
  th: Thresholds,
): NotifySnapshot {
  const rows = inStockRows(db, today, th);
  const agg = aggregateByMedicine(db);

  const batches: NotifyBatch[] = rows.map((r: BatchRow) => ({
    batchId: r.batch.id,
    medicineId: r.batch.medicineId,
    status: r.batch.status,
    effective: r.effective,
  }));

  // 一味药可能有多盒在库 ⇒ 按 medicineId 去重，别让同一味药被算成多种。
  const seen = new Map<number, NotifyMedicine>();
  for (const r of rows) {
    const id = r.medicine.id;
    if (seen.has(id)) continue;
    const a = agg.get(id);
    seen.set(id, {
      medicineId: id,
      dailyDose: r.medicine.dailyDose,
      autoDeduct: r.medicine.autoDeduct,
      autoPaused: r.medicine.autoPaused,
      totalQty: a?.totalQty ?? 0,
      unitConflict: a?.unitConflict ?? false,
    });
  }

  return { batches, medicines: [...seen.values()] };
}
