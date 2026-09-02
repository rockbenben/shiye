import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskRow } from './TaskRow.js';
import type { DragHandleProps, MoveControls } from './TaskCard.js';
import { pressTab, task } from '../test-utils.js';
import { App as AntApp } from 'antd';
import type { List, Task } from '../types.js';

/** `DragHandleProps` 的最小夹具——`attributes` 六个字段是 dnd-kit
 * `useDraggable`/`useSortable` 的返回值形状，这里手填成 `useSortable` 在
 * `disabled: false` 时会给出的样子，够用来断言「TaskRow 原样转发到抓手
 * 节点上」这件事，不需要真的套一层 DndContext。 */
const dragStub = (over: Partial<DragHandleProps> = {}): DragHandleProps => ({
  title: '拖动可以调整顺序',
  disabled: false,
  attributes: {
    role: 'button', tabIndex: 0, 'aria-disabled': false,
    'aria-pressed': undefined, 'aria-roledescription': 'draggable', 'aria-describedby': 'dnd-desc',
  },
  listeners: { onPointerDown: vi.fn(), onKeyDown: vi.fn() },
  setActivatorNodeRef: vi.fn(),
  ...over,
});

const NOW = new Date(2026, 7, 18, 12, 0, 0); // 2026-08-18 本地时间中午
const at = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();

// 修复轮 1 · I-3：夹具 id 故意不用 test-utils.task() 默认的 't1'——挡住
// 「onPatch(t.id, …) 写死成 onPatch('t1', …) 也全绿」这类夹具巧合
// （parked-all.md「夹具恰好等于那个值」那个反复出现的形状）。`now` 可传，
// 给 I-1 那条「同一个 due 换 now」用。
function setup(over: Parameters<typeof task>[0] = {}, now: Date = NOW) {
  const onPatch = vi.fn();
  const onOpen = vi.fn();
  const t = task({ id: 'row-9c2', ...over });
  const utils = render(<TaskRow t={t} now={now} onPatch={onPatch} onOpen={onOpen} />);
  return { ...utils, onPatch, onOpen, t };
}

const check = () => screen.getByRole('button', { name: /标记完成|标回待办/ });

