import type { Settings, Task } from './store.js';
import { isSettled } from './task.js';

/**
 * 每日概览——每天固定一个时刻，把今天要做的事
 * 推一条出来。
 *
 * 补的是这个应用在通知这件事上的一个空缺：它只在**某一条任务**到点时说话
 * （`reminder.ts`），而多数任务根本没设提醒——它们只有一个截止日期。于是
 * 「今天有什么」这件事完全靠人自己想起来打开应用看一眼，而这类工具最该替人
 * 记住的恰恰就是这一下。三路通知（网页横幅 / Windows 通知 / webhook）都是
 * 现成的，这里只补「什么时候说、说什么」。
 *
 * 纯函数，不读时钟、不碰文件。
 */

/** `HH:MM`，24 小时制。别的一律当没设。 */
export function parseHhmm(v: unknown): { h: number; m: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/** 本地日期 `YYYY-MM-DD`。跟 web 那边的 `dayKey` 同一条规矩：**不能用
 *  `toISOString().slice(0,10)`**，那是 UTC 镜头，晚上八点之后会算成明天。 */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 这一刻该不该发今天这一条。
 *
 * 三条都得成立：设了时刻、已经到点（本地墙钟）、今天还没发过。
 *
 * **「今天还没发过」靠 `dailySummaryOn` 记，不靠「刚好等于那一分钟」**：
 * 这个 tick 三十秒一轮，机器睡过去、服务重启、时钟跳一下，都可能让那一分钟
 * 整个被跳过——按「到点了就发，发过就记一天」判，晚一点也还是发得出来，
 * 而不是那天就静默地没有了。
 *
 * 反过来也守得住：一天只发一条，`dailySummaryOn` 是那天的本地日期。
 */
export function shouldSendSummary(settings: Settings, now: Date): boolean {
  const at = parseHhmm(settings.dailySummaryAt);
  if (!at) return false;
  if (settings.dailySummaryOn === localDay(now)) return false;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.h, at.m, 0, 0);
  return now.getTime() >= target.getTime();
}

/** 两个时刻之间差几个**本地日历天**（同一天算 0）。按年/月/日算，不是拿 24 小时
 *  去除——跟 `localDay` 同一条理由：「第几天」是人眼里的日历格子数。 */
