import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heatmap } from './Heatmap.js';
import { HEATMAP_LEVELS, heatmapWeeks } from '../lib/heatmap.js';

const NOW = new Date(2026, 7, 19, 15);
const show = (values: Map<string, number>) =>
  render(<Heatmap values={values} now={NOW} label={(k, v) => `${k}:${v}`} ariaLabel="测试热力图" />);

describe('Heatmap', () => {
  it('整张图有可访问名——一堆方格对读屏软件是一片沉默', () => {
    show(new Map());
    expect(screen.getByLabelText('测试热力图')).toBeTruthy();
  });

  it('格子数等于「列数 × 7」加上图例那几格', () => {
    const { container } = show(new Map());
    const cols = heatmapWeeks(NOW).length;
    expect(container.querySelectorAll('.ink-heat-grid .ink-heat-cell')).toHaveLength(cols * 7);
    // 图例是 0..HEATMAP_LEVELS 共 5 格
    expect(container.querySelectorAll('.ink-heat-legend .ink-heat-cell')).toHaveLength(HEATMAP_LEVELS + 1);
  });

  it('有值的那天染上档位，最大的那天是最深一档', () => {
    const { container } = show(new Map([['2026-08-19', 100], ['2026-08-18', 25]]));
    const top = container.querySelector('[title="2026-08-19:100"]')!;
    const mid = container.querySelector('[title="2026-08-18:25"]')!;
    expect(top.getAttribute('data-level')).toBe(String(HEATMAP_LEVELS));
    expect(mid.getAttribute('data-level')).toBe('1');
  });

  it('没有值的那天是第 0 档，但仍然有悬停文案——「这天什么都没做」也是信息', () => {
    const { container } = show(new Map([['2026-08-19', 100]]));
    const empty = container.querySelector('[title="2026-08-18:0"]')!;
    expect(empty.getAttribute('data-level')).toBe('0');
  });

  it('窗口之外那几格不带 data-level，也不带 title——它不是「值为 0」', () => {
    const { container } = show(new Map());
    const pads = container.querySelectorAll('.ink-heat-pad');
    for (const p of pads) {
      expect(p.getAttribute('data-level')).toBeNull();
      expect(p.getAttribute('title')).toBeNull();
    }
  });

  it('一年一次都没有时不炸，也不出现除以零', () => {
    const { container } = show(new Map());
    const levels = [...container.querySelectorAll('.ink-heat-grid .ink-heat-cell[data-level]')]
      .map((el) => el.getAttribute('data-level'));
    expect(new Set(levels)).toEqual(new Set(['0']));
  });
});
