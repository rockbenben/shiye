import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SuggestPanel } from './SuggestPanel.js';
import type { Task } from '../types.js';

const local = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 22, 10);

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: '任务', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 1),
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

function show(tasks: Task[]) {
  const onPatch = vi.fn();
  const { container } = render(<SuggestPanel tasks={tasks} now={NOW} onPatch={onPatch} />);
  return { onPatch, container };
}

const toggle = () => screen.getByRole('button', { name: /推荐任务/ });

describe('SuggestPanel', () => {
  it('没有任何推荐时整个组件不渲染——一个点开永远是空的入口比没有更糟', () => {
    const { container } = show([task({ id: 'a', status: 'done' })]);
    expect(container.querySelector('.ink-suggest')).toBeNull();
  });

  it('默认收起，只露一颗带数字的按钮——它是「今天之外还有什么」，不该把主角挤下去', () => {
    show([task({ id: 'a', createdAt: iso(2026, 7, 1) })]);
    expect(toggle().textContent).toContain('推荐任务');
    expect(toggle().textContent).toContain('1');
    expect(screen.queryByText('躺很久了')).toBeNull();
  });

  it('点开之后组标题和任务都出来', () => {
    show([task({ id: 'a', title: '整理书架', createdAt: iso(2026, 7, 1) })]);
    fireEvent.click(toggle());
    expect(screen.getByText('躺很久了')).toBeTruthy();
    expect(screen.getByText('整理书架')).toBeTruthy();
  });

  it('「加到今天」发的是「改期到今天」那份 patch，不另写一套「怎么算今天」', () => {
    const { onPatch } = show([task({ id: 'a', title: '交表', due: iso(2026, 8, 24, 18), createdAt: iso(2026, 8, 20) })]);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByLabelText('把「交表」加到今天'));
    // 原来几点还是几点（18:00），日期挪到今天——判据在 lib/reschedule.ts
    expect(onPatch).toHaveBeenCalledWith('a', expect.objectContaining({ due: iso(2026, 8, 22, 18) }));
  });

  it('有截止时间的把日期显出来——「明天」和「后天」不写日期在屏幕上长得一模一样', () => {
    show([task({ id: 'a', title: '交表', due: iso(2026, 8, 23, 9), createdAt: iso(2026, 8, 20) })]);
    fireEvent.click(toggle());
    expect(screen.getByText('明天')).toBeTruthy();
  });

  it('改过期的把次数显出来——这一组的信息量全在那个数字上', () => {
    show([task({ id: 'a', title: '交表', postponeCount: 4, createdAt: iso(2026, 8, 20) })]);
    fireEvent.click(toggle());
    expect(screen.getByText('推迟过 4 次')).toBeTruthy();
  });
});

/**
 * 点任务名跳回那条任务。这一屏回答的是「今天列表之外还有什么」，而看见
 * 「这条躺了 30 天」之后想做的**未必**是「加到今天」——也可能是打开它改小、
 * 或者干脆放弃。只有那一个动作的话，另外两条路要自己去别的视图里把它找出来。
 */
describe('SuggestPanel：点任务名跳回去', () => {
  const stale = task({ id: 'a', title: '交年报', createdAt: iso(2026, 8, 1) });

  it('接了 onOpen：名字是可点的，带上那条任务的 id', () => {
    const onOpen = vi.fn();
    render(<SuggestPanel tasks={[stale]} now={NOW} onPatch={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: '交年报' }));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('不给 onOpen 就还是一行字——点了没反应的入口比没有更糟', () => {
    render(<SuggestPanel tasks={[stale]} now={NOW} onPatch={vi.fn()} />);
    fireEvent.click(toggle());
    expect(screen.queryByRole('button', { name: '交年报' })).toBeNull();
    expect(screen.getByText('交年报')).toBeTruthy();
  });
});
