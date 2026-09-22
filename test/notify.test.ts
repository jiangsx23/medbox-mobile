/**
 * 本地推送的调度纯函数 —— `src/domain/notify.ts`（M5）。
 *
 * 这个套件钉住的是**产品决策**，不是实现细节。每一条「🔴」都对着
 * DESIGN.md / 需求文档里一句锁死的话；它们全都符合「看起来很合理、改掉就坏」
 * 的形状，所以测试是这里唯一的防腐剂：
 *
 * - `expiring`（进入 90 天窗口）**一条都不推** —— 最容易被下一个人「顺手补上」，
 *   而补上之后用户会把整个通知权限关掉，重要的那条也一起没了。
 * - 前瞻是**连续模型**，不是 `planSettlement` 那套阶梯 —— 抄错的话，
 *   药真的该补了却一条都不推（下方「不动点」那两条会立刻变红）。
 * - 锁屏**不出现药名**。
 * - 「今天那条永不 cancel」。
 *
 * 本文件不 import 任何 expo 模块（`jest.config.js` 是 `testEnvironment: 'node'`，
 * import 了当场炸）—— 那正是 `notify.ts` 被刻意写成纯函数的原因。
 */
import { addDays, localDayAt, type CalendarDay } from '../src/domain/calendar';
import {
  formatSummary,
  isEmptyCounts,
  notificationId,
  parseNotificationId,
  planKeyOf,
  planNotifications,
  reconcile,
  totalCount,
  NOTIFY_ID_PREFIX,
  NOTIFY_TEST_ID_PREFIX,
  type DesiredNotification,
  type NotifyBatch,
  type NotifyCounts,
  type NotifyMedicine,
  type NotifyOptions,
  type NotifySnapshot,
  type PendingNotification,
} from '../src/domain/notify';

const TODAY = '2026-09-22';
/** 默认提醒时刻（§7.5 锁定 09:00）。 */
const HOUR = 9;
const MINUTE = 0;

/**
 * 「现在」= 今天 00:30，**早于 9:00**。这个选择是刻意的：
 * 于是「今天 9:00 那条」是一个未来时刻、会被正常排出来。
 * 想测「过去时刻被挡住」的用例自己把 now 推后（见 `opts({ now })`）。
 */
const NOW = localDayAt(TODAY, 0, 30);

const day = (n: number): CalendarDay => addDays(TODAY, n);

function opts(over: Partial<NotifyOptions> = {}): NotifyOptions {
  return { hour: HOUR, minute: MINUTE, restockDays: 15, horizonDays: 14, now: NOW, ...over };
}

function batch(over: Partial<NotifyBatch> & { batchId: number }): NotifyBatch {
  return { medicineId: 1, status: 'in_stock', effective: null, ...over };
}

/** 默认可推送的「正常药」：开着自动扣减、没暂停、单位不混。 */
function med(over: Partial<NotifyMedicine> & { medicineId: number }): NotifyMedicine {
  return {
    dailyDose: 1,
    autoDeduct: true,
    autoPaused: false,
    totalQty: 0,
    unitConflict: false,
    ...over,
  };
}

