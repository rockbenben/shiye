import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CalendarView } from './CalendarView.js';
import { DEFAULT_CALENDAR_PREFS } from '../lib/calendarPrefs.js';
import { fcDragEvent, fcSlotPoint, fcTimeGridDrag, installFullCalendarFakeLayout, task } from '../test-utils.js';

// 2026-08-16 12:00 本地时间，周日——跟 CalendarGrid.test.tsx/CalendarHours.test.tsx
// 同一个锚点，方便对照。
const NOW = new Date(2026, 7, 16, 12, 0, 0);

const wiring = () => ({
  now: NOW,
  onPatch: vi.fn(),
  onEditTask: vi.fn(),
  onDelete: vi.fn(),
  lists: [],
  // 日历的两个显示开关。这几条测的都是别的东西（切档、拖拽、当天列表），
  // 给默认档就行——`showDone: false` 是产品默认，跟界面上的初始状态一致。
  prefs: DEFAULT_CALENDAR_PREFS,
  onPrefs: vi.fn(),
});

// task-5：月格换成 FullCalendar 之后格子是 .fc-daygrid-day（不再是
// .ink-cal-day），日期数字还是 .ink-cal-daynum（CalendarFull.tsx 自己用
// dayCellContent 渲染的，class 名字延续旧实现，见那个文件）。选中动作走
// keydown Enter，不用 FullCalendar 真实的指针交互引擎（mousedown/mousemove/
// mouseup + 假 getBoundingClientRect/elementFromPoint）——这里要测的是
// CalendarView 的 anchor/selectedKey 联动，不是 FullCalendar 的点击检测
// 本身（那半覆盖在 CalendarFull.test.tsx），键盘路径是 CalendarFull.tsx
// 自己接的 onKeyDown，不需要那整套假布局。
const selectDay = (container: HTMLElement, dayNum: number) => {
  const cell = [...container.querySelectorAll('.fc-daygrid-day')].find(
    (el) => el.querySelector('.ink-cal-daynum')?.textContent === String(dayNum),
  ) as HTMLElement;
  fireEvent.keyDown(cell, { key: 'Enter' });
};

// 整分支审查 D：实测过的坑——月视图选中 8/25（当天列表出现）→ 点「日」→ 标题
// 变成锚点那天（今天，8/16），不是选中的 8/25，刚出现的当天列表凭空消失。
// 派生守卫（selectedKey && days.some(...)）让「不显示陈旧内容」这件事本身是
// 对的，缺的是切档时把 anchor 同步到 selectedKey。
describe('CalendarView：切档时把 anchor 同步到 selectedKey（整分支审查 D）', () => {
  it('月视图选中 8/25，切到「日」：标题和当天列表都跟着选中的那天走，不是停在锚点（今天 8/16）', () => {
    const t = task({ id: 'a', title: '选中那天的事', due: new Date(2026, 7, 25, 10).toISOString() });
    const { container } = render(<CalendarView tasks={[t]} {...wiring()} />);

    selectDay(container, 25);
    expect(container.querySelector('.ink-row-list')).not.toBeNull();

    fireEvent.change(within(container).getByLabelText('看哪一档'), { target: { value: 'day' } });

    // 标题：8月25日 周二（选中那天），不是「8月16日 周日」（锚点/今天那天）。
    expect(container.querySelector('.ink-cal-heading')!.textContent).toBe('8月25日 周二');
    // 当天列表没有凭空消失——还是 8/25 那份内容，不是被派生守卫摘掉。
    const list = container.querySelector('.ink-row-list');
    expect(list, '当天列表凭空消失了——anchor 没有跟着 selectedKey 走').not.toBeNull();
    expect(within(list as HTMLElement).getByText('选中那天的事')).toBeTruthy();
    // task-6：周/日视图换成 FullCalendar 的 timeGridDay，不再是月视图那套 42
    // 格网格——`.fc-daygrid-day` 不该再出现 42 个，但**恰好 1 个**：
    // timeGridDay 的全天带背后仍然是 dayGrid 那套组件（一天一格），跟月视图
    // 「一个都不该有」不是同一件事，改成断言「恰好 1 个」，不是简单删掉这条
    // 断言了事——两个方向都要守（不是 42 个月格，但也不是凭空多出别的格子）。
    expect(container.querySelectorAll('.fc-daygrid-day')).toHaveLength(1);
  });

  it('选中的那天不在锚点所在的那一周：切到「周」，锚点跟着挪，标题包含选中的那天', () => {
    // 8/25（周二）离锚点所在的那一周（8/10-8/16）超过一周，翻页也翻不到——
    // 必须是 anchor 真的挪到了 8/25 所在的那一周，不是巧合落在原来那周里。
    const t = task({ id: 'a', title: '选中那天的事', due: new Date(2026, 7, 25, 10).toISOString() });
    const { container } = render(<CalendarView tasks={[t]} {...wiring()} />);

    selectDay(container, 25);
    fireEvent.change(within(container).getByLabelText('看哪一档'), { target: { value: 'week' } });

    // 周视图标题是「M月D日 - M月D日」，8/25 所在的那一周是 8/24（周一）到
    // 8/30（周日）。
    expect(container.querySelector('.ink-cal-heading')!.textContent).toBe('8月24日 - 8月30日');
  });

  it('没有 selectedKey 时切档：锚点不动，标题还是今天（NOW）所在的那页——不是每次切档都把锚点拉到 now', () => {
    const { container } = render(<CalendarView tasks={[]} {...wiring()} />);
    fireEvent.click(within(container).getByRole('button', { name: '下一页' }));
    // 翻到 9 月。
    expect(container.querySelector('.ink-cal-heading')!.textContent).toBe('2026年9月');

    fireEvent.change(within(container).getByLabelText('看哪一档'), { target: { value: 'day' } });
    // 没有选中任何一天——切档不该把翻好的页拉回 now 所在的 8/16，还是停在
    // 锚点已经翻到的 9 月 1 日（day 模式的锚点沿用同一个 anchor 对象）。
    expect(container.querySelector('.ink-cal-heading')!.textContent).toBe('9月1日 周二');
  });
});

