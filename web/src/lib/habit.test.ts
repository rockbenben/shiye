import { describe, expect, it } from 'vitest';
import { habitStreak } from './habit.js';
import { task } from '../test-utils.js';
import type { Repeat } from '../types.js';

const NOW = new Date(2026, 7, 17, 12, 0, 0); // 2026-08-17 周一中午
const iso = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();
const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

/** 一条「习惯」记录的夹具：habit+repeat 每天，标题固定，方便测「找齐同一个习惯」。 */
const habit = (id: string, completedAt: string | null, title = '喝八杯水') =>
  task({ id, title, habit: true, repeat: DAILY, completedAt });

describe('habitStreak', () => {
  it('连续三天完成 → streak 3', () => {
    const t = habit('t3', iso(2026, 8, 17));
    const all = [habit('t1', iso(2026, 8, 15)), habit('t2', iso(2026, 8, 16)), t];
    expect(habitStreak(all, t, NOW)).toEqual({ streak: 3, doneToday: true, week: null });
  });

  it('今天还没完成 → streak 数到昨天，doneToday false', () => {
    const t = habit('t4', null); // 今天这条还没标完成
    const all = [habit('t1', iso(2026, 8, 14)), habit('t2', iso(2026, 8, 15)), habit('t3', iso(2026, 8, 16)), t];
    expect(habitStreak(all, t, NOW)).toEqual({ streak: 3, doneToday: false, week: null });
  });

  it('今天完成了 → doneToday true，今天算进 streak', () => {
    const t = habit('t1', iso(2026, 8, 17));
    expect(habitStreak([t], t, NOW)).toEqual({ streak: 1, doneToday: true, week: null });
  });

  it('中间断了一天 → 只数到断点', () => {
    const t = habit('t3', iso(2026, 8, 17));
    // 8/15 缺一天，8/14 那条虽然也是同一个习惯，但断点之前的不该被数进去
    const all = [habit('t0', iso(2026, 8, 14)), habit('t2', iso(2026, 8, 16)), t];
    expect(habitStreak(all, t, NOW)).toEqual({ streak: 2, doneToday: true, week: null });
  });

  it('同一天完成两条 → 算一天', () => {
    const t = habit('t1', iso(2026, 8, 17, 8));
    const dup = habit('t2', iso(2026, 8, 17, 20));
    expect(habitStreak([t, dup], t, NOW)).toEqual({ streak: 1, doneToday: true, week: null });
  });

  // 上限：标题不同的记录不该被当成同一个习惯的历史
  it('标题不同的不算同一个习惯', () => {
    const t = habit('t1', null, '喝八杯水');
    const other = habit('x1', iso(2026, 8, 17), '写周报'); // habit/repeat 都一样，只有标题不同
    expect(habitStreak([t, other], t, NOW)).toEqual({ streak: 0, doneToday: false, week: null });
  });

  // 上限：不是习惯的任务一律返回 0，调用方靠这个决定要不要显示打卡条。
  // 同标题下混进真正符合习惯定义的历史（habit+每天+今明两天都完成）——
  // 只靠循环内部按 task.habit 过滤别的记录挡不住这条：那样会把别人的历史
  // 算成 t 的 streak。必须是 t 自己这条上的早退才对。
  it('habit: false 的返回 0', () => {
    const t = task({ id: 't1', title: '喝八杯水', habit: false, repeat: DAILY, completedAt: iso(2026, 8, 17) });
    const history = [habit('h1', iso(2026, 8, 16)), habit('h2', iso(2026, 8, 17))];
    expect(habitStreak([t, ...history], t, NOW)).toEqual({ streak: 0, doneToday: false, week: null });
  });

  /**
   * 上限：**「每月打卡」不是习惯**，返回 0。这一条不变——变的是「每周」那一档，
   * 它以前跟每月一起被挡在外面，现在是合法的习惯（见下面那一族）。
   * 同理混进同标题的真实每日历史，逼着这条断言只有靠 t 自己的早退才能通过。
   */
  it('repeat 是「每月」的返回 0', () => {
    const monthly: Repeat = { every: 'month', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };
    const t = task({ id: 't1', title: '写周报', habit: true, repeat: monthly, completedAt: iso(2026, 8, 17) });
    const history = [
      task({ id: 'h1', title: '写周报', habit: true, repeat: DAILY, completedAt: iso(2026, 8, 16) }),
      task({ id: 'h2', title: '写周报', habit: true, repeat: DAILY, completedAt: iso(2026, 8, 17) }),
    ];
    expect(habitStreak([t, ...history], t, NOW)).toEqual({ streak: 0, doneToday: false, week: null });
  });

  it('completedAt 解析不了的跳过，不抛', () => {
    const t = habit('t1', '不是日期');
    expect(() => habitStreak([t], t, NOW)).not.toThrow();
    expect(habitStreak([t], t, NOW)).toEqual({ streak: 0, doneToday: false, week: null });
  });

  // 时区陷阱：东八区当地凌晨完成的，UTC 是前一天下午——不能用 toISOString().slice(0,10)
  it('本地凌晨完成的算当天，不是前一天（东八区）', () => {
    const t = habit('t1', iso(2026, 8, 17, 0)); // 当地 00:00
    expect(habitStreak([t], t, NOW).doneToday).toBe(true);
  });
});

