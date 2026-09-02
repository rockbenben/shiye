import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { Sidebar } from './Sidebar.js';
import type { InboxItem, List, Task } from '../types.js';
import { LIST_COLORS } from '../lib/listIcon.js';
import type { ViewDef } from '../lib/views.js';

// 侧栏现在有一份存在 localStorage 的偏好（文件夹的折叠状态，见
// lib/folderFold.ts）。**跨用例会串**——某一条点了「收起 副业」，后面所有
// 渲染那个文件夹的用例都会拿到一个收着的侧栏，于是里面的清单查不到，
// 报出来的却是「菜单里没有 X」这种指向别处的错。每条前面清一次，
// 不依赖执行顺序（跟 density.test.ts 头上那条规矩同一份）。
beforeEach(() => localStorage.clear());

const NOW = new Date('2026-08-14T12:00:00.000Z');
const defs: ViewDef[] = [
  { key: 'inbox', label: '收件箱', group: 'tasks', count: ({ inbox }) => inbox.filter((e) => !e.processed).length, render: () => null },
  { key: 'today', label: '今天', group: 'tasks', count: () => 3, render: () => null },
  { key: 'source', label: '按来源', group: 'tasks', render: () => null },
];
const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: 'x', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null, listId: null, section: null, tags: [], priority: 0,
  repeat: null, completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});
const list = (p: Partial<List> = {}): List =>
  ({ id: 'l1', name: '工作', color: '#8B5E34', folderId: null, order: 0, archived: false, filter: null, ...p });

const setup = (over: Partial<Parameters<typeof Sidebar>[0]> = {}) => {
  const onSelect = vi.fn();
  render(
    <AntApp>
      <Sidebar
        viewDefs={defs} current="today" onSelect={onSelect}
        tasks={[]} insights={[]} inbox={[]} now={NOW} lists={[]}
        onAddList={vi.fn()}
        composer={<div data-testid="随手记" />}
        {...over}
      />
    </AntApp>,
  );
  return { onSelect };
};

/**
 * 视图导航分段。原来是一个平的 <ul>，十四项——而它们本来就是三类东西
 * （换一批任务看 / 同一批任务的另一种摆法 / 另一个模块），摆成一排长得
 * 一样的行，看着又多又平。判据（哪一项归哪一段）在 `lib/views.tsx`。
 *
 * **`views`（日历/看板/四象限）和 `more`（习惯/专注统计/纪念日/回顾）都不在
 * 这条侧栏上**——它们画在最左那条竖图标栏上（`Rail.tsx`），判据在
 * `lib/views.tsx` 的 `RAIL_GROUPS`（照搬滴答清单自己在设置里的分法：那两批
 * 在它那边叫「功能模块」，侧栏只装「智能清单」）。侧栏这儿只剩「任务」一段，
 * 所以下面这几条：那两段的项传进来都不该出现。
 */
describe('Sidebar：视图导航分段', () => {
  const threeGroups = [
    { key: 'today', label: '今天', group: 'tasks' as const, render: () => null },
    { key: 'calendar', label: '日历', group: 'views' as const, render: () => null },
    { key: 'habits', label: '习惯', group: 'more' as const, render: () => null },
  ];

  it('只剩「任务」一个小标题——别的两段都上了竖栏', () => {
    setup({ viewDefs: threeGroups });
    const heads = [...document.querySelectorAll('.ink-nav-group')].map((e) => e.textContent);
    // 「清单」「标签」两段也用同一个类——它们排在后面，取第一个。
    expect(heads[0]).toBe('任务');
    expect(heads).not.toContain('换种看法');
  });

  it('**`views` 和 `more` 两段整个不在侧栏上**（它们在最左那条竖栏）', () => {
    setup({ viewDefs: threeGroups });
    const lists = [...document.querySelectorAll('.ink-nav-views')];
    expect(lists).toHaveLength(1);
    expect([...lists[0]!.querySelectorAll('.ink-nav-label')].map((e) => e.textContent)).toEqual(['今天']);
    expect(screen.queryByRole('button', { name: '日历' })).toBeNull();
    expect(screen.queryByRole('button', { name: '习惯' })).toBeNull();
  });

  it('**空段整段不渲染**——导航项可以被逐项关掉，剩一个光秃秃的标题比不显示更糟', () => {
    setup({ viewDefs: threeGroups.filter((v) => v.group === 'tasks') });
    const heads = [...document.querySelectorAll('.ink-nav-group')].map((e) => e.textContent);
    expect(heads).not.toContain('换种看法');
    expect(heads).not.toContain('别的');
    expect(document.querySelectorAll('.ink-nav-views')).toHaveLength(1);
  });
});

