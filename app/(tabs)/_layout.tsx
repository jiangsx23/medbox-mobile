/**
 * 底部 4 个 tab。M1 只要求「骨架」，所以成员页与设置页是占位。
 *
 * 顺序按使用频率：查药（首页）→ 翻档案（药品）→ 看人（成员）→ 配置（设置）。
 */
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { color, font } from '../../src/ui/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.bgTop },
        headerTintColor: color.ink,
        headerTitleStyle: { fontSize: font.base, fontWeight: '700' },
        headerShadowVisible: false,
        tabBarActiveTintColor: color.brand,
        tabBarInactiveTintColor: color.muted,
        tabBarStyle: { backgroundColor: color.bgTop, borderTopColor: color.line },
        tabBarLabelStyle: { fontSize: font.tiny, fontWeight: '600' },
        sceneStyle: { backgroundColor: color.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '药箱',
          tabBarLabel: '药箱',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="home-outline" color={c} size={size} />,
        }}
      />
      <Tabs.Screen
        name="medicines"
        options={{
          title: '药品档案',
          tabBarLabel: '药品',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="medkit-outline" color={c} size={size} />,
        }}
      />
      <Tabs.Screen
        name="members"
        options={{
          title: '成员',
          tabBarLabel: '成员',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="people-outline" color={c} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarLabel: '设置',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="settings-outline" color={c} size={size} />,
        }}
      />
    </Tabs>
  );
}
