import { createElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { DragEndEvent } from '@dnd-kit/core';
import { REORDER_CONFIRM_TIMEOUT_MS, TodayView } from './TodayView.js';
import { FIRST_RUN_HINT } from '../lib/firstRun.js';
import { TaskGrid } from './TaskGrid.js';
import { groupProposals, type ProposalWiring } from './ProposalNote.js';
import { btnIn, keyboardDrag, mockDndRects, NoMotion, pickCardMenu } from '../test-utils.js';
import type { Repeat, Task } from '../types.js';

/**
 * 复审修复轮 1 · I1：`handleDragEnd` 里 `over === null` 这条分支，jsdom 里
 * 逼不出真实场景（`@dnd-kit` 的最近邻碰撞检测在这种小夹具下总能找到一个
 * 「最近」的目标）——**不等于测不了**，见 `TaskGrid.test.tsx` 顶部同款注释：
 * `vi.mock('@dnd-kit/core', …)` 部分替换，只在真实 `DndContext` 外面包一层
 * 把它收到的 `onDragEnd` 存进 `dndCapture`，其余全部走真实实现。
 */
const dndCapture = vi.hoisted(() => ({ onDragEnd: null as ((e: DragEndEvent) => void) | null }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...real,
    DndContext: (props: Parameters<typeof real.DndContext>[0]) => {
      dndCapture.onDragEnd = props.onDragEnd ?? null;
      return createElement(real.DndContext, props);
    },
  };
});

const NOW = new Date('2026-08-10T12:00:00.000Z');
const localIso = (y: number, m: number, d: number, h = 0, mi = 0): string => new Date(y, m - 1, d, h, mi).toISOString();
const LOCAL_NOW = new Date(2026, 7, 10, 12, 0, 0);

let n = 0;
const task = (p: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `任务${n}`, notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

const noop = () => {};
const noopAsync = async () => {};
const noopReorder = async () => {};

/** 上移/下移按钮：按 `aria-label` 属性直接查，不用 `getAllByRole`。
 *
 * 跟 `test-utils.tsx` 里 `pickCardMenu`/`btnIn` 顶上那条注释是同一个坑：
 * `getByRole`/`getAllByRole` 要对每个候选按钮的祖先链单独算一遍可访问性
 * （含 `getComputedStyle`），这个视图渲染出的候选按钮不算多，但这两个
 * 查询在下面这些测试里大多被 `waitFor` 反复调用——实测单次查询在这个环境
 * 里就要大几百毫秒到一秒多，摊到一条测试里的好几次 `waitFor` 轮询上就是
 * 这个文件真正在向每一批测试收的税，不是在等哪个真实定时器。
 * `aria-label` 是这两颗按钮硬编码在 TaskCard.tsx 里的字面属性，跟走
 * `getByRole` 判定出的可访问名字是同一个值，换查法不改变查到的是谁。 */
const upButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="上移"]')];
const downButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="下移"]')];

