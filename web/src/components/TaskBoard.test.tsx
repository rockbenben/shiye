import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TaskBoard } from './TaskBoard.js';
import { FIRST_RUN_HINT } from '../lib/firstRun.js';
import { NoMotion, pickCardMenu } from '../test-utils.js';
import type { InboxItem, List, Task } from '../types.js';
import type { StatusFilter } from '../lib/taskView.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

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

let m = 0;
const note = (p: Partial<InboxItem> = {}): InboxItem => ({
  id: `i${++m}`, text: `笔记${m}`, createdAt: '2026-08-01T00:00:00.000Z',
  processed: true, taskIds: [], ...p,
});

const noop = () => {};
const noopAsync = async () => {};

/**
 * 状态筛选现在是受控的（提到了 App 里，好让新建任务能判断「这张新卡会不会被
 * 当前筛选藏起来」）。这些测试直接渲染 TaskBoard 又要点筛选条，所以在这儿补一份
 * 最小的 state 宿主，行为跟原来的局部 useState 一样。
 */
// lists 在这里是可选的（TaskBoard 自己的 Props.lists 仍然是必填——那是 App.tsx
// 那条接线要靠编译器兜住的地方，见 TaskCard.tsx CardProps 的注释）：这个文件
// 里几十条测试都不关心清单，给个默认空数组，不用每条都补一个用不上的 prop。
function Board(
  props: Omit<React.ComponentProps<typeof TaskBoard>, 'filter' | 'onFilterChange' | 'lists'> & { lists?: List[] },
) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  // NoMotion：jsdom 不跑动画，看板的 Masonry 靠离场动画卸载被筛掉的卡，
  // 见 test-utils.tsx。
  return (
    <NoMotion>
      <TaskBoard {...props} lists={props.lists ?? []} filter={filter} onFilterChange={setFilter} />
    </NoMotion>
  );
}

// antd 会在「恰好两个汉字、且没有图标」的按钮里插一个空格：
// textContent 是「开 始」不是「开始」。按中文找 antd 按钮一律先去空白。
const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

