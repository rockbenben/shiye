import { describe, it, expect } from 'vitest';
import { THROUGHPUT_DAYS, throughput, throughputLabel } from './throughput.js';
import { task } from '../test-utils.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

/**
 * 「这一周的进出」——完成多少、新进来多少、差多少。
 *
 * 这一族守的是三件事：窗口的**边界**（差一天的两边各归哪一档）、`net` 的
 * **符号方向**（正数到底是债少了还是债多了——写反了整节的意思就反了，而
 * 界面上只是数字前面多了个减号，没人看得出），以及两个数都是 0 时
 * **整节不渲染**（调用方靠空串判断）。
 */
describe('throughput：这一周的进出', () => {
  it('窗口里完成的和新进来的各数各的', () => {
    const tasks = [
      task({ id: 'a', completedAt: daysAgo(1) }),
      task({ id: 'b', completedAt: daysAgo(3) }),
      task({ id: 'c', createdAt: daysAgo(2) }),
    ];
    expect(throughput(tasks, NOW)).toEqual({ done: 2, added: 1, net: 1 });
  });

  /**
   * **`net` 的方向**：`done - added`。正数 = 这周还的比借的多 = 积压变少。
   * 这个符号是这一节唯一要说的事，写反了不会让任何测试变红（除非有一条
   * 专门盯着它，就是这一条）。
   */
  it('net 是完成减新进来——正数说明积压变少了', () => {
    const 追上 = [task({ id: 'a', completedAt: daysAgo(1) }), task({ id: 'b', completedAt: daysAgo(1) })];
    expect(throughput(追上, NOW).net).toBe(2);

    const 落后 = [task({ id: 'a', createdAt: daysAgo(1) }), task({ id: 'b', createdAt: daysAgo(1) })];
    expect(throughput(落后, NOW).net).toBe(-2);
  });

  it('进出刚好持平就是 0——不是正也不是负', () => {
    const tasks = [task({ id: 'a', completedAt: daysAgo(1) }), task({ id: 'b', createdAt: daysAgo(1) })];
    expect(throughput(tasks, NOW).net).toBe(0);
  });

  /**
   * **窗口是滚动的 7 天，边界两边的差一天各归哪一档。** 这是这一节最容易被
   * 顺手改成「本周」的地方，而「本周」在周一早上只有一个小时的样本——那正是
   * `throughput.ts` 顶部专门解释过的坑。
   */
  it.each([
    ['差一天到期（第 6 天）', THROUGHPUT_DAYS - 1, 1],
    ['刚好到期（第 7 天）', THROUGHPUT_DAYS, 1],
    ['刚过期（第 8 天）', THROUGHPUT_DAYS + 1, 0],
  ] as const)('%s 的完成：%s 天前，算进去 %s 条', (_n, days, want) => {
    expect(throughput([task({ id: 'a', completedAt: daysAgo(days) })], NOW).done).toBe(want);
  });

  /**
   * **将来时刻不算。** `data/tasks/` 是手改得到的文件，`completedAt` 写成了
   * 明天完全可能——把它算进「最近 7 天」是报一个还没发生的功劳。
   */
  it('将来的时刻不算——手改文件能造出明天的 completedAt', () => {
    const 明天 = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString();
    expect(throughput([task({ id: 'a', completedAt: 明天, createdAt: 明天 })], NOW))
      .toEqual({ done: 0, added: 0, net: 0 });
  });

  /**
   * 还没做完的任务没有 `completedAt`，但它**是**这周新进来的——这两个数
   * 各自独立，不能因为一条任务「还挂着」就把它从 `added` 里漏掉。
   */
  it('还挂着的任务照样算「新进来」——两个数各数各的，不是同一批任务的两面', () => {
    expect(throughput([task({ id: 'a', createdAt: daysAgo(1) })], NOW)).toEqual({ done: 0, added: 1, net: -1 });
  });

  it('窗口外的老任务一条都不算', () => {
    const 老 = [task({ id: 'a', completedAt: daysAgo(60) }), task({ id: 'b', createdAt: daysAgo(60) })];
    expect(throughput(老, NOW)).toEqual({ done: 0, added: 0, net: 0 });
  });

  it('坏字符串当成没有——不能让一个「上周」把整节算成 NaN', () => {
    const tasks = [
      task({ id: 'a', completedAt: '上周', createdAt: '前天' }),
      task({ id: 'b', completedAt: daysAgo(1) }),
    ];
    expect(throughput(tasks, NOW)).toEqual({ done: 1, added: 0, net: 1 });
  });

  it('空数组是三个 0，不是 NaN', () => {
    expect(throughput([], NOW)).toEqual({ done: 0, added: 0, net: 0 });
  });
});

describe('throughputLabel：这一节那句话', () => {
  it('三个数按「完成 · 新进来 · 净」的顺序拼出来', () => {
    expect(throughputLabel({ done: 8, added: 5, net: 3 })).toBe('完成 8 条 · 新进来 5 条 · 净 +3 条');
  });

  /**
   * **符号本身是这一节要说的那件事**，所以负数用真减号（U+2212）而不是
   * 连字符，而且不靠颜色区分——颜色是扫一眼才知道的，正负号是读出来的。
   */
  it('负数带减号：落后是「净 −3 条」', () => {
    expect(throughputLabel({ done: 2, added: 5, net: -3 })).toContain('净 −3 条');
  });

  it('净 0 条不带符号——「+0」「−0」都是句怪话', () => {
    expect(throughputLabel({ done: 3, added: 3, net: 0 })).toContain('净 0 条');
    expect(throughputLabel({ done: 3, added: 3, net: 0 })).not.toMatch(/[+−]0/);
  });

  /**
   * **两个数都是 0 时整节不渲染。** 调用方判的就是空串——所以这条返回的必须
   * 是 `''`，不能是一句「完成 0 条、新进来 0 条」（那是对一个这周没碰过这个
   * 应用的人每天说的一句废话）。
   */
  it('两个数都是 0 时是空串——调用方据此整节不渲染', () => {
    expect(throughputLabel({ done: 0, added: 0, net: 0 })).toBe('');
  });

  /** 只有一个数也是 0 时**照样要说**：完成 0 条、新进来 5 条是这一节最该
   *  说出来的那种情况（这周一条没做完）。 */
  it('只有一个数是 0 时照说——「完成 0 条 · 新进来 5 条」正是该报的', () => {
    expect(throughputLabel({ done: 0, added: 5, net: -5 })).toBe('完成 0 条 · 新进来 5 条 · 净 −5 条');
  });

  /**
   * **文案里不写天数。** 标题（「这一周的进出」）里没有数字，所以
   * `THROUGHPUT_DAYS` 改成 14 也不会让这句话变成假的；天数写进 `title`
   * 里现算。这一条守的是「别把 7 硬编码进这句话」。
   */
  it('这句话里没有天数——窗口长短改了它不会变成假的', () => {
    expect(throughputLabel({ done: 1, added: 0, net: 1 })).not.toContain(String(THROUGHPUT_DAYS));
  });
});
