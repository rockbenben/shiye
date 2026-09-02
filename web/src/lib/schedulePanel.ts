import type { Task } from '../types.js';
import type { GroupBy } from './grouping.js';
import { hasTimeBlock, isSettled } from './taskView.js';

/**
 * 「安排任务」——日历右边那一栏（仿滴答清单）。
 *
 * 帮助文档原话：「把安排任务栏打开，你可以在这里查看到**所有无日期的任务**，
 * 快来给它们安排一个合适的时间吧」「拖拽到日历中即可」。
 *
 * 它补的是日历这个视图上一个一直存在的空缺：**日历只画得出有日期的任务**，
 * 而「哪些还没排」恰恰是打开日历最常想问的另一半。在这之前那一堆只能去
 * 「全部」里翻，翻到了也没法就地排——得打开它、找到截止时间那个框、挑一个
 * 日期，而那个日期你刚刚就在日历上看着空格子想好了。
 */

/** 分组轴：清单 / 标签 / 优先级，跟滴答那一栏顶上那三个页签一字不差。 */
export const SCHEDULE_AXES = ['list', 'tag', 'priority'] as const;
export type ScheduleAxis = (typeof SCHEDULE_AXES)[number];

/** 页签上的字。**从 `GroupBy` 的那份里挑，不另写一份**——`grouping.ts` 的
 *  `GROUP_LABEL` 写的是「按清单/按标签/按优先级」，那是下拉框里的说法；
 *  页签上只用得着名词本身。 */
export const SCHEDULE_AXIS_LABEL: Record<ScheduleAxis, string> = {
  list: '清单', tag: '标签', priority: '优先级',
};

/** 这几个轴恰好是 `GroupBy` 的子集，直接喂给 `regroupSections` 复用整套
 *  分桶逻辑（桶的 key/标题/「没有清单」「没有标签」那两个兜底组）。
 *  写成一个函数而不是靠 TypeScript 的结构兼容自动通过——将来 `ScheduleAxis`
 *  要是加了一档 `GroupBy` 里没有的，这里会当场编译不过。 */
export const axisToGroupBy = (a: ScheduleAxis): GroupBy => a;

/**
 * 「无日期」的判据。
 *
 * **日期读不出来的也算没有**：`due` 被手改成「下周三」时，日历不画它、
 * 「今天」不收它、排序把它沉底——功能上它就是没有日期。这跟
 * `smartFilter.ts` 里 `noDue` 那一档是同一条判据、同一段理由，两处必须一致，
 * 不然「智能清单里筛出来的没日期的」和「安排任务栏里列出来的」会是两批。
 */
export const hasNoDue = (t: Task): boolean => !t.due || Number.isNaN(Date.parse(t.due));

/**
 * 安排任务栏该列哪些任务：**没有日期、而且还没了结**。
 *
 * 排除 `isSettled`（已完成/搁置/已放弃）：这一栏问的是「还有什么没排上
 * 日程」，做完的和明确搁置的都不是。搁置尤其要排掉——「搁置」的字面意思就是
 * 「现在不打算安排它」，把它列在一个催人安排的栏里是跟用户刚做的决定对着干。
 *
 * 子任务照收：一条挂在父任务下面的子任务同样可以有自己的截止时间（数据模型
 * 上它就是一条普通任务），没排的话它也该出现在这儿。
 *
 * **有时间段的也排掉**（`hasTimeBlock`），哪怕它没有 `due`。「只有开始/结束时刻、
 * 没有截止日期」是这个应用明确支持的状态（`ics.ts` 顶上说它「在这个应用自己的
 * 日历上画得好好的」），而 `calendarAnchor` 对这种任务按**起点**落格——也就是说
 * 它**已经排在日历上了**。
 *
 * 少了这一条，同一屏会给出两个互相矛盾的答案：左边日历把它画在 9 月 5 日，右边
 * 「安排任务」栏又把它列成「还没排」。而且把它从栏里拖到某一格**看起来毫无反应**
 * ——`onScheduleTo` 只写 `due`，锚点仍然是 `startAt`，事件一动不动，只是这条任务
 * 悄悄多了一个他没要过的截止日期，然后从栏里消失了。
 */
export const unscheduled = (tasks: Task[]): Task[] =>
  tasks.filter((t) => hasNoDue(t) && !hasTimeBlock(t) && !isSettled(t));

/**
 * 一次拖拽事件里的指针坐标。
 *
 * **触摸事件上没有 `clientX`**——它在 `changedTouches[0]` 上。不管这一层的话，
 * 手指从日历上把一条任务拖到这一栏，`clientX` 是 `undefined`，跟矩形比大小
 * 全是 `false`，于是「什么都没发生」：不是报错，是**静默失效**，最难查的那种。
 */
export function pointerXY(ev: MouseEvent | TouchEvent): { x: number; y: number } {
  const t = 'changedTouches' in ev ? ev.changedTouches[0] : null;
  if (t) return { x: t.clientX, y: t.clientY };
  const m = ev as MouseEvent;
  return { x: m.clientX, y: m.clientY };
}

/** 这个点在不在这个元素上（边界算在里面）。元素不存在时一律算不在——
 *  「安排任务」栏收起来的时候，往那个方向拖不该有任何效果。 */
export function insideEl(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
