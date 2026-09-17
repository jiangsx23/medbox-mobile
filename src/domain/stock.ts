/**
 * 库存操作的**规则** —— 自 `medbox-app/app/routes/batches.py` 移植，改成纯函数。
 *
 * 七个操作（入库 / 取用 / 用完 / 丢弃 / 标记过期 / 恢复在库 / 编辑）在这里
 * 只做一件事：**给定操作前的状态，算出「该改哪些行、该写哪条事件、账本落到哪」**。
 * 一行都不落库（落库见 `src/data/stock.ts`），所以每条规则的边界都能单测。
 *
 * ── 每个操作都必须写一条变动记录（不变量 1、8）──────────────────────────
 * 「真实数量只由真实事件改变」。`patches` 里改了 `qty` 却忘了 `events` 里
 * 配一条，就是账实不符 —— 这是本模块存在的全部理由。
 *
 * ── 与自动扣减的耦合点（requirements.md §3.6）──────────────────────────
 * 五个操作要动药的账本，**方向各不相同**，全在下面的注释里标了「账本：」：
 *
 * | 操作 | 对起算日 | 对已核算消耗量 |
 * |---|---|---|
 * | 入库 | 推到今天 | 归零 |
 * | 取用 | **不动** | +k |
 * | 用完 / 丢弃 | 推到今天 | 归零 |
 * | 恢复在库 | 推到今天 | 归零 |
 * | 编辑数量 | 推到今天 | 归零 |
 * | 标记过期 | —— 完全不碰（数量没变） | |
 *
 * 顺序也是规则的一部分：**结算必须在改状态/改数量之前算**，
 * 否则结算读到的是新值，等于用新库存去结旧账。下面每个函数里都标了「顺序：」。
 */
import { isValidDay, parseDay, type CalendarDay } from './calendar';
import {
  BATCH_DISCARDED,
  BATCH_EXPIRED,
  BATCH_IN_STOCK,
  BATCH_USED_UP,
  EVENT_AUTO,
  EVENT_DISCARD,
  EVENT_EDIT,
  EVENT_IN,
  EVENT_MARK_EXPIRED,
  EVENT_RESTOCK,
  EVENT_TAKE,
  EVENT_USED_UP,
} from './constants';
import {
  afterTake,
  planRebaseline,
  planSettlement,
  type AutoBatch,
  type AutoMedicine,
  type Settlement,
} from './autodose';

// ── 方案的形状 ─────────────────────────────────────────────────────────

/** 一条待写入的变动记录。 */
export type EventDraft = {
  /**
   * `null` = **即将被创建的那一盒**。只有入库会用到：事件内容完全由表单决定，
   * 不依赖数据库生成的 id，所以不必等落库之后再补 —— 落库时把它换成新 id 即可。
   */
  batchId: number | null;
  type: string;
  deltaQty: number;
  qtyAfter: number;
  reason: string | null;
};

export type NewBatchDraft = {
  medicineId: number;
  ownerId: number | null;
  qty: number;
  unit: string;
  expiryDate: CalendarDay | null;
  openedAt: CalendarDay | null;
  openLifeDays: number | null;
  location: string | null;
  notes: string | null;
  status: string;
};

/** 批次上可以被操作改动的字段。 */
export type BatchPatch = Partial<Omit<NewBatchDraft, 'medicineId'>>;

export type Plan = {
  /** 入库才有 */
  create?: NewBatchDraft;
  /** 要改的已有批次：结算扣减 + 本次操作本身，可能同时存在 */
  patches: { id: number; patch: BatchPatch }[];
  /** 账本改动。**必须成对**（不变量 5），所以两个值总是一起出现 */
  ledger?: { medicineId: number; autoFrom: CalendarDay | null; autoAccounted: number };
  events: EventDraft[];
};

/** 校验失败时按字段收集**全部**问题，一次告诉用户，别让他一个个试（§3.2）。 */
export type OpResult = { ok: true; plan: Plan } | { ok: false; errors: Record<string, string> };

/**
 * 操作需要的药品字段 = 结算要的那几个 + 入库时要继承的两个。
 * 由 `AutoMedicine` 派生而非另起炉灶，保证传给 `planSettlement` 时不会缺字段。
 */
export type StockMedicine = AutoMedicine & {
  unit: string | null;
  ownerId: number | null;
};

export type OpContext = {
  medicine: StockMedicine;
  /** 该药**当前**在库且有量的批次（`status = in_stock && qty > 0`），结算用 */
  inStock: readonly AutoBatch[];
  today: CalendarDay;
};

