import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { FocusStats } from './FocusStats.js';
import { task } from '../test-utils.js';
import type { FocusSession, Task } from '../types.js';

const local = (y: number, mo: number, d: number, h = 9) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 19, 12);

const withSessions = (id: string, sessions: FocusSession[], over: Partial<Task> = {}) =>
  task({ id, title: id, focusSessions: sessions, ...over });

/** `message.useApp()` 要一层 `<AntApp>`，所有渲染都经这一个入口。 */
function show(tasks: Task[], opts: { onPatch?: (id: string, patch: Partial<Task>) => void } = {}) {
  const onPatch = opts.onPatch ?? vi.fn();
  const utils = render(<AntApp><FocusStats tasks={tasks} now={NOW} onPatch={onPatch} /></AntApp>);
  return { ...utils, onPatch };
}

/** 不接 onPatch 的那一份——「补记」整块不该渲染。 */
const showReadonly = (tasks: Task[]) =>
  render(<AntApp><FocusStats tasks={tasks} now={NOW} /></AntApp>);

const btn = (text: string) =>
  screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

describe('FocusStats', () => {
  it('一次都没专注过：说一句话，不画三张空图表——空图看着像坏了，而这是新机器上的常态', () => {
    const { container } = show([task({ id: 'a' })]);
    expect(screen.getByText(/还没有专注记录/)).toBeTruthy();
    expect(container.querySelector('.ink-fstat-trend')).toBeNull();
  });

  it('四个总览格子都在', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    for (const label of ['今天', '本周', '本月', '至今']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('趋势图十四根柱子，一天一根——没有记录的那天也有槽位', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    // 限定在这一张图里数：页面上还有一张 24 根柱子的「一天里的分布」，
    // 两张有意用同一套柱子样式，按 class 满页数会把两份加在一起。
    const trend = screen.getByRole('group', { name: '最近两周的趋势' });
    expect(trend.querySelectorAll('.ink-fstat-bar-slot')).toHaveLength(14);
  });

  it('柱子带可访问名，不只有 title——title 在有内容的元素上不会成为可访问名', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(screen.getByLabelText('2026-08-19 25 分钟')).toBeTruthy();
  });

  it('排行榜按分钟排，显示时长和次数', () => {
    show([
      withSessions('少的', [{ startedAt: iso(2026, 8, 19), minutes: 10 }]),
      withSessions('多的', [{ startedAt: iso(2026, 8, 19), minutes: 90 }]),
    ]);
    // 三张表（按类别 / 按任务 / 最近记录）用的是同一套行样式，各自报名字，
    // 按名字取那一份——原来靠 `.slice(0, 2)` 数位置，前面一多出一张表就错。
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    expect([...rank.querySelectorAll('.ink-fstat-rank-name')].map((el) => el.textContent))
      .toEqual(['多的', '少的']);
    expect(screen.getAllByText('1 小时 30 分').length).toBeGreaterThan(0);
  });

  it('年度热力图在——跟两周柱状图回答的不是同一个问题（这一年的形状 vs 最近怎么样）', () => {
    const { container } = show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(container.querySelector('.ink-heat-grid')).not.toBeNull();
    expect(screen.getByLabelText(/这一年的专注热力图/)).toBeTruthy();
  });

  it('排行榜截断了要说出来——看起来是全部、其实只有前十，会让人以为时间只花在这十件事上', () => {
    show(Array.from({ length: 12 }, (_, i) =>
      withSessions(`t${i}`, [{ startedAt: iso(2026, 8, 19), minutes: i + 1 }])));
    expect(screen.getByText(/另外还有 2 条/)).toBeTruthy();
  });

  it('刚好十条时不出那句话', () => {
    show(Array.from({ length: 10 }, (_, i) =>
      withSessions(`t${i}`, [{ startedAt: iso(2026, 8, 19), minutes: i + 1 }])));
    expect(screen.queryByText(/另外还有/)).toBeNull();
  });
});

/**
 * 补记 / 删记录（仿滴答清单的「补记专注记录」「删除专注记录」）。
 * 算什么在 `lib/focusStats.test.ts`，这里只测接线。
 */
