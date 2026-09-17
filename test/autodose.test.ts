/**
 * 自动扣减结算 —— `medbox-app/tests/test_autodose.py` 的全部 34 条规则，逐条重写。
 *
 * ── 为什么值得这么多条 ─────────────────────────────────────────────────
 * 这是全项目唯一「算错了用户看不出来、而且会静默改真实库存」的地方。
 * 上游那 34 条里有一半是**回归测试**（标了「回归 ① / ②」），也就是说
 * 这些坑**网页版真的踩过**。规则照搬，测试代码重写 —— 不搬测试就等于
 * 把这些坑重新挖一遍。
 *
 * ── 测试怎么跑（与上游的差别）──────────────────────────────────────────
 * 上游连库跑；这里 `planSettlement` 是纯函数，所以用一个 20 行的「假世界」
 * 顶上：`settle()` 把方案应用回内存里的批次和药品。**没有任何 SQL**，
 * 但被测的是同一份规则。
 */
import { addDays, type CalendarDay } from '../src/domain/calendar';
import type { AutoBatch, AutoMedicine, Settlement } from '../src/domain/autodose';
import {
  afterTake,
  pendingDeduction,
  planRebaseline,
  planSettlement,
  unitsConflict,
} from '../src/domain/autodose';
import { BATCH_EXPIRED, BATCH_IN_STOCK, BATCH_USED_UP } from '../src/domain/constants';

const TODAY: CalendarDay = '2026-09-14';
/** 上游所有批次都用同一个 created_at：效期也相同时的排序稳定性靠 id 兜底。 */
const CREATED = Date.UTC(2026, 0, 1);

let nextId = 1;

type TestBatch = AutoBatch & { status: string };

type World = { med: AutoMedicine; batches: TestBatch[] };

type MedOpts = {
  dose?: number | null;
  auto?: boolean;
  paused?: boolean;
  fromDaysAgo?: number;
  accounted?: number;
};

/** 建一个世界（上游的 `_med`）。 */
function world(opts: MedOpts = {}): World {
  const { dose = 1, auto = true, paused = false, fromDaysAgo = 0, accounted = 0 } = opts;
  return {
    med: {
      id: nextId++,
      autoDeduct: auto,
      autoPaused: paused,
      dailyDose: dose,
      autoFrom: addDays(TODAY, -fromDaysAgo),
      autoAccounted: accounted,
    },
    batches: [],
  };
}

/** 往世界里加一盒（上游的 `_batch`）。不传 `unit` 就是「片」。 */
function box(
  w: World,
  qty: number,
  opts: { expiryDays?: number | null; created?: number; unit?: string; status?: string } = {},
): TestBatch {
  const { expiryDays = null, created = CREATED, unit = '片', status = BATCH_IN_STOCK } = opts;
  const b: TestBatch = {
    id: nextId++,
    qty,
    unit,
    expiryDate: expiryDays === null ? null : addDays(TODAY, expiryDays),
    openedAt: null,
    openLifeDays: null,
    createdAt: created,
    status,
  };
  w.batches.push(b);
  return b;
}

/** 「在库且有量」—— 结算真正会看到的那些盒。 */
function live(w: World): AutoBatch[] {
  return w.batches.filter((b) => b.status === BATCH_IN_STOCK && b.qty > 0);
}

/**
 * 把方案应用回假世界（相当于 `src/data/stock.ts` 的 `applyPlan`，只是不落 SQL）。
 * 返回方案本身，所以既能断言扣了多少，也能看原因文本、事件条数。
 */
function apply(w: World, s: Settlement): Settlement {
  for (const t of s.takes) {
    const b = w.batches.find((x) => x.id === t.batchId)!;
    b.qty = t.qtyAfter;
    if (t.usedUp) b.status = BATCH_USED_UP;
  }
  w.med.autoFrom = s.autoFrom;
  w.med.autoAccounted = s.autoAccounted;
  return s;
}

/** 结算一次（上游的 `settle_medicine`）。 */
function settle(w: World, today: CalendarDay = TODAY) {
  return apply(w, planSettlement(w.med, live(w), today));
}

/** 该药所有批次的数量之和（上游的 `sun_qty`，含 qty=0 的盒）。 */
function qtyOf(w: World): number {
  return w.batches.reduce((s, b) => s + b.qty, 0);
}

