import { describe, it, expect, vi, afterEach } from 'vitest';
import { App as AntApp, Checkbox, ConfigProvider } from 'antd';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { List, Task } from '../types.js';
import { FOCUS_ABANDON_TAIL, MOVES, SWIPE, TaskCard, type DragHandleProps } from './TaskCard.js';
import { readFileSync } from 'node:fs';
import { btnIn, deleteCard, pickCardMenu } from '../test-utils.js';
import { ink, theme as appTheme } from '../theme.js';
import { POSTPONE_MIN } from '../lib/suggest.js';
import { whenText } from '../lib/dueChip.js';

// TaskCard 自己不直接碰 api.js——只有它渲染出来的 Attachments 子组件会。
// 跟 Attachments.test.tsx 同一份 mock 形状，这里单开一份是因为两个文件各自
// 独立跑，vi.mock 不跨文件共享。只 mock 这三个函数：TaskCard.tsx 自己没有
// 别的 api.ts 调用点，多 mock 的字段没有消费者。
vi.mock('../api.js', () => ({
  api: {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    attachmentUrl: vi.fn((taskId: string, name: string) => `/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`),
  },
}));
const { api } = await import('../api.js');
const uploadAttachmentMock = api.uploadAttachment as ReturnType<typeof vi.fn>;

const NOW = new Date(2026, 7, 12, 12, 0, 0);

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'ai', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
  { id: 'L2', name: '生活', color: '#15803D', folderId: null, order: 1, archived: false, filter: null },
  { id: 'L3', name: '归档了的', color: '#0E7490', folderId: null, order: 2, archived: true, filter: null },
];

// antd 会给「恰好两个汉字、非 text/link 变体」的按钮插空格，按中文找先去空白。
const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

// extra.lists 默认空数组——大多数测试不关心清单，只有 Task 3 那组要真的
// 传一份候选表。showCard 是同一个函数的另一个名字，两组测试各按自己读起来
// 顺的那个叫它。
function setup(
  over: Partial<Task> = {},
  extra: { lists?: List[]; offline?: boolean; allTasks?: Task[]; onEditTask?: (id: string, patch: Partial<Task>) => Promise<void>; onSkip?: (id: string) => void } = {},
) {
  const onDelete = vi.fn();
  const onPatch = vi.fn();
  const { container } = render(
    <AntApp>
      <TaskCard
        t={task(over)} now={NOW} lists={extra.lists ?? []} offline={extra.offline} allTasks={extra.allTasks}
        onPatch={onPatch} onEditTask={extra.onEditTask ?? (async () => {})} onDelete={onDelete} onEditingChange={() => {}}
        onSkip={extra.onSkip}
      />
    </AntApp>,
  );
  return { onDelete, onPatch, container };
}
const showCard = setup;

/** `pickCardMenu` 的标签是一个字面量联合（防打错），标签名是运行时才知道的
 *  字符串，套不进去——这里另开一个只给「打标签」那组用的小工具。 */
async function pickMenuLabel(label: string) {
  fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
  const item = await waitFor(() => {
    const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent?.replace(/\s/g, '') === label);
    if (!hit) throw new Error(`菜单里没有「${label}」`);
    return hit;
  });
  fireEvent.click(item);
}

/**
 * 删除是这张卡上分量最重的动作——现在会先进垃圾箱，点错了能在那边还原，
 * 不再是「误点等于真没了」，但依然值得先问一句：进了垃圾箱也得再点两下
 * 才能捞回来，不是什么都没发生。
 *
 * 它收在 ⋯ 菜单里（卡片最窄 358px，六个控件一行放不下，见 TaskCard），
 * 但「必须先确认」这条没变，这几条测试盯的是那个，不是它长在哪儿。
 */
describe('TaskCard：删除要先确认', () => {
  it('卡片上没有裸露的「删除」按钮——它收在 ⋯ 里，误点不到', () => {
    setup();
    expect(byText('删除')).toBeUndefined();
    expect(screen.getAllByRole('button').some((b) => b.textContent === '⋯')).toBe(true);
  });

  it('从菜单里点「删除」不会立刻删——那一下只是把确认弹出来', async () => {
    const { onDelete } = setup();

    await pickCardMenu('删除');

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('确认之后才真的删', async () => {
    const { onDelete } = setup();

    await deleteCard();

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('t1'));
  });

  it('点「取消」什么都不发生', async () => {
    const { onDelete } = setup();

    await pickCardMenu('删除');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(btnIn(dialog, '取消'));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it('确认里指一条可逆的路——多数想删的时刻其实是「暂时不想看见」', async () => {
    setup();

    await pickCardMenu('删除');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/搁置/)).toBeTruthy();
  });
});

/**
 * 置顶、创建副本、多级任务的两个记号（都仿滴答清单）。判据各自在
 * `lib/taskView.ts`（排序）和 `lib/hierarchy.ts`（层级）里测过，这里只测接线。
 */
describe('TaskCard：置顶 / 创建副本 / 多级任务记号', () => {
  it('菜单里点「置顶」发 pinned: true', async () => {
    const { onPatch } = setup();
    await pickCardMenu('置顶');
    expect(onPatch).toHaveBeenCalledWith('t1', { pinned: true });
  });

  it('已经置顶的那条菜单项变成「取消置顶」，点了发 pinned: false', async () => {
    const { onPatch } = setup({ pinned: true });
    await pickCardMenu('取消置顶');
    expect(onPatch).toHaveBeenCalledWith('t1', { pinned: false });
  });

  it('置顶要看得见——不然人不知道这张卡为什么排在最前面，也不知道去哪取消', () => {
    const { container } = setup({ pinned: true });
    expect(container.querySelector('.ink-pin-mark')).not.toBeNull();
    expect(setup().container.querySelector('.ink-pin-mark')).toBeNull();
  });

  /**
   * 「打标签」（仿滴答清单右键菜单里的标签那一项）。在这之前给一条任务补一个
   * 标签只能进编辑态、展开折叠块、打字、保存，四步。判据在 `lib/taskMenu.test.ts`，
   * 这里测的是接线：候选是从 `allTasks` 现算的、点下去发的是整份新 tags。
   */
  it('菜单里点一个没打过的标签，发的是加上它之后的整份 tags', async () => {
    const { onPatch } = setup({ tags: [] }, { allTasks: [task({ id: 'x', tags: ['工作'] })] });
    await pickMenuLabel('工作');
    expect(onPatch).toHaveBeenCalledWith('t1', { tags: ['工作'] });
  });

  it('已经打上的那一项前面有 `✓`，点它是摘掉——一个只加不减的入口是单向门', async () => {
    const { onPatch } = setup({ tags: ['工作'] }, { allTasks: [task({ id: 'x', tags: ['工作'] })] });
    await pickMenuLabel('✓工作');
    expect(onPatch).toHaveBeenCalledWith('t1', { tags: [] });
  });

  it('不给 allTasks 时整组「打标签」不出现——候选是从它现算的', async () => {
    setup({ tags: ['工作'] });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    await waitFor(() => expect(document.querySelectorAll('.ant-dropdown-menu-item').length).toBeGreaterThan(0));
    const labels = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
    expect(labels).not.toContain('✓ 工作');
  });

  it('不给 onDuplicate 时菜单里没有「创建副本」——一个点了没反应的菜单项比没有更糟', async () => {
    setup();
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    await waitFor(() => expect(document.querySelectorAll('.ant-dropdown-menu-item').length).toBeGreaterThan(0));
    const labels = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
    expect(labels).not.toContain('创建副本');
  });

  it('子任务卡上写清它属于谁——换个视图、或者父亲被筛掉了，这条卡就是孤零零一张', () => {
    const parent = task({ id: 'p', title: '装修' });
    const kid = task({ id: 'k', title: '刷墙', parentId: 'p' });
    render(
      <AntApp>
        <TaskCard t={kid} now={NOW} lists={[]} allTasks={[parent, kid]}
          onPatch={() => {}} onEditTask={async () => {}} onDelete={() => {}} onEditingChange={() => {}} />
      </AntApp>,
    );
    expect(screen.getByText(/属于「装修」/)).toBeTruthy();
  });

  it('父任务卡上写子任务进度', () => {
    const parent = task({ id: 'p', title: '装修' });
    const all = [parent, task({ id: 'k1', parentId: 'p', status: 'done' }), task({ id: 'k2', parentId: 'p' })];
    render(
      <AntApp>
        <TaskCard t={parent} now={NOW} lists={[]} allTasks={all}
          onPatch={() => {}} onEditTask={async () => {}} onDelete={() => {}} onEditingChange={() => {}} />
      </AntApp>,
    );
    expect(screen.getByText('子任务 1/2')).toBeTruthy();
  });

  it('不给 allTasks 时两个记号都不画，卡片照旧不崩——十几个调用点漏接一个不该白屏', () => {
    const { container } = setup({ parentId: 'p' });
    expect(container.querySelector('.ink-parent-mark')).toBeNull();
    expect(container.querySelector('.ink-kids-mark')).toBeNull();
  });
});

/**
 * 优先级 / 推迟 1 小时（仿滴答清单右键菜单）。补的是同一个不对称：批量操作条
 * 上早就有这两样，单张卡上没有——选中一条再走批量比在它自己的卡上改还少几步。
 */
describe('TaskCard：优先级 / 推迟收在 ⋯ 里', () => {
  const openMenu = async () => {
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    return await waitFor(() => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
      if (items.length < 5) throw new Error('菜单还没展开');
      return items;
    });
  };
  const click = async (label: string) => {
    await openMenu();
    fireEvent.click([...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent === label)!);
  };

  it('四档都在，高在前、「无」在最后', async () => {
    setup();
    const labels = (await openMenu()).filter((x) => ['高', '中', '低', '无'].includes(x ?? ''));
    expect(labels).toEqual(['高', '中', '低', '无']);
  });

  it('点一档发 priority——不用为了标个「高」开一次编辑表单', async () => {
    const { onPatch } = setup();
    await click('高');
    expect(onPatch).toHaveBeenCalledWith('t1', { priority: 3 });
  });

  it('点「无」发 0，不是 null', async () => {
    const { onPatch } = setup({ priority: 3 });
    await click('无');
    expect(onPatch).toHaveBeenCalledWith('t1', { priority: 0 });
  });

  it('当前那一档禁用着——藏起来看不出「少的那项正是它现在的档」', async () => {
    setup({ priority: 2 });
    await openMenu();
    const row = [...document.querySelectorAll('.ant-dropdown-menu-item')].find((e) => e.textContent === '中')!;
    expect(row.className).toContain('disabled');
  });

  it('**没有截止也没有提醒的任务不出现「推迟」**——点了什么都不会发生', async () => {
    setup();
    expect(await openMenu()).not.toContain('推迟 1 小时');
  });

  it('有截止时间就出现，点了把时间往后挪一小时', async () => {
    const { onPatch } = setup({ due: new Date(2026, 7, 12, 18).toISOString() });
    await click('推迟 1 小时');
    expect(onPatch).toHaveBeenCalledWith('t1', expect.objectContaining({
      due: new Date(2026, 7, 12, 19).toISOString(),
    }));
  });

  it('只有提醒没有截止的也能推——提醒跟着挪', async () => {
    const { onPatch } = setup({ reminders: [{ at: new Date(2026, 7, 12, 8).toISOString(), firedAt: null }] });
    await click('推迟 1 小时');
    expect(onPatch.mock.calls[0][1].reminders[0].at).toBe(new Date(2026, 7, 12, 9).toISOString());
  });
});

/**
 * 移动到清单（仿滴答清单右键菜单里的「移动到」）。候选判据在
 * `lib/listIcon.test.ts` 的 `fileableLists`，这里只测接线。
 */
