/**
 * 落库层（`src/data/`）的端到端测试 —— 在**真 SQLite** 上跑。
 *
 * ── 为什么值得为它装一个原生依赖 ───────────────────────────────────────
 * `src/domain/` 那层是纯函数，测试很容易写；但真正把数据改坏的地方在**下面一层**：
 * `applyPlan` 要把「patches → UPDATE 批次」「events → INSERT 变动记录」
 * 「ledger → 成对 UPDATE 两个列」三件事绑到同一个事务里。绑错了的表现是
 * **库存数字和时间线对不上** —— 用户看不出来，但从此账本就是错的。
 *
 * 怎么把库建起来（真 SQLite、跑 App 同一份迁移 SQL、为什么用 better-sqlite3
 * 而不是 expo-sqlite）见 `test/helpers.ts` 的文件头。
 */
import { eq } from 'drizzle-orm';

import {
  batchCountOf,
  createMedicine,
  deleteMedicine,
  medicineById,
  pauseMedicine,
  resumeMedicine,
  updateMedicine,
} from '../src/data/medicines';
import { deleteMember, ownedMedicineCount } from '../src/data/members';
import { getThresholds } from '../src/data/queries';
import {
  batchById,
  discard,
  edit,
  inStockBatchesOf,
  intake,
  markExpired,
  restock,
  settleAll,
  take,
  usedUp,
} from '../src/data/stock';
import type { MedboxDb } from '../src/db/client';
import { batches, medicines, members, settings, stockEvents } from '../src/db/schema';
import { addDays, diffDays, today as todayDay } from '../src/domain/calendar';
import {
  BATCH_IN_STOCK,
  BATCH_USED_UP,
  DEFAULT_RESTOCK_DAYS,
  EVENT_AUTO,
  KEY_NEAR_EXPIRY_DAYS,
  KEY_RESTOCK_DAYS,
} from '../src/domain/constants';
import type { MedicineForm } from '../src/domain/medicine';
import { getIntSetting, getSetting, setSetting } from '../src/importer/apply';
import { addBatch, addMedicine, freshDb, insertId } from './helpers';

const TODAY = '2026-09-14';
const NOW = Date.UTC(2026, 8, 14, 4, 0, 0);

// ── 造数据 ─────────────────────────────────────────────────────────────

/** 薄的本地包装：把本文件的基准时刻 `NOW` 绑上，调用点就不用到处传。 */
function med(db: MedboxDb, over: Partial<Parameters<typeof addMedicine>[2]> = {}): number {
  return addMedicine(db, NOW, over);
}

function box(
  db: MedboxDb,
  medicineId: number,
  qty: number,
  over: Partial<Parameters<typeof addBatch>[4]> = {},
): number {
  return addBatch(db, NOW, medicineId, qty, over);
}

/** 开着自动扣减、起算日往回数 `days` 天、每日 1 片的药。 */
function autoMed(db: MedboxDb, days: number): number {
  return med(db, {
    autoDeduct: true,
    dailyDose: 1,
    autoFrom: addDays(TODAY, -days),
    autoAccounted: 0,
  });
}

function events(db: MedboxDb, batchId: number) {
  return db
    .select()
    .from(stockEvents)
    .where(eq(stockEvents.batchId, batchId))
    .all()
    .sort((a, b) => a.id - b.id);
}

function lastEvent(db: MedboxDb, batchId: number) {
  const all = events(db, batchId);
  return all[all.length - 1];
}

/**
 * 不变量 1，直接在 SQL 上核：**每一盒的数量 == 它最后一条变动记录的「变动后数量」**。
 *
 * 这是全文件最要紧的一条断言 —— 它同时也是「事件有没有绑到正确的批次上」的判据：
 * 事件绑错行的话，被绑的那盒最后一条事件对不上，绑错到的目标也对不上。
 */
function assertInvariant1(db: MedboxDb): void {
  for (const b of db.select().from(batches).all()) {
    const last = lastEvent(db, b.id);
    // 用 throw 而不是 expect 的第二参数：那是 Vitest 的写法，jest 不认
    if (!last) throw new Error(`批次 ${b.id} 一条变动记录都没有`);
    if (last.qtyAfter !== b.qty) {
      throw new Error(
        `不变量 1 破了 —— 批次 ${b.id} 的数量是 ${b.qty}，` +
          `最后一条变动记录（${last.type}）写的却是 ${last.qtyAfter}`,
      );
    }
  }
}

function qtyOf(db: MedboxDb, id: number): number {
  return batchById(db, id)!.qty;
}

function statusOf(db: MedboxDb, id: number): string {
  return batchById(db, id)!.status;
}