// ══ pendingDeduction：纯算术 ═══════════════════════════════════════════
describe('待扣量算术', () => {
  it('整片剂量：天数 × 用量 − 已核算', () => {
    expect(pendingDeduction(7, 1, 0)).toBe(7);
    expect(pendingDeduction(7, 2, 5)).toBe(9);
  });

  it('小数剂量内部累计：每天 0.5 片时曲线是 0/1/1/2', () => {
    expect([1, 2, 3, 4].map((d) => pendingDeduction(d, 0.5, 0))).toEqual([0, 1, 1, 2]);
  });

  it('与 days_of_supply 口径一致：向下取整，不四舍五入', () => {
    expect(pendingDeduction(3, 0.5, 0)).toBe(1); // 1.5 → 1
    expect(pendingDeduction(10, 1.5, 0)).toBe(15);
  });

  it('挡得住浮点噪声：0.29 × 100 = 28.999999999999996，不挡就漏一整片', () => {
    expect(pendingDeduction(100, 0.29, 0)).toBe(29);
  });

  it('永不为负：手动取用把账本推高后只会余量，不会倒扣', () => {
    expect(pendingDeduction(5, 1, 3)).toBe(2);
    expect(pendingDeduction(5, 1, 99)).toBe(0);
    expect(pendingDeduction(0, 1, 0)).toBe(0); // 起算日当天
    expect(pendingDeduction(-3, 1, 0)).toBe(0); // 起算日在未来
    expect(pendingDeduction(10, 0, 0)).toBe(0);
  });
});

// ══ unitsConflict ═════════════════════════════════════════════════════
describe('跨单位守卫', () => {
  it('在库批次单位不一致 → 跨单位相加没有意义，宁可不扣', () => {
    const w = world({ fromDaysAgo: 5 });
    const a = box(w, 10, { unit: '片' });
    const c = box(w, 10, { unit: '袋' });

    expect(unitsConflict(live(w))).toBe(true);
    expect(settle(w).totalTaken).toBe(0);
    expect([a.qty, c.qty]).toEqual([10, 10]);
  });

  it('单位一致 → 正常扣', () => {
    const w = world();
    box(w, 10, { unit: '袋' });
    box(w, 10, { unit: '袋' });
    expect(unitsConflict(live(w))).toBe(false);
  });
});