/**
 * 日历显示设置（仿滴答清单日历右上角「显示设置」）。落格判据在
 * `lib/calendar.test.ts`，这里只测接线：两个勾选框在不在、点了报什么。
 */
describe('CalendarView：显示设置', () => {
  it('两个勾选框直接摆出来，不收进菜单——收起来就没人知道重复任务能铺开', () => {
    render(<CalendarView tasks={[]} {...wiring()} />);
    expect(screen.getByLabelText('显示已完成')).toBeTruthy();
    expect(screen.getByLabelText('显示未来重复周期')).toBeTruthy();
  });

  it('默认两个都不勾——「显示已完成」默认关是一次有意的行为变化，见 lib/calendarPrefs.ts', () => {
    render(<CalendarView tasks={[]} {...wiring()} />);
    expect((screen.getByLabelText('显示已完成') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('显示未来重复周期') as HTMLInputElement).checked).toBe(false);
  });

  it('勾一个报上去，另外两个原样带着', () => {
    const w = wiring();
    render(<CalendarView tasks={[]} {...w} />);
    fireEvent.click(screen.getByLabelText('显示未来重复周期'));
    expect(w.onPrefs).toHaveBeenCalledWith({ ...DEFAULT_CALENDAR_PREFS, showFutureRepeats: true });
  });

  it('「显示纪念日」默认开——纪念日本来就是「哪天有什么事」，那正是日历回答的问题', () => {
    render(<CalendarView tasks={[]} {...wiring()} />);
    expect((screen.getByLabelText('显示纪念日') as HTMLInputElement).checked).toBe(true);
  });

  it('纪念日画在格子上，而且是拖不动的——它不是任务', () => {
    const { container } = render(
      <CalendarView
        tasks={[]}
        countdowns={[{
          id: 'c1', title: '期末考', date: '2026-08-20', yearly: false, lunar: false,
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        }]}
        {...wiring()}
      />,
    );
    expect(container.querySelectorAll('.ink-cd-event')).toHaveLength(1);
  });

  it('关掉开关就不画——数据照样传进来，是开关说了不显示', () => {
    const { container } = render(
      <CalendarView
        tasks={[]}
        countdowns={[{
          id: 'c1', title: '期末考', date: '2026-08-20', yearly: false, lunar: false,
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
        }]}
        {...wiring()}
        prefs={{ ...DEFAULT_CALENDAR_PREFS, showCountdowns: false }}
      />,
    );
    expect(container.querySelectorAll('.ink-cd-event')).toHaveLength(0);
  });

  it('「显示专注记录」「显示打卡」默认都关——它们是历史，不是安排，混进日程里会把真要做的事挤掉', () => {
    render(<CalendarView tasks={[]} {...wiring()} />);
    expect((screen.getByLabelText('显示专注记录') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('显示打卡') as HTMLInputElement).checked).toBe(false);
  });

  it('开了「显示专注记录」，那几段番茄画在格子上，而且拖不动', () => {
    const t = task({
      id: 'a', title: '写周报',
      focusSessions: [{ startedAt: new Date(2026, 7, 19, 14).toISOString(), minutes: 25 }],
    });
    const { container } = render(
      <CalendarView tasks={[t]} {...wiring()} prefs={{ ...DEFAULT_CALENDAR_PREFS, showFocus: true }} />,
    );
    expect(container.querySelectorAll('.ink-pomo-event')).toHaveLength(1);
  });

  it('开了「显示打卡」，习惯做到的那天有个记号', () => {
    const h = task({
      id: 'h', title: '喝水', habit: true, status: 'done',
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null },
      completedAt: new Date(2026, 7, 19, 23, 47).toISOString(),
    });
    const { container } = render(
      <CalendarView tasks={[h]} {...wiring()} prefs={{ ...DEFAULT_CALENDAR_PREFS, showCheckins: true }} />,
    );
    expect(container.querySelectorAll('.ink-checkin-event')).toHaveLength(1);
  });

  it('两个开关关着时数据照样传进来，是开关说了不显示', () => {
    const t = task({
      id: 'a', focusSessions: [{ startedAt: new Date(2026, 7, 19, 14).toISOString(), minutes: 25 }],
    });
    const { container } = render(<CalendarView tasks={[t]} {...wiring()} />);
    expect(container.querySelectorAll('.ink-pomo-event')).toHaveLength(0);
  });

  it('开了之后未来的重复周期真的出现在格子上，而且是拖不动的影子', () => {
    const weekly = task({
      id: 'w', title: '开例会',
      due: new Date(2026, 7, 17, 9).toISOString(),
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    });
    const { container } = render(
      <CalendarView tasks={[weekly]} {...wiring()} prefs={{ ...DEFAULT_CALENDAR_PREFS, showFutureRepeats: true, showCountdowns: false }} />,
    );
    // 本体一条 + 这一页里推演出来的若干条，都叫「开例会」
    const all = [...container.querySelectorAll('.fc-event')];
    expect(all.length).toBeGreaterThan(1);
    // 推演出来的挂着单独的 class——不做区分的话人会去点一个点不动的影子
    expect(container.querySelectorAll('.ink-ghost-event').length).toBeGreaterThan(0);
  });
});

