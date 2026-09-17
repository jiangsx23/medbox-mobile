/**
 * 表单控件 —— 入库 / 编辑 / 成员三张表单共用。
 *
 * ── 一条贯穿的设计约束：错误信息**贴在字段下面**，不弹 alert ─────────────
 * requirements.md §3.2 要求「一次把所有问题都标出来、标红、聚焦第一个」。
 * 弹窗做不到这件事（弹一个只能显示一句），而且关掉弹窗后用户就看不见
 * 自己填错哪儿了。所以错误一律画在字段下方，由调用方一次性传进来。
 *
 * ── 日期用系统选择器，不用手打 ─────────────────────────────────────────
 * 「印刷效期」是入库时**每次都要填**的字段（刻意不预填，§3.2），手打
 * `2027-01-31` 十一次按键还容易打错。所以走系统日期选择器。
 * 安卓用命令式 API（`DateTimePickerAndroid.open`）弹出系统对话框；
 * iOS 走组件 + 自己的 Sheet —— 两条路的 API 不一样，这是这个库的历史包袱。
 *
 * 选出来的日期**只取年月日**，不带时刻：`CalendarDay` 是日历日，
 * 带上时区或时刻就违反了 §2.6 的日期口径。
 */
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState, type ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native';

import { today as dayOf, type CalendarDay } from '../domain/calendar';
import {
  buttonGhost,
  buttonGhostLabel,
  buttonLabel,
  buttonPrimary,
  color,
  font,
  radius,
  space,
  text,
  tone,
} from './theme';

// ── 字段外壳：标签 + 内容 + 错误 ───────────────────────────────────────

function FieldShell({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {/* 提示只在该字段没报错时显示 —— 两个都画会让人以为有两件事要处理 */}
      {!error && hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const inputStyle = (hasError: boolean) => [styles.input, hasError && styles.inputError];

// ── 文本输入 ───────────────────────────────────────────────────────────

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  keyboardType,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
}) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <TextInput
        style={[...inputStyle(!!error), multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.muted}
        keyboardType={keyboardType}
        multiline={multiline}
      />
    </FieldShell>
  );
}

// ── 日期选择 ───────────────────────────────────────────────────────────

/** 日历日 → 本地 `Date`（取当天中午，避开夏令时把零点挪到前一天）。 */
function dayToDate(day: CalendarDay): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function DateField({
  label,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  value: CalendarDay | null;
  onChange: (v: CalendarDay | null) => void;
  error?: string;
  hint?: string;
}) {
  const [iosOpen, setIosOpen] = useState(false);

  const open = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: value ? dayToDate(value) : new Date(),
        mode: 'date',
        // 只选年月日。带时刻的日期在 §2.6 的口径下是错的
        onChange: (e: DateTimePickerEvent, picked?: Date) => {
          if (e.type === 'set' && picked) onChange(dayOf(picked));
        },
      });
    } else {
      setIosOpen(true);
    }
  };

  return (
    <FieldShell label={label} error={error} hint={hint}>
      <View style={styles.dateRow}>
        <Pressable style={[inputStyle(!!error), styles.dateBtn]} onPress={open}>
          <Text style={value ? styles.dateValue : styles.datePlaceholder}>
            {value ?? '未填'}
          </Text>
        </Pressable>
        {/* 这四个字段都是可选的，「清除」不是可有可无的装饰：
            没有它，选错了日期就只能靠再选一次来「改」，改不回空 */}
        {value ? (
          <Pressable style={styles.clearBtn} onPress={() => onChange(null)} hitSlop={8}>
            <Text style={styles.clearText}>清除</Text>
          </Pressable>
        ) : null}
      </View>

      {iosOpen ? (
        <DateTimePicker
          value={value ? dayToDate(value) : new Date()}
          mode="date"
          display="spinner"
          onChange={(e, picked) => {
            setIosOpen(false);
            if (e.type === 'set' && picked) onChange(dayOf(picked));
          }}
        />
      ) : null}
    </FieldShell>
  );
}

// ── 文本 + 建议 ────────────────────────────────────────────────────────

/**
 * 自由文本 + 一排可点即填的建议。
 *
 * ⚠️ **不能**做成「只能从建议里选」的下拉：真实的存放位置里有「床头柜」，
 * 不在预设列表里。做成封闭列表，这些数据就没法原样录进去，
 * 编辑一次就把用户自己起的名字改掉了。
 */