describe('Sidebar：导航', () => {
  it('是 nav 不是 tablist——十几个去处还带分组，tab 模式撑不住', () => {
    setup();
    expect(screen.getByRole('navigation', { name: '视图' })).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('当前那个去处标 aria-current="page"，别的不标', () => {
    setup({ current: 'today' });
    expect(screen.getByRole('button', { name: /今天/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /按来源/ }).getAttribute('aria-current')).toBeNull();
  });

  it('点一下报出那个 key', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole('button', { name: /按来源/ }));
    expect(onSelect).toHaveBeenCalledWith('source');
  });

  it('有 count 的显示数字，没有 count 的**不显示 0**', () => {
    setup({ inbox: [{ id: 'i1', text: 'x', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }] as InboxItem[] });
    expect(screen.getByRole('button', { name: /收件箱/ }).textContent).toContain('1');
    // 「按来源」没有 count——它是个档案视图，数字对它没有意义。显示 0 会让人
    // 以为里面是空的。
    expect(screen.getByRole('button', { name: /按来源/ }).textContent).not.toMatch(/\d/);
  });

  it('计数为 0 时不显示数字——一个常驻的「0」是噪音', () => {
    setup({ inbox: [] });
    expect(screen.getByRole('button', { name: /收件箱/ }).textContent).not.toMatch(/\d/);
  });

  it('清单区从真实数据来，一个清单一个入口', () => {
    setup({ lists: [list({ id: 'l1', name: '工作' }), list({ id: 'l2', name: '生活' })] });
    expect(screen.getByRole('button', { name: /工作/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /生活/ })).toBeTruthy();
  });

  it('没有清单时不渲染清单列表，但「清单」标题和新建入口还在——不然永远建不出第一条', () => {
    setup({ lists: [] });
    expect(screen.getByRole('button', { name: '新建清单' })).toBeTruthy();
    // 标题旁边的加号是唯一该出现的按钮——没有清单，就不该有清单条目按钮。
    expect(screen.queryByRole('button', { name: /工作|生活/ })).toBeNull();
  });

  // 这条原来断言的是「归档的清单**根本不出现**」——那时候没有任何入口能把
  // 一份清单置成 archived，这条规矩纯粹是在防手改出来的数据。现在归档是一个
  // 用户动作了，要求跟着变：**藏干净就没有任何入口能取消归档**，归档会变成
  // 一扇单向门。真正要守的是「别跟在用的那几份混在一起」。
  it('归档的清单不混在在用的那份列表里，另起一节「已归档」——藏干净的话就取消不了归档了', () => {
    setup({
      lists: [list({ id: 'l1', name: '在用的' }), list({ id: 'l2', name: '归档了的', archived: true })],
    });
    expect(screen.getByRole('button', { name: /^在用的$/ })).toBeTruthy();
    expect(screen.getByText('已归档')).toBeTruthy();

    const archived = document.querySelector('.ink-nav-archived') as HTMLElement;
    expect(within(archived).getByRole('button', { name: /^归档了的$/ })).toBeTruthy();
    // 在用的那一份不该跑进「已归档」里。
    expect(within(archived).queryByRole('button', { name: /^在用的$/ })).toBeNull();
  });

  it('一份归档的都没有时不出「已归档」这一节——一个空标题不比不渲染更有用', () => {
    setup({ lists: [list({ id: 'l1', name: '在用的' })] });
    expect(screen.queryByText('已归档')).toBeNull();
  });

  // task-3-brief 要点③：智能清单（filter 非 null）在导航上要有记号跟普通
  // 清单区分开——它是一份存下来的查询，不是容器，见 scoped.ts 顶部的注释。
  it('智能清单在导航上带一个记号（.ink-nav-smart），普通清单没有', () => {
    setup({
      lists: [
        list({ id: 'l1', name: '工作' }),
        list({ id: 'l2', name: '本周待办', filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] } }),
      ],
    });
    const normal = screen.getByRole('button', { name: /工作/ });
    const smart = screen.getByRole('button', { name: /本周待办/ });
    expect(normal.querySelector('.ink-nav-smart')).toBeNull();
    expect(smart.querySelector('.ink-nav-smart')).not.toBeNull();
  });

  // final-review.md m3：✦ 之前整颗 aria-hidden，普通清单和智能清单的可访问名
  // 一模一样（都只有清单名）——屏幕阅读器听不出区别。改成只隐藏 ✦ 这个字形、
  // 用 .ink-sr-only 留住「智能清单」这句话之后，可访问名（不只是 CSS class）
  // 就能看出区别，这条按可访问名断言，不是按 DOM 结构。
  it('智能清单的可访问名里带着「智能清单」，普通清单没有——不止是 CSS class 上带了记号', () => {
    setup({
      lists: [
        list({ id: 'l1', name: '工作' }),
        list({ id: 'l2', name: '本周待办', filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] } }),
      ],
    });
    // 普通清单的可访问名精确等于清单名，不带别的。
    expect(screen.getByRole('button', { name: '工作' })).toBeTruthy();
    // 智能清单的可访问名里多出「智能清单」这句话——正则精确匹配整个可访问名，
    // ✦ 这个字形本身不该混进去（对无障碍树隐藏）。
    expect(screen.getByRole('button', { name: /^本周待办智能清单$/ })).toBeTruthy();
  });

  it('标签区从任务上现算，不是另一张表', () => {
    setup({ tasks: [task({ id: 'a', tags: ['紧急'] }), task({ id: 'b', tags: ['紧急', '等回复'] })] });
    expect(screen.getByRole('button', { name: /紧急/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /等回复/ })).toBeTruthy();
  });

  it('随手记的输入框常驻在侧栏里，但不在 nav landmark 内部——一个输入框不是导航项', () => {
    setup();
    const composer = screen.getByTestId('随手记');
    expect(composer).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '视图' }).contains(composer)).toBe(false);
  });

  // 下面两条不用 @testing-library/user-event——这个仓库没装这个包（见
  // test-utils.tsx 里其它辅助函数，全部走 fireEvent）。表单提交靠
  // fireEvent.submit 直接触发，不依赖 jsdom 有没有实现「文本框里回车=
  // 提交表单」这条浏览器隐式提交行为。

  it('一条清单都没有的时候也能建第一条——加号不在清单区的条件渲染里', () => {
    const onAddList = vi.fn();
    setup({ lists: [], onAddList });

    fireEvent.click(screen.getByRole('button', { name: '新建清单' }));
    const input = screen.getByLabelText('清单名字');
    fireEvent.change(input, { target: { value: '买菜' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAddList).toHaveBeenCalledWith('买菜');
  });

  it('空名字不发请求——按回车想取消不该弹红横幅', () => {
    const onAddList = vi.fn();
    setup({ lists: [], onAddList });

    fireEvent.click(screen.getByRole('button', { name: '新建清单' }));
    const input = screen.getByLabelText('清单名字');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);

    expect(onAddList).not.toHaveBeenCalled();
  });
});