/**
 * 「在这天新建」（仿滴答清单：在日历上点一天就能往那天加一条）。在这之前，
 * 日历上看出「周四空着」之后想往那天加一件事，得离开日历、去顶上开「新任务」、
 * 再自己把日期挑成周四——而那个日期你刚刚就是在日历上点出来的。
 */
describe('CalendarView：在这天新建', () => {
  // 用这个文件既有的 selectDay（keydown Enter），不自己另造一套点击——
  // 那条路要 FullCalendar 真实的指针交互引擎，见文件顶部那段说明。

  it('没选中哪一天时不出现——「这天」还没有着落', () => {
    render(<CalendarView tasks={[]} {...wiring()} onComposeOn={vi.fn()} />);
    expect(screen.queryByText('在这天新建')).toBeNull();
  });

  it('不给 onComposeOn 就不出现', () => {
    const { container } = render(<CalendarView tasks={[]} {...wiring()} />);
    selectDay(container, 18);
    expect(screen.queryByText('在这天新建')).toBeNull();
  });

  it('选中一天之后出现，点了把那天报上去', () => {
    const onComposeOn = vi.fn();
    const { container } = render(<CalendarView tasks={[]} {...wiring()} onComposeOn={onComposeOn} />);
    selectDay(container, 18);

    fireEvent.click(screen.getByText('在这天新建'));

    expect(onComposeOn).toHaveBeenCalledWith('2026-08-18');
  });
});

