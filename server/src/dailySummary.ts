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
  const today = localDay(now);
  /** 这条任务属于哪一天：取 due 和所有提醒里最早的那个时刻。都没有就是 `null`。 */
  const when = (t: Task): number | null => {
    const ms = [t.due, ...(Array.isArray(t.reminders) ? t.reminders.map((r) => r?.at) : [])]
      .map((x) => (x ? Date.parse(x) : NaN))
      .filter((n) => !Number.isNaN(n));
    return ms.length ? Math.min(...ms) : null;
  };
  /** 解得出来的 `startAt` 时刻，没有/解不出来就是 `null`。 */
  const startMs = (t: Task): number | null => {
    const at = t.startAt ? Date.parse(t.startAt) : NaN;
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
  const startsToday = (t: Task): boolean => {
    const at = startMs(t);
    return at !== null && localDay(new Date(at)) === today;
  };
  return tasks
    .filter((t) => {
      if (isSettled(t.status)) return false;
      const at = when(t);
      return (at !== null && localDay(new Date(at)) <= today) || startsToday(t);
    })
    // 排序也走 `when`：只有提醒的那几条没有 `due`，原来那行 `Date.parse(a.due!)`
    // 会得到 NaN，比较器返回 NaN 被当成「相等」，顺序就变成了数组原序。
    //
    // **只靠 `startAt` 进来的那几条退回 `startMs`**：它们的 `when()` 是 null，
    // 原来那个 `?? 0` 会把它们当成 1970 年、排到所有过期任务的前面——一条今天
    // 才轮到的任务，在推送里排在欠了三天的前头，说反了。
    .sort((a, b) => (when(a) ?? startMs(a) ?? 0) - (when(b) ?? startMs(b) ?? 0));
}

/**
 * 「这条已经欠着了」：它属于的那一天在今天之前。
 *
 * **有截止时间的，由截止时间说了算**——不看提醒。这跟网页那边
 * `taskView.ts` 的 `isTaskOverdue` 是同一条规矩（那边写着为什么），两处
 * 必须说同一句话，这个文件顶上那段注释也是这么要求的。
 *
 * 原来这里取的是「due 和所有提醒里**最早**那个」。一条真实数据上它会说错：
 * 截止今晚 21:00（没到），提醒昨天 10:00 响过、今天 15:00 还没到——最早的是
 * 昨天，于是推送里写「其中 1 件已经过期」，而屏幕上那条任务一点问题都没有。
 * 提醒本来就是提前叫你去做那件事的，它响过不该反过来把任务判成欠着。
 *
 * 没有 due 的才回落到提醒（这是「卡片编辑器能清空 due 只留提醒」那一支，
 * 上面 `summaryTasks` 的注释里有整段说明）——那时候最早那个提醒就是它属于的那天。
 */
function isOverdueDay(t: Task, now: Date): boolean {
  const due = t.due ? Date.parse(t.due) : NaN;
  if (!Number.isNaN(due)) return localDay(new Date(due)) < localDay(now);
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
  const overdue = tasks.filter((t) => isOverdueDay(t, now)).length;
  const title = overdue > 0
    // 过期的单独说一句：一句「今天 8 件事」里混着三件昨天就该做完的，
    // 那三件是最该被单独点名的，混在总数里等于把它们藏起来了。
    ? `今天 ${tasks.length} 件事，其中 ${overdue} 件已经过期`
    : `今天 ${tasks.length} 件事`;
  const lines = tasks.slice(0, SUMMARY_MAX).map((t) => `· ${t.title}`);
  if (tasks.length > SUMMARY_MAX) lines.push(`…还有 ${tasks.length - SUMMARY_MAX} 件`);
  return { title, body: lines.join('\n') };
}
