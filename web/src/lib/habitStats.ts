import type { Task } from '../types.js';
import { dayKey, weekStartOf } from './calendar.js';
import { habitDoneDays, habitStreak, isCheckinDay, isHabit, weeklyTarget } from './habit.js';
import type { WeekStart } from '../types.js';

/**
 * 习惯概览——仿滴答清单的「打卡概览」和「月度打卡表」。
 *
 * **习惯在这个应用里目前只在「今天」露过面**（`TodayView` 里那条连续天数），
 * 换个视图就什么都看不见，更没有「这个月坚持得怎么样」这种回答。它那边习惯
 * 是一个独立模块，有月度打卡表、连续天数、年度热力图；这里补上前两样。
 *
 * 一个习惯的历史散在**多条任务记录**上（每天完成一条、服务端生成下一条），
 * 靠「标题相同 + habit + 每天重复」认成一串——判据在 `habit.ts` 的
 * `habitDoneDays`，两处共用，不在这里再写一遍。
 *
 * 纯函数，不读时钟。
 */

export interface HabitDay {
  /** 本地 `YYYY-MM-DD`，同时是 React key。 */
  key: string;
  /** 这个月的第几天。 */
  dayOfMonth: number;
  done: boolean;
  /** 还没到的日子。打卡表上要跟「到了但没打」区分开——一个还没发生的日子
   *  画成空格，看起来跟「漏了」一模一样。 */
  future: boolean;
  /**
   * 那一天这个习惯**本来就不用打卡**——一周三次的健身在周二。
   *
   * 跟 `before`/`future` 一样不是「漏了」，格子画得也一样，但悬停说的话
   * 不一样（「这天不用打卡」而不是「那时还没有这个习惯」）。每天的习惯
   * 恒 `false`。
   */
  off: boolean;
  /**
   * 那一天这个习惯**还不存在**（建它之前）。
   *
   * 跟 `future` 一样不该算它的账，但**是另一个原因**，所以两者分开：格子画得
   * 一样（都不是「漏了」），悬停说的话不一样。
   *
   * 不分开的话，26 号建的一个习惯，1–25 号那 25 个格子跟「漏打卡」长得一模
   * 一样，悬停还会说「没打卡」——那是一句字面上不成立的话。
   */
  before: boolean;
}

export interface HabitSummary {
  /** 习惯的标题，同时是它的身份（见上面那条启发式）。 */
  title: string;
  /** 当下这条实例的 id——界面上点它能跳回那张卡。 */
  taskId: string;
  /**
   * **还没了结的那条实例**的 id，没有就是 `null`。
   *
   * 跟 `taskId` 的区别只在「一条都没有 live 的时候」：那时 `taskId` 退回最近
   * 动过的那一条（为了还能点进去看看），而这个字段老老实实是 `null`。
   *
   * 「今天打卡」那颗按钮认的是这个：**打卡就是把当下这条实例标完成**，而一条
   * 已经完成/放弃/搁置的实例上没有这个动作可做。分成两个字段而不是让调用方
   * 自己再判一次状态——那等于把「哪条算当下这一条」这个判断抄到界面里去。
   */
  liveId: string | null;
  /**
   * 当前连续多少个**周期**。判据跟卡片上那条完全一致——**同一个 `habitStreak`**，
   * 不是「同一套算法各写一份」：这儿以前自己数了一遍连续天数，放宽到「每周」
   * 之后那份没跟上，同一条习惯在卡片上写「连续 4 周」、在这一屏上写「连续 1 天」。
   *
   * 每天的习惯单位是天，每周的是周。**单位由 `week` 是不是 null 决定**，
   * 界面别自己再判一次。
   */
  streak: number;
  doneToday: boolean;
  /**
   * 每周那种习惯这一周做到几次了；每天那种是 `null`。跟 `HabitState.week`
   * 同一个形状、同一个来源。
   */
  week: { done: number; target: number } | null;
  /** 历史上最长的一次连续，单位跟 `streak` 一样。 */
  longest: number;
  /**
   * 每周那种习惯该在哪几天打卡（`getDay()` 的 0–6）；每天那种、以及
   * 「每 N 周做一次」（没勾星期几）那种是 `null`——**那两种哪天都算**。
   *
   * 月历格子自己有 `off` 就够了，这个字段是给**年度热力图**用的：它跨 365 天，
   * 而 `Heatmap` 的 `label` 是调用方给的回调——不把这份名单传出去，那张图会对
   * 一周三次的习惯的每个周二都说「没打卡」。跟 `startKey` 存在的理由一模一样。
   */
  checkinDays: number[] | null;
  /** 这个月打了几天。 */
  monthDone: number;
  /**
   * 这个月**这个习惯能打卡的天数**（含今天）。分母用它。
   *
   * 两次收窄，同一个毛病的两半：
   * ① 不用整月天数——月初第二天显示「1 / 30」会让人以为自己落下了 29 天；
   * ② 也不用「本月已过去几天」——**26 号新建的习惯会显示「0 / 26」**，读起来
   *    是「26 天你一天都没做」，而它前 25 天根本不存在。习惯这一屏整个是靠
   *    连续天数激励的，第一天就告诉人欠了 26 天，正好是反的。
   *
   * 现在从 `days` 里数：既不是 `future` 也不是 `before` 的那些天。
   */
  monthElapsed: number;
  /** 这个月的打卡表，一天一格。 */
  days: HabitDay[];
  /**
   * 这个习惯是哪天开始的，本地 `YYYY-MM-DD`（名下最早那条记录的 `createdAt`）。
   *
   * 月历格子自己用 `before` 就够了，这个字段是给**「看这一年」那张热力图**用的：
   * 它跨 365 天，而 `Heatmap` 的 `label` 是调用方给的回调——不把这天传出去，
   * 那张图会对建这个习惯之前的每一天都说「没打卡」，跟月历格子以前那句是同一句
   * 不成立的话，只是面积大得多。
   */
  startKey: string;
}

