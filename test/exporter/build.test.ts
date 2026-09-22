/**
 * 导出**格式**的规格测试 —— 硬约束 5 的静态那一半。
 *
 * `roundtrip.test.ts` 证明的是「导出去还能导回来」这个**行为**；
 * 这个文件钉的是**形状**：顶层有哪几个键、每一行有哪几个键（顺序在内）、
 * 时间戳是什么口径、真布尔还是 0/1。两者分工明确 ——
 * 形状错了往返测试**不一定**红（比如多写一个键，导入端只会多一条警告，
 * 不会报错），但那是「永久退路」上的裂缝，得单独盯。
 *
 * 数据用 `test/fixtures/all.json` 落库后的真库：空库测不出「字段掉了键」，
 * 因为空表根本没有行可查。
 */
import { batches, medicines, members, settings, stockEvents } from '../../src/db/schema';
import { toLocalNaiveString, toNaiveUtcString, parseInstant } from '../../src/domain/instant';
import { buildExport, EXPORT_FILE_NAME } from '../../src/exporter/build';
import { addBatch, addMedicine, freshDb } from '../helpers';
import {
  BATCH_KEYS,
  EVENT_KEYS,
  MEDICINE_KEYS,
  MEMBER_KEYS,
} from '../../src/importer/parse';
import { NOW, importedDb } from './fixture';

/** 无 Z、无毫秒的 naive 时间戳 —— `'2026-09-16T05:23:53'`。 */
const ISO_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const built = () => {
  const r = buildExport(importedDb(), NOW);
  if (!r.ok) throw new Error(`导出应当成功，却报了：${r.errors.join(' / ')}`);
  return r;
};

/** 导出结果里的一行，按表名取。 */
function rowsOf(json: string, table: string): Record<string, unknown>[] {
  return (JSON.parse(json) as Record<string, Record<string, unknown>[]>)[table];
}

describe('顶层结构', () => {
  it('恰好七个键，顺序与网页版 export.py 一致，且**没有 stats**', () => {
    const { json } = built();
    const doc = JSON.parse(json) as Record<string, unknown>;
    // 顺序也断言：两份文件能逐行 diff 是免费的调试资产（网页版也是这个顺序）
    expect(Object.keys(doc)).toEqual([
      'version',
      'exported_at',
      'settings',
      'members',
      'medicines',
      'batches',
      'stock_events',
    ]);
    // `stats` 是**解析时算的**，不是文件格式的一部分。写进去 = 多一个键 = 将来多一条警告
    expect(doc.stats).toBeUndefined();
  });

  it('version 是数字 1，不是字符串 "1"', () => {
    const { json } = built();
    const doc = JSON.parse(json) as { version: unknown };
    expect(doc.version).toBe(1);
    expect(typeof doc.version).toBe('number');
  });

  it('空库也成立：四张表是空数组，settings 仍有那两个键', () => {
    const r = buildExport(freshDb(), NOW);
    if (!r.ok) throw new Error('空库应当能导出');
    const doc = JSON.parse(r.json) as Record<string, unknown>;
    expect(Object.keys(doc)).toHaveLength(7);
    expect(doc.members).toEqual([]);
    expect(doc.medicines).toEqual([]);
    expect(doc.batches).toEqual([]);
    expect(doc.stock_events).toEqual([]);
    // 阈值是**设置**，不是数据 —— 空库里也该带出去，否则导回来阈值就没了
    expect(doc.settings).toEqual({ near_expiry_days: '90', restock_days: '15' });
  });

  it('文件名是 ASCII 的 all.json —— 用户认得它，网页版也叫这个', () => {
    expect(built().fileName).toBe(EXPORT_FILE_NAME);
    expect(EXPORT_FILE_NAME).toBe('all.json');
  });
});

describe('每一行的键与顺序都严格等于导入端的白名单', () => {
  // 键多一个 → 将来导入时多一条「不认识的字段」警告
  // 键少一个 → 那个字段静默丢失（比多一个严重得多）
  // 顺序也要比：白名单的顺序就是网页版的顺序，diff 起来才有意义
  const cases: [string, readonly string[]][] = [
    ['members', MEMBER_KEYS],
    ['medicines', MEDICINE_KEYS],
    ['batches', BATCH_KEYS],
    ['stock_events', EVENT_KEYS],
  ];

  it.each(cases)('%s', (table, keys) => {
    const rows = rowsOf(built().json, table);
    expect(rows.length).toBeGreaterThan(0); // 空表比不出东西
    for (const r of rows) expect(Object.keys(r)).toEqual([...keys]);
  });

  it('真实数据里每个可空字段都**显式写 null**，不是掉键', () => {
    // `JSON.stringify` 会把 `undefined` 整个键丢掉 —— 而 `?.` / `??` 少写一个
    // 就会造出 undefined。这条断言用真数据兜住它：13 条没效期的批次必须
    // 出现 `"expiry_date": null`，而不是键不见了。
    const rows = rowsOf(built().json, 'batches');
    const noExpiry = rows.filter((r) => r.expiry_date === null);
    expect(noExpiry.length).toBe(13); // 与 golden 的「未填效期 13」一致
    for (const r of noExpiry) expect('expiry_date' in r).toBe(true);
  });
});

