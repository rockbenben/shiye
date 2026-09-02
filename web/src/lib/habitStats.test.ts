import { describe, it, expect } from 'vitest';
import { habitStats, longestStreak } from './habitStats.js';
import { habitStreak } from './habit.js';
import { task } from '../test-utils.js';
import type { Repeat, Task } from '../types.js';

const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };
const local = (y: number, mo: number, d: number, h = 9) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

/** 2026-08-19，本月已过 19 天。 */
const NOW = local(2026, 8, 19, 12);

/** 一条打过卡的习惯实例。 */
const done = (title: string, day: number, over: Partial<Task> = {}): Task =>
  task({
    id: `${title}-${day}`, title, habit: true, repeat: DAILY,
    status: 'done', completedAt: iso(2026, 8, day), ...over,
  });

/** 当下待打卡的那条。 */
const live = (title: string): Task =>
  task({ id: `${title}-live`, title, habit: true, repeat: DAILY, status: 'todo' });

describe('longestStreak', () => {
  it('空集是 0', () => {
    expect(longestStreak(new Set())).toBe(0);
  });

  it('数出最长的一段', () => {
    expect(longestStreak(new Set(['2026-08-01', '2026-08-02', '2026-08-05']))).toBe(2);
  });

  it('**跨月也连得上**——按日期往后走，不是对 YYYY-MM-DD 字典序比相邻两项', () => {
    // 8-31 → 9-01 隔一天。字符串比较看不出这件事，而月末正是最容易断错的地方。
    expect(longestStreak(new Set(['2026-08-30', '2026-08-31', '2026-09-01']))).toBe(3);
  });

  it('乱序输入也对', () => {
    expect(longestStreak(new Set(['2026-08-03', '2026-08-01', '2026-08-02']))).toBe(3);
  });
});

