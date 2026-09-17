/**
 * 编辑 / 删除成员。
 *
 * ── 删除为什么可能被拒绝，而且拒绝是对的 ───────────────────────────────
 * 名下还有药时不给删（不变量 7），且**不**顺手把那些药改成「家庭共用」。
 * 归属是**用药安全信息** —— 谁在吃这个药。静默改掉等于让那些药从成员页
 * 消失，而用户不会收到任何提示，直到某天想问「外公还在吃这个吗」才发现
 * 找不到人了。想删就先逐一把药改到别人名下，那是个需要人做决定的过程。
 *
 * 所以这里的删除按钮**永远可点** —— 点了会看到一句说清「还差什么」的
 * 提示，比一个灰掉的按钮有用得多（灰按钮只会让人猜为什么不能点）。
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { deleteMember, memberById, ownedMedicineCount, updateMember } from '../../../src/data/members';
import { Button, ButtonBar, FormError, TextField } from '../../../src/ui/form';
import { useDb } from '../../../src/ui/DbProvider';
import { useQuery } from '../../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../../src/ui/theme';

export default function EditMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const memberId = Number(id);
  const router = useRouter();
  const { db, reload } = useDb();

  const m = useQuery((db) => memberById(db, memberId), [memberId]);
  const owned = useQuery((db) => ownedMedicineCount(db, memberId), [memberId]);

  const [name, setName] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  if (!m) {
    return (
      <View style={screen}>
        <Text style={[text.muted, styles.missing]}>这个成员不存在，可能已经被删掉了。</Text>
      </View>
    );
  }

  const nameValue = name ?? m.name;
  const notesValue = notes ?? m.notes ?? '';

  const save = () => {
    const res = updateMember(db, memberId, nameValue, notesValue);
    if (!res.ok) {
      setError(res.errors.name ?? res.errors._);
      return;
    }
    reload();
    router.back();
  };

  const remove = () => {
    Alert.alert(
      `删除「${m.name}」？`,
      owned > 0
        ? `他名下还有 ${owned} 种药。\n\n删除会失败 —— 请先到那些药的档案里把归属改成别人或「家庭共用」。`
        : '名下没有药，可以直接删。这个操作不影响任何药品记录。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            const res = deleteMember(db, memberId);
            if (!res.ok) {
              setError(res.errors._);
              return;
            }
            reload();
            // 详情页也在栈里，它现在已经指向一个不存在的成员了 —— 连它一起退掉，
            // 只 back() 一下会退回「成员不存在」的页面，看着像删除失败了
            router.dismissAll();
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: `编辑 · ${m.name}` }} />
      <ScrollView
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <FormError message={error} />
        <TextField
          label="姓名"
          value={nameValue}
          onChangeText={(v) => {
            setName(v);
            setError(undefined);
          }}
        />
        <TextField
          label="备注（可不填）"
          value={notesValue}
          onChangeText={setNotes}
          placeholder="外公的三高药、孩子的退烧药…"
          multiline
        />

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>删除成员</Text>
          <Text style={[text.muted, styles.dangerBody]}>
            {owned > 0
              ? `「${m.name}」名下还有 ${owned} 种药，现在删不掉。请先到那些药的档案里把归属改掉。`
              : '名下没有药，可以安全删除。'}
          </Text>
          <Pressable style={styles.dangerBtn} onPress={remove}>
            <Ionicons name="trash-outline" size={15} color={tone.danger.text} />
            <Text style={styles.dangerBtnText}>删除这个成员</Text>
          </Pressable>
        </View>
      </ScrollView>

      <ButtonBar>
        <Button label="取消" kind="ghost" onPress={() => router.back()} />
        <Button label="保存" onPress={save} />
      </ButtonBar>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl },
  missing: { padding: space.xl, textAlign: 'center' },

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