// ══ settle：扣多少、怎么排 ════════════════════════════════════════════
describe('结算', () => {
  it('补扣起算日到今天之间欠的量，起算日不动（没到断货）', () => {
    const w = world({ fromDaysAgo: 5 });
    const b = box(w, 30);

    const s = settle(w);

    expect(s.totalTaken).toBe(5);
    expect(b.qty).toBe(25);
    expect(w.med.autoAccounted).toBe(5);
    expect(w.med.autoFrom).toBe(addDays(TODAY, -5)); // 没断货 → 起算日不动
    expect(s.takes).toHaveLength(1);
    expect(s.takes[0]).toMatchObject({ amount: 5, qtyAfter: 25 });
    // 原因写清覆盖的日期区间，用户才能在时间线上对账
    expect(s.reason).toContain('09/09–09/14');
  });

  it('起算日就是今天 → 不扣。同一页刷十次也只扣一次', () => {
    const w = world({ fromDaysAgo: 0 });
    box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(settle(w).totalTaken).toBe(0);
    expect(qtyOf(w)).toBe(30);
    expect(w.med.autoAccounted).toBe(0);
  });

  it('FEFO：先扣最快过期的，不动晚的', () => {
    const w = world({ fromDaysAgo: 3 });
    const late = box(w, 10, { expiryDays: 300 });
    const soon = box(w, 10, { expiryDays: 10 });

    settle(w);

    expect([soon.qty, late.qty]).toEqual([7, 10]);
  });

  it('已过期盒排最后：只要还有正常盒就不动它，红色标签不会自己消失', () => {
    const w = world({ fromDaysAgo: 2 });
    const exp = box(w, 10, { expiryDays: -5 });
    const ok = box(w, 10, { expiryDays: 200 });

    settle(w);

    expect([ok.qty, exp.qty]).toEqual([8, 10]);
  });

  it('正常盒扣光了才轮到过期盒', () => {
    const w = world({ fromDaysAgo: 5 });
    const exp = box(w, 10, { expiryDays: -5 });
    const ok = box(w, 3, { expiryDays: 200 });

    settle(w);

    expect([ok.qty, exp.qty]).toEqual([0, 8]);
  });

  it('未填效期的与已过期的同为最后一档，但排在它之后（按建档时间/id）', () => {
    const w = world({ fromDaysAgo: 4 });
    const noexp = box(w, 10, { expiryDays: null });
    const ok = box(w, 10, { expiryDays: 100 });

    settle(w);

    expect([ok.qty, noexp.qty]).toEqual([6, 10]);
  });

  it('排序键全相等时「扣哪盒」不能跳变（真实数据里二甲双胍就是三盒一模一样）', () => {
    const w = world({ fromDaysAgo: 2 });
    const bs = [box(w, 5), box(w, 5), box(w, 5)];

    settle(w);

    // 三盒效期、建档时间完全相同 → 只能按 id，结果必须稳定地落在第一盒
    expect(bs.map((b) => b.qty)).toEqual([3, 5, 5]);
    expect(bs[0].id).toBeLessThan(bs[1].id);
    expect(bs[1].id).toBeLessThan(bs[2].id);
  });

  it('扣光的盒转「已用完」—— 系统唯一自动做的状态变更', () => {
    const w = world({ fromDaysAgo: 8 });
    const b = box(w, 8);

    settle(w);

    expect(b.qty).toBe(0);
    expect(b.status).toBe(BATCH_USED_UP);
    expect(qtyOf(w)).toBe(0);
  });

  it('断货期不计消耗：扣到 0 就停，起算日推到今天，欠账作废', () => {
    const w = world({ fromDaysAgo: 10 });
    const b = box(w, 3);

    expect(settle(w).totalTaken).toBe(3);
    expect(b.qty).toBe(0);
    expect(b.status).toBe(BATCH_USED_UP);
    expect(w.med.autoFrom).toBe(TODAY); // 断货从今天起算
    expect(w.med.autoAccounted).toBe(0);

    // 补货后从今天重新算，不会把断货的 7 天补扣回来
    box(w, 30);
    expect(settle(w).totalTaken).toBe(0);
    expect(qtyOf(w)).toBe(30);
  });

  it('一片库存都没有 → 重设起算日，不扣', () => {
    const w = world({ fromDaysAgo: 10 });
    expect(settle(w).totalTaken).toBe(0);
    expect(w.med.autoFrom).toBe(TODAY);
    expect(w.med.autoAccounted).toBe(0);
  });

  it('暂停服药期间不扣 —— 而且连起算日都不动', () => {
    const w = world({ fromDaysAgo: 10, paused: true });
    box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(qtyOf(w)).toBe(30);
    expect(w.med.autoFrom).toBe(addDays(TODAY, -10)); // 暂停的意图是整段作废，不是推到今天
  });

  it('没开自动扣减 → 不扣', () => {
    const w = world({ fromDaysAgo: 10, auto: false });
    box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(qtyOf(w)).toBe(30);
  });

  it('没填每日用量 → 不扣', () => {
    const w = world({ dose: null, fromDaysAgo: 10 });
    box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(qtyOf(w)).toBe(30);
  });

  it('每天 0.5 片：第 1 天不扣，第 2 天扣 1，库存永远保持整数', () => {
    const w = world({ dose: 0.5, fromDaysAgo: 1 });
    const b = box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(b.qty).toBe(30);

    // 时间前进一天，起算日不动
    expect(settle(w, addDays(TODAY, 1)).totalTaken).toBe(1);
    expect(b.qty).toBe(29);
    expect(w.med.autoAccounted).toBe(1);
  });

  it('系统时间被调回起算日之前 → 重设基线，而不是算出负数', () => {
    const w = world({ fromDaysAgo: -5 }); // 起算日在未来
    box(w, 30);

    expect(settle(w).totalTaken).toBe(0);
    expect(w.med.autoFrom).toBe(TODAY);
  });

  it('「在库但数量 0」的脏数据不算库存（不变量 4 的已知例外）', () => {
    const w = world({ fromDaysAgo: 5 });
    box(w, 0);

    expect(settle(w).totalTaken).toBe(0);
    expect(w.med.autoFrom).toBe(TODAY); // 视为断货
  });

  it('非在库状态的批次完全不参与', () => {
    const w = world({ fromDaysAgo: 5 });
    const alive = box(w, 30);
    const gone = box(w, 50, { status: BATCH_EXPIRED });

    settle(w);

    expect([alive.qty, gone.qty]).toEqual([25, 50]);
  });

  it('20 天没打开 → 一次补扣 20 天，只写一条事件、覆盖整段区间', () => {
    const w = world({ fromDaysAgo: 20 });
    const b = box(w, 30);

    const s = settle(w);

    expect(s.totalTaken).toBe(20);
    expect(b.qty).toBe(10);
    expect(s.takes).toHaveLength(1);
    expect(s.reason).toContain('08/25–09/14');
  });

  it('反复结算（每次多过一天）累计扣减 = 天数，不重不漏', () => {
    const w = world({ fromDaysAgo: 0 });
    box(w, 100);

    let total = 0;
    for (let d = 1; d <= 7; d++) total += settle(w, addDays(TODAY, d)).totalTaken;

    expect(total).toBe(7);
    expect(qtyOf(w)).toBe(93);
    expect(w.med.autoAccounted).toBe(7);
  });
});

