/**
 * 读取层 —— 把网页版的 `services/forecast.py`（聚合部分）与
 * `routes/dashboard.py::_build_groups` 翻译成 drizzle 查询。
 *
 * 规则本身在 `src/domain/`（纯函数，有测试）；这里只负责「把行捞出来、
 * 拼成界面要的形状」。派生字段（提醒日、效期分档、可用天数）都在 JS 里算，
 * 不在 SQL 里算 —— 因为它们是领域规则，写在 SQL 里就没法单测了。
 *
 * ⚠️ 所有返回库存数字的函数，都必须在**结算之后**调用（DESIGN.md §7.3）。
 * 界面上不要绕过 `useDb()` 直接查库，否则首页和详情页可能显示不同的数。
 */
import { and, eq, inArray } from 'drizzle-orm';

import type { MedboxDb } from '../db/client';
import type { Batch, CalendarDay, Medicine, Member } from '../db/schema';
import { batches, medicines, members, stockEvents } from '../db/schema';
import { compareDays } from '../domain/calendar';
import {
  BATCH_IN_STOCK,
  DEFAULT_NEAR_EXPIRY_DAYS,
  DEFAULT_RESTOCK_DAYS,
  KEY_NEAR_EXPIRY_DAYS,
  KEY_RESTOCK_DAYS,
  SHARED_LABEL,
} from '../domain/constants';
import type { ExpiryStatus } from '../domain/constants';
import { classify, effectiveExpiry } from '../domain/expiry';
import { daysOfSupply, needsRestock } from '../domain/forecast';
import { getIntSetting } from '../importer/apply';

/** 「无穷远」的日历日，用于把「未填效期」排到最后。 */
const MAX_DAY = '9999-12-31';

export type Thresholds = { nearDays: number; restockDays: number };

/** 读两个阈值，缺失时回默认值（对应网页版 `get_int_setting`）。 */
export function getThresholds(db: MedboxDb): Thresholds {
  return {
    nearDays: getIntSetting(db, KEY_NEAR_EXPIRY_DAYS, DEFAULT_NEAR_EXPIRY_DAYS),
    restockDays: getIntSetting(db, KEY_RESTOCK_DAYS, DEFAULT_RESTOCK_DAYS),
  };
}

/** 一个在库批次 + 它的药 + 它的归属 + 全部派生字段。 */
export type BatchRow = {
  batch: Batch;
  medicine: Medicine;
  owner: Member | null;
  effective: CalendarDay | null;
  expiryStatus: ExpiryStatus;
  /** 药级聚合：该药在库合计 ÷ 每日用量 */
  daysOfSupply: number | null;
  /** 药级判定 */
  needsRestock: boolean;
};

/** 药级聚合：该药在库合计、以及是否单位混用。 */
export type MedicineAgg = {
  totalQty: number;
  /** 在库批次用了不止一种单位 —— 跨单位相加没有意义 */
  unitConflict: boolean;
  units: string[];
};

/**
 * 全部在库批次（附派生视图），排序与网页版 `in_stock_rows` 一致：
 * **提醒日升序，无提醒日的排最后**。
 */
export function inStockRows(db: MedboxDb, today: CalendarDay, th: Thresholds): BatchRow[] {
  const raw = db
    .select({ batch: batches, medicine: medicines, owner: members })
    .from(batches)
    .innerJoin(medicines, eq(batches.medicineId, medicines.id))
    .leftJoin(members, eq(batches.ownerId, members.id))
    .where(eq(batches.status, BATCH_IN_STOCK))
    .all();

  const agg = aggregateByMedicine(db);

  const rows: BatchRow[] = raw.map(({ batch, medicine, owner }) => {
    const a = agg.get(medicine.id);
    // 每日用量缺失或 ≤0 → dos 为 null → needsRestock 为 false（不打扰用户）
    const dos = daysOfSupply(a?.totalQty ?? 0, medicine.dailyDose);
    return {
      batch,
      medicine,
      owner,
      effective: effectiveExpiry(batch),
      expiryStatus: classify(batch, today, th.nearDays),
      daysOfSupply: dos,
      needsRestock: needsRestock(dos, th.restockDays),
    };
  });

  rows.sort((x, y) => {
    // 无提醒日的排最后
    if (x.effective === null && y.effective === null) return 0;
    if (x.effective === null) return 1;
    if (y.effective === null) return -1;
    return compareDays(x.effective, y.effective);
  });
  return rows;
}

