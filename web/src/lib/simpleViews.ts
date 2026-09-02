import type { Task } from '../types.js';
import { sortByUrgency } from './taskView.js';
import { nestChildren } from './hierarchy.js';
import type { GridSection } from '../components/TaskGrid.js';

/**
 * 一条任务算不算「全部」里的。**做完和放弃的不算，搁置的算**——它还会回来，
 * 人心里还留着它。判据用 `isSettled` 会连搁置一起排除，那不对，所以逐个列，
 * 不复用它。
 *
 * **导出是因为导航上那个数字得跟这份列表说同一句话**：那边原来自己写了一遍
 * `status !== 'done'`，漏了放弃的（那个状态是后加的）——于是徽标写着 12、
 * 点进去只有 10，而这个应用最怕的就是界面说的跟实际不符。
 */
export const inAllView = (t: Task): boolean => t.status !== 'done' && t.status !== 'abandoned';

/** 「全部」：所有还没了结的，一组，按紧急度。判据见上面的 `inAllView`。 */
export function allSections(tasks: Task[], now: Date, keep: Set<string>): GridSection[] {
  const visible = tasks.filter((t) => inAllView(t) || keep.has(t.id));
  // 排完序再把子任务挪到各自父亲后面——顺序是先排后挪，反过来会让排序把
  // 刚挪好的父子拆开。判据在 lib/hierarchy.ts。
  return [{ key: 'all', title: '全部', tasks: nestChildren(sortByUrgency(visible, now)) }];
}

/**
 * 「已完成」：两组——做完的和放弃的，最近的排最前。
 *
 * 仿滴答清单：它把这两样摆在同一个「已完成&已放弃」分组里。放弃的任务得有
 * 一个能翻到的地方，不然「不删、以后回顾还看得见」这句话就是空的——而它们
 * 已经从「全部」「今天」「接下来」里退出去了。
 */
export function doneSections(tasks: Task[], keep: Set<string>): GridSection[] {
  // completedAt 是第一批新加的字段，迁移过来的老任务上是 null——退到 updatedAt，
  // 而不是当成 0 一股脑沉到最底下（那会让所有历史任务的顺序变成随机的）。
  // 放弃的任务没有 completedAt（服务端只在跃迁到 done 时盖章），恒走 updatedAt
  // 这一支，也就是「最后一次动它是什么时候」——那正是「什么时候放弃的」。
  const when = (t: Task) => Date.parse(t.completedAt ?? t.updatedAt) || 0;

  // **正在编辑的卡必须落在某一组里**（TaskGrid 的契约，见那个文件顶部）：
  // 在这个视图里点「重开」/「重新开始」，status 当场变回 todo，如果只按
  // status 分组，那张卡连同没保存的草稿会在手底下蒸发。规则是：
  // - 已放弃的（含正在编辑的已放弃的）落「已放弃」；
  // - 其余的——真已完成的、以及**正在编辑但已经不是这两种状态**的——落
  //   「已完成」，也就是它被点之前待的那一组。
  // 两条加起来覆盖这个视图收进来的每一条，不会有卡无处可去。
  const mine = tasks.filter((t) => t.status === 'done' || t.status === 'abandoned' || keep.has(t.id));
  const group = (want: 'done' | 'abandoned') => nestChildren(
    mine.filter((t) => (t.status === 'abandoned' ? 'abandoned' : 'done') === want)
      .sort((a, b) => when(b) - when(a)),
  );
  return [
    { key: 'done', title: '已完成', tasks: group('done') },
    { key: 'abandoned', title: '已放弃', tasks: group('abandoned') },
  ];
}