function dayNo(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

/**
 * **跨天的那几条，区间内每一天都算今天。** 判据跟网页那边 `isInTodayView`
 * 第六条对得上（两边由 `todayParity.guard.test.ts` 逐条对账）：`startAt` 和
 * `due` 都在、落在不同的本地日历天、开始早于截止；区间是
 * `[开始那天, 截止那天)`——截止那天由 `summaryTasks` 里 `when()` 那条收，不在
 * 这里重复算。
 *
 * 少了 `due` 就不是跨天，是「就那一天」（`startsToday`）。那条既有判据不动：
 * 没有上界的「已经开始了的都算」会让一条三个月前开始的活永远赖在今天，
 * 网页那边那段注释论证的就是这个。
 *
 * `total >= 2` 那道门槛跟网页那边 `spanOf` 是同一条：今天开始、明天就截止的
 * 那条只有一天可做，不是「要做好几天」。这一支就算写成 `>= 1` 也不会让两边
 * 的答案分叉（区间里只有开始那一天，而那一天 `startsToday` 已经收了），但对
 * 账测试只比「收不收」，比不到这一层——所以这一句还是照抄，别让它先飘。
 *
 * 收在模块级而不是 `summaryTasks` 里面：`summaryText` 问的是同一个问题
 * （「这条今天要清掉吗」），一份判据两处用。
 */
export function isOpenSpan(t: Task, now: Date): boolean {
  if (!t.startAt || !t.due) return false;
  const from = Date.parse(t.startAt);
  const to = Date.parse(t.due);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const total = dayNo(new Date(to)) - dayNo(new Date(from));
  const i = dayNo(now) - dayNo(new Date(from));
  return total >= 2 && i >= 0 && i < total;
}

/**
 * 这条任务**属于今天**吗——**不管它了结了没有**。
 *
 * **判据只有这一份**：`summaryTasks`（今天还剩哪几条）和 `todayProgress`（今天
 * 一共几件、做完了几件）问的是同一个问题，两边各写一份的话迟早有一份先飘。
 *
 * 判据跟网页那边 `isInTodayView` 对得上（`todayParity.guard.test.ts` 逐条对账）：
 * due / 提醒里最早的那个时刻落在今天**或更早**（欠着的也算今天）、今天开始、
 * 或者处在一个跨天的区间里。
 */
function belongsToToday(t: Task, now: Date): boolean {
  const today = localDay(now);
  /** 这条任务属于哪一天：取 due 和所有提醒里最早的那个时刻。都没有就是 `null`。 */
  const when = (x: Task): number | null => {
    const ms = [x.due, ...(Array.isArray(x.reminders) ? x.reminders.map((r) => r?.at) : [])]
      .map((v) => (v ? Date.parse(v) : NaN))
      .filter((n) => !Number.isNaN(n));
    return ms.length ? Math.min(...ms) : null;
  };
  /** 解得出来的 `startAt` 时刻，没有/解不出来就是 `null`。 */
  const startMs = (x: Task): number | null => {
    const at = x.startAt ? Date.parse(x.startAt) : NaN;
    return Number.isNaN(at) ? null : at;
  };
  /**
   * **今天开始的那些也算今天的。** 判据是「就今天这一天」，不是 `when` 那种
   * `<= today`——过去的开始时间不该让一条任务永远赖在今天，理由跟网页那边
   * `isInTodayView` 上那一整段一字不差（那边是正本，出处也记在那儿）。
   *
   * 单独一支、不折进 `when()`：那个函数取的是 due/提醒里**最早**的时刻，
   * 用来回答「这条属于哪一天、欠了多久」；开始时间回答的是另一个问题
   * （「今天轮到它了吗」），而且判据是等于不是小于等于。混进同一个 min 里，
   * 一条「上周开始、下周截止」的任务会被算成上周就欠着了。
   */
  const startsToday = (x: Task): boolean => {
    const at = startMs(x);
    return at !== null && localDay(new Date(at)) === today;
  };
  const at = when(t);
  return (at !== null && localDay(new Date(at)) <= today) || startsToday(t) || isOpenSpan(t, now);
}

/**
 * 今天该被提起的那几条：**已经过期的 + 今天到期的**，还没了结的。
 *
 * 跟网页「今天」那个去处是同一个意思，但不共用实现——那边在 `web/src/lib`，
 * 服务端引不过来（两个包的 rootDir 约束，见 `mutate.ts` 顶部）。判据简单到
 * 抄一遍比架一座桥便宜，但**两处必须说同一句话**：过期的算今天的，搁置和
 * 放弃的不算。
 *
 * 真正没有日期的（既没 due 也没提醒）不算——它们不属于任何一天，天天念一遍等于
 * 每天都在说同一串话。
 *
 * **但「只设了提醒、没设 due」的算。** 这一条是补的：上面那句「没有 due 的不算」
 * 原来把它们一并排了，而那个理由（「不属于任何一天」）盖不住它们——一条提醒设在
 * 今天的任务恰恰就属于今天，不会天天念。网页那边的「今天」一直收它们
 * （`isInTodayView` 里的 `hasReminderOn` / `isReminderOverdue`，那边有一整段写为什么：
 * 卡片编辑器能清空 `due` 只留提醒）。
 *
 * 实测出来的后果：推送说「今天 3 件事」，而屏幕上的「今天」是 5 件——两个数字
 * 各说各的，而且少报的那一边是通知。
 *
 * 口径写成 `localDay(提醒) <= today`：网页那边是「提醒在今天」或「提醒在更早一天
 * 且已经过了」，两者合起来就是这一行（更早一天的提醒不可能还在未来）。
 */
export function summaryTasks(tasks: Task[], now: Date): Task[] {
  return tasks
    .filter((t) => {
      if (isSettled(t.status)) return false;
      return belongsToToday(t, now);
    })
    // 排序也走 `when`：只有提醒的那几条没有 `due`，原来那行 `Date.parse(a.due!)`
    // 会得到 NaN，比较器返回 NaN 被当成「相等」，顺序就变成了数组原序。
    //
    // **只靠 `startAt` 进来的那几条退回 `startMs`**：它们的 `when()` 是 null，
    // 原来那个 `?? 0` 会把它们当成 1970 年、排到所有过期任务的前面——一条今天
    // 才轮到的任务，在推送里排在欠了三天的前头，说反了。
    .sort((a, b) => (whenOf(a) ?? startOf(a) ?? 0) - (whenOf(b) ?? startOf(b) ?? 0));
}

/** `summaryTasks` 排序用的那个「最早时刻」——`belongsToToday` 里那一份的同款，
 *  抄成两个函数是为了让两处共用同一份判据（注释见那里的 when()）。 */
function whenOf(t: Task): number | null {
  const ms = [t.due, ...(Array.isArray(t.reminders) ? t.reminders.map((r) => r?.at) : [])]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => !Number.isNaN(n));
  return ms.length ? Math.min(...ms) : null;
}

