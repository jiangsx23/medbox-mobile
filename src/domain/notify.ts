/**
 * 本地通知的调度纯函数 —— M5。DESIGN.md §5.2 / §7.5 在代码上的落点。
 *
 * ── 为什么整个模块是纯的 ───────────────────────────────────────────────
 * `jest.config.js` 是 `testEnvironment: 'node'` 且**刻意不用 jest-expo**，
 * 所以测试里 import 不了任何 expo 模块。这条约束把架构定死了：
 * **智力全放这里（可测），expo 调用只留一层薄壳**（`src/notify/scheduler.ts`）。
 * 本文件不 import expo、不 import drizzle、不自己读时钟 —— 「今天」和「现在」
 * 一律由调用方注入，否则测试会随真实时间漂移（`test/notify-guard.test.ts` 钉住）。
 *
 * ── 节奏：事件驱动、「只说一次」────────────────────────────────────────
 * DESIGN.md §3 第 9/10 条锁死了两件事：
 * - 触发只取**四类**：今天到期 / 已过期 / 需补货 / 已用完。
 *   **不推「首次进入快过期窗口」**（那就是 `classify` 的 `'expiring'` 档）——
 *   不紧急的噪音会让人关掉通知权限，连带把重要的也关掉。
 * - 「每事件只推一次」。这条比它看起来重要：它意味着**持续状态不能天天推**，
 *   而「已过期」「需补货」都天然是持续状态，不处理就永远为真。
 *
 * 实现办法是**给每条提醒找一个绝对日期**（见下），外加一条硬规则：
 * **只排严格晚于「现在」的时刻**。今天那条早在几天前就排好了、不重排，
 * 「持续状态每天重推」就被这条规则挡住了。
 *
 * ── 四条日期规则 ──────────────────────────────────────────────────────
 * | 触发 | 排在哪天 |
 * |---|---|
 * | 今天到期 | 那一盒的 `提醒日` |
 * | 已过期   | `提醒日 + 1`（刚变成已过期的那天） |
 * | 需补货   | `今天 + k₀`，k₀ 见下 |
 * | 已用完   | `今天 + k₁` |
 *
 * 外加：只排落在 `[今天, 今天 + 前瞻天数]` 内、且**时刻晚于现在**的日期。
 * 「需补货 / 已用完」只在 `k ≥ 1` 时排 —— `k == 0` 表示今天就已经低于阈值，
 * 说明它早就跨线了（那一天的提醒在跨线前就排过），再排就会变成天天推。
 *
 * ── 🔴 前瞻必须用「连续模型」，不能抄 `planSettlement` 的阶梯 ────────────
 * `src/domain/autodose.ts` 的 `planSettlement` 用 `Math.floor(days × dose)`
 * 扣减，那是**阶梯**。前瞻**绝不能**照抄，否则这个纯函数就不成立了：
 *
 * > 剂量 0.5、库存 20、阈值 15。阶梯在 25 天里只走 12 步，于是每天重算出的
 * > 「跨线日」都往后滑一天 —— 排在某日的提醒会天天被取消、改到后天，
 * > 直到某天 `k₀` 归零、条目消失，**药真的该补了却一条都没推**。
 *
 * 连续模型（`库存 − k × 剂量`，不 floor）让「跨线日」成为一个**不动点**：
 * 今天算出 `D + k`，明天算出 `(D+1) + (k−1)` —— 同一个绝对日期。
 * 这是「纯函数 + 无记忆」能成立的前提。代价是小数剂量时最多早 1~2 天
 * （阶梯比连续慢），对「该补货了」这种软阈值完全可以接受。
 * `test/notify.test.ts` 有一条不动点测试专门钉住它。
 */

import {
  addDays,
  compareDays,
  isValidDay,
  localDayAt,
  type CalendarDay,
} from './calendar';
import { BATCH_IN_STOCK } from './constants';

// ── 标识符 ──────────────────────────────────────────────────────────────
// 重排靠「稳定标识符」：同 id 重排是**覆盖**（已核实：原生侧走
// SharedPreferences.putString，键就是 identifier），所以只写变化的那几条。

