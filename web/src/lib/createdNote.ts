import type { Task } from '../types.js';
import { asArray, isInTodayView, STATUS_FILTER_LABEL, type StatusFilter } from './taskView.js';
import { inAllView } from './simpleViews.js';

/**
 * 刚建好的这条任务，在你正看着的这一屏里看得见吗——看不见就说清楚它去哪了。
 *
 * 这不是客套话，是这个仓库栽过五次的那一类 bug 的正面预防：**写成功了，界面
 * 看上去却什么也没发生。**「今天」只收今天要提醒/今天截止/已经过期的任务，
 * 所以在「今天」里建一条不带时间的任务，卡片会落进「按来源」，你盯着的这一屏
 * 一点变化都没有——跟建失败长得一模一样。
 *
 * **返回 `null` = 它就在你眼前，没什么可说的。** 两个调用方对这一档的处理不
 * 一样，所以这里不替它们编一句话：
 * - `TaskComposer`：整个表单会关掉，那是一次明确的状态变化，回一句「已添加」
 *   确认一下是对的。
 * - `QuickAdd`：那一行留在原地等你接着打下一条，新任务就出现在它下面。连记
 *   五条弹五次「已添加」是噪音——**列表自己变了就是最好的回执**。
 *
 * 原来这段逻辑是 `TaskComposer` 里的一个闭包 `report()`，只能靠整棵应用树的
 * 端到端测试去碰；挪出来是为了第二个调用方，也是为了它终于测得动。
 *
 * 纯函数。`now` 只喂给 `isInTodayView`。
 */
export function createdNote(
  view: string,
  task: Task,
  now: Date,
  boardFilter: StatusFilter,
): string | null {
  // 手工建的任务不管有没有时间，一定会出现在「按来源」（它按来源分组，不看
  // 时间）——所以下面每一句「看不见」的兜底都是指向那里。
  const elsewhere = '已添加。这条在「按来源」里';

  if (view === 'today') {
    return isInTodayView(task, now) ? null : '已添加。没填今天的时间，这条在「按来源」里';
  }
  if (view === 'source') {
    // 第二种「看不见」：人在「按来源」里把筛选停在「已完成」之类的档上，新
    // 任务是 todo，加完之后看板上一张新卡都不会出现——跟建失败一模一样。
    return boardFilter !== 'all' && boardFilter !== task.status
      ? `已添加。当前筛选是「${STATUS_FILTER_LABEL[boardFilter]}」，这条是待办，清除筛选才看得到`
      : null;
  }
  if (view.startsWith('list:')) {
    return task.listId === view.slice('list:'.length) ? null : elsewhere;
  }
  if (view.startsWith('tag:')) {
    return asArray<string>(task.tags).includes(view.slice('tag:'.length)) ? null : elsewhere;
  }
  // 「全部」是唯一一个不挑时间、不挑清单的任务视图，新任务当场就在里面。
  // **这一支是搬家时顺手改对的**：原来的 `report()` 写在只有「今天」和
  // 「按来源」两个任务视图的年代，除这两个之外一律回「这条在『按来源』里」，
  // 后来加了「全部」也跟着吃这句话——而它明明就列在你眼前。
  if (view === 'all') return inAllView(task) ? null : elsewhere;

  // 剩下的（收件箱、日历、习惯……）本来就不展示任务卡，这一屏建完不会有任何
  // 变化，跟前面几种一样必须说清楚去哪了。
  return elsewhere;
}
