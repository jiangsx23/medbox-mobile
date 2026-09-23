/**
 * 根布局。
 *
 * 唯一不显然的一点：**`DbProvider` 在 `Stack` 外面**。
 * 这样闸门没开时整个导航器都不会挂载，任何界面都没有机会去读库存 ——
 * 比「每个页面自己判断加载状态」可靠得多（后者漏一个页面就出现自相矛盾的数字）。
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DbProvider } from '../src/ui/DbProvider';
import { color, font } from '../src/ui/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <DbProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: color.bgTop },
            headerTintColor: color.ink,
            headerTitleStyle: { fontSize: font.base, fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: color.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          {/* 药品列表：药箱 tab 上每张统计卡 / 每个过滤项都落到这里。
              标题由这一页自己按当前筛选覆盖（「快过期」「需补货」…），这行只是兜底 */}
          <Stack.Screen name="stock" options={{ title: '在库药品' }} />
          <Stack.Screen name="medicine/[id]/index" options={{ title: '药品详情' }} />
          {/* 标题由各页自己用 <Stack.Screen options> 覆盖 —— 入库页要带药名 */}
          <Stack.Screen name="medicine/new" options={{ title: '新建药品' }} />
          <Stack.Screen name="medicine/[id]/edit" options={{ title: '编辑档案' }} />
          <Stack.Screen name="batch/new" options={{ title: '入库' }} />
          <Stack.Screen name="batch/[id]/edit" options={{ title: '编辑这一盒' }} />
          <Stack.Screen name="member/new" options={{ title: '添加成员' }} />
          <Stack.Screen name="member/[id]/index" options={{ title: '成员' }} />
          <Stack.Screen name="member/[id]/edit" options={{ title: '编辑成员' }} />
          <Stack.Screen name="import" options={{ title: '导入数据' }} />
          <Stack.Screen name="export" options={{ title: '导出数据' }} />
          <Stack.Screen name="notify-check" options={{ title: '通知自检' }} />
        </Stack>
      </DbProvider>
    </SafeAreaProvider>
  );
}