export const NOTIFY_ID_PREFIX = 'medbox:v1:';

/**
 * 测试通知的 id 前缀。**故意让 `parseNotificationId` 解析不出来**，
 * 于是日常重排永远不碰它 —— 否则用户刚在「通知自检」页排的那条测试通知，
 * 会被下一次回前台的重排顺手删掉。
 */
export const NOTIFY_TEST_ID_PREFIX = `${NOTIFY_ID_PREFIX}test:`;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `medbox:v1:2026-09-23T09:00`。界面与薄壳都不许自己拼这个串。 */
export function notificationId(day: CalendarDay, hour: number, minute: number): string {
  return `${NOTIFY_ID_PREFIX}${day}T${pad2(hour)}:${pad2(minute)}`;
}

const ID_RE = /^medbox:v1:(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/**
 * 解析自己的标识符。**解析不出来一律返回 null**，调用方必须把 null 当成
 * 「不是我们的，别动」—— 别的 App 的通知 id、系统自动生成的 UUID、
 * 以及本文件的测试通知都走这条路。
 */
export function parseNotificationId(
  id: string,
): { day: CalendarDay; hour: number; minute: number } | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  if (!isValidDay(m[1])) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return { day: m[1], hour, minute };
}

// ── 输入：库快照（纯数据，不含 drizzle）────────────────────────────────
// 由 `src/notify/snapshot.ts` 从库里读出来。domain 层不认识 `MedboxDb`，
// 这样两边各自干净、且这一层可以在没有数据库的情况下被穷举测试。

export type NotifyBatch = {
  batchId: number;
  medicineId: number;
  /** 批次状态。只有 `in_stock` 的盒才提醒 —— 已用完/已丢弃/已标记过期的都不该吵 */
  status: string;
  /** 提醒日（`effectiveExpiry` 的结果）。null = 未填效期 */
  effective: CalendarDay | null;
};

export type NotifyMedicine = {
  medicineId: number;
  dailyDose: number | null;
  /** 开着自动扣减、且没暂停 —— 库存才会随时间自己减少 */
  autoDeduct: boolean;
  autoPaused: boolean;
  /** 在库合计 */
  totalQty: number;
  /** 在库批次用了不止一种单位 —— 跨单位相加没有意义 */
  unitConflict: boolean;
};

export type NotifySnapshot = {
  batches: readonly NotifyBatch[];
  medicines: readonly NotifyMedicine[];
};

// ── 输出 ────────────────────────────────────────────────────────────────

export type NotifyCounts = {
  /** 那天到期的**盒数** */
  dueToday: number;
  /** 那天刚变成已过期的**盒数** */
  expired: number;
  /** 那天跨过补货阈值的**药种数**（不含当天已用完的，见下） */
  restock: number;
  /** 那天降到 0 的**药种数** */
  usedUp: number;
};

export type NotifyReason =
  | { kind: 'due'; batchId: number; medicineId: number }
  | { kind: 'expired'; batchId: number; medicineId: number }
  | { kind: 'restock'; medicineId: number }
  | { kind: 'usedUp'; medicineId: number };

export type PlannedNotification = {
  /** 稳定标识符，见上 */
  id: string;
  day: CalendarDay;
  /** 该天的本地墙上时刻（epoch 毫秒），直接喂给 DATE 触发器 */
  dateMs: number;
  title: string;
  body: string;
  /** 机器读的比较键。**人读的文案改了不该触发重排**，所以比对用它 */
  planKey: string;
  counts: NotifyCounts;
  /** 这一天为什么被排出来。给测试与调试用，**绝不进通知正文** */
  reasons: NotifyReason[];
};

export type NotifyOptions = {
  hour: number;
  minute: number;
  /** 补货阈值（默认 15），来自 `getThresholds` */
  restockDays: number;
  /** 前瞻天数。见 `NOTIFY_HORIZON_DAYS` 的理由 */
  horizonDays: number;
  /** 现在这个瞬间。**必须注入**，不许在模块里读时钟 */
  now: number;
};

// ── 四档计数与消息文案 ──────────────────────────────────────────────────