describe('habitStats', () => {
  it('一个标题只出一份——同一个习惯散在多条记录上，全列出来会变成按天的流水账', () => {
    const all = [done('喝水', 17), done('喝水', 18), live('喝水')];
    expect(habitStats(all, NOW).map((h) => h.title)).toEqual(['喝水']);
  });

  /**
   * **「每周」那一档放宽之后进来了**，「每月/每年」照旧不算——习惯是「每天做」
   * 或者「每周做几次」（《开始坚持一个习惯》：「健身，我只需要
   * 一周完成 3 次即可」）。
   */
  it('不是习惯的不算；每月/每年重复的也不算', () => {
    const notHabit = task({ id: 'x', title: '写周报', repeat: DAILY });
    const monthly = task({ id: 'y', title: '交房租', habit: true, repeat: { ...DAILY, every: 'month' } });
    expect(habitStats([notHabit, monthly], NOW)).toEqual([]);
  });

  it('每周重复的习惯算进来——它以前跟每月一起被挡在外面', () => {
    const weekly = task({ id: 'y', title: '健身', habit: true, repeat: { ...DAILY, every: 'week', weekdays: [1, 3, 5] } });
    expect(habitStats([weekly], NOW).map((h) => h.title)).toEqual(['健身']);
  });

  it('连续天数跟卡片上那条完全一致——两处并排显示在同一个界面上', () => {
    const all = [done('喝水', 17), done('喝水', 18), live('喝水')];
    const fromCard = habitStreak(all, all[2], NOW);
    const fromStats = habitStats(all, NOW)[0];
    expect(fromStats.streak).toBe(fromCard.streak);
    expect(fromStats.doneToday).toBe(fromCard.doneToday);
  });

  it('今天还没打卡不算断——连了两天今天没做，是「2 天，今天待打卡」', () => {
    const all = [done('喝水', 17), done('喝水', 18), live('喝水')];
    const h = habitStats(all, NOW)[0];
    expect(h.streak).toBe(2);
    expect(h.doneToday).toBe(false);
  });

  it('本月分母是「已经过去几天」，不是整月天数——月初第二天不该显示 1 / 31', () => {
    const all = [done('喝水', 1), live('喝水')];
    expect(habitStats(all, local(2026, 8, 2, 12))[0]).toMatchObject({ monthDone: 1, monthElapsed: 2 });
  });

  it('打卡表一个月一格不落，还没到的日子标成 future', () => {
    const h = habitStats([done('喝水', 18), live('喝水')], NOW)[0];
    expect(h.days).toHaveLength(31);              // 八月 31 天
    expect(h.days.find((d) => d.dayOfMonth === 18)!.done).toBe(true);
    expect(h.days.find((d) => d.dayOfMonth === 19)!.future).toBe(false);  // 今天不算「还没到」
    expect(h.days.find((d) => d.dayOfMonth === 20)!.future).toBe(true);
  });

  /**
   * **今天新建的习惯不该显示「0 / 26」。** 那读起来是「26 天你一天都没做」，
   * 而它前 25 天根本不存在——而这一屏整个是靠连续天数激励的，第一天就告诉人
   * 欠了一堆，正好是反的。跟上面「不用整月天数」是同一个毛病的两半。
   */
  it('本月建的习惯：分母从建它那天算起，之前那些天标成 before', () => {
    const born = iso(2026, 8, 17);
    const h = habitStats([
      { ...live('冥想'), createdAt: born },
      { ...done('冥想', 18), createdAt: born },
    ], NOW)[0];
    // 8/17 建的，今天 8/19——能打卡的是 17/18/19 三天。
    expect(h.monthElapsed).toBe(3);
    expect(h.days.find((d) => d.dayOfMonth === 16)!.before).toBe(true);
    expect(h.days.find((d) => d.dayOfMonth === 17)!.before).toBe(false);
    // 「还没到」和「还不存在」是两回事，别混成一个标记。
    expect(h.days.find((d) => d.dayOfMonth === 16)!.future).toBe(false);
    expect(h.days.find((d) => d.dayOfMonth === 20)!.before).toBe(false);
  });

  /**
   * **一条 `createdAt` 解析不出来，不该毁掉整条习惯的统计。**
   *
   * 起始日原来是 `Math.min(...instances.map(t => Date.parse(t.createdAt)))`——
   * `Math.min` 里只要有一个 `NaN`，结果就恒为 `NaN`，`dayKey` 出来是
   * `"NaN-NaN-NaN"`，本月分母跟着塌成 0，界面上是「本月 0 / 0 天」。
   * `due` 被手改成「下周三」那类脏数据在这个仓库是有先例的（`hasNoDue` 那条
   * 注释就是为它写的），`createdAt` 同样是文件里的字符串、同样改得动。
   */
  it('有一条 createdAt 解析不出来：忽略它，分母照旧从最早那条能解析的算', () => {
    const born = iso(2026, 8, 17);
    const h = habitStats([
      { ...live('冥想'), createdAt: born },
      { ...done('冥想', 18), createdAt: '下周三' },
    ], NOW)[0];
    expect(h.monthElapsed, '一条坏数据把分母塌成了 0').toBe(3);
    expect(h.days.find((d) => d.dayOfMonth === 17)!.before).toBe(false);
  });
  it('上个月就有的习惯：分母还是「本月已过去几天」，一天不少', () => {
    const h = habitStats([done('喝水', 18), live('喝水')], NOW)[0];
    // 夹具默认 createdAt 是 8/1，本月每一天都算得上。
    expect(h.monthElapsed).toBe(19);
    expect(h.days.filter((d) => d.before)).toHaveLength(0);
  });

  it('**分母不看「最早打过卡那天」，看建它那天**——建了三天没打卡，那三天是真漏了', () => {
    const born = iso(2026, 8, 15);
    const h = habitStats([
      { ...live('拉伸'), createdAt: born },
      { ...done('拉伸', 18), createdAt: born },
    ], NOW)[0];
    expect(h.monthElapsed).toBe(5);          // 15…19
    expect(h.monthDone).toBe(1);             // 只有 18 号那天
  });

  it('代表那条取「还没完成的那条」——点它跳过去是待打卡的实例，不是历史', () => {
    const all = [done('喝水', 18), live('喝水')];
    expect(habitStats(all, NOW)[0].taskId).toBe('喝水-live');
  });

  it('一条待办实例都没有时退回最近更新的那条，只是为了有个 id 能点', () => {
    const all = [done('喝水', 18, { updatedAt: iso(2026, 8, 18) })];
    expect(habitStats(all, NOW)[0].taskId).toBe('喝水-18');
  });

  it('被搁置/放弃的实例不当代表，但它当初打过的卡照样算进历史', () => {
    const all = [done('喝水', 17), done('喝水', 18, { status: 'abandoned' }), live('喝水')];
    const h = habitStats(all, NOW)[0];
    expect(h.taskId).toBe('喝水-live');
    expect(h.streak).toBe(2);   // 17、18 两天都算
  });

  it('连得久的在前，一样久按标题', () => {
    const all = [
      done('乙', 18), live('乙'),
      done('甲', 18), live('甲'),
      done('长', 17), done('长', 18), live('长'),
    ];
    expect(habitStats(all, NOW).map((h) => h.title)).toEqual(['长', '甲', '乙']);
  });
});

