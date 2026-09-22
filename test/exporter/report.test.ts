/**
 * 「在库清单」纯文本的规格测试（`src/exporter/report.ts`）。
 *
 * 这个文件的清单是**给人读的**：家人拿到它要判断「还剩多少 / 够不够 / 什么时候过期」。
 * 所以测试分两类：
 * - **数字对不对**：44 盒 / 37 种 / 2118 单位、需补货 1 种 —— 与 `test/golden.test.ts`
 *   同一套基准日，对不上就是回归。
 * - **读到会误解的地方**：单位混用时不许印天数、没设用量的药不许印「约剩」、
 *   取空的盒不许出现在清单里。这几条比数字更容易写错，而且错了用户看不出来。
 */
import { addBatch, addMedicine, freshDb } from '../helpers';
import { batches, stockEvents } from '../../src/db/schema';
import { buildInventoryReport, type InventoryReport } from '../../src/exporter/report';
import { BATCH_IN_STOCK, SHARED_LABEL } from '../../src/domain/constants';
import { IMPORT_DAY, NOW, importedDb } from './fixture';

/** 基准日：与 `test/golden.test.ts:31` 同一个，所以数字可以直接和它对比。 */
const DAY = IMPORT_DAY;

function report(day = DAY): InventoryReport {
  return buildInventoryReport(importedDb(), day, NOW);
}

/** 把一个组块拆成「标题 / 说明 / 盒行」。 */
type Block = { title: string; sub: string; lines: string[] };

function blocks(text: string): Block[] {
  return text
    .split('\n\n')
    .filter((c) => /^\[\d+\]/.test(c))
    .map((c) => {
      const [title, sub, ...lines] = c.split('\n');
      return { title, sub, lines };
    });
}

describe('数字与 golden 一致（基准日 2026-09-16）', () => {
  it('44 盒 / 37 种 / 2118 单位 / 需补货 1 种', () => {
    const s = report().summary;
    expect(s.boxCount).toBe(44);
    expect(s.medicineCount).toBe(37);
    expect(s.totalQty).toBe(2118);
    expect(s.restock).toHaveLength(1);
    // 「未填效期 13」「快过期 1」「已过期 0」—— 与 M1 装机核过的那三个数同源
    expect(s.noExpiryBoxes).toBe(13);
    expect(s.expiringBoxes).toBe(1);
    expect(s.expiredBoxes).toBe(0);
  });

  it('头部四行是固定的那四句，阈值跟着设置走', () => {
    const text = report().text;
    expect(text.startsWith('家庭药箱 · 在库清单\n')).toBe(true);
    expect(text).toContain('在库 44 盒 / 37 种 · 合计 2118 单位');
    expect(text).toContain('需补货 1 种 · 快过期 1 盒 · 已过期 0 盒 · 未填效期 13 盒');
    expect(text).toContain('阈值：快过期 90 天 · 需补货 15 天');
  });

  it('组数 37、每组标题是 [序号] + 药名，序号连续', () => {
    const bs = blocks(report().text);
    expect(bs).toHaveLength(37);
    bs.forEach((b, i) => expect(b.title.startsWith(`[${i + 1}] `)).toBe(true));
  });

  it('排序与首页同一套：第 1 组蒙脱石散、最后一组盐酸二甲双胍缓释片', () => {
    const bs = blocks(report().text);
    expect(bs[0].title).toContain('蒙脱石散');
    expect(bs[bs.length - 1].title).toContain('盐酸二甲双胍缓释片');
  });

  it('组按「最早的提醒日」升序 —— 无提醒日的排最后', () => {
    const days = report()
      .groups.map((g) => g.earliest)
      .filter((d): d is string => d !== null);
    expect(days).toEqual([...days].sort());
    // 有提醒日的组全排在没提醒日的组前面
    const flags = report().groups.map((g) => g.earliest !== null);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
  });

  it('文件名带日期 —— 一天一版，发出去不会互相盖掉', () => {
    expect(report().fileName).toBe('在库清单-2026-09-16.txt');
    expect(report('2026-10-02').fileName).toBe('在库清单-2026-10-02.txt');
  });
});

describe('需补货的那一种：阿托伐他汀 · 约剩 6 天', () => {
  it('组标题带【需补货】，说明行带「约剩 6 天」', () => {
    const b = blocks(report().text).find((x) => x.title.includes('阿托伐他汀钙片'))!;
    expect(b.title).toContain('【需补货】');
    expect(b.sub).toContain('约剩 6 天');
  });

  it('头部单列一行「需补货：…」—— 家人一眼就看到要买什么', () => {
    expect(report().text).toContain('需补货：阿托伐他汀钙片（约剩 6 天）');
  });

  it('只有这一个药带【需补货】标记', () => {
    const marked = blocks(report().text).filter((b) => b.title.includes('【需补货】'));
    expect(marked).toHaveLength(1);
  });
});