describe('Sidebar：搜索', () => {
  it('**侧栏上没有搜索框了**——它搬去了最左那条竖栏上的弹层（SearchModal）。留在这儿的毛病是：侧栏只有任务模块才渲染，站在习惯/日历上按 `/` 就是一个没反应的键', () => {
    setup();
    expect(screen.queryByLabelText('搜索任务')).toBeNull();
  });

  it('search 视图不出现在导航列表里——打字才会切过去，不是一个点得到的入口', () => {
    setup({ viewDefs: [...defs, { key: 'search', label: '搜索结果', group: 'tasks' as const, render: () => null }] });
    expect(screen.queryByRole('button', { name: '搜索结果' })).toBeNull();
  });
});

/**
 * 清单 emoji 图标（仿滴答清单「清单名称最前面输入 Emoji，可自动设置为清单的
 * 图标」）。**认哪一段是 emoji** 在 `lib/listIcon.test.ts` 里测；这里只测
 * 接线：导航项上画的是 emoji 还是那颗分类色圆点、名字有没有把 emoji 去掉。
 */
describe('Sidebar：清单名最前面的 emoji 当图标', () => {
  it('打了 emoji：画 emoji、名字里不再带它，那颗分类色圆点让位', () => {
    setup({ lists: [list({ id: 'L1', name: '🏠 家里' })] });
    const item = [...document.querySelectorAll('.ink-nav-item')]
      .find((el) => el.textContent?.includes('家里')) as HTMLElement;
    expect(item.querySelector('.ink-nav-emoji')?.textContent).toBe('🏠');
    expect(item.querySelector('.ink-nav-dot')).toBeNull();
    expect(item.querySelector('.ink-nav-label')?.textContent).toBe('家里');
  });

  it('没打 emoji：照旧画分类色圆点', () => {
    setup({ lists: [list({ id: 'L1', name: '工作' })] });
    const item = [...document.querySelectorAll('.ink-nav-item')]
      .find((el) => el.textContent?.includes('工作')) as HTMLElement;
    expect(item.querySelector('.ink-nav-emoji')).toBeNull();
    expect(item.querySelector('.ink-nav-dot')).not.toBeNull();
  });
});

/**
 * 情境（GTD）那一段。规矩跟标签一致：从任务上现算、只列真有任务的、
 * 一档都没人用时整段不渲染。
 */
describe('Sidebar：情境', () => {
  it('只列真有任务的那几档——五档常驻会把侧栏拉长三行永远是 0 的', () => {
    setup({ tasks: [task({ id: 'a', context: 'computer' }), task({ id: 'b', context: 'out' })] });
    expect(screen.getByRole('button', { name: /电脑前/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /外出/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /在家/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /联系人/ })).toBeNull();
  });

  it('一条都没分情境时，「情境」那个段标题整个不出现', () => {
    setup({ tasks: [task({ id: 'a', context: null })] });
    expect(screen.queryByText('情境')).toBeNull();
  });

  it('点一下报的是 `context:<英文 key>`，不是屏幕上那个中文名', () => {
    const { onSelect } = setup({ tasks: [task({ id: 'a', context: 'computer' })] });
    fireEvent.click(screen.getByRole('button', { name: /电脑前/ }));
    expect(onSelect).toHaveBeenCalledWith('context:computer');
  });

  it('后面那个数字只数还没了结的——跟标签/清单那排数字同一个口径', () => {
    setup({ tasks: [
      task({ id: 'a', context: 'computer' }),
      task({ id: 'b', context: 'computer', status: 'done' }),
    ] });
    // 两条都是 @电脑前，但其中一条已完成 → 数字是 1。
    expect(screen.getByRole('button', { name: /电脑前\s*1$/ })).toBeTruthy();
  });
});

/**
 * 二级标签（仿滴答清单）。层级用命名约定 `父/子` 表达，判据在
 * `lib/tagTree.test.ts`；这里只测侧栏这一层：缩不缩进、显示的是哪一段、
 * 点了报什么 key。
 */
describe('Sidebar：二级标签', () => {
  const withTag = (...tags: string[]) => [task({ id: 't1', tags })];

  it('`父/子` 缩进挂在父下面，子只显示斜杠后面那段——不重复父标签的名字', () => {
    setup({ tasks: withTag('工作', '工作/项目A') });
    const sub = document.querySelector('.ink-nav-subtags') as HTMLElement;
    expect(sub).not.toBeNull();
    // 名字里现在还带着那个未完成计数（「项目A 1」）——跟导航上那几个
    // 一样，计数就在按钮里、也就在可访问名里（读屏念得出来是件好事）。
    expect(within(sub).getByRole('button', { name: /项目A/ })).toBeTruthy();
  });

  it('点子标签报的是完整名字，不是显示出来的那半段', () => {
    const { onSelect } = setup({ tasks: withTag('工作/项目A') });
    fireEvent.click(screen.getByRole('button', { name: /项目A/ }));
    expect(onSelect).toHaveBeenCalledWith('tag:工作/项目A');
  });

  it('父标签自己没有任务时也建出来、也点得进去——点父标签连子标签一起看', () => {
    const { onSelect } = setup({ tasks: withTag('工作/项目A') });
    // 父标签自己没任务，但它连子标签一起算，所以名里也有个 1。
    const parent = screen.getByRole('button', { name: /^工作/ });
    expect(parent.className).toContain('ink-nav-tag-group');
    fireEvent.click(parent);
    expect(onSelect).toHaveBeenCalledWith('tag:工作');
  });

  it('没有斜杠的标签照旧是平的，不会凭空多一层缩进', () => {
    setup({ tasks: withTag('工作') });
    expect(document.querySelector('.ink-nav-subtags')).toBeNull();
  });
});

