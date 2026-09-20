/**
 * 药品档案的新建 / 编辑 / 删除 —— **落库层**。
 *
 * 规则全在 `src/domain/medicine.ts`（纯函数、有测试）；这里只做三件事：
 * 把规则要的行捞出来 → 把它算好的东西写进去 → 一个事务里完成。
 * 所以这个文件里**不该有任何 `if` 判断业务规则** —— 出现了就说明规则长错地方了。
 *
 * ── 编辑为什么要自己开事务，而不是复用 `applyPlan` ──────────────────────
 * 编辑档案要写的东西有两样：**结算**（扣批次 + 写事件 + 改账本）和
 * **档案行本身**。它们必须在**同一个事务**里 —— 若结算落了库而档案行没更新，
 * 账本就是照着旧剂量算的，而系统以为已经按新剂量算过了（不变量 1 的账实不符）。
 *
 * 但 `applyPlan` 自己就开了事务，**不能在里面再套一层**。而且这个坑
 * **测试测不出来**：better-sqlite3 的 `db.transaction()` 内部降级成 SAVEPOINT，
 * 嵌套静默成功；expo-sqlite 走裸 `begin`/`commit`，第二个 BEGIN 直接抛
 * `cannot start a transaction within a transaction`。
 *
 * 所以这里开事务、调 `applyPlanOn`（**不含**事务的那一半），而不是调 `applyPlan`。
 * 类型上也是这么设计的：`applyPlanOn` 收 `Executor`，而 `Executor` 是用 `Pick`
 * 去掉 `transaction` 的，所以这段代码**写不出** `tx.transaction(...)`。
 * 详见 `src/db/client.ts` 的 `Executor`。
 */
import { eq } from 'drizzle-orm';

import type { MedboxDb } from '../db/client';
import type { CalendarDay, Instant, Medicine } from '../db/schema';
import { batches, medicines } from '../db/schema';
import type { MedicineForm } from '../domain/medicine';
import { planMedicineCreate, planMedicineUpdate, planPause, planResume } from '../domain/medicine';
import { today as todayDay } from '../domain/calendar';
import { applyPlanOn, insertedId, loadOpContext } from './stock';

/** 与 `MemberResult` 同形，界面上两条路走同一套错误渲染。 */
export type MedicineResult = { ok: true; id: number } | { ok: false; errors: Record<string, string> };

/** 找不到药品时的统一回应（界面上当一句普通错误显示即可）。 */
function notFound(): MedicineResult {
  return { ok: false, errors: { _: '药品不存在，可能已经被删掉了。' } };
}

export function medicineById(db: MedboxDb, id: number): Medicine | undefined {
  return db.select().from(medicines).where(eq(medicines.id, id)).get();
}

/**
 * 该药名下的**批次条数**，含历史（已用完 / 已丢弃 / 已过期）。删除守卫的判据。
 *
 * ⚠️ **不能**换成 `inStockBatchesOf` —— 那个筛的是 `status = in_stock && qty > 0`。
 * 用后者的话，「药早就吃完了、只剩历史」的药会被放行，然后
 * `batches.medicine_id` 的外键抛一句 `FOREIGN KEY constraint failed`
 * （App 和测试里都开了 `PRAGMA foreign_keys = ON`）——
 * 一句指不到病根的原始报错。
 */
export function batchCountOf(db: MedboxDb, medicineId: number): number {
  return db.select({ id: batches.id }).from(batches).where(eq(batches.medicineId, medicineId)).all()
    .length;
}

// ── 新建 ───────────────────────────────────────────────────────────────

/**
 * 建档。**不走 Plan** —— 新建时这个药一条批次都没有，`planSettlement` 必然
 * 走「未开自动扣减」或「库存 ≤ 0」分支，`takes` 恒为空。也就是说方案里
 * 既不会有 patches 也不会有 events，唯一的差异只是 `autoFrom`/`autoAccounted`，
 * 而那两个本来就是「新建时的初值」，直接写进 INSERT 即可。
 * 走一遍 Plan 只是把两个常数绕一圈。
 *
 * 也不会产生任何 `stock_events`，而且是**结构性**的：`stock_events.batch_id`
 * 是 NOT NULL 且外键指向 `batches`，一盒都没有时根本没有可挂的行。
 * 不变量 8（只增不改不删）也不允许为「建档」造事件。
 */
export function createMedicine(
  db: MedboxDb,
  form: MedicineForm,
  today: CalendarDay,
  now: Instant = Date.now(),
): MedicineResult {
  const res = planMedicineCreate(form, today);
  if (!res.ok) return { ok: false, errors: res.errors };

  const inserted = db
    .insert(medicines)
    .values({ ...res.values, createdAt: now })
    .run();

  // ⚠️ 必须走 `insertedId`，不能写成 `Number(res.lastInsertRowId)` ——
  // drizzle 的两个驱动返回的键名不一样（expo-sqlite 大写 D、better-sqlite3 小写 d），
  // 直接取会拿到 NaN。`members.ts` 的 createMember 就踩了这个坑（见那里）。
  return { ok: true, id: insertedId(inserted) };
}

// ── 编辑 ───────────────────────────────────────────────────────────────

/**
 * 改档案。**结算与档案行在同一个事务里**（见文件头）。
 *
 * 顺序不能反：先 `applyPlanOn` 把旧账按**旧参数**结清，再写新字段。
 * 这个顺序在 `planMedicineUpdate` 里已经被结构保住了 —— 它拿的是更新前的
 * `ctx.medicine`，新值只在 `res.fields` 里，而 `res.fields` 的类型里
 * 根本没有账本字段，所以第二句 UPDATE 不可能覆盖第一句写下的账本。
 */