function desired(dayStr: CalendarDay, planKey = 'v1|0|0|1|0'): DesiredNotification {
  return {
    id: notificationId(dayStr, HOUR, MINUTE),
    day: dayStr,
    dateMs: localDayAt(dayStr, HOUR, MINUTE),
    title: '药箱：1 件事待处理',
    body: '需补货 1 种',
    planKey,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe('标识符 —— 重排的锚点', () => {
  it('拼出来是 medbox:v1:<day>T<HH:mm>，且能原样解析回来', () => {
    const id = notificationId('2026-09-23', 9, 0);
    expect(id).toBe(`${NOTIFY_ID_PREFIX}2026-09-23T09:00`);
    expect(parseNotificationId(id)).toEqual({ day: '2026-09-23', hour: 9, minute: 0 });
  });

  it('小时与分钟补零 —— 不补的话同一个时刻会有两种 id，重排就认不出来了', () => {
    expect(notificationId('2026-09-23', 8, 5)).toBe(`${NOTIFY_ID_PREFIX}2026-09-23T08:05`);
    expect(parseNotificationId(notificationId('2026-09-23', 8, 5))).toEqual({
      day: '2026-09-23',
      hour: 8,
      minute: 5,
    });
  });

  it('🔴 不是我们的 id 一律返回 null —— 调用方必须当成「别动它」', () => {
    // 别的 App 的、系统生成的、以及自检页那条测试通知，全走这条路。
    // 返回 null 之外的任何东西都会让「最小动作」原则破功（把别人的通知删了）。
    expect(parseNotificationId('')).toBeNull();
    expect(parseNotificationId('some-other-app:123')).toBeNull();
    expect(parseNotificationId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBeNull();
    expect(parseNotificationId(`${NOTIFY_TEST_ID_PREFIX}1789956290628`)).toBeNull();
    expect(parseNotificationId('medbox:v2:2026-09-23T09:00')).toBeNull();
  });

  it('格式对但日期/时间不合法 → 也是 null（不能让坏 id 混进「我们的」集合）', () => {
    expect(parseNotificationId(`${NOTIFY_ID_PREFIX}2026-9-23T09:00`)).toBeNull(); // 月没补零
    expect(parseNotificationId(`${NOTIFY_ID_PREFIX}2026-02-30T09:00`)).toBeNull(); // 2 月没有 30 号
    expect(parseNotificationId(`${NOTIFY_ID_PREFIX}2026-09-23T25:00`)).toBeNull(); // 没有 25 点
    expect(parseNotificationId(`${NOTIFY_ID_PREFIX}2026-09-23T09:60`)).toBeNull(); // 没有 60 分
    expect(parseNotificationId(`${NOTIFY_ID_PREFIX}2026-09-23`)).toBeNull(); // 缺时刻
  });
});

describe('文案与比较键', () => {
  it('title 严格是「药箱：N 件事待处理」，四档合计', () => {
    expect(formatSummary({ dueToday: 2, expired: 0, restock: 1, usedUp: 0 })).toEqual({
      title: '药箱：3 件事待处理',
      body: '今天到期 2 盒，需补货 1 种',
    });
  });

  it('0 的那几档不出现；四档全 0 就是「没有通知」', () => {
    expect(formatSummary({ dueToday: 0, expired: 0, restock: 0, usedUp: 0 })).toEqual({
      title: '药箱：0 件事待处理',
      body: '',
    });
    const counts: NotifyCounts = { dueToday: 0, expired: 3, restock: 0, usedUp: 2 };
    expect(formatSummary(counts).body).toBe('已过期 3 盒，已用完 2 种');
    expect(isEmptyCounts(counts)).toBe(false);
    expect(totalCount(counts)).toBe(5);
    expect(isEmptyCounts({ dueToday: 0, expired: 0, restock: 0, usedUp: 0 })).toBe(true);
  });

  it('planKey 只看四档计数 —— 改文案不该让已排的条目全部重排一次', () => {
    const a: NotifyCounts = { dueToday: 1, expired: 2, restock: 3, usedUp: 4 };
    expect(planKeyOf(a)).toBe('v1|1|2|3|4');
    expect(planKeyOf({ ...a })).toBe(planKeyOf(a)); // 值相同 ⇒ 键相同
    expect(planKeyOf({ ...a, restock: 4 })).not.toBe(planKeyOf(a));
  });
});

describe('planNotifications —— 什么时候产出条目', () => {
  it('空快照 ⇒ 一条都不产出（绝不推「0 件事」）', () => {
    expect(planNotifications({ batches: [], medicines: [] }, TODAY, opts())).toEqual([]);
  });

  it('今天到期：排在今天 9:00；次日再排一条「已过期」', () => {
    const snap: NotifySnapshot = { batches: [batch({ batchId: 7, effective: TODAY })], medicines: [] };
    const out = planNotifications(snap, TODAY, opts());

    expect(out.map((p) => p.day)).toEqual([TODAY, day(1)]);
    expect(out[0].id).toBe(notificationId(TODAY, 9, 0));
    expect(out[0].counts).toEqual({ dueToday: 1, expired: 0, restock: 0, usedUp: 0 });
    expect(out[0].reasons).toEqual([{ kind: 'due', batchId: 7, medicineId: 1 }]);
    expect(out[1].counts).toEqual({ dueToday: 0, expired: 1, restock: 0, usedUp: 0 });
  });

  it('过期很久的批次不再产出 —— 「每事件只推一次」靠的是日期在过去', () => {
    // 提醒日 = 5 天前 ⇒ due 排在过去、expired 排在 4 天前，两条都被挡掉。
    // 没有这条，「已过期」是个永远为真的状态，用户会天天被推。
    const snap: NotifySnapshot = {
      batches: [batch({ batchId: 7, effective: day(-5) })],
      medicines: [],
    };
    expect(planNotifications(snap, TODAY, opts())).toEqual([]);
  });

  it('🔴 进入 90 天快过期窗口**那天不推**，只推到期的绝对日期', () => {
    // 这是最容易被「顺手补上」的一条：`expiry.ts` 的 classify 有 'expiring' 档，
    // 页面也照常显示黄药丸，但推送**刻意**不接它（DESIGN.md §3 第 10 条）。
    // 判据：5 天后到期的药，产出日期只有 day(5) 与 day(6)，**没有今天**。
    const snap: NotifySnapshot = {
      batches: [batch({ batchId: 7, effective: day(5) })],
      medicines: [],
    };
    const out = planNotifications(snap, TODAY, opts({ horizonDays: 90 }));
    expect(out.map((p) => p.day)).toEqual([day(5), day(6)]);
    expect(out.some((p) => p.day === TODAY)).toBe(false);
  });

  it('同一天多件事 ⇒ 只合并成一条，计数相加', () => {
    const snap: NotifySnapshot = {
      batches: [batch({ batchId: 7, effective: day(3) })], // 3 天后到期
      // 另有一味药恰好在同一天跨过阈值：dose 1、库存 18、阈值 15 ⇒ k₀ = 3
      medicines: [med({ medicineId: 42, totalQty: 18 })],
    };
    const out = planNotifications(snap, TODAY, opts());
    // day(3) 一条（到期 + 需补货），day(4) 一条（已过期）
    expect(out.map((p) => p.day)).toEqual([day(3), day(4)]);
    expect(out[0].counts).toEqual({ dueToday: 1, expired: 0, restock: 1, usedUp: 0 });
    expect(out[0].title).toBe('药箱：2 件事待处理');
    expect(out[0].body).toBe('今天到期 1 盒，需补货 1 种');
  });

  it('产出按日期升序，id 与日期/时刻一一对应', () => {
    const snap: NotifySnapshot = {
      batches: [
        batch({ batchId: 1, effective: day(9) }),
        batch({ batchId: 2, effective: day(2) }),
      ],
      medicines: [],
    };
    const out = planNotifications(snap, TODAY, opts());
    expect(out.map((p) => p.day)).toEqual([day(2), day(3), day(9), day(10)]);
    for (const p of out) expect(p.id).toBe(notificationId(p.day, HOUR, MINUTE));
    expect(out.map((p) => p.dateMs)).toEqual([...out.map((p) => p.dateMs)].sort((a, b) => a - b));
  });

  it('未填效期、以及非在库的批次，都不产出', () => {
    const snap: NotifySnapshot = {
      batches: [
        batch({ batchId: 1, effective: null }), // 首页显示灰药丸，但没日期可依
        batch({ batchId: 2, effective: TODAY, status: 'used_up' }),
        batch({ batchId: 3, effective: TODAY, status: 'discarded' }),
      ],
      medicines: [],
    };
    expect(planNotifications(snap, TODAY, opts())).toEqual([]);
  });
});

describe('planNotifications —— 前瞻窗口的边界', () => {
  it('正好落在前瞻最后一天 ⇒ 排；再多一天 ⇒ 不排', () => {
    const inside: NotifySnapshot = {
      batches: [batch({ batchId: 1, effective: day(14) })],
      medicines: [],
    };
    const outside: NotifySnapshot = {
      batches: [batch({ batchId: 1, effective: day(15) })],
      medicines: [],
    };
    expect(planNotifications(inside, TODAY, opts()).map((p) => p.day)).toEqual([day(14)]);
    expect(planNotifications(outside, TODAY, opts())).toEqual([]);
  });

  it('🔴 时刻已过的今天那条不排 —— 原生侧遇到过去时刻会**静默删掉**已有通知', () => {
    // 已核实：`ExpoSchedulingDelegate.scheduleNotification` 在 nextTriggerDate() 为 null 时
    // 走 removeScheduledNotification，**不抛异常**。所以这层防线不是纵深防御、是必需的。
    const snap: NotifySnapshot = {
      batches: [batch({ batchId: 1, effective: TODAY })],
      medicines: [],
    };
    // 今天 10:00 跑，今天 9:00 已经过去 → 只剩明天那条「已过期」
    const late = opts({ now: localDayAt(TODAY, 10, 0) });
    expect(planNotifications(snap, TODAY, late).map((p) => p.day)).toEqual([day(1)]);
    // 今天 8:00 跑 → 两条都在
    const early = opts({ now: localDayAt(TODAY, 8, 0) });
    expect(planNotifications(snap, TODAY, early).map((p) => p.day)).toEqual([TODAY, day(1)]);
  });

  it('提醒时间用的是**本地墙上时间**，不是 UTC（UTC+8 会整整差 8 小时）', () => {
    const snap: NotifySnapshot = {
      batches: [batch({ batchId: 1, effective: day(1) })],
      medicines: [],
    };
    const out = planNotifications(snap, TODAY, opts({ hour: 9, minute: 0 }));
    const d = new Date(out[0].dateMs);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(Number(day(1).slice(8, 10)));
  });
});

describe('planNotifications —— 需补货 / 已用完', () => {
  it('连续模型：dose 0.5、库存 20、阈值 15 ⇒ 第 25 天跨线', () => {
    // 阶梯模型（planSettlement 的 floor(k×dose)）会给出第 10 天 —— 数字完全不同，
    // 所以这条断言真的能分辨两种模型。🔴 前瞻必须用连续模型的理由见模块文件头。
    const snap: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, dailyDose: 0.5, totalQty: 20 })],
    };
    const out = planNotifications(snap, TODAY, opts({ horizonDays: 30 }));
    expect(out.map((p) => p.day)).toEqual([day(25)]);
    expect(out[0].reasons).toEqual([{ kind: 'restock', medicineId: 1 }]);
  });

  it('🔴 不动点：明天再算一次，得到的是**同一个绝对日期**', () => {
    // 这是「纯函数 + 无记忆」能成立的全部前提。今天算出 D+25，
    // 明天库存少 0.5、算出的天数少 1 ⇒ 还是 D+25。日期不动 ⇒ 不会天天重排。
    const todaySnap: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, dailyDose: 0.5, totalQty: 20 })],
    };
    const tomorrowSnap: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, dailyDose: 0.5, totalQty: 19.5 })],
    };
    const a = planNotifications(todaySnap, TODAY, opts({ horizonDays: 30 }));
    const b = planNotifications(tomorrowSnap, day(1), opts({ horizonDays: 30 }));
    expect(a.map((p) => p.day)).toEqual([day(25)]);
    expect(b.map((p) => p.day)).toEqual([day(25)]);
  });

  it('边界是 ≤ 不是 <：库存正好等于阈值那天就算跨线', () => {
    // dose 1、库存 15、阈值 15 ⇒ 今天就已经 ≤ 阈值 ⇒ k₀ = 0 ⇒ 按规则 4 **不推**。
    // （那一天的通知早在上线前就该排过；k=0 时再排就变成天天推。）
    const atThreshold: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, totalQty: 15 })],
    };
    expect(planNotifications(atThreshold, TODAY, opts())).toEqual([]);

    // 多一片就不算跨线 ⇒ 明天跨 ⇒ 排在明天
    const above: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, totalQty: 16 })],
    };
    expect(planNotifications(above, TODAY, opts()).map((p) => p.day)).toEqual([day(1)]);
  });

  it('库存已经归零 ⇒ 两条都不推（k 都是 0，规则 4）', () => {
    const snap: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, totalQty: 0 })],
    };
    expect(planNotifications(snap, TODAY, opts())).toEqual([]);
  });

  it('「已用完」与「需补货」撞在同一天时只算已用完，不重复计数', () => {
    // 库存 5、dose 1、阈值 15：今天就已 ≤ 阈值（k₀ = 0，不推补货），5 天后归零。
    const snap: NotifySnapshot = {
      batches: [],
      medicines: [med({ medicineId: 1, totalQty: 5 })],
    };
    const out = planNotifications(snap, TODAY, opts());
    expect(out.map((p) => p.day)).toEqual([day(5)]);
    expect(out[0].counts).toEqual({ dueToday: 0, expired: 0, restock: 0, usedUp: 1 });
    expect(out[0].body).toBe('已用完 1 种');
  });

  it('🔴 单位混用 / 暂停服药 / 没开自动扣减 / 没设剂量 ⇒ 都不推', () => {
    // 「页面讲状态，推送讲事件」的刻意不对称。这四类药的库存**不随时间变**，
    // 跨线日要么是今天、要么永远是今天 ⇒ 按规则 4 都推不出来。
    // 首页照常显示「该补货」，只是不推。**这不是 bug，别去修它。**
    const snap: NotifySnapshot = {
      batches: [],
      medicines: [
        med({ medicineId: 1, totalQty: 0, unitConflict: true }), // 跨单位求和没意义
        med({ medicineId: 2, totalQty: 0, autoPaused: true }), // 暂停中
        med({ medicineId: 3, totalQty: 0, autoDeduct: false }), // 没开自动扣减
        med({ medicineId: 4, dailyDose: null, totalQty: 0 }), // 没设每日用量
        med({ medicineId: 5, dailyDose: 0, totalQty: 0 }), // 剂量 0
      ],
    };
    expect(planNotifications(snap, TODAY, opts())).toEqual([]);
  });

  it('多味药同一天跨线 ⇒ 一条通知里数「种数」', () => {
    const snap: NotifySnapshot = {
      batches: [],
      medicines: [
        med({ medicineId: 1, totalQty: 16 }), // 明天跨线
        med({ medicineId: 2, totalQty: 16 }),
        med({ medicineId: 3, totalQty: 17 }), // 后天跨线
      ],
    };
    const out = planNotifications(snap, TODAY, opts());
    expect(out.map((p) => p.day)).toEqual([day(1), day(2)]);
    expect(out[0].body).toBe('需补货 2 种');
    expect(out[1].body).toBe('需补货 1 种');
  });
});

