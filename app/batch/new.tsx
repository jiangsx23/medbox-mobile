/**
 * 入库 —— 新增一盒（`requirements.md` §3.2）。
 *
 * ── 预填规则是这一页最不显然的地方 ─────────────────────────────────────
 * 分两层，**来源不同、取舍也不同**：
 *
 * | 字段 | 预填自 | 为什么 |
 * |---|---|---|
 * | 数量 / 存放位置 / 备注 | **该药上一次入库**（`prefill()`） | 同一种药补货大概率还是同样的数量和位置，净收益 |
 * | 开封后有效期 | **一个常量 30**（`emptyBatchForm()`） | 它量的是药品种类的属性，不是一个盒子的属性 |
 * | 印刷效期 / 拆封日期 | **不预填** | 一盒一个样，见下 |
 *
 * **印刷效期与拆封日期必须留空**：把它们预填成上一盒的值，最坏的情况是
 * 用户直接点确定 —— 于是系统里记着一个**错的到期日**，而这正是这个 App
 * 存在的意义（提醒药过期）。
 *
 * ⚠️ **「开封后有效期」2026-09-23 起破例预填 30**（用户要求）。它不属于上面那类
 * 「一盒一个样」的字段：同一种药补十次都是同一个数，空着等于每次都重打一遍。
 * 那条通用的「一律不预填」原本是针对效期的，把它一并套到天数上是过度类推 ——
 * 完整论证（含「这不是医学建议」的界线）见 `DEFAULT_OPEN_LIFE_DAYS` 与 DESIGN.md §5.7。
 * **别看到「预填」两个字就把效期也填上。**
 *
 * ── 空值和 0 的区别 ───────────────────────────────────────────────────
 * 数量必须 > 0（§3.2）：入库是「多了一盒」，0 片的一盒没有意义，
 * 那属于编辑已有批次的范畴。
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { MedboxDb } from '../../src/db/client';
import { lastBatchFor, listMembers, medicineDetail } from '../../src/data/queries';
import { intake } from '../../src/data/stock';
import { BatchFields, emptyBatchForm, type BatchFormValues } from '../../src/ui/batchform';
import { useDb } from '../../src/ui/DbProvider';
import { Button, ButtonBar, FormError } from '../../src/ui/form';
import { useQuery } from '../../src/ui/useQuery';
import { Empty } from '../../src/ui/components';
import { color, font, screen, space, text } from '../../src/ui/theme';

/**
 * 该药上一次入库填过什么。**效期一类刻意不在这里返回**，见文件头注释。
 */
function prefill(db: MedboxDb, medicineId: number): Partial<BatchFormValues> {
  const last = lastBatchFor(db, medicineId);
  if (!last) return {};
  return {
    qty: String(last.qty),
    location: last.location ?? '',
    notes: last.notes ?? '',
  };
}

export default function NewBatchScreen() {
  const { medicineId } = useLocalSearchParams<{ medicineId: string }>();
  const id = Number(medicineId);
  const router = useRouter();
  const { db, today, reload } = useDb();
  const scroll = useRef<ScrollView>(null);

  const d = useQuery((db, today) => medicineDetail(db, id, today), [id]);
  const members = useQuery((db) => listMembers(db));

  const [values, setValues] = useState<BatchFormValues>(() => ({
    ...emptyBatchForm(),
    ...prefill(db, id),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!d.found) {
    return (
      <View style={screen}>
        <Empty title="药品不存在" hint="它可能已被删除。回上一页重新选一个。" />
      </View>
    );
  }

  const submit = () => {
    const res = intake(db, id, values, today);
    if (!res.ok) {
      setErrors(res.errors);
      // §3.2「聚焦第一个出错的字段」：这个表单的第一个字段就在最上面，
      // 滚回顶部就等于把第一个问题带进视野，比精确 focus 更省事也更可靠
      scroll.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    // 让闸门重新取数，详情页的数量和「在库」列表才会跟着变
    reload();
    router.back();
  };

  const errorCount = Object.keys(errors).length;

  return (
    <>
      <Stack.Screen options={{ title: `入库 · ${d.medicine.generic}` }} />
      <ScrollView
        ref={scroll}
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.h1}>再入库一盒</Text>
        <Text style={[text.muted, styles.lead]}>
          {d.medicine.generic}
          {d.medicine.spec ? ` · ${d.medicine.spec}` : ''}
        </Text>

        {errorCount > 0 ? (
          <FormError message={`有 ${errorCount} 处需要修改，已经在下面标出来了。`} />
        ) : null}

        <BatchFields
          mode="new"
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
          errors={errors}
          members={members}
          inheritedUnit={d.medicine.unit ?? ''}
          inheritedOwner={d.owner?.name ?? ''}
        />
      </ScrollView>

      <ButtonBar>
        <Button label="取消" kind="ghost" onPress={() => router.back()} />
        <Button label="入库" onPress={submit} />
      </ButtonBar>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl },
  h1: { fontSize: font.title, fontWeight: '700', color: color.ink, marginBottom: space.xs },
  lead: { marginBottom: space.lg },
});
