import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { CalendarFull, scrollTargetHour } from './CalendarFull.js';
import { calendarDays, dayKey, MAX_VISIBLE_TASKS, type CalMark } from '../lib/calendar.js';
import {
  task, installFullCalendarFakeLayout, fcCellCenter, fcClickCell, fcDragEvent,
  fcSlotPoint, fcTimeGridDrag,
} from '../test-utils.js';

// task-6：周/日视图共用同一批锚点/夹具，week 起点是 ANCHOR 所在周的周一
// （2026-08-10，见 calendar.ts 的 mondayOf），跟 CalendarHours.test.tsx（已
// 退役）用的锚点是同一个数字，方便对照旧断言。
const WEEK_DAYS = (tasks: ReturnType<typeof task>[] = []) => calendarDays(tasks, ANCHOR, 'week');
const DAY_DAYS = (tasks: ReturnType<typeof task>[] = []) => calendarDays(tasks, ANCHOR, 'day');

// 2026-08-16（周日）——跟 CalendarGrid.test.tsx/calendar.test.ts 同一个锚点，
// 月视图头尾补齐（7/27 起）已经被那份测试钉死，这里直接复用，不重新验证
// calendarDays 本身对不对（那是 Task 2 的事），只测 FullCalendar 怎么画它。
const ANCHOR = new Date(2026, 7, 16, 12, 0, 0);
const MONTH_DAYS = calendarDays([], ANCHOR, 'month');

function Harness({ initialTasks, onSelectDaySpy, onDropSpy, onOpenSpy, marks, hasDropHandler = true, anchor = ANCHOR, showLunar, showHolidays }: {
  initialTasks: ReturnType<typeof task>[];
  onSelectDaySpy?: (k: string) => void;
  onDropSpy?: (id: string, k: string) => void;
  onOpenSpy?: (id: string) => void;
  /** 塞给锚点那一天的标记。造一个真的重复/纪念日太绕，这里直接给形状。 */
  marks?: CalMark[];
  hasDropHandler?: boolean;
  anchor?: Date;
  showLunar?: boolean;
  showHolidays?: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const base = calendarDays(initialTasks, anchor, 'month');
  const days = marks
    ? base.map((d) => (d.key === dayKey(anchor) ? { ...d, marks: [...d.marks, ...marks] } : d))
    : base;
  return (
    <CalendarFull
      days={days}
      anchor={anchor}
      now={anchor}
      selectedKey={selectedKey}
      onSelectDay={(k) => { setSelectedKey(k); onSelectDaySpy?.(k); }}
      onDropOnDay={hasDropHandler ? (id, k) => onDropSpy?.(id, k) : undefined}
      onOpenTask={onOpenSpy}
      showLunar={showLunar}
      showHolidays={showHolidays}
    />
  );
}

/** ⚠️ **`allHours` 默认给 `true`**（组件的默认值是 `false`）。这一族测试里
 *  绝大多数断言的是「第 h 小时那一格在哪儿 / 拖到第 h 格会怎样」，而组件默认
 *  只画 `hourBand` 算出来的那一段（默认 07-23）——凌晨那几格在屏幕上不存在，
 *  按小时下标算坐标的那套换算（`fcSlotPoint`）会整族偏掉。
 *  band 本身的行为有它自己的一组断言（下面「画哪一段小时」那个 describe），
 *  以及 `calendar.test.ts` 里 `hourBand` 的单测。 */
function WeekDayHarness({ days, onSelectDaySpy, onDropSpy, hasDropHandler = true, now = ANCHOR, anchor = ANCHOR, allHours = true }: {
  days: ReturnType<typeof calendarDays>;
  onSelectDaySpy?: (k: string) => void;
  onDropSpy?: (id: string, k: string, hour: number | 'allday') => void;
  hasDropHandler?: boolean;
  now?: Date;
  anchor?: Date;
  allHours?: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  return (
    <CalendarFull
      days={days}
      anchor={anchor}
      now={now}
      selectedKey={selectedKey}
      onSelectDay={(k) => { setSelectedKey(k); onSelectDaySpy?.(k); }}
      onDropOnSlot={hasDropHandler ? (id, k, h) => onDropSpy?.(id, k, h) : undefined}
      allHours={allHours}
    />
  );
}

// FullCalendar 的点选/拖拽走它自己的指针交互引擎，不是原生 HTML5
// drag/drop，jsdom 下需要补 `elementFromPoint`/`getBoundingClientRect`
// 两个硬需求——`installFullCalendarFakeLayout`/`fcCellCenter`/`fcClickCell`/
// `fcDragEvent` 这一组辅助函数连同完整的踩坑过程，写在 test-utils.tsx
// （`mockDndRects` 边上，同一类「给 jsdom 补交互引擎需要的东西」的夹具），
// App.test.tsx 的日历拖拽测试也要用同一套，不在两个文件里各自维护一份。
let restoreFakeLayout: (() => void) | null = null;
function installFakeLayout() {
  restoreFakeLayout = installFullCalendarFakeLayout();
}
afterEach(() => {
  restoreFakeLayout?.();
  restoreFakeLayout = null;
});

describe('CalendarFull：结构——42 格月历，日期范围跟 calendarDays 对齐', () => {
  it('42 个格子，第一格/最后一格的 data-date 跟 calendarDays 算出来的 days[0]/days[41] 一致', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    const cells = container.querySelectorAll('.fc-daygrid-day');
    expect(cells).toHaveLength(42);
    expect(cells[0].getAttribute('data-date')).toBe(MONTH_DAYS[0].key);
    expect(cells[41].getAttribute('data-date')).toBe(MONTH_DAYS[41].key);
  });

  it('星期表头不由 FullCalendar 自己画——那还是 CalendarGrid.tsx 的 .ink-cal-weekdays，dayHeaders={false} 关掉库自己的一份，不重复', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    expect(container.querySelector('.fc-col-header')).toBeNull();
  });

  it('上个月/下个月补的格子标了 .fc-day-other——跟旧实现 .ink-cal-day-outside 同一件事，库自带', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')];
    MONTH_DAYS.forEach((d, i) => {
      expect(cells[i].classList.contains('fc-day-other')).toBe(d.outside);
    });
  });
});

// 复审 I4：上一版这里写着「dayMaxEvents 是按真实像素高度决定摆得下几条，
// jsdom 量不出来」——这句话是错的，而且是这一批第四次把没验过的假设写成
// 事实。实测过（真的渲染 + 读 DOM）：dayMaxEvents 给数字时是按条数切，
// 超出的事件块用内联样式 `visibility: hidden` 摘掉（`.fc-daygrid-event-
// harness-abs`），不依赖任何像素测量，jsdom 下完全确定性可测。下面三条
// 覆盖 3/4/5 条任务三个方向（含「恰好等于上限，一条都不该被摘」的上限）。
function visibleHarnessCount(cell: Element): number {
  return [...cell.querySelectorAll('.fc-daygrid-event-harness')]
    .filter((h) => getComputedStyle(h).visibility !== 'hidden').length;
}

describe('CalendarFull：任务展示——最多 3 条 + 「+N」', () => {
  it('标题原文画出来，不超过 3 条时不出现「还有」', () => {
    const tasks2 = [task({ id: 'a', title: 'A', due: '2026-08-20T09:00:00.000Z' }), task({ id: 'b', title: 'B', due: '2026-08-20T09:00:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks2} />);
    expect([...container.querySelectorAll('.fc-event-title')].map((e) => e.textContent)).toEqual(['A', 'B']);
    expect(container.querySelector('.fc-daygrid-more-link')).toBeNull();
  });

  /**
   * **格子里按时间排——而顺序的正本在 `calendar.ts`，不在 FullCalendar。**
   *
   * 它默认的 `eventOrder` 是 `start,-duration,allDay,title`，而月视图把每条都当
   * 全天（`allDay: true`），`start` 只剩日期——四个键全部打平，于是退到按**标题**
   * 排，用的还是 locale（拼音）序。实拍出来是「背单词 21:00 / 晨跑 7:00 /
   * 给房东打电话 20:00」：bei < chen < gei，一字不差。
   *
   * 修法是发一个 `ord`（按下标）当排序键，让它照 `calendarDays` 排好的顺序渲染。
   * 这条钉的是**接线**：`eventOrder="ord"` 或者 `extendedProps.ord` 少了一半，
   * 顺序就悄悄退回按标题排，而 `calendar.test.ts` 那三条照样全绿。
   *
   * 夹具刻意用「拼音序跟时间序相反」的三个标题——不然这条测试对着任何实现都绿。
   */
  it('同一格里按时刻排，不是 FullCalendar 默认的按标题（拼音）排', () => {
    const day = '2026-08-20T';
    const three = [
      task({ id: 'c', title: '背单词', due: `${day}21:00:00.000Z` }),
      task({ id: 'a', title: '晨跑', due: `${day}07:00:00.000Z` }),
      task({ id: 'b', title: '给房东打电话', due: `${day}20:00:00.000Z` }),
    ];
    const { container } = render(<Harness initialTasks={three} />);
    expect([...container.querySelectorAll('.fc-event-title')].map((e) => e.textContent))
      .toEqual(['晨跑', '给房东打电话', '背单词']);
  });

  it('恰好 3 条（等于 MAX_VISIBLE_TASKS）：不出现「还有」，3 条全部可见——上限，卡在边界上不该多摘一条', () => {
    const tasks3 = Array.from({ length: 3 }, (_, i) => task({ id: `t${i}`, title: `任务${i}`, due: '2026-08-20T09:00:00.000Z' }));
    const { container } = render(<Harness initialTasks={tasks3} />);
    const cell = [...container.querySelectorAll('.fc-daygrid-day')].find((c) => c.getAttribute('data-date') === '2026-08-20')!;
    expect(container.querySelector('.fc-daygrid-more-link')).toBeNull();
    expect(visibleHarnessCount(cell)).toBe(3);
  });

  it('4 条：「+1」，3 条可见 + 1 条真的被摘掉（visibility: hidden，不是还在 DOM 里装死）', () => {
    const tasks4 = Array.from({ length: 4 }, (_, i) => task({ id: `t${i}`, title: `任务${i}`, due: '2026-08-20T09:00:00.000Z' }));
    const { container } = render(<Harness initialTasks={tasks4} />);
    const cell = [...container.querySelectorAll('.fc-daygrid-day')].find((c) => c.getAttribute('data-date') === '2026-08-20')!;
    const more = container.querySelector('.fc-daygrid-more-link');
    expect(more, '「+N」链接不见了').not.toBeNull();
    // 「+1」不是「还有 1 条」——照滴答清单：那一行摆在最后一条任务的右端，
    // 一句话会把它挤成两行；这个数字要回答的只是「还有几条没画出来」。
    expect(more!.textContent).toBe('+1');
    expect(visibleHarnessCount(cell)).toBe(3);
    expect(cell.querySelectorAll('.fc-daygrid-event-harness')).toHaveLength(4);
  });

  it('一天超过 MAX_VISIBLE_TASKS 条（5 条）时出现「+N」，N 等于溢出数，且真的只有 3 条可见——dayMaxEvents 是按条数切，不依赖像素测量，jsdom 下完全确定', () => {
    const tasks5 = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, title: `任务${i}`, due: '2026-08-20T09:00:00.000Z' }));
    const { container } = render(<Harness initialTasks={tasks5} />);
    const cell = [...container.querySelectorAll('.fc-daygrid-day')].find((c) => c.getAttribute('data-date') === '2026-08-20')!;
    const more = container.querySelector('.fc-daygrid-more-link');
    expect(more, '「+N」链接不见了').not.toBeNull();
    expect(more!.textContent).toBe(`+${5 - MAX_VISIBLE_TASKS}`);
    expect(visibleHarnessCount(cell)).toBe(MAX_VISIBLE_TASKS);
    expect(cell.querySelectorAll('.fc-daygrid-event-harness')).toHaveLength(5);
  });
});