describe('reconcile —— 愿望与现状的差集', () => {
  const pendingOf = (list: DesiredNotification[]): PendingNotification[] =>
    list.map((d) => ({ id: d.id, planKey: d.planKey }));

  it('计划没变 ⇒ 常态零写入（create 与 cancel 都是空）', () => {
    const d = [desired(day(1)), desired(day(2), 'v1|1|0|0|0')];
    const r = reconcile(d, pendingOf(d), TODAY);
    expect(r.create).toEqual([]);
    expect(r.cancel).toEqual([]);
    expect(r.keep).toEqual([d[0].id, d[1].id]);
  });

  it('planKey 变了（同一天的事有增减）⇒ 重排那一条', () => {
    const d = [desired(day(1), 'v1|0|0|2|0')];
    const r = reconcile(d, [{ id: d[0].id, planKey: 'v1|0|0|1|0' }], TODAY);
    expect(r.create.map((x) => x.id)).toEqual([d[0].id]);
    expect(r.cancel).toEqual([]);
  });

  it('队列里有、计划里没有、且日期在未来的 ⇒ 取消', () => {
    const stale = desired(day(3));
    const r = reconcile([], [{ id: stale.id, planKey: stale.planKey }], TODAY);
    expect(r.cancel).toEqual([stale.id]);
    expect(r.create).toEqual([]);
  });

  it('🔴 日期是今天（或更早）的一律不 cancel —— 今天该来的提醒不能被自己删掉', () => {
    // 场景：8:50，今天那条 9:00 还躺在队列里，而用户刚把提醒时间从 9:00 改到 8:00
    // ⇒ desired 里没有它了。取消掉就是把今天该来的提醒删了。宁可留一条措辞旧的。
    const todayOne = desired(TODAY);
    const pastOne = desired(day(-2));
    const r = reconcile([], [{ id: todayOne.id, planKey: null }, { id: pastOne.id, planKey: null }], TODAY);
    expect(r.cancel).toEqual([]);
    expect(r.create).toEqual([]);
  });

  it('🔴 解析不出的 id 一律不动（含自检页的测试通知）', () => {
    const r = reconcile(
      [],
      [
        { id: `${NOTIFY_TEST_ID_PREFIX}1789956290628`, planKey: null },
        { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', planKey: null },
        { id: 'other-app:hello', planKey: null },
      ],
      TODAY,
    );
    expect(r.cancel).toEqual([]);
  });

  it('队列为空 ⇒ 全部新建', () => {
    const d = [desired(day(1)), desired(day(2))];
    const r = reconcile(d, [], TODAY);
    expect(r.create.map((x) => x.id)).toEqual([d[0].id, d[1].id]);
    expect(r.cancel).toEqual([]);
    expect(r.keep).toEqual([]);
  });

  it('同 id 但 planKey 为 null（不是我们排的）⇒ 重建，不当成「一样」', () => {
    const d = [desired(day(1))];
    const r = reconcile(d, [{ id: d[0].id, planKey: null }], TODAY);
    expect(r.create.map((x) => x.id)).toEqual([d[0].id]);
  });
});

/**
 * `refreshAll` —— 真机验收扫出来的那个 bug 的回归测试。
 *
 * 背景（2026-09-22，小米8 / API 27）：**重启手机后 `dumpsys alarm` 里本包一条都没有**，
 * 而自检页仍然报「待发 3 条 / 上次重排 正常」。
 *
 * 成因是 `pending` 的来路：`getAllScheduledNotificationsAsync()` 读的是 expo 自己的
 * SharedPreferences 队列（「我们请求过什么」），**不是** `AlarmManager` 真持有什么。
 * 重启清空后者、留下前者 ⇒ 条条 `planKey` 对得上 ⇒ 全部 `keep` ⇒ 零写入 ⇒
 * 那批提醒永远不响，而且**自检页的「重新对齐一次」走同一条路，也修不好自己**。
 *
 * 所以下面第一条 `refreshAll: true` 的那组断言，就是「修好了」的定义。
 * **谁把 refreshAll 去掉或忘了在冷启动传，这几条会立刻变红。**
 */
describe('reconcile —— refreshAll：把「记录还在、闹钟没了」这种状态修回来', () => {
  /** 重启后的真实现场：expo 的记录完好无损（所以 planKey 条条相同）。 */
  const staleAfterReboot = (list: DesiredNotification[]): PendingNotification[] =>
    list.map((d) => ({ id: d.id, planKey: d.planKey }));

  it('🔴 重启后：记录还在、闹钟已空 ⇒ refreshAll 必须全部重发', () => {
    const d = [desired(day(5)), desired(day(9)), desired(day(10))];
    const pending = staleAfterReboot(d);

    // 先钉住「bug 长什么样」：不强制时它认为一切正常，一个字节都不写 ——
    // 而 AlarmManager 里其实什么都没有。修好的关键就在这个对比上。
    const lazy = reconcile(d, pending, TODAY);
    expect(lazy.create).toEqual([]);
    expect(lazy.keep).toHaveLength(3);

    // 冷启动强制重发 ⇒ 三条全部重新排上，且**不 cancel 任何东西**
    const forced = reconcile(d, pending, TODAY, { refreshAll: true });
    expect(forced.create.map((x) => x.id)).toEqual(d.map((x) => x.id));
    expect(forced.cancel).toEqual([]);
    expect(forced.keep).toEqual([]);
  });

  it('refreshAll 不改变 cancel 的语义：陈旧条目照撤，今天那条照留', () => {
    const stale = desired(day(4));
    const todayOne = desired(TODAY);
    const want = [desired(day(1))];
    const r = reconcile(
      want,
      [
        { id: stale.id, planKey: stale.planKey },
        { id: todayOne.id, planKey: todayOne.planKey },
      ],
      TODAY,
      { refreshAll: true },
    );
    expect(r.cancel).toEqual([stale.id]); // 未来的陈旧条目：撤
    expect(r.cancel).not.toContain(todayOne.id); // 铁律 1 不受 refreshAll 影响
  });

  it('refreshAll 也不动自检页的测试通知（铁律 2 不受它影响）', () => {
    const testId = `${NOTIFY_TEST_ID_PREFIX}1789956290628`;
    const r = reconcile([], [{ id: testId, planKey: null }], TODAY, { refreshAll: true });
    expect(r.cancel).toEqual([]);
  });

  it('队列真的是空的时候，refreshAll 与不强制结果一致（不引入额外行为）', () => {
    const d = [desired(day(2))];
    expect(reconcile(d, [], TODAY, { refreshAll: true })).toEqual(reconcile(d, [], TODAY));
  });
});
