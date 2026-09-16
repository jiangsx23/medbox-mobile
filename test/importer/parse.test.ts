/**
 * 导入解析的测试 —— 逐条盯着 DESIGN.md §7.2 的 7 个坑。
 *
 * 前面一半用**真实文件** `test/fixtures/all.json`（2026-09-16 从网页版导出，
 * 与 `D:\Downloads\all.json` 同一份），确保校验规则不会比真实数据更严 ——
 * 那会让 M1 最后一步「导入真实数据」直接失败。
 *
 * 后半用**合成数据**制造真实数据里不存在但迟早会遇到的坏情况
 * （时区标记、缺字段、坏外键），确认它们是被**拒绝**而不是被静默兜底。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseExport, type ParsedImport } from '../../src/importer/parse';

const REAL_FILE = readFileSync(join(__dirname, '..', 'fixtures', 'all.json'), 'utf8');

/** 导入当天固定住，否则「起算日被重设为今天」这条断言会随运行日期漂移。 */
const IMPORT_DAY = '2026-09-16';

/** 解析真实文件并要求成功，失败时把错误打出来（比 `expect(ok).toBe(true)` 好排查） */
function parseReal(): ParsedImport {
  const r = parseExport(REAL_FILE, IMPORT_DAY);
  if (!r.ok) throw new Error('真实文件解析失败：\n' + r.errors.join('\n'));
  return r.data;
}

/** 拿真实文件当底，改一处再解析 —— 用来制造单点坏数据 */
function mutate(fn: (doc: any) => void): ReturnType<typeof parseExport> {
  const doc = JSON.parse(REAL_FILE);
  fn(doc);
  return parseExport(JSON.stringify(doc), IMPORT_DAY);
}

