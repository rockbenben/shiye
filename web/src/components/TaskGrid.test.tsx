import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { DragEndEvent } from '@dnd-kit/core';
import { TaskGrid, type GridSection } from './TaskGrid.js';
import { btnIn, keyboardDrag, mockDndRects, NoMotion, pickCardMenu, task } from '../test-utils.js';
import type { SelState } from '../lib/selection.js';
import { groupProposals, type ProposalWiring } from './ProposalNote.js';

/**
 * 复审修复轮 1 · I1：`handleDragEnd` 里 `over === null`（拖出了所有放置目标
 * 之外）这条分支，jsdom 里几乎逼不出真实场景——2 格这种小夹具下 `@dnd-kit`
 * 的最近邻碰撞检测总能找到一个「最近」的目标。**不等于测不了**：`DndContext`
 * 的 `onDragEnd` 只是一个普通 prop，`vi.mock` 部分替换 `@dnd-kit/core`——
 * 保留其余全部真实实现（`useDraggable`/`useSortable`/`useDroppable`……），
 * 只在真实 `DndContext` 外面包一层，把它这一次收到的 `onDragEnd` 存进
 * `dndCapture`——就能在测试里直接拿真实的 `handleDragEnd` 函数、手工喂一个
 * `over: null` 的事件，不需要真的在 jsdom 里演出一次「拖到放置目标之外」。
 * `real.DndContext(props)` 直接当函数调会 `TypeError`（它是 `memo()` 包过的
 * 组件，不是裸函数）——用 `createElement(real.DndContext, props)` 走正常的
 * React 元素创建，其余测试用例的真实拖拽行为不受影响。
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

// TaskCard 现在无条件调用 useFileDrop（Attachments.tsx）——拖放区扩到了整张
// 卡（final-review.md「专项判定」），不再只在渲染出 Attachments 子组件时才
// 存在。这个仓库其余测试文件不碰文件拖放，不需要这份 mock；只有下面「文件
// 拖到卡片上不会被 onDropTo 当成卡片拖拽」这条会真的触发一次 api 调用。
vi.mock('../api.js', () => ({
  api: {
    uploadAttachment: vi.fn(async () => ({})),
    deleteAttachment: vi.fn(),
    attachmentUrl: vi.fn((taskId: string, name: string) => `/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`),
  },
}));
const { api } = await import('../api.js');
const uploadAttachmentMock = api.uploadAttachment as ReturnType<typeof vi.fn>;

const NOW = new Date('2026-08-14T12:00:00.000Z');

// TaskCard 用了 antd 的下拉菜单和 message，要 AntApp 包一层；NoMotion 关掉
// 动画，否则菜单展开是异步的。这两层是本仓库所有卡片测试的既定装置，
// 照 TodayView.test.tsx 的用法来。
const wire = () => ({
  now: NOW,
  onPatch: vi.fn(),
  onEditTask: vi.fn(async () => ({})),
  onDelete: vi.fn(),
  lists: [],
});

const show = (
  sections: (e: Set<string>) => GridSection[],
  empty = '没有',
  extra: Partial<{
    layout: 'stack' | 'cells'; keepEmpty: boolean; onDropTo: (id: string, key: string) => void;
    editRequestId: string | null; onEditRequestHandled: () => void; density: 'row' | 'card';
    proposals: ProposalWiring; compact: boolean; emptyFiltered: string;
    onOpenDetail: (id: string) => void; openDetailId: string | null;
  }> = {},
) =>
  render(
    <NoMotion><AntApp>
      <TaskGrid sections={sections} empty={empty} {...wire()} {...extra} />
    </AntApp></NoMotion>,
  );

/**
 * 选中态是「跟 App 一层双向绑定」的 controlled 用法（见 TaskGrid.tsx
 * Props.selection 的注释）——测试里用这个小包装模拟 App 会做的事：自己
 * 持一份 `useState<SelState>`，原样转发 selection/onSelectionChange 给
 * TaskGrid。不用这层包装、直接把一个写死的 SelState 传进去的话，第一次
 * 点击之后 onSelectionChange 被调用了，但没有地方接住新状态、组件不会
 * 重渲染，测不出「点了之后卡片真的变了」。
 *
 * `density` 可传（task-2 修复轮 1 · I3）——默认不传（跟今天一样是卡片档），
 * 密度那组测试传 `'row'`，验证选中态在行档也接上了 TaskRow，不是只有
 * TaskCard 才有。
 */
function SelectableGrid(
  { sections, empty = '没有', density }: { sections: (e: Set<string>) => GridSection[]; empty?: string; density?: 'row' | 'card' },
) {
  const [sel, setSel] = useState<SelState>({ ids: new Set(), anchor: null });
  return (
    <NoMotion><AntApp>
      <TaskGrid sections={sections} empty={empty} {...wire()} density={density} selection={sel} onSelectionChange={setSel} />
    </AntApp></NoMotion>
  );
}

/** 按标题文字找到那张卡可点击的外层（TaskCard 渲染的 .ink-swipe）。 */
const cardFor = (title: string) => screen.getByText(title).closest('.ink-swipe') as HTMLElement;