describe('TaskCard：移动到清单', () => {
  const LISTS: List[] = [
    { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
    { id: 'L2', name: '生活', color: '#15803D', folderId: null, order: 1, archived: false, filter: null },
  ];

  const openMenu = async () => {
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    return await waitFor(() => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
      if (items.length < 5) throw new Error('菜单还没展开');
      return items;
    });
  };

  /** 清单名是数据，不是固定菜单项——所以不走 pickCardMenu 那个受控联合，
   *  见 test-utils.tsx 里那段说明。 */
  const pickList = async (name: string) => {
    await openMenu();
    fireEvent.click([...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent === name)!);
  };

  it('一个清单都没有时整组不出现——只剩「不属于任何清单」一项的「移动到」什么都没说', async () => {
    setup();
    expect(await openMenu()).not.toContain('不属于任何清单');
  });

  it('列出所有能归的清单，外加「不属于任何清单」', async () => {
    setup({}, { lists: LISTS });
    const labels = await openMenu();
    expect(labels).toEqual(expect.arrayContaining(['工作', '生活', '不属于任何清单']));
  });

  it('点一个发 listId——不用为了换个清单开一次编辑表单', async () => {
    const { onPatch } = setup({}, { lists: LISTS });
    await pickList('生活');
    expect(onPatch).toHaveBeenCalledWith('t1', { listId: 'L2' });
  });

  it('「不属于任何清单」发的是 null，不是空字符串', async () => {
    const { onPatch } = setup({ listId: 'L1' }, { lists: LISTS });
    await pickList('不属于任何清单');
    expect(onPatch).toHaveBeenCalledWith('t1', { listId: null });
  });

  it('**当前所在的那个列出来但禁用**——藏起来的话看不出「少的那项正是它现在待的地方」', async () => {
    setup({ listId: 'L1' }, { lists: LISTS });
    await openMenu();
    const row = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent === '工作')!;
    expect(row.className).toContain('disabled');
  });

  it('归档的清单不当候选，但任务本来就在里头时留着（禁用）', async () => {
    const archived: List[] = [{ ...LISTS[0], id: 'A', name: '去年', archived: true }, LISTS[1]];
    setup({ listId: 'A' }, { lists: archived });
    expect(await openMenu()).toEqual(expect.arrayContaining(['去年']));
  });
});

/**
 * 检查事项转为子任务（仿滴答清单「转为子任务」）。**能不能转在
 * `lib/hierarchy.test.ts`**，这里只测接线：按钮什么时候出现、点了报什么。
 */
describe('TaskCard：检查事项转为子任务', () => {
  const SUBS = [{ text: '刷墙', done: false }];

  const show = (
    over: Partial<Task> = {},
    onPromoteSubtask?: (t: Task, i: number) => void,
    allTasks?: Task[],
  ) => {
    const utils = render(
      <AntApp>
        <TaskCard t={task({ id: 'p', subtasks: SUBS, ...over })} now={NOW} lists={[]}
          onPromoteSubtask={onPromoteSubtask} allTasks={allTasks}
          onPatch={() => {}} onEditTask={async () => {}} onDelete={() => {}} onEditingChange={() => {}} />
      </AntApp>,
    );
    return { ...utils, btn: () => screen.queryByLabelText('把「刷墙」转成子任务') };
  };

  /** 一条 n 层的链，最深那一条 id 是 'p'（`show` 里那张卡）。 */
  const chainTo = (depth: number): Task[] => [
    ...Array.from({ length: depth - 1 }, (_, i) =>
      task({ id: `L${i}`, parentId: i === 0 ? null : `L${i - 1}` })),
    task({ id: 'p', subtasks: SUBS, parentId: `L${depth - 2}` }),
  ];

  it('不给 onPromoteSubtask 就没有这颗按钮——点了没反应的入口比没有更糟', () => {
    expect(show().btn()).toBeNull();
  });

  it('给了就出现，点了带上这一项的下标报上去', () => {
    const onPromote = vi.fn();
    const { btn } = show({}, onPromote);
    fireEvent.click(btn()!);
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), 0);
  });

  /**
   * **这一条整个换掉了。** 只做一层那时候「父任务自己已经是子任务」就不给转；
   * 五层下那是正常操作，真正不给转的是**这张卡已经在第五层**——转出来的那条
   * 挂上去就是第六层。
   */
  it('这张卡已经在第五层：不出现——转出来就是第六层', () => {
    expect(show({ parentId: 'L3' }, vi.fn(), chainTo(5)).btn()).toBeNull();
  });

  it('在第四层：照常出现，那只是第五层', () => {
    expect(show({ parentId: 'L2' }, vi.fn(), chainTo(4)).btn()).not.toBeNull();
  });

  /**
   * **拿不到全表时不拦。** 深度是全表算出来的；藏掉一颗本来能用的按钮，比
   * 偶尔让服务端回一次 400 更糟——后者至少说得出为什么。
   */
  it('没给 allTasks：照常出现，交给服务端把关', () => {
    expect(show({ parentId: 'grand' }, vi.fn()).btn()).not.toBeNull();
  });

  it('按钮不在勾选框的 label 里——在里面的话点它等于把这一项勾掉', () => {
    const { container, btn } = show({}, vi.fn());
    expect(container.querySelector('label')!.contains(btn()!)).toBe(false);
  });
});

/**
 * 跳过本次（仿滴答清单重复任务的「跳过」）。**算什么在
 * `server/src/repeat.test.ts`** ——那边测下一次落在哪、哪些字段重置、什么时候
 * 跳不动；这里只测接线：什么时候摆出这一项、点了发什么。
 */
describe('TaskCard：跳过本次', () => {
  const REP = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };
  const repeating = (over: Partial<Task> = {}) => ({
    due: new Date(2026, 7, 12, 9).toISOString(), repeat: REP, ...over,
  });

  const menuLabels = async () => {
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    return await waitFor(() => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
      if (items.length < 5) throw new Error('菜单还没展开');
      return items;
    });
  };

  // 下面三条都接了 onSkip：不接的话这一项本来就不出（见更下面那条），
  // 「没有」就不再是因为任务的形状，三条断言会变成恒真。
  const wired = { onSkip: () => {} };

  it('不重复的任务菜单里没有这一项——它没有「下一次」可跳', async () => {
    setup({}, wired);
    expect(await menuLabels()).not.toContain('跳过本次');
  });

  it('重复但没有截止时间的也没有——点了屏幕上什么都不会变', async () => {
    setup({ repeat: REP }, wired);
    expect(await menuLabels()).not.toContain('跳过本次');
  });

  it('次数用完的那条也没有——不该凭空多出一次', async () => {
    setup(repeating({ repeat: { ...REP, count: 0 } }), wired);
    expect(await menuLabels()).not.toContain('跳过本次');
  });

  /**
   * **没接 `onSkip` 的调用点，菜单里就没有这一项。** 原来这儿写死出这一项，
   * 点下去退回发一条普通 patch——服务端字段级的推迟计数把它记成一次拖延，
   * 而提示语一模一样。「今天」「按来源」两个视图当时就是这么漏的。
   * 这个位置原来的三条（`setup()` 不传 `onSkip`、断言 `onPatch` 收到 patch）
   * 测的正是那条退路。
   */
  it('没接 onSkip：能跳的任务菜单里也不出这一项——没接线的入口比记错账强', async () => {
    setup(repeating());
    expect(await menuLabels()).not.toContain('跳过本次');
  });

  it('接了 onSkip：能跳的才摆出来，点了走 onSkip，**不发 patch**', async () => {
    const onSkip = vi.fn();
    const { onPatch } = setup(repeating(), { onSkip });
    await pickCardMenu('跳过本次');
    expect(onSkip).toHaveBeenCalledWith('t1');
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('跳完说一句下次是什么时候——这张卡会从今天消失，不给回执看起来像被删了', async () => {
    setup(repeating(), { onSkip: () => {} });
    await pickCardMenu('跳过本次');
    expect(await screen.findByText(/跳过了，下次/)).toBeTruthy();
  });
});

/**
 * 改期（仿滴答清单右键菜单里的「日期」）。**算什么在 `lib/reschedule.test.ts`**
 * ——那边测保留原来的钟点、提醒跟着平移、坏数据不写出 Invalid Date；这里只测
 * 接线：菜单里点得到、点了发出去的是那份 patch。
 */
describe('TaskCard：改期收在 ⋯ 里', () => {
  it('菜单里有「改期」这一组，三个去处加一个清空', async () => {
    setup();
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '⋯')!);
    const labels = await waitFor(() => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
      if (items.length < 5) throw new Error('菜单还没展开');
      return items;
    });
    expect(labels).toEqual(expect.arrayContaining(['编辑', '今天', '明天', '下周', '去掉截止时间', '删除']));
  });

  it('点「明天」发一份把 due 挪到明天、钟点不变的 patch——不用为了推一天开一次编辑表单', async () => {
    // NOW 是 2026-08-12 12:00（本地），原来的截止是 8/11 18:00
    const { onPatch } = setup({ due: new Date(2026, 7, 11, 18).toISOString() });

    await pickCardMenu('明天');

    expect(onPatch).toHaveBeenCalledWith('t1', expect.objectContaining({
      due: new Date(2026, 7, 13, 18).toISOString(),
    }));
  });

  it('点「去掉截止时间」只清 due，不顺手把提醒也清了——两者各管各的', async () => {
    const { onPatch } = setup({
      due: new Date(2026, 7, 11, 18).toISOString(),
      reminders: [{ at: new Date(2026, 7, 11, 17).toISOString(), firedAt: null }],
    });

    await pickCardMenu('去掉截止时间');

    expect(onPatch).toHaveBeenCalledWith('t1', { due: null });
  });
});

/** 「编辑」跟删除一起进了 ⋯。它是可逆的，但也得点得到。 */
describe('TaskCard：编辑收进 ⋯ 之后仍然点得到', () => {
  it('从菜单里点「编辑」会进编辑态', async () => {
    setup();

    await pickCardMenu('编辑');

    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();
  });

  it('编辑态里标题框回车 = 保存，走的是跟「保存」按钮同一个 save()（空标题照样挡得住）', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    setup({}, { onEditTask });
    await pickCardMenu('编辑');

    const title = await screen.findByPlaceholderText('标题');
    fireEvent.change(title, { target: { value: '改过的标题' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith(
      't1', expect.objectContaining({ title: '改过的标题' }),
    ));
  });

  it('编辑态里 Esc = 取消，编辑框收起来', async () => {
    setup();
    await pickCardMenu('编辑');
    const title = await screen.findByPlaceholderText('标题');

    fireEvent.keyDown(title, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
  });
});

/**
 * I-4：编辑表单只做到改第一条提醒，但那不该等于「保存一次，第二条及以后的
 * 提醒就没了」。触发它的是「改标题」这种最日常的动作，而多提醒恰恰是这一批
 * 新加的能力——保存一次标题就把它废了，比没有这个编辑功能还糟。
 */
describe('TaskCard：保存编辑不会删掉后面的提醒', () => {
  it('任务原本有两条提醒，只编辑标题就保存——第二条原样保留，不是被清空', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({
            reminders: [
              { at: '2026-08-15T09:00:00.000Z', firedAt: null },
              { at: '2026-08-20T09:00:00.000Z', firedAt: null },
            ],
          })}
          now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalled());
    expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({
      reminders: [
        { at: '2026-08-15T09:00:00.000Z', firedAt: null },
        { at: '2026-08-20T09:00:00.000Z', firedAt: null },
      ],
    }));
  });
});

/**
 * 左右拖拽改状态。手势不是第二套状态机——它挑的每一步都必须是那排按钮里
 * 已经有的，否则会长成「按钮能做的和手势能做的不一样」。
 */
