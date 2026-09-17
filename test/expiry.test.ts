/**
 * 效期分档 —— 逐条移植自 `../medbox-app/tests/test_expiry.py`（11 条）。
 *
 * 上游的函数名标在每条用例的注释里，方便对着核；上游没有的补充用例单独标「补充」。
 *
 * 为什么值得翻译：这一层算出的「提醒日」直接决定首页那个药丸是
 * 灰色（未填效期）／黄色（快过期）／红色（已过期）。**算错了用户看不出来** ——
 * 药就搁在箱子里，谁也不会去翻印刷效期跟 App 上的数核对。
 */
import { addDays } from '../src/domain/calendar';
import { EXPIRY_EXPIRED, EXPIRY_EXPIRING, EXPIRY_NONE, EXPIRY_OK } from '../src/domain/constants';
import { classify, effectiveExpiry, isExpiredOrUnknown, type ExpiryInput } from '../src/domain/expiry';

/** 上游的 `TODAY`。所有用例都相对它算，所以断言里的日期是人能心算出来的。 */
const TODAY = '2026-09-03';

/**
 * 上游的 `b()`：一个只有效期三件套的批次。
 *
 * 三个字段都有默认值 —— 好处是**每个用例只说它关心的那个字段**，
 * 没提到的就是「没填」。这样一眼能看出这个用例在验什么，
 * 而不是被一堆无关的 `expiryDate: null` 淹掉。
 */
function b(over: Partial<ExpiryInput> = {}): ExpiryInput {
  return { expiryDate: null, openedAt: null, openLifeDays: null, ...over };
}

/** 相对 TODAY 的第 n 天，免得到处写死日期字符串。 */
const day = (n: number) => addDays(TODAY, n);

describe('effectiveExpiry —— 提醒日怎么算', () => {
  it('没开封时，提醒日就是印刷效期', () => {
    // 上游 test_effective_uses_printed_expiry_when_unopened
    expect(effectiveExpiry(b({ expiryDate: '2027-01-01' }))).toBe('2027-01-01');
  });

  it('开封后会缩短：印刷效期还在 2028，开封 30 天 → 取开封推算的那天', () => {
    // 上游 test_opening_shortens_shelf_life。
    // 这是「开封后有效期」这个字段存在的全部意义 —— 没它的话，
    // 一瓶开了封的滴眼液会一直显示到 2028 年都「正常」。
    const batch = b({ expiryDate: '2028-01-01', openedAt: TODAY, openLifeDays: 30 });
    expect(effectiveExpiry(batch)).toBe(day(30));
  });

  it('印刷效期更早时取印刷效期（两个候选取 min）', () => {
    // 上游 test_printed_expiry_wins_when_sooner
    const batch = b({ expiryDate: day(10), openedAt: TODAY, openLifeDays: 30 });
    expect(effectiveExpiry(batch)).toBe(day(10));
  });

  it('没填印刷效期时，光靠开封推算也算得出提醒日', () => {
    // 上游 test_open_window_only_when_no_printed_expiry
    expect(effectiveExpiry(b({ openedAt: TODAY, openLifeDays: 30 }))).toBe(day(30));
  });

  it('开封了但没填开封天数 → 退回印刷效期', () => {
    // 上游 test_opened_without_window_falls_back_to_printed
    expect(effectiveExpiry(b({ expiryDate: '2027-03-01', openedAt: TODAY }))).toBe('2027-03-01');
  });

  it('补充：只填了开封天数、没填开封日期 —— 一样不算，两个必须同时有', () => {
    // requirements.md §2.2 对「开封后有效期」的约束是双向的：
    // `openedAt` 和 `openLifeDays` 缺任何一个都不进候选。
    // 上游只立了「缺天数」那一半，「缺日期」这一半没测 —— 而它是更危险的一半：
    // 开封日期缺失时若仍按天数算，就得凭空假设一个起算点。
    expect(effectiveExpiry(b({ expiryDate: '2027-03-01', openLifeDays: 30 }))).toBe('2027-03-01');
    expect(effectiveExpiry(b({ openLifeDays: 30 }))).toBeNull();
  });

  it('两样都没有 = 未填效期（null）', () => {
    // 上游 test_no_expiry_info_returns_none
    expect(effectiveExpiry(b())).toBeNull();
  });
});

