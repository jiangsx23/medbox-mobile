/**
 * 药品档案的字段组 —— 新建与编辑共用。
 *
 * ── 为什么抽出来（与 `batchform.tsx` 同一个理由）────────────────────────
 * 两张表单 10 个字段全都一样，而且**字段顺序和措辞是需求的一部分**。
 * 各写一份迟早会漂移成「新建叫『用途备注』、编辑叫『备注』」。
 * 两张表单真正的差别只有一处：编辑时要知道**更新前是什么**，
 * 才能把「这次保存会改动库存」这件事说清楚 —— 也就是下面那个 `prev`。
 *
 * ── 「会扣库存」这句话必须由落库那边的判断来驱动 ─────────────────────────
 * 改每日用量或开关会真的改库存（先按旧参数结清、再以今天重新起算）。
 * 用户改完看到药少了一截，**第一反应会是 App 算错了**。所以这里必须写明
 * 「会先结清」。但这句话只在真的会结算时才对 —— 所以它由
 * `autoWouldChange()`（与 `planMedicineUpdate` 共用的那一个）决定要不要出现，
 * 而不是在这里另判一次。**提示说错了比不提示更糟**。
 *
 * ── 没开自动扣减时改每日用量，什么都不说 ─────────────────────────────────
 * 那种情况下库存一动不动（自动扣减本来就没在跑），每日用量只影响「可用天数」
 * 这个展示值。此时弹一句「会先结清」纯属吓唬人。
 */
import { StyleSheet, Switch, Text, View } from 'react-native';

import type { AutoMedicine } from '../domain/autodose';
import { MEDICINE_CATEGORIES, MEDICINE_FORMS, MEDICINE_UNITS } from '../domain/constants';
import { formatDose } from '../domain/forecast';
import type { MedicineForm } from '../domain/medicine';
import { autoWouldChange, doseOf } from '../domain/medicine';
import { Card } from './components';
import { ChoiceField, TextField } from './form';
import { color, font, radius, space, text, tone } from './theme';

export function emptyMedicineForm(): MedicineForm {
  return {
    generic: '',
    brand: '',
    spec: '',
    form: '',
    category: '',
    purposeNotes: '',
    dailyDose: '',
    unit: '',
    ownerId: '',
    autoDeduct: false,
  };
}

/**
 * 这次保存会不会动库存？会的话用两句话说清楚。
 *
 * 三种真会发生的情况 + 一种**刻意返回 null**（见文件头最后一段）。
 */
function autoNotice(
  prev: AutoMedicine,
  values: MedicineForm,
): { title: string; body: string } | null {
  if (!autoWouldChange(prev, values)) return null;

  const turningOn = !prev.autoDeduct && values.autoDeduct;
  const turningOff = prev.autoDeduct && !values.autoDeduct;
  // 本来没开、也没打开 —— 库存一动不动，别吓唬人
  if (!turningOn && !turningOff) return null;

  const fmt = (n: number | null) => (n === null ? '—' : formatDose(n));

  if (turningOn) {
    return {
      title: '开启自动扣减',
      body: `起算日设为今天 —— 之前没扣的不会补回来。以后每天按 ${fmt(doseOf(values))} 扣。`,
    };
  }

  // 关掉开关。暂停中的药没有旧账可结（暂停期间整个作废），
  // 别跟着说「照样扣掉」—— 那是句假话
  if (prev.autoPaused) {
    return {
      title: '关闭自动扣减',
      body: '这个药正在暂停服药中，不会有补扣 —— 只是把起算日推到今天。',
    };
  }
  return {
    title: '关闭自动扣减',
    body: '关掉也会先结清 —— 那几天已经吃过的药会照样扣掉。',
  };
}