describe('TaskCard：左右拖拽', () => {
  it('每个方向的落点都必须是 MOVES 里已有的那一步', () => {
    for (const [from, dirs] of Object.entries(SWIPE)) {
      const allowed = MOVES[from as keyof typeof MOVES];
      for (const t of [dirs.left, dirs.right].filter(Boolean)) {
        expect(
          allowed.some((m) => m.to === t!.to && m.label === t!.label),
          `${from} 的手势落点「${t!.label}→${t!.to}」不在按钮里`,
        ).toBe(true);
      }
    }
  });

  const card = () => document.querySelector('.ink-swipe') as HTMLElement;
  // **pointerType 一律 'touch'**：手势只对手指/触控笔生效，鼠标那条路被
  // TaskCard.onPointerDown 明确挡掉了（见那里的长注释：鼠标横向拖拽是在选文字）。
  // 这几条原来全写的 'mouse'，正是那个 bug 能一路绿着发出去的原因——测试替
  // 用户按下的是一种它自己都测不到的指针。
  const swipe = (el: HTMLElement, from: number, to: number, y = 0, pointerType = 'touch') => {
    fireEvent.pointerDown(el, { clientX: from, clientY: 0, pointerId: 1, pointerType, button: 0 });
    fireEvent.pointerMove(el, { clientX: (from + to) / 2, clientY: y, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: to, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: to, clientY: y, pointerId: 1 });
  };

  it('待办往右拖过阈值 → 开始（doing）', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 0, 140);
    expect(onPatch).toHaveBeenCalledWith('t1', { status: 'doing' });
  });

  it('待办往左拖过阈值 → 搁置（later）', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 200, 40);
    expect(onPatch).toHaveBeenCalledWith('t1', { status: 'later' });
  });

  it('进行中往右是完成、往左是退回——跟按钮一致', () => {
    const a = setup({ status: 'doing' });
    swipe(card(), 0, 140);
    expect(a.onPatch).toHaveBeenCalledWith('t1', { status: 'done' });
  });

  it('没拖够距离就松手，什么都不发生', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 0, 40);          // 40px < 88px 阈值
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('竖着划不触发——那是在滚页面，不是在改状态', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 0, 140, 200);    // 纵向位移比横向大
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('那个方向没有落点时不改状态（已完成没法再往右推）', () => {
    const { onPatch } = setup({ status: 'done' });
    swipe(card(), 0, 200);
    expect(onPatch).not.toHaveBeenCalled();
  });

  // 回归：鼠标横向拖拽 = 在选文字，不是在划卡片。
  //
  // 这条守的是一个真实反馈：「选择文字就出现搁置等，无法选择」。鼠标一旦进了
  // 手势这条路，`ink-swipe-active` 的 `user-select: none` 会把选区掐掉、卡片
  // 滑开露出「搁置」，划够距离松手连状态都改了。两个断言分别盯住这件事的两半：
  // 状态没被改（onPatch 没被调用）、卡片压根没动（不带 ink-swipe-active，
  // 也就没有那句 user-select: none）。
  it('鼠标横向拖拽不触发手势——桌面上那是在选文字，不是在改状态', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 0, 200, 0, 'mouse');   // 200px 远超 88px 阈值，touch 的话必中
    expect(onPatch).not.toHaveBeenCalled();
    expect(card().className).not.toContain('ink-swipe-active');
  });

  it('触控笔照旧能划——挡的是鼠标这一种指针，不是「除手指外都不许」', () => {
    const { onPatch } = setup({ status: 'todo' });
    swipe(card(), 0, 140, 0, 'pen');
    expect(onPatch).toHaveBeenCalledWith('t1', { status: 'doing' });
  });

  it('从按钮上按下去不算手势——那是要点按钮', () => {
    const { onPatch } = setup({ status: 'todo' });
    const btn = byText('开始')!;
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0, pointerId: 1, pointerType: 'touch', button: 0 });
    fireEvent.pointerMove(card(), { clientX: 200, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(card(), { clientX: 200, clientY: 0, pointerId: 1 });
    expect(onPatch).not.toHaveBeenCalled();
  });
});

/**
 * 优先级：一面小旗，填充色区分档位（规格「第三条通道」——分类和优先级都只走
 * background/fill，标题永远是石墨黑）。0 档不画旗，避免每张卡都多一个空记号。
 */
describe('TaskCard：优先级旗标', () => {
  it('优先级非 0 时卡片上有一面旗，0 时没有', () => {
    const { container, rerender } = render(
      <AntApp>
        <TaskCard
          t={task({ priority: 0 })} now={NOW}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-pri-flag')).toBeNull();

    rerender(
      <AntApp>
        <TaskCard
          t={task({ priority: 3 })} now={NOW}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    const flag = container.querySelector('.ink-pri-flag');
    expect(flag).not.toBeNull();
    expect(flag!.className).toContain('ink-pri-3');

    // Space direction="vertical" 打平 Fragment，每个直接子节点各占一个
    // .ant-space-item——旗和标题必须共享同一个，不然旗会独占一行，看着像
    // 掉了字（实测过：分开写渲染出「孤零零一个 ⚑」，这条断言之前不存在）。
    const titleEl = screen.getByText('写周报');
    expect(flag!.closest('.ant-space-item')).not.toBeNull();
    expect(flag!.closest('.ant-space-item')).toBe(titleEl.closest('.ant-space-item'));
  });

  // 参数化三档，不只挑一个：中（2）恰好是「档位名字数组整个反过来」这种变异的
  // 不动点，只测 2 抓不出「高/低」被写反的问题——这条曾经真的漏过一次反转。
  it.each([
    [1, '低'],
    [2, '中'],
    [3, '高'],
  ] as const)('优先级 %i 的旗子 className 和 aria-label 都对得上（%s）', (priority, label) => {
    const { container } = render(
      <AntApp>
        <TaskCard
          t={task({ priority })} now={NOW}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    const flag = container.querySelector('.ink-pri-flag')!;
    expect(flag.className).toContain(`ink-pri-${priority}`);
    expect(flag.getAttribute('aria-label')).toBe(`优先级：${label}`);
  });
});

describe('TaskCard：标签', () => {
  it('卡片上把标签列成胶囊，没有标签就不出这一行', () => {
    // 夹具故意不用字典序（'紧'=U+7D27 > '工'=U+5DE5）：如果实现偷偷 sort()
    // 了一遍再渲染，字典序夹具测不出来，这条断言就成了等价变异。
    const { container } = setup({ tags: ['紧急', '工作'] });
    const chips = [...container.querySelectorAll('.ink-tag-chip')].map((e) => e.textContent);
    expect(chips).toEqual(['紧急', '工作']);

    const { container: empty } = setup({ tags: [] });
    expect(empty.querySelector('.ink-tag-chip')).toBeNull();
    // 只查 .ink-tag-chip 挡不住「{t.tags.length > 0 && …} 被改成 {true && …}」
    // 这种变异——空数组 .map 出来的仍然是零个 <span>，跟「整行没渲染」在
    // .ink-tag-chip 这条查询上长得一模一样。补一条查外层 .ink-tag-row 的，
    // 才能分清「行没出现」和「行出现了但恰好没有芯片」。
    expect(empty.querySelector('.ink-tag-row')).toBeNull();
  });

  /**
   * 编辑往返对 tags 的两处接线（startEdit 读、save 写）各配一条测试，不是
   * 因为凑数——之前只有「点了保存、不碰标签」这一种场景，`startEdit` 写死成
   * `tags: []`、`save` 写死成 `tags: t.tags`（丢掉表单里的改动）两种坏实现
   * 都能让那种场景全绿：前者进编辑态时 draft.tags 本来就该等于 t.tags，
   * 不碰的话谁都测不出「读丢了」；后者不碰标签时 draft.tags 和 t.tags 值
   * 相同，写死成 t.tags 和写 draft.tags 在这条路径上产出一模一样的 patch。
   * 两条分别要「进来看得到」和「改了真的带得走」，缺一个都堵不住对应的坏实现。
   */
  it('编辑往返之一：进编辑态时非空标签原样带进表单——不是被 startEdit 换成空数组', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ tags: ['甲', '乙'] })} now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({ tags: ['甲', '乙'] })));
  });

  it('编辑往返之二：编辑态里删掉一个标签再保存，patch 里带走的是改过的那份，不是保存前的旧值', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ tags: ['甲', '乙'] })} now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    fireEvent.click(screen.getByRole('button', { name: '删掉标签 甲' }));
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({ tags: ['乙'] })));
  });
});

/**
 * 卡片左边一条 3px 竖条 + 清单名前一个 6px 实心圆点，颜色都是清单色；
 * 清单名本身是石墨黑（规格「第三条通道」）。
 */
describe('TaskCard：清单归属', () => {
  it('属于某个清单时画一条竖条和一个圆点，颜色是清单色', () => {
    const { container } = showCard(task({ listId: 'L1' }), { lists: LISTS });
    const bar = container.querySelector('.ink-list-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    // 只断言「非空」挡不住写死一个颜色（实测：两处 style 全改成字面量
    // '#000000' 完全不看清单色，这条照样绿）——比对具体的 rgb 值，
    // jsdom 会把 hex 归一成 rgb(...)。LISTS[0].color = '#C2410C'。
    expect(bar.style.backgroundColor).toBe('rgb(194, 65, 12)');
    expect(container.querySelector('.ink-list-name')!.textContent).toBe('工作');

    // 圆点是独立的记号（规格「清单名前一个 6px 实心圆点」），只查
    // .ink-list-name 的文本内容挡不住把整个 <span className="ink-list-dot">
    // 删掉——实测删完那半句测试照样绿，因为文本内容不含圆点。
    const dot = container.querySelector('.ink-list-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.backgroundColor).toBe('rgb(194, 65, 12)');

    // 结构性守卫：竖条必须在 <Space direction="vertical"> 外面，不能被挪进去。
    // TaskCard.tsx 渲染处的注释说清楚了理由——竖条是绝对定位、相对
    // .ink-task-card 贴左边缘的记号，不占任何一行的位置；<Space> 的
    // direction="vertical" 会给每个直接子节点包一层 .ant-space-item 并且
    // 塞进纵向 gap，挪进去会让每张挂了清单的卡多出 6px 的 gap（而竖条本身
    // 视觉上完全不需要占位置）。这条教训跟旗（本文件 249-250 行）是同一个
    // 形状（Task 1 那次是「旗独占一行」的 Critical），但当时没有回头给竖条
    // 补同款断言——没有这条，把这一行搬进 <Space> 里 TaskCard.test.tsx
    // 29 条测试一条不红，纯粹因为没人盯着这个位置决策。
    expect(container.querySelector('.ink-list-bar')!.closest('.ant-space-item')).toBeNull();
  });

  it('listId 指向已经被删掉的清单：不画竖条，也不显示裸 id', () => {
    const { container } = showCard(task({ listId: '早没了' }), { lists: LISTS });
    expect(container.querySelector('.ink-list-bar')).toBeNull();
    expect(container.textContent).not.toContain('早没了');
  });

  /**
   * 编辑往返对 listId 的两处接线（startEdit 读、save 写）各配一条测试，跟上面
   * 「标签」那组同一条教训：夹具不能用默认值 null——listId 默认就是 null，
   * `startEdit` 写死成 `listId: null`、`save` 写死成 `listId: t.listId`（丢掉
   * 表单里的改动）两种坏实现，在「不碰清单」的场景下都测不出来。这里第一条
   * 用非 null 的 L1 验证「读」，第二条从 L1 真的改成 L2 验证「写」，两条各自
   * 才逼得出「读丢了」和「写丢了」这两种坏实现。
   */
  it('编辑往返之一：进编辑态时已有的 listId 原样带进表单——不是被 startEdit 换成 null', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ listId: 'L1' })} now={NOW} lists={LISTS}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');

    expect((screen.getByLabelText('归到哪个清单') as HTMLSelectElement).value).toBe('L1');
  });

  it('编辑往返之二：编辑态里改选另一个清单再保存，patch 里带走的是改过的那个，不是保存前的旧值', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ listId: 'L1' })} now={NOW} lists={LISTS}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    fireEvent.change(screen.getByLabelText('归到哪个清单'), { target: { value: 'L2' } });
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({ listId: 'L2' })));
  });
});

/**
 * 情境（GTD）。跟重复规则同一类：一个**能填、能筛，但如果卡片上不画就等于
 * 不存在**的字段。`waitingFor` 就干放过一阵子（AI 写得进、筛选栏筛得到、
 * 卡片上一个字不显示），这条测试就是为了不重蹈。
 */
describe('TaskCard：情境', () => {
  const card = (over: Partial<Task>) => (
    <AntApp>
      <TaskCard
        t={task(over)} now={NOW}
        onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
      />
    </AntApp>
  );

  it('分了情境就画一个「@中文名」记号，没分就没有这个记号', () => {
    const { container, rerender } = render(card({ context: null }));
    expect(container.querySelector('.ink-context-mark')).toBeNull();

    rerender(card({ context: 'computer' }));
    // 比具体文本，不是「非空」——把字段名直接印出来（'@computer'）也能让
    // 「非空」过，而那正是这个字段最容易出的错：存的是英文 key。
    expect(container.querySelector('.ink-context-mark')!.textContent).toBe('@电脑前');
  });

  it('编辑往返：进编辑态带得进去、保存时又传得出来', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ context: 'out' })} now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    await pickCardMenu('编辑');
    const sel = screen.getByLabelText('什么条件下能做') as HTMLSelectElement;
    // 「读」这一半：夹具用非 null（startEdit 写死成 context: null 就红）。
    expect(sel.value).toBe('out');

    fireEvent.change(sel, { target: { value: 'easy' } });
    // antd 会在「恰好两个汉字」的按钮里插一个空格，所以走这个文件已有的 byText。
    fireEvent.click(byText('保存')!);
    // 「写」这一半：save 写死成 context: t.context 会丢掉表单里的改动，这里红。
    await waitFor(() => expect(onEditTask).toHaveBeenCalled());
    expect(onEditTask.mock.calls[0][1]).toMatchObject({ context: 'easy' });
  });
});

/**
 * 重复规则不是 AI 产出，卡片上的记号（「↻ 每周一」）走 describeRepeat，
 * 石墨黑、不借群青。跟标签/清单同一条教训：编辑往返的两处接线
 * （startEdit 读、save 写）各配一条测试，夹具不能用 null（repeat 的默认值）——
 * `startEdit` 写死成 `repeat: null`、`save` 写死成 `repeat: t.repeat`（丢掉
 * 表单里的改动）两种坏实现，在「不碰重复」的场景下都测不出来，「读」这条必须
 * 用非 null 的真实规则做夹具。
 */
