/**
 * 导出 `version: 1` JSON —— `AGENTS.md` 硬约束 5 的落点。
 *
 * 这个模块是**纯的**：吃一个 drizzle 句柄和一个时刻，吐一段字符串。
 * 它只做 SELECT，不调 `settleAll`、不写库、**不 import 任何 expo 模块** ——
 * 所以它能在 jest（node 环境，见 `jest.config.js`）里被直接测。
 * 「写文件 + 拉分享面板」那些副作用全在 `app/export.tsx` 里。
 *
 * ── 四条保命规则 ──────────────────────────────────────────────────────
 * 1. **键严格等于 `src/importer/parse.ts` 的白名单**，顺序也照抄网页版
 *    `../medbox-app/app/routes/export.py`。多一个键 = 将来导入时多一条警告。
 * 2. **四张表都按 `id` 升序。** `stock_events` 尤其必须 —— 不变量 1 的平局
 *    判定是 `>=`（`parse.ts:541`），同 `createdAt` 时**数组里靠后的赢**，
 *    而「靠后 = 写入更晚」的唯一可靠依据是 `id`。
 * 3. **`settings` 只写两个阈值键。** 绝不 spread settings 表 ——
 *    `last_import_at` / `last_import_file` / `migrate_*` 结构上不可能泄漏出去。
 * 4. **自检**：生成完立刻用导入端那把尺子（`parseExport`）量自己一遍，
 *    不过就不出文件。硬约束 5 从此是**运行时自证**，不是「测试里钉住」——
 *    将来任何改动破坏了双向兼容，导出**当场**失败，而不是等到用户真的要
 *    恢复备份时才发现。
 */
import type { MedboxDb } from '../db/client';
import {
  batches,
  medicines,
  members,
  stockEvents,
  type Instant,
  type Medicine,
} from '../db/schema';
import {
  BATCH_DISCARDED,
  BATCH_IN_STOCK,
  BATCH_USED_UP,
  DEFAULT_NEAR_EXPIRY_DAYS,
  DEFAULT_RESTOCK_DAYS,
  KEY_NEAR_EXPIRY_DAYS,
  KEY_RESTOCK_DAYS,
} from '../domain/constants';
import { toLocalNaiveString, toNaiveUtcString } from '../domain/instant';
import { getIntSetting } from '../importer/apply';
import { parseExport } from '../importer/parse';

/** 机器读的文件保持 ASCII —— 用户认得这个名字，网页版也叫它 `all.json`。 */
export const EXPORT_FILE_NAME = 'all.json';

/** 自检用的导入日。它只影响「自动扣减药的起算日被重设成哪天」，
 *  既不进 `errors` 也不进 `warnings`，所以传常量比传今天更不容易被误读。 */
const SELF_CHECK_DAY = '2000-01-01';

// ── 输出行的类型：键名与顺序都 = 网页版 export.py 的 payload ────────────

export type ExportedMember = {
  id: number;
  name: string;
  notes: string | null;
  created_at: string;
};

export type ExportedMedicine = {
  id: number;
  generic: string;
  brand: string | null;
  spec: string | null;
  form: string | null;
  category: string | null;
  purpose_notes: string | null;
  daily_dose: number | null;
  unit: string;
  owner_id: number | null;
  auto_deduct: boolean;
  auto_paused: boolean;
  auto_from: string | null;
  auto_accounted: number;
  created_at: string;
};

