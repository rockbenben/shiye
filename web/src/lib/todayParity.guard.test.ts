import { describe, it, expect } from 'vitest';
import { isInTodayView, isSettled as webIsSettled, STATUSES } from './taskView.js';
import { summaryTasks } from '../../../server/src/dailySummary.js';
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
  { name: '今天开始、下周截止', t: task({ id: 'n', due: at(9, 31), startAt: at(9) }) },
  { name: '今天开始但已完成', t: task({ id: 'o', due: null, startAt: at(9), status: 'done' }) },
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
