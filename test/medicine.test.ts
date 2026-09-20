/**
 * 药品档案的纯规则 —— 校验、收口、以及「改动时机」。
 *
 * ── 为什么这几条值得测 ─────────────────────────────────────────────────
 * 改「每日用量」或「自动扣减开关」是**唯一会静默改真实库存、且算错了用户
 * 看不出来**的用户操作。药盒上的数字不会自己核对，App 说剩 20 片就是 20 片。
 * 它比自动扣减本身风险还高：自动扣减是幂等的每日一扣（多跑无害），
 * 改剂量却可能一次性补扣一大笔。
 *
 * 落库效果（真 SQLite 上扣了几片、事件写了什么）在 `test/data.test.ts` 里测；
 * 这里只测不碰库的那一半。
 */
import {
  autoWouldChange,
  doseOf,
  formOf,
  planMedicineCreate,
  planMedicineUpdate,
  planPause,
  planResume,
  type MedicineForm,
  type MedicineRow,
} from '../src/domain/medicine';
import { afterTake, type AutoBatch, type AutoMedicine } from '../src/domain/autodose';
import { addDays } from '../src/domain/calendar';

const TODAY = '2026-09-14';

/** 一张除了指定字段之外都合法的表单。每个用例只说自己关心的那件事。 */
function form(over: Partial<MedicineForm> = {}): MedicineForm {
  return {
    generic: '二甲双胍缓释片',
    brand: '',
    spec: '',
    form: '',
    category: '',
    purposeNotes: '',
    dailyDose: '',
    unit: '片',
    ownerId: '',
    autoDeduct: false,
    ...over,
  };
}

/** 更新前的档案行（从库里读出来的那份快照）。 */
function prev(over: Partial<AutoMedicine> = {}): AutoMedicine {
  return {
    id: 7,
    autoDeduct: false,
    autoPaused: false,
    dailyDose: null,
    autoFrom: null,
    autoAccounted: 0,
    ...over,
  };
}

/** 取校验失败的那些键，断言时只看键名够用。 */
function errKeys(res: { ok: boolean; errors?: Record<string, string> }): string[] {
  return Object.keys(res.errors ?? {}).sort();
}

describe('档案表单校验', () => {
  it('通用名为空 / 单位为空，各报一条', () => {
    // 上游 _validate_medicine 的前两条
    const res = planMedicineCreate(form({ generic: '  ', unit: '' }), TODAY);
    if (res.ok) throw new Error('不该通过');
    expect(res.errors.generic).toBe('通用名：不能为空');
    expect(res.errors.unit).toBe('单位：请选择或填写单位');
  });

  it('**一次收齐全部问题**，不让用户一个一个试', () => {
    // §3.2 要求「把所有问题一次告诉用户」。故意同时违反三条，
    // 应当一次拿回三个键 —— 只报第一条的话用户要存三次才知道哪里都错了。
    const res = planMedicineCreate(
      form({ generic: '', unit: '', dailyDose: 'abc', autoDeduct: true }),
      TODAY,
    );
    if (res.ok) throw new Error('不该通过');
    expect(errKeys(res)).toEqual(['dailyDose', 'generic', 'unit']);
  });

  it('错误键名就是表单字段名（界面按 `errors.<字段>` 取）', () => {
    const res = planMedicineCreate(form({ ownerId: '外公' }), TODAY);
    if (res.ok) throw new Error('不该通过');
    expect(errKeys(res)).toEqual(['ownerId']);
  });

  it('勾了「自动扣减」却没填每日用量 → 报错，且话说清了为什么', () => {
    const res = planMedicineCreate(form({ autoDeduct: true, dailyDose: '' }), TODAY);
    if (res.ok) throw new Error('不该通过');
    expect(res.errors.dailyDose).toContain('勾了「自动扣减」就得填');
  });
});