describe('时间戳口径（§6.2 那颗雷）', () => {
  it('所有时间戳都是无 Z 无毫秒的 naive 串', () => {
    // 有 Z 或毫秒 = 导回网页版时会被当成另一种格式
    expect(ISO_NAIVE.test('2026-09-16T05:23:53')).toBe(true);
    const doc = JSON.parse(built().json) as Record<string, unknown>;
    const stamps: string[] = [];
    for (const table of ['members', 'medicines', 'batches', 'stock_events']) {
      for (const r of doc[table] as Record<string, unknown>[]) {
        for (const [k, v] of Object.entries(r)) {
          if (k === 'created_at' || k === 'updated_at') stamps.push(v as string);
        }
      }
    }
    expect(stamps.length).toBeGreaterThan(50);
    for (const s of stamps) expect(s).toMatch(ISO_NAIVE);
  });

  it('created_at 写 UTC、exported_at 写**本地** —— 两者口径相反且都刻意', () => {
    const json = built().json;
    const doc = JSON.parse(json) as { exported_at: string; members: { created_at: string }[] };

    expect(doc.exported_at).toBe(toLocalNaiveString(NOW));
    // 真库里第一个成员的时间戳，就该是 UTC 那一版
    const first = importedDb().select().from(members).orderBy(members.id).all()[0];
    expect(doc.members[0].created_at).toBe(toNaiveUtcString(first.createdAt));

    // 这台机器在 UTC+8：两个口径**必须**呈现出 8 小时差，否则说明有一个写错了
    // （同机同时区，所以这条断言在这里是确定的；换个时区跑会变，那是环境不是代码）
    const utc = doc.members[0].created_at;
    const utcMs = parseInstant(utc);
    expect(utcMs).not.toBeNull();
    const gapHours = (Date.parse(doc.exported_at) - Date.parse(utc)) / 3600000;
    expect(gapHours).toBeGreaterThan(7.9);
  });

  it('往返回到同一个毫秒 —— 不是「格式看着对」', () => {
    const db = importedDb();
    const r = buildExport(db, NOW);
    if (!r.ok) throw new Error('导出失败');
    const doc = JSON.parse(r.json) as { batches: { id: number; created_at: string }[] };

    const byId = new Map(db.select().from(batches).all().map((b) => [b.id, b.createdAt]));
    for (const out of doc.batches) {
      expect(parseInstant(out.created_at)).toBe(byId.get(out.id));
    }
  });
});

describe('值的形状', () => {
  it('auto_deduct / auto_paused 是**真布尔**，不是 0/1', () => {
    // `parse.ts` 的 `asBool` 只认真布尔 —— 写 0/1 会让整份文件导不回来
    const rows = rowsOf(built().json, 'medicines');
    for (const r of rows) {
      expect(typeof r.auto_deduct).toBe('boolean');
      expect(typeof r.auto_paused).toBe('boolean');
    }
    // 真数据里两种值都有，这条才不是在空转
    expect(rows.some((r) => r.auto_deduct === true)).toBe(true);
    expect(rows.some((r) => r.auto_deduct === false)).toBe(true);
  });

  it('settings 的值是字符串（网页版那一格就是字符串）', () => {
    const doc = JSON.parse(built().json) as { settings: Record<string, unknown> };
    for (const v of Object.values(doc.settings)) expect(typeof v).toBe('string');
  });

  it('数量都是数字，没有字符串化的 "12"', () => {
    const rows = rowsOf(built().json, 'batches');
    for (const r of rows) {
      expect(typeof r.qty).toBe('number');
      expect(typeof r.open_life_days === 'number' || r.open_life_days === null).toBe(true);
    }
  });
});

