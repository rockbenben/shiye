import { describe, it, expect } from 'vitest';
import { activityMarks } from './calendarMarks.js';
import { task } from '../test-utils.js';
import type { Repeat } from '../types.js';

const local = (y: number, mo: number, d: number, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

const FROM = local(2026, 8, 1, 0, 0);
const TO = local(2026, 8, 31, 23, 59);
const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null };

const marks = (tasks: Parameters<typeof activityMarks>[0], want = { focus: true, checkins: true }) =>
  activityMarks(tasks, FROM, TO, want);

describe('activityMarks：专注记录', () => {
  it('一条专注记录一个标记，带 end——**这是日历上唯一有时长的东西**', () => {
    const m = marks([task({ id: 'a', title: '写周报', focusSessions: [{ startedAt: iso(2026, 8, 19, 14), minutes: 25 }] })]);
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe('focus');
    expect(m[0].allDay).toBe(false);
    expect(Date.parse(m[0].end!) - Date.parse(m[0].start)).toBe(25 * 60_000);
  });

  it('id 带上开始时刻——同一条任务上的两段番茄不能撞 key', () => {
    const m = marks([task({
      id: 'a',
      focusSessions: [{ startedAt: iso(2026, 8, 19, 10), minutes: 25 }, { startedAt: iso(2026, 8, 19, 15), minutes: 25 }],
    })]);
    expect(new Set(m.map((x) => x.id)).size).toBe(2);
  });

  it('坏记录跳过，不让一条手改坏的记录把整个月的日历炸掉', () => {
    expect(marks([task({
      id: 'a',
      focusSessions: [
        { startedAt: '不是时间', minutes: 25 },
        { startedAt: iso(2026, 8, 19), minutes: 0 },
        { startedAt: iso(2026, 8, 19), minutes: -5 },
      ],
    })])).toHaveLength(0);
  });

  it('窗口外的不出——翻到八月不该看见七月那几段', () => {
    expect(marks([task({ id: 'a', focusSessions: [{ startedAt: iso(2026, 7, 20), minutes: 25 }] })])).toHaveLength(0);
  });

  it('开关关着就一条都不算', () => {
    const t = [task({ id: 'a', focusSessions: [{ startedAt: iso(2026, 8, 19), minutes: 25 }] })];
    expect(marks(t, { focus: false, checkins: true })).toHaveLength(0);
  });
});

describe('activityMarks：打卡', () => {
  const checked = (over = {}) =>
    task({ id: 'h', title: '喝水', habit: true, repeat: DAILY, status: 'done', completedAt: iso(2026, 8, 19, 23, 47), ...over });

  it('恒全天、恒本地日期——打卡的粒度是「这一天做了」，不是 23:47 那一刻', () => {
    const m = marks([checked()]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'checkin', allDay: true, start: '2026-08-19' });
    expect(m[0].end).toBeUndefined();
  });

  it('没打卡的习惯不出——completedAt 是空的就是还没做', () => {
    expect(marks([checked({ status: 'todo', completedAt: null })])).toHaveLength(0);
  });

  it('不是习惯的任务做完了也不算打卡', () => {
    expect(marks([checked({ habit: false })])).toHaveLength(0);
  });

  /**
   * 这条原来写的是「不是**每天**重复的习惯不算」，夹具用的正是 `every: 'week'`
   * ——而那句「判据跟 habitStats 一致」当时已经是假话：习惯放宽到「每周」之后
   * `habitStats` 收它、这儿不收，后果是一条每周的习惯打得了卡、日历上不出现。
   * 现在两边都走 `isHabit`。
   */
  it('每周重复的习惯也算——判据跟 habitStats 一致（同一个 `isHabit`）', () => {
    expect(marks([checked({ repeat: { ...DAILY, every: 'week', weekdays: [1, 3, 5] } })])).toHaveLength(1);
  });

  it('当不了习惯的重复档不算——每月打卡不是习惯', () => {
    expect(marks([checked({ repeat: { ...DAILY, every: 'month', monthDay: 1 } })])).toHaveLength(0);
  });

  it('开关关着就一条都不算', () => {
    expect(marks([checked()], { focus: true, checkins: false })).toHaveLength(0);
  });
});