describe('TaskGrid', () => {
  it('空组不渲染标题', () => {
    show(() => [
      { key: 'a', title: '已过期', tasks: [] },
      { key: 'b', title: '今天', tasks: [task()] },
    ]);
    expect(screen.queryByText('已过期')).toBeNull();
    expect(screen.getByText('今天')).toBeTruthy();
  });

  it('每组都空的时候才显示空状态，而且不连带渲染任何分组标题', () => {
    show(() => [{ key: 'a', title: 'A', tasks: [] }], '这里什么都没有');
    expect(screen.getByText('这里什么都没有')).toBeTruthy();
    expect(document.querySelector('.ink-grid-heading')).toBeNull();
  });

  it('组头上挂得了一颗按钮（action）——「哪一组该有什么按钮」由造 sections 的那一方定，这一层只管画', () => {
    show(() => [{ key: 'a', title: '已过期', tasks: [task()], action: <button type="button">全部改到今天</button> }]);
    const head = document.querySelector('.ink-grid-heading') as HTMLElement;
    expect(within(head).getByText('全部改到今天')).toBeTruthy();
  });

  it('startFolded 的组一开始是折起来的：组头和条数在，卡片不渲染', () => {
    show(() => [{ key: 'done', title: '已完成', tasks: [task({ id: 'x', title: '做完了的' })], startFolded: true }]);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    // 不是 display:none——那两百张卡连同各自的状态还留在树里，只省了滚动。
    expect(screen.queryByText('做完了的')).toBeNull();
  });

  it('点组头展开，再点收起', () => {
    show(() => [{ key: 'done', title: '已完成', tasks: [task({ id: 'x', title: '做完了的' })], startFolded: true }]);
    const head = screen.getByRole('button', { name: /已完成/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(head);
    expect(screen.getByText('做完了的')).toBeTruthy();
    expect(screen.getByRole('button', { name: /已完成/ }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /已完成/ }));
    expect(screen.queryByText('做完了的')).toBeNull();
  });

  it('**展开之后重渲染不会自己折回去**——sections() 每次都产出新对象，按 startFolded 重算就会把他刚展开的那一组折回去', () => {
    const { rerender } = show(() => [
      { key: 'done', title: '已完成', tasks: [task({ id: 'x', title: '做完了的' })], startFolded: true },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /已完成/ }));
    expect(screen.getByText('做完了的')).toBeTruthy();

    rerender(
      <NoMotion><AntApp>
        <TaskGrid
          sections={() => [{ key: 'done', title: '已完成', tasks: [task({ id: 'x', title: '做完了的' })], startFolded: true }]}
          empty="没有"
          {...wire()}
        />
      </AntApp></NoMotion>,
    );
    expect(screen.getByText('做完了的')).toBeTruthy();
  });

  it('**每一组都能折**，不只是 startFolded 那两组——点一下组头，这一组的卡就收起来', () => {
    show(() => [{ key: 'a', title: '未完成', tasks: [task({ id: 'x', title: '还没做的' })] }]);
    expect(screen.getByText('还没做的')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /未完成/ }));
    expect(screen.queryByText('还没做的')).toBeNull();
    // 再点一下回来——不是单向门。
    fireEvent.click(screen.getByRole('button', { name: /未完成/ }));
    expect(screen.getByText('还没做的')).toBeTruthy();
  });

  it('没传 startFolded 的组一开始是展开的——「能折」不等于「折着」', () => {
    show(() => [{ key: 'a', title: '未完成', tasks: [task({ id: 'x', title: '还没做的' })] }]);
    expect(screen.getByText('还没做的')).toBeTruthy();
    expect(screen.getByRole('button', { name: /未完成/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('没传 action 的组，组头上除了折叠那颗不多出别的按钮', () => {
    show(() => [{ key: 'a', title: '今天', tasks: [task()] }]);
    const head = document.querySelector('.ink-grid-heading') as HTMLElement;
    const btns = [...head.querySelectorAll('button')];
    expect(btns).toHaveLength(1);
    expect(btns[0]!.className).toContain('ink-grid-fold');
  });

  it('标题旁边的计数是这一组的条数，不是总数', () => {
    show(() => [
      { key: 'a', title: '今天', tasks: [task({ id: 'x' }), task({ id: 'y' })] },
      { key: 'b', title: '明天', tasks: [task({ id: 'z' })] },
    ]);
    // 在 heading 内部查，不是全页查——全页查的话「3」在别处出现也会通过
    expect(screen.getByRole('heading', { name: /今天/ }).textContent).toContain('2');
    expect(screen.getByRole('heading', { name: /明天/ }).textContent).toContain('1');
  });

  it('正在编辑的 id 传给 sections——谓词失配的卡不会中途消失', async () => {
    const seen: Array<Set<string>> = [];
    show((editing) => {
      seen.push(new Set(editing));
      return [{ key: 'a', title: '今天', tasks: [task()] }];
    });
    expect(seen.at(-1)!.size).toBe(0);
    // 编辑态是从卡片的下拉菜单进的，不是一个叫「编辑」的按钮。
    // pickCardMenu 是 test-utils 里既有的辅助，本仓库所有卡片测试都用它。
    await pickCardMenu('编辑');
    // 变异验证锚点：把 TaskGrid 里的 editingIds 换成永远的空 Set，这行会红
    expect(seen.at(-1)!.has('t1')).toBe(true);
  });

  it('编辑中换组不重挂——分组谓词的结果变了，编辑器也不能跟着换父节点消失', async () => {
    // sections 故意写成「编辑中就该属于组 b」：不钉组的话，点了编辑之后这张卡
    // 会从组 a 的 DOM 子树搬到组 b 的 DOM 子树，key 相同也救不了——React 只在
    // 同一个父节点的子节点数组里按 key 复用，跨父节点等于全新元素，TaskCard
    // 连同它未保存的编辑态一起被卸载重挂。
    const sections = (editing: Set<string>) => [
      { key: 'a', title: '组A', tasks: editing.has('t1') ? [] : [task()] },
      { key: 'b', title: '组B', tasks: editing.has('t1') ? [task()] : [] },
    ];
    const { rerender } = show(sections);
    await pickCardMenu('编辑');
    // btnIn 不是 getByText：antd 会给「恰好两个汉字、没有图标」的按钮插一个
    // 空格（渲染成「保 存」），见 test-utils.tsx 里 btnIn 自己的注释。
    expect(btnIn(document.body, '保存')).toBeTruthy();

    // 只渲染一次测不住钉组——钉组只需要在「进入编辑后的第一次渲染」里生效，
    // 光看这一次，「钉回上次的组」和「写坏了、钉到了这一轮的组」两种实现
    // 算出来的落点是一样的（这一轮唯一的一次读、写都还没发生分叉）。真正
    // 分叉在**下一次**渲染：SSE 刷新任务、`now` 走一格、父组件任何 setState
    // 都会触发它，这里手动 rerender 同一棵树来模拟。
    rerender(
      <NoMotion><AntApp>
        <TaskGrid sections={sections} empty="没有" {...wire()} />
      </AntApp></NoMotion>,
    );
    // 变异验证锚点：TaskGrid.tsx 的
    // `if (!editingIds.has(t.id)) home.current.set(...)` 去掉判断、改成无条件
    // 写——编辑中那次渲染也会把 home 覆写成当前算出来的组（这里是 b），这次
    // rerender 就会读到被写坏的 home，卡片被搬去组 b，重挂、「保存」消失。
    // 实测见 task-1-report.md。
    expect(btnIn(document.body, '保存')).toBeTruthy();
  });

  it('不在编辑中的卡跟着最新分组走，不会被它以前待过的组钉住', () => {
    // 跟上一条是两回事：上一条测「编辑中的卡不能因为分组变了而换组」，这条
    // 测反过来的一半——**没在编辑**的卡必须正常跟着新的分组结果走，不能被
    // `home` 那份「上次在哪」的记忆钉死。这半条规矩在「一直处于编辑态」的
    // 场景里测不出来：TaskGrid.tsx 里 `autoEdit` 的
    // `editingIds.has(t.id) ? home.current.get(t.id) : undefined` 两个分支
    // 只有在**从未进入过编辑态**的卡身上才会给出不同答案（编辑中的卡走的
    // 一直是同一个分支），所以必须单独用一条不涉及编辑的卡来验。
    let inB = false;
    const sections = () => [
      { key: 'a', title: '组A', tasks: inB ? [] : [task()] },
      { key: 'b', title: '组B', tasks: inB ? [task()] : [] },
    ];
    const { rerender } = show(sections);
    expect(screen.getByRole('heading', { name: /组A/ })).toBeTruthy();

    inB = true;
    rerender(
      <NoMotion><AntApp>
        <TaskGrid sections={sections} empty="没有" {...wire()} />
      </AntApp></NoMotion>,
    );
    // 变异验证锚点：TaskGrid.tsx 里 `autoEdit` 的三元判断去掉，改成无条件
    // `home.current.get(t.id)`——这张卡从没编辑过，但渲染一次之后 home 已经
    // 记下了它当时所在的组（组A），换成无条件读取之后，它会被永远钉在组A，
    // 即使 sections 已经把它分到组B。实测见 task-1-report.md。
    expect(screen.queryByRole('heading', { name: /组A/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /组B/ })).toBeTruthy();
  });

  it('卡片被删/被筛掉时，卸载会把它的 id 从 editingIds 里清掉——不然它永远出不来', async () => {
    // 这条守的是 TaskCard.tsx 里那句
    // `useEffect(() => () => onEditingChange(t.id, false), [])`：没有它的话，
    // 编辑到一半的卡被删除/被筛出视图，它的 id 会永远留在 TaskGrid 的
    // editingIds 里——不是这条卡自己的事：钉组逻辑会把**下一张**恰好复用了
    // 同一个分组结构、或者别的正在编辑的卡也牵连误判，而且这个 id 永远等不到
    // 任何人再调用 onEditingChange(id, false) 去摘掉它。
    const seen: Array<Set<string>> = [];
    let gone = false;
    const sections = (editing: Set<string>) => {
      seen.push(new Set(editing));
      return gone ? [] : [{ key: 'a', title: '组A', tasks: [task()] }];
    };
    const { rerender } = show(sections);
    await pickCardMenu('编辑');
    expect(seen.at(-1)!.has('t1')).toBe(true);

    // 模拟这张卡被删掉/被筛出视图：sections 不再返回它，TaskCard 卸载。
    gone = true;
    rerender(
      <NoMotion><AntApp>
        <TaskGrid sections={sections} empty="没有" {...wire()} />
      </AntApp></NoMotion>,
    );
    // 卸载 effect 里的 onEditingChange 调用本身是一次 setState，会再触发一轮
    // 渲染——sections 会因此再被调用一次，这次的 editingIds 里不该再有 t1。
    // 变异验证锚点：把 TaskCard.tsx 里那句 useEffect 删掉，这里会一直等到
    // 超时，seen 的最后一项永远含 t1。
    await waitFor(() => {
      expect(seen.at(-1)!.has('t1')).toBe(false);
    });
  });

  describe('layout / keepEmpty（看板、四象限要用，默认值不改变今天的行为）', () => {
    it('默认还是竖着摞，空组不出现，也没有 .ink-cells 容器——今天的行为一个字不变', () => {
      const { container } = show(() => [
        { key: 'a', title: '甲', tasks: [task({ id: '1' })] },
        { key: 'b', title: '乙', tasks: [] },
      ]);
      expect(container.querySelector('.ink-cells')).toBeNull();
      expect(screen.queryByText('乙')).toBeNull();
    });

    it('keepEmpty 打开之后空组的标题还在——看板要能往空列里拖', () => {
      show(
        () => [
          { key: 'a', title: '甲', tasks: [task({ id: '1' })] },
          { key: 'b', title: '乙', tasks: [] },
        ],
        '没有',
        { keepEmpty: true },
      );
      expect(screen.getByText('乙')).toBeTruthy();
    });

    it('keepEmpty 打开、且一条任务都没有时，还是显示那句空状态', () => {
      // 关键：keepEmpty 打开之后格子永远都在，shown 永远非空——空状态不能再靠
      // 「shown.length === 0」判断，得看「有没有任何一条任务」。
      show(() => [{ key: 'a', title: '甲', tasks: [] }], '一条任务都没有', { keepEmpty: true });
      expect(screen.getByText('一条任务都没有')).toBeTruthy();
    });

    it('layout=cells 时容器带 .ink-cells', () => {
      const { container } = show(() => [{ key: 'a', title: '甲', tasks: [] }], '没有', {
        layout: 'cells',
        keepEmpty: true,
      });
      expect(container.querySelector('.ink-cells')).not.toBeNull();
    });

    // 上限方向：编辑钉组那段（home ref）不能被这次改动弄坏——照抄上面
    // 「编辑中换组不重挂」那条，只把 layout 换成 cells。
    it('cells 布局下，正在编辑的卡照样钉在原来那一格', async () => {
      const sections = (editing: Set<string>) => [
        { key: 'a', title: '组A', tasks: editing.has('t1') ? [] : [task()] },
        { key: 'b', title: '组B', tasks: editing.has('t1') ? [task()] : [] },
      ];
      const { rerender } = show(sections, '没有', { layout: 'cells' });
      await pickCardMenu('编辑');
      expect(btnIn(document.body, '保存')).toBeTruthy();

      rerender(
        <NoMotion><AntApp>
          <TaskGrid sections={sections} empty="没有" layout="cells" {...wire()} />
        </AntApp></NoMotion>,
      );
      // 变异验证锚点：home ref 的钉组判断被去掉，这里会因为卡片重挂而丢失
      // 未保存的编辑态，「保存」按钮消失。
      expect(btnIn(document.body, '保存')).toBeTruthy();
    });
  });

  describe('onDropTo（拖进格子改字段，看板/四象限用）——task-3-brief：拖拽换成 @dnd-kit', () => {
    const twoCells = (onDropTo: (id: string, key: string) => void, extra: Partial<{ density: 'row' | 'card' }> = {}) =>
      show(
        () => [
          { key: 'todo', title: '待办', tasks: [task({ id: 'task-1' })] },
          { key: 'doing', title: '进行中', tasks: [] },
        ],
        '没有',
        { layout: 'cells', keepEmpty: true, onDropTo, ...extra },
      );

    /**
     * 键盘拖放（task-3-brief 的主要收益之一，四处现在都没有的能力）：
     * Tab 到抓手 → Space 拿起 → 方向键移动 → Space 放下。**jsdom 不算真实
     * 布局**，`@dnd-kit` 的键盘碰撞检测（`sortableKeyboardCoordinates`）靠
     * `getBoundingClientRect()` 判断「往哪个方向按能碰到下一个目标」，全零
     * 的矩形算不出方向——`mockDndRects` 按格子在 DOM 里出现的顺序造一份假的
     * 横向矩形（`todo` 在左、`doing` 在右），ArrowRight 才有意义（实测过：
     * 不 mock 直接测，onDragEnd 里 `over` 会一直停在 `todo` 自己身上）。
     */
    it('键盘：Tab 到抓手 → Space 拿起 → ArrowRight → Space 放下——onDropTo 收到 (id, 目标格 key)', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const onDropTo = vi.fn();
        const { container } = twoCells(onDropTo);
        const handle = container.querySelector<HTMLElement>('.ink-rank')!;
        await keyboardDrag(handle, ['ArrowRight']);
        // 精确到参数，不是 toHaveBeenCalled()——传错成源格 key（'todo'）也会
        // 让一个只断言「被调用了」的测试全绿，这个仓库的假绿总账第 288 行那类
        // 教训。
        expect(onDropTo).toHaveBeenCalledTimes(1);
        expect(onDropTo).toHaveBeenCalledWith('task-1', 'doing');
      } finally {
        restore();
      }
    });

    /**
     * 守卫②「拖回原地不发回调」：Space 拿起、不按任何方向键、立刻再按一次
     * Space 放下——`@dnd-kit` 这时候 `over` 就是它自己（`active.id ===
     * over.id`），`TaskGrid.tsx` `handleDragEnd` 里 `from === to` 那道判断
     * 会挡住，不发一次没有变化的 PATCH。
     */
    it('守卫②：拖回原地（Space 立刻再 Space，没有方向键移动）不发回调——一次没有变化的 PATCH 会白白刷一次盘', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const onDropTo = vi.fn();
        const { container } = twoCells(onDropTo);
        const handle = container.querySelector<HTMLElement>('.ink-rank')!;
        await keyboardDrag(handle);
        expect(onDropTo).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    /**
     * 守卫①「外来拖拽不转发」：`@dnd-kit` 只在自己的 `DndContext` 里派发
     * `active`/`over`——它不监听浏览器原生 Drag and Drop 事件（选中一段文字
     * 拖进来、拖一个链接进来走的就是那套原生机制）。**这条验证这一点，不是
     * 假设**：对着格子直接派发原生 dragover/drop（不经过 `@dnd-kit` 的
     * 指针/键盘监听器），`onDropTo` 不该被触发，`dragOver` 也不该被
     * preventDefault——组件树里已经没有任何原生 `onDragOver`/`onDrop`
     * 处理器了（以前 `CalendarGrid.tsx` 的等价守卫要手动读
     * `dataTransfer.getData('text/plain')` 挡一道，这里因为整套机制都换掉了，
     * 天然进不来，不需要那一步）。
     */
    it('守卫①：原生拖放事件（外来拖拽，比如选中的文字）不会被转发给 onDropTo——@dnd-kit 不监听这套事件', () => {
      const onDropTo = vi.fn();
      const { container } = twoCells(onDropTo);
      const section = container.querySelectorAll('.ink-grid-section')[1];
      const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => '这是一段被选中的普通文字，不是任务 id'), effectAllowed: '', dropEffect: '' };
      const notCanceled = fireEvent.dragOver(section, { dataTransfer });
      // 没有任何原生 onDragOver 处理器——事件不会被 preventDefault。
      expect(notCanceled).toBe(true);
      fireEvent.drop(section, { dataTransfer });
      expect(onDropTo).not.toHaveBeenCalled();
    });

    // 拖放区扩到了整张卡之后（final-review.md「专项判定」），TaskCard 上的
    // Card 节点也接了 dropProps（Attachments.tsx 的 useFileDrop）——文件拖放
    // 走的是浏览器原生 Drag and Drop（Attachments.tsx 自己监听 onDrop），
    // 跟上面那条「守卫①」同一条理由：@dnd-kit 完全不碰这套事件，两套机制
    // 互不相干，文件拖拽不会被误当成卡片拖拽去调用 onDropTo。
    it('文件拖到卡片上不会触发 onDropTo——不会被当成卡片拖拽', async () => {
      const onDropTo = vi.fn();
      const { container } = twoCells(onDropTo);
      const card = container.querySelector('.ink-task-card')!;
      const file = new File(['x'], 'a.txt');

      fireEvent.drop(card, { dataTransfer: { types: ['Files'], files: [file] } });

      await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledWith('task-1', file));
      expect(onDropTo).not.toHaveBeenCalled();
    });

    it('没给 onDropTo 时手柄整个不出现——没有 rank 也没有 drag，TaskCard.tsx 那道 (rank !== undefined || drag) 判断不成立', () => {
      const { container } = show(
        () => [{ key: 'todo', title: '待办', tasks: [task({ id: 'task-1' })] }],
        '没有',
        { layout: 'cells', keepEmpty: true },
      );
      // 「今天」以外的视图不该冒出一个能拖的手柄——`.ink-rank` 压根不渲染，
      // 不是渲染了但没有可达性属性。
      expect(container.querySelector('.ink-rank')).toBeNull();
    });

    it('格子布局下手柄不显示数字——这一格里第几张卡是 readTasks() 的文件顺序，不是任何人排出来的', () => {
      // 上面几条只查抓手属性，查不出手柄里显示的是数字还是抓手
      // 字形——TaskGrid 只要传了 rank（哪怕只传给 onDropTo 分支），这几条
      // 照样全绿：曾经真的这么写过一版（rank={onDropTo ? i + 1 : undefined}），
      // 这里的全部断言都不会红。这条直接读手柄的文本内容，钉住 TaskGrid 不
      // 传 rank 这件事本身，不是只信 TaskCard.test.tsx 那边的单元测试——
      // 见 TaskCard.tsx 里 CardProps.rank 的注释：这个数字会让人以为能在
      // 格子里拖着重新排序，而同格拖放其实是有意做成的空操作。
      const { container } = twoCells(vi.fn());
      const handle = container.querySelector<HTMLElement>('.ink-rank')!;
      expect(handle).not.toBeNull();
      expect(handle.textContent).toBe('⠿');
    });

    /**
     * 拖拽手感——被拖的卡带 .ink-row-dragging，悬停的目标格带
     * .ink-grid-section-over。以前靠 `dragging`/`overKey` 这两份 state 手动
     * 维护，现在直接读 `@dnd-kit` 自己算的 `isDragging`/`over`
     * （`useSortable`/`useDndContext`），见 `TaskGrid.tsx` 的
     * `GridCell`/`SortableTaskItem` 注释。键盘按到一半（拿起 + 按了方向键，
     * 还没放下）就是「拖动中」，这里只走到那一步，不放下，直接检查这两个
     * class。
     */
    it('拖动中：被拖的卡带 .ink-row-dragging，悬停的目标格带 .ink-grid-section-over', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const { container } = twoCells(vi.fn());
        const handle = container.querySelector<HTMLElement>('.ink-rank')!;
        const sourceCard = container.querySelector('[role="listitem"]')!;
        const targetSection = container.querySelectorAll('.ink-grid-section')[1];

        handle.focus();
        fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
        await new Promise((r) => setTimeout(r, 0));
        // 变异验证锚点：TaskGrid.tsx 的 SortableTaskItem 里 `isDragging` 那句
        // 三元表达式换成永远 undefined。
        expect(sourceCard.className).toContain('ink-row-dragging');

        fireEvent.keyDown(handle, { code: 'ArrowRight', key: 'ArrowRight' });
        await new Promise((r) => setTimeout(r, 0));
        // 变异验证锚点：GridCell 里 `overCellKey === section.key` 那句判断
        // 换成永远 false。
        expect(targetSection.className).toContain('ink-grid-section-over');

        // 收尾：把这次拾起的拖拽放下——不是必须（每条用例各自 render），
        // 只是不让这条用例结束时留一个悬空的键盘拖拽会话。
        fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
      } finally {
        restore();
      }
    });

    /**
     * 复审修复轮 1 · I5：格子内部的顺序从来不是任何人排出来的（`readTasks()`
     * 的文件顺序，同格拖放是 `handleDragEnd` 里 `from === to` 特意做成的
     * 空操作），但换库之前 `SortableContext` 用的是默认 `rectSortingStrategy`
     * ——拖动经过同一格里的另一张卡时，那张卡会被计算出一个位移 `transform`
     * 视觉上「让路」，等于当场演示一次其实不会发生的重排。这里用
     * `[role="listitem"]` 给两张卡分别造不同位置（跟别的测试用格子级别的
     * `mockDndRects` 不同——这条要能在**同一格内**用方向键从一张卡移动到
     * 另一张卡，格子级别的 mock 会让同格的卡拿到完全相同的假矩形，方向键
     * 分不出方向）。
     */
    it('守卫（I5）：同一格内拖动经过另一张卡，那张卡不会被展示出「会让位」的位移动效', async () => {
      const restore = mockDndRects('[role="listitem"]', { vertical: true, gap: 50 });
      try {
        const onDropTo = vi.fn();
        const { container } = show(
          () => [
            { key: 'todo', title: '待办', tasks: [task({ id: 'task-1' }), task({ id: 'task-2' })] },
            { key: 'doing', title: '进行中', tasks: [] },
          ],
          '没有',
          { layout: 'cells', keepEmpty: true, onDropTo },
        );
        const handle1 = container.querySelectorAll<HTMLElement>('.ink-rank')[0];
        const item2 = container.querySelectorAll('[role="listitem"]')[1] as HTMLElement;
        expect(item2.style.transform).toBeFalsy();

        handle1.focus();
        fireEvent.keyDown(handle1, { code: 'Space', key: ' ' });
        await new Promise((r) => setTimeout(r, 0));
        fireEvent.keyDown(handle1, { code: 'ArrowDown', key: 'ArrowDown' });
        await new Promise((r) => setTimeout(r, 0));

        // 变异验证锚点：GridCell 里 `strategy={noReflowStrategy}` 换回
        // `rectSortingStrategy`——这条会红（task-2 会被算出一个非空的
        // translate3d transform，视觉上让位，但松手 onDropTo 不会真的把
        // 它挪到别的位置——见下面收尾那句「同格不发回调」）。
        expect(item2.style.transform).toBeFalsy();

        fireEvent.keyDown(handle1, { code: 'Space', key: ' ' });
        await new Promise((r) => setTimeout(r, 0));
        // 同格没有真的发生任何改变——跟这份不会兑现的动效承诺互相印证。
        expect(onDropTo).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    /**
     * 被拖的卡在拖动中途从 sections() 里消失（SSE 把它标成完成/删了/被
     * /expand 合并……都可能）——**这条钉的是行为，不是数 class**（复审修复轮
     * 1 · C1：上一版这里只断言 `.ink-row-dragging`/`.ink-grid-section-over`
     * 不在 DOM 里，而这两个 class 本来就挂在**消失的那张卡自己**身上，它
     * 卸载了这两个 class 必然消失，跟 `@dnd-kit` 内部的键盘会话有没有真的
     * 解除毫无关系——这条断言在只清了本地 state、`@dnd-kit` 内部仍然卡死的
     * 坏实现下也会一样绿，没有测到东西）。**真正要证明的是「下一次真的还能
     * 拖」**：task-1 拿起后消失，紧接着对 task-2 走一次完整的键盘拖拽序列
     * （Tab 到抓手→Space→ArrowRight→Space），`onDropTo` 必须真的被调用——
     * 如果 `@dnd-kit` 的键盘会话卡在 task-1 身上没解除，`KeyboardSensor` 不会
     * 响应 task-2 抓手上的新 Space（它的 activator 只认
     * `event.target === active.activatorNode.current`），这条会直接看到
     * `onDropTo` 零调用。
     */
    it('被拖的卡中途从列表里消失，不会卡死键盘会话——紧接着对另一张卡的拖拽照样能完成', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const onDropTo = vi.fn();
        const build = (withTask1: boolean) => () => [
          { key: 'todo', title: '待办', tasks: [...(withTask1 ? [task({ id: 'task-1' })] : []), task({ id: 'task-2' })] },
          { key: 'doing', title: '进行中', tasks: [] },
        ];
        const { container, rerender } = show(build(true), '没有', { layout: 'cells', keepEmpty: true, onDropTo });
        const handle1 = container.querySelectorAll<HTMLElement>('.ink-rank')[0];
        handle1.focus();
        fireEvent.keyDown(handle1, { code: 'Space', key: ' ' });
        await new Promise((r) => setTimeout(r, 0));
        expect(container.querySelector('.ink-row-dragging')).not.toBeNull();

        rerender(
          <NoMotion><AntApp>
            <TaskGrid sections={build(false)} empty="没有" {...wire()} layout="cells" keepEmpty onDropTo={onDropTo} />
          </AntApp></NoMotion>,
        );
        // useCancelStuckDrag 的派发在 useEffect 里，等它跑完这一轮。
        await new Promise((r) => setTimeout(r, 0));

        // 高亮不会卡死（跟以前一样守着，但不是这条测试的重点）。
        expect(container.querySelector('.ink-row-dragging')).toBeNull();
        expect(container.querySelector('.ink-grid-section-over')).toBeNull();
        expect(onDropTo).not.toHaveBeenCalled();

        // 真正的行为断言：task-2 现在能被拖动完成，onDropTo 真的收到调用。
        const handle2 = container.querySelector<HTMLElement>('.ink-rank')!;
        await keyboardDrag(handle2, ['ArrowRight']);
        expect(onDropTo).toHaveBeenCalledTimes(1);
        expect(onDropTo).toHaveBeenCalledWith('task-2', 'doing');
      } finally {
        restore();
      }
    });

    /**
     * 复审修复轮 1 · I2：早前一版「被拖的卡消失」的修法是发现即用 `key` 强制
     * 重挂整棵 `<DndContext>` 子树——能让卡死的高亮消失，但代价是把子树里
     * 每一张卡（包括拖拽目标之外、没有任何问题的其它卡）连同它们各自的本地
     * state 一起卸载重挂。**实测过**：拖拽进行中 + 同一格里另一张卡正编辑到
     * 一半 + 被拖的那张卡消失 → 那张编辑中的卡的草稿被整个清空。现在的修法
     * （`lib/dnd.ts` 的 `useCancelStuckDrag`，派发一次 `Escape` 让 `@dnd-kit`
     * 走它自己的取消路径）不重挂任何东西——这条钉住这一点：task-1 拿起后
     * 消失时，同一格里 task-2 正开着编辑框、标题栏里有一段还没保存的草稿，
     * 这段草稿必须原样还在，不能被这次「取消拖拽」连带清掉。
     */
    it('守卫（I2）：拖拽进行中、被拖的卡消失，不会把同一格里另一张卡的未保存草稿一起清空', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const onDropTo = vi.fn();
        const build = (withTask1: boolean) => () => [
          {
            key: 'todo',
            title: '待办',
            tasks: [...(withTask1 ? [task({ id: 'task-1', title: '甲' })] : []), task({ id: 'task-2', title: '乙' })],
          },
          { key: 'doing', title: '进行中', tasks: [] },
        ];
        const { container, rerender } = show(build(true), '没有', { layout: 'cells', keepEmpty: true, onDropTo });

        // 打开「乙」（第二张卡）的编辑态，改一下标题——不保存。
        await pickCardMenu('编辑', { scope: container, nth: 1 });
        const titleBox = screen.getByPlaceholderText('标题');
        fireEvent.change(titleBox, { target: { value: '乙-改过还没保存' } });

        // 拿起「甲」（第一张卡）。
        const handle1 = container.querySelectorAll<HTMLElement>('.ink-rank')[0];
        handle1.focus();
        fireEvent.keyDown(handle1, { code: 'Space', key: ' ' });
        await new Promise((r) => setTimeout(r, 0));

        // 「甲」消失（SSE 并发删除）——不是「乙」，「乙」全程没被碰过。
        rerender(
          <NoMotion><AntApp>
            <TaskGrid sections={build(false)} empty="没有" {...wire()} layout="cells" keepEmpty onDropTo={onDropTo} />
          </AntApp></NoMotion>,
        );
        await new Promise((r) => setTimeout(r, 0));

        // 变异验证锚点：把 `useCancelStuckDrag` 换回「重挂整棵 DndContext」的
        // 旧修法——这条会红（草稿被清空，输入框读到的是「乙」原始标题，不是
        // 「乙-改过还没保存」）。
        expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('乙-改过还没保存');
      } finally {
        restore();
      }
    });

    /**
     * task-3-brief 要点①：「看板/四象限的跨列拖拽要复用行的抓手，别另起
     * 一套」——看板/四象限在 App.tsx 里固定 `density="row"`，非编辑态渲染
     * 的是 `TaskRow`，不再是 `TaskCard`。这条证的是同一份 `onDropTo` 机制
     * 在行档下照样能用：抓手挂在 `TaskRow` 悬停才出现的 `.ink-trow-handle`
     * 上（不是 `TaskCard` 那个常驻的 `.ink-rank`），键盘拖到另一格照样触发
     * `onDropTo(id, 目标格 key)`。
     */
    it('density="row" + cells：非编辑态渲染的是 TaskRow，键盘拖拽复用它常驻挂载、悬停才显示的抓手，onDropTo 照样触发', async () => {
      const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
      try {
        const onDropTo = vi.fn();
        const { container } = twoCells(onDropTo, { density: 'row' });
        // 先证明真的是行档，不是巧合读到了别的东西。
        expect(container.querySelector('.ink-trow')).not.toBeNull();
        expect(container.querySelector('.ink-task-card')).toBeNull();
        // 没悬停：抓手已经在 DOM 里（复审修复轮 1 · I4：常驻挂载，不再是
        // 悬停才挂进 DOM），只是带着视觉隐藏的 class，跟 TaskRow.test.tsx
        // 的既有行为一致。
        const handleBeforeHover = container.querySelector('.ink-trow-handle');
        expect(handleBeforeHover).not.toBeNull();
        expect(handleBeforeHover!.classList.contains('ink-trow-handle-hidden')).toBe(true);

        const row = container.querySelector('.ink-trow')!;
        fireEvent.mouseEnter(row);
        // 变异验证锚点 a：TaskGrid.tsx 里 `<TaskRow>` 那行的 `drag={drag}`
        // 被去掉——上面「没悬停也在 DOM 里」那条不受影响（`rank`/`drag` 都没
        // 给的话 TaskRow 压根不会渲染这个节点，但这条走的是 onDropTo 分支，
        // drag 一定会给），这里悬停之后仍然找不到 `.ink-trow-handle`，下面
        // `!` 断言会在 null 上抛错，测试失败。
        const handle = container.querySelector<HTMLElement>('.ink-trow-handle')!;
        expect(handle.classList.contains('ink-trow-handle-hidden')).toBe(false);
        await keyboardDrag(handle, ['ArrowRight']);
        // 变异验证锚点 b：`onDropTo` 的目标格 key 如果被写死（比如永远传
        // 'todo'，也就是源格本身），这里精确到参数的断言会红——跟这个文件
        // 上面「不是随便哪两个参数」那条同一条理由。
        expect(onDropTo).toHaveBeenCalledWith('task-1', 'doing');
      } finally {
        restore();
      }
    });

    /**
     * 复审修复轮 1 · I1：`handleDragEnd` 里 `over === null` 这条分支——之前
     * 被记成「测不了」，实测证伪。`dndCapture.onDragEnd` 是文件顶部
     * `vi.mock('@dnd-kit/core', …)` 抓到的、`TaskGrid.tsx` 真实传给
     * `<DndContext>` 的那个 `handleDragEnd` 函数本身，不是重新实现的一份。
     */
    describe('守卫（I1）：over === null 不发 onDropTo——手工喂事件，不是假设测不了', () => {
      it('对照组：手工喂一个合法的 over，onDropTo 精确调用一次——证明抓到的是真实可用的 handleDragEnd，不是空转', () => {
        const onDropTo = vi.fn();
        twoCells(onDropTo);
        expect(dndCapture.onDragEnd).not.toBeNull();
        dndCapture.onDragEnd!({
          active: { id: 'task-1', data: { current: { sortable: { containerId: 'todo' } } } },
          over: { id: 'doing', data: { current: {} } },
        } as unknown as DragEndEvent);
        expect(onDropTo).toHaveBeenCalledTimes(1);
        expect(onDropTo).toHaveBeenCalledWith('task-1', 'doing');
      });

      it('over 是 null（拖出了所有放置目标之外）：不发 onDropTo', () => {
        const onDropTo = vi.fn();
        twoCells(onDropTo);
        expect(dndCapture.onDragEnd).not.toBeNull();
        // 变异验证锚点：TaskGrid.tsx handleDragEnd 里的 `if (!onDropTo || !over) return;`
        // 去掉 `!over` 这半——这条会红（over 是 null，`String(over.id)` 会
        // 抛 TypeError，或者改成更宽松的写法会让 onDropTo 被意外调用）。
        dndCapture.onDragEnd!({
          active: { id: 'task-1', data: { current: { sortable: { containerId: 'todo' } } } },
          over: null,
        } as unknown as DragEndEvent);
        expect(onDropTo).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * 选中态（批量操作的地基，见 2026-08-17-selection.md）。这里测的是 TaskGrid
   * 自己那一半：`selection`/`onSelectionChange` 两个都不给时完全不接线；
   * 给了之后，勾选框的出现条件、渲染顺序怎么摊平、Shift 连选怎么跨分组——
   * 这几件都要靠真实的多分组渲染才测得出来，TaskCard.test.tsx 只测卡片自己
   * 收到 `select` prop 之后的那一半（判据、preventDefault、转发的 mods）。
   */
  describe('选中态：selection/onSelectionChange（批量操作的地基）', () => {
    const twoGroups = () => [
      { key: 'A', title: '组A', tasks: [task({ id: 'a', title: '甲' }), task({ id: 'b', title: '乙' })] },
      { key: 'B', title: '组B', tasks: [task({ id: 'c', title: '丙' }), task({ id: 'd', title: '丁' }), task({ id: 'e', title: '戊' })] },
    ];

    it('没给 selection/onSelectionChange：点卡片（哪怕带修饰键）什么都不发生，没有勾选框/选中标记——今天的行为不变', () => {
      const { container } = show(() => [{ key: 'a', title: '组A', tasks: [task({ id: 'a', title: '甲' })] }]);
      fireEvent.click(cardFor('甲'), { ctrlKey: true });
      expect(container.querySelector('.ink-sel-check')).toBeNull();
      expect(container.querySelector('.ink-task-card-selected')).toBeNull();
    });

    it('Ctrl 点选中，卡片上出现选中标记', () => {
      const { container } = render(
        <SelectableGrid sections={() => [{ key: 'a', title: '组A', tasks: [task({ id: 'a', title: '甲' })] }]} />,
      );
      expect(container.querySelector('.ink-task-card-selected')).toBeNull();
      fireEvent.click(cardFor('甲'), { ctrlKey: true });
      // 变异验证锚点：TaskGrid.tsx 里 `selected: selection.ids.has(t.id)` 换成
      // 永远 false——上面这行会红。
      expect(container.querySelector('.ink-task-card-selected')).not.toBeNull();
    });

    it('选中之后每张卡都出现勾选框，之前没有——上限', () => {
      const { container } = render(<SelectableGrid sections={twoGroups} />);
      expect(container.querySelectorAll('.ink-sel-check').length).toBe(0);
      fireEvent.click(cardFor('甲'), { ctrlKey: true });
      // 变异验证锚点：`showCheckbox: selection.ids.size > 0` 换成
      // `selection.ids.has(t.id)`（只有被点中的那张自己出现勾选框）——
      // 5 张卡里只有 1 张会有 .ink-sel-check，下面这条断言会红。
      expect(container.querySelectorAll('.ink-sel-check').length).toBe(5);
    });

    it('Shift 点连选，选中的是渲染顺序里的那一段（跨分组）', () => {
      render(<SelectableGrid sections={twoGroups} />);
      const checkedFor = (title: string) => (screen.getByLabelText(`选中「${title}」`) as HTMLInputElement).checked;

      // 锚点落在组A的「乙」（orderedIds 里第 2 位）。
      fireEvent.click(cardFor('乙'), { ctrlKey: true });
      // 连选到组B的「丁」（orderedIds 里第 4 位）——中间跨过组A/组B的边界。
      fireEvent.click(cardFor('丁'), { shiftKey: true });

      // orderedIds 是 [甲,乙,丙,丁,戊]（TaskGrid 的 shown 摊平出来的顺序，
      // 见 orderedIds 的注释），选中的该是「乙,丙,丁」这一段，不多不少：
      // 甲在锚点之前、戊在目标之后，两端都不该被带进来——这条断言同时守住
      // 「没有漏选中间跨组的丙」和「没有多选出界」两个方向。
      expect(checkedFor('甲')).toBe(false);
      expect(checkedFor('乙')).toBe(true);
      expect(checkedFor('丙')).toBe(true);
      expect(checkedFor('丁')).toBe(true);
      expect(checkedFor('戊')).toBe(false);
    });

    // twoGroups() 的 id 恰好是 a,b,c,d,e——渲染顺序和字典序凑巧一致，测不出
    // 「orderedIds 其实是按字典序/id 排的，不是按屏幕上真正的先后」这类实现
    // （比如手滑写成 `[...ids].sort()`）：那种坏实现在 twoGroups() 上也会
    // 全绿。跟 selection.test.ts「乱序夹具」那条同一个教训（O 是有序字母表，
    // 不能证明实现真的按「给定顺序」而不是「字母序」在切）——这里把组B排在
    // 组A前面，id 却仍是 a/b（组A）、c/d（组B），渲染顺序（丙丁甲乙）刻意
    // 跟字典序（甲乙丙丁）对不上，才逼得出这条区分。
    it('渲染顺序不是字典序/id 序——乱序夹具，逼出「orderedIds 其实在按字典序切」这类坏实现', () => {
      const sections = () => [
        { key: 'B', title: '组B', tasks: [task({ id: 'c', title: '丙' }), task({ id: 'd', title: '丁' })] },
        { key: 'A', title: '组A', tasks: [task({ id: 'a', title: '甲' }), task({ id: 'b', title: '乙' })] },
      ];
      render(<SelectableGrid sections={sections} />);
      const checkedFor = (title: string) => (screen.getByLabelText(`选中「${title}」`) as HTMLInputElement).checked;

      // 渲染顺序是 丙,丁,甲,乙（组B先渲染）。锚点丁，连选到甲——渲染顺序里
      // 这一段是「丁,甲」，不是字典序/id 序（那样会是「丁,甲」→「甲,丁」
      // 顺序反过来的另一段）。
      fireEvent.click(cardFor('丁'), { ctrlKey: true });
      fireEvent.click(cardFor('甲'), { shiftKey: true });

      expect(checkedFor('丙')).toBe(false);
      expect(checkedFor('丁')).toBe(true);
      expect(checkedFor('甲')).toBe(true);
      expect(checkedFor('乙')).toBe(false);
    });
  });

  /**
   * 'E' 键的落点（批量操作的地基，见 2026-08-17-selection.md Task 4）。
   * App 怎么算出「该给哪张卡传这个 id」是 App.test.tsx 的事（那边有真实的
   * 选中态和键盘事件），这里只守 TaskGrid 自己那一半：只有 t.id 命中的那张
   * 卡收到 autoEdit=true，别的卡（包括没给这个 prop 的默认情况）收到 false
   * 或 undefined，不是全部卡一起进编辑态。
   */
  describe('editRequestId：\'E\' 键的落点只精确命中一张卡', () => {
    const twoTasks = () => [
      { key: 'a', title: '组A', tasks: [task({ id: 'a', title: '甲' }), task({ id: 'b', title: '乙' })] },
    ];

    it('editRequestId 命中「甲」：只有「甲」进入编辑态，「乙」不受影响', () => {
      show(twoTasks, undefined, { editRequestId: 'a', onEditRequestHandled: vi.fn() });
      // 编辑态是 TaskFields 的表单，标题输入框的 placeholder 固定是「标题」——
      // 只应该出现一个（「甲」的），不是两个。
      expect(screen.getAllByPlaceholderText('标题').length).toBe(1);
      // 「乙」还是只读展示，标题原样是普通文字，不是输入框。
      expect(screen.getByText('乙')).toBeTruthy();
    });

    it('editRequestId 命中之后回调 onEditRequestHandled——不清的话同一个 id 再触发一次会被 useEffect 的依赖挡住', () => {
      const onHandled = vi.fn();
      show(twoTasks, undefined, { editRequestId: 'a', onEditRequestHandled: onHandled });
      expect(onHandled).toHaveBeenCalledTimes(1);
    });

    it('不给 editRequestId（默认，undefined）：没有任何一张卡自己进入编辑态——今天的行为不变', () => {
      show(twoTasks);
      expect(screen.queryByPlaceholderText('标题')).toBeNull();
    });

    // 上限：editRequestId 是空字符串或者 tasks 里不存在的 id 时，同样不该有
    // 任何一张卡进入编辑态——`t.id === editRequestId` 的比较不能被空值/假值
    // 意外命中空 id 之类的边界。
    it('editRequestId 是列表里不存在的 id：没有任何一张卡进入编辑态', () => {
      show(twoTasks, undefined, { editRequestId: 'zzz', onEditRequestHandled: vi.fn() });
      expect(screen.queryByPlaceholderText('标题')).toBeNull();
    });
  });

  /**
   * 密度（task-2）：`density` 不进 `GridWiring`，是 TaskGrid 自己的 Props 字段，
   * 见 TaskGrid.tsx Props.density 的注释。这里只测 TaskGrid 自己那一半——
   * App.tsx 的开关按钮、哪些视图给这个 prop、localStorage 读写分别是
   * App.test.tsx/density.test.ts 的事。
   */
  describe('density：行 / 卡两档渲染', () => {
    const oneTask = () => [{ key: 'a', title: '组A', tasks: [task({ title: '甲' })] }];

    it('不传 density：渲染出来是 TaskCard，没有 TaskRow——默认档，今天的行为不变（上限）', () => {
      const { container } = show(oneTask);
      expect(container.querySelector('.ink-task-card')).not.toBeNull();
      expect(container.querySelector('.ink-trow')).toBeNull();
    });

    // 上限断言（task-3-brief 要点③「卡档仍然是多列，行档改单列这条只改行档」）：
    // 容器的 class 也要按 density 二选一，不只是里面渲染的卡片/行组件换了。
    // 这条守的是「卡档没有被顺手改成单列」——容器还是 .ink-card-grid（两列
    // 网格），.ink-row-list（单列封顶）不该出现。
    it('不传 density：容器是 .ink-card-grid，不是 .ink-row-list——卡档不许被顺手改成单列（上限）', () => {
      const { container } = show(oneTask);
      expect(container.querySelector('.ink-card-grid')).not.toBeNull();
      expect(container.querySelector('.ink-row-list')).toBeNull();
    });

    it('density="row"：容器换成 .ink-row-list（单列），不再是 .ink-card-grid——两列网格换成了单列', () => {
      // 变异验证锚点：TaskGrid.tsx 里那句
      // `density === 'row' ? 'ink-row-list' : 'ink-card-grid'` 换成永远
      // 'ink-card-grid'（容器 class 写死）——上一条「不传 density」的用例
      // 照样绿，这条会红：行档下拿到的还是两列网格的容器，不是单列。
      const { container } = show(oneTask, undefined, { density: 'row' });
      expect(container.querySelector('.ink-row-list')).not.toBeNull();
      expect(container.querySelector('.ink-card-grid')).toBeNull();
    });

    it('density="row"：渲染出来是 TaskRow，没有 TaskCard——切换真的换了渲染', () => {
      const { container } = show(oneTask, undefined, { density: 'row' });
      // 变异验证锚点：把 TaskGrid.tsx 里 `density === 'row'` 换成永远 false
      // （或者把默认值参数从 'card' 改成 'row'，让这条测不出「default 传的是
      // 字面量 'card'」这件事）——上面那条「不传 density」的用例和这条会分道
      // 扬镳：一条要求没有 .ink-trow，一条要求必须有，同一份实现不可能两条
      // 都绿，除非它真的按 density 的值分支。
      expect(container.querySelector('.ink-trow')).not.toBeNull();
      expect(container.querySelector('.ink-task-card')).toBeNull();
    });

    it('density="row"：点标题展开成 TaskCard——复用的是既有的 editingIds/setEditing，不是另起一套「展开」状态', () => {
      const seen: Array<Set<string>> = [];
      const { container } = show((editing) => {
        seen.push(new Set(editing));
        return oneTask();
      }, undefined, { density: 'row' });
      expect(seen.at(-1)!.size).toBe(0);

      fireEvent.click(screen.getByRole('button', { name: '甲' }));

      // 变异验证锚点：TaskRow 的 onOpen 如果没接到 setEditing（比如接了一个
      // 空函数、或者接了一份 TaskGrid 自己另起的新 Set），这张卡不会从行
      // 换成卡，下面两条断言都会红。
      expect(container.querySelector('.ink-trow')).toBeNull();
      expect(container.querySelector('.ink-task-card')).not.toBeNull();
      // 而且这个 id 真的进了 sections(editing) 收到的那份集合——证明用的是
      // 同一份 editingIds，不是一份 TaskGrid 自己另外维护、外界看不到的状态。
      // 变异验证锚点：如果 onOpen 另起了一个独立的 `expandedIds` state（不是
      // 复用 editingIds/setEditing），这张卡照样会从行换成卡（上面两条断言
      // 依然绿），但这里会红——这正是这条测试要单独存在的理由。
      expect(seen.at(-1)!.has('t1')).toBe(true);
    });

    it('density="row"：展开之后是查看态，不是编辑表单——onOpen 只展开，不替用户点「编辑」', () => {
      show(oneTask, undefined, { density: 'row' });
      fireEvent.click(screen.getByRole('button', { name: '甲' }));
      // 查看态：标题还是普通文字，没有编辑表单的标题输入框。
      expect(screen.queryByPlaceholderText('标题')).toBeNull();
      expect(screen.getByText('甲')).toBeTruthy();
    });

    it('density="row"：展开 → 点「编辑」→ 点「取消」——收起来又变回行，靠的是 TaskCard 已有的编辑退出路径，没有另开一个「收起」按钮', async () => {
      const { container } = show(oneTask, undefined, { density: 'row' });
      fireEvent.click(screen.getByRole('button', { name: '甲' }));
      expect(container.querySelector('.ink-task-card')).not.toBeNull();

      // pickCardMenu 找的是文本恰好是「⋯」的按钮——TaskRow 自己也有一颗同样
      // 文案的「更多」按钮，但只在悬停时才挂进 DOM（TaskRow.tsx），这里没有
      // 触发悬停，不会跟 TaskCard 的下拉菜单按钮混淆。
      await pickCardMenu('编辑');
      expect(btnIn(document.body, '保存')).toBeTruthy();

      fireEvent.click(btnIn(document.body, '取消'));
      // 变异验证锚点：渲染分支的判断如果只看 `density === 'row'`、忘了
      // `!editingIds.has(t.id)`，正在编辑的卡也会被塞进 TaskRow 分支——
      // 上面 pickCardMenu('编辑') 那一步会先因为找不到「⋯」而抛错，走不到
      // 这里；这条断言额外守住「取消之后」这一刻的收尾状态。
      expect(container.querySelector('.ink-trow')).not.toBeNull();
      expect(container.querySelector('.ink-task-card')).toBeNull();
    });

    // 整分支审查 A 组：展开成卡之后，「⋯ → 编辑 → 取消」不是唯一的收起路
    // 径了——直接再点一次标题就能收回去，见 TaskCard.tsx 标题 onClick 上面
    // 的长注释。上一条测试留着（那条路仍然是合法的收起方式，只是不再是
    // 唯一的），这条补「整行可点 = 打开详情」该有的对称手势。
    it('density="row"：展开成卡之后再点一次标题——直接收回成行，不用绕「编辑→取消」', () => {
      const { container } = show(oneTask, undefined, { density: 'row' });
      fireEvent.click(screen.getByRole('button', { name: '甲' }));
      expect(container.querySelector('.ink-task-card')).not.toBeNull();
      expect(container.querySelector('.ink-trow')).toBeNull();

      // 变异验证锚点：TaskCard.tsx 标题的 onClick 被删掉/被改成恒不调用
      // onEditingChange——点了标题之后卡片纹丝不动，下面两条断言都会红。
      fireEvent.click(screen.getByText('甲'));
      expect(container.querySelector('.ink-trow')).not.toBeNull();
      expect(container.querySelector('.ink-task-card')).toBeNull();
    });

    /**
     * task-2 修复轮 1 · I3：切到行档之后，批量选择 / AI 建议边注静默消失——
     * 行分支以前只传 t/now/onPatch/onOpen 四个字段，`selection`/
     * `onSelectionChange`/`proposals` 虽然流到了 TaskGrid 里，却没有继续
     * 转发给 TaskRow。这两条测的是修完之后的样子：选中态和待决建议记号在
     * 行档也接上了，不是只有 TaskCard 才有。
     */
    it('density="row"：Ctrl 点标题真的选中——勾选框和选中标记都出现在行上，不是只有卡片才有', () => {
      const { container } = render(
        <SelectableGrid density="row" sections={() => [{ key: 'a', title: '组A', tasks: [task({ title: '甲' })] }]} />,
      );
      // 先证明真的是行档，不是巧合读到了别的东西。
      expect(container.querySelector('.ink-trow')).not.toBeNull();
      expect(container.querySelector('.ink-trow-select')).toBeNull();
      expect(container.querySelector('.ink-trow-selected')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '甲' }), { ctrlKey: true });

      // 变异验证锚点：TaskGrid.tsx 里 <TaskRow> 那行去掉 `select={selectWiring}`——
      // 这两条会双双落空，Ctrl 点标题会被当成没接选中，落进 TaskRowProps.onOpen
      // 那条「没有 select 时哪怕带修饰键也只 onOpen」的分支，什么都不会变。
      expect(container.querySelector('.ink-trow-selected')).not.toBeNull();
      expect(container.querySelector('.ink-trow-select')).not.toBeNull();
    });

    it('density="row"：有待决建议的任务，行上出现 .ink-trow-proposal；没有的任务不出现（对照组）', () => {
      const proposals: ProposalWiring = {
        byTask: groupProposals([{
          id: 'p1', taskId: 't1', patch: { title: '改个标题' }, reason: '理由',
          createdAt: '2026-01-01T00:00:00.000Z',
        }]),
        onAccept: vi.fn(async () => ({})),
        onDismiss: vi.fn(async () => ({})),
      };
      // 两条任务：t1 有待决建议，t2 没有——对照组挡的是「不管有没有建议，
      // 这个记号都渲染/都不渲染」这类坏实现（parked-all.md 反复出现的教训：
      // 只有正向用例、没有对照组，测不出上限方向）。
      show(
        () => [{ key: 'a', title: '组A', tasks: [task({ id: 't1', title: '甲' }), task({ id: 't2', title: '乙' })] }],
        undefined,
        { density: 'row', proposals },
      );
      const rowFor = (title: string) => screen.getByText(title).closest('.ink-trow') as HTMLElement;
      // 变异验证锚点：TaskGrid.tsx 里 `hasProposal` 算式写死成 `true`（或者
      // <TaskRow> 那行忘了传 hasProposal）——「乙」那行也会长出记号，下面
      // 第二条断言会红。
      expect(rowFor('甲').querySelector('.ink-trow-proposal')).not.toBeNull();
      expect(rowFor('乙').querySelector('.ink-trow-proposal')).toBeNull();
    });

    /**
     * `compact`（task-3-brief 修复轮 1 · C-2）：`TaskGrid` 只做一件事——原样
     * 转发给 `TaskRow`，判据/紧凑排版本身的实现是 `TaskRow.test.tsx` 的事。
     * 这里只守转发这一步没漏。
     */
    it('density="row" + compact：转发给 TaskRow，行上标签不渲染', () => {
      const { container } = show(
        () => [{ key: 'a', title: '组A', tasks: [task({ title: '甲', tags: ['紧急'] })] }],
        undefined,
        { density: 'row', compact: true },
      );
      // 变异验证锚点：TaskGrid.tsx 里 <TaskRow> 那行忘了传 `compact={compact}`
      // ——这条会红（标签照样渲染）。
      expect(container.querySelector('.ink-trow-tags')).toBeNull();
    });

    // 上限：不传 compact（undefined，五个列表类视图/四象限的默认状态）时
    // TaskRow 该收到的是 undefined，不是被 TaskGrid 自己悄悄改写成
    // true——同一份带标签的夹具，标签必须还在。
    it('density="row"：不传 compact 时标签正常渲染——上限，不许被顺手写死成紧凑', () => {
      const { container } = show(
        () => [{ key: 'a', title: '组A', tasks: [task({ title: '甲', tags: ['紧急'] })] }],
        undefined,
        { density: 'row' },
      );
      expect(container.querySelector('.ink-trow-tags')).not.toBeNull();
    });
  });
});

