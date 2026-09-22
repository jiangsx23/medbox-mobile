/**
 * 推送的**薄壳** —— 全仓唯一 import `expo-notifications` 的地方（M5）。
 *
 * ── 这里为什么可以「没测试」────────────────────────────────────────────
 * `jest.config.js` 是 `testEnvironment: 'node'`，且**刻意不用 jest-expo**：
 * 一 import 这个包，测试进程当场炸。所以架构被定死成
 * **「智力全在 `src/domain/notify.ts`（可测），expo 调用只留这一层（不可测）」**。
 * 对应地，本文件的纪律是：**零判断**。什么时候排、排哪天、什么时候取消，
 * 全部由 `planNotifications` / `reconcile` 决定好了；这里只把结果翻译成调用。
 * 一旦这里出现 `if`，那条 `if` 就永远不会有测试。
 *
 * ── 「用户不开 App 也会来」是怎么成立的 ────────────────────────────────
 * 闹钟是**原生 `AlarmManager`** 排的，到点由系统 service 自己展示 ——
 * 不需要 JS 活着、不需要进程活着。这正是选它而不是 JS 定时器的全部理由。
 * 会失手的只有两种：超出前瞻天数一直没打开过、以及 MIUI 把闹钟杀了
 * （后者没有代码解，靠 `app/notify-check.tsx` 那四步白名单）。
 */
import * as Notifications from 'expo-notifications';

import type { CalendarDay } from '../db/schema';
import {
  NOTIFY_TEST_ID_PREFIX,
  parseNotificationId,
  reconcile,
  type DesiredNotification,
  type PendingNotification,
} from '../domain/notify';

/** Android 频道 id。建完就改不动重要度了，所以它也是「必须一次定对」的一部分。 */
export const CHANNEL_ID = 'medbox-reminders';
const CHANNEL_NAME = '药箱提醒';

/**
 * 前台展示行为。**模块级一次性注册** —— 只影响「App 正开着时来了通知」，
 * 后台/杀进程时由原生直接展示，不经过这里。
 *
 * 🔴 `shouldPlaySound: false` 会让 Android **横幅完全不弹**（已核实）。
 * 提醒的意义就是弹出来，所以这里是 `true`。
 * `shouldSetBadge: false` —— 只有 iOS 用得上，我们没有角标语义，别假装有。
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * 建频道 + 按需要一次权限。**必须在 `syncNotifications` 之前调用**。
 *
 * 频道：Android 8.0+ **没有频道 = 通知被系统静默丢弃** —— 不报错、不提示，
 * 就是不来。所以每次闸门跑都幂等建一次（同 id 重复建是更新，不是新增）。
 *
 * 权限：默认开着，所以第一次跑时要一次。**已被拒绝则绝不重复弹** ——
 * `canAskAgain` 为假时直接返回，把「再去授权」交给设置页/自检页的按钮。
 * 这台 Android 8.1 上 `granted` 直接为真、根本不弹框（与 13+ 的分叉点）。
 */
export async function prepare(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: CHANNEL_NAME,
    // 🔴 HIGH 是「弹横幅」的下限，而且**频道的重要度建完就改不动**
    //（Android 的规矩：代码改了也没用，要么卸载重装、要么用户自己去系统里调）。
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    // 锁屏上不显示正文预览。⚠️ **这一项在小米8（API 27）上实测没有生效** ——
    // 真机读回来的是 `mLockscreenVisibility = -1000`（`VISIBILITY_NO_OVERRIDE`，
    // 即「没设过」），而锁屏上那条测试通知压根没出现（锁屏只有系统的 USB 两条）。
    // 最可能是 MIUI 自己的「锁屏通知」开关在管，不是我们能决定的。
    // 留着无害（新系统上可能有用），但**别把它当成保障** ——
    // 🔴 唯一可靠的保障是「正文里压根没有药名」，见 `src/domain/notify.ts`。
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    showBadge: true,
  });

  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return;
  if (!current.canAskAgain) return; // 问过了、被拒了 —— 不再骚扰
  await Notifications.requestPermissionsAsync();
}

/** 只读现状：队列里都有什么、各自带着哪个比较键。 */
export async function readPending(): Promise<PendingNotification[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.map((r) => ({
    id: r.identifier,
    // 自己排的条目会在 data 里带 planKey；不是我们排的就没有
    planKey: typeof r.content.data?.planKey === 'string' ? r.content.data.planKey : null,
  }));
}

export type SyncResult = { created: number; cancelled: number; kept: number };

/**
 * 把「愿望」变成现实。**最小动作**：
 * - 只取消 `reconcile` 点名的 id，绝不 `cancelAllScheduledNotificationsAsync()`
 *   —— 那会连今天还没到点的那条、以及自检页的测试条一起删，而且无法解释自己删了什么。
 * - 只写「新出现的」和「比较键变了的」。计划没变时**一个字节都不写**
 *   —— 除非 `refreshAll`，见下。
 *
 * 同 id 重排是**覆盖**（原生侧走 `SharedPreferences.putString`，键就是 identifier），
 * 所以不需要先 cancel 再 create。
 *
 * 🔴 `refreshAll` **必须在冷启动时传 true** —— 理由见 `reconcile` 的长注释：
 * `getAllScheduledNotificationsAsync()` 在安卓上读的是 expo 自己的 SharedPreferences，
 * 而重启会清空 `AlarmManager` 却留下那份记录，于是「计划没变」会把**已经不存在**的
 * 闹钟判成 `keep`，永远不修。2026-09-22 真机验收实测：重启后队列为 0 而自检页报「3 条/正常」。
 */
