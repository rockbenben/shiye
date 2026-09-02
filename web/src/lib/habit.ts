import type { Task } from '../types.js';
// 从模型层引，不从 `store.js`——那个文件碰 node 内置，打进网页包会白屏。
// 见 `server/src/model.ts` 顶上那段和 `webBundle.guard.test.ts`。
import { canBeHabit } from '../../../server/src/model.js';
import { dayKey, weekStartOf } from './calendar.js';
import type { WeekStart } from '../types.js';

export interface HabitState {
  /**
   * 连续多少个**周期**。每天的习惯就是连续天数；**每周的习惯是连续几周达标**
   * ——对一条「一周三次」的习惯说「连续 12 天」是句假话，它本来就不用天天做。
   */
  streak: number;
  doneToday: boolean;
  /**
   * 每周的习惯这一周做到几次了。每天的习惯是 `null`——那种没有「本周几次」
   * 这个概念，它的进度就是连续天数本身。
   */
  week: { done: number; target: number } | null;
}

/**
 * **哪些重复档能当习惯——名单在这儿，只在这儿。**
 *
 * 放宽到「每周」的时候这件事真的飘过：`habit.ts` / `habitStats.ts` 跟上了，
 * `App.tsx`（新建）和 `TaskCard.tsx`（保存）里那两句照样写着「不是每天就把
 * 记号抹掉」——于是一条每周的习惯**在表单里勾得上、一按保存就没了**，
 * 而两边都编译得过、也没有任何一处报错。`calendarMarks.ts` 那句同样漏了，
 * 后果是它打得了卡、日历上不出现。
 *
 * 名单（`HABIT_EVERY`）**和判据本身**都在 `server/src/model.ts`——服务端也要问
 * 同一个问题（校验器、以及 `mutate.ts` 合并 patch 之后那一次），放在那儿两个包
 * 引的才是同一份。这儿只把它转出去，网页那边的调用点不用改。
 * `habitKind.guard.test.ts` 盯着别处不许再写一遍。
 *
 * 这一个是**编辑器里问的形状**：手上只有一份重复规则，还没成任务。
 */
export { canBeHabit };

/** 读数据时问的形状：既要标了记号，重复档也得对得上。 */
export const isHabit = (t: Task): boolean => t.habit === true && canBeHabit(t.repeat);

/** 这条习惯是不是「每周做几次」那一种。每天的那种返回 false。 */
export const isWeekly = (t: Task): boolean => t.habit === true && t.repeat?.every === 'week';

/**
 * 「一周要做几次」。**就是选中的星期几个数**——「一周三次」在这个应用里的
 * 表达方式是 `weekdays: [1, 3, 5]`。
 *
 * 一个都没选（`every: 'week'` + 空数组，意思是「每 N 周做一次」）算 1 次。
 */
export const weeklyTarget = (t: Task): number => Math.max(1, (t.repeat?.weekdays ?? []).length);

/**
 * 这一天，这个习惯**本来就该打卡吗**。
 *
 * 每天的那种恒真。每周的那种看勾了哪几个星期几——「一周三次」的健身在周二
 * 没打卡不是漏了，它本来就不用做。月度打卡表的分母和最长连续都靠这个判据，
 * 不然一条一周三次的习惯在那一屏上永远像是欠着一堆账。
 *
 * 一个星期几都没勾（`every: 'week'` + 空数组，意思是「每 N 周做一次」）时
 * 哪天都算——那种没有指定日子，随便哪天做都是那一周的那一次。
 */
export const isCheckinDay = (t: Task, d: Date): boolean => {
  if (!isWeekly(t)) return true;
  const days = t.repeat?.weekdays ?? [];
  return days.length === 0 || days.includes(d.getDay());
};

/**
 * 一个习惯（按标题认）打过卡的那些**本地日期**。
 *
 * 提出来是因为「一个习惯的历史怎么拼起来」这件事现在有两个读者：卡片上那条
 * 连续天数（`habitStreak`）和习惯概览（`habitStats.ts` 的月度打卡表、最长
 * 连续）。两处各写一遍的话，「哪几天算打过卡」迟早给出两种答案，而它们会并排
 * 显示在同一个界面上。
 *
 * 坏数据一律跳过（`completedAt` 解析不了）——`data/tasks/` 是手改得到的文件。
 */