describe('TodayView：成员资格——只装过期/今天提醒/今天截止，不含 done/later', () => {
  it('过期未完成的任务出现', () => {
    const t = task({ title: '早该做了', due: '2026-08-01T00:00:00.000Z' });
    render(<TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.getByText('早该做了')).toBeDefined();
  });

  it('今天提醒、今天截止的任务出现，明天的不出现', () => {
    const remindToday = task({ title: '今天提醒', reminders: [{ at: localIso(2026, 8, 10, 9, 0), firedAt: null }] });
    const dueToday = task({ title: '今天截止', due: localIso(2026, 8, 10, 20, 0) });
    const dueTomorrow = task({ title: '明天截止', due: localIso(2026, 8, 11, 9, 0) });
    render(
      <TodayView lists={[]} tasks={[remindToday, dueToday, dueTomorrow]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    expect(screen.getByText('今天提醒')).toBeDefined();
    expect(screen.getByText('今天截止')).toBeDefined();
    expect(screen.queryByText('明天截止')).toBeNull();
  });

  it('done 和 later 都不出现，哪怕过期或者今天截止', () => {
    const done = task({ title: '做完了', status: 'done', due: '2026-08-01T00:00:00.000Z' });
    const later = task({ title: '搁置了', status: 'later', due: '2026-08-01T00:00:00.000Z' });
    render(<TodayView lists={[]} tasks={[done, later]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.queryByText('做完了')).toBeNull();
    expect(screen.queryByText('搁置了')).toBeNull();
  });

  it('**一条任务都没有时说的是「从哪儿开始」**，不是「今天没有要做的」——后者把「你今天很闲」和「这个应用还是空的」说成了同一句话', () => {
    render(<TodayView lists={[]} tasks={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.getByText(FIRST_RUN_HINT)).toBeDefined();
    expect(screen.queryByText('今天没有要做的')).toBeNull();
  });

  it('任务都不满足今天的成员资格时（比如都是明天的），同样显示「今天没有要做的」', () => {
    const tomorrow = task({ title: '明天的', due: localIso(2026, 8, 11, 9, 0) });
    render(<TodayView lists={[]} tasks={[tomorrow]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.getByText('今天没有要做的')).toBeDefined();
  });
});

/**
 * 头上那一行。算什么在 `lib/workload.test.ts`（含「几条是欠着的债」和「预计
 * 多久」两截），这里只测接线：数的是这个列表里的那几条。
 *
 * 夹具都用 8/1 到期的过期任务（那是「今天」最容易凑出来的成员资格），所以
 * 断言里都带着「都已经过期」那半句。
 */
describe('TodayView：头上那一行', () => {
  /** 只读这一行自己的文字：里面还可能挂着一颗「全部改到今天」，
   *  `textContent` 会把按钮上的字一起吃进来。 */
  const meta = () => {
    const el = document.querySelector('.ink-source-meta');
    return [...(el?.childNodes ?? [])]
      .filter((x) => x.nodeType === Node.TEXT_NODE)
      .map((x) => x.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  };

  it('条数后面挂上预计时长，数的是列表里这几条', () => {
    const a = task({ title: 'A', due: '2026-08-01T00:00:00.000Z', estimateMinutes: 30 });
    const b = task({ title: 'B', due: '2026-08-01T00:00:00.000Z', estimateMinutes: 45 });
    render(<TodayView lists={[]} tasks={[a, b]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(meta()).toBe('2 条，都已经过期 · 预计 1 小时 15 分');
  });

  it('**不在今天的那条不算进去**——两个数字数的必须是同一批任务', () => {
    const today = task({ title: '今天', due: '2026-08-01T00:00:00.000Z', estimateMinutes: 30 });
    const tomorrow = task({ title: '明天', due: localIso(2026, 8, 11, 9, 0), estimateMinutes: 600 });
    render(<TodayView lists={[]} tasks={[today, tomorrow]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(meta()).toBe('1 条，都已经过期 · 预计 30 分钟');
  });

  it('一条都没估过时那一行没有「预计」那半句——不报「预计 0 分钟」', () => {
    const a = task({ title: 'A', due: '2026-08-01T00:00:00.000Z' });
    render(<TodayView lists={[]} tasks={[a]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(meta()).toBe('1 条，都已经过期');
  });

  /**
   * 上面那行刚报完「9 条已过期」——**看见了债，却没有就地还债的地方**。这个
   * 动作原来只在命令面板和「接下来」的组头上有，而「今天」才是最常看见这个
   * 数字的地方。
   */
  it('有过期的时候挂一颗「全部改到今天」，推的是上面那个数字数的那几条', () => {
    const onDefer = vi.fn();
    const late = task({ id: 'a', title: '欠着的', due: localIso(2026, 8, 1, 9) });
    const soon = task({ id: 'b', title: '今天的', due: localIso(2026, 8, 10, 20) });
    render(<TodayView lists={[]} tasks={[late, soon]} now={LOCAL_NOW} onPatch={noop}
      onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} onDeferOverdue={onDefer} />);

    fireEvent.click(screen.getByRole('button', { name: '全部改到今天' }));

    expect(onDefer).toHaveBeenCalledTimes(1);
    expect((onDefer.mock.calls[0][0] as Task[]).map((t) => t.id)).toEqual(['a']);
  });

  it('一条都没过期时那颗按钮不出现——不摆一个点了改零条的入口', () => {
    render(<TodayView lists={[]} tasks={[task({ id: 'b', due: localIso(2026, 8, 10, 20) })]} now={LOCAL_NOW}
      onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} onDeferOverdue={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '全部改到今天' })).toBeNull();
  });

  it('不给 onDeferOverdue 就不画——它要发请求、还要先弹一句确认，调用方没接就不该摆这个入口', () => {
    render(<TodayView lists={[]} tasks={[task({ id: 'a', due: localIso(2026, 8, 1, 9) })]} now={LOCAL_NOW}
      onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.queryByRole('button', { name: '全部改到今天' })).toBeNull();
  });
});

describe('TodayView：排序——按 order，null 沉底', () => {
  it('渲染顺序按 order 升序', () => {
    const a = task({ title: 'A', due: '2026-08-01T00:00:00.000Z', order: 1 });
    const b = task({ title: 'B', due: '2026-08-01T00:00:00.000Z', order: 0 });
    const { container } = render(<TodayView lists={[]} tasks={[a, b]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    const titles = Array.from(container.querySelectorAll('.ant-typography strong')).map((el) => el.textContent);
    expect(titles).toEqual(['B', 'A']);
  });
});

describe('TodayView：键盘可达的手动排序', () => {
  const overdue = (over: Partial<Task>) => task({ due: '2000-01-01T00:00:00.000Z', ...over });

  it('上移/下移是原生 button，边界处禁用——第一条的上移按钮不可用', () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    render(<TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);

    expect(upButtons()[0].tagName).toBe('BUTTON');
    expect(upButtons()[0].disabled).toBe(true);
    expect(downButtons()[1].disabled).toBe(true);
  });

  it('点第一条的下移：调用 onReorder，参数是互换后的整份 order；成功后播报新位置（键盘用户能看到发生了什么）', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    fireEvent.click(downButtons()[0]);   // 第一条（第一条）下移

    expect(onReorder).toHaveBeenCalledWith([{ id: 't2', order: 0 }, { id: 't1', order: 1 }]);
    await waitFor(() => expect(screen.getByText(/第一条.*第 2 位/)).toBeDefined());
  });

  it('onReorder 失败：播报错误信息，不假装成功——重排是一次写，失败不能表现得像什么都没发生', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const onReorder = vi.fn().mockRejectedValue(new Error('网络断了'));
    render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    fireEvent.click(downButtons()[0]);

    await waitFor(() => expect(screen.getByText(/网络断了/)).toBeDefined());
  });

  it('两次连续失败播报同一句话——底层 DOM 节点必须真的换过一次，字符串没变时 React 会把 setState 吞掉、什么都不念', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const onReorder = vi.fn().mockRejectedValue(new Error('网络断了'));
    // NoMotion：antd Button 的 loading 图标走 rc-motion，jsdom 不派发
    // transitionend，把 motion 关掉让它直接跳到终态，减少下面这个「两次点击
    // 靠得够近」场景撞上过渡态的机会——跟 App.test.tsx 处理同一类问题是同一
    // 个办法。但光禁 motion 不够：antd Button 自己的 `loading` 内部状态要
    // 再等一轮 effect 才追上 props，跟 CSS 过渡无关，实测在系统负载重时
    // 复现过一次——`disabled` 属性已经是 false，但 `ant-btn-loading` 这个
    // class 还没摘掉，第二次点击被 antd 自己内部按「还在 loading」吞掉，
    // `onReorder` 少算一次调用。真正要等的是这个 class，不是我们自己那个
    // `disabled` 属性——下面 waitFor 两个都查。
    const { container } = render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    const liveText = () => container.querySelector('[aria-live]')?.textContent ?? '';
    fireEvent.click(downButtons()[0]);
    await waitFor(() => expect(liveText()).toMatch(/网络断了/));
    const firstNode = container.querySelector('[aria-live]');

    await waitFor(() => {
      const btn = downButtons()[0];
      expect(btn.disabled).toBe(false);
      expect(btn.className).not.toMatch(/ant-btn-loading\b/);
    });
    fireEvent.click(downButtons()[0]);
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(liveText()).toMatch(/网络断了/));
    const secondNode = container.querySelector('[aria-live]');

    // 两次播报的文字完全一样（都是「移动失败：网络断了」）——如果只是单纯
    // setState 成同一个字符串，React 会认定没有变化、连 DOM 都不碰，屏幕
    // 阅读器听不到第二次。这里要求承载文字的节点真的被换过一次。
    expect(secondNode).not.toBe(firstNode);
  });

  it('写成功之后按钮不会立刻解禁：要等 tasks 这个 prop 真的刷新到写入的新顺序（模拟 watcher/SSE/reload 那条链路）——不然连点两次会拿旧列表算出错误的 pairs', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const onReorder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    fireEvent.click(downButtons()[0]);
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));

    // 写已经成功了（onReorder resolve 了），但 tasks 这个 prop 还是重排之前
    // 那份——真实场景里这段窗口至少 200ms（文件监听器的去抖）。这期间所有
    // 卡的上/下移按钮都必须还是禁用的。
    await waitFor(() => expect(downButtons()).toHaveLength(2));
    await waitFor(() => expect(downButtons().every((b) => b.disabled)).toBe(true));
    expect(upButtons()).toHaveLength(2);
    expect(upButtons().every((b) => b.disabled)).toBe(true);

    rerender(
      <NoMotion><AntApp>
        <TodayView
          lists={[]}
          tasks={[{ ...t2, order: 0 }, { ...t1, order: 1 }]}
          now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder}
        />
      </AntApp></NoMotion>,
    );

    await waitFor(() => expect(downButtons().some((b) => !b.disabled)).toBe(true));
  });

  it('一次移动确认刷新之前，其它卡（这次没被点的那张）的按钮也一起禁用——防止「移动 A 又立刻移动 C」用旧列表算出错误的 pairs', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const t3 = overdue({ id: 't3', title: '第三条', order: 2 });
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2, t3]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    fireEvent.click(downButtons()[0]);   // 移动第一条
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));

    // 第三条跟这次移动完全无关——用它的「上移」按钮断言：它排最后，边界规则
    // 本身不会禁用「上移」，这里如果是禁用的，只能是因为「还有一次移动没被
    // 确认刷新」这条全局忙碌状态在起作用，不是巧合撞上了边界禁用。
    await waitFor(() => expect(upButtons()[2].disabled).toBe(true));
  });

  it('刷新真的到达之后，焦点回到操作过的那张卡上，不会被浏览器打回 <body>；原来点的方向在新位置上越界了就退到另一个方向', async () => {
    const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
    const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
    const onReorder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
      </AntApp></NoMotion>,
    );

    downButtons()[0].focus();
    fireEvent.click(downButtons()[0]);   // 第一条下移到最后一位
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));

    rerender(
      <NoMotion><AntApp>
        <TodayView
          lists={[]}
          tasks={[{ ...t2, order: 0 }, { ...t1, order: 1 }]}
          now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder}
        />
      </AntApp></NoMotion>,
    );

    // 第一条现在排最后，「下移」在新位置上越界禁用——焦点退到同一张卡的
    // 「上移」，不会被浏览器打回 <body>。
    await waitFor(() => {
      const buttons = upButtons();
      expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    });
  });

  it('刷新迟迟没到达——兜底超时之后按钮还是会重新启用，不会被卡死在禁用状态', async () => {
    vi.useFakeTimers();
    try {
      const t1 = overdue({ id: 't1', title: '第一条', order: 0 });
      const t2 = overdue({ id: 't2', title: '第二条', order: 1 });
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(
        <NoMotion><AntApp>
          <TodayView lists={[]} tasks={[t1, t2]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} />
        </AntApp></NoMotion>,
      );

      fireEvent.click(downButtons()[0]);

      // 让 onReorder 的 resolve 落地（两轮微任务：一次 await，一次 catch/then
      // 链），tasks 这个 prop 全程没有更新——模拟刷新真的没送回来。
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(downButtons()).toHaveLength(2);
      expect(downButtons().every((b) => b.disabled)).toBe(true);

      act(() => { vi.advanceTimersByTime(REORDER_CONFIRM_TIMEOUT_MS); });
      expect(downButtons().some((b) => !b.disabled)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TodayView：区域/列表语义——「按来源」每组都有 section+heading，这个作为落地页替代的视图不该是裸 div', () => {
  it('内容包在有名字的 section 里——aria-labelledby 指向一个真实存在的 heading，屏幕阅读器能跳到它', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(<TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    const headingId = section!.getAttribute('aria-labelledby');
    expect(headingId).toBeTruthy();
    const heading = document.getElementById(headingId!);
    expect(heading).not.toBeNull();
    expect(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']).toContain(heading!.tagName);
  });

  it('列表本身有 list/listitem 语义，不是一串裸 div', () => {
    const a = task({ id: 'a', due: '2026-08-01T00:00:00.000Z' });
    const b = task({ id: 'b', due: '2026-08-02T00:00:00.000Z' });
    render(<TodayView lists={[]} tasks={[a, b]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.getByRole('list')).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('显示当前条数——「按来源」每组都在标题下面标了「拆成 N 条」，今天这个当默认落地页的视图完全没有数字可看', () => {
    const a = task({ id: 'a', due: '2026-08-01T00:00:00.000Z' });
    const b = task({ id: 'b', due: '2026-08-02T00:00:00.000Z' });
    render(<TodayView lists={[]} tasks={[a, b]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    expect(screen.getByText(/2\s*条/)).toBeDefined();
  });
});

describe('TodayView：复用 TaskCard 的既有行为', () => {
  it('子任务能勾选', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z', subtasks: [{ text: '第一步', done: false }] });
    const onPatch = vi.fn();
    render(<TodayView lists={[]} tasks={[t]} now={NOW} onPatch={onPatch} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);
    fireEvent.click(screen.getByText('第一步'));
    expect(onPatch).toHaveBeenCalledWith(t.id, { subtasks: [{ text: '第一步', done: true }] });
  });

  it('能编辑并保存', async () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z', title: '原标题' });
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(<TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={onEditTask} onDelete={noop} onReorder={noopReorder} />);

    await pickCardMenu('编辑');
    const titleBox = screen.getByPlaceholderText('标题');
    fireEvent.change(titleBox, { target: { value: '改过的标题' } });
    fireEvent.click(btnIn(document.body, '保存'));

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith(t.id, { title: '改过的标题', notes: '', due: t.due, startAt: null, endAt: null, persistentReminder: false, priority: t.priority, tags: t.tags, listId: t.listId, section: null, repeat: t.repeat, parentId: null, estimateMinutes: null, habit: false, waitingFor: null, context: null, reminders: [] }));
  });
});

/**
 * 拖放的接线（task-3-brief：原生 HTML5 拖放换成 `@dnd-kit`，键盘也能拖）。
 * jsdom 不算真实布局，`@dnd-kit` 的键盘碰撞检测靠 `getBoundingClientRect()`
 * 判断方向——`mockDndRects` 按行在 DOM 里出现的顺序造一份假的纵向矩形。
 * 这几条守的是「处理函数还接在该接的地方、算出来的顺序跟按钮那条路一致」，
 * 回归了要红；键盘（Tab 到抓手→Space 拿起→方向键移动→Space 放下）是这个
 * Task 换成 `@dnd-kit` 之后真正新增的能力，以前只有鼠标能拖。
 */
describe('TodayView：拖放排序', () => {
  const three = () => [
    task({ id: 'a', title: 'A', due: '2026-08-01T00:00:00.000Z', order: 0 }),
    task({ id: 'b', title: 'B', due: '2026-08-01T00:00:00.000Z', order: 1 }),
    task({ id: 'c', title: 'C', due: '2026-08-01T00:00:00.000Z', order: 2 }),
  ];
  const rows = () => document.querySelectorAll('.ink-today-row');
  const handle = (i: number) => rows()[i].querySelector<HTMLElement>('.ink-rank')!;

  it('键盘：Tab 到抓手→Space 拿起→ArrowDown 两次→Space 放下——把第一条拖到末尾，提交的是整份新顺序', async () => {
    const restore = mockDndRects('.ink-today-row', { vertical: true, gap: 50 });
    try {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);

      await keyboardDrag(handle(0), ['ArrowDown', 'ArrowDown']);

      await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
        { id: 'b', order: 0 }, { id: 'c', order: 1 }, { id: 'a', order: 2 },
      ]));
    } finally {
      restore();
    }
  });

  /**
   * 守卫②「拖回原地不发回调」：Space 拿起中间那条、不按任何方向键、立刻
   * 再按一次 Space 放下——`over` 就是它自己，`moveTo()`（taskView.ts）里
   * `from === to` 那道判断会返回 null，`handleDragEnd` 因此不调用 commit。
   */
  it('守卫②：拖回原地（Space 立刻再 Space）不发起写——一次没有变化的重排会白占掉 tasks.json 唯一那份 .bak', async () => {
    const restore = mockDndRects('.ink-today-row', { vertical: true, gap: 50 });
    try {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);

      await keyboardDrag(handle(1));

      expect(onReorder).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /**
   * 守卫①「外来拖拽不转发」：`@dnd-kit` 只在自己的 `DndContext` 里派发
   * `active`/`over`，不监听浏览器原生 Drag and Drop 事件——对着行直接派发
   * 原生 dragover/drop（不经过 `@dnd-kit` 的指针/键盘监听器），不该触发
   * `onReorder`。**验证这一点，不是假设**。
   */
  it('守卫①：原生拖放事件（外来拖拽）不会被转发——@dnd-kit 不监听这套事件', () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => '这是一段被选中的普通文字，不是任务 id'), effectAllowed: '', dropEffect: '' };
    const notCanceled = fireEvent.dragOver(rows()[2], { dataTransfer });
    expect(notCanceled).toBe(true);
    fireEvent.drop(rows()[2], { dataTransfer });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('拖动时被拖的那行标出来，松手后标记清掉', async () => {
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} /></AntApp>);

    const h = handle(0);
    h.focus();
    fireEvent.keyDown(h, { code: 'Space', key: ' ' });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.ink-row-dragging').length).toBe(1);

    fireEvent.keyDown(h, { code: 'Space', key: ' ' });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.ink-row-dragging').length).toBe(0);
  });

  it('键盘那条路没被拖放挤掉——上/下移按钮还在，且跟拖放算出同一个结果', async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);

    const down = downButtons()[0];
    fireEvent.click(down);

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      { id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 },
    ]));
  });

  /**
   * 被拖的那条在拖动中途从列表里消失（SSE 把它标成完成/删了/提醒触发……
   * 都可能）——**这条钉的是行为，不是数 class**（复审修复轮 1 · C1：早前
   * 这里只断言 `.ink-row-dragging` 从 1 变回 0，而这个 class 挂在**消失的
   * 那一行自己**身上，它卸载了这个 class 必然消失，测不出 `@dnd-kit`
   * 内部的键盘会话有没有真的解除——`TodayView.tsx` 第一版压根没有接
   * `useCancelStuckDrag`，这条断言在那个坏实现下同样全绿，是复审抓到的
   * 教科书级「断言查的层次比缺陷所在的层次浅了一层」）。**真正要证明的是
   * 「下一次真的还能拖」**：a 拿起后消失，紧接着对 b 走一次完整的键盘拖拽
   * 序列，`onReorder` 必须真的被调用——如果 `@dnd-kit` 的键盘会话卡在 a
   * 身上没解除，b 抓手上的新 Space 不会被 `KeyboardSensor` 响应（它的
   * activator 只认 `event.target === active.activatorNode.current`），这条
   * 会直接看到 `onReorder` 零调用。
   */
  it('被拖的那条中途从列表里消失，不会卡死键盘会话——紧接着对另一条的拖拽照样能提交', async () => {
    const restore = mockDndRects('.ink-today-row', { vertical: true, gap: 50 });
    try {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(
        <AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>,
      );
      const h = handle(0);
      h.focus();
      fireEvent.keyDown(h, { code: 'Space', key: ' ' });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.querySelectorAll('.ink-row-dragging').length).toBe(1);

      // SSE 刷新把 a 标成完成 → 它离开「今天」，那一行连同它的键盘拖拽会话一起没了
      rerender(
        <AntApp><TodayView lists={[]} tasks={three().filter((t) => t.id !== 'a')} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>,
      );
      // useCancelStuckDrag 的派发在 useEffect 里，等它跑完这一轮。
      await new Promise((r) => setTimeout(r, 0));
      expect(document.querySelectorAll('.ink-row-dragging').length).toBe(0);
      expect(onReorder).not.toHaveBeenCalled();

      // 真正的行为断言：b（现在排第一）能被拖动完成，onReorder 真的收到调用。
      await keyboardDrag(handle(0), ['ArrowDown']);
      await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
        { id: 'c', order: 0 }, { id: 'b', order: 1 },
      ]));
    } finally {
      restore();
    }
  });

  /**
   * 复审修复轮 1 · I1：`handleDragEnd` 里 `over === null` 这条分支——之前
   * 被记成「测不了」，实测证伪。`dndCapture.onDragEnd` 是文件顶部
   * `vi.mock('@dnd-kit/core', …)` 抓到的、`TodayView.tsx` 真实传给
   * `<DndContext>` 的那个 `handleDragEnd` 函数本身，不是重新实现的一份。
   */
  describe('守卫（I1）：over === null 不发 onReorder——手工喂事件，不是假设测不了', () => {
    it('对照组：手工喂一个合法的 over，onReorder 精确调用一次——证明抓到的是真实可用的 handleDragEnd，不是空转', () => {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);
      expect(dndCapture.onDragEnd).not.toBeNull();
      dndCapture.onDragEnd!({ active: { id: 'a' }, over: { id: 'c' } } as unknown as DragEndEvent);
      expect(onReorder).toHaveBeenCalledWith([{ id: 'b', order: 0 }, { id: 'c', order: 1 }, { id: 'a', order: 2 }]);
    });

    it('over 是 null（拖出了所有放置目标之外）：不发 onReorder', () => {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);
      expect(dndCapture.onDragEnd).not.toBeNull();
      // 变异验证锚点：TodayView.tsx handleDragEnd 里的 `if (!over || status) return;`
      // 去掉 `!over` 这半——这条会红（over 是 null，`String(over.id)` 会
      // 抛 TypeError，或者改成更宽松的写法会让 onReorder 被意外调用）。
      dndCapture.onDragEnd!({ active: { id: 'a' }, over: null } as unknown as DragEndEvent);
      expect(onReorder).not.toHaveBeenCalled();
    });
  });

  /**
   * 复审修复轮 1 · m1：`TodayView.tsx` 换成 `@dnd-kit` 之后第一版的
   * `handleDragEnd` 漏掉了原生实现 `onDrop` 里 `if (!id || status) return`
   * 的这一半——`useSortable({disabled: status !== null})` 挡住的是「拿起」
   * 这一步，挡不住「已经拿起、status 才变化」这种时序：键盘会话开着的同时，
   * 用户用鼠标点了另一行的上/下移按钮触发了一次新的提交，这一刻 `status`
   * 已经不是 `null` 了，`ordered` 对应的还是提交前那份旧顺序，不能再拿它
   * 算 pairs。这里用 `onReorder` 永远不 resolve 模拟「上一次提交还没落定」，
   * 手工喂一个合法的 `over` 给真实的 `handleDragEnd`，确认它不会因此再发起
   * 第二次提交。
   */
  it('守卫（m1）：上一次移动还没落定时，即使收到合法的 over 也不会再发起一次新的提交', async () => {
    const onReorder = vi.fn(() => new Promise<void>(() => {})); // 故意永远不 resolve
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} /></AntApp>);

    fireEvent.click(downButtons()[0]);
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));

    expect(dndCapture.onDragEnd).not.toBeNull();
    // 变异验证锚点：TodayView.tsx handleDragEnd 里的 `if (!over || status) return;`
    // 去掉 `status` 这半——这条会红（明明上一次提交还悬着，这里还是又发了
    // 一次）。
    dndCapture.onDragEnd!({ active: { id: 'b' }, over: { id: 'c' } } as unknown as DragEndEvent);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});

