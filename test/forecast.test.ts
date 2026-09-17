/**
 * 补货预测 —— 逐条移植自 `../medbox-app/tests/test_forecast.py`（5 条）。
 *
 * 前 4 条是纯函数（`daysOfSupply` / `needsRestock`），最后一条
 * `test_dashboard_stats` 是**集成测试**：上游用 pytest 的 `session` fixture 建库，
 * 这里换成 `freshDb()`（`test/helpers.ts`）建真 SQLite；断言的目标函数
 * 从上游的 `forecast.dashboard_stats` 换成 `src/data/queries.ts` 的 `dashboard`
 * —— 因为在我们这边聚合查询归数据层，`src/domain/forecast.ts` 只留纯规则。
 *
 * 为什么值得翻译：`needsRestock` 决定首页「需补货」区块里出现哪些药。
 * 判错的两种方向都很难看 —— 报多了用户学会无视整个区块，
 * 报少了该买的药就断顿了。
 */
import { dashboard } from '../src/data/queries';
import { members } from '../src/db/schema';
import { addDays } from '../src/domain/calendar';
import { daysOfSupply, needsRestock } from '../src/domain/forecast';
import { addBatch, addMedicine, freshDb, insertId } from './helpers';

/** 上游的 `TODAY`。 */
const TODAY = '2026-09-03';
/** 上游没有这个概念（它用 `date`），我们这边的时刻是 epoch 毫秒。 */
const NOW = Date.UTC(2026, 8, 3, 4, 0, 0);

const day = (n: number) => addDays(TODAY, n);

describe('daysOfSupply —— 预计可用天数', () => {
  it('在库合计 ÷ 每日用量', () => {
    // 上游 test_days_of_supply_basic
    expect(daysOfSupply(30, 1)).toBe(30);
    expect(daysOfSupply(45, 1.5)).toBe(30);
  });

  it('0 库存 = 0 天，**不是** null', () => {
    // 上游 test_days_of_supply_zero_stock。
    // 0 和 null 必须分开：0 表示「算得出来，而且已经吃完了」，
    // null 表示「没设用量，不参与预测」。混成一个的话，首页要么漏报
    // 「已吃完」，要么给偶用药瞎报「需补货」。
    expect(daysOfSupply(0, 1)).toBe(0);
  });

  it('没设每日用量、或用量 ≤0 → null（不参与预测）', () => {
    // 上游 test_days_of_supply_no_or_bad_dose
    expect(daysOfSupply(30, null)).toBeNull();
    expect(daysOfSupply(30, undefined)).toBeNull();
    expect(daysOfSupply(30, 0)).toBeNull();
    expect(daysOfSupply(30, -1)).toBeNull();
  });
});

describe('needsRestock —— 需补货判定', () => {
  it('边界是 ≤ 不是 <：恰好等于阈值就算需补货', () => {
    // 上游 test_needs_restock。差这一天的意义是「刚好还能吃到下次买药」，
    // 该提醒了 —— 所以取 ≤。
    expect(needsRestock(15, 15)).toBe(true);
    expect(needsRestock(15.1, 15)).toBe(false);
  });

  it('0 库存算需补货（自然成立，不需要特判）', () => {
    // 上游同一处断言。0 ≤ 15 天然成立，代码里没有 `if (dos === 0)` ——
    // 有的话就是冗余，去掉它测试也照样过，所以这里钉住的是**行为**不是实现。
    expect(needsRestock(0, 15)).toBe(true);
  });

  it('没有预测（null）→ 不报需补货', () => {
    // 上游最后一条断言。偶用药（没设每日用量）永远不该出现在「需补货」里 ——
    // 否则用户会被一堆「感冒灵颗粒 需补货」淹掉，然后学会无视整个区块。
    expect(needsRestock(null, 15)).toBe(false);
    expect(needsRestock(undefined, 15)).toBe(false);
  });
});