/**
 * 「每周开始于」（设置里那一档）一路传到底。
 *
 * **这一条钉的是接线，不是算法**：`weekStart` 要经过 CalendarView →
 * CalendarGrid → CalendarFull 三层才到得了 FullCalendar 的 `firstDay` 和那行
 * 星期表头。中间任何一层漏传，屏幕上都是「设置里选了周日、日历照旧从周一
 * 开始」——设置本身存对了，看不出哪儿断的。**真发生过**：CalendarGrid 那一层
 * 漏了一处，改设置完全没反应。
 *
 * 算法本身（周日/周一各自该从哪天起）在 `calendar.test.ts`。
 */
describe('CalendarView：每周开始于一路传到底', () => {
  const weekdays = (c: HTMLElement) =>
    [...c.querySelectorAll('.ink-cal-weekday')].map((e) => e.textContent).join('');

  it('不传就是周一——那是加这个设置之前写死的值', () => {
    const { container } = render(<CalendarView tasks={[]} {...wiring()} />);
    expect(weekdays(container)).toBe('一二三四五六日');
  });

  it('传 0：表头转成周日开头', () => {
    const { container } = render(<CalendarView tasks={[]} {...wiring()} weekStart={0} />);
    expect(weekdays(container)).toBe('日一二三四五六');
  });

  it('**周日那一档不是另存一份表头**——把周一开头那份的最后一个挪到最前面，两份表迟早改歪一份', () => {
    const { container } = render(<CalendarView tasks={[]} {...wiring()} weekStart={0} />);
    const got = weekdays(container);
    expect(got).toHaveLength(7);
    expect([...new Set(got)].length).toBe(7);
  });
});

// 接线：设置里那两个开关要真的到得了 FullCalendar。`weekStart` 那次栽过
// 一次——设置存下来了、日历没变，因为 `<CalendarGrid>` 上漏了那个属性，
// 全量测试照样全绿（整分支审查 D 那批）。这里替月和周/日两条路各钉一次。
describe('CalendarView：农历/节假日两个开关一路传到底（weekStart 漏传那次的同一类）', () => {
  const OCT = [task({ id: 'a', due: new Date(2026, 9, 1, 10).toISOString() })];
  const at = (over: Record<string, unknown>) => ({ ...wiring(), now: new Date(2026, 9, 1, 12), tasks: OCT, countdowns: [], ...over });

  it('月视图：开着就画，关着一个字都没有', () => {
    const { container, rerender } = render(
      <CalendarView {...at({ showLunar: true, showHolidays: true, aiMode: 'cli' as const, aiBaseUrl: '', aiKey: '', aiModel: '' })} />,
    );
    expect(container.querySelector('.ink-cal-lunar')).not.toBeNull();
    expect(container.querySelector('.ink-cal-mark')).not.toBeNull();

    rerender(<CalendarView {...at({})} />);
    expect(container.querySelector('.ink-cal-sub')).toBeNull();
  });

  it('周视图：切档之后照样在——月和周/日是两个不同的 <CalendarFull>，各传各的', () => {
    const { container } = render(
      <CalendarView {...at({ showLunar: true, showHolidays: true, aiMode: 'cli' as const, aiBaseUrl: '', aiKey: '', aiModel: '' })} />,
    );
    fireEvent.change(within(container).getByLabelText('看哪一档'), { target: { value: 'week' } });
    expect(container.querySelector('.fc-col-header-cell .ink-cal-sub')).not.toBeNull();
  });
});

