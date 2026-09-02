import { describe, it, expect } from 'vitest';
import {
  applyMove, bubbleOverdue, countByStatus, countStale, filterTasks, formatWhen, groupBySource, isInTodayView, moveTo,
  isOverdue, isReminderOverdue, isStatus, overdueLabel, sortByUrgency, sortTodayOrder, isSettled, normalizeTaskArrays, STATUSES, STATUS_LABEL, STATUS_FILTERS, STATUS_FILTER_LABEL, displayReminderAt, waitingQuietLabel, parkedQuietLabel, notStarted, isTaskOverdue } from './taskView.js';
import type { InboxItem, Task, Status } from '../types.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

// 「今天」成员资格要测日历日边界（今天 23:59 vs 明天 00:01），不能用固定的
// UTC 'Z' 时间戳——那样测试结果会跟着跑测试的机器时区飘。这里改用不带时区
// 的本地 Date 构造，NOW 和 due/提醒时间都走同一套本地语义，边界断言在
// 任何时区跑都一样。
const LOCAL_NOW = new Date(2026, 7, 10, 12, 0, 0);
const localIso = (y: number, m: number, d: number, h = 0, mi = 0): string => new Date(y, m - 1, d, h, mi).toISOString();
// 一条任务可以有任意多条提醒（界面上也编辑得了），但这一族判据看的是**最早
// 那一条**——见 taskView.ts 里 firstReminderAt 上面那段：进不进「今天」、算不算
// 过期，问的是「最早什么时候要我动」。所以这里造一条就够。
const remindsAt = (iso: string) => [{ at: iso, firedAt: null }];

