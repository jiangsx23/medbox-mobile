/**
 * Drizzle schema —— 与网页版 `medbox-app/app/models.py` 一一对应。
 *
 * 字段名刻意保持与网页版一致（`purpose_notes`、`auto_from`…），
 * 这样导出的 JSON 天然就是 `version: 1` 格式，不需要一层名字映射。
 *
 * ── 两条存储决策（都是为了 §6.8 的「日期口径必须分开」）────────────────
 *
 * 1. **日历日存字符串 `'YYYY-MM-DD'`**（`autoFrom` / `expiryDate` / `openedAt`）。
 *    它没有时区、没有时刻，只做日历日加减。存成字符串就没法被误当成瞬间去
 *    除以 86400，也不会被设备的时区或夏令时影响 —— 把这一类错误从「容易犯」
 *    变成「写不出来」。类型别名见 `CalendarDay`。
 *
 * 2. **时刻存 epoch 毫秒整数**（`createdAt` / `updatedAt`）。
 *    网页版存的是「naive UTC 字符串」，本身没有时区标记，导入端必须靠硬编码
 *    规则才知道该按 UTC 解析（DESIGN.md §6.2 那颗雷）。存成毫秒整数就是
 *    一个无歧义的瞬间：排序直接比大小，展示时转本地时间，导出时再格式化回
 *    naive UTC 字符串保持 `version: 1` 兼容。
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** 日历日：`'YYYY-MM-DD'`，无时区无时刻。取值与算术见 `src/domain/calendar.ts`。 */
export type CalendarDay = string;

/** 时刻：epoch 毫秒。展示用 `new Date(ms)`，导出转回 naive UTC。 */
export type Instant = number;

// ── 成员 ───────────────────────────────────────────────────────────────
export const members = sqliteTable(
  'members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('members_name_unique').on(t.name)],
);

// ── 药品档案 ───────────────────────────────────────────────────────────
export const medicines = sqliteTable(
  'medicines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 通用名，必填非空 */
    generic: text('generic').notNull(),
    brand: text('brand'),
    spec: text('spec'),
    form: text('form'),
    category: text('category'),
    purposeNotes: text('purpose_notes'),
    /** 每日用量，可空；空或 ≤0 = 不参与补货预测与自动扣减 */
    dailyDose: real('daily_dose'),
    /** 默认单位，建档时定一次，入库时继承 */
    unit: text('unit'),
    /** 默认归属；null = 家庭共用 */
    ownerId: integer('owner_id').references(() => members.id),
    autoDeduct: integer('auto_deduct', { mode: 'boolean' }).notNull().default(false),
    autoPaused: integer('auto_paused', { mode: 'boolean' }).notNull().default(false),
    /** 起算日。与 autoAccounted 是一对，只能一起改（不变量 5）。 */
    autoFrom: text('auto_from').$type<CalendarDay>(),
    /** 自起算日起已核算的消耗量；自动扣减与手动「取用」都累加进来 */
    autoAccounted: integer('auto_accounted').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('medicines_generic_idx').on(t.generic), index('medicines_category_idx').on(t.category)],
);

// ── 库存批次（一盒一条） ────────────────────────────────────────────────
export const batches = sqliteTable(
  'batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    medicineId: integer('medicine_id')
      .notNull()
      .references(() => medicines.id),
    /** null = 家庭共用 */
    ownerId: integer('owner_id').references(() => members.id),
    qty: integer('qty').notNull(),
    unit: text('unit').notNull(),
    /** 印刷效期 */
    expiryDate: text('expiry_date').$type<CalendarDay>(),
    /** 拆封日期 */
    openedAt: text('opened_at').$type<CalendarDay>(),
    /** 开封后有效期（天）。与 openedAt 同时填才生效。 */
    openLifeDays: integer('open_life_days'),
    location: text('location'),
    /** in_stock / used_up / expired / discarded */
    status: text('status').notNull().default('in_stock'),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('batches_medicine_idx').on(t.medicineId),
    index('batches_owner_idx').on(t.ownerId),
    index('batches_status_idx').on(t.status),
  ],
);

// ── 数量变动记录（只增不改不删，不变量 8） ───────────────────────────────
export const stockEvents = sqliteTable(
  'stock_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    /** in / take / used_up / discard / mark_expired / restock / auto_take / edit */
    type: text('type').notNull(),
    /** 正 = 增，负 = 减。仅 edit 可以是 0。 */
    deltaQty: integer('delta_qty').notNull(),
    /** 事件发生后的余额 */
    qtyAfter: integer('qty_after').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('stock_events_batch_idx').on(t.batchId)],
);

// ── 设置（键值对） ─────────────────────────────────────────────────────
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type Member = typeof members.$inferSelect;
export type Medicine = typeof medicines.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type StockEvent = typeof stockEvents.$inferSelect;
export type Setting = typeof settings.$inferSelect;