describe('TaskRow：完成走的是跟按钮一样的 PATCH 路径', () => {
  it('待办点圆圈 → onPatch(id, { status: "done" })', () => {
    const { onPatch, t } = setup({ status: 'todo' });
    fireEvent.click(check());
    expect(onPatch).toHaveBeenCalledWith(t.id, { status: 'done' });
  });

  it('已完成再点圆圈 → onPatch(id, { status: "todo" })，不是留在 done 或者变成别的状态', () => {
    const { onPatch, t } = setup({ status: 'done' });
    fireEvent.click(check());
    expect(onPatch).toHaveBeenCalledWith(t.id, { status: 'todo' });
  });

  // 修复轮 1 · M-1：勾选圈 / 行体 / 「更多」是兄弟节点，`.ink-trow` 上没有
  // 任何 onClick——不存在冒泡目标，这条盯的是「结构真的是兄弟，不是嵌套」
  // 这个事实，不是在测某个 stopPropagation 调用（组件里已经删掉了，没有
  // 祖先监听器需要挡）。
  it('点圆圈不会顺带触发 onOpen——圆圈和行体是兄弟节点，没有共同的祖先监听器', () => {
    const { onOpen } = setup({ status: 'todo' });
    fireEvent.click(check());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('已完成：aria-pressed 是 "true"', () => {
    setup({ status: 'done' });
    expect(check().getAttribute('aria-pressed')).toBe('true');
  });

  it('未完成：aria-pressed 是 "false"——勾选圈是这一行唯一的 toggle 语义控件', () => {
    setup({ status: 'todo' });
    expect(check().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('TaskRow：点标题/行体打开', () => {
  it('点标题按钮（行体）→ onOpen(id)', () => {
    const { onOpen, t } = setup({ title: '写周报' });
    fireEvent.click(screen.getByRole('button', { name: '写周报' }));
    expect(onOpen).toHaveBeenCalledWith(t.id);
  });

  it('标题超长时 title 属性给全文——截断是 CSS 的事，属性必须是完整标题', () => {
    const long = '这是一条故意写得很长很长很长很长很长很长很长很长很长很长很长的标题，用来验证一行截断之后原文还在';
    setup({ title: long });
    const btn = screen.getByTitle(long);
    expect(btn.textContent).toContain(long);
  });
});

describe('TaskRow：已完成的行——打勾 + 删除线', () => {
  it('已完成：勾选圈里有勾号，标题带删除线的 class', () => {
    setup({ status: 'done', title: '做完的事' });
    const btn = check();
    expect(btn.textContent).toContain('✓');
    expect(btn.className).toContain('ink-trow-check-done');
    const title = screen.getByText('做完的事');
    expect(title.className).toContain('ink-trow-title-done');
  });

  it('未完成：勾选圈没有勾号，标题没有删除线 class', () => {
    setup({ status: 'todo', title: '还没做的事' });
    const btn = check();
    expect(btn.textContent).not.toContain('✓');
    expect(btn.className).not.toContain('ink-trow-check-done');
    const title = screen.getByText('还没做的事');
    expect(title.className).not.toContain('ink-trow-title-done');
  });
});

describe('TaskRow：到期 chip 的上限——没有 due 就不出现，不是「功能压根没接」才通过', () => {
  // 修复轮 1 · I-1：原来只用 `toContain('8月20日')` 子串匹配——
  // `2026年8月20日` 也含这个子串，行把 `now` 喂没喂对 `dueChip` 根本没被
  // 测到（把 TaskRow.tsx 里的 now 换成 2099 年、或者把整段文案写死成
  // '8月20日'，都能让原来那条全绿）。这里改成对 `.ink-trow-due` 的
  // `textContent` 做精确匹配。
  it('对照：有 due 时到期 chip 渲染出精确文案（不是子串匹配）', () => {
    const { container } = setup({ due: at(2026, 8, 20, 9) });
    const el = container.querySelector('.ink-trow-due');
    expect(el).not.toBeNull();
    expect(el!.textContent!.trim()).toBe('8月20日');
  });

  // 同一个 due，换两个不同的 now，文案跟着变——直接证明「行把 now 传给了
  // dueChip」这个接线点，而不是随便传个值就能通过。
  it('同一个 due，now 落在当天 → chip 是「今天 HH:mm」', () => {
    const due = at(2026, 8, 20, 9);
    const { container } = setup({ due }, new Date(2026, 7, 20, 12, 0, 0));
    expect(container.querySelector('.ink-trow-due')!.textContent!.trim()).toBe('今天 09:00');
  });

  it('同一个 due，now 挪到前一天 → chip 变成「明天」——不是巧合传对的', () => {
    const due = at(2026, 8, 20, 9);
    const { container } = setup({ due }, new Date(2026, 7, 19, 12, 0, 0));
    expect(container.querySelector('.ink-trow-due')!.textContent!.trim()).toBe('明天');
  });

  it('没有 due：.ink-trow-due 整个不出现', () => {
    const { container } = setup({ due: null });
    expect(container.querySelector('.ink-trow-due')).toBeNull();
  });

  it('过期的 due 带上过期红的 class', () => {
    const { container } = setup({ due: at(2026, 8, 1, 9), status: 'todo' });
    expect(container.querySelector('.ink-trow-due-overdue')).not.toBeNull();
  });

  it('已完成的任务即使 due 早就过了，也不画过期红——跟 taskView.ts 的 isOverdue 同一条口径', () => {
    const { container } = setup({ due: at(2026, 8, 1, 9), status: 'done' });
    expect(container.querySelector('.ink-trow-due')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due-overdue')).toBeNull();
  });

  /**
   * **「快到期」那一档**（仿 OmniFocus 的 `Due Soon`）。判据在 `dueChip`，
   * 这几条测的是这一行画不画。
   *
   * 在它之前，到期只有两种样子：过期（红）和其他（一个色）——「今天 18:00
   * 截止」和「三个月后截止」在行上除了文字之外长得一模一样，而一整屏扫过去时
   * 眼睛读的是颜色。
   */
  it('三天内到期、还没过期：带上快到期那个 class', () => {
    const { container } = setup({ due: at(2026, 8, 19, 9), status: 'todo' });
    expect(container.querySelector('.ink-trow-due-soon')).not.toBeNull();
  });

  it('还早的不带——否则这个记号等于没有', () => {
    const { container } = setup({ due: at(2026, 9, 30, 9), status: 'todo' });
    expect(container.querySelector('.ink-trow-due')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due-soon')).toBeNull();
  });

  it('已经过期的走过期红，不同时挂两种——两句话互斥', () => {
    const { container } = setup({ due: at(2026, 8, 1, 9), status: 'todo' });
    expect(container.querySelector('.ink-trow-due-overdue')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due-soon')).toBeNull();
  });

  it.each([['done'], ['later']] as const)('%s 的任务不画快到期——跟过期红同一条口径', (status) => {
    const { container } = setup({ due: at(2026, 8, 19, 9), status });
    expect(container.querySelector('.ink-trow-due')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due-soon')).toBeNull();
  });

  /**
   * **群青优先于快到期。** AI 写的到期时间标群青（`.ink-time-ai`），而这两个
   * 都往同一个 chip 上挂 class——「这是谁写的」比「快了」更要紧，而且两个
   * 一起上的话字色只会剩一个、看不出是哪套规则赢了。
   */
  it('AI 写的到期时间：走群青，不走快到期', () => {
    const { container } = setup({ due: at(2026, 8, 19, 9), status: 'todo', source: 'ai' });
    expect(container.querySelector('.ink-time-ai')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due-soon')).toBeNull();
  });
});

// 整分支审查 C1：计划设计①明写「提醒：一个小铃铛（不是『提醒
// 2026-08-12 09:00』整串）」，`TaskRow.tsx` 里以前一行都没有。
describe('TaskRow：铃铛——设计①「提醒：一个小铃铛」', () => {
  it('有提醒：出现铃铛，aria-label 带完整时间（不是整串堆在可见文案里）', () => {
    const { container } = setup({ reminders: [{ at: at(2026, 8, 20, 9), firedAt: null }] });
    const bell = container.querySelector('.ink-trow-remind');
    expect(bell).not.toBeNull();
    expect(bell!.getAttribute('aria-label')).toContain('2026-08-20 09:00');
    // 可见文案本身不是「提醒 2026-08-20 09:00」这种整串——设计①原话点名
    // 不要这种写法，时间只出现在 aria-label 里。
    expect(bell!.textContent).not.toContain('2026-08-20');
  });

  // 上限：没有提醒时铃铛不出现，不是「功能压根没接」才通过——跟到期 chip
  // 那组「没有 due 就不出现」同一条纪律。
  it('没有提醒：铃铛不出现（上限）', () => {
    const { container } = setup({ reminders: [] });
    expect(container.querySelector('.ink-trow-remind')).toBeNull();
  });
});

/**
 * 在等谁 / 会重复。卡片上这两样都画得出来，行档一个都没有——**同一条任务
 * 换个密度就少两条信息**。「在等」那一条尤其站不住：筛选栏一直有「只看等待
 * 中的」，筛出一屏行，看不出各自在等什么。
 *
 * 写法跟铃铛一字不差（一个字形 + aria-label 带内容），所以断言也照那一组写。
 */
describe('TaskRow：在等 / 会重复两个记号', () => {
  it('在等：出现沙漏，等的是谁在 aria-label 里，不堆进可见文案', () => {
    const { container } = setup({ waitingFor: '张老师回邮件' });
    const mark = container.querySelector('.ink-trow-waiting');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('aria-label')).toBe('在等：张老师回邮件');
    expect(mark!.textContent).not.toContain('张老师');
  });

  it('没在等谁就不出现（上限）', () => {
    expect(setup({ waitingFor: null }).container.querySelector('.ink-trow-waiting')).toBeNull();
  });

  it('会重复：出现循环箭头，规则原话在 aria-label 里——跟卡片走同一个 describeRepeat，不另拼一套说法', () => {
    const { container } = setup({
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    });
    const mark = container.querySelector('.ink-trow-repeat');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('aria-label')).toBe('重复：每周一');
  });

  it('不重复就不出现（上限）', () => {
    expect(setup({ repeat: null }).container.querySelector('.ink-trow-repeat')).toBeNull();
  });
});

/**
 * 置顶图钉 + 两个层级记号。卡片上一直都有，行档一个都没有。
 *
 * 图钉那条不是锦上添花：置顶是所有排序的第一个比较键（`taskView.ts` 的
 * `byPinned`），一条被顶到最前的任务在行档上没有任何说明，整份列表的顺序
 * 看起来就是乱的。
 */
describe('TaskRow：置顶 / 层级', () => {
  const kid = (over: Partial<Task> = {}) => ({ ...task({ id: 'kid', parentId: 'p' }), ...over });
  const dad = task({ id: 'p', title: '装修' });

  it('置顶的行上有图钉', () => {
    expect(setup({ pinned: true }).container.querySelector('.ink-trow-pin')).not.toBeNull();
  });

  it('没置顶就没有（上限）', () => {
    expect(setup({ pinned: false }).container.querySelector('.ink-trow-pin')).toBeNull();
  });

  it('子任务写「↳ 父亲的标题」——平铺列表里它只是**挨着**父亲，换个筛选就孤零零一条', () => {
    const { container } = render(
      <AntApp><TaskRow t={kid()} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} allTasks={[dad, kid()]} /></AntApp>,
    );
    expect(container.querySelector('.ink-trow-parent')?.textContent).toBe('↳ 装修');
  });

  it('父任务写「n/m」，跟卡片同一份判据（childProgress）', () => {
    const done = { ...kid({ id: 'k1' }), status: 'done' as const };
    const { container } = render(
      <AntApp><TaskRow t={dad} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} allTasks={[dad, done, kid({ id: 'k2' })]} /></AntApp>,
    );
    expect(container.querySelector('.ink-trow-kids')?.textContent).toBe('1/2');
  });

  it('**没给 allTasks 就两个都不画**——十几个调用点漏接一个不该让那一行崩，跟卡片同一条约定', () => {
    const { container } = render(
      <AntApp><TaskRow t={kid()} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} /></AntApp>,
    );
    expect(container.querySelector('.ink-trow-parent')).toBeNull();
    expect(container.querySelector('.ink-trow-kids')).toBeNull();
  });

  it('compact（看板那一列 217px）下不画层级——它们是成串的东西，不是单字形，跟标签/子项数同一档', () => {
    const { container } = render(
      <AntApp>
        <TaskRow t={kid()} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} allTasks={[dad, kid()]} compact />
      </AntApp>,
    );
    expect(container.querySelector('.ink-trow-parent')).toBeNull();
  });
});

// 整分支审查 C2：TaskCard 的红标是 isOverdue || isReminderOverdue
// （taskView.ts 的 isTaskOverdue），TaskRow 以前只用了 isOverdue 那一半——
// 只设了提醒、没设 due 的任务，dueChip(null, now) 是 null，行档上会一个
// 记号都没有，而底部「有 N 条已经过期了」用的是两条一起的判据，会出现
// 「底下说过期了，上面一点红都没有」。
describe('TaskRow：只设了提醒、没设 due 也要有红——跟 TaskCard 用同一个判据', () => {
  it('只设了提醒、没设 due，提醒已经过期：行上出现红色「已过期」记号', () => {
    const { container } = setup({ due: null, status: 'todo', reminders: [{ at: at(2026, 8, 1, 9), firedAt: null }] });
    // 没有 due，不会是 .ink-trow-due 那颗到期 chip——找的是同一个红色 class，
    // 内容是「已过期」，不是某个日期文案。
    const mark = container.querySelector('.ink-trow-due-overdue');
    expect(mark, '只设了提醒、提醒已经过期，行上应该有红色记号').not.toBeNull();
    expect(mark!.textContent).toBe('已过期');
  });

  // 对照组：提醒还没到时间，没有 due——不该出现任何红色记号，防的是
  // 「只要有提醒就画红」这种更粗糙的坏实现。
  it('对照：只设了提醒、提醒还没到时间，没设 due：没有红色记号', () => {
    const { container } = setup({ due: null, status: 'todo', reminders: [{ at: at(2026, 8, 20, 9), firedAt: null }] });
    expect(container.querySelector('.ink-trow-due-overdue')).toBeNull();
  });

  it('已完成的任务即使提醒早就过了，也不画红——跟 taskView.ts 的 isReminderOverdue 同一条口径（done 不算）', () => {
    const { container } = setup({ due: null, status: 'done', reminders: [{ at: at(2026, 8, 1, 9), firedAt: null }] });
    expect(container.querySelector('.ink-trow-due-overdue')).toBeNull();
  });
});

// 修复轮 1 · 裁决 B：AI 推断的到期时间要跟 TaskCard.tsx 的 .ink-time-ai
// 同一个判定条件（t.source === 'ai'），原样复用那个类名和条件。
describe('TaskRow：AI 推断的到期时间标群青，跟 TaskCard 的 .ink-time-ai 同一条判据', () => {
  it('source: "ai" 且未过期：due chip 带 .ink-time-ai', () => {
    const { container } = setup({ source: 'ai', due: at(2026, 8, 20, 9) });
    const el = container.querySelector('.ink-trow-due')!;
    expect(el.classList.contains('ink-time-ai')).toBe(true);
  });

  it('source: "user"：due chip 不带 .ink-time-ai——手填的时间跟正文一样安静', () => {
    const { container } = setup({ source: 'user', due: at(2026, 8, 20, 9) });
    const el = container.querySelector('.ink-trow-due')!;
    expect(el.classList.contains('ink-time-ai')).toBe(false);
  });

  it('过期红优先：source "ai" 且已过期，只带 .ink-trow-due-overdue，不带 .ink-time-ai', () => {
    const { container } = setup({ source: 'ai', due: at(2026, 8, 1, 9), status: 'todo' });
    const el = container.querySelector('.ink-trow-due')!;
    expect(el.classList.contains('ink-trow-due-overdue')).toBe(true);
    expect(el.classList.contains('ink-time-ai')).toBe(false);
  });
});

describe('TaskRow：标签的上限——同样要有对照组', () => {
  // 修复轮 1 · I-4：原来对照组只放了一个标签，`t.tags.map(…)` 换成
  // `t.tags.slice(0,1).map(…)`（只渲染第一个）照样全绿。这里对照组给两个，
  // 断言数量。
  it('对照：有标签时全部渲染，不是只渲染第一个', () => {
    const { container } = setup({ tags: ['紧急', '工作'] });
    const chips = container.querySelectorAll('.ink-tag-chip');
    expect(chips.length).toBe(2);
    expect([...chips].map((c) => c.textContent)).toEqual(['紧急', '工作']);
  });

  it('没有标签：.ink-trow-tags 整个不出现', () => {
    const { container } = setup({ tags: [] });
    expect(container.querySelector('.ink-trow-tags')).toBeNull();
  });
});

describe('TaskRow：子任务计数的上限——同样要有对照组', () => {
  // 修复轮 1 · I-5：原来对照组正好给了 2 个子任务，`· {t.subtasks.length}`
  // 写死成 `· {2}` 照样全绿。这里换成 3 个、断言精确文案，顺带钉住
  // 「是总数不是未完成数」——夹具里两个 done、一个没做完，写成
  // `filter(s => !s.done).length` 会得到 1，跟这条断言的 3 对不上。
  it('对照：子任务计数是精确的总数（含已完成的），不是写死的常量', () => {
    const { container } = setup({
      subtasks: [
        { text: '第一步', done: true },
        { text: '第二步', done: true },
        { text: '第三步', done: false },
      ],
    });
    const el = container.querySelector('.ink-trow-subcount');
    expect(el).not.toBeNull();
    expect(el!.textContent!.trim()).toBe('· 3');
  });

  it('没有子任务：.ink-trow-subcount 整个不出现', () => {
    const { container } = setup({ subtasks: [] });
    expect(container.querySelector('.ink-trow-subcount')).toBeNull();
  });

  /**
   * 读屏念的是「3 个子任务」，不是「点 3」——`·` 是给眼睛看的分隔号。
   *
   * 这条守的是 `role="img"` + `aria-label` 那一对属性：加上去的时候一条测试都
   * 没有，而它**会改写外层那颗按钮的可访问名**（CDP 读 AX 树实测：
   * `写周报· 4` → `写周报 4 个子任务`，是个改进，但改的是按钮的名字，不是
   * 一个可以随手动的角落）。文案手滑、或者哪天有人把 aria-label 删掉，
   * 屏幕上一个像素都不变，只有读屏用户听见区别。
   *
   * **不断言 `title`**：那颗外层按钮自己挂着 `title={t.title}`（标题被截断时
   * 悬停读全名，本文件另有一条 `getByTitle(long)` 钉着），子元素再挂一个 title
   * 会在那颗按钮上挖出一块悬停读不到标题的死区。
   */
  it('子项数带可读标签：role="img" + aria-label 念作「N 个子任务」，且不抢外层按钮的 title', () => {
    const { container } = setup({ subtasks: [{ text: 'a', done: false }, { text: 'b', done: true }, { text: 'c', done: false }] });
    const el = container.querySelector('.ink-trow-subcount')!;
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('3 个子任务');
    expect(el.hasAttribute('title')).toBe(false);
  });

  // 整分支审查 D1：GET /api/tasks 不校验文件写入的数据（TaskCard.tsx 渲染
  // .ink-subtask 那处、TaskBoard.test.tsx「缺 subtasks 字段不炸页面」都是
  // 同一条理由）——审查者实测：同一个缺 subtasks 字段的任务对象，卡档能
  // 兜住，行档裸读 `.length` 会直接抛 TypeError，把整个看板区域塌成错误
  // 面板。跟 TaskCard 对齐，配一条测试。
  it('缺 subtasks 字段不炸——跟 TaskCard 对齐，GET /api/tasks 不校验文件写入的数据', () => {
    const onPatch = vi.fn();
    const onOpen = vi.fn();
    const bad = { ...task({ id: 'row-bad' }), subtasks: undefined } as unknown as Task;
    // 变异验证锚点：TaskRow.tsx 把 `(t.subtasks ?? []).length` 换回裸的
    // `t.subtasks.length`——这条会红（render 直接抛 TypeError）。
    expect(() => render(<TaskRow t={bad} now={NOW} onPatch={onPatch} onOpen={onOpen} />)).not.toThrow();
  });
});

/**
 * 紧凑排版（task-3-brief 修复轮 1 · C-2）：只有看板传，标题独占一行、标签/
 * 子项数不渲染。**两个方向都要**——`compact: true` 时标签/子项数不在 DOM
 * 里（不是 CSS 藏起来），`compact` 不给（undefined，其余六个视图）时今天
 * 的行为不变，上限断言在下一个 describe 块（对照组）。
 */
describe('TaskRow：紧凑排版——只有看板传，标题独占一行，标签/子项数不渲染（task-3-brief 修复轮 1 · C-2）', () => {
  const tagged = { tags: ['紧急', '工作'], subtasks: [{ text: '第一步', done: false }] };

  it('compact: true：.ink-trow-tags/.ink-trow-subcount 都不在 DOM 里，哪怕任务本身有标签/子任务', () => {
    const t = task({ id: 'row-9c2', ...tagged });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} compact />);
    expect(container.querySelector('.ink-trow-tags')).toBeNull();
    expect(container.querySelector('.ink-trow-subcount')).toBeNull();
  });

  // 对照组：同一份带标签/子任务的夹具，compact 不给时两样都该在——防的是
  // 「标签/子项数被写死成永远不渲染」这类过度修正，不是靠 compact:true 那
  // 条正向用例自己证明「非 compact 还有这两样」。
  it('对照：compact 不给（undefined）时同一份夹具的标签/子项数都还在——上限，今天的行为不变', () => {
    const t = task({ id: 'row-9c2', ...tagged });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} />);
    expect(container.querySelector('.ink-trow-tags')).not.toBeNull();
    expect(container.querySelector('.ink-trow-subcount')).not.toBeNull();
  });

  it('compact: true：标题按钮带 .ink-trow-open-compact；不给/false 时不带', () => {
    const t = task({ id: 'row-9c2' });
    const { container, rerender } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} compact />);
    expect(container.querySelector('.ink-trow-open-compact')).not.toBeNull();

    rerender(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} compact={false} />);
    expect(container.querySelector('.ink-trow-open-compact')).toBeNull();
  });

  // compact 不该影响到期 chip/优先级旗——那两样比标签/子项数更要紧
  // （brief 原话：「到期/优先级更要紧，标题本身要靠这两样让路才读得全」），
  // C-2 要挤掉的是标签/子项数，不是全部元数据。
  it('compact: true：到期 chip、优先级旗还在——只有标签/子项数让路', () => {
    const t = task({ id: 'row-9c2', due: at(2026, 8, 20, 9), priority: 2, ...tagged });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} compact />);
    expect(container.querySelector('.ink-trow-due')).not.toBeNull();
    expect(container.querySelector('.ink-pri-flag')).not.toBeNull();
    expect(container.querySelector('.ink-trow-tags')).toBeNull();
    expect(container.querySelector('.ink-trow-subcount')).toBeNull();
  });
});