describe('CalendarFull：今天 / 选中', () => {
  it('.fc-day-today 标在 now 那一天，且只有一格', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    const todays = container.querySelectorAll('.fc-day-today');
    expect(todays).toHaveLength(1);
    expect(todays[0].getAttribute('data-date')).toBe(dayKey(ANCHOR));
  });

  it('点一格：.ink-cal-day-selected + aria-current="date" 出现在那一格，且只有那一格', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const { container } = render(<Harness initialTasks={[]} onSelectDaySpy={onSelectDaySpy} />);
    const targetIdx = 5;
    fcClickCell(container.querySelectorAll('.fc-daygrid-day')[targetIdx], fcCellCenter(targetIdx));
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith(MONTH_DAYS[targetIdx].key);

    await waitFor(() => {
      expect(container.querySelectorAll('.ink-cal-day-selected')).toHaveLength(1);
    });
    const cells = container.querySelectorAll('.fc-daygrid-day');
    expect(cells[targetIdx].classList.contains('ink-cal-day-selected')).toBe(true);
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
    expect(cells[targetIdx].getAttribute('aria-current')).toBe('date');
  });

  it('再点另一格：标记跟着挪，不是叠加在两格上——这条钉的是 aria-current 的响应式更新（dayCellDidMount 只在挂载时跑一次，光靠它 aria-current 会永远停在第一次点的那格，得靠 useEffect 补，见 CalendarFull.tsx 那段注释）', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const { container } = render(<Harness initialTasks={[]} onSelectDaySpy={onSelectDaySpy} />);
    const cells = container.querySelectorAll('.fc-daygrid-day');

    fcClickCell(cells[5], fcCellCenter(5));
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));

    fcClickCell(cells[10], fcCellCenter(10));
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(container.querySelectorAll('.ink-cal-day-selected')).toHaveLength(1);
    });

    expect(cells[5].classList.contains('ink-cal-day-selected')).toBe(false);
    expect(cells[10].classList.contains('ink-cal-day-selected')).toBe(true);
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
    expect(cells[5].getAttribute('aria-current')).toBeNull();
    expect(cells[10].getAttribute('aria-current')).toBe('date');
  });
});

describe('CalendarFull：键盘可达——格子不是字面的 <button>（DOM 由 FullCalendar 决定），但 Tab 停得到、Enter/Space 能选中', () => {
  it('全部 42 个格子 tabIndex 都是 0——键盘 Tab 挨个停得到', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')] as HTMLElement[];
    expect(cells).toHaveLength(42);
    for (const c of cells) expect(c.tabIndex).toBe(0);
  });

  it('Enter 选中这一格，跟点击一样——不走 FullCalendar 的指针交互引擎，是 CalendarFull.tsx 自己接的 keydown，不需要假布局', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<Harness initialTasks={[]} onSelectDaySpy={onSelectDaySpy} />);
    const cells = container.querySelectorAll('.fc-daygrid-day');
    fireEvent.keyDown(cells[7], { key: 'Enter' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
    expect(onSelectDaySpy).toHaveBeenCalledWith(MONTH_DAYS[7].key);
  });

  it('空格键同样能选中；别的键（比如 Tab 本身）不触发', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<Harness initialTasks={[]} onSelectDaySpy={onSelectDaySpy} />);
    const cells = container.querySelectorAll('.fc-daygrid-day');
    fireEvent.keyDown(cells[3], { key: ' ' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(cells[3], { key: 'Tab' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
  });
});

describe('CalendarFull：+N 点选——跟点格子本身是同一个动作，不弹 FullCalendar 自己的 popover', () => {
  it('点「+N」选中这一天；没有 .fc-popover 出现', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const tasks5 = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, title: `任务${i}`, due: '2026-08-20T09:00:00.000Z' }));
    const { container } = render(<Harness initialTasks={tasks5} onSelectDaySpy={onSelectDaySpy} />);
    const more = container.querySelector('.fc-daygrid-more-link')!;
    // MoreLinkClicking 走的是普通 click（不是 HitDragging 那套指针序列），
    // 实测过：mousedown+mousemove+mouseup 反而不触发，直接 click 才对。
    fireEvent.click(more);
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith('2026-08-20');
    expect(container.querySelector('.fc-popover')).toBeNull();
  });
});