export function MedicineFormFields({
  values,
  onChange,
  errors,
  members,
  /** 更新前的档案快照。**新建时不传** —— 没有旧账，也就没有那句提示 */
  prev,
}: {
  values: MedicineForm;
  onChange: (patch: Partial<MedicineForm>) => void;
  errors: Record<string, string>;
  members: { id: number; name: string }[];
  prev?: AutoMedicine;
}) {
  const notice = prev ? autoNotice(prev, values) : null;

  return (
    <>
      <TextField
        label="通用名"
        value={values.generic}
        onChangeText={(v) => onChange({ generic: v })}
        placeholder="缬沙坦胶囊"
        error={errors.generic}
      />
      <TextField
        label="品牌（可不填）"
        value={values.brand}
        onChangeText={(v) => onChange({ brand: v })}
        placeholder="代文"
      />
      <TextField
        label="规格（可不填）"
        value={values.spec}
        onChangeText={(v) => onChange({ spec: v })}
        placeholder="80mg×7 粒"
      />
      <ChoiceField
        label="剂型"
        value={values.form || null}
        options={MEDICINE_FORMS.map((f) => ({ value: f, label: f }))}
        onChange={(v) => onChange({ form: v ?? '' })}
      />
      <ChoiceField
        label="类别"
        value={values.category || null}
        options={MEDICINE_CATEGORIES.map((c) => ({ value: c, label: c }))}
        onChange={(v) => onChange({ category: v ?? '' })}
      />
      <TextField
        label="用途备注（可不填）"
        value={values.purposeNotes}
        onChangeText={(v) => onChange({ purposeNotes: v })}
        placeholder="降压、饭后吃、医嘱…"
        multiline
      />

      <ChoiceField
        label="单位"
        value={values.unit || null}
        options={MEDICINE_UNITS.map((u) => ({ value: u, label: u }))}
        onChange={(v) => onChange({ unit: v ?? '' })}
        error={errors.unit}
        // 这条提示不是装饰：单位按「盒/瓶」记时算不出可用天数，
        // 而算不出天数的药不会出现在「该补货了」里
        hint="入库时的默认单位。按「片 / 粒」记才能算可用天数"
      />
      <ChoiceField
        label="归属"
        value={values.ownerId || null}
        noneLabel="家庭共用"
        options={members.map((m) => ({ value: String(m.id), label: m.name }))}
        onChange={(v) => onChange({ ownerId: v ?? '' })}
        error={errors.ownerId}
        hint="只是标「谁在吃」，不涉及账号"
      />

      {/* ── 自动扣减 ──────────────────────────────────────────────── */}
      <Card style={styles.autoCard}>
        <View style={styles.autoRow}>
          <View style={styles.autoLabel}>
            <Text style={styles.autoTitle}>自动扣减</Text>
            <Text style={text.tiny}>每天自动按用量扣一次，不用手动记「取用」</Text>
          </View>
          <Switch
            value={values.autoDeduct}
            onValueChange={(v) => onChange({ autoDeduct: v })}
            trackColor={{ true: color.brand, false: color.line }}
            thumbColor={color.white}
          />
        </View>

        <TextField
          label="每日用量"
          value={values.dailyDose}
          onChangeText={(v) => onChange({ dailyDose: v })}
          placeholder="比如 1 或 0.5"
          keyboardType="decimal-pad"
          error={errors.dailyDose}
          hint="可以是小数。不勾自动扣减也可以填 —— 用来算还能吃几天"
        />

        {notice ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>{notice.title}</Text>
            <Text style={styles.noticeBody}>{notice.body}</Text>
            <Text style={styles.noticeFoot}>
              这条改动会留下一条自动扣减记录，原来的记录不会被动。
            </Text>
          </View>
        ) : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  autoCard: { backgroundColor: color.cardWarm },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  autoLabel: { flex: 1, gap: 2 },
  autoTitle: { fontSize: font.base, fontWeight: '700', color: color.ink },

  notice: {
    borderWidth: 1,
    borderColor: tone.warn.bd,
    backgroundColor: tone.warn.bg,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.sm,
  },
  noticeTitle: { fontSize: font.small, fontWeight: '700', color: tone.warn.text },
  noticeBody: { fontSize: font.small, color: color.ink, marginTop: 4, lineHeight: 20 },
  noticeFoot: { fontSize: font.tiny, color: color.muted, marginTop: 6, lineHeight: 17 },
});