describe('每日用量的解析', () => {
  it('空白字符串是「不填」，不是 0', () => {
    // 这两种必须分开：没设用量 = 偶用药，不该进补货预测，也从没被自动扣减过。
    // 当成 0 的话，这个药要么被预测成「0 天，需补货」，要么被判成「用量非法」。
    const res = planMedicineCreate(form({ dailyDose: '   ' }), TODAY);
    if (!res.ok) throw new Error('空着应当可以保存');
    expect(res.values.dailyDose).toBeNull();
  });

  it('小数是合法的 —— 网页版的提示原文就写着「如 1 或 1.5」', () => {
    const res = planMedicineCreate(form({ dailyDose: '1.5' }), TODAY);
    if (!res.ok) throw new Error('1.5 应当合法');
    expect(res.values.dailyDose).toBe(1.5);
  });

  it('0 / 负数 / 非法形状都不行', () => {
    // 逐个点名，因为它们各自走的是不同的失败路径：'0' 形状对但范围错，
    // 'abc' 形状就不对，'1e3' 和 '0x10' 是「Number() 会接受但人不这么想」的那类
    for (const bad of ['0', '-1', '1.5.5', 'abc', '1e3', '0x10', '1 片', '.']) {
      const res = planMedicineCreate(form({ dailyDose: bad }), TODAY);
      if (res.ok) throw new Error(`${bad} 不该通过`);
      expect(errKeys(res)).toEqual(['dailyDose']);
    }
  });
});

