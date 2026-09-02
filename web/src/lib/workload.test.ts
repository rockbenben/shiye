import { describe, it, expect } from 'vitest';
import { todayMetaLabel, workloadLabel } from './workload.js';
import type { Task } from '../types.js';
import { task } from '../test-utils.js';

const est = (m: number | null) => task({ estimateMinutes: m });

describe('workloadLabel', () => {
  it('全都估过：只报总和', () => {
    expect(workloadLabel([est(30), est(45)])).toBe('预计 1 小时 15 分');
  });

  it('**有没估过的就说出来**——不然「预计 45 分钟」会让人以为今天很轻松，而那是个下界', () => {
    expect(workloadLabel([est(45), est(null), est(null)])).toBe('预计 45 分钟，另有 2 条没估过');
  });

  it('一条都没估过：整句不出，不报「预计 0 分钟」', () => {
    expect(workloadLabel([est(null), est(null)])).toBe('');
  });

  it('空列表也是空串——调用方在列表为空时本来就不渲染这一行', () => {
    expect(workloadLabel([])).toBe('');
  });

  it('磁盘上手改坏的估计（字符串/负数/0）算「没估过」，不参与求和也不炸', () => {
    const bad = [est(60), task({ estimateMinutes: '30' as unknown as number }), est(-5), est(0)];
    expect(workloadLabel(bad)).toBe('预计 1 小时，另有 3 条没估过');
  });
});

/**
 * 「今天」头上那一整行。中间那一截（几条是欠着的债）是因为**这一排是平的**：
 * 过期的和今天要做的混在一起，「今天 12 条」读起来像「我今天安排了 12 件事」，
 * 而其中九条其实是债。
 */
describe('todayMetaLabel', () => {
  const NOW = new Date(2026, 7, 22, 12);
  const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h).toISOString();
  const soon = (over: Partial<Task> = {}) => task({ due: at(2026, 8, 22, 20), ...over });
  const late = (over: Partial<Task> = {}) => task({ due: at(2026, 8, 20), ...over });

  it('一条都没过期时就是原来那样', () => {
    expect(todayMetaLabel([soon(), soon()], NOW)).toBe('2 条');
  });

  it('有几条过期就报几条', () => {
    expect(todayMetaLabel([soon(), late(), late()], NOW)).toBe('3 条（2 条已过期）');
  });

  it('**全都过期时换一句话**——「9 条（9 条已过期）」是把同一个数字报两遍', () => {
    expect(todayMetaLabel([late(), late()], NOW)).toBe('2 条，都已经过期');
  });

  it('跟预计时长拼在一起', () => {
    expect(todayMetaLabel([late({ estimateMinutes: 30 }), soon({ estimateMinutes: 45 })], NOW))
      .toBe('2 条（1 条已过期） · 预计 1 小时 15 分');
  });

  it('空列表就是「0 条」——调用方在列表为空时本来就不渲染这一行', () => {
    expect(todayMetaLabel([], NOW)).toBe('0 条');
  });

  it('**做完的不算过期**——口径跟卡片上那个红标签同一条（isTaskOverdue）', () => {
    expect(todayMetaLabel([late({ status: 'done' }), soon()], NOW)).toBe('2 条');
  });
});