describe('四张表都按 id 升序', () => {
  // 🔴 `stock_events` 尤其必须：不变量 1 的平局判定是 `>=`（`parse.ts:541`），
  // 同 `createdAt` 时**数组里靠后的赢**，而「靠后 = 写入更晚」的唯一可靠依据是 id。
  it.each(['members', 'medicines', 'batches', 'stock_events'])('%s', (table) => {
    const ids = rowsOf(built().json, table).map((r) => r.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('同 createdAt 的两条事件：id 大的在后面（不变量 1 的平局判定靠这个）', () => {
    const db = freshDb();
    const med = db
      .insert(medicines)
      .values({ generic: '平局药', unit: '片', createdAt: NOW })
      .run();
    const medId = Number(med.lastInsertRowid ?? med.lastInsertRowId);
    const b = db
      .insert(batches)
      .values({
        medicineId: medId,
        qty: 8,
        unit: '片',
        status: 'in_stock',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const batchId = Number(b.lastInsertRowid ?? b.lastInsertRowId);
    // 同一个时刻的两条事件，只有 id 能区分谁后写
    for (const [delta, after] of [
      [10, 10],
      [-2, 8],
    ] as const) {
      db.insert(stockEvents)
        .values({ batchId, type: 'take', deltaQty: delta, qtyAfter: after, createdAt: NOW })
        .run();
    }

    const r = buildExport(db, NOW);
    if (!r.ok) throw new Error('导出失败');
    const evs = rowsOf(r.json, 'stock_events');
    expect(evs).toHaveLength(2);
    expect(evs[0].qty_after).toBe(10);
    expect(evs[1].qty_after).toBe(8);
    // 后者是**真正的最后一条**：不变量 1 说 Batch.qty == 最后一条事件的 qtyAfter
    expect(evs[1].qty_after).toBe(
      db.select().from(batches).all().find((x) => x.id === batchId)?.qty,
    );
  });
});

describe('settings 只写两个阈值键', () => {
  it('库里塞了溯源键和网页版迁移标记，也不会泄漏进文件', () => {
    const db = importedDb();
    db.insert(settings)
      .values([
        { key: 'migrate_auto_deduct_v1', value: '1' },
        { key: 'migrate_something_else', value: '2' },
      ])
      .onConflictDoUpdate({ target: settings.key, set: { value: '1' } })
      .run();

    const r = buildExport(db, NOW);
    if (!r.ok) throw new Error('导出失败');
    const doc = JSON.parse(r.json) as { settings: Record<string, string> };
    expect(Object.keys(doc.settings).sort()).toEqual(['near_expiry_days', 'restock_days']);
  });

  it('改过阈值就按改过的写出去（不是永远写默认值）', () => {
    const db = importedDb();
    db.insert(settings)
      .values({ key: 'near_expiry_days', value: '30' })
      .onConflictDoUpdate({ target: settings.key, set: { value: '30' } })
      .run();

    const r = buildExport(db, NOW);
    if (!r.ok) throw new Error('导出失败');
    const doc = JSON.parse(r.json) as { settings: Record<string, string> };
    expect(doc.settings.near_expiry_days).toBe('30');
    expect(doc.settings.restock_days).toBe('15');
  });
});

describe('自检（文件头规则 4）', () => {
  it('warnings 是自检那把尺子给的 —— 有真数据就非空，空库就空', () => {
    // 自检若被删掉，`warnings` 会恒为 []。这条是「自检真的在跑」的可观测证据。
    expect(built().warnings).toHaveLength(1);
    expect(built().warnings[0]).toContain('38 条在库没有变动记录');

    const empty = buildExport(freshDb(), NOW);
    if (!empty.ok) throw new Error('空库应当能导出');
    expect(empty.warnings).toEqual([]);
  });

  it('预检看不见的坏数据，自检拦得住 —— 证明它不是在空转', () => {
    // 这条是**自检存在意义**的证明，不是又一条格式断言。
    // 造一个 `buildExport` 自己的预检**检查不到**、但导入端会拒绝的状态：
    // 一个格式非法的日期（只有手工改库才做得到，但它正是自检要兜的那种事）。
    // 如果自检被删掉，这条会以 `ok: true` 挂掉。
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '坏日期药', unit: '片' });
    addBatch(db, NOW, medId, 5, { expiryDate: '2026-13-45' });

    const r = buildExport(db, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 报的是**导入端的原话，原样透出**：字段名 + 那个坏值。
    // ⚠️ 注意它**不点名药**（只有「批次 #1」）。这是可以接受的，不是疏漏：
    // 自检要兜的正是「预检列不全的未来坏状态」——也就是用户**在界面里改不了**
    // 的那一类（能在界面里改的，预检已经点名到药、到盒、并指了去哪改了）。
    // 所以导出页在自检失败时配的文案是「这份数据本身有问题」，不是「请去改某某」。
    expect(r.reason).toBe('self_check');
    expect(r.errors.join(' ')).toContain('expiry_date');
    expect(r.errors.join(' ')).toContain('2026-13-45');
  });
});