// ── 反过来那一半：把日历上的一条任务拖回「安排任务」栏 = 取消日期 ──
//
// 拖**进去**（栏 → 日历）走 FullCalendar 的外部拖拽协议（`Draggable` + `drop`），
// 那半在 CalendarFull.test.tsx。拖**出来**没有对应协议——落点在 FullCalendar 的
// 盒子外面，它认不出来、只会把事件弹回原处，能抓到的只有 `eventDragStop` 那一拍
// 的指针坐标，命中判断在 CalendarView 这一层（那一栏的 DOM 在它手上）。
//
// ⚠️ **`eventDragStop` 不是同步的**：FullCalendar 在弹回动画结束之后才发它
// （`dragRevertDuration={0}` 之后退化成 `setTimeout(done, 0)`，见
// @fullcalendar/interaction 的 `stopDrag`）。所以这一组全是 `await waitFor`，
// 松手之后直接断言会稳定地测到「还没发生」。
describe('CalendarView：从日历拖回「安排任务」栏 = 取消日期', () => {
  const DUE = new Date(2026, 7, 16, 10).toISOString();

  /** 假布局那套兜底会给 `.ink-cal-sched` 一个铺满整个坐标系的矩形（它没有
   *  专属分支），照那个判「指针在不在栏上」会恒为真——连落在日历里的拖动都
   *  会被判成拖出去了。所以这里给它一个**自己的**矩形（元素自身的属性盖过
   *  原型上那道垫片），摆在日历右边 x≥900 处。 */
  const putPanelAt = (container: HTMLElement, left: number) => {
    const el = container.querySelector('.ink-cal-sched') as HTMLElement;
    expect(el, '「安排任务」栏没渲染出来').not.toBeNull();
    el.getBoundingClientRect = () => ({
      x: left, y: 0, width: 300, height: 800,
      left, top: 0, right: left + 300, bottom: 800, toJSON() { return {}; },
    }) as DOMRect;
    return el;
  };

  /** 按下 → 挪到 (x, y) → 松手。`fcDragEvent` 只会按格子下标算落点，这里要的
   *  是「日历外面的某个点」，所以自己走一遍同样的手法。 */
  const press = (el: Element) => {
    const r = el.getBoundingClientRect();
    fireEvent.mouseDown(el, { button: 0, clientX: r.left + 5, clientY: r.top + 5 });
  };
  const moveTo = (x: number, y: number) => {
    for (let i = 0; i < 8; i++) fireEvent.mouseMove(document, { clientX: x, clientY: y });
  };
  const release = (x: number, y: number) => fireEvent.mouseUp(document, { button: 0, clientX: x, clientY: y });

  const open = () => {
    const w = wiring();
    const r = render(
      <CalendarView
        {...w}
        tasks={[task({ id: 'a', title: '写周报', due: DUE })]}
        countdowns={[]}
        prefs={{ ...DEFAULT_CALENDAR_PREFS, showSchedule: true }}
      />,
    );
    return { ...r, onPatch: w.onPatch, ev: r.container.querySelector('.fc-event') as HTMLElement };
  };

  it('松手在那一栏上：`due` 被置空，走的是 onPatch，不是另开一条端点', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, onPatch, ev } = open();
      putPanelAt(container, 900);
      press(ev); moveTo(1000, 400); release(1000, 400);
      await waitFor(() => expect(onPatch).toHaveBeenCalledWith('a', { due: null }));
    } finally { restore(); }
  });

  it('**松手在日历里：不走这条路**——同一拍 `eventDragStop` 对每次拖动都会响，落点在栏外面时它必须闭嘴，改期是 eventDrop 的事', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, onPatch, ev } = open();
      putPanelAt(container, 900);
      press(ev); moveTo(250, 250); release(250, 250);
      // 等到这次拖动真的结束（面板的拖拽态收回去了）再断言，不然测到的是
      // 「还没发生」而不是「不会发生」。
      await waitFor(() => expect(container.querySelector('.ink-cal-sched')!.className).not.toContain('ink-cal-sched-drop'));
      expect(onPatch).not.toHaveBeenCalledWith('a', { due: null });
    } finally { restore(); }
  });

  it('拖的过程中那一栏给出「可以放这儿」的回答，松手之后收回去', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, ev } = open();
      const panel = putPanelAt(container, 900);
      press(ev); moveTo(1000, 400);
      expect(panel.className).toContain('ink-cal-sched-drop');   // 正在拖
      expect(panel.className).toContain('ink-cal-sched-over');   // 而且就悬在这儿
      expect(container.querySelector('.ink-cal-dropnote')).not.toBeNull();

      release(1000, 400);
      await waitFor(() => expect(panel.className).not.toContain('ink-cal-sched-drop'));
      expect(panel.className).not.toContain('ink-cal-sched-over');
      expect(container.querySelector('.ink-cal-dropnote')).toBeNull();
    } finally { restore(); }
  });

  it('指针在日历里晃的时候那一栏不高亮——「可以放」和「就放这儿」是两个不同的回答', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, ev } = open();
      const panel = putPanelAt(container, 900);
      press(ev); moveTo(250, 250);
      expect(panel.className).toContain('ink-cal-sched-drop');
      expect(panel.className).not.toContain('ink-cal-sched-over');
      release(250, 250);
      await waitFor(() => expect(panel.className).not.toContain('ink-cal-sched-drop'));
    } finally { restore(); }
  });

  it('那一栏收起来的时候，往那个方向拖什么都不会发生——`insideEl` 对 null 一律为假', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const w = wiring();
      const { container } = render(
        <CalendarView {...w} tasks={[task({ id: 'a', title: '写周报', due: DUE })]} countdowns={[]} prefs={DEFAULT_CALENDAR_PREFS} />,
      );
      expect(container.querySelector('.ink-cal-sched')).toBeNull();
      const ev = container.querySelector('.fc-event') as HTMLElement;
      press(ev); moveTo(1000, 400); release(1000, 400);
      await new Promise((r) => setTimeout(r, 30));
      expect(w.onPatch).not.toHaveBeenCalledWith('a', { due: null });
    } finally { restore(); }
  });
});