/**
 * 每个药的：在库合计、在库单位集合。
 * 网页版 `_qty_sum_map` + `autodose.units_conflict` 的合体。
 */
export function aggregateByMedicine(db: MedboxDb): Map<number, MedicineAgg> {
  const rows = db
    .select({ medicineId: batches.medicineId, qty: batches.qty, unit: batches.unit })
    .from(batches)
    .where(eq(batches.status, BATCH_IN_STOCK))
    .all();

  const out = new Map<number, MedicineAgg>();
  for (const r of rows) {
    let a = out.get(r.medicineId);
    if (!a) {
      a = { totalQty: 0, unitConflict: false, units: [] };
      out.set(r.medicineId, a);
    }
    a.totalQty += r.qty;
    if (!a.units.includes(r.unit)) a.units.push(r.unit);
  }
  // 单位混用 = 在库批次里出现了不止一种单位。
  // §3.6：此时跳过自动扣减并说明原因（M4 用），但**数量仍照常展示**。
  for (const a of out.values()) a.unitConflict = a.units.length > 1;
  return out;
}

/** 单个药的聚合；没有在库批次时返回全 0。 */
export function medicineAgg(db: MedboxDb, medicineId: number): MedicineAgg {
  const rows = db
    .select({ qty: batches.qty, unit: batches.unit })
    .from(batches)
    .where(and(eq(batches.status, BATCH_IN_STOCK), eq(batches.medicineId, medicineId)))
    .all();
  const units: string[] = [];
  let totalQty = 0;
  for (const r of rows) {
    totalQty += r.qty;
    if (!units.includes(r.unit)) units.push(r.unit);
  }
  return { totalQty, unitConflict: units.length > 1, units };
}

// ── 首页 ───────────────────────────────────────────────────────────────

/** 首页「需补货」一行 */
export type RestockRow = { medicine: Medicine; daysOfSupply: number };

export type PerMember = { name: string; count: number; ownerId: number | null };

export type Dashboard = {
  rows: BatchRow[];
  inStockCount: number;
  nearExpiryCount: number;
  expiredCount: number;
  needRestock: RestockRow[];
  perMember: PerMember[];
  thresholds: Thresholds;
  today: CalendarDay;
};

/**
 * 首页总览聚合 —— 对应网页版 `forecast.dashboard_stats`。
 *
 * 注意「按成员」的口径：计的是**名下有在库的药品种数**（同种药多盒只算 1 种），
 * 不是盒数。这是网页版刻意的选择（§3.7），别改成盒数。
 */
export function dashboard(db: MedboxDb, today: CalendarDay): Dashboard {
  const th = getThresholds(db);
  const rows = inStockRows(db, today, th);

  const near = rows.filter((r) => r.expiryStatus === 'expiring');
  const expired = rows.filter((r) => r.expiryStatus === 'expired');

  // 需补货：只有设了每日用量的药才参与，所以从「有剂量的药」出发，
  // 而不是从在库行出发 —— 后者会漏掉「一个在库批次都没有」的药（§3.5 0 库存也算）
  const agg = aggregateByMedicine(db);
  const needRestock: RestockRow[] = [];
  const dosed = db.select().from(medicines).all().filter((m) => m.dailyDose !== null && m.dailyDose > 0);
  for (const m of dosed) {
    const dos = daysOfSupply(agg.get(m.id)?.totalQty ?? 0, m.dailyDose);
    if (needsRestock(dos, th.restockDays)) needRestock.push({ medicine: m, daysOfSupply: dos! });
  }
  needRestock.sort((a, b) => a.daysOfSupply - b.daysOfSupply);

  return {
    rows,
    inStockCount: rows.length,
    nearExpiryCount: near.length,
    expiredCount: expired.length,
    needRestock,
    perMember: perMemberCounts(rows),
    thresholds: th,
    today,
  };
}