export function totalCount(c: NotifyCounts): number {
  return c.dueToday + c.expired + c.restock + c.usedUp;
}

export function isEmptyCounts(c: NotifyCounts): boolean {
  return totalCount(c) === 0;
}

/**
 * 汇总文案。DESIGN.md §7.5 锁死：`title` = 「药箱：N 件事待处理」，
 * `body` 形如「今天到期 2 盒，需补货 1 种」，**0 的那几档不出现**。
 *
 * 🔴 锁屏不显示药名 —— 而这里**结构上就拿不到药名**：入参只有四个数字。
 * 「不泄漏」不是靠纪律，是靠类型（`test/notify.test.ts` 再从外面验一遍）。
 */
export function formatSummary(counts: NotifyCounts): { title: string; body: string } {
  const parts: string[] = [];
  if (counts.dueToday > 0) parts.push(`今天到期 ${counts.dueToday} 盒`);
  if (counts.expired > 0) parts.push(`已过期 ${counts.expired} 盒`);
  if (counts.restock > 0) parts.push(`需补货 ${counts.restock} 种`);
  if (counts.usedUp > 0) parts.push(`已用完 ${counts.usedUp} 种`);
  return { title: `药箱：${totalCount(counts)} 件事待处理`, body: parts.join('，') };
}

/** 只由四档计数决定 ⇒ 改文案不会让已排的条目全部重排一次。 */
export function planKeyOf(counts: NotifyCounts): string {
  return `v1|${counts.dueToday}|${counts.expired}|${counts.restock}|${counts.usedUp}`;
}

// ── 前瞻的两条线 ────────────────────────────────────────────────────────

/**
 * 浮点容差。`Q / dose` 可能算出 `25.000000000000004`，`Math.ceil` 会多给一天。
 * 减掉一个远小于「天」的量即可 —— 减整数与 `ceil` 可交换，所以不动点性质不受影响。
 */
const EPS = 1e-9;

/**
 * 从今天起第几天**第一次**满足「预计可用天数 ≤ 阈值」。0 表示今天就已低于阈值。
 * 连续模型，见文件头「🔴 前瞻必须用连续模型」。
 */
function crossingDay(totalQty: number, dailyDose: number, restockDays: number): number {
  // 求最小 k ≥ 0 使 (Q − k·dose) / dose ≤ R  ⟺  k ≥ Q/dose − R
  return Math.max(0, Math.ceil(totalQty / dailyDose - restockDays - EPS));
}

/** 从今天起第几天库存归零。0 表示今天就已经是 0。 */
function usedUpDay(totalQty: number, dailyDose: number): number {
  return Math.max(0, Math.ceil(totalQty / dailyDose - EPS));
}

// ── 计划 ────────────────────────────────────────────────────────────────

const KIND_ORDER: Record<NotifyReason['kind'], number> = {
  due: 0,
  expired: 1,
  restock: 2,
  usedUp: 3,
};

function reasonId(r: NotifyReason): number {
  return r.kind === 'restock' || r.kind === 'usedUp' ? r.medicineId : r.batchId;
}

/** 顺序确定，免得「同样的内容」因为遍历顺序不同而每次都被判成变了、白写一遍。 */
function compareReasons(a: NotifyReason, b: NotifyReason): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return k !== 0 ? k : reasonId(a) - reasonId(b);
}

function countOf(reasons: readonly NotifyReason[]): NotifyCounts {
  const c: NotifyCounts = { dueToday: 0, expired: 0, restock: 0, usedUp: 0 };
  for (const r of reasons) {
    if (r.kind === 'due') c.dueToday += 1;
    else if (r.kind === 'expired') c.expired += 1;
    else if (r.kind === 'restock') c.restock += 1;
    else c.usedUp += 1;
  }
  return c;
}

/**
 * 产出「未来这些天的这些时刻，各推一条什么」。
 *
 * 返回的每一条都满足：日期在 `[今天, 今天 + horizonDays]` 内、时刻**晚于 `now`**、
 * 至少有一件事。（没有任何事的日子**不产出条目** —— 绝不能推一条「0 件事」。）
 */