/**
 * 标签改名 / 删除（仿滴答清单的标签管理）。**算什么在 `lib/tagTree.test.ts`**
 * ——那边测子标签跟不跟着改、`#工作台` 会不会被误伤；这里只测接线。
 */
describe('Sidebar：标签管理', () => {
  const tagged = [task({ id: 'a', tags: ['工作', '工作/紧急'] })];

  /** 开某个标签的 ⋯ 并点里面一项。菜单挂在 body 末尾的浮层里。 */
  const pickTagMenu = async (tag: string, label: string) => {
    fireEvent.click(screen.getByLabelText(`标签 ${tag} 的更多操作`));
    const item = await waitFor(() => {
      const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent === label);
      if (!hit) throw new Error(`菜单里没有「${label}」`);
      return hit;
    });
    fireEvent.click(item);
  };

  it('不给那两个回调就没有那颗 ⋯——侧栏还是原来那样', () => {
    setup({ tasks: tagged });
    expect(screen.queryByLabelText('标签 工作 的更多操作')).toBeNull();
  });

  it('**子标签行上也有**——改「工作/紧急」不该被迫从父标签下手', () => {
    setup({ tasks: tagged, onRenameTag: vi.fn(), onDeleteTag: vi.fn() });
    expect(screen.getByLabelText('标签 工作/紧急 的更多操作')).toBeTruthy();
  });

  it('删除收在 ⋯ 里，不是一颗常驻的「×」——误点一下就是从 N 条任务上摘掉它，且捞不回来', async () => {
    const onDeleteTag = vi.fn();
    setup({ tasks: tagged, onDeleteTag });
    await pickTagMenu('工作', '删除');
    expect(onDeleteTag).toHaveBeenCalledWith('工作');
  });

  it('点改名就地展开一个输入框，草稿预填当前名字——多数改名只改一两个字', async () => {
    setup({ tasks: tagged, onRenameTag: vi.fn() });
    await pickTagMenu('工作', '改名');
    expect((screen.getByLabelText('标签 工作 的新名字') as HTMLInputElement).value).toBe('工作');
  });

  it('提交发新名字', async () => {
    const onRenameTag = vi.fn();
    setup({ tasks: tagged, onRenameTag });
    await pickTagMenu('工作', '改名');
    const input = screen.getByLabelText('标签 工作 的新名字');
    fireEvent.change(input, { target: { value: '事务' } });
    fireEvent.submit(input.closest('form')!);
    expect(onRenameTag).toHaveBeenCalledWith('工作', '事务');
  });

  it('没改 / 改成空白就什么都不发，直接收起来', async () => {
    const onRenameTag = vi.fn();
    setup({ tasks: tagged, onRenameTag });
    await pickTagMenu('工作', '改名');
    fireEvent.submit(screen.getByLabelText('标签 工作 的新名字').closest('form')!);
    expect(onRenameTag).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('标签 工作 的新名字')).toBeNull();
  });

  it('Esc 收起来，不改', async () => {
    const onRenameTag = vi.fn();
    setup({ tasks: tagged, onRenameTag });
    await pickTagMenu('工作', '改名');
    const input = screen.getByLabelText('标签 工作 的新名字');
    fireEvent.change(input, { target: { value: '事务' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRenameTag).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('标签 工作 的新名字')).toBeNull();
  });

  it('一次只开一个改名框', async () => {
    setup({ tasks: tagged, onRenameTag: vi.fn() });
    await pickTagMenu('工作', '改名');
    await pickTagMenu('工作/紧急', '改名');
    expect(screen.queryByLabelText('标签 工作 的新名字')).toBeNull();
    expect(screen.getByLabelText('标签 工作/紧急 的新名字')).toBeTruthy();
  });
});


/**
 * 清单管理（仿滴答清单：重命名 / 归档 / 删除）。**服务端那两条路由早就通了，
 * 前端一直只接了「新建」**——清单建出来改不动也删不掉，`archived` 更是没有
 * 任何入口能置成 true。改名的表单跟标签那份是同一个（`renameForm`）。
 */