/**
 * **一场只有时间段、没有截止时间的会**（「九点到十二点开会」——编辑表单里那
 * 三个日期选择器互相独立、都能清空，这是最自然的输入方式）。
 *
 * 月格本身早就按 `calendarAnchor` 落格了，所以它一直画得出来。缺的是另外两处：
 *
 * - 点开那天的**当天列表**按 `t.due` 筛（那个函数当时叫 `dueDayKey`，注释还
 *   写着「跟 `calendarDays` 同一条口径」）——于是**格子里看得到，点进去是空的**，
 *   同一屏上两句互相矛盾的话。
 * - **拖拽**第一句是 `if (!t?.due) return`——于是它在月视图上**拖不动，而且是
 *   静默的**：卡片跟着手指走，松开弹回原处，没有任何一处说为什么。
 */
describe('CalendarView：只有时间段的会，在月视图上看得到也拖得动', () => {
  const MEETING = task({
    id: 'm', title: '九点开会', due: null,
    startAt: new Date(2026, 7, 20, 9).toISOString(),
    endAt: new Date(2026, 7, 20, 12).toISOString(),
  });

  it('**月格里画得出来，点开那天的列表里也在**——改之前格子里有、列表里没有', () => {
    const { container } = render(<CalendarView tasks={[MEETING]} {...wiring()} />);
    // 先确认它真的画在 8/20 那一格上（不然下面那半可能是因为别的原因过的）。
    expect(container.querySelector('.fc-daygrid-event')!.textContent).toContain('九点开会');
    selectDay(container, 20);
    const list = container.querySelector('.ink-row-list');
    expect(list, '选中那天连列表都没出现').not.toBeNull();
    expect(within(list as HTMLElement).getByText('九点开会')).toBeTruthy();
  });

  it('对照：选中别的一天，它不在那份列表里——上面那条不是「列表把所有任务都列出来」', () => {
    const { container } = render(<CalendarView tasks={[MEETING]} {...wiring()} />);
    selectDay(container, 21);
    const list = container.querySelector('.ink-row-list');
    if (list) expect(within(list as HTMLElement).queryByText('九点开会')).toBeNull();
  });

  it('**拖得动，而且改的是那场会**：`startAt`/`endAt` 一起挪、时长不变，不凭空补一个 `due`', async () => {
    const w = wiring();
    const { container } = render(<CalendarView tasks={[MEETING]} {...w} />);
    const restore = installFullCalendarFakeLayout();
    try {
      const cells = [...container.querySelectorAll('.fc-daygrid-day')];
      const from = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-20');
      const to = cells.findIndex((c) => c.getAttribute('data-date') === '2026-08-21');
      fcDragEvent(container.querySelector('.fc-daygrid-event')!, from, to);

      // 落点按「往哪个方向拖」算、不是像素级精确到哪一天（见 fcDragEvent 的
      // 文档注释），所以不断言具体日期，只断言这次写**是什么形状**：钟点分毫
      // 不变、日期真的变了、时长还是三小时、没有多出一个 due。
      await waitFor(() => expect(w.onPatch).toHaveBeenCalled());
      const [id, patch] = w.onPatch.mock.calls.at(-1) as [string, Record<string, string>];
      expect(id).toBe('m');
      expect(patch).not.toHaveProperty('due');
      const s = new Date(patch.startAt), e = new Date(patch.endAt);
      expect([s.getHours(), s.getMinutes()]).toEqual([9, 0]);
      expect(s.getDate()).not.toBe(20);
      expect(e.getTime() - s.getTime()).toBe(3 * 3600_000);
    } finally { restore(); }
  });
});