describe('CalendarFull：拖到某天改期——只转发 (任务 id, 目标日期 key)，保留原时刻是调用方 CalendarView.tsx 的事', () => {
  it('拖到不同的一天：onDropOnDay 收到任务 id 和目标日期的 key', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} onDropSpy={onDropSpy} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')];
    const fromIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-20');
    const towardIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-21');
    const eventEl = container.querySelector('.fc-daygrid-event')!;

    fcDragEvent(eventEl, fromIdx, towardIdx);
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    const [droppedId, droppedKey] = onDropSpy.mock.calls[0];
    expect(droppedId).toBe('a');
    // 不是原来那天，且是合法的 YYYY-MM-DD——不死抠「拖向 8/21 就必须精确落在
    // 8/21」这个像素级承诺：FullCalendar 的坐标换算在这套假布局下有大约一格
    // 的系统性偏移（`useSubjectCenter` 用「拖起点矩形 ∩ 命中格矩形」的交集
    // 中心重新校准落点，这套换算跟这里手写的假 getBoundingClientRect 不是
    // 完全同一个坐标系），真实浏览器里像素是连续的，不会有这层因为「格子
    // 矩形是手写死数字」带来的跳变。这条钉住的是行为契约本身——拖到别的
    // 日子会转发 (id, 新的那天)，不是重新验证 FullCalendar 内部换算像素的
    // 具体公式。
    expect(droppedKey).not.toBe('2026-08-20');
    expect(droppedKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // 复审 M3，修复轮 2 复审①：旧实现有一条「拖到 outside 的格子（上/下月的
  // 日子）照样能改期」的测试，改用 FullCalendar 之后这条没有对应的新测试
  // 守住——行为大概率还在（.fc-day-other 默认可以放），但补一条，不是
  // 「大概率」。
  //
  // 修复轮 2 复审①指出：第一版这里从 8/20（idx24）往「7/31」（idx4，前面
  // outside 区间 idx0-4 的最后一格，紧挨着 8/1 那个边界）拖，`fcDragEvent`
  // 的坐标漂移让它实际落在了「8/1」——一个普通的当月格，不是 outside。
  // 第一版的断言只查了「预期目标格」（towardIdx 对应的 7/31）是不是
  // fc-day-other，从来没查拖拽真的落到了哪一格，所以这个漂移没能让测试
  // 变红——它测的其实是「拖到某个普通日子」，跟旁边那条测试重复，对
  // outside 格零覆盖。
  //
  // 两处都改：① 断言改查**实际落点**（从 onDropOnDay 收到的 droppedKey
  // 反查那个格子的 class），不是查预期目标。② 目标格从「outside 区间贴着
  // 边界的那一格」换成「outside 区间中间的那一格」——漂移量实测下来大致
  // 是 1 格左右，不随拖拽距离变大（8/20→8/21 一格距离漂移到 8/22，
  // 8/20→7/31 二十格距离漂移到 8/1，都是差 1 格），贴着边界的格子差 1 格
  // 就会漂出 outside 范围，中间的格子有余量。月末尾行 idx36-41 是 9 月
  // （outside），选中间的 idx38（9/3）当目标、8/28（idx32，同样落在这一批
  // outside 区间附近但本身是当月）当来源，即使漂移 ±1 也还落在 idx36-41
  // 这个 outside 范围内。
  //
  // 这样不管坐标漂移落到哪一格，只要实际落点真的是 outside，这条测试才算
  // 真的测到了「outside 格能不能放」；如果哪天 FullCalendar 把 outside 格
  // 设成不可放（`eventAllow` 之类返回 false），拖拽会被 revert，
  // `onDropSpy` 收不到调用，`waitFor` 超时——这条测试会红。
  it('拖到 outside 的格子（上个月/下个月的日子）照样能改期——断言查实际落点，目标格选在 outside 区间中段避开坐标漂移', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-28T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} onDropSpy={onDropSpy} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')];
    const fromIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-28');
    const towardIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-09-03');
    const eventEl = container.querySelector('.fc-daygrid-event')!;

    fcDragEvent(eventEl, fromIdx, towardIdx);
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    const [droppedId, droppedKey] = onDropSpy.mock.calls[0];
    expect(droppedId).toBe('a');
    expect(droppedKey).not.toBe('2026-08-28');
    expect(droppedKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 真正的断言：实际落点那一格是 outside（不是预期目标格）。
    const landedCell = cells.find((c) => c.getAttribute('data-date') === droppedKey);
    expect(landedCell, `落点 ${droppedKey} 对应的格子在 DOM 里找不到`).not.toBeUndefined();
    expect(landedCell!.classList.contains('fc-day-other'), `实际落点 ${droppedKey} 不是 outside 格——坐标漂移落到了当月格，这条测试没有测到 outside 格能不能放`).toBe(true);
  });

  // C1（复审 Critical）：`editable` 同时打开拖动和缩放（FullCalendar 的
  // API 语义，`eventStartEditable` 只管起点能不能拖，不关缩放）——没有
  // `eventDurationEditable={false}` 的话事件块会带 `fc-event-resizable`，
  // 真渲染出 `.fc-event-resizer`（悬停显出来），拖右边缘触发 `eventResize`，
  // 而这里没接对应 handler，`Task` 也没有时长字段，接不住这个交互出口。
  it('给了 onDropOnDay：事件块不带 fc-event-resizable，没有 .fc-event-resizer——eventDurationEditable={false} 关掉缩放，Task 没有时长字段接不住这个交互（C1）', () => {
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} hasDropHandler />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    expect(eventEl.classList.contains('fc-event-resizable')).toBe(false);
    expect(container.querySelector('.fc-event-resizer')).toBeNull();
  });

  it('没有真的产生移动（mousedown 后原地立刻 mouseup，没超过 eventDragMinDistance）：拖拽根本不会开始，onDropOnDay 不会被调用', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} onDropSpy={onDropSpy} />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    const p = fcCellCenter(24); // 2026-08-20 那一格（idx 24，7/27 起）
    fireEvent.mouseDown(eventEl, { button: 0, clientX: p.x, clientY: p.y });
    fireEvent.mouseUp(document, { button: 0, clientX: p.x, clientY: p.y });
    await new Promise((r) => setTimeout(r, 50));
    expect(onDropSpy).not.toHaveBeenCalled();
  });

  it('没给 onDropOnDay：事件块不带 fc-event-draggable，格子不可编辑——不需要真的模拟一次拖拽才能验证这半，是 editable prop 的静态渲染结果', () => {
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} hasDropHandler={false} />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    expect(eventEl.classList.contains('fc-event-draggable')).toBe(false);
  });

  it('给了 onDropOnDay：事件块带 fc-event-draggable——上面那条的对照组，确认「不给就没有」不是巧合，是这个 class 真的跟 onDropOnDay 挂钩', () => {
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} hasDropHandler />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    expect(eventEl.classList.contains('fc-event-draggable')).toBe(true);
  });

  // task-4 收尾轮踩过的坑，task-5-brief 明确点名不能退回去：拖拽提示以前
  // 挂在整张网格容器上，悬停格子任何空白处都会弹出这句 60 字；现在挂在
  // 日期数字（.ink-cal-daynum）这个叶子节点上，格子本身和它到根的每一层
  // 祖先都不该再挂这个 title。
  it('拖拽提示挂在日期数字上（.ink-cal-daynum），不是整张格子——悬停格子本身/祖先都不会带出这句话', () => {
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} hasDropHandler />);
    const daynum = container.querySelector('.ink-cal-daynum');
    expect(daynum, '.ink-cal-daynum 不见了').not.toBeNull();
    expect(daynum!.getAttribute('title'))
      .toBe('拖动任务到别的日期，钟点不变；提醒时间不会跟着挪，还在原来那一刻响。');
    const cell = container.querySelector('.fc-daygrid-day')!;
    expect(cell.hasAttribute('title')).toBe(false);
    expect(cell.closest('[title]')).toBeNull();
  });

  it('没给 onDropOnDay：日期数字上没有这句拖拽提示——跟旧实现同一个开关', () => {
    const tasks = [task({ id: 'a', title: 'Task A', due: '2026-08-20T18:30:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} hasDropHandler={false} />);
    const daynum = container.querySelector('.ink-cal-daynum');
    expect(daynum, '.ink-cal-daynum 不见了').not.toBeNull();
    expect(daynum!.getAttribute('title')).toBeNull();
  });
});

// I3（复审 Important，第三次「换渲染路径丢能力」）：旧实现 .ink-cal-tasktitle
// 带 title={t.title}，有专门测试守「标题被截断，鼠标悬停能看到全文」——这条
// 换成 FullCalendar 之后没有对应的新测试，实测过（复审指出）新实现悬停任何
// 地方都读不到全文，而 .fc-event-title 又加了 overflow:hidden/ellipsis 会
// 真的截断长标题，截断的部分从此没有办法看到。补 eventDidMount 把 title
// 挂回事件块本身，这里补对应的测试。
describe('CalendarFull：任务块悬停看全文（title 属性，I3）', () => {
  it('长标题会被截断显示，但事件块自己的 title 属性是完整原文——悬停能看到全文', () => {
    const longTitle = '这是一个很长很长很长很长的任务标题，格子里那一行放不下';
    const tasks = [task({ id: 'a', title: longTitle, due: '2026-08-20T09:00:00.000Z' })];
    const { container } = render(<Harness initialTasks={tasks} />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    expect(eventEl.getAttribute('title')).toBe(longTitle);
    // 截断的样式没有被顺手删掉——这条测试要跟「有 title 属性」同时成立，
    // 不然「加了 title」反而可能是以「取消截断」为代价换来的。
    expect(container.querySelector('.fc-event-title')!.textContent).toBe(longTitle);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// task-6：周/日视图，FullCalendar 的 timeGridWeek/timeGridDay——手写的
// CalendarHours 退役。
//
// **这一段测试能覆盖到什么、覆盖不到什么，先说清楚（brief 明确要求）**：
//
// ① 表头（`.fc-col-header-cell`）——点击/键盘都是 `CalendarFull.tsx` 自己接
//    的 `addEventListener`，不经过 FullCalendar 的指针交互引擎，`fireEvent.
//    click`/`fireEvent.keyDown` 直接测，不需要假布局。
// ② 全天带（`.fc-daygrid-day`，跟月视图共用同一套 dayGrid 组件）——点选/
//    拖拽/「+N」都实测过用现成的 `installFullCalendarFakeLayout` 能测出来，
//    跟月视图同一条路。
// ③ 「+N」（`.fc-timegrid-more-link`，同一小时堆的任务超过 eventMaxStack）
//    ——实测过：`MoreLinkClicking` 走的是普通 `click`，不经过坐标命中引擎，
//    `installFullCalendarFakeLayout` 装好之后直接 `fireEvent.click` 就测得
//    出来，不需要额外的小时槽专用假布局。
// ④ **小时槽本身（不是「+N」）的点选/拖拽测不出来**——`DateClicking`/
//    `EventDragging` 在小时槽这一半靠 `TimeCols.queryHit`，它要读两份坐标
//    缓存：`slatCoords`（24 行，靠 `TimeColsSlats` 组件测「自己隐藏没有」
//    ——`rootEl.offsetHeight`，jsdom 对任何元素恒为 0，不垫一个非零值这份
//    缓存永远建不出来，`test-utils.tsx` 的 `installFullCalendarFakeLayout`
//    已经在 task-6 里补了这个垫片，避免同页面里 `TimeCols` 被连带查询时抛
//    "Cannot read properties of null (reading 'positions')"）；`colCoords`
//    （决定"拖到哪一列"，靠 `TimeColsContent.updateCoords()`，它的开关是
//    `props.clientWidth !== null`，这个 `clientWidth` 在真实浏览器里由
//    `ResizeObserver` 量出来——这个仓库 `test-setup.ts` 给 `ResizeObserver`
//    打的是一个 `observe(){}` 什么都不做的空壳，回调永远不触发，
//    `clientWidth` 永远停在初始值）。逐层加探针实测过（`Emitter.trigger`/
//    `PositionCache.leftToIndex`/`topToIndex`）：`PointerDragging` 自己的
//    `pointerdown`/`pointerup` 确实在走，但 `HitDragging` 那一层的
//    `pointerdown`/`hitchange` 从未触发，`PositionCache.leftToIndex`/
//    `topToIndex` 实测**从未被调用过**——`initialHit` 恒 `null`，不是"测试
//    姿势不对"，是这条链路在这个仓库当前的 jsdom + ResizeObserver 空壳
//    组合下走不通。这不是"这个测不了"的反射性判断（brief 明确警告过这个
//    仓库在这一批已经错判了四次）——花了远超十分钟的时间实测排查：垫
//    `offsetHeight` 之后崩溃消失、`pageX`/`pageY`确认是 jsdom 从 `clientX`
//    正确派生的（不是没传）、全天带跟小时槽两个交互组件的裁剪范围冲突的
//    假设也排除过（分开给两者互不重叠的假矩形，结果不变）、最后用
//    `PositionCache.prototype.leftToIndex`/`topToIndex` 打了直接的调用计数
//    探针，实锤这条方法从未被调用——这是一条动手验证过的边界，不是猜的。
// ⑤ 小时级的精确渲染定位（"9 点的任务是不是真的画在第 9 行"）在旧实现
//    （`CalendarHours.tsx`）里能测，是因为那是手写的 24 个独立 `<div>`
//    小时格，每小时一个 DOM 节点，直接数格子。FullCalendar 的 timeGrid**没
//    有**逐小时的 DOM 节点——一天只有一个 `.fc-timegrid-col`（整列高
//    960px），事件靠内联 `top`/`height`（从 slatCoords 换算）绝对定位在
//    这一列内部，`slatCoords` 本身又依赖④说的那份 ResizeObserver 驱动的
//    测量管线（实测过：不垫 `colCoords` 相关的 `clientWidth` 度量，`top`/
//    `height` 内联样式要么是空字符串要么退化成一样的值，读不出真实的按
//    小时定位）。这一段测的是"这条任务出现在哪一天的时间轴列里"（结构层，
//    靠事件所在的 `.fc-timegrid-col`/`.fc-timegrid-col-events` 祖先关系
//    判断），不是"出现在第几行"——前者是 task-6 真正要接住的能力（月视图
//    换 FullCalendar 已经证明"格子里有没有这条任务"能测，这次新增的是
//    "有没有时间维度"，即 all-day/timed 两个区域分对了没有，见下面
//    isAllDay 那组测试），后者旧实现能测、这次测不出来，如实记进
//    task-6-report。
// ═══════════════════════════════════════════════════════════════════════

describe('CalendarFull：周/日结构——列数、24 小时槽、表头格式（task-6）', () => {
  it('周视图 7 列时间轴（.fc-timegrid-col，不含轴列），日视图 1 列', () => {
    const { container: weekC } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    expect([...weekC.querySelectorAll('.fc-timegrid-col')].filter((c) => !c.classList.contains('fc-timegrid-axis'))).toHaveLength(7);

    const { container: dayC } = render(<WeekDayHarness days={DAY_DAYS()} />);
    expect([...dayC.querySelectorAll('.fc-timegrid-col')].filter((c) => !c.classList.contains('fc-timegrid-axis'))).toHaveLength(1);
  });

  it('全天带用跟月视图同一套 dayGrid 组件——.fc-daygrid-day 数量等于列数', () => {
    const { container: weekC } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    expect(weekC.querySelectorAll('.fc-daygrid-day')).toHaveLength(7);
    const { container: dayC } = render(<WeekDayHarness days={DAY_DAYS()} />);
    expect(dayC.querySelectorAll('.fc-daygrid-day')).toHaveLength(1);
  });

  // **上限：两档各包各的那层高度壳。** task-7 删死 CSS 时保留了
  // `.ink-cal-timegrid`，理由是「还在渲染」——整分支审查实测：把
  // `CalendarFull.tsx` 那个 className 拿掉，**全量 1930 条全绿**，而
  // `theme.css.test.ts` 照样断言这条规则存在、照样把它算进「9 条」。
  //
  // 那条规则是周/日滚动壳的 `height: min(60vh, 960px)`——没有它，
  // FullCalendar 的 `height="100%"` 会对着一个 auto 高度的父元素解析，
  // 真实浏览器里是可见的布局塌陷。**jsdom 不做布局所以看不见塌陷，
  // 但看得见 class**，所以这条守得住。
  //
  // 跟 task-7 保留的另外八条对比：它们各自都有渲染点的守卫（整分支审查
  // 逐条打过变异），只有这一条没有——不是普遍缺口，就这一条。
  it('周/日包 .ink-cal-timegrid，月视图包 .ink-cal-monthgrid——两个类名不许串门，上限', () => {
    const { container: weekC } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    expect(weekC.querySelector('.ink-cal-timegrid')).not.toBeNull();
    expect(weekC.querySelector('.ink-cal-monthgrid')).toBeNull();
    const { container: dayC } = render(<WeekDayHarness days={DAY_DAYS()} />);
    expect(dayC.querySelector('.ink-cal-timegrid')).not.toBeNull();

    // 月视图现在也有壳，但是**另一个类**：周/日那层内部会滚（24 小时装不下），
    // 月那层不滚（六行等分，装不下的走 `+N`）。串了名字两套溢出会打架。
    const { container: monthC } = render(<Harness initialTasks={[]} />);
    expect(monthC.querySelector('.ink-cal-monthgrid')).not.toBeNull();
    expect(monthC.querySelector('.ink-cal-timegrid')).toBeNull();
  });

  // 整分支审查 F1 同一条纪律（parked-all.md 第 123 条）：机器可读的那份
  // （`data-time`）和人看得见的那份（小时刻度文本）是同一个节点上的两个
  // 属性，只守前者守不住后者——24 行逐行核对文本，不是只查存在。
  it('开了「显示全天 24 小时」：24 行小时刻度，文本两位数补零，逐行核对——不是只查 data-time', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    const labels = [...container.querySelectorAll('.fc-timegrid-slot-label')];
    expect(labels).toHaveLength(24);
    labels.forEach((el, h) => {
      expect(el.textContent, `第 ${h} 行`).toBe(String(h).padStart(2, '0'));
    });
  });

  // 表头文本格式沿用退役前 CalendarHours.tsx 的"星期几 日期"，逐列核对——
  // 不是只查第 0 列（parked-all.md 反复出现的坑）。
  it('表头逐列是「星期几 日期」，不是 FullCalendar 默认的英文格式', () => {
    const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
    const days = WEEK_DAYS();
    const { container } = render(<WeekDayHarness days={days} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    expect(heads).toHaveLength(7);
    days.forEach((d, i) => {
      expect(heads[i].textContent).toContain(WEEKDAY_CHARS[d.date.getDay()]);
      expect(heads[i].textContent).toContain(String(d.date.getDate()));
    });
  });
});

describe('CalendarFull：isAllDay 启发式接给 FullCalendar 的 allDay 字段（task-6 要点①）', () => {
  it('due 时分秒毫秒全为 0：事件落在全天带（.fc-daygrid-day），不进时间轴列', () => {
    const t = task({ id: 'a', title: '全天任务', due: new Date(2026, 7, 11, 0, 0, 0, 0).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    // 方向一：全天带里有它（跟月视图共用 .fc-daygrid-event 这个类）。
    const alldayCell = [...container.querySelectorAll('.fc-daygrid-day')].find((c) => c.getAttribute('data-date') === '2026-08-11')!;
    expect(alldayCell.querySelectorAll('.fc-daygrid-event')).toHaveLength(1);
    // 方向二（上限）：时间轴列里没有它——不是全天带有、时间轴列也重复画了一份。
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(0);
  });

  it('due 带具体时刻（9 点）：事件落在时间轴列（.fc-timegrid-event），不进全天带', () => {
    const t = task({ id: 'a', title: '按时任务', due: new Date(2026, 7, 11, 9, 0, 0, 0).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(1);
    expect(container.querySelectorAll('.fc-daygrid-event')).toHaveLength(0);
  });

  // 上限的边界：0 点但带非零分钟——isAllDay() 的判据是时/分/秒/毫秒全为 0，
  // 0:30 分钟不是 0，不该被误判成全天。这条钉住 allDay 字段真的是算出来的，
  // 不是「只要小时是 0 就当全天」这种更粗的近似。
  it('due 是 0 点半（分钟非 0）：不算全天，落在时间轴列', () => {
    const t = task({ id: 'a', title: '半夜半小时', due: new Date(2026, 7, 11, 0, 30, 0, 0).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(1);
    expect(container.querySelectorAll('.fc-daygrid-event')).toHaveLength(0);
  });

  it('哪一天：事件出现在正确的那一列（.fc-timegrid-col 的祖先关系），不是恒定第一列', () => {
    const t = task({ id: 'a', title: '周三的事', due: new Date(2026, 7, 12, 9).toISOString() }); // 8/12 周三，days[2]
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    const cols = [...container.querySelectorAll('.fc-timegrid-col')].filter((c) => !c.classList.contains('fc-timegrid-axis'));
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    const hostCol = cols.find((c) => c.contains(eventEl));
    expect(hostCol?.getAttribute('data-date')).toBe('2026-08-12');
    // 上限：别的列没有这条事件。
    cols.filter((c) => c !== hostCol).forEach((c) => {
      expect(c.querySelectorAll('.fc-timegrid-event')).toHaveLength(0);
    });
  });
});

// 实测过：这一组（不管是时间轴的 eventMaxStack 还是全天带的 dayMaxEvents）
// 在周/日视图下都要垫 `installFakeLayout()`（本文件顶部那份，task-6 补了
// `offsetHeight` 那道垫片）——不垫的话 more-link 恒不出现。这跟月视图那组
// 同名断言（84-121 行）不需要垫布局不是同一个情况：`nowIndicatorTop`/
// `eventMaxStack` 的堆叠判定要读 `slatCoords`（判断"这几条是不是叠在同一段
// 时间"要有真实的时间-像素换算），而月视图的 `dayMaxEvents` 纯按条数切，
// 从不读任何坐标缓存——同一个"还有 N 条"机制，两档视图背后走的不是同一条
// 计算路径，这也是本节头顶注释④说的"小时槽这半依赖度量管线"在**统计条数**
// 这个子问题上的体现（不是"点/拖测不出来"那个子问题，这次是纯渲染，垫了
// 布局就测得出来，不用改成不测）。
describe('CalendarFull：一格摆几条随几列变——日 3 条 / 周 1 条（task-6，跟月视图共用 MAX_VISIBLE_TASKS 的思路）', () => {
  // 日视图只显示 ANCHOR 那一天本身（2026-08-16），周视图显示那一周
  // （8/10-8/16）——两档用不同的日子造夹具，别把「周视图随手挑的 8/11」
  // 抄进日视图（那样任务落不进日视图唯一的那一天，`calendarDays` 直接把它
  // 挡在格子外面，会得到「什么都没渲染」而不是「渲染出来但摆不下」这种
  // 更隐蔽的假失败）。
  const tasksAt = (n: number, hour: number, day = 11) =>
    Array.from({ length: n }, (_, i) => task({ id: `t${i}`, title: `任务${i}`, due: new Date(2026, 7, day, hour).toISOString() }));

  it('日视图：4 条同一小时，3 条可见 + 「+1」——时间轴的「+N」是 FullCalendar 自己的紧凑格式，不走 moreLinkText（见下面周视图那条的注释）', () => {
    installFakeLayout();
    const { container } = render(<WeekDayHarness days={DAY_DAYS(tasksAt(4, 9, 16))} />);
    const more = container.querySelector('.fc-timegrid-more-link');
    expect(more, '「+N」链接不见了').not.toBeNull();
    expect(more!.textContent).toBe('+1');
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(MAX_VISIBLE_TASKS);
  });

  it('日视图：恰好 3 条（边界）不出现「还有」，3 条全部可见', () => {
    installFakeLayout();
    const { container } = render(<WeekDayHarness days={DAY_DAYS(tasksAt(3, 9, 16))} />);
    expect(container.querySelector('.fc-timegrid-more-link')).toBeNull();
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(3);
  });

  // 时间轴那半的「+N」（`.fc-timegrid-more-link`）实测过：`moreLinkText`
  // 这条自定义（"还有 N 条"）只吃得到 dayGrid 驱动的那两处（月格/全天带的
  // `.fc-daygrid-more-link`）——`TimeColMoreLink` 走的是它自己的
  // `renderMoreLinkInner`（`props.shortText`），不经过 `moreLinkText` 选项，
  // 渲染出来是 FullCalendar 自己的紧凑格式 `+N`。这恰好跟退役前
  // `CalendarHours.tsx` 的 `.ink-calh-more`（`+{overflow}`）是同一种写法，
  // 不是需要额外翻译的英文单词（跟月视图当初要压的 "5 more" 不是同一类
  // 问题）——这里断言的是这个真实格式，不是想当然地套用 moreLinkText。
  it('周视图：同样 4 条同一小时，只画 1 条 + 「+3」——不是日视图那档的 3 条上限，也不是 moreLinkText 那份"还有 N 条"（时间轴的 +N 不走这条自定义）', () => {
    installFakeLayout();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS(tasksAt(4, 9))} />);
    const more = container.querySelector('.fc-timegrid-more-link');
    expect(more, '「+N」链接不见了').not.toBeNull();
    expect(more!.textContent).toBe('+3');
    expect(container.querySelectorAll('.fc-timegrid-event')).toHaveLength(1);
  });

  it('全天带同一条规则：日视图 4 条全天任务只画 3 条 + 「+1」', () => {
    installFakeLayout();
    const allDay4 = Array.from({ length: 4 }, (_, i) => task({ id: `a${i}`, title: `全天${i}`, due: new Date(2026, 7, 16, 0).toISOString() }));
    const { container } = render(<WeekDayHarness days={DAY_DAYS(allDay4)} />);
    const more = container.querySelector('.fc-daygrid-more-link');
    expect(more, '全天带「+N」链接不见了').not.toBeNull();
    expect(more!.textContent).toBe('+1');
  });
});

describe('CalendarFull：表头日期格是键盘可达的可点元素（own listener，不需要假布局，task-6）', () => {
  it('点表头选中这一天——恰好一次，跟 onDropOnSlot 无关', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    fireEvent.click(heads[3]);
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
    expect(onSelectDaySpy).toHaveBeenCalledWith(WEEK_DAYS()[3].key);
  });

  it('键盘 Enter 选中这一天', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    fireEvent.keyDown(heads[2], { key: 'Enter' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
    expect(onSelectDaySpy).toHaveBeenCalledWith(WEEK_DAYS()[2].key);
  });

  it('键盘 Space 同样能选中；别的键（比如字母 a）不触发', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const head = container.querySelectorAll('.fc-col-header-cell')[0];
    fireEvent.keyDown(head, { key: ' ' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(head, { key: 'a' });
    expect(onSelectDaySpy).toHaveBeenCalledTimes(1);
  });

  it('表头 tabIndex 都是 0——键盘 Tab 挨个停得到', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')] as HTMLElement[];
    expect(heads).toHaveLength(7);
    for (const h of heads) expect(h.tabIndex).toBe(0);
  });

  it('多天夹具下点第二列，onSelectDay 收到第二天的 key，不是恒定的 days[0]', () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    fireEvent.click(heads[1]);
    expect(onSelectDaySpy).toHaveBeenCalledWith(WEEK_DAYS()[1].key);
  });

  it('拖拽说明只挂在表头（onDropOnSlot 存在时），不是常驻——跟月格拖拽提示不是同一句', () => {
    const { container: without } = render(<WeekDayHarness days={WEEK_DAYS()} hasDropHandler={false} />);
    expect(without.querySelector('.fc-col-header-cell')!.querySelector('[title]')).toBeNull();

    const { container: given } = render(<WeekDayHarness days={WEEK_DAYS()} hasDropHandler />);
    const hint = given.querySelector('.fc-col-header-cell')!.querySelector('[title]')?.getAttribute('title');
    expect(hint).toBe('拖动任务到某个时刻，就把它排到那一刻；提醒时间不会跟着挪，还在原来那一刻响。');
    // 跟月格那句原文不相等——单独写的，不是复制。
    expect(hint).not.toBe('拖动任务到别的日期，钟点不变；提醒时间不会跟着挪，还在原来那一刻响。');
  });

  // 修复轮 1（复审 I3）：这句提示只该挂在表头，悬停时间轴列本身（小时槽那一
  // 大片可滚动区域）不该弹出来——跟月格 `cell.closest('[title]')` 同一条
  // 上限写法，之前这半没测，只测了"表头有/没有"。
  it('上限：悬停时间轴列本身（不是表头）不会弹出这句话——格子和它的祖先都不挂这个 title', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} hasDropHandler />);
    const col = [...container.querySelectorAll('.fc-timegrid-col')].filter((c) => !c.classList.contains('fc-timegrid-axis'))[0];
    expect(col.getAttribute('title')).toBeNull();
    expect(col.closest('[title]')).toBeNull();
  });
});

describe('CalendarFull：今天/选中标在表头——跟月格共用同一条 --fc-today-bg-color 映射（task-6）', () => {
  it('.fc-day-today 出现在今天（NOW）那一列的表头上——原生能力，不需要自己判断', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    const todayHead = heads.find((h) => h.classList.contains('fc-day-today'));
    expect(todayHead?.getAttribute('data-date')).toBe(dayKey(ANCHOR));
  });

  it('点一列：.ink-cal-day-selected + aria-current="date" 出现在表头，且只有那一列', async () => {
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    fireEvent.click(heads[4]);
    await waitFor(() => expect(container.querySelectorAll('.ink-cal-day-selected')).toHaveLength(1));
    expect(heads[4].classList.contains('ink-cal-day-selected')).toBe(true);
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
    expect(heads[4].getAttribute('aria-current')).toBe('date');
  });

  it('再点另一列：标记跟着挪，不是叠加——响应式更新，不是只在挂载那一刻生效一次', async () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} />);
    const heads = [...container.querySelectorAll('.fc-col-header-cell')];
    fireEvent.click(heads[1]);
    await waitFor(() => expect(container.querySelectorAll('.ink-cal-day-selected')).toHaveLength(1));
    fireEvent.click(heads[5]);
    await waitFor(() => expect(heads[1].classList.contains('ink-cal-day-selected')).toBe(false));
    expect(heads[5].classList.contains('ink-cal-day-selected')).toBe(true);
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
  });
});

describe('CalendarFull：全天带点选/拖拽——复用月视图同一套假布局（task-6）', () => {
  it('点全天带某一格：选中那一天', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} onSelectDaySpy={onSelectDaySpy} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')];
    const targetIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-12');
    fcClickCell(cells[targetIdx], fcCellCenter(targetIdx));
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith('2026-08-12');
  });

  it('拖一条全天任务到另一天的全天带：onDropOnSlot 收到目标日期的 key 和 "allday"', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const t = task({ id: 'a', title: '全天任务', due: new Date(2026, 7, 11, 0).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onDropSpy={onDropSpy} />);
    const cells = [...container.querySelectorAll('.fc-daygrid-day')];
    const fromIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-11');
    const towardIdx = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-13');
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    fcDragEvent(eventEl, fromIdx, towardIdx);
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    const [droppedId, droppedKey, droppedHour] = onDropSpy.mock.calls[0];
    expect(droppedId).toBe('a');
    expect(droppedHour).toBe('allday');
    expect(droppedKey).not.toBe('2026-08-11');
    expect(droppedKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('点全天带「+N」：选中那一天，不弹 popover', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const allDay4 = Array.from({ length: 4 }, (_, i) => task({ id: `a${i}`, due: new Date(2026, 7, 11, 0).toISOString() }));
    const { container } = render(<WeekDayHarness days={WEEK_DAYS(allDay4)} onSelectDaySpy={onSelectDaySpy} />);
    const more = container.querySelector('.fc-daygrid-more-link')!;
    fireEvent.click(more);
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith('2026-08-11');
    expect(container.querySelector('.fc-popover')).toBeNull();
  });

  // 时间轴那半的「+N」（.fc-timegrid-more-link）走的是同一个 MoreLinkClicking
  // 机制——实测过它是普通 click，不经过 TimeCols 那条走不通的坐标命中链路
  // （见本节头顶的长注释④），可以直接测。
  it('点时间轴「+N」：选中那一天，不弹 popover', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const tasks4 = Array.from({ length: 4 }, (_, i) => task({ id: `t${i}`, due: new Date(2026, 7, 11, 9).toISOString() }));
    const { container } = render(<WeekDayHarness days={WEEK_DAYS(tasks4)} onSelectDaySpy={onSelectDaySpy} />);
    const more = container.querySelector('.fc-timegrid-more-link')!;
    fireEvent.click(more);
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith('2026-08-11');
    expect(container.querySelector('.fc-popover')).toBeNull();
  });
});

/**
 * 修复轮 1（复审 C1）：上一轮这里写着"小时槽本身的点/拖在这个仓库的 jsdom
 * 测试环境下走不通，根因是 ResizeObserver 被桩成空壳"——**这句话是错的**，
 * 逐条实测纠正过（见 `test-utils.tsx` `installFullCalendarFakeLayout` 头顶
 * 的长注释）：FullCalendar 6.1.21 压根不用 `ResizeObserver`（`grep` 零命中），
 * 真正的卡点是这个函数自己只垫了 `offsetHeight` 没垫 `clientHeight`，让
 * `computeScrollbarWidthsForEl` 算出一条假的 960px"滚动条"，把 timeGrid
 * 区域的坐标裁在了 clipping 范围外——垫上 `clientHeight` 之后，`TimeCols.
 * queryHit` 完全走得通，而且比全天带/月格还准（事件块给了自己那一格的
 * 矩形，`useSubjectCenter` 碰撞校准不会把落点拖偏），下面这组测试断言的都
 * 是**精确落点**，不是"往哪个方向拖"这种退让写法。
 */
describe('CalendarFull：时间轴（小时槽）点选/拖拽——修复轮 1，之前判断错了，现在真的测得出来（task-6 要点①②③、C1/C2）', () => {
  it('拖一条 9 点的任务到另一天的 14 点：onDropOnSlot 收到精确的目标日期和小时（假布局坐标映射保证的精确，不是验证 FullCalendar 真实像素下的鲁棒性，见 test-utils.tsx 的说明）', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const t = task({ id: 'a', title: '看医生', due: new Date(2026, 7, 11, 9).toISOString() }); // 8/11，col1
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onDropSpy={onDropSpy} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    fcTimeGridDrag(eventEl, { colIdx: 1, hour: 9 }, { colIdx: 3, hour: 14 }); // col3 = 8/13
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    // 精确断言，不是"合法的某个小时"——这条顺带钉住 eventDrop 里
    // allDay/hour 判断没有被写死成某个常量（比如恒 0）。
    expect(onDropSpy).toHaveBeenCalledWith('a', '2026-08-13', 14);
  });

  it('拖回原地（同一天同一小时）不发回调', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onDropSpy={onDropSpy} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    fcTimeGridDrag(eventEl, { colIdx: 1, hour: 9 }, { colIdx: 1, hour: 9 });
    await new Promise((r) => setTimeout(r, 100));
    expect(onDropSpy).not.toHaveBeenCalled();
  });

  // 复审（修复轮 2）挖出的真回归：`wasNoop` 判"原地"要求两维都不变
  // （天 + 小时），退役前 CalendarHours.test.tsx 第 347 行原文就叫
  // 「同一个小时数字、不同的一天：不是原地，照样发回调——『原地』是两维
  // 都不变，缺一维就不算」。上一轮误判成"低风险部分覆盖"，实际是零覆盖：
  // 有人在 `wasNoop` 按时分支里手滑漏掉日期比较（只比小时，不比天），
  // 现有测试全绿接不住——跟「拖到同一天不同小时」是同一类回归，缺的是
  // 「同一小时不同天」这另一半。
  it('同一个小时数字、不同的一天：不是原地，照样发回调——「原地」是两维都不变，缺一维就不算', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() }); // col1 = 8/11
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onDropSpy={onDropSpy} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    fcTimeGridDrag(eventEl, { colIdx: 1, hour: 9 }, { colIdx: 3, hour: 9 }); // col3 = 8/13，同样 9 点
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    expect(onDropSpy).toHaveBeenCalledWith('a', '2026-08-13', 9);
  });

  it('拖到同一天的 0 点那个小时格（不是全天带）：onDropOnSlot 收到的第三个参数是数字 0，不是 "allday"——两者算出来的 due 相同，但这里转发的是 eventDrop 真实读到的 allDay 字段，不是猜的', async () => {
    installFakeLayout();
    const onDropSpy = vi.fn();
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onDropSpy={onDropSpy} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    fcTimeGridDrag(eventEl, { colIdx: 1, hour: 9 }, { colIdx: 1, hour: 0 });
    await waitFor(() => expect(onDropSpy).toHaveBeenCalledTimes(1));
    expect(onDropSpy).toHaveBeenCalledWith('a', '2026-08-11', 0);
  });

  // 修复轮 1 · C-1（原回归）：日视图/周视图某小时格只有 1 条任务（没有溢出，
  // 冒不出「+N」）时，点这一格本身也能选中这一天——之前误判成测不出来，
  // 留了个空的 it.skip。
  it('点一个没有溢出的小时格（只有 1 条任务，冒不出「+N」）也能选中这一天', async () => {
    installFakeLayout();
    const onSelectDaySpy = vi.fn();
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() }); // col1 = 8/11
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} onSelectDaySpy={onSelectDaySpy} />);
    // 没有溢出，「+N」压根不存在。
    expect(container.querySelector('.fc-timegrid-more-link')).toBeNull();
    const cols = [...container.querySelectorAll('.fc-timegrid-col')].filter((c) => !c.classList.contains('fc-timegrid-axis'));
    const p = fcSlotPoint(4, 15); // 空白小时格，col4 = 8/14
    fireEvent.mouseDown(cols[4], { button: 0, clientX: p.x, clientY: p.y });
    fireEvent.mouseMove(document, { clientX: p.x, clientY: p.y });
    fireEvent.mouseUp(document, { button: 0, clientX: p.x, clientY: p.y });
    await waitFor(() => expect(onSelectDaySpy).toHaveBeenCalledTimes(1));
    expect(onSelectDaySpy).toHaveBeenCalledWith('2026-08-14');
  });

  // 修复轮 1：旧实现「9 点的任务只在 9 点那一行，不在 8 点也不在 10 点」的
  // 等价物——FullCalendar 没有逐小时的独立 DOM 节点，事件靠内联 top/height
  // 定位，这里直接读那两个值核对，不是猜"落对了大概位置"。
  it('9 点和 14 点的任务分别画在各自对应的高度上（内联 top 样式）——不是恒定位置，也不是互相串位', async () => {
    installFakeLayout();
    const t9 = task({ id: 'a', title: '九点', due: new Date(2026, 7, 11, 9).toISOString() });
    const t14 = task({ id: 'b', title: '十四点', due: new Date(2026, 7, 11, 14).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t9, t14])} />);
    await waitFor(() => expect(container.querySelectorAll('.fc-timegrid-event-harness').length).toBe(2));
    const harnesses = [...container.querySelectorAll('.fc-timegrid-event-harness')] as HTMLElement[];
    const nine = harnesses.find((h) => h.textContent?.includes('九点'))!;
    const fourteen = harnesses.find((h) => h.textContent?.includes('十四点'))!;
    // ROW_HEIGHT 已经退役（见 CalendarFull.tsx 顶部注释），这里不跟一个 JS
    // 常量比，直接跟 theme.css 里 `.fc-timegrid-slot { height: 40px }` 的
    // 字面值比——40px 是这两处唯一还活着的那份数字。
    expect(parseFloat(nine.style.top)).toBe(9 * 40);
    expect(parseFloat(fourteen.style.top)).toBe(14 * 40);
    // 上限：两者不相等，不是被压成了同一个值。
    expect(nine.style.top).not.toBe(fourteen.style.top);
  });
});

