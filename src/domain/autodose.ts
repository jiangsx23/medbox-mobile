/**
 * 自动扣减结算 —— 自 `medbox-app/app/services/autodose.py` 移植，**改成纯函数**。
 *
 * ── 为什么是纯函数 ─────────────────────────────────────────────────────
 * 结算是这个项目里最危险的一段：算错了用户看不出来，而且它**会真的改库存**。
 * 网页版把「读库 + 规则 + 写库」写在一个函数里，想测规则就得连库跑。
 * 这里拆成「给我药的参数、在库批次、今天 —— 还你一份结算方案」，
 * 于是整套规则在 node 里就能单测（`test/autodose.test.ts`），
 * 落库那一半缩成 `src/data/stock.ts` 里十几行没有分支的胶水。
 *
 * ── 三条最容易搬错的规则 ───────────────────────────────────────────────
 * 1. **账本是一对**（不变量 5）：`autoFrom`（起算日）与 `autoAccounted`
 *    （已核算消耗量）必须一起改。只改一个会静默漏扣或重复扣。
 *    所以本模块只通过 `Settlement` 同时交出这两个值，调用方没有单独改的途径。
 * 2. **取用与编辑的方向相反**（requirements.md §3.6）：取用是*报告消耗*
 *    （累加账本、**不动起算日**），编辑数量是*纠正账本*（以今天为新起算日）。
 *    见 `afterTake()` 与 `planRebaseline()` 的注释。
 * 3. **断货期不计消耗**：库存见底就把起算日推到今天，补货后从那天重新算。
 *    否则「断货 20 天」会在补货那一刻被当成吃了 20 天，一次扣掉一大笔。
 */
import { compareDays, diffDays, type CalendarDay } from './calendar';
import { BATCH_USED_UP } from './constants';
import { effectiveExpiry } from './expiry';
import { formatDose } from './forecast';

/** 「无穷远」的日历日：未填效期的盒排到最后用。 */
const MAX_DAY: CalendarDay = '9999-12-31';

/** 结算只读这几个字段 —— 不绑 drizzle 的行类型，测试里造起来不用凑全字段。 */
export type AutoMedicine = {
  id: number;
  autoDeduct: boolean;
  autoPaused: boolean;
  dailyDose: number | null;
  autoFrom: CalendarDay | null;
  autoAccounted: number;
};

export type AutoBatch = {
  id: number;
  qty: number;
  unit: string;
  expiryDate: CalendarDay | null;
  openedAt: CalendarDay | null;
  openLifeDays: number | null;
  /** 排序的最后一道保险，见 `compareFefo` */
  createdAt: number;
};

/** 一次结算要从某一盒扣走多少。 */
export type Take = {
  batchId: number;
  amount: number;
  qtyAfter: number;
  /** 扣到 0 了 —— 状态要跟着转「已用完」 */
  usedUp: boolean;
};

/**
 * 结算方案。**没有副作用**：调用方照着它改批次、写事件、落账本即可。
 *
 * 注意 `autoFrom` / `autoAccounted` 即使「什么都没发生」也会带上原值 ——
 * 让调用方无条件写回，省掉一个「要不要写」的分支（写回原值本来就是幂等的）。
 */
export type Settlement = {
  takes: Take[];
  totalTaken: number;
  autoFrom: CalendarDay | null;
  autoAccounted: number;
  /** 写入时间线的原因文本；没扣到东西时为 null */
  reason: string | null;
  /** 因为跨单位而**放弃**结算 —— 界面要说明原因，否则像是没生效 */
  skippedByUnitConflict: boolean;
};

/**
 * 从起算日起 `days` 天，累计应消耗与已核算之差（可能为 0）。
 *
 * ```
 * 待扣量 = max(0, floor(天数 × 每日用量) − 已核算消耗量)
 * ```
 *
 * 小数的零头靠「每次都从起算日重算」天然累计，不需要额外存余数 ——
 * 每天 0.5 片时，第 1 天 floor(0.5)=0 不扣，第 2 天 floor(1.0)=1 扣 1，
 * 库存永远是整数（不变量 6）。
 *
 * `toFixed(6)` 那一步是挡浮点误差：`0.29 * 100` 在 IEEE754 下是
 * `28.999999999999996`，不修就会少扣一片。
 */
