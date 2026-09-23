/**
 * 导出端的核心验证：**自己导出的东西，自己导得回来**。
 *
 * 这是全项目唯一能自动证明「`version: 1` 双向兼容」（硬约束 5）的测试 ——
 * 前面 245 条测试都只覆盖了「导入端能读网页版的文件」，没有一个反过来问
 * 「我们写出去的文件，别人读不读得懂」。而那份文件是**永久退路**。
 *
 * 另有一组守卫，钉住硬约束 6：**导出路径绝不触发结算、绝不写库**。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { applyImport } from '../../src/importer/apply';
import { parseExport } from '../../src/importer/parse';
import { buildExport } from '../../src/exporter/build';
import { getNotifyPrefs, setNotifyPrefs } from '../../src/data/notify';
import { pauseMedicine, resumeMedicine } from '../../src/data/medicines';
import { discard, edit, markExpired, restock, take, usedUp } from '../../src/data/stock';
import type { MedboxDb } from '../../src/db/client';
import { batches, medicines, settings, stockEvents } from '../../src/db/schema';
import { BATCH_EXPIRED, BATCH_IN_STOCK, BATCH_USED_UP } from '../../src/domain/constants';
import { addBatch, addMedicine, freshDb, freshDbWithHandle, type SqliteHandle } from '../helpers';
import {
  FIXTURE_TEXT as fixtureText,
  IMPORT_DAY,
  LATER_DAY,
  NOW,
  importedDb,
} from './fixture';


/** 去掉注释后的源码 —— 给下面的结构性守卫用。 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（`[^:]` 是为了不误伤 https://）
}

describe('真往返：fixture → 落库 → 导出 → 再解析', () => {
  it('导出的文件能被导入端解析，且数字与 M1 验收一致', () => {
    const db = importedDb();
    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const again = parseExport(built.json, '2026-09-21');
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // ① 与 golden 完全一致的那五个数（M1 装机验收核过的）
    expect(again.data.stats).toEqual({
      members: 3,
      medicines: 37,
      batches: 44,
      events: 6,
      totalQty: 2118,
    });
  });

  it('警告数从 2 降到 1，少的那条正是 migrate_* —— 证明 settings 没多写', () => {
    const db = importedDb();

    const first = parseExport(fixtureText, IMPORT_DAY);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 源文件：一条「设置里有 2 项是网页版内部状态」+ 一条「38 条在库没有变动记录」
    expect(first.data.warnings).toHaveLength(2);

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const again = parseExport(built.json, '2026-09-21');
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // 我们只写两个阈值键，所以「网页版内部状态」那条不该再出现
    expect(again.data.warnings).toHaveLength(1);
    expect(again.data.warnings[0]).toContain('38 条在库没有变动记录');
    expect(again.data.warnings.some((w) => w.includes('网页版内部状态'))).toBe(false);
    // 键白名单严格对上的证据：没有任何「不认识的字段」
    expect(again.data.warnings.some((w) => w.includes('不认识的字段'))).toBe(false);
  });

  it('逐行相等：批次与药品的关键字段往返无损', () => {
    const db = importedDb();
    const built = buildExport(db, NOW);
    if (!built.ok) throw new Error('导出失败');
    const doc = JSON.parse(built.json) as {
      batches: Record<string, unknown>[];
      medicines: Record<string, unknown>[];
    };

    const dbBatches = db.select().from(batches).orderBy(batches.id).all();
    expect(doc.batches).toHaveLength(dbBatches.length);
    doc.batches.forEach((out, i) => {
      const src = dbBatches[i];
      expect(out.qty).toBe(src.qty);
      expect(out.unit).toBe(src.unit);
      expect(out.status).toBe(src.status);
      expect(out.medicine_id).toBe(src.medicineId);
      expect(out.owner_id).toBe(src.ownerId);
      expect(out.expiry_date).toBe(src.expiryDate);
      expect(out.opened_at).toBe(src.openedAt);
      expect(out.open_life_days).toBe(src.openLifeDays);
      expect(out.location).toBe(src.location);
    });

    const dbMeds = db.select().from(medicines).orderBy(medicines.id).all();
    doc.medicines.forEach((out, i) => {
      const src = dbMeds[i];
      expect(out.generic).toBe(src.generic);
      expect(out.daily_dose).toBe(src.dailyDose);
      expect(out.auto_deduct).toBe(src.autoDeduct);
      expect(out.auto_paused).toBe(src.autoPaused);
      expect(out.auto_from).toBe(src.autoFrom);
      expect(out.auto_accounted).toBe(src.autoAccounted);
    });
  });

  it('幂等：再往返一次后，除 exported_at 外逐字节相等', () => {
    const db1 = importedDb();
    const first = buildExport(db1, NOW);
    if (!first.ok) throw new Error('第一次导出失败');

    // ⚠️ 第二次解析必须用**同一个导入日**。导入端会把每个药的起算日重设成
    // 导入当天（`parse.ts:401`），换一天解析就不是在测幂等，而是在测那件事 ——
    // 见下面单独的那一条。
    const reparsed = parseExport(first.json, IMPORT_DAY);
    if (!reparsed.ok) throw new Error('导出结果解析失败');
    const db2 = freshDb();
    applyImport(db2, reparsed.data, { importedAt: NOW, sourceName: 'all.json' });
    const second = buildExport(db2, NOW);
    if (!second.ok) throw new Error('第二次导出失败');

    // exported_at 两次都是 NOW，所以其实也相等；仍然显式剔掉，
    // 让这条断言只表达「数据部分幂等」。
    const strip = (s: string) => {
      const o = JSON.parse(s) as Record<string, unknown>;
      delete o.exported_at;
      return o;
    };
    expect(strip(second.json)).toEqual(strip(first.json));
  });

  it('换一天再导入时，变的东西**只有**每个药的起算日（坑 1 / 决策 8）', () => {
    // 上一轮用同一个导入日来比幂等。这一条反过来回答「导入日不同，到底改了什么」——
    // 没有它，幂等测试可以靠「恰好没有时间依赖」蒙混过关。
    //
    // 注意变的是**全部 37 个药**，不只是 6 个自动扣减药：`parse.ts:401` 对每个药
    // 都无条件写 `autoFrom: importDay`（那 31 个不扣减的药，文件里这个字段是空的，
    // 重设等于把它填成导入日。对它们没有行为影响 —— 恒等于导入日，也就恒不参与计算）。
    const db1 = importedDb();
    const first = buildExport(db1, NOW);
    if (!first.ok) throw new Error('第一次导出失败');

    const later = parseExport(first.json, LATER_DAY);
    if (!later.ok) throw new Error('导出结果解析失败');
    const db2 = freshDb();
    applyImport(db2, later.data, { importedAt: NOW, sourceName: 'all.json' });
    const second = buildExport(db2, NOW);
    if (!second.ok) throw new Error('第二次导出失败');

    type Doc = { exported_at: string; medicines: Record<string, unknown>[] };
    const a = JSON.parse(first.json) as Doc;
    const b = JSON.parse(second.json) as Doc;

    // ① 起算日：37 个全变成新的导入日
    expect(a.medicines).toHaveLength(37);
    expect(a.medicines.every((m) => m.auto_from === IMPORT_DAY)).toBe(true);
    expect(b.medicines.every((m) => m.auto_from === LATER_DAY)).toBe(true);
    // 「已核算量归零」往返后仍是 0（本来就是 0，这条钉的是它没被写坏）
    expect(b.medicines.every((m) => m.auto_accounted === 0)).toBe(true);

    // ② 把起算日抹平之后，两份文件应当**逐字节相等** —— 批次、事件、成员、
    //    设置、以及药品的其余 14 个字段一个都没动。
    const blank = (o: Doc) => ({
      ...o,
      exported_at: '',
      medicines: o.medicines.map((m) => ({ ...m, auto_from: null })),
    });
    expect(blank(b)).toEqual(blank(a));
  });
});

describe('守卫（硬约束 6）：导出绝不写库、绝不结算', () => {
  it('导出前后 batches.qty 与 stock_events 行数都不变', () => {
    const db = importedDb();
    const before = db.select().from(batches).orderBy(batches.id).all().map((b) => b.qty);
    const eventsBefore = db.select().from(stockEvents).all().length;

    buildExport(db, NOW);

    const after = db.select().from(batches).orderBy(batches.id).all().map((b) => b.qty);
    expect(after).toEqual(before);
    expect(db.select().from(stockEvents).all()).toHaveLength(eventsBefore);
  });

  it('一个「今天本该扣」的药，导出后数量分毫不动', () => {
    // 比行数断言强得多：行数不变可以靠「写了个 no-op」通过，
    // qty 不变才真的证明没有结算跑过。
    const db = freshDb();
    const medId = addMedicine(db, NOW, {
      generic: '三高药',
      unit: '片',
      dailyDose: 1,
      autoDeduct: true,
      autoPaused: false,
      autoFrom: '2026-09-01', // 距 NOW 那天 20 天 → 真结算会扣 20
    });
    const batchId = addBatch(db, NOW, medId, 30);

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);

    const row = db.select().from(batches).all().find((b) => b.id === batchId);
    expect(row?.qty).toBe(30);
    expect(db.select().from(stockEvents).all()).toHaveLength(0);
  });

  it('导出不改 journal_mode，也不留下 -wal/-shm（硬约束 4 的可观测后果）', () => {
    // ⚠️ 必须用**磁盘库**：SQLite 的内存库永远报告 `journal_mode = memory`，
    // 也设不成 delete —— 在内存库上跑这条，无论导出端做什么都「通过」，
    // 等于没测。「关 WAL」这个承诺只有磁盘上的 `-wal`/`-shm` 才看得见。
    const dir = mkdtempSync(join(tmpdir(), 'medbox-export-'));
    let handle: { sqlite: SqliteHandle } | null = null;
    try {
      handle = freshDbWithHandle(join(dir, 'medbox.db'));
      const { db, sqlite } = handle;
      // 与 src/db/client.ts 里 App 建库时同一句
      sqlite.pragma('journal_mode = DELETE');
      const before = sqlite.pragma('journal_mode', { simple: true });
      expect(String(before).toLowerCase()).toBe('delete');

      const built = buildExport(db, NOW);
      expect(built.ok).toBe(true);

      expect(sqlite.pragma('journal_mode', { simple: true })).toBe(before);
      // 「备份 = 一个文件」端到端：导出之后目录里仍然只有那一个库文件
      expect(readdirSync(dir)).toEqual(['medbox.db']);
    } finally {
      // Windows 上文件句柄没关就删目录会 EPERM，先关
      handle?.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('结构性守卫：src/exporter/* 里唯一的 db 动词是 select', () => {
    // 静态检查比行为守卫更早拦住「未来有人好心加一句 settleAll(db, today)」——
    // 那种改动可能因为库里恰好没什么可扣而骗过行为守卫，但会让这条当场红。
    //
    // ⚠️ 两条踩过的坑：
    // 1. 断言必须打在**去掉注释的源码**上。第一版直接扫原文，被 `build.ts`
    //    文件头那句「不调 `settleAll`、不写库」自己绊倒了 —— 守卫要抓的是**代码**，
    //    不是散文。
    // 2. 动词正则要允许 `db` 与 `.` 之间换行（`/\bdb\s*\./`）。项目里多行写法
    //    （`db\n  .select()`）是主流，写成 `/\bdb\./` 会漏掉它们 —— 第一版在
    //    `build.ts` 的 5 处查询里只抓到 2 处，守卫看着是绿的，其实是漏的。
    const ROOT = join(__dirname, '..', '..');
    const verbs = new Set<string>();
    for (const f of ['build.ts', 'report.ts']) {
      const src = codeOnly(readFileSync(join(ROOT, 'src', 'exporter', f), 'utf8'));
      for (const m of src.matchAll(/\bdb\s*\.\s*(\w+)/g)) verbs.add(m[1]);
      expect(src).not.toMatch(/settleAll/);
      expect(src).not.toMatch(/\breload\s*\(/);
      expect(src).not.toMatch(/\.transaction\s*\(/);
    }
    // 允许「一个查询都没有」（report.ts 全走 `src/data/queries.ts` 里的现成函数，
    // 它自己不碰句柄）—— 那是更安全的方向，不该判红。
    expect([...verbs].filter((v) => v !== 'select')).toEqual([]);
    // 但两个文件加起来必须至少有一次真的读到了库，否则这整个守卫是空转的
    expect(verbs.has('select')).toBe(true);
  });
});

describe('导出端的边界', () => {
  it('空库也能导出，且自检通过、没有警告', () => {
    const db = freshDb();
    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.stats).toEqual({
      members: 0,
      medicines: 0,
      batches: 0,
      events: 0,
      totalQty: 0,
    });
    expect(built.warnings).toEqual([]);
  });

  it('取空一盒（in_stock + qty 0）被归一化成 used_up，并留下一条提示', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '取空药', unit: '片' });
    const batchId = addBatch(db, NOW, medId, 0); // 默认就是 in_stock

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const doc = JSON.parse(built.json) as { batches: { id: number; status: string; qty: number }[] };
    const out = doc.batches.find((b) => b.id === batchId);
    expect(out?.status).toBe('used_up');
    expect(out?.qty).toBe(0);
    expect(built.notices).toHaveLength(1);
    expect(built.notices[0].generic).toBe('取空药');
    expect(built.notices[0].batchId).toBe(batchId);
  });

  it('used_up 但数量不为 0 → 拒绝导出，文案指出怎么修', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '坏状态药', unit: '片' });
    addBatch(db, NOW, medId, 5, { status: 'used_up' });

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(' ')).toContain('坏状态药');
    expect(built.errors.join(' ')).toContain('把数量改回 0');
    expect(built.reason).toBe('preflight'); // 界面据此指路「去哪改」，不是「数据坏了」
  });

  it('药品单位为空 → 拒绝导出，文案点名药并指向编辑界面', () => {
    const db = freshDb();
    addMedicine(db, NOW, { generic: '没单位药', unit: null });

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(' ')).toContain('没单位药');
    expect(built.errors.join(' ')).toContain('编辑');
    expect(built.reason).toBe('preflight');
  });

  it('open_life_days 为 0 → 拒绝导出（planEdit 漏了这个校验）', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '开封药', unit: '片' });
    addBatch(db, NOW, medId, 5, { openLifeDays: 0, openedAt: '2026-09-01' });

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(' ')).toContain('开封后有效期');
    expect(built.reason).toBe('preflight');
  });

  it('settings 只写两个阈值键 —— 库里塞了别的键也不泄漏', () => {
    const db = freshDb();
    db.insert(settings)
      .values([
        { key: 'last_import_at', value: '1789956290628' },
        { key: 'last_import_file', value: 'all.json' },
        { key: 'migrate_auto_deduct_v1', value: '1' },
      ])
      .run();

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const doc = JSON.parse(built.json) as { settings: Record<string, string> };
    expect(Object.keys(doc.settings).sort()).toEqual(['near_expiry_days', 'restock_days']);
    expect(doc.settings.near_expiry_days).toBe('90');
    expect(doc.settings.restock_days).toBe('15');
  });

  it('总库存在库合计 = in_stock 的 qty 之和（导出与库一致）', () => {
    const db = importedDb();
    const built = buildExport(db, NOW);
    if (!built.ok) throw new Error('导出失败');
    const fromDb = db
      .select()
      .from(batches)
      .all()
      .filter((b) => b.status === BATCH_IN_STOCK)
      .reduce((s, b) => s + b.qty, 0);
    expect(built.stats.totalQty).toBe(fromDb);
    expect(fromDb).toBe(2118);
  });
});

/**
 * 阶段 5 第 7 项（「自检不挡路」）的**本地替身**。
 *
 * ── 为什么用测试替掉真机那一步 ──────────────────────────────────────────
 * 计划里那一项要求把「取用 / 用完 / 丢弃 / 标记过期 / 恢复在库 / 编辑 / 暂停恢复」
 * 在手机上各走一遍、每步导一次。但那要反复改**用户家里真实的库存**（还得一条条改回去），
 * 而它真正要问的问题只有一个：
 *
 *   **这些操作留下的状态，运行时自检会不会把导出挡住？**
 *
 * 这个问题在真库上问一遍就够，而且能问得比手点全（每支都从干净数据重来、
 * 边界值可以直接构造）。真机上只验「能不能点到、文案对不对」这类**界面**属性。
 *
 * 三件事这里都断言了：① 导出必须成功；② 不该归一化的别乱归一化
 * （`notices` 为空）；③ 该拒绝的，得是**领域层**先拒绝、根本走不到导出端。
 */
