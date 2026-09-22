/**
 * `version: 1` 导出文件的解析与校验 —— DESIGN.md §7.2 的 7 个坑全在这里兜。
 *
 * 这个模块是**纯的**：只吃一段文本，吐一个结构，不碰数据库。这样它可以在
 * jest 里直接喂合成数据测试（包括那些真实数据里不存在的坏情况）。
 *
 * ── 两个贯穿全文的原则 ────────────────────────────────────────────────
 * 1. **先校验再写**：任何一条不合法就整体拒绝，绝不写一半（§7.2）。
 *    错误**一次列全**，不是报一个改一个 —— 和 §4「必填项一次列全」同一个道理。
 * 2. **不静默兜底**：解析不出来的时间戳不会退化成「现在」，单位为空不会退化成
 *    「片」。坏数据必须变成一条错误，否则它会伪装成一条好数据混进库存里。
 */
import {
  BATCH_STATUSES,
  DEFAULT_NEAR_EXPIRY_DAYS,
  DEFAULT_RESTOCK_DAYS,
  EVENT_EDIT,
  EVENT_LABELS,
  EVENT_MARK_EXPIRED,
  EVENT_RESTOCK,
  KEY_NEAR_EXPIRY_DAYS,
  KEY_RESTOCK_DAYS,
} from '../domain/constants';
import { parseDay, type CalendarDay } from '../domain/calendar';
import { parseInstant } from '../domain/instant';
import type { Instant } from '../db/schema';

// ── 解析结果的结构 ─────────────────────────────────────────────────────

/**
 * 「数量变化为 0」是合法的变动类型。
 *
 * `requirements.md` §2.3 的原话是「**仅「编辑」类型可以是 0**」，但那条把
 * 枚举里两个**按定义就不改数量**的操作漏掉了，而**网页版的代码并不遵守它**：
 * `../medbox-app/app/routes/batches.py:307,322` 给「标记过期」「恢复在库」
 * 记的正是 `delta 0`（§2.4 里这两件事本来就只改状态、不动数量）。
 *
 * 🔴 照 §2.3 的原文写会同时坏掉两件事，而且都是硬约束级别的：
 * 1. **导入端会拒绝网页版自己导出的文件** —— 硬约束 5 的双向兼容当场破掉。
 * 2. **App 自己「标记过期」一次之后，导出会被自己的运行时自检拦住。**
 *    而 `StockEvent` 只增不改不删（硬约束 2），那条事件永远在 ⇒ **再也没有
 *    导出的机会**，「能拿走」这个能力被一次点按永久锁死。
 *
 * 2026-09-22 由 M6 的「自检不挡路」扫出来（`test/exporter/roundtrip.test.ts` 里
 * 阶段 5 第 7 项的本地替身）。此前两半各自都有测试、且各自都过：
 * `test/stock.test.ts:323,346` 钉住「领域层写 0」，这一条钉住「解析端不许 0」——
 * 两个测试互相矛盾，却谁也照不到对方。
 */
const ZERO_DELTA_TYPES: readonly string[] = [EVENT_EDIT, EVENT_MARK_EXPIRED, EVENT_RESTOCK];

export type ParsedMember = {
  oldId: number;
  name: string;
  notes: string | null;
  createdAt: Instant;
};

export type ParsedMedicine = {
  oldId: number;
  generic: string;
  brand: string | null;
  spec: string | null;
  form: string | null;
  category: string | null;
  purposeNotes: string | null;
  dailyDose: number | null;
  unit: string | null;
  oldOwnerId: number | null;
  autoDeduct: boolean;
  autoPaused: boolean;
  /** 已被**重设**为导入当天，不是文件里的原值（§6.1 坑 1） */
  autoFrom: CalendarDay;
  /** 已被**归零**（§6.1 坑 1） */
  autoAccounted: number;
  createdAt: Instant;
  /** 原文件里的起算日，仅用于在导入结果页说明「已重新起算」 */
  originalAutoFrom: CalendarDay | null;
  /** 原文件里的已核算量 */
  originalAutoAccounted: number;
};