export function SuggestField({
  label,
  value,
  onChangeText,
  suggestions,
  placeholder,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  suggestions: readonly string[];
  placeholder?: string;
  error?: string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <TextInput
        style={inputStyle(!!error)}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.muted}
      />
      <View style={styles.suggestRow}>
        {suggestions.map((s) => (
          <Pressable
            key={s}
            style={[styles.choice, value === s && styles.choiceOn]}
            onPress={() => onChangeText(value === s ? '' : s)}
          >
            <Text style={[styles.suggestText, value === s && styles.choiceTextOn]}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </FieldShell>
  );
}

// ── 单选（单位 / 归属 / 剂型这类枚举） ─────────────────────────────────

export type Choice = { value: string; label: string };

/**
 * 一排可换行的选项按钮。`value === null` 表示「未选」，
 * 传 `noneLabel` 会额外给一个代表 null 的选项（比如归属的「家庭共用」）。
 */
export function ChoiceField({
  label,
  value,
  options,
  onChange,
  error,
  hint,
  noneLabel,
}: {
  label: string;
  value: string | null;
  options: Choice[];
  onChange: (v: string | null) => void;
  error?: string;
  hint?: string;
  noneLabel?: string;
}) {
  const all: Choice[] = noneLabel ? [{ value: '', label: noneLabel }, ...options] : options;
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <View style={styles.choiceRow}>
        {all.map((o) => {
          const selected = (value ?? '') === o.value;
          return (
            <Pressable
              key={o.value || '__none'}
              style={[styles.choice, selected && styles.choiceOn]}
              onPress={() => onChange(o.value === '' ? null : o.value)}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}

// ── 按钮 ───────────────────────────────────────────────────────────────

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
}) {
  const box = kind === 'primary' ? buttonPrimary : buttonGhost;
  const textStyle =
    kind === 'primary'
      ? buttonLabel
      : kind === 'danger'
        ? { ...buttonGhostLabel, color: tone.danger.text }
        : buttonGhostLabel;
  return (
    <Pressable
      style={[box, styles.btn, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

/** 页面底部固定的一排按钮。 */
export function ButtonBar({ children }: { children: ReactNode }) {
  return <View style={styles.buttonBar}>{children}</View>;
}

// ── 底部弹层（取用数量、丢弃原因、删除确认这类临时输入） ───────────────

/**
 * 从底部升起的弹层。
 *
 * 为什么不用 `Alert.prompt`：**它在安卓上根本不存在**（只有 iOS 有）。
 * 用 `Alert.prompt` 写出来的取用输入框在小米8 上会静默地什么都不弹。
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={text.title}>{title}</Text>
        <ScrollView
          style={styles.sheetBody}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.sheetBodyContent}
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** 表单里的一行错误提醒（整体性的失败，不属于任何单个字段）。 */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <Text style={styles.formError}>{message}</Text>;
}

const styles = StyleSheet.create({
  field: { marginBottom: space.lg },
  label: { fontSize: font.small, color: color.muted, marginBottom: space.xs },
  error: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.xs },
  hint: { fontSize: font.tiny, color: color.muted, marginTop: space.xs },

  input: {
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: font.base,
    color: color.ink,
  },
  inputError: { borderColor: tone.danger.bd, backgroundColor: tone.danger.bg },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },

  dateRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dateBtn: { flex: 1, justifyContent: 'center' },
  dateValue: { fontSize: font.base, color: color.ink },
  datePlaceholder: { fontSize: font.base, color: color.muted },
  clearBtn: { paddingHorizontal: space.sm, paddingVertical: 8 },
  clearText: { fontSize: font.small, color: color.brand },

  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  suggestText: { fontSize: font.tiny, color: color.muted },
  choice: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  choiceOn: { backgroundColor: color.brandSoft, borderColor: color.brandSoft2 },
  choiceText: { fontSize: font.small, color: color.ink },
  choiceTextOn: { color: color.brandStrong, fontWeight: '700' },

  btn: { flex: 1 },
  btnDisabled: { opacity: 0.45 },
  buttonBar: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.lg,
    borderTopWidth: 1,
    borderTopColor: color.line,
    backgroundColor: color.bgTop,
  },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.28)' },
  sheet: {
    backgroundColor: color.bgTop,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    maxHeight: '80%',
  },
  sheetBody: { marginTop: space.md },
  sheetBodyContent: { paddingBottom: space.md },

  formError: {
    fontSize: font.small,
    color: tone.danger.text,
    backgroundColor: tone.danger.bg,
    borderWidth: 1,
    borderColor: tone.danger.bd,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
    lineHeight: 20,
  },
});
