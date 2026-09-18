/**
 * 药品档案的新建与编辑 —— **纯规则**，一行数据库都不碰。
 *
 * ── 为什么校验在这里而不在 data 层 ───────────────────────────────────────
 * `src/data/members.ts` 的 `validateName` 之所以留在 data 层，是因为它要
 * **查库**判断重名。分界线是「要不要查库」，不是「是不是校验」。
 * 这里四条规则（通用名非空 / 单位非空 / 每日用量的形状 / 勾了自动扣减就得填）
 * 没有一条需要查库，所以按项目分层落在 domain，顺带也就测得到。
 *
 * ── 编辑档案是本项目最危险的一次写操作 ───────────────────────────────────
 * 改「每日用量」或「自动扣减开关」会**改动真实库存**：系统要按旧参数把欠的账
 * 结清、再以今天为新起算日（§3.6）。而账算错了用户**看不出来** —— 药盒上的
 * 数字不会自己核对。这比自动扣减本身风险更高：自动扣减是幂等的每日一扣，
 * 改剂量却可能一次性补扣一大笔。
 *
 * 上游 `routes/medicines.py` 为此写了三步：`settle_medicine()` → 逐字段赋新值 →
 * `rebaseline(settle_first=False)`，并留了一句警告「顺序不能反，settle_medicine
 * 读的就是 med.daily_dose」。这里**塌缩成一次调用**，让那个顺序**写不出来**：
 * `planRebaseline` 拿到的是 `prev`（更新前的快照），新值只存在于另一个类型的
 * 对象里，而且那个类型里根本没有账本字段可写。靠纪律不如靠类型。
 */
import type { AutoBatch, AutoMedicine } from './autodose';
import { planRebaseline } from './autodose';
import type { CalendarDay } from './calendar';
import type { Plan } from './stock';
import { mergeSettlement } from './stock';

/**
 * 档案表单。字段名 = 将来那个表单的字段名 = **错误对象的键名**
 * （`src/ui/form.tsx` 按 `errors.<字段>` 取）。
 *
 * 一律以字符串进来，在这里收口成领域值 —— 与 `IntakeForm` / `EditForm` 同规矩。
 * 唯一的例外是 `autoDeduct`：开关只有两态，没有「可解析的东西」，
 * 上游 `bool(auto_deduct)` 是在字符串上做真值判断，类型化之后那类 bug
 * （`'false'` 被当成真）从「容易犯」变成「写不出来」。
 */
export type MedicineForm = {
  generic: string;
  brand: string;
  spec: string;
  form: string;
  category: string;
  purposeNotes: string;
  dailyDose: string;
  unit: string;
  /** 空字符串 = 家庭共用；非空必须是成员 id */
  ownerId: string;
  autoDeduct: boolean;
};

/**
 * 档案里**只影响以后**的字段。
 *
 * ⚠️ 刻意**不含** `autoFrom` / `autoAccounted`：账本只有 `planRebaseline`
 * 能改（不变量 5），所以「档案行的 UPDATE 顺手把账本覆盖掉」这件事
 * 在类型上就写不出来 —— 这正是 `updateMedicine` 里那两条语句能安全地
 * 先后执行的原因。
 */
export type MedicineFields = {
  generic: string;
  brand: string | null;
  spec: string | null;
  form: string | null;
  category: string | null;
  purposeNotes: string | null;
  dailyDose: number | null;
  unit: string;
  ownerId: number | null;
  autoDeduct: boolean;
  autoPaused: boolean;
};

/**
 * 新建时要写的整行。
 *
 * 这里**可以**带 `autoFrom` / `autoAccounted`，因为新建写的是**初值**而不是
 * 「改账本」—— 一行还不存在的记录谈不上账实不符。
 */
export type NewMedicine = MedicineFields & {
  autoFrom: CalendarDay | null;
  autoAccounted: number;
};

/**
 * 从库里读出来的档案行，**只列表单用得上的那些列**。
 *
 * ⚠️ `unit` 在这里**可空**，而 `MedicineFields.unit` 不可空 —— 这不是笔误：
 * 读和写的要求本来就不一样。数据库列可空，从网页版导进来的老数据里真的有
 * 单位是空的（`planIntake` 那句「该药品档案还没填单位，请先到「编辑档案」补上」
 * 就是为它们写的）；而写回库时单位必须已经填上，否则入库连「一盒有多少」都
 * 说不清。中间那道坎是 `validate()`。
 */
export type MedicineRow = {
  id: number;
  generic: string;
  brand: string | null;
  spec: string | null;
  form: string | null;
  category: string | null;
  purposeNotes: string | null;
  dailyDose: number | null;
  unit: string | null;
  ownerId: number | null;
  autoDeduct: boolean;
  autoPaused: boolean;
  autoFrom: CalendarDay | null;
  autoAccounted: number;
};

