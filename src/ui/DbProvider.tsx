/**
 * 数据库就绪闸门 —— DESIGN.md §7.3 在 App 上的落点。
 *
 * ── 为什么要有这一层 ───────────────────────────────────────────────────
 * 网页版靠 FastAPI 的路由依赖，在「每个会读库存的页面」开门前自动跑一次结算。
 * App 没有那个统一入口，所以改成：**所有界面都挂在这一个 Provider 下面，
 * 闸门不开就不渲染任何界面**。
 *
 * 要挡住的 bug 很具体：首页显示「剩 34 片」、详情页显示「剩 32 片」。
 * 这不是显示问题，是同一份数据被读了两次、中间夹了一次结算。
 * 只要「读库存」这件事永远发生在闸门之后，这种自相矛盾就不可能发生。
 *
 * ⚠️ 因此：**不要**在界面里直接 `openDatabaseAsync`。要库就从 `useDb()` 拿。
 *
 * ── 冷启动 + 回前台 ───────────────────────────────────────────────────
 * 结算的另外两个触发点是冷启动（这里的 effect）和回前台（AppState 监听）。
 * 每次重跑完把 `version` 加一，界面靠它重新取数 —— 否则回前台后数字是旧的，
 * 用户会以为药没扣。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';

import { openMedboxDatabase, isWalDisabled, type MedboxDb } from '../db/client';
import { settleAll } from '../data/stock';
import { getNotifyPrefs } from '../data/notify';
import { getThresholds } from '../data/queries';
import type { CalendarDay } from '../db/schema';
import { today as todayDay } from '../domain/calendar';
import { NOTIFY_HORIZON_DAYS } from '../domain/constants';
import { planNotifications } from '../domain/notify';
import { hasAnyData } from '../importer/apply';
import { loadNotifySnapshot } from '../notify/snapshot';
import { prepare, syncNotifications } from '../notify/scheduler';
import { color, font, screen, space, text } from './theme';

type DbContextValue = {
  db: MedboxDb;
  /** 当天日历日。回前台时若跨了午夜会自动更新 */
  today: CalendarDay;
  /**
   * 每次闸门重跑自增。界面把它塞进 `useMemo`/`useEffect` 的依赖数组，
   * 就能在「结算/导入结束后」自动刷新。
   */
  version: number;
  /** 库里有没有药品档案（决定首页显示空药箱还是正常内容） */
  hasData: boolean;
  /** 关 WAL 的核对结果。不是 'delete' 就该在设置页告警 */
  journalMode: string;
  /**
   * 手动重跑闸门（导入完成后、下拉刷新时调用）。
   * `forceNotify` 会把推送队列**无条件重发**一遍，见 `run` 里 `refreshAll` 的理由。
   */
  reload: (opts?: { forceNotify?: boolean }) => void;
  /**
   * 上一次推送重排的失败原因，成功时为 null（M5）。
   *
   * 🔴 推送失败**绝不拦路** —— 它只被记在这里，让「通知自检」页能说出来。
   * 通知坏了不该让 App 打不开：药箱的主体功能一个都不依赖它。
   */
  notifyError: string | null;
};

const DbContext = createContext<DbContextValue | null>(null);

export function useDb(): DbContextValue {
  const v = useContext(DbContext);
  if (!v) throw new Error('useDb() 必须在 <DbProvider> 里面用');
  return v;
}

type Ready = { db: MedboxDb; journalMode: string };

/**
 * 闸门本体。每次开门做三件事：**打开 → 结算 → 涨版本号**。
 *
 * 顺序不能换。结算放在涨版本号之前，界面才会在「已经是结算后的数字」上重新取数；
 * 放在之后，首页会先渲染一遍旧数字、下一帧再跳成新数字 —— 用户看到的是
 * 药莫名其妙少了几片。
 *
 * ⚠️ M2 起结算真的会扣数量了（M1 时 `auto_from` 被导入重设成当天，无可结算天数）。
 * 所以 `settleAll` 失败必须让闸门**卡住**而不是放行 —— 宁可显示错误，
 * 也不能让界面拿着没结算的数字骗人。
 */
