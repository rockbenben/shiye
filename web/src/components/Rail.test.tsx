import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Rail } from './Rail.js';

const ITEMS = [
  { key: 'habits', label: '习惯' },
  { key: 'focus', label: '专注统计' },
  { key: 'countdown', label: '纪念日', count: 3 },
  { key: 'review', label: '回顾' },
];

const show = (over: Partial<Parameters<typeof Rail>[0]> = {}) => {
  const onSelect = vi.fn();
  const onOpenSettings = vi.fn();
  const onSearch = vi.fn();
  render(
    <Rail items={ITEMS} current="today" onSelect={onSelect} onSearch={onSearch} onOpenSettings={onOpenSettings} {...over} />,
  );
  return { onSelect, onSearch, onOpenSettings };
};

const nav = () => screen.getByRole('navigation', { name: '模块' });

describe('Rail', () => {
  it('每一项都自报名字——**只有记号的按钮不写 aria-label 就是一颗空按钮**，读屏念不出任何东西', () => {
    show();
    for (const it of ITEMS) {
      expect(within(nav()).getByRole('button', { name: it.label })).toBeTruthy();
    }
  });

  it('鼠标停下也说得出是什么（title）——记号认不出来时，悬停是唯一的退路', () => {
    show();
    expect(within(nav()).getByRole('button', { name: '习惯' }).getAttribute('title')).toBe('习惯');
  });

  it('**名字只有一份**：aria-label 和 title 都直接用传进来的 label，不另起短名', () => {
    show();
    for (const it of ITEMS) {
      const b = within(nav()).getByRole('button', { name: it.label });
      expect(b.getAttribute('title'), it.key).toBe(it.label);
    }
  });

  it('点了把 key 交出去', () => {
    const { onSelect } = show();
    fireEvent.click(within(nav()).getByRole('button', { name: '回顾' }));
    expect(onSelect).toHaveBeenCalledWith('review');
  });

  it('当前那一项标 aria-current，别的不标', () => {
    show({ current: 'focus' });
    expect(within(nav()).getByRole('button', { name: '专注统计' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav()).getByRole('button', { name: '习惯' }).getAttribute('aria-current')).toBeNull();
  });

  it('人不在这几个模块里时一项都不高亮——那是常态，多数时候人在任务列表上', () => {
    const { container } = render(
      <Rail items={ITEMS} current="today" onSelect={vi.fn()} onSearch={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it('有数字才画角标，0 和没有都不画——一个常驻的 0 是噪音', () => {
    const { container } = render(
      <Rail
        items={[{ key: 'habits', label: '习惯', count: 0 }, { key: 'review', label: '回顾', count: 7 }]}
        current="today"
        onSelect={vi.fn()}
        onSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    const counts = [...container.querySelectorAll('.ink-modrail-count')].map((e) => e.textContent);
    expect(counts).toEqual(['7']);
  });

  it('**「设置」不在导航地标里**——它开的是一个抽屉，不是一个去处，躺在 nav 里会被当成第五个导航项报出来', () => {
    const { onOpenSettings } = show();
    expect(within(nav()).queryByRole('button', { name: '设置' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('**搜索也不在导航地标里**——它是个动作（点开一个弹层），不是一个去处', () => {
    const { onSearch } = show();
    expect(within(nav()).queryByRole('button', { name: '搜索' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('一项都没有时（导航显示里全关掉）整条栏照样立得住，不崩', () => {
    render(<Rail items={[]} current="today" onSelect={vi.fn()} onSearch={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(within(nav()).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
  });
});