describe('TodayView：网格化之后的两条约定', () => {
  const t3 = () => [
    task({ id: 'a', title: 'A', due: '2026-08-01T00:00:00.000Z', order: 0, aiComment: '这条的拆解理由' }),
    task({ id: 'b', title: 'B', due: '2026-08-01T00:00:00.000Z', order: 1 }),
  ];

  it('每张卡自己带序号——多列排布下读序不能靠位置推断', () => {
    render(<AntApp><TodayView lists={[]} tasks={t3()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} /></AntApp>);

    const ranks = [...document.querySelectorAll('.ink-rank')].map((e) => e.textContent);
    expect(ranks).toEqual(['1', '2']);
  });

  it('「今天」不显示 AI 的拆解理由——这个视图问的是「我现在该干哪个」，理由在这儿是噪音', () => {
    render(<AntApp><TodayView lists={[]} tasks={t3()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} /></AntApp>);

    expect(screen.queryByText('AI 的拆解理由')).toBeNull();
    expect(screen.queryByText(/这条的拆解理由/)).toBeNull();
  });
});

/**
 * 打卡条（Task 3，见 task-3-brief.md）：规格「在『今天』里显示成连续打卡条」。
 * `habitStreak()`（Task 2）本身已经被 `lib/habit.test.ts` 盯着，这里只测
 * TodayView 这一层的接线——传没传对参数、只在这一个视图渲染、0 天不显示。
 */