// ── 表单值的解析与校验 ─────────────────────────────────────────────────

/** 表单一律以字符串进来（文本框给什么就是什么），在这里收口成领域值。 */
export type IntakeForm = {
  qty: string;
  expiryDate: string;
  openedAt: string;
  openLifeDays: string;
  location: string;
  notes: string;
};

/** 编辑比入库多问两个字段：单位和归属（入库时它们继承自药品档案）。 */
export type EditForm = IntakeForm & { unit: string; ownerId: string };

/**
 * 整数解析。`allowZero=false` 时 0 也算非法（入库必须 > 0，§3.2）。
 * 非法返回 null —— 不含「悄悄当成 0」这种兜底，那会让用户以为填成功了。
 */
export function parseQty(raw: string, allowZero: boolean): number | null {
  const s = (raw ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && (allowZero || n > 0) ? n : null;
}

/** 可选整数：空 = 不填（返回 undefined），非空但非法 = 报错（返回 null）。 */
function parseOptionalInt(raw: string): number | null | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

/**
 * 可选日历日：空 = 不填，非空但非法 = 报错。
 *
 * ⚠️ 这里**刻意偏离网页版**：网页版 `_parse_date` 遇到非法日期返回 None，
 * 也就是**悄悄丢掉**（用户填了「2026/9/1」会以为存上了）。
 * 手机上日期用选择器填，正常不会走到这条路；正因如此，一旦走到就说明
 * 有 bug，报错比静默丢弃更该发生。
 */
function parseOptionalDay(raw: string): CalendarDay | null | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  return isValidDay(s) ? parseDay(s) : null;
}

/** 空字符串 → null（数据库里「没填」统一是 NULL，不是空串）。 */
function orNull(s: string): string | null {
  return (s ?? '').trim() || null;
}

/** 时间线原因里怎么显示一个值（照抄网页版：空值写「空」）。 */
function show(v: string | number | null): string {
  return v === null || v === undefined ? '空' : String(v);
}

/** 字段中文名，编辑事件的原因文本要用（照抄网页版 `_FIELD_LABELS`）。 */
const FIELD_LABELS: Record<string, string> = {
  qty: '数量',
  unit: '单位',
  expiryDate: '印刷效期',
  openedAt: '拆封日期',
  openLifeDays: '开封天数',
  ownerId: '归属',
  location: '位置',
  notes: '备注',
};

/**
 * 把结算结果并进方案（扣减批次 + 自动扣减事件 + 账本）。
 *
 * 账本与当前值完全相同时不写 —— 否则每次冷启动结算都会把 6 个药的档案行
 * 无谓地重写一遍。真正需要落库的是「起算日被推到今天」和「归零」这类变化。
 */
function applySettlement(plan: Plan, s: Settlement, ctx: OpContext): Plan {
  for (const t of s.takes) {
    pushPatch(plan, t.batchId, t.usedUp ? { qty: 0, status: BATCH_USED_UP } : { qty: t.qtyAfter });
    plan.events.push({
      batchId: t.batchId,
      // §2.4：自动扣减把一盒扣到 0 时，状态转「已用完」是系统唯一自动做的状态变更
      type: EVENT_AUTO,
      deltaQty: -t.amount,
      qtyAfter: t.qtyAfter,
      reason: s.reason,
    });
  }
  const med = ctx.medicine;
  if (s.autoFrom !== med.autoFrom || s.autoAccounted !== med.autoAccounted) {
    plan.ledger = { medicineId: med.id, autoFrom: s.autoFrom, autoAccounted: s.autoAccounted };
  }
  return plan;
}

/** 同一个批次可能既被结算扣、又被本次操作改 —— 合并成一条 patch，后者覆盖前者。 */
function pushPatch(plan: Plan, id: number, patch: BatchPatch): void {
  const existing = plan.patches.find((p) => p.id === id);
  if (existing) Object.assign(existing.patch, patch);
  else plan.patches.push({ id, patch });
}

function withoutBatch(list: readonly AutoBatch[], id: number): AutoBatch[] {
  return list.filter((b) => b.id !== id);
}

