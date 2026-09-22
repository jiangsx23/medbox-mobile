/**
 * 通知自检 —— M5 的配套页，专门对付「手机系统会杀后台提醒」这件事。
 *
 * ── 为什么非要有这一页 ────────────────────────────────────────────────
 * 推送是本品**唯一一个「用户不打开 App 也要正确运行」的功能**，而它能不能
 * 真跑起来，取决于三件 App 管不了的事：系统的通知权限、通知频道、以及
 * 厂商省电策略（小米的「自启动 / 锁后台 / 省电无限制」）。前两件能读、能显示；
 * 第三件**没有任何公开 API** —— 只能靠人眼去系统设置里看。
 * 所以这一页的定位是**诊断仪**：把能读的都读出来，读不到的就老实说读不到。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 * 🔴 **只读**。显示现状不会改动任何东西 —— 否则「看一眼」这件事本身
 *    就成了被观察对象的一部分。
 * 🔴 **不把「5 秒后推一条」当成功判据**。它只验了频道、权限和前台展示，
 *    走的**不是**「进程不在」那条路。真正的验法是第二个按钮 + 划掉 App + 锁屏。
 * 🔴 **不谎报**。MIUI 的白名单没法自动检测，页面就写「请自己看一眼有没有锁头」，
 *    绝不画一个假的状态灯。
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CHANNEL_ID, probe, pushTestNow, scheduleTestIn, type NotifyProbe } from '../src/notify/scheduler';
import { Card, Field, SectionTitle } from '../src/ui/components';
import { useDb } from '../src/ui/DbProvider';
import { Button } from '../src/ui/form';
import { color, font, screen, space, tone } from '../src/ui/theme';

/** Android 13 起通知权限变成运行时权限，流程与 8.1 完全不同（§6.7）。 */
const ANDROID_TIRAMISU = 33;

/**
 * API 级别 → 版本名。
 *
 * 为什么不能直接印 `Platform.Version`：它在 Android 上返回的是 **API 级别**（这台机器是 `27`），
 * 印出来就是「Android 27」—— 而 Android 根本没有 27 这个版本。这一页的全部价值就是
 * 「让用户知道自己的系统处在哪条权限路径上」，把版本说错就把它变成了误导。
 * 用户认得「8.1」，不认得「27」。
 *
 * API 24 = `minSdkVersion`，36 = `targetSdkVersion`；表外的一律退化成 `API N`（不猜）。
 * ⚠️ 新 Android 发布时这里要补一行 —— 漏了不会出错，只会显示得难看。
 */
const ANDROID_NAMES: Record<number, string> = {
  24: '7.0',
  25: '7.1',
  26: '8.0',
  27: '8.1',
  28: '9',
  29: '10',
  30: '11',
  31: '12',
  32: '12L',
  33: '13',
  34: '14',
  35: '15',
  36: '16',
};

function androidLabel(sdk: number): string {
  const name = ANDROID_NAMES[sdk];
  return name === undefined ? `API ${sdk}` : `Android ${name}（API ${sdk}）`;
}

