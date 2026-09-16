/**
 * M1 验收用的「黄金数字」。
 *
 * ── 这个文件是干什么的 ─────────────────────────────────────────────────
 * M1 的验收标准是「**看到的数量和网页版对得上**」。这句话如果只靠肉眼看，
 * 每次改代码都得重新对一遍，而且对不上的时候说不清是哪边错了。
 * 所以把网页版那一天显示的数字**钉在这里**：谁把数字改坏了，这里就红。
 *
 * 数据源是 `test/fixtures/all.json`（`D:\Downloads\all.json` 的副本），
 * 日期用导出的那一天（2026-09-16），这样「快过期 / 已过期」的分档和当时
 * 网页版看到的一致 —— 换个日期跑分档当然会变，但那不是回归，是时间在走。
 *
 * ⚠️ **改这里的数字之前先想清楚**：这些值是从真实数据算出来的，不是随手填的。
 * 要改，得说明是哪条**领域规则**变了（而不是「测试挂了就改测试」）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_NEAR_EXPIRY_DAYS,
  DEFAULT_RESTOCK_DAYS,
  SHARED_LABEL,
  type ExpiryStatus,
} from '../src/domain/constants';
import type { CalendarDay } from '../src/domain/calendar';
import { classify, effectiveExpiry } from '../src/domain/expiry';
import { daysOfSupply, needsRestock } from '../src/domain/forecast';
import { parseExport } from '../src/importer/parse';

/** 导出那天。效期分档依赖这个日期。 */
const EXPORT_DAY: CalendarDay = '2026-09-16';

const raw = readFileSync(join(__dirname, 'fixtures', 'all.json'), 'utf8');
const parsed = parseExport(raw, EXPORT_DAY);
if (!parsed.ok) throw new Error(`fixture 应该能解析，却报了：${parsed.errors.join('; ')}`);
const data = parsed.data;

/** 在库批次 + 派生字段，等价于 App 里 `inStockRows()` 算出来的东西。 */
const inStock = data.batches
  .filter((b) => b.status === 'in_stock')
  .map((b) => ({
    batch: b,
    effective: effectiveExpiry(b),
    status: classify(b, EXPORT_DAY, DEFAULT_NEAR_EXPIRY_DAYS) as ExpiryStatus,
  }));

/** 每个药的在库合计，用于算可用天数。 */
const totalByMedicine = new Map<number, number>();
for (const b of inStock) {
  totalByMedicine.set(
    b.batch.oldMedicineId,
    (totalByMedicine.get(b.batch.oldMedicineId) ?? 0) + b.batch.qty,
  );
}

/** 首页统计格要显示的那四个数。 */
const tally = { inStock: inStock.length, expiring: 0, expired: 0, none: 0 };
for (const r of inStock) {
  if (r.status === 'expiring') tally.expiring++;
  else if (r.status === 'expired') tally.expired++;
  else if (r.status === 'none') tally.none++;
}

/** 需补货的药（首页「需补货」那一段）。 */
const restock = data.medicines
  .filter((m) => m.dailyDose !== null && m.dailyDose > 0)
  .map((m) => ({
    generic: m.generic,
    dos: daysOfSupply(totalByMedicine.get(m.oldId) ?? 0, m.dailyDose)!,
  }))
  .filter((r) => needsRestock(r.dos, DEFAULT_RESTOCK_DAYS))
  .sort((a, b) => a.dos - b.dos);