/** 按成员统计「名下有在库的药品种数」，含「家庭共用」这一档。 */
function perMemberCounts(rows: BatchRow[]): PerMember[] {
  const meds = new Map<string, Set<number>>();
  const ownerIds = new Map<string, number>();
  for (const r of rows) {
    const key = r.owner ? r.owner.name : SHARED_LABEL;
    if (!meds.has(key)) meds.set(key, new Set());
    meds.get(key)!.add(r.batch.medicineId);
    if (r.owner) ownerIds.set(key, r.owner.id);
  }
  const out: PerMember[] = [...meds.entries()].map(([name, ids]) => ({
    name,
    count: ids.size,
    ownerId: ownerIds.get(name) ?? null,
  }));
  // 网页版按数量倒序
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return out;
}

// ── 首页在库列表分组（药 → 逐盒） ──────────────────────────────────────

export type MedGroup = {
  medicine: Medicine;
  sublines: BatchRow[];
  daysOfSupply: number | null;
  needsRestock: boolean;
  /** 全量在库合计文本，**不受筛选影响**（网页版刻意如此） */
  totalText: string;
  /** 被筛选掉的盒数 */
  hidden: number;
  hiddenLabel: string;
};

/**
 * 把在库行按药分组，`keep` 决定哪些盒可见 —— 对应网页版 `_build_groups`。
 *
 * 两处容易被「顺手改掉」的细节：
 * - `totalText` 用的是**全部**在库盒的合计，不是筛选后的；否则点了「快过期」
 *   之后「合计 34 片」会变成「合计 4 片」，让人以为药少了。
 * - 组间排序按**组内最早的提醒日**，无提醒日的排最后。
 */
export function buildGroups(rows: BatchRow[], keep: (r: BatchRow) => boolean, hiddenLabel: string): MedGroup[] {
  const allByMed = new Map<number, BatchRow[]>();
  const perUnit = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const mid = r.batch.medicineId;
    if (!allByMed.has(mid)) allByMed.set(mid, []);
    allByMed.get(mid)!.push(r);
    if (!perUnit.has(mid)) perUnit.set(mid, new Map());
    const u = perUnit.get(mid)!;
    u.set(r.batch.unit, (u.get(r.batch.unit) ?? 0) + r.batch.qty);
  }

  const gmap = new Map<number, MedGroup>();
  const order: MedGroup[] = [];
  for (const r of rows) {
    if (!keep(r)) continue;
    const mid = r.batch.medicineId;
    let g = gmap.get(mid);
    if (!g) {
      g = {
        medicine: r.medicine,
        sublines: [],
        daysOfSupply: r.daysOfSupply,
        needsRestock: r.needsRestock,
        totalText: '',
        hidden: 0,
        hiddenLabel,
      };
      gmap.set(mid, g);
      order.push(g);
    }
    g.sublines.push(r);
  }

  for (const [mid, g] of gmap) {
    const units = perUnit.get(mid)!;
    g.totalText =
      units.size === 1
        ? `合计 ${[...units.values()][0]} ${[...units.keys()][0]}`
        : '合计 ' + [...units.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([u, q]) => `${q} ${u}`).join('，');
    g.hidden = (allByMed.get(mid)?.length ?? 0) - g.sublines.length;
  }

  order.sort((a, b) => {
    const ea = earliest(a.sublines);
    const eb = earliest(b.sublines);
    if (ea !== eb) return compareDays(ea, eb);
    return a.medicine.generic.localeCompare(b.medicine.generic, 'zh');
  });
  return order;
}

function earliest(rows: BatchRow[]): CalendarDay {
  let best = MAX_DAY;
  for (const r of rows) {
    if (r.effective !== null && compareDays(r.effective, best) < 0) best = r.effective;
  }
  return best;
}

// ── 药品列表页 ─────────────────────────────────────────────────────────

export type MedicineListRow = {
  medicine: Medicine;
  inStockQty: number;
};

/**
 * 药品档案列表：按通用名/品牌/规格搜索 + 按类别筛选。
 * 搜索在 JS 里做 —— 37 条数据，没必要为它引 SQL 的 LIKE 与转义。
 */
