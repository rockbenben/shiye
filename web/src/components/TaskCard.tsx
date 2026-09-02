import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Checkbox, ConfigProvider, DatePicker, Dropdown, Input, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import type { List, Status, Task, Subtask } from '../types.js';
import { allTags, formatWhen, isStatus, isTaskOverdue, overdueLabel, displayReminderAt, asArray, waitingQuietLabel, parkedQuietLabel, notStarted, CONTEXT_LABEL, STATUS_LABEL } from '../lib/taskView.js';
import { dueText, whenText } from '../lib/dueChip.js';
import { canBeHabit } from '../lib/habit.js';
import { formatMinutes, taskFocusMinutes } from '../lib/focusStats.js';
import { formKey, isInteractiveTarget } from '../lib/keymap.js';
import { clearDraft, stashDraft, takeDraft } from '../lib/draftStash.js';
// 从 server 这一侧引「下一次落在哪」——不在 web 抄一份。跳过和完成算的是同一
// 件事，两份实现会在 `from: 'done'`、拖过好几个周期、提醒对齐 due 这几条上
// 悄悄漂开。同一条先例见 lib/repeatProjection.ts。
import { blockingAncestor, childProgress, parentOf, parentOptionsFor, promoteSubtask } from '../lib/hierarchy.js';
import { sectionNames } from '../lib/grouping.js';
import { POSTPONE_MIN } from '../lib/suggest.js';
import { listLabel } from '../lib/listIcon.js';
import { decodeTaskMenu, taskMenuItems } from '../lib/taskMenu.js';
import { deleteOneConfirm } from '../lib/deleteConfirm.js';
import { boardLocalTheme } from '../theme.js';
import { TaskFields, PRI_LABEL, TIME_FORMAT, type TaskDraft } from './TaskFields.js';
import { NotesEditor } from './NotesEditor.js';
import { describeRepeat } from './RepeatFields.js';
import { ProposalNote, type ProposalWiring } from './ProposalNote.js';
import { Markdown } from './Markdown.js';
import { FocusTimer } from './FocusTimer.js';
import { Attachments, useFileDrop } from './Attachments.js';

/** 「改期」子菜单里那几项的顺序。`RESCHEDULE_LABEL` 是名字的单一出处，
 *  顺序在这里——两份东西分开放是因为顺序是这个菜单自己的事，别的调用方
 *  （以后的批量改期、命令面板）不一定按同一个顺序摆。 */


/**
 * 番茄钟被卸载掉时那句提示的后半截（前面拼任务标题）。
 *
 * **抽成常量是因为 README 逐字抄了它**（「番茄钟：专注完接着休息」那节）。两处
 * 手抄的话，改一头另一头就成了一句不成立的话——这个仓库为同一个形状栽过好几次
 * （AGENTS.md 少报字段、冒烟清单抄的那句局域网警告）。`TaskCard.test.tsx` 拿这个
 * 常量去比 README。
 *
 * **「标记完成」排在最前面**：原来这句话列的是「切走视图、换密度、这张卡被筛掉」
 * ——而实测下来最常撞上的那一下是**把它标记完成**（完成之后它当场从「今天」里
 * 被滤掉，卡跟着卸载）。「被筛掉」在字面上盖得住这一种，但刚点完「完成」的人
 * 不会把这两件事连起来：屏幕上是两条并排的提示，一条说中断了、一条说已完成，
 * 中间那层因果得他自己接。
 */
export const FOCUS_ABANDON_TAIL = '的番茄钟中断了——这一段不记。标记完成、切走视图、换密度、这张卡被筛掉，都算放弃。';

/** 每张卡能走到哪一步。「搁置」从 todo/doing 都能进——AI 拆出来一条暂时不想
 * 做的，不用先开始再退回才能搁置；从搁置回来一律是 todo（规格原话「从搁置
 * 回来就是改回 todo」），不直接跳回 doing。 */
export const MOVES: Record<Status, Array<{ label: string; to: Status }>> = {
  todo: [{ label: '开始', to: 'doing' }, { label: '搁置', to: 'later' }],
  doing: [{ label: '完成', to: 'done' }, { label: '退回', to: 'todo' }, { label: '搁置', to: 'later' }],
  done: [{ label: '重开', to: 'todo' }],
  // 「放弃」只从搁置这里走得到——不给待办/进行中各摆一颗：那两行本来就窄
  // （卡片最窄 358px），而「不做了」几乎总是先经过「暂时不做」。想直接放弃
  // 一条刚建的任务，先点「搁置」再点「放弃」，两步。
  later: [{ label: '恢复待办', to: 'todo' }, { label: '放弃', to: 'abandoned' }],
  // 仿滴答清单：「已放弃的任务还可以标记重新开始，计划临时有变也没关系」。
  abandoned: [{ label: '重新开始', to: 'todo' }],
};

/**
 * 左右拖拽的落点。**每一项都必须是 `MOVES` 里已经有的那一步**——手势不是
 * 第二套状态机，只是那排按钮的另一种按法。下面 `SWIPE` 里挑的就是 `MOVES`
 * 各状态的其中一项，`TaskCard.test.tsx` 有一条测试盯着它们不许飘。
 *
 * 方向的含义：**往右推进，往左退回或搁置。**
 * - 待办 → 右：开始　左：搁置
 * - 进行中 → 右：完成　左：退回
 * - 已完成 → 左：重开（右边没有更靠前的状态了）
 * - 搁置 → 右：恢复待办（左边没有更靠后的了）
 *
 * 某个方向没有落点时（已完成往右、搁置往左）不响应，卡片跟着手指走一小段
 * 就弹回去——不给反馈的话人会以为是卡了。
 */
export const SWIPE: Record<Status, { right?: { label: string; to: Status }; left?: { label: string; to: Status } }> = {
  todo: { right: { label: '开始', to: 'doing' }, left: { label: '搁置', to: 'later' } },
  doing: { right: { label: '完成', to: 'done' }, left: { label: '退回', to: 'todo' } },
  done: { left: { label: '重开', to: 'todo' } },
  // 搁置往左是「放弃」——方向语义没变（往左退得更远），而这一格以前是空的。
  later: { right: { label: '恢复待办', to: 'todo' }, left: { label: '放弃', to: 'abandoned' } },
  // 已放弃往右回到待办，跟已完成的「重开」对称。往左没有更后面的状态了。
  abandoned: { right: { label: '重新开始', to: 'todo' } },
};

/** 横向拖多远才算数。低于这个距离松手就弹回原位——手指在卡片上轻轻蹭一下
 * 不该改掉任务状态。 */
const SWIPE_COMMIT_PX = 88;
/** 开始跟手之前要先横向移动这么多，而且横向位移得大于纵向——不然页面上下
 * 滚一下、或者想拖序号换顺序时，卡片会跟着乱晃。 */
const SWIPE_START_PX = 12;

/** 「今天」视图专用的上/下移按钮——只有 TodayView 会传这个 prop，「按来源」
 * 看板不传，卡片上就不会多出这两个按钮：跨视图共用同一张卡，行为按 prop
 * 有没有来区分，不是复制一份卡片组件。移动本身（算新 order、发 PATCH、
 * 播报结果）由调用方（TodayView）做，这里只管按钮的可用状态和点击转发。 */
export interface MoveControls {
  onUp: () => void;
  onDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** 是不是「有一次移动正在进行、或者写完了还没等到刷新确认」——这是全局的，
   * 不是只看这一张卡自己：重排一次写的是整份可见列表，这期间任何一张卡的
   * 按钮被点，算出来的新顺序都是基于还没被确认过的旧数据，所以这期间所有
   * 卡的上/下移按钮都要禁用，不只是刚被点过的那一张。见 TodayView 里
   * `status` 状态机的注释。 */
  busy: boolean;
  /** 这张卡的这个方向是不是「用户刚点的那一个」——只影响 loading 动效，
   * 不影响是否可点（可点性统一由 busy 决定）。 */
  loadingUp: boolean;
  loadingDown: boolean;
  /** 拿到按钮的原生 DOM 节点——写完之后浏览器会把焦点从「被禁用的按钮」
   * 打回 <body>，TodayView 要在按钮重新可用时把焦点找回来，需要这两个
   * 引用才能定位到具体的 DOM 节点。 */
  upRef?: (el: HTMLButtonElement | null) => void;
  downRef?: (el: HTMLButtonElement | null) => void;
}

/**
 * 拖拽抓手的接线（task-3-brief：看板/四象限/今天三处的原生 HTML5 拖放合并
 * 成 `@dnd-kit`）。**跟 `MoveControls` 同一个位置**——两个都是「调用方
 * （`TaskGrid`/`TodayView`）算好一份 wiring 对象，`TaskCard`/`TaskRow` 只管
 * 转发到抓手 DOM 节点上」的同一种分工，这个类型两边共用（`TaskRow.tsx` 从
 * 这里 `import type`），字段对不上编译期就会报错。
 *
 * 以前这里是四个原生 HTML5 拖放属性（`draggable`/`title`/`onDragStart`/
 * `onDragEnd`）；`@dnd-kit` 不用那一套机制（指针/键盘事件，不是浏览器的
 * Drag and Drop API），换成它自己的 `attributes`/`listeners`——这两个都是
 * `useDraggable`/`useSortable` 的返回值，调用方（`TaskGrid`/`TodayView` 里
 * 新增的 `SortableTaskItem`/`SortableTodayRow` 包装组件）在自己那层调用这两个 hook，
 * 这里只负责把结果摊在抓手节点上，不直接调用 dnd-kit 的 hook——`TaskCard`/
 * `TaskRow` 因此仍然不知道 dnd-kit 存在，可以脱离 `DndContext` 单独渲染、
 * 单独测试，跟以前一样。
 */
export interface DragHandleProps {
  /** 悬停提示，调用方按当前状态算好（比如「今天」重排提交中会换成
   *  「上一次调整还没落定」），原样透传，跟以前 `title` 字段同一条理由。
   *
   *  **不能指望它顺带成为可访问名字**（复审修复轮 1 · I3 抓到的错误——这里
   *  曾经写过「没有 aria-label，浏览器/读屏软件会拿 title 当 accessible name
   *  兜底」，这句话不对：accname 规范里 `title` 只在元素**没有内容**时才会
   *  被拿来兜底，抓手节点是有内容的（卡档是 rank 数字/`⠿`，行档固定
   *  `⠿`）——`computeAccessibleName()` 实测过，看板抓手读到的名字是
   *  `"⠿"`、卡档抓手是排位数字（比如 `"1"`），不是这句 `title`，读屏软件
   *  念出来是「⠿ 按钮」而不是「拖动可以放进另一个格子 按钮」。渲染处
   *  （`TaskCard.tsx`/`TaskRow.tsx`）额外摊了一份 `aria-label={drag.title}`，
   *  可访问名字的来源是那一行，不是这条 `title` 属性本身——`title` 继续
   *  保留只是为了鼠标悬停时的原生 tooltip。 */
  title: string;
  /** 这一刻能不能拖——`attributes`/`listeners` 已经是 `useSortable({disabled})`
   *  在锁定状态下给出的空转版本（`listeners` 会是 `undefined`，指针/键盘都
   *  激活不了），这里单独再传一份纯布尔值只是给 CSS 用
   *  （`.ink-rank-locked` 换游标/提示文案），不是重复判断一遍。 */
  disabled: boolean;
  /** `useDraggable`/`useSortable` 返回的可达性属性（`role`/`tabIndex`/
   *  `aria-pressed`/`aria-roledescription`/`aria-describedby`……），直接摊
   *  在抓手节点上——键盘可达性（Tab 能停、有语义角色）靠的就是这些，不用
   *  自己拼一套。 */
  attributes: DraggableAttributes;
  /** `useDraggable`/`useSortable` 返回的指针/键盘事件监听器集合
   *  （`onPointerDown`/`onKeyDown`……），同样直接摊在抓手节点上。`disabled`
   *  时这里已经是 `undefined`——展开 `undefined` 是安全的空操作，不用在这层
   *  再判断一次。 */
  listeners: DraggableSyntheticListeners;
  /** dnd-kit 的「激活节点」ref——挂在真正接收指针/键盘事件的这个抓手节点
   *  上。`useDraggable`/`useSortable` 还有一个 `setNodeRef`，挂在外层「整个
   *  可拖拽区域」上（决定拖拽时哪个元素跟着变换/参与碰撞检测）；这里只需要
   *  前者，后者由 `TaskGrid`/`TodayView` 里的包装组件自己接，不经过
   *  `TaskCard`/`TaskRow`——这就是「只有抓手 draggable，整行/整卡不是」在
   *  dnd-kit 下的落地方式，跟以前只在抓手节点上写 `draggable`/`onDragStart`
   *  是同一个分工，只是换了一套属性。 */
  setActivatorNodeRef: (node: HTMLElement | null) => void;
}