export function pendingDeduction(days: number, dailyDose: number, accounted: number): number {
  if (days <= 0 || dailyDose <= 0) return 0;
  const ideal = Number((days * dailyDose).toFixed(6));
  return Math.max(0, Math.floor(ideal) - accounted);
}

/** 在库批次用了不止一种单位 —— 此时 sum(qty) 是跨单位相加，没有意义，不能扣。 */
export function unitsConflict(batches: readonly AutoBatch[]): boolean {
  return new Set(batches.map((b) => b.unit)).size > 1;
}

/**
 * 先扣最快过期的。
 *
 * 已过期 / 未填效期的排到最后，**只要还有正常盒就不动它们** ——
 * 否则首页那个红色「已过期」药丸会自己悄悄消失，用户注意不到还有盒药要处理。
 *
 * 末两项 `createdAt` / `id` 是必需的：效期可能全部为空且完全相等
 * （真实数据里二甲双胍的 3 个批次就是），只按提醒日排的话「扣哪盒」会随
 * 查询返回的物理顺序跳变，时间线上前后对不上账。
 */
function compareFefo(a: AutoBatch, b: AutoBatch, today: CalendarDay): number {
  const ea = effectiveExpiry(a);
  const eb = effectiveExpiry(b);
  const da = ea === null || compareDays(ea, today) < 0;
  const db = eb === null || compareDays(eb, today) < 0;
  if (da !== db) return da ? 1 : -1; // 该排到最后的往后
  const cmp = compareDays(ea ?? MAX_DAY, eb ?? MAX_DAY);
  if (cmp !== 0) return cmp;
  return a.createdAt - b.createdAt || a.id - b.id;
}

/** 原地不动：返回药当前的账本值，不产生任何扣减。 */
function untouched(med: AutoMedicine, skippedByUnitConflict = false): Settlement {
  return {
    takes: [],
    totalTaken: 0,
    autoFrom: med.autoFrom,
    autoAccounted: med.autoAccounted,
    reason: null,
    skippedByUnitConflict,
  };
}

/**
 * 只把起算日推到今天、账本归零，**不扣任何东西**。
 *
 * 两个地方用它，语义是同一个：「这段账算不出来（或不该算），那就从今天重新开始」——
 * - `planSettlement` 内部：起算日没初始化 / 在未来，或者库存见底（断货期不计消耗）
 * - **「暂停后恢复服药」**（`planResume`）：停药那段整个作废
 *
 * ⚠️ 它**故意不收 `batches`**：这里根本没有「可扣的库存」这回事。
 * 「只重设、不结清」这条路径拿不到库存，也就**想结清都结不成** ——
 * 靠类型而不是靠纪律。这正是从 `planRebaseline` 里把这个用途拆出来的理由。
 */
export function rebaselineNoSettle(today: CalendarDay): Settlement {
  return { takes: [], totalTaken: 0, autoFrom: today, autoAccounted: 0, reason: null, skippedByUnitConflict: false };
}

