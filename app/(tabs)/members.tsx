/**
 * 成员页 —— 谁在这个药箱里，各自名下有多少药（`requirements.md` §3.7）。
 *
 * ── 「家庭共用」为什么和别的成员长得不一样 ─────────────────────────────
 * 它**不是一条成员记录**，而是「归属为空」这个状态（见 `src/data/members.ts`）。
 * 所以它排在最后、不能改名、不能删除 —— 删掉它等于要求所有药都必须有主人，
 * 那是个产品决定，不该由「能不能点删除」来偷偷做掉。
 *
 * ── 这里数的是「种」不是「盒」────────────────────────────────────────
 * 与首页「按成员」的口径不同，这是刻意的：首页数「有在库的药」，
 * 这里数「档案里的全部药」。否则「给孩子建过档但已经吃完了」的药
 * 会从孩子名下凭空消失，看起来像数据丢了。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { listMembers, medicineCountByMember } from '../../src/data/queries';
import { Card, Empty, Pill, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../src/ui/theme';

/** 路由里用 `shared` 代表「归属为空」——`ownerId` 是 `null`，塞不进 path。 */
const SHARED = 'shared';

function MemberRow({
  name,
  count,
  notes,
  onPress,
}: {
  name: string;
  count: number;
  notes?: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Pill tone={tone.ok} label={name} />
      <Text style={[text.muted, styles.count]}>{count} 种药</Text>
      {notes ? (
        <Text style={[text.tiny, styles.note]} numberOfLines={1}>
          {notes}
        </Text>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={color.muted} />
    </Pressable>
  );
}

export default function MembersScreen() {
  const { hasData } = useDb();
  const router = useRouter();
  const members = useQuery((db) => listMembers(db));
  const counts = useQuery((db) => medicineCountByMember(db));

  if (!hasData) {
    return (
      <View style={screen}>
        <Empty title="还没有成员" hint="导入数据后，成员会一起装好；也可以回上一页手动导入。" />
      </View>
    );
  }

  const sharedCount = counts.get(null) ?? 0;

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <SectionTitle>成员（{members.length}）</SectionTitle>
      <Card style={styles.noPad}>
        {members.map((m, i) => (
          <View key={m.id} style={i > 0 ? styles.divided : undefined}>
            <MemberRow
              name={m.name}
              count={counts.get(m.id) ?? 0}
              notes={m.notes}
              onPress={() => router.push({ pathname: '/member/[id]', params: { id: m.id } })}
            />
          </View>
        ))}
        <View style={members.length > 0 ? styles.divided : undefined}>
          <MemberRow
            name="家庭共用"
            count={sharedCount}
            notes="归属为空的药都算在这里"
            onPress={() => router.push({ pathname: '/member/[id]', params: { id: SHARED } })}
          />
        </View>
      </Card>

      <Pressable style={styles.addBtn} onPress={() => router.push('/member/new')}>
        <Ionicons name="add" size={16} color={color.brand} />
        <Text style={styles.addText}>添加成员</Text>
      </Pressable>

      <Text style={styles.hint}>
        点进去可以看这个人名下有哪些药。加成员只是为了给药品标「谁在吃」——
        它不涉及账号，也不会同步到任何地方。
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  noPad: { paddingVertical: 0, paddingHorizontal: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  divided: { borderTopWidth: 1, borderTopColor: color.lineSoft },
  count: { flex: 1 },
  note: { maxWidth: '40%' },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.brandSoft2,
    borderRadius: radius.lg,
    paddingVertical: 12,
    marginTop: space.md,
  },
  addText: { fontSize: font.small, color: color.brand, fontWeight: '600' },
  hint: { fontSize: font.tiny, color: color.muted, marginTop: space.lg, lineHeight: 18 },
});