describe('TaskCard：重复规则', () => {
  it('repeat 非 null 时卡片上有「↻ 」记号，为 null 时没有', () => {
    const { container, rerender } = render(
      <AntApp>
        <TaskCard
          t={task({ repeat: null })} now={NOW}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-repeat-mark')).toBeNull();

    rerender(
      <AntApp>
        <TaskCard
          t={task({ repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null } })} now={NOW}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );
    // 具体文本而不只是「非空」——写死一个跟 describeRepeat 无关的字符串
    // 也能让「非空」那种断言过，见 .ink-list-bar 那条同一条教训（TaskCard.test.tsx
    // 「清单归属」那组，那边比对的是具体 rgb 值不是 truthy）。
    expect(container.querySelector('.ink-repeat-mark')!.textContent).toBe('↻ 每周一');
  });

  it('编辑往返之一：进编辑态时已有的重复规则原样带进表单——不是被 startEdit 换成 null', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ repeat: { every: 'week', interval: 2, weekdays: [1, 3], until: null, from: 'due', count: null, step: 0, monthDay: null } })} now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');

    expect((screen.getByLabelText('重复') as HTMLSelectElement).value).toBe('week');
    expect((screen.getByLabelText('每几个') as HTMLInputElement).value).toBe('2');
    expect(screen.getByRole('button', { name: '周一' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '周三' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '周二' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('编辑往返之二：编辑态里把「不重复」改成「每周一」再保存，patch 里带走的是改过的那份，不是保存前的旧值', async () => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard
          t={task({ repeat: null })} now={NOW}
          onPatch={vi.fn()} onEditTask={onEditTask} onDelete={vi.fn()} onEditingChange={() => {}} lists={[]}
        />
      </AntApp>,
    );

    await pickCardMenu('编辑');
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'week' } });
    fireEvent.click(screen.getByRole('button', { name: '周一' }));
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })));
  });
});

/**
 * 拖拽手柄：`rank` 给了就显示那个数字（「今天」视图，同时是排序抓手）；
 * 只给 `drag`、不给 `rank`（看板/四象限，TaskGrid.tsx 的 onDropTo）时换成
 * 一个不带编号的抓手字形，**不能**退化成显示数字或者干脆不显示——`.ink-rank`
 * 在这个界面已经有「能拖着排序」的确定含义，看板/四象限格子内的顺序不是
 * 任何人排出来的（是 readTasks() 的文件顺序），标上数字会让人以为能拖着
 * 重新排序，而同格拖放其实是 TaskGrid.tsx 有意做成的空操作。
 */
describe('TaskCard：拖拽手柄——有 rank 显示数字，只有 drag 显示抓手字形', () => {
  // `DragHandleProps` 的最小夹具——见 TaskRow.test.tsx 顶部同名注释，两个
  // 组件共用同一个类型（TaskCard.tsx 导出）。
  const drag: DragHandleProps = {
    title: '拖动', disabled: false,
    attributes: {
      role: 'button', tabIndex: 0, 'aria-disabled': false,
      'aria-pressed': undefined, 'aria-roledescription': 'draggable', 'aria-describedby': 'dnd-desc',
    },
    listeners: { onPointerDown: vi.fn() },
    setActivatorNodeRef: vi.fn(),
  };

  it('传了 rank：手柄里是那个数字', () => {
    const { container } = render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]} rank={3} drag={drag}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-rank')!.textContent).toBe('3');
  });

  it('只传 drag、不传 rank：手柄是抓手字形，不是数字，也不是空的', () => {
    const { container } = render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]} drag={drag}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    const handle = container.querySelector('.ink-rank');
    expect(handle).not.toBeNull();
    // 精确等于抓手字形，不是「不是数字」这种否定断言——纯否定断言连「渲染成
    // 空字符串」都拦不住（rank 是 undefined、又没有 ?? 兜底的话，React 渲染
    // undefined 是空字符串，同样匹配不上 /^\d+$/，那种写法会把这条变异漏过去）。
    expect(handle!.textContent).toBe('⠿');
    // 可达性属性不受影响——没有 rank 照样是拖拽抓手，role/tabIndex 照样在。
    expect(handle!.getAttribute('role')).toBe('button');
    expect(handle!.getAttribute('tabindex')).toBe('0');
  });

  /**
   * 复审修复轮 2 · I3 记账：`title` 属性在手柄有子内容（`⠿`/排名数字）时
   * 不会被 accname 规范采纳成可访问名字，实际生效的是 `aria-label={drag.title}`
   * ——但一直没有测试直接断言过这件事，复审删掉 `TaskCard.tsx` 里那行
   * `aria-label`，393 条相关测试原样全绿才发现的。变异验证锚点：删掉那行
   * `aria-label`——这条会红（可访问名字退回 `⠿`，`getAllByRole` 找不到）。
   */
  it('抓手的可访问名字是 aria-label 里那句话，不是 ⠿ 字形本身——I3', () => {
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]} drag={drag}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(screen.getAllByRole('button', { name: '拖动' })).toHaveLength(1);
  });

  it('rank 和 drag 都没给：手柄整个不出现——不是每张卡都该多一个抓手', () => {
    const { container } = render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-rank')).toBeNull();
  });
});

/**
 * 选中态：卡片自己不持有 SelState（那份 state 在 App 一层，见
 * 2026-08-17-selection.md 架构一节），只按 `select` prop 渲染 + 转发点击。
 * 「点了之后该变成什么状态」是 TaskGrid（配合 selection.ts 的纯函数）的事，
 * TaskGrid.test.tsx 测那一半（渲染顺序、跨分组连选）；这里测卡片自己这一半：
 * 判据（点在按钮上不选）、preventDefault、勾选框的出现条件、转发的 mods
 * 对不对。
 */