describe('TaskBoard：按来源分组', () => {
  it('任务出现在它来源的那句原话下面，标出写下的时间和拆成几条', () => {
    const src = note({ id: 'i1', text: '给 035 加导出 CSV', createdAt: '2026-08-10T10:00:00.000Z', taskIds: ['t1'] });
    const t = task({ id: 't1', title: '加导出按钮' });
    render(<Board tasks={[t]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    expect(screen.getByText('给 035 加导出 CSV')).toBeDefined();
    expect(screen.getByText('加导出按钮')).toBeDefined();
    expect(screen.getByText(/拆成 1 条/)).toBeDefined();
  });

  it('一条笔记拆出的多张卡都摆在它下面', () => {
    const src = note({ id: 'i1', text: '重构 discord、telegram', taskIds: ['t1', 't2'] });
    const t1 = task({ id: 't1', title: '重构 Discord' });
    const t2 = task({ id: 't2', title: '重构 Telegram' });
    render(<Board tasks={[t1, t2]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    expect(screen.getByText('重构 Discord')).toBeDefined();
    expect(screen.getByText('重构 Telegram')).toBeDefined();
    expect(screen.getByText(/拆成 2 条/)).toBeDefined();
    // 只有一句源句，不是两句——两张卡共用同一个来源分组。
    expect(screen.getAllByText('重构 discord、telegram')).toHaveLength(1);
  });

  it('没有来源的任务（手工建的、或来源条目被删了）落进最后一组「单独记的」', () => {
    const src = note({ id: 'i1', text: '有来源的笔记', taskIds: ['t1'] });
    const sourced = task({ id: 't1', title: '有来源' });
    const handmade = task({ id: 't2', title: '手工记的', source: 'user' });
    // orphan：source 是 'ai'，但没有任何 inbox 条目的 taskIds 提到它——
    // 来源条目已经被删掉了，这条任务不该消失，也不该挂在错的来源下面。
    const orphan = task({ id: 't3', title: '来源被删了', source: 'ai' });
    render(
      <Board tasks={[sourced, handmade, orphan]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />,
    );

    expect(screen.getByText('有来源的笔记')).toBeDefined();
    expect(screen.getByText('有来源')).toBeDefined();
    expect(screen.getByText('单独记的')).toBeDefined();
    expect(screen.getByText('手工记的')).toBeDefined();
    expect(screen.getByText('来源被删了')).toBeDefined();
  });

  it('全是没有来源的任务时，只有「单独记的」一组', () => {
    render(<Board tasks={[task({ title: '手工记的' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText('单独记的')).toBeDefined();
  });

  it('没有任务时不炸页面，显示空状态', () => {
    expect(() => render(<Board tasks={[]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />)).not.toThrow();
    expect(screen.getByText(FIRST_RUN_HINT)).toBeDefined();
  });
});

describe('TaskBoard：搁置（later）在「按来源」里仍然显示，只是多一档筛选', () => {
  it('搁置的任务默认（全部）照常渲染在看板上，不会因为搁置就消失——这里是档案，不该藏东西', () => {
    render(<Board tasks={[task({ title: '先放一放', status: 'later' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText('先放一放')).toBeDefined();
  });

  it('筛选条多一档「搁置」，点了之后只留 later 状态的任务', () => {
    render(
      <Board
        tasks={[task({ title: '搁置的', status: 'later' }), task({ title: '待办的', status: 'todo' })]}
        inbox={[]}
        now={NOW}
        onPatch={noop}
        onEditTask={noopAsync}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '搁置 1' }));
    expect(screen.getByText('搁置的')).toBeDefined();
    expect(screen.queryByText('待办的')).toBeNull();
  });
});

/**
 * 「已放弃」这一档一直不在筛选条上。它是后加的状态，而这个组件手抄了一份
 * 写死的五档表没跟上——于是「按来源」里选不到放弃的任务，尽管 `countByStatus`
 * 一直在数它。筛选栏和批量操作条当初漏掉「已放弃」是同一个 bug，那两处修的
 * 时候没顺手修这一处；现在三处都从 `taskView.ts` 的 `STATUS_FILTERS` 拿。
 */
describe('TaskBoard：「已放弃」也是一档', () => {
  it('筛选条上有「已放弃」，带计数', () => {
    render(
      <Board tasks={[task({ title: '不做了', status: 'abandoned' })]} inbox={[]} now={NOW}
        onPatch={noop} onEditTask={noopAsync} onDelete={noop} />,
    );
    expect(screen.getByRole('button', { name: '已放弃 1' })).toBeDefined();
  });

  it('点了之后只留 abandoned 的', () => {
    render(
      <Board
        tasks={[task({ title: '不做了', status: 'abandoned' }), task({ title: '待办的', status: 'todo' })]}
        inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '已放弃 1' }));
    expect(screen.getByText('不做了')).toBeDefined();
    expect(screen.queryByText('待办的')).toBeNull();
  });

  it('**筛到一条都不剩时那句提示报得出这一档的名字**——原来那份表里没有它，`FILTERS.find(...)!` 会当场炸', () => {
    render(
      <Board tasks={[task({ title: '待办的', status: 'todo' })]} inbox={[]} now={NOW}
        onPatch={noop} onEditTask={noopAsync} onDelete={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '已放弃 0' }));
    expect(screen.getByText('「已放弃」筛选下没有任务')).toBeDefined();
  });
});

describe('TaskBoard：状态筛选', () => {
  it('四个筛选按钮上的计数是全部任务的实时统计，不受筛选本身影响', () => {
    render(
      <Board
        tasks={[task({ status: 'todo' }), task({ status: 'doing' }), task({ status: 'done' })]}
        inbox={[]}
        now={NOW}
        onPatch={noop}
        onEditTask={noopAsync}
        onDelete={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '全部 3' })).toBeDefined();
    expect(screen.getByRole('button', { name: '待办 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: '进行中 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: '已完成 1' })).toBeDefined();
  });

  it('点「待办」筛选按钮之后只留 todo 状态的任务', () => {
    render(
      <Board
        tasks={[task({ title: '待办的', status: 'todo' }), task({ title: '做完的', status: 'done' })]}
        inbox={[]}
        now={NOW}
        onPatch={noop}
        onEditTask={noopAsync}
        onDelete={noop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '待办 1' }));

    expect(screen.getByText('待办的')).toBeDefined();
    expect(screen.queryByText('做完的')).toBeNull();
    expect(screen.getByRole('button', { name: '待办 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '全部 2' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('筛选之后一个来源组的任务全部被滤掉，这个组连同它的源句一起消失', () => {
    const src = note({ id: 'i1', text: '这句话拆出的任务都做完了', taskIds: ['t1'] });
    const t = task({ id: 't1', title: '做完的任务', status: 'done' });
    render(<Board tasks={[t]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '待办 0' }));

    expect(screen.queryByText('这句话拆出的任务都做完了')).toBeNull();
    // 不是「空的」——那句话是「压根没有任务」的意思，这里是任务都在，只是
    // 全被筛选挡住了，见下面「筛选导致的空」那组测试。
    expect(screen.queryByText('空的')).toBeNull();
  });
});

describe('TaskBoard：筛选不能摘掉正在编辑的卡片', () => {
  it('编辑中的卡片被筛选按理该滤掉时，编辑框和草稿还在，不会被从树上摘掉', async () => {
    // InboxSidebar 已经用 editingIds 解过同一道题——筛选切走导致组件卸载，
    // 局部 state（这里是 draft）跟着卸载一起消失，用户刚打的字没提示、
    // 没确认地就没了。
    const t = task({ id: 't1', title: '原标题', status: 'todo' });
    render(<Board tasks={[t]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    await pickCardMenu('编辑');
    const box = screen.getByPlaceholderText('标题') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '用户刚打的字' } });

    // 这张卡是 todo，「已完成」筛选正常情况下会把它滤掉。
    fireEvent.click(screen.getByRole('button', { name: '已完成 0' }));

    expect(screen.getByPlaceholderText('标题')).toBeDefined();
    expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('用户刚打的字');
  });

  it('保存或取消编辑之后，筛选恢复正常效力——卡片该被滤掉时才被滤掉', async () => {
    const t = task({ id: 't1', title: '原标题', status: 'todo' });
    render(<Board tasks={[t]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    await pickCardMenu('编辑');
    fireEvent.click(screen.getByRole('button', { name: '已完成 0' }));
    expect(screen.getByPlaceholderText('标题')).toBeDefined();

    fireEvent.click(byText('取消')!);
    expect(screen.queryByPlaceholderText('标题')).toBeNull();
    expect(screen.queryByText('原标题')).toBeNull();
  });
});

describe('TaskBoard：过期任务的排序', () => {
  it('同源组内，过期任务浮到最前面，其余仍按 AI 拆解出的步骤顺序（taskIds 数组顺序）', () => {
    const src = note({ id: 'i1', taskIds: ['t1', 't2', 't3'] });
    const step1 = task({ id: 't1', title: '第一步不急', due: '2026-08-31T00:00:00.000Z' });
    const step2 = task({ id: 't2', title: '第二步过期了', due: '2026-08-01T00:00:00.000Z' });
    const step3 = task({ id: 't3', title: '第三步也不急', due: '2026-08-15T00:00:00.000Z' });
    const { container } = render(
      <Board tasks={[step1, step2, step3]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />,
    );
    // 卡片标题渲染成 <span class="ant-typography"><strong>…</strong></span>——
    // 按渲染出的先后顺序直接读标题文字，比拿 getByText 单个节点再找位置更直接。
    const titles = Array.from(container.querySelectorAll('.ant-typography strong')).map((el) => el.textContent);
    expect(titles).toEqual(['第二步过期了', '第一步不急', '第三步也不急']);
  });

  it('「单独记的」那组：过期任务照旧排最前面（sortByUrgency，行为不变，重新确认板级覆盖）', () => {
    const fresh = task({ title: '不急', due: '2026-12-01T00:00:00.000Z' });
    const late = task({ title: '早该做了', due: '2026-08-01T00:00:00.000Z' });
    const { container } = render(<Board tasks={[fresh, late]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    const titles = Array.from(container.querySelectorAll('.ant-typography strong')).map((el) => el.textContent);
    expect(titles).toEqual(['早该做了', '不急']);
  });
});

describe('TaskBoard：「拆成 N 条」是历史事实，不是当下过滤后的计数', () => {
  it('切换筛选不改变「拆成 N 条」', () => {
    const src = note({ id: 'i1', text: '一句话', taskIds: ['t1', 't2'] });
    const t1 = task({ id: 't1', title: '任务A', status: 'todo' });
    const t2 = task({ id: 't2', title: '任务B', status: 'done' });
    render(<Board tasks={[t1, t2]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText(/拆成 2 条/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '待办 1' }));
    expect(screen.getByText(/拆成 2 条/)).toBeDefined();
  });

  it('taskIds 里的一条对应的任务已经被删掉（tasks 数组里找不到了），「拆成 N 条」依然是原数，不跟着少', () => {
    const src = note({ id: 'i1', text: '一句话', taskIds: ['t1', 't2'] });
    const t1 = task({ id: 't1', title: '还在的任务' });
    render(<Board tasks={[t1]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText(/拆成 2 条/)).toBeDefined();
  });
});

describe('TaskBoard：分组标题是真正的标题元素', () => {
  it('有来源的组：源句是 heading，标题导航能跳过去', () => {
    const src = note({ id: 'i1', text: '有来源的笔记', taskIds: ['t1'] });
    render(<Board tasks={[task({ id: 't1' })]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByRole('heading', { name: '有来源的笔记' })).toBeDefined();
  });

  it('「单独记的」也是 heading', () => {
    render(<Board tasks={[task({ title: '手工记的' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByRole('heading', { name: '单独记的' })).toBeDefined();
  });
});

describe('TaskBoard：空状态区分「筛选挡住了」和「真的什么都没有」', () => {
  it('筛选下没有匹配任务时，文案跟「真的没任务」不一样，并且给一个清除筛选的出口', () => {
    const t = task({ title: '还没做', status: 'todo' });
    render(<Board tasks={[t]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '已完成 0' }));

    expect(screen.queryByText('空的')).toBeNull();
    const clearBtn = screen.getByRole('button', { name: /清除筛选/ });
    fireEvent.click(clearBtn);

    expect(screen.getByText('还没做')).toBeDefined();
    expect(screen.getByRole('button', { name: '全部 1' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('真的没有任何任务时，还是原来那句「空的」，不显示清除筛选按钮', () => {
    render(<Board tasks={[]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText(FIRST_RUN_HINT)).toBeDefined();
    expect(screen.queryByRole('button', { name: /清除筛选/ })).toBeNull();
  });
});

/**
 * 曾经这里守的是「有 aiComment 就给行加一个 has-note 修饰类」——那是为页边
 * 留白轨道服务的。卡片网格化之后页边没了，边注挪进了卡片里，类名也就没了。
 * 但底下那件用户看得见的事没变，改成直接断言它，比断言类名更耐改。
 */
describe('TaskBoard：AI 的拆解理由跟着卡片走', () => {
  it('有 aiComment 就渲染出来', () => {
    render(<Board tasks={[task({ aiComment: '按平台拆成两条，因为模型不一样' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    expect(screen.getByText(/按平台拆成两条/)).toBeTruthy();
    expect(screen.getByText('AI 的拆解理由')).toBeTruthy();
  });

  it('没有 aiComment 就什么都不渲染——不留一个空标题', () => {
    render(<Board tasks={[task({ aiComment: '' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);

    expect(screen.queryByText('AI 的拆解理由')).toBeNull();
  });
});

describe('TaskBoard：卡片本身的行为', () => {
  // 记号上写的是「过期 N 天」（判据在 lib/taskView.ts 的 overdueLabel）——
  // 按 class 取、不按「已过期」这四个字取：那句文案已经带上了「多久」。
  const overdueMarks = () => [...document.querySelectorAll('.ink-overdue-mark')].map((e) => e.textContent);

  it('过期任务打上过期记号，没过期的不打', () => {
    render(<Board tasks={[task({ title: '早该做了', due: '2026-08-01T00:00:00.000Z' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(overdueMarks().some((m) => m?.startsWith('过期'))).toBe(true);
  });

  it('没过期就没有那个标记', () => {
    render(<Board tasks={[task({ title: '不急', due: '2026-12-01T00:00:00.000Z' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(overdueMarks()).toHaveLength(0);
  });

  it('remindAt 在更早一天已经触发过、没设 due——同样打上过期记号，不然这张卡在任何地方都看不出它已经逾期', () => {
    render(<Board tasks={[task({ title: '提醒过了没理', reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: null }], due: null })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(overdueMarks().some((m) => m?.startsWith('过期'))).toBe(true);
  });

  it('aiComment 有内容就在边注里显示出来 —— AI 为什么这么拆，用户得看得到', () => {
    render(<Board tasks={[task({ aiComment: '拆自「下周交季度总结」' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText(/拆自「下周交季度总结」/)).toBeDefined();
    expect(screen.getByText('AI 的拆解理由')).toBeDefined();
  });

  it('aiComment 是空字符串就不渲染边注', () => {
    render(<Board tasks={[task({ aiComment: '' })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.queryByText('AI 的拆解理由')).toBeNull();
  });

  it('子任务逐条列出来', () => {
    render(<Board tasks={[task({ subtasks: [{ text: '收集数据', done: true }, { text: '写初稿', done: false }] })]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText('收集数据')).toBeDefined();
    expect(screen.getByText('写初稿')).toBeDefined();
  });

  it('缺 subtasks 字段不炸页面 —— GET /api/tasks 不校验文件写入的数据', () => {
    const bad = { ...task(), subtasks: undefined } as unknown as Task;
    expect(() => render(<Board tasks={[bad]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />)).not.toThrow();
  });

  it('未知 status 的任务在状态角标上标出原始值，不炸页面', () => {
    const bad = { ...task({ title: '坏状态' }), status: 'pending' } as unknown as Task;
    render(<Board tasks={[bad]} inbox={[]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.getByText('坏状态')).toBeDefined();
    expect(screen.getByText(/状态异常/)).toBeDefined();
  });

  it('点「开始」把状态改成 doing', () => {
    const onPatch = vi.fn();
    const t = task();
    render(<Board tasks={[t]} inbox={[]} now={NOW} onPatch={onPatch} onEditTask={noopAsync} onDelete={noop} />);

    // 用 fireEvent 而不是原生 btn.click()：后者不走 act()，React 19 会告警，
    // 而状态更新落在断言之后就会假绿。
    const btn = byText('开始');
    expect(btn).toBeDefined();
    fireEvent.click(btn!);

    expect(onPatch).toHaveBeenCalledWith(t.id, { status: 'doing' });
  });
});

describe('TaskBoard：编辑卡片', () => {
  it('保存成功后退出编辑态，把改过的字段传给 onEditTask', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    // priority: 3（不是默认的 0）——0 断不出「保留」和「丢了」的区别（两者
    // 断言出来都是 0），必须用非默认值才能让「startEdit 忘了带 priority」
    // 这种回归红。真实故障：AI 建议调成「高」被接受之后，用户编辑一次标题
    // 就把优先级悄悄归零。
    const t = task({ title: '原标题', priority: 3 });
    render(<Board tasks={[t]} inbox={[]} now={NOW} onPatch={noop} onEditTask={onEditTask} onDelete={noop} />);

    await pickCardMenu('编辑');
    const titleBox = screen.getByPlaceholderText('标题');
    fireEvent.change(titleBox, { target: { value: '改过的标题' } });
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith(t.id, { title: '改过的标题', notes: '', due: null, startAt: null, endAt: null, persistentReminder: false, priority: t.priority, tags: t.tags, listId: t.listId, section: null, repeat: t.repeat, parentId: null, estimateMinutes: null, habit: false, waitingFor: null, context: null, reminders: [] }));
    // 编辑态关掉了：标题输入框不在了，标题以普通文本形式显示。
    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
  });

  it('保存失败：编辑框留着、刚打的字原样在，弹出错误提示——不能把用户的输入连带没存成的这次一起清空', async () => {
    const onEditTask = vi.fn().mockRejectedValue(new Error('网络断了'));
    const t = task({ title: '原标题' });
    render(
      <AntApp>
        <Board tasks={[t]} inbox={[]} now={NOW} onPatch={noop} onEditTask={onEditTask} onDelete={noop} />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    const titleBox = screen.getByPlaceholderText('标题');
    fireEvent.change(titleBox, { target: { value: '写了一半服务就挂了' } });
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalled());

    // 编辑框还在，草稿原样保留——不是被清空重置回原标题。
    expect(screen.getByPlaceholderText('标题')).toBeDefined();
    expect(screen.getByDisplayValue('写了一半服务就挂了')).toBeDefined();
    // 错误提示弹出来了。
    await waitFor(() => expect(screen.getByText('网络断了')).toBeDefined());
  });
});


/**
 * 「按来源」原来是全站唯一选不中的视图。接上之后这一屏有两件事跟别处不一样，
 * 两件都得钉住：
 *
 *   1. **Shift 退化成单点加减**。瀑布流里没有「两张卡之间」这回事，连选
 *      本来就无从谈起。写成测试是因为这是一个**故意的不一致**，下一个人很容易
 *      把它当成遗漏「修好」，而那会让 `rangeBetween` 拿一份不诚实的顺序选出
 *      「屏幕上不连续的一段」。
 *   2. **组头那颗按钮选的是这一组**，不是全部也不是另一组。
 */
describe('TaskBoard：选中这一组', () => {
  const two = () => {
    const src = note({ id: 'i1', text: '一句原话', taskIds: ['t1', 't2'] });
    return { src, a: task({ id: 't1', title: '第一步' }), b: task({ id: 't2', title: '第二步' }) };
  };
  /** 受控宿主：选中态在 App 一层，这里补最小的一份。 */
  function Host({ tasks, inbox, onSel }: { tasks: Task[]; inbox: InboxItem[]; onSel?: (n: Set<string>) => void }) {
    const [sel, setSel] = useState<{ ids: Set<string>; anchor: string | null }>({ ids: new Set(), anchor: null });
    return (
      <Board
        tasks={tasks} inbox={inbox} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop}
        selection={sel}
        onSelectionChange={(next) => { setSel(next); onSel?.(next.ids); }}
      />
    );
  }
  const groupBtn = (label: string | RegExp) => screen.getAllByRole('button')
    .find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))!;

  it('点「选中这 2 条」把整组选上，再点一下全部取消', () => {
    const { src, a, b } = two();
    const seen: Set<string>[] = [];
    render(<Host tasks={[a, b]} inbox={[src]} onSel={(ids) => seen.push(ids)} />);

    fireEvent.click(groupBtn(/选中这 2 条/));
    expect([...seen[0]].sort()).toEqual(['t1', 't2']);

    // 全选中之后那颗按钮自己反过来，不是旁边再长一颗。
    fireEvent.click(groupBtn('取消这一组'));
    expect([...seen[1]]).toEqual([]);
  });

  it('只选自己那一组——旁边那组一张也不碰', () => {
    const src1 = note({ id: 'i1', text: '第一句', taskIds: ['t1'] });
    const src2 = note({ id: 'i2', text: '第二句', taskIds: ['t2'] });
    const seen: Set<string>[] = [];
    render(<Host
      tasks={[task({ id: 't1', title: 'A' }), task({ id: 't2', title: 'B' })]}
      inbox={[src1, src2]}
      onSel={(ids) => seen.push(ids)}
    />);

    // 两组各一张，所以两颗都是「选中这 1 条」；点第一颗。
    const btns = screen.getAllByRole('button').filter((x) => /选中这 1 条/.test(x.textContent ?? ''));
    expect(btns).toHaveLength(2);
    fireEvent.click(btns[0]);
    expect([...seen[0]]).toEqual(['t1']);
  });

  it('没接选中态的时候，组头上根本没这颗按钮', () => {
    const { src, a, b } = two();
    render(<Board tasks={[a, b]} inbox={[src]} now={NOW} onPatch={noop} onEditTask={noopAsync} onDelete={noop} />);
    expect(screen.queryByText(/选中这 \d+ 条/)).toBeNull();
  });

  it('按住 Shift 点等于单点加减，不是连选一段——这一屏没有「之间」', () => {
    const src = note({ id: 'i1', text: '一句原话', taskIds: ['t1', 't2', 't3'] });
    const tasks = [task({ id: 't1', title: 'A' }), task({ id: 't2', title: 'B' }), task({ id: 't3', title: 'C' })];
    const seen: Set<string>[] = [];
    render(<Host tasks={tasks} inbox={[src]} onSel={(ids) => seen.push(ids)} />);

    // 先用组选把勾选框露出来，再取消，留下一个「选中集非空过」的起点；
    // 然后点 A 把它选上，再 Shift 点 C。
    fireEvent.click(groupBtn(/选中这 3 条/));
    const boxes = () => document.querySelectorAll('.ink-task-card input[type=checkbox]');
    expect(boxes().length).toBeGreaterThan(0);

    seen.length = 0;
    // Shift 点卡片本体：如果这一屏真的做了连选，选中集会被整个替换成
    // 一段区间；退化成单点加减的话，只会在已选中的三张里去掉一张。
    const cardC = screen.getByText('C').closest('.ink-task-card') as HTMLElement;
    fireEvent.click(cardC, { shiftKey: true });
    expect(seen.length).toBeGreaterThan(0);
    expect([...seen[seen.length - 1]].sort()).toEqual(['t1', 't2']);
  });
});
