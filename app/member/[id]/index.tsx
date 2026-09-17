/**
 * 成员详情 —— 这个人名下的药，按药分组、药下逐盒（`requirements.md` §3.7）。
 *
 * ── 「仅在库 / 在库+历史」这个开关为什么必须存在 ────────────────────────
 * 默认只看在库：这一页的用途是「他现在在吃什么」，混进一堆早就吃完的药
 * 会把这个用途冲掉。但「上个月那个药是不是吃完了」也需要能查 ——
 * 所以给一个开关，而不是两页。
 *
 * ── 这一页只读 ────────────────────────────────────────────────────────
 * 所有会改数据的操作都在**药品详情页**（每盒下面那排按钮）。
 * 药箱里同一个药可能同时归两个人吃，在这里放操作按钮，
 * 点的时候说不清「扣的是谁的那盒」。
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { memberDetail, type MemberSubline } from '../../../src/data/queries';
import { BATCH_STATUS_LABELS } from '../../../src/domain/constants';
import { formatDose } from '../../../src/domain/forecast';
import { Card, Empty, ExpiryPill, Pill, SectionTitle } from '../../../src/ui/components';
import { useQuery } from '../../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../../src/ui/theme';

/** 路由里用 `shared` 代表「归属为空」——`ownerId` 是 `null`，塞不进 path。 */
const SHARED = 'shared';

function Subline({ s }: { s: MemberSubline }) {
  const b = s.batch;
  return (
    <View style={styles.subline}>
      <View style={styles.line}>
        <Text style={styles.qty}>
          {formatDose(b.qty)} <Text style={styles.qtyUnit}>{b.unit}</Text>
        </Text>
        {s.inStock ? (
          <ExpiryPill status={s.expiryStatus} />
        ) : (
          <Pill tone={tone.gray} label={BATCH_STATUS_LABELS[b.status] ?? b.status} />
        )}
      </View>
      <View style={[styles.line, styles.mt]}>
        <Text style={text.tiny}>
          {s.inStock
            ? s.effective
              ? `提醒日 ${s.effective}${b.openedAt ? '（拆封后）' : ''}`
              : '未填效期'
            : `印刷效期 ${b.expiryDate ?? '未填'}`}
        </Text>
        {b.location ? <Text style={styles.locChip}>{b.location}</Text> : null}
      </View>
    </View>
  );
}

export default function MemberDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isShared = id === SHARED;
  const ownerId = isShared ? null : Number(id);
  const router = useRouter();
  const [scope, setScope] = useState<'in_stock' | 'all'>('in_stock');

  const d = useQuery((db, today) => memberDetail(db, ownerId, scope, today), [ownerId, scope]);

  const name = isShared ? '家庭共用' : d.member?.name;

  // 成员被删掉（或在另一台设备上删掉）后，这个页面还挂在栈里
  if (!isShared && !d.member) {
    return (
      <View style={screen}>
        <Empty title="成员不存在" hint="它可能已被删除。回上一页重新选一个。" />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: name ?? '成员',
          // 「家庭共用」不是一个可编辑的记录，不给编辑入口
          headerRight: isShared
            ? undefined
            : () => (
                <Pressable hitSlop={8} onPress={() => router.push({ pathname: '/member/[id]/edit', params: { id: id! } })}>
                  <Text style={styles.headerBtn}>编辑</Text>
                </Pressable>
              ),
        }}
      />
      <ScrollView style={screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>{name}</Text>
        {!isShared && d.member?.notes ? (
          <Text style={[text.muted, styles.lead]}>{d.member.notes}</Text>
        ) : null}
        {isShared ? (
          <Text style={[text.muted, styles.lead]}>
            没有指定归属的药都算在这里。想给某个药指定主人，去那个药的档案里改归属。
          </Text>
        ) : null}

        {/* ── 仅在库 / 在库+历史 ───────────────────────────────── */}
        <View style={styles.seg}>
          {(
            [
              ['in_stock', '仅在库'],
              ['all', '在库 + 历史'],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              style={[styles.segBtn, scope === key && styles.segOn]}
              onPress={() => setScope(key)}
            >
              <Text style={[styles.segText, scope === key && styles.segTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {d.groups.length === 0 ? (
          <Card>
            <Text style={text.muted}>
              {scope === 'in_stock' ? '目前没有在库的药。' : '名下还没有任何药。'}
            </Text>
            {!isShared ? (
              <Text style={[text.muted, styles.mt]}>
                药的归属在「药品档案 → 编辑」里改，或者入库时选。
              </Text>
            ) : null}
          </Card>
        ) : (
          <>
            <SectionTitle>
              {isShared ? '共用的药' : '名下的药'}（{d.groups.length}）
            </SectionTitle>
            {d.groups.map((g) => (
              <Card key={g.medicine.id} style={styles.card}>
                <Pressable
                  style={styles.line}
                  onPress={() =>
                    router.push({ pathname: '/medicine/[id]', params: { id: g.medicine.id } })
                  }
                >
                  <Text style={styles.medName}>{g.medicine.generic}</Text>
                  {g.medicine.spec ? (
                    <Text style={text.tiny}>{g.medicine.spec}</Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={14} color={color.muted} />
                </Pressable>
                <Text style={[text.muted, styles.total]}>{g.totalText}</Text>
                {g.sublines.map((s) => (
                  <Subline key={s.batch.id} s={s} />
                ))}
              </Card>
            ))}
          </>
        )}

        <Text style={styles.footHint}>
          <Ionicons name="information-circle-outline" size={12} color={color.muted} /> 这里的数量
          是自动扣减算过的。要记「取用」，去药品详情页点那一盒下面的按钮。
        </Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  h1: { fontSize: font.hero, fontWeight: '700', color: color.ink },
  lead: { marginTop: space.xs },
  headerBtn: { fontSize: font.base, color: color.brand, fontWeight: '600' },

  seg: {
    flexDirection: 'row',
    gap: space.xs,
    backgroundColor: color.brandSoft,
    borderRadius: radius.md,
    padding: 3,
    marginTop: space.lg,
  },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.sm },
  segOn: { backgroundColor: color.card },
  segText: { fontSize: font.small, color: color.muted },
  segTextOn: { color: color.brandStrong, fontWeight: '700' },

  card: { marginBottom: space.md },
  medName: { fontSize: font.base, fontWeight: '700', color: color.ink },
  total: { marginTop: space.xs },

  subline: {
    borderTopWidth: 1,
    borderTopColor: color.lineSoft,
    paddingTop: space.sm,
    marginTop: space.sm,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  mt: { marginTop: space.xs },
  qty: { fontSize: font.small, fontWeight: '600', color: color.ink },
  qtyUnit: { fontWeight: '400', color: color.muted },
  locChip: {
    fontSize: font.tiny,
    color: color.brand,
    backgroundColor: color.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  footHint: { fontSize: font.tiny, color: color.muted, textAlign: 'center', marginTop: space.xl },
});
