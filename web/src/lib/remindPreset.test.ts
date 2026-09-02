import { describe, it, expect } from 'vitest';
import {
  activePresets, choiceKey, choiceToRemindAt, presetToRemindAt, remindAnchorAt,
  REMIND_CHOICES, REMIND_PRESETS, setNthReminder, togglePreset, type RemindChoice,
} from './remindPreset.js';
import type { Timed } from './taskView.js';

const at = (h: number, mi = 0) => new Date(2026, 7, 20, h, mi).toISOString();
const A_FIXED = new Date(2026, 7, 20, 8).toISOString();

describe('presetToRemindAt', () => {
  it('准时就是截止那一刻', () => {
    expect(presetToRemindAt(at(9), 0)).toBe(at(9));
  });

  it('提前 30 分钟', () => {
    expect(presetToRemindAt(at(9), 30)).toBe(at(8, 30));
  });

  it('提前 1 天跨到前一天', () => {
    expect(presetToRemindAt(new Date(2026, 7, 20, 9).toISOString(), 60 * 24))
      .toBe(new Date(2026, 7, 19, 9).toISOString());
  });

  it('没有截止时间就没有参照物，返回 null——整排预设都不该显示', () => {
    expect(presetToRemindAt(null, 30)).toBeNull();
  });

  it('截止时间是坏字符串也返回 null，不写出 Invalid Date', () => {
    expect(presetToRemindAt('不是时间', 30)).toBeNull();
  });
});

/** 只有截止时间的一条：加锚点之前这是唯一一种能点出预设的任务。 */
const dueOnly = (h: number): Timed => ({ due: at(h), startAt: null, endAt: null });
/** 一场会：九点到十二点，没有截止时间。 */
const meeting = (): Timed => ({ due: null, startAt: at(9), endAt: at(12) });
const find = (anchor: 'main' | 'end', minutes: number): RemindChoice =>
  REMIND_CHOICES.find((c) => c.anchor === anchor && c.minutes === minutes)!;

describe('remindAnchorAt：预设相对哪个时刻算', () => {
  it('只有截止时间：主锚点就是截止那一刻', () => {
    expect(remindAnchorAt(dueOnly(9), 'main')).toBe(at(9));
  });

  it('**有时间段就锚在起点**，不是截止时间——跟日历落格同一个判据', () => {
    const t: Timed = { due: at(18), startAt: at(9), endAt: at(12) };
    expect(remindAnchorAt(t, 'main')).toBe(at(9));
  });

  it('「结束时」锚在时间段的结束', () => {
    expect(remindAnchorAt(meeting(), 'end')).toBe(at(12));
  });

  it('**没有时间段就没有「结束时」这一档**——摆一颗点了没反应的按钮比没有更糟', () => {
    expect(remindAnchorAt(dueOnly(9), 'end')).toBeNull();
  });

  it('`endAt` 不晚于 `startAt` 当成没有时间段：主锚点退回截止时间，结束时那档消失', () => {
    const bad: Timed = { due: at(18), startAt: at(12), endAt: at(9) };
    expect(remindAnchorAt(bad, 'main')).toBe(at(18));
    expect(remindAnchorAt(bad, 'end')).toBeNull();
  });

  it('什么时间都没设：两个锚点都算不出来，整排按钮都不该显示', () => {
    const none: Timed = { due: null, startAt: null, endAt: null };
    expect(remindAnchorAt(none, 'main')).toBeNull();
    expect(remindAnchorAt(none, 'end')).toBeNull();
  });
});

/**
 * **这一族是第七批留下的那个半截。** 时间段（`startAt`+`endAt`）是上一批加的，
 * 提醒预设却还整排锚死在 `due` 上——于是一场只有时间段、没有截止时间的会，
 * 一档预设都点不出来，只能自己去日历上挑一个绝对时刻。
 */
describe('choiceToRemindAt：一场只有时间段的会', () => {
  it('**点得出「提前 30 分钟」了**——按会议的起点算，不是按截止时间', () => {
    expect(choiceToRemindAt(meeting(), find('main', 30))).toBe(at(8, 30));
  });

  it('「准时」就是会议开始那一刻', () => {
    expect(choiceToRemindAt(meeting(), find('main', 0))).toBe(at(9));
  });

  it('「结束时」是会议结束那一刻', () => {
    expect(choiceToRemindAt(meeting(), find('end', 0))).toBe(at(12));
  });

  it('没有时间段时「结束时」算不出来，别的档照常', () => {
    expect(choiceToRemindAt(dueOnly(9), find('end', 0))).toBeNull();
    expect(choiceToRemindAt(dueOnly(9), find('main', 30))).toBe(at(8, 30));
  });
});

describe('REMIND_CHOICES', () => {
  it('**六档偏移是从 `REMIND_PRESETS` 派生的**，不是另抄一份——那六个数还有第二个读者（设置里的「默认提醒」）', () => {
    expect(REMIND_CHOICES.filter((c) => c.anchor === 'main').map((c) => c.minutes))
      .toEqual(REMIND_PRESETS.map((p) => p.minutes));
  });

  it('锚点不同的只有「结束时」一档，排在最后', () => {
    const ends = REMIND_CHOICES.filter((c) => c.anchor === 'end');
    expect(ends).toHaveLength(1);
    expect(REMIND_CHOICES[REMIND_CHOICES.length - 1].anchor).toBe('end');
  });

  it('**每一档的 key 都不一样**——「准时」和「结束时」分钟数都是 0，只按分钟数认会互相顶掉', () => {
    expect(new Set(REMIND_CHOICES.map(choiceKey)).size).toBe(REMIND_CHOICES.length);
  });

  it('每一档都认得出自己——预设表加一档时这条会替你验', () => {
    const t: Timed = { due: null, startAt: at(9), endAt: at(12) };
    for (const c of REMIND_CHOICES) {
      const made = choiceToRemindAt(t, c);
      expect(made, `${choiceKey(c)} 算不出时刻`).not.toBeNull();
      expect(activePresets(t, [made!])).toContain(choiceKey(c));
    }
  });
});

