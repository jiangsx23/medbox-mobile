/**
 * 设置页 —— M1 里只有一件事是必须的：**导入数据的入口**。
 *
 * 顺带把三个诊断信息露出来，因为它们是「出事了才知道要看」的东西，
 * 而且现在不做、以后补的代价是「用户报问题时手上没有任何信息」：
 * 1. 数据库的 journal_mode —— 不是 delete 就说明「备份 = 一个文件」这条承诺破了
 * 2. 上次导入的时间和源文件名 —— 核对「我导的是哪份」
 * 3. 库里的行数 —— 和网页版对数量时用得上
 *
 * 阈值（90 天 / 15 天）这一版只读不写：改了会影响首页的「快过期」分档，
 * 而 M1 的验收标准正是「数量对得上网页版」。等 M3 做完预测再放开编辑。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DB_NAME, isWalDisabled } from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { getThresholds } from '../../src/data/queries';
import { getSetting, KEY_LAST_IMPORT_AT, KEY_LAST_IMPORT_FILE } from '../../src/importer/apply';
import { toLocalDisplay } from '../../src/domain/instant';
import { Card, Field, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, screen, space, text, tone } from '../../src/ui/theme';

export default function SettingsScreen() {
  const router = useRouter();
  const { hasData, journalMode } = useDb();

  const info = useQuery((db) => {
    const th = getThresholds(db);
    const at = getSetting(db, KEY_LAST_IMPORT_AT);
    const n = at === null ? null : Number.parseInt(at, 10);
    return {
      thresholds: th,
      importedAt: n !== null && Number.isFinite(n) ? n : null,
      importFile: getSetting(db, KEY_LAST_IMPORT_FILE),
      counts: {
        members: db.select().from(schema.members).all().length,
        medicines: db.select().from(schema.medicines).all().length,
        batches: db.select().from(schema.batches).all().length,
        events: db.select().from(schema.stockEvents).all().length,
      },
    };
  });

  const walOk = isWalDisabled(journalMode);

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <SectionTitle>数据</SectionTitle>
      <Card>
        <Pressable style={styles.action} onPress={() => router.push('/import')}>
          <Ionicons name="download-outline" size={18} color={color.brand} />
          <Text style={styles.actionLabel}>导入数据</Text>
          <Ionicons name="chevron-forward" size={16} color={color.muted} />
        </Pressable>
        <Text style={styles.actionHint}>
          {hasData
            ? '从网页版导出的 all.json 重新导入。会先清空手机上现有的数据。'
            : '还没有数据。导入网页版导出的 all.json 就能开始用。'}
        </Text>
      </Card>

      <SectionTitle>库里现在有什么</SectionTitle>
      <Card>
        <Field label="成员" value={String(info.counts.members)} />
        <Field label="药品档案" value={String(info.counts.medicines)} />
        <Field label="批次" value={String(info.counts.batches)} />
        <Field label="变动记录" value={String(info.counts.events)} />
      </Card>

      <SectionTitle>上次导入</SectionTitle>
      <Card>
        <Field
          label="时间"
          value={info.importedAt !== null ? toLocalDisplay(info.importedAt) : '从未导入'}
        />
        <Field label="文件" value={info.importFile ?? '—'} />
      </Card>

      <SectionTitle>阈值</SectionTitle>
      <Card>
        <Field label="快过期" value={`${info.thresholds.nearDays} 天内`} />
        <Field label="需补货" value={`库存 ≤ ${info.thresholds.restockDays} 天`} />
        <Text style={styles.tip}>
          这两个数决定首页怎么分档。这一版只读 —— 改了会让首页和网页版对不上，
          而「对得上」正是这一版的验收标准。
        </Text>
      </Card>

      {/* ── 诊断 ─────────────────────────────────────────────────────
          不是给日常用的，是出事时唯一能问的东西。所以宁可平时显眼一点。 */}
      <SectionTitle>诊断</SectionTitle>
      <Card>
        <Field label="数据库" value={DB_NAME} />
        <Field
          label="日志模式"
          value={journalMode}
          valueStyle={walOk ? undefined : styles.bad}
        />
        <Field label="备份" value={walOk ? '一个文件' : '多个文件（异常）'} valueStyle={walOk ? undefined : styles.bad} />
        {!walOk ? (
          <Text style={styles.badNote}>
            ⚠️ 数据库开着 WAL，改动会写在额外的 -wal / -shm 文件里，
            只拷 medbox.db 会丢数据。请把这条信息告诉开发者。
          </Text>
        ) : (
          <Text style={styles.tip}>
            日志模式是 {journalMode}（不是 wal），所以药箱数据全在 {DB_NAME} 这一个文件里，
            拷贝它就是完整备份。
          </Text>
        )}
      </Card>

      <Text style={styles.version}>家庭药箱 0.1.0 · 数据只在这台手机上</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  actionLabel: { flex: 1, fontSize: font.base, fontWeight: '700', color: color.ink },
  actionHint: { fontSize: font.tiny, color: color.muted, lineHeight: 17, marginTop: space.xs },
  tip: { fontSize: font.tiny, color: color.muted, marginTop: space.sm, lineHeight: 17 },
  bad: { color: tone.danger.text, fontWeight: '700' },
  badNote: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.sm, lineHeight: 17 },
  version: {
    fontSize: font.tiny,
    color: color.muted,
    textAlign: 'center',
    marginTop: space.xl,
  },
});
