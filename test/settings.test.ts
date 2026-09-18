/**
 * 阈值输入校验 —— 规则与文案都照抄网页版 `app/routes/settings.py`。
 *
 * 为什么值得单独测：这两个数**用户以为能改坏库存**。它们其实只影响首页分档，
 * 但如果校验松了（比如把 `abc` 当成 0 存进去），`classify` 拿到的阈值就会是
 * 0 —— 首页所有药都变成「快过期」，而用户刚做的是「改个设置」，
 * 他不会把这两件事联系起来。所以「什么能存进去」要钉死。
 */
import { DEFAULT_NEAR_EXPIRY_DAYS, DEFAULT_RESTOCK_DAYS } from '../src/domain/constants';
import { parseThresholds } from '../src/domain/settings';

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
