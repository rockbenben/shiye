import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SchedulePanel } from './SchedulePanel.js';
import { task } from '../test-utils.js';
import type { List } from '../types.js';

const NOW = new Date(2026, 7, 24, 12);

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#8A6A3B', folderId: null, order: 0, archived: false, filter: null },
  { id: 'L2', name: '家里', color: '#4F7A55', folderId: null, order: 1, archived: false, filter: null },
];

const show = (over: Partial<Parameters<typeof SchedulePanel>[0]> = {}) => {
  const onClose = vi.fn();
  const r = render(
    <SchedulePanel
      tasks={[
        task({ id: 'a', title: '写年度总结', listId: 'L1', tags: ['季度'] }),
        task({ id: 'b', title: '换灯泡', listId: 'L2', priority: 2 }),
        task({ id: 'c', title: '排好了的', listId: 'L1', due: '2026-08-25T10:00:00.000Z' }),
      ]}
      lists={LISTS}
      now={NOW}
      onClose={onClose}
      {...over}
    />,
  );
  return { ...r, onClose };
};

const items = () => [...document.querySelectorAll('.ink-sched-item')];
const titles = () => items().map((e) => e.querySelector('.ink-sched-name')?.textContent);

describe('SchedulePanel：列的是「所有没日期的任务」', () => {
  it('有日期的那条不在里面——这一栏回答的就是「还有什么没排」', () => {
    show();
    expect(titles()).toEqual(['写年度总结', '换灯泡']);
    expect(screen.queryByText('排好了的')).toBeNull();
  });

  it('一条没日期的都没有时说一句好消息，不是「没搜到」', () => {
    show({ tasks: [task({ id: 'c', due: '2026-08-25T10:00:00.000Z' })] });
    expect(screen.getByText('每一条都排上日期了。')).toBeTruthy();
  });

  it('**每一行都带 data-task-id**——日历那侧的 FullCalendar `Draggable` 靠它认出拖的是哪条，少了这个属性拖过去会静默什么都不发生', () => {
    show();
    expect(items().map((e) => e.getAttribute('data-task-id'))).toEqual(['a', 'b']);
  });

  it('行的类名是 .ink-sched-item——`Draggable` 的 itemSelector 认的就是它，改名要连 CalendarView 那边一起改', () => {
    show();
    expect(items()).toHaveLength(2);
  });
});

describe('SchedulePanel：清单 / 标签 / 优先级三个页签', () => {
  it('默认按清单分，组标题是清单名', () => {
    show();
    expect(screen.getByRole('tab', { name: '清单' }).getAttribute('aria-selected')).toBe('true');
    const heads = [...document.querySelectorAll('.ink-sched-grouphead')].map((e) => e.textContent);
    expect(heads.some((h) => h?.includes('工作'))).toBe(true);
    expect(heads.some((h) => h?.includes('家里'))).toBe(true);
  });

  it('切到标签：分组换成标签，「没有标签」那一组也在——不然打了标签的和没打的会有一半人间蒸发', () => {
    show();
    fireEvent.click(screen.getByRole('tab', { name: '标签' }));
    const heads = [...document.querySelectorAll('.ink-sched-grouphead')].map((e) => e.textContent);
    expect(heads.some((h) => h?.includes('#季度'))).toBe(true);
    expect(heads.some((h) => h?.includes('没有标签'))).toBe(true);
  });

  it('切到优先级：分组换成优先级', () => {
    show();
    fireEvent.click(screen.getByRole('tab', { name: '优先级' }));
    const heads = [...document.querySelectorAll('.ink-sched-grouphead')].map((e) => e.textContent);
    expect(heads.some((h) => h?.includes('中'))).toBe(true);
  });

  it('**按清单分组时行上不再重复清单名**——组标题已经写了；换个轴才补一句它属于哪儿', () => {
    show();
    expect(items()[0]!.querySelector('.ink-sched-meta')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '标签' }));
    expect(items()[0]!.querySelector('.ink-sched-meta')?.textContent).toBe('工作');
  });

  it('组能收起来，收起来之后里面的行不在 DOM 里', () => {
    show();
    const head = [...document.querySelectorAll('.ink-sched-grouphead')]
      .find((e) => e.textContent?.includes('工作'))!;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('写年度总结')).toBeNull();
  });
});

describe('SchedulePanel：排序', () => {
  it('换排序档会重排——复用 grouping.ts 那份档位表，不为这一栏另发明一套', () => {
    show({
      tasks: [
        task({ id: 'a', title: '长的', listId: 'L1', estimateMinutes: 90 }),
        task({ id: 'b', title: '短的', listId: 'L1', estimateMinutes: 10 }),
      ],
    });
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'estimate' } });
    expect(titles()).toEqual(['短的', '长的']);
  });
});

describe('SchedulePanel：↑/↓ 手动挪位置', () => {
  it('**不给 onReorder 就不画那两颗**——一个点了没反应的入口比没有更糟', () => {
    show();
    expect(document.querySelector('.ink-sched-move')).toBeNull();
  });

  it('挪一条：交出去的是整份可见顺序 + 新 order，跟「今天」那份是同一个契约', async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    show({ onReorder });
    fireEvent.click(screen.getByLabelText('把「换灯泡」往上挪'));
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([
      { id: 'b', order: 0 },
      { id: 'a', order: 1 },
    ]));
  });

  it('第一条的↑和最后一条的↓禁用——到头了还能点等于一次没有效果的写盘', () => {
    show({ onReorder: vi.fn() });
    const first = within(items()[0] as HTMLElement);
    const last = within(items()[items().length - 1] as HTMLElement);
    expect(first.getByLabelText(/往上挪/).hasAttribute('disabled')).toBe(true);
    expect(last.getByLabelText(/往下挪/).hasAttribute('disabled')).toBe(true);
  });

  it('**顺序是跨组算的**：`order` 是一个全局字段，只在组内重排会让另一个分组轴下的顺序变得没法解释', async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    show({ onReorder });
    // a 在「工作」组、b 在「家里」组，分属两组；把 b 往上挪要能跨过组边界。
    fireEvent.click(screen.getByLabelText('把「换灯泡」往上挪'));
    await waitFor(() => expect(onReorder.mock.calls[0]![0]).toHaveLength(2));
  });
});

describe('SchedulePanel：点开一条 / 收起这一栏', () => {
  it('给了 onOpen，任务名是个按钮，点了把 id 交出去', () => {
    const onOpen = vi.fn();
    show({ onOpen });
    fireEvent.click(screen.getByRole('button', { name: '写年度总结' }));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('没给 onOpen 就只是一行字，不是一个点了没反应的按钮', () => {
    show();
    expect(screen.queryByRole('button', { name: '写年度总结' })).toBeNull();
    expect(screen.getByText('写年度总结')).toBeTruthy();
  });

  it('「收起」把这一栏关掉', () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(onClose).toHaveBeenCalled();
  });
});
