/**
 * 药品列表 —— 药箱 tab 上任何一张统计卡 / 一个过滤项都落到这一页。
 *
 * ── 为什么自己一页（DESIGN.md §5.1 的「刻意偏离之偏离」）────────────────
 * 2026-09-23 用户要求药箱页**默认显示统计**，点某一张统计再进来看列表。
 * 于是原来首页那一段（搜索框 → 筛选 → 在库分组列表 → 需补货）**整段搬到这里**，
 * 一个字都没丢：首页只剩下四张统计卡与「按成员」。
 * 代价写在 §5.1：场景 1「这药还有吗」的答案从零点击变成一次点击。
 *
 * ── 顺带解决掉的：一进 App 不再先看到输入框 ────────────────────────────
 * 用户原先报的「点图标进来就弹文字输入框」，其实是**搜索框在首屏最顶上**
 * 造成的观感（全项目没有 `autoFocus`、没有 `.focus()`，`dumpsys input_method`
 * 也读到 `mInputShown=false`）。输入框跟着列表走之后，落屏第一眼是统计卡，
 * 这件事自然就没了 —— 不是靠加代码压键盘，是靠不再把它放在第一眼。
 *
 * ── filter 放在 URL 里，不另存一份 state ───────────────────────────────
 * chip 点击走 `router.setParams`（改当前路由的参数，不压栈），于是
 * 「从哪张卡点进来」与「点了哪个 chip」是**同一条路径** ——
 * 没有两份状态要同步、不需要 useEffect 去跟 props 对齐。
 * 参数不认识时退化成 `all`：手改 URL 或以后改了取值，都不会白屏。
 *
 * ⚠️ 这里**没有** `!hasData` 分支（首页有）：`hasData` 为假时首页只显示
 * 「导入数据」，没有任何入口能推到这一页，写了就是没有调用方的代码。
 * 真从深链接进来，空态显示的也是「药箱是空的。」，不算错。
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { buildGroups, dashboard, type BatchRow } from '../src/data/queries';
import type { Medicine } from '../src/db/schema';
import { formatDos, formatDose } from '../src/domain/forecast';
import { Card, ExpiryPill, Pill } from '../src/ui/components';
import { useQuery } from '../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../src/ui/theme';

/**
 * 取值即「URL 里那个字符串」，所以顺序就是这个数组的顺序（chip 从左到右）。
 *
 * 「需补货」这个 chip 是 2026-09-23 新加的，理由很具体：统计页有四张卡，
 * 前三张分别落到 全部/快过期/已过期，第四张（库存不足）若没有对应的 chip，
 * 点进来会是一个**所有 chip 都没选中**的页面 —— 那看着像坏了。
 */
const FILTERS = ['all', 'near', 'expired', 'restock', 'auto'] as const;
type Filter = (typeof FILTERS)[number];

const isFilter = (v: unknown): v is Filter => FILTERS.includes(v as Filter);

const CHIP_LABEL: Record<Filter, string> = {
  all: '全部',
  near: '快过期',
  expired: '已过期',
  restock: '需补货',
  auto: '自动扣减',
};

const TITLE: Record<Filter, string> = {
  all: '在库药品',
  near: '快过期',
  expired: '已过期',
  restock: '需补货',
  auto: '自动扣减',
};

/** 被筛掉的盒怎么向用户交代 —— 不能说「没有了」，药还在，只是不在这个筛选里。 */
const HIDDEN_LABEL: Record<Filter, string> = {
  all: '',
  near: '不在「快过期」范围',
  expired: '未过期',
  restock: '',
  auto: '没开自动扣减',
};

/**
 * 搜索命中：药名 / 品牌 / 规格 / 备注 / **归属人名**。
 *
 * 带上归属人不是顺手加的 —— 「按成员」那一排点一下就是往搜索框里填名字，
 * 若只搜药名，点「外公」会得到空结果，看着像坏了。
 */
function matches(m: Medicine, needle: string, ownerName?: string | null): boolean {
  if (!needle) return true;
  return [m.generic, m.brand, m.spec, m.purposeNotes, ownerName]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(needle));
}

/** 某个 chip 下「这一盒该不该显示」。 */
function keepFor(filter: Filter, needle: string) {
  return (r: BatchRow) => {
    const okStatus =
      filter === 'near'
        ? r.expiryStatus === 'expiring'
        : filter === 'expired'
          ? r.expiryStatus === 'expired'
          : filter === 'auto'
            ? r.medicine.autoDeduct === true
            : true; // all（restock 不走分组这条路）
    return okStatus && matches(r.medicine, needle, r.owner?.name);
  };
}

