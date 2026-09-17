/**
 * 批次的字段组 —— 入库与编辑共用。
 *
 * ── 为什么抽出来 ───────────────────────────────────────────────────────
 * 两张表单 8 个字段里有 6 个完全相同（数量/印刷效期/拆封日期/开封后天数/
 * 存放位置/备注），而且**字段顺序和措辞是需求的一部分**（§3.2）。
 * 各写一份迟早会漂移成「入库叫『开封天数』、编辑叫『开封后有效期』」。
 *
 * ── 两张表单真正的差别只有两处 ─────────────────────────────────────────
 * 1. **单位和归属**：入库时是从药品档案继承的**只读**信息（§3.2 明确不再问），
 *    编辑时可以改（§3.3）。所以它们由 `mode` 决定是展示还是可编辑。
 * 2. 入库不预填效期/拆封/开封天数，编辑则把现值填进去 ——
 *    这是调用方的初始值问题，不是字段本身的问题。
 */
import { MEDICINE_UNITS, STORAGE_LOCATIONS } from '../domain/constants';
import type { IntakeForm } from '../domain/stock';
import { ChoiceField, DateField, SuggestField, TextField } from './form';
import { Field } from './components';
import { Card } from './components';
import { text } from './theme';
import { Text, View } from 'react-native';

export type BatchFormValues = IntakeForm & { unit: string; ownerId: string };

export function emptyBatchForm(): BatchFormValues {
  return {
    qty: '',
    expiryDate: '',
    openedAt: '',
    openLifeDays: '',
    location: '',
    notes: '',
    unit: '',
    ownerId: '',
  };
}

export function BatchFields({
  values,
  onChange,
  errors,
  mode,
  members,
  /** 入库时展示用的单位 / 归属名（来自药品档案，只读） */
  inheritedUnit,
  inheritedOwner,
}: {
  values: BatchFormValues;
  onChange: (patch: Partial<BatchFormValues>) => void;
  errors: Record<string, string>;
  mode: 'new' | 'edit';
  members: { id: number; name: string }[];
  inheritedUnit?: string;
  inheritedOwner?: string;
}) {
  return (
    <>
      {mode === 'new' ? (
        <Card>
          <Field label="单位" value={inheritedUnit || '—'} />
          <Field label="归属" value={inheritedOwner || '家庭共用'} />
          <Text style={[text.tiny, { marginTop: 8, lineHeight: 18 }]}>
            单位和归属跟着药品档案走，这里不用再填。要改请到「药品档案 → 编辑」。
          </Text>
        </Card>
      ) : (
        <>
          <ChoiceField
            label="单位"
            value={values.unit || null}
            options={MEDICINE_UNITS.map((u) => ({ value: u, label: u }))}
            onChange={(v) => onChange({ unit: v ?? '' })}
            error={errors.unit}
          />
          <ChoiceField
            label="归属"
            value={values.ownerId || null}
            noneLabel="家庭共用"
            options={members.map((m) => ({ value: String(m.id), label: m.name }))}
            onChange={(v) => onChange({ ownerId: v ?? '' })}
            error={errors.ownerId}
          />
        </>
      )}

      <TextField
        label="数量"
        value={values.qty}
        onChangeText={(v) => onChange({ qty: v })}
        placeholder={mode === 'new' ? '这一盒有多少' : '改成正的整数'}
        keyboardType="number-pad"
        error={errors.qty}
        hint={mode === 'edit' ? '改成 0 会把这一盒转成「已用完」' : undefined}
      />

      <DateField
        label="印刷效期"
        value={values.expiryDate || null}
        onChange={(v) => onChange({ expiryDate: v ?? '' })}
        error={errors.expiryDate}
        hint="药盒上印的有效期，没有就不填"
      />

      <DateField
        label="拆封日期"
        value={values.openedAt || null}
        onChange={(v) => onChange({ openedAt: v ?? '' })}
        error={errors.openedAt}
        hint="开了封才填"
      />

      <TextField
        label="开封后有效期（天）"
        value={values.openLifeDays}
        onChangeText={(v) => onChange({ openLifeDays: v })}
        placeholder="比如 30"
        keyboardType="number-pad"
        error={errors.openLifeDays}
        // §2.2：只填一个不算数 —— 必须和拆封日期同时填了才生效。
        // 这里不报错（用户可能正在填），只是说清规则
        hint="要同时填了「拆封日期」才生效"
      />

      <SuggestField
        label="存放位置"
        value={values.location}
        onChangeText={(v) => onChange({ location: v })}
        suggestions={STORAGE_LOCATIONS}
        placeholder="药箱·上层"
        error={errors.location}
      />

      <TextField
        label="备注"
        value={values.notes}
        onChangeText={(v) => onChange({ notes: v })}
        placeholder="给谁吃、医嘱、注意事项…"
        multiline
      />
    </>
  );
}
