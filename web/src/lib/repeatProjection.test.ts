import { describe, it, expect } from 'vitest';
import { futureOccurrences } from './repeatProjection.js';
import { task } from '../test-utils.js';
import type { Repeat, Task } from '../types.js';

const local = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

const R = (o: Partial<Repeat> = {}): Repeat =>
  ({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...o });

const days = (ts: ReturnType<typeof futureOccurrences>) =>
  ts.map((g) => new Date(g.at).getDate());

/** 2026-08-17 是周一。 */
const FROM = local(2026, 8, 17);
const TO = local(2026, 9, 13, 23);

describe('futureOccurrences：不推演的三种情况', () => {
  it('没有 repeat', () => {
    expect(futureOccurrences(task({ due: iso(2026, 8, 17, 9) }), FROM, TO)).toEqual([]);
  });

  it('没有 due——nextOccurrence 要一个起点，没有 due 就没有起点', () => {
    expect(futureOccurrences(task({ repeat: R(), due: null }), FROM, TO)).toEqual([]);
  });

  it('已完成 / 已搁置——完成那一刻服务端已经把下一条真的建出来了，再推一遍是画两遍', () => {
    const base: Partial<Task> = { repeat: R(), due: iso(2026, 8, 17, 9) };
    expect(futureOccurrences(task({ ...base, status: 'done' }), FROM, TO)).toEqual([]);
    expect(futureOccurrences(task({ ...base, status: 'later' }), FROM, TO)).toEqual([]);
  });
});

describe('futureOccurrences：推演', () => {
  it('每周一：一个月窗口里推出后面几个周一', () => {
    const t = task({ id: 'w', title: '开例会', repeat: R({ every: 'week', weekdays: [1] }), due: iso(2026, 8, 17, 9) });
    // 起点 8/17 本身不推（它是已经存在的那一条），往后是 24、31、9/7
    expect(days(futureOccurrences(t, FROM, TO))).toEqual([24, 31, 7]);
  });

  it('推出来的带上是从哪条任务来的、叫什么——界面要拿它做 key 和标题', () => {
    const t = task({ id: 'w', title: '开例会', repeat: R({ every: 'week', weekdays: [1] }), due: iso(2026, 8, 17, 9) });
    expect(futureOccurrences(t, FROM, TO)[0]).toMatchObject({ taskId: 'w', title: '开例会' });
  });

  it('原来几点还是几点', () => {
    const t = task({ repeat: R({ every: 'week', weekdays: [1] }), due: iso(2026, 8, 17, 9) });
    expect(new Date(futureOccurrences(t, FROM, TO)[0].at).getHours()).toBe(9);
  });

  it('窗口之外的不推——翻页时重算，不是一次算三年', () => {
    const t = task({ repeat: R({ every: 'day' }), due: iso(2026, 8, 17, 9) });
    const got = futureOccurrences(t, FROM, local(2026, 8, 20, 23));
    expect(days(got)).toEqual([18, 19, 20]);
  });

  it('起点在窗口之前也能推——一条上个月设的「每周一」，这个月照样铺得出来', () => {
    const t = task({ repeat: R({ every: 'week', weekdays: [1] }), due: iso(2026, 7, 6, 9) });
    expect(days(futureOccurrences(t, local(2026, 8, 17), local(2026, 8, 31, 23)))).toEqual([17, 24, 31]);
  });

  it('until 到了就停', () => {
    const t = task({ repeat: R({ every: 'day', until: iso(2026, 8, 19, 23) }), due: iso(2026, 8, 17, 9) });
    expect(days(futureOccurrences(t, FROM, TO))).toEqual([18, 19]);
  });

  /**
   * **预算按「走了几步」扣，不按「画了几个」扣。**
   *
   * 用 `out.length` 计数的话，窗口之前那些步走过却不扣预算——于是每翻一页都
   * 重新给满额度。实测复现过：`count: 2`、9/3 起每天一次，本月画 2 个、下月又
   * 画 2 个、再下月还画 2 个，后面那些是第 30、31 次，永远不会发生。一条快结束
   * 的重复任务会在**所有**未来的日历页上留下幽灵。
   */
  it('翻到后面的月份不该重新给满额度——总共只有 count 次', () => {
    const t = task({ repeat: R({ every: 'day', count: 2 }), due: iso(2026, 9, 3, 9) });
    const 本月 = futureOccurrences(t, local(2026, 9, 1), local(2026, 9, 30, 23));
    const 下月 = futureOccurrences(t, local(2026, 10, 1), local(2026, 10, 31, 23));
    const 再下月 = futureOccurrences(t, local(2026, 11, 1), local(2026, 11, 30, 23));
    expect(本月.length, '本月该画满这 2 次').toBe(2);
    expect(下月, '下月不该再有——那两次已经在 9 月用完了').toEqual([]);
    expect(再下月).toEqual([]);
  });
  it('count（还要再重复几次）是上限——不能在屏幕上凭空多出一次永远不会发生的会', () => {
    const t = task({ repeat: R({ every: 'day', count: 2 }), due: iso(2026, 8, 17, 9) });
    expect(days(futureOccurrences(t, FROM, TO))).toEqual([18, 19]);
  });

  it('艾宾浩斯的步数跟着往前走——不递增的话推出来是一串等距的「第一次间隔」', () => {
    const t = task({ repeat: R({ every: 'ebbinghaus', step: 0, monthDay: null }), due: iso(2026, 8, 17, 9) });
    // 间隔表 1/2/3/8：从 8/17 起是 18、20、23、31
    expect(days(futureOccurrences(t, FROM, TO))).toEqual([18, 20, 23, 31]);
  });

  it('due 坏掉（手改文件写了「下周三」）不炸，也不推', () => {
    expect(futureOccurrences(task({ repeat: R(), due: '下周三' }), FROM, TO)).toEqual([]);
  });
});