// ══ 手动操作与账本的对账（上游的两条回归） ════════════════════════════
describe('账本对账', () => {
  it('回归 ①：手动取用要累加进账本，不能重设起算日（否则同一片扣两次）', () => {
    const w = world({ fromDaysAgo: 3 });
    box(w, 30);

    // 9/14：结算到当天，已扣 3
    expect(settle(w).totalTaken).toBe(3);
    expect(w.med.autoAccounted).toBe(3);

    // 9/14 晚：手动取用 1 片（提前装进随身药盒）—— 这是「报告消耗」
    const ledger = afterTake(w.med, 1)!;
    w.med.autoAccounted = ledger.autoAccounted;

    expect(w.med.autoAccounted).toBe(4);
    expect(w.med.autoFrom).toBe(addDays(TODAY, -3)); // 起算日没动

    // 9/15：该扣 4，已核算 4 → 不补扣
    expect(settle(w, addDays(TODAY, 1)).totalTaken).toBe(0);
    expect(w.med.autoAccounted).toBe(4);
  });

  it('手动取用对没开自动扣减的药不写账本', () => {
    const w = world({ auto: false });
    expect(afterTake(w.med, 5)).toBeNull();
    expect(w.med.autoAccounted).toBe(0);
  });

  it('回归 ②：改每日用量不能按新用量补扣过去的天数（顺序：先结清→再赋值→再重设）', () => {
    const w = world({ dose: 1, fromDaysAgo: 10 });
    const b = box(w, 35);

    // 第一步：按**旧**参数结清，该扣 10
    expect(settle(w).totalTaken).toBe(10);
    expect(b.qty).toBe(25);

    // 第二步：赋新值；第三步：只重设基线，不结清
    w.med.dailyDose = 2;
    apply(w, planRebaseline(w.med, live(w), TODAY, false));

    expect(w.med.autoFrom).toBe(TODAY);
    expect(w.med.autoAccounted).toBe(0);
    expect(b.qty).toBe(25); // 没有被按新用量补扣

    // 从今天起按 2/天算
    expect(settle(w, addDays(TODAY, 1)).totalTaken).toBe(2);
    expect(b.qty).toBe(23);
  });

  it('暂停 10 天再恢复：只重设基线，不补扣停药期间的分量', () => {
    const w = world({ fromDaysAgo: 10, paused: true });
    const b = box(w, 30);

    expect(settle(w).totalTaken).toBe(0);

    w.med.autoPaused = false;
    apply(w, planRebaseline(w.med, live(w), TODAY, false));

    expect(b.qty).toBe(30); // 停药期间该吃的药没有被补扣回来
    expect(w.med.autoFrom).toBe(TODAY);
    expect(settle(w).totalTaken).toBe(0);
  });

  it('恢复在库要在改状态**之前**结算：否则这盒旧货会被当成新库存一起扣', () => {
    const w = world({ fromDaysAgo: 30 });
    const onHand = box(w, 5); // 手上还剩 5 片
    const gone = box(w, 20, { status: BATCH_USED_UP });

    // 结算时 `gone` 还不在在库清单里 —— 这正是 planRestock 的顺序
    apply(w, planRebaseline(w.med, live(w), TODAY, true));
    gone.status = BATCH_IN_STOCK;

    expect(w.med.autoFrom).toBe(TODAY);
    expect(w.med.autoAccounted).toBe(0);
    expect(onHand.qty).toBe(0); // 5 片已经按旧账扣光了
    expect(qtyOf(w)).toBe(20); // 只剩恢复的 20
  });

  it('入库要先用**手上现有的**库存结清，再以今天为新起算日', () => {
    const w = world({ fromDaysAgo: 6 });
    const b = box(w, 10);

    const s = apply(w, planRebaseline(w.med, live(w), TODAY, true));

    expect(s.totalTaken).toBe(6);
    expect(b.qty).toBe(4);
    expect(s.autoFrom).toBe(TODAY);
    expect(s.autoAccounted).toBe(0);
  });
});
