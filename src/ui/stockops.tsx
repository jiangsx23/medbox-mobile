/**
 * 一盒药下面的操作按钮 —— 取用 / 用完 / 丢弃 / 标记过期 / 恢复在库 / 编辑。
 *
 * ── 为什么「确认」不是可有可无的 ───────────────────────────────────────
 * 这五个操作里，除了「取用」和「编辑」，其余四个**都是一次点击就改数据**，
 * 而且改的是不可撤销的（`StockEvent` 只增，纠错只能再追加一条）。
 * 所以除了取用（本身要填数量，填完点确定已经是二次确认）之外，
 * 一律先弹确认，并在确认框里**说清这一下会做什么** ——
 * 「标记过期」数量不变、和「丢弃」数量归零，是两件完全不同的事。
 *
 * ── 取用/丢弃为什么用底部弹层而不是 Alert.prompt ───────────────────────
 * `Alert.prompt` **只有 iOS 有**。用它写出来的输入框在小米8（安卓）上
 * 会静默地什么都不弹 —— 不是报错，是没反应，最难查的那种。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Batch } from '../db/schema';
import { discard, markExpired, restock, take, usedUp } from '../data/stock';
import { BATCH_IN_STOCK } from '../domain/constants';
import type { OpResult } from '../domain/stock';
import { useDb } from './DbProvider';
import { Button, Sheet, TextField } from './form';
import { color, font, radius, space, text, tone } from './theme';

/** 小号操作按钮。 */
function MiniButton({
  label,
  onPress,
  icon,
  danger,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  danger?: boolean;
}) {
  return (
    <Pressable style={styles.mini} onPress={onPress}>
      {icon ? (
        <Ionicons name={icon} size={14} color={danger ? tone.danger.text : color.brand} />
      ) : null}
      <Text style={[styles.miniText, danger && styles.miniTextDanger]}>{label}</Text>
    </Pressable>
  );
}

export function BatchOps({ batch }: { batch: Batch }) {
  const { db, today, reload } = useDb();
  const router = useRouter();
  const inStock = batch.status === BATCH_IN_STOCK;

  const [sheet, setSheet] = useState<'take' | 'discard' | null>(null);
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** 跑一个操作；失败就把错误显示出来，成功就重新取数。 */
  const run = (res: OpResult): void => {
    if (!res.ok) {
      setError(res.errors._ ?? Object.values(res.errors)[0] ?? '操作没成功。');
      return;
    }
    setError(null);
    setSheet(null);
    setReason('');
    // 闸门重跑 → 版本号 +1 → 详情页与首页一起刷新
    reload();
  };

  const confirm = (title: string, message: string, label: string, act: () => void, danger = false) => {
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      { text: label, style: danger ? 'destructive' : 'default', onPress: act },
    ]);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {inStock ? (
          <>
            <MiniButton
              label="取用"
              icon="remove-circle-outline"
              onPress={() => {
                setError(null);
                setAmount('1');
                setReason('');
                setSheet('take');
              }}
            />
            <MiniButton
              label="用完"
              icon="checkmark-circle-outline"
              onPress={() =>
                confirm(
                  '用完这一盒？',
                  `数量会从 ${batch.qty} 归 0，状态转成「已用完」。时间线上会留一条记录。`,
                  '用完',
                  () => run(usedUp(db, batch.id, today)),
                )
              }
            />
            <MiniButton
              label="丢弃"
              icon="trash-outline"
              danger
              onPress={() => {
                setError(null);
                setReason('');
                setSheet('discard');
              }}
            />
            <MiniButton
              label="标记过期"
              icon="alert-circle-outline"
              onPress={() =>
                confirm(
                  '标记为已过期？',
                  // Alert 里不认 markdown，别在这里写 **加粗**
                  `数量不变（还是 ${batch.qty} ${batch.unit}），只是不能再吃了。\n\n` +
                    '如果这盒药已经扔了，请用「丢弃」。',
                  '标记过期',
                  () => run(markExpired(db, batch.id, today)),
                )
              }
            />
          </>
        ) : batch.qty > 0 ? (
          <MiniButton
            label="恢复在库"
            icon="arrow-undo-outline"
            onPress={() =>
              confirm(
                '恢复在库？',
                `数量不变（${batch.qty} ${batch.unit}），只是状态改回「在库」。\n\n` +
                  '适合「标记过期后发现有别的用途」或「误标了丢弃」。',
                '恢复在库',
                () => run(restock(db, batch.id, today)),
              )
            }
          />
        ) : (
          // 已用完/已丢弃的盒数量是 0，直接恢复会造出「在库且为 0」的非法状态，
          // 所以这里不给按钮、只说明该怎么办 —— 给个按不动的按钮更让人困惑
          <Text style={styles.hint}>数量是 0，先用「编辑」把数量改回大于 0 才能恢复在库</Text>
        )}

        <MiniButton
          label="编辑"
          icon="create-outline"
          onPress={() => router.push({ pathname: '/batch/[id]/edit', params: { id: batch.id } })}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* ── 取用 ─────────────────────────────────────────────── */}
      <Sheet visible={sheet === 'take'} title="取用" onClose={() => setSheet(null)}>
        <Text style={[text.muted, styles.sheetLead]}>
          这一盒现在有 {batch.qty} {batch.unit}。
        </Text>
        <TextField
          label="取用数量"
          value={amount}
          onChangeText={setAmount}
          keyboardType="number-pad"
          hint={`不能超过 ${batch.qty}`}
        />
        <TextField
          label="原因（可不填）"
          value={reason}
          onChangeText={setReason}
          placeholder="装进随身药盒"
        />
        <View style={styles.sheetButtons}>
          <Button label="取消" kind="ghost" onPress={() => setSheet(null)} />
          <Button label="确定" onPress={() => run(take(db, batch.id, amount, reason, today))} />
        </View>
      </Sheet>

      {/* ── 丢弃 ─────────────────────────────────────────────── */}
      <Sheet visible={sheet === 'discard'} title="丢弃这一盒" onClose={() => setSheet(null)}>
        <Text style={[text.muted, styles.sheetLead]}>
          {batch.qty} {batch.unit}会归 0，状态转成「已丢弃」，整盒退出在库。
        </Text>
        <TextField
          label="原因（可不填）"
          value={reason}
          onChangeText={setReason}
          placeholder="受潮了 / 过期太久 / 医生让停"
        />
        <View style={styles.sheetButtons}>
          <Button label="取消" kind="ghost" onPress={() => setSheet(null)} />
          <Button label="确定丢弃" onPress={() => run(discard(db, batch.id, reason, today))} />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  miniText: { fontSize: font.tiny, color: color.brand, fontWeight: '600' },
  miniTextDanger: { color: tone.danger.text },
  hint: { fontSize: font.tiny, color: color.muted, flexShrink: 1 },
  error: { fontSize: font.small, color: tone.danger.text, marginTop: space.sm },
  sheetLead: { marginBottom: space.lg },
  sheetButtons: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
});
