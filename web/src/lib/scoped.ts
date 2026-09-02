import type { List, Task } from '../types.js';
import { asArray, sortByUrgency } from './taskView.js';
import { taggedWith } from './tagTree.js';
import { nestChildren } from './hierarchy.js';
import { applyFilter } from './smartFilter.js';
import type { GridSection } from '../components/TaskGrid.js';

/**
 * 清单和标签这两种**动态**去处。它们不在 VIEW_SPECS 里——数量运行时才知道，
 * 而两者渲染的是同一个组件，区别只在谓词。返回 null 表示「这个 key 不归我管」。
 *
 * `list:<id>` 要分叉：`lists` 里那条记录 `filter` 非 null 时是**智能清单**——
 * 存下来的查询，不是容器，取任务按 `applyFilter` 算，不看 `listId`；`filter`
 * 是 null 或者这个 id 在 `lists` 里根本找不到（清单被删了/还没拉到）时退回
 * 普通清单那条老路，按 `listId ===` 取，见 task-3-brief 要点②。
 */
export function scopedSections(
  tasks: Task[], view: string, now: Date, keep: Set<string>, lists: List[],
): GridSection[] | null {
  let match: (t: Task) => boolean;
  if (view.startsWith('list:')) {
    const id = view.slice('list:'.length);
    const smart = lists.find((l) => l.id === id)?.filter ?? null;
    if (smart) {
      const matchedIds = new Set(applyFilter(tasks, smart, now).map((t) => t.id));
      match = (t) => matchedIds.has(t.id);
    } else {
      match = (t) => t.listId === id;
    }
  } else if (view.startsWith('tag:')) {
    // slice 而不是 split(':')[1]——标签名里可以有冒号（'项目:035'）。
    const tag = view.slice('tag:'.length);
    // **父标签连子标签一起算**（二级标签，仿滴答清单）：点进「工作」要看到
    // `#工作/项目A` 的任务，不然层级只是侧栏上好看一点，点进去还是空的。
    // 判据在 lib/tagTree.ts——它带上分隔符比前缀，`#工作台` 不会被算成
    // `#工作` 的子标签。
    match = (t) => taggedWith(asArray<string>(t.tags), tag);
  } else if (view.startsWith('context:')) {
    // 情境（GTD）。跟标签不一样，这一维**没有层级**：五档平的，没有
    // 「父情境连子情境一起算」这回事，也就不需要 `taggedWith` 那套。
    // 没分情境的进不来（`t.context` 是 null 就不等）——跟筛选栏那一维、
    // 侧栏那个数字三处同一条口径。
    match = (t) => t.context === view.slice('context:'.length);
  } else {
    return null;
  }

  const mine = tasks.filter((t) => match(t) || keep.has(t.id));
  // **三组，不是两组。** 原来只分「done / 非 done」，于是**已放弃的落进
  // 「未完成」**——那一组的名字在这时候是句假话：那条任务不是没做完，是明确
  // 决定不做了。「已放弃」这个状态是后加的，这一行没跟上，跟 `inAllView`
  // 注释里记的那次（导航徽标漏掉放弃的）是同一个形状。
  //
  // 分组规则跟 `doneSections` 一致：放弃的自己一组，其余按 done / 不 done。
  // 空组 `TaskGrid` 整个不渲染，所以绝大多数清单看起来还是两组。
  // 三条加起来覆盖 `mine` 里每一条，`keep`（正在编辑、状态刚被点变）也一定
  // 落得进某一组——那是 TaskGrid 的契约，见那个文件顶部。
  const of = (t: Task) => (t.status === 'abandoned' ? 'dropped' : t.status === 'done' ? 'closed' : 'open');
  const group = (want: 'open' | 'closed' | 'dropped') => mine.filter((t) => of(t) === want);
  return [
    // 排完序再把子任务挪到各自父亲后面，见 lib/hierarchy.ts。
    { key: 'open', title: '未完成', tasks: nestChildren(sortByUrgency(group('open'), now)) },
    // 这两组**默认折起来**（`TaskGrid` 的 `startFolded`）：一份用了一年的
    // 清单底下挂着两百条做完的卡，每次点进去都要从它们上面滚过去。滴答清单
    // 那边默认干脆不显示已完成的；折起来加一个数字比整个藏掉更本分——「这份
    // 清单我做完过多少」本身是句有用的话，而且一点就展开。
    //
    // 「未完成」不给这个标记：那是点进一份清单要看的东西，没有折起来的道理。
    { key: 'closed', title: '已完成', tasks: nestChildren(group('closed')), startFolded: true },
    { key: 'dropped', title: '已放弃', tasks: nestChildren(group('dropped')), startFolded: true },
  ];
}
