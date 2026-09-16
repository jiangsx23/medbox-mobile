/**
 * 导入数据 —— 整个 M1 里唯一会改数据的动作。
 *
 * ── 三步，中间不省 ────────────────────────────────────────────────────
 * 1. **选文件**（系统文件选择器，读 `all.json`）
 * 2. **先解析、再给结果看**，确认后才写库。解析是纯函数（`importer/parse.ts`），
 *    所以「这份文件有几处毛病」在动任何数据之前就能说清楚。
 * 3. **确认覆盖**：库里已经有数据时必须明确警告会清空 ——
 *    这是全 App 唯一会丢数据的操作。
 *
 * ── 界面上刻意保留的两块内容 ─────────────────────────────────────────
 * - **被重新起算的自动扣减药**：导入会把 6 个三高药的起算日改成今天
 *   （否则会一次扣爆，见 DESIGN.md §7.2 坑 4）。这是**改动了语义**，
 *   所以必须显式列出来，不能默默做完。
 * - **警告列表**：解析器发现的不规范之处。M1 的验收标准是「数量对得上网页版」，
 *   这些警告就是「哪里可能对不上」的清单。
 */
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { parseExport, type ParsedImport } from '../src/importer/parse';
import { applyImport, type ImportOutcome } from '../src/importer/apply';
import { formatDose } from '../src/domain/forecast';
import { nowInstant } from '../src/domain/instant';
import { today as todayDay } from '../src/domain/calendar';
import { Card, SectionTitle } from '../src/ui/components';
import { useDb } from '../src/ui/DbProvider';
import { color, font, radius, screen, space, text, tone } from '../src/ui/theme';

type Stage =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'preview'; fileName: string; parsed: ParsedImport }
  | { kind: 'failed'; fileName: string; errors: string[] }
  | { kind: 'done'; outcome: ImportOutcome };

