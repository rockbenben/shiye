import { useEffect, useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Button, ConfigProvider } from 'antd';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import type { List, Task, WeekStart } from '../types.js';
import { applyMove, isDoneToday, isInTodayView, isTaskOverdue, moveTo, sortTodayOrder } from '../lib/taskView.js';
import { FIRST_RUN_HINT, isFirstRun } from '../lib/firstRun.js';
import { todayMetaLabel } from '../lib/workload.js';
import { habitStreak } from '../lib/habit.js';
import { boardLocalTheme } from '../theme.js';
import type { Density } from '../lib/density.js';
import { useCancelStuckDrag } from '../lib/dnd.js';
import { clickToSelection, type SelState } from '../lib/selection.js';
import { TaskCard, type DragHandleProps } from './TaskCard.js';
import { TaskRow } from './TaskRow.js';
import { HabitStreak } from './HabitStreak.js';
import { hasPendingProposal, type ProposalWiring } from './ProposalNote.js';

interface Props {
  /** 刚勾完、还在原地划着删除线的那几条（仿滴答清单：勾完先划掉、停一下再
   *  移走）。跟 `editingIds` 并列进同一个「先别让它走」的判断；下面
   *  「今天完成的」那一节要把它们排掉，不然同一条同时出现在两处。
   *  可选，默认空集——不给就是加这个 prop 之前的行为（勾完当场落到下面）。 */
  linger?: Set<string>;
  /** 一周从周几开始（`Settings.weekStart`）——每周那种习惯的「本周 N/M」靠它，
   *  跟日历那七列、专注统计的「本周」必须是同一个数。不给按周一。 */
  weekStart?: WeekStart;
  tasks: Task[];
  now: Date;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onEditTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
  onDelete: (id: string) => void;
  proposals?: ProposalWiring;
  /** 手动排序的写入口。**不在这里更新本地状态**——跟这个仓库其余所有写操作
   * 同一条规矩：写完文件，等 SSE 推 data-changed 回来 reload，界面才跟着变。
   * 这里只管发起写、等结果、把结果播报给用户；失败要能被这里 catch 到并
   * 说清楚，不能吞掉装作什么都没发生——重排也是一次写，见规格「架构不变式」。 */
  onReorder: (pairs: Array<{ id: string; order: number }>) => Promise<unknown>;
  /** 转交给每张 TaskCard。 */
  lists: List[];
  /**
   * 选中态（批量操作的地基）。**跟 `TaskGrid.tsx` 的那两个是同一份语义、
   * 同一个 `clickToSelection`**，不是另起一套——两个都给了才接线，只给一个
   * 没有意义。
   *
   * 为什么补：这个应用最常用的视图恰恰是唯一不能多选的那个。「把今天这五条
   * 一起推到明天」是最典型的批量需求，而它在「今天」里做不到——`D`/`T`/`M`/
   * `W`/`Delete` 这一整套快捷键也跟着够不着，它们全都作用在选中集合上。
   * 当初的范围是「只做 TaskGrid」（`App.tsx` 那份 `gridWiring` 的注释里写着），
   * 「今天」和「按来源」两个手写 props 的视图就这么落在了外面。
   *
   * 「按来源」这一轮仍然没有：那个视图是 Masonry 瀑布流，**看到的顺序跟数组
   * 顺序对不上**（卡片按列高填进不同的列），而 Shift 连选要的正是「屏幕上
   * 看到的那个顺序」——`TaskGrid` 里那份 `orderedIds` 的注释说的就是这件事。
   * 这个视图是普通网格/单列，DOM 顺序就是视觉顺序，没有那个问题。
   */
  selection?: SelState;
  onSelectionChange?: (next: SelState) => void;
  /**
   * 「把这几条过期的改到今天」。收的是**屏幕上那几条**（这个列表里过期的
   * 那一批），不是「全表所有过期的」——一颗按钮改掉几条看不见的任务，比没有
   * 这颗按钮糟得多。跟「接下来」那颗组头按钮同一条规矩。
   *
   * 不给就不画这颗按钮：它要发请求、还要先弹一句确认，调用方没接就不该摆
   * 这个入口。
   *
   * 为什么摆在这儿：上面那行刚报完「12 条（9 条已过期）」——**看见了债，却
   * 没有就地还债的地方**。这个动作原来只在命令面板和「接下来」的组头上有，
   * 而「今天」是最常看见这个数字的地方。
   */
  onDeferOverdue?: (overdue: Task[]) => void;
  /** 转交给每张 TaskCard——番茄钟一轮的时长，见 TaskCard.tsx CardProps 的
   *  注释。可选、不给就是 TaskCard 自己的默认值。 */
  focusMinutes?: number;
  /** 一轮走完之后歇多久，分钟——原样转交给每张 TaskCard，见那边的注释。 */
  breakMinutes?: number;
  /** 「创建副本」，只是转交给每张 TaskCard。 */
  onDuplicate?: (t: Task) => void;
  /**
   * 跳过这一次 + 检查事项转子任务，只是转交给每张 TaskCard。**不给 `onSkip`
   * 的话那张卡的「跳过」会退回发一条普通 patch，服务端把它记成一次拖延**——
   * 这两个视图不走 `gridWiring`（手写 props），就是在这儿漏过一次，
   * 见 `cardWiring.guard.test.ts`。
   */
  onSkip?: (id: string) => void;
  onPromoteSubtask?: (t: Task, index: number) => void;
  /** 转交给每张 TaskCard 再转交给 Attachments——离线记号（task-3-brief），
   *  见 TaskCard.tsx CardProps.offline 的注释。可选、不给就是 TaskCard 自己
   *  的默认值 false。 */
  offline?: boolean;

