import type { Reminder, Task } from '../types.js';
import { asArray } from './taskView.js';

/**
 * 「创建副本」（仿滴答清单）带走什么。
 *
 * **照抄内容，不照抄经历。** 一条任务上的字段分得开两类：一类说的是「这件事
 * 是什么」（标题、备注、什么时候要做、分几步、归哪儿、要花多久），另一类说的
 * 是「上一条经历过什么」（做到哪一步了、什么时候做完的、改过几次期、专注了
 * 多久）。副本没经历过任何事，第二类一律不带。
 *
 * 判断挪出 `App.tsx` 是为了下面那条守卫测得动：**`Task` 加一个新字段时，这里
 * 必须做一次决定**，不然它会被静默漏掉——`estimateMinutes` 就是这么漏的
 * （它是后加的字段，加的时候只更新了服务端 `nextInstance`，没更新这里，于是
 * 「预计 45 分钟」的任务复制一份出来就没有估计了，而「拿副本当模板」正是这个
 * 功能最常见的用法）。同一类漏字段的事在 `api.addTask` 那一层也发生过
 * （tags/priority），那边现在有 `Object.keys(emptyDraft())` 的结构性守卫，
 * 这里是它的孪生兄弟。
 */
export const COPIED = [
  'title', 'notes', 'due', 'startAt', 'endAt', 'reminders', 'persistentReminder', 'subtasks', 'listId', 'section', 'tags',
  'priority', 'repeat', 'waitingFor', 'context', 'habit', 'estimateMinutes',
] as const;
// `section`（清单里的分段）归「这件事是什么」那一类，跟 `listId` 一起带走：
// 副本最常见的用法是当模板改，而「它属于哪一段」跟「它在哪份清单」是同一个
// 坐标的两半，带一半不带另一半只会让副本落在一个奇怪的位置。
// `startAt`（开始时间）归「这件事是什么」那一类，跟 `due` 一起带走：它是这件
// 事的计划的一半（「那天之前别管它」），不是上一条的经历。拿副本当模板时，
// 一条「9 月 10 日才开始」的任务复制出来还是 9 月 10 日开始——跟 due 的处理
// 一字不差，两个字段本来就是「时间段」的两端。

/**
 * 明确**不**带的，三类：
 *
 * ① 服务端说了算的：`id`/`createdAt`/`updatedAt`/`source`/`order`。
 * ② 上一条的经历：`status`（副本从头开始）、`completedAt`、`postponeCount`、
 *    `focusSessions`、`attachments`。`aiComment` 也在这一类，另外还有第二个
 *    理由：它是 AI 当时**为那一条**写的话，抄到一条人手建的副本上，卡片上那
 *    句群青就在说谎。
 * ③ 关系：`parentId`/`pinned`。一条子任务的副本挂在同一个父亲下面看着合理，
 *    但「创建副本」最常见的用法是拿它当模板改，多一层要先解开的关系不如不给
 *    ——他要挂上去，编辑表单里一步就能挂。置顶同理。
 */
export const DROPPED = [
  'id', 'status', 'source', 'aiComment', 'createdAt', 'updatedAt', 'order',
  'completedAt', 'postponeCount', 'attachments', 'focusSessions', 'pinned', 'parentId',
  // `reviewedAt` 归第②类（上一条的经历）：那个章说的是「他在回顾里看过**那一条**」，
  // 副本是一条他刚建出来的新任务，他还没看过它。带过去等于让副本一出生就自带
  // 七天的回顾豁免。
  'reviewedAt',
] as const;

/** 副本的草稿。纯函数：不发请求、不读时钟，标题上的「（副本）」也在这里加。 */
export function duplicateDraft(t: Task): Partial<Task> {
  return {
    title: `${t.title}（副本）`,
    notes: t.notes,
    due: t.due,
    // 「时间段」的两端一起带走：一条「9 月 10 日才开始」的任务复制出来还是
    // 9 月 10 日开始。它属于「这件事是什么」那一类（计划的一半），不是上一条
    // 的经历——理由跟 `due` 一字不差。
    startAt: t.startAt ?? null,
    // 结束时刻跟开始时刻一起带走——它们是「时间段」的两端，带一半等于把
    // 副本的时长弄没了。
    endAt: t.endAt ?? null,
    // 提醒的章（`firedAt`）清掉，不然副本上那条提醒永远不会响。
    reminders: asArray<Reminder>(t.reminders).map((r) => ({ at: r.at, firedAt: null })),
    // 提醒都带过去了，只漏「要不要一直响」说不通——那是同一件事的一半。
    persistentReminder: t.persistentReminder ?? false,
    // 勾选状态清掉：抄一份「已经做完三步」的副本没有意义，跟 `nextInstance`
    // 生成下一次重复实例时的处理一致。
    subtasks: asArray<Task['subtasks'][number]>(t.subtasks).map((x) => ({ ...x, done: false })),
    listId: t.listId,
    section: t.section ?? null,
    tags: [...asArray<string>(t.tags)],
    priority: t.priority,
    repeat: t.repeat,
    waitingFor: t.waitingFor,
    // 情境跟着走：它说的是「这件事得在什么条件下干」，是这件事本身的属性，
    // 不是上一次干它时的经历。拿副本当模板时最该保住的正是这一类。
    context: t.context,
    habit: t.habit,
    // **带走**——理由跟服务端 `nextInstance` 里那条一字不差：那是这件事要花
    // 多久，不是这一次花了多久。`focusSessions`（这一次花了多久）反过来不带。
    estimateMinutes: t.estimateMinutes,
  };
}