/**
 * 多个提醒。**数据模型（`Task.reminders`）一直是数组**，服务端逐条判、逐条
 * 发，`.ics` 也逐条导出——只有表单一直卡在一个：第二条及以后编辑不到，保存时
 * 靠 `t.reminders.slice(1)` 原样接回去才没被抹掉。
 */
describe('setNthReminder', () => {
  const A = at(8), B = at(9), C = at(10);

  it('改第 i 个', () => {
    expect(setNthReminder([A, C], 1, B)).toEqual([A, B]);
  });

  it('**末尾那个空位算第 n 个**——表单永远多摆一个空选择器当「加一个」', () => {
    expect(setNthReminder([A], 1, B)).toEqual([A, B]);
  });

  it('传 null 就是删掉那一个', () => {
    expect(setNthReminder([A, B, C], 1, null)).toEqual([A, C]);
  });

  it('按时刻排好序——界面上的先后跟真正响的先后一致', () => {
    expect(setNthReminder([C], 1, A)).toEqual([A, C]);
  });

  it('去重：同一个时刻设两遍没有意义，服务端也只会发一次', () => {
    expect(setNthReminder([A, B], 2, A)).toEqual([A, B]);
  });
});

describe('togglePreset', () => {
  const T = dueOnly(9);
  const HALF = find('main', 30);
  const DAY = find('main', 60 * 24);
  const END = find('end', 0);

  it('没有就加一个', () => {
    expect(togglePreset(T, [], HALF)).toEqual([at(8, 30)]);
  });

  it('**加是加一个，不是换掉现有的**——「提前一天」加「提前半小时」是最常见的一对', () => {
    const dayBefore = choiceToRemindAt(T, DAY)!;
    expect(togglePreset(T, [dayBefore], HALF)).toEqual([dayBefore, at(8, 30)]);
  });

  it('有了再点就删掉那一个，别的留着', () => {
    const dayBefore = choiceToRemindAt(T, DAY)!;
    expect(togglePreset(T, [dayBefore, at(8, 30)], HALF)).toEqual([dayBefore]);
  });

  it('算不出锚点时原样返回——那颗按钮本来也不显示', () => {
    const none: Timed = { due: null, startAt: null, endAt: null };
    expect(togglePreset(none, [A_FIXED], HALF)).toEqual([A_FIXED]);
    // 「结束时」在一条没有时间段的任务上同样算不出来。
    expect(togglePreset(T, [A_FIXED], END)).toEqual([A_FIXED]);
  });

  it('「结束时」加得上，也删得掉', () => {
    const m = meeting();
    expect(togglePreset(m, [], END)).toEqual([at(12)]);
    expect(togglePreset(m, [at(12)], END)).toEqual([]);
  });

  /**
   * **删的时候按毫秒认，不按字符串认。** `data/tasks/` 是手改得到的文件，
   * 同一个瞬间能写成好几种样子（带不带毫秒、`+08:00` 还是 `Z`）。按字符串比
   * 的话，那颗按钮会亮着（`activePresets` 按毫秒认）却点不灭——一颗点了没反应
   * 的亮按钮，比不亮更糟。
   */
  it('同一瞬间的另一种写法，点一下也删得掉', () => {
    const same = new Date(Date.parse(at(8, 30))).toISOString().replace('.000Z', '.0Z');
    expect(Date.parse(same)).toBe(Date.parse(at(8, 30)));
    expect(togglePreset(T, [same], HALF)).toEqual([]);
  });
});

describe('activePresets', () => {
  const T = dueOnly(9);

  it('**可能不止一颗亮**——一条任务可以有多个提醒', () => {
    const both = [choiceToRemindAt(T, find('main', 60 * 24))!, at(8, 30)];
    expect([...activePresets(T, both)].sort()).toEqual(['main:1440', 'main:30']);
  });

  it('对不上任何一档的不进来，也不影响别的', () => {
    expect([...activePresets(T, [at(8, 31), at(8, 30)])]).toEqual(['main:30']);
  });

  it('一个提醒都没有就是空的', () => {
    expect(activePresets(T, []).size).toBe(0);
  });

  it('**差一分钟就不算**——点亮一颗其实对不上的按钮等于说了一件不成立的事', () => {
    expect(activePresets(T, [at(8, 31)]).size).toBe(0);
  });

  it('提醒在锚点之后不算任何一档（偏移是负的）', () => {
    expect(activePresets(T, [at(10)]).size).toBe(0);
  });

  it('**「准时」和「结束时」各自认各自的**——分钟数一样，锚点不一样', () => {
    const m = meeting();
    expect([...activePresets(m, [at(9)])]).toEqual(['main:0']);
    expect([...activePresets(m, [at(12)])]).toEqual(['end:0']);
  });

  it('同一瞬间的另一种写法也点得亮——手改文件写出来的那种', () => {
    const same = new Date(Date.parse(at(8, 30))).toISOString().replace('.000Z', '.0Z');
    expect([...activePresets(T, [same])]).toEqual(['main:30']);
  });
});
