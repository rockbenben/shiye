import type { Task } from '../types.js';
import { formatMinutes } from './focusStats.js';
import { countStale } from './taskView.js';

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
 * 纯函数，不读时钟：进来的是哪一批任务由调用方决定（「今天」传的就是它列表里
 * 那几条，跟旁边的 `N 条` 数的是同一批，两个数字不会各说各的）。
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
 * 口径复用 `countStale`（`isTaskOverdue`），跟卡片上那个红标签、跟「可以让 AI
 * 回顾一遍」那句提示是同一条判据，不新造一个「算不算过期」。
 */
export function todayMetaLabel(tasks: Task[], now: Date): string {
  const n = tasks.length;
  const stale = countStale(tasks, now);
  const head = stale === 0 ? `${n} 条`
    : stale === n ? `${n} 条，都已经过期`
      : `${n} 条（${stale} 条已过期）`;
  const load = workloadLabel(tasks);
  return load ? `${head} · ${load}` : head;
}
