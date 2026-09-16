/**
 * 首页 = 查药。
 *
 * ── 顺序是刻意与网页版不同的（DESIGN.md §5.1）─────────────────────────
 * 网页版是「统计卡 → 按成员 → 需补货 → 在库列表」。手机上照着排的话，
 * 最高频的问题（场景 1「这药还有吗」）的答案会被挤到第二屏去。
 * 所以改成 **搜索框 → 在库列表 → 统计一行 → 需补货 → 按成员**。
 *
 * 统计没有消失，只是从四张大卡压成一行小字 —— 它现在的角色是
 * 「扫一眼有没有异常」，不是「第一眼要看的东西」。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { buildGroups, dashboard, type BatchRow } from '../../src/data/queries';
import { formatDos, formatDose } from '../../src/domain/forecast';
import { Card, Empty, ExpiryPill, Pill, PillRow, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../src/ui/theme';

type Filter = '' | 'near' | 'expired';

const HIDDEN_LABEL: Record<Filter, string> = {
  '': '',
  near: '不在「快过期」范围',
  expired: '未过期',
};

export default function HomeScreen() {
  const { hasData } = useDb();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('');

  const dash = useQuery((db, today) => dashboard(db, today));

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const keep = (r: BatchRow) => {
      if (filter === 'near' && r.expiryStatus !== 'expiring') return false;
      if (filter === 'expired' && r.expiryStatus !== 'expired') return false;
      if (!needle) return true;
      const m = r.medicine;
      // 归属人名也算匹配项 —— 下面「按成员」那一排点一下就是往搜索框里填名字，
      // 若只搜药名，点「外公」会得到空结果，看着像坏了。
      return [m.generic, m.brand, m.spec, m.purposeNotes, r.owner?.name]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(needle));
    };
    return buildGroups(dash.rows, keep, HIDDEN_LABEL[filter]);
  }, [dash.rows, q, filter]);

  if (!hasData) {
    return (
      <View style={screen}>
        <Empty
          title="药箱还是空的"
          hint="先把网页版导出的 all.json 导进来，药品、批次、成员会一次装好。"
        />
        <View style={styles.emptyAction}>
          <Pressable style={styles.primaryBtn} onPress={() => router.push('/import')}>
            <Text style={styles.primaryBtnLabel}>导入数据</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── 搜索（新增，网页版只在药品档案页有） ───────────────────── */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={17} color={color.muted} />
        <TextInput
          style={styles.searchInput}
          value={q}
          onChangeText={setQ}
          placeholder="搜药名、品牌、规格、成员"
          placeholderTextColor={color.muted}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {q.length > 0 && (
          <Pressable onPress={() => setQ('')} hitSlop={8}>
            <Ionicons name="close-circle" size={17} color={color.muted} />
          </Pressable>
        )}
      </View>

      {/* ── 筛选 ─────────────────────────────────────────────────── */}
      <View style={styles.filters}>
        {(['', 'near', 'expired'] as Filter[]).map((f) => (
          <Pressable
            key={f || 'all'}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipOn]}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
              {f === '' ? '全部' : f === 'near' ? '快过期' : '已过期'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── 在库列表（药的答案在这里） ───────────────────────────── */}
      <Card style={styles.listCard}>
        {groups.length === 0 ? (
          <View style={styles.noResult}>
            <Text style={text.muted}>
              {q || filter ? '没有符合条件的药。' : '药箱是空的。'}
            </Text>
          </View>
        ) : (
          groups.map((g, i) => (
            <View key={g.medicine.id} style={[styles.group, i > 0 && styles.groupDivided]}>
              <Pressable
                style={styles.groupHead}
                onPress={() => router.push(`/medicine/${g.medicine.id}`)}
              >
                <View style={styles.groupTitleRow}>
                  <Text style={styles.generic}>{g.medicine.generic}</Text>
                  {g.medicine.brand ? (
                    <Text style={text.muted}>（{g.medicine.brand}）</Text>
                  ) : null}
                  {g.medicine.dailyDose ? (
                    <Text style={text.muted}>每日 {formatDose(g.medicine.dailyDose)}</Text>
                  ) : null}
                </View>
                <View style={styles.groupMetaRow}>
                  {g.needsRestock && g.daysOfSupply !== null ? (
                    <Pill
                      tone={tone.restock}
                      label={`库存不足 · 约剩 ${formatDos(g.daysOfSupply)} 天`}
                    />
                  ) : g.daysOfSupply !== null ? (
                    <Pill tone={tone.ok} label={`约${formatDos(g.daysOfSupply)}天`} />
                  ) : null}
                  {g.totalText ? <Text style={text.muted}>{g.totalText}</Text> : null}
                </View>
              </Pressable>

              {g.sublines.map((s) => (
                <View key={s.batch.id} style={styles.batchLine}>
                  <Text style={styles.batchQty}>
                    {formatDose(s.batch.qty)} {s.batch.unit}
                  </Text>
                  <ExpiryPill status={s.expiryStatus} />
                  <Text style={text.muted}>
                    提醒日 {s.effective ?? '未填'}
                    {s.batch.openedAt ? ' · 开封' : ''}
                  </Text>
                  <Text style={styles.memberChip}>
                    {s.owner ? s.owner.name : '家庭共用'}
                  </Text>
                  {s.batch.location ? (
                    <Text style={styles.locChip}>{s.batch.location}</Text>
                  ) : null}
                </View>
              ))}

              {g.hidden > 0 ? (
                <Text style={styles.hidden}>
                  另有 {g.hidden} 盒{g.hiddenLabel}，未在上方列出。
                </Text>
              ) : null}
            </View>
          ))
        )}
      </Card>

      {/* ── 统计：压成一行小数字 ─────────────────────────────────── */}
      <View style={styles.statsRow}>
        <Stat label="在库批次" num={dash.inStockCount} onPress={() => setFilter('')} />
        <Stat
          label={`快过期（${dash.thresholds.nearDays}天内）`}
          num={dash.nearExpiryCount}
          t={tone.warn}
          onPress={() => setFilter('near')}
        />
        <Stat
          label="已过期"
          num={dash.expiredCount}
          t={tone.danger}
          onPress={() => setFilter('expired')}
        />
        <Stat
          label={`库存不足（≤${dash.thresholds.restockDays}天）`}
          num={dash.needRestock.length}
          t={tone.restock}
          suffix="种"
        />
      </View>

      {/* ── 需补货 ───────────────────────────────────────────────── */}
      {dash.needRestock.length > 0 && (
        <>
          <SectionTitle>需补货</SectionTitle>
          <Card>
            {dash.needRestock.map((r) => (
              <Pressable
                key={r.medicine.id}
                style={styles.restockLine}
                onPress={() => router.push(`/medicine/${r.medicine.id}`)}
              >
                <View style={styles.restockMain}>
                  <Text style={styles.generic}>{r.medicine.generic}</Text>
                  <Text style={text.muted}>
                    {formatDose(r.medicine.dailyDose!)} /天
                  </Text>
                </View>
                {r.daysOfSupply === 0 ? (
                  <Pill tone={tone.danger} label="已用完 / 无库存" />
                ) : (
                  <Pill tone={tone.restock} label={`约剩 ${formatDos(r.daysOfSupply)} 天`} />
                )}
              </Pressable>
            ))}
          </Card>
        </>
      )}

      {/* ── 按成员 ───────────────────────────────────────────────── */}
      {dash.perMember.length > 0 && (
        <>
          <SectionTitle>按成员</SectionTitle>
          <Card>
            <PillRow>
              {dash.perMember.map((m) => (
                <Pressable
                  key={m.name}
                  style={styles.memberPill}
                  onPress={() => {
                    // M2 起跳成员页；现在先在首页搜这个名字，效果等价且不用等新页面
                    setQ(m.name);
                  }}
                >
                  <Text style={styles.memberPillText}>
                    {m.name}
                    <Text style={styles.memberPillCount}> {m.count} 种</Text>
                  </Text>
                </Pressable>
              ))}
            </PillRow>
            <Text style={[text.tiny, styles.memberHint]}>
              点一下按成员筛选；「家庭共用」是没指定归属的药。
            </Text>
          </Card>
        </>
      )}
    </ScrollView>
  );
}

