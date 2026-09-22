/**
 * 快照层 —— `src/notify/snapshot.ts`（M5）。
 *
 * 这一层唯一的智力含量是「从哪张表拿、拿哪些行」，所以测试的重点不是它自己，
 * 而是**它和领域层接起来之后的端到端行为**：真 SQLite → 快照 → `planNotifications`。
 *
 * 其中最要紧的一组是最后那两条「刻意不对称」：**单位混用 / 暂停服药的药，
 * 首页照常把它们列为「需补货」，但推送一条都不发**。这个不一致看着像 bug，
 * 其实是设计（页面讲状态，推送讲事件）—— 不钉住的话，下一个人会来「修」它。
 */
import { dashboard, getThresholds } from '../src/data/queries';
import { addDays, localDayAt } from '../src/domain/calendar';
import { planNotifications, type NotifyOptions } from '../src/domain/notify';
import { loadNotifySnapshot } from '../src/notify/snapshot';
import { addBatch, addMedicine, freshDb } from './helpers';

const TODAY = '2026-09-22';
const NOW = localDayAt(TODAY, 0, 30);
const day = (n: number) => addDays(TODAY, n);

function opts(over: Partial<NotifyOptions> = {}): NotifyOptions {
  return { hour: 9, minute: 0, restockDays: 15, horizonDays: 14, now: NOW, ...over };
}

/** 建库 + 快照 + 计划，一条龙。测试要的几乎都是这个。 */
function plan(db: Parameters<typeof loadNotifySnapshot>[0], over: Partial<NotifyOptions> = {}) {
  const th = getThresholds(db);
  const snap = loadNotifySnapshot(db, TODAY, th);
  const o = opts({ restockDays: th.restockDays, ...over });
  return { snap, out: planNotifications(snap, TODAY, o) };
}

describe('loadNotifySnapshot —— 批次侧', () => {
  it('只有在库的批次进快照（已用完 / 已丢弃 / 标记过期的都不吵）', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, { generic: '布洛芬片' });
    const keep = addBatch(db, NOW, med, 1, { expiryDate: day(10) });
    addBatch(db, NOW, med, 1, { expiryDate: day(10), status: 'used_up' });
    addBatch(db, NOW, med, 1, { expiryDate: day(10), status: 'discarded' });
    addBatch(db, NOW, med, 1, { expiryDate: day(10), status: 'expired' });

    const { snap } = plan(db);
    expect(snap.batches.map((b) => b.batchId)).toEqual([keep]);
    expect(snap.batches[0]).toMatchObject({ medicineId: med, status: 'in_stock' });
  });

  it('未填效期 ⇒ effective 为 null（首页是灰药丸，但推送没有日期可依）', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, {});
    addBatch(db, NOW, med, 5, { expiryDate: null });
    const { snap, out } = plan(db);
    expect(snap.batches[0].effective).toBeNull();
    expect(out).toEqual([]);
  });

  it('effective 用的是**提醒日**：拆封 + 开封天数 比印刷效期早时取早的那个', () => {
    // requirements.md §2.2 的「开封后有效期」—— 一瓶糖浆拆开 20 天后过期，
    // 即使瓶子上印的是明年。推送跟着这个日子走，否则提醒会晚几个月。
    const db = freshDb();
    const med = addMedicine(db, NOW, {});
    addBatch(db, NOW, med, 1, {
      expiryDate: day(300),
      openedAt: day(-10),
      openLifeDays: 20,
    });
    addBatch(db, NOW, med, 1, { expiryDate: day(8) }); // 印刷效期更早

    const { snap, out } = plan(db);
    // 顺序跟着 `inStockRows` 走：**提醒日升序**（这里是复制它的排序，不是新规则）
    expect(snap.batches.map((b) => b.effective)).toEqual([day(8), day(10)]);
    // 提醒日各自 +1 的「已过期」也都在
    expect(out.map((p) => p.day)).toEqual([day(8), day(9), day(10), day(11)]);
  });
});

describe('loadNotifySnapshot —— 药侧', () => {
  it('同一味药多盒在库 ⇒ 只出一条，totalQty 是合计', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, { dailyDose: 1, autoDeduct: true });
    addBatch(db, NOW, med, 20, {});
    addBatch(db, NOW, med, 11, {});

    const { snap, out } = plan(db, { horizonDays: 20 });
    expect(snap.medicines).toHaveLength(1);
    expect(snap.medicines[0]).toMatchObject({ medicineId: med, totalQty: 31, unitConflict: false });
    // 31 片、每日 1 片、阈值 15 ⇒ 第 16 天跨线；第 31 天归零（超出前瞻，不排）
    expect(out.map((p) => p.day)).toEqual([day(16)]);
  });

  it('在库批次用了两种单位 ⇒ unitConflict（跨单位求和没有意义）', () => {
    const db = freshDb();
    const mixed = addMedicine(db, NOW, { dailyDose: 1, autoDeduct: true });
    const single = addMedicine(db, NOW, { dailyDose: 1, autoDeduct: true });
    addBatch(db, NOW, mixed, 3, { unit: '片' });
    addBatch(db, NOW, mixed, 1, { unit: '盒' });
    addBatch(db, NOW, single, 4, { unit: '片' });
    addBatch(db, NOW, single, 1, { unit: '片' });

    const { snap } = plan(db);
    const byId = new Map(snap.medicines.map((m) => [m.medicineId, m]));
    expect(byId.get(mixed)!.unitConflict).toBe(true);
    expect(byId.get(single)!.unitConflict).toBe(false);
  });

  it('把 dailyDose / autoDeduct / autoPaused 原样带出来', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, { dailyDose: 2, autoDeduct: true, autoPaused: true });
    addBatch(db, NOW, med, 5, {});
    const { snap } = plan(db);
    expect(snap.medicines[0]).toMatchObject({ dailyDose: 2, autoDeduct: true, autoPaused: true });
  });
});