/** 写进事件原因里的 `MM/DD`（与网页版 `{:%m/%d}` 同格式）。 */
function monthDay(day: CalendarDay): string {
  return `${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

/**
 * 结算一种药 —— `services/autodose.py::settle_medicine` 的纯函数版。
 *
 * 六个提前返回分支的顺序**必须**照搬，它们互相之间有依赖：
 * 先看「参不参与」，再看「起算日有没有被改坏」，然后才看库存与待扣量。
 */
export function planSettlement(
  med: AutoMedicine,
  batches: readonly AutoBatch[],
  today: CalendarDay,
): Settlement {
  // 没开自动扣减 / 暂停服药期间不扣 —— 此时**连起算日都不动**，
  // 因为「暂停」的意图是这段时间整个作废，不是把账推到今天重来。
  if (!med.autoDeduct || med.autoPaused) return untouched(med);
  if (med.dailyDose === null || med.dailyDose <= 0) return untouched(med);

  // 未初始化，或系统时间被改到了起算日之前 —— 重设到今天就别扣了
  if (med.autoFrom === null || compareDays(med.autoFrom, today) > 0) return rebaselineNoSettle(today);

  // 跨单位相加是错的，宁可不扣（详情页会显示原因）
  if (unitsConflict(batches)) return untouched(med, true);

  const stock = batches.reduce((s, b) => s + b.qty, 0);
  // 断货期不计消耗：没药吃的日子作废，补货后从那天重新算
  if (stock <= 0) return rebaselineNoSettle(today);

  const need = pendingDeduction(diffDays(med.autoFrom, today), med.dailyDose, med.autoAccounted);
  if (need <= 0) return untouched(med);

  const take = Math.min(need, stock);
  const start = med.autoFrom;
  const ordered = [...batches].sort((a, b) => compareFefo(a, b, today));

  const takes: Take[] = [];
  let remaining = take;
  for (const b of ordered) {
    if (remaining <= 0) break;
    const n = Math.min(b.qty, remaining);
    remaining -= n;
    takes.push({ batchId: b.id, amount: n, qtyAfter: b.qty - n, usedUp: b.qty - n === 0 });
  }

  // 库存见底、不够扣：剩下的欠账作废，断货期从今天起算
  const short = take < need;
  return {
    takes,
    totalTaken: take,
    autoFrom: short ? today : med.autoFrom,
    autoAccounted: short ? 0 : med.autoAccounted + take,
    reason: `自动扣减 ${monthDay(start)}–${monthDay(today)}（每日用量 ${formatDose(med.dailyDose)}）`,
    skippedByUnitConflict: false,
  };
}

/**
 * 先按**调用时的参数**把手上的库存结清，再把起算日推到今天、账本归零。
 * **唯一**允许重设账本的地方。
 *
 * 用于 入库 / 恢复在库 / 编辑数量 / 改每日用量 —— 这些场景旧账是真实发生过的，
 * 一笔勾销会让系统以为「少吃了几片」，可用天数偏大。
 *
 * ⚠️ 调用方必须在**赋新值之前**调用，否则会拿新参数去结旧账
 * （把每日用量 1 改成 2 时，会按 2 重算过去 N 天，一次补扣一大笔）。
 *
 * ⚠️ 「**不**结清的重设」不在这个函数里，那是 `rebaselineNoSettle(today)`。
 * 这里曾经有一个 `settleFirst` 布尔参数，拆掉是因为：它的 6 个生产调用点
 * **全都传 `true`**（一个永远为真的参数在调用点上不携带信息，只招人来传错），
 * 而唯一该传 `false` 的用途是「恢复服药」—— 那一支的执行体根本不读 `batches`，
 * 收下库存参数只会让人以为它读了。
 */
export function planRebaseline(
  med: AutoMedicine,
  batches: readonly AutoBatch[],
  today: CalendarDay,
): Settlement {
  const base = planSettlement(med, batches, today);
  // 结算自己也可能重设（扣不够时），但结果与这里一致，直接覆盖
  return { ...base, autoFrom: today, autoAccounted: 0 };
}

/**
 * 手动「取用」k 个单位：**累加进账本，不动起算日**。
 *
 * 这里不能像「编辑数量」那样重设起算日 —— 当天那一片可能已经被自动扣过了，
 * 重设会让次日再扣一次，同一片算两次。累加则与「结算有没有在这个操作之前跑过」无关。
 *
 * 没开自动扣减的药返回 null（账本对它没有意义，不写）。
 */
export function afterTake(
  med: AutoMedicine,
  amount: number,
): { autoFrom: CalendarDay | null; autoAccounted: number } | null {
  if (!med.autoDeduct) return null;
  return { autoFrom: med.autoFrom, autoAccounted: med.autoAccounted + amount };
}

/** 结算把一盒扣到 0 时，状态跟着转「已用完」（§2.4 状态机里唯一的系统自动变更）。 */
export const USED_UP_STATUS = BATCH_USED_UP;
