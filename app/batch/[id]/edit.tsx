/**
 * 编辑纠错 —— 改一盒的任何字段（`requirements.md` §3.3 表格最后一行）。
 *
 * ── 为什么编辑比别的操作「多问」单位和归属 ─────────────────────────────
 * 入库时这两项是从药品档案继承的、**只读**的。但「这一盒其实是盒不是片」
 * 「这盒其实是给孩子买的，档案里的归属填错了」这类纠错，需要能改到它们 ——
 * 所以编辑是唯一能改单位和归属的地方。
 *
 * ── 改数量会写进自动扣减的账本 ─────────────────────────────────────────
 * 编辑数量**不只是改个数字**：它意味着「之前记的消耗量对不上」，
 * 所以会先按旧数量把欠的账结清、再以今天为新起算日（§3.6）。
 * 界面上要说清这件事，否则用户会以为改完就没事了。
 *
 * 任何改动都会留下一条「编辑」事件，写清哪个字段从什么变成了什么 ——
 * 历史不能改，只能追加（不变量 8）。
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { listMembers, medicineDetail } from '../../../src/data/queries';
import { batchById, edit } from '../../../src/data/stock';
import { BatchFields, type BatchFormValues } from '../../../src/ui/batchform';
import { useDb } from '../../../src/ui/DbProvider';
import { Button, ButtonBar, FormError } from '../../../src/ui/form';
import { useQuery } from '../../../src/ui/useQuery';
import { Card, Empty } from '../../../src/ui/components';
import { color, font, screen, space, text } from '../../../src/ui/theme';

export default function EditBatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const batchId = Number(id);
  const router = useRouter();
  const { db, today, reload } = useDb();
  const scroll = useRef<ScrollView>(null);

  const b = useQuery((db) => batchById(db, batchId), [batchId]);
  const members = useQuery((db) => listMembers(db));
  const d = useQuery((db, today) => medicineDetail(db, b?.medicineId ?? -1, today), [b?.medicineId]);

  const [values, setValues] = useState<BatchFormValues | null>(() =>
    b
      ? {
          qty: String(b.qty),
          expiryDate: b.expiryDate ?? '',
          openedAt: b.openedAt ?? '',
          openLifeDays: b.openLifeDays === null ? '' : String(b.openLifeDays),
          location: b.location ?? '',
          notes: b.notes ?? '',
          unit: b.unit,
          ownerId: b.ownerId === null ? '' : String(b.ownerId),
        }
      : null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!b || !values) {
    return (
      <View style={screen}>
        <Empty title="这一盒不存在" hint="它可能已被删除。回上一页看看。" />
      </View>
    );
  }

  const submit = () => {
    const res = edit(db, batchId, values, today);
    if (!res.ok) {
      setErrors(res.errors);
      scroll.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    reload();
    router.back();
  };

  const qtyChanged = String(b.qty) !== values.qty.trim();
  const errorCount = Object.keys(errors).length;

  return (
    <>
      <Stack.Screen options={{ title: '编辑这一盒' }} />
      <ScrollView
        ref={scroll}
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.h1}>{d.medicine?.generic ?? '这一盒'}</Text>
        <Text style={[text.muted, styles.lead]}>
          当前 {b.qty} {b.unit} · 建档 {new Date(b.createdAt).toLocaleDateString('zh-CN')}
        </Text>

        {errorCount > 0 ? (
          <FormError message={`有 ${errorCount} 处需要修改，已经在下面标出来了。`} />
        ) : null}

        {qtyChanged ? (
          <Card style={styles.notice}>
            <Text style={text.body}>
              数量从 {b.qty} 改成 {values.qty.trim() || '…'}
            </Text>
            <Text style={[text.muted, styles.noticeHint]}>
              改数量不只是改个数字：系统会先按旧数量把该扣的账结清，再以今天重新起算。
              这条改动会留下一条「编辑」记录，原来的记录不会被动。
            </Text>
          </Card>
        ) : null}

        <BatchFields
          mode="edit"
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v!, ...patch }))}
          errors={errors}
          members={members}
        />
      </ScrollView>

      <ButtonBar>
        <Button label="取消" kind="ghost" onPress={() => router.back()} />
        <Button label="保存" onPress={submit} />
      </ButtonBar>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl },
  h1: { fontSize: font.title, fontWeight: '700', color: color.ink, marginBottom: space.xs },
  lead: { marginBottom: space.lg },
  notice: { marginBottom: space.lg, backgroundColor: color.cardWarm },
  noticeHint: { marginTop: space.sm, lineHeight: 20 },
});
