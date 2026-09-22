/**
 * 测试搭台工具 —— **只放「怎么把库建起来」，不放任何断言**。
 * 断言留在各自的测试文件里，否则单看一个文件不知道自己到底验了什么。
 *
 * ── 为什么要连真库，而不是造几个对象了事 ───────────────────────────────
 * `src/domain/` 是纯函数，喂对象就行。但 `src/data/` 那层是 SQL 往返：
 * 外键有没有开、NOT NULL 漏没漏、插入后的自增 id 拿不拿得到，
 * 都只有真库能回答。所以这里建的是**真 SQLite**，跑的是
 * `drizzle/*.sql`（与 App 上跑的**同一份**迁移文件）。
 *
 * ── 为什么是 better-sqlite3 而不是 expo-sqlite ─────────────────────────
 * expo-sqlite 只能在设备/模拟器里跑。better-sqlite3 的决定性优点是**同步 API**，
 * 与 expo-sqlite 形状一致：`db.transaction((tx) => { tx.insert(...).run() })`。
 * `drizzle-orm/sqlite-proxy` 那条路人尽皆知地走不通 —— 它是异步的，
 * 而 `applyPlan` 依赖同步事务。
 *
 * `drizzle-orm/expo-sqlite` 与 `drizzle-orm/better-sqlite3` 的实例
 * 运行时形状相同、类型不同，所以在边界上做一次 cast —— 代价换取
 * 「落库层不再是无测试的代码」。没测到的只剩 expo-sqlite 自身的行为。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MedboxDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { batches, medicines } from '../src/db/schema';
import { BATCH_IN_STOCK } from '../src/domain/constants';

const DRIZZLE_DIR = join(__dirname, '..', 'drizzle');

/**
 * 建一个内存库，跑**与 App 同一份**迁移 SQL。
 *
 * 直接用 `drizzle/*.sql` 而不是 `drizzle-kit push`：这样 schema 改错、
 * 迁移文件没重新生成，测试会立刻挂 —— 相当于顺手校验了两者一致。
 */
export function freshDb(): MedboxDb {
  return freshDbWithHandle().db;
}

/**
 * 同 `freshDb`，但把 better-sqlite3 的原始 handle 一并交出来。
 *
 * 只有需要绕过 drizzle、直接问 SQLite 本身的时候才用它 ——
 * 目前唯一的用处是导出端的守卫测试要读 `PRAGMA journal_mode`
 * （`test/exporter/roundtrip.test.ts`）。
 *
 * `file` 给出时建的是**磁盘库**而不是内存库。这一项是必需的、不是便利：
 * SQLite 的**内存库永远报告 `journal_mode = memory`**，也设不成 `delete` ——
 * 在内存库上断言 journal_mode，无论被测代码做什么都会「通过」（或永远失败）。
 * 「关 WAL」这个承诺只有磁盘库上的 `-wal`/`-shm` 才看得见。
 */
export function freshDbWithHandle(file?: string): { db: MedboxDb; sqlite: SqliteHandle } {
  const sqlite = new Database(file ?? ':memory:');
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) sqlite.exec(readFileSync(join(DRIZZLE_DIR, f), 'utf8'));
  // 外键默认是关的。App 里开（client.ts），这里也要开 ——
  // 否则「事件指向不存在的批次」这类错误在测试里看不见
  sqlite.pragma('foreign_keys = ON');
  return { db: drizzle(sqlite, { schema }) as unknown as MedboxDb, sqlite };
}

/** better-sqlite3 的实例类型 —— 只为了上面那个返回值不要写成 `any`。 */
export type SqliteHandle = InstanceType<typeof Database>;

/**
 * 造数据用：取刚插入那一行的自增 id。
 *
 * ⚠️ drizzle 的**两个驱动返回的键名不一样**：expo-sqlite 是 `lastInsertRowId`
 * （大写 D，App 上跑的是这个），better-sqlite3 是 `lastInsertRowid`（小写 d）。
 *
 * 测试里**另写一份**、而不是 import `src/data/stock.ts` 里那个 `insertedId` ——
 * 这是刻意的：如果两边共用同一个函数，就只能证明「它和自己一致」，
 * 证明不了落库层自己处理了驱动差异。保持两份独立的实现，
 * 把 `applyPlan` 里的兼容去掉，入库测试会立刻以
 * `NOT NULL constraint failed` 挂掉。
 */
export function insertId(res: {
  lastInsertRowId?: number | bigint;
  lastInsertRowid?: number | bigint;
}): number {
  const v = res.lastInsertRowId ?? res.lastInsertRowid;
  if (v === undefined) throw new Error('拿不到自增 id —— 驱动返回的键名又变了');
  return Number(v);
}

/**
 * 插一个药品档案，返回它的 id。
 *
 * `now` 显式传而不是取默认值：一批测试里所有行的时间戳应当一致，
 * 各文件用自己的基准时刻，排序断言才不会被「差几毫秒」搅乱。
 */
export function addMedicine(
  db: MedboxDb,
  now: number,
  over: Partial<typeof medicines.$inferInsert> = {},
): number {
  return insertId(
    db
      .insert(medicines)
      .values({ generic: '测试药', unit: '片', createdAt: now, ...over })
      .run(),
  );
}

/** 插一个在库批次，返回它的 id。 */
export function addBatch(
  db: MedboxDb,
  now: number,
  medicineId: number,
  qty: number,
  over: Partial<typeof batches.$inferInsert> = {},
): number {
  return insertId(
    db
      .insert(batches)
      .values({
        medicineId,
        qty,
        unit: '片',
        status: BATCH_IN_STOCK,
        createdAt: now,
        updatedAt: now,
        ...over,
      })
      .run(),
  );
}