describe('TodayView：打卡条', () => {
  const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

  it('习惯任务显示连续打卡条，天数按完整 tasks 算——包含已经不在「今天」列表里的历史（那条是 done，被成员资格筛掉了）', () => {
    const yesterdayDone = task({
      id: 'h0', title: '喝水', habit: true, repeat: DAILY, status: 'done',
      completedAt: localIso(2026, 8, 9, 9),
    });
    const todayPending = task({
      id: 'h1', title: '喝水', habit: true, repeat: DAILY,
      completedAt: null, due: localIso(2026, 8, 10, 20),
    });
    render(
      <TodayView lists={[]} tasks={[yesterdayDone, todayPending]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    // yesterdayDone 本身不出现在「今天」的列表里（done 被筛掉），但它的
    // completedAt 仍然要被算进 todayPending 的连续天数——如果接线时只把
    // `ordered`/`visible` 那份已经过滤过的列表传给 habitStreak，这里会数成
    // 0 天，断言就会失败。
    expect(screen.getByText(/连续 1 天/)).toBeDefined();
    expect(screen.getByText(/今天还没打卡/)).toBeDefined();
  });

  // 上限：streak===0 且 doneToday===false（还没打过卡的习惯）不显示打卡条——
  // 挂一个「连续 0 天」是噪音。
  it('streak 0 且今天没打卡的习惯任务——不显示打卡条', () => {
    const t = task({
      due: localIso(2026, 8, 10, 20), habit: true, repeat: DAILY, completedAt: null,
    });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    expect(container.querySelector('.ink-habit-streak')).toBeNull();
  });

  it('不是习惯的任务——不显示打卡条', () => {
    const t = task({ due: localIso(2026, 8, 10, 20), habit: false });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    expect(container.querySelector('.ink-habit-streak')).toBeNull();
  });

  // 上限：只在「今天」——同一条有连续天数的习惯任务，经另一个共用 TaskCard
  // 的视图（TaskGrid：看板/四象限/全部……都是它）渲染，不该看到打卡条。
  // HabitStreak.tsx 只从 TodayView.tsx 被引用，TaskGrid/TaskCard 都不认识
  // 它——这条测试钉住「以后有人手滑把它接进别的视图」这件事会红。
  it('别的视图不显示打卡条——同一条有连续天数的习惯任务经 TaskGrid 渲染看不到', () => {
    const t = task({
      title: '喝水', habit: true, repeat: DAILY,
      completedAt: localIso(2026, 8, 9, 9), due: localIso(2026, 8, 10, 20),
    });
    render(
      <AntApp>
        <TaskGrid sections={() => [{ key: 'a', title: '组', tasks: [t] }]} empty="没有" now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} lists={[]} />
      </AntApp>,
    );
    expect(document.querySelector('.ink-habit-streak')).toBeNull();
    expect(screen.queryByText(/连续/)).toBeNull();
  });
});

/**
 * 行档（task-5-brief）：`TodayView` 不走 `TaskGrid`，密度分支是这个文件自己
 * 手写的——`TaskGrid.test.tsx`/`App.test.tsx` 的密度循环测的是 `TaskGrid`
 * 那五个接线点，够不到这里，得单独测。
 */
describe('TodayView：行档（density="row"，task-5-brief）', () => {
  const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

  it('不传 density：默认卡档，渲染的还是 TaskCard——上限，今天的行为不变', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    expect(container.querySelector('.ant-card')).not.toBeNull();
    expect(container.querySelector('.ink-trow')).toBeNull();
  });

  it('density="row"：渲染的是 TaskRow，不是 TaskCard', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" />,
    );
    expect(container.querySelector('.ink-trow')).not.toBeNull();
    expect(container.querySelector('.ant-card')).toBeNull();
  });

  // 上限断言（task-3-brief 要点②「行档改单列」）：列表容器的 class 也要按
  // density 二选一，不只是行/卡组件本身换了——「今天」是手动排序的列表，
  // 两列会让顺序左右横跳着排，见 theme.css .ink-row-list 上面的注释。
  it('不传 density：容器是 .ink-card-grid，不是 .ink-row-list——卡档不许被顺手改成单列（上限）', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    expect(container.querySelector('.ink-card-grid')).not.toBeNull();
    expect(container.querySelector('.ink-row-list')).toBeNull();
  });

  it('density="row"：容器换成 .ink-row-list（单列），不再是 .ink-card-grid', () => {
    // 变异验证锚点：TodayView.tsx 里那句
    // `density === 'row' ? 'ink-row-list' : 'ink-card-grid'` 换成永远
    // 'ink-card-grid'——上一条「不传 density」的用例照样绿，这条会红。
    const t = task({ due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" />,
    );
    expect(container.querySelector('.ink-row-list')).not.toBeNull();
    expect(container.querySelector('.ink-card-grid')).toBeNull();
  });

  it('行档下点标题：展开成完整的 TaskCard（复用 editingIds，跟 TaskGrid.tsx 的 density 分支同一个套路）', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z', title: '写周报' });
    render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" />,
    );
    // 用 title 属性查，不用可访问名字——行体按钮把标题和到期 chip 拼在同一个
    // 可访问名字里（「写周报8月1日」），跟 TaskRow.test.tsx「标题超长时 title
    // 属性给全文」那条测试同一个理由，title 属性只有 t.title 本身，不受
    // meta 区内容影响。
    fireEvent.click(screen.getByTitle('写周报'));
    expect(document.querySelector('.ant-card')).not.toBeNull();
    expect(document.querySelector('.ink-trow')).toBeNull();
  });

  // 整分支审查 A 组：展开成卡之后，再点一次标题——直接收回成行，不用绕
  // 「⋯ → 编辑 → 取消」，见 TaskCard.tsx 标题 onClick 上面的长注释。
  it('行档下点标题两次：展开成卡，再点一次收回成行', () => {
    const t = task({ due: '2026-08-01T00:00:00.000Z', title: '写周报' });
    render(
      <TodayView lists={[]} tasks={[t]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" />,
    );
    fireEvent.click(screen.getByTitle('写周报'));
    expect(document.querySelector('.ant-card')).not.toBeNull();

    // 变异验证锚点：TaskCard.tsx 标题的 onClick 被删掉/改成恒不调用
    // onEditingChange——点了标题之后卡片纹丝不动，下面两条断言都会红。
    fireEvent.click(screen.getByText('写周报'));
    expect(document.querySelector('.ink-trow')).not.toBeNull();
    expect(document.querySelector('.ant-card')).toBeNull();
  });

  /**
   * 整分支审查 B1：`TaskGrid.tsx` 的 `hasProposal` 有对照组测试守着
   * （`TaskGrid.test.tsx` 那条「甲有建议长记号、乙没有不长」），`TodayView`
   * 因为不走 `TaskGrid`，以前自己复制了一份一模一样的算式，零测试跟过去——
   * 现在两处共用 `ProposalNote.tsx` 的 `hasPendingProposal`，这里补上
   * TodayView 那一半的对照组测试，跟 TaskGrid.test.tsx 那条同一个形状。
   */
  it('有待决建议的任务，行上出现 .ink-trow-proposal；没有的任务不出现（对照组）', () => {
    const withProposal = task({ id: 'p1', title: '甲', due: '2026-08-01T00:00:00.000Z' });
    const withoutProposal = task({ id: 'p2', title: '乙', due: '2026-08-01T00:00:00.000Z' });
    const proposals: ProposalWiring = {
      byTask: groupProposals([{
        id: 'pr1', taskId: 'p1', patch: { title: '改个标题' }, reason: '理由',
        createdAt: '2026-01-01T00:00:00.000Z',
      }]),
      onAccept: vi.fn(async () => ({})),
      onDismiss: vi.fn(async () => ({})),
    };
    render(
      <TodayView
        lists={[]} tasks={[withProposal, withoutProposal]} now={NOW}
        onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        density="row" proposals={proposals}
      />,
    );
    const rowFor = (title: string) => screen.getByText(title).closest('.ink-trow') as HTMLElement;
    // 变异验证锚点：TodayView.tsx 里 hasProposal 算式写死成 false（或者
    // <TaskRow> 那行忘了传 hasProposal）——「甲」那行的记号会消失，第一条
    // 断言会红；写死成 true 的话「乙」也会长出记号，第二条断言会红。
    expect(rowFor('甲').querySelector('.ink-trow-proposal')).not.toBeNull();
    expect(rowFor('乙').querySelector('.ink-trow-proposal')).toBeNull();
  });

  it('习惯任务：打卡条在行档下仍然渲染，且带上收窄的 class——brief「行档保留它，但排版要跟着收窄」', () => {
    // 照抄上面「TodayView：打卡条」那组已验证过的夹具（昨天打过卡的历史
    // 实例 + 今天待打卡的这条，streak 才不是 0）——不是随手拍一条新的，
    // 见那组第一条测试上面的注释。
    const yesterdayDone = task({
      id: 'h0', title: '喝水', habit: true, repeat: DAILY, status: 'done',
      completedAt: localIso(2026, 8, 9, 9),
    });
    const todayPending = task({
      id: 'h1', title: '喝水', habit: true, repeat: DAILY,
      completedAt: null, due: localIso(2026, 8, 10, 20),
    });
    const { container } = render(
      <TodayView lists={[]} tasks={[yesterdayDone, todayPending]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" />,
    );
    const streak = container.querySelector('.ink-habit-streak');
    expect(streak).not.toBeNull();
    expect(streak!.className).toContain('ink-habit-streak-compact');
    expect(container.querySelector('.ink-trow')).not.toBeNull();
  });

  it('对照组：卡档下同一份夹具，打卡条不带收窄 class', () => {
    const yesterdayDone = task({
      id: 'h0', title: '喝水', habit: true, repeat: DAILY, status: 'done',
      completedAt: localIso(2026, 8, 9, 9),
    });
    const todayPending = task({
      id: 'h1', title: '喝水', habit: true, repeat: DAILY,
      completedAt: null, due: localIso(2026, 8, 10, 20),
    });
    const { container } = render(
      <TodayView lists={[]} tasks={[yesterdayDone, todayPending]} now={LOCAL_NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    const streak = container.querySelector('.ink-habit-streak');
    expect(streak).not.toBeNull();
    expect(streak!.className).not.toContain('ink-habit-streak-compact');
  });
});

/**
 * 上限断言——task-5-brief 存在的唯一理由：行档下手动排序仍然有效，拖抓手
 * /点上下移之后顺序真的变了、并且落盘（`onReorder` 收到正确的 order）。
 * 照抄上面「TodayView：拖放排序」「TodayView：键盘可达的手动排序」两组
 * 卡档下已有的测试形状，只换成 `density="row"` + `TaskRow` 的抓手/菜单查询——
 * 拖放/按钮共用的是同一段 `commit()`，两条路的提交结果应该完全一致。
 */
describe('TodayView：行档下手动排序仍然有效（task-5 上限断言）', () => {
  const three = () => [
    task({ id: 'a', title: 'A', due: '2026-08-01T00:00:00.000Z', order: 0 }),
    task({ id: 'b', title: 'B', due: '2026-08-01T00:00:00.000Z', order: 1 }),
    task({ id: 'c', title: 'C', due: '2026-08-01T00:00:00.000Z', order: 2 }),
  ];
  const rows = () => document.querySelectorAll('.ink-today-row');
  const trow = (i: number) => rows()[i].querySelector('.ink-trow') as HTMLElement;

  it('键盘拖抓手把第一条拖到末尾：onReorder 收到整份新顺序', async () => {
    const restore = mockDndRects('.ink-today-row', { vertical: true, gap: 50 });
    try {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} density="row" /></AntApp>);

      fireEvent.mouseEnter(trow(0));
      const handle = trow(0).querySelector<HTMLElement>('.ink-trow-handle')!;
      await keyboardDrag(handle, ['ArrowDown', 'ArrowDown']);

      await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
        { id: 'b', order: 0 }, { id: 'c', order: 1 }, { id: 'a', order: 2 },
      ]));
    } finally {
      restore();
    }
  });

  it('点「更多」展开菜单、点「下移」：onReorder 收到互换后的 order，跟卡档按钮那条路结果一致', async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} density="row" /></AntApp>);

    const first = trow(0);
    fireEvent.mouseEnter(first);
    fireEvent.click(within(first).getByRole('button', { name: /更多操作/ }));
    fireEvent.click(within(first).getByRole('button', { name: '下移' }));

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      { id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 },
    ]));
  });

  it('点「更多」展开菜单、点「上移」：第二条移到最前，onReorder 收到对应的 order', async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} density="row" /></AntApp>);

    const second = trow(1);
    fireEvent.mouseEnter(second);
    fireEvent.click(within(second).getByRole('button', { name: /更多操作/ }));
    fireEvent.click(within(second).getByRole('button', { name: '上移' }));

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      { id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 },
    ]));
  });

  it('边界处禁用：第一条的「上移」在菜单里是 disabled，不是缺失', () => {
    render(<AntApp><TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} density="row" /></AntApp>);
    const first = trow(0);
    fireEvent.mouseEnter(first);
    fireEvent.click(within(first).getByRole('button', { name: /更多操作/ }));
    expect((within(first).getByRole('button', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * 修复轮 1 · C-1：真实浏览器里点一次上/下移，那颗按钮当场变成
   * disabled——浏览器会在这一刻把一个正聚焦的元素踢回 `<body>`
   * （`relatedTarget` 是 `null`），这不代表用户离开了这一行。
   * `TaskRow.tsx` 的 `onBlur` 在 `move.busy` 期间要跳过这个信号，否则
   * 菜单（连同 `upRef`/`downRef` 指向的那两颗按钮）被卸载，下面这个
   * 效果就找不到目标，行档会丢掉卡档本来就有的「刷新到达之后焦点回到
   * 操作过的那张卡」这条行为——键盘用户连续调整顺序（这个功能的主场景）
   * 会被迫每次都从头 Tab 一遍。
   *
   * jsdom 不模拟「禁用一个正聚焦的元素会自动把焦点踢回 body」这一步（这个
   * 仓库自己在真实 Chrome 里核实过：`document.activeElement` 确实变成
   * `document.body`），这里在点击之后显式派发 `focusOut(relatedTarget:
   * null)` 补上——不补的话这条测试测的是 jsdom 的假象，不是这条缺陷本来
   * 的样子。**这条测试本身要做变异**：去掉 `TaskRow.tsx` 里
   * `if (move?.busy) return;` 那一行必须红。
   */
  it('点下移之后模拟浏览器把焦点踢回 body：菜单不消失，写完落定之后焦点能找回按钮（task-5 修复轮 1 · C-1）', async () => {
    // 用三条——「A」下移一格之后落在中间（第 2/3 位），下移按钮还是可用的，
    // 断言能直接查「下移」本身找不找得回焦点，不用先处理「移到边界之后
    // 焦点该退到另一个方向」那层（那是既有行为，卡档已经测过，不是这条
    // 缺陷要盯的东西）。
    const onReorder = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <NoMotion><AntApp>
        <TodayView lists={[]} tasks={three()} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} density="row" />
      </AntApp></NoMotion>,
    );

    const first = trow(0);
    fireEvent.mouseEnter(first);
    fireEvent.click(within(first).getByRole('button', { name: /更多操作/ }));
    const down = within(first).getByRole('button', { name: '下移' }) as HTMLButtonElement;
    down.focus();
    fireEvent.click(down);

    // 这一刻 down 已经因为 busy 变成 disabled——真实浏览器会自动把焦点踢回
    // body，jsdom 不会，手工补上那个信号，跟真实浏览器观察到的完全一致
    // （relatedTarget 是 null）。
    fireEvent.focusOut(down, { relatedTarget: null });

    // 菜单不该消失：down 仍然在 DOM 里（disabled，但没被卸载）。
    expect(within(first).queryByRole('button', { name: '下移' })).not.toBeNull();

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      { id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 },
    ]));

    // 模拟「刷新到达」——跟上面「写成功之后按钮不会立刻解禁」那条卡档测试
    // 同一个手法：真实链路是文件监听器→SSE→reload，这里直接 rerender 成
    // 写入后的新顺序。「A」现在排第 2 位（0-based index 1），下移仍然可用
    // （后面还有「C」）。
    const original = three(); // [a(order0), b(order1), c(order2)]
    rerender(
      <NoMotion><AntApp>
        <TodayView
          lists={[]}
          tasks={[
            { ...original[1], order: 0 }, // b
            { ...original[0], order: 1 }, // a
            { ...original[2], order: 2 }, // c
          ]}
          now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} onReorder={onReorder} density="row"
        />
      </AntApp></NoMotion>,
    );

    // 写完落定之后，TodayView 的焦点归还 effect 应该能找到这颗按钮（因为
    // 它一直没被卸载）并把焦点还给它——跟卡档「刷新到达之后焦点回到操作过
    // 的那张卡」是同一条行为，行档不该因为这个缺陷而失去它。
    await waitFor(() => {
      const btn = within(first).getByRole('button', { name: '下移' }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(document.activeElement).toBe(btn);
    });
  });
});

