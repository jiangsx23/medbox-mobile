import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 配置：只用来**生成**建表/加列的 SQL 迁移。
 *
 * 生成出来的 `drizzle/` 目录会跟代码一起打进 App，运行时由
 * `drizzle-orm/expo-sqlite/migrator` 的 `migrate()` 执行
 * （见 `src/db/client.ts`）。所以「用户手机上已经装着 App、我要加字段」
 * 这件事的处理方式是：改 `schema.ts` → `npm run db:generate` → 发新版本，
 * 老用户升级后迁移自动跑一次。
 *
 * ⚠️ 改完 schema 一定要重新 `npm run db:generate` 并把 `drizzle/` 一起提交。
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // 必须写 `driver: 'expo'`：它让 drizzle-kit 额外产出 `drizzle/migrations.js`
  // —— 把 .sql 打包成一个 JS 模块，`useMigrations` / `migrate()` 就认这个。
  // 只写 dialect 的话只有 .sql 文件，运行时 import 会找不到迁移。
  driver: 'expo',
} satisfies Config;
