/**
 * 七个库存操作的规则 —— `requirements.md` §2.4 状态机 / §3.2 入库 / §3.3 日常操作
 * / 不变量 1、3、4、5、8。
 *
 * ── 这里的测试是照着「会出什么事」写的，不是照着函数写的 ─────────────────
 * 每条 `it` 的名字都是**一句产品承诺**（「取用不能超过现有数量」），
 * 而不是「planTake 返回 ok:false」。函数改名、拆分都不该让测试挂；
 * 规则变了才该挂。
 *
 * ── 反复出现的那个断言 ─────────────────────────────────────────────────
 * `assertLedgerMatches` 检查**不变量 1**：批次最终数量 == 它**最后一条**
 * 变动记录的「变动后数量」。凡是改数量的操作，这条都必须成立 ——
 * 它是「数量与时间线永远对得上」这句承诺的全部内容。
 */
import { addDays } from '../src/domain/calendar';
import type { AutoBatch } from '../src/domain/autodose';
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
} from '../src/domain/constants';
import type { OpContext, Plan, StockMedicine } from '../src/domain/stock';
import {
  planDiscard,
  planEdit,
  planIntake,
  planMarkExpired,
  planRestock,
  planTake,
  planUsedUp,
} from '../src/domain/stock';

const TODAY = '2026-09-14';

// ── 造数据 ─────────────────────────────────────────────────────────────

function medicine(over: Partial<StockMedicine> = {}): StockMedicine {
  return {
    id: 1,
    autoDeduct: false,
    autoPaused: false,
    dailyDose: null,
    autoFrom: null,
    autoAccounted: 0,
    unit: '片',
    ownerId: null,
    ...over,
  };
}

/** 开着自动扣减、起算日在 3 天前的药 —— 每次操作都欠 3 片。 */
function autoMedicine(over: Partial<StockMedicine> = {}): StockMedicine {
  return medicine({ autoDeduct: true, dailyDose: 1, autoFrom: addDays(TODAY, -3), ...over });
}

function liveBatch(id: number, qty: number, over: Partial<AutoBatch> = {}): AutoBatch {
  return { id, qty, unit: '片', expiryDate: null, openedAt: null, openLifeDays: null, createdAt: 1000, ...over };
}

/** 规则要的那一大坨批次字段（比 AutoBatch 多）。 */
function batch(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    qty: 20,
    unit: '片',
    status: BATCH_IN_STOCK,
    expiryDate: null,
    openedAt: null,
    openLifeDays: null,
    ownerId: null,
    location: null,
    notes: null,
    ...over,
  } as Parameters<typeof planEdit>[1];
}

function ctx(med: StockMedicine, inStock: AutoBatch[] = []): OpContext {
  return { medicine: med, inStock, today: TODAY };
}

const intakeForm = (over: Partial<Parameters<typeof planIntake>[1]> = {}) => ({
  qty: '30',
  expiryDate: '',
  openedAt: '',
  openLifeDays: '',
  location: '',
  notes: '',
  ...over,
});

const editForm = (over: Partial<Parameters<typeof planEdit>[2]> = {}) => ({
  qty: '20',
  unit: '片',
  expiryDate: '',
  openedAt: '',
  openLifeDays: '',
  ownerId: '',
  location: '',
  notes: '',
  ...over,
});

// ── 断言帮手 ───────────────────────────────────────────────────────────

/** 取出方案，失败时把错误直接摊在断言信息里，省得逐个 `if (!res.ok)`。 */
function planOf(res: ReturnType<typeof planIntake>): Plan {
  if (!res.ok) throw new Error(`本该成功，却报了：${JSON.stringify(res.errors)}`);
  return res.plan;
}

function errorsOf(res: ReturnType<typeof planIntake>): Record<string, string> {
  if (res.ok) throw new Error('本该失败，却成功了');
  return res.errors;
}

function eventsOf(plan: Plan, batchId: number | null) {
  return plan.events.filter((e) => e.batchId === batchId);
}

