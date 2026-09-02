import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HabitStats } from './HabitStats.js';
import { task } from '../test-utils.js';
import type { Repeat, Task } from '../types.js';

const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };
const local = (y: number, mo: number, d: number, h = 9) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 19, 12);

const done = (title: string, day: number): Task =>
  task({ id: `${title}-${day}`, title, habit: true, repeat: DAILY, status: 'done', completedAt: iso(2026, 8, day) });
const live = (title: string): Task =>
  task({ id: `${title}-live`, title, habit: true, repeat: DAILY, status: 'todo' });

const show = (tasks: Task[]) => {
  const onOpen = vi.fn();
  const utils = render(<HabitStats tasks={tasks} now={NOW} onOpen={onOpen} />);
  return { ...utils, onOpen };
};

describe('HabitStats', () => {
  it('一个习惯都没有：说清楚怎么建一个，不摆一张空表', () => {
    const { container } = show([task({ id: 'a' })]);
    expect(screen.getByText(/还没有习惯/)).toBeTruthy();
    expect(container.querySelector('.ink-hstat-card')).toBeNull();
  });

  it('三个数字都在：连续 / 最长 / 本月', () => {
    show([done('喝水', 17), done('喝水', 18), live('喝水')]);
    expect(screen.getByText(/连续/)).toBeTruthy();
    expect(screen.getByText(/最长/)).toBeTruthy();
    expect(screen.getByText(/本月/)).toBeTruthy();
  });

  it('今天打没打卡单独标出来——底下那张表要数到「今天」那一格才看得出来', () => {
    show([done('喝水', 18), live('喝水')]);
    expect(screen.getByText('今天待打卡')).toBeTruthy();
  });

  it('今天打过卡就换一句话', () => {
    show([done('喝水', 19)]);
    expect(screen.getByText('今天已打卡')).toBeTruthy();
  });

  it('月度打卡表一个月一格不落', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    expect(container.querySelectorAll('.ink-hstat-cell')).toHaveLength(31);
    expect(container.querySelectorAll('.ink-hstat-cell-done')).toHaveLength(1);
  });

  it('还没到的日子跟「到了但没打」分开标——不区分的话一个还没发生的日子看起来跟漏了一样', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    // 8/20 到 8/31 共 12 天还没到
    expect(container.querySelectorAll('.ink-hstat-cell-off')).toHaveLength(12);
  });

  it('点习惯名字跳回那条任务，跳的是待打卡的那条实例', () => {
    const { onOpen } = show([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByRole('button', { name: '喝水' }));
    expect(onOpen).toHaveBeenCalledWith('喝水-live');
  });

  it('打卡表有可访问名——一堆方格对读屏软件是一片沉默', () => {
    show([done('喝水', 18), live('喝水')]);
    expect(screen.getByLabelText('本月打卡表：1 / 19 天')).toBeTruthy();
  });
});

describe('HabitStats：年度热力图', () => {
  it('默认收起——一张 365 格的图乘上五个习惯，会把「这个月怎么样」挤出屏幕', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    expect(container.querySelector('.ink-heat-grid')).toBeNull();
  });

  it('点开才画，画的是这个习惯自己的打卡', () => {
    show([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByRole('button', { name: /看这一年/ }));
    expect(screen.getByLabelText('「喝水」这一年的打卡热力图')).toBeTruthy();
  });

  /**
   * **建这个习惯之前的那些天不说「没打卡」。** 这张图跨 365 天，而习惯多半是
   * 最近才建的——不分开的话，它会对建它之前的每一天都说一句不成立的话。跟月历
   * 格子里 `before` 那一档同一个理由，只是面积大得多。
   */
  it('建它之前的那些天说「那时还没有这个习惯」，不说「没打卡」', () => {
    const born = iso(2026, 8, 17);
    const { container } = show([
      { ...live('冥想'), createdAt: born },
      { ...done('冥想', 18), createdAt: born },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /看这一年/ }));
    const titles = [...container.querySelectorAll('.ink-heat-grid [title]')]
      .map((e) => e.getAttribute('title') ?? '');
    const before = titles.find((t) => t.startsWith('2026-08-16'));
    const after = titles.find((t) => t.startsWith('2026-08-18'));
    expect(before, '热力图里没有 8/16 那格').toBeTruthy();
    expect(before).toContain('那时还没有这个习惯');
    expect(after).toContain('打过卡');
  });

  it('每个习惯各自展开，互不影响', () => {
    show([done('喝水', 18), live('喝水'), done('跑步', 18), live('跑步')]);
    const buttons = screen.getAllByRole('button', { name: /看这一年/ });
    fireEvent.click(buttons[0]);
    expect(screen.queryAllByLabelText(/这一年的打卡热力图/)).toHaveLength(1);
  });
});

/**
 * 今天打卡。补的是一处「看得见、够不着」：这一屏每个习惯上都写着「今天待
 * 打卡」，而打卡这件事在这儿一步都做不了——得先点标题跳到「全部」、在一屏
 * 任务里找到那张卡、再勾它。**这是这个应用里最高频的一下**，却隔着三步。
 */
