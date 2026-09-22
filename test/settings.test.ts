/**
 * 阈值输入校验 —— 规则与文案都照抄网页版 `app/routes/settings.py`。
 *
 * 为什么值得单独测：这两个数**用户以为能改坏库存**。它们其实只影响首页分档，
 * 但如果校验松了（比如把 `abc` 当成 0 存进去），`classify` 拿到的阈值就会是
 * 0 —— 首页所有药都变成「快过期」，而用户刚做的是「改个设置」，
 * 他不会把这两件事联系起来。所以「什么能存进去」要钉死。
 */
import {
  DEFAULT_NEAR_EXPIRY_DAYS,
  DEFAULT_NOTIFY_TIME,
  DEFAULT_RESTOCK_DAYS,
} from '../src/domain/constants';
import {
  normalizeNotifyTime,
  parseNotifyTime,
  parseThresholds,
} from '../src/domain/settings';

describe('parseThresholds —— 阈值输入校验', () => {
  it('正常整数通过，原样返回', () => {
    expect(parseThresholds('90', '15')).toEqual({ ok: true, nearDays: 90, restockDays: 15 });
    expect(parseThresholds('30', '7')).toEqual({ ok: true, nearDays: 30, restockDays: 7 });
  });

  it('0 和负数都不行 —— 报「需为大于 0 的天数」，**不是**「需为整数」', () => {
    // 这两句文案的区别是有意义的：对着 `-5` 说「需为整数」会让用户一头雾水，
    // 它明明是个整数。所以形状和范围要分成两条规则。
    expect(parseThresholds('0', '15')).toEqual({
      ok: false,
      errors: { nearDays: '阈值需为大于 0 的天数' },
    });
    expect(parseThresholds('-5', '15')).toEqual({
      ok: false,
      errors: { nearDays: '阈值需为大于 0 的天数' },
    });
  });

  it('不是整数的报「需为整数」：小数、字母、空、科学计数法', () => {
    for (const bad of ['1.5', 'abc', '', '  ', '1e3', '0x10', '90天']) {
      const res = parseThresholds(bad, '15');
      expect(res).toEqual({ ok: false, errors: { nearDays: '阈值需为整数' } });
    }
  });

  it('前后空格与正号是允许的（Python 的 int() 也接受）', () => {
    expect(parseThresholds(' 90 ', '+15')).toEqual({ ok: true, nearDays: 90, restockDays: 15 });
  });

  it('**两个都错时两条一起回来** —— 不让用户改一个再发现另一个也不行', () => {
    const res = parseThresholds('abc', '0');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('不该通过');
    expect(res.errors).toEqual({
      nearDays: '阈值需为整数',
      restockDays: '阈值需为大于 0 的天数',
    });
  });

  it('错误键名就是表单字段名（界面按 `errors.<字段>` 取）', () => {
    const res = parseThresholds('abc', 'xyz');
    if (res.ok) throw new Error('不该通过');
    expect(Object.keys(res.errors).sort()).toEqual(['nearDays', 'restockDays']);
  });

  it('默认值本身是合法的 —— 否则用户一打开设置页就保存会失败', () => {
    const res = parseThresholds(String(DEFAULT_NEAR_EXPIRY_DAYS), String(DEFAULT_RESTOCK_DAYS));
    expect(res.ok).toBe(true);
  });
});

// ── 提醒时间（M5）────────────────────────────────────────────────────

describe('parseNotifyTime —— 提醒时间校验', () => {
  it('HH:mm 通过，拆成两个数字', () => {
    expect(parseNotifyTime('09:00')).toEqual({ ok: true, hour: 9, minute: 0 });
    expect(parseNotifyTime('23:59')).toEqual({ ok: true, hour: 23, minute: 59 });
    expect(parseNotifyTime('00:00')).toEqual({ ok: true, hour: 0, minute: 0 });
  });

  it('小时少写前导零也收（读宽松），补零交给 normalizeNotifyTime（写严格）', () => {
    // 分开的理由：时刻会拼进通知的**标识符**，而标识符是比较用的 ——
    // 同一个时刻有两种写法，重排就会把同一条通知认成两条。
    expect(parseNotifyTime('9:05')).toEqual({ ok: true, hour: 9, minute: 5 });
    expect(normalizeNotifyTime(9, 5)).toBe('09:05');
  });

  it('分钟必须两位 —— `9:5` 是形状错，不是范围错', () => {
    expect(parseNotifyTime('9:5')).toEqual({ ok: false, error: '提醒时间需为 HH:MM 格式' });
    expect(parseNotifyTime('09:0')).toEqual({ ok: false, error: '提醒时间需为 HH:MM 格式' });
  });

  it('范围和形状分开报 —— 对着 `9:65` 说「格式不对」会让人一头雾水', () => {
    expect(parseNotifyTime('25:00')).toEqual({ ok: false, error: '小时需在 0-23 之间' });
    expect(parseNotifyTime('09:65')).toEqual({ ok: false, error: '分钟需在 0-59 之间' });
  });

  it('乱七八糟的输入一律不收', () => {
    for (const bad of ['', '  ', 'nine', '9', '9.30', '-9:00', '09:00:00', '09：00']) {
      expect(parseNotifyTime(bad).ok).toBe(false);
    }
  });

  it('前后空格是容忍的（库里存过带空格的值也不该炸）', () => {
    expect(parseNotifyTime(' 09:00 ')).toEqual({ ok: true, hour: 9, minute: 0 });
  });

  it('normalizeNotifyTime 一定补成两位 —— 它是「库里只有一种写法」的保证', () => {
    expect(normalizeNotifyTime(0, 0)).toBe('00:00');
    expect(normalizeNotifyTime(9, 5)).toBe('09:05');
    expect(normalizeNotifyTime(23, 59)).toBe('23:59');
  });

  it('默认提醒时间本身是合法的 —— 否则没改过设置的用户连队列都排不出来', () => {
    expect(parseNotifyTime(DEFAULT_NOTIFY_TIME).ok).toBe(true);
  });

  it('往返：normalize 之后再 parse，回到原来的两个数', () => {
    for (const [h, m] of [[0, 0], [8, 5], [9, 0], [23, 59]]) {
      expect(parseNotifyTime(normalizeNotifyTime(h, m))).toEqual({ ok: true, hour: h, minute: m });
    }
  });
});
