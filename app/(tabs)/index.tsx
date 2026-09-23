/**
 * 药箱（tab）= 统计总览。
 *
 * ── 2026-09-23 的顺序反转（DESIGN.md §5.1 有记账）──────────────────────
 * 原先这一页是「搜索框 → 在库列表 → 统计一行 → 需补货 → 按成员」，
 * 刻意与网页版不同：理由是场景 1「这药还有吗」的答案在**在库列表**里，
 * 不该被统计挤到第二屏。用户要求改成统计优先（像网页版首页，但不带在库列表），
 * 于是那段列表**整段搬去了 `app/stock.tsx`**，这里只剩统计。
 * 代价是明确的：「这药还有吗」从零点击变成一次点击。用户已确认。
 *
 * ── 四张卡每一张都必须能点 ──────────────────────────────────────────────
 * 「点某张统计就进对应的药品列表」是这个页面的全部意义 ——
 * 所以这里**不允许再出现不可点的数字**（原先「库存不足」就没有 `onPress`，
 * 那是这个设计的一半没做完）。
 *
 * ── 顺带：一进 App 不再像在要你打字 ─────────────────────────────────────
 * 用户报的「点图标进来就弹输入框」，成因是搜索框正好是首屏第一个元素
 * （全项目没有 `autoFocus`，系统侧 `mInputShown=false`）。
 * 搜索框跟着列表走之后，这件事就不存在了 —— 不用加任何「压键盘」的代码。
 */
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { dashboard } from '../../src/data/queries';
import { Card, Empty, PillRow, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../src/ui/theme';

/** 路由里用 `shared` 代表「归属为空」——`ownerId` 是 `null`，塞不进 path。 */
const SHARED = 'shared';

export default function HomeScreen() {
  const { hasData } = useDb();
  const router = useRouter();

  const dash = useQuery((db, today) => dashboard(db, today));

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

  /**
   * 四张卡。
   *
   * ⚠️ **前三张数「盒」、第四张数「种」** —— 这个不对称是从网页版
   * `dashboard_stats()` 一路继承下来的，别抹平（§5.1）。
   * 第四张靠 `hint` 那句「种药待补」把量词交代清楚，免得读者以为它也是盒数。
   */
  const cards = [
    {
      key: 'all',
      label: '在库批次',
      unit: '盒',
      num: dash.inStockCount,
      t: undefined,
    },
    {
      key: 'near',
      label: `快过期（${dash.thresholds.nearDays}天内）`,
      unit: '盒',
      num: dash.nearExpiryCount,
      t: tone.warn,
    },
    {
      key: 'expired',
      label: '已过期',
      unit: '盒',
      num: dash.expiredCount,
      t: tone.danger,
    },
    {
      key: 'restock',
      label: `库存不足（≤${dash.thresholds.restockDays}天）`,
      unit: '种',
      num: dash.needRestock.length,
      t: tone.restock,
      hint: '种药待补',
    },
  ] as const;

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <SectionTitle>药箱总览</SectionTitle>

      <View style={styles.grid}>
        {cards.map((c) => (
          <Pressable
            key={c.key}
            // 卡片与列表页的 chip 是同一个筛选维度，所以走同一个页面的同一个参数
            onPress={() => router.push({ pathname: '/stock', params: { filter: c.key } })}
            style={[
              styles.statCard,
              {
                backgroundColor: c.t ? c.t.bg : color.bgTop,
                borderColor: c.t ? c.t.bd : color.line,
              },
            ]}
          >
            <Text style={[styles.statNum, { color: c.t ? c.t.text : color.ink }]}>
              {c.num}
              <Text style={styles.statUnit}> {c.unit}</Text>
            </Text>
            <Text style={styles.statLabel}>{c.label}</Text>
            {'hint' in c && c.hint ? <Text style={styles.statHint}>{c.hint}</Text> : null}
          </Pressable>
        ))}
      </View>

      <Text style={[text.tiny, styles.gridHint]}>点一下看对应的药品列表。</Text>

      {/* ── 按成员：保留不可省 —— 它回答的是「外公现在在吃什么」，
             与四张卡按状态切的方式正交，不能由卡片代替 ─────────────────── */}
      {dash.perMember.length > 0 && (
        <>
          <SectionTitle>按成员</SectionTitle>
          <Card>
            <PillRow>
              {dash.perMember.map((m) => (
                <Pressable
                  key={m.name}
                  style={styles.memberPill}
                  onPress={() =>
                    // M1 时这里只能把名字填进搜索框（成员页还没做）。
                    // M2 有了成员详情页，点进去能看到「这个人现在在吃什么」——
                    // 那时长的信息比筛选后的药名列表多。
                    router.push({
                      pathname: '/member/[id]',
                      params: { id: m.ownerId ?? SHARED },
                    })
                  }
                >
                  <Text style={styles.memberPillText}>
                    {m.name}
                    <Text style={styles.memberPillCount}> {m.count} 种</Text>
                  </Text>
                </Pressable>
              ))}
            </PillRow>
            <Text style={[text.tiny, styles.memberHint]}>
              点一下看这个人名下的药；「家庭共用」是没指定归属的药。
            </Text>
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 2 },

  // 2×2。用 47% + flexGrow 而不是写死两行：窄屏（≤320dp）上 0.94W + 间距
  // 仍然放得下，不必为极端宽度再写一套。flexGrow 会把余量补平，右边不留缝。
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  statCard: {
    flexGrow: 1,
    flexBasis: '47%',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
  statNum: { fontSize: font.hero, fontWeight: '700' },
  statUnit: { fontSize: font.small, fontWeight: '600' },
  statLabel: { fontSize: font.small, color: color.muted, marginTop: 2, lineHeight: 18 },
  statHint: { fontSize: font.tiny, color: color.muted, marginTop: 1 },
  gridHint: { marginTop: space.sm },

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
