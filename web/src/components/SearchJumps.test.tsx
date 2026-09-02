import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SearchJumps } from './SearchJumps.js';
import type { List } from '../types.js';

const list = (id: string, name: string): List =>
  ({ id, name, color: '#C2410C', folderId: null, order: 0, archived: false, filter: null });

describe('SearchJumps', () => {
  it('一个都没匹配到时整个不渲染——一条常驻的空横条比没有更糟', () => {
    const { container } = render(<SearchJumps lists={[]} tags={[]} onOpen={() => {}} />);
    expect(container.querySelector('.ink-search-jumps')).toBeNull();
  });

  it('清单和标签摆在同一排，不是两个标签页——一屏装得下就别把答案藏到一次点击后面', () => {
    render(<SearchJumps lists={[list('L1', '工作')]} tags={['紧急']} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '工作' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '#紧急' })).toBeTruthy();
  });

  it('点清单跳到 list:<id>', () => {
    const onOpen = vi.fn();
    render(<SearchJumps lists={[list('L1', '工作')]} tags={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: '工作' }));
    expect(onOpen).toHaveBeenCalledWith('list:L1');
  });

  it('点标签跳到 tag:<名字>——名字里有冒号也不会被切坏', () => {
    const onOpen = vi.fn();
    render(<SearchJumps lists={[]} tags={['项目:035']} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: '#项目:035' }));
    expect(onOpen).toHaveBeenCalledWith('tag:项目:035');
  });

  it('清单的圆点用它自己的颜色——分类色只出现在填充上，不上字', () => {
    const { container } = render(<SearchJumps lists={[list('L1', '工作')]} tags={[]} onOpen={() => {}} />);
    const dot = container.querySelector('.ink-list-dot') as HTMLElement;
    expect(dot.style.backgroundColor).toBeTruthy();
  });
});
