/**
 * 新建药品档案（`requirements.md` §3.1）。
 *
 * ── 建档不等于入库 ─────────────────────────────────────────────────────
 * 这一页只登记「家里有这个药」——它有几盒、放哪儿、哪盒快过期，都是入库的事。
 * 所以存完回列表**是对的**：新药下面写着「无库存」，用户看到这个字样就明白
 * 还差一步；反倒是直接跳进一个一盒都没有的详情页，会让人以为建档没成功。
 *
 * ── 为什么绝不检查重名 ─────────────────────────────────────────────────
 * 「二甲双胍」与「二甲双胍缓释片」、同名的不同规格、同名的不同厂家，
 * 都是**正常数据**。成员那边有重名检查是因为 `members.name` 上有唯一索引
 * （同一份药箱里有两个「外公」确实是错的），而 `medicines` 上只有两个
 * **非唯一**索引 —— 加检查会挡掉合法输入。
 */
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { createMedicine } from '../../src/data/medicines';
import { listMembers } from '../../src/data/queries';
import { useDb } from '../../src/ui/DbProvider';
import { Button, ButtonBar, FormError } from '../../src/ui/form';
import { MedicineFormFields, emptyMedicineForm } from '../../src/ui/medicineform';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, screen, space, text } from '../../src/ui/theme';

export default function NewMedicineScreen() {
  const router = useRouter();
  const { db, today, reload } = useDb();
  const scroll = useRef<ScrollView>(null);

  const members = useQuery((db) => listMembers(db));

  const [values, setValues] = useState(emptyMedicineForm);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const res = createMedicine(db, values, today);
    if (!res.ok) {
      setErrors(res.errors);
      // §3.2「聚焦第一个出错的字段」：通用名就在最上面，滚回顶部就够了
      scroll.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    reload();
    router.back();
  };

  const errorCount = Object.keys(errors).length;

  return (
    <>
      <Stack.Screen options={{ title: '新建药品' }} />
      <ScrollView
        ref={scroll}
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.h1}>登记一种药</Text>
        <Text style={[text.muted, styles.lead]}>
          现在只填档案。有几盒、放哪儿、什么时候过期，等入库的时候再记。
        </Text>

        {errorCount > 0 ? (
          <FormError message={`有 ${errorCount} 处需要修改，已经在下面标出来了。`} />
        ) : null}

        <MedicineFormFields
          values={values}
          onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
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
  lead: { marginBottom: space.lg, lineHeight: 20 },
});
