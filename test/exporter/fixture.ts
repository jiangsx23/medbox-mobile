/**
 * 导出端三个测试共用的搭台：**把真实那份导出文件落进一个真库**。
 *
 * 不是 `.test.ts`，所以 jest 不会把它当套件（`testMatch` 只认 `*.test.ts`）。
 *
 * ── 为什么必须是真文件、真库 ───────────────────────────────────────────
 * 导出端要验的是「写出去的东西和网页版那份**同一格式**」。手捏几个对象
 * 测不出键名写错、`undefined` 掉了键、时间戳口径反了这类事 —— 而那些
 * 恰恰是硬约束 5 唯一会出事的方式。所以这里走完整条真路：
 * `test/fixtures/all.json`（`D:\Downloads\all.json` 的副本）→ `parseExport`
 * → `applyImport` → 一个真 SQLite。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MedboxDb } from '../../src/db/client';
import { applyImport } from '../../src/importer/apply';
import { parseExport } from '../../src/importer/parse';
import { freshDb } from '../helpers';

export const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'all.json');
export const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');

/** 与 `test/golden.test.ts:31` 同一个基准日 —— 只在导入当天与「今天」重合。 */
export const IMPORT_DAY = '2026-09-16';
/** 「换一天再导入」用的日子（真机上就是 09-21 那次装机导入）。 */
export const LATER_DAY = '2026-09-21';
/** 固定时刻，`exported_at` 才可断言。 */
export const NOW = 1789000000000;

/** fixture → 落库。`day` 是这次导入的「当天」（决定 6 个自动扣减药的起算日）。 */
export function importedDb(day: string = IMPORT_DAY): MedboxDb {
  const parsed = parseExport(FIXTURE_TEXT, day);
  if (!parsed.ok) throw new Error(`fixture 解析失败：${parsed.errors.join(' / ')}`);
  const db = freshDb();
  applyImport(db, parsed.data, { importedAt: NOW, sourceName: 'all.json' });
  return db;
}