interface CardProps {
  t: Task;
  now: Date;
  /** 归到哪个清单要靠这份候选表把 t.listId 解成名字和颜色——卡片自己不
   * 拉数据。找不到（清单被删了）就不画竖条/圆点，见下面渲染处的注释。 */
  lists: List[];
  onPatch: (id: string, patch: Partial<Task>) => void;
  /**
   * 全部任务——只为了两件事：这条的父任务叫什么、它自己名下有几个子任务
   * （`lib/hierarchy.ts`）。**不给就两个记号都不画**，卡片照旧，不是崩：
   * 十几个调用点里漏接一个不该让那个视图白屏，见 lists 那条 prop 的对照
   * （那个是必填，因为竖条/清单名不画出来会跟数据自相矛盾；父子关系不画
   * 只是少一条信息）。
   */
  allTasks?: Task[];
  /** 创建副本（仿滴答清单「创建副本」）。不给就不显示这个菜单项。 */
  onDuplicate?: (t: Task) => void;
  /**
   * 把一个检查事项转成真正的子任务（仿滴答清单「转为子任务」）。要发两个
   * 请求（新建 + 从父任务的清单里摘掉），所以由 App 那边接，跟 onDuplicate
   * 同一个分工。**不给就不显示这颗按钮**——一个点了没反应的入口比没有更糟。
   */
  onPromoteSubtask?: (t: Task, index: number) => void;
  /** 跳过重复任务的这一次。**不给就退回发 patch 那条老路**——十几个调用点
   *  漏接一个不该让那张卡的「跳过本次」点了没反应；退回去的代价只是那一次
   *  会被记成一次拖延，比整个动作失灵轻。 */
  onSkip?: (id: string) => void;
  /** 编辑态保存专用，不走 guard()——guard 会把失败吞掉只弹一条提示，
   * 编辑框那份「用户刚打的字」不能跟着一起没了，必须让调用方（TaskCard）
   * 自己 await 到结果，失败时把编辑框留着。 */
  onEditTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
  onDelete: (id: string) => void;
  /** 编辑器开着的时候通知父组件——跟 InboxSidebar 的 editingIds 同一个套路：
   * 状态筛选切换会重新算列表，正常情况下滤掉的卡就该从树上摘掉，但这张卡
   * 如果正编辑到一半，摘掉等于把它本地的 draft state 连带没保存的草稿一起
   * 卸载没了。父组件靠这份 id 集合，在筛选结果里强行留住正在编辑的那张卡。 */
  onEditingChange: (id: string, editing: boolean) => void;
  move?: MoveControls;
  /** AI 修改建议的接线。渲染在卡片里而不是单独一个「提议收件箱」页面——
   * 提议是关于某条任务的，离开那条任务就没法判断该不该接受。 */
  proposals?: ProposalWiring;
  /** 「今天」里这张卡排第几（从 1 起）。**同时是拖拽排序的抓手。**
   * 网格布局之后它从页边挪进了卡片右上角：多列排布下「读序」必须一眼看得出，
   * 靠位置推断不行（横着读还是竖着读？），数字写在卡上就没有歧义了。
   *
   * **看板/四象限（TaskGrid 的 onDropTo）只传 `drag`、不传这个。** 那两个视图
   * 格子里的顺序不是任何人排出来的——是 `readTasks()` 的文件顺序，标上编号
   * 等于把一个实现细节说成他的排序；`.ink-rank` 在这个界面里已经有确定含义
   * （这条注释本身），同一个数字出现在格子里，任何人都会推断「能在这一列里
   * 拖着排序」，而同格内拖放是 `TaskGrid.tsx` 有意做成的空操作——拖了会
   * 什么反馈都没有。所以只给 `drag`、不给 `rank` 时，手柄换成一个不带编号
   * 的抓手字形（渲染处 `rank ?? '⠿'`），不显示数字。 */
  rank?: number;
  /** 渲染 aiComment。只有「按来源」传——那个视图回答的是「这条哪来的、
   * 为什么这么拆」；「今天」问的是「我现在该干哪个」，理由在那儿是噪音。 */
  showNote?: boolean;
  /** 拖拽抓手的接线。「今天」搭配 `rank` 一起传，手柄显示序号；看板/四象限
   * （`TaskGrid.tsx` 的 `onDropTo`）只传这个、不传 `rank`，手柄显示抓手字形，
   * 见上面 `rank` 的注释。形状见 `DragHandleProps`。 */
  drag?: DragHandleProps;
  /**
   * 选中态接线（批量操作的地基，见 2026-08-17-selection.md）。**不给的话卡片
   * 跟今天一模一样**——没有勾选框，点击不做任何事：这个 prop 是否存在本身
   * 就是「选中功能有没有接线」的唯一开关，调用方（TaskGrid）只有在拿到
   * `selection`/`onSelectionChange` 两个 prop 时才会传它，见 TaskGrid.tsx。
   *
   * - `showCheckbox`：整个选中集合非空时为 true（由调用方算好传进来，这张卡
   *   自己不知道全局选中了几张）——「勾选框只在已经选中了至少一张时出现」。
   * - `onClick`：卡片本体被点了一下、且满足触发选中的条件（见下面渲染处的
   *   判断）时回调，`mods` 是这次点击带的修饰键；勾选框自己被点也走这个
   *   回调，固定传 `{ shift: false, ctrlOrMeta: true }`——「一旦选中了至少
   *   一张，之后可以平常点击勾选框来加减」，不需要按住 Ctrl。
   */
  select?: {
    selected: boolean;
    showCheckbox: boolean;
    onClick: (mods: { shift: boolean; ctrlOrMeta: boolean }) => void;
  };
  /**
   * 'E' 键触发的编辑请求（批量操作的地基，见 2026-08-17-selection.md Task 4）。
   * `true` 时（且只在 `true` 那一刻，不是「只要是 true 就」）这张卡自己调用
   * `startEdit()`，然后立刻调 `onAutoEdited` 把上游那份「谁该进入编辑态」的
   * 状态清掉——不清的话，同一张卡编辑完退出、选中还在、再按一次 E，上游那份
   * id 没变，`useEffect` 的依赖没变化不会重新触发，第二次按键会静默失效。
   * 调用方（App，经 TaskGrid 转发）只在「选中恰好是这一张」时把这个 prop
   * 置真，见 App.tsx 'edit' 分支和 TaskGrid.tsx 的转发逻辑。
   */
  autoEdit?: boolean;
  onAutoEdited?: () => void;
  /** 番茄钟一轮的时长，分钟——来自 Settings.focusMinutes。**可选，默认 25**：
   *  这个 prop 是后补的，给它一个默认值而不是设成必填，是不想为了这一个数字
   *  去改遍每一个渲染 TaskCard 的现有测试（TaskGrid/TodayView/TaskBoard 及
   *  它们各自的测试文件），那些用例根本不关心番茄钟时长。真实链路（App.tsx）
   *  会显式传 `settings.focusMinutes`，不依赖这个默认值。 */
  focusMinutes?: number;
  /** 一轮走完之后歇多久，分钟——来自 `Settings.breakMinutes`。**可选，默认 0
   *  = 不休息**：跟 focusMinutes 同一个理由，十几个调用点漏接一个不该让那张卡
   *  行为跟别处不一样，而「不休息」正是加这个字段之前的行为。 */
  breakMinutes?: number;
  /**
   * 离线记号（task-3-brief）：本机连不上服务端、现在看到的是本地缓存。
   * **只有这一件事看它**——附件的「打开」链接直接指向服务端的文件系统
   * （`api.attachmentUrl`），离线时点了是个死链接，见 `Attachments.tsx` 的
   * 处理。**可选，默认 `false`**——跟 `focusMinutes` 同一个理由，这个
   * prop 是后补的，不想为了它去改遍每一个渲染 `TaskCard` 的现有测试
   * （`TaskGrid`/`TodayView`/`TaskBoard` 及它们各自的测试文件），那些
   * 用例根本不关心离不离线。真实链路（`App.tsx`）会显式传 `offline` 这个
   * state，不依赖这个默认值。
   */
  offline?: boolean;
  /**
   * 详情面板那一栏的形状（仿滴答清单第三栏，见 `TaskDetail.tsx`）：顶上一行
   * 「勾选圈 + 日期」，下面一个大标题，再下面一整块正文——**标题和正文都点
   * 一下就地改**，不用先进整张卡的编辑态。
   *
   * **为什么是这张卡的一个形态，而不是 `TaskDetail` 自己画一份**：面板要的
   * 「点正文就能写」需要的全套东西（`onEditTask` 的失败处理、草稿、`/` 菜单、
   * 输入法守卫）这里全都有；在面板里另起一份，等于把同一个字段做成两套写法，
   * 那正是这个仓库最贵的那类缺陷（`statusLabel.guard.test.ts` 记着两次账）。
   *
   * 只改**查看态**的排布。双击进整张卡的编辑态那条路一个字没动——那里才改得了
   * 另外八个字段（优先级/标签/清单/重复/提醒……），面板上这三样只是把最常改的
   * 三件事（做没做完、什么时候、写了什么）提到手边。
   */
  detail?: boolean;
}