describe('TaskCard：选中态', () => {
  const card = () => document.querySelector('.ink-swipe') as HTMLElement;

  const withSelect = (select: { selected: boolean; showCheckbox: boolean; onClick: (m: { shift: boolean; ctrlOrMeta: boolean }) => void }) =>
    render(
      <AntApp>
        <TaskCard
          t={task({ status: 'todo' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          select={select}
        />
      </AntApp>,
    );

  /**
   * `X` 键。**这是整层键盘操作的入口**：勾选框只在「已经选中了至少一张」之后
   * 才出现，而在这之前进入选中态的唯一办法是 Ctrl/Shift 点卡片——一个鼠标
   * 动作，于是 E/D/T/M/W 那一整套作用在选中集合上的键，键盘用户一个都够不着。
   */
  it('焦点在卡里按 X 就选中这一张——不用先用鼠标点出选中态', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.keyDown(card(), { key: 'x' });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('Shift + X 是连选，跟 Shift 点同一个语义', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.keyDown(card(), { key: 'X', shiftKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: true, ctrlOrMeta: true });
  });

  it('**在输入框里打 x 不算**——那是在打字。按钮上按 x 反而要算：焦点落在按钮上正是键盘走到这张卡的常态', () => {
    const onClick = vi.fn();
    const { container } = withSelect({ selected: false, showCheckbox: false, onClick });
    const input = document.createElement('input');
    container.querySelector('.ink-swipe')!.appendChild(input);
    fireEvent.keyDown(input, { key: 'x' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Ctrl + X 不认——那是剪切', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.keyDown(card(), { key: 'x', ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('没有 select prop：点卡片（哪怕带修饰键）什么都不发生，也没有勾选框/选中标记——今天的行为不变', () => {
    const { container } = setup({ status: 'todo' });
    fireEvent.click(card(), { ctrlKey: true });
    expect(container.querySelector('.ink-sel-check')).toBeNull();
    expect(container.querySelector('.ink-task-card-selected')).toBeNull();
  });

  it('平常点卡片（不带修饰键）：什么都不发生——今天的行为不变', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(card());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('showCheckbox: false 时没有勾选框；true 时才有', () => {
    const { container, rerender } = withSelect({ selected: false, showCheckbox: false, onClick: vi.fn() });
    expect(container.querySelector('.ink-sel-check')).toBeNull();

    rerender(
      <AntApp>
        <TaskCard
          t={task({ status: 'todo' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          select={{ selected: false, showCheckbox: true, onClick: vi.fn() }}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-sel-check')).not.toBeNull();
  });

  it('selected: true 时卡片带选中标记的 class，false 时没有', () => {
    const { container, rerender } = withSelect({ selected: false, showCheckbox: true, onClick: vi.fn() });
    expect(container.querySelector('.ink-task-card-selected')).toBeNull();

    rerender(
      <AntApp>
        <TaskCard
          t={task({ status: 'todo' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          select={{ selected: true, showCheckbox: true, onClick: vi.fn() }}
        />
      </AntApp>,
    );
    expect(container.querySelector('.ink-task-card-selected')).not.toBeNull();
  });

  it('Ctrl 点卡片：触发 onClick，mods 精确是 { shift: false, ctrlOrMeta: true }', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(card(), { ctrlKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('Cmd（metaKey）点也算——ctrlOrMeta 不是只认 Ctrl', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(card(), { metaKey: true });
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('Shift 点：触发 onClick 且 mods 是 { shift: true, ctrlOrMeta: false }，同时 preventDefault 拦掉浏览器的文本选区扩展', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    // fireEvent 返回 dispatchEvent 的结果：事件被 preventDefault 时是 false，
    // 跟 TaskGrid.test.tsx onDragOver 那条同一个断言手法。
    const notCanceled = fireEvent.click(card(), { shiftKey: true });
    expect(notCanceled).toBe(false);
    expect(onClick).toHaveBeenCalledWith({ shift: true, ctrlOrMeta: false });
  });

  it('平常点（不带修饰键）不 preventDefault——只有 Shift 点才拦，别处不该多拦', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    const notCanceled = fireEvent.click(card());
    expect(notCanceled).toBe(true);
  });

  it('点卡片上的按钮（比如「开始」）不会触发选中——上限', () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });
    fireEvent.click(byText('开始')!, { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('点勾选框本身：平常点（不需要按 Ctrl）就触发 onClick，mods 固定是 { shift: false, ctrlOrMeta: true }', () => {
    const onClick = vi.fn();
    const { container } = withSelect({ selected: false, showCheckbox: true, onClick });
    const checkbox = container.querySelector('.ink-sel-check input') as HTMLElement;
    expect(checkbox).not.toBeNull();
    fireEvent.click(checkbox);
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  // I5（final-review.md）：编辑态整张卡是个表单，onClick 顶部 `if (draft)
  // return` 挡住选中——跟 onPointerDown 顶部同一条判断（防的是划一下滑动手势
  // 也会把卡带进选中）。这条以前没有测试守：编辑态开着的时候 Ctrl 点卡片
  // 空白处会把它选中，接着按 Del 就是对一张正在编辑的卡弹批量删除确认。
  it('编辑态挡选中：进入编辑之后 Ctrl 点卡片什么都不发生——整张卡此刻是个表单', async () => {
    const onClick = vi.fn();
    withSelect({ selected: false, showCheckbox: false, onClick });

    await pickCardMenu('编辑');
    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();   // 先证明真的进了编辑态

    fireEvent.click(card(), { ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });
});

/**
 * 行档「展开收不回去」的修复（整分支审查 A 组）：`TaskGrid.tsx`/
 * `TodayView.tsx` 点标题展开成的这张查看态卡，以前没有对称的收起入口——
 * 唯一的路是「⋯ → 编辑 → 取消」（`cancelEdit()`），`TaskCard.test.tsx`/
 * `App.test.tsx` 里好几条测试就是这么绕过去的，没人把它读成缺陷。
 *
 * 这里补的是「再点一次标题」这条对称路径，直接调用 `onEditingChange(id,
 * false)`——见 TaskCard.tsx 标题那个 onClick 上面的长注释：这个函数在
 * 全站其余 TaskCard（按来源、卡档、日历……）里，只要它们没有真被行档展开过，
 * 拿到的都是一个本来就不在 editingIds 里的 id，delete 一个不存在的 key 是
 * 幂等空操作——这条测试只验证 TaskCard 自己这一半（调用了什么、修饰键怎么
 * 分流），「点两次真的能在 TaskGrid/TodayView 里把行变回来」是下面
 * TaskGrid.test.tsx/TodayView.test.tsx 那两条集成测试的事。
 */
describe('TaskCard：点标题收起（行档展开成卡之后的对称收起手势）', () => {
  it('平常点标题（没有修饰键）：调用 onEditingChange(id, false)', () => {
    const onEditingChange = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={onEditingChange}
        />
      </AntApp>,
    );
    // 变异验证锚点：标题的 onClick 被删掉，或者改成不带条件地转发别的 id——
    // 这条会红。
    fireEvent.click(screen.getByText('写周报'));
    expect(onEditingChange).toHaveBeenCalledWith('t1', false);
  });

  it('按住 Ctrl/Shift 点标题：不触发收起，原样放行给上面 Card 级的选中逻辑——不会「选中的同时又把卡收起」', () => {
    const onEditingChange = vi.fn();
    const onClick = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task({ status: 'todo' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={onEditingChange}
          select={{ selected: false, showCheckbox: false, onClick }}
        />
      </AntApp>,
    );
    fireEvent.click(screen.getByText('写周报'), { ctrlKey: true });
    // 变异验证锚点：标题的 onClick 把修饰键判断删掉——这条会红（Ctrl 点
    // 一下会把收起也一起触发了）。
    expect(onEditingChange).not.toHaveBeenCalled();
    // 中间断言：这次点击确实到达了 Card 级的选中逻辑（点击本身冒泡上去了，
    // 不是被别的东西吞掉）——证明「不触发收起」不是巧合，是真的分流成了选中。
    expect(onClick).toHaveBeenCalledWith({ shift: false, ctrlOrMeta: true });
  });

  it('编辑态（点了「编辑」）：标题换成了输入框，DOM 里找不到可点的标题文字——点两下不会误收起正在编辑的草稿', async () => {
    const onEditingChange = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={onEditingChange}
        />
      </AntApp>,
    );
    await pickCardMenu('编辑');
    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();
    onEditingChange.mockClear();
    // 标题文字不再以 Typography.Text 的形式出现（换成了输入框），点它触发
    // 收起的那个 onClick 已经不在 DOM 里——没有元素可点，onEditingChange
    // 自然不会再被这个入口调用。
    expect(screen.queryByText('写周报')).toBeNull();
    expect(onEditingChange).not.toHaveBeenCalled();
  });
});

// 既有缺陷（在 2026-08-17-selection 这批之前就有，Task 3 发现、留给 Task 4
// 修，见 task-4-brief）：子任务勾选框没有套 boardLocalTheme——只有
// TaskBoard/TodayView 整棵子树套了那层，别的视图（全部/已完成/看板/四象限/
// 搜索/接下来/清单/标签……）勾一下子任务会得到一个群青的勾。群青是配额制，
// 只标 AI 产出的内容，「勾掉一个子任务」是人的动作。见 TaskCard.tsx 里
// .ink-subtask 上面那段注释——修法是给它也套上跟选中勾选框同一层局部
// ConfigProvider。
//
// CSS 守卫（theme.css.test.ts 那套前缀扫描）抓不到这个：颜色不是
// theme.css 里的规则，是 antd 的 token（Checkbox 选中态直接读
// token.colorPrimary，没有组件级 token 能覆盖，见 theme.ts 顶部注释），
// 前缀扫描扫的是 CSS 文件文本，够不到运行时才生成的 CSS-in-JS。
//
// 这里改成「渲染出来查 antd 实际算出的 CSS 变量」：antd 6 走 css-var 模式，
// 每个 Checkbox 渲染时会把 colorPrimary 写成一条形如
// `.css-var-xxx{--ant-color-primary:#2e3ed4}` 的规则，挂在这个 Checkbox
// 自己的根节点（`<label>`）上——jsdom 的 getComputedStyle 不会展开 var()
// 函数调用（读 backgroundColor 在两种主题下都只会原样吐出字符串
// "var(--ant-color-primary)"，测不出差异），但它认得出「这个自定义属性
// 本身在这个节点上被声明成了什么值」，读 getPropertyValue 就够，不用
// 另外解析 CSS 选择器匹配。
//
// 外层套 appTheme（main.tsx 真正在用的那份全局主题，colorPrimary 是群青
// ink.ai）模拟「这张卡被渲染在没有套 boardLocalTheme 的视图里」的真实
// 场景——文件顶部 setup()/withSelect() 用的 <AntApp> 都没有套主题，
// colorPrimary 落的是 antd 默认蓝，两种蓝分不出「压没压对」，必须显式
// 套 appTheme 才能让这个夹具真的复现那个 bug 原来会发生的环境。
describe('TaskCard：子任务勾选框不能是群青（既有缺陷，这批顺手修）', () => {
  it('对照：这份夹具本身确实会让 Checkbox 读到群青——不是随手挑的主题恰好不是群青', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          {/* 没有局部 ConfigProvider 包裹——直接摆一个裸 Checkbox，
              证明外层 appTheme 本身就是群青，下一条测试读到「不是群青」
              是因为 TaskCard 内部压回来了，不是这份夹具凑巧不是群青。 */}
          <Checkbox className="ink-control-probe" checked>裸勾选框</Checkbox>
        </AntApp>
      </ConfigProvider>,
    );
    const wrapper = container.querySelector('.ink-control-probe') as HTMLElement;
    const primary = getComputedStyle(wrapper).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.ai.toLowerCase());
  });

  it('子任务勾选框读到的 --ant-color-primary 是你的墨（ink.you），不是群青（ink.ai）', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          <TaskCard
            t={task({ subtasks: [{ text: '子任务一', done: true }] })}
            now={NOW} lists={[]}
            onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          />
        </AntApp>
      </ConfigProvider>,
    );
    const wrapper = container.querySelector('.ink-subtask') as HTMLElement;
    expect(wrapper).not.toBeNull();
    const primary = getComputedStyle(wrapper).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.you.toLowerCase());
    expect(primary).not.toBe(ink.ai.toLowerCase());
  });
});

// final-review.md I3：同一个 antd token 盲区（Checkbox/DatePicker 选中态直接
// 读全局 token.colorPrimary，没有组件级 token 能覆盖，见 theme.ts 顶部
// boardLocalTheme 的注释）在编辑态的 DatePicker 上还剩一处没修——上面那组
// 测试守的是子任务勾选框，这里补编辑态的两个 DatePicker（截止/提醒）。
// 手法跟上面完全一样：外层套 appTheme（main.tsx 真正在用的那份全局主题）
// 模拟「这张卡被渲染在没有套 boardLocalTheme 的视图里」的真实场景，读
// antd 6 挂在 `.ant-picker` 根节点上的 --ant-color-primary 自定义属性。
describe('TaskCard：编辑态的 DatePicker 不能是群青（I3，final-review.md）', () => {
  it('编辑态两个 DatePicker（截止/提醒）读到的 --ant-color-primary 都是你的墨，不是群青', async () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          <TaskCard
            t={task()} now={NOW} lists={[]}
            onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          />
        </AntApp>
      </ConfigProvider>,
    );
    await pickCardMenu('编辑');
    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();

    const pickers = container.querySelectorAll('.ant-picker');
    expect(pickers).toHaveLength(3);   // 截止 + 提醒，先证明这份夹具真的渲染出了两个
    pickers.forEach((p) => {
      const primary = getComputedStyle(p as HTMLElement).getPropertyValue('--ant-color-primary').trim().toLowerCase();
      expect(primary).toBe(ink.you.toLowerCase());
      expect(primary).not.toBe(ink.ai.toLowerCase());
    });
  });
});

// 'E' 键的落点，见 CardProps.autoEdit 的注释。App/TaskGrid 怎么算出「该给
// 哪张卡传 true」是 App.test.tsx 的事（那边有真实的选中态），这里只守
// TaskCard 自己收到这个 prop 之后的反应。
describe('TaskCard：autoEdit——外部触发的编辑请求', () => {
  it('autoEdit: true 时自己进入编辑态，且回调 onAutoEdited', () => {
    const onAutoEdited = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          autoEdit onAutoEdited={onAutoEdited}
        />
      </AntApp>,
    );
    expect(screen.getByPlaceholderText('标题')).toBeTruthy();
    expect(onAutoEdited).toHaveBeenCalledTimes(1);
  });

  it('autoEdit: false（或不给）不会自己进入编辑态——今天的行为不变', () => {
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(screen.queryByPlaceholderText('标题')).toBeNull();
  });

  it('从 false 变 true 才触发；已经是 true 不重新触发（重渲染不会把编辑到一半的草稿打回原样）', () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <AntApp>
        <TaskCard
          t={task({ title: '原标题' })} now={NOW} lists={[]}
          onPatch={onPatch} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          autoEdit onAutoEdited={() => {}}
        />
      </AntApp>,
    );
    const titleInput = screen.getByPlaceholderText('标题') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '改了一半' } });

    // autoEdit 还是 true（没有变成 false 再变回 true），同一个 task 对象
    // 重渲染一次——如果 effect 的依赖数组错误地把 startEdit 本身也算进去，
    // 这里会重新调用 startEdit()，把刚打的字冲掉、退回「原标题」。
    rerender(
      <AntApp>
        <TaskCard
          t={task({ title: '原标题' })} now={NOW} lists={[]}
          onPatch={onPatch} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          autoEdit onAutoEdited={() => {}}
        />
      </AntApp>,
    );
    expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('改了一半');
  });
});

/**
 * Task 1（2026-08-17-card-features）：备注按 markdown 渲染。Markdown 组件
 * 本身对不等于卡片真的接上了它——这两条测的是接线那一层，见 task-1-brief
 * 「接线那一层也要测」。
 */
describe('TaskCard：备注按 markdown 渲染（接线）', () => {
  it('查看态：notes 里的 markdown 标题渲染成 <h1>，不是原样的 "# 大标题" 字符串', () => {
    setup({ notes: '# 大标题' });

    expect(screen.getByRole('heading', { name: '大标题' })).toBeTruthy();
    expect(screen.queryByText('# 大标题')).toBeNull();
  });

  it('编辑态：notes 的编辑框仍是纯文本 textarea，装的是原始 markdown 源码——所见即所改', async () => {
    setup({ notes: '# 大标题' });

    await pickCardMenu('编辑');

    const textarea = screen.getByPlaceholderText(/^备注/) as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.value).toBe('# 大标题');
    // 编辑态不该把它渲染成标题元素——那样就不是「所见即所改」了。
    expect(screen.queryByRole('heading', { name: '大标题' })).toBeNull();
  });
});

/**
 * Task 4（2026-08-17-card-features）：番茄钟接线。FocusTimer 自己那一层的
 * 机制（倒计时、锁）由 FocusTimer.test.tsx 守，这里只测 TaskCard 接上它之后
 * 那一步——onComplete 拿到的一条记录怎么变成发给 onPatch 的 patch。
 *
 * 这两条都用完整的 vi.useFakeTimers()（不是 App.test.tsx 那批限定
 * toFake: ['Date'] 的写法）——task-4-brief 点名的坑是「整套假时钟会饿死 hash
 * 路由和 waitFor 的轮询」，这个文件不涉及 hash 路由，且下面两条都不用
 * waitFor（直接同步断言），不会撞上那个坑。afterEach 统一还原，不留给下一条
 * 用例。
 */
describe('TaskCard：番茄钟（接线）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 最危险的一处：写成覆盖的话，一次专注把整个历史清空，而且没有任何提示，
   * 用户要等到看回顾数据时才发现。这里必须证明「原本两条，专注一次之后是
   * 三条，且前两条一字不差」，不能只断言「长度变了」或者「新的那条在里面」——
   * 那两种弱断言都拦不住 `focusSessions: [session]`（覆盖）这种坏实现。
   */
  it('倒计时结束：往 focusSessions 追加一条，不是覆盖——已有的两条原样带上', () => {
    vi.useFakeTimers();
    const existing = [
      { startedAt: '2026-08-01T00:00:00.000Z', minutes: 25 },
      { startedAt: '2026-08-05T00:00:00.000Z', minutes: 25 },
    ];
    const onPatch = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task({ focusSessions: existing })} now={NOW} lists={[]}
          onPatch={onPatch} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          focusMinutes={1}
        />
      </AntApp>,
    );

    fireEvent.click(byText('开始专注')!);
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(onPatch).toHaveBeenCalledTimes(1);
    const [id, patch] = onPatch.mock.calls[0] as [string, { focusSessions: Array<{ startedAt: string; minutes: number }> }];
    expect(id).toBe('t1');
    // 长度必须是 3（2 条原有 + 1 条新的），不是 1（覆盖）也不是 2（新的那条
    // 没进去）——三种坏实现各对应一种错误长度，这条断言把它们都拦住。
    expect(patch.focusSessions).toHaveLength(3);
    expect(patch.focusSessions[0]).toEqual(existing[0]);
    expect(patch.focusSessions[1]).toEqual(existing[1]);
    expect(patch.focusSessions[2]).toMatchObject({ minutes: 1 });
  });

  it('中途「取消」：不发任何请求——onPatch 完全不会被调用（规格「中途放弃不记」的上限断言）', () => {
    vi.useFakeTimers();
    const onPatch = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={onPatch} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
          focusMinutes={5}
        />
      </AntApp>,
    );

    fireEvent.click(byText('开始专注')!);
    fireEvent.click(byText('取消专注')!);
    // 取消之后就算时间继续往前走（比如浏览器标签页留在后台没关），也不该
    // 迟到地补发一次——取消是彻底放弃，不是暂停。
    act(() => { vi.advanceTimersByTime(5 * 60_000); });

    expect(onPatch).not.toHaveBeenCalled();
  });

  it('不传 focusMinutes 时落回默认的 25 分钟——设置页从没打开过也有番茄钟能用', () => {
    vi.useFakeTimers();
    render(
      <AntApp>
        <TaskCard
          t={task()} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );

    fireEvent.click(byText('开始专注')!);

    expect(screen.getByText('25:00')).toBeTruthy();
  });

  /**
   * final-review.md C1：同一张卡会同时挂在「今天」「按来源」两个 keepMounted
   * 视图里（切走只是 hidden，不卸载），也就是同一个 t.id 会同时渲染出两个
   * TaskCard、两个 FocusTimer 实例。不用搭出整棵 App 树来复现——直接渲染
   * 两份同样的 `t` 就是这个处境。旧实现（FocusTimer 的锁按 taskId 建）在这里
   * 两个「开始专注」都可点：点开两个各自倒计时，走完各发一条内容相同的
   * PATCH，第二条覆盖第一条，静默丢掉一条 focusSession（见 C1「PROBE 1」）。
   * 锁改成按组件实例建之后，第二个必须被挡住。
   */
  it('同一个 t.id 同时渲染两张卡（模拟两个 keepMounted 视图）：第一张开始专注之后，第二张也被挡住', () => {
    vi.useFakeTimers();
    const t = task({ id: 'same-task' });
    render(
      <AntApp>
        <TaskCard t={t} now={NOW} lists={[]} onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} focusMinutes={1} />
        <TaskCard t={t} now={NOW} lists={[]} onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}} focusMinutes={1} />
      </AntApp>,
    );

    const buttons = screen.getAllByRole('button').filter((b) => b.textContent === '开始专注') as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons[1].disabled).toBe(false);

    fireEvent.click(buttons[0]);

    expect(buttons[1].disabled).toBe(true);
  });
});

