/**
 * 设置项里**需要校验的那几个** —— 目前只有首页那两个阈值。
 *
 * 为什么单独一个模块而不是直接写在设置页里：这两条规则是纯的（不查库），
 * 按项目分层（`domain` = 纯函数 + 测试，`data` = 只做 IO）就该落在这里，
 * 而且落在界面里就没法测。规则本身照抄网页版 `app/routes/settings.py`，
 * **连文案都一样** —— 两个版本对同一份错误给出不同说法，用户会以为是两回事。
 */

/** 校验失败时按字段收集问题（键名 = 表单字段名），一次告诉用户（§3.2）。 */
export type ThresholdErrors = Record<string, string>;

export type ThresholdResult =
  | { ok: true; nearDays: number; restockDays: number }
  | { ok: false; errors: ThresholdErrors };

/**
 * 解析一个「天数字段」。三种失败要分开报，所以不能直接用 `parseQty`：
 * 它把「不是整数」和「不是正数」都收成 `null`，而这两种要说不同的话 ——
 * 对着 `-5` 报「阈值需为整数」会让用户一头雾水，它明明是个整数。
 */
type Parsed = { n: number } | { bad: '整数' | '正数' };

function parsePositiveInt(raw: string): Parsed {
  const s = (raw ?? '').trim();
  // 形状先判：Python 的 int() 接受前后空格和正负号，所以这里也接受，
  // 让 `-5` 走到「正数」那条而不是被当成「不是整数」
  if (!/^[+-]?\d+$/.test(s)) return { bad: '整数' };
  const n = Number(s);
  return n > 0 ? { n } : { bad: '正数' };
}

/**
 * 校验两个阈值。两个都错就两条一起回来 —— 否则用户改完一个再发现另一个也不行，
 * 白跑一趟。
 */
export function parseThresholds(nearRaw: string, restockRaw: string): ThresholdResult {
  const errors: ThresholdErrors = {};

  const take = (raw: string, key: string): number | null => {
    const p = parsePositiveInt(raw);
    if ('n' in p) return p.n;
    errors[key] = p.bad === '整数' ? '阈值需为整数' : '阈值需为大于 0 的天数';
    return null;
  };

  const nearDays = take(nearRaw, 'nearDays');
  const restockDays = take(restockRaw, 'restockDays');

  if (nearDays === null || restockDays === null) return { ok: false, errors };
  return { ok: true, nearDays, restockDays };
}
