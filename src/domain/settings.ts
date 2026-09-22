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

// ── 提醒时间（M5）─────────────────────────────────────────────────────

export type NotifyTimeResult = { ok: true; hour: number; minute: number } | { ok: false; error: string };

/**
 * 解析 `'HH:mm'`。
 *
 * 三种失败分开报，理由同上面的阈值：对着 `'9:65'` 说「时间需为 HH:MM 格式」
 * 会让人一头雾水（它的形状没问题）。
 *
 * **读宽松、写严格**：小时允许少写前导零（`'9:05'` 收），但写回库时一律走
 * `normalizeNotifyTime` 补成 `'09:05'`。因为时刻会拼进通知的标识符，而标识符是
 * **比较**用的 —— 同一个时刻有两种写法，重排就会把同一条通知认成两条。
 */
export function parseNotifyTime(raw: string): NotifyTimeResult {
  const s = (raw ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(s)) return { ok: false, error: '提醒时间需为 HH:MM 格式' };
  const col = s.indexOf(':');
  const hour = Number(s.slice(0, col));
  const minute = Number(s.slice(col + 1));
  if (hour > 23) return { ok: false, error: '小时需在 0-23 之间' };
  if (minute > 59) return { ok: false, error: '分钟需在 0-59 之间' };
  return { ok: true, hour, minute };
}

/** `(9, 5)` → `'09:05'`。写库前一律过一遍，保证库里只有一种写法。 */
export function normalizeNotifyTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