/**
 * 附件（task-4-brief）：Task 3 已经把 Attachments 组件本身连同拖放/列表/删除
 * 逻辑做完并测过，这里只测「接线」这一层——taskId 是不是真的传对了、
 * attachments 是不是空时不显示、编辑态是不是照样显示、没有把拖放区扩大到
 * 整张卡这个决定是不是真的成立。组件内部的行为（诱饵拖拽、上传中禁用、
 * 删除要确认……）不重复测，见 Attachments.test.tsx。
 */
describe('TaskCard：附件接进卡片', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('查看态下 attachments 为空——整段不渲染（上限断言，不是只查列表）', () => {
    const { container } = setup({ attachments: [] });
    // 不只查 .ink-attach-list（那个本来就该没有）——还要查 .ink-attach-box
    // 本身：如果实现变成「查看态也永远渲染拖放区，只是列表为空」，前一条
    // 断言测不出来，因为拖放框和列表是两个不同的元素。
    expect(container.querySelector('.ink-attach-box')).toBeNull();
    expect(screen.queryByText('拖文件到这里，或点击选择')).toBeNull();
  });

  // task-3-brief：offline 是转发给 Attachments 的最后一棒（App.tsx →
  // gridWiring/TodayView/TaskBoard → TaskGrid → TaskCard → Attachments），
  // 这里只钉住 TaskCard 这一棒确实转发到了，具体离线时「打开」变成什么样
  // 是 Attachments.test.tsx 自己的职责，不在这里重复断言细节。
  it('offline 转发给 Attachments——离线时「打开」变成提示文字，不是死链接', () => {
    setup({ attachments: ['报告.pdf'] }, { offline: true });
    expect(screen.queryByRole('link', { name: '打开' })).toBeNull();
    expect(screen.getByText('要连上服务才能看')).toBeTruthy();
  });

  // 上限断言：不传 offline（跟这个 describe 块其余用例一样）时默认在线，
  // 「打开」照常是可点的链接——不传新 prop 不该悄悄把所有既有卡片变成
  // 「离线」的样子。
  it('上限断言：不传 offline 时默认在线，「打开」照常是可点的链接', () => {
    setup({ attachments: ['报告.pdf'] });
    expect(screen.getByRole('link', { name: '打开' })).toBeTruthy();
    expect(screen.queryByText('要连上服务才能看')).toBeNull();
  });

  it('查看态下 attachments 非空——渲染附件区，taskId 是真的传给了 Attachments（不是随便一个值）', async () => {
    // id 特意不用别处测试常用的默认值 't1'——防的是「taskId 写死成某个看起来
    // 眼熟的字符串」这种变异跟夹具撞车之后测不出来（总账第五节「夹具恰好
    // 等于写死的值」那一条）。
    const { container } = setup({ id: 'atk-77', attachments: ['报告.pdf'] });
    const box = container.querySelector('.ink-attach-box');
    expect(box).not.toBeNull();
    expect(screen.getByText('报告.pdf')).toBeTruthy();

    const file = new File(['x'], 'new.txt');
    fireEvent.drop(box!, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledWith('atk-77', file));
  });

  it('上传成功之后列表真的刷新了——父组件传入新的 t.attachments，新文件出现', () => {
    // 模拟真实流程：写进文件 → watcher → SSE → App.reload() → 带着新
    // attachments 的 t 重新传下来，TaskCard 不缓存旧值。不用真的走一遍
    // uploadAttachment + reload，直接 rerender 一个 attachments 更长的 t，
    // 断言新文件名出现——这条测的是 TaskCard 有没有老老实实把 t.attachments
    // 原样转发，而不是挡住「Attachments 拿到的是一份 mount 时就定住的拷贝」
    // 这种坏实现。
    const { container, rerender } = render(
      <AntApp>
        <TaskCard
          t={task({ id: 'atk-refresh', attachments: ['a.txt'] })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.queryByText('b.txt')).toBeNull();

    rerender(
      <AntApp>
        <TaskCard
          t={task({ id: 'atk-refresh', attachments: ['a.txt', 'b.txt'] })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(container.querySelectorAll('.ink-attach-item')).toHaveLength(2);
  });

  it('编辑态：attachments 为空也照样显示——编辑到一半想拖个文件进来是自然的动作，也是给零附件任务加第一个附件的入口', async () => {
    setup({ attachments: [] });
    expect(document.querySelector('.ink-attach-box')).toBeNull(); // 进编辑态之前：查看态照旧不显示

    await pickCardMenu('编辑');

    expect(document.querySelector('.ink-attach-box')).not.toBeNull();
    expect(screen.getByText('拖文件到这里，或点击选择')).toBeTruthy();
  });

  /**
   * 拖放区扩大到了整张卡（final-review.md「专项判定」，方向从「没有扩大」
   * 反过来）——之前的实现只有 `.ink-attach-box` 是放置目标，而查看态
   * attachments 为空时那个 div 整段不渲染，`data/` 里现有任务没有一条带
   * 附件，等于每一张卡在默认状态下都没有任何拖放目标；补偿路径（先点
   * 「编辑」）卡片菜单也找不到——发现不了，比什么都不做更糟。现在
   * `useFileDrop` 的 `dropProps` 摊在 `Card` 节点上，文件落在卡片任意区域
   * 都会被接住。用 fireEvent 直接对着 `.ink-task-card` 派发 drop——原生事件
   * 会冒泡到祖先节点，这正好模拟「拖放点在附件框以外的卡片区域」，不用真的
   * 算坐标。
   */
  it('拖放区扩大到了整张卡：文件落在卡片其余区域（不在 .ink-attach-box 上）也会触发上传', async () => {
    uploadAttachmentMock.mockResolvedValue({});
    const { container } = setup({ id: 'atk-whole-card', attachments: ['报告.pdf'] });
    const card = container.querySelector('.ink-task-card');
    expect(card).not.toBeNull();

    const file = new File(['x'], 'stray.txt');
    fireEvent.drop(card!, { dataTransfer: { types: ['Files'], files: [file] } });

    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledWith('atk-whole-card', file));
  });

  it('拖放区扩大到了整张卡：查看态下 attachments 为空也能直接拖文件上传，不用先点「编辑」', async () => {
    uploadAttachmentMock.mockResolvedValue({});
    const { container } = setup({ id: 'atk-empty-card', attachments: [] });
    const card = container.querySelector('.ink-task-card');
    expect(container.querySelector('.ink-attach-box')).toBeNull(); // 上限：这个状态下附件框确实没渲染

    const file = new File(['x'], 'first.txt');
    fireEvent.drop(card!, { dataTransfer: { types: ['Files'], files: [file] } });

    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledWith('atk-empty-card', file));
  });

  // 上限断言：卡片拖拽（TaskGrid/TodayView/CalendarGrid 统一用
  // setData('text/plain', taskId)）经过整张卡不会被误当成文件——诱饵手法
  // 跟 Attachments.test.tsx 那条同款：dataTransfer 标着 'text/plain'，但塞了
  // 一个真的 File（真实卡片拖拽不会有），如果 isFileDrag 那道判断被删掉，
  // 会读到这个诱饵、照样发起上传，而且事件会被 preventDefault/取消——这条
  // 断言两头都查，不止查有没有调用上传。
  it('拖放区扩大到了整张卡：卡片拖拽（text/plain，诱饵 File）经过不会被当成文件，事件不会被取消', () => {
    const { container } = setup({ attachments: ['报告.pdf'] });
    const card = container.querySelector('.ink-task-card');
    const bait = new File(['x'], 'bait.txt');

    const notCanceled = fireEvent.drop(card!, { dataTransfer: { types: ['text/plain'], files: [bait] } });

    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(notCanceled).toBe(true);
  });

  // m3（final-review.md）：`e.stopPropagation()` 之前零覆盖。卡片拖拽/看板
  // 格子拖拽今天各自靠自己的守卫（`dragging`/`dragId` state、空 getData）
  // 挡住误触，不依赖这一道——所以「onDropTo/onDropOnDay 没被误触发」测不出
  // 这一行有没有被删掉（验证过：TaskGrid.test.tsx 那条即使去掉 stopPropagation
  // 也照样绿）。直接 spy 原生 `Event.prototype.stopPropagation`，钉住真的
  // 文件拖拽落在卡片上时这一行真的被调用了。
  it('m3：文件拖到卡片上会 stopPropagation，不冒泡给别的拖拽系统', () => {
    const { container } = setup({ attachments: ['报告.pdf'] });
    const card = container.querySelector('.ink-task-card');
    const stopSpy = vi.spyOn(Event.prototype, 'stopPropagation');

    fireEvent.drop(card!, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.txt')] } });

    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockRestore();
  });
});

/**
 * 已专注 / 预计（仿滴答清单的「预计番茄/预计时长」，这里只做后一种）。番茄钟一直往
 * `focusSessions` 里记，而**卡片上一个字都没说过**——「专注统计」那一页补的是
 * 汇总的那一半，「我在这件事上已经投了多久」是在卡片上问的。
 */
describe('TaskCard：已专注 / 预计', () => {
  const sess = (minutes: number) => ({ startedAt: new Date(2026, 7, 12, 9).toISOString(), minutes });

  it('没专注过也没估过，这一段不出现——不给一张干净的卡加一句「已专注 0 分钟」', () => {
    const { container } = setup();
    expect(container.textContent).not.toContain('已专注');
    expect(container.textContent).not.toContain('预计');
  });

  it('专注过就说累计了多久', () => {
    const { container } = setup({ focusSessions: [sess(25), sess(65)] });
    expect(container.textContent).toContain('已专注 1 小时 30 分');
  });

  it('估过就带上分母', () => {
    const { container } = setup({ focusSessions: [sess(25)], estimateMinutes: 90 });
    expect(container.textContent).toContain('已专注 25 分钟 / 预计 1 小时 30 分');
  });

  it('**只估过、还没开始做的也要显示**——那正是「今天打算干这个」的时候要看的', () => {
    const { container } = setup({ estimateMinutes: 45 });
    expect(container.textContent).toContain('还没专注过 / 预计 45 分钟');
  });

  it('超了用跟「已过期」同一个记号——两者是同一类信息，不为它另发明一种颜色', () => {
    const { container } = setup({ focusSessions: [sess(120)], estimateMinutes: 60 });
    const marks = [...container.querySelectorAll('.ink-overdue-mark')].map((e) => e.textContent);
    expect(marks.some((m) => m?.includes('已专注 2 小时'))).toBe(true);
  });

  it('没超就不标', () => {
    const { container } = setup({ focusSessions: [sess(30)], estimateMinutes: 60 });
    const marks = [...container.querySelectorAll('.ink-overdue-mark')].map((e) => e.textContent);
    expect(marks.some((m) => m?.includes('已专注'))).toBe(false);
  });
});

/**
 * 过期记号上那句「多久」（判据在 `lib/taskView.ts` 的 `overdueLabel`，
 * 那边测的是算什么，这里只测接线）。
 */
describe('TaskCard：过期说清多久', () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const H = 60 * 60 * 1000;

  it('欠三天就写「过期 3 天」，不是光一句「已过期」——欠一小时和欠三个星期长得一模一样的话，这个记号没法拿来决定先干哪个', () => {
    const { container } = setup({ due: ago(3 * 24 * H) });
    expect(container.querySelector('.ink-overdue-mark')?.textContent).toBe('过期 3 天');
  });

  it('刚过一会儿写「刚过期」', () => {
    const { container } = setup({ due: ago(10 * 60 * 1000) });
    expect(container.querySelector('.ink-overdue-mark')?.textContent).toBe('刚过期');
  });

  it('没过期就没有这个记号', () => {
    const { container } = setup({ due: new Date(NOW.getTime() + H).toISOString() });
    expect([...container.querySelectorAll('.ink-overdue-mark')].map((e) => e.textContent))
      .not.toContain('刚过期');
  });
});