/**
 * 「今天完成的」那一节。补的是这个应用里最高频那一步之后的空白：点完成，
 * 卡片当场从「今天」消失——看不到自己今天做了什么，点错了也没有退路
 * （撤销得先想起来去「已完成」里翻）。
 */
describe('TodayView：今天完成的', () => {
  const doneAt = (h: number) => localIso(2026, 8, 10, h);
  const show = (tasks: Task[], onPatch = noop) =>
    render(<TodayView lists={[]} tasks={tasks} now={LOCAL_NOW} onPatch={onPatch}
      onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />);

  it('一条都没完成时整节不出现', () => {
    show([task({ title: '还没做', due: localIso(2026, 8, 10, 20) })]);
    expect(screen.queryByText(/今天完成的/)).toBeNull();
  });

  it('今天做完的列出来，带条数', () => {
    show([task({ title: '做完了', status: 'done', completedAt: doneAt(9) })]);
    expect(screen.getByText('今天完成的 1 条')).toBeTruthy();
    expect(screen.getByText('做完了')).toBeTruthy();
  });

  it('**默认折叠**——一天做完十几件事之后，展开着会把真正要做的挤到屏幕外面', () => {
    const { container } = show([task({ title: '做完了', status: 'done', completedAt: doneAt(9) })]);
    expect((container.querySelector('.ink-today-done') as HTMLDetailsElement).open).toBe(false);
  });

  it('**昨天做完的不算**——那是「已完成」那个去处的事', () => {
    show([task({ title: '昨天的', status: 'done', completedAt: localIso(2026, 8, 9, 9) })]);
    expect(screen.queryByText(/今天完成的/)).toBeNull();
  });

  it('放弃的不算——这一节叫「今天完成的」，把放弃的算进来是在抬高那个数字', () => {
    show([task({ title: '放弃了', status: 'abandoned', completedAt: doneAt(9) })]);
    expect(screen.queryByText(/今天完成的/)).toBeNull();
  });

  it('最近做完的排最前——刚点错的那条该在手边', () => {
    const { container } = show([
      task({ title: '早上做的', status: 'done', completedAt: doneAt(8) }),
      task({ title: '刚做的', status: 'done', completedAt: doneAt(11) }),
    ]);
    const titles = [...container.querySelectorAll('.ink-today-done-title')].map((e) => e.textContent);
    expect(titles).toEqual(['刚做的', '早上做的']);
  });

  it('**「重开」走的是跟卡片状态按钮同一条 PATCH**——点错完成的第一反应是撤销', () => {
    const onPatch = vi.fn();
    show([task({ id: 'oops', title: '点错了', status: 'done', completedAt: doneAt(9) })], onPatch);
    fireEvent.click(screen.getByLabelText('把「点错了」重开'));
    expect(onPatch).toHaveBeenCalledWith('oops', { status: 'todo' });
  });

  it('它不进上面那个拖拽列表——手动排序排的是「接下来先做哪个」，做完的没有先后可言', () => {
    const { container } = show([
      task({ title: '还没做', due: localIso(2026, 8, 10, 20) }),
      task({ title: '做完了', status: 'done', completedAt: doneAt(9) }),
    ]);
    const list = container.querySelector('.ink-today-list')!;
    expect(list.textContent).not.toContain('做完了');
  });
});

