import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HabitStreak } from './HabitStreak.js';

describe('HabitStreak', () => {
  it('streak > 0 且今天已打卡：显示连续天数，不显示「今天还没打卡」', () => {
    const { container } = render(<HabitStreak habit={{ streak: 3, doneToday: true, week: null }} />);
    expect(screen.getByText(/连续 3 天/)).toBeDefined();
    expect(container.textContent).not.toContain('今天还没打卡');
  });

  it('streak > 0 且今天没打卡：连续天数照旧，附带「今天还没打卡」', () => {
    render(<HabitStreak habit={{ streak: 5, doneToday: false, week: null }} />);
    expect(screen.getByText(/连续 5 天/)).toBeDefined();
    expect(screen.getByText(/今天还没打卡/)).toBeDefined();
  });

  // 上限：streak===0 且 doneToday===false 时不渲染任何东西——还没开始的习惯
  // 挂一个「连续 0 天」是噪音，不是信息。
  it('streak 0 且 doneToday false：什么都不渲染', () => {
    const { container } = render(<HabitStreak habit={{ streak: 0, doneToday: false, week: null }} />);
    expect(container.innerHTML).toBe('');
    expect(container.querySelector('.ink-habit-streak')).toBeNull();
  });

  // final-review.md m6：aria-label 挂在裸 <div> 上，读屏软件大概率不采信
  // （generic 角色的 accessible-name 计算不认 aria-label），会退回去读子节点
  // 的可见文本——「今天还没打卡」那半句原来连子节点也是 aria-hidden，两条路
  // 都读不到，对读屏用户整句消失。这里守住退回子节点这条路：文案本身不能
  // 被 aria-hidden 挡住。
  it('「今天还没打卡」不是 aria-hidden 的——读屏软件退回去读子节点也要读得到', () => {
    render(<HabitStreak habit={{ streak: 5, doneToday: false, week: null }} />);
    const pending = screen.getByText(/今天还没打卡/);
    expect(pending.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('不上群青：打卡是人自己做的事，纯 CSS，class 名不是 ant-* 组件', () => {
    const { container } = render(<HabitStreak habit={{ streak: 1, doneToday: true, week: null }} />);
    // 没有引入任何 antd 组件——断言渲染结果里不含 antd 的 class 前缀，
    // 侧面证明这条打卡条走的是纯 CSS，不需要额外套 boardLocalTheme 那套
    // colorPrimary 断言（那套只在真的用了 antd 组件时才需要，见 task-3-brief）。
    expect(container.querySelector('[class*="ant-"]')).toBeNull();
  });
});

/**
 * **每周的习惯说的是另一句话。** 一条「一周三次」的健身，周一三五做完之后
 * 「连续天数」是 1（周二没做）——那个数字对它是句假话，它本来就不用天天做。
 */
describe('HabitStreak：每周的习惯', () => {
  const weekly = (done: number, target: number, streak = 0) =>
    render(<HabitStreak habit={{ streak, doneToday: false, week: { done, target } }} />);

  it('写「本周 2/3」，不写连续天数', () => {
    weekly(2, 3);
    expect(screen.getByText('本周 2/3')).toBeTruthy();
    expect(screen.queryByText(/连续 \d+ 天/)).toBeNull();
  });

  it('连上了就补一句「连续 N 周」——单位是周不是天', () => {
    weekly(3, 3, 4);
    expect(screen.getByText('· 连续 4 周')).toBeTruthy();
  });

  it('还没连上就不写那半句——「连续 0 周」是噪音', () => {
    weekly(1, 3, 0);
    expect(screen.queryByText(/连续/)).toBeNull();
  });

  it('一次都没做、也没连上过：整个不渲染，跟每天那种一字不差', () => {
    const { container } = weekly(0, 3, 0);
    expect(container.firstChild).toBeNull();
  });

  it('读屏念得出完整的话——可见文字是「本周 2/3」，听起来会缺上下文', () => {
    weekly(2, 3, 4);
    expect(screen.getByLabelText('本周已打卡 2 次，目标 3 次，连续 4 周达标')).toBeTruthy();
  });

  it('每天的习惯（week 为 null）照旧写连续天数——这一档一个字没变', () => {
    render(<HabitStreak habit={{ streak: 5, doneToday: true, week: null }} />);
    expect(screen.getByText('连续 5 天')).toBeTruthy();
  });
});