/**
 * **周/日视图把一场会拖到另一个时刻。** 这一处比月格那处坏：`onDropOnSlot`
 * 原来无条件写 `{ due }`，于是一场 09:00-12:00 的会拖到 15:00 那一格，写进去的
 * 是 `due = 15:00` 而时间段原地不动——落格看的是 `startAt`，它**当场弹回
 * 09:00**。屏幕上等于什么都没发生，只是悄悄多了一个他没说过的截止时间。
 * 另外几处是「不动」，这一处是「看着没动、其实写坏了」。
 */
describe('CalendarView：把一场会拖到另一个时刻', () => {
  const MEETING = task({
    id: 'm', title: '九点开会', due: null,
    startAt: new Date(2026, 7, 16, 9).toISOString(),
    endAt: new Date(2026, 7, 16, 12).toISOString(),
  });
  // `fcSlotPoint` 按「第 h 小时那一格」算坐标，而日历默认只画 `hourBand`
  // 那一段（07-23），换算会整条偏掉——先把「显示全天 24 小时」打开，坐标系
  // 才对得上。`prefs` 是受控的，点那个开关只会调 `onPrefs`，得直接传进来。
  const dayView = (t = MEETING) => {
    const w = { ...wiring(), prefs: { ...DEFAULT_CALENDAR_PREFS, showAllHours: true } };
    const { container } = render(<CalendarView tasks={[t]} {...w} />);
    fireEvent.change(within(container).getByLabelText('看哪一档'), { target: { value: 'day' } });
    return { container, w };
  };

  it('**挪的是那场会**：`startAt` 落到目标时刻、时长不变，不写 `due`', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, w } = dayView();
      fcTimeGridDrag(container.querySelector('.fc-timegrid-event')!, { colIdx: 0, hour: 9 }, { colIdx: 0, hour: 14 });
      await waitFor(() => expect(w.onPatch).toHaveBeenCalled());
      const [id, patch] = w.onPatch.mock.calls.at(-1) as [string, Record<string, string>];
      expect(id).toBe('m');
      expect(patch).not.toHaveProperty('due');
      expect(new Date(patch.startAt).getHours()).toBe(14);
      expect(Date.parse(patch.endAt) - Date.parse(patch.startAt)).toBe(3 * 3600_000);
    } finally { restore(); }
  });

  it('对照：**没有时间段的普通任务照旧改 `due`**——上面那条没有把这条路整个换掉', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const plain = task({ id: 'p', title: '交表', due: new Date(2026, 7, 16, 9).toISOString() });
      const { container, w } = dayView(plain);
      fcTimeGridDrag(container.querySelector('.fc-timegrid-event')!, { colIdx: 0, hour: 9 }, { colIdx: 0, hour: 14 });
      await waitFor(() => expect(w.onPatch).toHaveBeenCalled());
      const [id, patch] = w.onPatch.mock.calls.at(-1) as [string, Record<string, string>];
      expect(id).toBe('p');
      expect(patch).toEqual({ due: new Date(2026, 7, 16, 14).toISOString() });
    } finally { restore(); }
  });

  /**
   * **全天带对有时间段的不接。** 拖上去唯一说得通的写法是把 `startAt`/`endAt`
   * 清掉，而那是在一次没有确认、事后看不出来的拖拽里丢信息——跟四象限横轴
   * 「拖了不改期」同一条既有约定（`lib/cells.ts`）：没有一个「对」的值可以写
   * 的时候，不写。要把一场会变成全天的，清空表单里那两个时刻。
   *
   * `fcTimeGridDrag` 只接小时数（全天带不是一个小时格），所以这一条自己走
   * 指针序列——跟 App.test.tsx 里那条「拖到全天带」同一个手法。
   */
  const dragToAllDay = (container: HTMLElement) => {
    const eventEl = container.querySelector('.fc-timegrid-event')!;
    const src = fcSlotPoint(0, 9);
    const rect = container.querySelector('.fc-daygrid-day')!.getBoundingClientRect();
    const dst = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    fireEvent.mouseDown(eventEl, { button: 0, clientX: src.x, clientY: src.y });
    for (let i = 1; i <= 10; i++) {
      fireEvent.mouseMove(document, { clientX: src.x + (dst.x - src.x) * (i / 10), clientY: src.y + (dst.y - src.y) * (i / 10) });
    }
    for (let i = 0; i < 4; i++) fireEvent.mouseMove(document, { clientX: dst.x, clientY: dst.y });
    fireEvent.mouseUp(document, { button: 0, clientX: dst.x, clientY: dst.y });
  };

  it('有时间段的拖到全天带：什么都不发，不清掉那场会、也不编一个零点的 `due`', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const { container, w } = dayView();
      dragToAllDay(container);
      await new Promise((r) => { setTimeout(r, 50); });
      expect(w.onPatch).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('对照：**普通任务拖到全天带照旧落那天零点**——证明上面那条不是「全天带整个失灵了」', async () => {
    const restore = installFullCalendarFakeLayout();
    try {
      const plain = task({ id: 'p', title: '交表', due: new Date(2026, 7, 16, 9).toISOString() });
      const { container, w } = dayView(plain);
      dragToAllDay(container);
      await waitFor(() => expect(w.onPatch).toHaveBeenCalled());
      const [id, patch] = w.onPatch.mock.calls.at(-1) as [string, Record<string, string>];
      expect(id).toBe('p');
      expect(new Date(patch.due).getHours()).toBe(0);
    } finally { restore(); }
  });
});

