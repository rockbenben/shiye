import { describe, it, expect } from 'vitest';
import { isInTodayView, isSettled as webIsSettled, isTaskOverdue as webIsTaskOverdue, STATUSES } from './taskView.js';
import { todayMetaLabel } from './workload.js';
import { isTaskOverdue as srvIsTaskOverdue, summaryTasks, summaryText } from '../../../server/src/dailySummary.js';
import { isSettled as srvIsSettled } from '../../../server/src/task.js';
import { task } from '../test-utils.js';
import type { Task } from '../types.js';

/**
 * **网页的「今天」和服务端的每日概览，收的必须是同一批任务。**
 *
 * 两边不共用实现是有理由的：判据在 `web/src/lib`，服务端引不过来（两个包的
 * rootDir 约束，见 `server/src/mutate.ts` 顶部），而这条判据简单到「抄一遍比架
 * 一座桥便宜」。`dailySummary.ts` 的注释里写着这个决定，也写着它的代价：
 * **两处必须说同一句话**。
 *
 * 而只靠那句话是守不住的——它已经飘了一次：`summaryTasks` 要求 `due` 必须存在，
 * 于是「只设了提醒、没设 due」的任务（卡片编辑器能清空 `due` 只留提醒，网页的
 * 「今天」一直收它们）在推送里整类消失。后果是**推送说「今天 3 件事」、屏幕上
 * 却是 5 件**，而且少报的那一边是通知——这个仓库对「两个数字各说各的」最敏感。
 *
 * 所以把那句话变成断言：一批铺开的夹具，逐条比两边的答案。
 *
 * ## 为什么跨包 import 在这里是可以的
 *
 * 这是**测试**，不是产品代码——`ProposalNote.test.tsx` 早就这么引 `PROPOSABLE`
 * 了（同一个理由：守卫要同时看两边）。产品代码那条 rootDir 约束不受影响。
 */

/** 概览的触发时刻是用户自己设的（`dailySummaryAt`），不一定是早上——所以拿晚上八点做
 *  基准：如果两边对「今天 09:00 那条算不算」有分歧，这个时刻才照得出来。 */
const NOW = new Date(2026, 7, 26, 20, 0, 0);
const at = (h: number, day = 26) => new Date(2026, 7, day, h, 0, 0).toISOString();

/** 每一条都是一种「属于哪一天」的表达方式，正反两面都要有。 */
const CASES: Array<{ name: string; t: Task }> = [
  { name: '今天 09:00 到期', t: task({ id: 'a', due: at(9) }) },
  { name: '今天 23:00 到期（还没到）', t: task({ id: 'a2', due: at(23) }) },
  { name: '今天零点到期（全天）', t: task({ id: 'a3', due: at(0) }) },
  { name: '昨天到期', t: task({ id: 'b', due: at(9, 25) }) },
  { name: '只设了今天的提醒、没有 due', t: task({ id: 'c', due: null, reminders: [{ at: at(21), firedAt: null }] }) },
  { name: '提醒昨天已经响过、没有 due', t: task({ id: 'd', due: null, reminders: [{ at: at(9, 25), firedAt: at(9, 25) }] }) },
  { name: '既没 due 也没提醒', t: task({ id: 'f', due: null }) },
  { name: '明天到期', t: task({ id: 'g', due: at(9, 27) }) },
  { name: '明天的提醒、没有 due', t: task({ id: 'g2', due: null, reminders: [{ at: at(9, 27), firedAt: null }] }) },
  { name: '今天到期但已完成', t: task({ id: 'h', due: at(9), status: 'done' }) },
  { name: '今天到期但已搁置', t: task({ id: 'i', due: at(9), status: 'later' }) },
  { name: '今天到期但已放弃', t: task({ id: 'j', due: at(9), status: 'abandoned' }) },
  // 「今天开始」那一支。加这五条之前，这一族对 `startAt` 是**空转**的——
  // 两边同时不认它，也「一致」。
  { name: '今天开始、没有 due', t: task({ id: 'k', due: null, startAt: at(9) }) },
  { name: '今天晚些开始、还没到点', t: task({ id: 'k2', due: null, startAt: at(23) }) },
  { name: '明天开始', t: task({ id: 'l', due: null, startAt: at(9, 27) }) },
  { name: '昨天开始、没有 due——不该永远赖在今天', t: task({ id: 'm', due: null, startAt: at(9, 25) }) },
  { name: '今天开始、下周截止（跨天区间的第一天）', t: task({ id: 'n', due: at(9, 31), startAt: at(9) }) },
  { name: '今天开始但已完成', t: task({ id: 'o', due: null, startAt: at(9), status: 'done' }) },
  // 跨天区间那一族。加这几条之前 `startAt` 那几条对「区间中间的那一天」是空转的：
  // 每条都落在开始或截止那一格上，两边同时只认「就那一天」，也「一致」。
  { name: '区间正中间（24 号开始、31 号截止，今天 26 号）', t: task({ id: 'p', due: at(9, 31), startAt: at(9, 24) }) },
  { name: '区间里但已完成', t: task({ id: 'p2', due: at(9, 31), startAt: at(9, 24), status: 'done' }) },
  { name: '区间还没开始（28 号才开始）', t: task({ id: 'q', due: at(9, 31), startAt: at(9, 28) }) },
  { name: '跨月区间、今天还没到（8-29 开始、9-02 截止）', t: task({ id: 'q2', due: new Date(2026, 8, 2, 9, 0).toISOString(), startAt: at(9, 29) }) },
  { name: '今天开始、明天截止——只有一天可做，不算跨天，靠 startAt 进来', t: task({ id: 'q3', due: at(9, 27), startAt: at(9) }) },
];