/**
 * 修复轮 1（复审 C3）：`scrollTargetHour` 现在导出了（见 CalendarFull.tsx
 * 那条函数头顶的注释——退役前 `CalendarHours.tsx` 不导出的理由是"有
 * `scrollIntoView` 这个可以 spy 的渲染层出口"，`scrollTime` 是纯配置 prop
 * 没有这个出口，理由已经不成立）。这里直接单测这个纯函数，7 条边界原样
 * 搬自退役前的 `CalendarHours.test.tsx`——少了一条（"滚动用的是 block:
 * 'center'"，那条测的是 `scrollIntoView` 的调用参数，`scrollTime` 没有
 * 对应的"block"概念，不适用了）。
 */
describe('scrollTargetHour：进来滚到第一条任务所在小时减一，没有就 8 点（task-6 修复轮 1 · C3）', () => {
  const oneDay = (key: string, dateArgs: [number, number, number], tasks: ReturnType<typeof task>[] = []) => ({
    key, date: new Date(...dateArgs), outside: false, tasks, marks: [],
  });

  it('有任务：目标是「第一条任务的小时减一」——14 点的任务对应 13 点，不是巧合撞上默认的 8 点', () => {
    const t = task({ id: 'a', due: new Date(2026, 7, 16, 14).toISOString() });
    const days = [oneDay('2026-08-16', [2026, 7, 16], [t])];
    expect(scrollTargetHour(days, new Date(2026, 7, 16, 12))).toBe(13);
  });

  it('一条任务都没有：目标是默认的 8 点', () => {
    const days = [oneDay('2026-08-16', [2026, 7, 16])];
    expect(scrollTargetHour(days, new Date(2026, 7, 16, 12))).toBe(8);
  });

  it('第一条任务在 0 点半：目标钉在 0，不会算出 -1', () => {
    // 0:30——分钟不是 0，不算全天（isAllDay 要求时分秒毫秒全为 0），落在
    // 0 点那个小时槽。
    const t = task({ id: 'a', due: new Date(2026, 7, 16, 0, 30).toISOString() });
    const days = [oneDay('2026-08-16', [2026, 7, 16], [t])];
    expect(scrollTargetHour(days, new Date(2026, 7, 16, 12))).toBe(0);
  });

  it('全天任务不算进「第一条任务所在的小时」——退回默认 8 点，不会被误判成 0 点再减一变成 -1', () => {
    const allDayTask = task({ id: 'a', due: new Date(2026, 7, 16, 0).toISOString() });
    const days = [oneDay('2026-08-16', [2026, 7, 16], [allDayTask])];
    expect(scrollTargetHour(days, new Date(2026, 7, 16, 12))).toBe(8);
  });

  it('今天不在 days 里：退回 days[0] 那一天，按它的第一条任务算目标小时', () => {
    const t = task({ id: 'a', due: new Date(2026, 7, 20, 10).toISOString() }); // 8/20 那天 10 点
    const days = [oneDay('2026-08-20', [2026, 7, 20], [t])];
    // now 是 8/16，不在 days 里。
    expect(scrollTargetHour(days, new Date(2026, 7, 16, 12))).toBe(9); // 10 点减一
  });

  it('days 是空数组：不崩，退回默认 8 点', () => {
    expect(scrollTargetHour([], new Date(2026, 7, 16, 12))).toBe(8);
  });
});

