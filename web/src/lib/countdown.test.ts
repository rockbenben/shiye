import { describe, it, expect } from 'vitest';
import {
  countdownState, countdownsInRange, daysBetween, nextLunarYearly, nextYearly, parseDay, sortCountdowns,
} from './countdown.js';
import { dayKey } from './calendar.js';
import type { Countdown } from '../types.js';

const NOW = new Date(2026, 7, 19, 15);   // 2026-08-19 下午三点

const cd = (over: Partial<Countdown> = {}): Countdown => ({
  id: 'c', title: '考试', date: '2026-09-01', yearly: false, lunar: false,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('parseDay', () => {
  it('YYYY-MM-DD → 本地那天的零点', () => {
    const d = parseDay('2026-09-01')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 1, 0]);
  });

  it('形状不对返回 null', () => {
    for (const bad of ['', '2026/09/01', '2026-9-1', '下周三', '2026-09-01T00:00:00Z']) {
      expect(parseDay(bad), bad).toBeNull();
    }
  });

  it('不存在的日子返回 null——2026-02-30 会溢出成 3 月 2 日，显示成一个用户没输入过的日期', () => {
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('2026-13-01')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('**按日历日算，不按毫秒差**——今晚 23:00 到明早 01:00 只隔两小时，但那是 1 天', () => {
    expect(daysBetween(new Date(2026, 7, 19, 23), new Date(2026, 7, 20, 1))).toBe(1);
  });

  it('同一天是 0，不管几点', () => {
    expect(daysBetween(new Date(2026, 7, 19, 1), new Date(2026, 7, 19, 23))).toBe(0);
  });

  it('过去的是负数', () => {
    expect(daysBetween(new Date(2026, 7, 19), new Date(2026, 7, 17))).toBe(-2);
  });
});

describe('nextYearly', () => {
  it('今年那天还没到就是今年', () => {
    expect(nextYearly(8, 1, NOW).getFullYear()).toBe(2026);   // 9 月 1 日
  });

  it('今年那天已经过去了就是明年', () => {
    const d = nextYearly(0, 1, NOW);                          // 1 月 1 日
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2027, 0, 1]);
  });

  it('今天就是那天：算今年（还有 0 天），不跳到明年', () => {
    expect(daysBetween(NOW, nextYearly(7, 19, NOW))).toBe(0);
  });

  it('2 月 29 日在平年落到 2 月 28——不能溢出成三月一日，那样「2 月的纪念日」跑到三月去了', () => {
    const d = nextYearly(1, 29, new Date(2027, 0, 5));        // 2027 不是闰年
    expect([d.getMonth(), d.getDate()]).toEqual([1, 28]);
  });

  it('闰年照常落在 2 月 29', () => {
    const d = nextYearly(1, 29, new Date(2028, 0, 5));        // 2028 是闰年
    expect([d.getMonth(), d.getDate()]).toEqual([1, 29]);
  });
});

describe('countdownState', () => {
  it('未来：倒数', () => {
    expect(countdownState(cd({ date: '2026-09-01' }), NOW)).toMatchObject({ kind: 'down', days: 13 });
  });

  it('过去：正数', () => {
    expect(countdownState(cd({ date: '2026-08-09' }), NOW)).toMatchObject({ kind: 'up', days: 10 });
  });

  it('今天：就是今天，天数 0', () => {
    expect(countdownState(cd({ date: '2026-08-19' }), NOW)).toMatchObject({ kind: 'today', days: 0 });
  });

  it('每年重复的永远在倒数——「已经过去 300 天」对一个每年都来的日子没有意义', () => {
    // 生日在 3 月，今天 8 月：不 yearly 是「已经 160 多天」，yearly 是「还有 200 多天」
    expect(countdownState(cd({ date: '2026-03-10', yearly: false }), NOW)!.kind).toBe('up');
    expect(countdownState(cd({ date: '2026-03-10', yearly: true }), NOW)!.kind).toBe('down');
  });

  it('日期坏掉返回 null——调用方据此画「日期坏了」，不显示 NaN 天', () => {
    expect(countdownState(cd({ date: '下周三' }), NOW)).toBeNull();
  });
});

