/**
 * 数据库打开与迁移 —— 硬约束 4 的落点。
 *
 * ── 为什么必须显式关掉 WAL ─────────────────────────────────────────────
 * 产品的核心承诺之一是「**备份 = 一个文件**」。WAL 模式下 SQLite 会把最近的
 * 改动写在同目录的 `-wal` 和 `-shm` 两个附属文件里，只拷 `medbox.db` 会丢掉
 * 最近的改动（甚至拷出一个损坏的库）。网页版正是为了这条**刻意不开** WAL。
 *
 * 麻烦之处在于：expo-sqlite 的官方文档**推荐**开 WAL（性能更好），所以
 * 「什么都不做」拿到的很可能就是 WAL。这里必须显式设成 DELETE，
 * 而且设完要**读回来核对** —— 设置失败却默默继续，等于承诺悄悄失效。
 *
 * 注：`journal_mode` 是写进数据库文件头的**持久属性**，设一次就长期生效。
 * 但每次启动都设一遍成本极低，而且能挡住「文件是从别处拷来的 WAL 库」这种
 * 情况，所以不省这一步。
 */
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as SQLite from 'expo-sqlite';

import migrations from '../../drizzle/migrations';
import * as schema from './schema';

export const DB_NAME = 'medbox.db';

export type MedboxDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 能执行 insert / update / delete 的最小接口。
 *
 * 数据库句柄（`MedboxDb`）与**事务句柄**（`db.transaction((tx) => …)` 里的 `tx`）
 * 都满足它 —— 这是刻意的：`Pick` 正好把 `transaction` 排除在外，于是拿到
 * `Executor` 的代码**写不出** `exec.transaction(...)`。
 *
 * ── 为什么非要挡住 ─────────────────────────────────────────────────────
 * 两个驱动对「事务里再开事务」的行为**不一样**：better-sqlite3 的
 * `db.transaction()` 内部降级成 SAVEPOINT，嵌套静默成功；expo-sqlite 走的是
 * 裸 `begin`/`commit`，第二个 BEGIN 直接抛
 * `cannot start a transaction within a transaction`。
 *
 * 也就是说「外层开事务、里面再调一个自己开事务的函数」这种写法
 * **本地测试全绿、装到手机上必炸**。类型上挡掉比注释里提醒可靠。
 */
export type Executor = Pick<MedboxDb, 'insert' | 'update' | 'delete'>;

export type DbHandle = {
  sqlite: SQLite.SQLiteDatabase;
  db: MedboxDb;
  /** 关 WAL 的核对结果，供「设置」页的诊断信息展示 */
  journalMode: string;
};

/** 单文件备份的附属文件：出现它们就说明 WAL 没关掉 */
const WAL_SIDECARS = ['-wal', '-shm'];

/**
 * 打开数据库、关掉 WAL、跑迁移。
 *
 * 顺序很重要：**先关 WAL 再跑迁移**。反过来的话迁移会在 WAL 模式下执行，
 * 留下一对附属文件（虽然内容最终会合并回主文件，但那段窗口里
 * 「备份 = 一个文件」是不成立的）。
 */
export async function openMedboxDatabase(): Promise<DbHandle> {
  const sqlite = await SQLite.openDatabaseAsync(DB_NAME);

  // 硬约束 4：关掉 WAL。返回的字符串是生效后的模式。
  await sqlite.execAsync('PRAGMA journal_mode = DELETE');
  const journalMode = await readJournalMode(sqlite);

  // 外键约束默认是**关**的，必须显式打开，否则 schema 里的 references 只是注释。
  await sqlite.execAsync('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // 迁移是幂等的：drizzle 在库里记账，已经跑过的不会重跑。
  await migrate(db, migrations);

  return { sqlite, db, journalMode };
}

/** 读回当前的 journal_mode，用于核对关 WAL 是否真的生效。 */
export async function readJournalMode(sqlite: SQLite.SQLiteDatabase): Promise<string> {
  const row = await sqlite.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
  return (row?.journal_mode ?? 'unknown').toLowerCase();
}

/**
 * WAL 是否真的关掉了。false 表示「备份 = 一个文件」这条承诺**已经失效**，
 * 应当在界面上明确告警，而不是假装没事。
 */
export function isWalDisabled(journalMode: string): boolean {
  return journalMode !== 'wal';
}

/**
 * 附属文件后缀（`-wal` / `-shm`），供**整库拷文件**式的备份检查用。
 *
 * ⚠️ M6 的导出**不用它**：那条路是「查询 → 生成 JSON」，产出的是一份新文件，
 * 跟 `medbox.db` 旁边有没有 `-wal` 无关 —— 真去 stat 等于去检查别人的文件。
 * 留在这里是给「把 medbox.db 当文件拷走」那种备份方式用的。
 * 硬约束 6（导出路径绝不写库）由 `test/exporter/roundtrip.test.ts` 的静态守卫钉住，比 stat 附属文件强。
 */
export const WAL_SUFFIXES = WAL_SIDECARS;
