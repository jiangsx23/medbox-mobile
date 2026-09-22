/**
 * 导出数据 —— M6「能拿走」的界面。
 *
 * ── 这个页面只做两件事 ────────────────────────────────────────────────
 * 1. **生成**：调 `src/exporter/` 里那两个纯函数，拿到一段字符串。
 * 2. **交出去**：把字符串写进 App 私有缓存，再拉起安卓系统分享面板。
 *
 * 所有判断（该写哪些字段、该不该拒绝、清单怎么排）都在那两个纯模块里，
 * 这里不做任何领域决策 —— 所以这一页是本模块**唯一** import expo 的地方，
 * 也是唯一没法被 jest 覆盖的地方。让无法测试的部分尽量薄，是刻意的。
 *
 * ── 三条界面纪律 ──────────────────────────────────────────────────────
 * 🔴 **不写「已发送」**。`shareAsync` 的 resolve 只代表**面板关掉了**，
 *    用户点「取消」它也 resolve。所以只能说「分享面板已关闭」。
 * 🔴 **不碰 `reload`**。硬约束 6：导出路径绝不触发结算。这一页从 `useDb()`
 *    里只解构 `{ db, today, hasData }` —— 拿不到 `reload`，就想不起来调用它。
 * 🔴 **预览过什么，就分享什么**。分享用的是内存里那段字符串，不是重新查库 ——
 *    回前台会跑结算闸门（`DbProvider`），重查一遍可能得到和刚才预览不一样的数字。
 */
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { formatDose } from '../src/domain/forecast';
import { nowInstant } from '../src/domain/instant';
import { buildExport } from '../src/exporter/build';
import { buildInventoryReport } from '../src/exporter/report';
import { Card, SectionTitle } from '../src/ui/components';
import { useDb } from '../src/ui/DbProvider';
import { color, font, radius, screen, space, text, tone } from '../src/ui/theme';

/** 两份可以拿出去的东西：完整备份（机器读）与在库清单（人读）。 */
type Which = 'backup' | 'report';

/** 生成好、**还没写文件**的一份成品。 */
type Artifact = {
  which: Which;
  fileName: string;
  mimeType: string;
  /** 要写进文件的那段字符串 */
  body: string;
  stats: { n: string; label: string }[];
  /** 需要让用户先看见的提醒（解析器给的 + 归一化时改过的） */
  warnings: string[];
  notices: string[];
};

type Stage =
  | { kind: 'idle' }
  | { kind: 'ready'; art: Artifact }
  | { kind: 'failed'; which: Which; reason: 'preflight' | 'self_check' | 'generate'; errors: string[] };