describe('TaskRow：优先级旗——走 --pri-*，不是群青（规格正面答过）', () => {
  it('priority > 0：显示旗，class 是 ink-pri-N', () => {
    const { container } = setup({ priority: 3 });
    const flag = container.querySelector('.ink-pri-flag');
    expect(flag).not.toBeNull();
    expect(flag!.className).toContain('ink-pri-3');
  });

  // 修复轮 1 · I-3：唯一的正向用例正好是 priority: 3，
  // `` `ink-pri-flag ink-pri-${t.priority}` `` 写死成字面量 `ink-pri-flag
  // ink-pri-3` 照样全绿。补一条不等于 3 的档位。
  it('priority === 1：class 是 ink-pri-1，不是恰好只测过 3 那个值', () => {
    const { container } = setup({ priority: 1 });
    const flag = container.querySelector('.ink-pri-flag');
    expect(flag).not.toBeNull();
    expect(flag!.className).toContain('ink-pri-1');
    expect(flag!.className).not.toContain('ink-pri-3');
  });

  it('priority === 0：不显示旗', () => {
    const { container } = setup({ priority: 0 });
    expect(container.querySelector('.ink-pri-flag')).toBeNull();
  });
});

describe('TaskRow：悬停才出现「更多」，且没占位（上限）', () => {
  it('没悬停：⋯ 整个不在 DOM 里', () => {
    const { container } = setup();
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
    expect(container.querySelector('.ink-trow-more')).toBeNull();
  });

  it('悬停之后：⋯ 出现；移开之后：⋯ 又消失', () => {
    const { container } = setup();
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    expect(screen.getByRole('button', { name: /更多操作/ })).toBeTruthy();
    fireEvent.mouseLeave(row);
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
  });

  // 修复轮 1 · M-1：同上，这颗按钮现在压根没有 onClick——「更多」还没接
  // 任何动作（是后面 Task 的事），这条盯的是「它不会顺带触发 onOpen」这个
  // 行为事实，不是某个已经删掉的 stopPropagation 调用。
  it('点「更多」不会顺带触发 onOpen——它自己没有 onClick，也没有祖先监听器可冒泡', () => {
    const { container, onOpen } = setup();
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('TaskRow：键盘可达性——聚焦也能让「更多」出现，不只是鼠标悬停（Task 1 复审 M-9，task-5 补上）', () => {
  // React 的 onFocus/onBlur 挂在容器上收的是原生 focusin/focusout（这两个
  // 会冒泡，focus/blur 本身不会）——`fireEvent.focus`/`.blur` 派发的是不
  // 冒泡的那一版，够不到挂在祖先节点上的处理器，得用 `.focusIn`/`.focusOut`。
  it('聚焦行内的标题按钮：⋯ 出现', () => {
    setup();
    const titleBtn = screen.getByRole('button', { name: '写周报' });
    fireEvent.focusIn(titleBtn);
    expect(screen.getByRole('button', { name: /更多操作/ })).toBeTruthy();
  });

  it('焦点真的离开整行（relatedTarget 在行外）：⋯ 收起', () => {
    setup();
    const titleBtn = screen.getByRole('button', { name: '写周报' });
    fireEvent.focusIn(titleBtn);
    expect(screen.getByRole('button', { name: /更多操作/ })).toBeTruthy();
    fireEvent.focusOut(titleBtn, { relatedTarget: document.body });
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
  });

  it('焦点在行内部转移（比如从标题切到「更多」自己）：relatedTarget 还在行内，⋯ 不收起', () => {
    setup();
    const titleBtn = screen.getByRole('button', { name: '写周报' });
    fireEvent.focusIn(titleBtn);
    const more = screen.getByRole('button', { name: /更多操作/ });
    fireEvent.focusOut(titleBtn, { relatedTarget: more });
    expect(screen.getByRole('button', { name: /更多操作/ })).toBeTruthy();
  });
});

describe('TaskRow：排序抓手——只有传了 drag 才出现，只有它自己是拖拽激活节点', () => {
  it('没传 drag：悬停也不出现抓手（上限，其余五个视图不该多出这个东西）', () => {
    const { container } = setup();
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    expect(container.querySelector('.ink-trow-handle')).toBeNull();
  });

  /**
   * 复审修复轮 1 · I4：抓手以前只在悬停/聚焦之后才挂进 DOM（`{hover && drag
   * && (...)}`），而它在 DOM 里排在勾选圈之前——纯键盘正向 Tab 的实际序列
   * 因此是「Tab 落到勾选圈（此时抓手还不在 DOM）→ focus 冒泡触发 hover →
   * 抓手挂到它前面 → 再 Tab 走到标题，抓手被跳过」，只有 Shift+Tab 才摸
   * 得到。这里改成常驻挂载、用 `.ink-trow-handle-hidden` 视觉隐藏——这条
   * 直接验证「常驻」这一半：没有 mouseEnter/focus，`drag` 给了的时候抓手
   * 已经在 DOM 里（带隐藏 class），不是要等悬停才出现。
   */
  it('传了 drag：不悬停/不聚焦，抓手也已经在 DOM 里（常驻挂载，只是视觉隐藏）——I4', () => {
    const t = task({ id: 'row-9c2' });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub()} />);
    const handle = container.querySelector('.ink-trow-handle');
    // 变异验证锚点：TaskRow.tsx 把 `{drag && (...)}` 改回
    // `{hover && drag && (...)}`——这条会红（不悬停时抓手整个不在 DOM 里）。
    expect(handle).not.toBeNull();
    expect(handle!.classList.contains('ink-trow-handle-hidden')).toBe(true);
  });

  it('传了 drag：悬停之后隐藏 class 摘掉，抓手正常显示', () => {
    const t = task({ id: 'row-9c2' });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub()} />);
    fireEvent.mouseEnter(container.querySelector('.ink-trow')!);
    const handle = container.querySelector('.ink-trow-handle')!;
    expect(handle.classList.contains('ink-trow-handle-hidden')).toBe(false);
  });

  /**
   * 复审修复轮 2 · I3 记账：I3 本身修对了（`aria-label={drag.title}`），
   * 但没有一条测试直接断言过这个可访问名字——复审删掉 `TaskRow.tsx` 里
   * 那行 `aria-label`，393 条相关测试原样全绿才发现的（`title` 属性在
   * 有子内容——`⠿`/排名数字——时不会被 accname 规范采纳，见 `TaskCard.tsx`
   * `DragHandleProps.title` 的注释）。这里补上正面断言，变异验证锚点：
   * `TaskRow.tsx` 里 `aria-label={drag.title}` 被删掉——这条会红（可访问
   * 名字退回 dnd-kit `attributes` 里没有的东西，`getAllByRole` 找不到）。
   */
  it('抓手的可访问名字是 aria-label 里那句话——I3', () => {
    const t = task({ id: 'row-9c2' });
    render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub()} />);
    expect(screen.getAllByRole('button', { name: '拖动可以调整顺序' })).toHaveLength(1);
  });

  /**
   * 复审修复轮 1 · I4 的核心断言——**真的按 Tab，不是 `.focus()` 冒充**（复审
   * 原话：「所有测试都用 handle.focus() 或先 mouseEnter 跳过了这一步，用例
   * 名却统统写着『Tab 到抓手』」）。用 `pressTab`（test-utils.tsx）：从行外
   * 一个已知的起点开始，连续按 Tab，第一个停下来的必须是抓手，不是勾选圈
   * 或标题——这才是「抓手排在正向 Tab 顺序最前面」这件事本身，不是「抓手
   * 能不能被 .focus() 指名道姓地选中」（那个哪怕挂在最后一个也测得过）。
   */
  it('真的按 Tab：从行外部开始，第一个停下来的是抓手，不是勾选圈或标题——I4', () => {
    const t = task({ id: 'row-9c2', title: '写周报' });
    render(
      <>
        <button data-testid="before">行外部的起点</button>
        <TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub()} />
      </>,
    );
    screen.getByTestId('before').focus();
    // 变异验证锚点：TaskRow.tsx 把抓手的 DOM 位置从「勾选圈之前」挪到
    // 「更多按钮之后」（或者恢复成 hover 门槛）——这条会红：Tab 第一次停下
    // 的会是勾选圈（.ink-trow-check），不是抓手。
    pressTab();
    expect(document.activeElement?.className).toContain('ink-trow-handle');
    pressTab();
    expect(document.activeElement?.className).toContain('ink-trow-check');
  });

  // 整分支审查 D2：28px 抓手位（.ink-trow-draggable）只在这一行可能有抓手
  // 时才留——`drag` 只在 onDropTo（看板/四象限）或「今天」时才给。上限
  // 断言两个方向都要：有抓手的视图留着这个 class，没抓手的六个视图不留。
  it('没传 drag（全部/接下来/已完成/搜索/清单/标签这六个视图）：不带 .ink-trow-draggable，不留 28px 抓手位（上限）', () => {
    const { container } = setup();
    const row = container.querySelector('.ink-trow')!;
    expect(row.classList.contains('ink-trow-draggable')).toBe(false);
  });

  it('传了 drag（今天/看板/四象限）：带 .ink-trow-draggable，留着 28px 抓手位', () => {
    const t = task({ id: 'row-9c2' });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub()} />);
    const row = container.querySelector('.ink-trow')!;
    // 变异验证锚点：TaskRow.tsx 把 `drag ? ' ink-trow-draggable' : ''`
    // 换成恒为空串（或者恒加）——这条和上面那条会有一条红。
    expect(row.classList.contains('ink-trow-draggable')).toBe(true);
  });

  it('传了 drag：悬停之后抓手出现，且只有抓手自己是拖拽激活节点，整行不是', () => {
    const t = task({ id: 'row-9c2' });
    const setActivatorNodeRef = vi.fn();
    const { container } = render(
      <TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub({ setActivatorNodeRef })} />,
    );
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    const handle = container.querySelector('.ink-trow-handle');
    expect(handle).not.toBeNull();
    // setActivatorNodeRef 是 dnd-kit 认定「这是可以按下去开始拖的那个节点」
    // 的唯一依据（挂 ref 才算数，不是某个 HTML 属性）——它必须收到抓手这个
    // 真实 DOM 节点，且只调用这一次。
    expect(setActivatorNodeRef).toHaveBeenCalledTimes(1);
    expect(setActivatorNodeRef).toHaveBeenCalledWith(handle);
    // 整行不该被摊上 role="button"/tabIndex 这类拖拽激活属性——
    // TodayView.tsx 顶部注释解释过为什么整行不能是拖拽区（会让标题里选不了
    // 文字），这条是这个 Task 的第二条硬约束，必须钉住。
    expect(row.getAttribute('role')).not.toBe('button');
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  it('attributes/listeners 原样摊在抓手节点上——role/tabIndex 能读到，指针事件真的转发给 dnd-kit 的监听器', () => {
    const onPointerDown = vi.fn();
    const drag = dragStub({
      attributes: {
        role: 'button', tabIndex: 0, 'aria-disabled': false,
        'aria-pressed': undefined, 'aria-roledescription': 'draggable', 'aria-describedby': 'dnd-desc',
      },
      listeners: { onPointerDown },
    });
    const t = task({ id: 'row-9c2' });
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={drag} />);
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    const handle = container.querySelector('.ink-trow-handle')!;
    // 变异验证锚点：TaskRow.tsx 的 `{...drag.attributes}` 被删掉——下面这行会红。
    expect(handle.getAttribute('role')).toBe('button');
    expect(handle.getAttribute('tabindex')).toBe('0');
    // 变异验证锚点：`{...drag.listeners}` 被删掉——指针事件不会转发，
    // onPointerDown 永远不会被调用。
    fireEvent.pointerDown(handle);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('disabled: true——手柄带 .ink-rank-locked，提示文案换成锁定态那句', () => {
    const t = task({ id: 'row-9c2' });
    const { container } = render(
      <TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={dragStub({ disabled: true, title: '上一次调整还没落定' })} />,
    );
    fireEvent.mouseEnter(container.querySelector('.ink-trow')!);
    const handle = container.querySelector('.ink-trow-handle')!;
    expect(handle.classList.contains('ink-rank-locked')).toBe(true);
    expect(handle.getAttribute('title')).toBe('上一次调整还没落定');
  });
});

