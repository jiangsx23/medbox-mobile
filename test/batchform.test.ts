/**
 * 入库表单的初始值 —— 2026-09-23 用户要求「开封后有效期默认填 30 天」。
 *
 * ── 为什么值得单独一个套件 ──────────────────────────────────────────────
 * 这条预填**刻意打破**了 `requirements.md` §3.2/§3.3 的「效期、拆封日期、
 * 开封后有效期一律不预填」。破例的边界很窄，而越界的方式恰好是最坏的那种：
 * **顺手把「印刷效期」也预填上**，用户直接点确定 ⇒ 系统里记着一个错的到期日，
 * 而这正是这个 App 存在的意义。所以边界要用测试钉住，不能只写在注释里。
 *
 * ── 为什么要 mock 三个模块 ─────────────────────────────────────────────
 * `src/ui/batchform.tsx` import 了 `react-native`，以及 `./form`、`./components`
 * 两个同目录 UI 模块；后两者又各自 import 了
 * `@react-native-community/datetimepicker` 与 `@expo/vector-icons` —— 那两个包
 * 在 npm 里是**未编译的 ESM**，而 `jest.config.js` 是 `testEnvironment: 'node'`
 * 且刻意不用 `jest-expo`（见它的文件头），默认不转译 `node_modules`
 * ⇒ 直接 import 会在**那两个第三方包**里炸 `Cannot use import statement outside a module`。
 *
 * 被 mock 的**只有** `react-native` 与上面两个自家 UI 模块；`batchform.tsx`
 * 自己与 `domain/constants.ts` 跑的**是真代码** —— 这正是本套件要测的东西。
 * 这不算给测试引入 jest-expo：环境仍是 node，被 mock 的是三个模块，不是整套 RN。
 * ⚠️ 它们的工厂都返回空对象，所以**只能调 `emptyBatchForm()` 这类纯函数**，
 * 不要去渲染 `BatchFields`（那会一路调到 `undefined` 上）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  Alert: {},
  StyleSheet: { create: (x: unknown) => x },
}));
jest.mock('../src/ui/form', () => ({}));
jest.mock('../src/ui/components', () => ({}));

import { DEFAULT_OPEN_LIFE_DAYS } from '../src/domain/constants';
import { emptyBatchForm } from '../src/ui/batchform';

describe('emptyBatchForm —— 入库表单开出来时长什么样', () => {
  it('「开封后有效期」预填 30 天', () => {
    expect(emptyBatchForm().openLifeDays).toBe('30');
    // 与常量对一次：证明填的是这个常量、不是散在代码里的字面量 '30'。
    // 两条一起才有意义 —— 只对常量的话，把常量改成 90 测试照样绿。
    expect(emptyBatchForm().openLifeDays).toBe(String(DEFAULT_OPEN_LIFE_DAYS));
  });

  it('🔴 印刷效期与拆封日期**必须留空**（破例只破了「开封后天数」这一个字段）', () => {
    const v = emptyBatchForm();
    expect(v.expiryDate).toBe('');
    expect(v.openedAt).toBe('');
  });

  it('其余字段都是空串，且全都是 string（不是 undefined）', () => {
    const v = emptyBatchForm();
    // 为什么单列一条：这些值直接喂给 `TextField` 的 `value`，
    // 给 `undefined` 会变成非受控输入（React 警告 + 用户输入被吞）。
    expect(v).toEqual({
      qty: '',
      expiryDate: '',
      openedAt: '',
      openLifeDays: '30',
      location: '',
      notes: '',
      unit: '',
      ownerId: '',
    });
    for (const [, value] of Object.entries(v)) expect(typeof value).toBe('string');
  });

  it('每次调用都返回新对象（不能被调用方改坏，两份表单不共享状态）', () => {
    const a = emptyBatchForm();
    a.openLifeDays = '999';
    expect(emptyBatchForm().openLifeDays).toBe('30');
  });
});

// ── 结构性守卫 ────────────────────────────────────────────────────────
// 抄 `test/notify-guard.test.ts` 的两条规矩：
//  ① 断言打在**去掉注释的源码**上（本文件的注释里就到处写着这个常量的名字，
//     扫原文的话守卫会被散文自己绊倒 —— 这不是假想，是真会发生的形状）；
//  ② 每条都要有**非空转断言**（正则写错 / 路径扫空时测试照样绿的坑，M6 踩过）。

const ROOT = join(__dirname, '..');

/** 去掉块注释与行注释。`[^:]` 是为了不误伤 `https://`。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 递归列出 `src/` 与 `app/` 下所有 .ts/.tsx（这两个目录就是全部产品代码）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'app'));
  // 非空转：扫到 0 个文件的话下面所有断言都会「通过」
  expect(out.length).toBeGreaterThan(30);
  return out;
}

describe('守卫：这个默认值只允许作用于**入库**', () => {
  it('🔴 全仓只有 src/ui/batchform.tsx 引用了 DEFAULT_OPEN_LIFE_DAYS', () => {
    // 为什么这是硬约束而不是洁癖：**编辑表单（`app/batch/[id]/edit.tsx`）绝不能有这个默认值。**
    // 它显示的是库里的**现存事实** —— `open_life_days` 为 null 时就该显示空。
    // 在那里预填 30 有两个后果，第二个是安静的：
    //   ① 界面说「30 天」，而库里没有这个数 —— 显示的东西不是真相；
    //   ② 用户只想改个数量、直接点保存 ⇒ `planEdit` 把 30 落库 ⇒
    //      **一个原本没有开封期约束的批次，到期日被悄悄提前了**，而用户没做任何这类决定。
    // 所以「默认值」这件事必须**只有入库一个入口**，别的页面要用常量得先过这一关。
    const hits = sourceFiles()
      .filter((p) => codeOnly(readFileSync(p, 'utf8')).includes('DEFAULT_OPEN_LIFE_DAYS'))
      .map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .sort();

    expect(hits).toEqual(['src/domain/constants.ts', 'src/ui/batchform.tsx']);
  });

  it('编辑表单不给 openLifeDays 兜默认值（null 就是空）', () => {
    const src = readFileSync(join(ROOT, 'app/batch/[id]/edit.tsx'), 'utf8');
    // 非空转：先证明读到的是那个文件、且下面要找的那行确实在
    expect(src.length).toBeGreaterThan(500);
    expect(codeOnly(src)).toContain('openLifeDays: b.openLifeDays === null ?');

    const code = codeOnly(src);
    expect(code).not.toContain('DEFAULT_OPEN_LIFE_DAYS');
    // 兜底值必须是空串。写成 `?? '30'` / `|| 30` 这类「顺手补一个默认」就是本条的靶子
    expect(code).toMatch(/openLifeDays: b\.openLifeDays === null \? '' : String\(b\.openLifeDays\)/);
  });
});