describe('dashboard —— 首页总览聚合（上游 test_dashboard_stats）', () => {
  it('上游那条集成测试原样重跑', () => {
    const db = freshDb();

    const dad = insertId(db.insert(members).values({ name: '爸爸', createdAt: NOW }).run());

    // A：慢性药，每日 1 片，在库 8 片 → 预计 8 天 ≤ 15 → 需补货
    const medA = addMedicine(db, NOW, { generic: '硝苯地平缓释片', category: '处方药', dailyDose: 1 });
    // C：设了用量，但一个在库批次都没有 → 0 库存，需补货
    const medC = addMedicine(db, NOW, { generic: '阿托伐他汀', category: '处方药', dailyDose: 1 });
    // B：偶用药，没设每日用量 → 不参与补货
    const medB = addMedicine(db, NOW, { generic: '感冒灵颗粒', category: 'OTC非处方药' });
    // D 近效期 / E 已过期 / F 正常，三个都没设用量
    const medD = addMedicine(db, NOW, { generic: '布洛芬片' });
    const medE = addMedicine(db, NOW, { generic: '维生素C片' });
    const medF = addMedicine(db, NOW, { generic: '蒙脱石散' });

    addBatch(db, NOW, medA, 8, { unit: '片', ownerId: dad, expiryDate: day(400) });
    addBatch(db, NOW, medB, 2, { unit: '盒', expiryDate: day(300) });
    addBatch(db, NOW, medD, 1, { unit: '盒', expiryDate: day(30) });
    addBatch(db, NOW, medE, 1, { unit: '盒', expiryDate: day(-5) });
    addBatch(db, NOW, medF, 3, { unit: '盒', expiryDate: day(300) });

    const dash = dashboard(db, TODAY);

    // 阈值一条都没设过 → 用默认值 90 / 15（上游 `get_int_setting` 同样行为）。
    // 顺手把「设置表是空的时候不能崩」也钉住了。
    expect(dash.thresholds).toEqual({ nearDays: 90, restockDays: 15 });

    // 在库 5 条 —— C 一个在库批次都没有，所以不是 6
    expect(dash.inStockCount).toBe(5);

    // 近效期只有 D（30 天）；已过期只有 E（5 天前）
    expect(dash.nearExpiryCount).toBe(1);
    expect(dash.rows.filter((r) => r.expiryStatus === 'expiring').map((r) => r.medicine.id)).toEqual([medD]);
    expect(dash.expiredCount).toBe(1);
    expect(dash.rows.filter((r) => r.expiryStatus === 'expired').map((r) => r.medicine.id)).toEqual([medE]);

    // 需补货：A（8 天）和 C（0 天）都该提醒；B 没设用量，不参与。
    // 这条是整块测试的重点 —— 注意 C **一条在库批次都没有**，
    // 如果从「在库行」出发去算需补货就会漏掉它（§3.5）。
    expect(new Set(dash.needRestock.map((r) => r.medicine.generic))).toEqual(
      new Set(['硝苯地平缓释片', '阿托伐他汀']),
    );

    // A 那一行：约剩 8 天、判为需补货
    const aRow = dash.rows.find((r) => r.medicine.id === medA)!;
    expect(aRow.daysOfSupply).toBe(8);
    expect(aRow.needsRestock).toBe(true);

    // 按成员：爸爸 1 条，其余 4 条家庭共用。
    // ⚠️ 这个 fixture 分不出两种口径 —— 上游数的是**批次行数**，
    // 我们数的是**药品种数**（§3.7，同种药多盒只算 1 种）。
    // 这里每种药恰好只有 1 盒，所以两种算法都得 5。
    // 真正钉住「品种数」口径的是 `test/golden.test.ts` 里那串验收数字
    // （家庭共用 16 / 孩子 14 / 外公 6 / 妈妈 1）。
    expect(dash.perMember.reduce((s, m) => s + m.count, 0)).toBe(5);
    expect(dash.perMember.find((m) => m.name === '爸爸')).toMatchObject({ count: 1, ownerId: dad });
  });
});
