/**
 * 复用的小组件。都是「网页版里反复出现的那几块」的直译，
 * 没有引入任何设计系统或用例 —— 37 条数据、4 个页面，够用就行。
 */
import { Ionicons } from '@expo/vector-icons';
import { Alert, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { EXPIRY_STATUS_LABELS, type ExpiryStatus } from '../domain/constants';
import {
  card as cardStyle,
  color,
  font,
  pill,
  pillText,
  radius,
  space,
  text,
  tone,
  toneForExpiry,
  type Tone,
} from './theme';

/** 状态药丸：效期分档用这个。 */
export function ExpiryPill({ status }: { status: ExpiryStatus }) {
  const t = toneForExpiry(status);
  return <Pill tone={t} label={EXPIRY_STATUS_LABELS[status]} />;
}

/** 「该补货了」药丸。与效期分档**并列**显示，不互相替代。 */
export function RestockPill() {
  return <Pill tone={tone.restock} label="该补货" />;
}

/** 通用药丸。 */
export function Pill({ tone: t, label }: { tone: Tone; label: string }) {
  return (
    <View style={[pill(t), styles.pillWrap]}>
      <Text style={pillText(t)}>{label}</Text>
    </View>
  );
}

/** 一排药丸的容器，自动换行。 */
export function PillRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.pillRow}>{children}</View>;
}

/** 卡片。`style` 收数组，方便调用方叠加自己的间距/配色。 */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[cardStyle, style]}>{children}</View>;
}

/** 「名称 —— 值」的一行，标签左、值右。 */
export function Field({ label, value, valueStyle }: { label: string; value: React.ReactNode; valueStyle?: TextStyle }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[text.body, styles.fieldValue, valueStyle]}>{value ?? '—'}</Text>
    </View>
  );
}

/** 空状态：一句话说明「为什么这里是空的」，不要只写「暂无数据」。 */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={text.title}>{title}</Text>
      {hint ? <Text style={[text.muted, styles.emptyHint]}>{hint}</Text> : null}
    </View>
  );
}

/** 分组小标题（首页的「需补货」「按成员」等）。 */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{children}</Text>
      {right}
    </View>
  );
}

/**
 * 小号操作按钮：一行排开、描边、带个小图标。
 *
 * 从 `stockops.tsx` 提上来的 —— 第二个使用者（药品详情页的「暂停服药」）
 * 出现了，与当初 `medicineform.tsx` / `batchform.tsx` 被抽出来是同一个时机。
 */
export function MiniButton({
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

/**
 * 二次确认框。**不是可有可无的**：这里所有调用点改的都是不可撤销的数据
 * （`StockEvent` 只增，纠错只能再追加一条），所以 `message` 必须说清
 * 这一下会做什么，而不是重复一遍标题。
 *
 * 用 `Alert` 而不是自绘 —— 它是系统原生弹窗，安卓上一样有；反例见
 * `stockops.tsx` 文件头关于 `Alert.prompt` 只有 iOS 的那段。
 *
 * ⚠️ `Alert` 的正文**不认 markdown**，`message` 里写 `**加粗**` 会原样显示星号。
 */
export function confirm(
  title: string,
  message: string,
  label: string,
  act: () => void,
  danger = false,
): void {
  Alert.alert(title, message, [
    { text: '取消', style: 'cancel' },
    { text: label, style: danger ? 'destructive' : 'default', onPress: act },
  ]);
}

const styles = StyleSheet.create({
  pillWrap: { alignSelf: 'flex-start' },
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
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  field: { flexDirection: 'row', paddingVertical: 5, alignItems: 'flex-start' },
  fieldLabel: { width: 88, fontSize: font.small, color: color.muted, lineHeight: 24 },
  fieldValue: { flex: 1 },
  empty: { alignItems: 'center', paddingVertical: space.xl * 2, paddingHorizontal: space.lg },
  emptyHint: { marginTop: space.sm, textAlign: 'center' },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: space.xl,
    marginBottom: space.sm,
    paddingHorizontal: space.xs,
  },
  sectionTitleText: { fontSize: font.base, fontWeight: '700', color: color.ink },
});