/** `whenOf` 那一份的「开始时刻」孪生体。 */
function startOf(t: Task): number | null {
  const at = t.startAt ? Date.parse(t.startAt) : NaN;
  return Number.isNaN(at) ? null : at;
}

/**
 * 今天一共几件、做完了几件、还剩几件。**桌面端画任务栏进度条要的就是这三个
 * 数**（`win.setProgressBar`）。
 *
 * **三个数一起给，因为只给「还剩几件」画不出进度条**——进度条要的是一个比例，
 * 而「今天一共几件」这个分母只有把了结的也算进去才知道。分母用
 * `belongsToToday` 那同一份判据（不另抄一份日期逻辑），所以：
 *
 * - `total` = 属于今天的（**含已经做完的**）
 * - `done` = 其中真的做完了的（`status === 'done'`；**搁置和放弃不算做完**——
 *   那是「不做」，不是「做完了」）
 * - `remaining` = 还没了结的——**跟网页「今天」那一屏是同一批**（`summaryTasks`）
 */
export function todayProgress(tasks: Task[], now: Date): { total: number; done: number; remaining: number } {
  const today = tasks.filter((t) => belongsToToday(t, now));
  return {
    total: today.length,
    done: today.filter((t) => t.status === 'done').length,
    remaining: today.filter((t) => !isSettled(t.status)).length,
  };
}

/** 这个 `due` 是不是「全天」——**判据是本地零点整**，跟网页那边 `isAllDayIso`
 *  一字不差。按 UTC 读会读错：`2026-08-19T00:00:00+08:00` 存成 Z 是
 *  `16:00:00Z`，用 `getUTCHours()` 判就不是全天了。 */