/**
 * **每周的习惯**（仿滴答清单：「健身，我只需要一周完成 3 次即可」）。
 *
 * 放宽之前这个应用连表达都表达不了——标成习惯就必须每天做，而那条限制给的
 * 理由是「『每月打卡』不是习惯」，那句话盖不住「一周三次」。
 *
 * 「一周三次」在这儿的表达方式是 `every: 'week'` + `weekdays: [1,3,5]`：
 * **次数就是选中的天数**。
 */
describe('habitStreak：每周的习惯', () => {
  /** 2026-08-19 是周三。周一档的本周是 8/17（周一）起。 */
  const WED = new Date(2026, 7, 19, 12, 0, 0);
  const weekly = (days: number[]): Repeat =>
    ({ every: 'week', interval: 1, weekdays: days, until: null, from: 'due', count: null, step: 0, monthDay: null });
  const inst = (id: string, day: number) =>
    task({ id, title: '健身', habit: true, repeat: weekly([1, 3, 5]), completedAt: iso(2026, 8, day) });

  it('本周做了几次就报几次，目标是选中的天数', () => {
    const t = inst('t1', 19);
    const got = habitStreak([t, inst('h1', 17)], t, WED);
    expect(got.week).toEqual({ done: 2, target: 3 });
  });

  /**
   * **连续数的是「周」不是「天」。** 一条一周三次的习惯，周一三五做完之后
   * 连续天数是 1（周二没做）——那个数字对它是句假话。
   */
  it('连续几周达标，不是连续几天', () => {
    const t = inst('t1', 19);
    const all = [t, inst('h1', 17), inst('h2', 21), // 本周 8/17、19、21 三次，达标
      inst('p1', 10), inst('p2', 12), inst('p3', 14)]; // 上周三次，也达标
    const got = habitStreak(all, t, WED);
    expect(got.week).toEqual({ done: 3, target: 3 });
    expect(got.streak).toBe(2);
  });

  /**
   * **本周还没做够不算断**——跟每天那种「今天还没打卡不等于断了」一字不差：
   * 一个连了两周的习惯，周一看它该显示「2 周」，不是「0 周」。
   */
  it('本周还没做够：连续周数从上周算起，不清零', () => {
    const t = inst('t1', 19);
    const all = [t, inst('p1', 10), inst('p2', 12), inst('p3', 14)];
    const got = habitStreak(all, t, WED);
    expect(got.week).toEqual({ done: 1, target: 3 });
    expect(got.streak).toBe(1);
  });

  it('上周没做够：连续断在那儿', () => {
    const t = inst('t1', 19);
    const all = [t, inst('h1', 17), inst('h2', 21), inst('p1', 10)]; // 上周只有一次
    expect(habitStreak(all, t, WED).streak).toBe(1);
  });

  it('一天都没选（每 N 周一次）：目标算 1 次', () => {
    const t = task({ id: 't1', title: '体检', habit: true, repeat: weekly([]), completedAt: iso(2026, 8, 19) });
    expect(habitStreak([t], t, WED).week).toEqual({ done: 1, target: 1 });
  });

  /**
   * **周首跟着设置走**，跟日历那七列、专注统计的「本周」是同一个数
   * （`calendar.ts` 的 `weekStartOf`）——不然「本周 2/3」和日历各说各的。
   */
  it('周首跟着 weekStart 走：周日档下 8/16（周日）算本周', () => {
    const t = inst('t1', 19);
    const all = [t, inst('h1', 16)];  // 8/16 是周日
    expect(habitStreak(all, t, WED, 1).week!.done).toBe(1);   // 周一档：8/16 是上周
    expect(habitStreak(all, t, WED, 0).week!.done).toBe(2);   // 周日档：8/16 算本周
  });

  it('每天的习惯 week 是 null——那种没有「本周几次」这个概念', () => {
    const t = task({ id: 't1', title: '喝水', habit: true, repeat: DAILY, completedAt: iso(2026, 8, 19) });
    expect(habitStreak([t], t, WED).week).toBeNull();
  });
});