export default function ExportScreen() {
  // ⚠️ 故意不解构 `reload` —— 见文件头第 2 条纪律
  const { db, today, hasData } = useDb();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shareErr, setShareErr] = useState<string | null>(null);

  /** 生成一份成品。纯计算，不写文件、不改库。 */
  function prepare(which: Which) {
    setNote(null);
    setShareErr(null);
    try {
      if (which === 'backup') {
        const r = buildExport(db, nowInstant());
        if (!r.ok) {
          setStage({ kind: 'failed', which, reason: r.reason, errors: r.errors });
          return;
        }
        setStage({
          kind: 'ready',
          art: {
            which,
            fileName: r.fileName,
            // 显式给 mimeType：不给时部分 ROM 把 .json 猜成 octet-stream，微信会拒收
            mimeType: 'application/json',
            body: r.json,
            stats: [
              { n: String(r.stats.members), label: '成员' },
              { n: String(r.stats.medicines), label: '药品档案' },
              { n: String(r.stats.batches), label: '批次' },
              { n: String(r.stats.events), label: '变动记录' },
              { n: formatDose(r.stats.totalQty), label: '库存合计' },
            ],
            warnings: r.warnings,
            notices: r.notices.map((x) => `${x.generic} · 第 #${x.batchId} 盒`),
          },
        });
        return;
      }

      const rep = buildInventoryReport(db, today, nowInstant());
      setStage({
        kind: 'ready',
        art: {
          which,
          fileName: rep.fileName,
          mimeType: 'text/plain',
          body: rep.text,
          stats: [
            { n: String(rep.summary.boxCount), label: '在库盒数' },
            { n: String(rep.summary.medicineCount), label: '品种' },
            { n: formatDose(rep.summary.totalQty), label: '合计单位' },
            { n: String(rep.summary.restock.length), label: '需补货' },
          ],
          warnings: [],
          notices: [],
        },
      });
    } catch (e) {
      setStage({
        kind: 'failed',
        which,
        reason: 'generate',
        errors: [`生成时出错：${msg(e)}`],
      });
    }
  }

  /** 写文件 + 拉分享面板。 */
  async function share() {
    if (stage.kind !== 'ready' || busy) return;
    const art = stage.art;
    setBusy(true);
    setShareErr(null);
    try {
      const file = new File(Paths.cache, art.fileName);
      // 每次都重写，不看 `exists`：同名文件可能在**上一次启动**时留在缓存里，
      // 存在 ≠ 内容是这一份。33 KB 的东西，重写的代价比分享出旧数据小得多。
      file.create({ overwrite: true });
      file.write(art.body);

      if (!(await Sharing.isAvailableAsync())) {
        setShareErr('这台设备没有可用的分享面板，文件发不出去。');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: art.mimeType,
        UTI: art.which === 'backup' ? 'public.json' : 'public.plain-text',
        dialogTitle: art.which === 'backup' ? '导出全部数据' : '在库清单',
      });
      // 🔴 只能说面板关了。取消也 resolve，写「已发送」就是在骗人。
      setNote('分享面板已关闭。文件已经交出去了 —— 有没有真的发出去，取决于你在面板里选了什么。');
    } catch (e) {
      // 分享失败**不算**生成失败：文件还在缓存里、数据也没事，重试即可
      setShareErr(`没能拉起分享面板：${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const art = stage.kind === 'ready' ? stage.art : null;

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <Card>
        <Text style={text.body}>
          这里把手机上的数据
          <Text style={styles.bold}>原样交到你手里</Text>
          ，两种样子：一份给机器读的完整备份，一份给人看的在库清单。
          都是先写进 App 自己的缓存，再交给系统分享面板 ——
          你可以发到微信、邮件，或存到文件管理器。
        </Text>
        <Text style={styles.hint}>
          {hasData
            ? '两种都会带上库里全部的数据。'
            : '⚠️ 手机上还没有数据，导出来的会是一份空备份。'}
        </Text>
      </Card>

      {stage.kind === 'idle' && (
        <>
          <SectionTitle>完整备份</SectionTitle>
          <Card>
            <Text style={styles.body2}>
              <Text style={styles.mono}>all.json</Text> —— 与网页版「家庭电子药箱」
              完全相同的格式（<Text style={styles.mono}>version: 1</Text>）。
              换手机、重装 App、或者将来回到网页版，都靠它恢复。
            </Text>
            <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={() => prepare('backup')}>
              <Ionicons name="archive-outline" size={18} color={color.white} />
              <Text style={styles.primaryBtnLabel}>生成完整备份</Text>
            </Pressable>
          </Card>

          <SectionTitle>在库清单</SectionTitle>
          <Card>
            <Text style={styles.body2}>
              一份纯文本（<Text style={styles.mono}>.txt</Text>），按药排好：每盒的数量、
              效期、放在哪，以及「约剩几天」。适合打印出来，或直接发给家里人。
              <Text style={styles.body2}> 它在微信里能直接打开，不需要额外装东西。</Text>
            </Text>
            <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={() => prepare('report')}>
              <Ionicons name="list-outline" size={18} color={color.white} />
              <Text style={styles.primaryBtnLabel}>生成在库清单</Text>
            </Pressable>
          </Card>
        </>
      )}

      {stage.kind === 'failed' && (
        <>
          <SectionTitle>
            {stage.which === 'backup' ? '完整备份' : '在库清单'}没能生成
          </SectionTitle>
          <Card style={styles.badCard}>
            {stage.errors.map((e, i) => (
              <Text key={i} style={styles.badItem}>
                • {e}
              </Text>
            ))}
            <Text style={styles.badFoot}>
              {stage.reason === 'generate'
                ? '数据没有被改动，库还是原样。可以退出去重进这一页再试一次。'
                : '一个文件都没有写出去，手机上的数据保持原样。'}
            </Text>
          </Card>
          <Pressable style={[styles.primaryBtn, styles.mtLg]} onPress={() => prepare(stage.which)}>
            <Text style={styles.primaryBtnLabel}>再生成一次</Text>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={() => setStage({ kind: 'idle' })}>
            <Text style={styles.ghostBtnLabel}>回到上一步</Text>
          </Pressable>
        </>
      )}

      {art && (
        <>
          <SectionTitle>{art.which === 'backup' ? '完整备份' : '在库清单'}已生成，可以先核对</SectionTitle>
          <Card>
            <Text style={styles.file}>{art.fileName}</Text>
            <View style={styles.statGrid}>
              {art.stats.map((s) => (
                <View key={s.label} style={styles.stat}>
                  <Text style={styles.statN}>{s.n}</Text>
                  <Text style={styles.statLabel}>{s.label}</Text>
                </View>
              ))}
            </View>
          </Card>

          {art.notices.length > 0 && (
            <>
              <SectionTitle>有 {art.notices.length} 盒的状态被改写了</SectionTitle>
              <Card style={styles.warnCard}>
                <Text style={styles.hint}>
                  这几盒在手机上还是「在库」但数量已经是 0。「在库 + 0」这种状态
                  <Text style={styles.bold}>导出去就导不回来</Text>
                  （导入会拒绝整份文件），所以这里把它们写成「已用完」——
                  这和 App 里「编辑数量」把一盒改成 0 时的结果是一样的，不是凭空发明。
                </Text>
                {art.notices.map((n, i) => (
                  <Text key={i} style={styles.warnItem}>
                    • {n}
                  </Text>
                ))}
              </Card>
            </>
          )}

          {art.warnings.length > 0 && (
            <>
              <SectionTitle>提醒（{art.warnings.length}）</SectionTitle>
              <Card>
                {art.warnings.map((w, i) => (
                  <Text key={i} style={styles.warnItem}>
                    • {w}
                  </Text>
                ))}
              </Card>
            </>
          )}

          <SectionTitle>文件开头</SectionTitle>
          <Card>
            <Text style={styles.preview}>{head(art.body, 20)}</Text>
            <Text style={styles.hint}>
              只显示前 20 行。整份文件会通过分享面板交出去。
            </Text>
          </Card>

          {shareErr && (
            <Card style={styles.badCard}>
              <Text style={styles.badItem}>• {shareErr}</Text>
              <Text style={styles.badFoot}>数据与文件都还在，可以直接再点一次。</Text>
            </Card>
          )}

          {note && (
            <Card style={styles.okCard}>
              <View style={styles.okHead}>
                <Ionicons name="checkmark-circle" size={22} color={tone.ok.text} />
                <Text style={styles.okTitle}>分享面板已关闭</Text>
              </View>
              <Text style={styles.hint}>{note}</Text>
            </Card>
          )}

          <Pressable
            style={[styles.primaryBtn, styles.mtLg, busy && styles.btnBusy]}
            onPress={share}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={color.white} />
            ) : (
              <Ionicons name="share-outline" size={18} color={color.white} />
            )}
            <Text style={styles.primaryBtnLabel}>
              {busy
                ? '正在打开分享面板…'
                : (note ?? shareErr) !== null
                  ? '再分享一次'
                  : '分享 / 保存'}

            </Text>

          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={() => setStage({ kind: 'idle' })}>
            <Text style={styles.ghostBtnLabel}>返回</Text>
          </Pressable>
        </>
      )}

      {/* 硬约束 6 的用户可见版本。这一行不许删。 */}
      <Text style={styles.footer}>
        这一步只读数据 —— 导出不会结算、不会扣减、不会改任何数量。
      </Text>
    </ScrollView>
  );
}

/** 前 n 行（预览用）。 */
function head(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.length <= n ? s : lines.slice(0, n).join('\n') + '\n…';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  mono: { fontFamily: 'monospace', color: color.brand },
  bold: { fontWeight: '700', color: color.ink },
  hint: { fontSize: font.tiny, color: color.muted, marginTop: space.md, lineHeight: 18 },
  body2: { fontSize: font.small, color: color.ink, lineHeight: 21 },
  mtLg: { marginTop: space.xl },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.brand,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  btnBusy: { opacity: 0.7 },
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

  preview: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: color.ink,
    lineHeight: 16,
  },

  badCard: { backgroundColor: tone.danger.bg, borderColor: tone.danger.bd, marginTop: space.md },
  badItem: { fontSize: font.small, color: tone.danger.text, marginTop: space.sm, lineHeight: 20 },
  badFoot: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.md, fontWeight: '600' },

  warnCard: { backgroundColor: tone.warn.bg, borderColor: tone.warn.bd },
  warnItem: { fontSize: font.small, color: color.ink, marginTop: space.sm, lineHeight: 20 },

  okCard: { backgroundColor: tone.ok.bg, borderColor: tone.ok.bd, marginTop: space.md },
  okHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  okTitle: { fontSize: font.base, fontWeight: '700', color: tone.ok.text },

  footer: {
    fontSize: font.tiny,
    color: color.muted,
    textAlign: 'center',
    marginTop: space.xl,
    lineHeight: 18,
  },
});