/**
 * 从一份「打过卡的日期」集合里数出最长的一段连续。
 *
 * **只对每天的习惯成立**——每周那种走 `longestWeeks`，见它上面那段。
 */
export function longestStreak(doneDays: Set<string>): number {
  if (doneDays.size === 0) return 0;
  // 逐日往后走，不是对字符串排序之后比相邻两项——`YYYY-MM-DD` 的字典序碰上
  // 月末/年末（`2026-08-31` → `2026-09-01`）没法判断「是不是隔了一天」，
  // 而那正是连续天数最容易断错的地方。
  const dates = [...doneDays].sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of dates) {
    const [y, m, d] = key.split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    if (prev) {
      const next = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1);
      run = dayKey(next) === key ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
    prev = cur;
  }
  return best;
}

/**
 * 这个月的打卡表。
 *
 * `startKey` 是这个习惯最早那条记录的日子（本地 `YYYY-MM-DD`）。比它早的那些
 * 天标成 `before`——那时候还没有这个习惯，不能算成漏打卡。**按字符串比**：
 * `YYYY-MM-DD` 是定长的，字典序就是时间序，不用为此再造一个 Date 去比。
 */
function monthGrid(doneDays: Set<string>, now: Date, startKey: string, t: Task): HabitDay[] {
  const total = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = now.getDate();
  const out: HabitDay[] = [];
  for (let d = 1; d <= total; d++) {
    const date = new Date(now.getFullYear(), now.getMonth(), d);
    const key = dayKey(date);
    out.push({
      key, dayOfMonth: d, done: doneDays.has(key), future: d > today, before: key < startKey,
      off: !isCheckinDay(t, date),
    });
  }
  return out;
}

/**
 * 每周那种习惯的**最长连续几周达标**。
 *
 * 跟 `longestStreak` 分开而不是加个参数：两者数的是不同的东西（天 / 周），
 * 合成一个函数只会让两条路都难读。取值口径跟 `habitStreak` 里那段一致
 * ——一周之内打够 `target` 次就算这一周达标。
 */