describe('Sidebar：清单管理', () => {
  const two = [list({ id: 'l1', name: '工作' }), list({ id: 'l2', name: '归档了的', archived: true })];

  const pickListMenu = async (name: string, label: string) => {
    fireEvent.click(screen.getByLabelText(`清单 ${name} 的更多操作`));
    const item = await waitFor(() => {
      const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent === label);
      if (!hit) throw new Error(`菜单里没有「${label}」`);
      return hit;
    });
    fireEvent.click(item);
  };

  it('三个回调都不给就没有那颗 ⋯', () => {
    setup({ lists: two });
    expect(screen.queryByLabelText('清单 工作 的更多操作')).toBeNull();
  });

  it('改名：就地展开输入框，预填当前名字，提交发出去', async () => {
    const onRenameList = vi.fn();
    setup({ lists: two, onRenameList });
    await pickListMenu('工作', '改名');
    const input = screen.getByLabelText('清单 工作 的新名字') as HTMLInputElement;
    expect(input.value).toBe('工作');
    fireEvent.change(input, { target: { value: '事务' } });
    fireEvent.submit(input.closest('form')!);
    expect(onRenameList).toHaveBeenCalledWith('l1', '事务');
  });

  it('没改就什么都不发——跟标签改名共用同一个表单，行为一致', async () => {
    const onRenameList = vi.fn();
    setup({ lists: two, onRenameList });
    await pickListMenu('工作', '改名');
    fireEvent.submit(screen.getByLabelText('清单 工作 的新名字').closest('form')!);
    expect(onRenameList).not.toHaveBeenCalled();
  });

  it('在用的那份菜单里写「归档」，点了发 true', async () => {
    const onArchiveList = vi.fn();
    setup({ lists: two, onArchiveList });
    await pickListMenu('工作', '归档');
    expect(onArchiveList).toHaveBeenCalledWith('l1', true);
  });

  it('**已归档那份写「取消归档」，点了发 false**——归档不是单向门', async () => {
    const onArchiveList = vi.fn();
    setup({ lists: two, onArchiveList });
    await pickListMenu('归档了的', '取消归档');
    expect(onArchiveList).toHaveBeenCalledWith('l2', false);
  });

  it('删除直接报上去，确认框由 App 那边弹——这个组件不知道里面有几条任务', async () => {
    const onDeleteList = vi.fn();
    setup({ lists: two, onDeleteList });
    await pickListMenu('工作', '删除');
    expect(onDeleteList).toHaveBeenCalledWith('l1');
  });
});

/**
 * 文件夹（把清单分组，仿滴答清单）。**整块存在于服务端、界面上一处都没有**：
 * `Folder` 表、`List.folderId`、四条 CRUD 路由都在，侧栏一直把清单平铺。
 * 分组判据在 `lib/listIcon.test.ts` 的 `groupListsByFolder`，这里只测接线。
 */
