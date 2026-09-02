import { describe, it, expect } from 'vitest';
import { SCHEDULE_AXES, SCHEDULE_AXIS_LABEL, axisToGroupBy, hasNoDue, insideEl, pointerXY, unscheduled } from './schedulePanel.js';
import { GROUP_LABEL } from './grouping.js';
import type { Task } from '../types.js';

const t = (over: Partial<Task> = {}): Task => ({
  id: 'x', title: '一件事', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null, postponeCount: 0,
  waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null,
  parentId: null, ...over,
});

describe('hasNoDue', () => {
  it('没写就是没有', () => {
    expect(hasNoDue(t({ due: null }))).toBe(true);
    expect(hasNoDue(t({ due: '' }))).toBe(true);
  });

  it('有一个读得出来的时刻就是有', () => {
    expect(hasNoDue(t({ due: '2026-08-20T10:00:00.000Z' }))).toBe(false);
  });

  it('**读不出来的也算没有**——`due` 被手改成「下周三」时，日历不画它、「今天」不收它、排序把它沉底，功能上它就是没有日期；这跟 smartFilter 的 noDue 是同一条判据，两处必须一致', () => {
    expect(hasNoDue(t({ due: '下周三' }))).toBe(true);
  });
});

describe('unscheduled', () => {
  /**
   * **有时间段的不算「没排期」**，哪怕它没有 `due`。
   *
   * 「只有开始/结束时刻、没有截止日期」是明确支持的状态（`ics.ts` 顶上说它
   * 「在这个应用自己的日历上画得好好的」），`calendarAnchor` 按**起点**给它落格
   * ——它已经排在日历上了。
   *
   * 少了这条，同一屏会给出两个互相矛盾的答案：左边日历把它画在那天，右边
   * 「安排任务」栏又说它还没排。而且把它拖进某一格看起来毫无反应（只写 `due`，
   * 锚点还是 `startAt`），只是悄悄多了个没人要的截止日期。
   */
  it('有时间段的不列进来——它已经画在日历上了', () => {
    const 会议 = t({ id: '会议', due: null, startAt: '2026-09-05T01:00:00.000Z', endAt: '2026-09-05T04:00:00.000Z' });
    const 真没排 = t({ id: '真没排', due: null });
    expect(unscheduled([会议, 真没排]).map((x) => x.id)).toEqual(['真没排']);
  });

  // 只有起点、没有终点 => 不成块（`hasTimeBlock` 要求 end > start），日历上也
  // 落不了格，所以它确实还没排——该列进来。
  it('只有 startAt 没有 endAt：不成块，照样算没排期', () => {
    const 半个 = t({ id: '半个', due: null, startAt: '2026-09-05T01:00:00.000Z', endAt: null });
    expect(unscheduled([半个]).map((x) => x.id)).toEqual(['半个']);
  });
  it('挑出没日期的', () => {
    const a = t({ id: 'a' });
    const b = t({ id: 'b', due: '2026-08-20T10:00:00.000Z' });
    expect(unscheduled([a, b]).map((x) => x.id)).toEqual(['a']);
  });

  it('**已完成/已放弃不算**——这一栏问的是「还有什么没排上日程」，做完的不是', () => {
    const done = t({ id: 'done', status: 'done' });
    const gone = t({ id: 'gone', status: 'abandoned' });
    expect(unscheduled([done, gone])).toEqual([]);
  });

  it('**搁置的也不算**——「搁置」的字面意思就是「现在不打算安排它」，把它列在一个催人安排的栏里是跟他刚做的决定对着干', () => {
    expect(unscheduled([t({ id: 'later', status: 'later' })])).toEqual([]);
  });

  it('进行中的照收——它没日期这件事没变', () => {
    expect(unscheduled([t({ id: 'doing', status: 'doing' })]).map((x) => x.id)).toEqual(['doing']);
  });

  it('子任务照收：数据模型上它就是一条普通任务，没排日期同样该出现在这儿', () => {
    expect(unscheduled([t({ id: 'kid', parentId: 'p' })]).map((x) => x.id)).toEqual(['kid']);
  });
});

describe('分组轴', () => {
  it('三档，跟滴答那一栏顶上那三个页签一字不差', () => {
    expect(SCHEDULE_AXES).toEqual(['list', 'tag', 'priority']);
    expect(SCHEDULE_AXES.map((a) => SCHEDULE_AXIS_LABEL[a])).toEqual(['清单', '标签', '优先级']);
  });

  it('**每一档在 `GroupBy` 里都真的存在**——这三个字符串是直接喂给 `regroupSections` 的，对不上就是一屏空分组', () => {
    for (const a of SCHEDULE_AXES) {
      expect(GROUP_LABEL[axisToGroupBy(a)], a).toBeTruthy();
    }
  });

  it('页签上只用名词，不用下拉框里那句「按清单」——同一个词在两个地方各按各的语境说', () => {
    expect(SCHEDULE_AXIS_LABEL.list).toBe('清单');
    expect(GROUP_LABEL.list).toBe('按清单');
  });
});

describe('pointerXY：拖拽事件里的指针坐标', () => {
  it('鼠标事件读 clientX/clientY', () => {
    expect(pointerXY({ clientX: 12, clientY: 34 } as MouseEvent)).toEqual({ x: 12, y: 34 });
  });

  it('**触摸事件读 changedTouches[0]**——触摸事件上没有 clientX，照鼠标那条读会拿到 undefined，然后跟矩形比大小全是 false：不是报错，是「手指拖过去什么都没发生」这种静默失效', () => {
    const ev = { changedTouches: [{ clientX: 56, clientY: 78 }] } as unknown as TouchEvent;
    expect(pointerXY(ev)).toEqual({ x: 56, y: 78 });
  });
});

describe('insideEl：这个点在不在这个元素上', () => {
  const el = (left: number, top: number, w: number, h: number) => ({
    getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h }),
  }) as HTMLElement;

  it('里面算里面，外面算外面', () => {
    const box = el(100, 100, 200, 200);
    expect(insideEl(box, 150, 150)).toBe(true);
    expect(insideEl(box, 50, 150)).toBe(false);
    expect(insideEl(box, 150, 350)).toBe(false);
  });

  it('边界算在里面——差一个像素就落空的判据，用起来是「明明放在上面了却没反应」', () => {
    const box = el(100, 100, 200, 200);
    expect(insideEl(box, 100, 100)).toBe(true);
    expect(insideEl(box, 300, 300)).toBe(true);
  });

  it('**元素不存在一律为假**：「安排任务」栏收起来的时候，往那个方向拖不该有任何效果', () => {
    expect(insideEl(null, 150, 150)).toBe(false);
  });

  it('坐标不是有限数也为假——触摸事件读歪了会拿到 undefined，那种情况下宁可什么都不做', () => {
    const box = el(0, 0, 9999, 9999);
    expect(insideEl(box, NaN, 10)).toBe(false);
    expect(insideEl(box, undefined as unknown as number, 10)).toBe(false);
  });
});
