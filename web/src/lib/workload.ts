import type { Task } from '../types.js';
import { formatMinutes } from './focusStats.js';
import { countStale, isMultiDayToday } from './taskView.js';

/**
 * 「这一批任务排了多少活」——给「今天」头上那行 `N 条` 补一句预计时长。
 *
 * （这儿原来写着「仿滴答清单：它在『今天』上方报当天排了几个番茄」。
 * **语料里查不到这个汇总**：《常见问题》 只说「预计番茄/时长」
 * 能「在任务列表页以及任务详情页查看」，那是**每条任务各显示各的**，不是
 * 当天求和。这个函数的理由在下面那两段，本来就不靠这句对比。）
 *
 * **这条数字回答的是「今天排得下吗」。** 一天七条任务，每条看着都不大，加起来
 * 六个小时——那件事只有在有人把它加起来的时候才看得见，而这个应用一直有
 * `estimateMinutes`（编辑表单里填、卡片上显示「已专注 50 分钟 / 预计 45 分钟」），
 * 却从来没有在任何地方求过和。
 *
 * **没估过的那几条要说出来，这是这个函数存在的一半理由。** 七条里只有两条估
 * 过、加起来 45 分钟，光写「预计 45 分钟」会让人以为今天很轻松——那比不写更糟。
 * 所以第二句写清楚还有几条没估过：这个数字是**下界**，不是当天的总量。
 *
 * 一条都没估过时**整句不出**（返回空串）：一个「预计 0 分钟」是句假话，而
 * 「7 条都没估过」对一个从来不填估计的人来说是每天都在的一句废话。
 *
 * 纯函数，不读时钟：进来的是哪一批任务由调用方决定。**「今天」传进来的不是整排，
 * 是「今天要清的那几条」**——跨天的那一条上面那个 `estimateMinutes` 是**整件事**的
 * 时长（「这个模块要 6 小时」），不是今天那一段的，把它加进「今天排得下吗」那个
 * 数字会虚高。见下面 `todayMetaLabel`：那一行分两档，各数各的。
 */
export function workloadLabel(tasks: Task[]): string {
  let estimated = 0;
  let noEstimate = 0;
  for (const t of tasks) {
    // 磁盘上那份是手改的，`estimateMinutes` 可能是字符串/负数/NaN——一律
    // 当成「没估过」，跟 `focusStats.ts` 的 `validAt` 同一条判据。
    const m = t.estimateMinutes;
    if (typeof m === 'number' && Number.isFinite(m) && m > 0) estimated += m;
    else noEstimate += 1;
  }
  if (estimated === 0) return '';
  const rest = noEstimate > 0 ? `，另有 ${noEstimate} 条没估过` : '';
  return `预计 ${formatMinutes(estimated)}${rest}`;
}

/**
 * 「今天」头上那一整行。`12 条（9 条已过期） · 预计 4 小时 30 分，另有 3 条没估过`
 *
 * **中间那一截是这一轮补的**。「今天」这一排是**平的**——过期的和今天要做的混在
 * 一起，那是一次有意的取舍（顺序是他自己拖出来的，一分组处处打架，理由写在
 * `TodayView` 里那段长注释）。代价是「今天 12 条」读起来像「我今天安排了 12 件
 * 事」，而其中九条其实是欠着的债。原来的补偿只有卡片上各自那句「过期 3 天」——
 * 一条一条看得出来，**一眼看不出这一天的形状**。
 *
 * 全都过期时换一句「都已经过期」，不写「9 条（9 条已过期）」——同一个数字报两遍
 * 是句废话。
 *
 * ## 第二档：「今天要清 N 条，另 M 条在做着」
 *
 * 跨天的那几条（`startAt` 到 `due` 那段区间走到中间）现在每一天都在这一排里，
 * 于是「12 条」这个数多了一类**不是今天要干完的活**：那条「第 3 天 · 共 8 天」
 * 跟「今天必须清掉的一条」并排数进同一个数，等于把进度和欠账混报。所以那一排
 * 分两档报：**今天要清的**（含欠着的债）和**在做着的**。
 *
 * 没有跨天的那几条时**整句和原来一字不差**——这一档只在真的有两档时才出现，
 * 「12 条（今天要清 12 条）」是给不需要这句话的日子每天多印六个字。
 *
 * 两档不会重叠：在做着的那几条必然还没到截止那天（区间不含截止那天，见
 * `taskView.ts` 的 `spanOf`），而过期只看 `due`，所以「已过期」永远数在
 * 今天要清的那一档里。
 *
 * 口径复用 `countStale`（`isTaskOverdue`），跟卡片上那个红标签、跟「可以让 AI
 * 回顾一遍」那句提示是同一条判据，不新造一个「算不算过期」。
 */
export function todayMetaLabel(tasks: Task[], now: Date): string {
  const n = tasks.length;
  const doing = tasks.filter((t) => isMultiDayToday(t, now));
  const clear = tasks.filter((t) => !isMultiDayToday(t, now));
  const stale = countStale(clear, now);
  const head = doing.length === 0
    ? (stale === 0 ? `${n} 条`
      : stale === n ? `${n} 条，都已经过期`
        : `${n} 条（${stale} 条已过期）`)
    : clear.length === 0
      ? `${n} 条，都在做着`
      : `${n} 条（今天要清 ${clear.length} 条${stale ? `，${stale} 条已过期` : ''}），另 ${doing.length} 条在做着`;
  const load = workloadLabel(clear);
  return load ? `${head} · ${load}` : head;
}