/**
 * 「筛选把东西全挡掉了」跟「你一条任务都没有」是两回事。后者那句话在筛选
 * 开着的时候是一句假话——你有两百条，只是这个筛选一条都没匹配上，而它还
 * 刚好长得像「数据没了」。
 */
describe('TaskGrid：筛空了跟真空了说的不是同一句', () => {
  const none = () => [{ key: 'k', title: '', tasks: [] }];

  it('没给 emptyFiltered 时照旧说原来那句', () => {
    show(none, '一条任务都没有');
    expect(screen.getByText('一条任务都没有')).toBeTruthy();
  });

  it('给了就用它', () => {
    show(none, '一条任务都没有', { emptyFiltered: '这 200 条都被筛选挡住了' });
    expect(screen.getByText('这 200 条都被筛选挡住了')).toBeTruthy();
    expect(screen.queryByText('一条任务都没有')).toBeNull();
  });

  it('**列表其实不空时两句都不出现**——正在编辑的那张卡会被留下来，那时候该显示的是那张卡', () => {
    show(() => [{ key: 'k', title: '', tasks: [task({ id: 'a', title: '还在编辑' })] }],
      '一条任务都没有', { emptyFiltered: '都被筛选挡住了' });
    expect(screen.queryByText('都被筛选挡住了')).toBeNull();
    expect(screen.queryByText('一条任务都没有')).toBeNull();
  });
});

