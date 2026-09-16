/**
 * Babel 配置。
 *
 * ── `inline-import` 这一条是干嘛的（别删） ─────────────────────────────
 * drizzle-kit 生成的 `drizzle/migrations.js` 长这样：
 *
 *     import m0000 from './0000_crazy_diamondback.sql';
 *
 * 也就是把一整个 `.sql` 文件当成模块来 import，指望它变成一个字符串。
 * 但 Metro 遇到 `.sql` 只会做两件事里的一件：
 *   1. 不认识这个后缀 → 直接报「Unable to resolve module」；
 *   2. 认识（`metro.config.js` 里加了 `sourceExts.push('sql')`）→
 *      **把 SQL 当成 JavaScript 去解析** → 语法错误，打包失败。
 *
 * 所以 `metro.config.js` 那一行只解决了第 1 个问题，反而撞上第 2 个。
 * 真正把 `.sql` 变成字符串的是这里的 `inline-import`：它在打包前就把
 * 文件内容替换成字符串字面量，Metro 根本不会去解析那段 SQL。
 *
 * 这个错误**只在真正打包时才会暴露**（`tsc` 和 `jest` 都碰不到 Metro），
 * 所以它是在第一次 `gradlew assembleRelease` 时才炸出来的。
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
