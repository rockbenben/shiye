import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HabitStats, todayState } from './HabitStats.js';
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

  it('三个数字都在：连续 / 最长 / 这个月', () => {
    const { container } = show([done('喝水', 17), done('喝水', 18), live('喝水')]);
    expect(screen.getByText(/连续/)).toBeTruthy();
    expect(screen.getByText(/最长/)).toBeTruthy();
    // 那一栏里数字被 <b> 包着，getByText 只认元素自己的直接文本节点，够不到
    // 被拆开的那句话——按整栏的 textContent 看。
    expect(container.querySelector('.ink-hstat-nums')!.textContent).toMatch(/8月\s+2\s*\/\s*19/);
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
    expect(screen.getByLabelText('8月打卡表：1 / 19 天')).toBeTruthy();
  });

  /**
   * **这一族盯的是「这张表长得像月历，就得真的是月历」。**
   *
   * 这里原来是 `display: flex; flex-wrap: wrap` + 固定 23px 格子，于是
   * 「一行几天」完全由容器宽度决定——实测同一批 30 天在 1440px 下排成
   * 11/11/8、1024px 下 16/14、390px 手机上 12/12/6。格子里印着 1..31，
   * 没有人会不按周去读它，而每一行的第一个格子在不同宽度下指向不同的日期。
   *
   * 列数写死在 CSS 里（`repeat(7, 23px)`），jsdom 算不出布局，所以这一族
   * **测不了「渲染出来是几列」**——它测的是那一层能被测到的约定：1 号之前
   * 补几格、补出来的东西不带 `.ink-hstat-cell`（否则「一个月 31 格」那条
   * 断言会跟着变），以及顶上那行星期标签按 `weekStart` 轮转。
   * 真正「七列」这件事靠 `theme.css` 那一条 + 人眼，别把它当成有守卫。
   */
  describe('月历的七列（1 号之前补空格 + 星期标签）', () => {
    /** 2026-08-01 是周六。 */
    it('周一开头时，1 号之前补 5 格（8/1 是周六）', () => {
      const { container } = show([done('喝水', 18), live('喝水')]);
      expect(container.querySelectorAll('.ink-hstat-blank')).toHaveLength(5);
    });

    it('**补的格子不算进「一天一格」**——否则「一个月 31 格」那条会随月份飘', () => {
      const { container } = show([done('喝水', 18), live('喝水')]);
      expect(container.querySelectorAll('.ink-hstat-cell')).toHaveLength(31);
      // 补的那几格不能带 cell 那个类
      for (const b of container.querySelectorAll('.ink-hstat-blank')) {
        expect(b.className).not.toContain('ink-hstat-cell');
      }
    });

    it('星期标签按 weekStart 轮转，周一开头时是「一二三四五六日」', () => {
      const { container } = show([done('喝水', 18), live('喝水')]);
      const wd = [...container.querySelectorAll('.ink-hstat-wd')].map((e) => e.textContent);
      expect(wd).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    });

    it('**改成周日开头，标签和空格一起挪**——两处用同一个数，不然整张表错位一天', () => {
      const { container } = render(
        <HabitStats tasks={[done('喝水', 18), live('喝水')]} now={NOW} onOpen={vi.fn()} weekStart={0} />,
      );
      expect([...container.querySelectorAll('.ink-hstat-wd')].map((e) => e.textContent))
        .toEqual(['日', '一', '二', '三', '四', '五', '六']);
      // 周日起头，8/1（周六）之前是 6 格
      expect(container.querySelectorAll('.ink-hstat-blank')).toHaveLength(6);
    });

  it('星期标签对读屏是噪音——它在 `role="img"` 那张表里已经有一句整话', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    for (const e of container.querySelectorAll('.ink-hstat-wd, .ink-hstat-blank')) {
      expect(e.getAttribute('aria-hidden'), e.textContent ?? '').toBe('true');
    }
  });

  /**
   * **分母是 0 的那一栏整个不出现。**
   *
   * 实测（手机宽度那一轮）发现的形状：今天刚建一个「每周一、五」的习惯，
   * 而今天不是打卡日——`monthElapsed` 算出来 0，屏幕上成了「本月 0 / 0 天」，
   * 一个读起来像坏掉的分数。
   *
   * `habitStats.ts` 里那段注释其实**已经点名过这个形状**（它是在讲
   * 「坏 createdAt 不能直接进 Math.min」时说的：「月度分母跟着变成 0，
   * 界面上是「本月 0 / 0 天」」）——那条把 NaN 那条路堵死了，但合法路径上
   * 的同一个显示还在。这里补上。
   */
  describe('分母是 0 时（本月还没有打卡日）', () => {
    /** NOW 是 2026-08-19，周三。 */
    const WEEK_MON_FRI: Repeat = { ...DAILY, every: 'week', weekdays: [1, 5] };
    const bornToday = (p: Partial<Task>) => task({ ...p, createdAt: iso(2026, 8, 19) });

    it('每周一、五的习惯今天（周三）刚建 → 那一栏不渲染，不留一个「0 / 0」', () => {
      const { container } = show([bornToday({ id: 'w', title: '练背', habit: true, repeat: WEEK_MON_FRI, status: 'todo' })]);
      expect(container.querySelector('.ink-hstat-nums')!.textContent).not.toMatch(/8月\s+\d/);
    });

    it('读屏听到的也不是「0 / 0 天」，而是说清为什么没有', () => {
      show([bornToday({ id: 'w', title: '练背', habit: true, repeat: WEEK_MON_FRI, status: 'todo' })]);
      expect(screen.getByLabelText('8月打卡表：还没有打卡日')).toBeTruthy();
    });

    it('**对照：分母不是 0 就照常显示**——别把这一栏整个删了', () => {
      const { container } = show([done('喝水', 18), live('喝水')]);
      expect(container.querySelector('.ink-hstat-nums')!.textContent).toMatch(/8月\s+1\s*\/\s*19/);
      expect(screen.getByLabelText('8月打卡表：1 / 19 天')).toBeTruthy();
    });

    it('每天的习惯今天刚建 → 分母是 1，照常显示（不是所有「刚建」都藏）', () => {
      const { container } = show([bornToday({ id: 'd', title: '喝水', habit: true, repeat: DAILY, status: 'todo' })]);
      expect(container.querySelector('.ink-hstat-nums')!.textContent).toMatch(/8月\s+\d\s*\/\s*1/);
    });
  });
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

/**
 * **「今天打卡」那颗按钮必须读月历格子同一份判据。**
 *
 * 沙箱实测抓到的一处自相矛盾：一条勾了「一三五」的健身，在周六打开这一屏，
 * 月历里今天那格是 `ink-hstat-cell-off`（悬停写着「这天不用打卡」），旁边却是
 * 一颗点得动的「今天打卡」。头一版那颗按钮只看「没打过 + 有 live 实例」，
 * 没读 `checkinDays`——同一张卡上两句反话。
 */
describe('HabitStats：不该打的那天不给按钮', () => {
  const withCheckIn = (tasks: Task[], now: Date) => {
    const onCheckIn = vi.fn();
    render(<HabitStats tasks={tasks} now={now} onOpen={vi.fn()} onCheckIn={onCheckIn} />);
    return { onCheckIn };
  };

  it('今天不在 checkinDays 里：给「今天不用打卡」这句文字，不给按钮', () => {
    // NOW 是 8/19 周三，这条勾的是一、五。
    const MON_FRI: Repeat = { ...DAILY, every: 'week', weekdays: [1, 5] };
    withCheckIn([
      task({ id: 'live', title: '练背', habit: true, repeat: MON_FRI, status: 'todo' }),
      task({ id: 'd17', title: '练背', habit: true, repeat: MON_FRI, status: 'done', completedAt: iso(2026, 8, 17) }),
    ], NOW);
    expect(screen.getByText('今天不用打卡')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '今天打卡' })).toBeNull();
  });

  it('本周已经达标：给「本周已达标」，不再催一次', () => {
    // 8/21 是周五，在这条的打卡日里；一/二/三/四 四天都已经打过，目标四次。
    const WEEK_1235: Repeat = { ...DAILY, every: 'week', weekdays: [1, 2, 3, 5] };
    const Fri = local(2026, 8, 21, 12);
    withCheckIn([
      task({ id: 'live', title: '健身', habit: true, repeat: WEEK_1235, status: 'todo' }),
      ...[17, 18, 19, 20].map((d) => task({
        id: `gym-${d}`, title: '健身', habit: true, repeat: WEEK_1235, status: 'done', completedAt: iso(2026, 8, d),
      })),
    ], Fri);
    expect(screen.getByText('本周已达标')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '今天打卡' })).toBeNull();
  });

  it('**对照：该打、没打、也没达标——那颗按钮必须还在**（别把它整个删了当修完）', () => {
    const MON_FRI: Repeat = { ...DAILY, every: 'week', weekdays: [1, 3, 5] };
    // NOW 是 8/19 周三，在打卡日里；本周一打过一次，目标三次，还差两次。
    const { onCheckIn } = withCheckIn([
      task({ id: 'live', title: '健身', habit: true, repeat: MON_FRI, status: 'todo' }),
      task({ id: 'd17', title: '健身', habit: true, repeat: MON_FRI, status: 'done', completedAt: iso(2026, 8, 17) }),
    ], NOW);
    fireEvent.click(screen.getByRole('button', { name: '今天打卡' }));
    expect(onCheckIn).toHaveBeenCalledWith('live');
  });
});