export function DbProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [day, setDay] = useState<CalendarDay>(() => todayDay());
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(async (opts: { forceNotify?: boolean } = {}) => {
    if (busy.current) return; // 冷启动与回前台可能几乎同时触发，串行化
    busy.current = true;
    try {
      let handle = ready;
      // 还在等库打开 ⇒ 这是**本进程第一次**跑闸门。重启手机必然伴随一次冷启动，
      // 而重启会清空 AlarmManager 却留下 expo 的队列记录 —— 所以第一次必须重发，
      // 否则那批「看起来还在」的提醒再也不会响。见 `src/domain/notify.ts` 的 reconcile。
      const coldStart = !handle;
      if (!handle) {
        const opened = await openMedboxDatabase();
        handle = { db: opened.db, journalMode: opened.journalMode };
        setReady(handle);
      }
      // 「今天」只取一次，结算与推送共用 —— 否则跨午夜那一瞬间两者可能差一天。
      const now = Date.now();
      const today = todayDay(new Date(now));

      // 结算。幂等，所以冷启动与回前台各跑一次是设计目标而不是浪费。
      // 必须在 `setVersion` **之前**跑完：版本号一涨，所有界面就会重新取数，
      // 那时候库存数字必须已经是结算后的。
      settleAll(handle.db, today);

      // 回前台时可能已经跨了午夜，日期要跟着走，否则「今天到期」会算错一天
      setDay(today);
      setVersion((v) => v + 1);

      // ── 推送重排（M5）────────────────────────────────────────────
      // 🔴 必须在**结算之后**：前瞻吃的是结算后的库存。
      //    注意这与硬约束 6 方向**正好相反** —— 导出那条路径的纪律是
      //    「绝不结算、只 select」；推送是「必须结算完再算」。两者都别搞混。
      //
      // 放在 `setVersion` 之后是**刻意的偏离**：`prepare()` 在新安卓上会弹
      // 权限框，await 它会让「正在打开药箱…」一直挂到用户点完为止。
      // 而在 `await` 处 React 已经把上面两个 setState 刷出去了 ⇒ 界面照常出，
      // 通知自己在后面排队。`busy` 仍然握着，所以不会和下一次重排打架。
      try {
        const prefs = getNotifyPrefs(handle.db);
        // 关掉开关 = 愿望为空 = 未来所有条目被撤掉（今天那条除外，见 reconcile）
        const desired = prefs.enabled
          ? planNotifications(
              loadNotifySnapshot(handle.db, today, getThresholds(handle.db)),
              today,
              {
                hour: prefs.hour,
                minute: prefs.minute,
                restockDays: getThresholds(handle.db).restockDays,
                horizonDays: NOTIFY_HORIZON_DAYS,
                now,
              },
            )
          : [];
        if (prefs.enabled) await prepare();
        // 🔴 冷启动无条件重发；自检页的「重新对齐一次」也走这条强制路（它存在的意义
        //    就是修好队列，而它自己以前也修不好 —— 见 reconcile 的长注释）
        await syncNotifications(desired, today, {
          refreshAll: coldStart || opts.forceNotify === true,
        });
        setNotifyError(null);
      } catch (e) {
        // 🔴 只记不抛。通知坏了不该让 App 打不开 —— 药箱的主体功能不依赖它。
        setNotifyError(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [ready]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void run();
    });
    return () => sub.remove();
  }, [run]);

  if (error !== null) {
    return (
      <View style={[screen, styles.center]}>
        <Text style={text.title}>数据库打不开</Text>
        <Text style={[text.muted, styles.gap]}>{error}</Text>
        <Text style={[text.muted, styles.gap]}>
          药箱数据在手机上，这一步失败就拿不到任何数据。重启 App 试试；
          若一直不行，请把上面这行文字发给开发者。
        </Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={[screen, styles.center]}>
        <ActivityIndicator color={color.brand} size="large" />
        <Text style={[text.muted, styles.gap]}>正在打开药箱…</Text>
      </View>
    );
  }

  const hasData = hasAnyData(ready.db);

  return (
    <DbContext.Provider
      value={{
        db: ready.db,
        today: day,
        version,
        hasData,
        journalMode: ready.journalMode,
        reload: (opts) => void run(opts),
        notifyError,
      }}
    >
      {children}
    </DbContext.Provider>
  );
}

/**
 * 回前台的监听放在 Provider 里，但「WAL 没关掉」这件事只在这里判断一次 ——
 * 它是持久属性，不用天天查。为 false 时设置页会显红字。
 */
export { isWalDisabled };

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl },
  gap: { marginTop: space.md, textAlign: 'center', fontSize: font.base },
});