export function planNotifications(
  snap: NotifySnapshot,
  today: CalendarDay,
  opts: NotifyOptions,
): PlannedNotification[] {
  const horizonEnd = addDays(today, opts.horizonDays);
  const byDay = new Map<CalendarDay, NotifyReason[]>();

  const add = (day: CalendarDay, r: NotifyReason): void => {
    if (compareDays(day, today) < 0) return; // 过去的日期不排（「只说一次」的兜底）
    if (compareDays(day, horizonEnd) > 0) return; // 超出前瞻
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  };

  // ① 每盒药：今天到期 / 刚过期
  for (const b of snap.batches) {
    if (b.status !== BATCH_IN_STOCK) continue;
    if (b.effective === null) continue; // 未填效期：首页是灰药丸，但没有日期可依
    add(b.effective, { kind: 'due', batchId: b.batchId, medicineId: b.medicineId });
    add(addDays(b.effective, 1), { kind: 'expired', batchId: b.batchId, medicineId: b.medicineId });
  }

  // ② 每味药：需补货 / 已用完。
  // 刻意排除的三类（**页面照常显示「该补货」，只是不推**）：
  //   - 没设每日用量 → §3.5 根本不参与预测
  //   - 没开自动扣减 / 正在暂停 → 库存不随时间变，「跨线日」要么是今天要么永远是今天
  //   - 单位混用 → 跨单位求和没有意义，而且 `planSettlement` 遇到它也不扣
  // 「页面讲状态，推送讲事件」：这类药的库存只在用户手动取用那一刻变（人正拿着
  // 手机），事后推一条没有价值。**别把它当 bug 修** —— 见 DESIGN.md §7.7。
  for (const m of snap.medicines) {
    const dose = m.dailyDose;
    if (dose === null || dose <= 0) continue;
    if (!m.autoDeduct || m.autoPaused) continue;
    if (m.unitConflict) continue;

    const k1 = usedUpDay(m.totalQty, dose);
    const k0 = crossingDay(m.totalQty, dose, opts.restockDays);

    if (k1 >= 1) add(addDays(today, k1), { kind: 'usedUp', medicineId: m.medicineId });
    // 与「已用完」落在同一天时只算「已用完」—— 四档互斥，不重复计数
    if (k0 >= 1 && k0 !== k1) add(addDays(today, k0), { kind: 'restock', medicineId: m.medicineId });
  }

  const days = [...byDay.keys()].sort(compareDays);
  const out: PlannedNotification[] = [];
  for (const day of days) {
    const reasons = byDay.get(day)!.slice().sort(compareReasons);
    const counts = countOf(reasons);
    if (isEmptyCounts(counts)) continue;

    const dateMs = localDayAt(day, opts.hour, opts.minute);
    // 🔴 过去时刻**必须在这里挡住**。原生侧遇到过去的 DATE 触发器不会报错，
    //    而是**静默把那条已有的通知删掉**（已核实 `ExpoSchedulingDelegate`），
    //    于是重排会一边报告「排了 N 条」一边把真实存在的那条弄丢。
    if (dateMs <= opts.now) continue;

    const { title, body } = formatSummary(counts);
    out.push({
      id: notificationId(day, opts.hour, opts.minute),
      day,
      dateMs,
      title,
      body,
      planKey: planKeyOf(counts),
      counts,
      reasons,
    });
  }
  return out;
}

// ── 对账：愿望 vs 现状 ──────────────────────────────────────────────────

/** 排一条通知所需的最小信息（`PlannedNotification` 的子集）。 */
export type DesiredNotification = Pick<
  PlannedNotification,
  'id' | 'day' | 'dateMs' | 'title' | 'body' | 'planKey'
>;

/** 现状里的一条：id + 它自己带着的比较键（存在 `content.data.planKey`）。 */
export type PendingNotification = { id: string; planKey: string | null };

export type ReconcilePlan = {
  create: DesiredNotification[];
  cancel: string[];
  keep: string[];
};