/**
 * 屏顶那句总账 + 那份「今天处在哪个状态」的判据。
 *
 * 这一屏原来什么都不说：两个习惯、今天一个待打卡一个不用打，屏幕上没有任何
 * 一处回答「我今天还欠几件」——而侧栏给它配的是一个网格图标，它是被当报表进的
 * 这一屏。
 */
describe('HabitStats：屏顶一句总账', () => {
  it('几个待打卡、几个今天不用打，各数各的', () => {
    // 喝水：每天、今天没打 → 待打卡。练背：勾一五，今天（8/19 周三）不是它的
    // 日子 → 不用打。两句必须分开数，合成一句「2 个待打卡」是假话。
    const MON_FRI: Repeat = { ...DAILY, every: 'week', weekdays: [1, 5] };
    show([
      done('喝水', 18), live('喝水'),
      task({ id: 'w', title: '练背', habit: true, repeat: MON_FRI, status: 'todo' }),
    ]);
    const line = screen.getByRole('status').textContent ?? '';
    expect(line).toContain('1 个待打卡');
    expect(line).toContain('1 个今天不用打');
  });

  it('todayState 四档各归各的，顺序是 done → off → met → pending', () => {
    const base = { checkinDays: null, week: null, doneToday: false, liveId: 'x' };
    const Wed = local(2026, 8, 19, 12);
    expect(todayState({ ...base, doneToday: true } as never, Wed)).toBe('done');
    expect(todayState({ ...base, checkinDays: [1, 5] } as never, Wed)).toBe('off');
    expect(todayState({ ...base, week: { done: 3, target: 3 } } as never, Wed)).toBe('met');
    expect(todayState(base as never, Wed)).toBe('pending');
    // 已经打过的人不再被判成「不用打」——打没打过是第一位的事实
    expect(todayState({ ...base, doneToday: true, checkinDays: [1, 5] } as never, Wed)).toBe('done');
  });
});