// ── 入库（新增一盒）────────────────────────────────────────────────────
/**
 * 入口：药品详情的「＋ 再入库一盒」、首页需补货的「去补货」。
 *
 * 表单只问 数量 / 印刷效期 / 拆封日期 / 开封后有效期 / 存放位置 / 备注 ——
 * **不再问单位和归属**，它们从药品档案继承（§3.2）。想改就先去编辑档案。
 *
 * 账本：先用手上现有的库存（**还不含这一批**）把欠的账结清，再从今天重新起算。
 * 不能只看「入库前在库量是否为 0」来判断要不要重置 —— 断货期间一直没打开 App 时，
 * 系统仍以为有库存，那样会在补货这一刻一次性补扣掉整段断货期。
 */
export function planIntake(ctx: OpContext, form: IntakeForm): OpResult {
  const errors: Record<string, string> = {};

  const qty = parseQty(form.qty, false);
  if (qty === null) errors.qty = '数量：请填大于 0 的整数';

  // 单位取自药品档案，不在入库页重复问
  const unit = ctx.medicine.unit?.trim() ?? '';
  if (!unit) errors.unit = '该药品档案还没填单位，请先到「编辑档案」补上';

  const expiryDate = parseOptionalDay(form.expiryDate);
  if (expiryDate === null) errors.expiryDate = '印刷效期：格式应为 2026-09-15';
  const openedAt = parseOptionalDay(form.openedAt);
  if (openedAt === null) errors.openedAt = '拆封日期：格式应为 2026-09-15';
  const openLifeDays = parseOptionalInt(form.openLifeDays);
  if (openLifeDays === null) errors.openLifeDays = '开封后天数：请填整数';
  else if (openLifeDays !== undefined && openLifeDays <= 0) {
    errors.openLifeDays = '开封后天数：请填大于 0 的整数';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const plan: Plan = { patches: [], events: [] };
  // 先用手上现有的库存结清，再重设起算日 —— 注意用的是 ctx.inStock，
  // 里面**不含**这一批新货（它还没建出来）
  applySettlement(plan, planRebaseline(ctx.medicine, ctx.inStock, ctx.today, true), ctx);

  plan.create = {
    medicineId: ctx.medicine.id,
    // 归属继承自药品档案；null = 家庭共用
    ownerId: ctx.medicine.ownerId,
    qty: qty!,
    unit,
    expiryDate: expiryDate ?? null,
    openedAt: openedAt ?? null,
    openLifeDays: openLifeDays ?? null,
    location: orNull(form.location),
    notes: orNull(form.notes),
    status: BATCH_IN_STOCK,
  };
  plan.events.push({
    batchId: null,
    type: EVENT_IN,
    deltaQty: qty!,
    qtyAfter: qty!,
    reason: '入库',
  });

  return { ok: true, plan };
}

// ── 取用（减量）────────────────────────────────────────────────────────
/**
 * 账本：**累加已核算消耗量，不动起算日**。取用是「报告消耗」——
 * 当天那一片可能已经被自动扣过了，重设起算日会让次日再扣一次。
 * 累加则与「结算有没有在这个操作之前跑过」无关（§3.6）。
 */
export function planTake(
  ctx: OpContext,
  batch: { id: number; qty: number; unit: string; status: string },
  amountRaw: string,
  reason: string,
): OpResult {
  if (batch.status !== BATCH_IN_STOCK) {
    return { ok: false, errors: { _: '这一盒已经不在库了，不能再取用。' } };
  }
  const amount = parseQty(amountRaw, false);
  if (amount === null) return { ok: false, errors: { amount: '取用数量：请填大于 0 的整数' } };
  if (amount > batch.qty) {
    return {
      ok: false,
      errors: { amount: `取用数量（${amount}）不能超过现有的 ${batch.qty} ${batch.unit}` },
    };
  }

  const plan: Plan = { patches: [], events: [] };
  const qtyAfter = batch.qty - amount;
  pushPatch(plan, batch.id, { qty: qtyAfter });
  plan.events.push({
    batchId: batch.id,
    type: EVENT_TAKE,
    deltaQty: -amount,
    qtyAfter,
    reason: orNull(reason),
  });

  const ledger = afterTake(ctx.medicine, amount);
  if (ledger) plan.ledger = { medicineId: ctx.medicine.id, ...ledger };

  return { ok: true, plan };
}

// ── 用完 / 丢弃 / 标记过期 / 恢复在库 ──────────────────────────────────

/**
 * 用完。数量归 0，状态转「已用完」。
 *
 * 账本：这盒已经不在库了，用**剩下的批次**把欠账结清，再从今天重新起算。
 * 顺序：先归零，再结算 —— 结算要看到的是「这盒已经不在了」之后的库存。
 */
export function planUsedUp(
  ctx: OpContext,
  batch: { id: number; qty: number; status: string },
): OpResult {
  if (batch.status !== BATCH_IN_STOCK) {
    return { ok: false, errors: { _: '这一盒已经不在库了。' } };
  }
  const plan: Plan = { patches: [], events: [] };
  pushPatch(plan, batch.id, { qty: 0, status: BATCH_USED_UP });
  plan.events.push({
    batchId: batch.id,
    type: EVENT_USED_UP,
    deltaQty: -batch.qty,
    qtyAfter: 0,
    reason: '用完',
  });
  const settle = planRebaseline(ctx.medicine, withoutBatch(ctx.inStock, batch.id), ctx.today, true);
  applySettlement(plan, settle, ctx);
  return { ok: true, plan };
}

/** 丢弃。与用完同形，区别是原因由用户填（可不填）。 */
export function planDiscard(
  ctx: OpContext,
  batch: { id: number; qty: number; status: string },
  reason: string,
): OpResult {
  if (batch.status !== BATCH_IN_STOCK) {
    return { ok: false, errors: { _: '这一盒已经不在库了。' } };
  }
  const plan: Plan = { patches: [], events: [] };
  pushPatch(plan, batch.id, { qty: 0, status: BATCH_DISCARDED });
  plan.events.push({
    batchId: batch.id,
    type: EVENT_DISCARD,
    deltaQty: -batch.qty,
    qtyAfter: 0,
    reason: orNull(reason),
  });
  const settle = planRebaseline(ctx.medicine, withoutBatch(ctx.inStock, batch.id), ctx.today, true);
  applySettlement(plan, settle, ctx);
  return { ok: true, plan };
}

/**
 * 标记过期。**数量不变**（§2.4：药可能还在用，只是不能吃了）。
 * 因此**完全不碰账本** —— 库存没变，就没有要结的账。
 */
export function planMarkExpired(
  ctx: OpContext,
  batch: { id: number; qty: number; status: string },
): OpResult {
  if (batch.status !== BATCH_IN_STOCK) {
    return { ok: false, errors: { _: '这一盒已经不在库了。' } };
  }
  const plan: Plan = { patches: [], events: [] };
  pushPatch(plan, batch.id, { status: BATCH_EXPIRED });
  plan.events.push({
    batchId: batch.id,
    type: EVENT_MARK_EXPIRED,
    deltaQty: 0,
    qtyAfter: batch.qty,
    reason: '标记过期',
  });
  return { ok: true, plan };
}

/**
 * 恢复在库。数量不变，状态转回在库。
 *
 * 顺序：**必须在把状态改回在库之前结算** —— 恢复只改状态、数量不变，
 * 结算要看到的是「恢复之前」的在库量，否则这次恢复的货会被当成旧货一起扣。
 */
export function planRestock(
  ctx: OpContext,
  batch: { id: number; qty: number; status: string },
): OpResult {
  if (batch.status === BATCH_IN_STOCK) {
    return { ok: false, errors: { _: '这一盒本来就在库。' } };
  }
  if (batch.qty <= 0) {
    // 已用完 / 已丢弃的盒数量是 0（不变量 3），恢复回在库就成了「在库且为 0」，
    // 违反不变量 4。网页版没有拦这一步，App 上拦掉并说清怎么办。
    return {
      ok: false,
      errors: { _: '这一盒的数量是 0，恢复在库前请先用「编辑」把数量改回大于 0。' },
    };
  }
  const plan: Plan = { patches: [], events: [] };
  // 结算要用「恢复之前」的在库清单：此刻这一盒还不在里面
  const settle = planRebaseline(ctx.medicine, ctx.inStock, ctx.today, true);
  applySettlement(plan, settle, ctx);
  pushPatch(plan, batch.id, { status: BATCH_IN_STOCK });
  plan.events.push({
    batchId: batch.id,
    type: EVENT_RESTOCK,
    deltaQty: 0,
    qtyAfter: batch.qty,
    reason: '恢复在库',
  });
  return { ok: true, plan };
}

// ── 编辑纠错 ───────────────────────────────────────────────────────────
/**
 * 全字段编辑。与其它操作的区别：**它连单位和归属都能改**（入库时不能）。
 *
 * 账本：改了数量 = 纠正账本 —— **先按旧数量结清，再以今天为新起算日**。
 * 顺序：结算必须在赋值之前算，否则会拿新数量去结旧账。
 *
 * ⚠️ **刻意偏离网页版**：把在库批次的数量改成 0 时，状态一并转「已用完」。
 * 网页版允许「在库且数量为 0」，违反不变量 4；而「改到 0」这个事实与
 * 自动扣减扣到 0 是同一件事，按 §2.4 状态机本来就该转「已用完」。
 * 不这么做的话，首页会多出一盒「在库 0 片」的幽灵药盒。
 */
export function planEdit(
  ctx: OpContext,
  batch: {
    id: number;
    qty: number;
    unit: string;
    status: string;
    expiryDate: CalendarDay | null;
    openedAt: CalendarDay | null;
    openLifeDays: number | null;
    ownerId: number | null;
    location: string | null;
    notes: string | null;
  },
  form: EditForm,
): OpResult {
  const errors: Record<string, string> = {};

  const qty = parseQty(form.qty, true);
  if (qty === null) errors.qty = '数量：请填大于等于 0 的整数';

  const unit = (form.unit ?? '').trim();
  if (!unit) errors.unit = '单位：请选择或填写单位';

  const expiryDate = parseOptionalDay(form.expiryDate);
  if (expiryDate === null) errors.expiryDate = '印刷效期：格式应为 2026-09-15';
  const openedAt = parseOptionalDay(form.openedAt);
  if (openedAt === null) errors.openedAt = '拆封日期：格式应为 2026-09-15';
  const openLifeDays = parseOptionalInt(form.openLifeDays);
  if (openLifeDays === null) errors.openLifeDays = '开封后天数：请填整数';

  const ownerRaw = (form.ownerId ?? '').trim();
  let ownerId: number | null = null;
  if (ownerRaw) {
    if (!/^-?\d+$/.test(ownerRaw)) errors.ownerId = '归属：请从列表中选择';
    else ownerId = Number(ownerRaw);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const next = {
    qty: qty!,
    unit,
    expiryDate: expiryDate ?? null,
    openedAt: openedAt ?? null,
    openLifeDays: openLifeDays ?? null,
    ownerId,
    location: orNull(form.location),
    notes: orNull(form.notes),
  };
  const prev = {
    qty: batch.qty,
    unit: batch.unit,
    expiryDate: batch.expiryDate,
    openedAt: batch.openedAt,
    openLifeDays: batch.openLifeDays,
    ownerId: batch.ownerId,
    location: batch.location,
    notes: batch.notes,
  };

  const plan: Plan = { patches: [], events: [] };

  // 手动改数量 = 纠正账本。放在写新值之前，结算读到的才是旧数量。
  if (next.qty !== prev.qty) {
    applySettlement(plan, planRebaseline(ctx.medicine, ctx.inStock, ctx.today, true), ctx);
  }

  const patch: BatchPatch = { ...next };
  // 在库批次的状态**显式写出来**，哪怕没变 —— 因为上面那次结算也可能 patch 同一行。
  // `pushPatch` 是按字段合并、后者覆盖前者，这里不写的话，结算把这一盒扣到 0 时
  // 留下的 `status: used_up` 会活下来，于是出现「已用完但还有 20 片」。
  // 实际很难触发（闸门在任何界面渲染前就结算过了），但两处写同一行的字段，
  // 该由谁定就该由谁写清楚。
  if (batch.status === BATCH_IN_STOCK) {
    patch.status = next.qty === 0 ? BATCH_USED_UP : BATCH_IN_STOCK;
  }
  pushPatch(plan, batch.id, patch);

  const changes: string[] = [];
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (prev[k] !== next[k]) {
      changes.push(`${FIELD_LABELS[k]}: ${show(prev[k])}→${show(next[k])}`);
    }
  }
  if (changes.length > 0) {
    plan.events.push({
      batchId: batch.id,
      type: EVENT_EDIT,
      deltaQty: 0,
      qtyAfter: next.qty,
      reason: changes.join('；'),
    });
  }

  return { ok: true, plan };
}

// ── 结算（供 DbProvider 的闸门调用）────────────────────────────────────

/**
 * 结算一种药，包成可以直接落库的 `Plan`。与上面七个操作走同一条落库路径，
 * 所以「结算」不需要一套并行的写库代码。
 */
export function planSettle(ctx: OpContext): Plan {
  const plan: Plan = { patches: [], events: [] };
  return applySettlement(plan, planSettlement(ctx.medicine, ctx.inStock, ctx.today), ctx);
}