/**
 * 保存时的 `habit`。**「每天」以外的重复档上不该留着这个记号**——习惯那个
 * 去处按「habit 且每天重复」认，留着它只是一条永远不会被读到的数据。
 */
describe('TaskCard：习惯这个记号跟着重复档走', () => {
  const DAILY = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };

  it('每天重复的任务，勾着的习惯记号原样保存', async () => {
    const { onPatch } = setup({ repeat: DAILY, habit: true });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('打开编辑态时把当前的 habit 读进草稿——不是每次编辑都把它清掉', async () => {
    setup({ repeat: DAILY, habit: true });
    await pickCardMenu('编辑');
    expect((screen.getByLabelText(/当成习惯/) as HTMLInputElement).checked).toBe(true);
  });

  const saveWith = async (over: Parameters<typeof task>[0]) => {
    const onEditTask = vi.fn().mockResolvedValue(undefined);
    render(
      <AntApp>
        <TaskCard t={task({ id: 't1', habit: true, ...over })}
          now={NOW} lists={[]} onPatch={() => {}} onEditTask={onEditTask}
          onDelete={() => {}} onEditingChange={() => {}} />
      </AntApp>,
    );
    await pickCardMenu('编辑');
    fireEvent.click(btnIn(document.body, '保存')!);
    return onEditTask;
  };

  /**
   * **这条原来是「改成每周之后保存，记号跟着清掉」。** 那是习惯只认「每天」
   * 时候的规矩；放宽到「每天或每周」之后，同一个动作的正确结果**反过来了**。
   *
   * 留着它的旧版本会是这一批里最贵的一种假绿：`TaskCard.tsx` 那句判断当时
   * 确实还没跟上（写着 `every === 'day' ? habit : false`），于是「表单里勾得上、
   * 一按保存就没了」这个真 bug **有一条测试在替它作证**。
   */
  it('**改成每月重复之后保存，习惯记号跟着清掉**——每月打卡不是习惯', async () => {
    const onEditTask = await saveWith({ repeat: { ...DAILY, every: 'month', monthDay: 1 } });
    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({ habit: false })));
  });

  it('**每周重复的习惯，记号原样存下去**——「一周三次」是习惯', async () => {
    const onEditTask = await saveWith({ repeat: { ...DAILY, every: 'week', weekdays: [1, 3, 5] } });
    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('t1', expect.objectContaining({ habit: true })));
  });
});

/**
 * 卡片上画出「在等」。筛选栏一直有「只看等待中的」，而卡片上一个字都不显示：
 * 筛出来一屏任务，看不出各自在等什么，也想不起该去催谁。
 */
describe('TaskCard：在等', () => {
  it('有值就画出来', () => {
    const { container } = setup({ waitingFor: '张老师回邮件' });
    expect(container.textContent).toContain('在等 张老师回邮件');
  });

  it('没在等时这一段不出现', () => {
    const { container } = setup();
    expect(container.querySelector('.ink-waiting-mark')).toBeNull();
  });

  it('**不上群青**——这是人自己填的，或者 AI 从原文里摘出来的事实，不是它的判断', () => {
    const { container } = setup({ waitingFor: '张老师回邮件', source: 'ai' });
    const mark = container.querySelector('.ink-waiting-mark')!;
    expect(mark.className).not.toContain('ink-time-ai');
  });
});

/**
 * 卡片上的提醒。一条任务现在可以有好几个（见 TaskFields 那串选择器），
 * 而这一行是摘要——摊开三四个时刻会把它撑爆，但只显示第一个、一个字不提
 * 还有别的，会让人以为就设了那一个。
 */
describe('TaskCard：多个提醒时说出来还有几个', () => {
  const at = (h: number) => new Date(2026, 7, 12, h).toISOString();

  it('一个提醒时不加那个 +N', () => {
    const { container } = setup({ reminders: [{ at: at(9), firedAt: null }] });
    expect(container.querySelector('.ink-meta-more')).toBeNull();
  });

  it('三个提醒时显示第一个，后面写 +2', () => {
    const { container } = setup({
      reminders: [{ at: at(9), firedAt: null }, { at: at(12), firedAt: null }, { at: at(18), firedAt: null }],
    });
    expect(container.querySelector('.ink-meta-more')?.textContent).toContain('+2');
  });
});

/**
 * 手填检查事项。**在这之前只有 AI 拆得出来**——表单里刻意不含这个字段
 * （那行注释写着「真要手填再说」），于是手工建的任务永远没有检查事项，
 * 而「全勾完就自动完成」「⤴ 转成子任务」「子任务 n/m」三样都建在它上面。
 */
/**
 * 检查事项的文字按**行内 markdown** 渲染。备注早就渲染了，同一段文字换个字段
 * 就变成一串反引号说不通——而 AI 往这里写「跑 `npm run report`」是常事。
 * 只渲染行内格式：块级那层壳（`<p>`）会把勾选框的文字挤到下一行。
 */
describe('TaskCard：检查事项按行内 markdown 渲染', () => {
  it('反引号渲染成行内代码，不是原样显示一串符号', () => {
    setup({ subtasks: [{ text: '跑 `npm run report`', done: false }] });
    const code = document.querySelector('.ink-subtask code');
    expect(code?.textContent).toBe('npm run report');
  });

  it('**不另起段落**——那一行的文字要跟勾选框并排，不能被挤到下一行', () => {
    setup({ subtasks: [{ text: '**要紧**的一步', done: false }] });
    expect(document.querySelector('.ink-subtask p')).toBeNull();
    expect(document.querySelector('.ink-subtask strong')?.textContent).toBe('要紧');
  });

  it('编辑态里仍然是纯文本——所见即所改，跟备注一条规矩', async () => {
    setup({ subtasks: [{ text: '跑 `npm run report`', done: false }] });
    await pickCardMenu('编辑');
    const box = screen.getByLabelText('第 1 项检查事项') as HTMLInputElement;
    expect(box.value).toBe('跑 `npm run report`');
    // 渲染那一份让位给输入框，不是两份并存
    expect(document.querySelector('.ink-subtask code')).toBeNull();
  });

  it('原始 HTML 照样不变成元素——安全边界跟备注是同一条', () => {
    setup({ subtasks: [{ text: '<b>粗</b>', done: false }] });
    expect(document.querySelector('.ink-subtask b')).toBeNull();
  });
});