function ledgerOf(db: MedboxDb, id: number) {
  const m = db.select().from(medicines).where(eq(medicines.id, id)).get()!;
  return { autoFrom: m.autoFrom, autoAccounted: m.autoAccounted };
}

// ══ 入库 ═════════════════════════════════════════════════════════════════

describe('入库', () => {
  it('新盒真的落库，且「入库」事件绑在**新建的那一行**上', () => {
    const db = freshDb();
    const m = med(db);

    const res = intake(db, m, { qty: '30', expiryDate: '2027-01-31', openedAt: '', openLifeDays: '', location: '药箱·上层', notes: '' }, TODAY);
    expect(res.ok).toBe(true);

    const b = db.select().from(batches).all();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ qty: 30, unit: '片', status: BATCH_IN_STOCK, location: '药箱·上层' });

    // 入库时 Plan 里的事件 batchId 是 null（那一行还不存在），
    // 靠 applyPlan 换成刚插入的自增 id —— 换错了这里就是外键错误或绑到别人身上
    const ev = lastEvent(db, b[0].id);
    expect(ev).toMatchObject({ type: 'in', deltaQty: 30, qtyAfter: 30 });
    assertInvariant1(db);
  });

  it('数量必须大于 0，报错时**一行都不写**', () => {
    const db = freshDb();
    const m = med(db);

    expect(intake(db, m, { qty: '0', expiryDate: '', openedAt: '', openLifeDays: '', location: '', notes: '' }, TODAY).ok).toBe(false);
    expect(db.select().from(batches).all()).toHaveLength(0);
    expect(db.select().from(stockEvents).all()).toHaveLength(0);
  });

  it('补货时先把欠的账结清、再从今天重新起算（断货期不能一次性补扣）', () => {
    const db = freshDb();
    const m = autoMed(db, 10); // 10 天没管过
    const old = box(db, m, 2); // 手上只剩 2 片

    // 用**手上现有的**库存结账：只扣得掉 2 片，剩下 8 天的量作废
    expect(intake(db, m, { qty: '30', expiryDate: '', openedAt: '', openLifeDays: '', location: '', notes: '' }, TODAY).ok).toBe(true);

    expect(qtyOf(db, old)).toBe(0);
    expect(statusOf(db, old)).toBe('used_up');
    // 起算日推到今天、已核算清零 —— 新进来的 30 片不该被过去的 8 天吃掉
    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });
    assertInvariant1(db);
  });
});

// ══ 取用 ═════════════════════════════════════════════════════════════════

describe('取用', () => {
  it('数量减掉、时间线留痕、账本累加而**起算日不动**', () => {
    const db = freshDb();
    const m = autoMed(db, 2);
    const b = box(db, m, 10);
    const from = ledgerOf(db, m).autoFrom;

    expect(take(db, b, '3', '装进随身药盒', TODAY).ok).toBe(true);

    expect(qtyOf(db, b)).toBe(7);
    expect(lastEvent(db, b)).toMatchObject({ type: 'take', deltaQty: -3, qtyAfter: 7, reason: '装进随身药盒' });
    // 取用是「报告消耗」：同一个已核算量要算上它，所以起算日不能被推走
    expect(ledgerOf(db, m)).toEqual({ autoFrom: from, autoAccounted: 3 });
    assertInvariant1(db);
  });

  it('取用不能超过现有数量 —— 报错且数量不变', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);

    const res = take(db, b, '6', '', TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.amount).toContain('不能超过');
    expect(qtyOf(db, b)).toBe(5);
    expect(events(db, b)).toHaveLength(0);
  });

  it('不在库的盒不能取用', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5, { status: 'expired' });
    expect(take(db, b, '1', '', TODAY).ok).toBe(false);
  });
});

// ══ 用完 / 丢弃 / 标记过期 / 恢复在库 ═══════════════════════════════════