describe('CalendarFull：周/日视图的拖拽开关（editable/eventDurationEditable，不需要真的拖一次）', () => {
  it('给了 onDropOnSlot：时间轴事件带 fc-event-draggable，不带 fc-event-resizable/没有缩放手柄', () => {
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} hasDropHandler />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    expect(eventEl.classList.contains('fc-event-draggable')).toBe(true);
    expect(eventEl.classList.contains('fc-event-resizable')).toBe(false);
    expect(container.querySelector('.fc-event-resizer')).toBeNull();
  });

  it('没给 onDropOnSlot：时间轴事件不带 fc-event-draggable——跟旧实现「没给就不接管」同一个开关', () => {
    const t = task({ id: 'a', due: new Date(2026, 7, 11, 9).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} hasDropHandler={false} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    expect(eventEl.classList.contains('fc-event-draggable')).toBe(false);
  });
});

describe('CalendarFull：当前时刻线（nowIndicator，task-6）', () => {
  it('今天在这一批 days 里：.fc-timegrid-now-indicator-line 恰好出现一次，而且真的在今天那一列——不是随便哪一列（修复轮 1 · m3）', () => {
    // nowIndicatorTop 的计算要读 slatCoords（`props.slatCoords &&
    // props.slatCoords.safeComputeTop(...)`）——不垫 `offsetHeight` 那道
    // 垫片（installFakeLayout 里）slatCoords 恒为 null，线根本不会画出来，
    // 跟上一节「一格摆几条」同一条限制。
    installFakeLayout();
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} now={ANCHOR} />);
    const lines = container.querySelectorAll('.fc-timegrid-now-indicator-line');
    expect(lines).toHaveLength(1);
    // 上一版只查了"整棵树恰好一条"，没查"是哪一列"——每个 .fc-timegrid-col
    // 各自有一个 now-indicator-container，只有今天那一列真的塞了线，这里
    // 反查线所在的列，断言它的 data-date 就是 ANCHOR（8/16）。
    const hostCol = lines[0].closest('td.fc-timegrid-col');
    expect(hostCol?.getAttribute('data-date')).toBe(dayKey(ANCHOR));
  });

  it('今天不在这一批 days 里（日视图正显示别的日子）：一条线都不出现', () => {
    installFakeLayout();
    // ANCHOR 是 8/16，day 视图只显示 8/16 这一天本身——换一批不含 8/16 的
    // days（比如从别的锚点算出的某一天）来模拟"正显示着别的日子"，
    // `anchor` 必须跟 `days` 保持一致（FullCalendar 实际显示哪一天由
    // `initialDate`/`anchor` 决定，不是靠 `days` 猜出来的——两者不同步会
    // 得到"看起来是这个用例，实际测的是另一件事"的假结果，这里踩过一次）。
    const otherAnchor = new Date(2026, 7, 20, 12);
    const otherDay = calendarDays([], otherAnchor, 'day');
    const { container } = render(<WeekDayHarness days={otherDay} anchor={otherAnchor} now={ANCHOR} />);
    expect(container.querySelectorAll('.fc-timegrid-now-indicator-line')).toHaveLength(0);
  });

  it('月视图（timeMode 为 null）不开 nowIndicator——dayGrid 没有这个概念，不该画出这条线', () => {
    const { container } = render(<Harness initialTasks={[]} />);
    expect(container.querySelectorAll('.fc-timegrid-now-indicator-line')).toHaveLength(0);
  });
});

