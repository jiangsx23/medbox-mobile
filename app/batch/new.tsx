/**
 * 入库 —— 新增一盒（`requirements.md` §3.2）。
 *
 * ── 预填规则是这一页最不显然的地方 ─────────────────────────────────────
 * **沿用该药上一次入库填过的「数量 / 存放位置 / 备注」，但效期、拆封日期、
 * 开封后天数一律不预填。**
 *
 * 道理是：一盒药的效期每次都不一样。把它预填成上一盒的效期最坏的情况是
 * 用户直接点确定 —— 于是系统里记着一个**错的到期日**，而这正是这个 App
 * 存在的意义（提醒药过期）。数量/位置/备注则高度重复（同一种药补货时
 * 大概率还是同样的数量和位置），预填是净收益。
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