describe('用完 / 丢弃 / 标记过期 / 恢复在库', () => {
  it('用完：数量归 0 且状态转「已用完」', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);

    expect(usedUp(db, b, TODAY).ok).toBe(true);
    expect(qtyOf(db, b)).toBe(0);
    expect(statusOf(db, b)).toBe('used_up');
    expect(lastEvent(db, b)).toMatchObject({ type: 'used_up', deltaQty: -5, qtyAfter: 0 });
    assertInvariant1(db);
  });

  it('用完一盒后它退出在库清单（结算不该再看到它）', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);

    expect(inStockBatchesOf(db, m)).toHaveLength(1);
    usedUp(db, b, TODAY);
    expect(inStockBatchesOf(db, m)).toHaveLength(0);
  });

  it('丢弃：数量归 0、状态转「已丢弃」、原因由用户填', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);

    expect(discard(db, b, '受潮了', TODAY).ok).toBe(true);
    expect(qtyOf(db, b)).toBe(0);
    expect(statusOf(db, b)).toBe('discarded');
    expect(lastEvent(db, b)).toMatchObject({ type: 'discard', reason: '受潮了' });
    assertInvariant1(db);
  });

  it('标记过期：**数量不变**，也完全不碰账本', () => {
    const db = freshDb();
    const m = autoMed(db, 3);
    const b = box(db, m, 5);

    expect(markExpired(db, b, TODAY).ok).toBe(true);
    expect(qtyOf(db, b)).toBe(5);
    expect(statusOf(db, b)).toBe('expired');
    expect(lastEvent(db, b)).toMatchObject({ type: 'mark_expired', deltaQty: 0, qtyAfter: 5 });
    // 网页版这里也不调 rebaseline：库存没变就没有要结的账
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, -3), autoAccounted: 0 });
    assertInvariant1(db);
  });

  it('恢复在库：数量不变、状态回来，且结算看到的是**恢复之前**的库存', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5, { status: 'expired' });

    expect(restock(db, b, TODAY).ok).toBe(true);
    expect(qtyOf(db, b)).toBe(5);
    expect(statusOf(db, b)).toBe(BATCH_IN_STOCK);
    expect(lastEvent(db, b)).toMatchObject({ type: 'restock', deltaQty: 0, qtyAfter: 5 });
    assertInvariant1(db);
  });

  it('数量为 0 的盒不给恢复在库（否则造出「在库 0 片」，违反不变量 4）', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);
    usedUp(db, b, TODAY);

    const res = restock(db, b, TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors._).toContain('编辑');
    expect(statusOf(db, b)).toBe('used_up');
    assertInvariant1(db);
  });
});

// ══ 编辑纠错 ═════════════════════════════════════════════════════════════

describe('编辑纠错', () => {
  it('改数量：写完的还是「数量 == 最后一条事件」，且账本被重新起算', () => {
    const db = freshDb();
    const m = autoMed(db, 4);
    const b = box(db, m, 20);

    expect(edit(db, b, { qty: '12', unit: '片', expiryDate: '', openedAt: '', openLifeDays: '', ownerId: '', location: '', notes: '' }, TODAY).ok).toBe(true);

    expect(qtyOf(db, b)).toBe(12);
    expect(lastEvent(db, b).qtyAfter).toBe(12);
    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });
    assertInvariant1(db);
  });

  it('改到 0：状态一并转「已用完」', () => {
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 20);

    expect(edit(db, b, { qty: '0', unit: '片', expiryDate: '', openedAt: '', openLifeDays: '', ownerId: '', location: '', notes: '' }, TODAY).ok).toBe(true);

    expect(qtyOf(db, b)).toBe(0);
    expect(statusOf(db, b)).toBe('used_up');
    assertInvariant1(db);
  });

  it('结算把这一盒扣到 0、用户同时把它改成 8 —— 不能留下「已用完但还有 8 片」', () => {
    const db = freshDb();
    const m = autoMed(db, 3);
    const b = box(db, m, 3);

    // 编辑先把旧数量结清（3 片正好被扣光 → 结算标了 used_up），
    // 再写用户填的 8 —— 两条 patch 落在同一行，后写的必须把状态一起掰回来
    expect(edit(db, b, { qty: '8', unit: '片', expiryDate: '', openedAt: '', openLifeDays: '', ownerId: '', location: '', notes: '' }, TODAY).ok).toBe(true);

    expect(qtyOf(db, b)).toBe(8);
    expect(statusOf(db, b)).toBe(BATCH_IN_STOCK);
    assertInvariant1(db);
  });
});

// ══ 结算 ════════════════════════════════════════════════════════════════

