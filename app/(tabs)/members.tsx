/**
 * 成员页 —— **M1 占位**。
 *
 * 按 DESIGN.md §8.1 第 8 条，成员页这一版可以只是占位。
 * 但占位不等于空页：这里把已导入的成员列出来（数据是现成的），
 * 只是还不能改名 / 增删 —— 那是 M2。这样「导入成功了没有」在成员页也能看出来，
 * 不用等 M2 才发现名字导错了。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { listMembers, medicineCountByMember } from '../../src/data/queries';
import { Card, Empty, Pill, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, screen, space, text, tone } from '../../src/ui/theme';

export default function MembersScreen() {
  const { hasData } = useDb();
  const members = useQuery((db) => listMembers(db));
  const counts = useQuery((db) => medicineCountByMember(db));

  if (!hasData) {
    return (
      <View style={screen}>
        <Empty title="还没有成员" hint="导入数据后，成员会一起装好。" />
      </View>
    );
  }

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <SectionTitle>成员（{members.length}）</SectionTitle>
      <Card>
        {members.map((m, i) => (
          <View key={m.id} style={[styles.row, i > 0 && styles.divided]}>
            <Pill tone={tone.ok} label={m.name} />
            <Text style={[text.muted, styles.notes]}>{counts.get(m.id) ?? 0} 种药</Text>
            {m.notes ? <Text style={[text.tiny, styles.note]}>{m.notes}</Text> : null}
          </View>
        ))}
        <View style={[styles.row, styles.divided]}>
          <Pill tone={tone.gray} label="家庭共用" />
          <Text style={[text.muted, styles.notes]}>
            {counts.get(null) ?? 0} 种药未指定归属
          </Text>
        </View>
      </Card>

      <Text style={styles.hint}>
        改名、增删成员会在下一版加进来。现在这些是从导入的数据里读出来的，
        改不了是对的 —— 免得改完之后发现和网页版对不上，却不知道是哪边错了。
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divided: { borderTopWidth: 1, borderTopColor: color.lineSoft },
  notes: { flex: 1 },
  note: { fontSize: font.tiny },
  hint: { fontSize: font.tiny, color: color.muted, marginTop: space.lg, lineHeight: 18 },
});
