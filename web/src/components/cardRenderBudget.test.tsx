import { createElement, memo, useState, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TaskGrid, type GridSection } from './TaskGrid.js';
import { NoMotion, task } from '../test-utils.js';
import type { List } from '../types.js';

/**
 * **一张卡的渲染次数，是有预算的。**
 *
 * 看板/「今天」/「全部」这些屏动辄几十上百张卡，而 `TaskCard`/`TaskRow`
 * 是一整棵带 antd 组件、拖拽、番茄钟的子树——重渲染一张不是「多跑一个函数」，
 * 是把那一整棵再 reconcile 一遍。`App.tsx` 一层挂着 50 个 state：改一个筛选词、
 * 开一次设置弹层、收到一条 SSE，都会让整屏的卡跟着重渲染一遍，而它们的内容
 * 一个字节都没变。
 *
 * **这不是理论上的洁癖，是这个仓库已经付过账的那类缺陷的规模版**：
 * `cardWiring.guard.test.ts` 记着三次「接线漏了、测试全绿、界面两屏不一样」，
 * `statusLabel.guard.test.ts` 记着两次「同一件事写成两份」。那些是**正确性**
 * 问题；这一条是**规模**问题——数据量上去（真攒了几百条任务）之后，每次切
 * 视图都要重渲染一屏，而 React.memo 一次就能把它挡掉。
 *
 * **为什么不能只加 `React.memo`**：memo 比的是 props 的**引用**。进到每张卡上的
 * `onOpen={() => open(t.id)}`、`select={selectWiring}` 这些闭包是**每次渲染现造
 * 的新对象**——memo 加上去，每次仍然判定「props 变了」，一张都挡不住。这就是
 * 为什么这条测试盯**渲染次数**而不是「有没有 memo」：前者是结果，后者只是
 * 手段，而且手段完全可能没生效。
 *
 * **断言写成「不因为无关的 state 变动而重渲染」而不是「渲染了几次」**：前者描述
 * 的是契约（无关变动不该惊动卡片），后者在实现细节变化时会假红。
 */

const NOW = new Date('2026-08-14T12:00:00.000Z');

/**
 * 数**真** `TaskCard` 渲染了几次。
 *
 * `TaskGrid` 里是静态 import（`./TaskCard.js`），所以走 `vi.mock` 部分替换、
 * 在真的 `TaskCard` 外面包一层计数器——渲染的还是原来那棵组件树，只是外面
 * 多了一行 `spy()`。`TaskGrid.test.tsx` 拿同一条路 mock `@dnd-kit` 的
 * `DndContext`，是本仓库既有的做法。
 */
const renderSpy = vi.hoisted(() => ({ calls: 0, props: [] as Array<Record<string, unknown>> }));
vi.mock('./TaskCard.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./TaskCard.js')>();
  // **数的是卡片子树内部那次渲染，不是「元素被重新创建」**——这两件事不是
  // 一回事，而 React 正是把前者省掉了、后者每次都做。
  //
  // 所以这里**自己再 memo 一次**：`TaskCardImpl`（真正干活的那个组件）外面
  // 包一层计数器，外面这层也 `memo`。于是计数器的行为跟真卡片一致——props
  // 没变它就不跑。一次「无关 state 变动」如果真的被挡住了，计数器不会动。
  //
  // 早期版本直接数 `TaskCard` 那个 memo 组件的调用次数，看着像在数渲染，
  // 其实数的是「父组件又创建了一遍元素」——memo 照样挡住了内部的活，计数器
  // 却每次都涨。那条测法会把「已经修好了」报成「没修好」。
  const Spied = (props: Record<string, unknown>) => {
    renderSpy.calls += 1;
    renderSpy.props.push(props);
    return createElement(real.TaskCardImpl as unknown as ComponentType<Record<string, unknown>>, props);
  };
  return { ...real, TaskCard: memo(Spied) };
});

describe('卡的渲染预算', () => {
  it('父级 state 变动、卡片数据没变时，卡不重渲染', () => {
    renderSpy.calls = 0;
    // `stable` 在整条用例里**始终是同一个引用**——模拟「SSE 没推这条任务」。
    const stable = [task({ id: 'a', title: '甲' }), task({ id: 'b', title: '乙' })];

    // `sections` 每次调用产出新数组（这正是各视图的写法），但里面的
    // `Task` 对象是同一批——**这才是常态**：视图重算分组，任务本身没变。
    const sections = (): GridSection[] => [{ key: 'g', title: '组', tasks: stable.slice() }];

    // **回调在组件外造一次**，不是每次渲染现造——这是调用方（`App.tsx`）
    // 必须守住的那一半。写在渲染体里的 `onPatch={() => …}` 每渲染一次就是
    // 一个新函数，memo 比引用时判定「props 变了」，卡片照样全量重渲染：
    // **卡自己那一半（memo）做了，调用方这一半没做，等于没做。**
    const onPatch = vi.fn();
    const onEditTask = vi.fn(async () => ({}));
    const onDelete = vi.fn();
    // `lists` 同理——渲染体里的字面量 `[]` 每渲染一次就是一个新数组。
    // 真实链路里 `App.tsx` 的 `lists` 是 state，本来就稳定；这里写死一份
    // 是为了让夹具跟那条约定一致，而不是替它掩饰一个假的「不稳定」。
    const lists: List[] = [];

    const Harness = () => {
      const [tick, setTick] = useState(0);
      return (
        <NoMotion><AntApp>
          <TaskGrid
            sections={sections}
            empty="没有"
            now={NOW}
            lists={lists}
            allTasks={stable}
            onPatch={onPatch}
            onEditTask={onEditTask}
            onDelete={onDelete}
          />
          <button type="button" onClick={() => setTick((n) => n + 1)}>无关变动 {tick}</button>
        </AntApp></NoMotion>
      );
    };

    render(<Harness />);
    const baseline = renderSpy.calls;
    expect(baseline).toBeGreaterThan(0);

    // 一次**完全无关**的父级 state 变动：数据一个字节没变。
    // 用 `fireEvent.click` 而不是 `document.querySelector('button')`——
    // 卡片自己也有 button（⋯ 菜单那些），前者会点中第一颗，不是这一颗。
    fireEvent.click(screen.getByRole('button', { name: /无关变动/ }));

    // 关键断言：卡片探针的渲染次数**不因为这个无关变动而增加**。
    // 诊断放在断言**前面**：诊断失败时抛出的信息直接点名是哪个 prop 在变，
    // 比「expected 4 to be 2」有用得多——后者只说「变了」，不说「哪个」。
    if (renderSpy.calls !== baseline) {
      // 第二次渲染的那一批从 index `baseline` 开始——按**同一张卡**的前后两
      // 份比（错位比会拿 A 卡跟 B 卡比，报出来的键全是噪音）。
      const changed = new Set<string>();
      for (let i = 0; i < baseline; i++) {
        const before = renderSpy.props[i];
        const after = renderSpy.props[baseline + i];
        if (!after) continue;
        Object.keys({ ...before, ...after }).forEach((k) => {
          if (before[k] !== after[k]) changed.add(k);
        });
      }
      throw new Error(`这些 prop 的引用变了，memo 因此拦不住：${[...changed].join(', ')}`);
    }
    expect(renderSpy.calls).toBe(baseline);
  });
});