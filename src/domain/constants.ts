/**
 * 枚举值与中文标签 —— 对应网页版的 `app/models.py` 常量与 `app/zh.py`。
 *
 * 标签表照搬 zh.py，措辞不要改：这些字是用户在网页版上看惯的，
 * 改了会让「对着网页版核数量」这件事多一层翻译。
 */
import type { CalendarDay } from '../db/schema';

// ── 剂型 / 类别 / 单位 / 位置（requirements.md 附录 A）────────────────
export const MEDICINE_FORMS = [
  '片剂',
  '胶囊',
  '口服液',
  '颗粒',
  '软膏',
  '滴眼液',
  '喷剂',
  '注射剂',
  '外用',
  '其他',
] as const;

export const MEDICINE_CATEGORIES = [
  '处方药',
  'OTC非处方药',
  '中成药',
  '保健品',
  '外用药',
  '医疗器械',
  '其他',
] as const;

export const MEDICINE_UNITS = ['盒', '瓶', '板', '粒', '袋', '支', '贴', '片', 'ml', 'g'] as const;

export const STORAGE_LOCATIONS = [
  '药箱·上层',
  '药箱·中层',
  '药箱·下层',
  '冰箱冷藏',
  '冰箱冷冻',
  '阴凉柜',
  '随身包',
  '客厅抽屉',
] as const;

// ── 批次状态（requirements.md §2.4 状态机）────────────────────────────
export const BATCH_IN_STOCK = 'in_stock';
export const BATCH_USED_UP = 'used_up';
export const BATCH_EXPIRED = 'expired';
export const BATCH_DISCARDED = 'discarded';

export const BATCH_STATUSES = [BATCH_IN_STOCK, BATCH_USED_UP, BATCH_EXPIRED, BATCH_DISCARDED] as const;

/** 只有 `in_stock` 计入「在库」/剩余量（不变量 2）。 */
export const IN_STOCK_STATUSES = [BATCH_IN_STOCK] as const;

export const BATCH_STATUS_LABELS: Record<string, string> = {
  [BATCH_IN_STOCK]: '在库',
  [BATCH_USED_UP]: '已用完',
  [BATCH_EXPIRED]: '已过期',
  [BATCH_DISCARDED]: '已丢弃',
};

// ── 变动记录类型 ───────────────────────────────────────────────────────
export const EVENT_IN = 'in';
export const EVENT_TAKE = 'take';
export const EVENT_USED_UP = 'used_up';
export const EVENT_DISCARD = 'discard';
export const EVENT_MARK_EXPIRED = 'mark_expired';
export const EVENT_RESTOCK = 'restock';
export const EVENT_AUTO = 'auto_take';
export const EVENT_EDIT = 'edit';

export const EVENT_LABELS: Record<string, string> = {
  [EVENT_IN]: '入库',
  [EVENT_TAKE]: '取用',
  [EVENT_USED_UP]: '用完',
  [EVENT_DISCARD]: '丢弃',
  [EVENT_MARK_EXPIRED]: '标记过期',
  [EVENT_RESTOCK]: '恢复在库',
  [EVENT_AUTO]: '自动扣减',
  [EVENT_EDIT]: '编辑',
};

// ── 效期分档（requirements.md §3.4）────────────────────────────────────
export const EXPIRY_EXPIRED = 'expired';
export const EXPIRY_EXPIRING = 'expiring';
export const EXPIRY_OK = 'ok';
export const EXPIRY_NONE = 'none';

export type ExpiryStatus = 'expired' | 'expiring' | 'ok' | 'none';

export const EXPIRY_STATUS_LABELS: Record<ExpiryStatus, string> = {
  [EXPIRY_EXPIRED]: '已过期',
  [EXPIRY_EXPIRING]: '快过期',
  [EXPIRY_OK]: '正常',
  [EXPIRY_NONE]: '未填效期',
};

// ── 设置项默认值（对应 config.py）─────────────────────────────────────
export const KEY_NEAR_EXPIRY_DAYS = 'near_expiry_days';
export const KEY_RESTOCK_DAYS = 'restock_days';

export const DEFAULT_NEAR_EXPIRY_DAYS = 90;
export const DEFAULT_RESTOCK_DAYS = 15;

/** 「家庭共用」不是一个成员记录，而是「归属为空」这个状态（§2.5）。 */
export const SHARED_LABEL = '家庭共用';

export const SCHEMA_VERSION = 1;

/** 便于类型标注：一批日历日。 */
export type { CalendarDay };
