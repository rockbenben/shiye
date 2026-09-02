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
