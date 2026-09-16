/**
 * 「暖居药箱」设计系统 → React Native。
 *
 * 数值逐条抄自网页版 `medbox-app/app/static/app.css` 的 `:root`，**不要随手改**：
 * 那套色值是按 WCAG 对比度 ≥ 4.5:1 配出来的（每个状态色的文字色 vs 底色），
 * 改一个就得重新验一遍对比度，否则长辈在阳光下看不清。
 *
 * 与 CSS 的三处必然差异：
 * 1. **没有 clamp()**。手机只有一个宽度，流式排版没意义，取值固定为原区间中段。
 * 2. **没有 rem**。RN 的 fontSize 单位是 dp，直接用数字。
 * 3. **阴影不同**。Android 的 `elevation` 只认灰黑影、不认颜色，网页那种
 *    「暖褐色柔光」在安卓上做不出来。所以卡片改用**极浅描边 + 小 elevation**
 *    来表达层次 —— 看起来略硬一点，但至少不会在深色壁纸下发灰。
 */
import type { TextStyle, ViewStyle } from 'react-native';

import type { ExpiryStatus } from '../domain/constants';

export const color = {
  // 暖底 + 青绿
  bg: '#f7f3ec',
  bgTop: '#fffdf8',
  card: '#ffffff',
  cardWarm: '#fffdfa',
  ink: '#24302a',
  muted: '#5c6660',
  line: '#e7e2d8',
  lineSoft: '#efeae0',

  brand: '#0e6e55',
  brandStrong: '#0a5a44',
  brandSoft: '#e2efe9',
  brandSoft2: '#cfdfd6',

  white: '#ffffff',
} as const;

/** 一个状态配色：文字色 / 底色 / 描边色。 */
export type Tone = { text: string; bg: string; bd: string };

export const tone = {
  ok: { text: '#157347', bg: '#e2f0e5', bd: '#b8d7c1' },
  warn: { text: '#8a5a06', bg: '#fbf1dc', bd: '#ecd7a3' },
  restock: { text: '#a94e1f', bg: '#fbe8d9', bd: '#ecc7a9' },
  danger: { text: '#b42318', bg: '#fce8e4', bd: '#f0c0b8' },
  gray: { text: '#56615a', bg: '#ecefe9', bd: '#d6dcd5' },
} as const satisfies Record<string, Tone>;

/**
 * 效期分档 → 配色。
 *
 * ⚠️ 注意这里**没有** `restock`：那是「该补货了」的颜色，与效期无关，
 * 由 `needsRestock` 单独决定。一盒药可以同时「效期正常」且「需要补货」，
 * 两个标记会并排显示 —— 这正是网页版的行为，别把它们合并成一个。
 */
const EXPIRY_TONE: Record<ExpiryStatus, Tone> = {
  expired: tone.danger,
  expiring: tone.warn,
  ok: tone.ok,
  none: tone.gray,
};

export function toneForExpiry(status: ExpiryStatus): Tone {
  return EXPIRY_TONE[status];
}

export const radius = { lg: 18, md: 12, sm: 9 } as const;

/**
 * 字号。原 CSS 是 clamp(下限, 基准, 上限)，这里取中段 ——
 * 网页版在手机上恰好也落在这一档，所以视觉上是接着的。
 */
export const font = {
  hero: 26,
  title: 19,
  base: 15,
  small: 13,
  tiny: 12,
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** 通用卡片外观。 */
export const card: ViewStyle = {
  backgroundColor: color.card,
  borderRadius: radius.lg,
  borderWidth: 1,
  borderColor: color.line,
  padding: space.lg,
  // 网页版是彩色柔光阴影，安卓 elevation 做不出来，只留一点点抬升
  elevation: 1,
};

/** 页面底色。 */
export const screen: ViewStyle = { flex: 1, backgroundColor: color.bg };

/** 正文 / 次要文字 / 标题。 */
export const text = {
  body: { fontSize: font.base, color: color.ink, lineHeight: 24 } as TextStyle,
  muted: { fontSize: font.small, color: color.muted, lineHeight: 20 } as TextStyle,
  title: { fontSize: font.title, color: color.ink, fontWeight: '700' } as TextStyle,
  hero: { fontSize: font.hero, color: color.ink, fontWeight: '700' } as TextStyle,
  tiny: { fontSize: font.tiny, color: color.muted } as TextStyle,
} as const;

/** 小圆角药丸标签（状态、单位、成员都用它）。 */
export function pill(t: Tone): ViewStyle & { } {
  return {
    backgroundColor: t.bg,
    borderColor: t.bd,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  };
}

/** 药丸里的文字。 */
export function pillText(t: Tone): TextStyle {
  return { color: t.text, fontSize: font.tiny, fontWeight: '600' };
}

/** 主要按钮（实心青绿）。 */
export const buttonPrimary: ViewStyle = {
  backgroundColor: color.brand,
  borderRadius: radius.md,
  paddingVertical: 13,
  paddingHorizontal: space.lg,
  alignItems: 'center',
};

/** 次要按钮（描边）。 */
export const buttonGhost: ViewStyle = {
  backgroundColor: color.card,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: color.line,
  paddingVertical: 13,
  paddingHorizontal: space.lg,
  alignItems: 'center',
};

export const buttonLabel: TextStyle = {
  color: color.white,
  fontSize: font.base,
  fontWeight: '700',
};

export const buttonGhostLabel: TextStyle = { ...buttonLabel, color: color.ink };