function isAllDayDue(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime())
    && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/**
 * 「这条已经欠着了」——**跟网页那边 `taskView.ts` 的 `isTaskOverdue` 是同一条
 * 规矩**，分两档：
 *
 * - **落在本地零点的 `due`（全天）按天比**：那个值在这个应用里的意思是
 *   「这一整天」（网页那边 `isAllDay` / `dueOverdue` 上面有整段理由），
 *   那一天过完才算欠着。
 * - **定了具体钟点的按时刻比**：「今天 18:00 交」在 21:00 就是欠着三小时，
 *   屏幕上那张卡也正写着「过期 3 小时」。
 *
 * 原来这一整函数只有按天那一半，于是同一时刻两边报两个数：实测一份真数据上
 * 屏幕那句是「今天要清 6 件，5 件已过期」，推送那句是「…1 件已过期」。
 *
 * **有截止时间的，由截止时间说了算**——不看提醒。网页那边闸门补的账在这儿同样
 * 成立：截止今晚 21:00（没到）、提醒昨天响过的任务，屏幕上一点红都没有，推送
 * 不该说它欠着。没有 due 的才回落到提醒（「卡片编辑器能清空 due 只留提醒」
 * 那一支，上面 `summaryTasks` 的注释里有整段说明）——那时候最早那个提醒就是
 * 它属于的那天，那一档**按天**比，跟网页那边 `isReminderOverdue` 同一条。
 *
 * **导出**只为给 `todayParity.guard.test.ts` 逐条对账：这一句跟网页那个红
 * 标签是同一个问题，两边的实现各一份，光比「两句 prose 里的数」比不到这一层。
 */
export function isTaskOverdue(t: Task, now: Date): boolean {
  // 了结的不算欠着——跟网页那边 `isOverdue` 第一行同一条（那边红标签和计数都
  // 靠它，「已完成」那一列不该满屏飘红）。`summaryTasks` 已经在筛选那一步把
  // 了结的挡了，这一行不改变任何现有输出，要的是「这个函数本身跟那边说同一
  // 句话」——对账测试是拿整张夹具表逐条比的，不该要求它先自己滤一遍。
  if (isSettled(t.status)) return false;
  const due = t.due ? Date.parse(t.due) : NaN;
  if (!Number.isNaN(due)) {
    if (isAllDayDue(t.due as string)) {
      const d = new Date(due);
      // 那一天的**结束**（第二天零点）过了才算。用 `getDate() + 1` 让 Date 自己
      // 处理月末/年末，不做 +86400000 那种会在夏令时差一小时的算术——跟网页同一条。
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() <= now.getTime();
    }
    return due < now.getTime();
  }
  const ms = (Array.isArray(t.reminders) ? t.reminders.map((r) => r?.at) : [])
    .map((x) => (x ? Date.parse(x) : NaN))
    .filter((n) => !Number.isNaN(n));
  return ms.length > 0 && localDay(new Date(Math.min(...ms))) < localDay(now);
}

/** 一条概览的标题和正文。列几条就够——通知不是列表页，滚不动也点不开。 */
export const SUMMARY_MAX = 5;

export function summaryText(tasks: Task[], now: Date): { title: string; body: string } {
  // `t.due!` 那个非空断言去掉了：现在这份列表里有只设了提醒、没有 due 的条目，
  // `Date.parse(null!)` 是 NaN，`localDay(new Date(NaN))` 会抛。走跟筛选同一个时刻取法。
  const doing = tasks.filter((t) => isOpenSpan(t, now));
  const clear = tasks.filter((t) => !isOpenSpan(t, now));
  const overdue = clear.filter((t) => isTaskOverdue(t, now)).length;
  const title = doing.length === 0
    ? (overdue > 0
      // 过期的单独说一句：一句「今天 8 件事」里混着三件昨天就该做完的，
      // 那三件是最该被单独点名的，混在总数里等于把它们藏起来了。
      ? `今天 ${tasks.length} 件事，其中 ${overdue} 件已经过期`
      : `今天 ${tasks.length} 件事`)
    : clear.length === 0
      ? `今天 ${tasks.length} 件事，都在做着`
      : `今天 ${tasks.length} 件事（今天要清 ${clear.length} 件${overdue ? `，${overdue} 件已过期` : ''}），另 ${doing.length} 件在做着`;
  const lines = tasks.slice(0, SUMMARY_MAX).map((t) => `· ${t.title}`);
  if (tasks.length > SUMMARY_MAX) lines.push(`…还有 ${tasks.length - SUMMARY_MAX} 件`);
  return { title, body: lines.join('\n') };
}