describe('自动扣减结算', () => {
  it('按天数扣、账本与库存一起落库', () => {
    const db = freshDb();
    const m = autoMed(db, 3);
    const b = box(db, m, 10);

    expect(settleAll(db, TODAY, NOW)).toBe(3);

    expect(qtyOf(db, b)).toBe(7);
    expect(lastEvent(db, b)).toMatchObject({ type: 'auto_take', deltaQty: -3, qtyAfter: 7 });
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, -3), autoAccounted: 3 });
    assertInvariant1(db);
  });

  it('幂等：同一天跑两遍，第二遍一片都不扣（冷启动能放心多跑）', () => {
    const db = freshDb();
    const m = autoMed(db, 3);
    const b = box(db, m, 10);

    expect(settleAll(db, TODAY, NOW)).toBe(3);
    const after = qtyOf(db, b);
    const evCount = events(db, b).length;

    expect(settleAll(db, TODAY, NOW)).toBe(0);
    expect(qtyOf(db, b)).toBe(after);
    expect(events(db, b)).toHaveLength(evCount);
    assertInvariant1(db);
  });

  it('库存扣光后：状态转「已用完」，且第二天不会变成负数', () => {
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 4);

    expect(settleAll(db, TODAY, NOW)).toBe(4);
    expect(qtyOf(db, b)).toBe(0);
    expect(statusOf(db, b)).toBe('used_up');

    expect(settleAll(db, addDays(TODAY, 1), NOW)).toBe(0);
    expect(qtyOf(db, b)).toBe(0);
    assertInvariant1(db);
  });

  it('单位冲突的药品跳过扣减，并留下一条说明（不静默改数）', () => {
    const db = freshDb();
    const m = autoMed(db, 3);
    box(db, m, 5);
    box(db, m, 5, { unit: '盒' });

    expect(settleAll(db, TODAY, NOW)).toBe(0);
    expect(ledgerOf(db, m).autoAccounted).toBe(0);
  });

  it('暂停的药不扣；没开自动扣减的药更不扣', () => {
    const db = freshDb();
    const paused = med(db, { autoDeduct: true, autoPaused: true, dailyDose: 1, autoFrom: addDays(TODAY, -5), autoAccounted: 0 });
    const off = med(db, { generic: '手记的药', dailyDose: 1, autoFrom: addDays(TODAY, -5) });
    const b1 = box(db, paused, 10);
    const b2 = box(db, off, 10);

    expect(settleAll(db, TODAY, NOW)).toBe(0);
    expect(qtyOf(db, b1)).toBe(10);
    expect(qtyOf(db, b2)).toBe(10);
  });
});

// ══ 成员（不变量 7） ═══════════════════════════════════════════════════

describe('成员删除', () => {
  it('名下有药时拒绝删除，且**不**把那些药改到家庭共用', () => {
    const db = freshDb();
    const memberId = insertId(db.insert(members).values({ name: '外公', createdAt: NOW }).run());
    const m = med(db, { generic: '缬沙坦胶囊', ownerId: memberId });

    expect(ownedMedicineCount(db, memberId)).toBe(1);

    const del = deleteMember(db, memberId);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.errors._).toContain('1 种药');

    // 关键：拒绝就是拒绝，不能顺手把归属清掉 —— 那是用药安全信息
    expect(db.select().from(members).all()).toHaveLength(1);
    expect(db.select().from(medicines).where(eq(medicines.id, m)).get()!.ownerId).toBe(memberId);
  });

  it('名下没药时可以删', () => {
    const db = freshDb();
    const memberId = insertId(db.insert(members).values({ name: '孩子', createdAt: NOW }).run());

    expect(deleteMember(db, memberId).ok).toBe(true);
    expect(db.select().from(members).all()).toHaveLength(0);
  });
});

// ══ 设置 ═════════════════════════════════════════════════════════════════
//
// 输入的校验（什么能存、报什么话）在 `test/settings.test.ts` 里测，那是纯的。
// 这里只测**写进去之后**的行为：upsert 真的覆盖了吗、读回来对不对。