  /**
   * 「打开一条任务」交给右边那一栏详情面板（仿滴答清单），不让那一行当场
   * 膨胀成一张卡。**给了就换行为，不给就是原来那样**——跟 `TaskGrid` 的
   * 同名 prop 一字不差，理由整段在 TaskDetail.tsx 顶部。
   */
  onOpenDetail?: (id: string, opts?: { edit?: boolean }) => void;

  /** 面板现在摊着哪一条——那一行要标出来。跟 `TaskGrid` 的同名 prop 一字
   *  不差，见那边的注释。 */
  openDetailId?: string | null;
  /**
   * 行/卡密度（task-5-brief）。**默认 `'card'`——今天的行为不变**，只有
   * `App.tsx` 把 `'today'` 加进 `DENSITY_VIEWS` 之后才会传 `'row'`。
   *
   * **这里手写 row/card 分支，不复用 `TaskGrid.tsx` 那份**——`TaskGrid` 的
   * 分支没有 `rank`/`move`/`drag`，这个视图必须保留手动排序（brief 原话：
   * 「这不是五行接线，单开一个 Task」），`TaskRow` 也因此多出了 `drag`/
   * `move` 这两个只有这里会传的 prop，见 `TaskRow.tsx` 的注释。
   */
  density?: Density;
}

/** 写成功之后最多等多久让 `tasks` 这个 prop 刷新到写入的新顺序——正常链路是
 * 文件监听器（≥200ms 去抖）→ SSE → reload，几百毫秒内会到。这只是兜底：
 * SSE 断线、reload 请求恰好失败之类的意外发生时，按钮不能永远卡在禁用状态，
 * 该干嘛就没法接着干嘛，比「多等几秒才能再点一次」更糟。 */
export const REORDER_CONFIRM_TIMEOUT_MS = 4000;

interface ReorderStatus {
  id: string;
  /** 只有按钮那条路有方向——落定之后要靠它决定把焦点还给上移还是下移那颗。
   * 拖放没有方向（也不需要还焦点，鼠标用户的焦点本来就不在按钮上），传 null。 */
  direction: 'up' | 'down' | null;
  /** null：写请求还在飞。非 null：写已经成功，这是期望 `tasks` 刷新之后
   * 应该体现出来的 id→order 映射，还没等到匹配的刷新。 */
  pairs: Array<{ id: string; order: number }> | null;
}

/** dnd-kit 的 `over`/`active` 会话数据（跨容器场景才会有 `sortable`
 *  字段）——「今天」只有一个容器，这里其实用不上，但 `handleDragEnd` 的
 *  `active.id`/`over.id` 已经是 `UniqueIdentifier`（`string | number`），
 *  统一转成 `String(...)` 再跟任务 id 比较,避免类型不对齐。 */

/**
 * 单条可拖拽的行——调用 `useSortable`，把结果转成 `DragHandleProps` 喂给
 * `children`（渲染 `TaskCard`/`TaskRow` 那部分）。**必须是独立的模块级
 * 组件**，不能内联写在 `.map()` 回调里，理由跟 `TaskGrid.tsx` 的
 * `SortableTaskItem` 一样——`useSortable` 是 hook，列表条数会变，内联调用
 * 违反 Hooks 规则。
 *
 * `role="listitem"`、`.ink-today-row` 这层容器挂在这里——以前手写的
 * `<div role="listitem" className="ink-today-row ...">` 是同一个 DOM 位置。
 * `.ink-row-dragging` 现在用 `isDragging`（dnd-kit 自己算的），不用我们
 * 自己的 `dragId` state 比较；`.ink-row-pending`（拖放提交中、等确认刷新）
 * 是调用方按 `status` 算好传进来的 `pendingClass`，这半跟拖拽机制无关，
 * 原样透传。
 */
