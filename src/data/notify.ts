/**
 * 提醒偏好的读写（M5）。**本机偏好，不是数据** ——
 * 所以它既不进 `all.json`（`buildExport` 的 settings 白名单里没有这两个键），
 * 也不在导出/下载那条路径上冒头。
 *
 * 存放位置刻意选在现有的 `settings` 表（复用 `getSetting` / `setSetting`）：
 * 单条 upsert 天然原子，不用为两个值起一张新表、更不用引入第二个存储后端。
 */
import type { MedboxDb } from '../db/client';
import {
  DEFAULT_NOTIFY_ENABLED,
  DEFAULT_NOTIFY_TIME,
  KEY_NOTIFY_ENABLED,
  KEY_NOTIFY_TIME,
} from '../domain/constants';
import { normalizeNotifyTime, parseNotifyTime } from '../domain/settings';
import { getSetting, setSetting } from '../importer/apply';

/** 拆开的时刻，而不是 `'HH:mm'` 字符串 —— 调用方要的永远是数字。 */
export type NotifyPrefs = { enabled: boolean; hour: number; minute: number };

/** `'1'` 为真。**没写过的键取默认值（开着）**，所以新装的 App 直接就在工作。 */
function readEnabled(db: MedboxDb): boolean {
  const raw = getSetting(db, KEY_NOTIFY_ENABLED);
  if (raw === null) return DEFAULT_NOTIFY_ENABLED;
  return raw === '1';
}

/**
 * 读提醒偏好。
 *
 * 🔴 **时刻读坏了也不能抛**：这一层喂的是「App 打开时的重排」，
 * 抛出去就是启动即崩。库里存着一个解不出来的值（手改过、旧版本写过别的格式）
 * 时回默认的 09:00，用户最多是收到的时间不对，而不是打不开 App。
 */
export function getNotifyPrefs(db: MedboxDb): NotifyPrefs {
  const raw = getSetting(db, KEY_NOTIFY_TIME) ?? DEFAULT_NOTIFY_TIME;
  const parsed = parseNotifyTime(raw);
  const fallback = parseNotifyTime(DEFAULT_NOTIFY_TIME);
  const t = parsed.ok ? parsed : (fallback as { ok: true; hour: number; minute: number });
  return { enabled: readEnabled(db), hour: t.hour, minute: t.minute };
}

/**
 * 写提醒偏好。两个键各一条 upsert，**先写时刻再写开关** ——
 * 中途被杀进程时，宁可「开着但时刻是新的」，也别「关着但时刻是新的」
 * （前者至少还会提醒，后者是静默失效）。
 */
export function setNotifyPrefs(db: MedboxDb, prefs: NotifyPrefs): void {
  setSetting(db, KEY_NOTIFY_TIME, normalizeNotifyTime(prefs.hour, prefs.minute));
  setSetting(db, KEY_NOTIFY_ENABLED, prefs.enabled ? '1' : '0');
}
