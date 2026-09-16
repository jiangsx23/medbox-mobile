const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// drizzle-kit 把迁移写成了 `import m0000 from './0000_xxx.sql'`，
// 而 Metro 默认不认识 .sql 这个后缀 —— 不加这行就是
// 「Unable to resolve module ...0000_xxx.sql」。
//
// ⚠️ 但这一行只是**一半**。加完之后 Metro 会去解析那段 SQL，当成 JavaScript，
//    于是变成语法错误 —— 打包照样失败，只是错误信息换了个样子。
//    另一半在 `babel.config.js` 的 `inline-import` 插件，它把 .sql 变成字符串，
//    Metro 就不会去解析了。**两处要一起改。**
config.resolver.sourceExts.push('sql');

module.exports = config;