describe('habitStats：liveId', () => {
  it('有还没了结的实例时就是它——「今天打卡」认的是这个 id', () => {
    const rows = [done('喝水', 18), live('喝水')];
    expect(habitStats(rows, NOW)[0].liveId).toBe('喝水-live');
  });

  it('**整串都了结了就是 null**，而 taskId 仍然退回最近动过的那条（还点得进去看）', () => {
    const rows = [done('喝水', 18)];
    const h = habitStats(rows, NOW)[0];
    expect(h.liveId).toBeNull();
    expect(h.taskId).toBe('喝水-18');
  });

  it('搁置的不算 live——一条搁置的实例上没有「打卡」这个动作', () => {
    const rows = [done('喝水', 18), { ...live('喝水'), status: 'later' as const }];
    expect(habitStats(rows, NOW)[0].liveId).toBeNull();
  });
});

/**
 * **每周那种习惯在这一屏上的表达**。
 *
 * 这一族是被一个真实的分叉逼出来的：`habitStats` 以前自己数了一遍连续天数
 * （一个叫 `currentStreak` 的私有函数），注释写着「跟 `habitStreak` 同一套
 * 算法，两处的结果必须一致」——习惯放宽到「每周」之后那份没跟上，同一条
 * 「一周三次」的健身在卡片上写「连续 4 周」，在这一屏上写「连续 1 天」。
 * 现在这儿直接调 `habitStreak`，那个私有函数删了。
 *
 * 日子按 2026-08 排：3 号周一、5 号周三、7 号周五（本周之前的那些周），
 * 17 / 19 号是这一周的周一和周三（`NOW` 是 8/19 周三）。
 */
