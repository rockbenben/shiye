import { describe, it, expect } from 'vitest';
import { WEEKDAY_SHORT, weekdayFull, weekdayHeader } from './weekday.js';

/**
 * **这一族守的是「加一档不用改代码」。**
 *
 * 在 `weekdayHeader` 之前，表头顺序是这么算的：
 * `weekStart === 0 ? [WEEKDAYS[6]!, ...WEEKDAYS.slice(0, 6)] : WEEKDAYS`——
 * 一句只认得两档的写法，抄在两个文件里。加进周六那一档时它不报错，只会把
 * 周六静默当成周一，两处一起错。下面三条把三档都钉死。
 */
describe('weekdayHeader：表头从哪个星期几排起', () => {
  it.each([
    [1, ['一', '二', '三', '四', '五', '六', '日']],
    [0, ['日', '一', '二', '三', '四', '五', '六']],
    [6, ['六', '日', '一', '二', '三', '四', '五']],
  ] as const)('weekStart=%s', (ws, want) => {
    expect(weekdayHeader(ws)).toEqual(want);
  });

  it('三档互不相同——否则上面那族可能是「一律返回同一份」在相等', () => {
    const all = [weekdayHeader(0), weekdayHeader(1), weekdayHeader(6)].map((x) => x.join(''));
    expect(new Set(all).size).toBe(3);
  });

  it('每一档都是七天的一个轮转：不重不漏', () => {
    for (const ws of [0, 1, 6] as const) {
      expect(new Set(weekdayHeader(ws)).size).toBe(7);
      expect([...weekdayHeader(ws)].sort()).toEqual([...WEEKDAY_SHORT].sort());
    }
  });
});

describe('WEEKDAY_SHORT / weekdayFull：按 getDay() 索引', () => {
  it('0 是周日、6 是周六——这份表的索引口径就是 Date#getDay()', () => {
    expect(WEEKDAY_SHORT[0]).toBe('日');
    expect(WEEKDAY_SHORT[6]).toBe('六');
  });

  it.each([
    ['2026-08-23', '周日'],
    ['2026-08-24', '周一'],
    ['2026-08-26', '周三'],
    ['2026-08-22', '周六'],
  ])('%s → %s', (d, want) => {
    expect(weekdayFull(new Date(`${d}T00:00:00`).getDay())).toBe(want);
  });
});