/**
 * 详情面板（`onOpenDetail`）。**这一层只测"点开这一条去哪了"**——面板长什么
 * 样在 `TaskDetail.test.tsx`，接线在 `App.test.tsx`。
 */
describe('TaskGrid：打开一条任务交给详情面板', () => {
  const one = () => [{ key: 'a', title: '未完成', tasks: [task({ id: 'x', title: '写周报' })] }];

  it('给了 onOpenDetail：点标题把 id 送出去，那一行**不再当场膨胀成一张卡**（列表不跳）', () => {
    const onOpenDetail = vi.fn();
    show(one, '没有', { density: 'row', onOpenDetail });
    // 按 class 取标题那颗按钮：勾选圈的 aria-label 里也有「写周报」三个字，
    // 按名字取会同时命中两颗。
    fireEvent.click(document.querySelector('.ink-trow-open') as HTMLElement);
    // 点标题是「看看这条」，不带 edit——两个意图分开，见 Props.onOpenDetail。
    expect(onOpenDetail).toHaveBeenCalledWith('x', undefined);
    // 还是一行，没有变成卡片——这一条正是这个面板存在的理由。
    expect(document.querySelector('.ink-trow')).not.toBeNull();
    expect(document.querySelector('.ink-task-card')).toBeNull();
  });

  it('没给 onOpenDetail：还是原来那样就地展开——十几个调用点漏接一个不该换行为', () => {
    show(one, '没有', { density: 'row' });
    fireEvent.click(document.querySelector('.ink-trow-open') as HTMLElement);
    expect(document.querySelector('.ink-task-card')).not.toBeNull();
  });

  it('⋯ 菜单里的「编辑」也走这一条，**但带上 edit: true**——他按的是「我要改」，不该只给他一个查看态', async () => {
    const onOpenDetail = vi.fn();
    show(one, '没有', { density: 'row', onOpenDetail });
    const row = document.querySelector('.ink-trow') as HTMLElement;
    // ⋯ 只在悬停/聚焦时才挂进 DOM，见 TaskRow.tsx。
    fireEvent.mouseEnter(row);
    await pickCardMenu('编辑', { scope: row });
    expect(onOpenDetail).toHaveBeenCalledWith('x', { edit: true });
  });

  it("'E' 键（editRequestId）也走同一条路", async () => {
    const onOpenDetail = vi.fn();
    show(one, '没有', { density: 'row', onOpenDetail, editRequestId: 'x' });
    // 'E' 键在 TaskRow 内部走的就是 onEdit，所以同样带 edit: true。
    await waitFor(() => expect(onOpenDetail).toHaveBeenCalledWith('x', { edit: true }));
  });

  it('openDetailId 指着的那一行标出来——详情在右边、列表在左边，对不上号这个面板就是半残的', () => {
    show(one, '没有', { density: 'row', onOpenDetail: vi.fn(), openDetailId: 'x' });
    const row = document.querySelector('.ink-trow') as HTMLElement;
    expect(row.className).toContain('ink-trow-current');
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('别的行不标，openDetailId 是 null 时一行都不标', () => {
    show(one, '没有', { density: 'row', onOpenDetail: vi.fn(), openDetailId: null });
    expect(document.querySelector('.ink-trow-current')).toBeNull();
  });
});
