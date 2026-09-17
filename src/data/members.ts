/**
 * 成员与归属 —— `requirements.md` §2.5 / §3.7。
 *
 * ── 「家庭共用」不是一条记录 ───────────────────────────────────────────
 * 它是**归属为空**这个状态。所以这个文件里没有、也不该有一条叫「家庭共用」
 * 的成员行：界面上的「家庭共用」入口查的是 `owner_id IS NULL`。
 * 一旦有人图省事造一条同名记录，同一个药箱就会出现两个「家庭共用」。
 *
 * ── 姓名唯一 ───────────────────────────────────────────────────────────
 * 数据库上已经有唯一索引（`members_name_unique`），这里先查一次只为给出
 * 人话的错误提示。**唯一的保证仍然在索引上** —— 别把这里的前置检查
 * 当成并发安全的依据，它只是文案。
 */
import { eq } from 'drizzle-orm';

import type { MedboxDb } from '../db/client';
import type { Instant, Member } from '../db/schema';
import { medicines, members } from '../db/schema';

export type MemberResult = { ok: true; id: number } | { ok: false; errors: Record<string, string> };

export function memberById(db: MedboxDb, id: number): Member | undefined {
  return db.select().from(members).where(eq(members.id, id)).get();
}

/** 该成员名下的**药品档案**数（不是批次数）—— 不变量 7 的判据。 */
export function ownedMedicineCount(db: MedboxDb, memberId: number): number {
  return db.select({ id: medicines.id }).from(medicines).where(eq(medicines.ownerId, memberId)).all()
    .length;
}

/** 除 `exceptId` 外有没有人叫这个名字。 */
function nameTaken(db: MedboxDb, name: string, exceptId?: number): boolean {
  return db
    .select({ id: members.id, name: members.name })
    .from(members)
    .all()
    .some((m) => m.name === name && m.id !== exceptId);
}

function validateName(db: MedboxDb, raw: string, exceptId?: number): Record<string, string> {
  const name = (raw ?? '').trim();
  if (!name) return { name: '姓名：请填姓名' };
  if (nameTaken(db, name, exceptId)) return { name: `已经有叫「${name}」的成员了，换个名字。` };
  return {};
}

export function createMember(
  db: MedboxDb,
  rawName: string,
  rawNotes: string,
  now: Instant = Date.now(),
): MemberResult {
  const errors = validateName(db, rawName);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const res = db
    .insert(members)
    .values({ name: rawName.trim(), notes: (rawNotes ?? '').trim() || null, createdAt: now })
    .run();
  return { ok: true, id: Number(res.lastInsertRowId) };
}

export function updateMember(
  db: MedboxDb,
  id: number,
  rawName: string,
  rawNotes: string,
  _now: Instant = Date.now(),
): MemberResult {
  if (!memberById(db, id)) return { ok: false, errors: { _: '成员不存在，可能已经被删掉了。' } };

  const errors = validateName(db, rawName, id);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // members 表没有 updated_at：成员的改动不参与任何账本，
  // 加一个时间戳只会让人以为它有用。归属的变更走批次的「编辑」事件留痕。
  db.update(members)
    .set({ name: rawName.trim(), notes: (rawNotes ?? '').trim() || null })
    .where(eq(members.id, id))
    .run();
  return { ok: true, id };
}

/**
 * 删除成员。**有归属药品时拒绝**（不变量 7）。
 *
 * 拒绝而不是「顺手把那些药改成家庭共用」是刻意的：归属是**用药安全信息**
 * （谁在吃这个药），静默改掉等于让药从成员页消失，而用户不会收到任何提示。
 * 想删就先逐一把名下的药改到别人名下或家庭共用 —— 那是个需要人做决定的过程。
 */
export function deleteMember(db: MedboxDb, id: number): MemberResult {
  const m = memberById(db, id);
  if (!m) return { ok: false, errors: { _: '成员不存在，可能已经被删掉了。' } };

  const owned = ownedMedicineCount(db, id);
  if (owned > 0) {
    return {
      ok: false,
      errors: {
        _: `「${m.name}」名下还有 ${owned} 种药，不能删除。请先把这些药的归属改成别人或「家庭共用」。`,
      },
    };
  }

  db.delete(members).where(eq(members.id, id)).run();
  return { ok: true, id };
}