// ══════════════════════════════════════════════════════════════════════
describe('真实文件 all.json', () => {
  it('能通过校验，且数量与网页版核对得上', () => {
    const d = parseReal();
    expect(d.stats).toEqual({
      members: 3,
      medicines: 37, // 注意不是 38 —— id 4 缺失（DESIGN.md §7.1）
      batches: 44,
      events: 6,
      totalQty: 2118,
    });
  });

  /**
   * ⚠️ DESIGN.md §7.1 写的是「库存合计 **2124** 单位」，那是**过时的**。
   *
   * 差额正好是 6，等于 6 条 auto_take 事件各扣 1。这 6 条事件的时刻是
   * `05:23:53Z`（= 本地 13:23:53），而 `exported_at` 是 13:23:58 ——
   * 也就是说**导出这个动作本身触发了惰性结算**，先把 6 个三高药各扣了 1，
   * 5 秒后才写出文件。2124 是扣减前的数，文件里已经是 2118。
   *
   * 这条测试把账算清楚，免得将来有人拿 2124 去「修正」正确的代码。
   */
  it('2124 是结算前的数：加上 6 条 auto_take 正好回到 2124', () => {
    const d = parseReal();
    const autoDeducted = d.events
      .filter((e) => e.type === 'auto_take')
      .reduce((sum, e) => sum + e.deltaQty, 0);
    expect(autoDeducted).toBe(-6);
    expect(d.stats.totalQty - autoDeducted).toBe(2124);
  });

  it('全部在库、且没有一条被漏掉', () => {
    const d = parseReal();
    expect(d.batches.every((b) => b.status === 'in_stock')).toBe(true);
    expect(d.batches.every((b) => b.qty > 0)).toBe(true);
  });

  it('ID 4 缺失这件事被原样保留（不重排 id）', () => {
    const d = parseReal();
    expect(d.medicines.map((m) => m.oldId)).not.toContain(4);
  });

  it('有 38 条在库没有变动记录 —— 原样导入，不补造假记录（§6.9）', () => {
    const d = parseReal();
    const batchesWithEvents = new Set(d.events.map((e) => e.oldBatchId));
    expect(batchesWithEvents.size).toBe(6);
    expect(d.batches.length - batchesWithEvents.size).toBe(38);
    expect(d.warnings.some((w) => w.includes('38'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('坑 1 🔴 自动扣减的起算日必须重设，否则扣爆库存', () => {
  it('6 个自动扣减药全部被重新起算到导入当天、账本归零', () => {
    const d = parseReal();
    const auto = d.medicines.filter((m) => m.autoDeduct && !m.autoPaused);

    expect(auto).toHaveLength(6);
    for (const m of auto) {
      expect(m.autoFrom).toBe(IMPORT_DAY); // 重设
      expect(m.autoAccounted).toBe(0); // 归零
    }
  });

  it('原文件里的起算日是 09-15、账本记着 1，证明重设确实发生了', () => {
    const d = parseReal();
    const auto = d.medicines.filter((m) => m.autoDeduct && !m.autoPaused);
    // 如果不重设，这两个值会被原样带进来 —— 正是「扣爆」的源头
    expect(auto.every((m) => m.originalAutoFrom === '2026-09-15')).toBe(true);
    expect(auto.every((m) => m.originalAutoAccounted === 1)).toBe(true);
  });

  it('auto_deduct / auto_paused 两个开关保持原值，不被改动（决策 8）', () => {
    const d = parseReal();
    const auto = d.medicines.filter((m) => m.autoDeduct);
    expect(auto).toHaveLength(6);
    expect(d.medicines.every((m) => m.autoPaused === false)).toBe(true);
  });

  it('6 个药被列进 autoRestarted，供结果页显式展示', () => {
    const d = parseReal();
    expect(d.autoRestarted).toHaveLength(6);
    expect(d.autoRestarted.map((a) => a.generic)).toEqual(
      expect.arrayContaining(['缬沙坦胶囊', '阿托伐他汀钙片', '盐酸二甲双胍缓释片', '阿司匹林肠溶片', '苯磺酸氨氯地平片', '格列美脲片']),
    );
  });

  it('导入当天再解析一次，结果完全一致（同一份文件重入不产生差异）', () => {
    const a = parseReal();
    const b = parseReal();
    expect(b.medicines).toEqual(a.medicines);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('坑 2 🔴 created_at 按 UTC 解析，exported_at 丢弃', () => {
  it('无时区标记的字符串被当作 UTC，而不是本地时间', () => {
    const d = parseReal();
    const ev = d.events[0];
    // 文件里是 '2026-09-16T05:23:53'。若误按本地时间(UTC+8)解析会得到
    // 2026-09-16T21:23:53Z —— 差 8 小时，足以跨过日期边界。
    expect(new Date(ev.createdAt).toISOString()).toBe('2026-09-16T05:23:53.000Z');
  });

  it('批次的两个时间戳同样按 UTC 解析', () => {
    const d = parseReal();
    const b = d.batches.find((x) => x.updatedAt !== x.createdAt)!;
    expect(new Date(b.updatedAt).toISOString()).toBe('2026-09-16T05:23:53.000Z');
    expect(new Date(b.createdAt).toISOString()).toBe('2026-09-03T15:23:11.000Z');
  });

  it('exported_at 只留原文，不参与任何计算', () => {
    const d = parseReal();
    expect(d.exportedAtRaw).toBe('2026-09-16T13:23:58.411989');
    // 它不在 ParsedImport 里变成任何时刻字段
    expect(Object.keys(d)).not.toContain('exportedAt');
  });

  it('带 Z 后缀时尊重后缀（同样表示 UTC）', () => {
    const r = mutate((doc) => {
      doc.stock_events[0].created_at = '2026-09-16T05:23:53Z';
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Date(r.data.events[0].createdAt).toISOString()).toBe('2026-09-16T05:23:53.000Z');
  });

  it('带 +08:00 偏移时按偏移换算，而不是当成 UTC', () => {
    const r = mutate((doc) => {
      doc.stock_events[0].created_at = '2026-09-16T13:23:53+08:00';
    });
    expect(r.ok).toBe(true);
    // 13:23:53+08:00 == 05:23:53Z
    if (r.ok) expect(new Date(r.data.events[0].createdAt).toISOString()).toBe('2026-09-16T05:23:53.000Z');
  });

  it('时间戳是垃圾时整份拒绝，而不是兜底成「现在」', () => {
    const r = mutate((doc) => {
      doc.stock_events[0].created_at = '不是时间';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('created_at');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('坑 3 🟠 settings 只取两个阈值，丢掉网页版内部迁移标记', () => {
  it('只保留 near_expiry_days 与 restock_days', () => {
    const d = parseReal();
    expect(d.settings).toEqual({ nearExpiryDays: 90, restockDays: 15 });
  });

  it('migrate_* 被丢掉，并且告诉用户丢了什么', () => {
    const d = parseReal();
    const w = d.warnings.find((x) => x.includes('migrate_'));
    expect(w).toBeDefined();
    expect(w).toContain('migrate_medicine_unit_owner_v1');
    expect(w).toContain('migrate_auto_deduct_v1');
  });

  it('settings 缺失时退回默认阈值，而不是报错', () => {
    const r = mutate((doc) => {
      delete doc.settings;
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.settings).toEqual({ nearExpiryDays: 90, restockDays: 15 });
  });

  it('阈值非法时退回默认值', () => {
    const r = mutate((doc) => {
      doc.settings.near_expiry_days = 'abc';
      doc.settings.restock_days = '';
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.settings).toEqual({ nearExpiryDays: 90, restockDays: 15 });
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('坑 4 🟡 布尔值是真布尔，不做字符串猜谜', () => {
  it('"0" 不会被当成 false 静默接受', () => {
    const r = mutate((doc) => {
      doc.medicines[0].auto_deduct = '0';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('auto_deduct');
  });

  it('"false" 同样被拒绝', () => {
    const r = mutate((doc) => {
      doc.medicines[1].auto_paused = 'false';
    });
    expect(r.ok).toBe(false);
  });

  it('整数 0 也被拒绝 —— 网页版库里存的是 0/1，但导出的是布尔，混了就是文件有问题', () => {
    const r = mutate((doc) => {
      doc.medicines[0].auto_deduct = 0;
    });
    expect(r.ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('整体拒绝：任何一条不合法都不写一半', () => {
  it('version 不是 1 → 拒绝', () => {
    const r = mutate((doc) => {
      doc.version = 2;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('version');
  });

  it('坏外键（批次的药不存在）→ 拒绝，且说明是外键问题', () => {
    const r = mutate((doc) => {
      doc.batches[0].medicine_id = 9999;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('外键');
  });

  it('坏外键（归属成员不存在）→ 拒绝', () => {
    const r = mutate((doc) => {
      doc.batches[0].owner_id = 9999;
    });
    expect(r.ok).toBe(false);
  });

  it('坏外键（变动记录指向不存在的批次）→ 拒绝', () => {
    const r = mutate((doc) => {
      doc.stock_events[0].batch_id = 9999;
    });
    expect(r.ok).toBe(false);
  });

  it('通用名为空 → 拒绝', () => {
    const r = mutate((doc) => {
      doc.medicines[0].generic = '   ';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('通用名');
  });

  it('药品缺单位 → 拒绝', () => {
    const r = mutate((doc) => {
      doc.medicines[0].unit = null;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('单位');
  });

  it('错误一次列全，不是报一个改一个', () => {
    const r = mutate((doc) => {
      doc.medicines[0].generic = '';
      doc.medicines[1].unit = null;
      doc.medicines[2].daily_dose = -5;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('不是 JSON → 明确说是 JSON 的问题', () => {
    const r = parseExport('{ 这不是 json', IMPORT_DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('JSON');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('不变量：坏状态/坏数量必须被挡下', () => {
  it('在库但数量为 0 → 拒绝（不变量 4）', () => {
    const r = mutate((doc) => {
      doc.batches[0].qty = 0;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('不变量 4');
  });

  it('已用完但数量不为 0 → 拒绝（不变量 3）', () => {
    const r = mutate((doc) => {
      doc.batches[0].status = 'used_up'; // qty 仍是 4
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('不变量 3');
  });

  it('批次数量与最后一条变动记录的 qty_after 对不上 → 拒绝（不变量 1）', () => {
    const r = mutate((doc) => {
      // 批次 2 有变动记录，qty_after = 4
      doc.batches.find((b: any) => b.id === 2).qty = 7;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('不变量 1');
  });

  it('每日用量为 0 或负数 → 拒绝（§2.1：要么空，要么 > 0）', () => {
    const zero = mutate((doc) => {
      doc.medicines[0].daily_dose = 0;
    });
    expect(zero.ok).toBe(false);
    const neg = mutate((doc) => {
      doc.medicines[0].daily_dose = -1;
    });
    expect(neg.ok).toBe(false);
  });

  it('每日用量为 null 是合法的（该药不参与预测）', () => {
    const r = mutate((doc) => {
      doc.medicines[1].daily_dose = null;
    });
    expect(r.ok).toBe(true);
  });

  it('日历日非法（2026-02-30）→ 拒绝', () => {
    const r = mutate((doc) => {
      doc.batches[0].expiry_date = '2026-02-30';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('expiry_date');
  });

  it('未知状态码 → 拒绝', () => {
    const r = mutate((doc) => {
      doc.batches[0].status = 'somewhere';
    });
    expect(r.ok).toBe(false);
  });

  it('未知变动类型 → 拒绝', () => {
    const r = mutate((doc) => {
      doc.stock_events[0].type = 'teleport';
    });
    expect(r.ok).toBe(false);
  });

  it('只有「编辑」允许 delta_qty 为 0', () => {
    const bad = mutate((doc) => {
      doc.stock_events[0].delta_qty = 0;
    });
    expect(bad.ok).toBe(false);

    const okEdit = mutate((doc) => {
      doc.stock_events[0].type = 'edit';
      doc.stock_events[0].delta_qty = 0;
    });
    expect(okEdit.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('单位混用：逐条原样导入，不按单位合并（坑 6）', () => {
  it('同一药下不同单位的批次各自保留，不合并成一条', () => {
    // 药 1（缬沙坦）真实数据里本来就有 2 条「片」的批次。
    // 再造一条「ml」的，凑出网页版真实出现过的混用场景。
    const r = mutate((doc) => {
      doc.batches.push({
        id: 9001,
        medicine_id: 1,
        owner_id: null,
        qty: 3,
        unit: 'ml',
        expiry_date: null,
        opened_at: null,
        open_life_days: null,
        location: null,
        status: 'in_stock',
        notes: null,
        created_at: '2026-09-03T15:23:11',
        updated_at: '2026-09-03T15:23:11',
      });
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const forMed1 = r.data.batches.filter((x) => x.oldMedicineId === 1);
      // 3 条，而不是被合并成 2 条 —— 跨单位相加是真实的算术错误
      expect(forMed1).toHaveLength(3);
      expect([...new Set(forMed1.map((x) => x.unit))].sort()).toEqual(['ml', '片']);
      expect(forMed1.find((x) => x.unit === 'ml')!.qty).toBe(3); // 数量没被并进「片」
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('不认识的模型字段：响亮提示，不静默丢弃（§7.2 末条）', () => {
  it('多出来的字段会被点名写进 warnings', () => {
    const r = mutate((doc) => {
      doc.medicines[0].brand_new_field = 'x';
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.warnings.some((w) => w.includes('brand_new_field'))).toBe(true);
    }
  });
});