export default function ImportScreen() {
  const router = useRouter();
  const { db, hasData, reload } = useDb();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({
      // exporter 产出的是 application/json，但不同文件管理器给的 MIME 五花八门，
      // 干脆全收，靠解析器去判 —— 文件选错了会得到清楚的报错，不会写坏数据
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled) return;

    const asset = res.assets[0];
    const fileName = asset.name ?? 'all.json';
    setStage({ kind: 'reading' });
    try {
      const file = new File(asset.uri);
      // 用异步读，不用 textSync —— 后者阻塞 JS 线程，文件一大界面就冻住。
      // 顺手挡两种选错文件的情况：空文件（读不出来，size 为 0）和超大文件
      // （真实导出 33 KB，超过 8 MB 基本可以断定不是药箱导出）。
      if (file.size === 0) {
        setStage({
          kind: 'failed',
          fileName,
          errors: ['这个文件是空的，或者 App 没有权限读它。'],
        });
        return;
      }
      if (file.size !== null && file.size > 8 * 1024 * 1024) {
        setStage({
          kind: 'failed',
          fileName,
          errors: [
            `文件有 ${Math.round(file.size / 1024 / 1024)} MB，不像是药箱导出（真实文件约 33 KB）。` +
              '确认选的是 all.json，而不是别的备份文件。',
          ],
        });
        return;
      }
      const text = await file.text();
      const parsed = parseExport(text, todayDay());
      setStage(
        parsed.ok
          ? { kind: 'preview', fileName, parsed: parsed.data }
          : { kind: 'failed', fileName, errors: parsed.errors },
      );
    } catch (e) {
      setStage({
        kind: 'failed',
        fileName,
        errors: [`文件读不出来：${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }

  function commit() {
    if (stage.kind !== 'preview') return;
    try {
      const outcome = applyImport(db, stage.parsed, {
        importedAt: nowInstant(),
        sourceName: stage.fileName,
      });
      reload();
      setStage({ kind: 'done', outcome });
    } catch (e) {
      setStage({
        kind: 'failed',
        fileName: stage.fileName,
        errors: [`写库失败（数据没有被改动）：${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      {stage.kind === 'done' ? (
        <Result outcome={stage.outcome} onDone={() => router.back()} onAgain={() => setStage({ kind: 'idle' })} />
      ) : (
        <>
          <Card>
            <Text style={text.body}>
              从网页版「家庭电子药箱」导出的 <Text style={styles.mono}>all.json</Text>，
              在手机上导入一次就能用了。
            </Text>
            <Text style={styles.hint}>
              {hasData
                ? '⚠️ 手机上已经有数据。导入会先清空再写入 —— 同一份文件重复导入不会产生重复，但换成另一份文件就会整个替换掉。'
                : '手机上还没有数据，导入是安全的。'}
            </Text>
          </Card>

          {stage.kind === 'reading' ? (
            <View style={styles.center}>
              <ActivityIndicator color={color.brand} />
              <Text style={[text.muted, styles.mt]}>正在读取并检查文件…</Text>
            </View>
          ) : (
            <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={pick}>
              <Ionicons name="folder-open-outline" size={18} color={color.white} />
              <Text style={styles.primaryBtnLabel}>选择 all.json</Text>
            </Pressable>
          )}

          {stage.kind === 'failed' && (
            <>
              <SectionTitle>这份文件有问题</SectionTitle>
              <Card style={styles.badCard}>
                <Text style={styles.badFile}>{stage.fileName}</Text>
                {stage.errors.map((e, i) => (
                  <Text key={i} style={styles.badItem}>
                    • {e}
                  </Text>
                ))}
                <Text style={styles.badFoot}>
                  一行数据都没写进去，手机上的数据保持原样。
                </Text>
              </Card>
            </>
          )}

          {stage.kind === 'preview' && (
            <>
              <SectionTitle>检查通过，等您确认</SectionTitle>
              <Card>
                <Text style={styles.file}>{stage.fileName}</Text>
                <View style={styles.statGrid}>
                  <Stat n={stage.parsed.members.length} label="成员" />
                  <Stat n={stage.parsed.medicines.length} label="药品档案" />
                  <Stat n={stage.parsed.batches.length} label="批次" />
                  <Stat n={stage.parsed.events.length} label="变动记录" />
                </View>
                <View style={styles.totalRow}>
                  <Text style={text.muted}>库存合计</Text>
                  <Text style={styles.total}>
                    {formatDose(stage.parsed.stats.totalQty)} 单位
                  </Text>
                </View>
                <Text style={styles.hint}>
                  导出时间：{stage.parsed.exportedAtRaw ?? '文件里没写'}
                </Text>
              </Card>

              {stage.parsed.autoRestarted.length > 0 && (
                <>
                  <SectionTitle>这 {stage.parsed.autoRestarted.length} 种药的起算日会改成今天</SectionTitle>
                  <Card style={styles.warnCard}>
                    <Text style={styles.hint}>
                      自动扣减是「从起算日算到今天，缺多少天补扣多少」。导入时若沿用文件里的旧起算日，
                      会把这几天的一次全扣掉，所以这里统一改成今天 —— 相当于「从今天重新开始记」。
                    </Text>
                    {stage.parsed.autoRestarted.map((m, i) => (
                      <View key={`${m.generic}-${i}`} style={styles.autoRow}>
                        <Text style={styles.autoName}>{m.generic}</Text>
                        <Text style={text.muted}>{m.originalAutoFrom ?? '—'} → 今天</Text>
                      </View>
                    ))}
                  </Card>
                </>
              )}

              {stage.parsed.warnings.length > 0 && (
                <>
                  <SectionTitle>提醒（{stage.parsed.warnings.length}）</SectionTitle>
                  <Card>
                    {stage.parsed.warnings.map((w, i) => (
                      <Text key={i} style={styles.warnItem}>
                        • {w}
                      </Text>
                    ))}
                  </Card>
                </>
              )}

              <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={commit}>
                <Ionicons name="checkmark" size={18} color={color.white} />
                <Text style={styles.primaryBtnLabel}>
                  {hasData ? '清空并导入' : '导入'}
                </Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={() => setStage({ kind: 'idle' })}>
                <Text style={styles.ghostBtnLabel}>再选一个文件</Text>
              </Pressable>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statN}>{n}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Result({
  outcome,
  onDone,
  onAgain,
}: {
  outcome: ImportOutcome;
  onDone: () => void;
  onAgain: () => void;
}) {
  return (
    <>
      <Card style={styles.okCard}>
        <View style={styles.okHead}>
          <Ionicons name="checkmark-circle" size={22} color={tone.ok.text} />
          <Text style={styles.okTitle}>导入完成</Text>
        </View>
        <View style={styles.statGrid}>
          <Stat n={outcome.members} label="成员" />
          <Stat n={outcome.medicines} label="药品档案" />
          <Stat n={outcome.batches} label="批次" />
          <Stat n={outcome.events} label="变动记录" />
        </View>
        <View style={styles.totalRow}>
          <Text style={text.muted}>库存合计</Text>
          <Text style={styles.total}>{formatDose(outcome.totalQty)} 单位</Text>
        </View>
      </Card>

      <Text style={styles.hint}>
        想核对数量的话，去首页看「在库批次」这一格的数字，或者药品档案页点开任意一个药
        看「剩余量」。这两个数应当和网页版一致。
      </Text>

      <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={onDone}>
        <Text style={styles.primaryBtnLabel}>去看看药箱</Text>
      </Pressable>
      <Pressable style={styles.ghostBtn} onPress={onAgain}>
        <Text style={styles.ghostBtnLabel}>再导一次</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  mono: { fontFamily: 'monospace', color: color.brand },
  hint: { fontSize: font.tiny, color: color.muted, marginTop: space.md, lineHeight: 18 },
  mt: { marginTop: space.md },
  mtLg: { marginTop: space.xl },
  center: { alignItems: 'center', paddingVertical: space.xl },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.brand,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  primaryBtnLabel: { color: color.white, fontSize: font.base, fontWeight: '700' },
  ghostBtn: {
    alignItems: 'center',
    paddingVertical: 13,
    marginTop: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
  },
  ghostBtnLabel: { color: color.ink, fontSize: font.base, fontWeight: '600' },

  file: { fontSize: font.small, color: color.ink, fontWeight: '700' },
  statGrid: { flexDirection: 'row', marginTop: space.md, gap: space.sm },
  stat: { flex: 1, alignItems: 'center', gap: 1 },
  statN: { fontSize: font.title, fontWeight: '700', color: color.ink },
  statLabel: { fontSize: 10, color: color.muted },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.lineSoft,
  },
  total: { fontSize: font.title, fontWeight: '700', color: color.brand },

  badCard: { backgroundColor: tone.danger.bg, borderColor: tone.danger.bd },
  badFile: { fontSize: font.small, fontWeight: '700', color: tone.danger.text },
  badItem: { fontSize: font.small, color: tone.danger.text, marginTop: space.sm, lineHeight: 20 },
  badFoot: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.md, fontWeight: '600' },

  warnCard: { backgroundColor: tone.warn.bg, borderColor: tone.warn.bd },
  warnItem: { fontSize: font.small, color: color.ink, marginTop: space.sm, lineHeight: 20 },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  autoName: { flex: 1, fontSize: font.small, fontWeight: '600', color: color.ink },

  okCard: { backgroundColor: tone.ok.bg, borderColor: tone.ok.bd },
  okHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  okTitle: { fontSize: font.title, fontWeight: '700', color: tone.ok.text },
});