export type ExportedBatch = {
  id: number;
  medicine_id: number;
  owner_id: number | null;
  qty: number;
  unit: string;
  expiry_date: string | null;
  opened_at: string | null;
  open_life_days: number | null;
  location: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ExportedEvent = {
  id: number;
  batch_id: number;
  type: string;
  delta_qty: number;
  qty_after: number;
  reason: string | null;
  created_at: string;
};

export type ExportDocument = {
  version: 1;
  exported_at: string;
  settings: Record<string, string>;
  members: ExportedMember[];
  medicines: ExportedMedicine[];
  batches: ExportedBatch[];
  stock_events: ExportedEvent[];
};

export type ExportStats = {
  members: number;
  medicines: number;
  batches: number;
  events: number;
  totalQty: number;
};

/**
 * 导出时为「让文件导得回来」而对语义做的调整。
 * **必须显示给用户**（导出页有一张橙色提示卡），不许静默改语义 ——
 * 与导入页「这 6 种药的起算日会改成今天」必须列出来是同一条原则。
 */
export type ExportNotice = {
  kind: 'zero_qty_in_stock_as_used_up';
  batchId: number;
  generic: string;
};

export type ExportResult =
  | {
      ok: true;
      json: string;
      fileName: string;
      stats: ExportStats;
      notices: ExportNotice[];
      /** 自检里 `parseExport` 给的 warnings，原样透出（导入页同款展示） */
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
      /**
       * 失败来自哪一步 —— 界面据此换文案，**不是**靠匹配错误文本里的某个字：
       * - `preflight`：我们能提前检查出来的问题，用户**在界面里改得动**
       *   （单位没填、状态与数量对不上、开封天数不是正数）→ 指路到具体界面。
       * - `self_check`：我们用导入端那把尺子量自己，量不过。这一类的意思恰好是
       *   「界面里改不动的东西坏了」→ 只能说「这份数据本身有问题」，不能指路。
       */
      reason: 'preflight' | 'self_check';
    };

// ── 主函数 ─────────────────────────────────────────────────────────────

/**
 * 把库里的全部数据组装成 `version: 1` 的 JSON 文本。
 *
 * **只读**：全程只有 `db.select`（`test/exporter/roundtrip.test.ts` 里有一条
 * 静态守卫在读源码断言这一点）。
 *
 * @param now 导出时刻。显式传进来而不是内部取 `Date.now()`，测试才能固定住它。
 */
export function buildExport(db: MedboxDb, now: Instant): ExportResult {
  const meds = db.select().from(medicines).orderBy(medicines.id).all();
  const nameOf = new Map<number, string>(meds.map((m) => [m.id, m.generic]));

  // ── 预检 1：单位必填 ───────────────────────────────────────────────
  // 正常路径到不了这里（建档校验拦住了空单位，导入方向也会整份拒绝），
  // 但 schema 上 unit 可空（`src/db/schema.ts:55`）。而 `parse.ts:337` 会
  // 拒绝空单位 —— 也就是**导出去了也导不回来**，所以提前拒绝并点名。
  const noUnit = meds.filter((m) => (m.unit ?? '').trim() === '');
  if (noUnit.length > 0) {
    return { ok: false, reason: 'preflight', errors: [unitErrorMessage(noUnit)] };
  }

  const rawBatches = db.select().from(batches).orderBy(batches.id).all();

  // ── 预检 2：状态/数量对不上、开封天数 ≤ 0 ──────────────────────────
  const bad = collectBadBatches(rawBatches, nameOf);
  if (bad.length > 0) return { ok: false, reason: 'preflight', errors: bad };

  // ── 归一化：`in_stock` + qty 0 → `used_up` ─────────────────────────
  // 取用把一盒取空后 `planTake` **不转状态**（`src/domain/stock.ts:305-307`
  // 只 push 了 `{ qty: qtyAfter }`，网页版 `batches.py` 的 `take_from_batch`
  // 同样不转），而 `parse.ts:434` 的不变量 4 会拒绝 `in_stock` + qty 0。
  // 归一化不是发明 —— `planEdit` 和结算自己扣到 0 时留下的**都是** `used_up`，
  // 是 `planTake` 那一处不一致，导出端在替它兜。
  // 正确性：不变量 3 要求 `used_up` 的 qty 为 0 ✅（本来就是 0）；
  // 不变量 1 要求最后一条事件的 qtyAfter == qty —— 取空那条事件的
  // `qtyAfter` 正是 0 ✅（真对不上说明是手工改的库，自检会拦下）。
  const notices: ExportNotice[] = [];

  const doc: ExportDocument = {
    version: 1,
    // exported_at 是**本地** naive，与 created_at 的 UTC 口径相反（§6.2）
    exported_at: toLocalNaiveString(now),
    settings: buildSettings(db),
    members: db
      .select()
      .from(members)
      .orderBy(members.id)
      .all()
      .map((m) => ({
        id: m.id,
        name: m.name,
        notes: m.notes,
        created_at: toNaiveUtcString(m.createdAt),
      })),
    medicines: meds.map((m) => ({
      id: m.id,
      generic: m.generic,
      brand: m.brand,
      spec: m.spec,
      form: m.form,
      category: m.category,
      purpose_notes: m.purposeNotes,
      daily_dose: m.dailyDose,
      unit: m.unit!, // 预检 1 已保证非空
      owner_id: m.ownerId,
      auto_deduct: m.autoDeduct,
      auto_paused: m.autoPaused,
      auto_from: m.autoFrom ?? null,
      auto_accounted: m.autoAccounted,
      created_at: toNaiveUtcString(m.createdAt),
    })),
    batches: rawBatches.map((b) => {
      const status = b.status === BATCH_IN_STOCK && b.qty === 0 ? BATCH_USED_UP : b.status;
      if (status !== b.status) {
        notices.push({
          kind: 'zero_qty_in_stock_as_used_up',
          batchId: b.id,
          generic: nameOf.get(b.medicineId) ?? `药品 #${b.medicineId}`,
        });
      }
      return {
        id: b.id,
        medicine_id: b.medicineId,
        owner_id: b.ownerId,
        qty: b.qty,
        unit: b.unit,
        expiry_date: b.expiryDate ?? null,
        opened_at: b.openedAt ?? null,
        open_life_days: b.openLifeDays,
        location: b.location,
        status,
        notes: b.notes,
        created_at: toNaiveUtcString(b.createdAt),
        updated_at: toNaiveUtcString(b.updatedAt),
      };
    }),
    // 🔴 必须按 id 升序，理由见文件头规则 2
    stock_events: db
      .select()
      .from(stockEvents)
      .orderBy(stockEvents.id)
      .all()
      .map((e) => ({
        id: e.id,
        batch_id: e.batchId,
        type: e.type,
        delta_qty: e.deltaQty,
        qty_after: e.qtyAfter,
        reason: e.reason,
        created_at: toNaiveUtcString(e.createdAt),
      })),
  };

  const json = JSON.stringify(doc, null, 2);

  // ── 自检：拿导入端那把尺子量自己（文件头规则 4）────────────────────
  const self = parseExport(json, SELF_CHECK_DAY);
  if (!self.ok) return { ok: false, reason: 'self_check', errors: self.errors };

  return {
    ok: true,
    json,
    fileName: EXPORT_FILE_NAME,
    stats: {
      members: doc.members.length,
      medicines: doc.medicines.length,
      batches: doc.batches.length,
      events: doc.stock_events.length,
      totalQty: doc.batches
        .filter((b) => b.status === BATCH_IN_STOCK)
        .reduce((sum, b) => sum + b.qty, 0),
    },
    notices,
    warnings: self.data.warnings,
  };
}

// ── 内部 ───────────────────────────────────────────────────────────────

/**
 * `settings` 只写两个阈值。
 *
 * 🔴 **绝不 `...spread` settings 表**：那会把 `last_import_at` /
 * `last_import_file`（App 自己的）和 `migrate_*`（网页版内部迁移标记）
 * 一起写进去，导入时 `parse.ts:282` 会为它们各报一条警告 —— 我们自己的
 * 备份文件不该带着这种东西。
 */
function buildSettings(db: MedboxDb): Record<string, string> {
  return {
    [KEY_NEAR_EXPIRY_DAYS]: String(
      getIntSetting(db, KEY_NEAR_EXPIRY_DAYS, DEFAULT_NEAR_EXPIRY_DAYS),
    ),
    [KEY_RESTOCK_DAYS]: String(getIntSetting(db, KEY_RESTOCK_DAYS, DEFAULT_RESTOCK_DAYS)),
  };
}

type RawBatch = typeof batches.$inferSelect;

/**
 * 找出「导出去了也导不回来」的批次 —— 一次列全，不是报一个改一个。
 *
 * 两类都是**可达**的，不是防御幻想出来的状态：
 * - `used_up`/`discarded` 而数量不为 0：`planEdit` 对**所有状态**的盒都渲染
 *   「编辑」按钮，而它只在 `in_stock` 时才顺带写 status —— 编辑一个已用完的
 *   盒并填上数量，就得到这个状态。
 *   没有合法表达：要满足不变量 3 就得把 qty 改 0，但那会同时打破不变量 1
 *   （最后一条 edit 事件的 qtyAfter 是那个非 0 值）；改事件更不行
 *   （不变量 8：StockEvent 只增不改不删）。所以只能拒绝。
 * - `open_life_days ≤ 0`：`planEdit` 用 `parseOptionalInt`（正则 `^-?\d+$`，
 *   `src/domain/stock.ts:141`）**漏了 > 0 的校验**，而 `planIntake` 有
 *   （`stock.ts:246`）；`parse.ts:446` 会拒绝。
 */
function collectBadBatches(b: RawBatch[], nameOf: Map<number, string>): string[] {
  const errors: string[] = [];
  const label = (x: RawBatch) =>
    `「${nameOf.get(x.medicineId) ?? `药品 #${x.medicineId}`}」第 #${x.id} 盒`;

  const badStatus = b.filter(
    (x) =>
      (x.status === BATCH_USED_UP || x.status === BATCH_DISCARDED) && x.qty !== 0,
  );
  if (badStatus.length > 0) {
    const one = badStatus[0];
    errors.push(
      `有 ${badStatus.length} 盒的状态和数量对不上，例如${label(one)}：` +
        `状态是「${one.status}」但数量是 ${one.qty}。\n` +
        '这种数据导出去了也导不回来（导入端会拒绝整份文件），所以先不生成。\n' +
        '请打开那一盒，把数量改回 0，或用「恢复在库」把它改回在库，再导出。',
    );
  }

  const badOpenLife = b.filter((x) => x.openLifeDays !== null && x.openLifeDays <= 0);
  if (badOpenLife.length > 0) {
    const one = badOpenLife[0];
    errors.push(
      `有 ${badOpenLife.length} 盒的「开封后有效期」不是正数，例如${label(one)}：` +
        `填的是 ${one.openLifeDays} 天。\n` +
        '这个值导出去了也导不回来，所以先不生成。\n' +
        '请打开那一盒，把「开封后有效期」改成大于 0 的天数（或清空）。',
    );
  }

  return errors;
}

function unitErrorMessage(bad: Medicine[]): string {
  const names = bad
    .slice(0, 5)
    .map((m) => `「${m.generic}」(id ${m.id})`)
    .join('、');
  const more = bad.length > 5 ? ` 等 ${bad.length} 个` : '';
  return (
    `有 ${bad.length} 个药品档案没填单位：${names}${more}。\n` +
    'version: 1 的格式要求每个药都必须有单位，这份文件导出去了也导不回来，所以先不生成。\n' +
    '请到「药品档案 → 编辑」把单位补上再导出。'
  );
}
