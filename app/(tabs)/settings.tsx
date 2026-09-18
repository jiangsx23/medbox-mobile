/**
 * 设置页 —— M1 里只有一件事是必须的：**导入数据的入口**。
 *
 * 顺带把三个诊断信息露出来，因为它们是「出事了才知道要看」的东西，
 * 而且现在不做、以后补的代价是「用户报问题时手上没有任何信息」：
 * 1. 数据库的 journal_mode —— 不是 delete 就说明「备份 = 一个文件」这条承诺破了
 * 2. 上次导入的时间和源文件名 —— 核对「我导的是哪份」
 * 3. 库里的行数 —— 和网页版对数量时用得上
 *
 * 阈值（90 天 / 15 天）可编辑 —— M3 的预测已经做完并有测试兜着，
 * 原先那句「等 M3 做完预测再放开编辑」的前提已经不成立了。
 * 这两个数**只影响分档显示**，不动任何库存（见下面的文案）。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DB_NAME, isWalDisabled } from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { getThresholds } from '../../src/data/queries';
import {
  getSetting,
  KEY_LAST_IMPORT_AT,
  KEY_LAST_IMPORT_FILE,
  setSetting,
} from '../../src/importer/apply';
import { KEY_NEAR_EXPIRY_DAYS, KEY_RESTOCK_DAYS } from '../../src/domain/constants';
import { toLocalDisplay } from '../../src/domain/instant';
import { parseThresholds, type ThresholdErrors } from '../../src/domain/settings';
import { Card, Field, SectionTitle } from '../../src/ui/components';
import { useDb } from '../../src/ui/DbProvider';
import { Button, TextField } from '../../src/ui/form';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, screen, space, text, tone } from '../../src/ui/theme';

export default function SettingsScreen() {
  const router = useRouter();
  const { db, hasData, journalMode, reload } = useDb();

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

  // 输入框只在用户动过之后才受控（null = 还没动）——
  // 否则保存后 `info` 重取，用户正在打字的框会被冲掉
  const [near, setNear] = useState<string | null>(null);
  const [restock, setRestock] = useState<string | null>(null);
  const [errors, setErrors] = useState<ThresholdErrors>({});
  const [saved, setSaved] = useState(false);

  const nearValue = near ?? String(info.thresholds.nearDays);
  const restockValue = restock ?? String(info.thresholds.restockDays);

  const save = () => {
    const res = parseThresholds(nearValue, restockValue);
    setSaved(false);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    setSetting(db, KEY_NEAR_EXPIRY_DAYS, String(res.nearDays));
    setSetting(db, KEY_RESTOCK_DAYS, String(res.restockDays));
    // 不动库存，所以不需要结算；但必须刷新，否则 useQuery 拿的还是旧阈值
    reload();
    setSaved(true);
  };

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
        <TextField
          label="快过期"
          value={nearValue}
          onChangeText={(v) => {
            setNear(v);
            setSaved(false);
          }}
          keyboardType="number-pad"
          error={errors.nearDays}
          hint="天。首页把「这么多天内到期」的药标成黄色"
        />
        <TextField
          label="需补货"
          value={restockValue}
          onChangeText={(v) => {
            setRestock(v);
            setSaved(false);
          }}
          keyboardType="number-pad"
          error={errors.restockDays}
          hint="天。库存预计还够用这么多天或更少时，进「需补货」"
        />
        <Button label="保存" onPress={save} />
        {saved ? <Text style={styles.saved}>已保存。</Text> : null}
        <Text style={styles.tip}>
          这两个数只影响首页怎么分档，不会改动任何库存 —— 调大调小都不会让药变少。
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
  saved: { fontSize: font.small, color: tone.ok.text, marginTop: space.sm },
  bad: { color: tone.danger.text, fontWeight: '700' },
  badNote: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.sm, lineHeight: 17 },
  version: {
    fontSize: font.tiny,
    color: color.muted,
    textAlign: 'center',
    marginTop: space.xl,
  },
});
