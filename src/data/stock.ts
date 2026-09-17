/**
 * 库存操作的**落库层**。
 *
 * 规则全在 `src/domain/stock.ts`（纯函数、有测试）；这里只做三件事：
 * 把规则要的行捞出来 → 把规则算好的方案写进去 → 一个事务里完成。
 * 所以这个文件里**不该有任何 `if` 判断业务规则** —— 出现了就说明规则长错地方了。
 *
 * ── 为什么方案里带的是「批次 id」而不是整行 ─────────────────────────────
 * 方案的形状刻意贴近 SQL：`patches` 是 UPDATE、`events` 是 INSERT、
 * `ledger` 是一次成对的列更新（不变量 5）。这样「结算」和「用户操作」
 * 能共用同一条落库路径（`applyPlan`），不必为结算再写一套并行的写库代码。
 */
import { and, eq, gt } from 'drizzle-orm';

import type { MedboxDb } from '../db/client';
import type { Batch, CalendarDay, Instant } from '../db/schema';
import { batches, medicines, stockEvents } from '../db/schema';
import type { AutoBatch } from '../domain/autodose';
import { BATCH_IN_STOCK } from '../domain/constants';
import {
  planDiscard,
  planEdit,
  planIntake,
  planMarkExpired,
  planRestock,
  planSettle,
  planTake,
  planUsedUp,
  type EditForm,
  type IntakeForm,
  type OpContext,
  type OpResult,
  type Plan,
} from '../domain/stock';

/** 找不到药品/批次时的统一回应（界面上当一句普通错误显示即可）。 */
function notFound(what: string): OpResult {
  return { ok: false, errors: { _: `${what}不存在，可能已经被删掉了。` } };
}

function toAutoBatch(b: Batch): AutoBatch {
  return {
    id: b.id,
    qty: b.qty,
    unit: b.unit,
    expiryDate: b.expiryDate,
    openedAt: b.openedAt,
    openLifeDays: b.openLifeDays,
    createdAt: b.createdAt,
  };
}

/**
 * 结算用：该药在库且**有量**的批次。
 *
 * `qty > 0` 不是多余的 —— 存量数据里可能有「在库但 0 片」的批次（不变量 4 的
 * 已知例外），把它们算进合计会让 `sum(qty)` 与界面显示的对不上。
 */
export function inStockBatchesOf(db: MedboxDb, medicineId: number): AutoBatch[] {
  return db
    .select()
    .from(batches)
    .where(
      and(
        eq(batches.medicineId, medicineId),
        eq(batches.status, BATCH_IN_STOCK),
        gt(batches.qty, 0),
      ),
    )
    .all()
    .map(toAutoBatch);
}

/** 把纯规则需要的输入凑齐：药 + 它当前的在库批次 + 今天。 */
export function loadOpContext(
  db: MedboxDb,
  medicineId: number,
  today: CalendarDay,
): OpContext | null {
  const m = db.select().from(medicines).where(eq(medicines.id, medicineId)).get();
  if (!m) return null;
  return {
    medicine: {
      id: m.id,
      autoDeduct: m.autoDeduct,
      autoPaused: m.autoPaused,
      dailyDose: m.dailyDose,
      autoFrom: m.autoFrom,
      autoAccounted: m.autoAccounted,
      unit: m.unit,
      ownerId: m.ownerId,
    },
    inStock: inStockBatchesOf(db, medicineId),
    today,
  };
}

export function batchById(db: MedboxDb, batchId: number): Batch | undefined {
  return db.select().from(batches).where(eq(batches.id, batchId)).get();
}

/**
 * 取刚插入那一行的自增 id。
 *
 * ⚠️ drizzle 的**两个驱动返回的键名不一样**：expo-sqlite 是 `lastInsertRowId`
 * （大写 D，App 上跑的是这个），better-sqlite3 是 `lastInsertRowid`（小写 d）。
 * 两个都认，是为了让落库层能在 better-sqlite3 上被测试到（见 `test/data.test.ts`）——
 * 否则这条路径只能靠真机试。
 *
 * 更要紧的是**取不到就立刻报错**。让 `createdId` 变成 `NaN` 的话，入库事件会带着
 * 一个非法的 `batch_id` 落库，用户看到的是一句指不到病根的
 * 「NOT NULL constraint failed: stock_events.batch_id」。
 */
function insertedId(res: {
  lastInsertRowId?: number | bigint;
  lastInsertRowid?: number | bigint;
}): number {
  const v = res.lastInsertRowId ?? res.lastInsertRowid;
  if (v === undefined) throw new Error('插入批次后拿不到自增 id —— 驱动返回的键名变了？');
  return Number(v);
}