describe('「今天」的口径：网页 ≡ 每日概览', () => {
  it.each(CASES.map((c) => [c.name, c.t] as const))('%s：两边给同一个答案', (_name, t) => {
    const web = isInTodayView(t, NOW);
    const srv = summaryTasks([t], NOW).length > 0;
    expect(srv, web ? '网页的「今天」收它，概览漏了' : '概览收了它，网页的「今天」不收').toBe(web);
  });

  it('夹具正反两面都有——否则上面那一族可能是「两边都恒不收」在相等', () => {
    const yes = CASES.filter((c) => isInTodayView(c.t, NOW)).length;
    expect(yes, '没有一条被收进「今天」，这一族测不出任何东西').toBeGreaterThan(3);
    expect(CASES.length - yes, '没有一条被排除，这一族同样测不出东西').toBeGreaterThan(3);
  });
});


/**
 * **两句 prose 报的必须是同四个数。**
 *
 * 屏幕头上那行（`workload.ts`）和推送那句（`dailySummary.ts`）各写各的字面量，
 * 上面那一族只保证「收的是同一批任务」——收得一样、数说得不一样，照样是
 * 「推送说 3 件、屏幕上 5 件」那个形状，只是从成员资格漂移换成了措辞漂移。
 *
 * 所以这里把两边各自的散文抠成 `{ 总数, 要清, 在做着, 已过期 }` 四元组再比。
 * **两个解析都断言成功**：解析器静默返回 null 的话，这一族就变成「两个 null
 * 相等」，将来任何一边改文案都会把守卫悄悄摘掉而不是报红——同 `CONTRIBUTING`
 * 里那条「闸要自带解析器没吞掉形状的守卫」。
 */
describe('「今天几件」：屏幕那一行 ≡ 每日概览那句', () => {
  /** 网页那句用「条」、推送那句用「件」，两种量词分开抠。总数取**第一个**
   *  「数字 + 量词」：网页那句以它开头，推送那句开头多两个字（「今天 8 件
   *  事」），所以不锚行首——两边的第一个都还是总数。 */
  const parse = (s: string, q: string) => {
    const total = new RegExp(`(\\d+) ${q}`).exec(s)?.[1];
    if (total === undefined) return null;
    const doing = new RegExp(`另 (\\d+) ${q}在做着`).exec(s)?.[1]
      ?? (/都在做着/.test(s) ? total : undefined);
    const clear = new RegExp(`今天要清 (\\d+) ${q}`).exec(s)?.[1]
      ?? (doing === undefined ? total : String(Number(total) - Number(doing)));
    // 「已过期」和「已经过期」两种写法都要认：网页那句用前者，推送那句不分档时
    // 用的是后者。认不出来就退回 0——那会让「两边都是 0」假相等，所以这一族
    // 的夹具必须有一面真的有过期数（下面那条断言盯着）。
    const stale = /都\s*已经?过期/.test(s) ? Number(total)
      : +(new RegExp(`(\\d+) ${q}已(?:经)?过期`).exec(s)?.[1] ?? 0);
    return { total: +total, clear: +clear, doing: +(doing ?? 0), stale };
  };

  const PAIRS: Array<{ name: string; tasks: Task[] }> = [
    { name: '没有跨天的', tasks: CASES.filter((c) => isInTodayView(c.t, NOW)).map((c) => c.t) },
    { name: '两档都有', tasks: [task({ id: 'x', due: at(9, 31), startAt: at(9, 24) }), task({ id: 'y', due: at(9) })] },
    { name: '全在做着', tasks: [task({ id: 'x', due: at(9, 31), startAt: at(9, 24) }), task({ id: 'z', due: at(9, 31), startAt: at(9, 20) })] },
    { name: '要清的全过期', tasks: [task({ id: 'y', due: at(9, 25) }), task({ id: 'x', due: at(9, 31), startAt: at(9, 24) })] },
  ];

  it.each(PAIRS.map((p) => [p.name, p.tasks] as const))('%s：两边报的同四个数', (name, tasks) => {
    const web = parse(todayMetaLabel(tasks, NOW), '条');
    const push = parse(summaryText(summaryTasks(tasks, NOW), NOW).title, '件');
    expect(web, `网页那句解析不出来，改动文案时这条守卫会先瞎：${todayMetaLabel(tasks, NOW)}`).not.toBeNull();
    expect(push, `推送那句解析不出来，同上：${summaryText(summaryTasks(tasks, NOW), NOW).title}`).not.toBeNull();
    expect(push, `「${name}」这一面两边数不一样`).toEqual(web);
    expect(web!.clear + web!.doing, `「${name}」两档加起来不等于总数`).toBe(web!.total);
  });

  /**
   * 四个数各自都得有一面**非零**——不然是「两边都是 0」在相等，这一族什么都
   * 没盯住。上一段那个「已过期」的解析就是为这条补的：加它之前这一族比的是
   * 三个数，而真数据上分叉的恰好是第四个。
   */
  it('夹具铺满了四个数：每一面都有非零的读数', () => {
    const seen = PAIRS.flatMap(({ tasks }) => {
      const w = parse(todayMetaLabel(tasks, NOW), '条');
      const p = parse(summaryText(summaryTasks(tasks, NOW), NOW).title, '件');
      expect(p, `某一面两边数不一样`).toEqual(w);
      return [w!];
    });
    for (const key of ['total', 'clear', 'doing', 'stale'] as const) {
      expect(seen.some((r) => r[key] > 0), `没有任何一面出现非零的 ${key}，那个键比不出东西`).toBe(true);
    }
  });
});


