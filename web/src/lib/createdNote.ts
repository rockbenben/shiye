import type { Task } from '../types.js';
import { asArray, isInTodayView, STATUS_FILTER_LABEL, type StatusFilter } from './taskView.js';
import { inAllView } from './simpleViews.js';
import { dueBucketOf } from './agenda.js';

/**
 * 刚建好的这条任务，在你正看着的这一屏里看得见吗——看不见就说清楚它去哪了。
 *
 * 这不是客套话，是这个仓库栽过五次的那一类 bug 的正面预防：**写成功了，界面
 * 看上去却什么也没发生。**「今天」只收今天要提醒/今天截止/已经过期的任务，
 * 所以在「今天」里建一条不带时间的任务，卡片会落进「按来源」，你盯着的这一屏
 * 一点变化都没有——跟建失败长得一模一样。
 *
 * **说一句之前先问「为什么看不见」**：看不见有好几种原因（没定时间 / 日期在
 * 将来 / 清单对不上 / 筛选挡住了），**每一种的下一步不一样**。笼统一句
 * 「没填今天的时间」会把「日期在将来」也说成「你漏填了」——而他并没有漏。
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
 * 纯函数。`now` 喂给 `isInTodayView` 和 `dueBucketOf`。
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
    if (isInTodayView(task, now)) return null;
    // **分两种情况说，理由不同、去处也不同。**
    //
    // 原来这一支只有一句「已添加。没填今天的时间，这条在「按来源」里」——
    // 那是**没定时间**那件事的话。但最常见的一格根本不是它：人在「今天」里
    // 写「明天下午三点给猫买猫粮」，日期被认走了、截止落在明天 15:00，
    // 于是这条**不在「今天」**。这时候屏幕上来的却是「没填今天的时间」——
    // 他明明写了「明天下午三点」，这句话读起来就是「你漏填了时间」，
    // 于是他回头去检查自己写的话，**而真正该说的是「日期不在今天」**。
    //
    // 去处也一并改：定了将来日期的这条在「接下来」里（「明天」那一组），
    // 那才是他刚写下的那个日期所在的地方。「按来源」当然也有它，但那是
    // 按「谁写的」分组的去处——新用户根本不知道那个去处是干什么的，
    // 而「接下来」是「今天」旁边那一个，说「它去隔壁了」比说「它去档案室了」
    // 好懂。
    //
    // 分档用 `dueBucketOf`（全站唯一那份「这条算哪一档」，「接下来」那一屏
    // 和「按到期时间分组」都调它）——不在这儿另写一遍日期比较。
    const bucket = dueBucketOf(task, now);
    if (bucket === 'tomorrow' || bucket === 'week' || bucket === 'later') {
      return '已添加。日期不在今天，这条在「接下来」里';
    }
    if (bucket === 'notStarted') {
      return '已添加。还没到能开始的时间，这条在「接下来」里';
    }
    if (bucket === 'none') {
      return '已添加。没定时间，这条在「按来源」里';
    }
    return elsewhere;
  }
  if (view === 'source') {
    // 第二种「看不见」：人在「按来源」里把筛选停在「已完成」之类的档上，新
    // 任务是 todo，加完之后看板上一张新卡都不会出现——跟建失败一模一样。
    return boardFilter !== 'all' && boardFilter !== task.status
      ? `已添加。当前筛选是「${STATUS_FILTER_LABEL[boardFilter]}」，这条是待办，清除筛选才看得到`
      : null;
  }
  // **「接下来」按截止分桶装下全部没了结的任务**（`agendaSections`），新任务
  // 当场就落在其中一组里（没定时间 → 「没有时间」那一组）。
  //
  // 原来这一支没有，被底下那个兜底接走了，于是加完一条弹一句「已添加。这条
  // 在『按来源』里」——**而那张新卡就在他眼前**。屏幕上写着「这条在别处」、
  // 眼前摆着「这条在这儿」，两句话打架，他得先信哪一句？多半是都不信，
  // 然后开始怀疑是不是真存上了。
  if (view === 'upcoming') {
    if (!inAllView(task)) return elsewhere;
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
  // 情境那个去处：新建时情境已经预填成它了（`composeDefaults`），所以它
  // 就在这一屏里。跟清单/标签那两支同一条判据。
  if (view.startsWith('context:')) {
    return task.context === view.slice('context:'.length) ? null : elsewhere;
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