/**
 * 落库。**整体一个事务** —— 数量改了却没写事件，就是账实不符（不变量 1），
 * 这种中间状态绝不允许被别的查询看到。
 *
 * `createdAt` / `updatedAt` 用同一个 `now`：一次操作产生的一组行时间一致，
 * 时间线排序才不会出现「事件比批次早 1 毫秒」这种要靠 id 兜底的乱序。
 */
export function applyPlan(db: MedboxDb, plan: Plan, now: Instant = Date.now()): void {
  db.transaction((tx) => {
    let createdId: number | null = null;

    if (plan.create) {
      const res = tx
        .insert(batches)
        .values({ ...plan.create, createdAt: now, updatedAt: now })
        .run();
      createdId = insertedId(res);
    }

    for (const { id, patch } of plan.patches) {
      tx.update(batches).set({ ...patch, updatedAt: now }).where(eq(batches.id, id)).run();
    }

    if (plan.ledger) {
      // 起算日与已核算消耗量**一起写**（不变量 5）。分成两条 UPDATE
      // 中间被读到，就是一个自相矛盾的账本。
      tx.update(medicines)
        .set({ autoFrom: plan.ledger.autoFrom, autoAccounted: plan.ledger.autoAccounted })
        .where(eq(medicines.id, plan.ledger.medicineId))
        .run();
    }

    for (const e of plan.events) {
      // null = 刚创建的那一盒（只有入库会这样）。既没指定批次、本次又没新建批次，
      // 说明方案本身不成立 —— 与其让 SQLite 报一句 NOT NULL，不如在这里说清楚
      const batchId = e.batchId ?? createdId;
      if (batchId === null) {
        throw new Error('方案里有个事件既没指定批次，本次操作也没有新建批次');
      }
      tx.insert(stockEvents)
        .values({
          batchId,
          type: e.type,
          deltaQty: e.deltaQty,
          qtyAfter: e.qtyAfter,
          reason: e.reason,
          createdAt: now,
        })
        .run();
    }
  });
}

/** 算出方案并落库 —— 七个操作共用的外壳。 */
function run(
  db: MedboxDb,
  medicineId: number,
  today: CalendarDay,
  build: (ctx: OpContext) => OpResult,
  now: Instant,
): OpResult {
  const ctx = loadOpContext(db, medicineId, today);
  if (!ctx) return notFound('药品');
  const res = build(ctx);
  if (res.ok) applyPlan(db, res.plan, now);
  return res;
}

// ── 七个操作 ───────────────────────────────────────────────────────────

/** 入库（新增一盒）。 */
export function intake(
  db: MedboxDb,
  medicineId: number,
  form: IntakeForm,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  return run(db, medicineId, today, (ctx) => planIntake(ctx, form), now);
}

/** 取用 k 个单位。 */
export function take(
  db: MedboxDb,
  batchId: number,
  amount: string,
  reason: string,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planTake(ctx, b, amount, reason), now);
}

export function usedUp(
  db: MedboxDb,
  batchId: number,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planUsedUp(ctx, b), now);
}

export function discard(
  db: MedboxDb,
  batchId: number,
  reason: string,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planDiscard(ctx, b, reason), now);
}

export function markExpired(
  db: MedboxDb,
  batchId: number,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planMarkExpired(ctx, b), now);
}

export function restock(
  db: MedboxDb,
  batchId: number,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planRestock(ctx, b), now);
}

/** 编辑纠错（全字段，含单位与归属）。 */
export function edit(
  db: MedboxDb,
  batchId: number,
  form: EditForm,
  today: CalendarDay,
  now: Instant = Date.now(),
): OpResult {
  const b = batchById(db, batchId);
  if (!b) return notFound('这一盒');
  return run(db, b.medicineId, today, (ctx) => planEdit(ctx, b, form), now);
}

// ── 结算（DbProvider 的闸门调用）───────────────────────────────────────

/**
 * 结算全部启用了自动扣减的药，返回本次实际扣掉的总量。
 *
 * **幂等**：同一天跑多少次结果都一样。所以冷启动、回前台、下拉刷新
 * 可以放心地都调它 —— 多跑无害是设计目标，不是巧合。
 *
 * ⚠️ 导出/下载路径**绝不要**调这个（硬约束 6）：下载文件不该悄悄改数据。
 */
export function settleAll(db: MedboxDb, today: CalendarDay, now: Instant = Date.now()): number {
  const meds = db
    .select({ id: medicines.id })
    .from(medicines)
    .where(and(eq(medicines.autoDeduct, true), eq(medicines.autoPaused, false)))
    .all();

  let total = 0;
  for (const med of meds) {
    const ctx = loadOpContext(db, med.id, today);
    if (!ctx) continue;
    const plan = planSettle(ctx);
    const didSomething = plan.events.length > 0 || plan.ledger !== undefined;
    if (!didSomething) continue;
    applyPlan(db, plan, now);
    // 事件是负数，取反才是「扣了多少」
    total += plan.events.reduce((s, e) => s - e.deltaQty, 0);
  }
  return total;
}