/**
 * **「这条欠没欠着」：网页那个红标签 ≡ 每日概览那句里「其中 N 件已经过期」的数。**
 *
 * 上面那一族比的是「收的是同一批任务」，比不到「同一批任务里算出同一个过期数」。
 * 这两份实现真的分叉过一次，是拿真数据跑出来才看见的：网页那边分两档（落在本地
 * 零点的按天比、定了钟点的按时刻比），服务端只抄了按天那一半——于是同一时刻
 * 屏幕上写「今天要清 6 条，5 条已过期」，推送写「…1 件已过期」。
 *
 * 夹具表里那三条正好把这一族照全：今天 09:00（时刻已过）、今天 23:00（还没到）、
 * 今天零点（全天，那一天还没过完）——三份答案两两不同，少一档判据就红一条。
 */
describe('「已经欠着了」：网页的红标签 ≡ 每日概览那句', () => {
  it.each(CASES.map((c) => [c.name, c.t] as const))('%s：两边给同一个答案', (_name, t) => {
    const web = webIsTaskOverdue(t, NOW);
    expect(srvIsTaskOverdue(t, NOW), web ? '网页标红，概览不认它欠着' : '概览算它欠着，网页没标红').toBe(web);
  });

  it('正反两面都有——否则上面那一族可能是「两边都恒假」在相等', () => {
    const yes = CASES.filter((c) => webIsTaskOverdue(c.t, NOW)).length;
    expect(yes, '没有一条算欠着，这一族测不出任何东西').toBeGreaterThan(0);
    expect(CASES.length - yes, '没有一条不算欠着，同上').toBeGreaterThan(0);
  });
});


/**
 * **两份 `isSettled` 必须认同一批状态。**
 *
 * 它是上面那一族的地基：`isInTodayView` 和 `summaryTasks` 第一行都在问「人是不是
 * 已经对这条做过判断了」。两个包各一份（`server/src/task.ts` 收 `Status`、
 * `web/src/lib/taskView.ts` 收 `Task`），两边的注释都写着「靠 `types.sync.test.ts` 盯着
 * `Status` 本身不飘」——**但那只保证类型同步，不保证两份实现认同一个子集**：
 * 加第五种状态时只改一边，两边照样编译得过，而后果是「一条已经关闭的任务在服务端
 * 不发提醒、在网页上照样标红」这类静默分叉。
 *
 * 遍历 `STATUSES` 而不是手写四个值：那份名单自己就是从 `Status` 来的单一出处，
 * 加了新状态这一族自动覆盖得到。
 */
describe('isSettled：服务端 ≡ 网页', () => {
  it.each(STATUSES)('%s：两边给同一个答案', (status) => {
    expect(webIsSettled(task({ status })), `状态 ${status} 两边不一致`).toBe(srvIsSettled(status));
  });

  it('正反两面都有——否则上面那一族可能是「两边都恒真/恒假」在相等', () => {
    const settled = STATUSES.filter((s) => srvIsSettled(s)).length;
    expect(settled).toBeGreaterThan(0);
    expect(STATUSES.length - settled).toBeGreaterThan(0);
  });
});