/**
 * 月历能翻月。
 *
 * 月初进这一屏什么都看不见：这一屏的立意是「这个月坚持得怎么样」，而每月
 * 头几天月历上就是几个空格，刚过去的那个月反而查不到——想查只能点「看这一年」，
 * 在 365 格里自己找。
 */
/**
 * 整宽那张表：一行一个习惯，右边一条最近 28 天的格子带。
 * 立意在 `habitStats.ts` 的 `recent` 上——「这周谁断了」要横着一眼看完，
 * 而月历那种五行七列的大件一多就变成一列长队。
 */
describe('HabitStats：整宽那一行与格子带', () => {
  it('每条带 28 格，最后一格标着今天', () => {
    const { container } = show([done('喝水', 18), live('喝水')]);
    const cells = container.querySelectorAll('.ink-hstat-bcell');
    expect(cells.length).toBe(28);
    expect(cells[27].className).toContain('ink-hstat-bcell-today');
    expect([...cells].filter((c) => c.className.includes('ink-hstat-bcell-today')).length, '「今天」只能有一格').toBe(1);
  });

  it('打过卡的那几格填上，读屏听到的是个数不是二十八个方格', () => {
    const { container } = show([done('喝水', 17), done('喝水', 18), live('喝水')]);
    const band = container.querySelector('.ink-hstat-band')!;
    expect(band.querySelectorAll('.ink-hstat-bcell-done').length).toBe(2);
    expect(band.getAttribute('aria-label')).toContain('打过 2 天');
  });

  it('两行的同一列是同一个日子——这条带全部的意义在这儿', () => {
    const { container } = show([done('喝水', 18), live('喝水'), done('跑步', 18), live('跑步')]);
    const rows = [...container.querySelectorAll('.ink-hstat-band')];
    expect(rows.length).toBe(2);
    const keys = (el: Element) => [...el.querySelectorAll('.ink-hstat-bcell')].map((c) => c.getAttribute('title')!.split(' ')[0]);
    expect(keys(rows[1])).toEqual(keys(rows[0]));
  });

  it('月历收在详情里，点开那一行才摊开；点一行不动另一行', () => {
    const { container } = show([done('喝水', 18), live('喝水'), done('跑步', 18), live('跑步')]);
    const cards = () => [...container.querySelectorAll('.ink-hstat-card')];
    expect(cards().every((c) => !c.className.includes('is-open'))).toBe(true);
    fireEvent.click(screen.getByLabelText('展开「喝水」的月历'));
    expect(cards()[0].className).toContain('is-open');
    expect(cards()[1].className).not.toContain('is-open');
    // 再点一下收回去。
    fireEvent.click(screen.getByLabelText('收起「喝水」的月历'));
    expect(cards()[0].className).not.toContain('is-open');
  });

  it('展开那颗跟标题是两个动作：一个在本屏看历史，一个跳去那张卡', () => {
    const { onOpen } = show([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByLabelText('展开「喝水」的月历'));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('喝水'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('HabitStats：翻月', () => {
  /** 整宽那张表默认一行都没摊开，而翻月那颗管的正是摊开的那几个月历——
   *  所以要先点开一行。这三条测的是「翻到哪个月」，不是「那颗在不在」，
   *  补这一步没有放松任何断言。 */
  const openAndBack = () => {
    fireEvent.click(screen.getByLabelText('展开「喝水」的月历'));
    fireEvent.click(screen.getByLabelText('上一个月'));
  };

  it('翻到上个月：表头那个月份跟着改，格子画的是上个月', () => {
    show([done('喝水', 18), live('喝水')]);
    openAndBack();
    expect(screen.getByText('7月')).toBeTruthy();
    // 上个月没有这个习惯的记录（夹具都在 8 月），但格子还得一张不落——
    // 31 格 + 7 个星期标签
    expect(document.querySelectorAll('.ink-hstat-cell').length).toBe(31);
  });

  it('**翻月不动「今天」**：连续天数、本周次数照真实的今天算', () => {
    show([done('喝水', 18), live('喝水')]);
    const before = screen.getByText(/连续/).textContent;
    openAndBack();
    expect(screen.getByText(/连续/).textContent).toBe(before);
  });

  it('未来不能翻：已经在当月时「下一个月」是死的', () => {
    show([done('喝水', 18), live('喝水')]);
    fireEvent.click(screen.getByLabelText('展开「喝水」的月历'));
    const next = screen.getByLabelText('下一个月') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });

  it('一行都没摊开时那颗不出现——它翻的是看不见的月历', () => {
    show([done('喝水', 18), live('喝水')]);
    expect(screen.queryByLabelText('上一个月')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开「喝水」的月历'));
    expect(screen.getByLabelText('上一个月')).toBeTruthy();
  });
});
