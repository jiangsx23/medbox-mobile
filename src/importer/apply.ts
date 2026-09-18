/**
 * 把解析好的导出数据写进本地库 —— DESIGN.md §7.2 的「实现要求」。
 *
 * ── 三个刻意的选择 ─────────────────────────────────────────────────────
 * 1. **整体一个事务**：清空 + 全量写入要么全成要么全不成。导入失败时用户
 *    手上还是原来的数据，不会落进「清空了但没写进去」的空库。
 * 2. **重建 id**：旧 id 只在那一份文件里有意义（自增整数，跨库无意义），
 *    所以重新分配，并用一张「旧 → 新」映射表翻译外键。比「强行保留原 id
 *    再调自增起点」稳 —— 后者一旦文件里有空洞（真实数据里 id 4 就缺失）
 *    或将来再导入第二份文件，就会撞主键。
 * 3. **先清空再写入，不做增量合并**（决策 6）：批次没有天然业务键，
 *    「这条批次和那条是不是同一盒」根本无从判断，合并只会制造重复。
 */
import { eq } from 'drizzle-orm';

import type { MedboxDb } from '../db/client';
import type { Instant } from '../db/schema';
import { batches, members, medicines, settings, stockEvents } from '../db/schema';
import { KEY_NEAR_EXPIRY_DAYS, KEY_RESTOCK_DAYS } from '../domain/constants';
import type { ParsedImport } from './parse';

/** 导入完成后回给界面看的账。数字要与网页版对得上。 */
export type ImportOutcome = {
  members: number;
  medicines: number;
  batches: number;
  events: number;
  totalQty: number;
  /** 被重新起算的自动扣减药（决策 8，结果页要显式列出） */
  autoRestarted: ParsedImport['autoRestarted'];
  warnings: string[];
  exportedAtRaw: string | null;
};

/** 记录导入来源的设置键，供设置页展示与追溯 */
export const KEY_LAST_IMPORT_AT = 'last_import_at';
export const KEY_LAST_IMPORT_FILE = 'last_import_file';

export type ApplyOptions = {
  /** 导入这个动作发生的时刻（epoch ms） */
  importedAt: Instant;
  /** 源文件名，记进设置以便追溯 */
  sourceName?: string | null;
};

/**
 * 清空后全量写入。**在调用前必须已经让用户确认过** ——
 * 这会丢掉手机上的现有数据（虽然同一份文件的重复导入不会产生重复数据）。
 */