export function updateMedicine(
  db: MedboxDb,
  id: number,
  form: MedicineForm,
  today: CalendarDay,
  now: Instant = Date.now(),
): MedicineResult {
  const ctx = loadOpContext(db, id, today);
  if (!ctx) return notFound();

  const res = planMedicineUpdate(ctx.medicine, ctx.inStock, form, today);
  if (!res.ok) return { ok: false, errors: res.errors };

  // 读在事务外（`loadOpContext`），与 `stock.ts` 的 `run()` 完全同形。
  // 单连接 + 单线程 + 同步 SQLite，不存在被插队的窗口。
  db.transaction((tx) => {
    applyPlanOn(tx, res.plan, now);
    tx.update(medicines).set(res.fields).where(eq(medicines.id, id)).run();
  });

  return { ok: true, id };
}

// ── 删除 ───────────────────────────────────────────────────────────────

/**
 * 删除档案。**有任何批次就拒绝**（照抄上游 `routes/medicines.py`）。
 *
 * 拒绝而不是「顺手把那些批次也删掉」是刻意的：批次与变动记录是**只增**的
 * （不变量 8），删掉之后时间线就对不上了，而用户不会知道少了什么。
 *
 * ⚠️ 这个守卫是**终局的**：批次永远不删，所以一旦有过批次，删除就**永远**
 * 不会成功 —— 哪怕那盒药早就用完/丢弃了。文案里必须说透这一点，
 * 否则用户会反复试「我先把药全丢弃了再来删」。
 *
 * 不加事务，与 `deleteMember` 一致（单条 DELETE 本身就是原子的）。
 * 唯一的保证在外键 + 单连接单线程上，这个前置检查只是**文案** ——
 * 将来若有人加了一条 `ON DELETE CASCADE` 的迁移，它就会悄悄从「文案」
 * 升级成「唯一防线」，同时把不变量 8 一起破坏掉。
 */
export function deleteMedicine(db: MedboxDb, id: number): MedicineResult {
  const m = medicineById(db, id);
  if (!m) return notFound();

  const n = batchCountOf(db, id);
  if (n > 0) {
    return {
      ok: false,
      errors: {
        _:
          `「${m.generic}」名下还有 ${n} 条批次记录（含已用完、已丢弃、已过期的），不能删除。` +
          '这些记录删掉时间线就对不上了 —— 想改档案内容请用「编辑档案」。',
      },
    };
  }

  db.delete(medicines).where(eq(medicines.id, id)).run();
  return { ok: true, id };
}

// ── 暂停服药 / 恢复服药 ─────────────────────────────────────────────────

/**
 * 暂停服药。**结算与标志位在同一个事务里**，形状与 `updateMedicine` 相同。
 *
 * ⚠️ `today` 默认取**当场**的日期，**界面不要传 `useDb().today`**。
 * `DbProvider` 的 `today` 是缓存值（`useState(() => todayDay())`），只在
 * 冷启动 / 回前台 / 手动 reload 时更新；App 一直留在前台跨过午夜时它停在昨天。
 *
 * 对「取用 / 编辑数量」那类操作，这点偏差只会让账**晚一天**结 ——
 * 下一次闸门就补上了，**会自愈**。对这两个动作**不会自愈**：
 *
 * - 暂停用昨天结算 → 今天那一片不扣 → 紧接着置 `autoPaused` → 闸门从此跳过它
 *   → 恢复时账本又被覆盖成「今天 / 0」→ **那一片永久消失**
 * - 恢复用昨天写 `autoFrom` → 下一次闸门按今天算 days=1，把停药期的最后一天
 *   当成吃药的日子扣掉 —— 会真扣药，用户看得见
 *
 * 所以默认值就是 `todayDay()`。（`now = Date.now()` 本来就是同一个签名里的
 * 时钟默认值，风格一致。测试照常显式传日期。）
 */
export function pauseMedicine(
  db: MedboxDb,
  id: number,
  today: CalendarDay = todayDay(),
  now: Instant = Date.now(),
): MedicineResult {
  const ctx = loadOpContext(db, id, today);
  if (!ctx) return notFound();

  const res = planPause(ctx.medicine, ctx.inStock, today);
  if (!res.ok) return { ok: false, errors: res.errors };

  db.transaction((tx) => {
    // 先结清欠的账，再置标志位 —— 两件事必须同一个事务：
    // 若结算落了库而标志位没落，这个药会带着「已经结清」的账本继续按天扣。
    applyPlanOn(tx, res.plan, now);
    tx.update(medicines).set({ autoPaused: true }).where(eq(medicines.id, id)).run();
  });
  return { ok: true, id };
}

/** 恢复服药：只重设账本，**一片都不扣**。规则与 `today` 的理由见 `planResume` 与上面那段。 */
export function resumeMedicine(
  db: MedboxDb,
  id: number,
  today: CalendarDay = todayDay(),
  now: Instant = Date.now(),
): MedicineResult {
  const ctx = loadOpContext(db, id, today);
  if (!ctx) return notFound();

  const res = planResume(ctx.medicine, today);
  if (!res.ok) return { ok: false, errors: res.errors };

  db.transaction((tx) => {
    applyPlanOn(tx, res.plan, now);
    tx.update(medicines).set({ autoPaused: false }).where(eq(medicines.id, id)).run();
  });
  return { ok: true, id };
}