describe('「约剩 N 天」的五条限制', () => {
  it('只出现在设了每日用量的那 6 个药上（37 − 6 = 31 个不印）', () => {
    const bs = blocks(report().text);
    const withDos = bs.filter((b) => b.sub.includes('约剩'));
    expect(withDos).toHaveLength(6);
    // 标题形如 `[13] 阿托伐他汀钙片（10mg×14片）【需补货】` → 剁掉序号、规格、标记，
    // 只留药名（规格里的 × 与括号都是数据，不该在断言里重复一遍）
    expect(withDos.map((b) => b.title.replace(/^\[\d+\] /, '').replace(/[【（].*/, ''))).toEqual([
      '缬沙坦胶囊',
      '阿托伐他汀钙片',
      '阿司匹林肠溶片',
      '苯磺酸氨氯地平片',
      '格列美脲片',
      '盐酸二甲双胍缓释片',
    ]);
    // 剩下 31 个的说明行里连「约剩」两个字都不该出现
    // （没设用量却印一个数，家人会当成事实）
    for (const b of bs.filter((x) => !x.sub.includes('约剩'))) {
      expect(b.sub).not.toContain('约剩');
    }
  });

  it('单位混用时印「无法估算天数」，**不给数字**', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '混单位药', unit: '片', dailyDose: 1 });
    addBatch(db, NOW, medId, 4, { unit: '片' });
    addBatch(db, NOW, medId, 6, { unit: '粒' });

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.groups).toHaveLength(1);
    const sub = blocks(r.text)[0].sub;
    expect(sub).toContain('有不止一种单位，无法估算天数');
    expect(sub).not.toContain('约剩');
    // 数量照常展示（§3.6：混用时数量仍要看得见）。
    // 不断言两种单位的**顺序** —— `buildGroups` 用的是默认的 `localeCompare`，
    // 顺序随 ICU 实现，钉死它会在别的机器上无缘无故红。
    expect(sub).toContain('4 片');
    expect(sub).toContain('6 粒');
  });

  it('单位混用的药仍进「需补货」名单，但**两处都不给天数**', () => {
    // 名单必须留着：`需补货 N 种` 的个数要和首页对得上（首页也是这么算的，
    // 网页版的 `units_conflict` 只挡自动扣减、不挡补货预测）。
    // 但天数要抹掉 —— 同一份清单里一处「无法估算天数」、另一处「约剩 10 天」，
    // 读的人只会信那个数字。
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '混单位药', unit: '片', dailyDose: 1 });
    addBatch(db, NOW, medId, 4, { unit: '片' });
    addBatch(db, NOW, medId, 6, { unit: '粒' });

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.summary.restock).toEqual([{ generic: '混单位药', daysOfSupply: null }]);
    expect(r.text).toContain('需补货：混单位药（单位不统一，天数算不准）');
    // 全文不许出现那个由「4 片 + 6 粒」加出来的 10 天
    expect(r.text).not.toContain('约剩 10 天');
    expect(r.text).not.toContain('约剩 10天');
  });

  it('0 库存的药照进名单，天数是 0 而不是「算不准」，且空药箱时也印出来', () => {
    // 与上一条的分界：没有在库批次 ≠ 单位混用。前者天数是**确定**的 0。
    // 这也是「一盒在库都没有」的极端情形 —— 正文没有组可印，补货名单是唯一
    // 有信息量的东西，早退把它吞掉就等于头部说「需补货 1 种」却不说谁。
    const db = freshDb();
    addMedicine(db, NOW, { generic: '吃完了', unit: '片', dailyDose: 2 });

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.summary.restock).toEqual([{ generic: '吃完了', daysOfSupply: 0 }]);
    expect(r.text).toContain('需补货：吃完了（约剩 0 天）');
    expect(r.text).toContain('（药箱里还没有在库的药）');
    // 补货行在空药箱那句**之前** —— 先说要买什么，再说箱子是空的
    expect(r.text.indexOf('需补货：吃完了')).toBeLessThan(
      r.text.indexOf('（药箱里还没有在库的药）'),
    );
  });

  it('没设每日用量（dailyDose 为 null）时不印天数，也不判需补货', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '没用量药', unit: '片' });
    addBatch(db, NOW, medId, 2);

    const r = buildInventoryReport(db, DAY, NOW);
    expect(blocks(r.text)[0].sub).not.toContain('约剩');
    expect(r.summary.restock).toEqual([]);
  });
});

