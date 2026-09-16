/**
 * drizzle-kit 生成的 `drizzle/migrations.js` 会 `import m0000 from './0000_xxx.sql'`。
 * Metro 靠 `metro.config.js` 里的 `sourceExts.push('sql')` 认识这个后缀，
 * TypeScript 则靠这里。
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