/**
 * 「校验 + 收口」的结果。刻意与 `stock.ts` 的 `OpResult` 分开：
 * 那个只有 `{plan}`，而档案编辑要**同时**交回「档案行要写的字段」和「要落的方案」，
 * 两样东西必须一起用（见 `updateMedicine` 的事务）。
 */
export type Validated<T> = { ok: true; values: T } | { ok: false; errors: Record<string, string> };

// ── 读取 / 表单初值 ────────────────────────────────────────────────────

/**
 * 数据库行 → 表单初值。**10 个字段全是手工映射**，所以它必须测得到
 * （`test/medicine.test.ts` 里有一条「打开就保存，什么都不改」的往返测试）。
 *
 * 写错一个字段的表现非常隐蔽：用户打开编辑页、碰都没碰、按保存，
 * 那个字段就被悄悄搬到了别的地方（或者变成空）——**没有任何报错**。
 *
 * 两处转换是这段代码的全部意义：
 * `dailyDose` 的 `null` 要变成**空串**（不是 `'0'`），
 * `ownerId` 的 `null` 要变成空串（代表「家庭共用」，不是 `'0'` —— 那会指向
 * 一个不存在的成员，而它恰好通过了「非空就得是数字」那条校验）。
 */
export function formOf(m: MedicineRow): MedicineForm {
  return {
    generic: m.generic,
    brand: m.brand ?? '',
    spec: m.spec ?? '',
    form: m.form ?? '',
    category: m.category ?? '',
    purposeNotes: m.purposeNotes ?? '',
    dailyDose: m.dailyDose === null ? '' : String(m.dailyDose),
    unit: m.unit ?? '',
    ownerId: m.ownerId === null ? '' : String(m.ownerId),
    autoDeduct: m.autoDeduct,
  };
}

// ── 解析 ───────────────────────────────────────────────────────────────

/** 可选文本：空白 = 不填（null）。 */
function orNull(s: string): string | null {
  return (s ?? '').trim() || null;
}

/**
 * 每日用量。三种输入要分开对待，所以不能直接用 `Number()`：
 *
 * - 空字符串 = **不填**（合法，`null`）—— 偶用药就是没有每日用量
 * - 填了但形状不对 = 报错
 * - 形状对但 ≤ 0 = 报错
 *
 * ⚠️ 也**不能**用 `parseQty`：它是给「几片」这种整数准备的，`1.5` 会被它判非法。
 * 而每日用量允许小数 —— 网页版的提示原文就是「需为大于 0 的数字（如 1 或 1.5）」。
 *
 * `Number('')` 会得到 `0`、`Number('1e3')` 会得到 `1000`、`Number('0x10')`
 * 会得到 `16` —— 直接用 `Number()` 太松，所以先判形状。
 */
function parseDose(raw: string): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * 表单里的每日用量 —— 与落库用的是同一个解析函数。
 *
 * 导出是为了让**界面能和落库走同一条判断**：编辑页的提示块要说「会先结清再重算」，
 * 而这句话只在真的会结算时才对。界面若自己写一份（`Number(values.dailyDose)`），
 * 迟早会和这里漂移 —— `Number('')` 是 0、`Number('abc')` 是 NaN，两个都不是
 * 「留空」的语义 —— 那时用户看到的解释就是假的。
 */
export function doseOf(form: MedicineForm): number | null {
  return parseDose(form.dailyDose);
}

/**
 * 这次保存会不会**动账本**（= 要不要跑结算）。
 *
 * `planMedicineUpdate` 与编辑页的提示块共用它，所以「界面说会发生什么」与
 * 「落库真的做什么」不可能对不上。判据只有剂量和开关两样：改单位/归属
 * 不算 —— 它们只对之后新入库的批次生效，不改写已有批次（否则就是静默篡改历史）。
 */
export function autoWouldChange(prev: AutoMedicine, form: MedicineForm): boolean {
  return prev.dailyDose !== doseOf(form) || prev.autoDeduct !== form.autoDeduct;
}

// ── 校验 ───────────────────────────────────────────────────────────────

/**
 * 四条规则，照抄上游 `_validate_medicine`。
 *
 * 一次收齐全部问题（§3.2「把所有问题一次告诉用户」），所以不 early return ——
 * 用户填错三处就该一次看到三条，而不是改一条存一次、试三遍。
 */