describe('哪些盒进清单、哪些不进', () => {
  it('已过期但仍在库的盒**在**清单里 —— 「在库」是状态，不是「没过期」', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '过期药', unit: '片' });
    addBatch(db, NOW, medId, 3, { expiryDate: '2020-01-01' });

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.summary.boxCount).toBe(1);
    expect(r.summary.expiredBoxes).toBe(1);
    expect(r.text).toContain('过期药');
    expect(r.text).toContain('效期 2020-01-01');
  });

  it('已用完 / 已丢弃的盒不进清单，也不计入盒数', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '用完药', unit: '片' });
    addBatch(db, NOW, medId, 0, { status: 'used_up' });
    addBatch(db, NOW, medId, 5, { status: 'discarded' });
    const keepId = addBatch(db, NOW, medId, 7);

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.summary.boxCount).toBe(1);
    expect(r.summary.totalQty).toBe(7);
    // 药本身还在清单里（它有 1 盒在库），但被排除的那两盒的行不该印出来
    expect(r.groups[0].boxes.map((b) => b.batchId)).toEqual([keepId]);
    expect(r.text).toContain('1 盒');
    expect(r.text).not.toContain('5 片'); // 已丢弃那盒的数量
    expect(r.text).not.toContain('0 片'); // 已用完那盒的数量
  });

  it('在库但数量为 0 的盒不进清单 —— 与导出端归一化成「已用完」是同一口径', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '取空药', unit: '片' });
    addBatch(db, NOW, medId, 0, { status: BATCH_IN_STOCK });
    addBatch(db, NOW, medId, 5);

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.summary.boxCount).toBe(1);
    expect(r.summary.totalQty).toBe(5);
  });

  it('空库也能出清单：头部照印，正文一句「还没有在库的药」', () => {
    const r = buildInventoryReport(freshDb(), DAY, NOW);
    expect(r.summary.boxCount).toBe(0);
    expect(blocks(r.text)).toHaveLength(0);
    expect(r.text).toContain('在库 0 盒 / 0 种 · 合计 0 单位');
    expect(r.text).toContain('（药箱里还没有在库的药）');
  });
});

describe('排版细节（改了会影响用户对清单的信任）', () => {
  it('UTF-8 无 BOM、只用 \\n、结尾恰好一个换行', () => {
    const text = report().text;
    expect(text[0]).not.toBe('﻿');
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('位置为空印 —，不印 null / undefined', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '没位置药', unit: '片' });
    addBatch(db, NOW, medId, 1, { location: null });

    const text = buildInventoryReport(db, DAY, NOW).text;
    expect(text).toContain('1 片 · 未填效期 · —');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('归属为空印「家庭共用」（与首页同一个标签）', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '共享药', unit: '片' });
    addBatch(db, NOW, medId, 1);

    expect(buildInventoryReport(db, DAY, NOW).text).toContain(SHARED_LABEL);
    expect(SHARED_LABEL).toBe('家庭共用');
  });

  it('提醒日只在**不同于**印刷效期时才另起一行', () => {
    const db = freshDb();
    const medId = addMedicine(db, NOW, { generic: '拆封药', unit: '片' });
    // 印刷效期很远，但 2026-01-01 拆封 + 开封 30 天 ⇒ 提醒日 2026-01-31，更早
    addBatch(db, NOW, medId, 10, {
      expiryDate: '2027-12-31',
      openedAt: '2026-01-01',
      openLifeDays: 30,
    });

    const r = buildInventoryReport(db, DAY, NOW);
    expect(r.groups[0].boxes[0].effective).toBe('2026-01-31');
    expect(r.groups[0].boxes[0].showReminder).toBe(true);
    expect(r.text).toContain('↳ 提醒日 2026-01-31');

    // 没拆封的盒：提醒日 == 印刷效期，不另起一行
    const db2 = freshDb();
    const m2 = addMedicine(db2, NOW, { generic: '没拆封药', unit: '片' });
    addBatch(db2, NOW, m2, 10, { expiryDate: '2027-12-31' });
    const r2 = buildInventoryReport(db2, DAY, NOW);
    expect(r2.groups[0].boxes[0].showReminder).toBe(false);
    expect(r2.text).not.toContain('↳');
  });

  it('一盒一行，多盒的药每盒都印出来（含各自的效期与位置）', () => {
    const b = blocks(report().text).find((x) => x.title.includes('缬沙坦胶囊'))!;
    expect(b.sub).toContain('2 盒');
    expect(b.lines.filter((l) => /^\s{6}\d/.test(l))).toHaveLength(2);
    expect(b.lines.join('\n')).toContain('4 片 · 效期 2026-12-31 · 床头柜');
    expect(b.lines.join('\n')).toContain('30 片 · 效期 2027-10-06 · 床头柜');
  });
});

describe('只读（硬约束 6）', () => {
  it('生成清单不改数量、不写事件 —— 「约剩」只是个除法', () => {
    const db = importedDb();
    const before = db.select().from(batches).all().map((b) => [b.id, b.qty]);
    const events = db.select().from(stockEvents).all().length;

    buildInventoryReport(db, DAY, NOW);

    expect(db.select().from(batches).all().map((b) => [b.id, b.qty])).toEqual(before);
    expect(db.select().from(stockEvents).all()).toHaveLength(events);
  });
});