export function applyImport(db: MedboxDb, data: ParsedImport, opts: ApplyOptions): ImportOutcome {
  db.transaction((tx) => {
    // ── 清空。顺序按外键依赖倒着来：先删子表 ────────────────────────
    tx.delete(stockEvents).run();
    tx.delete(batches).run();
    tx.delete(medicines).run();
    tx.delete(members).run();
    tx.delete(settings).run();

    // ── 成员。姓名唯一，正好可以拿来当回读的键 ────────────────────
    const memberIdMap = new Map<number, number>();
    for (const m of data.members) {
      const res = tx
        .insert(members)
        .values({ name: m.name, notes: m.notes, createdAt: m.createdAt })
        .run();
      memberIdMap.set(m.oldId, Number(res.lastInsertRowId));
    }

    // ── 药品档案 ──────────────────────────────────────────────────
    const medicineIdMap = new Map<number, number>();
    for (const m of data.medicines) {
      const res = tx
        .insert(medicines)
        .values({
          generic: m.generic,
          brand: m.brand,
          spec: m.spec,
          form: m.form,
          category: m.category,
          purposeNotes: m.purposeNotes,
          dailyDose: m.dailyDose,
          unit: m.unit,
          ownerId: m.oldOwnerId === null ? null : memberIdMap.get(m.oldOwnerId)!,
          autoDeduct: m.autoDeduct,
          autoPaused: m.autoPaused,
          // 这两个值是 parse.ts 重设过的（导入当天 / 0），不是文件里的原值
          autoFrom: m.autoFrom,
          autoAccounted: m.autoAccounted,
          createdAt: m.createdAt,
        })
        .run();
      medicineIdMap.set(m.oldId, Number(res.lastInsertRowId));
    }

    // ── 批次 ──────────────────────────────────────────────────────
    const batchIdMap = new Map<number, number>();
    for (const b of data.batches) {
      const res = tx
        .insert(batches)
        .values({
          medicineId: medicineIdMap.get(b.oldMedicineId)!,
          ownerId: b.oldOwnerId === null ? null : memberIdMap.get(b.oldOwnerId)!,
          qty: b.qty,
          unit: b.unit,
          expiryDate: b.expiryDate,
          openedAt: b.openedAt,
          openLifeDays: b.openLifeDays,
          location: b.location,
          status: b.status,
          notes: b.notes,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        })
        .run();
      batchIdMap.set(b.oldId, Number(res.lastInsertRowId));
    }

    // ── 变动记录。🟢 坑 7：**不补造**「入库」记录去填那 38 条空时间线 ──
    // （§6.9：那条记录不是真实发生过的操作，伪造它等于污染账本）
    for (const e of data.events) {
      tx.insert(stockEvents)
        .values({
          batchId: batchIdMap.get(e.oldBatchId)!,
          type: e.type,
          deltaQty: e.deltaQty,
          qtyAfter: e.qtyAfter,
          reason: e.reason,
          createdAt: e.createdAt,
        })
        .run();
    }

    // ── 设置：只写两个阈值 + 一条导入溯源 ─────────────────────────
    tx.insert(settings)
      .values({ key: KEY_NEAR_EXPIRY_DAYS, value: String(data.settings.nearExpiryDays) })
      .run();
    tx.insert(settings)
      .values({ key: KEY_RESTOCK_DAYS, value: String(data.settings.restockDays) })
      .run();
    tx.insert(settings)
      .values({ key: KEY_LAST_IMPORT_AT, value: String(opts.importedAt) })
      .run();
    if (opts.sourceName) {
      tx.insert(settings)
        .values({ key: KEY_LAST_IMPORT_FILE, value: opts.sourceName })
        .run();
    }
  });

  return {
    members: data.members.length,
    medicines: data.medicines.length,
    batches: data.batches.length,
    events: data.events.length,
    totalQty: data.stats.totalQty,
    autoRestarted: data.autoRestarted,
    warnings: data.warnings,
    exportedAtRaw: data.exportedAtRaw,
  };
}

/** 库里有没有数据（决定首页是显示「空药箱」还是正常内容）。 */
export function hasAnyData(db: MedboxDb): boolean {
  const row = db.select({ id: medicines.id }).from(medicines).limit(1).get();
  return row !== undefined;
}

/** 读一个整数设置，带默认值兜底（对应网页版 `settings_store.get_int_setting`）。 */
export function getIntSetting(db: MedboxDb, key: string, fallback: number): number {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 读一个字符串设置。 */
export function getSetting(db: MedboxDb, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

/**
 * 写一个设置（有则改、无则建）。
 *
 * 写成**一条** `INSERT … ON CONFLICT DO UPDATE`，而不是「先 delete 再 insert」：
 * 后者两条语句之间进程被杀（手机上是常态 —— 切后台被回收、崩溃、OOM），
 * 结果是**这个键不见了**。而 `getIntSetting` 读不到就回默认值，所以表现是
 * 「用户把快过期改成 30 天，回来一看又变回 90 天」，且**没有任何报错**。
 * 一条语句天然原子，调用方也不必记得开事务。
 *
 * 位置说明：这里与两个 getter 同表同处。如果设置页将来长出别的功能，
 * 三个一起搬去 `src/data/settings.ts` 即可（那时是一次纯搬迁）。
 */
export function setSetting(db: MedboxDb, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
