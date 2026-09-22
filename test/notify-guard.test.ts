/**
 * 结构性守卫 —— 钉住的是**架构本身**，不是行为（M5）。
 *
 * 这些约束用行为测试表达不出来，或者表达出来也拦不住「未来有人好心改一下」：
 * 「expo 的 import 不外溢」「闸门顺序不能反」「时间必须注入」—— 它们全都是
 * 「改坏了当场没有症状、几个月后在真机上才发现」的形状。
 *
 * ── 抄了 M6 的两条教训 ────────────────────────────────────────────────
 * 1. 🔴 **断言必须打在去掉注释的源码上。** 第一版守卫扫原文，被文件头那句
 *    「**绝不** `cancelAllScheduledNotificationsAsync()`」自己绊倒了 ——
 *    守卫要抓的是**代码**，不是散文。本项目里注释密度极高，这条不是洁癖。
 * 2. 🔴 **每条守卫都要有非空转断言。** M6 踩过「守卫永远为真」：正则写错、
 *    路径写错、目录扫空，测试照样绿。所以每条都额外断言「我确实读到了那个文件」
 *    / 「那个模式确实在别处出现过」。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/** 去掉块注释与行注释。`[^:]` 是为了不误伤 `https://`。 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  // 非空转：读到的必须是一个真文件，而不是空串
  expect(src.length).toBeGreaterThan(500);
  return src;
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

describe('守卫：expo 的依赖只允许出现在一个文件里', () => {
  it('🔴 全仓只有 src/notify/scheduler.ts import expo-notifications', () => {
    // 为什么是硬约束而不是风格问题：`jest.config.js` 是 `testEnvironment: 'node'`
    // 且刻意不用 jest-expo ⇒ 任何被测试间接 import 到的模块里只要出现这一行，
    // **整个测试进程当场炸**。所以「智力放纯函数、expo 只留一层薄壳」这条
    // 架构不是审美，是测试能不能跑起来的前提。
    const offenders: string[] = [];
    let found: string | null = null;

    for (const p of sourceFiles()) {
      const code = codeOnly(readFileSync(p, 'utf8'));
      if (!/from\s+['"]expo-notifications['"]|require\(\s*['"]expo-notifications['"]\s*\)/.test(code)) {
        continue;
      }
      const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/');
      if (rel === 'src/notify/scheduler.ts') found = rel;
      else offenders.push(rel);
    }

    expect(offenders).toEqual([]);
    // 非空转：那一行确实存在于它该在的地方（否则上面那句是在比两个空集合）
    expect(found).toBe('src/notify/scheduler.ts');
  });

  it('🔴 被测试覆盖的模块里不许出现 expo —— 直接点名两个最容易被污染的', () => {
    // `src/domain/notify.ts` 是纯的（31 条测试）；`src/notify/snapshot.ts` 只碰 SQLite
    // （11 条测试，走 better-sqlite3）。它们一旦 import expo，那两套测试全都起不来。
    for (const rel of ['src/domain/notify.ts', 'src/notify/snapshot.ts']) {
      const code = codeOnly(read(rel));
      expect(code).not.toMatch(/['"]expo-notifications['"]/);
      expect(code).not.toMatch(/['"]expo-/);
      // 非空转：确认读到的确实是那个模块
      expect(code).toMatch(/export (function|const)/);
    }
  });
});

describe('守卫：闸门顺序与时间注入', () => {
  it('🔴 DbProvider 里 settleAll 必须在 syncNotifications 之前', () => {
    // 前瞻吃的是**结算后**的库存。顺序反了，排出来的提醒基于昨天的数字 ——
    // 而且它不会报错，只会安静地算错一天。
    //
    // ⚠️ 注意这与硬约束 6 **方向正好相反**：`src/exporter/` 的纪律是
    // 「绝不结算、只 select」（那条守卫在 `test/exporter/roundtrip.test.ts` 里）。
    // 两条都别搞混 —— 所以这条测试的注释里把另一条也写出来。
    const code = codeOnly(read('src/ui/DbProvider.tsx'));
    const settle = code.search(/settleAll\s*\(/);
    const sync = code.search(/syncNotifications\s*\(/);
    // 非空转：两个都得真的出现，否则 -1 < -1 也是「通过」
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(settle).toBeLessThan(sync);
  });

  it('🔴 推送失败只记不抛 —— 通知坏了不该让 App 打不开', () => {
    const code = codeOnly(read('src/ui/DbProvider.tsx'));
    // 推送那一段必须**自成一个 try**，而且它的 catch 里必须是 setNotifyError。
    // 不能共用外层那个 catch —— 那个走 `setError`，会把整个 App 卡在
    // 「数据库打不开」的错误页上。通知坏了不该有这个后果。
    const block =
      /try\s*\{\s*const prefs = getNotifyPrefs[\s\S]*?\}\s*catch\s*\(e\)\s*\{\s*setNotifyError\(/.exec(code);
    // 非空转：这条正则要求「结构原样存在」，改散了就抓不到（而不是宽松地放过）
    expect(block).not.toBeNull();
    // 反过来确认「致命」那条路仍然只属于数据库：全文件里 setError 与
    // setNotifyError 必须同时存在，各管各的
    expect(code).toMatch(/setError\s*\(/);
    expect(code).toMatch(/setNotifyError\s*\(/);
  });

  it('🔴 src/domain/notify.ts 里没有 `new Date(` / `Date.now(` —— 「今天」是注入的', () => {
    // 模块里读真实时钟的后果不是「不准」，是**测试会随真实时间漂移**：
    // 今天绿的用例明天可能红，而且红得莫名其妙。所有时刻都由调用方传进来。
    const code = codeOnly(read('src/domain/notify.ts'));
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(/);
    // 非空转：确认读到的确实是那个模块
    expect(code).toMatch(/export function planNotifications/);
  });
});

describe('守卫：队列完整性（reboot 那一课）', () => {
  it('🔴 DbProvider 必须在冷启动时 refreshAll —— 否则重启后提醒静默失效', () => {
    // 为什么这条必须有：这个 bug **在运行时没有任何症状**。
    // 重启后 AlarmManager 空了，而 expo 的 SharedPreferences 记录还在 ⇒
    // `reconcile` 认为「计划没变」⇒ 零写入 ⇒ 提醒再也不会响，
    // 而自检页照样报「待发 3 条 / 上次重排 正常」。2026-09-22 真机验收就是这样被骗过去的。
    // 行为测试只能钉住纯函数那一半；「冷启动这个**调用点**有没有传」只能靠读源码。
    const code = codeOnly(read('src/ui/DbProvider.tsx'));
    // 非空转：冷的判据本身得存在，而且确实来自「库还没打开」
    expect(code).toMatch(/coldStart/);
    expect(code).toMatch(/coldStart\s*=\s*!\s*(handle|ready)/);
    // 它必须真的被用在 syncNotifications 的参数里（定义了不用 = 白定义）
    const call = /syncNotifications\(([\s\S]{0,400}?)\)\s*;/.exec(code);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/refreshAll\s*:[\s\S]*coldStart/);
  });

  it('🔴 自检页的「重新对齐一次」必须强制重发 —— 它存在的意义就是修队列', () => {
    // 不强制的话它自己也会掉进同一个坑：队列真空 + 记录还在 ⇒「计划没变」⇒ 修不好。
    const code = codeOnly(read('app/notify-check.tsx'));
    expect(code).toMatch(/reload\(\s*\{\s*forceNotify\s*:\s*true\s*\}\s*\)/);
    // 非空转：确认读到的确实是那个页面
    expect(code).toMatch(/通知自检|重新对齐/);
  });
});

describe('守卫：取消动作必须是最小动作', () => {
  it('🔴 全仓不出现 cancelAllScheduledNotificationsAsync', () => {
    // 它会连今天还没到点的那条、以及自检页的测试条一起删，而且**无法解释
    // 自己删了什么**。前缀过滤 + 逐个 cancel 是必须坚持的最小动作。
    // 这条守卫的敌人是「图省事」：一句 cancelAll 能让所有测试照样绿。
    for (const p of sourceFiles()) {
      const code = codeOnly(readFileSync(p, 'utf8'));
      expect(code).not.toMatch(/cancelAllScheduledNotificationsAsync/);
    }
    // 非空转：确认「逐个取消」那条路确实在（否则可能整个功能被删了也不报）
    expect(codeOnly(read('src/notify/scheduler.ts'))).toMatch(/cancelScheduledNotificationAsync\s*\(/);
  });

  it('🔴 频道重要度必须是 HIGH —— 建完就改不动了', () => {
    // Android 的规矩：频道一旦建好，重要度就锁死。代码里从 DEFAULT 改成 HIGH
    // 对**已装用户没有任何效果**（只能卸载重装或用户自己去系统里调）。
    // 所以第一次就得写对，而且这条守卫是唯一能拦住「有人顺手降一档」的东西。
    const code = codeOnly(read('src/notify/scheduler.ts'));
    expect(code).toMatch(/importance:\s*Notifications\.AndroidImportance\.HIGH/);
    expect(code).not.toMatch(/AndroidImportance\.(DEFAULT|LOW|MIN|NONE)/);
  });
});