describe('habitStats：每周那种习惯', () => {
  const WEEKLY: Repeat = { ...DAILY, every: 'week', weekdays: [1, 3, 5] };
  const w = (day: number, over: Partial<Task> = {}): Task =>
    task({ id: `健身-${day}`, title: '健身', habit: true, repeat: WEEKLY, status: 'done', completedAt: iso(2026, 8, day), ...over });
  const wlive = (): Task => task({ id: '健身-live', title: '健身', habit: true, repeat: WEEKLY, status: 'todo' });

  it('**连续数的是周，跟卡片上那条一字不差**——同一个 habitStreak，不是同一套算法各写一份', () => {
    const all = [w(3), w(5), w(7), w(10), w(12), w(14), w(17), w(19), wlive()];
    const h = habitStats(all, NOW)[0];
    expect(h.streak).toBe(habitStreak(all, wlive(), NOW).streak);
    expect(h.week).toEqual(habitStreak(all, wlive(), NOW).week);
  });

  it('「本周几次」报出来了——每天那种是 null，界面按它决定写「周」还是「天」', () => {
    const h = habitStats([w(17), w(19), wlive()], NOW)[0];
    expect(h.week).toEqual({ done: 2, target: 3 });
    expect(habitStats([done('喝水', 18), live('喝水')], NOW)[0].week).toBeNull();
  });

  it('**最长连续也数周**：连着三周都打够三次，就是 3', () => {
    const all = [w(3), w(5), w(7), w(10), w(12), w(14), w(17), w(19), wlive()];
    // 8/3-8/7 那周三次、8/10-8/14 那周三次、本周到 19 号只有两次（还没达标），
    // 所以最长是前两周 = 2。
    expect(habitStats(all, NOW)[0].longest).toBe(2);
  });

  it('中间断了一周就从头数——不是把所有达标周加起来', () => {
    const all = [w(3), w(5), w(7), /* 跳过 8/10 那一周 */ w(17), w(19), w(21), wlive()];
    expect(habitStats(all, NOW)[0].longest).toBe(1);
  });

  it('**不用打卡的那些天不算进分母**——一周三次的习惯在周二没打卡不是漏了', () => {
    const h = habitStats([w(3), wlive()], NOW)[0];
    // 8 月 1-19 号里，周一三五共 8 天（3/5/7/10/12/14/17/19）。
    expect(h.monthElapsed).toBe(8);
    expect(h.days.filter((d) => d.off).length).toBeGreaterThan(10);
  });

  it('每天那种一天都不是 `off`——这个字段对它恒 false', () => {
    const h = habitStats([done('喝水', 18), live('喝水')], NOW)[0];
    expect(h.days.some((d) => d.off)).toBe(false);
  });

  it('一个星期几都没勾（「每 N 周做一次」）：哪天都算得上打卡，目标是 1 次', () => {
    const t = task({ id: 'x', title: '大扫除', habit: true, repeat: { ...WEEKLY, weekdays: [] }, status: 'todo' });
    const h = habitStats([{ ...t, id: 'x-1', status: 'done' as const, completedAt: iso(2026, 8, 18) }, t], NOW)[0];
    expect(h.week).toEqual({ done: 1, target: 1 });
    expect(h.days.some((d) => d.off)).toBe(false);
  });
});

/**
 * `checkinDays` 只有一个读者——年度热力图的 `label` 回调（`HabitStats.tsx`）。
 * 它跟月历格子的 `off` 说的是同一句话，但那张图跨 365 天、格子是调用方画的，
 * 所以得把这份名单单独传出去。跟 `startKey` 存在的理由一模一样。
 */
describe('habitStats：checkinDays', () => {
  const WEEKLY: Repeat = { ...DAILY, every: 'week', weekdays: [1, 3, 5] };
  const wk = (over: Partial<Task> = {}): Task =>
    task({ id: '健身-live', title: '健身', habit: true, repeat: WEEKLY, status: 'todo', ...over });

  it('每周那种报出勾了的那几天', () => {
    expect(habitStats([wk()], NOW)[0].checkinDays).toEqual([1, 3, 5]);
  });

  it('每天那种是 null——哪天都算，没有「不用打卡的日子」', () => {
    expect(habitStats([done('喝水', 18), live('喝水')], NOW)[0].checkinDays).toBeNull();
  });

  it('「每 N 周做一次」（一个星期几都没勾）也是 null——那种哪天做都算那一周的那一次', () => {
    expect(habitStats([wk({ repeat: { ...WEEKLY, weekdays: [] } })], NOW)[0].checkinDays).toBeNull();
  });

  it('跟月历格子的 `off` 说的是同一句话——不是两份各判各的', () => {
    const h = habitStats([wk()], NOW)[0];
    for (const d of h.days) {
      const [y, m, dd] = d.key.split('-').map(Number);
      expect(d.off, `${d.key} 两处对不上`).toBe(!h.checkinDays!.includes(new Date(y, m - 1, dd).getDay()));
    }
  });
});