describe('classify —— 已过期 / 快过期 / 正常 / 未填效期', () => {
  it('昨天到期 = 已过期', () => {
    // 上游 test_classify_expired
    expect(classify(b({ expiryDate: day(-1) }), TODAY, 90)).toBe(EXPIRY_EXPIRED);
  });

  it('今天到期 = 快过期，**不算**已过期', () => {
    // 上游 test_classify_expiring_today_counted。
    // 两处边界刻意不对称：已过期是严格 `< 今天`，快过期是两头都含。
    // 差别就在这一天 —— 「今天还能吃」的药被染成红色，会让人直接扔了它。
    expect(classify(b({ expiryDate: TODAY }), TODAY, 90)).toBe(EXPIRY_EXPIRING);
  });

  it('快过期的边界两头都含：正好第 90 天算，第 91 天才算正常', () => {
    // 上游 test_classify_boundary_near_days
    expect(classify(b({ expiryDate: day(90) }), TODAY, 90)).toBe(EXPIRY_EXPIRING);
    expect(classify(b({ expiryDate: day(91) }), TODAY, 90)).toBe(EXPIRY_OK);
  });

  it('200 天后 = 正常', () => {
    // 上游 test_classify_ok
    expect(classify(b({ expiryDate: day(200) }), TODAY, 90)).toBe(EXPIRY_OK);
  });

  it('没填效期是独立的一档，不算快过期', () => {
    // 上游 test_classify_none。这一档不是为了好看：存量数据里 44 条在库批次
    // 有 13 条没填效期，把它们混进「快过期」会让首页亮出 13 个黄药丸，
    // 用户不知道那是什么意思，也就学会了忽略黄色。
    expect(classify(b(), TODAY, 90)).toBe(EXPIRY_NONE);
  });

  it('补充：印刷效期还很远、但开封把提醒日拉到眼前 → 分档跟着走', () => {
    // 这条是防「classify 绕过 effectiveExpiry 直接看印刷效期」的。
    // 那种写法上面每条用例都还能过 —— 因为那些用例里两个日期是同一个。
    // 只有印刷效期和开封推算**不一致**时才分得出来。
    const batch = b({ expiryDate: '2028-01-01', openedAt: TODAY, openLifeDays: 30 });
    expect(classify(batch, TODAY, 90)).toBe(EXPIRY_EXPIRING);
  });

  it('补充：阈值设成 0 天时，「今天到期」仍算快过期，但昨天到期还是已过期', () => {
    // 阈值 0 不等于「关掉快过期」—— 因为快过期的下界是 `今天`，
    // 与阈值无关。网页版把阈值做成可配置项，所以这条要钉住。
    expect(classify(b({ expiryDate: TODAY }), TODAY, 0)).toBe(EXPIRY_EXPIRING);
    expect(classify(b({ expiryDate: day(-1) }), TODAY, 0)).toBe(EXPIRY_EXPIRED);
    expect(classify(b({ expiryDate: day(1) }), TODAY, 0)).toBe(EXPIRY_OK);
  });
});

/**
 * `isExpiredOrUnknown` 在上游没有对应函数，它是 `autodose._fefo_key` 里
 * 「过期盒排到最后」那一半规则的提取。**上线前一条测试都没有** ——
 * 而它决定自动扣减先从哪一盒扣，正是「算错了用户看不出来」的重灾区。
 */
describe('isExpiredOrUnknown —— 自动扣减挑盒用（上游 `_fefo_key`）', () => {
  it('已过期和未填效期都算「该排到最后」', () => {
    // 上游把这两类归成同一档。分开的话，「先吃没写效期的」
    // 会成为自动扣减的默认行为 —— 那是在拿用户冒险。
    expect(isExpiredOrUnknown(b({ expiryDate: day(-1) }), TODAY)).toBe(true);
    expect(isExpiredOrUnknown(b(), TODAY)).toBe(true);
  });

  it('今天到期**不算** —— 今天还能吃', () => {
    // 与 classify 一致地用严格 `<`。这里若写成 `<=`，
    // 今天到期的药会被自动扣减整个跳过去：用户当天吃了药，账却没扣。
    expect(isExpiredOrUnknown(b({ expiryDate: TODAY }), TODAY)).toBe(false);
    expect(isExpiredOrUnknown(b({ expiryDate: day(1) }), TODAY)).toBe(false);
  });

  it('按提醒日判定，不是按印刷效期', () => {
    // 印刷效期在 2028，但 40 天前开封、开封后只能放 30 天 → 实际早就过期了。
    const batch = b({ expiryDate: '2028-01-01', openedAt: day(-40), openLifeDays: 30 });
    expect(isExpiredOrUnknown(batch, TODAY)).toBe(true);
  });
});