export function listMedicines(db: MedboxDb, q: string, category: string): MedicineListRow[] {
  const agg = aggregateByMedicine(db);
  const all = db.select().from(medicines).all();

  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((m) => {
      if (category && m.category !== category) return false;
      if (!needle) return true;
      return [m.generic, m.brand, m.spec, m.purposeNotes]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(needle));
    })
    .map((m) => ({ medicine: m, inStockQty: agg.get(m.id)?.totalQty ?? 0 }));

  rows.sort((a, b) => a.medicine.generic.localeCompare(b.medicine.generic, 'zh'));
  return rows;
}

/** 库里出现过的类别（给筛选下拉用），按标准顺序排。 */
export function usedCategories(db: MedboxDb): string[] {
  const rows = db.select({ category: medicines.category }).from(medicines).all();
  const set = new Set(rows.map((r) => r.category).filter((c): c is string => !!c));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

// ── 药品详情页 ─────────────────────────────────────────────────────────

export type MedicineDetail = {
  medicine: Medicine;
  owner: Member | null;
  threshold: Thresholds;
  totalQty: number;
  unitConflict: boolean;
  daysOfSupply: number | null;
  needsRestock: boolean;
  /** 在库，逐盒展开 */
  inStock: BatchRow[];
  /** 历史（已用完 / 已过期 / 已丢弃） */
  history: Batch[];
  /** 变动时间线，按时间正序 */
  events: (typeof stockEvents.$inferSelect)[];
  /** 药品不存在时为 false */
  found: boolean;
};

export function medicineDetail(db: MedboxDb, medicineId: number, today: CalendarDay): MedicineDetail {
  const medicine = db.select().from(medicines).where(eq(medicines.id, medicineId)).get();
  const th = getThresholds(db);

  if (!medicine) {
    return {
      medicine: undefined as unknown as Medicine,
      owner: null,
      threshold: th,
      totalQty: 0,
      unitConflict: false,
      daysOfSupply: null,
      needsRestock: false,
      inStock: [],
      history: [],
      events: [],
      found: false,
    };
  }

  const owner = medicine.ownerId
    ? db.select().from(members).where(eq(members.id, medicine.ownerId)).get() ?? null
    : null;

  const rows = inStockRows(db, today, th).filter((r) => r.batch.medicineId === medicineId);
  const agg = medicineAgg(db, medicineId);
  const dos = daysOfSupply(agg.totalQty, medicine.dailyDose);

  const history = db
    .select()
    .from(batches)
    .where(and(eq(batches.medicineId, medicineId), inArray(batches.status, ['used_up', 'expired', 'discarded'])))
    .all();

  // 时间线：把该药所有批次的事件按时间正序排（对应模板里的 events）
  const batchIds = db.select({ id: batches.id }).from(batches).where(eq(batches.medicineId, medicineId)).all().map((b) => b.id);
  const events = batchIds.length
    ? db.select().from(stockEvents).where(inArray(stockEvents.batchId, batchIds)).all()
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
    : [];

  return {
    medicine,
    owner,
    threshold: th,
    totalQty: agg.totalQty,
    unitConflict: agg.unitConflict,
    daysOfSupply: dos,
    needsRestock: needsRestock(dos, th.restockDays),
    inStock: rows,
    history,
    events,
    found: true,
  };
}

// ── 成员 ───────────────────────────────────────────────────────────────

export function listMembers(db: MedboxDb): Member[] {
  return db.select().from(members).all().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/**
 * 每位成员名下有多少**种**药（成员页用）。
 *
 * ⚠️ 与首页「按成员」口径**不同**，这是刻意的：首页数的是「有在库的药」，
 * 这里数的是「档案里的全部药」—— 一盒都没有的药在成员页也该算他名下，
 * 否则「给孩子建过档但吃完了」的药会从孩子名下凭空消失。
 * 键 `null` 表示「家庭共用」。
 */
export function medicineCountByMember(db: MedboxDb): Map<number | null, number> {
  const rows = db.select({ ownerId: medicines.ownerId }).from(medicines).all();
  const out = new Map<number | null, number>();
  for (const r of rows) out.set(r.ownerId, (out.get(r.ownerId) ?? 0) + 1);
  return out;
}