describe('HabitStats：今天打卡', () => {
  const withCheckIn = (tasks: Task[]) => {
    const onCheckIn = vi.fn();
    render(<HabitStats tasks={tasks} now={NOW} onOpen={vi.fn()} onCheckIn={onCheckIn} />);
    return { onCheckIn };
  };

  it('还没打卡：那一格是一颗按钮，点了把**当下那条实例**标完成', () => {
    const { onCheckIn } = withCheckIn([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByRole('button', { name: '今天打卡' }));
    expect(onCheckIn).toHaveBeenCalledWith('喝水-live');
  });

  it('今天已经打过了就还是一句话——那时候没有动作可做（要反悔走勾选框那条路上的撤销）', () => {
    withCheckIn([done('喝水', 19)]);
    expect(screen.getByText('今天已打卡')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '今天打卡' })).toBeNull();
  });

  it('**整串都了结了、没有 live 实例时不给按钮**——那时候「打卡」没有对象', () => {
    withCheckIn([done('喝水', 18)]);
    expect(screen.getByText('今天待打卡')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '今天打卡' })).toBeNull();
  });

  it('不给 onCheckIn 就退回原来的样子——点了没反应的入口比没有更糟', () => {
    render(<HabitStats tasks={[done('喝水', 18), live('喝水')]} now={NOW} onOpen={vi.fn()} />);
    expect(screen.getByText('今天待打卡')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '今天打卡' })).toBeNull();
  });
});

/**
 * **每周那种习惯在这一屏上说的是另一套话。** 单位是周，还多一句「本周 N/M 次」
 * ——对一条一周三次的健身说「连续 12 天」是句假话，它本来就不用天天做。
 *
 * 判据是 `HabitSummary.week` 是不是 null（`lib/habitStats.ts` 定的），
 * 这一层不自己判「它是哪种习惯」——那正是这批改动要消掉的那种第二份定义。
 */
describe('HabitStats：每周那种习惯', () => {
  const WEEKLY: Repeat = { ...DAILY, every: 'week', weekdays: [1, 3, 5] };
  const w = (day: number): Task =>
    task({ id: `健身-${day}`, title: '健身', habit: true, repeat: WEEKLY, status: 'done', completedAt: iso(2026, 8, day) });
  const wlive = (): Task => task({ id: '健身-live', title: '健身', habit: true, repeat: WEEKLY, status: 'todo' });

  it('**单位写「周」不写「天」**', () => {
    show([w(17), w(19), wlive()]);
    expect(screen.getByText(/连续/).textContent).toContain('周');
    expect(screen.getByText(/最长/).textContent).toContain('周');
  });

  it('多一句「本周 N / M 次」——每天那种没有这句', () => {
    show([w(17), w(19), wlive()]);
    expect(screen.getByText(/本周/).textContent).toMatch(/2\s*\/\s*3/);
  });

  it('每天那种还是「天」，也没有「本周」那一句——放宽之后这一支一个字都不该变', () => {
    show([done('喝水', 18), live('喝水')]);
    expect(screen.getByText(/连续/).textContent).toContain('天');
    expect(screen.queryByText(/本周/)).toBeNull();
  });

  it('**不用打卡的那天，悬停说的是「不用打卡」，不是「没打卡」**', () => {
    const { container } = show([w(17), wlive()]);
    const cells = [...container.querySelectorAll('.ink-hstat-cell')] as HTMLElement[];
    // 8/18 是周二——这个习惯勾的是一三五。
    const tue = cells.find((c) => c.getAttribute('title')?.startsWith('2026-08-18'));
    expect(tue?.getAttribute('title')).toContain('这天不用打卡');
    // 8/19 是周三，该打卡而还没打：那才是「没打卡」。
    const wed = cells.find((c) => c.getAttribute('title')?.startsWith('2026-08-19'));
    expect(wed?.getAttribute('title')).toContain('没打卡');
  });

  /**
   * **年度热力图那句话单独测**——它跟月历格子说的是同一句，但**是另一份代码**：
   * 那张图跨 365 天、格子由 `Heatmap` 画，`label` 是这一层给的回调，读的是
   * `checkinDays` 而不是 `HabitDay.off`。
   *
   * 头一版这一族漏了它：只测了月历格子，把热力图那个分支改成恒 false，
   * 一条都不红。改完之后一年五十二个周二会写着「没打卡」，而那是假话。
   */
  it('**年度热力图上，不用打卡的那天也说「不用打卡」**', () => {
    const { container } = show([w(17), wlive()]);
    fireEvent.click(screen.getByText(/看这一年/));
    const cells = [...container.querySelectorAll('.ink-heat-cell')] as HTMLElement[];
    const tue = cells.find((c) => c.getAttribute('title')?.startsWith('2026-08-18'));
    expect(tue?.getAttribute('title'), '8/18 是周二，这个习惯勾的是一三五').toContain('这天不用打卡');
    const wed = cells.find((c) => c.getAttribute('title')?.startsWith('2026-08-19'));
    expect(wed?.getAttribute('title'), '8/19 是周三，该打而没打').toContain('没打卡');
  });

  it('每天那种在热力图上没有「不用打卡」这句——它哪天都该打', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByText(/看这一年/));
    const titles = [...container.querySelectorAll('.ink-heat-cell')].map((c) => c.getAttribute('title') ?? '');
    expect(titles.some((t) => t.includes('不用打卡'))).toBe(false);
    expect(titles.length, '热力图一个格子都没画——这一族在空转').toBeGreaterThan(300);
  });

  it('空状态那句话也说全了「每天」「每周」——它是唯一告诉人怎么建一个的地方', () => {
    show([task({ id: 'a' })]);
    const note = screen.getByText(/还没有习惯/).textContent ?? '';
    for (const label of ['每天', '每周']) expect(note, `少了「${label}」`).toContain(label);
  });
});