function longestWeeks(doneDays: Set<string>, t: Task, weekStart: WeekStart): number {
  if (doneDays.size === 0) return 0;
  const target = weeklyTarget(t);
  const perWeek = new Map<string, number>();
  for (const key of doneDays) {
    const [y, m, d] = key.split('-').map(Number);
    const wk = dayKey(weekStartOf(new Date(y, m - 1, d), weekStart));
    perWeek.set(wk, (perWeek.get(wk) ?? 0) + 1);
  }
  const weeks = [...perWeek.entries()].filter(([, n]) => n >= target).map(([k]) => k).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of weeks) {
    const [y, m, d] = k.split('-').map(Number);
    // 上一个达标周的下一周就是这一周？隔了几周就断了，从 1 重新数。
    const back = dayKey(new Date(y, m - 1, d - 7));
    run = prev === back ? run + 1 : 1;
    if (run > best) best = run;
    prev = k;
  }
  return best;
}

/**
 * 每个习惯一份概览。
 *
 * **一个标题只出一份**：同一个习惯散在多条任务记录上（每天一条），全列出来
 * 会变成一份按天的流水账，而这个页面回答的是「这几个习惯坚持得怎么样」。
 * 代表那一条取**还没完成的那条**（当下待打卡的实例）；一条都没有（比如今天
 * 的已经打完、下一条还没生成）就退回最近更新的那条，只是为了有个 id 能点。
 *
 * 已放弃/已搁置的实例不参与「代表谁」的挑选，但**它们的历史照样算**——
 * `habitDoneDays` 只看 `completedAt`，一条后来被搁置的实例当初真的打过卡。
 */
export function habitStats(all: Task[], now: Date, weekStart: WeekStart = 1): HabitSummary[] {
  const byTitle = new Map<string, Task[]>();
  for (const t of all) {
    if (!isHabit(t)) continue;
    const bucket = byTitle.get(t.title);
    if (bucket) bucket.push(t);
    else byTitle.set(t.title, [t]);
  }

  const out: HabitSummary[] = [];
  for (const [title, instances] of byTitle) {
    const live = instances.find((t) => t.status !== 'done' && t.status !== 'abandoned' && t.status !== 'later');
    const rep = live
      ?? [...instances].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const doneDays = habitDoneDays(all, title);
    // **走卡片上那一份**，不在这儿再数一遍：以前这儿有个 `currentStreak`，
    // 注释写着「跟 habitStreak 同一套算法，两处的结果必须一致」——放宽到
    // 「每周」之后它没跟上，同一条习惯两屏上写着两个数。
    const { streak, doneToday, week } = habitStreak(all, rep, now, weekStart);
    // 习惯是哪天开始的：拿它名下最早那条记录的 `createdAt`。**不是「最早打过卡
    // 的那天」**——建了三天没打卡的习惯，那三天是真的漏了，该算进分母。
    // **解析不出来的 `createdAt` 要剔掉，不能直接进 `Math.min`。** 只要有一条坏的，
    // `Math.min` 的结果就恒为 `NaN`，`dayKey` 出来是 `"NaN-NaN-NaN"`，整条习惯的
    // 起始日没了——月度分母跟着变成 0，界面上是「本月 0 / 0 天」。一条手改坏的
    // 记录不该毁掉这条习惯的全部统计。
    // 全都解析不出来（极端情况）就退回 `now`：那天之前没有可信的起点，分母从今天算。
    const starts = instances.map((t) => Date.parse(t.createdAt)).filter((n) => !Number.isNaN(n));
    const startKey = dayKey(starts.length > 0 ? new Date(Math.min(...starts)) : now);
    const days = monthGrid(doneDays, now, startKey, rep);
    out.push({
      title,
      taskId: rep.id,
      liveId: live?.id ?? null,
      streak,
      doneToday,
      week,
      longest: week ? longestWeeks(doneDays, rep, weekStart) : longestStreak(doneDays),
      checkinDays: week && (rep.repeat?.weekdays ?? []).length > 0 ? [...rep.repeat!.weekdays] : null,
      monthDone: days.filter((d) => d.done).length,
      // `off`（一周三次的习惯在周二）跟 `future`/`before` 一样不算账：
      // 那天本来就不用做，算进分母等于说他欠着。
      monthElapsed: days.filter((d) => !d.future && !d.before && !d.off).length,
      days,
      startKey,
    });
  }
  // 连得久的在前，一样久按标题——不留「顺序取决于 readTasks() 的文件顺序」
  // 这种一改就变的排法。
  return out.sort((a, b) => b.streak - a.streak || a.title.localeCompare(b.title, 'zh'));
}
