/**
 * 药品详情：这个药我还有多少、什么时候过期、都放在哪。
 *
 * ── 逐盒展开是这一页的重点 ────────────────────────────────────────────
 * 「剩 34 片」这个数字**不能单独出现** —— 34 片可能是 2 盒各 17 片，
 * 也可能是一盒快过期、另一盒还有一年。要决定「先吃哪盒」必须看到每一盒。
 * 所以「在库」不折叠，直接一盒一张卡（44 条批次里最多的药也就几盒）。
 *
 * ── 与网页版的差别 ───────────────────────────────────────────────────
 * 网页版每盒下面挂一排操作按钮（取用 / 用完 / 标记过期 / 丢弃 / 编辑）。
 * **M1 不做这些** —— 那是 M2「能记药」的内容。所以这里只读不写，
 * 不是为了省事，是这一版本来就只承诺「能查药」。
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { medicineDetail } from '../../src/data/queries';
import { BATCH_STATUS_LABELS, EVENT_LABELS } from '../../src/domain/constants';
import { formatDose } from '../../src/domain/forecast';
import { toLocalDisplay } from '../../src/domain/instant';
import { Card, Empty, ExpiryPill, Pill, SectionTitle } from '../../src/ui/components';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../src/ui/theme';

export default function MedicineDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const medicineId = Number(id);
  const router = useRouter();

  const d = useQuery((db, today) => medicineDetail(db, medicineId, today), [medicineId]);

  if (!d.found) {
    return (
      <View style={screen}>
        <Empty title="药品不存在" hint="它可能已被删除。回上一页重新选一个。" />
      </View>
    );
  }

  const m = d.medicine;

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>
        {m.generic}
        {m.brand ? <Text style={styles.h1Sub}>（{m.brand}）</Text> : null}
      </Text>

      {/* ── 基本信息 ─────────────────────────────────────────────── */}
      <Card style={styles.gap}>
        <View style={styles.kvRow}>
          <Kv label="剩余量" value={`${formatDose(d.totalQty)}${m.unit ? ` ${m.unit}` : ''}`} big />
          <Kv label="规格" value={m.spec ?? '—'} />
          <Kv label="剂型" value={m.form ?? '—'} />
          <Kv label="归属" value={d.owner ? d.owner.name : '家庭共用'} />
          <Kv label="每日用量" value={m.dailyDose ? `${formatDose(m.dailyDose)} /天` : '—'} />
        </View>
        {m.category ? (
          <View style={styles.badgeRow}>
            <Pill tone={tone.ok} label={m.category} />
          </View>
        ) : null}
        {m.purposeNotes ? <Text style={styles.note}>{m.purposeNotes}</Text> : null}
      </Card>

      {/* ── 可用天数 / 自动扣减 ──────────────────────────────────── */}
      {m.dailyDose ? (
        <Card style={[styles.gap, styles.infoCard]}>
          {d.daysOfSupply !== null ? (
            <View style={styles.line}>
              <Text style={text.muted}>
                按每天 {formatDose(m.dailyDose)} 计约可用{' '}
                <Text style={styles.strong}>{d.daysOfSupply.toFixed(1)}</Text> 天
              </Text>
              {d.needsRestock ? (
                <Pill tone={tone.restock} label="库存不足，该补货了" />
              ) : (
                <Pill tone={tone.ok} label="充足" />
              )}
            </View>
          ) : (
            <Text style={text.muted}>
              单批单位若为盒/瓶，请按片/粒/袋入库才能算天数。
            </Text>
          )}

          <View style={[styles.line, styles.lineSpaced]}>
            {m.autoDeduct ? (
              m.autoPaused ? (
                <>
                  <Pill tone={tone.warn} label="自动扣减已暂停" />
                  <Text style={text.muted}>停药期间不扣，恢复后从当天重新起算</Text>
                </>
              ) : (
                <>
                  <Pill tone={tone.ok} label="自动扣减已开启" />
                  <Text style={text.muted}>
                    起算日 {m.autoFrom ?? '—'} · 已核算消耗{' '}
                    <Text style={styles.strong}>{formatDose(m.autoAccounted)}</Text>
                    {m.unit ?? ''}
                  </Text>
                </>
              )
            ) : (
              <Text style={text.muted}>未开启自动扣减 —— 需要每天手动记「取用」。</Text>
            )}
          </View>

          {/* 单位混用时「合计」这个数字是假的，必须说出来，
              否则用户会拿一个没有意义的数去做决定 */}
          {d.unitConflict ? (
            <Text style={styles.conflict}>
              ⚠️ 该药的在库记录用了不止一种单位，数量相加没有意义。请把各条记录的单位统一。
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/* ── 在库，逐盒 ───────────────────────────────────────────── */}
      <SectionTitle>在库（{d.inStock.length}）</SectionTitle>
      {d.inStock.length === 0 ? (
        <Card>
          <Text style={text.muted}>暂无在库。</Text>
        </Card>
      ) : (
        d.inStock.map((r) => {
          const b = r.batch;
          return (
            <Card key={b.id} style={styles.gap}>
              <View style={styles.line}>
                <Text style={styles.qtyBig}>
                  {formatDose(b.qty)} <Text style={styles.qtyUnit}>{b.unit}</Text>
                </Text>
                <ExpiryPill status={r.expiryStatus} />
              </View>
              <Text style={[text.muted, styles.mt]}>
                提醒日：
                {r.effective ? (
                  <>
                    {r.effective}
                    <Text style={styles.tiny}>
                      （{b.openedAt ? '拆封后' : '印刷效期'}）
                    </Text>
                  </>
                ) : (
                  '未填效期'
                )}
              </Text>
              <View style={[styles.line, styles.mt]}>
                <Text style={styles.memberChip}>
                  {r.owner ? r.owner.name : '家庭共用'}
                </Text>
                {b.location ? <Text style={styles.locChip}>{b.location}</Text> : null}
              </View>
              {b.notes ? <Text style={[text.muted, styles.mt]}>{b.notes}</Text> : null}
            </Card>
          );
        })
      )}

      {/* ── 历史 ─────────────────────────────────────────────────── */}
      {d.history.length > 0 && (
        <>
          <SectionTitle>历史（已用完 / 已过期 / 已丢弃）</SectionTitle>
          <Card>
            {d.history.map((b, i) => (
              <View key={b.id} style={[styles.histRow, i > 0 && styles.histDivided]}>
                <Pill tone={tone.gray} label={BATCH_STATUS_LABELS[b.status] ?? b.status} />
                <Text style={styles.histQty}>
                  {formatDose(b.qty)} {b.unit}
                </Text>
                <Text style={[text.muted, styles.histDate]}>
                  {b.expiryDate ?? '—'}
                  {b.openedAt ? `（${b.openedAt} 拆封）` : ''}
                </Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {/* ── 变动时间线 ───────────────────────────────────────────── */}
      <SectionTitle>变动时间线</SectionTitle>
      <Card>
        {d.events.length === 0 ? (
          <Text style={text.muted}>
            暂无变动记录。
            {/* 导入进来的老数据没有「入库」记录，是刻意的，见 DESIGN.md §6.9 ——
                这里说清楚，免得看着像数据丢了 */}
            <Text style={styles.tiny}>
              {' '}
              （从网页版导入的历史批次没有入库记录，这是正常的。）
            </Text>
          </Text>
        ) : (
          d.events.map((ev, i) => (
            <View key={ev.id} style={[styles.evRow, i > 0 && styles.histDivided]}>
              <View style={styles.evTop}>
                <Text style={styles.evTime}>{toLocalDisplay(ev.createdAt)}</Text>
                <Text style={styles.evType}>{EVENT_LABELS[ev.type] ?? ev.type}</Text>
                <Text style={[styles.evDelta, ev.deltaQty < 0 ? styles.evMinus : styles.evPlus]}>
                  {ev.deltaQty > 0 ? `+${ev.deltaQty}` : ev.deltaQty}
                </Text>
                <Text style={text.muted}>→ {formatDose(ev.qtyAfter)}</Text>
              </View>
              {ev.reason ? <Text style={[text.muted, styles.tiny]}>{ev.reason}</Text> : null}
            </View>
          ))
        )}
      </Card>

      <Text style={styles.footHint}>
        <Ionicons name="information-circle-outline" size={12} color={color.muted} /> 入库、取用、
        用完、丢弃等操作会在下一版加进来。
      </Text>
    </ScrollView>
  );
}

function Kv({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, big && styles.kvBig]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  gap: { marginBottom: space.md },
  h1: { fontSize: font.hero, fontWeight: '700', color: color.ink, marginBottom: space.md },
  h1Sub: { fontSize: font.base, fontWeight: '400', color: color.muted },

  kvRow: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.md },
  kv: { minWidth: '30%', gap: 2 },
  kvLabel: { fontSize: font.tiny, color: color.muted },
  kvValue: { fontSize: font.base, color: color.ink },
  kvBig: { fontSize: font.title, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', marginTop: space.md },
  note: { fontSize: font.small, color: color.muted, marginTop: space.md, lineHeight: 20 },

  infoCard: { backgroundColor: color.cardWarm },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  lineSpaced: { marginTop: space.md },
  strong: { fontWeight: '700', color: color.ink },
  conflict: { fontSize: font.small, color: tone.danger.text, marginTop: space.md, lineHeight: 20 },

  qtyBig: { fontSize: font.title, fontWeight: '700', color: color.ink },
  qtyUnit: { fontSize: font.base, fontWeight: '400', color: color.muted },
  mt: { marginTop: space.sm },
  tiny: { fontSize: font.tiny, color: color.muted },
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

  histRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  histDivided: { borderTopWidth: 1, borderTopColor: color.lineSoft },
  histQty: { fontSize: font.small, fontWeight: '600', color: color.ink },
  histDate: { flex: 1, textAlign: 'right' },

  evRow: { paddingVertical: space.sm },
  evTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  evTime: { fontSize: font.tiny, color: color.muted },
  evType: { fontSize: font.small, color: color.ink, fontWeight: '600' },
  evDelta: { fontSize: font.small, fontWeight: '700' },
  evMinus: { color: tone.restock.text },
  evPlus: { color: tone.ok.text },

  footHint: { fontSize: font.tiny, color: color.muted, textAlign: 'center', marginTop: space.xl },
});