export async function syncNotifications(
  desired: readonly DesiredNotification[],
  today: CalendarDay,
  opts: { refreshAll?: boolean } = {},
): Promise<SyncResult> {
  const plan = reconcile(desired, await readPending(), today, opts);

  for (const id of plan.cancel) {
    await Notifications.cancelScheduledNotificationAsync(id);
  }
  for (const d of plan.create) {
    await Notifications.scheduleNotificationAsync({
      identifier: d.id,
      content: {
        title: d.title,
        body: d.body,
        // 只放机器读的比较键。**不放药名、不放 id** —— 这些字段会跟着通知落盘，
        // 也可能出现在系统的通知详情里。
        data: { planKey: d.planKey },
        // Android 8+ 由频道管声音，这里显式写一遍是给低版本兜底。
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(d.dateMs),
        channelId: CHANNEL_ID,
      },
    });
  }

  return { created: plan.create.length, cancelled: plan.cancel.length, kept: plan.keep.length };
}

/**
 * 排一条 N 秒后的测试通知。
 *
 * 🔴 **测试 id 刻意用 `parseNotificationId` 解不出来的前缀** ——
 * 否则用户刚在自检页排的这条，会被下一次回前台的重排顺手删掉。
 * 文案同样不含药名（正式提醒的正文只有数字，测试条照同一个规矩）。
 */
export async function scheduleTestIn(seconds: number): Promise<string> {
  const id = `${NOTIFY_TEST_ID_PREFIX}${Date.now()}`;
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title: '药箱：自检通知',
      body: '看到这条，说明通知这条路是通的。',
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
      channelId: CHANNEL_ID,
    },
  });
  return id;
}

/** 「马上推一条（5 秒后）」—— 只验频道+权限+前台展示，**别把它当成功判据**。 */
export function pushTestNow(): Promise<string> {
  return scheduleTestIn(5);
}

// ── 自检页要的现状 ──────────────────────────────────────────────────────

export type ProbeEntry = {
  id: string;
  /** 解析出来的日期；解析不出（测试通知）为 null */
  day: CalendarDay | null;
  /** 排定的绝对时刻（epoch 毫秒），拿不到为 null */
  dateMs: number | null;
};

export type NotifyProbe = {
  permission: 'granted' | 'denied' | 'undetermined';
  /** 为假表示「已经问过、被拒了」，界面该改成引导去系统设置 */
  canAskAgain: boolean;
  /** 8.0+ 没有频道 = 通知被系统静默丢弃。这一项是自检页最重要的一行 */
  channelExists: boolean;
  /**
   * expo 的 `AndroidImportance`；没有频道时为 null。6 = HIGH = 会弹横幅。
   *
   * ⚠️ **别拿这个数字去对 `adb shell dumpsys notification`** —— 它俩不是一个刻度，
   * 对不上是正常的，不是 bug。2026-09-22 真机验收时我自己就在这里绕了一圈：
   *
   * | 刻度 | HIGH 的值 |
   * |---|---|
   * | expo 的 `enumValue`（= 这里） | **6** |
   * | Android 的 `NotificationManager.IMPORTANCE_HIGH`（= dumpsys 打印的 `mImportance`） | **4** |
   *
   * 依据 `expo/modules/notifications/notifications/enums/NotificationImportance.kt`：
   * `HIGH(NotificationManagerCompat.IMPORTANCE_HIGH, 6)` —— 构造器第一个参数是原生值、
   * 第二个才是这个 `enumValue`。所以自检页显示的「重要度 6」和 dumpsys 的
   * `mImportance=4` **说的是同一件事**，两边都没错。
   */
  channelImportance: number | null;
  /**
   * 频道的重要度够不够弹横幅。**刻意在这里算好、不让界面去比数字** ——
   * `AndroidImportance.HIGH === 6` 是 expo 的类型细节，界面层不该 import 它
   *（那会把 expo 的 import 扩散到 `app/` 里，守卫测试当场变红）。
   */
  channelWillBanner: boolean;
  scheduled: ProbeEntry[];
};

/**
 * 一次性读出「现在是什么状态」，给自检页显示。
 *
 * 只读，不改任何东西 —— 自检页的诊断动作必须是无副作用的，
 * 否则「看一眼」这件事本身就会改动被观察的对象。
 */
export async function probe(): Promise<NotifyProbe> {
  const [perm, channel, all] = await Promise.all([
    Notifications.getPermissionsAsync(),
    Notifications.getNotificationChannelAsync(CHANNEL_ID),
    Notifications.getAllScheduledNotificationsAsync(),
  ]);

  const scheduled: ProbeEntry[] = all.map((r) => {
    const parsed = parseNotificationId(r.identifier);
    const trigger = r.trigger as { value?: unknown } | null;
    // DATE 触发器的值原生侧回传的是毫秒数。拿不到就算了 —— 界面显示「—」，
    // 不因为一个装饰性字段读不出来就让整个自检页失败。
    const value = trigger && typeof trigger.value === 'number' ? trigger.value : null;
    return { id: r.identifier, day: parsed?.day ?? null, dateMs: value };
  });

  const importance = channel?.importance ?? null;
  return {
    permission: perm.granted ? 'granted' : perm.canAskAgain ? 'undetermined' : 'denied',
    canAskAgain: perm.canAskAgain,
    channelExists: channel !== null,
    channelImportance: importance,
    channelWillBanner: importance !== null && importance >= Notifications.AndroidImportance.HIGH,
    scheduled,
  };
}
