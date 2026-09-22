/**
 * 「在库清单」纯文本 —— DESIGN.md §5.3 里那半个「可读分享」。
 *
 * ── 为什么是纯文本，不是 PDF ───────────────────────────────────────────
 * `requirements.md:358` 明确把格式降级成**实现选择**（「Excel / CSV / PDF /
 * 分享面板」都不是需求），§3.4 要的是「适合**打印或发给别人**」这个**结果**。
 * 纯文本在微信里可读、可复制、能打印，而且**不引第二个依赖**
 * （PDF 要 `expo-print`）。少一个原生依赖 = 少一次出包风险。
 *
 * ── 零新领域逻辑 ──────────────────────────────────────────────────────
 * 全部复用现成的：`inStockRows` 已经算好提醒日、效期分档、预计可用天数，
 * `buildGroups` 已经做好分组与组间排序（**和首页同一套**，
 * 所以清单的顺序和用户在 App 里看到的一致，不用重新学）。
 * 这个文件只负责「排版成字」。
 *
 * 和 `build.ts` 一样是**纯的**：只 SELECT，不 import 任何 expo 模块。
 */
import type { MedboxDb } from '../db/client';
import type { CalendarDay, Instant } from '../db/schema';
import { formatDos } from '../domain/forecast';
import { toLocalDisplay } from '../domain/instant';
import { SHARED_LABEL } from '../domain/constants';
import {
  aggregateByMedicine,
  buildGroups,
  dashboard,
  getThresholds,
  inStockRows,
  type BatchRow,
  type MedGroup,
  type MedicineAgg,
} from '../data/queries';

/** 一盒一行。 */
export type ReportBox = {
  batchId: number;
  qty: number;
  unit: string;
  /** 印刷效期原文 */
  expiryDate: CalendarDay | null;
  /** 提醒日；与 expiryDate 不同时（拆封+开封天数更早）才多印一行 */
  effective: CalendarDay | null;
  location: string | null;
  showReminder: boolean;
};

export type ReportGroup = {
  medicineId: number;
  generic: string;
  spec: string | null;
  /** 归属。同一种药的多盒归属不一致时用 `/` 连起来 */
  ownerLabel: string;
  /** 与首页完全一致的合计文本，如「合计 34 片」 */
  totalText: string;
  boxCount: number;
  earliest: CalendarDay | null;
  /** 药级的「约剩 N 天」；null = 不打印（没设每日用量） */
  daysOfSupply: number | null;
  /** 在库批次单位混用 → 跨单位相加没有意义 → 不打印天数 */
  unitConflict: boolean;
  needsRestock: boolean;
  boxes: ReportBox[];
};

export type ReportSummary = {
  boxCount: number;
  medicineCount: number;
  totalQty: number;
  expiringBoxes: number;
  expiredBoxes: number;
  noExpiryBoxes: number;
  /**
   * 需补货的药（药级，含 0 库存的）。
   * `daysOfSupply` 为 **null = 单位不统一，天数算不准** —— 与组内说明同一个口径，
   * 两处必须一致：同一份清单里一处印「无法估算天数」、另一处印「约剩 10 天」，
   * 读的人只会信那个数字。
   */
  restock: { generic: string; daysOfSupply: number | null }[];
  nearDays: number;
  restockDays: number;
};

export type InventoryReport = {
  text: string;
  fileName: string;
  generatedAt: Instant;
  today: CalendarDay;
  groups: ReportGroup[];
  summary: ReportSummary;
};

/**
 * 生成在库清单。
 *
 * 内容范围：**只有 `in_stock` 且 `qty > 0` 的盒**。已用完/已过期/已丢弃
 * 不进「在库清单」；`qty = 0` 的在库盒导出时会被归一到「已用完」（`build.ts`），
 * 这里也一并排除 —— 两边口径一致。
 */