let n = 0;
const task = (p: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `任务${n}`, notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

let m = 0;
const inboxItem = (p: Partial<InboxItem> = {}): InboxItem => ({
  id: `i${++m}`, text: `笔记${m}`, createdAt: '2026-08-01T00:00:00.000Z',
  processed: true, taskIds: [], ...p,
});

describe('isOverdue', () => {
  it('截止时间过了且没做完就算过期', () => {
    expect(isOverdue(task({ due: '2026-08-09T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('做完了就不算过期 —— 已完成那一列不该满屏飘红', () => {
    expect(isOverdue(task({ due: '2026-08-09T00:00:00.000Z', status: 'done' }), NOW)).toBe(false);
  });

  it('没设截止时间的不算过期', () => {
    expect(isOverdue(task(), NOW)).toBe(false);
  });

  it('截止时间还没到不算', () => {
    expect(isOverdue(task({ due: '2026-08-11T00:00:00.000Z' }), NOW)).toBe(false);
  });

  it('搁置了就不算过期——搁置是「暂时不想看见它」，红标和置顶正好是让它更显眼', () => {
    expect(isOverdue(task({ due: '2026-08-09T00:00:00.000Z', status: 'later' }), NOW)).toBe(false);
  });
});

describe('sortByUrgency', () => {
  it('过期的排最前面 —— 一堆卡片里，要紧的那张不能沉在底下', () => {
    const fresh = task({ title: '不急', due: '2026-12-01T00:00:00.000Z' });
    const late = task({ title: '早该做了', due: '2026-08-01T00:00:00.000Z' });
    expect(sortByUrgency([fresh, late], NOW).map((t) => t.title)).toEqual(['早该做了', '不急']);
  });

  it('都过期时按截止时间升序 —— 一堆红卡里，拖得最久的那张要在最上面', () => {
    const yesterday = task({ title: '昨天该做', due: '2026-08-09T00:00:00.000Z' });
    const lastWeek = task({ title: '上周就该做', due: '2026-08-03T00:00:00.000Z' });
    expect(sortByUrgency([yesterday, lastWeek], NOW).map((t) => t.title)).toEqual(['上周就该做', '昨天该做']);
  });

  it('同为未过期时按截止时间升序，没截止时间的排最后', () => {
    const none = task({ title: '没期限' });
    const later = task({ title: '月底', due: '2026-08-31T00:00:00.000Z' });
    const soon = task({ title: '明天', due: '2026-08-11T00:00:00.000Z' });
    expect(sortByUrgency([none, later, soon], NOW).map((t) => t.title)).toEqual(['明天', '月底', '没期限']);
  });
});

describe('groupBySource', () => {
  it('任务归到它来源的那条收件箱记录下面', () => {
    const note = inboxItem({ id: 'i1', text: '给 035 加导出 CSV', taskIds: ['t1'] });
    const t1 = task({ id: 't1', title: '加导出按钮' });
    expect(groupBySource([t1], [note])).toEqual([{ source: note, tasks: [t1] }]);
  });

  it('一条记录拆出的多个任务按 taskIds 数组本身的顺序，不重新排序', () => {
    const note = inboxItem({ id: 'i1', taskIds: ['t2', 't1'] });
    const t1 = task({ id: 't1', title: '第一步' });
    const t2 = task({ id: 't2', title: '第二步' });
    // 传入顺序是 [t1, t2]，但 taskIds 里写的是 [t2, t1] —— 分组要跟 taskIds 走。
    expect(groupBySource([t1, t2], [note])[0].tasks.map((t) => t.title)).toEqual(['第二步', '第一步']);
  });

  it('组按来源记录写下的时间升序排列', () => {
    const early = inboxItem({ id: 'i1', createdAt: '2026-08-01T09:00:00.000Z', taskIds: ['t1'] });
    const late = inboxItem({ id: 'i2', createdAt: '2026-08-01T10:00:00.000Z', taskIds: ['t2'] });
    const t1 = task({ id: 't1' });
    const t2 = task({ id: 't2' });
    // 故意传入 [late, early] 的顺序，分组结果要按 createdAt 排，不是按传入顺序。
    expect(groupBySource([t1, t2], [late, early]).map((g) => g.source?.id)).toEqual(['i1', 'i2']);
  });

  it('手工建的任务（source 从没进过任何 taskIds）落进最后一组，source 是 null', () => {
    const note = inboxItem({ id: 'i1', taskIds: ['t1'] });
    const t1 = task({ id: 't1' });
    const handmade = task({ id: 't2', title: '手工记的', source: 'user' });
    const groups = groupBySource([t1, handmade], [note]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({ source: null, tasks: [handmade] });
  });

  it('来源记录被删掉的任务同样落进最后一组 —— 不需要额外记录它曾经属于哪条', () => {
    const orphan = task({ id: 't1', title: '来源被删了', source: 'ai' });
    // 没有任何 inbox 记录的 taskIds 提到 t1。
    const groups = groupBySource([orphan], [inboxItem({ id: 'i1', taskIds: ['other-task'] })]);
    expect(groups).toEqual([{ source: null, tasks: [orphan] }]);
  });

  it('taskIds 缺失时兜底成空数组，不炸', () => {
    const bad = { ...inboxItem({ id: 'i1' }), taskIds: undefined } as unknown as InboxItem;
    expect(() => groupBySource([task()], [bad])).not.toThrow();
  });

  it('taskIds 类型不对（手改文件写成了字符串而不是数组）不炸，当空数组处理', () => {
    // data/inbox.json 是手改的：一个漏写方括号的 taskIds 会变成裸字符串，
    // 字符串没有 .map，直接崩会把整页带崩，见 App.tsx 的 asArray 同一条教训。
    const bad = { ...inboxItem({ id: 'i1' }), taskIds: 't_abc' } as unknown as InboxItem;
    const t = task({ id: 't_abc' });
    expect(() => groupBySource([t], [bad])).not.toThrow();
    // 坏掉的 taskIds 当空数组处理：这条任务找不到来源，落进「单独记的」，
    // 不会因为字符串巧合跟自己的 id 撞了就被误配对。
    expect(groupBySource([t], [bad])).toEqual([{ source: null, tasks: [t] }]);
  });

  it('没有任务时结果是空数组', () => {
    expect(groupBySource([], [inboxItem()])).toEqual([]);
  });

  it('同一个任务 id 被两条 inbox 记录的 taskIds 都提到，只在先写下的那条下面出现一次', () => {
    const t1 = task({ id: 'dup', title: '共享 id' });
    const early = inboxItem({ id: 'i1', createdAt: '2026-08-01T09:00:00.000Z', taskIds: ['dup'] });
    const late = inboxItem({ id: 'i2', createdAt: '2026-08-01T10:00:00.000Z', taskIds: ['dup'] });
    const groups = groupBySource([t1], [late, early]);
    const rendered = groups.flatMap((g) => g.tasks);
    expect(rendered).toHaveLength(1);
    expect(groups.find((g) => g.source?.id === 'i1')?.tasks).toEqual([t1]);
    expect(groups.find((g) => g.source?.id === 'i2')).toBeUndefined();
  });

  it('两个不同的任务碰巧共享同一个 id，其中一个被 inbox 引用，另一个不能从看板上消失', () => {
    const dup1 = task({ id: 'dup', title: '第一条' });
    const dup2 = task({ id: 'dup', title: '第二条' });
    const note = inboxItem({ id: 'i1', taskIds: ['dup'] });
    const groups = groupBySource([dup1, dup2], [note]);
    const rendered = groups.flatMap((g) => g.tasks);
    // 两条都得在板上——按 id 记「用过没」会把另一条也误伤成用过，
    // 明明还在文件里却哪个分组都进不去，这才是比「重复出现」更糟的那种消失。
    expect(rendered).toHaveLength(2);
    expect(rendered.map((t) => t.title).sort()).toEqual(['第一条', '第二条']);
  });

  it('inbox 记录缺 createdAt 时不炸、且沉到最后，不搅乱其余记录按时间的排序', () => {
    // Date.parse(undefined) 是 NaN，NaN 参与比较恒为「相等」——不guard的话，
    // 这条坏记录夹在中间时，跟它比较的那几对全部「相等」，排序结果不再是
    // 单纯按 createdAt 升序，是比较器实现细节说了算。跟 byWhen() 同一条教训。
    const bad = { ...inboxItem({ id: 'i-bad', taskIds: ['t-bad'] }), createdAt: undefined } as unknown as InboxItem;
    const early = inboxItem({ id: 'i-early', createdAt: '2026-08-01T09:00:00.000Z', taskIds: ['t-early'] });
    const late = inboxItem({ id: 'i-late', createdAt: '2026-08-01T10:00:00.000Z', taskIds: ['t-late'] });
    const tasks = [task({ id: 't-bad' }), task({ id: 't-early' }), task({ id: 't-late' })];
    expect(() => groupBySource(tasks, [late, bad, early])).not.toThrow();
    const order = groupBySource(tasks, [late, bad, early]).map((g) => g.source?.id);
    expect(order).toEqual(['i-early', 'i-late', 'i-bad']);
  });
});

describe('bubbleOverdue', () => {
  it('过期的排最前面，其余任务保持原有的相对顺序（不像 sortByUrgency 那样按截止时间重排）', () => {
    // 同源组要保留 AI 拆解出的步骤顺序——只有「过期」这一件事值得打破它，
    // 没过期的几条谁先谁后依然照抄 taskIds 数组本身的顺序。
    const step1 = task({ title: '第一步', due: '2026-08-31T00:00:00.000Z' });
    const step2 = task({ title: '第二步（过期）', due: '2026-08-01T00:00:00.000Z' });
    const step3 = task({ title: '第三步', due: '2026-08-15T00:00:00.000Z' });
    const result = bubbleOverdue([step1, step2, step3], NOW).map((t) => t.title);
    expect(result).toEqual(['第二步（过期）', '第一步', '第三步']);
  });

  it('都不过期时原样返回，不按截止时间重排', () => {
    const b = task({ title: 'B', due: '2026-08-20T00:00:00.000Z' });
    const a = task({ title: 'A', due: '2026-08-15T00:00:00.000Z' });
    expect(bubbleOverdue([b, a], NOW).map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('过期但被搁置的不置顶——搁置的卡不该是组里最显眼的那张', () => {
    const step1 = task({ title: '第一步', due: '2026-08-31T00:00:00.000Z' });
    const shelved = task({ title: '搁置了（过期）', due: '2026-08-01T00:00:00.000Z', status: 'later' });
    expect(bubbleOverdue([step1, shelved], NOW).map((t) => t.title)).toEqual(['第一步', '搁置了（过期）']);
  });

  it('多条都过期时，过期的几条之间仍按截止时间升序', () => {
    const yesterday = task({ title: '昨天该做', due: '2026-08-09T00:00:00.000Z' });
    const lastWeek = task({ title: '上周就该做', due: '2026-08-03T00:00:00.000Z' });
    const notYet = task({ title: '还没到', due: '2026-08-20T00:00:00.000Z' });
    expect(bubbleOverdue([yesterday, notYet, lastWeek], NOW).map((t) => t.title)).toEqual(['上周就该做', '昨天该做', '还没到']);
  });
});

describe('filterTasks', () => {
  it("'all' 不筛，原样返回", () => {
    const tasks = [task({ status: 'todo' }), task({ status: 'done' })];
    expect(filterTasks(tasks, 'all')).toEqual(tasks);
  });

  it('按状态筛，未知 status 按 todo 处理', () => {
    const todo = task({ title: '待办的', status: 'todo' });
    const odd = task({ title: '状态坏了', status: 'pending' as Task['status'] });
    const done = task({ title: '做完的', status: 'done' });
    expect(filterTasks([todo, odd, done], 'todo').map((t) => t.title)).toEqual(['待办的', '状态坏了']);
    expect(filterTasks([todo, odd, done], 'done').map((t) => t.title)).toEqual(['做完的']);
  });
});

describe('countByStatus', () => {
  it('数出六个筛选按钮各自的计数，未知 status 并入 todo', () => {
    const tasks = [
      task({ status: 'todo' }),
      task({ status: 'doing' }),
      task({ status: 'done' }),
      task({ status: 'later' }),
      task({ status: 'abandoned' }),
      task({ status: 'pending' as Task['status'] }),
    ];
    expect(countByStatus(tasks)).toEqual({ all: 6, todo: 2, doing: 1, done: 1, later: 1, abandoned: 1 });
  });

  it('空数组全是 0', () => {
    expect(countByStatus([])).toEqual({ all: 0, todo: 0, doing: 0, done: 0, later: 0, abandoned: 0 });
  });
});

describe('isInTodayView：「今天」的成员资格', () => {
  it('过期未完成的算——不看提醒时间/due 是不是今天', () => {
    const t = task({ due: '2026-08-09T00:00:00.000Z' });
    expect(isInTodayView(t, NOW)).toBe(true);
  });

  it('提醒时间落在今天算，due 落在今天也算', () => {
    expect(isInTodayView(task({ reminders: remindsAt(localIso(2026, 8, 10, 9, 0)) }), LOCAL_NOW)).toBe(true);
    expect(isInTodayView(task({ due: localIso(2026, 8, 10, 18, 0) }), LOCAL_NOW)).toBe(true);
  });

  it('边界：due 在今天 23:59 算今天，due 在明天 00:01 不算', () => {
    const lateToday = task({ due: localIso(2026, 8, 10, 23, 59) });
    const earlyTomorrow = task({ due: localIso(2026, 8, 11, 0, 1) });
    expect(isInTodayView(lateToday, LOCAL_NOW)).toBe(true);
    expect(isInTodayView(earlyTomorrow, LOCAL_NOW)).toBe(false);
  });

  it('边界：提醒时间在今天 00:00 算今天（今天要提醒那条分支）；昨天 23:59 现在也算，但走的是 isReminderOverdue（提醒已经在更早一天触发过）——不再是「不算」，见同一个 describe 块下面 isReminderOverdue 的说明', () => {
    const earlyToday = task({ reminders: remindsAt(localIso(2026, 8, 10, 0, 0)) });
    const lateYesterday = task({ reminders: remindsAt(localIso(2026, 8, 9, 23, 59)) });
    expect(isInTodayView(earlyToday, LOCAL_NOW)).toBe(true);
    expect(isInTodayView(lateYesterday, LOCAL_NOW)).toBe(true);
  });

  /**
   * **`startAt` 落在今天也算。** 这一支补的是「到那天再提醒我」那半句——
   * 在它之前，开始时间只负责在那之前把任务藏起来，到期那一刻什么都不发生。
   * 出处和完整理由在 `taskView.ts` 的 `isInTodayView` 上面。
   */
  it('今天开始的算——哪怕没有 due、也没有提醒', () => {
    expect(isInTodayView(task({ due: null, startAt: localIso(2026, 8, 10, 9, 0) }), LOCAL_NOW)).toBe(true);
  });

  it('今天开始但还没到点的也算——「哪天开始做」在人心里是一天，不是一个时刻', () => {
    // LOCAL_NOW 是 12:00，这条 18:00 才开始，`notStarted` 还是 true。
    // 两个记号都对：卡片上那个「18:00 开始」负责说后半句。
    expect(isInTodayView(task({ due: null, startAt: localIso(2026, 8, 10, 18, 0) }), LOCAL_NOW)).toBe(true);
  });

  it('明天开始的不算——那正是这个字段要挡掉的噪声', () => {
    expect(isInTodayView(task({ due: null, startAt: localIso(2026, 8, 11, 9, 0) }), LOCAL_NOW)).toBe(false);
  });

  /**
   * **上限方向，这一条比上面那几条重要**：判据是「就今天这一天」，不是
   * 「已经开始了的都算」。写成后者的话，「今天」会变成只进不出的池子——
   * 三个月前设了开始时间、没有截止日期又没做完的任务永远赖在里面。
   */
  it('昨天开始、没有 due 的不算——不能让「今天」变成只进不出的池子', () => {
    expect(isInTodayView(task({ due: null, startAt: localIso(2026, 8, 9, 9, 0) }), LOCAL_NOW)).toBe(false);
  });

  it('今天开始、下周才截止的算——进来的理由是开始时间，不是 due', () => {
    const t = task({ due: localIso(2026, 8, 20, 9, 0), startAt: localIso(2026, 8, 10, 9, 0) });
    expect(isInTodayView(t, LOCAL_NOW)).toBe(true);
    // 对照：把开始时间摘掉，同一条就该落在「今天」之外——证明上面那条不是
    // 靠 due 混进来的。
    expect(isInTodayView(task({ due: localIso(2026, 8, 20, 9, 0), startAt: null }), LOCAL_NOW)).toBe(false);
  });

  it('done 不算，哪怕过期或者今天截止', () => {
    expect(isInTodayView(task({ status: 'done', due: '2026-08-01T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isInTodayView(task({ status: 'done', due: localIso(2026, 8, 10, 18, 0) }), LOCAL_NOW)).toBe(false);
  });

  it('今天开始但已完成/已搁置的不算——第一行那道 isSettled 对新这一支同样生效', () => {
    const st = localIso(2026, 8, 10, 9, 0);
    expect(isInTodayView(task({ status: 'done', due: null, startAt: st }), LOCAL_NOW)).toBe(false);
    expect(isInTodayView(task({ status: 'later', due: null, startAt: st }), LOCAL_NOW)).toBe(false);
  });

  it("later（搁置）不算，哪怕过期或者今天截止——搁置就是要从「今天」挪走", () => {
    expect(isInTodayView(task({ status: 'later', due: '2026-08-01T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isInTodayView(task({ status: 'later', reminders: remindsAt(localIso(2026, 8, 10, 9, 0)) }), LOCAL_NOW)).toBe(false);
  });

  it('没有 due/提醒时间、没过期的不算——跟今天没关系', () => {
    expect(isInTodayView(task(), NOW)).toBe(false);
  });

  it('due/提醒时间是明天以后的不算', () => {
    expect(isInTodayView(task({ due: localIso(2026, 8, 12, 9, 0) }), LOCAL_NOW)).toBe(false);
    expect(isInTodayView(task({ reminders: remindsAt(localIso(2026, 8, 15, 9, 0)) }), LOCAL_NOW)).toBe(false);
  });

  it("提醒时间在更早的一天就已经到了、没设 due——算，不能从「今天」默默消失：卡片编辑器能清空 due 只留提醒时间，第二天 isOverdue（只看 due）也不会亮，不补这条会两头都不提", () => {
    const t = task({ reminders: remindsAt(localIso(2026, 8, 9, 9, 0)), due: null });
    expect(isInTodayView(t, LOCAL_NOW)).toBe(true);
  });

  it('提醒时间是今天更早的时间（还是今天）——走原来那条「今天要提醒」分支，不重复算', () => {
    const t = task({ reminders: remindsAt(localIso(2026, 8, 10, 6, 0)), due: null });
    expect(isInTodayView(t, LOCAL_NOW)).toBe(true);
  });
});

describe('isReminderOverdue：提醒在更早的一天已经触发过、任务还没做完', () => {
  it('提醒时间是昨天的算', () => {
    expect(isReminderOverdue(task({ reminders: remindsAt(localIso(2026, 8, 9, 9, 0)) }), LOCAL_NOW)).toBe(true);
  });

  it('提醒时间是今天的不算——那是「今天要提醒」，不是「更早就该提醒」', () => {
    expect(isReminderOverdue(task({ reminders: remindsAt(localIso(2026, 8, 10, 6, 0)) }), LOCAL_NOW)).toBe(false);
  });

  it('没设提醒的不算', () => {
    expect(isReminderOverdue(task(), LOCAL_NOW)).toBe(false);
  });

  it('done/later 不算——已经处理过或者已经主动搁置的，不用继续标', () => {
    expect(isReminderOverdue(task({ reminders: remindsAt(localIso(2026, 8, 9, 9, 0)), status: 'done' }), LOCAL_NOW)).toBe(false);
    expect(isReminderOverdue(task({ reminders: remindsAt(localIso(2026, 8, 9, 9, 0)), status: 'later' }), LOCAL_NOW)).toBe(false);
  });
});

describe('sortTodayOrder：按 order 升序，null 排最后', () => {
  it('有 order 的按数字升序排在前面', () => {
    const a = task({ title: 'A', order: 2 });
    const b = task({ title: 'B', order: 0 });
    const c = task({ title: 'C', order: 1 });
    expect(sortTodayOrder([a, b, c], NOW).map((t) => t.title)).toEqual(['B', 'C', 'A']);
  });

  it('没排过序（order: null）的沉到 order 有值的那些后面', () => {
    const ordered = task({ title: '排过的', order: 0 });
    const unordered = task({ title: '没排过的', order: null });
    expect(sortTodayOrder([unordered, ordered], NOW).map((t) => t.title)).toEqual(['排过的', '没排过的']);
  });

  it('null 这一段内部仍按紧急度排（过期优先、再按截止时间）——退回原来的排法，不是随便摆', () => {
    const fresh = task({ title: '不急', due: '2026-12-01T00:00:00.000Z', order: null });
    const late = task({ title: '过期的', due: '2026-08-01T00:00:00.000Z', order: null });
    expect(sortTodayOrder([fresh, late], NOW).map((t) => t.title)).toEqual(['过期的', '不急']);
  });

  it('order 相同的两条（不同路径写入撞了）排序仍是确定的，不看数组原来的先后', () => {
    const a = task({ id: 'z', title: 'A', order: 0, createdAt: '2026-08-01T00:00:00.000Z' });
    const b = task({ id: 'a', title: 'B', order: 0, createdAt: '2026-08-01T00:00:00.000Z' });
    // 两条 order、createdAt 都相同，最终按 id 兜底——不管传入顺序是 [a,b] 还是 [b,a]，
    // 结果都一样（id 'a' < 'z'）。
    expect(sortTodayOrder([a, b], NOW).map((t) => t.id)).toEqual(['a', 'z']);
    expect(sortTodayOrder([b, a], NOW).map((t) => t.id)).toEqual(['a', 'z']);
  });

  it('order 相同但 createdAt 不同——更早创建的排前面', () => {
    const older = task({ title: '更早', order: 5, createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = task({ title: '更晚', order: 5, createdAt: '2026-08-05T00:00:00.000Z' });
    expect(sortTodayOrder([newer, older], NOW).map((t) => t.title)).toEqual(['更早', '更晚']);
  });
});

describe('applyMove：上/下移一格，整份可见列表重新落定', () => {
  it('把中间一条上移，跟前一条互换，返回整份列表的新 order（0..n-1）', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const result = applyMove([a, b, c], 'b', 'up');
    expect(result).toEqual([{ id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 }]);
  });

  it('下移同理', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const result = applyMove([a, b, c], 'b', 'down');
    expect(result).toEqual([{ id: 'a', order: 0 }, { id: 'c', order: 1 }, { id: 'b', order: 2 }]);
  });

  it('已经排过序的列表再移动一次，之前的 order 值不影响结果——整份重新编号', () => {
    const a = task({ id: 'a', order: 99 });
    const b = task({ id: 'b', order: 1 });
    const result = applyMove([a, b], 'b', 'up');
    expect(result).toEqual([{ id: 'b', order: 0 }, { id: 'a', order: 1 }]);
  });

  it('已经在最前面的再上移——越界，返回 null，调用方不该发起任何写', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    expect(applyMove([a, b], 'a', 'up')).toBeNull();
  });

  it('已经在最后面的再下移——同样越界返回 null', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    expect(applyMove([a, b], 'b', 'down')).toBeNull();
  });

  it('传一个不在列表里的 id——返回 null，不炸', () => {
    const a = task({ id: 'a' });
    expect(applyMove([a], '不存在', 'up')).toBeNull();
  });
});

describe('formatWhen：YYYY-MM-DD HH:mm，不是 toLocaleString 那套 2026/8/16 18:00:00', () => {
  it('补零、用短横线、不带秒', () => {
    // 用本地 Date 构造再取本地 getter 拼期望值，跟实现同一套时区语义，
    // 断言不会跟着跑测试的机器时区飘——同一条教训见文件顶部 LOCAL_NOW 的注释。
    const d = new Date(2026, 7, 6, 9, 5, 30);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const expected = `2026-08-06 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    expect(formatWhen(d.toISOString())).toBe(expected);
  });

  it('null 返回空字符串', () => {
    expect(formatWhen(null)).toBe('');
  });

  it('解析不出来的字符串原样返回，不是空字符串或 NaN', () => {
    expect(formatWhen('不是日期')).toBe('不是日期');
  });
});

describe('isStatus', () => {
  it('只认 todo/doing/done/later 四个值', () => {
    expect(isStatus('todo')).toBe(true);
    expect(isStatus('doing')).toBe(true);
    expect(isStatus('done')).toBe(true);
    expect(isStatus('later')).toBe(true);
    expect(isStatus('pending')).toBe(false);
    expect(isStatus('toString')).toBe(false);
    expect(isStatus(undefined)).toBe(false);
  });
});

describe('overdueLabel：过期了多久', () => {
  // 本地墙钟，跟这个文件里「今天」那族测试同一条：固定的 'Z' 时间戳会让
  // 「差几小时」的断言跟着跑测试的机器时区飘。
  const NOW_L = new Date(2026, 7, 10, 12, 0, 0);
  const ago = (ms: number) => new Date(NOW_L.getTime() - ms).toISOString();
  const H = 60 * 60 * 1000;

  it('没过期返回 null', () => {
    expect(overdueLabel(task({ due: new Date(NOW_L.getTime() + H).toISOString() }), NOW_L)).toBeNull();
    expect(overdueLabel(task(), NOW_L)).toBeNull();
  });

  it('一小时内是「刚过期」——「过期 0 小时」是句废话', () => {
    expect(overdueLabel(task({ due: ago(59 * 60 * 1000) }), NOW_L)).toBe('刚过期');
  });

  it('一天内报小时', () => {
    expect(overdueLabel(task({ due: ago(3 * H) }), NOW_L)).toBe('过期 3 小时');
    expect(overdueLabel(task({ due: ago(23 * H) }), NOW_L)).toBe('过期 23 小时');
  });

  it('再往上报天，整除不进位——差 47 小时是 1 天不是 2 天', () => {
    expect(overdueLabel(task({ due: ago(24 * H) }), NOW_L)).toBe('过期 1 天');
    expect(overdueLabel(task({ due: ago(47 * H) }), NOW_L)).toBe('过期 1 天');
    expect(overdueLabel(task({ due: ago(21 * 24 * H) }), NOW_L)).toBe('过期 21 天');
  });

  it('做完/搁置的不算过期——跟 isTaskOverdue 同一条口径，不另写一份', () => {
    for (const status of ['done', 'later', 'abandoned'] as const) {
      expect(overdueLabel(task({ due: ago(3 * H), status }), NOW_L)).toBeNull();
    }
  });

  it('只设了提醒、没设 due 的那一支：参照的是那条更早响过的提醒', () => {
    const t = task({ due: null, startAt: null, endAt: null, reminders: [{ at: ago(3 * 24 * H), firedAt: null }] });
    expect(overdueLabel(t, NOW_L)).toBe('过期 3 天');
  });

  it('时间解析不出来（手改 JSON 写了「下周三」）的那条根本判不出过期，不会硬造一个数字出来', () => {
    expect(overdueLabel(task({ due: '下周三' }), NOW_L)).toBeNull();
    expect(overdueLabel(task({ due: null, startAt: null, endAt: null, reminders: [{ at: '下周三', firedAt: null }] }), NOW_L)).toBeNull();
  });
});

describe('countStale：「可以让 AI 回顾一遍」那句提示的触发条件', () => {
  it('数的就是卡片上挂「已过期」标签的那些', () => {
    const list = [
      task({ due: localIso(2026, 8, 1) }),                     // 过期
      task({ reminders: remindsAt(localIso(2026, 8, 1, 9, 0)) }),   // 提醒早过了
      task({ due: localIso(2026, 12, 1) }),                    // 还早
      task(),                                                   // 没设时间
    ];
    expect(countStale(list, LOCAL_NOW)).toBe(2);
  });

  it('完成的和搁置的不算——那两个都是人已经做过判断的，回顾不该翻出来', () => {
    const list = [
      task({ due: localIso(2026, 8, 1), status: 'done' }),
      task({ due: localIso(2026, 8, 1), status: 'later' }),
    ];
    expect(countStale(list, LOCAL_NOW)).toBe(0);
  });

  it('看板空的时候是 0——那种情况提「让 AI 回顾一遍」是废话，回顾什么呢', () => {
    expect(countStale([], LOCAL_NOW)).toBe(0);
  });
});

describe('moveTo：拖放用的任意位置移动', () => {
  const list = () => [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }), task({ id: 'd' })];

  it('往下拖：中间的挪到末尾，其余依次前移', () => {
    expect(moveTo(list(), 'b', 3)).toEqual([
      { id: 'a', order: 0 }, { id: 'c', order: 1 }, { id: 'd', order: 2 }, { id: 'b', order: 3 },
    ]);
  });

  it('往上拖：末尾的挪到最前', () => {
    expect(moveTo(list(), 'd', 0)).toEqual([
      { id: 'd', order: 0 }, { id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 },
    ]);
  });

  it('落点超出范围就夹回来——拖到列表外的空白处是常见操作，不该静默失败', () => {
    expect(moveTo(list(), 'a', 99)?.at(-1)).toEqual({ id: 'a', order: 3 });
    expect(moveTo(list(), 'd', -5)?.[0]).toEqual({ id: 'd', order: 0 });
  });

  it('原地不动返回 null——调用方不该为此发起一次写', () => {
    expect(moveTo(list(), 'b', 1)).toBeNull();
  });

  it('id 不在列表里返回 null', () => {
    expect(moveTo(list(), '不存在', 0)).toBeNull();
  });

  it('跟 applyMove 对同一格移动的结果一致——键盘和鼠标不能有两套语义', () => {
    expect(moveTo(list(), 'b', 2)).toEqual(applyMove(list(), 'b', 'down'));
    expect(moveTo(list(), 'c', 1)).toEqual(applyMove(list(), 'c', 'up'));
  });
});

/**
 * 置顶（仿滴答清单）。**所有排序的第一个比较键**——判据提成了 `byPinned`，
 * 三个排序器都 `||` 上它，这几条盯的是「每一个都真的用上了」，不是
 * `byPinned` 本身对不对（那是一行减法）。
 */
describe('置顶排最前', () => {
  it('sortByUrgency：置顶压过「已过期」', () => {
    const over = task({ title: '过期的', due: '2000-01-01T00:00:00.000Z' });
    const pin = task({ title: '置顶的', due: null, pinned: true });
    expect(sortByUrgency([over, pin], NOW).map((t) => t.title)).toEqual(['置顶的', '过期的']);
  });

  it('bubbleOverdue（按来源组内）：置顶压过 AI 拆出来的步骤顺序', () => {
    const step1 = task({ title: '第一步' });
    const step2 = task({ title: '第二步', pinned: true });
    expect(bubbleOverdue([step1, step2], NOW).map((t) => t.title)).toEqual(['第二步', '第一步']);
  });

  it('sortTodayOrder：置顶跨过「手动排过序的」那条界线提到最前', () => {
    // 不提的话，一条置顶但没手动排过位置的任务会卡在所有手动排序之后
    const first = task({ title: '手排第一', order: 0 });
    const second = task({ title: '手排第二', order: 1 });
    const pinned = task({ title: '置顶的', order: null, pinned: true });
    expect(sortTodayOrder([first, second, pinned], NOW).map((t) => t.title))
      .toEqual(['置顶的', '手排第一', '手排第二']);
  });

  it('置顶组内部，手动排序照样生效', () => {
    const a = task({ title: 'A', order: 1, pinned: true });
    const b = task({ title: 'B', order: 0, pinned: true });
    expect(sortTodayOrder([a, b], NOW).map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('pinned 缺失（老数据、手改文件）当成没置顶，不炸也不乱序', () => {
    const legacy = { ...task({ title: '老的' }) } as Task;
    delete (legacy as Partial<Task>).pinned;
    const normal = task({ title: '新的' });
    expect(sortByUrgency([legacy, normal], NOW)).toHaveLength(2);
  });
});

/**
 * 「已了结」：做完 / 放弃 / 搁置。这条判据以前在七处各内联写过一遍，加第四种
 * 状态时漏改任何一处都是一个静默的错（一条放弃了的任务照样标红、照样到点响）。
 */
describe('isSettled', () => {
  it.each([
    ['todo', false],
    ['doing', false],
    ['done', true],
    ['later', true],
    ['abandoned', true],
  ] as const)('%s → %s', (status, want) => {
    expect(isSettled(task({ status }))).toBe(want);
  });

  it('放弃的不标红、不进「今天」——跟做完/搁置一视同仁', () => {
    const overdue = { due: '2000-01-01T00:00:00.000Z' };
    expect(isOverdue(task({ ...overdue, status: 'abandoned' }), NOW)).toBe(false);
    expect(isInTodayView(task({ ...overdue, status: 'abandoned' }), NOW)).toBe(false);
  });
});

/**
 * 入口处补齐数组字段。**`GET /api/tasks` 是 `readAll` 的直通车**：JSON.parse
 * 之后直接当 `Task` 交出去，一次校验都没有（`upgradeTask` 只在一次性迁移时
 * 跑过）。手改文件时漏一个 `"tags": []`，类型上它还是 `Task`，运行时
 * `t.tags.length` 当场抛，而这个仓库没有全局错误边界——一条坏数据白掉整页。
 */
describe('normalizeTaskArrays', () => {
  const raw = (over: Record<string, unknown>) => over as unknown as Task;

  it('五个数组字段都补上', () => {
    const t = normalizeTaskArrays(raw({ id: 'a', title: '写周报' }));
    expect(t.reminders).toEqual([]);
    expect(t.subtasks).toEqual([]);
    expect(t.tags).toEqual([]);
    expect(t.attachments).toEqual([]);
    expect(t.focusSessions).toEqual([]);
  });

  it('**不是数组的也当空**——`?? []` 只挡得住 null/undefined，挡不住手滑写成一个裸字符串', () => {
    const t = normalizeTaskArrays(raw({ id: 'a', tags: '紧急', subtasks: 3 }));
    expect(t.tags).toEqual([]);
    expect(t.subtasks).toEqual([]);
  });

  it('本来就有的原样留着，别的字段一个不动', () => {
    const t = normalizeTaskArrays(raw({ id: 'a', title: '写周报', priority: 3, tags: ['紧急'] }));
    expect(t.tags).toEqual(['紧急']);
    expect(t.title).toBe('写周报');
    expect(t.priority).toBe(3);
  });

  it('**只补数组，缺 title 不补**——那是另一类问题，补一个空字符串等于把坏数据伪装成好的', () => {
    expect('title' in normalizeTaskArrays(raw({ id: 'a' }))).toBe(false);
  });

  it('补过之后，那几个原来裸着的消费点都不再崩', () => {
    const t = normalizeTaskArrays(raw({ id: 'a', title: '写周报', notes: '' }));
    // 卡片/行的标签那两行、search 的全文匹配、suggest 的推荐，全都是裸的
    // `t.tags.length` / `...t.tags` / `t.reminders.length`。
    expect(() => t.tags.length + t.reminders.length + t.subtasks.map((s) => s.text).length).not.toThrow();
  });
});

/**
 * **每一处「列出所有状态」的地方都得列全。** 这条守的是一类反复出现的漂移：
 * `abandoned` 是后加的第五个状态，而好几处各自手抄了一份四个的列表没跟上
 * ——筛选栏里选不到已放弃的任务、批量操作条没法把选中的几条标成放弃、
 * `.ics` 把放弃的也导出去、日历上它还占着那一天。前三处已经改成从这里引，
 * 这条测试盯着 `Status` 这个类型本身：以后再加一个状态，`STATUSES` 漏了就红。
 */
describe('STATUSES：五个一个不少', () => {
  it('跟 Status 这个联合类型逐字对上', () => {
    // 写死一份期望值，不是从 STATUSES 自己推——那样等于自己跟自己比，
    // 漏一个照样绿。这一份要跟 types.ts 的 `Status` 手工对齐，而那个类型
    // 有 types.sync.test.ts 盯着不跟服务端分叉。
    const all: Status[] = ['todo', 'doing', 'done', 'later', 'abandoned'];
    expect([...STATUSES].sort()).toEqual([...all].sort());
  });

  it('每一个都有文案——列表里有、界面上却显示成空白，比不列还糟', () => {
    for (const s of STATUSES) expect(STATUS_LABEL[s], s).toBeTruthy();
  });

  /**
   * 筛选条那几档。**这条盯的是「档位齐不齐」**——`TaskBoard` 原来手抄了一份
   * 五档的表，漏了「已放弃」，于是「按来源」里选不到放弃的任务（而
   * `countByStatus` 一直在数它）。这跟筛选栏和批量操作条当初漏掉「已放弃」
   * 是同一个 bug，那两处修的时候没顺手修这一处。
   */
  it('筛选档位 = 「全部」+ 五个状态，一个不少，顺序跟 STATUSES 一致', () => {
    expect(STATUS_FILTERS).toEqual(['all', ...STATUSES]);
  });

  it('每一档都有文案', () => {
    for (const f of STATUS_FILTERS) expect(STATUS_FILTER_LABEL[f], f).toBeTruthy();
  });

  it('`isSettled` 认得出「人已经做过判断」的那三个，另外两个不算', () => {
    const settled = STATUSES.filter((s) => isSettled({ status: s } as Task));
    expect(settled.sort()).toEqual(['abandoned', 'done', 'later']);
  });
});

/**
 * 多个提醒时的「今天」成员资格。**这一条以前只看第一个提醒**——而数组是按
 * 时刻排好序的，第一个就是最早那个，于是「今天要响的那一个」排在后面时
 * 一个字都不算数。
 */
describe('isInTodayView：任意一个提醒是今天就算', () => {
  const NOW = new Date(2026, 7, 25, 12);
  const at = (d: number, h = 9) => new Date(2026, 7, d, h).toISOString();
  const withReminders = (...times: string[]) =>
    task({ id: 'r', due: null, reminders: times.map((a) => ({ at: a, firedAt: null })) });

  it('**早一个 + 今天一个：算今天的**（这条以前是漏的）', () => {
    expect(isInTodayView(withReminders(at(20), at(25)), NOW)).toBe(true);
  });

  it('只有今天那一个，照旧算', () => {
    expect(isInTodayView(withReminders(at(25)), NOW)).toBe(true);
  });

  it('今天一个 + 以后一个，也算', () => {
    expect(isInTodayView(withReminders(at(25), at(30)), NOW)).toBe(true);
  });

  it('全都在以后：不算——那是「接下来」的事', () => {
    expect(isInTodayView(withReminders(at(28), at(30)), NOW)).toBe(false);
  });

  it('全都在过去：照旧靠「提醒过期了」那一支留下来，不是靠这条', () => {
    const t = withReminders(at(20), at(21));
    expect(isInTodayView(t, NOW)).toBe(true);
    expect(isReminderOverdue(t, NOW)).toBe(true);
  });

  it('**今天有一个的时候不该被标成「提醒过期了」**……这条目前还是会标，因为最早那个确实过去了', () => {
    // 钉住现状：`isReminderOverdue` 看的是最早那个（排序后就是最该被追的那个），
    // 「今天还有一个要响」并不能抵消「上一个已经过去了、而且还没做完」。
    // 两句话同时成立，卡片上既进「今天」也挂「已过期」——这是有意的，不是漏判。
    expect(isReminderOverdue(withReminders(at(20), at(25)), NOW)).toBe(true);
  });

  it('坏掉的时刻不算数，也不崩', () => {
    expect(isInTodayView(withReminders('下周三'), NOW)).toBe(false);
  });
});

/**
 * 界面上显示哪一个提醒。卡片和行档原来直接取 `reminders[0]`（最早那个）——
 * 一条任务只有一个提醒时没区别，有好几个时它会一直显示那个早就响过的时刻，
 * 而人想知道的是「下一次什么时候响」。
 */
describe('displayReminderAt', () => {
  const NOW = new Date(2026, 7, 25, 12);
  const at = (d: number, h = 9) => new Date(2026, 7, d, h).toISOString();
  const t = (...times: string[]) => task({ id: 'r', reminders: times.map((a) => ({ at: a, firedAt: null })) });

  it('**显示还没到的里面最早那个**，不是数组里第一个', () => {
    expect(displayReminderAt(t(at(20), at(28)), NOW)).toBe(at(28));
  });

  it('今天晚些时候那个也算「还没到」', () => {
    expect(displayReminderAt(t(at(20), at(25, 18)), NOW)).toBe(at(25, 18));
  });

  it('全都过去了：显示最后那个——最近刚响过的那次，比翻出最早那次有用', () => {
    expect(displayReminderAt(t(at(20), at(21)), NOW)).toBe(at(21));
  });

  it('只有一个时就是它，不管过没过', () => {
    expect(displayReminderAt(t(at(20)), NOW)).toBe(at(20));
    expect(displayReminderAt(t(at(28)), NOW)).toBe(at(28));
  });

  it('一个都没有是 null', () => {
    expect(displayReminderAt(task({ id: 'r' }), NOW)).toBeNull();
  });

  it('坏掉的时刻跳过，不返回一个解析不出来的字符串', () => {
    expect(displayReminderAt(t('下周三', at(28)), NOW)).toBe(at(28));
    expect(displayReminderAt(t('下周三'), NOW)).toBeNull();
  });
});

describe('isOverdue：全天任务按「天」比，不按「时刻」比', () => {
  const t = (due: string | null, over: Partial<Task> = {}): Task => task({ due, ...over });
  const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

  it('**今天的全天任务，当天之内不算过期**——这是量出来才补上的：从「安排任务」栏拖到今天那一格，due 落在今天零点，当天下午那张卡上同时写着「过期 13 小时」和「截止 今天 00:00」', () => {
    const due = local(2026, 8, 25).toISOString();
    expect(isOverdue(t(due), local(2026, 8, 25, 0, 1))).toBe(false);
    expect(isOverdue(t(due), local(2026, 8, 25, 13, 0))).toBe(false);
    expect(isOverdue(t(due), local(2026, 8, 25, 23, 59))).toBe(false);
  });

  it('过完那一天才算过期', () => {
    const due = local(2026, 8, 25).toISOString();
    expect(isOverdue(t(due), local(2026, 8, 26, 0, 0))).toBe(true);
    expect(isOverdue(t(due), local(2026, 8, 26, 9, 0))).toBe(true);
  });

  it('**定了钟点的照旧按时刻比**——「今天 09:00 交表」下午一点就是过期了，那正是那时候该说的话', () => {
    const due = local(2026, 8, 25, 9, 0).toISOString();
    expect(isOverdue(t(due), local(2026, 8, 25, 8, 59))).toBe(false);
    expect(isOverdue(t(due), local(2026, 8, 25, 13, 0))).toBe(true);
  });

  it('月末/年末不靠 +86400000 那种算术——用 Date 自己跨月', () => {
    expect(isOverdue(t(local(2026, 8, 31).toISOString()), local(2026, 9, 1, 0, 30))).toBe(true);
    expect(isOverdue(t(local(2026, 8, 31).toISOString()), local(2026, 8, 31, 23, 0))).toBe(false);
    expect(isOverdue(t(local(2026, 12, 31).toISOString()), local(2027, 1, 1, 0, 30))).toBe(true);
  });

  it('了结的、没日期的一律不算过期——这两条没变', () => {
    expect(isOverdue(t(null), local(2026, 8, 26))).toBe(false);
    expect(isOverdue(t(local(2026, 8, 1).toISOString(), { status: 'done' }), local(2026, 8, 26))).toBe(false);
  });
});

/**
 * 「在等谁」多久没动静了。GTD 的等待清单每周过一遍，问的就是「这条该催了吗」，
 * 而屏幕上只写「在等 张老师」答不了这个问题——等两天和等三个星期长得一样。
 */
describe('waitingQuietLabel', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 24 * 3600 * 1000).toISOString();

  it('没在等谁 → null', () => {
    expect(waitingQuietLabel(task({ waitingFor: null, context: null, updatedAt: at(30) }), NOW)).toBeNull();
  });

  it.each([
    ['刚动过', 0, null],
    ['一天', 1, null],
    ['两天（门槛之下）', 2, null],
    ['三天（门槛）', 3, '3 天没动静'],
    ['十二天', 12, '12 天没动静'],
  ] as const)('%s → %s', (_n, days, want) => {
    expect(waitingQuietLabel(task({ waitingFor: '张老师', updatedAt: at(days) }), NOW)).toBe(want);
  });

  it('**做完/放弃的不说**——那两种已经不存在「该不该催」这个问题', () => {
    for (const status of ['done', 'abandoned'] as const) {
      expect(waitingQuietLabel(task({ waitingFor: '张老师', status, updatedAt: at(30) }), NOW), status).toBeNull();
    }
  });

  it('**搁置的照说**——「搁置 + 在等别人」恰恰是最该知道等了多久的组合：做不了正是因为在等人', () => {
    expect(waitingQuietLabel(task({ waitingFor: '张老师', status: 'later', updatedAt: at(12) }), NOW))
      .toBe('12 天没动静');
  });

  it('updatedAt 解析不了就不说，不抛也不印 NaN', () => {
    expect(waitingQuietLabel(task({ waitingFor: '张老师', updatedAt: '前天' }), NOW)).toBeNull();
  });
});

/**
 * 搁置了很久的（GTD 的「将来也许」）。补的是一个黑洞：搁置的任务不进「今天」
 * 「接下来」「四象限」，也不进推荐面板——只在「全部」和看板那一列里混着，
 * 没有任何地方说过「这条你三个月前搁下的，还要吗」。
 */
describe('parkedQuietLabel', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 24 * 3600 * 1000).toISOString();

  it.each([
    ['刚搁下', 0, null],
    ['29 天（门槛之下）', 29, null],
    ['30 天（门槛）', 30, '搁了 30 天'],
    ['92 天', 92, '搁了 92 天'],
  ] as const)('%s → %s', (_n, days, want) => {
    expect(parkedQuietLabel(task({ status: 'later', updatedAt: at(days) }), NOW)).toBe(want);
  });

  it.each(['todo', 'doing', 'done', 'abandoned'] as const)('%s 不是搁置，不说', (status) => {
    expect(parkedQuietLabel(task({ status, updatedAt: at(90) }), NOW)).toBeNull();
  });

  it('updatedAt 解析不了就不说，不印 NaN', () => {
    expect(parkedQuietLabel(task({ status: 'later', updatedAt: '前年' }), NOW)).toBeNull();
  });

  it('**门槛比等待那条大一个量级**——搁置本来就是「暂时不做」，三天没动静是它应有的样子', () => {
    const t = task({ status: 'later', waitingFor: '张老师', updatedAt: at(5) });
    expect(waitingQuietLabel(t, NOW)).toBe('5 天没动静');
    expect(parkedQuietLabel(t, NOW)).toBeNull();
  });
});

/**
 * 「还没到开始时间」（OmniFocus 的 Defer Date，也就是 GTD 里的
 * 「等到那天再说」）。它把「现在还做不了」从「暂时不想做」（搁置）里分了
 * 出来——在这之前两种意图挤在同一个状态里。
 */
describe('notStarted', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const at = (h: number) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();

  it('没设开始时间 → false（随时可以做）', () => {
    expect(notStarted(task({ startAt: null }), NOW)).toBe(false);
  });

  it('开始时间在将来 → true', () => {
    expect(notStarted(task({ startAt: at(24) }), NOW)).toBe(true);
  });

  it('已经到了 → false', () => {
    expect(notStarted(task({ startAt: at(-1) }), NOW)).toBe(false);
  });

  it('正好这一刻 → false——「到了」就是到了，不留一个说不清的边界', () => {
    expect(notStarted(task({ startAt: NOW.toISOString() }), NOW)).toBe(false);
  });

  it('解析不了的时刻 → false，不抛也不把任务藏起来', () => {
    expect(notStarted(task({ startAt: '下周三' }), NOW)).toBe(false);
  });

  it('**不看 due**——「开始晚于截止」是自相矛盾，但校验器有意收下它，这里也不替他解释', () => {
    const t = task({ startAt: at(48), due: at(-48) });
    expect(notStarted(t, NOW)).toBe(true);
    expect(isTaskOverdue(t, NOW)).toBe(true);
  });
});

/**
 * **在等别人的任务照常进「今天」**——跟四象限那条同一个理由，见
 * `cells.test.ts` 里「有意不做」那一段。「今天」答的是「我今天盘子里有什么」，
 * 一条今天到期、在等人的任务确实在盘子里。
 */
describe('isInTodayView：「在等谁」不影响成员资格', () => {
  it('今天到期、在等人的，照常在「今天」里', () => {
    const now = new Date(2026, 7, 25, 12, 0, 0);
    const t = task({ id: 'w', due: new Date(2026, 7, 25, 18).toISOString(), waitingFor: '张律师' });
    expect(isInTodayView(t, now)).toBe(true);
  });
});

/**
 * **有截止时间的，由截止时间说了算。**
 *
 * 这一组来自一次真实的困惑（现场数据抄在第一条里）：改了日期，底下那句
 * 「有 1 条已经过期了」怎么都消不掉——因为消它的开关根本不在 `due` 上。
 */
describe('isTaskOverdue：一个已经响过的提醒，不能让还没到期的任务变成「过期」', () => {
  const NOW = new Date(2026, 7, 30, 9, 32);
  const local = (d: number, h: number, mi = 0) => new Date(2026, 7, d, h, mi).toISOString();

  /** 现场那一条：截止今晚 21:00，提醒昨天 10:00（响过）+ 今天 15:00（还没到）。 */
  const realOne = () => task({
    due: local(30, 21),
    reminders: [{ at: local(29, 10), firedAt: null }, { at: local(30, 15), firedAt: null }],
  });

  it('现场这一条：不算过期', () => {
    expect(isTaskOverdue(realOne(), NOW)).toBe(false);
  });

  /**
   * 分开断言两支，是为了让这条测试红的时候能一眼看出是哪一支变了：
   * 提醒那一支**照旧为真**（`reminders[0]` 确实过去了），被挡住的是总判据。
   */
  it('提醒那一支本身没变——挡住它的是「due 还没到」这个闸门', () => {
    expect(isReminderOverdue(realOne(), NOW)).toBe(true);
    expect(isOverdue(realOne(), NOW)).toBe(false);
  });

  it('屏幕上也不该有「已过期」那行字', () => {
    expect(overdueLabel(realOne(), NOW)).toBeNull();
  });

  it('底下那句提示的计数里也没有它', () => {
    expect(countStale([realOne()], NOW)).toBe(0);
  });

  it('due 一旦真的过了，照样算过期——闸门只挡「还没到」的', () => {
    const t = task({ due: local(29, 21), reminders: [{ at: local(29, 10), firedAt: null }] });
    expect(isTaskOverdue(t, NOW)).toBe(true);
  });

  /** 没有 due 的那一支一个字没动：这正是 `isReminderOverdue` 当初要补的分支。 */
  it('没设 due、提醒早就响过的，还是算过期', () => {
    expect(isTaskOverdue(task({ due: null, reminders: [{ at: local(29, 10), firedAt: null }] }), NOW)).toBe(true);
  });

  /**
   * `due` 写坏了（手改文件）**不算「还没到」**——一个坏字段不该有能力把提醒
   * 那一支静默关掉，那会让一条真该被追的任务从计数里凭空消失。
   */
  it('due 是坏数据时不挡，照旧走提醒那一支', () => {
    expect(isTaskOverdue(task({ due: '下周三', reminders: [{ at: local(29, 10), firedAt: null }] }), NOW)).toBe(true);
  });

  /**
   * **「今天」那一屏的成员资格不受影响**——那是另一个问题：一条昨天响过、还没
   * 处理的任务该不该浮到今天来，答案仍然是该。两个问题，两个答案。
   */
  it('不动「今天」的成员资格', () => {
    expect(isInTodayView(realOne(), NOW)).toBe(true);
    expect(isInTodayView(task({ due: local(31, 21), reminders: [{ at: local(29, 10), firedAt: null }] }), NOW)).toBe(true);
  });
});