describe('阶段 5 第 7 项的本地替身：八种界面操作之后，自检都不挡路', () => {
  /** 与真机同一天。取 09-22 而不是导入当天，是为了让账本那条路的天数不为 0。 */
  const DAY = '2026-09-22';

  /**
   * 本组专用的时刻 —— **必须晚于导入日**，不能借上面那个共用的 `NOW`。
   *
   * 共用的 `NOW` 是 `2026-09-10`，比 `LATER_DAY`（导入日 09-21）**还早**。
   * 用它写出来的事件，`created_at` 会比文件里带进来的事件更小，于是
   * `parse.ts` 挑「最后一条事件」时会挑到文件那条 —— 断言就会以一个
   * 与本题无关的方式失败。真机上的时间永远晚于导入日，所以这里也照真机取。
   */
  const NOW2 = Date.UTC(2026, 8, 22, 2, 0, 0); // 2026-09-22 10:00 本地

  /** 一台「刚导入过」的机器，外加几个找盒子的工具。 */
  function stage() {
    const db = importedDb(LATER_DAY);
    const all = db.select().from(batches).all();
    const meds = new Map(db.select().from(medicines).all().map((m) => [m.id, m]));

    /**
     * 挑一盒**不参与自动扣减**的盒。
     *
     * 不是为了躲开账本 —— 而是为了让「这个操作本身有没有把库弄成非法状态」
     * 这个问题不被结算顺带扣几片搅浑。账本那条路由最后两支单独覆盖。
     */
    function plainBox(minQty = 1) {
      const b = all.find(
        (x) => x.status === BATCH_IN_STOCK && x.qty >= minQty && !meds.get(x.medicineId)!.autoDeduct,
      );
      if (!b) throw new Error(`fixture 里找不到数量 ≥ ${minQty} 的非自动扣减在库盒`);
      return b;
    }

    /** 第一个开了自动扣减的药（真机上是外公的三高药之一）。 */
    function autoMedicine() {
      const m = [...meds.values()].find((x) => x.autoDeduct);
      if (!m) throw new Error('fixture 里没有自动扣减的药');
      return m;
    }

    return { db, all, meds, plainBox, autoMedicine };
  }

  /** 导出必须成功。失败时把自检原文抛出来 —— 只看到 `ok: false` 没法查。 */
  function mustExport(db: MedboxDb) {
    const built = buildExport(db, NOW2);
    if (!built.ok) throw new Error(`导出被挡住了：${built.errors.join(' / ')}`);
    return built;
  }

  it('取用（还剩）→ 通过，且不该归一化', () => {
    const { db, plainBox } = stage();
    const box = plainBox(2);
    expect(take(db, box.id, '1', '', DAY, NOW2).ok).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('取用（把一盒取空）→ 通过，且**不需要**归一化（领域层直接转成「已用完」）', () => {
    // 🔴 §9 第 11 项 2026-09-23 修的。**这条用例以前是反过来的** ——
    // 它断言「恰好一条归一化提示点名那一盒」，也就是把 bug 的症状当成了规格：
    // `planTake` 当时只减数量、不动状态，于是「在库 + 0」这种**不变量 4 明确拒绝**的行
    // 由 App 自己的日常操作造出来，只能靠导出端的归一化兜着。
    // 现在取空即转 `used_up`，这条路径上归一化成了死代码 —— 但**它必须留着**，
    // 存量数据仍需要它（下一个用例）。
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(take(db, box.id, String(box.qty), '', DAY, NOW2).ok).toBe(true);

    expect(mustExport(db).notices).toEqual([]);
    // 库里也真的转了状态，不只是导出时看着对
    const row = db.select().from(batches).all().find((b) => b.id === box.id);
    expect(row?.status).toBe(BATCH_USED_UP);
    expect(row?.qty).toBe(0);
  });

  it('用完 → 通过，且不该归一化（数量已归 0，状态本就合法）', () => {
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(usedUp(db, box.id, DAY, NOW2).ok).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('丢弃 → 通过，且不该归一化', () => {
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(discard(db, box.id, '潮了', DAY, NOW2).ok).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('标记过期 → 通过，且数量原样保留（§2.4：药还在，只是不能吃）', () => {
    const { db, all, plainBox } = stage();
    const box = plainBox(1);
    expect(markExpired(db, box.id, DAY, NOW2).ok).toBe(true);

    const built = mustExport(db);
    expect(built.notices).toEqual([]);

    const out = (JSON.parse(built.json) as { batches: { id: number; status: string; qty: number }[] })
      .batches.find((b) => b.id === box.id);
    expect(out?.status).toBe(BATCH_EXPIRED);
    expect(out?.qty).toBe(box.qty);
    expect(all.length).toBe(44); // 只是状态变了，没多没少
  });

  it('恢复在库（标记过期之后）→ 通过，且回到 in_stock', () => {
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(markExpired(db, box.id, DAY, NOW2).ok).toBe(true);
    expect(restock(db, box.id, DAY, NOW2).ok).toBe(true);

    const built = mustExport(db);
    expect(built.notices).toEqual([]);
    const out = (JSON.parse(built.json) as { batches: { id: number; status: string }[] }).batches.find(
      (b) => b.id === box.id,
    );
    expect(out?.status).toBe(BATCH_IN_STOCK);
  });

  it('编辑数量 → 通过，且不该归一化', () => {
    const { db, plainBox } = stage();
    const box = plainBox(2);
    expect(
      edit(
        db,
        box.id,
        {
          qty: '2', // 1 → 2. 刻意不给 0：改成 0 是下一条的事
          expiryDate: box.expiryDate ?? '',
          openedAt: box.openedAt ?? '',
          openLifeDays: box.openLifeDays === null ? '' : String(box.openLifeDays),
          location: box.location ?? '',
          notes: box.notes ?? '',
          unit: box.unit,
          ownerId: box.ownerId === null ? '' : String(box.ownerId),
        },
        DAY,
        NOW,
      ).ok,
    ).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('编辑数量改到 0 → 通过，状态被**领域层**自己转成 used_up（不用导出端兜）', () => {
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(
      edit(
        db,
        box.id,
        {
          qty: '0',
          expiryDate: box.expiryDate ?? '',
          openedAt: box.openedAt ?? '',
          openLifeDays: box.openLifeDays === null ? '' : String(box.openLifeDays),
          location: box.location ?? '',
          notes: box.notes ?? '',
          unit: box.unit,
          ownerId: box.ownerId === null ? '' : String(box.ownerId),
        },
        DAY,
        NOW,
      ).ok,
    ).toBe(true);

    // 关键：库里就**不是**「在库 + 0」了，所以归一化那支不会被触发
    expect(
      db.select().from(batches).all().find((b) => b.id === box.id)?.status,
    ).toBe(BATCH_USED_UP);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('暂停服药 → 通过（账本被结算过一轮也照样能导出）', () => {
    const { db, autoMedicine } = stage();
    const med = autoMedicine();
    expect(pauseMedicine(db, med.id, DAY, NOW2).ok).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('恢复服药 → 通过', () => {
    const { db, autoMedicine } = stage();
    const med = autoMedicine();
    expect(pauseMedicine(db, med.id, DAY, NOW2).ok).toBe(true);
    expect(resumeMedicine(db, med.id, DAY, NOW2).ok).toBe(true);
    expect(mustExport(db).notices).toEqual([]);
  });

  it('用完 / 丢弃之后再「恢复在库」→ **领域层**先拒绝，永远走不到导出端的拒绝分支', () => {
    // 这条是设计上最该解释的一处：导出端有一条「used_up/discarded 而数量不为 0
    // → 拒绝整份文件」的硬规则，但正常路径**产生不出**那种状态 —— 因为
    // planRestock 自己拦住了（qty 0 恢复回在库就是「在库 + 0」，违反不变量 4）。
    // 于是那条拒绝规则只会被**存量/手改过的库**触发，不是日常操作。
    const { db, plainBox } = stage();
    const box = plainBox(1);
    expect(usedUp(db, box.id, DAY, NOW2).ok).toBe(true);

    const res = restock(db, box.id, DAY, NOW2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors._).toContain('编辑');
    expect(res.errors._).toContain('大于 0');
  });

  it('真机 item 5 那个状态（存量数据）：库里留着「在库 + 0」，导出**归一化而不是拒绝**', () => {
    // 2026-09-22 在真机上见过这个状态（阿奇霉素 · 第 #34 盒）：取空之后
    // 库里的 status 仍是 in_stock，界面照样显示「0 袋 · 正常」。
    //
    // ⚠️ 2026-09-23 起，这个状态**日常操作已经造不出来了**（`planTake` 取空即转
    // `used_up`，见上一个用例）。但归一化**必须保留**，两条理由：
    //   ① 存量数据里可能已经有了 —— 改了 `planTake` 也**去不掉库里已经存在的行**
    //      （账本只增，硬约束 2），所以导出端是这些行的唯一出路；
    //   ② 手改过 / 别的工具写过的库同样会带进来。
    // 所以这里**直接写库、绕过领域层** —— 那才是存量数据真正的样子。
    const { db, plainBox } = stage();
    const box = plainBox(1);
    db.update(batches).set({ qty: 0, status: BATCH_IN_STOCK }).where(eq(batches.id, box.id)).run();

    const built = mustExport(db);
    expect(built.notices).toHaveLength(1);
    expect(built.notices[0].batchId).toBe(box.id);

    // 导出只看不写（硬约束 6）：库里那行还是原样
    const row = db.select().from(batches).all().find((b) => b.id === box.id);
    expect(row?.status).toBe(BATCH_IN_STOCK);
    expect(row?.qty).toBe(0);
  });
});

describe('提醒偏好是本机偏好：导入不丢、导出不带（M5）', () => {
  it('🔴 导入之后提醒偏好还在 —— `delete(settings)` 不能顺手带走它', () => {
    // 不加这条守卫，失败的样子是这样的：用户开着提醒用了几个月，导入一次备份，
    // 提醒就悄悄没了 —— 而且要等到「该推的那天没推」才会发现。
    // 阈值不一样：那是文件里带来的合法值，本来就该被覆盖。
    const db = importedDb(LATER_DAY);
    setNotifyPrefs(db, { enabled: false, hour: 7, minute: 30 });

    const parsed = parseExport(fixtureText, LATER_DAY);
    if (!parsed.ok) throw new Error('fixture 解析失败');
    applyImport(db, parsed.data, { importedAt: NOW, sourceName: 'all.json' });

    expect(getNotifyPrefs(db)).toEqual({ enabled: false, hour: 7, minute: 30 });
  });

  it('从来没有设过提醒偏好时，导入不凭空造出这两个键', () => {
    // 「保留」不是「补默认值」：往库里写一个用户没设过的值，
    // 会让「这个键存在」不再等于「用户动过它」。
    const db = importedDb(LATER_DAY);
    const keys = db.select().from(settings).all().map((r) => r.key);
    expect(keys).not.toContain('notify_enabled');
    expect(keys).not.toContain('notify_time');
  });

  it('🔴 导出的文件里没有通知键 —— 它是本机偏好，不是数据', () => {
    // 进了 all.json 就变成「别人的偏好覆盖我的」：换台手机导入一份备份，
    // 自己的提醒时间被对方的覆盖掉，而且没有任何提示。
    const db = importedDb();
    setNotifyPrefs(db, { enabled: true, hour: 21, minute: 5 });

    const built = buildExport(db, NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const doc = JSON.parse(built.json) as { settings: Record<string, string> };
    expect(Object.keys(doc.settings).sort()).toEqual(['near_expiry_days', 'restock_days']);
    expect(JSON.stringify(doc.settings)).not.toContain('notify');
    // 非空转断言：确认上面那句话不是在比一个空对象
    expect(doc.settings.near_expiry_days).toBe('90');
  });

  it('保留的是值本身，不是「格式正确的值」—— 坏值原样留着，读的时候回默认', () => {
    // 刻意不做「导入时顺手清洗」：清洗会把用户数据变成我们的猜测。
    // 读出坏的值的兜底在 `getNotifyPrefs` 里（回 09:00，且绝不抛）。
    const db = importedDb(LATER_DAY);
    db.insert(settings).values({ key: 'notify_time', value: '乱写的' }).run();

    const parsed = parseExport(fixtureText, LATER_DAY);
    if (!parsed.ok) throw new Error('fixture 解析失败');
    applyImport(db, parsed.data, { importedAt: NOW, sourceName: 'all.json' });

    expect(db.select().from(settings).all().find((r) => r.key === 'notify_time')?.value).toBe('乱写的');
    expect(getNotifyPrefs(db)).toEqual({ enabled: true, hour: 9, minute: 0 });
  });
});