export default function StockScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string }>();
  const filter: Filter = isFilter(params.filter) ? params.filter : 'all';
  const [q, setQ] = useState('');

  const dash = useQuery((db, today) => dashboard(db, today));

  const needle = q.trim().toLowerCase();

  const groups = useMemo(
    () => buildGroups(dash.rows, keepFor(filter, needle), HIDDEN_LABEL[filter]),
    [dash.rows, filter, needle],
  );

  const restockRows = useMemo(
    () => dash.needRestock.filter((r) => matches(r.medicine, needle)),
    [dash.needRestock, needle],
  );

  /**
   * chip 上的数 —— **在当前搜索范围内**统计（与药品档案页的 chip 同一个口径）。
   *
   * 为什么不是全库的数：搜「0.1g」时旁边挂着「全部 44」而列表只有 1 行，
   * 那个数就是在说谎 —— 这是 2026-09-23 真机上发现的，第一版写的就是全库数。
   * 而搜索为空时两种算法**结果完全相同**（`dashboard()` 里
   * `inStockCount === rows.length`，快过期/已过期也都是从 `rows` 数的），
   * 所以「从统计卡点进来、数字对得上」这条一并保住 —— 刚进来时搜索框是空的。
   *
   * ⚠️ 前三与第四仍然**不对称**：**前三数「盒」、需补货数「种」** ——
   * 那是从网页版 `dashboard_stats()` 一路继承下来的，别抹平。
   * 「自动扣减」没有对应的卡，数**盒**（与它同行的三个批次类 chip 一致）。
   *
   * 🔴 判据只有 `autoDeduct`、**不含** `autoPaused`（暂停服药不等于关了自动扣减），
   * 且必须与药品档案页那个「自动扣减」徽章**同一个判据**，
   * 否则同一个词在两处含义不同。
   */
  const counts: Record<Filter, number> = useMemo(() => {
    const hit = (r: BatchRow) => matches(r.medicine, needle, r.owner?.name);
    const searched = dash.rows.filter(hit);
    return {
      all: searched.length,
      near: searched.filter((r) => r.expiryStatus === 'expiring').length,
      expired: searched.filter((r) => r.expiryStatus === 'expired').length,
      restock: dash.needRestock.filter((r) => matches(r.medicine, needle)).length,
      auto: searched.filter((r) => r.medicine.autoDeduct).length,
    };
  }, [dash.rows, dash.needRestock, needle]);

  return (
    <View style={screen}>
      <Stack.Screen options={{ title: TITLE[filter] }} />

      <View style={styles.head}>
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

        {/* 5 个 chip 在窄屏上可能放不下 —— 允许换行，宁可两行也别把最后一个挤没 */}
        <View style={styles.filters}>
          {FILTERS.map((f) => (
            <Pressable
              key={f}
              onPress={() => router.setParams({ filter: f })}
              style={[styles.chip, filter === f && styles.chipOn]}
            >
              <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
                {CHIP_LABEL[f]} {counts[f]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {filter === 'restock' ? (
          /* ── 需补货：与「在库列表」是两种形状，分开渲染 ─────────────── */
          <Card style={styles.listCard}>
            {restockRows.length === 0 ? (
              <View style={styles.noResult}>
                <Text style={text.muted}>
                  {needle ? '没有符合条件的药。' : '现在没有需要补货的药。'}
                </Text>
              </View>
            ) : (
              restockRows.map((r) => (
                <View key={r.medicine.id} style={styles.restockLine}>
                  <Pressable
                    style={styles.restockMain}
                    onPress={() =>
                      router.push({ pathname: '/medicine/[id]', params: { id: r.medicine.id } })
                    }
                  >
                    <Text style={styles.generic}>{r.medicine.generic}</Text>
                    <Text style={text.muted}>{formatDose(r.medicine.dailyDose!)} /天</Text>
                  </Pressable>
                  {r.daysOfSupply === 0 ? (
                    <Pill tone={tone.danger} label="已用完 / 无库存" />
                  ) : (
                    <Pill tone={tone.restock} label={`约剩 ${formatDos(r.daysOfSupply)} 天`} />
                  )}
                  {/* 补货是这个 App 里唯一「买回来马上要记」的动作，
                      所以在这一行直接给入口，不必先进详情页再找按钮 */}
                  <Pressable
                    style={styles.restockBtn}
                    onPress={() =>
                      router.push({ pathname: '/batch/new', params: { medicineId: r.medicine.id } })
                    }
                  >
                    <Text style={styles.restockBtnText}>去补货</Text>
                  </Pressable>
                </View>
              ))
            )}
          </Card>
        ) : (
          /* ── 在库列表（分组） ──────────────────────────────────────── */
          <Card style={styles.listCard}>
            {groups.length === 0 ? (
              <View style={styles.noResult}>
                <Text style={text.muted}>
                  {needle || filter !== 'all' ? '没有符合条件的药。' : '药箱是空的。'}
                </Text>
              </View>
            ) : (
              groups.map((g, i) => (
                <View key={g.medicine.id} style={[styles.group, i > 0 && styles.groupDivided]}>
                  <Pressable
                    style={styles.groupHead}
                    onPress={() =>
                      router.push({ pathname: '/medicine/[id]', params: { id: g.medicine.id } })
                    }
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
                      {g.medicine.autoDeduct ? (
                        <Text style={[styles.autoChip]}>自动扣减</Text>
                      ) : null}
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
                      <Text style={styles.memberChip}>{s.owner ? s.owner.name : '家庭共用'}</Text>
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
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    backgroundColor: color.bg,
    gap: space.md,
  },
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
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
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

  content: { paddingHorizontal: space.lg, paddingBottom: space.xl * 2 },
  listCard: { marginTop: space.sm, padding: 0, overflow: 'hidden' },
  noResult: { padding: space.xl, alignItems: 'center' },
  group: { paddingHorizontal: space.lg, paddingVertical: space.md },
  groupDivided: { borderTopWidth: 1, borderTopColor: color.lineSoft },
  groupHead: { gap: 2 },
  groupTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  generic: { fontSize: font.base, fontWeight: '700', color: color.ink },
  groupMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  // 与药品档案页那个徽章同色（`tone.restock`）—— 同一样东西在两处不能长成两种颜色
  autoChip: {
    fontSize: font.tiny,
    color: tone.restock.text,
    backgroundColor: tone.restock.bg,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },

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

  restockLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  restockMain: { flex: 1, gap: 1 },
  restockBtn: {
    borderWidth: 1,
    borderColor: color.brandSoft2,
    backgroundColor: color.brandSoft,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  restockBtnText: { fontSize: font.tiny, color: color.brandStrong, fontWeight: '700' },
});
