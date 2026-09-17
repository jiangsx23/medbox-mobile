/**
 * 添加成员（`requirements.md` §3.7）。
 *
 * ── 这里刻意只有两个字段 ───────────────────────────────────────────────
 * 姓名 + 备注。没有年龄、没有头像、没有「关系」——
 * 成员存在的唯一目的是回答「这个药是谁在吃」，多问一个问题就多一分
 * 让用户在中途放弃的理由。姓名唯一是唯一的硬规则（数据库上有唯一索引）。
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { createMember } from '../../src/data/members';
import { useDb } from '../../src/ui/DbProvider';
import { Button, ButtonBar, FormError, TextField } from '../../src/ui/form';
import { screen, space } from '../../src/ui/theme';

export default function NewMemberScreen() {
  const router = useRouter();
  const { db, reload } = useDb();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const res = createMember(db, name, notes);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    reload();
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: '添加成员' }} />
      <ScrollView
        style={screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <FormError message={errors._} />
        <TextField
          label="姓名"
          value={name}
          onChangeText={setName}
          placeholder="外公 / 妈妈 / 孩子"
          error={errors.name}
        />
        <TextField
          label="备注（可不填）"
          value={notes}
          onChangeText={setNotes}
          placeholder="外公的三高药、孩子的退烧药…"
          multiline
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
});
