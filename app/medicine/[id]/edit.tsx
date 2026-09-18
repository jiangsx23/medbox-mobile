/**
 * 编辑 / 删除药品档案（`requirements.md` §3.1）。
 *
 * ── 改这一页会改到真实库存，所以提示必须写清 ─────────────────────────────
 * 表单里的「自动扣减」和「每日用量」不是纯展示字段：改它们会让系统先按**旧**
 * 参数把欠的账结清、再以今天为新起算日。用户改完看到药少了一截，
 * 第一反应会是 App 算错了 —— 所以那段提示由 `MedicineFormFields` 负责渲染，
 * 判断依据与落库共用同一个函数（见 `src/ui/medicineform.tsx` 的文件头）。
 *
 * ── 删除为什么几乎总是失败，而失败是对的 ───────────────────────────────
 * 只要这个药有过**任何**批次记录就拒绝删除（不变量 8：批次与变动记录只增）。
 * 而且是**终局**的：批次永远不删，所以一旦入过库，删除就永远不会成功 ——
 * 哪怕那盒药早就用完了。这一点必须在界面上说透，否则用户会反复试
 * 「我先把药全丢弃了再来删」。
 *
 * 所以危险区按钮**永远可点**（与成员编辑页同一决定）：点了会看到一句说清
 * 「还差什么」的提示，比一个灰掉的按钮有用得多 —— 灰按钮只会让人猜。
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { batchCountOf, deleteMedicine, medicineById, updateMedicine } from '../../../src/data/medicines';
import { listMembers } from '../../../src/data/queries';
import { formOf } from '../../../src/domain/medicine';
import { useDb } from '../../../src/ui/DbProvider';
import { Empty } from '../../../src/ui/components';
import { Button, ButtonBar, FormError } from '../../../src/ui/form';
import { MedicineFormFields } from '../../../src/ui/medicineform';
import { useQuery } from '../../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../../src/ui/theme';

export default function EditMedicineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const medicineId = Number(id);
  const router = useRouter();
  const { db, today, reload } = useDb();
  const scroll = useRef<ScrollView>(null);

  const m = useQuery((db) => medicineById(db, medicineId), [medicineId]);
  const batches = useQuery((db) => batchCountOf(db, medicineId), [medicineId]);
  const members = useQuery((db) => listMembers(db));

  // 与 `app/batch/[id]/edit.tsx` 同形：初值只取一次，之后由用户编辑。
  // `null` 只在「这一行不存在」时出现，单独处理，免得下面到处 `?.`
  const [values, setValues] = useState(() => (m ? formOf(m) : null));
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!m || !values) {
    return (
      <View style={screen}>
        <Empty title="药品不存在" hint="它可能已被删除。回上一页看看。" />
      </View>
    );
  }

  const submit = () => {
    const res = updateMedicine(db, medicineId, values, today);
    if (!res.ok) {
      setErrors(res.errors);
      scroll.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    reload();
    router.back();
  };

  const remove = () => {
    Alert.alert(
      `删除「${m.generic}」？`,
      batches > 0
        ? `它名下有 ${batches} 条批次记录。\n\n删除会失败 —— 这些记录含已用完、已丢弃、已过期的，而它们只增不删（时间线要靠它们才对得上）。`
        : '名下一条批次记录都没有，可以直接删。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            const res = deleteMedicine(db, medicineId);
            if (!res.ok) {
              setErrors(res.errors);
              return;
            }
            reload();
            // 详情页也在栈里，它现在已经指向一个不存在的药了 —— 连它一起退掉，
            // 只 back() 一下会退回「药品不存在」的页面，看着像删除失败了
            router.dismissAll();
          },
        },
      ],
    );
  };

  const errorCount = Object.keys(errors).length;

  return (
    <>
      <Stack.Screen options={{ title: `编辑 · ${m.generic}` }} />
      <ScrollView
        ref={scroll}
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.h1}>{m.generic}</Text>
        <Text style={[text.muted, styles.lead]}>
          改的是档案，不是某一盒的数量。某盒吃了几片、放哪儿，在那一盒的「编辑」里改。
        </Text>

        <FormError message={errors._} />
        {errorCount > 0 && !errors._ ? (
          <FormError message={`有 ${errorCount} 处需要修改，已经在下面标出来了。`} />
        ) : null}

        <MedicineFormFields
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v!, ...patch }))}
          errors={errors}
          members={members}
          prev={m}
        />

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>删除药品</Text>
          <Text style={[text.muted, styles.dangerBody]}>
            {batches > 0
              ? `「${m.generic}」名下还有 ${batches} 条批次记录，现在删不掉 —— 而且以后也删不掉：批次和变动记录只增不删（不然时间线就对不上了）。想改档案内容，用上面的表单。`
              : '名下一条批次记录都没有，可以安全删除。删掉之后这个药就不在列表里了。'}
          </Text>
          <Pressable style={styles.dangerBtn} onPress={remove}>
            <Ionicons name="trash-outline" size={15} color={tone.danger.text} />
            <Text style={styles.dangerBtnText}>删除这个药品</Text>
          </Pressable>
        </View>
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
  lead: { marginBottom: space.lg, lineHeight: 20 },

  dangerZone: {
    marginTop: space.xl,
    borderWidth: 1,
    borderColor: tone.danger.bd,
    backgroundColor: tone.danger.bg,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  dangerTitle: { fontSize: font.base, fontWeight: '700', color: tone.danger.text },
  dangerBody: { marginTop: space.xs, lineHeight: 20 },
  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.md,
    borderWidth: 1,
    borderColor: tone.danger.bd,
    backgroundColor: color.card,
    borderRadius: radius.md,
    paddingVertical: 11,
  },
  dangerBtnText: { fontSize: font.small, color: tone.danger.text, fontWeight: '600' },
});