describe('CalendarFull：全天带的「+N」跟时间轴共用 MAX_VISIBLE_TASKS 语义之外，任务块悬停看全文（eventDidMount，两档视图共用同一个钩子）', () => {
  it('时间轴事件的 title 是完整原文——跟月视图 I3 同一条钩子，两档视图公用', () => {
    const longTitle = '这是一个足够长、时间轴那一列会把它裁掉的标题文字内容';
    const t = task({ id: 'a', title: longTitle, due: new Date(2026, 7, 11, 9).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    expect(eventEl.getAttribute('title')).toBe(longTitle);
  });

  it('全天带事件的 title 也是完整原文——跟月视图共用同一个 eventDidMount', () => {
    const longTitle = '这是一个足够长、全天带也会把它裁掉的标题文字内容';
    const t = task({ id: 'a', title: longTitle, due: new Date(2026, 7, 11, 0).toISOString() });
    const { container } = render(<WeekDayHarness days={WEEK_DAYS([t])} />);
    const eventEl = container.querySelector('.fc-daygrid-event')!;
    expect(eventEl.getAttribute('title')).toBe(longTitle);
  });
});

/**
 * 渲染层的群青断言——task-5-brief 明确要求的验收标准：静态扫描
 * （theme.css.test.ts 那半）只守得住「我们自己写的 .fc-* 规则/--fc-*
 * 变量映射」，守不住 FullCalendar 自己样式表里有没有硬编码颜色，这正是
 * antd colorPrimary 那个盲区漏过四轮的同一个形状（光扫、不渲染）。这里真的
 * 用 @testing-library/react 渲染一个带任务事件的 FullCalendar，同时让
 * FullCalendar 自己动态注入的 `<style data-fullcalendar>` 和这份 theme.css
 * 都在场，走一遍真实 CSS 层叠，读 getComputedStyle 算出来的颜色。
 *
 * FullCalendar 的 `injectStyles` 特意把自己的 `<style>` 插在 `<head>`
 * 里「第一个 script/link[rel=stylesheet]/style」前面（源码见
 * @fullcalendar/core/internal-common.js 的 `registerStylesRoot`）——这是
 * 它自己的设计：让用户样式表在文档顺序上总是排在后面、天然赢得同特异度的
 * 层叠。这里手动模拟同一个顺序：先渲染 FullCalendar（触发它自己插入
 * style），再把 theme.css 追加到 `<head>` 末尾（`appendChild`，保证排在
 * FullCalendar 那条后面）——顺序反了的话这组测试测的就是「谁先谁赢」这件
 * 事本身，不是真正的生产环境顺序。
 */
describe('CalendarFull：渲染层群青断言——真的渲染一个 FullCalendar，读实际计算出来的颜色', () => {
  const themeCss = readFileSync('web/src/theme.css', 'utf8');

  function renderWithRealTheme(cssText: string) {
    const { container } = render(<Harness initialTasks={[task({ id: 'a', title: '任务A', due: '2026-08-20T09:00:00.000Z' })]} />);
    const styleTag = document.createElement('style');
    styleTag.textContent = cssText;
    document.head.appendChild(styleTag);
    return { container, styleTag };
  }

  /**
   * jsdom 的 getComputedStyle 只负责算出「哪条声明赢了级联」，不会展开
   * `var()`——一条 `color: var(--fc-event-text-color)` 赢了之后，读到的
   * computed 值就是字面字符串 `"var(--fc-event-text-color)"`，不会继续
   * 帮你查 `--fc-event-text-color` 本身映射到什么（这个仓库另一条真级联层
   * 测试，theme.css.test.ts 的 `.ink-trow-due.ink-time-ai`，验证的正是
   * 「哪条赢了」这一层，不是这一层）。但自定义属性本身可以用
   * `getComputedStyle(el).getPropertyValue('--x')` 单独查到它的级联值。
   *
   * 复审 I1 抓到两个真漏洞，都改在这个函数里：
   * ① 原来的正则是 `^var\((--[\w-]+)\)$`——要求整个字符串**恰好**是
   *   `var(--x)`，`var(--nope, #2E3ED4)` 这种带 fallback 的写法（`--nope`
   *   没有声明、没有逗号就不匹配，`--nope, #2E3ED4` 那部分整个漏掉）不匹配，
   *   直接原样返回，群青从这条路径溜走。
   * ② 原来只在**整个属性值恰好是**一个 `var()` 引用时才展开，
   *   `color-mix(in srgb, var(--ink-you) 8%, transparent)` 这种「var() 只是
   *   更大表达式的一部分」的情况完全不触发展开——`--fc-today-bg-color`
   *   现在的映射正是这个形状，如果哪天被偷改成
   *   `color-mix(in srgb, var(--ink-ai) 8%, transparent)`，原来的正则
   *   连尝试展开都不会尝试。
   *
   * 改成全局替换：找出字符串里**所有** `var(...)` 出现的地方（不要求整个
   * 字符串就是一个 var() 引用），每个都查一次对应自定义属性的值（没有就退
   * 到 fallback），替换回原字符串里，再看这一轮有没有真的替换过东西——
   * 有就拿替换后的结果再做一轮（处理 `--a: var(--b)` 这种变量套变量的链），
   * 没有就到底了。`[^()]*(?:\([^()]*\)[^()]*)*` 允许 fallback 里出现一层
   * 嵌套括号（比如 `var(--x, rgba(0,0,0,.5))`），这个仓库目前的实际写法
   * 用不到更深的嵌套，不为假设中的情况多写解析器。
   */
  function resolveVarChain(el: Element, value: string, depth = 0): string {
    if (depth > 8) return value;
    const varPattern = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
    let replaced = false;
    const next = value.replace(varPattern, (whole, varName: string, fallback: string | undefined) => {
      const propValue = getComputedStyle(el).getPropertyValue(varName);
      if (propValue && propValue.trim()) { replaced = true; return propValue.trim(); }
      if (fallback !== undefined) { replaced = true; return fallback.trim(); }
      return whole; // 真的查无此变量、也没有 fallback——原样留着，交给下面的
      // 「还剩 var(」过滤器认成「没解析出具体颜色」，不是这个函数负责报错。
    });
    if (!replaced || next === value) return next;
    return resolveVarChain(el, next, depth + 1);
  }

  /** 全树扫一遍常见的携色属性，返回「元素 + 属性 + 值」三元组列表——值已经
   *  展开过 var() 链条，只收真的解析出了颜色的（跳过 'none'/'transparent'/
   *  空字符串/展开到底还剩 var() 引用的——后者说明这个自定义属性压根没被
   *  声明过、也没有 fallback，不构成一个具体的颜色判定）。
   *
   *  复审 I1：`boxShadow`/`fill`/`stroke`/`textDecorationColor` 是这一轮
   *  补的——FullCalendar 自己的 `.fc-event:focus{box-shadow:...}` 证明
   *  box-shadow 是库真的会用来传色的属性，原来的列表里没有它，塞群青进去
   *  静默通过。 */
  function collectColors(root: Element): Array<{ el: Element; prop: string; value: string }> {
    const props = [
      'color', 'backgroundColor', 'background',
      'borderColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
      'outlineColor', 'boxShadow', 'fill', 'stroke', 'textDecorationColor',
    ] as const;
    const out: Array<{ el: Element; prop: string; value: string }> = [];
    const walk = (el: Element) => {
      const cs = getComputedStyle(el);
      for (const prop of props) {
        const raw = cs[prop as keyof CSSStyleDeclaration] as unknown as string;
        if (!raw) continue;
        const v = resolveVarChain(el, raw);
        if (v && v !== 'none' && v !== 'transparent' && v !== '' && !v.includes('var(')) {
          out.push({ el, prop, value: v });
        }
      }
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(root);
    return out;
  }

  /**
   * 复审 I1 的第三个漏洞：原来是整串相等判定（`upper === GROUP_BLUE_HEX`），
   * `color-mix(in srgb, #2E3ED4 100%, transparent)` 这种「群青只是更大字符串
   * 里的一段」的复合值永远不会跟 `#2E3ED4` 完全相等，漏检。改成子串/正则
   * 检查——群青出现在字符串**任何位置**都算命中，不要求独占整个值。
   */
  const GROUP_BLUE_HEX = '#2E3ED4';
  function isGroupBlue(value: string): boolean {
    const upper = value.toUpperCase();
    if (upper.includes(GROUP_BLUE_HEX)) return true;
    // rgb(46, 62, 212) / rgba(46,62,212,...)——逗号两边空白不固定，用正则
    // 而不是逐字符相等；不要求这是整个字符串，只要出现在某个位置就算命中
    // （跟上面 includes 版本同一条道理）。
    return /RGBA?\(\s*46\s*,\s*62\s*,\s*212\b/.test(upper);
  }

  // 对照组：先证明这套扫描夹具真的抓得到群青，不是「扫了一遍没找到」那种
  // 假绿——这正是 antd colorPrimary 盲区漏过四轮的教训（task-5-brief 原话：
  // 「光『扫了一遍没找到』不算数」）。手工把 --fc-event-text-color 的映射
  // 换成群青，其它都不变，确认扫描器真的会报警。
  it('对照组：把 --fc-event-text-color 故意改成群青，扫描器必须抓到——先证明夹具能复现群青，不是瞎扫', () => {
    const poisoned = themeCss.replace(
      /--fc-event-text-color:\s*var\(--ink-you\);/,
      '--fc-event-text-color: #2E3ED4;',
    );
    expect(poisoned, '替换没生效，正则没匹配上——theme.css 里这一行的写法变了').not.toBe(themeCss);
    const { container, styleTag } = renderWithRealTheme(poisoned);
    try {
      const hits = collectColors(container).filter((h) => isGroupBlue(h.value));
      expect(hits.length, '故意染色之后应该至少抓到一处群青，扫描器却什么都没报').toBeGreaterThan(0);
    } finally {
      document.head.removeChild(styleTag);
    }
  });

  // 复审 I1 点名的三个扫描器真漏洞，各一条对照组——不依赖整份 theme.css，
  // 直接给扫描函数喂一个只演示这一种写法的最小夹具，证明「现在抓得到」，
  // 跟上面「对照组」那条（演示整条真实映射被偷改）是互补的两层：那条测的
  // 是「真实场景下会不会被抓到」，这三条测的是「这几种具体的写法本身，
  // 扫描器认不认得」。
  it('对照组②：var(--x, #2E3ED4) 这种带 fallback 的写法要抓到——原来的正则只认「整个值恰好是 var(--x)」，带逗号 fallback 的形状直接不匹配、原样放过', () => {
    const style = document.createElement('style');
    style.textContent = '.probe-fallback { color: var(--ink-does-not-exist, #2E3ED4); }';
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'probe-fallback';
    document.body.appendChild(el);
    try {
      const hits = collectColors(el).filter((h) => isGroupBlue(h.value));
      expect(hits.length, 'var() 带 fallback 语法里的群青没被抓到').toBeGreaterThan(0);
    } finally {
      document.head.removeChild(style);
      document.body.removeChild(el);
    }
  });

  it('对照组③：color-mix(...) 里裹着群青要抓到——原来是整串相等判定，color-mix() 这种复合值不会跟 #2E3ED4 完全相等；--fc-today-bg-color 现在的真实写法就是 color-mix(in srgb, var(--ink-you) 8%, transparent) 这个形状，偷改成 var(--ink-ai) 也要能抓到', () => {
    // 用变量间接引用，不直接把 color-mix(...) 写在 background-color 上——
    // 实测过：jsdom 的 cssstyle 不认识 color-mix() 是一个合法的 <color>
    // 值，直接写会导致整条声明被判定非法、整个丢弃（computed 值退回初始值，
    // 连字符串都摸不到）；但 cssstyle 对 var() 引用本身很宽松，任何属性
    // 挂一个 var(--x) 都会原样放行，跟 --fc-today-bg-color 在真实 theme.css
    // 里的用法（`background-color: var(--fc-today-bg-color)`，被引用的
    // 变量本身才是 color-mix() 表达式）是同一个形状。
    const style = document.createElement('style');
    style.textContent = ':root { --probe-mix: color-mix(in srgb, #2E3ED4 100%, transparent); }\n.probe-colormix { background-color: var(--probe-mix); }';
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'probe-colormix';
    document.body.appendChild(el);
    try {
      const hits = collectColors(el).filter((h) => isGroupBlue(h.value));
      expect(hits.length, 'color-mix() 里裹着的群青没被抓到').toBeGreaterThan(0);
    } finally {
      document.head.removeChild(style);
      document.body.removeChild(el);
    }
  });

  it('对照组④：box-shadow 带群青要抓到——原来扫的属性列表里没有它；FullCalendar 自己的 .fc-event:focus{box-shadow:...} 说明这是库真的会用来传色的属性', () => {
    const style = document.createElement('style');
    style.textContent = '.probe-shadow { box-shadow: 0 0 0 2px #2E3ED4; }';
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'probe-shadow';
    document.body.appendChild(el);
    try {
      const hits = collectColors(el).filter((h) => isGroupBlue(h.value));
      expect(hits.length, 'box-shadow 里的群青没被抓到').toBeGreaterThan(0);
    } finally {
      document.head.removeChild(style);
      document.body.removeChild(el);
    }
  });

  it('真实断言：过我们自己的 theme.css，渲染出来的任何元素在 jsdom 能算出计算值的那几个属性上，都没有一处颜色是群青（border 简写不在这个射程内，见 theme.css.test.ts 的文本层正向断言）', () => {
    const { container, styleTag } = renderWithRealTheme(themeCss);
    try {
      const hits = collectColors(container).filter((h) => isGroupBlue(h.value));
      expect(hits, `发现群青：${hits.map((h) => `<${h.el.tagName.toLowerCase()} class="${h.el.className}"> ${h.prop}=${h.value}`).join('; ')}`).toEqual([]);
    } finally {
      document.head.removeChild(styleTag);
    }
  });

  // task-6：timeGrid 会注入它**自己那一份**样式表（`@fullcalendar/timegrid`
  // 内部也有一次 `injectStyles(css_248z)`，跟 daygrid 那次是两次独立调用，
  // 各自往 `<head>` 插一条 `<style data-fullcalendar>`）——月视图那组对照组
  // （上面）只让 daygrid 的样式表进过场，没有验证过 timeGrid 那份注入的
  // 样式表真的读得穿。这里先渲染一个周视图的 `WeekDayHarness`（带一条按
  // 时刻的任务，触发 `.fc-timegrid-event`/`.fc-timegrid-now-indicator-line`
  // 这些 timeGrid 独有的类真实存在于 DOM 里），再复用同一套
  // `collectColors`/`resolveVarChain`/`isGroupBlue`（都在这个 describe
  // 块顶层定义，两组测试共用，不重复实现一遍）。
  function renderTimeGridWithRealTheme(cssText: string) {
    const { container } = render(
      <WeekDayHarness days={WEEK_DAYS([task({ id: 'a', title: '周视图任务', due: '2026-08-11T09:00:00.000Z' })])} />,
    );
    const styleTag = document.createElement('style');
    styleTag.textContent = cssText;
    document.head.appendChild(styleTag);
    return { container, styleTag };
  }

  // ⚠️ 这里本来想仿照月视图那组补一条"对照组⑤"（故意把
  // --fc-now-indicator-color 改成群青，验证扫描器会报警），**动手写了才
  // 发现这条对照组注定失败，不是扫描器有洞，是 jsdom 对这个属性本身就
  // 算不出真实结果**：`--fc-now-indicator-color` 唯一的落点是
  // `border-color: var(--fc-now-indicator-color)`——`border-color` 虽然
  // 只管颜色（不是 `border: width style color` 那种三合一简写），但它
  // 依然是一条会同时展开成上右下左四个方向的**简写**。探针实测过：jsdom
  // 的 cssstyle 对 `border-color: var(--x)` 不是"整条丢弃"（那是三合一
  // 简写的行为），而是**悄悄按初始值算**——不管 `--x` 声明成什么颜色，
  // `getComputedStyle(el).borderTopColor` 恒读到 `rgb(0, 0, 0)`，`var()`
  // 引用没有真的展开。改哪个颜色，扫描器读到的都是同一个黑，写"故意染色
  // 应该被抓到"的断言必然失败——这不是"扫描器该修"的漏洞（跟 I1 那三个
  // 真漏洞不是同一类），是这条 CSS 声明本身在 jsdom 下就没有可信的计算值，
  // 硬凑一条对照组只会是一条"看起来在测群青、实际测的是 jsdom 的初始值"
  // 的假测试。跟 `--fc-border-color`/`--fc-event-border-color` 归进同一类
  // "唯二靠文本层守"的例外——详见 theme.css 里这条声明旁边的长注释，唯一
  // 真实的守卫是下面 theme.css.test.ts 补的文本层正向断言。
  it('真实断言（timeGrid）：过我们自己的 theme.css，周视图渲染出来的任何元素在 jsdom 能算出计算值的那几个属性上，都没有一处颜色是群青（--fc-now-indicator-color 走 border-color 简写，不在这个射程内，见 theme.css.test.ts 的文本层正向断言）', () => {
    installFakeLayout(); // 让当前时刻线真的画出来，扫描范围盖住它（颜色本身测不出来，但同一批渲染出的事件文字/底色这些能测的仍然要覆盖到）
    const { container, styleTag } = renderTimeGridWithRealTheme(themeCss);
    try {
      const hits = collectColors(container).filter((h) => isGroupBlue(h.value));
      expect(hits, `发现群青：${hits.map((h) => `<${h.el.tagName.toLowerCase()} class="${h.el.className}"> ${h.prop}=${h.value}`).join('; ')}`).toEqual([]);
    } finally {
      document.head.removeChild(styleTag);
    }
  });
});

// ── 农历 / 节气 / 「休 班」（`showLunar` / `showHolidays`）──
// 这两个开关背后的数据全在 lib/lunar.ts，那份有自己的单元测试（哪天写哪个
// 字、表外的年份不许标）。这里只测**接线**：开关关着的时候一个字都不多出来、
// 开着的时候画在日号那一格里、读屏读到的是整句不是碎字。
describe('CalendarFull：日号底下那半行', () => {
  const OCT = new Date(2026, 9, 1, 12, 0, 0); // 国庆那个月，有休也有班

  it('**两个开关都不给的时候一个字都不多**——这个组件在别处被单独渲染几十次，多一行小字会让一堆无关断言跟着抖', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} />);
    expect(container.querySelector('.ink-cal-sub')).toBeNull();
  });

  it('开了农历：格子里写农历/节气，写在日号那一格里（不是另起一个块）', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} showLunar />);
    const texts = [...container.querySelectorAll('.ink-cal-lunar')].map((e) => e.textContent);
    expect(texts).toContain('国庆');   // 10/1，公历节日压过节气
    expect(texts).toContain('寒露');   // 10/8，节气
    expect(texts).toContain('重阳');   // 10/18，农历节日
    expect(texts).toContain('九月');   // 10/10，农历初一写月份
    // 挂在日号那个 <a> 里边：删掉这条断言的话，「另起一块画在格子正文里」
    // 也能让上面几句通过，而那样它会跟任务条抢位置。
    const one = container.querySelector('.ink-cal-lunar');
    expect(one!.closest('.fc-daygrid-day-number')).not.toBeNull();
  });

  it('只开农历不开节假日：有农历，没有「休 / 班」', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} showLunar />);
    expect(container.querySelector('.ink-cal-lunar')).not.toBeNull();
    expect(container.querySelector('.ink-cal-mark')).toBeNull();
  });

  it('只开节假日不开农历：有「休 / 班」，没有农历', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} showHolidays />);
    expect(container.querySelector('.ink-cal-lunar')).toBeNull();
    const marks = [...container.querySelectorAll('.ink-cal-mark')].map((e) => e.textContent);
    expect(marks.filter((m) => m === '休').length).toBe(7); // 国庆整块七天
    expect(marks).toContain('班');                          // 10/10 调休上班
  });

  it('「休」实心、「班」描边——两个都是石墨黑，靠填色/描边分开而不是靠色相，色盲也读得出来', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} showHolidays />);
    const off = [...container.querySelectorAll('.ink-cal-mark')].find((e) => e.textContent === '休');
    const on = [...container.querySelectorAll('.ink-cal-mark')].find((e) => e.textContent === '班');
    expect(off!.className).toContain('ink-cal-mark-off');
    expect(on!.className).toContain('ink-cal-mark-on');
  });

  it('**屏幕上那两截碎字对读屏隐藏，另挂一句整的**——「廿三」「休」各自朗读的话，日号后面会跟一串没有主语的碎片', () => {
    const { container } = render(<Harness initialTasks={[]} anchor={OCT} showLunar showHolidays />);
    for (const e of container.querySelectorAll('.ink-cal-lunar, .ink-cal-mark')) {
      expect(e.getAttribute('aria-hidden')).toBe('true');
    }
    const sr = [...container.querySelectorAll('.ink-cal-sub .ink-sr-only')].map((e) => e.textContent);
    expect(sr.some((t) => t?.includes('放假'))).toBe(true);
    expect(sr.some((t) => t?.includes('调休上班'))).toBe(true);
    expect(sr.every((t) => t?.startsWith('农历'))).toBe(true);
  });

  it('周/日视图的表头日期格里也有这半行——两档共用同一个 CellSub，不是月视图专属', () => {
    const { container } = render(
      <CalendarFull
        days={calendarDays([], OCT, 'week')}
        anchor={OCT}
        now={OCT}
        selectedKey={null}
        onSelectDay={() => {}}
        showLunar
        showHolidays
      />,
    );
    const inHeader = container.querySelector('.fc-col-header-cell .ink-cal-sub');
    expect(inHeader).not.toBeNull();
  });
});