export function TaskCard({
  t, now, lists, allTasks, onDuplicate, onPromoteSubtask, onSkip, onPatch, onEditTask, onDelete, onEditingChange, move, proposals, rank, showNote, drag, select,
  autoEdit, onAutoEdited, focusMinutes = 25, breakMinutes = 0, offline = false, detail = false,
}: CardProps) {
  const { message, modal } = AntApp.useApp();
  // 「跳过本次」能不能点，顺带就是要发的补丁——`null` 就是不该摆这个菜单项。
  // 已经投进这条任务的分钟数，和「超了没有」。**超了用跟「已过期」同一个记号**
  // ——两者是同一类信息（说好的和实际的对不上了），不为它单发明一种颜色。
  /**
   * 检查事项**不进 `draft`**，增删改跟「勾掉一项」一样直接发 patch。
   *
   * 这是有意的：那个勾选框在编辑态里也能点（这张卡一直是这么写的），如果
   * 表单里再存一份草稿，编辑期间勾的那一下会在保存时被草稿盖回去。让这一
   * 整块都走同一条路（直接 patch），就没有两份状态可以对不上。
   */
  const subs = asArray<Subtask>(t.subtasks);
  const putSubs = (next: Subtask[]) => onPatch(t.id, { subtasks: next });

  const spent = taskFocusMinutes(t);
  const over = t.estimateMinutes !== null && t.estimateMinutes > 0 && spent > t.estimateMinutes;
  // 编辑态是一份完整的 TaskDraft（跟 TaskComposer 共用同一份表单）——AI 猜的
  // 时间猜歪了，之前只能手改 tasks.json，现在这些字段都能在卡片上直接改。
  // 提醒**整个数组一起发**（表单现在编辑得了任意多个），`firedAt` 一律写
  // null：服务端按时刻逐条比对，时刻没变的沿用它原来的章（applyTaskPatch），
  // 客户端发什么都不算数。
  // 检查事项不在这份草稿里，走它自己那条直接 patch 的路，见上面 `putSubs`。
  // **挂载时先问一句「上次卸载的时候有没有没改完的」**：切走视图会把这张卡
  // 整个卸载，草稿跟着没（八个视图里只有三个 keepMounted）。判据和为什么不
  // 存 localStorage 都在 lib/draftStash.ts。取出来即移交所有权，那边同时删掉。
  // **不在 `useState` 的初始化器里调 `takeDraft`。** 它「取出即移交所有权」
  // （那边同时 `stash.delete`），而 React 的 `StrictMode`（`main.tsx` 开着）会
  // **把初始化器跑两次**：第一次拿到草稿并删掉，第二次拿到 `null`，React 保留的
  // 是第二次的结果——开发模式下切走再切回，没改完的草稿就这么没了，而这正是
  // 这份 stash 存在的全部理由。
  //
  // 改成挂载后的一次性 effect：初始化器变成纯的（`null`），有副作用的那一下
  // 只发生一次。`[]` 依赖是有意的——这就是「挂载时问一句」，不跟着 `t.id` 重跑。
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  useEffect(() => {
    const kept = takeDraft(t.id);
    if (!kept) return;
    setDraft(kept);
    // **接回草稿的同时就告诉上游「这张卡在编辑态」**，不另起一个 effect：
    // 这两件事是同一件（「上次没改完，接着改」），拆开的话第二个 effect 在
    // 挂载那一帧看到的 `draft` 还是 `null`（`setDraft` 要下一次渲染才生效），
    // 通知就永远发不出去——`editingIds` 会在下一次重算时把这张卡当普通卡摘掉，
    // 连同刚接回来的草稿。测试「接回草稿时要告诉上游」钉的正是这一下。
    onEditingChange(t.id, true);
    // 只在挂载那一刻问一次——之后进出编辑态各自都调过 onEditingChange 了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [saving, setSaving] = useState(false);
  // 「加一条检查事项」那个框里打了什么。纯本地，加完就清空。
  const [newSub, setNewSub] = useState('');

  // 卡片被卸载时（任务删了、被筛选摘掉……）如果还处在编辑态，得把它从
  // editingIds 里摘出去——没有这一步，这个 id 永远不会被 delete，调用方
  // （TaskGrid/TaskBoard 的 editingIds）从此往后每次重算都会把它当成
  // 「正在编辑」强行钉住，直到整页刷新才恢复正常。只在卸载时跑一次：
  // t.id 和 onEditingChange 对同一张卡片实例不会变，正常保存/取消已经
  // 各自调用过一次 onEditingChange(false)，这里重复调用是幂等的空操作。
  useEffect(() => () => onEditingChange(t.id, false), []);

  // 卸载时把没改完的草稿存住。走 ref 而不是把 `draft` 列进依赖——清理函数
  // 读的必须是**卸载那一刻**的值，依赖数组里的闭包钉在挂载那一次。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => () => {
    if (draftRef.current) stashDraft(t.id, draftRef.current);
  }, [t.id]);


  // notes ?? ''：手写任务可能压根没写这个字段（GET /api/tasks 不校验文件写入
  // 的数据，见下面 subtasks 那处一样的兜底），undefined 会让 TextArea 从「受控」
  // 变「非受控」，第一次敲字符 React 就会告警。
  const startEdit = () => {
    /**
     * **就地编辑还开着的时候不进整张卡的编辑态。** 详情面板里在正文里打了字、
     * 直接双击别处：那一下 mousedown 会先让 textarea 离焦、`commitNotes()`
     * 开始落盘，但那是个 `await`，请求回来之前 `t.notes` 还是旧值——这时候
     * 打开表单，草稿抓到的是旧备注，他再按一下保存就把刚写的那段盖回去了。
     * 挡住这一次（`notesDraft`/`titleDraft` 要等落盘成功才清）就没有这个窗口：
     * 再双击一次，那时草稿抓到的是新值。
     */
    if (notesDraft !== null || titleDraft !== null) return;
    // `prev ?? …`，不是无条件覆盖：挂载时可能已经从上一次卸载接回了一份草稿
    // （`takeDraft`），而 `autoEdit`（`E` 键 / 各处「指出这一条」）那条 effect
    // 会在挂载后紧接着调这个函数——直接覆盖的话，刚接回来的那份当场被任务的
    // 当前值冲掉，等于白存。已经在编辑态时菜单里的「编辑」本来就够不到，所以
    // 这个分支只会在那种情形下走到。
    setDraft((prev) => prev ?? { title: t.title, notes: t.notes ?? '', due: t.due, startAt: t.startAt ?? null, endAt: t.endAt ?? null, reminders: t.reminders.map((r) => r.at), persistentReminder: t.persistentReminder ?? false, priority: t.priority, tags: t.tags, listId: t.listId, section: t.section ?? null, repeat: t.repeat, parentId: t.parentId ?? null, estimateMinutes: t.estimateMinutes ?? null, habit: t.habit ?? false, waitingFor: t.waitingFor ?? null, context: t.context ?? null });
    onEditingChange(t.id, true);
  };

  // 'E' 键的落点，见 CardProps.autoEdit 的注释。依赖数组只列 `autoEdit`
  // 本身：`startEdit`/`onAutoEdited` 每次渲染都是新的函数引用，列进去会让
  // 这个 effect 在每次渲染后都重跑一遍（等于任何一次按键都会把编辑框强行
  // 重置成任务当前值，编辑到一半打个字就被打回原样）——只在 `autoEdit`
  // 从假变真那一刻触发一次，才是「进入编辑态」该有的语义。
  useEffect(() => {
    if (autoEdit) {
      startEdit();
      onAutoEdited?.();
    }
  }, [autoEdit]);

  const cancelEdit = () => {
    setDraft(null);
    // 主动取消之后再「恢复」出一份旧草稿是凭空冒出来的东西。
    clearDraft(t.id);
    onEditingChange(t.id, false);
  };
  const save = async () => {
    const title = draft?.title.trim();
    if (!draft || !title) return;
    setSaving(true);
    try {
      await onEditTask(t.id, {
        title, notes: draft.notes, due: draft.due, startAt: draft.startAt, endAt: draft.endAt,
        persistentReminder: draft.persistentReminder, priority: draft.priority, tags: draft.tags, listId: draft.listId, section: draft.section,
        repeat: draft.repeat, parentId: draft.parentId, estimateMinutes: draft.estimateMinutes,
        // 当不了习惯的重复档上不该留着这个记号——习惯那个去处按 `isHabit` 认，
        // 留着它只是一条永远不会被读到的数据。
        habit: canBeHabit(draft.repeat) ? draft.habit : false,
        waitingFor: draft.waitingFor,
        context: draft.context,
        // 整个数组照发。**不用再 `t.reminders.slice(1)` 把编辑不到的那几条
        // 接回去了**——表单现在编辑得到全部。`firedAt` 一律发 null 也没关系：
        // 服务端按时刻逐条比对，时刻没变的沿用它原来的章（applyTaskPatch），
        // 客户端发什么都不算数。
        reminders: draft.reminders.map((at) => ({ at, firedAt: null })),
      });
      setDraft(null);
      // 存成了，那份草稿就没有意义了。**只在成功这一支清**——失败那一支下面
      // 特意把草稿留着（那条既有的教训），清掉等于把他刚改的内容连同这次失败
      // 一起弄丢。
      clearDraft(t.id);
      onEditingChange(t.id, false);
    } catch (e) {
      // 保存失败就把编辑框留着、草稿原样在——清空等于把用户刚改的内容连带
      // 没存成的这次一起弄丢，跟 InboxComposer 的 submit() 是同一条教训。
      void message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 详情面板里「点标题/点正文就地改」的两份草稿。`null` = 没在改这一个。
   *
   * **不复用上面那份 `draft`**：那是一整张表单的十二个字段，进去要按保存、
   * 出来要按取消；这里改的是一个字段，写完点别处就落盘。两者同时存在没有
   * 冲突——面板上双击空白照样能进整张卡的编辑态，那时候这段 JSX 根本不在
   * DOM 里（`draft` 那一支渲染的是 `TaskFields`）。
   */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  /**
   * Esc 撤销时**离焦可能紧接着就到**，而离焦那条路是「落盘」——不立一个旗子
   * 的话，按 Esc 等于确认，想撤销的那一下反而把它存了。
   *
   * 用 ref 不用 state：这个值要在同一轮事件里写下、马上被另一个处理函数读到，
   * setState 排到下一次渲染才生效，读到的会是上一轮的旧值。
   *
   * **开编辑器时先清一次，不能只靠落盘那条路去消费它。** 按 Esc 的时候框当场
   * 被卸载，浏览器对「焦点元素被移除」多半根本不派发 blur——旗子立了没人收，
   * 就一直是 true，于是**下一次真的改完点别处，那一次会被当成撤销静默丢掉**。
   * 这条测试钉在 TaskDetail.test.tsx（「Esc 过一次之后，下一次编辑照样存得进去」）。
   */
  const abortInline = useRef(false);
  /** 进就地编辑：清掉上一次可能没被消费掉的撤销旗子，再把草稿放进去。 */
  const openInline = (set: (v: string) => void, value: string) => {
    abortInline.current = false;
    set(value);
  };

  /** 落盘失败**不清草稿**——清了等于把他刚打的字连同这次失败一起弄丢，跟
   *  `save()` 的 catch 分支是同一条教训。空标题同理：留在框里让他自己收拾，
   *  不静默丢弃，也不拿一个空标题去覆盖原来的。 */
  const commitTitle = async () => {
    if (titleDraft === null) return;
    if (abortInline.current) { abortInline.current = false; setTitleDraft(null); return; }
    const next = titleDraft.trim();
    if (!next) return;
    if (next === t.title) { setTitleDraft(null); return; }
    try {
      await onEditTask(t.id, { title: next });
      setTitleDraft(null);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };

  /** 备注可以被清空（那是一个正当的编辑），所以这里没有「空就不存」那条，
   *  只有「跟原来一样就什么都不发」。 */
  const commitNotes = async () => {
    if (notesDraft === null) return;
    if (abortInline.current) { abortInline.current = false; setNotesDraft(null); return; }
    if (notesDraft === (t.notes ?? '')) { setNotesDraft(null); return; }
    try {
      await onEditTask(t.id, { notes: notesDraft });
      setNotesDraft(null);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };

  /** Esc：立旗子 + 关掉框。两处一字不差，提出来不各写一遍。 */
  const abortInlineEdit = (close: () => void) => { abortInline.current = true; close(); };

  // 复用同一个「已过期」标签，不新造一套视觉语言：isOverdue 只看 due，
  // isReminderOverdue 补的是「remindAt 在更早一天已经触发过、没有 due 兜底」
  // 这个分支（见 taskView.ts 的注释）——两条判据的实现互不相干，但对用户
  // 来说都是「这件事该关注了却没处理」，没必要分开画两种红标。
  //
  // 合成一个 taskView.ts 的 isTaskOverdue，跟 TaskRow.tsx 共用同一份（整分支
  // 审查 C2：以前 TaskRow 只抄了半句，只设了提醒的任务行档上一个记号都
  // 没有）。**那不是一个单纯的 OR**：有一个还没到的 due 时，提醒那一支整个
  // 不参与——「没有 due 兜底」上面这半句本来就是这么写的，只是代码一度没检查
  // 它，见 taskView.ts 里 isTaskOverdue 的注释和那次真实的困惑。
  // ── 左右拖拽改状态 ──
  // 用指针事件，不用 HTML5 拖放：那套是「把这个东西搬到别处」，而这里是
  // 「原地推一把」，需要跟手的实时位移；而且序号那个抓手已经占了 HTML5 拖放
  // 做纵向排序，两套机制各走各的通道才不会打架。
  const [dx, setDx] = useState(0);
  const swipe = useRef<{ x: number; y: number; on: boolean } | null>(null);
  const targets = SWIPE[isStatus(t.status) ? t.status : 'todo'];
  const target = dx > 0 ? targets.right : dx < 0 ? targets.left : undefined;

  const onPointerDown = (e: React.PointerEvent) => {
    // 编辑态整张卡是个表单，别在上面做手势。
    if (draft) return;
    // 从按钮、复选框、输入框上按下去的不算——那些地方按下去是要点它们，
    // 顺手划一下不该把任务状态改了。
    if ((e.target as HTMLElement).closest('button, input, textarea, a, label, .ant-picker, .ink-rank')) return;
    // **鼠标不走手势，只有手指/触控笔走。** 鼠标横向拖拽在桌面上有且只有一个
    // 意思：选中一段文字。原来这里对所有 pointerType 一视同仁，于是想划中卡片
    // 标题的人会撞上——横向位移一过 SWIPE_START_PX 就 setPointerCapture，
    // `.ink-swipe-active` 的 `user-select: none` 当场把选区掐掉，卡片滑开露出
    // 「搁置」；**再多划一点松手，任务状态就真的被改了**。（实测报上来的原话是
    // 「选择文字就出现搁置等，无法选择」。）
    //
    // 下面 onPointerMove 里那句「竖着动得更多就整个作罢（用户只是想选中一段
    // 文字）」挡的是反方向：选文字恰恰是横着划的，那条守卫对这件事一次都没
    // 生效过——它真正管的是「页面在滚」。
    //
    // 砍掉鼠标这条通路不损失任何能力：手势的每一个落点都来自 `MOVES`（见上面
    // `SWIPE` 的注释「只是那排按钮的另一种按法」），而那排按钮在查看态下常驻
    // 在每张卡上，鼠标本来就够得着。触屏那边一切照旧。
    //
    // 这一句也顺带把原来的 `e.button !== 0` 覆盖掉了：那条只在 pointerType 是
    // mouse 时才有意义，鼠标整个不进来之后它没有剩下的适用场景。
    if (e.pointerType === 'mouse') return;
    swipe.current = { x: e.clientX, y: e.clientY, on: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s) return;
    const ddx = e.clientX - s.x;
    const ddy = e.clientY - s.y;
    if (!s.on) {
      // 还没确定是不是横划：竖着动得更多就整个作罢（页面在滚，或者用户
      // 只是想选中一段文字），免得卡片跟着抖。
      if (Math.abs(ddy) > Math.abs(ddx)) { swipe.current = null; return; }
      if (Math.abs(ddx) < SWIPE_START_PX) return;
      s.on = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    // 没有落点的那个方向给一点阻尼，划得动但划不远——「这边没有」要看得出来，
    // 而不是完全没反应（那跟卡死没区别）。
    const has = ddx > 0 ? targets.right : targets.left;
    setDx(has ? ddx : ddx * 0.18);
  };

  const endSwipe = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const committed = s?.on && target && Math.abs(dx) >= SWIPE_COMMIT_PX ? target : null;
    setDx(0);
    if (committed) onPatch(t.id, { status: committed.to });
  };

  // 拖放区扩到了整张卡（final-review.md「专项判定」）：`data/` 里现有任务没
  // 有一条带附件，查看态下 attachments 为空整段不渲染 Attachments，那种状态
  // 下卡片上一个拖放目标都没有；补偿路径（先点「编辑」）也发现不了——卡片
  // 菜单只有「编辑」「删除」两项，没有任何暗示附件存在的记号。整张卡当放置
  // 目标不需要多状态、不需要隐形目标：目标就是这个永远存在的 Card 本身，
  // 状态只有一份（useFileDrop 里那份），`dropProps` 直接摊在 Card 上，
  // `over`/`uploading` 转发给 Attachments。
  const { over: fileOver, uploading, upload, dropProps } = useFileDrop(t.id);

  const overdue = isTaskOverdue(t, now);
  const statusLabel = isStatus(t.status) ? STATUS_LABEL[t.status] : `状态异常：${String(t.status)}`;
  // 显示「下一次什么时候响」，不是「最早那次」——判据在 taskView 的
  // `displayReminderAt`。逻辑那一半（进不进「今天」、算不算过期）另有判据，
  // 那边看的是最早那个，两者问的不是同一个问题。
  const remindAt = displayReminderAt(t, now);
  // 找不到就当没有——清单被删掉之后那条任务的 listId 还指着它，
  // 显示一个裸 uuid 对人没有意义。
  const list = t.listId ? lists.find((l) => l.id === t.listId) : undefined;

  /**
   * 「打标签」那一组的候选。从 `allTasks` 现算——它本来就在手上（层级记号也
   * 读它），不为这一组再穿一根 prop 下来。`useMemo` 是必要的而不是顺手：
   * 菜单的 `items` 每次渲染都重算一遍，不 memo 就是每张卡每一帧扫一遍全表。
   */
  const tagChoices = useMemo(() => (allTasks ? allTags(allTasks) : []), [allTasks]);

  /**
   * ⋯ 菜单那份配置。**提出来是因为它现在有两个入口**：右上角那颗 ⋯，和在
   * 卡片上点右键。同一份 `items` + 同一个 `onClick`，不写两遍——写两遍就是
   * 等着「右键菜单比 ⋯ 少一项」这种事发生。
   */
  const cardMenu = {
    // 菜单本身在 lib/taskMenu.ts——**卡片和紧凑行共用同一份**。原来这一整块
    // 是就地写的，于是行那边的 ⋯ 一直只有「今天」视图里的上下移，别的视图
    // 里点了什么都不发生。
    // `canSkip: !!onSkip`，跟旁边的 `canDuplicate` 同一个口径——**没接线就不出
    // 这一项**。原来写死 `true`，于是没接 `onSkip` 的视图照样出「跳过」，点下去
    // 退回那条普通 patch，被记成一次拖延，而提示语一模一样，分不出来。
    items: taskMenuItems(t, { lists, now, canDuplicate: !!onDuplicate, canSkip: !!onSkip, tags: tagChoices }),
    onClick: ({ key }: { key: string }) => {
      const action = decodeTaskMenu(key, t, now);
      if (!action) return;
      if (action.kind === 'edit') return startEdit();
      if (action.kind === 'duplicate') return onDuplicate?.(t);
      if (action.kind === 'patch') return onPatch(t.id, action.patch);
      if (action.kind === 'skip') {
        // 只走 onSkip 那条专门的路：发普通 patch 的话，服务端字段级
        // 的推迟计数会把这一次记成一次拖延（见那条路由）。原来这儿有一条
        // 「没接 onSkip 就退回发 patch」的老路——那正是把跳过记成拖延的路，
        // 而且提示语一模一样，分不出来。现在没接线的调用点根本不出这一项
        // （上面 canSkip），这条退路不该再有。
        if (!onSkip) return;
        onSkip(t.id);
        // 说一句下一次是什么时候：这张卡会**从今天消失**（due 挪走
        // 了），不给回执的话看起来像是被删掉了。
        void message.success(`跳过了，下次 ${formatWhen(action.nextDue)}`);
        return;
      }
      // 删除要先问一句——即便现在有垃圾箱兜底、点错了能在那边
      // 还原回来，这仍然是这张卡上分量最重的一步，不该一个误触
      // 就直接发生。这句顺便指一下「搁置」：多数想删的时刻其实
      // 是「暂时不想看见它」，那条路更轻。
      // 用 modal.confirm 不用 Popconfirm：动作是从菜单项发起的，
      // 菜单这时候已经收起来了，没有可以挂气泡的锚点。
      // **文案在 lib/deleteConfirm.ts**，不在这儿手写：这句原来
      // 是三份一字不差的复制（这里、TaskRow、批量那条），而
      // 「子任务不会跟着删」那半句要是只补一处，另外两处就继续瞒着。
      modal.confirm({
        ...deleteOneConfirm(t, allTasks ?? [t]),
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => onDelete(t.id),
      });
    },
  };

  // 多级任务的两个记号。`allTasks` 没给就都是空——见那条 prop 的注释。
  const parent = allTasks ? parentOf(t, allTasks) : undefined;
  // 挡着这一条的那个祖先（自己没设开始时间，但父辈设了）。`allTasks` 没给
  // 就是 undefined，跟上面那两个层级记号同一条约定。
  const blocker = allTasks ? blockingAncestor(t, now, allTasks) : undefined;
  const kids = allTasks ? childProgress(t.id, allTasks) : null;

  return (
    // ink-task-card：正文行宽上限（见 theme.css 里这个类的注释）——没有边注、
    // 独占整条网格轨道的卡片不加这个上限的话，宽屏下能跑到 1150px+ 一行。
    // 外面这层承载「拖动时露出来的目标状态」和位移，Card 本身跟着 translate。
    // touch-action: pan-y——横向手势交给我们，纵向照旧由浏览器滚页面，
    // 不然手机上想往下滚会被卡片吃掉。
    <div
      className={`ink-swipe${dx !== 0 ? ' ink-swipe-active' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      // 选中态：只在 `select` 给了（TaskGrid 接了 selection/onSelectionChange）
      // 时才挂这个处理器——不给的话今天的行为一个字不变，见 CardProps.select
      // 的注释。
      onClick={select ? (e) => {
        // 编辑态整张卡是个表单，别在上面选中——跟 onPointerDown 顶部同一条
        // 判断（197 行）。
        if (draft) return;
        // 点在按钮/链接/输入框（含勾选框自己）上不算——那些地方点一下是要
        // 点它们，不该顺手选中整张卡。勾选框走的是它自己独立的 onChange
        // （下面渲染处），这里的 closest('input',...) 天然会挡住它，两条
        // 路不会打架。判据复用 keymap.ts 的 isInteractiveTarget，只多传
        // 'button, a'，不重开第二份选择器，见 task-3-brief。
        if (isInteractiveTarget(e.target, 'button, a')) return;
        const shift = e.shiftKey;
        const ctrlOrMeta = e.ctrlKey || e.metaKey;
        // 平常点：今天的行为不变，什么都不做——只有带修饰键才进入选择。
        if (!shift && !ctrlOrMeta) return;
        // Shift 点会被浏览器当成扩展文本选区的手势，不拦的话卡片文字被刷蓝
        // 一片，见 task-3-brief 要点③。
        if (shift) e.preventDefault();
        select.onClick({ shift, ctrlOrMeta });
      } : undefined}
      /**
       * **`X` = 选中/取消选中焦点所在的这一张**（`Shift+X` 从锚点连选）。
       *
       * 补的是一个把整层键盘操作堵死的洞：勾选框只在「已经选中了至少一张」
       * 之后才出现，而进入选中态的唯一办法是 **Ctrl/Shift 点卡片**——一个
       * 鼠标动作。于是 `E`（编辑选中的）、`D`（标完成）、`T/M/W`（改期）
       * 这一整套快捷键，键盘用户一个都够不着：它们全都作用在选中集合上，
       * 而那个集合他建不起来。
       *
       * **挂在整张卡上、靠冒泡接住**，不给卡片本身加 `tabIndex`：卡里本来
       * 就有一串可聚焦的按钮（标题、状态、`⋯`），Tab 过去按一下 `X` 就行，
       * 再多一个「整张卡」的停靠点只会让 Tab 一圈变长。
       *
       * 挡掉的只有输入框（`isInteractiveTarget` 的三种：input/textarea/
       * contenteditable）——在备注里打「x」当然不该选中这张卡。**按钮不挡**，
       * 跟上面点击那条相反：那条挡按钮是因为「点按钮就是点按钮」，而这里
       * 焦点落在按钮上正是键盘走到这张卡的常态。
       *
       * 带 Ctrl/Cmd/Alt 的不认：`Ctrl+X` 是剪切。
       */
      /**
       * **双击卡片 = 改它。** 之前进编辑只有两条路：选中之后按 `E`，或者鼠标
       * 挪到卡片右上角点 ⋯ 再点「编辑」。双击是列表里最省事的那一步，滴答
       * 清单、以及基本上所有列表界面都是这个约定。
       *
       * `draft` 非空（已经在编辑态）时不再触发：那时整张卡是个表单，在备注
       * 框里双击是「选中一个词」。`isInteractiveTarget(e.target, 'button, a')`
       * 挡的是同一类事——双击一颗按钮不该顺带进编辑。
       */
      onDoubleClick={(e) => {
        if (draft) return;
        if (isInteractiveTarget(e.target, 'button, a')) return;
        e.preventDefault();
        startEdit();
      }}
      onKeyDown={select ? (e) => {
        if (draft) return;
        if (e.key !== 'x' && e.key !== 'X') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        select.onClick({ shift: e.shiftKey, ctrlOrMeta: true });
      } : undefined}
    >
      {/* 露在卡片底下的那一格：显示松手会发生什么。够不到提交距离时压暗，
          够到了才实心——手指还在动的时候就该知道松手算不算数。 */}
      {target && (
        <span
          className={[
            'ink-swipe-hint',
            dx > 0 ? 'ink-swipe-hint-right' : 'ink-swipe-hint-left',
            Math.abs(dx) >= SWIPE_COMMIT_PX ? 'ink-swipe-hint-armed' : '',
          ].filter(Boolean).join(' ')}
          aria-hidden="true"
        >
          {target.label}
        </span>
      )}
    {/* 整张卡右键 = 那份 ⋯ 菜单，落在指针处（antd 的 `contextMenu` trigger
        自己定位）。**跟 ⋯ 是同一个 `menu` 对象**，两个入口一份契约。
        编辑态里关掉（`trigger={[]}`）：那时候整张卡是个表单，在备注框里点
        右键要的是浏览器自己的复制/粘贴，不是任务菜单。 */}
    <Dropdown menu={cardMenu} trigger={draft ? [] : ['contextMenu']}>
    <Card
      size="small"
      // 选中态的记号是这条 className，不是群青——群青是配给制，只标 AI 产出
      // 的内容，选中是人自己点出来的状态。CSS 见 theme.css 的
      // .ink-task-card-selected（用 --rule）。
      // ink-attach-box-over：文件拖在卡片任意位置上时才挂——复用 Attachments
      // 组件早就有的那条规则（outline: 1.5px dashed var(--rule)），不新写一条，
      // 只在真的拖着文件时才出现，不是常驻提示，密度不受影响（见 useFileDrop
      // 的注释）。
      // detail：**这一栏本身就是那张卡**，不该在一条已经有界行和内边距的栏
      // 里再套一层带阴影的卡片外壳（实测截图：双层边框，而且页脚被那层壳挤得
      // 像浮在外面）。滴答清单那一栏也没有卡片，就是一页内容。
      className={`ink-task-card${detail ? ' ink-task-card-plain' : ''}${select?.selected ? ' ink-task-card-selected' : ''}${fileOver ? ' ink-attach-box-over' : ''}`}
      variant={detail ? 'borderless' : undefined}
      styles={detail ? { body: { padding: 0 } } : undefined}
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      {...dropProps}
    >
      {/* 勾选框：只在「已经选中了至少一张」时出现（select.showCheckbox 由
          TaskGrid 按全局选中集合算好传进来，这张卡自己不知道别的卡选没选）——
          平常的卡片一个多余的控件都不多。点它是「平常点击就能加减」（跟按住
          Ctrl 点卡片同一个效果），不需要按修饰键，见 CardProps.select 的注释。
          `onClick` 里 stopPropagation：防的是万一某个浏览器把点在勾选框视觉
          区域上的事件派发到它非 <input> 的兄弟节点（antd Checkbox 内部结构），
          让上面卡片级的 onClick 也收到同一次点击——那条路径只有在带
          Ctrl/Shift 时才会做事，双重触发没有可观察的坏结果，这里只是不给
          它任何生效的机会。局部 ConfigProvider 压 colorPrimary：Checkbox
          的选中态直接读全局 token.colorPrimary（也就是群青 #2E3ED4），
          antd 6 没给它留组件级 token 能单独覆盖——跟 TaskBoard.tsx/
          TodayView.tsx 的子任务勾选框、SettingsModal.tsx 的 Switch 是
          同一个已知限制、同一个解法（theme.ts 顶部注释），这里局部再压一次
          是因为 TaskGrid 的多数调用方（看板/四象限/全部/已完成……）不像
          TaskBoard/TodayView 那样整棵子树套了 boardLocalTheme。 */}
      {select?.showCheckbox && (
        <ConfigProvider theme={boardLocalTheme}>
          <Checkbox
            className="ink-sel-check"
            aria-label={`选中「${t.title}」`}
            checked={select.selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => select.onClick({ shift: false, ctrlOrMeta: true })}
          />
        </ConfigProvider>
      )}
      {/* 序号：网格里每张卡自己带着「第几位」，不靠位置推断。也是拖拽抓手。
          `rank` 和 `drag` 任一给了就画这个手柄——只给 `drag`（看板/四象限）
          时没有数字可显示，也**不能**显示 `rank`（哪怕它是 undefined 硬转
          出来的东西），换成一个不带编号的抓手字形 `⠿`：那两个视图格子内的
          顺序是 `readTasks()` 的文件顺序，不是任何人排出来的，标上数字会
          让人以为能拖着重新排序，而同格拖放其实是 `TaskGrid.tsx` 有意做成
          的空操作，见 CardProps.rank 的注释。 */}
      {(rank !== undefined || drag) && (
        <div
          className={drag?.disabled ? 'ink-rank ink-rank-locked' : 'ink-rank'}
          // 没有 drag（这条分支目前只会在纯展示 rank 的假设场景下出现，实际
          // 调用点 rank 永远和 drag 成对传）时保持装饰性、对读屏软件隐藏；
          // 有 drag 时可达性交给下面摊开的 attributes（role/tabIndex/……）
          // 自己说明，不再需要 aria-hidden。
          aria-hidden={drag ? undefined : true}
          // 可访问名字必须显式给，不能指望 `title` 兜底——见 DragHandleProps.title
          // 的注释（复审修复轮 1 · I3）：这个节点永远有文本内容（排位数字或
          // `⠿`），accname 规范里 `title` 只在没有内容时才会被拿来当名字，
          // 有内容时内容本身赢，`title` 只剩下鼠标悬停 tooltip 这一个作用。
          aria-label={drag?.title}
          ref={drag?.setActivatorNodeRef}
          title={drag?.title}
          {...drag?.attributes}
          {...drag?.listeners}
        >
          {rank ?? '⠿'}
        </div>
      )}
      {/* 卡片左边一条 3px 竖条，清单色。放在 Space 外面（不占任何行的位置，
          绝对定位相对 .ink-task-card——见 theme.css 里 .ink-task-card 已有的
          position: relative）——编辑态下也照常显示，跟序号一个道理：这是
          「这张卡属于哪个清单」的记号，不是表单内容的一部分。 */}
      {!detail && list && <span className="ink-list-bar" style={{ backgroundColor: list.color }} aria-hidden="true" />}
      <Space direction="vertical" size={6} style={{ display: 'flex' }}>
        {draft ? (
          // 局部 ConfigProvider 压 colorPrimary：跟下面子任务/选中勾选框
          // 同一个已知限制（antd 6 的 DatePicker 选中态直接读全局
          // token.colorPrimary 派生出的 controlItemBgActive，没有组件级 token
          // 能单独覆盖，见 theme.ts 顶部 boardLocalTheme 那段注释）。TaskFields
          // 里有两个 DatePicker（截止/提醒），套了 repeat 的话 RepeatFields
          // 里还有第三个（重复截止）——都是这一层的子孙，一层 ConfigProvider
          // 三个一起盖住。这里以前**没有**套：只有 TaskBoard/TodayView 整棵
          // 子树套了 boardLocalTheme，恰好盖住了它们各自渲染出来的编辑态，
          // 其余视图（全部/已完成/看板/四象限/搜索/接下来/清单/标签/日历……）
          // 点开一张卡改时间，日期面板里「今天」的圈、选中那天的底色全是
          // 群青——是选中态那批（2026-08-17-selection）修子任务勾选框时
          // 留下的同一个盲区，这次一起补上，见 final-review.md I3。
          <ConfigProvider theme={boardLocalTheme}>
            <TaskFields
              value={draft}
              onChange={setDraft}
              lists={lists}
              // 候选表在这儿算，不在表单里：判据要看全部任务，而 TaskFields
              // 只认识「这一条草稿」。allTasks 没给就不给候选，那一项整个不
              // 渲染——跟上面两个层级记号同一条。
              // `parentOptionsFor` 而不是 `parentCandidates`：它会把这条任务当下
              // 挂着的那个父亲补进去（父亲做完之后就不再是候选）。少了这一步，
              // 下拉框会显示「不是谁的子任务」、而卡片上画着「↳ 属于……」，
              // 而且候选为空时整个框不渲染、这条子任务再也摘不下来。
              parentOptions={allTasks ? parentOptionsFor(allTasks, t).map((x) => ({ id: x.id, title: x.title })) : undefined}
              // 分段候选从全表现算——跟标签一样，分段在这个应用里没有实体。
              // 判据只有一份（`grouping.ts` 的 `sectionNames`），分组那边用的是
              // 同一个，不然会出现「分组里有这一段、下拉里没有」。
              sectionOptions={allTasks ? sectionNames(allTasks) : undefined}
              // 键盘保存/取消（仿滴答清单：标题框里回车就是「写好了」）。跟下面
              // 那两颗按钮走同一对函数，不另写一条路——`save()` 自己会挡空标题、
              // 失败时把编辑框和草稿留着，那些判断一条都不能绕过去。
              onSubmit={() => void save()}
              onCancel={cancelEdit}
            />
          </ConfigProvider>
        ) : (
          <>
            {/* 详情面板顶上那一行（仿滴答清单）：左边一个勾选圈，右边这条任务的
                日期。**这两件事是打开一条任务最常要做的**——做完了、或者改个
                时间，之前都得先进整张卡的编辑态（改期还得走 ⋯ 菜单）。

                勾选圈直接借 `TaskRow` 那两个类名，不新画一个：同一个动作在
                行档和详情里长得一样，而且那份是纯 CSS 画的圆，天然绕开
                「antd 选中态直接读全局 colorPrimary（群青）」那个已知盲区
                （theme.ts 顶部注释）——群青是配给制，只标 AI 产出的内容，
                「我把它做完了」是人自己按的。判据也照抄那一份：done 就标回
                todo，不是标成别的什么状态。

                日期用的就是编辑表单里那个 DatePicker（同一套 format、同样
                allowClear 就是清空），只是去掉边框摆成一颗药丸。`variant`
                和 `suffixIcon={null}` 只改样子，不改行为。外面那层
                ConfigProvider 压 colorPrimary 跟编辑态那处同一个理由：
                日期面板里「今天」的圈和选中那天的底色会直接读全局主色。 */}
            {detail && (
              <div className="ink-dt-top">
                <button
                  type="button"
                  className={`ink-trow-check${t.status === 'done' ? ' ink-trow-check-done' : ''}`}
                  aria-pressed={t.status === 'done'}
                  aria-label={t.status === 'done' ? `把「${t.title}」标回待办` : `把「${t.title}」标记完成`}
                  onClick={() => onPatch(t.id, { status: t.status === 'done' ? 'todo' : 'done' })}
                >
                  {t.status === 'done' && <span aria-hidden="true">✓</span>}
                </button>
                <ConfigProvider theme={boardLocalTheme}>
                  <DatePicker
                    className="ink-dt-date"
                    variant="borderless"
                    suffixIcon={null}
                    showTime={{ format: TIME_FORMAT }}
                    // **说人话，跟行档和卡片档同一个词**（`dueText`）：同一条任务
                    // 在列表里写着「今天 18:00」、点开详情变成「2026-08-25 18:00」，
                    // 是这个仓库明写过的一类缺陷（TaskCard 时间那一行的注释）。
                    // antd 的 `format` 收得下一个函数；代价是这个框不能再直接打字
                    // 输入日期——对一颗药丸来说本来就是点开面板挑，不是打字。
                    format={(v) => dueText(v.toISOString(), now)}
                    allowClear
                    placeholder="设置日期"
                    value={t.due ? dayjs(t.due) : null}
                    onChange={(d) => onPatch(t.id, { due: d ? d.toISOString() : null })}
                  />
                </ConfigProvider>
                {/* 优先级旗靠右（`.ink-dt-flag` 自己 margin-left: auto，不写成
                    祖先打头的选择器——那种写法会从 theme.css.test.ts 那条前缀
                    扫描里整条隐形）。**它在这一行，不在标题旁边**：竖排的
                    `<Space>` 会把标题那一行的兄弟节点各摊成一行，旗单独占一行
                    看起来像渲染坏了（实测截图确认过）。 */}
                {t.priority > 0 && (
                  <span
                    className={`ink-dt-flag ink-pri-flag ink-pri-${t.priority}`}
                    role="img"
                    aria-label={`优先级：${PRI_LABEL[t.priority as 1 | 2 | 3]}`}
                  >⚑</span>
                )}
              </div>
            )}
            {/* 旗和标题必须在同一个节点里：<Space direction="vertical"> 把 Fragment
                打平，每个直接子节点各占一个 .ant-space-item——两个 <span>/<Typography.Text>
                分开写会各占一行，旗变成孤零零的一行，不是「标题前面」。
                不把旗塞进 Typography.Text 内部：那样 status==='done' 时 delete
                会连旗一起划掉。优先级：一面小旗，填充色区分档位（规格「第三条
                通道」——分类和优先级都只走 background/fill，标题永远是石墨黑）。
                0 不画。

                这面旗不按 t.source 分群青/石墨黑——不是漏了，是规格正面
                答过的：AI 拆解时不能直接写 priority（一律 0），只能在 updates
                里建议，人接受了才落地，见 2026-08-13-full-rebuild-design.md
                「updates 的字段白名单扩容」一节。到了这里渲染的值不会是「AI
                写的、人还没看过」，群青标的正是那种中间态（跟下面 due/提醒
                那两行按 t.source 切换 ink-time-ai 不是一回事），这面旗用不上，
                颜色固定走 --pri-3/2/1，见 theme.css 里那三个变量上方的注释。 */}
            <div className="ink-card-titlerow">
              {/* **一键完成。** 在这之前，卡片档要完成一条待办得走两步
                  （「开始」→「完成」，见 MOVES.todo 只有开始/搁置；划动手势和
                  ⋯ 菜单里也都没有「完成」）——而同一个动作在行档是点一下勾选圈、
                  在详情面板是点一下勾选圈、批量是一个 D 键。**同一件事在四个
                  地方三种代价**，而卡片档还是默认那一档。滴答清单那边每条任务
                  不管摆成什么样都有一个勾选框。
                  借的就是行档那两个类名和那条判据（`done ? 'todo' : 'done'`），
                  不新画一个圈、也不新写一套状态判断——详情面板那颗（`detail`
                  分支里那个）也是同一份，三处长一个样。
                  **`detail` 下不画**：那一屏顶上已经有一个了。 */}
              {!detail && (
                <button
                  type="button"
                  className={`ink-trow-check ink-card-check${t.status === 'done' ? ' ink-trow-check-done' : ''}`}
                  aria-pressed={t.status === 'done'}
                  aria-label={t.status === 'done' ? `把「${t.title}」标回待办` : `把「${t.title}」标记完成`}
                  onClick={() => onPatch(t.id, { status: t.status === 'done' ? 'todo' : 'done' })}
                >
                  {t.status === 'done' && <span aria-hidden="true">✓</span>}
                </button>
              )}
              {!detail && t.priority > 0 && (
                <span
                  className={`ink-pri-flag ink-pri-${t.priority}`}
                  role="img"
                  aria-label={`优先级：${PRI_LABEL[t.priority as 1 | 2 | 3]}`}
                >⚑</span>
              )}
              {/* 点标题收起回行档（final-review「行档展开收不回去」）。整行
                  可点展开成这张查看态的卡（TaskGrid.tsx/TodayView.tsx 的
                  onOpen={() => setEditing(t.id, true)}），但收起没有对称的
                  入口——`onEditingChange(id, false)` 在这份文件里只有
                  cancelEdit()/save()/卸载三处调用，都在「取消/保存一次真的
                  编辑」的路径上，没有一处对应「只是打开看了一眼，点一下收走」。
                  这里直接复用 `onEditingChange`，不新增一个 `onCollapse` prop：
                  能让 `editingIds` 变成 true、同时 `draft` 仍是 null（也就是
                  这段 JSX 真的渲染出来的那一刻）的路径只有 TaskRow.onOpen
                  一条——TaskCard 自己的 `startEdit()` 会把 draft 和
                  `onEditingChange(true)` 一起置真，那时候标题已经换成了
                  TaskFields 的输入框，这段 <Typography.Text> 根本不在 DOM
                  里。所以对着「查看态」点标题调用 `onEditingChange(id,
                  false)`，在全站其余每一处 TaskCard（按来源、卡档的
                  TaskGrid、日历……）都是拿着一个本来就不在 editingIds 里的
                  id 去 delete，天然是幂等空操作；只有行档展开出来的这一种
                  场景，这一下才真的把它收回去。
                  按了 Shift/Ctrl/Cmd 的点击原样放行，不在这里拦截——留给
                  下面 Card 级的 `onClick`（选中态那条路）去处理，跟
                  TaskRow.tsx `onTitleClick` 用「有没有修饰键」分流是同一条
                  判据，不会出现「Ctrl 点一下」被这里先收起、选中逻辑再也
                  收不到这次点击的手势打架。 */}
              {/* 详情面板里标题是这一栏的大标题，**点一下就地改**——不用先
                  进整张卡的编辑态。包在 `<h2>` 里的一颗按钮，是「可点的标题」
                  这件事的标准写法：读屏按标题跳能跳到它，键盘 Tab 过去回车
                  就开始改，两样都不用另外接线。
                  回车 = 写好了（`plainEnter`，跟编辑表单里标题框同一条规矩）；
                  Esc = 不改了；点到别处 = 落盘。 */}
              {detail ? (
                titleDraft === null ? (
                  <h2 className="ink-dt-h">
                    <button
                      type="button"
                      className={`ink-dt-title${t.status === 'done' ? ' ink-dt-title-done' : ''}`}
                      onClick={() => openInline(setTitleDraft, t.title)}
                    >{t.title}</button>
                  </h2>
                ) : (
                  <Input
                    className="ink-dt-title-edit"
                    aria-label="标题"
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(e) => {
                      const k = formKey(e, { plainEnter: true });
                      if (k === 'submit') { e.preventDefault(); void commitTitle(); }
                      if (k === 'cancel') { e.preventDefault(); abortInlineEdit(() => setTitleDraft(null)); }
                    }}
                  />
                )
              ) : (
              <Typography.Text
                strong
                delete={t.status === 'done'}
                style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                  onEditingChange(t.id, false);
                }}
              >{t.title}</Typography.Text>
              )}
            </div>
            {/* 详情面板里备注是这一栏的正文（仿滴答清单）：**非编辑态渲染成
                markdown，点一下变回原始文本开始写，点到别处就落盘、重新渲染**。
                写的时候是纯文本、所见即所改——这一点跟编辑表单一字不差，用的
                本来就是同一个 `NotesEditor`（`/` 菜单、Ctrl+Enter、输入法守卫
                全都在里面），不是在这儿另写一个 textarea。

                外面这层不用 `<button>` 包：渲染出来的 markdown 里可能有链接、
                表格、勾选框，把它们塞进一颗按钮里既是非法 HTML，也会让那些
                链接点不动。所以用 `role="button"` + `tabIndex` 让键盘够得着，
                鼠标那一侧靠 `isInteractiveTarget` 放行链接和按钮——点链接就是
                点链接，不该顺手进编辑，跟整张卡 onClick/onDoubleClick 用的是
                同一道判断、同一个函数。

                空备注也要有个点得着的地方，否则「点正文开始写」在一条还没写过
                备注的任务上根本无处可点。 */}
            {detail && (
              notesDraft === null ? (
                <div
                  className="ink-dt-notes"
                  role="button"
                  tabIndex={0}
                  aria-label="备注"
                  onClick={(e) => {
                    if (isInteractiveTarget(e.target, 'button, a')) return;
                    openInline(setNotesDraft, t.notes ?? '');
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    if (isInteractiveTarget(e.target, 'button, a')) return;
                    e.preventDefault();
                    openInline(setNotesDraft, t.notes ?? '');
                  }}
                >
                  {t.notes
                    ? <Markdown source={t.notes} />
                    : <span className="ink-dt-notes-empty">写点什么……</span>}
                </div>
              ) : (
                <NotesEditor
                  value={notesDraft}
                  onChange={setNotesDraft}
                  autoFocus
                  // 离焦就渲染，「预览」这颗开关在这里是同一件事的第二个入口，
                  // 而且点它会把焦点从正在写的框里带走。
                  hidePreview
                  // 面板比卡片高得多，长备注不用挤在六行里。
                  maxRows={20}
                  onBlur={() => void commitNotes()}
                  onSubmit={() => void commitNotes()}
                  onCancel={() => abortInlineEdit(() => setNotesDraft(null))}
                />
              )
            )}

            {/* 多级任务（仿滴答清单）的两个记号。**只在有 allTasks 时才画**，
                见那条 prop 的注释。
                子任务：说清它属于谁——平铺列表里子任务紧跟在父亲后面
                （lib/hierarchy.ts 的 nestChildren），但换个视图、或者父亲被
                筛掉了，这条卡就是孤零零一张，没有这句话看不出它是谁的一步。
                父任务：一个 1/3 的进度，不用点进去数。 */}
            {parent && <span className="ink-parent-mark">↳ 属于「{parent.title}」</span>}
            {kids && <span className="ink-kids-mark">子任务 {kids.done}/{kids.total}</span>}

            {/* 清单名前一个 6px 实心圆点，颜色跟左边那条竖条一样；名字本身是
                石墨黑——规格「第三条通道」：分类色只出现在 background/fill，
                不上字。 */}
            {/* `!detail`：详情面板把「这条归在哪个清单」摆到了整栏最底下那一条
                （仿滴答清单，见 TaskDetail.tsx 的页脚）——同一个事实在一栏里
                出现两次，第二次就只是噪音。 */}
            {!detail && list && (
              <span className="ink-list-name">
                {/* 跟侧栏同一条：名字前面的 emoji 当图标、替掉圆点，
                    见 lib/listIcon.ts。 */}
                {listLabel(list.name).icon
                  ? <span className="ink-list-emoji">{listLabel(list.name).icon}</span>
                  : <span className="ink-list-dot" style={{ backgroundColor: list.color }} aria-hidden="true" />}
                {listLabel(list.name).text}
              </span>
            )}

            {t.tags.length > 0 && (
              <div className="ink-tag-row">
                {t.tags.map((x) => <span className="ink-tag-chip" key={x}>{x}</span>)}
              </div>
            )}

            {/* 重复规则不是 AI 产出，石墨黑，不借群青——那是配额制的颜色，只标
                「这是 AI 写的/推断的」。这行是它自己独立的一行，跟清单名/标签
                同一个套路：这几个已经是 <Space direction="vertical"> 外层那个
                Fragment 打平出来的兄弟节点，各占一个 .ant-space-item，不是新踩
                Task 1 那个「把记号塞进 Fragment 导致独占一行」的坑——这里本来
                就该是独立一行。 */}
            {t.repeat && <span className="ink-repeat-mark">↻ {describeRepeat(t.repeat)}</span>}

            {/* 情境（GTD）。跟重复规则、「在等」同一档轻处理（小号、灰）：它们都是
                一条状态注记，不是任务本身。
                **不画就等于没有这个字段**——筛选栏筛得到、表单填得了，卡片上却一个
                字都不显示的话，人筛出一屏之后看不出哪几条是怎么进来的，也无从发现
                哪一条分错了情境。`waitingFor` 就是这么干放了很久，见下面那段。 */}
            {t.context && <span className="ink-context-mark">@{CONTEXT_LABEL[t.context]}</span>}

            {/* 在等谁/等什么。**画出来**——筛选栏一直有「只看等待中的」，而卡片
                上一个字都不显示：筛出来一屏任务，看不出各自在等什么，也想不起
                该去催谁。跟重复规则同一档轻处理（小号、灰），它是一条状态注记，
                不是任务本身。 */}
            {/* **等了多久也要说。** 只写「在等 张老师」的话，等了两天和等了三个
                星期长得一模一样——而 GTD 的等待清单每周过一遍，问的就是「这条
                该催了吗」，「多久」正是那半句答案。口径是「多久没动静」不是
                「等了多久」，三天以下不说，判据和理由在 taskView 的
                `waitingQuietLabel`。 */}
            {t.waitingFor && (
              <span className="ink-waiting-mark">
                ⏳ 在等 {t.waitingFor}
                {waitingQuietLabel(t, now) && <span className="ink-waiting-quiet"> · {waitingQuietLabel(t, now)}</span>}
              </span>
            )}

            {/* `!detail && t.due`：详情面板顶上那颗日期药丸说的就是这一个字段，
                不在下面再说一遍。**「过期」那个记号照旧**——它不是「截止时间是
                什么」，是「已经欠着了」，药丸里没有这句话。 */}
            {/* `blocker` 也要算进这个开关：被父亲挡着的那种子任务**很可能一个
                时间字段都没有**（日期写在父亲身上），少了它这一整行不渲染，
                下面那句「「装修」9月1日 才开始」就永远画不出来——测试实测过。 */}
            {(overdue || (!detail && t.due) || notStarted(t, now) || blocker || remindAt || spent > 0 || t.estimateMinutes || t.postponeCount >= POSTPONE_MIN) && (
              <div className="ink-task-times">
                {/* 「过期 3 天」而不是光一句「已过期」：欠一小时和欠三个星期
                    长得一模一样的话，这个记号就只剩「有问题」三个字，没法拿来
                    决定先干哪个。判据在 lib/taskView.ts 的 overdueLabel。 */}
                {overdue && <span className="ink-overdue-mark">{overdueLabel(t, now) ?? '已过期'}</span>}
                {/* 截止/提醒的键名（不是值）用群青标——群青标的是「这是 AI 写的/
                    推断的」，手工任务自己填的时间跟正文一样安静，这里按
                    t.source 决定，不是按字段本身。 */}
                {/* **时间说成人话，跟行档一个词。** 这两处原来走 `formatWhen`
                    的绝对格式，于是同一条任务在行档下是「今天 18:00」、切成卡片
                    档变成「截止 2026-08-24 18:00」——而卡片上它左边紧挨着的就是
                    「过期 3 小时」，同一个事实的相对说法和绝对说法并排摆着。
                    `formatWhen` 留给记录（专注记录、收件箱时间戳、建议的新旧
                    对比），那些地方问的正是「具体哪一刻」。 */}
                {/* **还没到开始时间就写出来**（OmniFocus 的 Defer Date）。
                    到了之后不再显示：那时候「开始时间」是历史，屏幕上留着它
                    只是噪音——人这时候要看的是截止和过期。
                    跟截止用同一个 `dueText` 说人话（「明天 09:00」而不是
                    「2026-09-01 09:00」），不新造一种时间写法。 */}
                {/* 时刻和「开始」之间留一个半角空格：`dueText` 吐的是
                    「9月10日 09:00」，紧挨着写就是「09:00开始」——数字和汉字
                    之间不留空隙，跟这一行里「截止 今天 17:30」那种排法不一致。 */}
                {notStarted(t, now) && t.startAt && (
                  <span className="ink-notstarted-mark">{dueText(t.startAt, now)} 开始</span>
                )}
                {/* **父亲还没开始，这一条现在也做不了。**（`blockingAncestor`，
                    出处和为什么在 hierarchy.ts 上。）四象限和「现在做什么」按
                    这个判据把它挡在外面，屏幕上就必须说得出为什么——不然一条
                    自己没设开始时间的子任务从那两屏消失，是无解的。
                    **写出祖先的名字**，不只写日期：他要么去改那条的日期，要么
                    把这条摘出来，两条路都得先知道是谁挡着。
                    自己也没开始时不重复画——上面那枚已经说了「那天之前别管」，
                    并排两句「9月1日 开始」「装修 9月1日 才开始」是同一件事说两遍。 */}
                {!notStarted(t, now) && blocker && (
                  <span className="ink-notstarted-mark">
                    「{blocker.title}」{dueText(blocker.startAt as string, now)} 才开始
                  </span>
                )}
                {!detail && t.due && (
                  <span>
                    <span className={t.source === 'ai' ? 'ink-time-ai' : undefined}>截止</span> {dueText(t.due, now)}
                  </span>
                )}
                {remindAt && (
                  <span>
                    <span className={t.source === 'ai' ? 'ink-time-ai' : undefined}>提醒</span> {whenText(remindAt, now)}
                    {/* 还有几个没显示就说出来。卡片是摘要，摊开三四个时刻会
                        把这一行撑爆；但**只显示第一个、一个字不提还有别的**，
                        会让人以为就设了那一个——一条任务现在可以有好几个提醒
                        （见 TaskFields 那串选择器）。 */}
                    {t.reminders.length > 1 && <span className="ink-meta-more"> +{t.reminders.length - 1}</span>}
                  </span>
                )}
                {/* 已专注 / 预计。**跟截止和提醒同一行**：它们都是「这条任务
                    的时间事实」，分两行会让本来就密的卡片再长一截。这两个永远
                    是石墨黑，不看 t.source——番茄钟是人自己按的，估计也是人填
                    的，AI 写什么都不算数（outbox.ts 的 stripForced）。 */}
                {/* 「改过 N 次期」。**这个数一直在存，却只在「建议」那一栏露过面**
                    （`suggest.ts` 的「一拖再拖」组）——而它最该出现的地方正是你
                    盯着这张卡想「这个到底做不做」的时候。门槛跟那一组共用同一个
                    常量，不各写一个 2。
                    用跟「已过期」同一个记号：两者是同一类信息（说好的和实际的
                    对不上了），不为它另发明一种颜色——这条理由跟旁边「专注超了
                    预计」那一处一字不差。 */}
                {t.postponeCount >= POSTPONE_MIN && (
                  <span className="ink-overdue-mark">推迟过 {t.postponeCount} 次</span>
                )}
                {(spent > 0 || t.estimateMinutes) && (
                  <span className={over ? 'ink-overdue-mark' : undefined}>
                    {spent > 0 ? `已专注 ${formatMinutes(spent)}` : '还没专注过'}
                    {t.estimateMinutes ? ` / 预计 ${formatMinutes(t.estimateMinutes)}` : ''}
                  </span>
                )}
              </div>
            )}

            {/* 按 markdown 渲染，不是纯文本——AGENTS.md 明写「支持 markdown」，
                AI 拆解时会往这里写标题/列表/代码块。react-markdown 直接构造
                React 元素，不经过 HTML 字符串那条路，见 Markdown.tsx 顶部
                注释。编辑态（上面 draft 分支）走的是 TaskFields 里的
                Input.TextArea，纯文本、所见即所改——只有查看态渲染成
                富文本。 */}
            {!detail && t.notes && <Markdown source={t.notes} />}
          </>
        )}

        {/* 编辑态里不显示提议：你正在手改这个字段，旁边摆一个「AI 想把它改成
            别的」的按钮，点下去会把你没保存的草稿覆盖掉。改完再说。 */}
        {!draft && proposals?.byTask.get(t.id)?.map((p) => (
          <ProposalNote key={p.id} p={p} task={t} lists={lists} onAccept={proposals.onAccept} onDismiss={proposals.onDismiss} />
        ))}

        {/* subtasks 缺失时兜底成空数组：GET /api/tasks 不校验文件写入的数据，
            一个漏写这个字段的任务不该让整页白屏。子任务勾选不属于这次的编辑态，
            编辑中也照样能勾。
            局部 ConfigProvider 压 colorPrimary：跟下面选中勾选框（.ink-sel-check）
            同一个已知限制（antd 6 的 Checkbox 选中态直接读全局 token.colorPrimary，
            没有组件级 token 能单独覆盖，见 theme.ts 顶部注释）——「勾掉一个子任务」
            是人的动作，不该被染成群青（群青是配给制，只标 AI 产出的内容）。
            这里以前**没有**套这层：只有 TaskBoard/TodayView 整棵子树套了
            boardLocalTheme，恰好盖住了这个勾选框会被渲染到的两个地方，其余视图
            （全部/已完成/看板/四象限/搜索/接下来/清单/标签……）勾一下子任务就是
            群青——是选中态那批（2026-08-17-selection）之前就有的既有缺陷，这次
            顺手一起修，用的是跟选中勾选框同一个解法：只局部套这一小块，不去动
            外层调用方有没有套过 boardLocalTheme。 */}
        <ConfigProvider theme={boardLocalTheme}>
          {subs.map((s, i) => (
            <div className="ink-subtask-row" key={`${t.id}-${i}`}>
              <Checkbox
                className="ink-subtask"
                checked={s.done}
                onChange={(e) => putSubs(subs.map((x, k) => (k === i ? { ...x, done: e.target.checked } : x)))}
              >
                {/* 编辑态里这一项的文字变成输入框——**在这之前检查事项只有 AI
                    拆得出来**：表单里刻意不含这个字段（那行注释写着「真要手填
                    再说」），于是手工建的任务永远没有检查事项，而「全勾完就
                    自动完成」「⤴ 转成子任务」「子任务 n/m」三样都建在它上面。
                    打错一个字也只能整条删了重加。 */}
                {draft ? (
                  <input
                    className="ink-subtask-edit"
                    aria-label={`第 ${i + 1} 项检查事项`}
                    value={s.text}
                    onChange={(e) => putSubs(subs.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                  />
                ) : (
                  /* 查看态按**行内 markdown** 渲染：AI 往这里写「跑
                     `npm run report`」「对一遍 **口径**」是常事，而备注早就
                     渲染了——同一段文字换个字段就变成一串反引号，说不通。
                     `inline` 只去掉段落那层壳，写的时候（上面 draft 那一支）
                     仍然是纯文本、所见即所改，跟备注一条规矩。
                     链接**不用**额外拦点击：`<a href>` 是 HTML 规范里的
                     interactive content，点在它上面时浏览器不会把这次激活
                     转给 label 关联的勾选框（真浏览器里实测过，不是推断）。 */
                  <Markdown source={s.text} inherit inline />
                )}
              </Checkbox>
              {draft && (
                <button
                  type="button"
                  className="ink-subtask-del"
                  aria-label={`删掉检查事项「${s.text}」`}
                  onClick={() => putSubs(subs.filter((_, k) => k !== i))}
                >×</button>
              )}
              {/* 转为子任务（仿滴答清单）。**只在真转得动的那一项旁边出现**：
                  父任务自己已经是子任务的（多级只做一层）、文字是空的，
                  `promoteSubtask` 都会回 null。判据在 lib/hierarchy.ts。 */}
              {onPromoteSubtask && promoteSubtask(t, i, allTasks) && (
                <Button
                  className="ink-subtask-promote"
                  size="small"
                  type="text"
                  aria-label={`把「${s.text}」转成子任务`}
                  title="转成一条真正的子任务，就能单独设截止时间和备注"
                  onClick={() => onPromoteSubtask(t, i)}
                >⤴</Button>
              )}
            </div>
          ))}
          {/* 「加一条」。**只在编辑态出现**：一个常驻在每张卡下面的空输入框，
              对绝大多数没有检查事项的任务纯属噪音。空的那一行本身就是那颗
              「添加」按钮，跟提醒那串选择器同一个手势（见 TaskFields）。 */}
          {draft && (
            <input
              className="ink-subtask-edit ink-subtask-add"
              aria-label="加一条检查事项"
              placeholder="加一条检查事项…"
              value={newSub}
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const text = newSub.trim();
                // 空的不加——回车多半是想收工，不是想加一条没有内容的。
                if (!text) return;
                putSubs([...subs, { text, done: false }]);
                setNewSub('');
              }}
            />
          )}
        </ConfigProvider>

        {/* 附件（规格第六节最后一项）。**查看态下 attachments 为空整段不渲染
            列表/拾取框**——`data/` 里现有任务没有一条带附件，默认状态每张卡
            都摆一个常驻的框是噪音，不是「等真的用到了再出现」；一旦有了至少
            一个附件，这块跟着出现，同一个位置。**编辑态永远显示**，不看
            attachments 是否为空：编辑到一半想拖个文件进来是自然的动作（跟
            编辑标题不是一回事，不该因为在改标题就摸不到附件），而且
            `<input type=file>` 那条键盘/读屏可达的拾取路径本来就要在某处
            出现，编辑态是它现成的入口。

            **拖放目标是整张 Card，不是这个 div**（final-review.md「专项
            判定」）：`over`/`uploading`/`onUpload` 都来自上面调用一次的
            `useFileDrop(t.id)`，这里只转发，不重新起一份状态——拖放本身
            接在 Card 节点上（见上面 `{...dropProps}`），文件不管落在卡片
            哪个位置都会被接住，不需要先点「编辑」才摸得到。 */}
        {(draft || (t.attachments ?? []).length > 0) && (
          <Attachments taskId={t.id} attachments={t.attachments ?? []} over={fileOver} uploading={uploading} onUpload={upload} offline={offline} />
        )}

        {/* AI 的拆解理由。网格化之后页边没有了，它从卡片外的留白挪进卡片里，
            接在正文之后、操作之前——它解释的是「这条为什么长这样」，
            读完内容再读它，顺序是对的。视觉语言不变（群青、衬线、斜体），
            但那条虚线从左边挪到了上边：在页边时它是「另起一栏」，在卡片里
            它是「下面这段是另一个人写的」。 */}
        {showNote && t.aiComment && !draft && (
          <aside className="ink-margin-note">
            <span className="ink-margin-who">AI 的拆解理由</span>
            {/* 收到两行，点「展开」看全文。搬进卡片之后它不再是页边批注了——
                实测占掉一张卡 20%～34% 的高度，一张只有标题的卡有三分之一是
                群青斜体，「群青是配给制」这条规矩视觉上就不成立了。
                两行够用：这段话的用途是扫一眼「AI 为什么这么拆」，真要细看
                再展开。用 antd 的 ellipsis 不手写 -webkit-line-clamp——那个
                自己实现不了「展开」这一半。 */}
            <Typography.Paragraph
              style={{ marginBottom: 0 }}
              ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
            >
              {t.aiComment}
            </Typography.Paragraph>
          </aside>
        )}

        <Space size={6} wrap align="center">
          {/* 状态角标是这张卡「现在处在哪一步」的唯一来源——status 不合法时
              （手改文件、AI 手滑）原始值就标在这里，用过期橙标出来，不装作
              没发生过（见 taskView.ts 的 isStatus 注释），不需要在别处再重复
              一遍同样的信息。 */}
          {!draft && (
            <span className={isStatus(t.status) ? 'ink-status-pill' : 'ink-status-pill ink-status-pill-bad'}>
              {statusLabel}
              {/* **搁了很久的把天数写在角标里。** 搁置是「暂时不做」，而这个
                  应用里它不进「今天」「接下来」「四象限」，也不进推荐面板
                  （suggest.ts 的 isCandidate 把搁置算作了结）——不写这个数字的话，
                  三个月前搁下的和昨天搁下的长得一模一样，GTD 那档「将来也许」
                  就成了黑洞。挂在角标里而不是另起一个记号：说的是同一件事的
                  两半（现在是什么状态 + 这个状态待了多久）。判据在
                  taskView 的 parkedQuietLabel（30 天门槛，只少说不多说）。 */}
              {parkedQuietLabel(t, now) && (
                <span className="ink-parked-quiet"> · {parkedQuietLabel(t, now)}</span>
              )}
            </span>
          )}
          {/* 置顶要看得见——一条排在最前面的卡，人得知道它是「被按上去的」
              还是「本来就该在这儿」，不然下次想让它别在最前面时不知道去点哪。
              一个字形，不是一整块标签：它跟状态角标并排，那儿本来就窄。 */}
          {!draft && t.pinned && <span className="ink-pin-mark" title="已置顶">📌</span>}
          {draft ? (
            <>
              {/* color="default"：全站约定，你自己按的按钮不用 type="primary"
                  ——那个语义上是「这个按钮拿主色」，即便主色已经被上面的
                  ConfigProvider 压回你的墨，写 primary 仍然是在暗示「这是主操作、
                  该用品牌色」，跟约定对不上。variant="solid" 表示分量：编辑态里
                  这是唯一的确认动作。 */}
              <Button size="small" color="default" variant="solid" loading={saving} disabled={!draft.title.trim() || saving} onClick={() => void save()}>保存</Button>
              <Button size="small" disabled={saving} onClick={cancelEdit}>取消</Button>
            </>
          ) : (
            <>
              {/* 同样的兜底：status 不合法时当成 todo 处理，避免 MOVES[t.status]
                  是 undefined 时 .map 把整页炸掉。 */}
              {MOVES[isStatus(t.status) ? t.status : 'todo'].map((m) => (
                <Button key={m.to} size="small" onClick={() => onPatch(t.id, { status: m.to })}>
                  {m.label}
                </Button>
              ))}
              {/* 番茄钟：规格「卡片上一个『开始专注』，倒计时结束往该任务的
                  focusSessions 追加一条」。**追加不是覆盖**——onComplete 拿到
                  的只是这一轮新产出的那一条，把它跟已有的 focusSessions 拼起来
                  发 PATCH 是这里的责任，FocusTimer 自己不知道、也不该知道这张
                  卡已经攒了几条。`t.focusSessions ?? []` 兜底：GET /api/tasks
                  不校验文件写入的数据，跟上面 subtasks 的兜底同一条理由
                  （TaskCard.tsx 渲染 .ink-subtask 那段注释）。 */}
              <FocusTimer
                minutes={focusMinutes}
                // 写进浏览器标签页用（`FocusTimer` 里那两个 effect），界面上
                // 不显示——卡片标题就在旁边。
                label={t.title}
                breakMinutes={breakMinutes}
                onComplete={(session) => onPatch(t.id, { focusSessions: [...(t.focusSessions ?? []), session] })}
                /* **中途被卸载了要说一声。** 「关掉页面 = 放弃」是规格定死的，
                   但卸载不止那一种：切到日历看一眼、把密度从卡片换成行、这张
                   卡被筛掉，都会卸载它——那几下用户并没有觉得自己在放弃什么，
                   而屏幕上那个走了十八分钟的倒计时就这么没了。不改「不记」这条
                   规矩，只是不再瞒着。用 warning 不用 info：丢了东西。 */
                onAbandon={() => void message.warning(`「${t.title}」${FOCUS_ABANDON_TAIL}`)}
              />
              {/* 「编辑」「删除」收进这颗 ⋯，不再各占一颗按钮。
                  卡片网格化之后一张卡最窄只有 358px（2560 下六列），而一张
                  待办卡摆着状态角标 + 两步状态动作 + 编辑 + 删除 + 上下移动
                  共六个控件，实测 2560 下每一张的按钮都要折成两行——屏幕最宽
                  的时候按钮反而放不下。收起这两颗之后一行装得下。
                  顺带把删除这个分量最重的动作从一等位置挪走：它原本紧挨着
                  「编辑」，两颗都是文字按钮、只差一个字宽——删除现在会先进
                  垃圾箱、不是没有退路，但误触的代价还是不该跟「编辑」一样轻。 */}
              <Dropdown trigger={['click']} menu={cardMenu}>
                <Button size="small" type="text" aria-label={`「${t.title}」的更多操作`}>⋯</Button>
              </Dropdown>
              {/* 「今天」视图专属：手动排序的键盘/鼠标共用路径，见 TaskCard.tsx
                  顶部 MoveControls 的注释。边界处禁用（不是隐藏）——禁用的原生
                  按钮天然退出 Tab 顺序，这是这个仓库已经在用的可达性写法
                  （保存按钮的 disabled 同一套）。 */}
              {move && (
                <span role="group" aria-label={`调整「${t.title}」在今天列表里的顺序`}>
                  <Button className="ink-move-btn" ref={move.upRef} size="small" aria-label="上移" disabled={!move.canMoveUp || move.busy} loading={move.loadingUp} onClick={move.onUp}>↑</Button>
                  <Button className="ink-move-btn" ref={move.downRef} size="small" aria-label="下移" disabled={!move.canMoveDown || move.busy} loading={move.loadingDown} onClick={move.onDown}>↓</Button>
                </span>
              )}
            </>
          )}
        </Space>
      </Space>
    </Card>
    </Dropdown>
    </div>
  );
}