export type ParsedBatch = {
  oldId: number;
  oldMedicineId: number;
  oldOwnerId: number | null;
  qty: number;
  unit: string;
  expiryDate: CalendarDay | null;
  openedAt: CalendarDay | null;
  openLifeDays: number | null;
  location: string | null;
  status: string;
  notes: string | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type ParsedEvent = {
  oldId: number;
  oldBatchId: number;
  type: string;
  deltaQty: number;
  qtyAfter: number;
  reason: string | null;
  createdAt: Instant;
};

export type ParsedImport = {
  members: ParsedMember[];
  medicines: ParsedMedicine[];
  batches: ParsedBatch[];
  events: ParsedEvent[];
  settings: { nearExpiryDays: number; restockDays: number };
  /** 给用户核对的数字（§7.2「导入后显示…让用户能对着网页版核一遍」） */
  stats: {
    members: number;
    medicines: number;
    batches: number;
    events: number;
    totalQty: number;
  };
  /** 被重新起算的自动扣减药，要在结果页显式列出（决策 8） */
  autoRestarted: { generic: string; originalAutoFrom: CalendarDay | null }[];
  /** 非致命提示：不认识的字段、被丢弃的设置项等 */
  warnings: string[];
  /** 文件里的 exported_at 原文。只用于展示，**不参与任何计算**（§6.2 坑 2）。 */
  exportedAtRaw: string | null;
};

export type ParseResult =
  | { ok: true; data: ParsedImport }
  | { ok: false; errors: string[] };

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 最多报这么多条错误，避免一个坏文件刷屏 */
const MAX_ERRORS = 40;

class Collector {
  readonly errors: string[] = [];
  add(msg: string) {
    if (this.errors.length < MAX_ERRORS) this.errors.push(msg);
  }
  get overflowed() {
    return this.errors.length >= MAX_ERRORS;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * 布尔值：JSON 里是 `true/false`，网页版库里是 `0/1`。
 * §7.2 坑 4 警告「别当整数解析」—— 所以这里**只认真正的布尔**，
 * 字符串 `"0"` / `"false"` 一律报错而不是猜。猜错方向会让「关闭的自动扣减」
 * 变成「开启」，进而静默改库存。
 */
function asBool(v: unknown, field: string, c: Collector, where: string): boolean {
  if (typeof v === 'boolean') return v;
  c.add(`${where} 的 ${field} 应该是 true/false，实际是 ${JSON.stringify(v)}`);
  return false;
}

/** 日历日：`'2026-09-15'`，用 parseDay 严格校验（会挡掉 2026-02-30 这种） */
function asDay(
  v: unknown,
  field: string,
  c: Collector,
  where: string,
  { required = false }: { required?: boolean } = {},
): CalendarDay | null {
  if (v === null || v === undefined || v === '') {
    if (required) c.add(`${where} 缺少必填的 ${field}`);
    return null;
  }
  if (typeof v !== 'string') {
    c.add(`${where} 的 ${field} 不是日期字符串：${JSON.stringify(v)}`);
    return null;
  }
  const parsed = parseDay(v);
  if (parsed === null) {
    c.add(`${where} 的 ${field} 不是合法日历日（要 YYYY-MM-DD）：${JSON.stringify(v)}`);
    return null;
  }
  return parsed;
}

/**
 * 时刻：按 **UTC** 解析（坑 2 的核心）。
 * 见 `src/domain/instant.ts` 里为什么不能用 `new Date(string)`。
 */
function asInstant(v: unknown, field: string, c: Collector, where: string): Instant | null {
  if (typeof v !== 'string') {
    c.add(`${where} 的 ${field} 缺失或不是字符串`);
    return null;
  }
  const ms = parseInstant(v);
  if (ms === null) {
    c.add(`${where} 的 ${field} 不是合法时间戳：${JSON.stringify(v)}`);
    return null;
  }
  return ms;
}

/** 已知的模型字段名，用来发现「不认识的字段」（§7.2 最后一条） */
function findUnknownKeys(obj: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !known.includes(k));
}

// 四处白名单导出给 `src/exporter/build.ts` 用：导出端必须**严格**按这些键写，
// 多一个键将来导入时就多一条「不认识的字段」警告。测试也拿它们比对（`test/exporter/`）。
export const MEMBER_KEYS: readonly string[] = ['id', 'name', 'notes', 'created_at'];
export const MEDICINE_KEYS: readonly string[] = [
  'id',
  'generic',
  'brand',
  'spec',
  'form',
  'category',
  'purpose_notes',
  'daily_dose',
  'unit',
  'owner_id',
  'auto_deduct',
  'auto_paused',
  'auto_from',
  'auto_accounted',
  'created_at',
];
export const BATCH_KEYS: readonly string[] = [
  'id',
  'medicine_id',
  'owner_id',
  'qty',
  'unit',
  'expiry_date',
  'opened_at',
  'open_life_days',
  'location',
  'status',
  'notes',
  'created_at',
  'updated_at',
];
export const EVENT_KEYS: readonly string[] = [
  'id',
  'batch_id',
  'type',
  'delta_qty',
  'qty_after',
  'reason',
  'created_at',
];

// ── 主函数 ─────────────────────────────────────────────────────────────

/**
 * 解析导出文件。
 *
 * @param text      `all.json` 的原文
 * @param importDay **导入当天**的日历日。自动扣减药的起算日会被重设成它（坑 1）。
 *                  显式传进来而不是内部取 `today()`，是为了测试能固定住这一天。
 */
export function parseExport(text: string, importDay: CalendarDay): ParseResult {
  const c = new Collector();
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`不是合法的 JSON 文件：${(e as Error).message}`] };
  }
  if (!isPlainObject(root)) {
    return { ok: false, errors: ['文件顶层不是一个对象，不像是 medbox 的导出文件。'] };
  }

  // ── version ────────────────────────────────────────────────────────
  if (root.version !== 1) {
    return {
      ok: false,
      errors: [
        `不支持的 version：${JSON.stringify(root.version)}。这个 App 只认 version: 1` +
          `（网页版导出的格式）。`,
      ],
    };
  }

  // `exported_at` 是本地时间 naive，与 created_at 的 UTC 口径不同（§6.2）。
  // 直接**丢弃**，只留原文用于展示。
  const exportedAtRaw = typeof root.exported_at === 'string' ? root.exported_at : null;

  // ── settings：只取两个阈值，丢掉网页版内部迁移标记（坑 3）─────────────
  let nearExpiryDays = DEFAULT_NEAR_EXPIRY_DAYS;
  let restockDays = DEFAULT_RESTOCK_DAYS;
  if (isPlainObject(root.settings)) {
    const s = root.settings;
    const near = parseInt(String(s[KEY_NEAR_EXPIRY_DAYS] ?? ''), 10);
    if (Number.isFinite(near) && near >= 0) nearExpiryDays = near;
    const restock = parseInt(String(s[KEY_RESTOCK_DAYS] ?? ''), 10);
    if (Number.isFinite(restock) && restock >= 0) restockDays = restock;

    const dropped = Object.keys(s).filter((k) => k !== KEY_NEAR_EXPIRY_DAYS && k !== KEY_RESTOCK_DAYS);
    if (dropped.length > 0) {
      warnings.push(
        `设置里有 ${dropped.length} 项是网页版内部状态，已忽略：${dropped.join('、')}`,
      );
    }
  }

  const rawMembers = Array.isArray(root.members) ? root.members : [];
  const rawMedicines = Array.isArray(root.medicines) ? root.medicines : [];
  const rawBatches = Array.isArray(root.batches) ? root.batches : [];
  const rawEvents = Array.isArray(root.stock_events) ? root.stock_events : [];

  for (const [label, arr] of [
    ['members', root.members],
    ['medicines', root.medicines],
    ['batches', root.batches],
    ['stock_events', root.stock_events],
  ] as const) {
    if (!Array.isArray(arr)) c.add(`文件里缺少 ${label} 数组。`);
  }

  // ── members ────────────────────────────────────────────────────────
  const members: ParsedMember[] = [];
  const memberIds = new Set<number>();
  rawMembers.forEach((raw, i) => {
    const where = `成员 #${i + 1}`;
    if (!isPlainObject(raw)) return c.add(`${where} 不是一个对象。`);
    const id = asInt(raw.id);
    if (id === null) return c.add(`${where} 的 id 不是整数。`);
    const name = asString(raw.name);
    if (name === null) return c.add(`${where} 的姓名不能为空。`);
    if (memberIds.has(id)) return c.add(`${where} 的 id ${id} 重复。`);
    memberIds.add(id);
    const createdAt = asInstant(raw.created_at, 'created_at', c, where);
    if (createdAt === null) return;
    warnUnknown(raw, MEMBER_KEYS, where, warnings);
    members.push({ oldId: id, name, notes: asNullableString(raw.notes), createdAt });
  });

  // ── medicines ──────────────────────────────────────────────────────
  const medicines: ParsedMedicine[] = [];
  const medicineIds = new Set<number>();
  const autoRestarted: { generic: string; originalAutoFrom: CalendarDay | null }[] = [];

  rawMedicines.forEach((raw, i) => {
    const where = `药品 #${i + 1}`;
    if (!isPlainObject(raw)) return c.add(`${where} 不是一个对象。`);
    const id = asInt(raw.id);
    if (id === null) return c.add(`${where} 的 id 不是整数。`);
    const generic = asString(raw.generic);
    if (generic === null) return c.add(`${where}（id ${id}）的通用名不能为空。`);
    if (medicineIds.has(id)) return c.add(`${where} 的 id ${id} 重复。`);
    medicineIds.add(id);

    const unit = asString(raw.unit);
    if (unit === null) c.add(`${where}「${generic}」缺单位（requirements.md §2.1 要求单位必填）。`);

    const createdAt = asInstant(raw.created_at, 'created_at', c, where);
    if (createdAt === null) return;

    // 每日用量：要么空，要么 > 0（§2.1 校验规则）
    let dailyDose: number | null = null;
    if (raw.daily_dose !== null && raw.daily_dose !== undefined) {
      if (typeof raw.daily_dose !== 'number' || !Number.isFinite(raw.daily_dose)) {
        c.add(`${where}「${generic}」的每日用量不是数字：${JSON.stringify(raw.daily_dose)}`);
      } else if (raw.daily_dose <= 0) {
        c.add(`${where}「${generic}」的每日用量必须 > 0，实际是 ${raw.daily_dose}`);
      } else {
        dailyDose = raw.daily_dose;
      }
    }

    const oldOwnerId = raw.owner_id === null || raw.owner_id === undefined ? null : asInt(raw.owner_id);
    if (raw.owner_id !== null && raw.owner_id !== undefined && oldOwnerId === null) {
      c.add(`${where}「${generic}」的 owner_id 不是整数。`);
    }
    if (oldOwnerId !== null && !memberIds.has(oldOwnerId)) {
      c.add(`${where}「${generic}」的归属成员 id ${oldOwnerId} 在 members 里不存在（外键对不上）。`);
    }

    const autoDeduct = asBool(raw.auto_deduct, 'auto_deduct', c, where);
    const autoPaused = asBool(raw.auto_paused, 'auto_paused', c, where);

    // 🔴 坑 1：起算日重设为导入当天、已核算量归零。
    // 照搬原值会让「这台机器上没结算过的那段日子」被一次性补扣 ——
    // 2026-12-01 导入的话每个药要扣 76 单位，而缬沙坦只有 4 片，直接扣爆。
    const originalAutoFrom = asDay(raw.auto_from, 'auto_from', c, where);
    const originalAutoAccounted = asInt(raw.auto_accounted) ?? 0;

    if (autoDeduct && !autoPaused) {
      autoRestarted.push({ generic, originalAutoFrom });
    }

    warnUnknown(raw, MEDICINE_KEYS, where, warnings);

    medicines.push({
      oldId: id,
      generic,
      brand: asNullableString(raw.brand),
      spec: asNullableString(raw.spec),
      form: asNullableString(raw.form),
      category: asNullableString(raw.category),
      purposeNotes: asNullableString(raw.purpose_notes),
      dailyDose,
      unit,
      oldOwnerId,
      autoDeduct,
      autoPaused,
      autoFrom: importDay, // ← 重设
      autoAccounted: 0, // ← 归零
      createdAt,
      originalAutoFrom,
      originalAutoAccounted,
    });
  });

  // ── batches ────────────────────────────────────────────────────────
  const batches: ParsedBatch[] = [];
  const batchIds = new Set<number>();

  rawBatches.forEach((raw, i) => {
    const where = `批次 #${i + 1}`;
    if (!isPlainObject(raw)) return c.add(`${where} 不是一个对象。`);
    const id = asInt(raw.id);
    if (id === null) return c.add(`${where} 的 id 不是整数。`);
    if (batchIds.has(id)) return c.add(`${where} 的 id ${id} 重复。`);
    batchIds.add(id);

    const oldMedicineId = asInt(raw.medicine_id);
    if (oldMedicineId === null) return c.add(`${where} 缺所属药品 medicine_id。`);
    if (!medicineIds.has(oldMedicineId)) {
      return c.add(`${where} 的 medicine_id ${oldMedicineId} 在 medicines 里不存在（外键对不上）。`);
    }

    const qty = asInt(raw.qty);
    if (qty === null) return c.add(`${where} 的数量不是整数。`);
    if (qty < 0) return c.add(`${where} 的数量不能为负，实际是 ${qty}。`);

    // 🟢 坑 6：单位逐条原样导入，**不按单位合并批次**。
    // 历史上真实出现过同一药不同批次单位不同（创可贴有 ml 和 片）。
    const unit = asString(raw.unit);
    if (unit === null) return c.add(`${where} 缺单位。`);

    const status = asString(raw.status) ?? 'in_stock';
    if (!(BATCH_STATUSES as readonly string[]).includes(status)) {
      c.add(`${where} 的状态 ${JSON.stringify(status)} 不是已知状态（${BATCH_STATUSES.join('/')}）。`);
    }
    // 不变量 3 / 4：used_up、discarded 必须为 0；in_stock 不能为 0
    if ((status === 'used_up' || status === 'discarded') && qty !== 0) {
      c.add(`${where} 状态是「${status}」但数量是 ${qty}，应该为 0（不变量 3）。`);
    }
    if (status === 'in_stock' && qty === 0) {
      c.add(`${where} 状态是「在库」但数量是 0，这是非法状态（不变量 4）。`);
    }

    const oldOwnerId = raw.owner_id === null || raw.owner_id === undefined ? null : asInt(raw.owner_id);
    if (oldOwnerId !== null && !memberIds.has(oldOwnerId)) {
      c.add(`${where} 的归属成员 id ${oldOwnerId} 在 members 里不存在（外键对不上）。`);
    }

    const openLifeDays = raw.open_life_days === null || raw.open_life_days === undefined
      ? null
      : asInt(raw.open_life_days);
    if (openLifeDays !== null && openLifeDays <= 0) {
      c.add(`${where} 的开封后有效期必须 > 0，实际是 ${openLifeDays}。`);
    }

    const createdAt = asInstant(raw.created_at, 'created_at', c, where);
    if (createdAt === null) return;
    // updated_at 缺失时退回 created_at：它只影响排序和展示，不值得为此拒绝整份文件。
    // 注意必须先判空再解析 —— 直接调 asInstant 会在缺失时先记一条错误。
    const updatedAt =
      raw.updated_at === null || raw.updated_at === undefined
        ? createdAt
        : asInstant(raw.updated_at, 'updated_at', c, where);
    if (updatedAt === null) return;

    warnUnknown(raw, BATCH_KEYS, where, warnings);

    batches.push({
      oldId: id,
      oldMedicineId,
      oldOwnerId,
      qty,
      unit,
      expiryDate: asDay(raw.expiry_date, 'expiry_date', c, where),
      openedAt: asDay(raw.opened_at, 'opened_at', c, where),
      openLifeDays,
      location: asNullableString(raw.location),
      status,
      notes: asNullableString(raw.notes),
      createdAt,
      updatedAt,
    });
  });

  // ── stock_events ───────────────────────────────────────────────────
  const events: ParsedEvent[] = [];
  const eventIds = new Set<number>();
  const validTypes = Object.keys(EVENT_LABELS);

  rawEvents.forEach((raw, i) => {
    const where = `变动记录 #${i + 1}`;
    if (!isPlainObject(raw)) return c.add(`${where} 不是一个对象。`);
    const id = asInt(raw.id);
    if (id === null) return c.add(`${where} 的 id 不是整数。`);
    if (eventIds.has(id)) return c.add(`${where} 的 id ${id} 重复。`);
    eventIds.add(id);

    const oldBatchId = asInt(raw.batch_id);
    if (oldBatchId === null) return c.add(`${where} 缺 batch_id。`);
    if (!batchIds.has(oldBatchId)) {
      return c.add(`${where} 的 batch_id ${oldBatchId} 在 batches 里不存在（外键对不上）。`);
    }

    const type = asString(raw.type);
    if (type === null) return c.add(`${where} 缺类型 type。`);
    if (!validTypes.includes(type)) {
      c.add(`${where} 的类型 ${JSON.stringify(type)} 不是已知类型（${validTypes.join('/')}）。`);
    }

    const deltaQty = asInt(raw.delta_qty);
    if (deltaQty === null) return c.add(`${where} 的 delta_qty 不是整数。`);
    const qtyAfter = asInt(raw.qty_after);
    if (qtyAfter === null) return c.add(`${where} 的 qty_after 不是整数。`);
    if (qtyAfter < 0) return c.add(`${where} 的 qty_after 不能为负。`);
    if (deltaQty === 0 && !ZERO_DELTA_TYPES.includes(type)) {
      c.add(`${where} 的类型是「${type}」但数量变化为 0，只有「编辑」「标记过期」「恢复在库」允许为 0。`);
    }

    const createdAt = asInstant(raw.created_at, 'created_at', c, where);
    if (createdAt === null) return;

    warnUnknown(raw, EVENT_KEYS, where, warnings);

    events.push({
      oldId: id,
      oldBatchId,
      type,
      deltaQty,
      qtyAfter,
      reason: asNullableString(raw.reason),
      createdAt,
    });
  });

  if (c.errors.length > 0) {
    const errs = [...c.errors];
    if (c.overflowed) errs.push(`……（错误过多，只显示前 ${MAX_ERRORS} 条）`);
    return { ok: false, errors: errs };
  }

  // ── 全局一致性：不变量 1（存量数据例外见 §6.9）──────────────────────
  // 只在「该批次确实有变动记录」时检查，因为存量数据有 38 条没有任何记录。
  const lastEventByBatch = new Map<number, ParsedEvent>();
  for (const e of events) {
    const prev = lastEventByBatch.get(e.oldBatchId);
    if (!prev || e.createdAt >= prev.createdAt) lastEventByBatch.set(e.oldBatchId, e);
  }
  for (const b of batches) {
    const last = lastEventByBatch.get(b.oldId);
    if (last && last.qtyAfter !== b.qty) {
      c.add(
        `批次 id ${b.oldId} 的数量 ${b.qty} 与它最后一条变动记录的「变动后数量」` +
          `${last.qtyAfter} 对不上（不变量 1）。`,
      );
    }
  }

  // 存量数据没有变动记录是**已知且接受**的（§6.9）。不补假记录，只提示。
  const batchesWithoutEvents = batches.filter((b) => !lastEventByBatch.has(b.oldId)).length;
  if (batchesWithoutEvents > 0) {
    warnings.push(
      `有 ${batchesWithoutEvents} 条在库没有变动记录 —— 这是网页版清库时保留在库数据的正常现象，` +
        `已原样导入，不补造记录。`,
    );
  }

  if (c.errors.length > 0) {
    const errs = [...c.errors];
    if (c.overflowed) errs.push(`……（错误过多，只显示前 ${MAX_ERRORS} 条）`);
    return { ok: false, errors: errs };
  }

  return {
    ok: true,
    data: {
      members,
      medicines,
      batches,
      events,
      settings: { nearExpiryDays, restockDays },
      stats: {
        members: members.length,
        medicines: medicines.length,
        batches: batches.length,
        events: events.length,
        totalQty: batches
          .filter((b) => b.status === 'in_stock')
          .reduce((sum, b) => sum + b.qty, 0),
      },
      autoRestarted,
      warnings,
      exportedAtRaw,
    },
  };
}

function warnUnknown(
  raw: Record<string, unknown>,
  known: readonly string[],
  where: string,
  warnings: string[],
) {
  const unknown = findUnknownKeys(raw, known);
  if (unknown.length > 0) {
    warnings.push(`${where} 上有不认识的字段，已忽略：${unknown.join('、')}`);
  }
}
