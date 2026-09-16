/**
 * 「跟着闸门刷新」的取数钩子。
 *
 * 存在的唯一理由：把 `version` 自动塞进依赖数组。手写 `useMemo(fn, [version])`
 * 很容易漏掉它，而漏掉的表现是**回前台后数字不更新** —— 用户会以为药没扣，
 * 这种 bug 不会崩、不会报错，只会让人不再信任这个 App。
 *
 * 注意 `deps` 里**不要**再放 `db` 或 `today` 之外的东西当「刷新开关」；
 * 要刷新就说明数据变了，那就该走 `reload()`。
 */
import { useMemo } from 'react';

import { useDb } from './DbProvider';

/**
 * 跑一个同步查询并缓存结果。查询函数必须依赖 `db` 与 `today` 是纯的，
 * 且**不能有副作用** —— 它在渲染期间执行。
 */
export function useQuery<T>(fn: (db: ReturnType<typeof useDb>['db'], today: ReturnType<typeof useDb>['today']) => T, deps: unknown[] = []): T {
  const { db, today, version } = useDb();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 就是要的「外部失效信号」，deps 由调用方给
  return useMemo(() => fn(db, today), [db, today, version, ...deps]);
}