// ── 周/日视图画哪一段小时（`hourBand` + `allHours`）──
// 原来是 FullCalendar 的默认 00:00-24:00：24 行 × 40px = 960px 塞进一个 600
// 出头的容器，一进来就得滚，滚到底是 23 点，而滚过去的那七行凌晨通常一件事
// 都没有。`hourBand` 的算法和边界在 calendar.test.ts 单测，这里测的是这个
// 组件真的照它画了，以及那个出口开关。
describe('CalendarFull：周/日视图画哪一段小时', () => {
  const hours = (c: HTMLElement) => [...c.querySelectorAll('.fc-timegrid-slot-label')].map((e) => e.textContent);
  const at = (d: number, h: number) => new Date(2026, 7, d, h).toISOString();

  it('默认只画 07-23 这一段，凌晨不白占高度', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} allHours={false} />);
    expect(hours(container)).toEqual(['07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22']);
  });

  it('**那一段之外有任务，带子张开到包住它**——这条是整个设计的意义：看不见就等于没有，不该有东西躲在一条折叠带后面（滴答清单那种「00:00-07:00」折叠行要点一下才知道里面有什么）', () => {
    const { container } = render(
      <WeekDayHarness days={calendarDays([task({ id: 'a', due: at(10, 3) })], ANCHOR, 'week')} allHours={false} />,
    );
    const h = hours(container);
    expect(h[0]).toBe('03');
    expect(h).toContain('22');
  });

  it('开了「显示全天 24 小时」：不管有没有事都画满 0-23——凌晨那几格在屏幕上不存在的话，也没法往那儿拖东西，这个开关是那个出口', () => {
    const { container } = render(<WeekDayHarness days={WEEK_DAYS()} allHours />);
    expect(hours(container)).toHaveLength(24);
    expect(hours(container)[0]).toBe('00');
  });

  it('全天任务不把带子拉到零点——本地零点是这个应用表达「全天」的方式，那条任务在上面的全天带里，不在 0 点那一格', () => {
    const { container } = render(
      <WeekDayHarness days={calendarDays([task({ id: 'a', due: at(10, 0) })], ANCHOR, 'week')} allHours={false} />,
    );
    expect(hours(container)[0]).toBe('07');
  });
});

