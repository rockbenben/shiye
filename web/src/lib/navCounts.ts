import type { List, Task, TaskContext } from '../types.js';
import { inAllView } from './simpleViews.js';
import { applyFilter } from './smartFilter.js';
import { taggedWith } from './tagTree.js';
import { asArray } from './taskView.js';

/**
 * 侧栏里每份清单、每个标签后面那个数字——**还没了结的有几条**（仿滴答清单）。
 *
 * 为什么要有：一屏侧栏摆着十份清单，哪一份真的堆着活、哪一份早就空了，
 * 在这之前只能一个个点进去看。导航上「今天」「收件箱」「全部」一直有这个数，
 * 清单和标签没有——而它们恰恰是数量会长的那一批。
 *
 * **口径只有一个：`inAllView`**（不是 done、也不是 abandoned；搁置的算）。
 * 三个理由拴在一起：
 * ① 跟导航上「全部」那个数同一条判据，两个数字摆在同一根侧栏上，不能各算各的；
 * ② 跟点进去之后「未完成」那一组看到的是同一批（`scoped.ts` 的分组也是这条）；
 * ③ 已完成的数量只会越来越大，挂一个一直在涨的数字没有意义——这正是导航上
 *    「已完成」那个去处**故意不给 count** 的理由（见 `lib/views.tsx`）。
 *
 * **智能清单也按这条算**：先 `applyFilter` 拿到它匹配的那一批，再数其中没了结的。
 * 一份查询可能明确筛的就是「已完成」，那时这个数是 0——那不是算错，那份清单
 * 点进去「未完成」那一组也确实是空的，两边说的是同一句话。
 *
 * 纯函数：`now` 由调用方传（智能清单里「N 天内」要用）。
 */

/** 每份清单一个数，key 是清单 id。0 也在表里——渲染层自己决定 0 要不要画
 *  （侧栏的规矩是不画，「一个常驻的 0 是噪音」）。 */
export function listCounts(tasks: Task[], lists: List[], now: Date): Map<string, number> {
  const open = tasks.filter(inAllView);
  const out = new Map<string, number>();
  // 普通清单一趟扫完，不是每份清单各扫一遍全表——十份清单一千条任务就是
  // 一万次比较，而这个函数每次渲染侧栏都跑。
  const byList = new Map<string, number>();
  for (const t of open) {
    if (t.listId) byList.set(t.listId, (byList.get(t.listId) ?? 0) + 1);
  }
  for (const l of lists) {
    out.set(l.id, l.filter
      ? applyFilter(tasks, l.filter, now).filter(inAllView).length
      : byList.get(l.id) ?? 0);
  }
  return out;
}

/**
 * 一个标签下还没了结的有几条。**父标签连子标签一起算**（`taggedWith`）——
 * 点进「工作」看得到 `#工作/项目A` 的任务，那个数就得跟看到的对得上。
 */
export function tagCount(tasks: Task[], tag: string): number {
  return tasks.filter((t) => inAllView(t) && taggedWith(asArray<string>(t.tags), tag)).length;
}

/**
 * 一个情境下还没了结的有几条。口径跟 `tagCount` 一字不差（`inAllView`）——
 * 侧栏上那一排数字背后必须是同一个问题的答案，不然「标签 3」和「情境 3」
 * 各说各的，人会开始不信这排数字。
 *
 * **没分情境的永远不计入任何一档**，跟 `applyFilter` 那一维同一条（见
 * smartFilter.ts）：侧栏上五档加起来小于「全部」是对的。
 */
export function contextCount(tasks: Task[], context: TaskContext): number {
  return tasks.filter((t) => inAllView(t) && t.context === context).length;
}

/**
 * 一个文件夹下面所有清单加起来还没了结的有几条。
 *
 * **只数它当下装着的那几份清单**（`lists` 由调用方筛好——侧栏传的是没归档的
 * 那一批），不自己去猜 `folderId`：文件夹这一层在界面上就是「把几份清单收起来
 * 摆在一个标题下」，那个标题上的数字该跟它底下那几行加起来对得上，一条不多
 * 一条不少。归档的清单不在那个标题下面，自然也不该算进那个数。
 */
export function folderCount(counts: Map<string, number>, lists: List[]): number {
  return lists.reduce((n, l) => n + (counts.get(l.id) ?? 0), 0);
}
