import { dayKey } from './calendar.js';
import { dueOverdue, isAllDayIso } from './taskView.js';
import { endOfDay, URGENT_WITHIN_DAYS } from './agenda.js';

export interface DueChip {
  text: string;
  overdue: boolean;
  /**
   * **快到期**——`due` 在 `URGENT_WITHIN_DAYS` 天内，但还没过期
   * （仿 OmniFocus 的 `Due Soon`，它那边是一个黄圈，介于灰和红之间）。
   *
   * 在这一档之前，到期只有两种样子：过期（红）和其他（一个色）。于是「今天
   * 18:00 截止」和「三个月后截止」在行上除了文字不同之外**长得一模一样**——
   * 文字确实说了「今天」，但一整屏扫过去时，颜色才是眼睛真正在读的东西。
   *
   * `overdue` 和 `soon` **互斥**：已经过期的不叫「快到期」，那是另一句话。
   *
   * 跟 `overdue` 同一条契约：**这里只算时间先后，画不画由调用方决定**
   * （做完/搁置的任务不该painted，判据在 `taskView.ts` 的 `isOverdue` 那一族）。
   */
  soon: boolean;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * 任务行上那颗到期 chip 的文案 + 是否过期。**纯函数，只看 `due`/`now`**——
 * 「做没做完」不归它管：`overdue` 只是时间先后（`due < now`），已完成/搁置
 * 的任务要不要把这个过期标红，是调用方（TaskRow）的决定，复用
 * `taskView.ts` 的 `isOverdue`（那份「done/later 不算过期」的口径已经在
 * 别处测过，这里不重复一遍同样的判断）。
 *
 * **日期一律本地**：「今天」「明天」靠 `calendar.ts` 的 `dayKey` 比对本地
 * 年/月/日，**不用 `toISOString().slice(0,10)`**——那是 UTC 日期，东八区
 * 当地凌晨的任务会被算到前一天，`calendar.ts`/`dueChip.test.ts` 都有专门
 * 守着这条的测试。
 *
 * `due` 解析不了（手改文件、AI 手滑）就当没有，返回 `null`，不抛——
 * `GET /api/tasks` 不校验文件里写的东西，跟 `calendarDays` 同一条教训。
 */
/**
 * 一个时刻落在**哪一天**，说成人话：`今天` / `明天` / `昨天` / `8月21日` /
 * `2025年8月21日`。不带时刻——时刻由调用方决定要不要接在后面。
 *
 * 单独抽出来是因为有两个调用方（行上那颗 chip、卡片上的「截止/提醒」），
 * 而这套「哪天说成什么」的规矩各写一份的话，两种密度下同一条任务会用两种
 * 说法——这正是抽它出来那一次要治的病。
 */
export function dayText(d: Date, now: Date): string {
  const k = dayKey(d);
  if (k === dayKey(now)) return '今天';
  // Date 构造函数自己处理月末溢出（比如 8/31 + 1 天 = 9/1），不用手写进位。
  if (k === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return '明天';
  // 「昨天」。今天和明天都有相对说法，往前一天却直接掉回「8月21日」——而过期
  // 一天恰恰是最常见的那一种，也是最该一眼看出来的那一种。再往前不做「前天」
  // 「N 天前」：那是卡片上那个记号在回答的问题（overdueLabel），这里回答的是
  // 「什么时候」，两个混在一起会在同一张卡上说两遍。
  if (k === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 一个时刻的完整相对写法：`今天 18:00`、`8月21日 17:00`。
 *
 * 卡片上的「截止」「提醒」用它。**在这之前那两处走的是 `taskView.formatWhen`
 * 的绝对格式**（`2026-08-24 18:00`），于是同一条任务在行档下读作「今天
 * 18:00」、切成卡片档就变成「截止 2026-08-24 18:00」，而且卡片上它右边紧挨着
 * 的就是「过期 3 小时」——同一个事实的相对说法和绝对说法并排摆着。
 * `formatWhen` 留给**记录**（专注记录、收件箱条目的时间戳、建议里的新旧对比）：
 * 那些地方要的正是「具体哪一刻」，不是「离现在多远」。
 *
 * 跟 `dueChip` 不一样，**零点照样把时刻写出来**：那边零点当「没定时刻」是给
 * 到期日用的（随口一句「今天」不该显示成定了个零点的闹钟），而提醒定在零点
 * 是一个真的闹钟，吞掉时刻会让它看起来没设。
 */
/**
 * **到期日**那一档的说法：跟 `whenText` 一样带钟点，但**本地零点不写时刻**。
 *
 * 零点在到期日上的意思是「这一整天」（`isAllDay`）。写成「截止 今天 00:00」
 * 有两重错：看着像定了个零点的闹钟，而且跟 `isOverdue`「整天的任务当天不算
 * 过期」对不上——实测见过同一张卡上并排写着「过期 13 小时」和「截止 今天
 * 00:00」。
 *
 * **提醒继续用 `whenText`**：提醒定在零点是一个真的闹钟，吞掉时刻会让它看
 * 起来没设。两个函数的差别就是这一条，所以分开写而不是加个 flag。
 */
export function dueText(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return isAllDayIso(iso) ? dayText(d, now) : whenText(iso, now);
}

export function whenText(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${dayText(d, now)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function dueChip(due: string | null, now: Date): DueChip | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // 判据跟卡片上那个红色「已过期」标签**共用同一个函数**。原来这里是
  // `t < now.getTime()`，是同一条规则的第三份拷贝——全天规则补上之后那份
  // 没跟上，同一条任务会一边不红一边红。
  const overdue = dueOverdue(due, now);
  // 边界跟四象限「紧急」那一列是**同一个数、同一个函数**（`agenda.ts` 的
  // `URGENT_WITHIN_DAYS` + `endOfDay`）。整日边界不是「往后推 N 天的同一时刻」
  // ——三天后深夜到期也该算快到期，理由在 `cells.ts` 的 `urgentBoundary` 上面。
  const soon = !overdue && t <= endOfDay(now, URGENT_WITHIN_DAYS);
  const day = dayText(d, now);

  // 「有时刻就带上」：本地零点当成「没有具体时刻」，只显示「今天」，
  // 不然一条随手记随口写的「今天」会被展示成「今天 00:00」，看着像是
  // 真定了个零点的闹钟。**只有「今天」这一档带时刻**：明天/昨天/某月某日
  // 那几档在行上只回答「哪一天」，这是加时刻之前就是这样的。
  if (day === '今天' && (d.getHours() !== 0 || d.getMinutes() !== 0)) {
    return { text: `今天 ${p2(d.getHours())}:${p2(d.getMinutes())}`, overdue, soon };
  }
  return { text: day, overdue, soon };
}