/**
 * 选中态。**这个视图原来是唯一不能多选的**——而它恰恰是最常用的那个：
 * 「把今天这五条一起推到明天」是最典型的批量需求，`D`/`T`/`M`/`W`/`Delete`
 * 那一整套快捷键也跟着够不着（它们全都作用在选中集合上）。判据跟 `TaskGrid`
 * 共用同一个 `clickToSelection`，这里测的是接线。
 */
describe('TodayView：选中态', () => {
  const overdue = (title: string, id: string) =>
    task({ id, title, due: localIso(2026, 8, 1, 9) });

  const show = (tasks: Task[], sel: { ids: Set<string>; anchor: string | null }, onChange = vi.fn()) => {
    const utils = render(
      <TodayView lists={[]} tasks={tasks} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        selection={sel} onSelectionChange={onChange} />,
    );
    return { ...utils, onChange };
  };

  const cardFor = (title: string) => screen.getByText(title).closest('.ink-swipe') as HTMLElement;

  it('不给这两个 prop 就完全不接线——没有勾选框，Ctrl 点也什么都不发生（今天的行为不变）', () => {
    const { container } = render(
      <TodayView lists={[]} tasks={[overdue('甲', 'a')]} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder} />,
    );
    fireEvent.click(cardFor('甲'), { ctrlKey: true });
    expect(container.querySelector('.ink-sel-check')).toBeNull();
    expect(container.querySelector('.ink-task-card-selected')).toBeNull();
  });

  it('Ctrl 点一张卡：报回加上它之后的选中集合', () => {
    const { onChange } = show([overdue('甲', 'a')], { ids: new Set(), anchor: null });
    fireEvent.click(cardFor('甲'), { ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith({ ids: new Set(['a']), anchor: 'a' });
  });

  it('已经选中的画上选中态和勾选框', () => {
    const { container } = show([overdue('甲', 'a')], { ids: new Set(['a']), anchor: 'a' });
    expect(container.querySelector('.ink-task-card-selected')).not.toBeNull();
    expect(container.querySelector('.ink-sel-check')).not.toBeNull();
  });

  it('**Shift 连选按的是这个视图排好之后的顺序**，不是传进来那份数组的顺序——手动排序把它们重排过', () => {
    const rows = [
      task({ id: 'a', title: '甲', due: localIso(2026, 8, 1, 9), order: 2 }),
      task({ id: 'b', title: '乙', due: localIso(2026, 8, 1, 9), order: 1 }),
      task({ id: 'c', title: '丙', due: localIso(2026, 8, 1, 9), order: 0 }),
    ];
    // 屏幕上的顺序是 丙 → 乙 → 甲（order 升序）。从「丙」连选到「乙」应该
    // 只圈住这两条；按传进来那份数组的顺序算的话会圈住全部三条。
    const { onChange } = show(rows, { ids: new Set(['c']), anchor: 'c' });
    fireEvent.click(cardFor('乙'), { shiftKey: true });
    expect(onChange).toHaveBeenCalledWith({ ids: new Set(['c', 'b']), anchor: 'c' });
  });

  it('行档也接线——同一个列表按密度切换，能不能多选不该跟着密度变', () => {
    const { onChange } = show([overdue('甲', 'a')], { ids: new Set(), anchor: null });
    expect(onChange).not.toHaveBeenCalled();
    render(
      <TodayView lists={[]} tasks={[overdue('甲', 'a')]} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        density="row" selection={{ ids: new Set(['a']), anchor: 'a' }} onSelectionChange={vi.fn()} />,
    );
    expect(document.querySelector('.ink-trow-selected')).not.toBeNull();
  });
});

describe('TodayView：打开一条任务交给详情面板', () => {
  const one = [task({ id: 'a', title: '写周报', due: localIso(2026, 8, 10, 20) })];

  it('给了 onOpenDetail：点标题把 id 送出去，那一行不再当场膨胀成一张卡', () => {
    const onOpenDetail = vi.fn();
    render(
      <TodayView lists={[]} tasks={one} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        density="row" onOpenDetail={onOpenDetail} />,
    );
    fireEvent.click(document.querySelector('.ink-trow-open') as HTMLElement);
    expect(onOpenDetail).toHaveBeenCalledWith('a');
    expect(document.querySelector('.ink-task-card')).toBeNull();
  });

  it('没给就还是原来那样就地展开——这个视图的行为不因为漏接一个 prop 就变', () => {
    render(
      <TodayView lists={[]} tasks={one} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        density="row" />,
    );
    fireEvent.click(document.querySelector('.ink-trow-open') as HTMLElement);
    expect(document.querySelector('.ink-task-card')).not.toBeNull();
  });

  it('openDetailId 指着的那一行标出来', () => {
    render(
      <TodayView lists={[]} tasks={one} now={LOCAL_NOW} onPatch={noop}
        onEditTask={noopAsync} onDelete={noop} onReorder={noopReorder}
        density="row" onOpenDetail={vi.fn()} openDetailId="a" />,
    );
    expect(document.querySelector('.ink-trow-current')).not.toBeNull();
  });
});