/**
 * **点日历上的任务 → 开详情，这条链有三跳，以前只测了最后一跳。**
 *
 * 链路是 `CalendarView`（月档）→ `CalendarGrid` → `CalendarFull` 的 `eventClick`。
 * `CalendarFull.test.tsx` 直接渲染 `CalendarFull`、自己接 `onOpenTask`，所以它只
 * 证明了最后那一跳；中间 `CalendarGrid.tsx` 那句 `onOpenTask={onOpenTask}` 谁都
 * 没盯着——**实测把它删掉，124 条日历测试全绿**。
 *
 * 这正是这个仓库反复栽的那一类（`TaskGrid.tsx` 顶上那段「`CalendarView` 没跟着
 * 补字段，TypeScript 对 JSX spread 不做多余属性检查，编译期不报、运行期悄悄丢」
 * 说的是同一件事）。这条从最外面点进去，一次覆盖三跳。
 */
describe('CalendarView：点月格里的任务，一路转发到详情', () => {
  it('点一条任务 → onOpenDetail 拿到它的 id（三跳一起覆盖）', () => {
    const onOpenDetail = vi.fn();
    const t = task({ id: 'cv-1', title: '交季度报表', due: new Date(2026, 7, 17, 9).toISOString() });
    const { container } = render(
      <CalendarView tasks={[t]} {...wiring()} onOpenDetail={onOpenDetail} />,
    );
    const ev = [...container.querySelectorAll('.fc-event')]
      .find((e) => (e.textContent ?? '').includes('交季度报表'));
    expect(ev, '月格里没画出那条任务').toBeTruthy();
    fireEvent.click(ev!);
    expect(onOpenDetail, '中间那一跳（CalendarGrid 的转发）断了').toHaveBeenCalledWith('cv-1');
  });
});