export function buildInventoryReport(
  db: MedboxDb,
  today: CalendarDay,
  now: Instant,
): InventoryReport {
  const th = getThresholds(db);
  const rows = inStockRows(db, today, th);
  const agg = aggregateByMedicine(db);

  // 与首页同一套分组与排序；`hiddenLabel` 用不上（我们不筛掉任何盒）
  const visible = buildGroups(rows, (r) => r.batch.qty > 0, '');
  const groups = visible.map((g) => toReportGroup(g, agg.get(g.medicine.id)?.unitConflict ?? false));

  const boxes = groups.flatMap((g) => g.boxes);
  const restock = restockRows(db, today, agg);

  const summary: ReportSummary = {
    boxCount: boxes.length,
    medicineCount: groups.length,
    totalQty: boxes.reduce((s, b) => s + b.qty, 0),
    expiringBoxes: countStatus(visible, 'expiring'),
    expiredBoxes: countStatus(visible, 'expired'),
    noExpiryBoxes: countStatus(visible, 'none'),
    restock,
    nearDays: th.nearDays,
    restockDays: th.restockDays,
  };

  return {
    text: render(groups, summary, now),
    fileName: `在库清单-${today}.txt`,
    generatedAt: now,
    today,
    groups,
    summary,
  };
}

// ── 组装 ───────────────────────────────────────────────────────────────

function toReportGroup(g: MedGroup, unitConflict: boolean): ReportGroup {
  const owners = [...new Set(g.sublines.map((r) => r.owner?.name ?? SHARED_LABEL))];
  const boxes: ReportBox[] = g.sublines.map((r) => ({
    batchId: r.batch.id,
    qty: r.batch.qty,
    unit: r.batch.unit,
    expiryDate: r.batch.expiryDate,
    effective: r.effective,
    location: r.batch.location,
    // 提醒日只有在**不同于**印刷效期时才值得单独印一行
    // （「拆封 + 开封天数」比印刷效期更早的情形）
    showReminder: r.effective !== null && r.effective !== r.batch.expiryDate,
  }));

  return {
    medicineId: g.medicine.id,
    generic: g.medicine.generic,
    spec: g.medicine.spec,
    ownerLabel: owners.join(' / '),
    totalText: g.totalText,
    boxCount: boxes.length,
    earliest: earliestOf(g.sublines),
    daysOfSupply: g.daysOfSupply,
    // 单位混用时天数没有意义（跨单位相加），宁可不说也不给一个假的确定值
    unitConflict,
    needsRestock: g.needsRestock,
    boxes,
  };
}

function earliestOf(rows: BatchRow[]): CalendarDay | null {
  let best: CalendarDay | null = null;
  for (const r of rows) {
    if (r.effective !== null && (best === null || r.effective < best)) best = r.effective;
  }
  return best;
}

function countStatus(groups: MedGroup[], status: string): number {
  return groups.reduce(
    (n, g) => n + g.sublines.filter((r) => r.expiryStatus === status).length,
    0,
  );
}

/**
 * 需补货的药。名单直接用首页那个 `dashboard` —— 它是权威实现，口径已经过验收
 * （「需补货只有阿托伐他汀 · 约剩 6 天」）。自己再算一遍只会多一处能算错的地方。
 * 注意它是**药级**的：没有在库批次的药（0 库存）也算（§3.5）。
 *
 * ⚠️ 但**天数在这一处要按本清单的口径再筛一次**：`dashboard` 与首页一致地
 * 给单位混用的药也算天数（网页版的 `units_conflict` 只挡自动扣减，不挡补货预测），
 * 那个数来自「4 片 + 6 粒」这种没有意义的相加。首页照印是既成事实，而这份清单
 * 是要发给家人、脱离 App 单独看的 —— 里面一处说「无法估算天数」、另一处又给出
 * 「约剩 10 天」，读的人只会信数字。所以名单**保留**（`需补货 N 种` 的个数
 * 必须和首页对得上），数字抹成 null，由排版那层改印原因。
 *
 * 这是**刻意与首页不同**的一处，见 DESIGN.md §7.6 / §9。
 */
function restockRows(
  db: MedboxDb,
  today: CalendarDay,
  agg: Map<number, MedicineAgg>,
): { generic: string; daysOfSupply: number | null }[] {
  return dashboard(db, today).needRestock.map((r) => ({
    generic: r.medicine.generic,
    // 没有任何在库批次的药（0 库存）在 agg 里没有条目 → 保持原来的天数（通常是 0）
    daysOfSupply: agg.get(r.medicine.id)?.unitConflict ? null : r.daysOfSupply,
  }));
}