describe('端到端：真库 → 快照 → 计划', () => {
  it('库存掉到阈值以下 ⇒ 在算出来的那一天推「需补货」', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, { generic: '格列美脲片', dailyDose: 1, autoDeduct: true });
    addBatch(db, NOW, med, 20, { expiryDate: day(400) });

    const { out } = plan(db);
    // 20 片、每日 1 片、阈值 15 ⇒ 第 5 天 dos 正好 15 ≤ 15 ⇒ 跨线
    expect(out.map((p) => p.day)).toEqual([day(5)]);
    expect(out[0].body).toBe('需补货 1 种');
    expect(out[0].reasons).toEqual([{ kind: 'restock', medicineId: med }]);
  });

  it('🔴 单位混用 / 暂停服药的药：**页面报「需补货」，推送一条不发**', () => {
    // 刻意的页面/推送不对称（DESIGN.md §7.7）。这两类药的库存在两次打开 App
    // 之间**不会自己变**，所以「跨线日」要么是今天、要么永远是今天 ——
    // 按规则 4（只在 k ≥ 1 时排）一条都推不出来。
    // 用户手动取用的那一刻人正拿着手机，事后推一条没有价值。
    const db = freshDb();
    const mixed = addMedicine(db, NOW, { generic: '混单位药', dailyDose: 1, autoDeduct: true });
    const paused = addMedicine(db, NOW, { generic: '暂停药', dailyDose: 1, autoDeduct: true, autoPaused: true });
    const off = addMedicine(db, NOW, { generic: '没开自动扣减的药', dailyDose: 1, autoDeduct: false });
    addBatch(db, NOW, mixed, 3, { unit: '片' });
    addBatch(db, NOW, mixed, 1, { unit: '盒' });
    addBatch(db, NOW, paused, 5, {});
    addBatch(db, NOW, off, 5, {});

    const { out } = plan(db);
    expect(out).toEqual([]);

    // 但页面照旧 —— 这正是「不对称」三个字的全部内容
    const dash = dashboard(db, TODAY);
    const names = new Set(dash.needRestock.map((r) => r.medicine.generic));
    expect(names).toEqual(new Set(['混单位药', '暂停药', '没开自动扣减的药']));
    expect(names.has('混单位药')).toBe(true); // 非空转断言：上面的 toEqual 真的在比东西
  });

  it('🔴 没设每日用量的药：页面本来就不报，推送也不推（两边一致）', () => {
    // 这条**不属于**上面那种刻意不对称 —— §3.5 说没设用量就不参与预测，
    // 页面和推送口径是一样的。写下来是为了让下一个人别把它和前一条混为一谈。
    const db = freshDb();
    const med = addMedicine(db, NOW, { generic: '偶用药', dailyDose: null, autoDeduct: true });
    addBatch(db, NOW, med, 2, {});
    const { out } = plan(db);
    expect(out).toEqual([]);
    expect(dashboard(db, TODAY).needRestock).toEqual([]);
  });

  it('🔴 锁屏上不出现药名：快照里放真药名，正文里一个都找不到', () => {
    // Android 没有 iOS 那种「锁屏隐藏正文」的开关，所以唯一的落点是**不写进去**。
    // 这里从真库一路跑到 title/body，是这套保证的端到端版本。
    const db = freshDb();
    const med = addMedicine(db, NOW, { generic: '阿司匹林肠溶片', dailyDose: 1, autoDeduct: true });
    addBatch(db, NOW, med, 20, {});

    const { out } = plan(db);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('药箱：1 件事待处理');
    expect(out[0].body).toBe('需补货 1 种');
    expect(out[0].title).not.toContain('阿司匹林');
    expect(out[0].body).not.toContain('阿司匹林');
  });

  it('效期与补货同时命中 ⇒ 同一天合并成一条，两个数都在', () => {
    const db = freshDb();
    const med = addMedicine(db, NOW, { generic: '二甲双胍', dailyDose: 1, autoDeduct: true });
    addBatch(db, NOW, med, 16, { expiryDate: day(1) }); // 明天到期
    // 16 片 ⇒ 明天 dos 15 ≤ 15 ⇒ 同一天跨线
    const { out } = plan(db);
    // day(2) 那条是这批药次日转「已过期」，与补货无关；它证明两件事没被错误地合并
    expect(out.map((p) => p.day)).toEqual([day(1), day(2)]);
    expect(out[0].counts).toEqual({ dueToday: 1, expired: 0, restock: 1, usedUp: 0 });
    expect(out[0].title).toBe('药箱：2 件事待处理');
    expect(out[1].counts).toEqual({ dueToday: 0, expired: 1, restock: 0, usedUp: 0 });
  });
});