describe('sortCountdowns', () => {
  it('先今天、再倒数（近的在前）、最后正数（近的在前），坏的沉底', () => {
    const rows = [
      cd({ id: 'far', title: '远的', date: '2026-12-01' }),
      cd({ id: 'past', title: '过去的', date: '2026-08-01' }),
      cd({ id: 'bad', title: '坏的', date: '不是日期' }),
      cd({ id: 'today', title: '今天的', date: '2026-08-19' }),
      cd({ id: 'near', title: '近的', date: '2026-08-21' }),
    ];
    expect(sortCountdowns(rows, NOW).map((c) => c.id)).toEqual(['today', 'near', 'far', 'past', 'bad']);
  });

  it('不改传进来的数组', () => {
    const rows = [cd({ id: 'a', date: '2026-12-01' }), cd({ id: 'b', date: '2026-08-21' })];
    sortCountdowns(rows, NOW);
    expect(rows.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

/**
 * 日历上标纪念日（仿滴答清单的「显示倒数纪念日」）。
 */
describe('countdownsInRange', () => {
  const from = new Date(2026, 7, 1);   // 8/1
  const to = new Date(2026, 7, 31);    // 8/31

  it('不重复的：那一天在范围里就出现', () => {
    expect(countdownsInRange([cd({ id: 'a', date: '2026-08-20' })], from, to).map((m) => m.id)).toEqual(['a']);
  });

  it('不重复的：不在范围里就不出现', () => {
    expect(countdownsInRange([cd({ id: 'a', date: '2026-09-20' })], from, to)).toEqual([]);
  });

  it('**每年重复的按年铺开**——一个 3 月的生日，翻到明年三月那一页也该看得见', () => {
    const birthday = cd({ id: 'b', date: '2020-03-10', yearly: true });
    const mar2026 = countdownsInRange([birthday], new Date(2026, 2, 1), new Date(2026, 2, 31));
    const mar2028 = countdownsInRange([birthday], new Date(2028, 2, 1), new Date(2028, 2, 31));
    expect(mar2026.map((m) => m.at.getFullYear())).toEqual([2026]);
    expect(mar2028.map((m) => m.at.getFullYear())).toEqual([2028]);
  });

  it('每年重复的落在别的月份就不出现', () => {
    expect(countdownsInRange([cd({ id: 'b', date: '2020-03-10', yearly: true })], from, to)).toEqual([]);
  });

  it('范围跨年时两年都试——月视图一页 42 天会跨到下一年', () => {
    const rows = [cd({ id: 'ny', date: '2020-01-01', yearly: true })];
    // 2026-12-28 到 2027-01-07
    const marks = countdownsInRange(rows, new Date(2026, 11, 28), new Date(2027, 0, 7));
    expect(marks.map((m) => m.at.getFullYear())).toEqual([2027]);
  });

  it('闰日的每年纪念日在平年落到 2/28，不溢出到三月那一页', () => {
    const rows = [cd({ id: 'leap', date: '2024-02-29', yearly: true })];
    const feb2027 = countdownsInRange(rows, new Date(2027, 1, 1), new Date(2027, 1, 28));
    expect(feb2027.map((m) => m.at.getDate())).toEqual([28]);
  });

  it('日期坏掉的整条跳过，不炸', () => {
    expect(countdownsInRange([cd({ id: 'x', date: '下周三' })], from, to)).toEqual([]);
  });

  it('边界那两天算在里面', () => {
    const rows = [cd({ id: 'a', date: '2026-08-01' }), cd({ id: 'b', date: '2026-08-31' })];
    expect(countdownsInRange(rows, from, to).map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});

/**
 * **农历纪念日**（仿滴答清单：「点击日期，可选择设置为公历或农历」，
 * 《添加倒数纪念日》）。农历生日、中秋、清明这一类——在中文
 * 用户这儿是倒数日的头号用例，而在这一档之前它表达不了：勾了「每年」只会
 * 按公历那天回来，跟真正的日子每年差十几天。
 *
 * 农历的机器**仓库里本来就有**（`server/src/chineseDays.ts`，`repeat.ts` 的
 * `lunar-year` 一直在用），这一档只是把它接到纪念日上，不新造轮子。
 *
 * 夹具的日子：2020-10-01 是农历八月十五（中秋），2026 年的中秋落在 09-25，
 * 2027 年落在 09-15。`NOW` 是 2026-08-19。
 */
describe('countdownState：农历', () => {
  const MIDAUTUMN_2020 = '2020-10-01';   // 农历八月十五

  it('**按农历算下一次，不是按公历那天**——这一档的全部意义', () => {
    const st = countdownState(cd({ date: MIDAUTUMN_2020, yearly: true, lunar: true }), NOW)!;
    expect(dayKey(st.at)).toBe('2026-09-25');
  });

  it('同一条不勾农历就是公历那天——两档给的是不同的答案，差了将近一周', () => {
    const st = countdownState(cd({ date: MIDAUTUMN_2020, yearly: true, lunar: false }), NOW)!;
    expect(dayKey(st.at)).toBe('2026-10-01');
  });

  it('今年那个已经过去了就落到明年——农历日在公历上每年漂十几天，这条最容易错', () => {
    // 2026-08-15 是农历七月初三；NOW 是 08-19，今年那个已经过去了。
    // 农历 2027 年的七月初三落在公历 **2027-08-04**——按公历顺推会得到
    // 2027-08-15，差十一天。这十一天正是这一档存在的理由。
    const st = countdownState(cd({ date: '2026-08-15', yearly: true, lunar: true }), NOW)!;
    expect(dayKey(st.at)).toBe('2027-08-04');
  });

  it('**不勾「每年」时农历不起作用**——不重复的日子是一个固定的公历点', () => {
    const st = countdownState(cd({ date: MIDAUTUMN_2020, yearly: false, lunar: true }), NOW)!;
    expect(dayKey(st.at)).toBe('2020-10-01');
    expect(st.kind).toBe('up');
  });

  it('农历的每年也永远在倒数，跟公历那档一条规矩', () => {
    expect(countdownState(cd({ date: MIDAUTUMN_2020, yearly: true, lunar: true }), NOW)!.kind).toBe('down');
  });

  it('日期本身解析不了时，农历那一档也不会把它救回来', () => {
    expect(countdownState(cd({ date: '不是日期', yearly: true, lunar: true }), NOW)).toBeNull();
  });
});

describe('nextLunarYearly', () => {
  it('今年那个还没到就用今年的', () => {
    const from = new Date(2020, 9, 1);        // 农历八月十五
    const now = new Date(2026, 0, 1);          // 2026-01-01，今年中秋还没到
    expect(dayKey(nextLunarYearly(from, now)!)).toBe('2026-09-25');
  });

  it('今天就是那一天时算「下一次」，不跳到明年——跟公历那档同一条', () => {
    const from = new Date(2020, 9, 1);
    const now = new Date(2026, 8, 25, 10);     // 正是 2026 年的中秋
    expect(dayKey(nextLunarYearly(from, now)!)).toBe('2026-09-25');
  });
});
