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
 * 2. 初始值不同：入库用 `emptyBatchForm()`（见下），编辑由调用方把库里的现值填进去 ——
 *    这是调用方的初始值问题，不是字段本身的问题。
 *
 * ⚠️ **入库的初始值里，「开封后有效期」是有预填的（30 天），「印刷效期」「拆封日期」没有。**
 * 这不是写漏了 —— 2026-09-23 用户要求预填 30，理由与被推翻的那条「一律不预填」的区别
 * 见 `DEFAULT_OPEN_LIFE_DAYS` 的注释与 DESIGN.md §5.7。**别顺手把效期也填上。**
 */
import { DEFAULT_OPEN_LIFE_DAYS, MEDICINE_UNITS, STORAGE_LOCATIONS } from '../domain/constants';
import type { IntakeForm } from '../domain/stock';
import { ChoiceField, DateField, SuggestField, TextField } from './form';
import { Field } from './components';
import { Card } from './components';
import { text } from './theme';
import { Text, View } from 'react-native';

export type BatchFormValues = IntakeForm & { unit: string; ownerId: string };

/**
 * **入库**表单的初始值。
 *
 * 除了 `openLifeDays` 以外全是空串 —— 尤其**印刷效期与拆封日期必须留空**：
 * 一盒一个样，预填了最坏的后果是用户直接点确定、系统里记着一个**错的到期日**。
 * 而「开封后有效期」量的是**药品种类**的属性（同一种眼药水补十次都是同一个数），
 * 预填一个常见值省一次打字 —— 判据与取舍见 `constants.ts` 里的 `DEFAULT_OPEN_LIFE_DAYS`。
 *
 * ⚠️ **只有入库用它。** 编辑（`app/batch/[id]/edit.tsx`）自己从库里取值，
 * `open_life_days` 为 `null` 时就该显示空 —— 在那里预填 30 等于凭空写下一个库里没有的数，
 * 用户只是想改个数量、一保存就被悄悄改了到期日。
 */
export function emptyBatchForm(): BatchFormValues {
  return {
    qty: '',
    expiryDate: '',
    openedAt: '',
    openLifeDays: String(DEFAULT_OPEN_LIFE_DAYS),
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
        // 占位符**只在这个框空着的时候才可见** —— 而它现在空着只有两种情况：
        // ①入库时用户主动清掉（= 不想按开封期算）；②编辑时库里存的就是空。
        // 所以这句话要说的是「空着是什么意思」，而不是再报一个数字：
        // 原先写「比如 30」，用户清空后会看到灰字 30，**看着像已经填好了** ——
        // 而清空恰恰是我们在 §5.7 里认定的**安全方向**，不能被一行灰字吓回去。
        placeholder="留空 = 只按印刷效期算"
        keyboardType="number-pad"
        error={errors.openLifeDays}
        // §2.2：只填一个不算数 —— 必须和拆封日期同时填了才生效。
        // 这里不报错（用户可能正在填），只是说清规则
        //
        // ⚠️ 入库那句「默认 30 天，不对就改」**必须留着**：预填值的唯一风险是
        // 用户没意识到那是**我们填的**、不是从药盒上读来的。一句话的成本，换来
        // 「填进去的 30 被当成事实」这个误解不会发生。编辑模式下它不该出现 ——
        // 那里显示的是库里存的数，没有「默认」这回事。
        hint={
          mode === 'new'
            ? '默认 30 天，不对就改；要同时填了「拆封日期」才生效'
            : '要同时填了「拆封日期」才生效'
        }
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
