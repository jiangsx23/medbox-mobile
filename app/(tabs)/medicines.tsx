/**
 * 药品档案列表。
 *
 * 与首页的分工：首页回答「现在有什么」，这一页回答「这药我建过档没有」——
 * 所以它列出**全部档案，包括一盒都没有的**（在库数量显示 0）。
 * 页面上没有的东西（比如「已停用的药」）比页面上有错的更难查。
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { listMedicines, usedCategories, type MedicineListRow } from '../../src/data/queries';
import { formatDose } from '../../src/domain/forecast';
import { Empty } from '../../src/ui/components';
import { useQuery } from '../../src/ui/useQuery';
import { color, font, radius, screen, space, text, tone } from '../../src/ui/theme';

export default function MedicinesScreen() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');

  const rows = useQuery((db) => listMedicines(db, q, category), [q, category]);
  const categories = useQuery((db) => usedCategories(db));
  /**
   * 各类别各有多少种 —— **在搜索范围内统计，但不受类别筛选影响**。
   * 这样「全部」的数是搜索命中的总数，每个类别的数是它的子集，两者自洽：
   * 搜「沙坦」时显示「全部 2 / 心血管 2」。若改用筛选后的 rows.length，
   * 选中类别后「全部」会变成 2、点回「全部」又变回 37，看着像数字在乱跳。
   */
  const counts = useQuery((db) => {
    const inSearch = listMedicines(db, q, '');
    const byCategory = new Map<string, number>();
    for (const r of inSearch) {
      const c = r.medicine.category;
      if (c) byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    }
    return { all: inSearch.length, byCategory };
  }, [q]);

  const footer = useMemo(() => `共 ${rows.length} 种`, [rows.length]);

  return (
    <View style={screen}>
      <View style={styles.head}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={17} color={color.muted} />
          <TextInput
            style={styles.searchInput}
            value={q}
            onChangeText={setQ}
            placeholder="搜药名、品牌、规格、备注"
            placeholderTextColor={color.muted}
            returnKeyType="search"
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ('')} hitSlop={8}>
              <Ionicons name="close-circle" size={17} color={color.muted} />
            </Pressable>
          )}
        </View>

        {categories.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            <CategoryChip
              label={`全部 ${counts.all}`}
              on={category === ''}
              onPress={() => setCategory('')}
            />
            {categories.map((c) => (
              <CategoryChip
                key={c}
                label={`${c} ${counts.byCategory.get(c) ?? 0}`}
                on={category === c}
                onPress={() => setCategory(category === c ? '' : c)}
              />
            ))}
          </ScrollView>
        )}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.medicine.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Empty
            title={q || category ? '没有匹配的药品' : '还没有药品档案'}
            hint={
              q || category
                ? '换个词试试，或点上面的「全部」取消类别筛选。'
                : '点下面的「新建药品」登记一种；或者从网页版导入数据，档案会一次装好。'
            }
          />
        }
        renderItem={({ item }) => (
          <MedicineRow item={item} onPress={() => router.push(`/medicine/${item.medicine.id}`)} />
        )}
        ListFooterComponent={
          <View>
            {rows.length > 0 ? <Text style={styles.footer}>{footer}</Text> : null}
            {/* 放在页脚而不是固定在底部：药有 37 种，固定在底部会一直压着列表，
                而「新建」是个偶尔才用一次的动作。页脚既在列表末尾顺手的位置，
                空列表时它也照样出现 —— 那正是用户第一次进来最需要它的时刻。 */}
            <Pressable style={styles.addBtn} onPress={() => router.push('/medicine/new')}>
              <Ionicons name="add" size={16} color={color.brand} />
              <Text style={styles.addText}>新建药品</Text>
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

function CategoryChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function MedicineRow({ item, onPress }: { item: MedicineListRow; onPress: () => void }) {
  const m = item.medicine;
  const out = item.inStockQty === 0;
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitle}>
          <Text style={styles.generic}>{m.generic}</Text>
          {m.brand ? <Text style={text.muted}>（{m.brand}）</Text> : null}
        </View>
        <View style={styles.rowMeta}>
          {m.spec ? <Text style={text.muted}>{m.spec}</Text> : null}
          {m.category ? <Text style={styles.cat}>{m.category}</Text> : null}
          {m.dailyDose ? (
            <Text style={text.muted}>每日 {formatDose(m.dailyDose)}</Text>
          ) : null}
          {m.autoDeduct ? (
            <Text style={[styles.cat, styles.auto]}>自动扣减</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.rowRight}>
        <Text style={[styles.qty, out && styles.qtyOut]}>
          {out ? '无库存' : `${formatDose(item.inStockQty)} ${m.unit ?? ''}`}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={color.muted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    backgroundColor: color.bg,
    gap: space.md,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: font.base, color: color.ink, padding: 0 },
  chips: { gap: space.sm, paddingRight: space.lg },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
  },
  chipOn: { backgroundColor: color.brand, borderColor: color.brand },
  chipText: { fontSize: font.small, color: color.ink, fontWeight: '600' },
  chipTextOn: { color: color.white },

  list: { paddingHorizontal: space.lg, paddingBottom: space.xl * 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    marginBottom: space.sm,
  },
  rowPressed: { backgroundColor: color.cardWarm },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' },
  generic: { fontSize: font.base, fontWeight: '700', color: color.ink },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  cat: {
    fontSize: font.tiny,
    color: color.brand,
    backgroundColor: color.brandSoft,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  // 自动扣减标记用「需补货」那套橙 —— 它俩定位相同：值得多看一眼
  auto: { color: tone.restock.text, backgroundColor: tone.restock.bg },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  qty: { fontSize: font.small, fontWeight: '700', color: color.ink },
  qtyOut: { color: color.muted, fontWeight: '600' },
  footer: { textAlign: 'center', fontSize: font.tiny, color: color.muted, paddingVertical: space.md },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.brandSoft2,
    borderRadius: radius.lg,
    paddingVertical: 12,
    marginTop: space.sm,
  },
  addText: { fontSize: font.small, color: color.brand, fontWeight: '600' },
});
