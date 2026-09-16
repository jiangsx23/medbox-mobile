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
import type { CalendarDay } from '../db/schema';
import { today as todayDay } from '../domain/calendar';
import { hasAnyData } from '../importer/apply';
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
  /** 手动重跑闸门（导入完成后、下拉刷新时调用） */
  reload: () => void;
};

const DbContext = createContext<DbContextValue | null>(null);

export function useDb(): DbContextValue {
  const v = useContext(DbContext);
  if (!v) throw new Error('useDb() 必须在 <DbProvider> 里面用');
  return v;
}

type Ready = { db: MedboxDb; journalMode: string };

/**
 * 闸门本体。`settle()` 里目前**只做「打开 + 迁移」**这两件 M1 就需要的事。
 *
 * M4 的自动扣减结算要插在这里（`settleAll(db, today)`），插进来之后
 * 上面那句「读完闸门之前的数字永不矛盾」才真正成立。
 * 现在还没写，是因为 M1 导入时把 `auto_from` 重设成了导入当天、
 * `auto_accounted` 归零，所以**没有可结算的天数**，跑不跑结果一样。
 */
export function DbProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [day, setDay] = useState<CalendarDay>(() => todayDay());
  const busy = useRef(false);

  const run = useCallback(async () => {
    if (busy.current) return; // 冷启动与回前台可能几乎同时触发，串行化
    busy.current = true;
    try {
      let handle = ready;
      if (!handle) {
        const opened = await openMedboxDatabase();
        handle = { db: opened.db, journalMode: opened.journalMode };
        setReady(handle);
      }
      // M4: settleAll(handle.db, todayDay()) —— 结算插在这一行

      // 回前台时可能已经跨了午夜，日期要跟着走，否则「今天到期」会算错一天
      setDay(todayDay());
      setVersion((v) => v + 1);
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
        reload: () => void run(),
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