describe('Sidebar：文件夹', () => {
  const F = (id: string, name: string, order = 0) => ({ id, name, order });

  const pickMenu = async (label: string, item: string) => {
    fireEvent.click(screen.getByLabelText(label));
    const hit = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent === item);
      if (!found) throw new Error(`菜单里没有「${item}」`);
      return found;
    });
    fireEvent.click(hit);
  };

  it('不给 folders 就跟原来一样平铺，一个文件夹标题都没有', () => {
    setup({ lists: [list({ id: 'l1', name: '工作' })] });
    expect(document.querySelector('.ink-nav-folder')).toBeNull();
    expect(screen.getByRole('button', { name: /^工作$/ })).toBeTruthy();
  });

  it('文件夹标题出现，里面的清单缩进挂在下面', () => {
    setup({
      lists: [list({ id: 'l1', name: '写作', folderId: 'f1' })],
      folders: [F('f1', '副业')],
    });
    expect(screen.getByText('副业')).toBeTruthy();
    const nested = document.querySelector('.ink-nav-infolder') as HTMLElement;
    expect(within(nested).getByRole('button', { name: /^写作$/ })).toBeTruthy();
  });

  // 名字必须是 `.ink-nav-label`，不能是裸文字节点：那个类带着
  // flex:1 / min-width:0 / ellipsis 三件套，侧栏里别的每一行都靠它收尾。
  // 裸着的时候长名字会折成两行（实测 267px 侧栏上 35px 高两行），而
  // `align-items: center` 把计数和 ⋯ 停在两行中间，看着像没对齐。
  /**
   * 收/放。**这是「侧栏变短」的那一下**：折叠必须真的不渲染那一组，不是
   * 把它藏在 CSS 后面——藏起来的话行还占着，而收起来的全部意义就是收回
   * 那些行。（`display: none` 的元素在 jsdom 里照样 getByRole 得到，所以
   * 这条断言的是「查不到」，不是「不可见」。）
   *
   * 一个文件夹装十一份清单是真实形状（一个 365 项目一份清单，全归在「365」
   * 下）——那时候文件夹没把列表切成几段，只是多了一行标题。
   */
  it('点收起：那一组的清单不再渲染；再点放回来', async () => {
    setup({
      lists: [list({ id: 'l1', name: '写作', folderId: 'f1' }), list({ id: 'l2', name: '读书', folderId: 'f1' })],
      folders: [F('f1', '副业')],
    });
    expect(screen.getByRole('button', { name: /^写作$/ })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('收起文件夹 副业'));
    expect(screen.queryByRole('button', { name: /^写作$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^读书$/ })).toBeNull();
    // 标题本身留着——收起来之后没有任何入口能放回来，就成了一扇单向门。
    expect(screen.getByText('副业')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('展开文件夹 副业'));
    expect(screen.getByRole('button', { name: /^写作$/ })).toBeTruthy();
  });

  // 读屏靠 aria-expanded 念「已折叠/已展开」。名字带上文件夹名：侧栏上会有
  // 好几颗一模一样的三角，只念「按钮」分不出是哪一个。
  it('三角带 aria-expanded，名字里有文件夹名', () => {
    setup({ lists: [list({ id: 'l1', folderId: 'f1' })], folders: [F('f1', '副业')] });
    const b = screen.getByLabelText('收起文件夹 副业');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(b);
    expect(screen.getByLabelText('展开文件夹 副业').getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * **顶层那组永远展开。** 它没有标题行，也就没有任何地方能把它放回来——
   * 收起来等于那几份清单从侧栏永久消失。
   */
  it('不属于任何文件夹的那几份不受影响', () => {
    setup({
      lists: [list({ id: 'l1', name: '收集', folderId: null }), list({ id: 'l2', name: '写作', folderId: 'f1' })],
      folders: [F('f1', '副业')],
    });
    fireEvent.click(screen.getByLabelText('收起文件夹 副业'));
    expect(screen.getByRole('button', { name: /^收集$/ })).toBeTruthy();
  });

  it('文件夹标题的名字套在 .ink-nav-label 里——跟清单/标签/视图那几行同一套收尾', () => {
    setup({
      lists: [list({ id: 'l1', name: '写作', folderId: 'f1' })],
      folders: [F('f1', '一个名字相当长的文件夹用来撑侧栏的宽度')],
    });
    const head = document.querySelector('.ink-nav-folder') as HTMLElement;
    const label = head.querySelector('.ink-nav-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('一个名字相当长的文件夹用来撑侧栏的宽度');
  });

  it('新建文件夹：点入口、打字、回车', () => {
    const onAddFolder = vi.fn();
    setup({ onAddFolder });
    fireEvent.click(screen.getByLabelText('新建文件夹'));
    const input = screen.getByLabelText('文件夹名字');
    fireEvent.change(input, { target: { value: '副业' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAddFolder).toHaveBeenCalledWith('副业');
  });

  it('空名字不发请求——服务端会 400，而人很可能只是按回车想取消', () => {
    const onAddFolder = vi.fn();
    setup({ onAddFolder });
    fireEvent.click(screen.getByLabelText('新建文件夹'));
    fireEvent.submit(screen.getByLabelText('文件夹名字').closest('form')!);
    expect(onAddFolder).not.toHaveBeenCalled();
  });

  it('文件夹改名走的是跟标签/清单同一个就地表单', async () => {
    const onRenameFolder = vi.fn();
    setup({ folders: [F('f1', '副业')], onRenameFolder });
    await pickMenu('文件夹 副业 的更多操作', '改名');
    const input = screen.getByLabelText('文件夹 副业 的新名字') as HTMLInputElement;
    expect(input.value).toBe('副业');
    fireEvent.change(input, { target: { value: '正业' } });
    fireEvent.submit(input.closest('form')!);
    expect(onRenameFolder).toHaveBeenCalledWith('f1', '正业');
  });

  it('删文件夹报上去，确认框由 App 那边弹', async () => {
    const onDeleteFolder = vi.fn();
    setup({ folders: [F('f1', '副业')], onDeleteFolder });
    await pickMenu('文件夹 副业 的更多操作', '删除');
    expect(onDeleteFolder).toHaveBeenCalledWith('f1');
  });

  it('清单的 ⋯ 里能挪进文件夹，发的是文件夹 id', async () => {
    const onMoveListToFolder = vi.fn();
    setup({ lists: [list({ id: 'l1', name: '工作' })], folders: [F('f1', '副业')], onMoveListToFolder });
    await pickMenu('清单 工作 的更多操作', '副业');
    expect(onMoveListToFolder).toHaveBeenCalledWith('l1', 'f1');
  });

  it('「不放进文件夹」发的是 null，不是空字符串', async () => {
    const onMoveListToFolder = vi.fn();
    setup({
      lists: [list({ id: 'l1', name: '工作', folderId: 'f1' })],
      folders: [F('f1', '副业')], onMoveListToFolder,
    });
    await pickMenu('清单 工作 的更多操作', '不放进文件夹');
    expect(onMoveListToFolder).toHaveBeenCalledWith('l1', null);
  });

  it('一个文件夹都没有时不出「移到文件夹」这一组——只剩「不放进文件夹」一项什么都没说', async () => {
    setup({ lists: [list({ id: 'l1', name: '工作' })], onMoveListToFolder: vi.fn(), onRenameList: vi.fn() });
    fireEvent.click(screen.getByLabelText('清单 工作 的更多操作'));
    await waitFor(() => expect(document.querySelectorAll('.ant-dropdown-menu-item').length).toBeGreaterThan(0));
    const labels = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
    expect(labels).toContain('改名');
    expect(labels).not.toContain('不放进文件夹');
  });

  it('**菜单会是空的时候连那颗 ⋯ 都不摆**——只接了「移到文件夹」、又一个文件夹都没建', () => {
    setup({ lists: [list({ id: 'l1', name: '工作' })], onMoveListToFolder: vi.fn() });
    expect(screen.queryByLabelText('清单 工作 的更多操作')).toBeNull();
  });
});

/**
 * 清单 / 文件夹上移下移（仿滴答清单侧栏能拖着重排）。`order` 以前建出来就
 * 冻住——顺序等于建的先后，永远。算什么在 `lib/listIcon.test.ts` 的
 * `movePatches`，这里只测接线：菜单里有没有、到头禁不禁、只在同一层内换。
 */
describe('Sidebar：重排', () => {
  const F = (id: string, name: string, order: number) => ({ id, name, order });
  const three = [
    list({ id: 'l1', name: '甲', order: 0 }),
    list({ id: 'l2', name: '乙', order: 1 }),
    list({ id: 'l3', name: '丙', order: 2 }),
  ];

  const openList = async (name: string) => {
    fireEvent.click(screen.getByLabelText(`清单 ${name} 的更多操作`));
    await waitFor(() => expect(document.querySelectorAll('.ant-dropdown-menu-item').length).toBeGreaterThan(0));
    return [...document.querySelectorAll('.ant-dropdown-menu-item')];
  };
  const row = (items: Element[], text: string) => items.find((e) => e.textContent === text)!;

  it('不给 onReorder 就没有这两项', async () => {
    setup({ lists: three, onRenameList: vi.fn() });
    const items = await openList('甲');
    expect(items.map((e) => e.textContent)).not.toContain('上移');
  });

  it('中间那份两边都能动', async () => {
    const onReorder = vi.fn();
    setup({ lists: three, onReorder });
    const items = await openList('乙');
    expect(row(items, '上移').className).not.toContain('disabled');
    expect(row(items, '下移').className).not.toContain('disabled');
  });

  it('**到头就禁用，不是藏起来**——藏起来菜单会忽长忽短，同一个动作每次在不同高度上', async () => {
    setup({ lists: three, onReorder: vi.fn() });
    expect(row(await openList('甲'), '上移').className).toContain('disabled');
  });

  it('点上移，发的是算好的那两条 order', async () => {
    const onReorder = vi.fn();
    setup({ lists: three, onReorder });
    fireEvent.click(row(await openList('乙'), '上移'));
    expect(onReorder).toHaveBeenCalledWith('list', [{ id: 'l2', order: 0 }, { id: 'l1', order: 1 }]);
  });

  it('**只在同一层内换**：文件夹里只有一份清单时它上下都动不了，哪怕顶层还有别的', async () => {
    setup({
      lists: [list({ id: 'top', name: '顶层的', order: 0 }), list({ id: 'in', name: '文件夹里的', order: 1, folderId: 'f1' })],
      folders: [F('f1', '副业', 0)],
      onReorder: vi.fn(),
    });
    const items = await openList('文件夹里的');
    expect(row(items, '上移').className).toContain('disabled');
    expect(row(items, '下移').className).toContain('disabled');
  });

  it('文件夹自己也能上下移，发的是 folder', async () => {
    const onReorder = vi.fn();
    setup({ folders: [F('f1', '甲', 0), F('f2', '乙', 1)], onReorder });
    fireEvent.click(screen.getByLabelText('文件夹 乙 的更多操作'));
    const items = await waitFor(() => {
      const xs = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (xs.length === 0) throw new Error('菜单还没展开');
      return xs;
    });
    fireEvent.click(row(items, '上移'));
    expect(onReorder).toHaveBeenCalledWith('folder', [{ id: 'f2', order: 0 }, { id: 'f1', order: 1 }]);
  });
});

/**
 * 编辑智能清单的筛选条件（仿滴答清单：智能清单建完还能改）。`filter` 以前
 * 建出来就冻住——想改一个档位只能删了重建，名字/颜色/位置全部重来。
 * 弹窗在 App 那边，这里只测「这一项什么时候出现、点了报什么」。
 */
describe('Sidebar：编辑智能清单的筛选条件', () => {
  const smart = list({
    id: 's1', name: '本周要紧的',
    filter: {
      status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: 7,
      hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
    },
  });
  const plain = list({ id: 'l1', name: '工作' });

  const menuOf = async (name: string) => {
    fireEvent.click(screen.getByLabelText(`清单 ${name} 的更多操作`));
    return await waitFor(() => {
      const xs = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (xs.length === 0) throw new Error('菜单还没展开');
      return xs;
    });
  };

  it('**普通清单没有这一项**——它没有筛选条件可编辑', async () => {
    setup({ lists: [plain], onEditListFilter: vi.fn(), onRenameList: vi.fn() });
    const labels = (await menuOf('工作')).map((e) => e.textContent);
    expect(labels).not.toContain('编辑筛选条件');
  });

  it('智能清单有，点了把整条清单报上去', async () => {
    const onEditListFilter = vi.fn();
    setup({ lists: [smart], onEditListFilter });
    const items = await menuOf('本周要紧的');
    const hit = items.find((e) => e.textContent === '编辑筛选条件')!;
    fireEvent.click(hit);
    expect(onEditListFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('不给回调就不出现', async () => {
    setup({ lists: [smart], onRenameList: vi.fn() });
    const labels = (await menuOf('本周要紧的')).map((e) => e.textContent);
    expect(labels).not.toContain('编辑筛选条件');
  });
});

/**
 * 「让 AI 回顾这份清单」。一个项目一份清单，所以这一项问的是「这个项目现在
 * 怎么样了」。**条件跟「编辑筛选条件」正好相反**，两条都得钉住。
 */
describe('Sidebar：让 AI 回顾这份清单', () => {
  const smart = list({
    id: 's1', name: '本周要紧的',
    filter: {
      status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: 7,
      hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
    },
  });
  const plain = list({ id: 'l1', name: '工作' });

  const menuOf = async (name: string) => {
    fireEvent.click(screen.getByLabelText(`清单 ${name} 的更多操作`));
    return await waitFor(() => {
      const xs = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (xs.length === 0) throw new Error('菜单还没展开');
      return xs;
    });
  };

  // 「点了报上去」那条挪到下面「有一条待办就能点」里了——**这里的清单必须有一条
  // 还挂着的任务**，不然那一项是灰的，点不动（那正是下面第一条钉的事）。
  it('普通清单有这一项', async () => {
    setup({ lists: [plain], onReviewList: vi.fn(), tasks: [task({ id: 'a', listId: 'l1' })] });
    const labels = (await menuOf('工作')).map((e) => e.textContent);
    expect(labels).toContain('让 AI 回顾这份清单');
  });

  /**
   * **一条还挂着的任务都没有时置灰。** 少了这条，一份空清单上点下去照样真的叫
   * 一次 AI：CLI 那条烧一两分钟订阅额度，接口那条按 token 真花钱，然后回一句
   * 「没提出任何建议」。「回顾」那一屏那颗全局按钮早就是这么做的
   * （`ReviewView.tsx` 的 `hasLive`）——**同一件事的两个入口不能有两个口径**。
   *
   * 刚建好一批清单时这是常态：一个项目一份清单建齐，任务还一条都没往里放。
   */
  it('清单里一条还挂着的任务都没有：那一项在，但是灰的，名字里写明为什么', async () => {
    setup({ lists: [plain], onReviewList: vi.fn(), tasks: [] });
    const item = (await menuOf('工作')).find((e) => /让 AI 回顾这份清单/.test(e.textContent ?? ''))!;
    expect(item.textContent).toContain('没有还挂着的任务');
    expect(item.className).toContain('disabled');
  });

  /**
   * **搁置的不算「还挂着」。** 这里**不能**复用侧栏角标那个数：它走 `inAllView`，
   * 搁置的算还在（角标回答的是「这摊还有多少事」）。而 `workflows/review.md` 明写
   * 「`later`（他自己搁置的）和 `done` 的不要动」——一份只剩搁置任务的清单，回顾
   * 进去一条都不许碰，那就是一次白跑。
   */
  it('只剩搁置/已完成的任务：照样是灰的', async () => {
    setup({
      lists: [plain],
      onReviewList: vi.fn(),
      tasks: [
        task({ id: 'a', listId: 'l1', status: 'later' }),
        task({ id: 'b', listId: 'l1', status: 'done' }),
      ],
    });
    const item = (await menuOf('工作')).find((e) => /让 AI 回顾这份清单/.test(e.textContent ?? ''))!;
    expect(item.className).toContain('disabled');
  });

  it('有一条待办就能点，名字里也不再带那句解释', async () => {
    const onReviewList = vi.fn();
    setup({ lists: [plain], onReviewList, tasks: [task({ id: 'a', listId: 'l1', status: 'todo' })] });
    const item = (await menuOf('工作')).find((e) => /让 AI 回顾这份清单/.test(e.textContent ?? ''))!;
    expect(item.textContent).toBe('让 AI 回顾这份清单');
    expect(item.className).not.toContain('disabled');
    fireEvent.click(item);
    expect(onReviewList).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }));
  });

  /**
   * **智能清单不能有这一项。** 它是一条存下来的查询，不是容器——没有任何任务的
   * `listId` 等于它的 id，发过去只会让 AI 对着一份空任务列表跑一趟、烧掉一次
   * 额度（调接口那条路上是真花钱的），然后回一句「这份清单里没什么要改的」。
   */
  it('智能清单没有这一项', async () => {
    setup({ lists: [smart], onReviewList: vi.fn(), onRenameList: vi.fn() });
    const labels = (await menuOf('本周要紧的')).map((e) => e.textContent);
    expect(labels).not.toContain('让 AI 回顾这份清单');
  });

  it('不给回调就不出现', async () => {
    setup({ lists: [plain], onRenameList: vi.fn() });
    const labels = (await menuOf('工作')).map((e) => e.textContent);
    expect(labels).not.toContain('让 AI 回顾这份清单');
  });
});

/**
 * 改颜色。**分类色一直是建清单那一刻按清单数轮着取的，之后没有任何入口能改**
 * ——攒到第七份清单时颜色开始重复，而那颗圆点正是侧栏里认清单用的记号。
 */
describe('Sidebar：改清单颜色', () => {
  const L = list({ id: 'l1', name: '工作', color: LIST_COLORS[0].hex });

  const openMenu = async () => {
    fireEvent.click(screen.getByLabelText('清单 工作 的更多操作'));
    return await waitFor(() => {
      const xs = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (xs.length === 0) throw new Error('菜单还没展开');
      return xs;
    });
  };

  it('不给回调就没有这一组', async () => {
    setup({ lists: [L], onRenameList: vi.fn() });
    const labels = (await openMenu()).map((e) => e.textContent);
    expect(labels).not.toContain(LIST_COLORS[1].name);
  });

  it('六个颜色都在，**每个都有名字**——只有色块的菜单读屏念不出来', async () => {
    setup({ lists: [L], onRecolorList: vi.fn() });
    const labels = (await openMenu()).map((e) => e.textContent);
    for (const c of LIST_COLORS) expect(labels.join('|'), c.name).toContain(c.name);
  });

  it('点一个发那个色号', async () => {
    const onRecolorList = vi.fn();
    setup({ lists: [L], onRecolorList });
    const items = await openMenu();
    fireEvent.click(items.find((e) => e.textContent?.includes(LIST_COLORS[2].name))!);
    expect(onRecolorList).toHaveBeenCalledWith('l1', LIST_COLORS[2].hex);
  });

  it('当前那个禁用着——藏起来看不出「少的那项正是它现在的颜色」', async () => {
    setup({ lists: [L], onRecolorList: vi.fn() });
    const items = await openMenu();
    const cur = items.find((e) => e.textContent?.includes(LIST_COLORS[0].name))!;
    expect(cur.className).toContain('disabled');
  });

  it('**候选里没有群青**——服务端会拒收它，给一个挑得出「服务端不收」的控件等于把一次 400 摆在人面前', () => {
    expect(LIST_COLORS.map((c) => c.hex.toUpperCase())).not.toContain('#2E3ED4');
  });
});