/**
 * 上/下移收进「更多」（task-5-brief 唯一的硬约束）：这组测的是接线本身
 * （点了菜单里的按钮真的调用了 move.onUp/onDown、disabled 状态真的接上了
 * canMoveUp/canMoveDown/busy）——「移动之后顺序真的变了、落盘」这条更高
 * 一层的上限断言在 TodayView.test.tsx 里（那边才有真实的 order/onReorder
 * 可以断言，TaskRow 自己不知道整份列表长什么样）。
 */
describe('TaskRow：上/下移收进「更多」的菜单——task-5 唯一的硬约束', () => {
  const moveStub = (over: Partial<MoveControls> = {}): MoveControls => ({
    onUp: vi.fn(),
    onDown: vi.fn(),
    canMoveUp: true,
    canMoveDown: true,
    busy: false,
    loadingUp: false,
    loadingDown: false,
    ...over,
  });

  function setupWithMove(move: MoveControls) {
    const t = task({ id: 'row-9c2', title: '写周报' });
    const utils = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} move={move} />);
    const row = utils.container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    return { ...utils, row };
  }

  it('没传 move：点「更多」什么都不发生——没有菜单，也没有 onClick（跟其余五个视图今天的行为一致）', () => {
    const { container, onOpen } = setup();
    const row = container.querySelector('.ink-trow')!;
    fireEvent.mouseEnter(row);
    const more = screen.getByRole('button', { name: /更多操作/ });
    expect(more.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(more);
    expect(screen.queryByRole('button', { name: '上移' })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('传了 move：点一次「更多」展开菜单（上移/下移都在），再点一次收起', () => {
    setupWithMove(moveStub());
    const more = screen.getByRole('button', { name: /更多操作/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '上移' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下移' })).toBeTruthy();

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: '上移' })).toBeNull();
  });

  it('点「上移」/「下移」调用对应回调，不是互相调反了', () => {
    const move = moveStub();
    setupWithMove(move);
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));

    fireEvent.click(screen.getByRole('button', { name: '上移' }));
    expect(move.onUp).toHaveBeenCalledTimes(1);
    expect(move.onDown).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下移' }));
    expect(move.onDown).toHaveBeenCalledTimes(1);
    expect(move.onUp).toHaveBeenCalledTimes(1);
  });

  it('canMoveUp: false → 上移禁用；canMoveDown: false → 下移禁用（边界处，不是靠隐藏）', () => {
    setupWithMove(moveStub({ canMoveUp: false, canMoveDown: false }));
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    expect((screen.getByRole('button', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '下移' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('busy: true → 两颗都禁用，不管 canMoveUp/canMoveDown 各自是什么——全局忙碌状态优先', () => {
    setupWithMove(moveStub({ canMoveUp: true, canMoveDown: true, busy: true }));
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    expect((screen.getByRole('button', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '下移' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('鼠标移出整行：菜单跟着「更多」一起收起，不是残留在 DOM 里', () => {
    const { row } = setupWithMove(moveStub());
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(screen.getByRole('button', { name: '上移' })).toBeTruthy();

    fireEvent.mouseLeave(row);
    expect(screen.queryByRole('button', { name: '上移' })).toBeNull();
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
  });

  // 修复轮 1 · M-3：aria-controls 指向菜单面板的 id——菜单是「更多」的
  // 兄弟节点，没有这一行读屏软件只听得到「已展开」，找不到展开了什么。
  it('「更多」的 aria-controls 指向展开出来那个面板的 id', () => {
    setupWithMove(moveStub());
    const more = screen.getByRole('button', { name: /更多操作/ });
    fireEvent.click(more);
    const controlsId = more.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const panel = document.getElementById(controlsId!);
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('role')).toBe('group');
  });

  it('没传 move：aria-controls 不出现——没有菜单可控制，跟其余五个视图行为一致', () => {
    const { container } = setup();
    fireEvent.mouseEnter(container.querySelector('.ink-trow')!);
    const more = screen.getByRole('button', { name: /更多操作/ });
    expect(more.getAttribute('aria-controls')).toBeNull();
  });

  /**
   * 修复轮 1 · C-1：点上/下移会让那颗按钮变成 `disabled`（busy）——**真实
   * 浏览器**会在这一刻把一个正聚焦的元素被禁用时的焦点打回 `<body>`，
   * `relatedTarget` 是 `null`（jsdom 不模拟这一步，`down.blur()` 手工补上，
   * 见下面 `simulateBrowserKnocksFocusToBody` 的注释）。这不代表用户离开了
   * 这一行，`onBlur` 在 `busy` 期间必须跳过，否则菜单（连同 upRef/downRef
   * 指向的那两颗按钮）会被卸载，`TodayView.tsx` 的焦点归还 effect 就再也
   * 找不到目标——这条测试钉住「busy 期间收到『焦点被打回 body』的信号，
   * 菜单不能消失」这个具体行为，跟 TodayView.test.tsx 里那条端到端版本
   * （真的走一遍 onReorder）互补：这里是纯组件层面，不需要 TodayView 的
   * commit()/status 状态机就能把 busy 直接摆出来。
   */
  it('busy 时「焦点被打回 body」不收起菜单——C-1 的核心断言', () => {
    // 先用 busy:false 渲染、聚焦——一开始就 busy:true 的按钮从一开始就是
    // disabled，jsdom/真实浏览器都聚焦不上，那样测的不是这条缺陷本来的
    // 样子（真实场景是「点下去那一刻还能聚焦，disabled 是这次点击引发的
    // 重渲染才落地的」）。busy 变 true 用 rerender 模拟这次重渲染。
    const t = task({ id: 'row-9c2', title: '写周报' });
    const move = moveStub({ busy: false });
    const { container, rerender } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} move={move} />);
    fireEvent.mouseEnter(container.querySelector('.ink-trow')!);
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    const down = screen.getByRole('button', { name: '下移' }) as HTMLButtonElement;
    down.focus();
    expect(document.activeElement).toBe(down);

    rerender(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} move={{ ...move, busy: true }} />);

    // 真实浏览器这一步会自动发生：一个正聚焦的元素被禁用，浏览器把焦点
    // 打回 <body>，relatedTarget 是 null（这个仓库自己实测过，见修复轮 1
    // 报告）。jsdom 缺的正是这一步——连手工 `.blur()` 都不管用（对一个
    // 已经 disabled 的元素调用 `.blur()`，jsdom 里 `document.activeElement`
    // 纹丝不动，这是比原来设想更深的一层 jsdom 差距，不只是「不会自动
    // 发生」，连手动模拟都要绕开 `.blur()`）。这里直接派发那个真实浏览器
    // 会发的事件本身——bubbles:true，会冒泡到 `.ink-trow` 触发 onBlur，
    // relatedTarget 显式给 null，跟真实信号完全一致。
    fireEvent.focusOut(down, { relatedTarget: null });

    // 菜单、「更多」都还在——没有被 busy 期间这次「离开」信号误伤。
    expect(screen.queryByRole('button', { name: '下移' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /更多操作/ })).not.toBeNull();
  });

  // 对照组：不是靠「onBlur 整个不再收起任何东西」这种更懒但错的写法蒙混
  // 过关——不 busy 时同样的「离开」信号是真的离开了这一行，菜单该收就得
  // 收。上一条测试如果是靠删掉整个 onBlur 折叠逻辑通过的，这一条会红。
  it('对照组：不 busy 时同样的「离开」信号是真的离开，菜单正常收起', () => {
    setupWithMove(moveStub({ busy: false }));
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    const down = screen.getByRole('button', { name: '下移' }) as HTMLButtonElement;
    down.focus();

    fireEvent.focusOut(down, { relatedTarget: null });

    expect(screen.queryByRole('button', { name: '下移' })).toBeNull();
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
  });
});

describe('TaskRow：不用 antd，一个 ant-* 的 class 都不该出现', () => {
  it('纯 CSS 画的行，渲染结果里没有任何 antd 组件的 class', () => {
    const { container } = setup({ status: 'done', priority: 2, tags: ['x'], subtasks: [{ text: 'a', done: false }] });
    expect(container.querySelector('[class*="ant-"]')).toBeNull();
  });

  // 修复轮 1 · M-4：上面那条只测了默认态（不悬停、不传 drag/move）——
  // 这个 Task 新增的三个 surface（抓手、「更多」展开态、菜单本身）全在
  // 覆盖之外，这次巧合都是原生元素才没露馅，但守卫得跟上，不能靠巧合。
  it('悬停 + 传了 drag/move + 展开菜单之后，抓手/更多/菜单里也没有任何 ant-* 的 class', () => {
    const t = task({ id: 'row-9c2', status: 'done', priority: 2, tags: ['x'], subtasks: [{ text: 'a', done: false }] });
    const drag = dragStub({ title: 't' });
    const move: MoveControls = {
      onUp: vi.fn(), onDown: vi.fn(), canMoveUp: true, canMoveDown: true, busy: false, loadingUp: false, loadingDown: false,
    };
    const { container } = render(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} drag={drag} move={move} />);
    fireEvent.mouseEnter(container.querySelector('.ink-trow')!);
    fireEvent.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(container.querySelector('.ink-trow-handle')).not.toBeNull();
    expect(container.querySelector('.ink-trow-menu')).not.toBeNull();
    expect(container.querySelector('[class*="ant-"]')).toBeNull();
  });
});

/**
 * 选中态（批量操作，task-2 修复轮 1）：TaskRow 复用的是已经流到 TaskGrid
 * 里的那套 selection/onSelectionChange，`select` prop 的形状**跟
 * `TaskCard.tsx` 的 `CardProps.select` 完全一致**——这里的用例照抄
 * `TaskCard.test.tsx`「TaskCard：选中态」那组，判据、preventDefault、
 * 勾选框出现条件、转发的 mods 都要对得上，唯一的结构性差异是：TaskCard
 * 没有「打开」这回事，选中和「什么都不做」二选一；TaskRow 的标题按钮本来
 * 就有 `onOpen`，选中和打开靠「按没按修饰键」分岔，不是靠「给没给 select」
 * 分岔——多出来的那几条用例专门钉住这一点。
 */
describe('TaskRow：选中态——跟 TaskCard 复用同一套 selection/onSelectionChange 语义', () => {
  const titleBtn = () => screen.getByRole('button', { name: '写周报' });

  function withSelect(
    select: { selected: boolean; showCheckbox: boolean; onClick: (m: { shift: boolean; ctrlOrMeta: boolean }) => void },
  ) {
    const onPatch = vi.fn();
    const onOpen = vi.fn();
    const t = task({ id: 'row-9c2' });
    const utils = render(<TaskRow t={t} now={NOW} onPatch={onPatch} onOpen={onOpen} select={select} />);
    return { ...utils, onPatch, onOpen, t };
  }

  /** `X` 键。判据和理由的正本在 `TaskCard.test.tsx`——这里盯的是**行档也得有**：
   *  同一个 TaskGrid 按密度在卡片和行之间切换，「键盘能不能进选中态」不该跟着
   *  密度变。 */
  it('焦点在这一行里按 X 就选中它——行档也有，不只卡片档', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.keyDown(titleBtn(), { key: 'x' });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('Shift + X 是连选；Ctrl + X 不认（那是剪切）', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.keyDown(titleBtn(), { key: 'X', shiftKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: true, ctrlOrMeta: true });
    onClick.mockClear();
    fireEvent.keyDown(titleBtn(), { key: 'x', ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('没有 select prop：点标题（哪怕带修饰键）只触发 onOpen，不会报错——今天的行为不变', () => {
    const { onOpen, t } = setup();
    fireEvent.click(titleBtn(), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith(t.id);
  });

  it('给了 select，但平常点标题（不带修饰键）：还是走 onOpen，不触发 select.onClick——两个手势按「有没有按修饰键」分岔，不是按「有没有给 select」分岔', () => {
    const onClick = vi.fn();
    const { onOpen, t } = withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(titleBtn());
    expect(onOpen).toHaveBeenCalledWith(t.id);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Ctrl 点标题：触发 select.onClick，mods 精确是 { shift: false, ctrlOrMeta: true }，不触发 onOpen', () => {
    const onClick = vi.fn();
    const { onOpen } = withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(titleBtn(), { ctrlKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Cmd（metaKey）点也算——ctrlOrMeta 不是只认 Ctrl', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(titleBtn(), { metaKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('Shift 点：mods 是 { shift: true, ctrlOrMeta: false }，且 preventDefault 拦掉浏览器扩展文本选区', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    // fireEvent 返回 dispatchEvent 的结果：事件被 preventDefault 时是 false，
    // 跟 TaskCard.test.tsx / TaskGrid.test.tsx onDragOver 同一个断言手法。
    const notCanceled = fireEvent.click(titleBtn(), { shiftKey: true });
    expect(notCanceled).toBe(false);
    expect(onClick).toHaveBeenCalledWith({ shift: true, ctrlOrMeta: false });
  });

  it('平常点（不带修饰键）不 preventDefault——只有 Shift 点才拦', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    const notCanceled = fireEvent.click(titleBtn());
    expect(notCanceled).toBe(true);
  });

  it('点勾选圈（哪怕带修饰键）不会触发选中——它是独立的按钮，只切完成/取消完成，跟 TaskCard 上「点按钮不选中」是同一条上限', () => {
    const onClick = vi.fn();
    const { onPatch, t } = withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(check(), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
    expect(onPatch).toHaveBeenCalledWith(t.id, { status: 'done' });
  });

  it('showCheckbox: false 时没有勾选框；true 时才有', () => {
    const { container, rerender, t } = withSelect({ selected: false, showCheckbox: false, onClick: vi.fn() });
    expect(container.querySelector('.ink-trow-select')).toBeNull();

    rerender(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} select={{ selected: false, showCheckbox: true, onClick: vi.fn() }} />);
    expect(container.querySelector('.ink-trow-select')).not.toBeNull();
  });

  it('selected: true 时行带选中标记的 class，false 时没有', () => {
    const { container, rerender, t } = withSelect({ selected: false, showCheckbox: true, onClick: vi.fn() });
    expect(container.querySelector('.ink-trow-selected')).toBeNull();

    rerender(<TaskRow t={t} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} select={{ selected: true, showCheckbox: true, onClick: vi.fn() }} />);
    expect(container.querySelector('.ink-trow-selected')).not.toBeNull();
  });

  it('点勾选框本身：平常点（不需要按 Ctrl）就触发 onClick，mods 固定是 { shift: false, ctrlOrMeta: true }', () => {
    const onClick = vi.fn();
    const { container } = withSelect({ selected: false, showCheckbox: true, onClick });
    const checkbox = container.querySelector('.ink-trow-select') as HTMLElement;
    expect(checkbox).not.toBeNull();
    fireEvent.click(checkbox);
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });
});

describe('TaskRow：待决建议记号——群青唯一合法出现的地方（task-2 修复轮 1）', () => {
  it('hasProposal: true 时出现 .ink-trow-proposal', () => {
    const { container } = render(<TaskRow t={task({ id: 'row-9c2' })} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} hasProposal />);
    expect(container.querySelector('.ink-trow-proposal')).not.toBeNull();
  });

  it('hasProposal 不给（undefined）：不出现——上限，今天的行为不变', () => {
    const { container } = setup();
    expect(container.querySelector('.ink-trow-proposal')).toBeNull();
  });

  it('hasProposal: false（显式）：同样不出现', () => {
    const { container } = render(<TaskRow t={task({ id: 'row-9c2' })} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} hasProposal={false} />);
    expect(container.querySelector('.ink-trow-proposal')).toBeNull();
  });
});

/**
 * 属于哪个清单。**卡片档一直有（左边一条清单色竖条 + 圆点和名字），行档
 * 一个字都没有**——而行档正是「全部」「搜索」「今天」这类跨清单视图里最常
 * 用的密度，恰恰是这条信息最要紧的地方。
 */
describe('TaskRow：属于哪个清单', () => {
  const LISTS: List[] = [
    { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
    { id: 'L2', name: '🛒 购物', color: '#0F766E', folderId: null, order: 1, archived: false, filter: null },
  ];
  const show = (over: Parameters<typeof task>[0] = {}, extra: Partial<Parameters<typeof TaskRow>[0]> = {}) =>
    render(<TaskRow t={task({ id: 'row-9c2', ...over })} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} lists={LISTS} {...extra} />);

  it('画出清单名和一颗清单色圆点', () => {
    const { container } = show({ listId: 'L1' });
    expect(screen.getByText('工作')).toBeTruthy();
    expect(container.querySelector('.ink-list-dot')).not.toBeNull();
  });

  it('名字开头那个 emoji 当图标、替掉圆点——跟卡片和侧栏同一条判据（lib/listIcon.ts）', () => {
    const { container } = show({ listId: 'L2' });
    expect(screen.getByText('购物')).toBeTruthy();
    expect(container.querySelector('.ink-list-emoji')?.textContent).toBe('🛒');
    expect(container.querySelector('.ink-list-dot')).toBeNull();
  });

  it('**清单被删了（listId 指着一个不存在的 id）就什么都不画**——一个裸 uuid 对人没有意义', () => {
    const { container } = show({ listId: '没了' });
    expect(container.querySelector('.ink-list-name')).toBeNull();
  });

  it('不属于任何清单的也不画', () => {
    const { container } = show({ listId: null });
    expect(container.querySelector('.ink-list-name')).toBeNull();
  });

  it('compact（看板一列 217px）下不画——跟标签/子项数同一档，而且按清单分列时列头已经说过了', () => {
    const { container } = show({ listId: 'L1' }, { compact: true });
    expect(container.querySelector('.ink-list-name')).toBeNull();
  });
});

/**
 * 「更多操作」菜单。在这之前这一行的 ⋯ **只有「今天」视图里的上下移**——
 * 其余五个视图里它照样渲染出来、点了什么都不发生（那个组件自己的注释写着
 * 「点了什么都不发生，跟今天的行为一致」），而换成「行」密度还会静默失去
 * 卡片那颗 ⋯ 里的每一样。菜单本身在 `lib/taskMenu.test.ts`，这里只测接线。
 */
describe('TaskRow：更多操作', () => {
  const LISTS: List[] = [
    { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
  ];

  /** 这个 describe 自己的一份——下面那个同名的在别的 describe 里，够不着。 */
  const move = (): MoveControls => ({
    onUp: vi.fn(), onDown: vi.fn(), canMoveUp: true, canMoveDown: true,
    busy: false, loadingUp: false, loadingDown: false,
  });

  const withMenu = (over: Parameters<typeof task>[0] = {}, extra: Partial<Parameters<typeof TaskRow>[0]> = {}) => {
    const onPatch = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const t = task({ id: 'row-9c2', ...over });
    render(
      <AntApp>
        <TaskRow t={t} now={NOW} onPatch={onPatch} onOpen={vi.fn()}
          lists={LISTS} onEdit={onEdit} onDelete={onDelete} {...extra} />
      </AntApp>,
    );
    return { onPatch, onEdit, onDelete, t };
  };

  /** ⋯ 只在悬停时出现，跟原来一样。 */
  const openMenu = async () => {
    fireEvent.mouseEnter(document.querySelector('.ink-trow') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /的更多操作$/ }));
    return await waitFor(() => {
      const xs = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (xs.length === 0) throw new Error('菜单还没展开');
      return xs;
    });
  };

  it('菜单里有卡片上那几样，不再是一颗点了没反应的按钮', async () => {
    withMenu();
    const labels = (await openMenu()).map((e) => e.textContent);
    expect(labels).toEqual(expect.arrayContaining(['编辑', '置顶', '今天', '明天', '删除']));
  });

  it('点「明天」发的是保留原钟点的那份 patch，跟卡片一模一样', async () => {
    // NOW 是 2026-08-18 中午，原来的截止是 8/11 18:00 → 明天 = 8/19，钟点不变。
    const { onPatch, t } = withMenu({ due: at(2026, 8, 11, 18) });
    const items = await openMenu();
    fireEvent.click(items.find((e) => e.textContent === '明天')!);
    expect(onPatch).toHaveBeenCalledWith(t.id, expect.objectContaining({ due: at(2026, 8, 19, 18) }));
  });

  it('「编辑」转出去——行档没有就地编辑表单，编辑的意思就是展开那张卡', async () => {
    const { onEdit, t } = withMenu();
    const items = await openMenu();
    fireEvent.click(items.find((e) => e.textContent === '编辑')!);
    expect(onEdit).toHaveBeenCalledWith(t.id);
  });

  it('删除**先弹跟卡片一字不差的确认**——同一个动作在两种密度下说两种话，等于让人以为是两回事', async () => {
    const { onDelete } = withMenu();
    const items = await openMenu();
    fireEvent.click(items.find((e) => e.textContent === '删除')!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('垃圾箱');
    expect(dialog.textContent).toContain('搁置');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('**「今天」视图（给了 move）继续走上下移那条老路**——那两颗按钮挂着键盘拖拽要用的 ref，塞进菜单里会把那条焦点契约弄断', async () => {
    withMenu({}, { move: move() });
    fireEvent.mouseEnter(document.querySelector('.ink-trow') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /的更多操作$/ }));
    expect(screen.getByRole('button', { name: '上移' })).toBeTruthy();
    expect(document.querySelectorAll('.ant-dropdown-menu-item')).toHaveLength(0);
  });

  it('不给 onEdit/onDelete 的调用点还是老样子，不崩', () => {
    expect(() => setup()).not.toThrow();
  });
});

// ── 便捷操作：双击改它、右键弹菜单（跟卡片档同一套约定）──
describe('TaskRow：双击改它、右键弹菜单', () => {
  const full = (over: Parameters<typeof task>[0] = {}) => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onPatch = vi.fn();
    const t = task({ id: 'row-9c2', title: '写周报', ...over });
    const utils = render(
      <TaskRow t={t} now={NOW} onPatch={onPatch} onOpen={vi.fn()} onEdit={onEdit} onDelete={onDelete} lists={[]} />,
    );
    return { ...utils, onEdit, onDelete, onPatch, t, row: utils.container.querySelector('.ink-trow')! };
  };

  it('**双击这一行 = 改它**——单击是「打开」（右边详情），双击是「就地改」', () => {
    const { row, onEdit, t } = full();
    fireEvent.doubleClick(row);
    expect(onEdit).toHaveBeenCalledWith(t.id);
  });

  it('**双击标题按钮不算**——那颗按钮自己有单击行为（打开），双击它不该顺带做第二件事', () => {
    const { onEdit, container } = full();
    // 按类名取，不按可访问名：标题按钮和「更多操作」按钮的名字里都有标题，
    // `getByRole('button', { name: /写周报/ })` 会一次匹配到两颗。
    fireEvent.doubleClick(container.querySelector('.ink-trow-open')!);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('右键这一行弹出 ⋯ 那份菜单——同一个 menu 对象，不是另抄一份', async () => {
    const { row } = full();
    fireEvent.contextMenu(row);
    const items = (await screen.findAllByRole('menuitem')).map((e) => e.textContent);
    expect(items).toContain('编辑');
    expect(items.length).toBeGreaterThan(3);
  });

  it('**没给 onEdit/onDelete 的只读列表：不包 Dropdown，右键落回浏览器自己的菜单**——顺带守住「这一行不出现任何 ant-* class」那条', () => {
    const { container } = setup();
    fireEvent.contextMenu(container.querySelector('.ink-trow')!);
    expect(container.querySelector('[class*="ant-"]')).toBeNull();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('有菜单时行上**只多一个 `ant-dropdown-trigger`**，那是个纯行为钩子——「这一行不用 antd 画」那条规矩说的是外观，这个类在真浏览器里实测不改任何计算样式（antd 唯一匹配它的规则还要求 `.ant-btn`）', () => {
    const { row } = full();
    const antClasses = row.className.split(/\s+/).filter((c) => c.startsWith('ant-'));
    expect(antClasses).toEqual(['ant-dropdown-trigger']);
    // 行内部照旧一个 antd 组件都没有。
    expect(row.querySelector('[class*="ant-"]')).toBeNull();
  });
});


/**
 * 「还没到开始时间」那枚 chip。卡片上一直画着「X 开始」，行档原来一点记号都
 * 没有——同一条任务换个密度就少一条信息，而这个文件自己就为「在等」「重复」
 * 认过同一条账（见那一段注释）。这一下是拍图看出来的：四象限里一条 9/1
 * 才开始的任务，跟旁边立刻能干的长得一模一样。
 */
/**
 * 情境（GTD）。跟下面「还没开始」同一条账：卡片上画得出来、行档上没有，
 * 同一条任务换个密度就少一条信息。这一条是照着 CONTRIBUTING 里那份「不会红的
 * 那几处」扫出来的——`context` 加完之后卡片画了、行档漏了，而全量测试是绿的。
 */
describe('TaskRow：情境', () => {
  it('分了情境就画 `@中文名`', () => {
    const { container } = setup({ context: 'computer' });
    expect(container.querySelector('.ink-context-mark')!.textContent).toBe('@电脑前');
  });

  it('没分情境就没有这个记号——不是画一个空的 `@`', () => {
    const { container } = setup({ context: null });
    expect(container.querySelector('.ink-context-mark')).toBeNull();
  });

  it('**画的是中文名，不是存盘的英文 key**——把字段值直接印出来也能让「非空」过', () => {
    const { container } = setup({ context: 'easy' });
    expect(container.querySelector('.ink-context-mark')!.textContent).toBe('@省力');
  });

  it('compact（看板那一列 217px）不画——跟标签/子项数同一档，多字符串先让路', () => {
    const { container } = render(
      <TaskRow t={task({ id: 'row-9c2', context: 'computer' })} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} compact />,
    );
    expect(container.querySelector('.ink-context-mark')).toBeNull();
  });
});

describe('TaskRow：还没开始', () => {
  // NOW 是 2026-08-18 中午（文件顶部）。两个夹具分坐它两边，「到了没到」才分得开。
  const LATER = new Date(2026, 8, 1, 9, 0, 0).toISOString();
  const EARLIER = new Date(2026, 7, 1, 9, 0, 0).toISOString();

  it('开始时间还没到：画一枚带「起」的 chip', () => {
    const { container } = setup({ startAt: LATER, due: null });
    const el = container.querySelector('.ink-trow-start');
    expect(el).not.toBeNull();
    // 后缀是「起」不是别的——它就摆在到期 chip 旁边，两枚长得一样，
    // 没这个后缀就会被读成截止时间。
    expect(el!.textContent).toMatch(/起$/);
  });

  it('开始时间已经到了：没有这枚 chip（它说的是「现在还干不了」，不是「有个开始时间」）', () => {
    const { container } = setup({ startAt: EARLIER, due: null });
    expect(container.querySelector('.ink-trow-start')).toBeNull();
  });

  it('没设开始时间：没有这枚 chip', () => {
    const { container } = setup({ startAt: null, due: null });
    expect(container.querySelector('.ink-trow-start')).toBeNull();
  });

  it('**到期 chip 照旧在**——两枚是共存的，不是新那枚把旧那枚挤掉了', () => {
    const { container } = setup({ startAt: LATER, due: LATER });
    expect(container.querySelector('.ink-trow-start')).not.toBeNull();
    expect(container.querySelector('.ink-trow-due')).not.toBeNull();
  });
});

/**
 * **父亲还没开始，行档上也要说得出**——跟卡片同一条理由：四象限和「现在做
 * 什么」按 `notStartedDeep` 把这条挡在外面（`lib/hierarchy.ts` 的
 * `blockingAncestor`），屏幕上不说的话，一条自己一个日期都没设的子任务从那
 * 两屏消失是无解的。行档比卡片窄，只写名字不写日期。
 */
describe('TaskRow：父任务还没开始时说出是谁挡着', () => {
  const LATER = new Date(2026, 8, 1, 9).toISOString();   // 9/1，NOW 是 8/18
  const PAST = new Date(2026, 7, 1, 9).toISOString();
  const dad = (over: Parameters<typeof task>[0] = {}) => task({ id: 'p', title: '装修', ...over });
  const kid = (over: Parameters<typeof task>[0] = {}) => task({ id: 'c', title: '量尺寸', parentId: 'p', ...over });
  const starts = (c: HTMLElement) => [...c.querySelectorAll('.ink-trow-start')].map((e) => e.textContent);
  const row = (all: Task[], self: Task) =>
    render(<AntApp><TaskRow t={self} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} allTasks={all} /></AntApp>).container;

  it('**写出父任务的名字**', () => {
    const c = row([dad({ startAt: LATER }), kid()], kid());
    expect(starts(c)).toEqual(['等「装修」']);
  });

  it('父亲的开始时间已经过了：什么都不写', () => {
    const c = row([dad({ startAt: PAST }), kid()], kid());
    expect(starts(c)).toEqual([]);
  });

  it('**自己也没开始时只写一枚**——写它自己那个日期，不重复说父亲', () => {
    const own = new Date(2026, 8, 5, 9).toISOString();
    const c = row([dad({ startAt: LATER }), kid({ startAt: own })], kid({ startAt: own }));
    expect(starts(c)).toHaveLength(1);
    expect(starts(c)[0]).not.toContain('装修');
  });

  it('没给 `allTasks` 就不画——跟旁边两个层级记号同一条约定', () => {
    const c = render(<AntApp><TaskRow t={kid()} now={NOW} onPatch={vi.fn()} onOpen={vi.fn()} /></AntApp>).container;
    expect(starts(c)).toEqual([]);
  });
});
