import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CalendarYear } from './CalendarYear.js';
import { calendarDays } from '../lib/calendar.js';
import { task } from '../test-utils.js';

const NOW = new Date(2026, 7, 25, 12, 0, 0);
const ANCHOR = new Date(2026, 7, 1);

const at = (m: number, d: number, h = 10) => new Date(2026, m - 1, d, h).toISOString();

const show = (tasks = [] as ReturnType<typeof task>[], over: Partial<Parameters<typeof CalendarYear>[0]> = {}) => {
  const onSelectDay = vi.fn();
  const r = render(
    <CalendarYear
      days={calendarDays(tasks, ANCHOR, 'year')}
      anchor={ANCHOR}
      now={NOW}
      selectedKey={null}
      onSelectDay={onSelectDay}
      {...over}
    />,
  );
  return { ...r, onSelectDay };
};

/** 某一格（按可访问名找，那上面写着「M月D日，N 件事」）。 */
const cell = (m: number, d: number) => screen.getByRole('button', { name: new RegExp(`^${m}月${d}日，`) });

describe('CalendarYear：十二个小月历', () => {
  it('十二个月一个不少', () => {
    const { container } = show();
    expect(container.querySelectorAll('.ink-year-month')).toHaveLength(12);
    expect(screen.getByText('1月')).toBeTruthy();
    expect(screen.getByText('12月')).toBeTruthy();
  });

  it('每个月的天数对得上——2 月 28 天（2026 不是闰年），1 月 31 天', () => {
    show();
    expect(cell(2, 28)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^2月29日，/ })).toBeNull();
    expect(cell(1, 31)).toBeTruthy();
  });

  it('**格子里不写标题**——一天只有十来像素宽，这一档回答的是「哪几段忙」，靠深浅说话', () => {
    show([task({ id: 'a', title: '一个很长的任务标题', due: at(8, 25) })]);
    expect(screen.queryByText('一个很长的任务标题')).toBeNull();
  });

  it('有事的那天上深浅，没事的是第 0 档', () => {
    show([task({ id: 'a', due: at(8, 25) })]);
    expect(cell(8, 25).getAttribute('data-level')).not.toBe('0');
    expect(cell(8, 26).getAttribute('data-level')).toBe('0');
  });

  it('**深浅按这一年最忙那天归一，不写死阈值**——一天一件事的人和一天十件事的人，看到的都该是一张有深浅的图', () => {
    show([
      task({ id: 'a', due: at(8, 25) }),
      task({ id: 'b', due: at(8, 26) }), task({ id: 'c', due: at(8, 26, 11) }),
      task({ id: 'd', due: at(8, 27) }), task({ id: 'e', due: at(8, 27, 11) }), task({ id: 'f', due: at(8, 27, 12) }),
      task({ id: 'g', due: at(8, 28) }), task({ id: 'h', due: at(8, 28, 11) }),
      task({ id: 'i', due: at(8, 28, 12) }), task({ id: 'j', due: at(8, 28, 13) }),
    ]);
    const lv = (d: number) => Number(cell(8, d).getAttribute('data-level'));
    expect(lv(25)).toBeLessThan(lv(28));
    expect(lv(28)).toBe(4);
  });

  it('可访问名说全「哪一天、几件事」——屏幕上只有一个裸数字，读屏读出来会是一串数字', () => {
    show([task({ id: 'a', due: at(8, 25) })]);
    expect(screen.getByRole('button', { name: '8月25日，1 件事' })).toBeTruthy();
  });

  it('点一天把 key 交出去——这是这一档唯一的交互', () => {
    const { onSelectDay } = show();
    fireEvent.click(cell(8, 25));
    expect(onSelectDay).toHaveBeenCalledWith('2026-08-25');
  });

  it('今天有自己的记号', () => {
    const { container } = show();
    const today = container.querySelector('.ink-year-day-today');
    expect(today?.textContent).toBe('25');
  });

  it('每一行最左边是第几周', () => {
    const { container } = show();
    const aug = [...container.querySelectorAll('.ink-year-month')][7] as HTMLElement;
    // 2026-08-24 那一周是第 35 周（跟滴答截图里那个数一致）。
    expect(within(aug).getByText('35')).toBeTruthy();
  });

  it('周日开头那一档：表头第一列变成「日」', () => {
    const { container } = show([], { weekStart: 0 });
    const first = container.querySelector('.ink-year-dow');
    expect(first?.textContent).toBe('日');
  });
});
