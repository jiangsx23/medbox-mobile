/**
 * 测试只覆盖**纯领域逻辑**（`src/domain/` 与 `src/importer/parse.ts`），
 * 所以刻意不用 `jest-expo` 预设 —— 那些模块不碰 React Native，
 * 用普通的 node 环境跑得更快，依赖也更少。
 *
 * 这也是 DESIGN.md §5.5 的落点：要翻译的 45 条测试全是领域规则，
 * 没有一条需要渲染组件。
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
};