// ── 排版 ───────────────────────────────────────────────────────────────

/**
 * 格式约定（改了会影响用户对清单的信任，别随手改）：
 * - UTF-8 **无 BOM**、`\n` 换行（不是 `\r\n`）
 * - 日期一律 `YYYY-MM-DD`，不加工
 * - 组之间一个空行，**不用横线**（省掉换行与字体的坑）
 * - 位置为空印 `—`
 */
function render(groups: ReportGroup[], s: ReportSummary, now: Instant): string {
  const L: string[] = [];

  L.push('家庭药箱 · 在库清单');
  L.push(`生成 ${toLocalDisplay(now)}（手机本地时间）`);
  L.push('');
  L.push(`在库 ${s.boxCount} 盒 / ${s.medicineCount} 种 · 合计 ${s.totalQty} 单位`);
  L.push(
    `需补货 ${s.restock.length} 种 · 快过期 ${s.expiringBoxes} 盒 · ` +
      `已过期 ${s.expiredBoxes} 盒 · 未填效期 ${s.noExpiryBoxes} 盒`,
  );
  L.push(`阈值：快过期 ${s.nearDays} 天 · 需补货 ${s.restockDays} 天`);
  L.push('');
  L.push('说明');
  L.push('· 按「提醒日」从近到远排。提醒日 = 印刷效期 与「拆封日期 + 开封后天数」里较早的那个。');
  L.push('· 「未填效期」表示这盒药没有失效依据，请自己看一眼。');
  L.push('· 「约剩 N 天」= 该药在库合计 ÷ 每日用量，只是个估算。');

  // ⚠️ 「需补货」这行必须印在**空药箱那句之前**。它就挂在 `groups.length === 0`
  // 早退之后的那个位置时，会出现「头部说需补货 1 种，正文里一个字都不提是谁」——
  // 而「一盒在库都没有」正是最该看补货名单的场合（§3.5：0 库存也算需补货）。
  if (s.restock.length > 0) {
    L.push('');
    L.push('需补货：' + s.restock.map(restockText).join('、'));
  }

  if (groups.length === 0) {
    L.push('');
    L.push('（药箱里还没有在库的药）');
    return L.join('\n') + '\n';
  }

  groups.forEach((g, i) => {
    L.push('');
    L.push(`[${i + 1}] ${g.generic}${g.spec ? `（${g.spec}）` : ''}${g.needsRestock ? '【需补货】' : ''}`);
    L.push(`    ${groupSubline(g)}`);
    for (const b of g.boxes) {
      L.push(`      ${boxLine(b)}`);
      if (b.showReminder) L.push(`        ↳ 提醒日 ${b.effective}`);
    }
  });

  return L.join('\n') + '\n';
}

/**
 * 需补货行里的一味药。`daysOfSupply === null` 时印原因而不是数字 ——
 * 与组内说明同一句话，读的人在两处看到的是同一个判断。
 */
function restockText(r: { generic: string; daysOfSupply: number | null }): string {
  return r.daysOfSupply === null
    ? `${r.generic}（单位不统一，天数算不准）`
    : `${r.generic}（约剩 ${formatDos(r.daysOfSupply)} 天）`;
}

function groupSubline(g: ReportGroup): string {
  const parts = [
    g.ownerLabel,
    g.totalText.replace(/^合计\s*/, ''),
    `${g.boxCount} 盒`,
    g.earliest ? `最早提醒 ${g.earliest}` : '未填效期',
  ];
  if (g.unitConflict) {
    parts.push('（有不止一种单位，无法估算天数）');
  } else if (g.daysOfSupply !== null) {
    parts.push(`约剩 ${formatDos(g.daysOfSupply)} 天`);
  }
  return parts.join(' · ');
}

function boxLine(b: ReportBox): string {
  return [
    `${b.qty} ${b.unit}`,
    b.expiryDate ? `效期 ${b.expiryDate}` : '未填效期',
    b.location ?? '—',
  ].join(' · ');
}