describe('FocusStats：补记', () => {
  it('不给 onPatch 就整块不渲染——一个点了没反应的表单比没有更糟', () => {
    showReadonly([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(screen.queryByLabelText('补记到哪条任务')).toBeNull();
  });

  it('一条记录都没有时补记入口照样在——那正是这个功能最典型的用法', () => {
    show([task({ id: 'a', title: '写周报' })]);
    expect(screen.getByLabelText('补记到哪条任务')).toBeTruthy();
  });

  it('没选任务 / 没填时长时「补记」是禁用的，不发一条编出来的记录', () => {
    show([task({ id: 'a', title: '写周报' })]);
    expect(btn('补记')!.hasAttribute('disabled')).toBe(true);
  });

  it('填全之后补记，发的是追加那一条的 patch', () => {
    const { onPatch } = show([task({ id: 'a', title: '写周报' })]);
    fireEvent.change(screen.getByLabelText('补记到哪条任务'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('专注了多少分钟'), { target: { value: '40' } });
    fireEvent.click(btn('补记')!);
    expect(onPatch).toHaveBeenCalledWith('a', expect.objectContaining({
      focusSessions: [expect.objectContaining({ minutes: 40 })],
    }));
  });

  it('记录列表上每条都能删——补记必须配一张删得掉的列表，不然是单向门', () => {
    const { onPatch } = show([withSessions('写周报', [{ startedAt: iso(2026, 8, 19, 14), minutes: 25 }])]);
    const del = screen.getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('删掉「写周报」'))!;
    fireEvent.click(del);
    expect(onPatch).toHaveBeenCalledWith('写周报', { focusSessions: [] });
  });
});

/**
 * 另外两种切法（仿滴答清单「专注时间分布」和「专注时长分布」）。**算什么在
 * `lib/focusStats.test.ts`**，这里只测接线：摆出来了没、那两句解释在不在。
 */
describe('FocusStats：什么时候专注 / 花在哪一类上', () => {
  const LISTS = [{ id: 'L1', name: '工作' }];
  const at = (h: number, m = 25) => ({ startedAt: iso(2026, 8, 19, h), minutes: m });

  const showWith = (tasks: Task[]) =>
    render(<AntApp><FocusStats tasks={tasks} lists={LISTS} now={NOW} /></AntApp>);

  it('一天二十四根柱子，跟两周那张分得开', () => {
    showWith([withSessions('a', [at(14)])]);
    const hours = screen.getByRole('group', { name: '一天里的分布' });
    expect(hours.querySelectorAll('.ink-fstat-bar-slot')).toHaveLength(24);
  });

  it('**说「记录最多的是」，不说「你最擅长在」**——数据说得出前者，说不出后者', () => {
    showWith([withSessions('a', [at(14)])]);
    expect(screen.getByText(/记录最多的是 14:00–15:00/)).toBeTruthy();
  });

  it('有清单时默认按清单分，列出清单名', () => {
    showWith([withSessions('a', [at(14)], { listId: 'L1' })]);
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).getByText('工作')).toBeTruthy();
  });

  it('切到按标签，列出标签名，**并且把「加起来会超过总数」说出来**', () => {
    showWith([withSessions('a', [at(14)], { tags: ['写作', '紧急'] })]);
    fireEvent.change(screen.getByLabelText('分布按什么分'), { target: { value: 'tag' } });
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).getByText('写作')).toBeTruthy();
    expect(screen.getByText(/各项加起来会比总时长多/)).toBeTruthy();
  });

  it('按清单那一档不出那句话——一条任务只在一个清单里，那是真的划分', () => {
    showWith([withSessions('a', [at(14)], { listId: 'L1' })]);
    expect(screen.queryByText(/各项加起来会比总时长多/)).toBeNull();
  });

  it('不给 lists 时只剩「按标签」可选——一份全是裸 uuid 的分布不如不显示', () => {
    render(<AntApp><FocusStats tasks={[withSessions('a', [at(14)], { listId: 'L1' })]} now={NOW} /></AntApp>);
    const sel = screen.getByLabelText('分布按什么分') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['tag']);
  });
});

/**
 * 点任务名跳回那条任务。补的是一处「看得见、够不着」：这一屏告诉你「这三小时
 * 花在『写周报』上」，而那条任务在这儿点不开——得自己记住标题，切到别的视图
 * 再找一遍。跟习惯页那颗、「回顾」里点关联任务是同一个动作。
 */
describe('FocusStats：点任务名跳回去', () => {
  const rows = [withSessions('写周报', [{ startedAt: iso(2026, 8, 19), minutes: 90 }])];

  it('排行榜里的名字是可点的，带上那条任务的 id', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={rows} now={NOW} onOpen={onOpen} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    fireEvent.click(within(rank).getByRole('button', { name: '写周报' }));
    expect(onOpen).toHaveBeenCalledWith('写周报');
  });

  it('最近的记录那张表里也能点', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={rows} now={NOW} onOpen={onOpen} /></AntApp>);
    const recent = screen.getByRole('list', { name: '最近的专注记录' });
    fireEvent.click(within(recent).getByRole('button', { name: '写周报' }));
    expect(onOpen).toHaveBeenCalledWith('写周报');
  });

  it('**按类别那张不能点**——一个标签没有「那条任务」可跳', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={[withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }], { tags: ['写作'] })]} now={NOW} onOpen={onOpen} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).queryByRole('button', { name: '写作' })).toBeNull();
  });

  it('不给 onOpen 就还是一行字——点了没反应的入口比没有更糟', () => {
    render(<AntApp><FocusStats tasks={rows} now={NOW} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    expect(within(rank).queryByRole('button', { name: '写周报' })).toBeNull();
    expect(within(rank).getByText('写周报')).toBeTruthy();
  });
});