/**
 * 🔴 `refreshAll` —— 为什么必须有这个开关（2026-09-22 真机验收扫出来的真 bug）
 *
 * 上面的「现状」来自 `Notifications.getAllScheduledNotificationsAsync()`。
 * 设计阶段我以为它**就是真相**，于是「读现状顺带自愈」成立。**它在安卓上是假的。**
 *
 * 那个 API 读的是 expo 自己的 **SharedPreferences 队列**
 *（`expo.modules.notifications.SharedPreferencesNotificationsStore.xml`）——
 * 一份「我们**请求过**什么」的账，**不是**「`AlarmManager` 现在**真的**持有什么」。
 * 重启手机时 Android 清空 `AlarmManager`，那份 SharedPreferences **原样留着**。
 *
 * 后果（真机实测，小米8 / API 27）：重启之后 `dumpsys alarm` 里本包**一条都没有**，
 * 而 `pending` 仍返回 3 条、`planKey` 条条相同 ⇒ 全部落 `keep` ⇒
 * **零写入** ⇒ 那 3 条提醒再也不会响，而自检页照样报「待发 3 条 / 上次重排 正常」。
 * 更糟的是「重新对齐一次」走的也是这条路，所以它**修不好自己**。
 *
 * 所以：**一次进程的第一次重排必须无条件重发**（`refreshAll: true`）。
 * 同 id 重发是**覆盖**，天然幂等、不需要先 cancel；而 `planNotifications`
 * 只产出**严格晚于 `now`** 的时刻，所以重发**绝不会**把已经响过的那条再响一次。
 * 这条同时把另外两种「`AlarmManager` 被系统清空」也一起修了：
 * MIUI 杀进程、以及用户在设置里「强行停止」（后者会让 App 进 stopped 状态丢掉全部闹钟）。
 *
 * ⚠️ **不要**把它改成「每次回前台都重发」。稳态（回前台、计划没变）保持零写入
 * 是刻意保留的性质：省电、且让 `keep` 这条语义仍然可测。
 * 重启**必然**伴随一次冷启动，所以只挂冷启动就够了。
 *
 * 三条铁律（与 `refreshAll` 无关，永远成立）：
 *
 * 1. 🔴 **日期是今天（或更早）的，一律不 cancel。**
 *    8:50 时今天那条 9:00 还在队列里，而「愿望」里可能没有它 —— 比如用户刚把
 *    提醒时间从 9:00 改成 8:00，或者小数剂量让跨线日在 ±1 天之间摆动。
 *    取消掉就是**把今天该来的提醒删了**。宁可留一条措辞旧一点的。
 * 2. 🔴 **解析不出来的 id（含测试通知）一律不动。**
 *    别的 App 的、系统生成的 UUID、以及「通知自检」页刚排的那条测试通知。
 * 3. 「看起来一样」= id 相同**且** `planKey` 相同。人的文案改了、
 *    但四档计数没变时，不该让所有已排条目重排一次。
 *
 * 结果：常态**零写入**（计划没变时 create 与 cancel 都是空数组）；`refreshAll` 时
 * 全部 `create`、`cancel` 照旧只列该撤的那些。
 */
export function reconcile(
  desired: readonly DesiredNotification[],
  pending: readonly PendingNotification[],
  today: CalendarDay,
  opts: { refreshAll?: boolean } = {},
): ReconcilePlan {
  const current = new Map(pending.map((p) => [p.id, p]));
  const wanted = new Set(desired.map((d) => d.id));

  const create: DesiredNotification[] = [];
  const keep: string[] = [];
  for (const d of desired) {
    const p = current.get(d.id);
    // refreshAll 时**不看 pending**：那份记录说不了 AlarmManager 的实话，见上
    if (!opts.refreshAll && p !== undefined && p.planKey === d.planKey) keep.push(d.id);
    else create.push(d);
  }

  const cancel: string[] = [];
  for (const p of pending) {
    if (wanted.has(p.id)) continue; // 上面已经处理过
    const parsed = parseNotificationId(p.id);
    if (parsed === null) continue; // 铁律 2
    if (compareDays(parsed.day, today) <= 0) continue; // 铁律 1
    cancel.push(p.id);
  }

  return { create, cancel, keep };
}