/**
 * 统计格。4 个挤一行，所以标签会换行 —— 这是刻意的：
 * 标签完整可读比格子整齐重要（「快过期（90天内）」砍成「快过期」就丢掉了阈值）。
 */
function Stat({
  label,
  num,
  t,
  suffix,
  onPress,
}: {
  label: string;
  num: number;
  t?: { text: string; bg: string; bd: string };
  suffix?: string;
  onPress?: () => void;
}) {
  const c = t ?? { text: color.ink, bg: color.bgTop, bd: color.line };
  return (
    <Pressable style={[styles.stat, { backgroundColor: c.bg, borderColor: c.bd }]} onPress={onPress}>
      <Text style={[styles.statNum, { color: c.text }]}>
        {num}
        {suffix ? <Text style={styles.statSuffix}>{suffix}</Text> : null}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: font.base, color: color.ink, padding: 0 },
  filters: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
  },
  chipOn: { backgroundColor: color.brand, borderColor: color.brand },
  chipText: { fontSize: font.small, color: color.ink, fontWeight: '600' },
  chipTextOn: { color: color.white },

  listCard: { marginTop: space.md, padding: 0, overflow: 'hidden' },
  noResult: { padding: space.xl, alignItems: 'center' },
  group: { paddingHorizontal: space.lg, paddingVertical: space.md },
  groupDivided: { borderTopWidth: 1, borderTopColor: color.lineSoft },
  groupHead: { gap: 2 },
  groupTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  generic: { fontSize: font.base, fontWeight: '700', color: color.ink },
  groupMetaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: 2 },

  batchLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
    paddingLeft: space.md,
    marginTop: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: color.brandSoft2,
  },
  batchQty: { fontSize: font.base, color: color.ink, fontWeight: '600' },
  memberChip: { fontSize: font.tiny, color: color.muted },
  locChip: {
    fontSize: font.tiny,
    color: color.brand,
    backgroundColor: color.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  hidden: { fontSize: font.tiny, color: color.muted, marginTop: space.sm, paddingLeft: space.md },

  statsRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  stat: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  statNum: { fontSize: font.title, fontWeight: '700' },
  statSuffix: { fontSize: font.tiny, fontWeight: '600' },
  statLabel: { fontSize: 10, color: color.muted, textAlign: 'center', marginTop: 1, lineHeight: 13 },

  restockLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  restockMain: { flex: 1, gap: 1 },

  memberPill: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.cardWarm,
    borderRadius: 999,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  memberPillText: { fontSize: font.small, color: color.ink, fontWeight: '600' },
  memberPillCount: { color: color.brand, fontWeight: '700' },
  memberHint: { marginTop: space.sm },

  emptyAction: { paddingHorizontal: space.xl },
  primaryBtn: {
    backgroundColor: color.brand,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryBtnLabel: { color: color.white, fontSize: font.base, fontWeight: '700' },
});