describe('归属', () => {
  it('空 = 家庭共用（null）', () => {
    const res = planMedicineCreate(form({ ownerId: '' }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.values.ownerId).toBeNull();
  });

  it('填了数字 = 那个成员', () => {
    const res = planMedicineCreate(form({ ownerId: '3' }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.values.ownerId).toBe(3);
  });

  it('填了非数字 → **报错**，不是悄悄变成家庭共用', () => {
    // ⚠️ 这里刻意偏离上游的 `_int_or_none`（它会把填错的归属静默变成 None）。
    // 归属是「谁在吃这个药」这种用药安全信息，静默丢弃等于让那些药从成员页
    // 消失，而用户不会收到任何提示。
    const res = planMedicineCreate(form({ ownerId: '外公' }), TODAY);
    if (res.ok) throw new Error('不该通过');
    expect(res.errors.ownerId).toBe('归属：请从列表中选择');
  });
});

describe('新建时的账本初值', () => {
  it('勾了自动扣减 → 起算日就是**建档当天**，不追溯', () => {
    const res = planMedicineCreate(form({ autoDeduct: true, dailyDose: '2' }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.values.autoFrom).toBe(TODAY);
    expect(res.values.autoAccounted).toBe(0);
  });

  it('没勾自动扣减 → 起算日**留空**，不是今天', () => {
    // 写 today 会让一个从没启用过的药看起来像已经起算过 ——
    // 详情页上的「起算日」会凭空多出一行，而它其实一天都没扣过。
    const res = planMedicineCreate(form({ autoDeduct: false }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.values.autoFrom).toBeNull();
  });

  it('空白字段收口成 null，不是空字符串', () => {
    const res = planMedicineCreate(form({ brand: '  ', spec: '', purposeNotes: '' }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.values.brand).toBeNull();
    expect(res.values.spec).toBeNull();
    expect(res.values.purposeNotes).toBeNull();
  });
});

describe('编辑时的账本时机', () => {
  it('只改通用名 → **方案是空的**，一片药都不动', () => {
    // 这条防的是「每次保存都 rebaseline」：那会让用户改个错别字
    // 就触发一次自动扣减，外加时间线上多一条莫名其妙的记录。
    const res = planMedicineUpdate(prev({ autoDeduct: true, dailyDose: 1 }), [], form({ generic: '新名字', autoDeduct: true, dailyDose: '1' }), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toBeUndefined();
  });

  it('改单位 / 改归属 → 同样不碰账本（它们只对之后新入库的批次生效）', () => {
    const res = planMedicineUpdate(
      prev({ autoDeduct: true, dailyDose: 1 }),
      [],
      form({ unit: '盒', ownerId: '2', autoDeduct: true, dailyDose: '1' }),
      TODAY,
    );
    if (!res.ok) throw new Error('不该失败');
    expect(res.plan.ledger).toBeUndefined();
    expect(res.fields.unit).toBe('盒');
    expect(res.fields.ownerId).toBe(2);
  });

  it('改每日用量 → 产生方案，**且账本重设到今天、已核算归零**', () => {
    const res = planMedicineUpdate(
      prev({ autoDeduct: true, dailyDose: 1, autoFrom: '2026-09-01', autoAccounted: 3 }),
      [],
      form({ autoDeduct: true, dailyDose: '2' }),
      TODAY,
    );
    if (!res.ok) throw new Error('不该失败');
    expect(res.plan.ledger).toEqual({ medicineId: 7, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('关→开：清掉暂停状态', () => {
    const res = planMedicineUpdate(
      prev({ autoDeduct: false, autoPaused: true }),
      [],
      form({ autoDeduct: true, dailyDose: '1' }),
      TODAY,
    );
    if (!res.ok) throw new Error('不该失败');
    expect(res.fields.autoPaused).toBe(false);
  });

  it('一直开着、只是改个名字：**不会**被默默解除暂停', () => {
    // 编辑表单里没有暂停开关，用户改个错别字不会被提示「你的药重新开始扣了」。
    // 所以「autoDeduct 为真就置 false」是错的写法 —— 这条钉住它。
    const res = planMedicineUpdate(
      prev({ autoDeduct: true, autoPaused: true, dailyDose: 1 }),
      [],
      form({ generic: '改个错别字', autoDeduct: true, dailyDose: '1' }),
      TODAY,
    );
    if (!res.ok) throw new Error('不该失败');
    expect(res.fields.autoPaused).toBe(true);
  });
});

describe('autoWouldChange —— 编辑页那句提示的判据', () => {
  /**
   * 这个函数被**两处**用：`planMedicineUpdate`（决定跑不跑结算）和编辑页的
   * 提示块（决定说不说「会先结清」）。所以它必须一比一对上「真的会扣库存」——
   * 提示说错了比不提示更糟：用户会因为一句假话去翻账本。
   */
  it('改剂量 / 动开关 → 会', () => {
    expect(autoWouldChange(prev({ dailyDose: 1 }), form({ dailyDose: '2' }))).toBe(true);
    expect(autoWouldChange(prev({ autoDeduct: true, dailyDose: 1 }), form({ autoDeduct: false, dailyDose: '1' }))).toBe(true);
    expect(autoWouldChange(prev({ autoDeduct: false }), form({ autoDeduct: true, dailyDose: '1' }))).toBe(true);
  });

  it('改通用名 / 单位 / 归属 → 不会', () => {
    // 库存一动不动。这三样「只对之后新入库的批次生效，不改写已有批次」
    expect(
      autoWouldChange(
        prev({ autoDeduct: true, dailyDose: 1 }),
        form({ autoDeduct: true, dailyDose: '1', generic: '换个名', unit: '盒', ownerId: '3' }),
      ),
    ).toBe(false);
  });

  it('每日用量写成 `1` 与 `1.0` 是同一个数，不算改动', () => {
    // 界面上「每日用量 1 → 1.0」会变成一句无意义的提示
    expect(autoWouldChange(prev({ dailyDose: 1 }), form({ dailyDose: '1.0' }))).toBe(false);
  });
});

describe('doseOf —— 表单值到领域值的唯一入口', () => {
  it('空串是「不填」而不是 0', () => {
    // ⚠️ 这里不能是 `Number(raw)`：`Number('')` 得到 0，
    // 而 0 会被当成「有每日用量」，一个从没填过的药会凭空出现在补货预测里
    expect(doseOf(form({ dailyDose: '' }))).toBe(null);
    expect(doseOf(form({ dailyDose: '  ' }))).toBe(null);
    expect(doseOf(form({ dailyDose: '0' }))).toBe(null);
  });

  it('小数原样返回', () => {
    expect(doseOf(form({ dailyDose: '0.5' }))).toBe(0.5);
    expect(doseOf(form({ dailyDose: '1.5' }))).toBe(1.5);
  });
});

describe('formOf + 保存的往返 —— 「打开编辑页，碰都没碰，按保存」', () => {
  /**
   * 这是编辑页最常见的一次操作，也是最容易出事的一次：
   * 用户打开只是想看一眼某个字段，顺手按了保存。
   *
   * `formOf` 是 10 个字段的手工映射，搬错一个（比如把 spec 写进 purposeNotes）
   * 就会让那次「什么都没改」的保存**悄悄搬走数据**，而且不报任何错。
   * 下面这条把「读出来 → 原样存回去」钉成恒等。
   */
  const row: MedicineRow = {
    id: 7,
    generic: '二甲双胍缓释片',
    brand: '格华止',
    spec: '0.5g×30 片',
    form: '片剂',
    category: '处方药',
    purposeNotes: '随餐服用',
    dailyDose: 1.5,
    unit: '片',
    ownerId: 3,
    autoDeduct: true,
    autoPaused: false,
    autoFrom: '2026-09-01',
    autoAccounted: 4,
  };

  it('写回的字段与读出来的一模一样（每个字段逐个点名）', () => {
    const res = planMedicineUpdate(row, [], formOf(row), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.fields.generic).toBe(row.generic);
    expect(res.fields.brand).toBe(row.brand);
    expect(res.fields.spec).toBe(row.spec);
    expect(res.fields.form).toBe(row.form);
    expect(res.fields.category).toBe(row.category);
    expect(res.fields.purposeNotes).toBe(row.purposeNotes);
    expect(res.fields.dailyDose).toBe(row.dailyDose);
    expect(res.fields.unit).toBe(row.unit);
    expect(res.fields.ownerId).toBe(row.ownerId);
    expect(res.fields.autoDeduct).toBe(row.autoDeduct);
    // ⚠️ 这一条最要紧：表单里根本没有「暂停」这个字段，所以它**必须**原样带过去。
    // 带不过去的话，一个暂停中的药会因为用户进去看了一眼就被解除暂停，
    // 第二天开始重新扣药 —— 而用户完全不知道发生了什么。
    expect(res.fields.autoPaused).toBe(row.autoPaused);
  });

  it('且一片药都不动、时间线一个字不加', () => {
    const res = planMedicineUpdate(row, [], formOf(row), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toBeUndefined();
  });

  it('小数用量不因为走一趟字符串就变形（1.5 → "1.5" → 1.5）', () => {
    const res = planMedicineUpdate(row, [], formOf(row), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.fields.dailyDose).toBe(1.5);
    expect(autoWouldChange(row, formOf(row))).toBe(false);
  });

  it('ownerId 为 null（家庭共用）走一趟不会变成 0 号成员', () => {
    // `String(null)` 是 "null"、"?? 0" 是 0 —— 两种写法都会造出一个不存在的归属，
    // 而它恰好能通过「非空就得是数字」那条校验，一路写进库
    const shared = { ...row, ownerId: null };
    const res = planMedicineUpdate(shared, [], formOf(shared), TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.fields.ownerId).toBeNull();
  });

  it('单位空着的老数据：打开就保存会**被拦住**，并告诉他去哪补', () => {
    // 这是断头路的出口：`planIntake` 会说「该药品档案还没填单位，请先到
    // 『编辑档案』补上」，在编辑页存在之前，用户到不了那个地方。
    const noUnit = { ...row, unit: null };
    const res = planMedicineUpdate(noUnit, [], formOf(noUnit), TODAY);
    if (res.ok) throw new Error('单位空着不该能存');
    expect(res.errors.unit).toBe('单位：请选择或填写单位');
  });
});

// ══ 暂停服药 / 恢复服药 ════════════════════════════════════════════════
//
// 这一组测的是**两个方向的不对称**，也是全项目里唯一一处「日期取错不会自愈」
// 的操作（见 `src/data/medicines.ts` 的 `pauseMedicine`）。落库效果
// （真扣了几片、标志位、事件）在 `test/data.test.ts` 里测，这里不碰库。

/** 一盒药。默认是「片」在库，够用即可 —— 这一组不关心效期排序（那在 autodose 里测）。 */
function abox(qty: number, over: Partial<AutoBatch> = {}): AutoBatch {
  return {
    id: 1,
    qty,
    unit: '片',
    expiryDate: null,
    openedAt: null,
    openLifeDays: null,
    createdAt: 0,
    status: 'in_stock',
    ...over,
  };
}

/** 一个开着自动扣减、起算日在 `fromDaysAgo` 天前的药。 */
function auto(over: Partial<AutoMedicine> = {}): AutoMedicine {
  return prev({ autoDeduct: true, dailyDose: 1, autoFrom: addDays(TODAY, -10), ...over });
}

describe('暂停 / 恢复', () => {
  it('暂停：先把欠的账结清，且**起算日不动**（不重设基线）', () => {
    // 起算日 10 天前、已核算 1、每日 1 → 该扣 9 片
    const p = auto({ autoFrom: addDays(TODAY, -10), autoAccounted: 1 });
    const res = planPause(p, [abox(30)], TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([{ id: 1, patch: { qty: 21 } }]);
    expect(res.plan.events).toHaveLength(1);
    expect(res.plan.events[0]).toMatchObject({ batchId: 1, deltaQty: -9, qtyAfter: 21 });

    // ⚠️ 这条是「暂停 ≠ 改剂量」的分水岭：起算日仍是 10 天前，**不是今天**。
    // 用 planRebaseline 的话这里会变成 (TODAY, 0) —— 那是「编辑档案」的语义。
    expect(res.plan.ledger).toEqual({
      medicineId: 7,
      autoFrom: addDays(TODAY, -10),
      autoAccounted: 10,
    });
  });

  it('暂停：闸门今天已经结算过时是**空操作**（幂等，多跑无害）', () => {
    // 这正是绝大多数情况：闸门在冷启动/回前台已经扣过，按下暂停时无事可做。
    const p = auto({ autoFrom: TODAY, autoAccounted: 0 });
    const res = planPause(p, [abox(30)], TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toBeUndefined();
  });

  it('暂停：一片库存都没有时起算日推到今天 —— 断货期不计消耗', () => {
    const p = auto({ autoFrom: addDays(TODAY, -10), autoAccounted: 0 });
    const res = planPause(p, [], TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toEqual({ medicineId: 7, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('暂停：在库单位不统一时**方案整个是空的**（已知缺口，钉成行为而不是留给人猜）', () => {
    // 跨单位相加没有意义 → planSettlement 返回 untouched(med, true)，
    // 而 mergeSettlement 不看 skippedByUnitConflict（三者全等），
    // 于是只有标志位会落库：**这一下并没有结清**，恢复会把欠账一起吞掉。
    // 界面上的确认文案为此明说了「单位不统一时算不出，会跳过」。
    const p = auto({ autoFrom: addDays(TODAY, -10), autoAccounted: 0 });
    const res = planPause(p, [abox(30, { id: 1, unit: '片' }), abox(30, { id: 2, unit: '袋' })], TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toBeUndefined();
  });

  it('恢复：**一片都不扣**，只把起算日设成今天、已核算归零', () => {
    // 这是这个功能对用户的全部承诺。用 planRebaseline（先结清）会扣 30 片。
    const p = auto({ autoPaused: true, autoFrom: addDays(TODAY, -30), autoAccounted: 0 });
    const res = planResume(p, TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toEqual({ medicineId: 7, autoFrom: TODAY, autoAccounted: 0 });
  });

  it('恢复：起算日已经是今天、已核算本来就是 0 时**不写账本**（只翻标志位）', () => {
    // mergeSettlement 只在「和目标值不同」时写 ledger。这不是漏写：
    // 落地层照样会把 autoPaused 置 false，恢复动作本身是生效的。
    const p = auto({ autoPaused: true, autoFrom: TODAY, autoAccounted: 0 });
    const res = planResume(p, TODAY);
    if (!res.ok) throw new Error('不该失败');

    expect(res.plan.patches).toEqual([]);
    expect(res.plan.events).toEqual([]);
    expect(res.plan.ledger).toBeUndefined();
  });

  it('暂停期间手动「取用」过的药，恢复后那几片**不会被算两次**（反直觉，但对的）', () => {
    // `planTake` 的 afterTake 只判 autoDeduct、不判 autoPaused，所以停药期间
    // 手动记的「取用」照样累加进账本。恢复时起算日一起被推到今天 ——
    // 那一笔于是**被丢弃**而不是被追认。用户手动记的那几片仍然从库存里扣掉了，
    // 只是不再计入自动扣减的账。
    const paused = auto({ autoPaused: true, autoFrom: TODAY, autoAccounted: 0 });
    const taken = afterTake(paused, 3);

    expect(taken).toEqual({ autoFrom: TODAY, autoAccounted: 3 });

    const res = planResume({ ...paused, autoAccounted: 3 }, TODAY);
    if (!res.ok) throw new Error('不该失败');
    expect(res.plan.ledger).toEqual({ medicineId: 7, autoFrom: TODAY, autoAccounted: 0 });
    expect(res.plan.patches).toEqual([]);
  });

  it('守卫：没开自动扣减的药，两个动作都拒绝', () => {
    const off = prev({ autoDeduct: false, autoPaused: false, dailyDose: 1, autoFrom: addDays(TODAY, -10) });

    const a = planPause(off, [abox(30)], TODAY);
    const b = planResume(off, TODAY);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    // 措辞不同是因为**判据顺序是先状态后开关**（下一条专门钉这个顺序）：
    // 这一行 autoPaused 是 0，所以 resume 报的是「没有在暂停中」—— 真话。
    if (a.ok || b.ok) throw new Error('不该通过');
    expect(a.errors._).toBe('这个药没有开启自动扣减，不需要暂停或恢复。');
    expect(b.errors._).toBe('这个药没有在暂停中，不需要恢复。');
  });

  it('守卫：已经暂停了再暂停 → 拒绝；没暂停就恢复 → 拒绝', () => {
    const already = auto({ autoPaused: true, autoFrom: addDays(TODAY, -10) });
    const a = planPause(already, [abox(30)], TODAY);
    if (a.ok) throw new Error('不该通过');
    expect(a.errors._).toBe('这个药已经在暂停中了。');

    const running = auto({ autoPaused: false, autoFrom: addDays(TODAY, -10) });
    const b = planResume(running, TODAY);
    if (b.ok) throw new Error('不该通过');
    // 「没暂停就恢复」才是真正危险的那一边：起算日推到今天、账本归零，
    // 而欠账没结清 —— 静默抹账。所以两个方向都拒绝，而不是只拦一边。
    expect(b.errors._).toBe('这个药没有在暂停中，不需要恢复。');
  });

  it('守卫：judgement 顺序 —— 关掉开关留下的 stale autoPaused 报的是「没开自动扣减」', () => {
    // 「先暂停 → 再进编辑档案关掉自动扣减」会留下 autoDeduct=false 且
    // autoPaused=true 的行（见 fieldsFrom）。这条钉住判据是**先看目标状态、
    // 再看开关**：反过来的话这里会报「这个药没有在暂停中」—— 而那一行上
    // autoPaused 明明是 1。报错可以，说假话不行。
    const stale = prev({ autoDeduct: false, autoPaused: true });
    const res = planResume(stale, TODAY);
    if (res.ok) throw new Error('不该通过');

    expect(res.errors._).not.toContain('没有在暂停中');
    expect(res.errors._).toBe('这个药没有开启自动扣减，不需要暂停或恢复。');
  });
});