export function habitDoneDays(all: Task[], title: string): Set<string> {
  const out = new Set<string>();
  for (const task of all) {
    if (!isHabit(task) || task.title !== title) continue;
    if (!task.completedAt) continue;
    const d = new Date(task.completedAt);
    if (Number.isNaN(d.getTime())) continue;
    out.add(dayKey(d));
  }
  return out;
}

/**
 * 从 `completedAt` 的历史算连续打卡天数——不另存计数（规格第六节）。
 *
 * 一个习惯的历史散在**多条任务记录**上：一条重复任务标完成，
 * 服务端 `nextInstance`（server/src/repeat.ts）会生成一条新任务，旧的那条留着
 * `completedAt` 不动。所以没法靠一条记录上的数组拿到历史，只能在 `all` 里
 * 找齐同一个习惯的所有实例。
 *
 * **找齐靠「标题相同 + habit + 每天重复」这条启发式**，跟服务端判断「下一条
 * 是不是已经生成过」（`server/src/app.ts` 的 `maybeSpawnNextInstance`，同样用
 * 标题相同）走的是同一条线。**这是启发式，不是精确匹配**：改了标题，连续
 * 天数会从头算起。
 *
 * （这段注释以前写着「`Task` 上没有 `parentId`」——那已经不成立了，多级任务
 * 那一批加上了。但**不能拿它来串这条链**：`parentId` 是人在界面上挂的父子
 * 关系，`nextInstance` 生成下一条时不写它；拿同一个字段表达两种含义，两边
 * 迟早互相踩。真要精确匹配得另加一个 `seriesId`，那是另一件事。）
 */
export function habitStreak(all: Task[], t: Task, now: Date, weekStart: WeekStart = 1): HabitState {
  if (!isHabit(t)) return { streak: 0, doneToday: false, week: null };

  const doneDays = habitDoneDays(all, t.title);
  const doneToday = doneDays.has(dayKey(now));

  if (isWeekly(t)) {
    /**
     * **每周的习惯数的是「连续几周达标」，不是连续天数。**
     *
     * 一条「一周三次」的健身，周一三五做完之后连续天数是 1（周二没做）——
     * 那个数字对它是句假话，它本来就不用天天做。
     *
     * 周首走 `weekStartOf`（`calendar.ts` 那唯一一份），跟日历、专注统计的
     * 「本周」是同一个数——不然「本周 2/3」和日历上那七列会各说各的。
     */
    const target = weeklyTarget(t);
    const doneIn = (start: Date): number => {
      let n = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        if (doneDays.has(dayKey(d))) n++;
      }
      return n;
    };
    const thisWeek = weekStartOf(now, weekStart);
    const done = doneIn(thisWeek);

    // 本周还没做够不算断——跟每天那种「今天还没打卡不等于断了」同一条：
    // 一个连了十二周的习惯，周一看它该显示「12 周」，不是「0 周」。
    const cursor = new Date(thisWeek);
    if (done < target) cursor.setDate(cursor.getDate() - 7);
    let streak = 0;
    // 上界防手改数据造出的怪表：一年五十二周，四百轮够到八年前。
    for (let guard = 0; guard < 400 && doneIn(cursor) >= target; guard++) {
      streak++;
      cursor.setDate(cursor.getDate() - 7);
    }
    return { streak, doneToday, week: { done, target } };
  }

  // 今天还没打卡不等于断了：从「今天已完成就从今天数，否则从昨天数」的那一天
  // 开始往回数连续命中的天数——一个连了三十天的习惯，今天还没做，该显示
  // 「30 天，今天待打卡」，不是「0 天」。
  const cursor = new Date(now);
  if (!doneToday) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (doneDays.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { streak, doneToday, week: null };
}