function validate(form: MedicineForm): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!(form.generic ?? '').trim()) errors.generic = '通用名：不能为空';
  if (!(form.unit ?? '').trim()) errors.unit = '单位：请选择或填写单位';

  const doseRaw = (form.dailyDose ?? '').trim();
  const dose = parseDose(doseRaw);
  if (doseRaw !== '' && dose === null) {
    // 填了东西但解析不出/不合法 —— 提示里带上「或留空」，
    // 否则用户不知道原来这个字段是可以不填的
    errors.dailyDose = '每日用量：需为大于 0 的数字（如 1 或 1.5），或留空';
  } else if (form.autoDeduct && dose === null) {
    errors.dailyDose = '每日用量：勾了「自动扣减」就得填，否则不知道每天扣多少';
  }

  // ⚠️ 刻意偏离上游：它这里是 `int(value) if value.isdigit() else None`，
  // 也就是把填错的归属**悄悄变成「家庭共用」**。归属是用药安全信息
  // （谁在吃这个药），静默改掉会让那些药从成员页消失而用户毫不知情。
  // `planEdit` 已经为同一类问题偏离过一次，跟随它报错。
  const ownerRaw = (form.ownerId ?? '').trim();
  if (ownerRaw && !/^-?\d+$/.test(ownerRaw)) errors.ownerId = '归属：请从列表中选择';

  return errors;
}

/** 校验通过后，把表单收口成要写库的那些字段。 */
function fieldsFrom(form: MedicineForm, prev: AutoMedicine | null): MedicineFields {
  const ownerRaw = (form.ownerId ?? '').trim();
  return {
    generic: form.generic.trim(),
    brand: orNull(form.brand),
    spec: orNull(form.spec),
    form: orNull(form.form),
    category: orNull(form.category),
    purposeNotes: orNull(form.purposeNotes),
    dailyDose: parseDose(form.dailyDose),
    unit: form.unit.trim(),
    ownerId: ownerRaw ? Number(ownerRaw) : null,
    autoDeduct: form.autoDeduct,
    // 只在**关→开**那一次清掉暂停（上游 `if auto and not prev_auto: auto_paused = False`）。
    // ⚠️ 不能写成「autoDeduct 为真就置 false」—— 那样一个暂停中的药，
    // 用户进去改个错别字就会被默默解除暂停，而编辑表单里根本没有暂停开关，
    // 他不会有任何察觉，只会发现药又开始被扣了。
    autoPaused: form.autoDeduct && prev !== null && !prev.autoDeduct ? false : (prev?.autoPaused ?? false),
  };
}

// ── 新建 ───────────────────────────────────────────────────────────────

/**
 * 新建档案。**不追溯**：起算日就是建档当天，已核算量从 0 开始。
 *
 * 不做重名检查，这是**照抄上游而不是漏了**：`members.name` 上有唯一索引所以
 * 成员那边有 `nameTaken`，而 `medicines` 上只有两个**非唯一**索引。
 * 「二甲双胍」与「二甲双胍缓释片」、同名的不同规格都是正常数据，加检查会挡掉合法输入。
 */
export function planMedicineCreate(
  form: MedicineForm,
  today: CalendarDay,
): Validated<NewMedicine> {
  const errors = validate(form);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const fields = fieldsFrom(form, null);
  return {
    ok: true,
    values: {
      ...fields,
      // 没勾自动扣减时**刻意留空**而不是写 today：写 today 会让一个从没启用过的药
      // 看起来像已经起算过，详情页上的「起算日」会凭空多出一行
      autoFrom: fields.autoDeduct ? today : null,
      autoAccounted: 0,
    },
  };
}

// ── 编辑 ───────────────────────────────────────────────────────────────

/**
 * 编辑档案。返回「要写的字段」和「要落的结算方案」两样东西 ——
 * 调用方必须在**同一个事务**里写它们（见 `src/data/medicines.ts`）。
 *
 * `prev` 是**更新前**从库里读出来的那一行。这一点是这段代码的全部要害：
 * `planRebaseline(prev, …)` 拿旧参数算欠账，新值只出现在 `fields` 里。
 * 顺序反了会怎样？把每日 1 片改成 2 片，系统会拿**新的** 2 片/天去补算
 * 过去 10 天，一次扣掉 20 片（应该是 10）。
 */
export function planMedicineUpdate(
  prev: AutoMedicine,
  inStock: readonly AutoBatch[],
  form: MedicineForm,
  today: CalendarDay,
): { ok: true; fields: MedicineFields; plan: Plan } | { ok: false; errors: Record<string, string> } {
  const errors = validate(form);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const fields = fieldsFrom(form, prev);
  const autoChanged = autoWouldChange(prev, form);

  const plan: Plan = { patches: [], events: [] };

  if (autoChanged) {
    // settleFirst = true：旧账是**真实发生过的**，一笔勾销等于白送用户几天的药。
    // （注意这里对「关掉开关」同样适用 —— 上游 auto_changed 是对称的，
    // 那几天吃过的药照样要扣。测试里有一条专门钉住这个 parity。）
    //
    // 只改通用名/单位/归属时 autoChanged 为假，这里一句都不跑 ——
    // 否则用户改个错别字就会触发一次自动扣减 + 一条时间线记录。
    mergeSettlement(plan, planRebaseline(prev, inStock, today, true), prev);
  }

  return { ok: true, fields, plan };
}