/**
 * **点日历上的任务 → 打开那一条。**
 *
 * 这条路（`onOpenTask` / `eventClick`）以前一行测试都没有——`grep -rn onOpenTask
 * web/src` 全是产品代码。它的判据还曾经是反向的（`id.includes(':')` 就当成
 * 标记跳过），于是有两个谁都不会发现的坏法：
 *
 * - 任务 id 里带冒号就点不开。`isSafeId` 只拦 `..` 和斜杠，冒号是放行的，而
 *   `POST /api/push` 收的是**别的设备**给的 id（push.ts 自己写着「这里挡的只是
 *   形状，不挡 id 安不安全」）。那条任务在日历上画得出来、拖得动，唯独点了
 *   没反应。
 * - 反过来，改了标记 id 的拼法之后，每个标记都会被当成任务，带着一个假 id
 *   去开卡片。
 *
 * 现在判据是正向的：只认 `MARK_KINDS` 那四种前缀。
 */
describe('CalendarFull：点任务块打开那一条', () => {
  const clickEvent = (container: HTMLElement, title: string) => {
    const el = [...container.querySelectorAll('.fc-event')]
      .find((e) => (e.textContent ?? '').includes(title));
    expect(el, `日历上没画出「${title}」`).toBeTruthy();
    fireEvent.click(el!);
  };

  it('点一条任务，拿到的是它的 id', () => {
    const onOpen = vi.fn();
    const t = task({ id: 'plain-1', title: '交季度报表', due: ANCHOR.toISOString() });
    const { container } = render(<Harness initialTasks={[t]} onOpenSpy={onOpen} />);
    clickEvent(container, '交季度报表');
    expect(onOpen).toHaveBeenCalledWith('plain-1');
  });

  it('**id 里带冒号的任务照样打得开**——反向判据那一版这条是死的', () => {
    const onOpen = vi.fn();
    const t = task({ id: 'meeting:1', title: '例会', due: ANCHOR.toISOString() });
    const { container } = render(<Harness initialTasks={[t]} onOpenSpy={onOpen} />);
    clickEvent(container, '例会');
    expect(onOpen, 'id 带冒号就被当成标记跳过了').toHaveBeenCalledWith('meeting:1');
  });

  it('点标记不打开任何东西——它没有卡片可开', () => {
    const onOpen = vi.fn();
    const marks: CalMark[] = [{ kind: 'countdown', id: 'cd-1', title: '年会', start: dayKey(ANCHOR), allDay: true }];
    const { container } = render(<Harness initialTasks={[]} marks={marks} onOpenSpy={onOpen} />);
    clickEvent(container, '年会');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