describe('TaskCard：检查事项加得了、改得了、删得了', () => {
  const SUBS = [{ text: '刷墙', done: false }];

  it('**不在编辑态时只能勾**——一个常驻在每张卡下面的输入框对绝大多数任务纯属噪音', () => {
    setup({ subtasks: SUBS });
    expect(screen.queryByLabelText('加一条检查事项')).toBeNull();
    expect(screen.queryByLabelText('第 1 项检查事项')).toBeNull();
  });

  it('进编辑态之后冒出「加一条」，回车加上去', async () => {
    const { onPatch } = setup({ subtasks: SUBS });
    await pickCardMenu('编辑');
    const box = screen.getByLabelText('加一条检查事项');
    fireEvent.change(box, { target: { value: '装灯' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPatch).toHaveBeenCalledWith('t1', {
      subtasks: [{ text: '刷墙', done: false }, { text: '装灯', done: false }],
    });
  });

  it('空的不加——回车多半是想收工，不是想加一条没有内容的', async () => {
    const { onPatch } = setup({ subtasks: SUBS });
    await pickCardMenu('编辑');
    fireEvent.keyDown(screen.getByLabelText('加一条检查事项'), { key: 'Enter' });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('**一条都没有的任务也加得了**——那正是这个入口最要紧的场景', async () => {
    const { onPatch } = setup({ subtasks: [] });
    await pickCardMenu('编辑');
    const box = screen.getByLabelText('加一条检查事项');
    fireEvent.change(box, { target: { value: '第一步' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPatch).toHaveBeenCalledWith('t1', { subtasks: [{ text: '第一步', done: false }] });
  });

  it('文字改得了——打错一个字不用整条删了重加', async () => {
    const { onPatch } = setup({ subtasks: SUBS });
    await pickCardMenu('编辑');
    fireEvent.change(screen.getByLabelText('第 1 项检查事项'), { target: { value: '刷两遍墙' } });
    expect(onPatch).toHaveBeenCalledWith('t1', { subtasks: [{ text: '刷两遍墙', done: false }] });
  });

  it('删得掉', async () => {
    const { onPatch } = setup({ subtasks: [{ text: '刷墙', done: false }, { text: '装灯', done: true }] });
    await pickCardMenu('编辑');
    fireEvent.click(screen.getByLabelText('删掉检查事项「刷墙」'));
    expect(onPatch).toHaveBeenCalledWith('t1', { subtasks: [{ text: '装灯', done: true }] });
  });

  it('**编辑态里照样勾得动**——这块走的是直接 patch，不进草稿，所以保存时不会把勾的那一下盖回去', async () => {
    const { onPatch } = setup({ subtasks: SUBS });
    await pickCardMenu('编辑');
    fireEvent.click(screen.getByRole('checkbox', { name: /刷墙|第 1 项/ }) ?? screen.getAllByRole('checkbox')[0]);
    expect(onPatch).toHaveBeenCalledWith('t1', { subtasks: [{ text: '刷墙', done: true }] });
  });
});

/**
 * 「推迟过 N 次」。**这个数一直在存，却只在「建议」那一栏露过面**（`suggest.ts`
 * 的「一拖再拖」组）——而它最该出现的地方正是你盯着这张卡想「这个到底做不做」
 * 的时候。门槛跟那一组共用同一个常量。
 *
 * 措辞从「改过 N 次期」换成「推迟过 N 次」：前者断句别扭（读起来是「改过 / 4
 * 次 / 期」），而这个数存的本来就是「本来有截止日期、被往后挪了」几次
 * （server/src/mutate.ts 的 postponed）——「推迟」正是它的意思。
 */
describe('TaskCard：推迟过几次', () => {
  const mark = (over: Partial<Task>) =>
    [...setup(over).container.querySelectorAll('.ink-overdue-mark')].map((e) => e.textContent);

  it('到了门槛就说出来', () => {
    expect(mark({ postponeCount: POSTPONE_MIN })).toContain(`推迟过 ${POSTPONE_MIN} 次`);
    expect(mark({ postponeCount: 5 })).toContain('推迟过 5 次');
  });

  it('没到门槛不说——推一次是常事，每张卡都挂一句是噪音', () => {
    expect(mark({ postponeCount: POSTPONE_MIN - 1 }).some((x) => x?.includes('推迟'))).toBe(false);
    expect(mark({ postponeCount: 0 }).some((x) => x?.includes('推迟'))).toBe(false);
  });

  it('**门槛跟「建议」那一组是同一个常量**——两处各写一个 2，调门槛只会改到一处', () => {
    // 这一条钉的是「用了那个 export」，不是某个具体数字：POSTPONE_MIN 改成 3，
    // 上面两条会自己跟着走，这一条保证它确实是从 suggest.ts 来的。
    expect(mark({ postponeCount: POSTPONE_MIN })).toContain(`推迟过 ${POSTPONE_MIN} 次`);
    expect(mark({ postponeCount: POSTPONE_MIN - 1 }).join()).not.toContain('推迟');
  });
});

/**
 * 切走视图会把这张卡整个卸载，编辑到一半的草稿跟着没——八个视图里只有三个
 * `keepMounted`。收件箱那条草稿栽过同一个坑（当时靠给那个视图加 keepMounted
 * 修的），任务卡这边修不了同一处：八个视图全挂着不卸载，等于把整棵树留在
 * 内存里。判据在 `lib/draftStash.ts`。
 */
describe('TaskCard：编辑到一半被卸载', () => {
  const NOTE = '刚打了一半的备注';

  const mount = (over: Partial<Task> = {}) => render(
    <AntApp>
      <TaskCard
        t={task({ id: 'keep-1', ...over })} now={NOW} lists={[]}
        onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
      />
    </AntApp>,
  );

  const typeNote = async () => {
    await pickCardMenu('编辑');
    const notes = await screen.findByPlaceholderText(/备注/);
    fireEvent.change(notes, { target: { value: NOTE } });
  };

  it('卸载再挂回来：草稿还在，卡片直接是编辑态', async () => {
    const first = mount();
    await typeNote();
    first.unmount();

    mount();
    expect(await screen.findByDisplayValue(NOTE)).toBeTruthy();
  });

  it('**取消之后卸载就不留**——主动取消完再「恢复」出一份旧草稿是凭空冒出来的东西', async () => {
    const first = mount();
    await typeNote();
    fireEvent.click(byText('取消')!);
    first.unmount();

    const { container } = mount();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('**存成了也不留**', async () => {
    const first = render(
      <AntApp>
        <TaskCard
          t={task({ id: 'keep-1' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    await pickCardMenu('编辑');
    const notes = await screen.findByPlaceholderText(/备注/);
    fireEvent.change(notes, { target: { value: NOTE } });
    fireEvent.click(byText('保存')!);
    // 退出编辑态的判据用「保存按钮没了」，不用 textarea：antd 的自适应高度
    // TextArea 会额外渲染一个 tabindex=-1 的隐藏镜像，`querySelector('textarea')`
    // 分不清那两个。
    await waitFor(() => expect(byText('保存')).toBeUndefined());
    first.unmount();

    const { container } = mount();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('压根没进过编辑态的卡卸载再挂回来还是查看态', async () => {
    mount().unmount();
    const { container } = mount();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('**`E` 键（autoEdit）不会把刚接回来的草稿冲掉**——那条 effect 紧接着挂载就跑，无条件覆盖等于白存', async () => {
    const first = mount();
    await typeNote();
    first.unmount();

    render(
      <AntApp>
        <TaskCard
          t={task({ id: 'keep-1' })} now={NOW} lists={[]} autoEdit
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={() => {}}
        />
      </AntApp>,
    );
    expect(await screen.findByDisplayValue(NOTE)).toBeTruthy();
  });

  it('**接回草稿时要告诉上游「这张卡在编辑态」**——不说的话 editingIds 会在下一次重算时把它当普通卡摘掉，连同刚接回来的草稿', async () => {
    const first = mount();
    await typeNote();
    first.unmount();

    const onEditingChange = vi.fn();
    render(
      <AntApp>
        <TaskCard
          t={task({ id: 'keep-1' })} now={NOW} lists={[]}
          onPatch={vi.fn()} onEditTask={async () => {}} onDelete={vi.fn()} onEditingChange={onEditingChange}
        />
      </AntApp>,
    );
    await waitFor(() => expect(onEditingChange).toHaveBeenCalledWith('keep-1', true));
  });
});

/**
 * **卡片上的时间跟行档说同一个词。**
 *
 * 「截止」和「提醒」原来走 `taskView.formatWhen` 的绝对格式，于是同一条任务
 * 在行档下读作「今天 18:00」、切成卡片档变成「截止 2026-08-12 18:00」——而
 * 卡片上它左边紧挨着的就是「过期 3 小时」，同一个事实的相对说法和绝对说法
 * 并排摆着。界面审查时在真浏览器里两档一对照才看出来。
 *
 * 判据故意写成「跟 dueChip 一致」而不是写死某个字符串：dueChip 是行档那颗
 * chip 的文案来源，两边从此绑在一起，谁改了另一边会红。
 */
describe('TaskCard：时间说成人话，跟行档同一个词', () => {
  const times = (over: Partial<Task>) =>
    [...setup(over).container.querySelectorAll('.ink-task-times span')].map((e) => e.textContent);

  it('截止用相对说法（今天/明天/昨天/几月几日），不是 YYYY-MM-DD', () => {
    const due = new Date(2026, 7, 12, 18, 0).toISOString();
    const line = times({ due }).find((t) => t?.startsWith('截止'));
    expect(line).toBe(`截止 ${whenText(due, NOW)}`);
    expect(line).toBe('截止 今天 18:00');
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('提醒也一样——同一行里两个时刻不能一个相对一个绝对', () => {
    const at = new Date(2026, 7, 13, 9, 30).toISOString();
    const line = times({ reminders: [{ at, firedAt: null }] })!.find((t) => t?.startsWith('提醒'));
    expect(line).toBe('提醒 明天 09:30');
  });
});

// ── 便捷操作：双击进编辑 / 右键弹同一份菜单 ──
// 在这之前，进编辑只有两条路：先选中再按 `E`，或者鼠标挪到卡片右上角点 ⋯
// 再点「编辑」。菜单也只有 ⋯ 一个入口。
describe('TaskCard：双击改它、右键弹菜单', () => {
  it('**双击卡片进编辑态**——列表里最省事的那一步', () => {
    const { container } = setup({ title: '写周报' });
    expect(container.querySelector('textarea')).toBeNull();
    fireEvent.doubleClick(container.querySelector('.ink-task-card')!);
    expect((screen.getByDisplayValue('写周报') as HTMLInputElement)).toBeTruthy();
  });

  it('**双击按钮不进编辑**——双击一颗按钮是在点那颗按钮，不该顺带做别的事', () => {
    const { container } = setup({ title: '写周报' });
    fireEvent.doubleClick(screen.getByRole('button', { name: /更多操作/ }));
    expect(container.querySelector('.ink-task-card textarea')).toBeNull();
  });

  it('**已经在编辑态里双击不再触发**——那时整张卡是个表单，在备注框里双击是「选中一个词」，是浏览器的事', async () => {
    const { container } = setup({ title: '写周报', notes: '一些备注' });
    fireEvent.doubleClick(container.querySelector('.ink-task-card')!);
    const box = await screen.findByDisplayValue('一些备注');
    fireEvent.change(box, { target: { value: '改了一半' } });
    fireEvent.doubleClick(box);
    // 没有被重置回任务当前值——双击要是又跑一次 startEdit，这里会变回「一些备注」
    expect((box as HTMLTextAreaElement).value).toBe('改了一半');
  });

  it('右键弹出的菜单**跟 ⋯ 是同一份**，不是另抄的一份少几项', async () => {
    const { container } = setup({ title: '写周报' });
    fireEvent.contextMenu(container.querySelector('.ink-task-card')!);
    const viaRight = (await screen.findAllByRole('menuitem')).map((e) => e.textContent);
    expect(viaRight.length).toBeGreaterThan(3);
    expect(viaRight).toContain('编辑');
  });

  it('右键菜单里点「编辑」，跟双击到的是同一个编辑态', async () => {
    const { container } = setup({ title: '写周报' });
    fireEvent.contextMenu(container.querySelector('.ink-task-card')!);
    fireEvent.click(await screen.findByText('编辑'));
    expect(screen.getByDisplayValue('写周报')).toBeTruthy();
  });
});

/**
 * 卡片上的一键完成。**在这之前卡片档要完成一条待办得走两步**（「开始」→
 * 「完成」：`MOVES.todo` 只有开始/搁置，划动手势和 ⋯ 菜单里也都没有「完成」）
 * ——而同一个动作在行档是点一下勾选圈、在详情面板也是、批量是一个 D 键。
 * 同一件事在四个地方三种代价，而卡片档还是默认那一档。
 */
describe('TaskCard：卡片上的勾选圈', () => {
  it('待办的卡片上就有，点一下直接完成——不用先「开始」', () => {
    const { onPatch } = setup({ id: 't1', title: '换纱窗', status: 'todo' });
    fireEvent.click(screen.getByRole('button', { name: '把「换纱窗」标记完成' }));
    expect(onPatch).toHaveBeenCalledWith('t1', { status: 'done' });
  });

  it('已完成的再点一下标回待办——判据跟行档那个圈一字不差', () => {
    const { onPatch } = setup({ id: 't1', title: '换纱窗', status: 'done' });
    fireEvent.click(screen.getByRole('button', { name: '把「换纱窗」标回待办' }));
    expect(onPatch).toHaveBeenCalledWith('t1', { status: 'todo' });
  });

  it.each(['doing', 'later', 'abandoned'] as const)('%s 状态也有这个圈——每条任务在哪儿都有一个', (status) => {
    setup({ id: 't1', title: '换纱窗', status });
    expect(screen.getByRole('button', { name: '把「换纱窗」标记完成' })).toBeTruthy();
  });
});

/**
 * 番茄钟被卸载时那句提示：**README 逐字抄了它**（「番茄钟：专注完接着休息」那节）。
 * 两处手抄的话，改一头另一头就成了一句不成立的话——这个仓库为同一个形状栽过
 * 好几次（AGENTS.md 少报字段、Android 冒烟清单抄的那句局域网警告，后者真飘过）。
 */
describe('番茄钟中断那句提示', () => {
  it('README 抄的那份跟常量一字不差', () => {
    const md = readFileSync('README.md', 'utf8').replace(/\s+/g, '');
    expect(
      md,
      'README「番茄钟」那节抄的中断提示跟 TaskCard 的 FOCUS_ABANDON_TAIL 对不上了，两边必须同步改。',
    ).toContain(FOCUS_ABANDON_TAIL.replace(/\s+/g, ''));
  });

  it('**「标记完成」在里面**——那是最常撞上的一种「被筛掉」，不点名的话人接不上因果', () => {
    expect(FOCUS_ABANDON_TAIL).toContain('标记完成');
    expect(FOCUS_ABANDON_TAIL.indexOf('标记完成')).toBeLessThan(FOCUS_ABANDON_TAIL.indexOf('切走视图'));
  });
});

/**
 * **父亲还没开始，卡片上要说得出是谁挡着。**
 *
 * 四象限和「现在做什么」按 `notStartedDeep` 把这条挡在外面（判据和出处在
 * `lib/hierarchy.ts` 的 `blockingAncestor`）。屏幕上不说的话，一条自己一个
 * 日期都没设的子任务从那两屏消失，是无解的——而他要么去改父任务的日期、
 * 要么把这条摘出来，两条路都得先知道是谁挡着。
 */
describe('卡片：父任务还没开始时说出是谁挡着', () => {
  const LATER = new Date(2026, 8, 1, 9).toISOString();   // 9/1，NOW 是 8/12
  const PAST = new Date(2026, 7, 1, 9).toISOString();
  const parent = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const mark = (c: HTMLElement) => [...c.querySelectorAll('.ink-notstarted-mark')].map((e) => e.textContent);

  it('**写出父任务的名字和日期**', () => {
    const { container } = setup({ id: 'c', title: '量尺寸', parentId: 'p' }, { allTasks: [parent({ startAt: LATER }), task({ id: 'c', parentId: 'p' })] });
    expect(mark(container).join()).toContain('装修');
    expect(mark(container).join()).toContain('才开始');
  });

  it('父亲的开始时间已经过了：不写这句话', () => {
    const { container } = setup({ id: 'c', parentId: 'p' }, { allTasks: [parent({ startAt: PAST }), task({ id: 'c', parentId: 'p' })] });
    expect(mark(container)).toEqual([]);
  });

  it('没有父亲：不写这句话', () => {
    const { container } = setup({ id: 'c' }, { allTasks: [task({ id: 'c' })] });
    expect(mark(container)).toEqual([]);
  });

  it('**自己也没开始时只说一句**——并排两句「9月1日 开始」「装修 9月1日 才开始」是同一件事说两遍', () => {
    const own = new Date(2026, 8, 5, 9).toISOString();
    const { container } = setup({ id: 'c', parentId: 'p', startAt: own }, { allTasks: [parent({ startAt: LATER }), task({ id: 'c', parentId: 'p', startAt: own })] });
    const marks = mark(container);
    expect(marks).toHaveLength(1);
    expect(marks[0]).not.toContain('装修');   // 说的是它自己那个日期
  });

  it('没给 `allTasks` 就不画——跟旁边两个层级记号同一条约定', () => {
    const { container } = setup({ id: 'c', parentId: 'p' });
    expect(mark(container)).toEqual([]);
  });
});