/** 只取本地的「时:分」。`toLocaleString()` 会把日期再印一遍，而左边已经印了。 */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function NotifyCheckScreen() {
  const { db, notifyError, reload } = useDb();

  const [state, setState] = useState<NotifyProbe | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await probe());
    } catch (e) {
      // 读不出来不是致命错误，但要说出来 —— 沉默的自检页比没有自检页更糟
      setNote(`读不到通知状态：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (which: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(which);
    setNote(null);
    try {
      await fn();
      setNote(done);
    } catch (e) {
      setNote(`失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const sdk = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  const pending = state?.scheduled ?? [];
  // 只显示最近要来的三条；NULL 的（测试条）排最后
  const soon = [...pending]
    .sort((a, b) => (a.dateMs ?? Number.MAX_SAFE_INTEGER) - (b.dateMs ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 3);

  return (
    <ScrollView style={screen} contentContainerStyle={styles.content}>
      <SectionTitle>现在是什么状态</SectionTitle>
      <Card>
        {/* 系统版本必须显示：它决定下面哪些权限根本不适用 */}
        <Field label="系统版本" value={androidLabel(sdk)} />
        <Text style={styles.note}>
          {sdk >= ANDROID_TIRAMISU
            ? '这台机器是 Android 13 以上，通知权限要用户手动允许。'
            : '这台机器低于 Android 13，装好就默认有通知权限，不会弹框。'}
        </Text>

        <Field
          label="通知权限"
          value={
            state === null
              ? '读取中…'
              : state.permission === 'granted'
                ? '已允许'
                : state.permission === 'undetermined'
                  ? '还没问过'
                  : '未允许'
          }
          valueStyle={state?.permission === 'granted' ? undefined : styles.bad}
        />
        {state !== null && state.permission !== 'granted' ? (
          <Text style={styles.badNote}>
            {state.canAskAgain
              ? '还没问过系统。关闭再打开「提醒」开关就会问一次。'
              : '已经被拒绝过，App 不会再弹框。请到「设置 → 应用管理 → 家庭药箱 → 通知」里手动打开。'}
          </Text>
        ) : null}

        <Field
          label="通知频道"
          value={
            state === null
              ? '读取中…'
              : state.channelExists
                ? `${CHANNEL_ID} · 重要度 ${state.channelImportance}${state.channelWillBanner ? '（会弹横幅）' : '（不弹横幅）'}`
                : '缺失'
          }
          valueStyle={state?.channelExists ? undefined : styles.bad}
        />
        {state !== null && !state.channelExists ? (
          <Text style={styles.badNote}>
            ⚠️ Android 8 以上没有通知频道，通知会被系统
            <Text style={styles.strong}>静默丢弃</Text>
            {' '}—— 不报错、不提示，就是不来。回到设置页关掉再打开「提醒」开关即可重建。
          </Text>
        ) : null}

        <Field label="待发提醒" value={`${pending.length} 条`} />
        {soon.length > 0 ? (
          soon.map((p) => (
            <Text key={p.id} style={styles.mono}>
              {p.day ?? '（测试通知）'}
              {/* 左边印标识符里的日期、右边印触发器里的时刻 —— 两个都印是为了能**看出它们对不上**：
                  前者是我们解析出来的，后者是原生真的要响的时刻 */}
              {p.dateMs !== null ? ` · ${hhmm(p.dateMs)}` : ''}
            </Text>
          ))
        ) : (
          <Text style={styles.note}>
            队列是空的。要么最近没有要提醒的事，要么提醒开关关着，要么排的时候还没到点。
          </Text>
        )}

        <Field
          label="上次重排"
          value={notifyError === null ? '正常' : '失败'}
          valueStyle={notifyError === null ? undefined : styles.bad}
        />
        {notifyError !== null ? <Text style={styles.badNote}>{notifyError}</Text> : null}

        <Pressable
          style={styles.action}
          // forceNotify：**这个按钮的全部意义就是「队列可能坏了，重排一遍」**，
          // 所以它必须无条件重发。不强制的话它自己也会掉进那个坑：
          // 重启后队列真空、而 expo 的记录还在 ⇒ 「计划没变」⇒ 什么都不写 ⇒ 修不好。
          onPress={() => void run('reload', async () => reload({ forceNotify: true }), '已重新对齐一次。')}
        >
          <Ionicons name="refresh-outline" size={18} color={color.brand} />
          <Text style={styles.actionLabel}>重新对齐一次</Text>
          {busy === 'reload' ? <Text style={styles.note}>…</Text> : null}
        </Pressable>
        <Text style={styles.note}>
          重新对齐会按现在的库存把队列全部重发一遍。没坏的时候它是无害的，坏的时候它是唯一能修好的办法。
        </Text>
      </Card>

      <SectionTitle>通知没来？按这四步做一遍</SectionTitle>
      <Card>
        <Text style={styles.step}>
          1. 省电策略 → 选「无限制」。设置 → 应用管理 → 家庭药箱 → 省电策略。
        </Text>
        <Text style={styles.step}>2. 自启动 → 打开。同上那个页面的「自启动」。</Text>
        <Text style={styles.step}>
          3. 锁后台 → 打开最近任务，在家庭药箱那张卡片上「下拉」，出现一个锁头图标。
        </Text>
        <Text style={styles.step}>
          4. 通知优先级 → 设置 → 通知管理 → 家庭药箱 → 把提醒的优先级设为「优先」。
        </Text>
        <Text style={styles.note}>
          找不到就先在系统设置里搜「省电」「自启动」「通知」。这几项在小米手机上
          就是会杀定时提醒，
          <Text style={styles.strong}>这件事没有 100% 的代码解</Text>
          {' '}—— 白名单只是缓解。
        </Text>
        <Text style={styles.note}>
          第 3 步没法自动检查（系统没有公开接口），所以只能靠你自己看一眼有没有锁头。
        </Text>
      </Card>

      <SectionTitle>试一下</SectionTitle>
      <Card>
        <Text style={styles.note}>
          这两个按钮测的不是同一件事，
          <Text style={styles.strong}>别拿第一个当成功判据</Text>。
        </Text>
        <Button
          label={busy === 'now' ? '已排上…' : '马上推一条（5 秒后）'}
          onPress={() => void run('now', () => pushTestNow(), '5 秒后会到。它只验频道和权限，App 正开着。')}
        />
        <View style={styles.gap} />
        <Button
          label={busy === 'minute' ? '已排上…' : '排一条 1 分钟后的'}
          onPress={() =>
            void run(
              'minute',
              () => scheduleTestIn(60),
              '已排上。现在把「家庭药箱」从最近任务里划掉，然后锁屏等一分钟。',
            )
          }
        />
        <Text style={styles.note}>
          第二个才是真正的验证：排好之后
          <Text style={styles.strong}>把 App 从最近任务划掉、锁屏</Text>
          ，一分钟内状态栏应该弹出来。做到了，说明闹钟在进程不存在时也能由系统自己触发。
        </Text>
        <Text style={styles.warn}>
          ⚠️ 划掉和「强行停止」不是一回事：划掉
          <Text style={styles.strong}>不会</Text>
          取消闹钟（应该收到）；而在系统设置里「强行停止」会让 App 进入停止状态、
          <Text style={styles.strong}>丢掉所有闹钟</Text>
          {' '}—— 这是 Android 的规定，不是坏了。测的时候只用划掉。
        </Text>
        <Text style={styles.note}>
          测试通知的标识符带 test 前缀，所以日常重排
          <Text style={styles.strong}>不会</Text>
          把它删掉。
        </Text>
      </Card>

      {note !== null ? <Text style={styles.result}>{note}</Text> : null}

      <Text style={styles.note}>
        通知里永远不会出现药名，标题只有「药箱：N 件事待处理」。药箱的其它功能
        一个都不依赖通知 —— 就算它彻底不来，首页上照样看得到全部信息。
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xl * 3 },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  actionLabel: { flex: 1, fontSize: font.base, fontWeight: '700', color: color.ink },
  note: { fontSize: font.tiny, color: color.muted, marginTop: space.xs, lineHeight: 17 },
  // 强调走嵌套 <Text> 而不是 Markdown 的 `**` —— RN 不认识 Markdown，会把星号原样画出来
  strong: { fontWeight: '700', color: color.ink },
  bad: { color: tone.danger.text, fontWeight: '700' },
  badNote: { fontSize: font.tiny, color: tone.danger.text, marginTop: space.xs, lineHeight: 17 },
  warn: {
    fontSize: font.tiny,
    color: tone.warn.text,
    backgroundColor: tone.warn.bg,
    borderWidth: 1,
    borderColor: tone.warn.bd,
    borderRadius: 8,
    padding: space.sm,
    marginTop: space.sm,
    lineHeight: 17,
  },
  step: { fontSize: font.small, color: color.ink, marginTop: space.sm, lineHeight: 20 },
  mono: { fontSize: font.tiny, color: color.ink, marginTop: 2 },
  gap: { height: space.sm },
  result: {
    fontSize: font.small,
    color: color.ink,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 8,
    padding: space.md,
    marginTop: space.lg,
    lineHeight: 19,
  },
});