describe('设置', () => {
  it('同一个键写两次只留一行，值是后写的', () => {
    const db = freshDb();

    setSetting(db, 'near_expiry_days', '90');
    setSetting(db, 'near_expiry_days', '30');

    const rows = db.select().from(settings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('30');
  });

  it('没写过的键读到默认值，写完之后读到新值', () => {
    const db = freshDb();

    expect(getIntSetting(db, 'restock_days', DEFAULT_RESTOCK_DAYS)).toBe(DEFAULT_RESTOCK_DAYS);

    setSetting(db, 'restock_days', '7');
    expect(getIntSetting(db, 'restock_days', DEFAULT_RESTOCK_DAYS)).toBe(7);
    expect(getSetting(db, 'restock_days')).toBe('7');
  });

  it('界面读阈值的那条路（getThresholds）认新值', () => {
    // 这条测的是**接线**：设置页写的是 KEY_NEAR_EXPIRY_DAYS / KEY_RESTOCK_DAYS
    // 这两个键，而首页读的是 getThresholds。两边对不上的话，用户保存完
    // 回到首页发现数字没变，却以为是自己没点中「保存」。
    //
    // 这里**刻意不断言库存没变**：`setSetting` 结构上就碰不到任何库存表，
    // 断言它只会得到一条永远不可能失败的装饰。真正需要防的是「界面在保存阈值时
    // 顺手调了一次结算」—— 那是界面层的错，得靠手工过一遍，测不到这里来。
    const db = freshDb();

    setSetting(db, KEY_NEAR_EXPIRY_DAYS, '30');
    setSetting(db, KEY_RESTOCK_DAYS, '7');

    expect(getThresholds(db)).toEqual({ nearDays: 30, restockDays: 7 });
  });
});

// ══ 药品档案 ═════════════════════════════════════════════════════════════
//
// 校验（什么能存、报什么话）在 `test/medicine.test.ts` 里测，那是纯的。
// 这里测的是**落库之后到底发生了什么** —— 扣了几片、事件写了什么、账本对不对。
//
// 这一组是全仓库第二要紧的地方（第一是自动扣减本身）：改剂量/开关是唯一
// 「静默改真实库存、算错了用户看不出来」的用户操作。

/** 一张合法的档案表单。每个用例只覆盖它关心的字段。 */
function mform(over: Partial<MedicineForm> = {}): MedicineForm {
  return {
    generic: '测试药',
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

/** 库里一共有多少条变动记录 —— 用来断言「这次操作一条都没写」。 */
function eventCount(db: MedboxDb): number {
  return db.select().from(stockEvents).all().length;
}

describe('药品档案', () => {
  it('改每日用量：先按**旧**用量结清，再以今天重新起算 —— 10 天只扣 10，不是 20', () => {
    const db = freshDb();
    const m = autoMed(db, 10); // 每日 1、起算日在 10 天前、已核算 0
    const b = box(db, m, 30);

    const res = updateMedicine(
      db,
      m,
      mform({ generic: '测试药', dailyDose: '2', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(true);

    // 要害：如果先赋新值（每日 2）再结清，这里会是 30 - 20 = 10。
    // 正确顺序是拿**旧**的每日 1 去算过去 10 天，扣 10 片。
    expect(qtyOf(db, b)).toBe(20);

    // 事件原因里写的是**旧**用量。带全角右括号是为了挡住「每日用量 12）」
    // 这类误匹配 —— 只搜 `每日用量 1` 的话，用量 12 的串也能匹配上。
    expect(lastEvent(db, b).reason).toContain('每日用量 1）');
    expect(lastEvent(db, b).type).toBe(EVENT_AUTO);

    // 账本重设到今天、已核算归零
    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });
    // 档案行也真的写进去了 —— 这一条同时钉住「结算与档案行在同一个事务里」
    expect(medicineById(db, m)!.dailyDose).toBe(2);

    assertInvariant1(db);
  });

  it('改成自动扣减：账本初始化为**今天**，不追溯过去的天数', () => {
    const db = freshDb();
    // 没开自动扣减、也没有起算日，但药已经躺在库里
    const m = med(db);
    const b = box(db, m, 30);

    const res = updateMedicine(db, m, mform({ dailyDose: '1', autoDeduct: true }), TODAY, NOW);
    expect(res.ok).toBe(true);

    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });
    // 一片都没扣 —— 打开开关不该把「之前那些天」补算上
    expect(qtyOf(db, b)).toBe(30);
    expect(events(db, b)).toHaveLength(0);

    // 刻意**不调** assertInvariant1：这里要断言的正是「一条事件都没有」，
    // 而 box() 造出来的批次本来就没有事件（模拟导入的存量数据，§6.9 的例外），
    // 那条不变量在这里必然报「批次没有变动记录」。别的用例两样都要，这里只取一样。
  });

  it('关掉自动扣减：**仍然先按旧参数结清**（有意保持与上游一致）', () => {
    // 上游的 auto_changed 对「开关变了」和「剂量变了」是对称的。关掉之前
    // 那几天吃过的药是真的吃过了，不结清等于白送。代价是这个动作会产生
    // 一条自动扣减事件 —— 所以编辑页必须给用户解释（见那个「notice」提示块）。
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 30);

    const res = updateMedicine(db, m, mform({ dailyDose: '1', autoDeduct: false }), TODAY, NOW);
    expect(res.ok).toBe(true);

    expect(qtyOf(db, b)).toBe(20);
    expect(lastEvent(db, b).type).toBe(EVENT_AUTO);
    expect(medicineById(db, m)!.autoDeduct).toBe(false);

    assertInvariant1(db);
  });

  it('只改通用名：库存、账本、时间线**一个字都不动**', () => {
    // 防「每次保存都 rebaseline」—— 那会让用户改个错别字就触发一次
    // 自动扣减，外加时间线上多一条莫名其妙的记录。
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 30);
    const before = eventCount(db);

    const res = updateMedicine(
      db,
      m,
      mform({ generic: '改个错别字', dailyDose: '1', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(true);

    expect(medicineById(db, m)!.generic).toBe('改个错别字');
    expect(qtyOf(db, b)).toBe(30);
    expect(eventCount(db)).toBe(before);
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, -10), autoAccounted: 0 });

    // 同上：这里断言的是「一条事件都没写」，与 assertInvariant1 互斥
  });

  it('暂停中的药只改通用名，**不会**被默默解除暂停', () => {
    // 编辑表单里没有暂停开关，用户改个错别字不会被提示「你的药重新开始扣了」。
    // 所以「autoDeduct 为真就置 autoPaused = false」是错的写法。
    const db = freshDb();
    const m = med(db, { autoDeduct: true, autoPaused: true, dailyDose: 1, autoFrom: TODAY });
    box(db, m, 30);

    const res = updateMedicine(
      db,
      m,
      mform({ generic: '改个错别字', dailyDose: '1', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(true);

    expect(medicineById(db, m)!.autoPaused).toBe(true);
  });

  it('改单位 / 改归属**不改写已有批次**', () => {
    // 单位与归属只对**之后新入库**的批次生效。改写已有批次等于静默篡改历史 ——
    // 用户看到的是「这盒明明写着一盒，怎么变成一片了」。
    const db = freshDb();
    const dad = insertId(db.insert(members).values({ name: '爸爸', createdAt: NOW }).run());
    const mom = insertId(db.insert(members).values({ name: '妈妈', createdAt: NOW }).run());
    const m = med(db, { unit: '片', ownerId: dad });
    const b1 = box(db, m, 10, { unit: '片', ownerId: dad });
    const b2 = box(db, m, 20, { unit: '片', ownerId: dad });
    const before = eventCount(db);

    const res = updateMedicine(db, m, mform({ unit: '盒', ownerId: String(mom) }), TODAY, NOW);
    expect(res.ok).toBe(true);

    // 档案行是新值……
    const row = medicineById(db, m)!;
    expect(row.unit).toBe('盒');
    expect(row.ownerId).toBe(mom);
    // ……而两盒还是旧值，且没有产生任何记录
    expect(batchById(db, b1)!.unit).toBe('片');
    expect(batchById(db, b1)!.ownerId).toBe(dad);
    expect(batchById(db, b2)!.unit).toBe('片');
    expect(batchById(db, b2)!.ownerId).toBe(dad);
    expect(eventCount(db)).toBe(before);
  });

  it('校验失败时**一行都不写** —— 库存、账本、档案行全都原样', () => {
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 30);
    const before = eventCount(db);

    const res = updateMedicine(
      db,
      m,
      mform({ generic: '', dailyDose: 'abc', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该通过');
    expect(Object.keys(res.errors).sort()).toEqual(['dailyDose', 'generic']);

    expect(qtyOf(db, b)).toBe(30);
    expect(eventCount(db)).toBe(before);
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, -10), autoAccounted: 0 });
    expect(medicineById(db, m)!.generic).toBe('测试药');
  });

  it('药品不存在：报一句 `_` 错误，且什么都不写', () => {
    const db = freshDb();
    const before = eventCount(db);

    const res = updateMedicine(db, 999, mform(), TODAY, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该通过');
    expect(res.errors._).toContain('药品不存在');
    expect(eventCount(db)).toBe(before);
  });

  it('新建：起算日 = **建档当天**，已核算 = 0，且一条变动记录都不产生', () => {
    const db = freshDb();

    const res = createMedicine(
      db,
      mform({ generic: '二甲双胍缓释片', dailyDose: '2', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('不该失败');

    const row = medicineById(db, res.id)!;
    expect(row.autoFrom).toBe(TODAY);
    expect(row.autoAccounted).toBe(0);
    expect(row.createdAt).toBe(NOW);
    // 建档不产生事件 —— 而且是结构性的：stock_events.batch_id 是 NOT NULL
    // 且外键指向 batches，一盒都没有时根本没有可挂的行
    expect(eventCount(db)).toBe(0);
  });

  it('新建：没勾自动扣减时起算日**为空**', () => {
    const db = freshDb();
    const res = createMedicine(db, mform(), TODAY, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('不该失败');

    expect(medicineById(db, res.id)!.autoFrom).toBeNull();
  });

  it('新建：id 是真的（不是 NaN）—— 驱动键名差异的回归点', () => {
    // `createMember` 就是在这上面栽的：它写 `Number(res.lastInsertRowId)`，
    // 而 better-sqlite3 返回的键是小写 d，于是拿到 NaN —— 本地测试全绿、
    // 真机反而是好的。这条把 createMedicine 钉住。
    const db = freshDb();
    const res = createMedicine(db, mform(), TODAY, NOW);
    if (!res.ok) throw new Error('不该失败');

    expect(Number.isInteger(res.id)).toBe(true);
    expect(medicineById(db, res.id)).toBeDefined();
  });

  it('删除：有一条**已用完**的批次也拒绝 —— 判据是全部批次，不是「在库」批次', () => {
    // 用 inStockBatchesOf 当判据的话，这里会被放行，然后外键抛一句
    // `FOREIGN KEY constraint failed` —— 指不到病根的原始报错。
    const db = freshDb();
    const m = med(db);
    const b = box(db, m, 5);
    usedUp(db, m, b, TODAY, NOW);
    expect(statusOf(db, b)).toBe(BATCH_USED_UP);
    expect(inStockBatchesOf(db, m)).toHaveLength(0); // 在库确实是空的

    const res = deleteMedicine(db, m);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该通过');
    // 药名（用户手上有十几种药）+ 条数（判断有没有点错对象）
    expect(res.errors._).toContain('「测试药」');
    expect(res.errors._).toContain('1 条批次记录');
    // 拒绝就是拒绝：档案行与批次都原样
    expect(medicineById(db, m)).toBeDefined();
    expect(batchById(db, b)).toBeDefined();
  });

  it('删除：一条批次都没有时可以删', () => {
    const db = freshDb();
    const m = med(db);

    const res = deleteMedicine(db, m);
    expect(res.ok).toBe(true);
    expect(medicineById(db, m)).toBeUndefined();
  });

  it('删除：药品不存在时报错，不静默成功', () => {
    const db = freshDb();
    const res = deleteMedicine(db, 999);
    expect(res.ok).toBe(false);
  });
});

// ══ 暂停服药 / 恢复服药 ════════════════════════════════════════════════
//
// 纯规则（扣多少、守卫措辞、起算日动不动）在 `test/medicine.test.ts` 里测。
// 这里测的是**落库之后到底发生了什么** —— 尤其「结算与标志位在同一个事务里」
// 这一条：只落了结算没落标志位的话，那个药会带着「已经结清」的账本继续按天扣。

describe('暂停 / 恢复', () => {
  it('暂停：按天扣、写 auto_take 事件、置标志位，而**起算日不动**', () => {
    const db = freshDb();
    const m = autoMed(db, 10); // 每日 1、起算日 10 天前、已核算 0
    const b = box(db, m, 30);

    const res = pauseMedicine(db, m, TODAY, NOW);
    expect(res.ok).toBe(true);

    expect(qtyOf(db, b)).toBe(20);
    expect(lastEvent(db, b).type).toBe(EVENT_AUTO);
    expect(medicineById(db, m)!.autoPaused).toBe(true);
    // ⚠️ 这条是分水岭：暂停**不重设基线**。用 planRebaseline 的话会是 (TODAY, 0)，
    // 那是「编辑档案」的语义 —— 用户改了剂量才该那样。
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, -10), autoAccounted: 10 });

    assertInvariant1(db);
  });

  it('恢复：库存**一片都不动**，只把起算日设成今天、已核算归零', () => {
    const db = freshDb();
    const m = med(db, {
      autoDeduct: true,
      autoPaused: true,
      dailyDose: 1,
      autoFrom: addDays(TODAY, -30),
      autoAccounted: 0,
    });
    const b = box(db, m, 30);
    const before = eventCount(db);

    const res = resumeMedicine(db, m, TODAY, NOW);
    expect(res.ok).toBe(true);

    expect(qtyOf(db, b)).toBe(30); // ← 全部承诺就在这一行
    expect(eventCount(db)).toBe(before); // 一条变动记录都不写
    expect(medicineById(db, m)!.autoPaused).toBe(false);
    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });

    // 刻意不调 assertInvariant1：这里断言的正是「一条事件都没写」，
    // 而 box() 造的批次本来就没有事件（模拟导入的存量数据，§6.9 的例外）。
  });

  it('暂停 → 隔几天 → 恢复：停药期间一片不扣，恢复后从当天重新开始扣', () => {
    // 这是这个功能对用户的**全部承诺**，端到端走一整圈。
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 30);

    // 9/14 暂停：结清这 10 天
    expect(pauseMedicine(db, m, TODAY, NOW).ok).toBe(true);
    expect(qtyOf(db, b)).toBe(20);

    // 停药 5 天。闸门在这期间照常跑（冷启动 / 回前台），但它会跳过这个药
    expect(settleAll(db, addDays(TODAY, 5), NOW)).toBe(0);
    expect(qtyOf(db, b)).toBe(20); // 一片都没动

    // 9/19 恢复：从当天重新起算
    expect(resumeMedicine(db, m, addDays(TODAY, 5), NOW).ok).toBe(true);
    expect(ledgerOf(db, m)).toEqual({ autoFrom: addDays(TODAY, 5), autoAccounted: 0 });
    expect(qtyOf(db, b)).toBe(20);

    // 再隔一天才重新开始扣，且只扣一天
    expect(settleAll(db, addDays(TODAY, 6), NOW)).toBe(1);
    expect(qtyOf(db, b)).toBe(19);
  });

  it('暂停中的药**不再被闸门结算**（settleAll 的 filter）', () => {
    const db = freshDb();
    const m = autoMed(db, 0); // 起算日就是今天，按下去时无事可做
    const b = box(db, m, 30);

    expect(pauseMedicine(db, m, TODAY, NOW).ok).toBe(true);
    const before = eventCount(db);

    // 隔 7 天再跑闸门 —— 暂停的药必须一动不动
    expect(settleAll(db, addDays(TODAY, 7), NOW)).toBe(0);
    expect(qtyOf(db, b)).toBe(30);
    expect(eventCount(db)).toBe(before);
    // 而且连起算日都不该被推走：暂停的意图是整段作废，不是「从今天重算」
    expect(ledgerOf(db, m)).toEqual({ autoFrom: TODAY, autoAccounted: 0 });
  });

  it('不传 today 时用的是**当天**（默认值 todayDay()，不是缓存的旧日期）', () => {
    // 这两个动作的日期错了**不会自愈**：暂停用昨天结算 → 那一片永久消失。
    // 所以签名上的默认值必须真的生效，而不是「反正界面会传」。
    //
    // ⚠️ 这条**不能**拿文件顶部的 TODAY 去算 —— 那是个固定夹具，而默认值取的是
    // **真实当天**。所以期望值也从 `todayDay()` 现算：断言的是「结算走到了今天」，
    // 而不是「走到了某个写死的日期」。
    const db = freshDb();
    const m = autoMed(db, 3);
    const b = box(db, m, 30);

    const autoFrom = addDays(TODAY, -3); // 相对夹具，与「今天」无关
    expect(pauseMedicine(db, m).ok).toBe(true);

    const expectedDays = diffDays(autoFrom, todayDay()); // diffDays(a, b) 是 b − a
    // 起算日**不动**（暂停不重设基线），但账已经结到当天了
    expect(ledgerOf(db, m)).toEqual({ autoFrom, autoAccounted: expectedDays });
    expect(qtyOf(db, b)).toBe(30 - expectedDays);
    // 兜底：真实当天与夹具差得离谱的话，上面的式子会自己成立而没有说服力
    expect(expectedDays).toBeGreaterThan(0);
  });

  it('守卫失败时**一行都不写** —— 库存、账本、标志位、时间线全都原样', () => {
    const db = freshDb();
    const m = autoMed(db, 10);
    const b = box(db, m, 30);
    const before = eventCount(db);

    // 没暂停就恢复
    const a = resumeMedicine(db, m, TODAY, NOW);
    expect(a.ok).toBe(false);
    // 已经暂停了再暂停
    expect(pauseMedicine(db, m, TODAY, NOW).ok).toBe(true);
    const b2 = pauseMedicine(db, m, TODAY, NOW);
    expect(b2.ok).toBe(false);

    expect(qtyOf(db, b)).toBe(20); // 只有第一次暂停结的那次
    expect(medicineById(db, m)!.autoPaused).toBe(true);
    expect(eventCount(db)).toBe(before + 1); // 只有第一次暂停写的那一条
  });

  it('药品不存在时不静默成功', () => {
    const db = freshDb();
    expect(pauseMedicine(db, 999, TODAY, NOW).ok).toBe(false);
    expect(resumeMedicine(db, 999, TODAY, NOW).ok).toBe(false);
  });

  it('暂停中的药进编辑页改名字并保存 → **仍然是暂停中**（与落库层是两件事，一起钉住）', () => {
    const db = freshDb();
    const m = autoMed(db, 0);
    box(db, m, 30);
    expect(pauseMedicine(db, m, TODAY, NOW).ok).toBe(true);

    const res = updateMedicine(
      db,
      m,
      mform({ generic: '改个错别字', dailyDose: '1', autoDeduct: true }),
      TODAY,
      NOW,
    );
    expect(res.ok).toBe(true);
    expect(medicineById(db, m)!.autoPaused).toBe(true);
  });
});