/** 按成员：名下有在库的药品种数（含「家庭共用」）。 */
const perMember = (() => {
  const nameOf = new Map(data.members.map((m) => [m.oldId, m.name]));
  const byName = new Map<string, Set<number>>();
  for (const r of inStock) {
    const key = r.batch.oldOwnerId === null ? SHARED_LABEL : nameOf.get(r.batch.oldOwnerId)!;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(r.batch.oldMedicineId);
  }
  return [...byName.entries()]
    .map(([name, ids]) => ({ name, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
})();

describe('M1 黄金数字 —— 这批数字就是「和网页版对得上」的定义', () => {
  it('规模：3 成员 / 37 药品 / 44 批次 / 6 条变动', () => {
    expect(data.members).toHaveLength(3);
    expect(data.medicines).toHaveLength(37);
    expect(data.batches).toHaveLength(44);
    expect(data.events).toHaveLength(6);
  });

  it('44 条批次全部在库 → 首页「在库批次」格显示 44', () => {
    expect(inStock).toHaveLength(44);
  });

  it('库存合计 2118 单位', () => {
    expect(data.stats.totalQty).toBe(2118);
  });

  it('成员是 外公 / 妈妈 / 孩子', () => {
    expect(data.members.map((m) => m.name).sort()).toEqual(['外公', '孩子', '妈妈'].sort());
  });

  it('自动扣减的药正好 6 个，全是外公的三高药，且导入后起算日都归零', () => {
    const auto = data.medicines.filter((m) => m.autoDeduct);
    expect(auto.map((m) => m.generic).sort()).toEqual(
      [
        '缬沙坦胶囊',
        '阿托伐他汀钙片',
        '盐酸二甲双胍缓释片',
        '阿司匹林肠溶片',
        '苯磺酸氨氯地平片',
        '格列美脲片',
      ].sort(),
    );
    for (const m of auto) {
      expect(m.autoFrom).toBe(EXPORT_DAY); // 导入时被重设成导入当天，不是文件里的旧值
      expect(m.autoAccounted).toBe(0);
    }
  });

  it('阈值为默认的 90 / 15 天', () => {
    expect(data.settings.nearExpiryDays).toBe(DEFAULT_NEAR_EXPIRY_DAYS);
    expect(data.settings.restockDays).toBe(DEFAULT_RESTOCK_DAYS);
  });

  it('首页统计格：在库 44 / 快过期 1 / 已过期 0 / 未填效期 13', () => {
    // 「未填效期 13」这一条特别值得钉住：44 盒里有 13 盒根本没有效期，
    // 首页会显示成 13 个灰药丸。不知道的人会以为数据导丢了，其实文件里就没有。
    expect(tally).toEqual({ inStock: 44, expiring: 1, expired: 0, none: 13 });
  });

  it('最早的提醒日是 2026-11-30（+75 天），落在 90 天窗口里', () => {
    const days = inStock
      .map((r) => r.effective)
      .filter((d): d is CalendarDay => d !== null)
      .sort()[0];
    expect(days).toBe('2026-11-30');
  });

  it('需补货只有 1 种药：阿托伐他汀钙片，约剩 6 天', () => {
    expect(restock).toEqual([{ generic: '阿托伐他汀钙片', dos: 6 }]);
  });

  it('按成员：外公 6 / 家庭共用 16 / 孩子 14 / 妈妈 1（合计 37 = 全部档案）', () => {
    expect(perMember).toEqual([
      { name: SHARED_LABEL, count: 16 },
      { name: '孩子', count: 14 },
      { name: '外公', count: 6 },
      { name: '妈妈', count: 1 },
    ]);
    // 每种药最多出现在一个人名下，所以各档相加必然等于档案总数 ——
    // 对不上就说明同一盒药被算进了两个人，或者有药没进任何一档
    expect(perMember.reduce((s, m) => s + m.count, 0)).toBe(data.medicines.length);
  });

  it('没有「同一药下单位混用」的情况 —— App 上不该出现那条红字告警', () => {
    const unitsPerMed = new Map<number, Set<string>>();
    for (const r of inStock) {
      const s = unitsPerMed.get(r.batch.oldMedicineId) ?? new Set<string>();
      s.add(r.batch.unit);
      unitsPerMed.set(r.batch.oldMedicineId, s);
    }
    const conflicted = [...unitsPerMed.entries()].filter(([, s]) => s.size > 1);
    expect(conflicted).toEqual([]);
  });

  it('导入会重设 6 个药的起算日 —— 结果页必须把这 6 个名字列出来', () => {
    expect(data.autoRestarted).toHaveLength(6);
    expect(new Set(data.autoRestarted.map((m) => m.generic)).size).toBe(6);
    // 原始起算日都是 2026-09-15，比导出日早一天
    for (const m of data.autoRestarted) expect(m.originalAutoFrom).toBe('2026-09-15');
  });

  /**
   * `warnings` 不是「出错了」的通道，是「**有件事你该知道**」的通道 ——
   * 这两条都是真实文件里必然出现的正常现象，导入页会照原样列出来。
   * 所以这里钉死条数与内容：多出来一条就说明解析器发现了新情况，
   * 要么是真问题，要么是它变得过于啰嗦（后者会让人不再读这些提示）。
   */
  it('真实文件产生且仅产生 2 条提示，内容固定', () => {
    expect(data.warnings).toHaveLength(2);
    expect(data.warnings[0]).toContain('migrate_medicine_unit_owner_v1');
    expect(data.warnings[0]).toContain('migrate_auto_deduct_v1');
    // 44 条在库 − 6 条有记录的 = 38 条历史批次没有入库记录。
    // 这是刻意不补造的（§6.9），所以它必须一直在提示里说清楚。
    expect(data.warnings[1]).toContain('38 条在库没有变动记录');
  });
});
