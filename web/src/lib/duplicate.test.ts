import { describe, it, expect } from 'vitest';
import { COPIED, DROPPED, duplicateDraft } from './duplicate.js';
import { task } from '../test-utils.js';

describe('duplicateDraft：结构性守卫', () => {
  /**
   * 这一条是这个模块存在的理由。`Task` 上每一个字段都必须在两张名单里**恰好
   * 出现一次**——加了新字段却两边都没写，这里当场红；那正是 `estimateMinutes`
   * 曾经被静默漏掉的那条路（副本里没有「预计 45 分钟」，而拿副本当模板是这个
   * 功能最常见的用法）。
   */
  it('两张名单加起来恰好是 Task 的全部字段，不重不漏', () => {
    const named = [...COPIED, ...DROPPED] as string[];
    expect([...named].sort()).toEqual(Object.keys(task()).sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it('COPIED 里的每一个都真的出现在草稿里——名单不是摆设', () => {
    const draft = duplicateDraft(task());
    expect(Object.keys(draft).sort()).toEqual([...COPIED].sort());
  });
});

describe('duplicateDraft', () => {
  it('标题加「（副本）」', () => {
    expect(duplicateDraft(task({ title: '交房租' })).title).toBe('交房租（副本）');
  });

  it('**预计时长带走**——那是这件事要花多久，不是这一次花了多久', () => {
    expect(duplicateDraft(task({ estimateMinutes: 45 })).estimateMinutes).toBe(45);
  });

  it('专注记录不带——它记的正是「这一次花了多久」，跟上面那条是一对', () => {
    const draft = duplicateDraft(task({ focusSessions: [{ startedAt: '2026-08-01T01:00:00.000Z', minutes: 25 }] }));
    expect('focusSessions' in draft).toBe(false);
  });

  it('子任务带过去但全部重置成没做', () => {
    const draft = duplicateDraft(task({ subtasks: [{ text: '第一步', done: true }] }));
    expect(draft.subtasks).toEqual([{ text: '第一步', done: false }]);
  });

  it('提醒的章清掉，不然副本上那条提醒永远不会响', () => {
    const draft = duplicateDraft(task({ reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: '2026-08-20T01:00:03.000Z' }] }));
    expect(draft.reminders).toEqual([{ at: '2026-08-20T01:00:00.000Z', firedAt: null }]);
  });

  it('标签是一份新数组，不跟原任务共享引用', () => {
    const t = task({ tags: ['工作'] });
    const draft = duplicateDraft(t);
    expect(draft.tags).toEqual(['工作']);
    expect(draft.tags).not.toBe(t.tags);
  });

  it('数组字段是磁盘上手改坏的（不是数组）也不炸——`asArray` 兜底，跟别处一致', () => {
    const draft = duplicateDraft(task({ tags: null as unknown as string[], reminders: null as unknown as [] }));
    expect(draft.tags).toEqual([]);
    expect(draft.reminders).toEqual([]);
  });
});