function SortableTodayRow({
  id, disabled, dragTitle, pendingClass, children,
}: {
  id: string;
  disabled: boolean;
  dragTitle: string;
  pendingClass?: string;
  children: (drag: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
    transition: transition ?? undefined,
  };
  const className = ['ink-today-row', pendingClass, isDragging ? 'ink-row-dragging' : ''].filter(Boolean).join(' ');
  return (
    <div role="listitem" ref={setNodeRef} style={style} className={className}>
      {children({ title: dragTitle, disabled, attributes, listeners, setActivatorNodeRef })}
    </div>
  );
}

/**
 * 「今天」：我现在该干哪个。跟「按来源」并列的顶层视图，见
 * 已归档的 docs/superpowers/specs/2026-08-12-today-view.md。不分组，只有一份按 order
 * 排的扁平列表——分组回答的是「这条哪来的」，今天不需要回答这个。
 */
/** 默认空集提到模块层：写成默认参数每次渲染都是新对象，白白让依赖比较判成「变了」。 */
const EMPTY_LINGER: Set<string> = new Set();

export function TodayView({ tasks, now, onPatch, onEditTask, onDelete, onReorder, onDuplicate, onSkip, onPromoteSubtask, proposals, lists, focusMinutes, breakMinutes, offline, onOpenDetail, openDetailId, density = 'card', selection, onSelectionChange, onDeferOverdue, linger = EMPTY_LINGER, weekStart = 1 }: Props) {
  const { message } = AntApp.useApp();
  // 正在编辑的任务 id：编辑到一半如果因为改了截止时间等原因掉出了「今天」的
  // 成员资格，筛选重算不该把编辑框连带草稿一起卸载掉——跟 TaskBoard 的
  // editingIds 同一个套路。
  //
  // 跟 TaskGrid.tsx 同一份坑：行档接上「点标题展开成卡」之后（下面
  // onOpen={() => setEditing(t.id, true)}），这份 state 同时承担了两个语义——
  // 「有没保存的草稿，别卸载」和「用户点开看了一眼，还没编辑」，因为复用的是
  // 同一份 state，没有另起一套「展开」集合。副作用：`visible` 的成员资格判断
  // （下面 `isInTodayView(t, now) || editingIds.has(t.id)`）会把「只是看了一眼」
  // 的卡也当成正在编辑的卡一样，不受「今天」的成员资格约束。这一点只在「打开
  // 着」的这段时间成立，效果上跟一张真在编辑的卡一致，可以接受——写在这里
  // 是为了让下一个读到这段代码的人不用重新想一遍。
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const setEditing = (id: string, editing: boolean) =>
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (editing) next.add(id);
      else next.delete(id);
      return next;
    });

  // 一次移动的完整状态机：非 null 表示「有一次移动还没有落定」——从点击那一刻
  // 起，到写成功*并且*确认 tasks 这个 prop 已经刷新到写入的新顺序为止。这段
  // 时间里全部卡的上/下移按钮都禁用，不只是被点的那一张——见下面 status 用途
  // 的注释和 MoveControls.busy 的类型注释。
  const [status, setStatus] = useState<ReorderStatus | null>(null);
  // 键盘用户点了上/下移之后，屏幕阅读器要能听到发生了什么——重排写完之前
  // 页面不会有任何视觉变化（等 SSE 回来才重绘），这条播报是唯一「马上」告诉
  // 用户结果的通道，成功、失败都播。`seq` 每次播报都自增、当 `key` 用在
  // 承载文字的元素上：连续两次播报同一句话（比如两次一样的失败）时，只改
  // state 里的字符串不会触发 DOM 变化（React 认为「没变」），屏幕阅读器听
  // 不到第二次；用 `key` 强制换一个新的 DOM 节点，保证每次播报都是一次真实
  // 的 DOM mutation。
  const [announce, setAnnounce] = useState({ seq: 0, text: '' });
  const say = (text: string) => setAnnounce((prev) => ({ seq: prev.seq + 1, text }));

  // 每张卡的上/下移按钮的原生 DOM 节点——写完、确认刷新到达之后，浏览器早就
  // 把焦点从「被禁用的按钮」打回了 <body>，要把它找回来只能靠这份引用，
  // React 状态里存不了 DOM 节点本身。
  const buttonRefs = useRef(new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>());
  const setButtonRef = (id: string, dir: 'up' | 'down', el: HTMLButtonElement | null) => {
    const entry = buttonRefs.current.get(id) ?? { up: null, down: null };
    entry[dir] = el;
    buttonRefs.current.set(id, entry);
  };
  // 记「最近一次点的是哪张卡、哪个方向」——status 落定变回 null 的时候要靠它
  // 决定把焦点还给谁，但那一刻 status 本身已经没有这份信息了（三条落定路径
  // ——失败、确认刷新、兜底超时——分别把它清成 null）。
  const lastMoveRef = useRef<{ id: string; direction: 'up' | 'down' } | null>(null);

  /**
   * **这一排是平的，过期的和今天要做的混在一起——这是有意的，不打算改。**
   *
   * 滴答清单的「今天」把过期的单独分一组。这里做不了，而且不是画不出来那种
   * 做不了：这个视图的顺序是**他自己拖出来的**（`order`，一条全局序列），
   * 而「过期 / 今天」是从 `due` 现算的。两者一分组就处处打架——
   *
   * - 跨组拖是什么意思？组是按 `due` 分的，拖过去只能是改期，而这个视图的
   *   拖拽一直是排序，一个手势两种含义；
   * - 上下移那两颗按钮到了组边界该怎么办；
   * - 播报那句「移到第 N 位，共 M 条」是组内还是全表；
   * - `order` 只有一条序列，分组之后「第几位」不再对应它。
   *
   * 补偿在别处，而且是够的：**卡片上写着「过期 3 天」**（不只是「已过期」，
   * 见 `lib/taskView.ts` 的 `overdueLabel`），一眼看得出哪几条欠得久；「接下来」
   * 有真正的「已过期」分组，组头上还有「全部推到今天」；命令面板里那条
   * 「把 N 条过期的改到今天」从这个视图也叫得出来。
   */
  // `linger`：刚勾完的那几条**先留在原地划着删除线**，1.2 秒后才落到下面
  // 「今天完成的」那一节去（仿滴答清单，判据和时长在 App.tsx 的 startLinger）。
  // 这里跟 `editingIds` 并列进同一个「先别让它走」的判断——两者要的是同一
  // 件事。下面 `doneToday` 要把它们排掉，不然同一条会同时出现在两个地方。
  const visible = tasks.filter((t) => isInTodayView(t, now) || editingIds.has(t.id) || linger.has(t.id));
  const ordered = sortTodayOrder(visible, now);
  // 今天做完的。**最近做完的排最前**——刚点错的那一条该在手边，不是翻到底下
  // 去找，跟垃圾箱里「最近删的排最前」同一条。
  const doneToday = tasks.filter((t) => isDoneToday(t, now) && !editingIds.has(t.id) && !linger.has(t.id))
    .sort((a, b) => (Date.parse(b.completedAt ?? '') || 0) - (Date.parse(a.completedAt ?? '') || 0));
  const meta = todayMetaLabel(ordered, now);
  // 上面那行报的「N 条已过期」数的是哪几条，这颗按钮推的就是哪几条——同一份
  // 判据（`isTaskOverdue`），不让数字和动作各算各的。
  const overdueHere = ordered.filter((t) => isTaskOverdue(t, now));

  /**
   * 每张卡的选中态接线。**跟 `TaskGrid.tsx` 里那份逐字同构**（那边是正本）：
   * 两个 prop 都给了才接，`showCheckbox` 是「全局选中集合非空」而不是每张卡
   * 自己决定，连选的顺序取**真正会渲染的那一份**（`ordered`，已经排过序、
   * 置顶提过前了），不是原始的 `tasks`。
   */
  const orderedIds = ordered.map((t) => t.id);
  const selectFor = (id: string) => (selection && onSelectionChange ? {
    selected: selection.ids.has(id),
    showCheckbox: selection.ids.size > 0,
    onClick: (mods: { shift: boolean; ctrlOrMeta: boolean }) =>
      onSelectionChange(clickToSelection(selection, orderedIds, id, mods)),
  } : undefined);

  /**
   * 一次重排的提交路径。**按钮和拖放共用这一段**——两条路只在「怎么算出
   * pairs」上不同（换一格 vs 指定落点），落定规则、播报、失败处理、等待
   * 刷新确认全都一样。分成两份写的话，迟早出现「拖出来的顺序」和「按出来的
   * 顺序」行为不一致。
   */
  const commit = async (id: string, direction: 'up' | 'down' | null, pairs: Array<{ id: string; order: number }>) => {
    const title = ordered.find((t) => t.id === id)?.title ?? '';
    lastMoveRef.current = direction ? { id, direction } : null;
    setStatus({ id, direction, pairs: null });
    try {
      await onReorder(pairs);
      const idx = pairs.findIndex((p) => p.id === id);
      say(`${title} 移到第 ${idx + 1} 位，共 ${pairs.length} 条`);
      // 写成功了，但不能现在就解禁——tasks 这个 prop 还是写之前那份，界面
      // 上什么都没变。转成「等待确认」，让下面的 effect 盯着 tasks 什么时候
      // 真的追上来。
      setStatus({ id, direction, pairs });
    } catch (e) {
      const detail = (e as Error).message;
      say(`移动失败：${detail}`);
      void message.error(detail);
      // 失败：文件没有被这次移动改过，列表本来就是准的，不用等任何刷新，
      // 立刻放开。
      setStatus(null);
    }
  };

  const move = (id: string, direction: 'up' | 'down') => {
    const pairs = applyMove(ordered, id, direction);
    if (!pairs) return;
    void commit(id, direction, pairs);
  };

  // ── 拖放（task-3-brief：原生 HTML5 拖放换成 @dnd-kit，键盘也能拖）──
  // 抓手仍然是右侧留白里那个序号（.ink-rank）：它本来就是「这张卡排第几」
  // 的视觉表达，让它同时成为改这个数的把手，是这个界面里最不需要解释的
  // 一处。也仍然刻意**不**把整张卡设成可拖拽区——那会让卡里的备注没法选中、
  // 从按钮上起拖也很怪，见下面 SortableTodayRow/`.ink-rank` 的接线。
  // 键盘路径不受影响：上/下移按钮原样保留，拖放是鼠标/键盘都能用的补充，
  // 见 2026-08-12-today-view.md「键盘必须能用」——这也是这个 Task 换成
  // @dnd-kit 之后的主要收益：以前拖放是鼠标独占的，现在 Tab 到抓手→Space
  // 拿起→方向键移动→Space 放下也能达成同样的效果。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 拖拽会话的 id 追踪——只用来喂 `useCancelStuckDrag`（`lib/dnd.ts`）：被拖
  // 的那一行如果在拖动中途从 `ordered` 里消失，键盘会话会卡死收不到下一次
  // Space（`@dnd-kit` 的已知行为，那个函数的注释里有完整说明和为什么修法是
  // 派发一次 Escape、不是重挂组件树——重挂会把这个列表里其它正在编辑的卡的
  // 未保存草稿一起清空，见 task-3-report.md 修复轮 1 · I2/C1）。
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  useCancelStuckDrag(activeDragId, ordered.some((t) => t.id === activeDragId));

  /**
   * 拖拽落定。**两条守卫都在这里**：
   *
   * ① **外来拖拽不转发**：`@dnd-kit` 只在自己的 `DndContext` 里派发
   * `active`/`over`——选中一段文字拖进来走的是浏览器原生 Drag and Drop
   * API，`@dnd-kit` 完全不监听那套事件（组件树里不再有任何
   * `onDragOver`/`onDrop` 原生属性），`handleDragEnd` 天然进不来外来拖拽。
   *
   * ② **拖回原地不发回调**：`over` 为 `null`（拖出了列表范围）在这里
   * `!over` 直接返回；`over` 就是自己或者算出来的目标下标等于原下标——两种
   * 都会让 `moveTo` 返回 `null`（`taskView.ts` 里 `from === to` 那条判断，
   * 跟按钮那条路复用同一个函数），不需要在这里重复判断一遍「有没有变化」。
   */
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    // 会话到这里就算真的结束了（不管接下来是不是真的提交一次写）——
    // `activeDragId` 只是给 `useCancelStuckDrag` 判断「有没有会话在进行」用的，
    // 这里清空跟下面要不要 commit 是两件事。
    setActiveDragId(null);
    // status 非空：上一次移动（按钮或拖放）还没落定。`useSortable({disabled:
    // status !== null})` 挡住的是「拿起」这一步，挡不住「已经拿起、status
    // 才变化」这种时序——键盘会话开着的同时，用户用鼠标点了另一行的上/下移
    // 按钮触发了一次新的提交，落地这一刻 status 已经不是 null 了，不能再拿
    // 这次的 `ordered`（对应的是提交前那份旧顺序）去算 pairs，跟原生实现
    // `onDrop` 里 `if (!id || status) return` 的这一半是同一条理由，@dnd-kit
    // 化的第一版漏掉了，这里补回来（task-3-report.md 修复轮 1 · m1）。
    if (!over || status) return;
    const id = String(active.id);
    // 拖到一半、被拖的那条从 ordered 里消失了（SSE 把它标成完成/删了/
    // 提醒触发……都可能）：这一刻它对应的 SortableTodayRow 早就卸载了，
    // `active`/`over` 里的 id 是陈旧的——不发一个打不中真实任务的写请求，
    // 跟 TaskGrid.tsx handleDragEnd 同一条理由。
    if (!ordered.some((t) => t.id === id)) return;
    const toIndex = ordered.findIndex((t) => t.id === String(over.id));
    if (toIndex < 0) return;
    const pairs = moveTo(ordered, id, toIndex);
    if (!pairs) return;
    void commit(id, null, pairs);
  };

  /**
   * 拖放提交期间，被移动的那张卡压暗。
   *
   * 按钮那条路在等待落定的这几秒里会让被点的按钮转圈；拖放没有按钮可转，
   * 而 `tasks` 刷新回来之前列表还是旧顺序——松手之后卡片会**当着你的面弹回
   * 原位**，一点提示都没有。SSE 慢一点或者丢了，这个状态能持续整整 4 秒，
   * 读起来就是「拖失败了」。
   */
  const pendingId = status && status.direction === null ? status.id : null;

  // 确认刷新到达：tasks 里每一条待确认的 id，要么已经不在了（这期间被删了，
  // 不用再等它），要么 order 已经等于这次写入的目标值。全部满足就算「刷新
  // 追上了」，放开按钮。
  useEffect(() => {
    if (!status?.pairs) return;
    const confirmed = status.pairs.every((p) => {
      const t = tasks.find((x) => x.id === p.id);
      return !t || t.order === p.order;
    });
    if (confirmed) setStatus(null);
  }, [tasks, status]);

  // 兜底：等待确认的这段时间开始计时，正常情况下会被上面那个 effect 先一步
  // 放开（status 变化触发这个 effect 的清理，定时器被取消）；只有刷新真的
  // 没在预期时间内到达时才会真的触发。
  useEffect(() => {
    if (!status?.pairs) return;
    const timer = setTimeout(() => setStatus(null), REORDER_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // status 落定回 null（不管是失败、确认刷新、还是兜底超时）之后，把焦点还
  // 给刚才操作的那张卡：优先还给原来点的那个方向，如果它在新位置上越界禁用
  // 了（比如一路下移到了最后一位），退到同一张卡的另一个方向；两个都没有
  // （卡片这期间被删了）就不勉强，落回浏览器默认的 <body>。
  useEffect(() => {
    if (status !== null) return;
    const last = lastMoveRef.current;
    if (!last) return;
    lastMoveRef.current = null;
    const refs = buttonRefs.current.get(last.id);
    if (!refs) return;
    const primary = last.direction === 'up' ? refs.up : refs.down;
    const secondary = last.direction === 'up' ? refs.down : refs.up;
    const target = primary && !primary.disabled ? primary : secondary && !secondary.disabled ? secondary : null;
    target?.focus();
  }, [status]);

  // 抓手的提示文案——锁定态跟解锁态换口——所有行共用同一份 status，算一次
  // 就够，不用在 .map() 里逐行重算。
  const dragTitle = status === null ? '拖动可以调整顺序' : '上一次调整还没落定';

  return (
    <ConfigProvider theme={boardLocalTheme}>
      {/* 「按来源」给每一组都包了 <section aria-labelledby> + <h2>——不然渲染出来
          是一个没有名字的 region，标题导航（屏幕阅读器按 H 跳）也无从可跳，见
          TaskBoard.tsx 的 GroupSection。这个视图取代了原来的默认落地页，同一条
          道理没有理由不适用：没有 heading、没有 list 语义、没有可读的条数，
          屏幕阅读器用户落地就是一堆裸 div。heading 用 ink-sr-only（视觉上不
          占地方）——顶部「今天」标签页按钮已经在视觉上说清楚了这是哪个视图，
          再画一遍纯属重复；下面 .ink-source-meta 的条数是给所有人看的，不是
          只给屏幕阅读器。 */}
      <section aria-labelledby="ink-today-heading">
        <h2 id="ink-today-heading" className="ink-sr-only">今天要做的</h2>

        {/* 视觉上不占地方，屏幕阅读器会念出内容变化——不用 aria-live="assertive"：
            移动结果不紧急到需要打断用户正在做的别的事。 */}
        <p aria-live="polite" className="ink-sr-only" key={announce.seq}>{announce.text}</p>

        {ordered.length === 0 ? (
          // 一行安静的字，不是 antd 自带的 Empty 插画——见 theme.css 里
          // .ink-empty-note 的注释。
          // 「今天很闲」和「整个应用还是空的」不是同一句话，见 lib/firstRun.ts。
          <p className="ink-empty-note">{isFirstRun(tasks) ? FIRST_RUN_HINT : '今天没有要做的'}</p>
        ) : (
          <>
            {/* 这一行回答两个问题：**今天这一堆是什么形状**（几条、其中几条
                是欠着的债——这一排是平的，过期的和今天要做的混在一起，见上面
                `visible` 那段长注释），和**今天排得下吗**（预计多久，七条任务
                每条看着都不大、加起来六小时这件事只有在有人加起来的时候才看得
                见）。整句怎么拼在 lib/workload.ts，数的是跟这个列表完全同一批
                任务，几个数字不会各说各的。 */}
            <p className="ink-source-meta ink-mono">
              {meta}
              {/* 「改到」不是「推到」：同一个动作在确认框（「把 N 条过期的改到
                  今天？」）、命令面板（「把 N 条过期的改到今天」）和事后那句提示
                  （「N 条过期的改到了今天」）里都叫「改到」，只有这两颗按钮
                  （这里 + App.tsx 的分组头）叫「推到」。而这个应用里「推」另有
                  其事——「推迟 1 小时」「推迟过 4 次」说的是往后拖，不是
                  「挪到今天」。 */}
              {onDeferOverdue && overdueHere.length > 0 && (
                <Button
                  size="small"
                  type="text"
                  style={{ marginInlineStart: 8 }}
                  onClick={() => onDeferOverdue(overdueHere)}
                >全部改到今天</Button>
              )}
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={({ active }) => setActiveDragId(String(active.id))}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveDragId(null)}
            >
              <div className="ink-today-list">
                {/* 容器按密度二选一——跟 TaskGrid.tsx 同一条规矩（task-3-brief 第二
                    条要点「行档改单列」，五个列表类视图里「今天」是唯一不经过
                    TaskGrid 的那个，这里手写一份同样的判断）：卡档（默认）两列
                    网格 .ink-card-grid，行档单列封顶 .ink-row-list。 */}
                <div className={density === 'row' ? 'ink-row-list' : 'ink-card-grid'} role="list">
                  {/* 序号排在卡片右上角。它曾经和「按来源」的边注共用卡片右侧那条
                      250px 的留白（规格里「同一条留白，两种占用」那节）——卡片改成
                      网格/瀑布流之后版面全用来铺列，那条留白没有了，序号进卡片、
                      边注也进卡片。序号用石墨黑、不斜体、不衬线镶边——那一整套是
                      「这是另一个人写的」的记号，专属边注，序号是人自己的字迹，
                      不借那套视觉语言。

                      这个数字不携带边注那样的新信息，它是当前列表顺序的视觉重复
                      （屏幕阅读器已经能从 role="listitem" 的顺序、以及移动后
                      aria-live 播报的「移到第 N 位」听到同样的信息）——**这条
                      理由本身没变，但落地方式变了**（复审修复轮 1 · I3/I4）：
                      「今天」这里 `rank` 永远和 `drag` 成对传，`.ink-rank` 因此
                      永远是一个可拖拽/可键盘操作的抓手，不能再整个 `aria-hidden`
                      （那样会把它从可达性树里连同它的拖拽功能一起摘掉，键盘用户
                      够不到）。现在的做法是 `TaskCard.tsx` 给这个节点摊了一份
                      `aria-label={drag.title}`（比如「拖动可以调整顺序」）——
                      `aria-label` 存在时会整个盖过「用节点内容当可访问名字」这条
                      默认规则，效果上数字依然不会被当成这张卡的名字重复念一遍，
                      只是换成了标签覆盖，不是从可达性树里剔除。 */}
                  <SortableContext items={ordered.map((t) => t.id)} strategy={rectSortingStrategy}>
                    {ordered.map((t, i) => (
                      <SortableTodayRow
                        key={t.id}
                        id={t.id}
                        disabled={status !== null}
                        dragTitle={dragTitle}
                        pendingClass={pendingId === t.id ? 'ink-row-pending' : undefined}
                      >
                        {(drag) => (
                          <>
                            {/* 打卡条：只在「今天」画——HabitStreak.tsx 只从这里被引用，
                                TaskCard 不认识它，别的视图共用的还是裸 TaskCard，见
                                HabitStreak.tsx 顶部注释。history 要用完整的 `tasks`
                                （不是 `ordered`/`visible`）：同一个习惯已经打过卡的
                                历史实例 status 是 done，早就被「今天」的成员资格筛掉了，
                                算连续天数不能只看这一张卡自己还留在列表里的这份。
                                compact（task-5）：行档下收窄间距，见 HabitStreak.tsx
                                的注释——打卡是这类任务的全部意义，行档不丢它。 */}
                            <HabitStreak habit={habitStreak(tasks, t, now, weekStart)} compact={density === 'row'} />
                            {/* move 每行各算一次（依赖 i，跨行不同）——不是各写一份：
                                拖放/上下移在两档密度之间会慢慢漂开（跟 commit() 顶部
                                「按钮和拖放共用同一段」同一条理由，见那处注释）。 */}
                            {(() => {
                              const moveControls = {
                                onUp: () => void move(t.id, 'up'),
                                onDown: () => void move(t.id, 'down'),
                                canMoveUp: i > 0,
                                canMoveDown: i < ordered.length - 1,
                                busy: status !== null,
                                loadingUp: status?.id === t.id && status.direction === 'up',
                                loadingDown: status?.id === t.id && status.direction === 'down',
                                upRef: (el: HTMLButtonElement | null) => setButtonRef(t.id, 'up', el),
                                downRef: (el: HTMLButtonElement | null) => setButtonRef(t.id, 'down', el),
                              };
                              // 行档、且这张卡没被「打开」：紧凑的一行，没有 TaskCard 那个
                              // 大号 rank 数字（brief 明写「行里不要那个大数字」）——排序
                              // 靠悬停/聚焦才出现的抓手和收进「更多」的上/下移，见
                              // TaskRow.tsx 的注释。点标题（onOpen）复用既有的
                              // editingIds/setEditing——跟 TaskGrid.tsx 的 density 分支
                              // 同一个套路：不新起一个「展开」状态，`setEditing` 之后这张
                              // 卡的 id 进了 editingIds，下一次渲染落进下面的 TaskCard
                              // 分支（默认查看态，不是表单）。「今天」没有分组，不需要
                              // TaskGrid 那份「钉回原来那一组」的 `home` 逻辑。
                              return density === 'row' && !editingIds.has(t.id) ? (
                                <TaskRow
                                  t={t}
                                  now={now}
                                  onPatch={onPatch}
                                  onOpen={() => (onOpenDetail ? onOpenDetail(t.id) : setEditing(t.id, true))}
                                  // 算式提成了 ProposalNote.tsx 的 hasPendingProposal，
                                  // 跟 TaskGrid.tsx 共用同一份（整分支审查 B1：以前这里
                                  // 自己复制了一份一模一样的表达式，零测试跟着）。
                                  hasProposal={hasPendingProposal(proposals, t.id)}
                                  drag={drag}
                                  move={moveControls}
                                  current={openDetailId != null && t.id === openDetailId}
                                  select={selectFor(t.id)}
                                  // 「今天」的行档原来这几个都不给，于是这一档
                                  // **既没有 ⋯ 菜单也没有右键菜单**——那句「想用
                                  // 那几项就切回卡片档」是当时的结论。现在给上：
                                  // 右上角那颗 ⋯ 在这一档仍然归 ↑/↓ 用（TaskRow
                                  // 里 `!move` 那条分支挡着，那条焦点契约不能断），
                                  // 而**右键不跟它抢位置**，正好把那几项接回来。
                                  lists={lists}
                                  allTasks={tasks}
                                  onEdit={(id) => (onOpenDetail ? onOpenDetail(id, { edit: true }) : setEditing(id, true))}
                                  onDelete={onDelete}
                                />
                              ) : (
                                <TaskCard
                                  t={t}
                                  now={now}
                                  lists={lists}
                                  // 全表：多级任务那两个记号要查父亲/数孩子。
                                  // 这个视图本来就收着全部任务（它自己筛出
                                  // 「今天」那一份），不用新加 prop。
                                  allTasks={tasks}
                                  onDuplicate={onDuplicate}
                                  onSkip={onSkip}
                                  onPromoteSubtask={onPromoteSubtask}
                                  onPatch={onPatch}
                                  onEditTask={onEditTask}
                                  onDelete={onDelete}
                                  onEditingChange={setEditing}
                                  proposals={proposals}
                                  focusMinutes={focusMinutes}
                                  breakMinutes={breakMinutes}
                                  offline={offline}
                                  rank={i + 1}
                                  drag={drag}
                                  move={moveControls}
                                  select={selectFor(t.id)}
                                />
                              );
                            })()}
                          </>
                        )}
                      </SortableTodayRow>
                    ))}
                  </SortableContext>
                </div>
              </div>
            </DndContext>
          </>
        )}
        {/* 今天做完的。**默认折叠**：一天做完十几件事之后，展开着会把真正
            要做的那几条挤到屏幕外面——而这一节要回答的是「我今天干了什么」，
            那是回头看的问题，不是此刻要做决定的问题。
            用原生 <details>，跟编辑表单那几组一样：折叠状态是浏览器管的，
            不用为它存一份偏好，也不用写开合的交互。
            **不进上面那个拖拽列表**：手动排序排的是「接下来先做哪个」，
            已经做完的没有先后可言。 */}
        {doneToday.length > 0 && (
          <details className="ink-today-done">
            <summary className="ink-more-summary">今天完成的 {doneToday.length} 条</summary>
            <ul className="ink-today-done-list" role="list">
              {doneToday.map((t) => (
                <li className="ink-today-done-item" key={t.id}>
                  <span className="ink-today-done-title">{t.title}</span>
                  {/* 一颗「重开」就够——**点错完成的第一反应是撤销**，而在这
                      之前那张卡当场消失，撤销得先想起来去「已完成」里翻。
                      走的是跟卡片上状态按钮完全一样的那条路（PATCH status），
                      服务端自己清 completedAt。
                      **跟勾完那一下弹的撤销提示不重复**：那条六秒就没了，管的是
                      「刚点错」；这一颗常驻，管的是「一小时后回头看今天做了什么，
                      发现有一条不该在这儿」。判据在 lib/undoDone.ts。 */}
                  <button
                    type="button"
                    className="ink-today-done-undo"
                    aria-label={`把「${t.title}」重开`}
                    onClick={() => onPatch(t.id, { status: 'todo' })}
                  >重开</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </ConfigProvider>
  );
}
