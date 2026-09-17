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

import { deleteMember, ownedMedicineCount } from '../src/data/members';
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
import { batches, medicines, members, stockEvents } from '../src/db/schema';
import { addDays } from '../src/domain/calendar';
import { BATCH_IN_STOCK } from '../src/domain/constants';
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