/** 一个批次在方案执行后的最终数量。 */
function finalQty(plan: Plan, id: number, before: number): number {
  let q = before;
  for (const p of plan.patches) if (p.id === id && p.patch.qty !== undefined) q = p.patch.qty;
  return q;
}

/**
 * **不变量 1**：批次最终数量 == 它最后一条变动记录的「变动后数量」。
 * 每个改数量的操作都必须过这一关 —— 这正是「数量与时间线对得上」的定义。
 */
function assertLedgerMatches(plan: Plan, ids: { id: number; before: number }[]): void {
  for (const { id, before } of ids) {
    const evs = eventsOf(plan, id);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs[evs.length - 1].qtyAfter).toBe(finalQty(plan, id, before));
  }
}

// ══ 入库 ══════════════════════════════════════════════════════════════
describe('入库（新增一盒）', () => {
  it('建一盒在库、写一条「入库」事件，数量对得上', () => {
    const plan = planOf(planIntake(ctx(medicine()), intakeForm({ qty: '24' })));

    expect(plan.create).toMatchObject({ qty: 24, unit: '片', status: BATCH_IN_STOCK });
    expect(plan.events).toEqual([
      { batchId: null, type: EVENT_IN, deltaQty: 24, qtyAfter: 24, reason: '入库' },
    ]);
  });

  it('单位和归属从药品档案继承，不在入库页重复问', () => {
    const plan = planOf(
      planIntake(ctx(medicine({ unit: '袋', ownerId: 3 })), intakeForm({ qty: '5' })),
    );

    expect(plan.create).toMatchObject({ unit: '袋', ownerId: 3 });
  });

  it('一次收全所有问题，不让用户一个一个试', () => {
    const errors = errorsOf(
      planIntake(ctx(medicine({ unit: '' })), intakeForm({ qty: '0', expiryDate: '2026/9/1' })),
    );

    // 三个字段一起报，而不是报完数量再报单位
    expect(Object.keys(errors).sort()).toEqual(['expiryDate', 'qty', 'unit']);
  });

  it('数量必须是大于 0 的整数 —— 0、负数、非数字都不行', () => {
    for (const qty of ['0', '-5', 'abc', '', '1.5']) {
      expect(errorsOf(planIntake(ctx(medicine()), intakeForm({ qty }))).qty).toBeDefined();
    }
    expect(planOf(planIntake(ctx(medicine()), intakeForm({ qty: '1' }))).create!.qty).toBe(1);
  });

  it('药品档案没填单位 → 明确告诉用户去哪儿补，而不是建一盒没单位的药', () => {
    const errors = errorsOf(planIntake(ctx(medicine({ unit: null })), intakeForm()));
    expect(errors.unit).toContain('编辑档案');
    expect(errors.unit).not.toBe(''); // 空消息等于没提示
  });

  it('先用**手上现有的**库存结清旧账，再以今天为新起算日', () => {
    const med = autoMedicine(); // 欠 3 片
    const plan = planOf(planIntake(ctx(med, [liveBatch(10, 20)]), intakeForm({ qty: '30' })));

    // 旧账在这盒上结掉 3
    expect(finalQty(plan, 10, 20)).toBe(17);
    expect(eventsOf(plan, 10)).toEqual([
      { batchId: 10, type: EVENT_AUTO, deltaQty: -3, qtyAfter: 17, reason: expect.any(String) },
    ]);
    // 新起算日 = 今天、账本归零
    expect(plan.ledger).toEqual({ medicineId: med.id, autoFrom: TODAY, autoAccounted: 0 });
    // 新盒数量不受旧账影响
    expect(plan.create!.qty).toBe(30);
  });

  it('断货期不会因为入库被一次补扣回来', () => {
    // 起算日 30 天前，但手上一片都没有 → 视为断货，欠账作废
    const med = autoMedicine({ autoFrom: addDays(TODAY, -30) });
    const plan = planOf(planIntake(ctx(med, []), intakeForm({ qty: '30' })));

    expect(plan.events.filter((e) => e.type === EVENT_AUTO)).toHaveLength(0);
    expect(plan.ledger).toEqual({ medicineId: med.id, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('没开自动扣减的药也把起算日推到今天（将来开自动扣减时从这次入库算起）', () => {
    const plan = planOf(planIntake(ctx(medicine({ autoFrom: '2026-09-15' })), intakeForm()));
    expect(plan.ledger).toEqual({ medicineId: 1, autoFrom: TODAY, autoAccounted: 0 });
  });
});

// ══ 取用 ══════════════════════════════════════════════════════════════
describe('取用', () => {
  it('减量并写一条「取用」事件', () => {
    const plan = planOf(planTake(ctx(medicine()), batch({ qty: 20 }), '3', ''));

    expect(plan.patches).toEqual([{ id: 10, patch: { qty: 17 } }]);
    expect(plan.events[0]).toMatchObject({ type: EVENT_TAKE, deltaQty: -3, qtyAfter: 17 });
    assertLedgerMatches(plan, [{ id: 10, before: 20 }]);
  });

  it('不能超过现有数量（网页版会弹这句话，App 上也一样）', () => {
    const errors = errorsOf(planTake(ctx(medicine()), batch({ qty: 20 }), '21', ''));
    expect(errors.amount).toContain('21');
    expect(errors.amount).toContain('20');
  });

  it('刚好取完是允许的（剩下 0 而不是负数）', () => {
    const plan = planOf(planTake(ctx(medicine()), batch({ qty: 20 }), '20', ''));
    expect(finalQty(plan, 10, 20)).toBe(0);
  });

  it('数量必须是大于 0 的整数', () => {
    for (const amount of ['0', '-1', 'x', '']) {
      expect(errorsOf(planTake(ctx(medicine()), batch(), amount, '')).amount).toBeDefined();
    }
  });

  it('已经不在库的盒不能再取用', () => {
    const errors = errorsOf(planTake(ctx(medicine()), batch({ status: BATCH_EXPIRED }), '1', ''));
    expect(errors._).toBeDefined();
  });

  it('账本：累加已核算消耗量，**起算日不动**（动了就会同一片扣两次）', () => {
    const med = autoMedicine(); // 起算日 3 天前
    const plan = planOf(planTake(ctx(med), batch({ qty: 20 }), '2', '装进随身药盒'));

    expect(plan.ledger).toEqual({
      medicineId: med.id,
      autoFrom: addDays(TODAY, -3), // ← 没动
      autoAccounted: 2, // ← 累加
    });
  });

  it('没开自动扣减的药不写账本', () => {
    const plan = planOf(planTake(ctx(medicine()), batch(), '2', ''));
    expect(plan.ledger).toBeUndefined();
  });

  it('原因可以不填', () => {
    const plan = planOf(planTake(ctx(medicine()), batch(), '2', '  '));
    expect(plan.events[0].reason).toBeNull();
  });
});

// ══ 用完 / 丢弃 ═══════════════════════════════════════════════════════
describe('用完 / 丢弃', () => {
  it('用完：数量归 0、状态转「已用完」、事件记录减少量', () => {
    const plan = planOf(planUsedUp(ctx(medicine()), batch({ qty: 7 })));

    expect(plan.patches).toEqual([{ id: 10, patch: { qty: 0, status: BATCH_USED_UP } }]);
    expect(plan.events[0]).toMatchObject({ type: EVENT_USED_UP, deltaQty: -7, qtyAfter: 0 });
  });

  it('用完：结算是用**剩下的**批次结的，这一盒已经不算库存了', () => {
    const med = autoMedicine(); // 欠 3
    // 这一盒（10）将被归零；另一盒（11）还在
    const plan = planOf(planUsedUp(ctx(med, [liveBatch(10, 7), liveBatch(11, 50)]), batch({ id: 10, qty: 7 })));

    // 7 片被「用完」吞掉，不再参与结算；结算从 11 扣 3
    expect(finalQty(plan, 11, 50)).toBe(47);
    expect(finalQty(plan, 10, 7)).toBe(0); // 用完的 patch 覆盖了任何结算扣减
    expect(plan.ledger).toEqual({ medicineId: med.id, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('丢弃：数量归 0、状态转「已丢弃」、原因用用户填的', () => {
    const plan = planOf(planDiscard(ctx(medicine()), batch({ qty: 4 }), '受潮了'));

    expect(plan.patches).toEqual([{ id: 10, patch: { qty: 0, status: BATCH_DISCARDED } }]);
    expect(plan.events[0]).toMatchObject({ type: EVENT_DISCARD, deltaQty: -4, reason: '受潮了' });
  });

  it('已用完 / 已丢弃的盒数量必须是 0（不变量 3）', () => {
    for (const plan of [
      planOf(planUsedUp(ctx(medicine()), batch({ qty: 7 }))),
      planOf(planDiscard(ctx(medicine()), batch({ qty: 7 }), '')),
    ]) {
      expect(finalQty(plan, 10, 7)).toBe(0);
      expect(plan.events[0].qtyAfter).toBe(0);
    }
  });

  it('不在库的盒不能再「用完」或「丢弃」', () => {
    expect(errorsOf(planUsedUp(ctx(medicine()), batch({ status: BATCH_USED_UP })))._).toBeDefined();
    expect(errorsOf(planDiscard(ctx(medicine()), batch({ status: BATCH_DISCARDED }), ''))._).toBeDefined();
  });
});

// ══ 标记过期 ══════════════════════════════════════════════════════════
describe('标记过期', () => {
  it('只改状态，**数量不变**（药可能还在用，只是不能吃了）', () => {
    const plan = planOf(planMarkExpired(ctx(medicine()), batch({ qty: 9 })));

    expect(plan.patches).toEqual([{ id: 10, patch: { status: BATCH_EXPIRED } }]);
    expect(plan.patches[0].patch.qty).toBeUndefined();
    expect(plan.events[0]).toMatchObject({ type: EVENT_MARK_EXPIRED, deltaQty: 0, qtyAfter: 9 });
  });

  it('完全不碰账本 —— 数量没变就没有要结的账', () => {
    const med = autoMedicine(); // 欠 3 片，但标记过期不该触发结算
    const plan = planOf(planMarkExpired(ctx(med, [liveBatch(10, 9)]), batch({ qty: 9 })));

    expect(plan.ledger).toBeUndefined();
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0].type).toBe(EVENT_MARK_EXPIRED);
  });

  it('不在库的盒不能再标记过期', () => {
    expect(errorsOf(planMarkExpired(ctx(medicine()), batch({ status: BATCH_EXPIRED })))._).toBeDefined();
  });
});

// ══ 恢复在库 ══════════════════════════════════════════════════════════
describe('恢复在库', () => {
  it('数量不变、状态转回在库、写一条 delta 为 0 的事件', () => {
    const plan = planOf(planRestock(ctx(medicine()), batch({ qty: 12, status: BATCH_EXPIRED })));

    expect(plan.patches).toEqual([{ id: 10, patch: { status: BATCH_IN_STOCK } }]);
    expect(plan.events[0]).toMatchObject({ type: EVENT_RESTOCK, deltaQty: 0, qtyAfter: 12 });
  });

  it('必须在改状态**之前**结算 —— 否则这盒旧货会被当成新库存一起扣', () => {
    const med = autoMedicine(); // 欠 3 片
    // 手上只有这一盒，但它是「已过期」→ 不在 inStock 里 → 结算看到的是断货
    const plan = planOf(planRestock(ctx(med, []), batch({ qty: 20, status: BATCH_EXPIRED })));

    // 断货 → 不扣，只重设起算日
    expect(plan.events.filter((e) => e.type === EVENT_AUTO)).toHaveLength(0);
    expect(plan.ledger).toEqual({ medicineId: med.id, autoFrom: TODAY, autoAccounted: 0 });
    expect(finalQty(plan, 10, 20)).toBe(20); // 这盒没被扣
  });

  it('数量为 0 的盒拒绝恢复 —— 否则会造出「在库且为 0」的非法状态（不变量 4）', () => {
    const errors = errorsOf(planRestock(ctx(medicine()), batch({ qty: 0, status: BATCH_USED_UP })));
    expect(errors._).toContain('编辑');
  });

  it('本来就在库的盒不能「恢复」', () => {
    expect(errorsOf(planRestock(ctx(medicine()), batch({ status: BATCH_IN_STOCK })))._).toBeDefined();
  });
});

// ══ 编辑纠错 ══════════════════════════════════════════════════════════
describe('编辑纠错', () => {
  it('改数量 = 纠正账本：先按旧数量结清，再以今天为新起算日', () => {
    const med = autoMedicine(); // 欠 3 片
    const plan = planOf(planEdit(ctx(med, [liveBatch(10, 20)]), batch({ qty: 20 }), editForm({ qty: '15' })));

    // 先扣 3（旧数量 20 → 17），再把数量改成 15
    expect(plan.events.map((e) => e.type)).toEqual([EVENT_AUTO, EVENT_EDIT]);
    expect(plan.events[0]).toMatchObject({ deltaQty: -3, qtyAfter: 17 });
    expect(finalQty(plan, 10, 20)).toBe(15);
    expect(plan.ledger).toEqual({ medicineId: med.id, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('编辑事件把**改了哪些字段的新旧值**都记下来（纠错要留痕）', () => {
    const plan = planOf(
      planEdit(
        ctx(medicine()),
        batch({ qty: 20, location: '药箱·上层' }),
        editForm({ qty: '18', location: '冰箱冷藏', notes: '换地方了' }),
      ),
    );

    const ev = plan.events.find((e) => e.type === EVENT_EDIT)!;
    expect(ev.deltaQty).toBe(0); // 编辑是唯一允许 delta 为 0 的类型
    expect(ev.qtyAfter).toBe(18);
    expect(ev.reason).toContain('数量: 20→18');
    expect(ev.reason).toContain('位置: 药箱·上层→冰箱冷藏');
    expect(ev.reason).toContain('备注: 空→换地方了');
    expect(ev.reason).not.toContain('单位'); // 没改的字段不该出现在原因里
  });

  it('只改效期不动数量 → 不触发结算', () => {
    const med = autoMedicine();
    const plan = planOf(planEdit(ctx(med, [liveBatch(10, 20)]), batch({ qty: 20 }), editForm({ expiryDate: '2027-01-31' })));

    expect(plan.ledger).toBeUndefined();
    expect(plan.events.map((e) => e.type)).toEqual([EVENT_EDIT]);
    expect(finalQty(plan, 10, 20)).toBe(20);
  });

  it('什么都没改 → 一条事件都不写（不留下没意义的记录）', () => {
    const plan = planOf(planEdit(ctx(medicine()), batch({ qty: 20, unit: '片' }), editForm({ qty: '20', unit: '片' })));
    expect(plan.events).toHaveLength(0);
  });

  it('可以改单位和归属 —— 这两项入库时不能改', () => {
    const plan = planOf(
      planEdit(ctx(medicine()), batch({ qty: 20, unit: '片', ownerId: null }), editForm({ unit: '盒', ownerId: '2' })),
    );

    expect(plan.patches[0].patch).toMatchObject({ unit: '盒', ownerId: 2 });
    expect(plan.events[0].reason).toContain('归属: 空→2');
  });

  it('数量可以为 0（编辑是纠错手段），但状态要一并转「已用完」', () => {
    const plan = planOf(planEdit(ctx(medicine()), batch({ qty: 20 }), editForm({ qty: '0' })));

    // 网页版会留下「在库且数量 0」的幽灵药盒，违反不变量 4 —— App 上补上
    expect(plan.patches[0].patch).toMatchObject({ qty: 0, status: BATCH_USED_UP });
    expect(plan.events[0].qtyAfter).toBe(0);
  });

  it('本来就是「已过期」的盒改成 0，不该被改成「已用完」（状态是用户标的，别乱动）', () => {
    const plan = planOf(planEdit(ctx(medicine()), batch({ qty: 20, status: BATCH_EXPIRED }), editForm({ qty: '0' })));
    expect(plan.patches[0].patch.status).toBeUndefined();
  });

  it('数量和单位是必填的，且一次报全', () => {
    const errors = errorsOf(planEdit(ctx(medicine()), batch(), editForm({ qty: '-1', unit: '  ', ownerId: 'abc' })));
    expect(Object.keys(errors).sort()).toEqual(['ownerId', 'qty', 'unit']);
  });

  it('数量负数不行，但 0 行', () => {
    expect(errorsOf(planEdit(ctx(medicine()), batch(), editForm({ qty: '-1' }))).qty).toBeDefined();
    expect(planOf(planEdit(ctx(medicine()), batch(), editForm({ qty: '0' }))).patches.length).toBe(1);
  });
});

// ══ 不变量 1：数量与时间线永远对得上 ══════════════════════════════════
describe('不变量 1 —— 七个操作逐一体检', () => {
  it('凡是改了数量的操作，最后一条事件的「变动后数量」都等于最终数量', () => {
    const med = autoMedicine();
    const inStock = [liveBatch(10, 20), liveBatch(11, 8)];
    const cases: { name: string; plan: Plan; ids: { id: number; before: number }[] }[] = [
      {
        name: '取用',
        plan: planOf(planTake(ctx(med, inStock), batch({ id: 10, qty: 20 }), '3', '')),
        ids: [{ id: 10, before: 20 }],
      },
      {
        name: '用完',
        plan: planOf(planUsedUp(ctx(med, inStock), batch({ id: 10, qty: 20 }))),
        // 10 被归零，11 被结算扣了 3
        ids: [
          { id: 10, before: 20 },
          { id: 11, before: 8 },
        ],
      },
      {
        name: '丢弃',
        plan: planOf(planDiscard(ctx(med, inStock), batch({ id: 10, qty: 20 }), '')),
        ids: [{ id: 10, before: 20 }],
      },
      {
        name: '标记过期',
        plan: planOf(planMarkExpired(ctx(med, inStock), batch({ id: 10, qty: 20 }))),
        ids: [{ id: 10, before: 20 }],
      },
      {
        name: '编辑',
        plan: planOf(planEdit(ctx(med, inStock), batch({ id: 10, qty: 20 }), editForm({ qty: '15' }))),
        ids: [{ id: 10, before: 20 }],
      },
    ];

    for (const c of cases) {
      // 只要动了数量，就必须有事件解释这个数量是怎么来的
      try {
        assertLedgerMatches(c.plan, c.ids);
      } catch (e) {
        throw new Error(`「${c.name}」破坏了不变量 1：${(e as Error).message}`);
      }
    }
  });

  it('每一盒被改动的批次，事件条数与「它真的变了」一致', () => {
    const med = autoMedicine();
    const plan = planOf(planTake(ctx(med, [liveBatch(10, 20)]), batch({ id: 10, qty: 20 }), '5', ''));
    assertLedgerMatches(plan, [{ id: 10, before: 20 }]);
    expect(plan.events).toHaveLength(1); // 取用本身不改账本，没有自动扣减事件
  });

  it('入库的新盒：事件里的数量就是新建的数量', () => {
    const plan = planOf(planIntake(ctx(medicine()), intakeForm({ qty: '42' })));
    const evs = eventsOf(plan, null);
    expect(evs).toHaveLength(1);
    expect(evs[0].qtyAfter).toBe(plan.create!.qty);
    expect(plan.create!.qty).toBe(42);
  });
});
