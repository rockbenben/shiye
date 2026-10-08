import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ScheduledBanner } from './ScheduledBanner.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ScheduledBanner', () => {
  it('显示还剩多少秒，每秒自己走一次，不用父组件推着刷新', () => {
    const fixedNow = new Date('2026-08-11T06:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const at = new Date(fixedNow + 45_000).toISOString();
    render(<ScheduledBanner at={at} onRunNow={() => {}} onSkip={() => {}} />);

    expect(screen.getByText(/约 45 秒后/)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText(/约 40 秒后/)).toBeTruthy();
  });

  /**
   * 「约 N 秒后」只在**一分钟内**说得出人话。设置里那一档写的是「10～3600 秒」
   * （`SettingsModal.tsx` 的「自动拆解延迟」，`addonAfter="秒"`），所以把延迟调到
   * 半小时是界面明摆着允许的做法——而横幅会照着说「约 1799 秒后」。同一个数在
   * 输入框里带「秒」那个后缀读起来是精确值，在一句话里读起来是一串要心算的数。
   * 一分钟以内照旧走秒：那正是这个组件自己养那个 1 秒定时器的意义。
   */
  it('还有一分钟以上时说分钟/小时，不报四位秒数', () => {
    const cases: Array<[number, RegExp]> = [
      [59, /约 59 秒后/],
      [60, /约 1 分钟后/],
      [120, /约 2 分钟后/],
      [3540, /约 59 分钟后/],
      [3600, /约 1 小时后/],
    ];
    for (const [sec, want] of cases) {
      const { unmount } = render(<ScheduledBanner at={new Date(Date.now() + sec * 1000).toISOString()} onRunNow={() => {}} onSkip={() => {}} />);
      expect(screen.getByText(want), `${sec} 秒那一档说的话不对`).toBeTruthy();
      unmount();
    }
  });

  it('两个按钮各自触发对应的回调', () => {
    const at = new Date(Date.now() + 30_000).toISOString();
    const onRunNow = vi.fn();
    const onSkip = vi.fn();
    render(<ScheduledBanner at={at} onRunNow={onRunNow} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole('button', { name: '立即拆解' }));
    fireEvent.click(screen.getByRole('button', { name: '这次不拆' }));

    expect(onRunNow).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
