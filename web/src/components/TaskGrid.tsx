import { useRef, useState, type ReactNode } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCorners, useDndContext, useDroppable, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import type { List, Task } from '../types.js';
import { TaskCard, type DragHandleProps } from './TaskCard.js';
import { TaskRow } from './TaskRow.js';
import { hasPendingProposal, type ProposalWiring } from './ProposalNote.js';
import { clickToSelection, type SelState } from '../lib/selection.js';
import type { Density } from '../lib/density.js';
import { useCancelStuckDrag } from '../lib/dnd.js';

export interface GridSection {
  key: string;
  title: string;
  tasks: Task[];
  /**
   * 组头上那颗按钮（现在只有「接下来」的「已过期」用，见 App.tsx 的
   * `withDeferAll`）。**这一层只管画**：画什么、什么时候有，由造 sections
   * 的那一方决定——`TaskGrid` 被六个视图共用，在这儿写死「哪一组该有什么
   * 按钮」等于把某一个视图的规矩塞进公共件里。
   */
  action?: ReactNode;
  /**
   * 这一组**一开始就是折起来的**（现在只有清单/标签视图的「已完成」
   * 「已放弃」用）。不是「能不能折」——每一组都能折，见下面 sectionNodes
   * 那处注释。
   *
   * 存在的理由：一份用了一年的清单，底下挂着两百条做完的卡，每次点进去都要
   * 从它们上面滚过去。折起来加一个数字比整个藏掉更本分——「这份清单我做完过
   * 多少」本身是句有用的话，而且一点就展开，不用去别的去处翻。
   *
   * （这儿原来写着「滴答清单那边默认干脆不显示已完成的」。**那句话反了**：
   * 语料里教的是「如何**隐藏**已完成任务」这个动作（`如何编辑四象限规则.md`、
   * 日历那边同理），用「隐藏」就说明默认是显示的。）
   *
   * **只在不能拖的那一支生效**（没给 `onDropTo` 的视图）。能拖的格子里一个
   * 折起来的格子等于一个看不见的放置目标，那是另一件事，需要时再说。
   */
  startFolded?: boolean;
}

/**
 * `TaskGrid` 需要转交给每张 `TaskCard` 的那一组 props——独立成一个具名类型，
 * 不写在 `Props` 内联，是因为 `CalendarView` 的当天列表也是一个 `TaskGrid`
 * （CalendarView.tsx），需要转发同一组字段。以前 `CalendarView` 自己手写一份
 * 副本（一个个字段声明、一个个字段转发），新字段加进这里之后要记得去
 * `CalendarView.tsx` 补两处——补漏一次，见 final-review.md I2：这里加了
 * `focusMinutes` 字段，`CalendarView` 没跟着补，TypeScript 对 JSX spread 不做
 * 多余属性检查，`App.tsx` 的 `gridWiring` 照样把它摊开传了进去，编译期不报错，
 * 运行期悄悄丢。这不是第一次：上一批漏的是 `selection`/`onSelectionChange`/
 * `editRequestId`/`onEditRequestHandled` 四个字段，同一个机制、同一个位置，
 * 隔一批又漏了一次。
 *
 * 现在 `CalendarView` 的 `Props` 直接 `extends GridWiring`，用一份
 * `{...wiring}` 整体转发（不再逐个手写）——新增字段只用改这一处：
 * `App.tsx` 的 `gridWiring` 对象类型跟着这个接口走，`CalendarView` 的
 * `Props` 也跟着走，转发那一行天然带上新字段，没有第二处要记得改。
 */
export interface GridWiring {
  now: Date;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onEditTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
  onDelete: (id: string) => void;
  proposals?: ProposalWiring;
  /** 转交给每张 TaskCard——摊开的 gridWiring 不会自动流到孙子组件，
   * 这里必须显式收一份、显式传一份。 */
  lists: List[];
  /** 全部任务，转交给每张 TaskCard 画多级任务那两个记号（见 TaskCard 那条
   *  prop 的注释）。跟 lists 同一个「必须显式收一份、显式传一份」的道理。 */
  allTasks?: Task[];
  /** 创建副本，同样只是转交。 */
  onDuplicate?: (t: Task) => void;
  /**
   * 选中态（批量操作的地基，见 2026-08-17-selection.md）。**跟 App 一层的
   * state 双向绑定（controlled）**：`selection` 是当前值，`onSelectionChange`
   * 是这次点击算出来的新值该往哪儿写——TaskGrid 自己不持有这份 state，只算
   * 「这次点击该变成什么」（`clickToSelection`），真正的 state 放在 App 一层，
   * 是那份文档「架构」一节明确定的（跨视图切换要能清空，TaskGrid 实例一多，
   * state 分散在每个实例里没法统一清）。
   *
   * **两个都不给（今天所有调用方的默认状态）时，这整套选中 UI 完全不接线**：
   * 没有勾选框，点击卡片什么都不做——今天的行为一个字不变。给就两个一起给，
   * 只给一个没有意义（有 `selection` 没有 `onSelectionChange` 的话，点了也
   * 没地方写新状态；反过来同理）。
   *
   * **渲染顺序从这里算，不在外面另算一遍**：Shift 连选要的是屏幕上看到的
   * 顺序，卡片是分组渲染的（`sections`——看板四列、四象限四格、接下来六段），
   * 只有下面 `orderedIds`（用这个函数体已经算好的 `shown`摊平出来）才是
   * 「屏幕上真正看到的那个顺序」；调用方拿原始的 `tasks` 数组自己另算一遍
   * 的话，两处顺序会分叉，Shift 连选会选中「屏幕上不连续的一段」，用户完全
   * 看不懂，见 task-3-brief 要点①。
   */
  selection?: SelState;
  onSelectionChange?: (next: SelState) => void;
  /**
   * 'E' 键触发的编辑请求（批量操作的地基，见 2026-08-17-selection.md Task 4）。
   * App 算出「选中恰好一张」时把那张卡的 id 放这里；`TaskGrid` 只做一件事——
   * 找到 `t.id` 等于这个值的那张卡，把它的 `TaskCard.autoEdit` 置真，别的卡
   * 都是 false。不给（undefined）时任何卡的 `t.id === editRequestId` 天然
   * 都不成立，等于完全不接线，今天的行为不变。
   *
   * `onEditRequestHandled`：跟 `editRequestId` 成对，卡片自己进入编辑态之后
   * 会回调它——不清的话，编辑同一张卡两次（退出、选中还在、再按一次 E）会
   * 因为这个 id 没变而不重新触发，见 TaskCard.tsx `CardProps.autoEdit` 的
   * 注释。
   */
  editRequestId?: string | null;
  onEditRequestHandled?: () => void;
  /**
   * 「打开一条任务」交给右边那一栏详情面板（仿滴答清单），而不是让那一行
   * 当场膨胀成一张卡。**给了就换行为，不给就是原来那样**——不给的调用方
   * （TaskBoard 那种本来就是卡片的、以及测试里只关心列表本身的）一个字都
   * 不用改。
   *
   * 换掉的是三处，它们在行档本来全都等于「展开那张卡」：点标题 / ⋯ 菜单里的
   * 「编辑」/ 'E' 键。**三处都改，但后两处多带一个 `edit: true`**——「看看
   * 这条」和「我要改它」是两个意图，都塞进同一个查看态，等于让他开了面板
   * 再去翻一次 ⋯ 菜单。
   *
   * 为什么值得换：行档点一条任务，那一行当场变成一张卡，它下面所有任务往下
   * 跳一大截——你正要点的下一条跑了。理由整段在 TaskDetail.tsx 顶部。
   */
  onOpenDetail?: (id: string, opts?: { edit?: boolean }) => void;

  /**
   * 面板现在摊着的是哪一条——列表里那一行要标出来（`TaskRow.current`）。
   * 跟 `onOpenDetail` 成对：一个把任务送过去，一个把「送过去的是谁」标
   * 回来。不给就没有任何一行被标，等于不接线。
   */
  openDetailId?: string | null;
  /** 转交给每张 TaskCard——番茄钟一轮的时长，见 TaskCard.tsx CardProps 的
   *  注释。可选、不给就是 TaskCard 自己的默认值，不强制这里的调用方都得
   *  知道这个数字。 */
  focusMinutes?: number;
  /** 转交给每张 TaskCard 再转交给 Attachments——离线记号（task-3-brief），
   *  见 TaskCard.tsx CardProps.offline 的注释。可选、不给就是 TaskCard 自己
   *  的默认值 false（假设在线，今天的行为不变）。 */
  offline?: boolean;
  /**
   * 一轮走完之后歇多久，转交给每张 TaskCard 的番茄钟。**跟 `focusMinutes`
   * 是一对，漏了它的后果不是「少一个功能」而是「行为跟别处不一样」**：
   * TaskCard 那边的默认值是 0 = 不休息，于是他在设置里定的休息时长在所有
   * 格子视图里静默失效，而详情面板里（直接摊 `cardWiring`，不经这一层）是
   * 生效的——同一颗番茄钟，两个地方两种走法。
   */
  breakMinutes?: number;
  /**
   * 跳过这一次。**必须转发，不能让它掉在这一层**：TaskCard 的 ⋯ 菜单里
   * 「跳过」没接到这个回调时会退回发一条普通 patch，而服务端字段级的推迟
   * 计数会把那条 patch 记成一次拖延——「跳过不是拖延」正是
   * `POST /api/tasks/:id/skip` 这条路由存在的全部理由。攒够几次，卡片上
   * 就挂出「推迟过 N 次」（TaskCard 的 `POSTPONE_MIN`），建议面板也跟着标。
   */
  onSkip?: (id: string) => void;
  /** 检查事项转子任务。不给就是那颗按钮整个不出现（TaskCard 那边的判断），
   *  于是同一张卡在详情面板里有这颗按钮、在看板上没有。 */
  onPromoteSubtask?: (t: Task, index: number) => void;
}

interface Props extends GridWiring {
  /**
   * 刚被勾成「已完成」、还在原地划着删除线的那几条（仿滴答清单：勾完先划掉、
   * 停一下再移走，不是当场蒸发）。**跟 `editingIds` 并进同一个 keep 集合**
   * 交给 `sections()`。
   *
   * 可选，默认空集：十几个调用点漏接一个不该让那一屏行为跟别处不一样，而
   * 「当场消失」正是加这个 prop 之前的行为。状态和计时都在 App.tsx。
   */
  linger?: Set<string>;
  /**
   * 算分组。**是函数不是数组**：参数是「哪些卡正在编辑」，调用方要把它 OR 进
   * 自己的谓词里，让这张卡在某个组里继续出现——不然它会直接从所有组里消失，
   * 见 TodayView.tsx 里「筛选重算不该把编辑框连带草稿一起卸载」那个坑（卡连同草稿一起从列表里没了）。
   *
   * 光有这半步不够：调用方的谓词只保证卡「还在某处」，保证不了「还在同一组」。
   * 分组视图上这个坑更深——改个日期就会从「明天」跳到「7 天内」，卡片换了
   * 父节点，React 照样把它当成全新元素卸载重挂，草稿一样丢。这后半步由
   * `TaskGrid` 自己接住：见下面 `home` 那段，正在编辑的卡强制钉回它编辑开始
   * 前所在的那一组，不跟着新的分组结果跳组。
   *
   * **每条任务在返回的数组里只能出现在一个组里。** 钉组靠的是 `key` 去重定位
   * 「这张卡本来在哪」，同一个 id 出现在两个组里会撞 React 的 key（同一个
   * `t.id` 被塞进两个不同的 `bins` 桶，其中一个会静默吃掉另一个，控制台报
   * `Encountered two children with the same key`）。写 `sections` 时不要为了
   * 「让编辑中的卡在多处可见」把它同时塞进好几个组的 `tasks` 里——上面那句
   * 「OR 进自己的谓词」说的是选一个组收留它，不是每个组都收留一遍。
   */
  sections: (editing: Set<string>) => GridSection[];
  /** 每一组都空的时候显示的那一行字。 */
  empty: string;
  /**
   * **筛选把东西全挡掉时**说的那句，替掉上面那句。
   *
   * 「一条任务都没有」在筛选开着的时候是一句假话：你有两百条，只是这个筛选
   * 一条都没匹配上。这个仓库反复躲的就是这种「界面说的跟实际不符」——而这一
   * 句还刚好长得像「数据没了」。
   *
   * **判断落在这个组件里**，不在调用方：只有它知道最后到底渲没渲成空的。
   * 调用方那边 `matched === 0` 时列表也未必是空的——正在编辑的那张卡会被
   * `filterSections` 特意留下来（不留的话编辑框会在手底下蒸发），那时候
   * 该显示的是那张卡，不是任何一句空状态。
   */
  emptyFiltered?: string;
  /** 'stack'（默认，今天的行为：分组竖着摞）| 'cells'（并排的格子，看板/四象限用）。 */
  layout?: 'stack' | 'cells';
  /** 默认 false（今天的行为：空组连标题都不出）。看板/四象限要 true——一个空的
   * 「进行中」列/象限格必须还在，否则没有地方可以把卡拖进去。 */
  keepEmpty?: boolean;
  /** 给了就把每个格子变成放置目标，卡片也变成可拖的。参数是「这张卡的 id」和
   * 「落进了哪个格子的 key」。**落进它本来所在的那一格不会触发这个回调**——
   * 那是一次没有变化的操作，调用方一般会把它接到 onPatch 发一条 PATCH，
   * 不加这个判断的话拖回原处也会白白写一次盘。不给这个 prop（今天/接下来/
   * 全部……这些视图都不给）时，卡片不会冒出拖拽手柄，格子也不是放置目标——
   * 那种视图里手柄拖不动，出现了就是纯粹的噪音。
   *
   * task-3-brief：拖拽机制从原生 HTML5 Drag and Drop 换成了 `@dnd-kit`——
   * 见下面 `GridCell`/`SortableTaskItem`/`handleDragEnd` 的注释。这个 prop
   * 本身的签名/语义（给不给决定接不接线、`(taskId, cellKey)`、拖回原处不
   * 触发）一个字没变，`App.tsx` 两个调用点（看板/四象限）不用跟着改。 */
  onDropTo?: (taskId: string, cellKey: string) => void;
  /**
   * 每张卡渲染成密度更高的 `TaskRow` 还是完整的 `TaskCard`。**默认 `'card'`——
   * 今天的行为一个像素都不变**（task-2-brief 的上限断言）。
   *
   * **故意不放进 `GridWiring`**，虽然它跟 `focusMinutes`/`lists` 长得很像
   * （都是「转发给每张卡的一个值」）。区别在于：`GridWiring` 里的字段是「每个
   * 网格视图都该给同一份」的东西——漏传会静默丢功能（`selection` 漏了选不中
   * 卡片、`focusMinutes` 漏了番茄钟悄悄换成别的默认值），所以才值得为它做
   * `extends GridWiring` 这层结构性防护。`density` 不是：它是**按视图各自决定
   * 要不要开**的显示偏好——看板/四象限现在还固定卡片（`TaskRow` 还没有拖拽
   * 抓手，接了会让「拖卡改状态」这个核心交互失效），日历当天列表同理没接。
   *
   * **这个决定本身站得住，但这段注释曾经写错过两条理由**——修复轮 1 的代码
   * 审查抓到的，留着当反面教材，别再抄错：
   *
   * ① 曾经说「进 `GridWiring` 反而要多写 `density="card"` 去覆盖，比现在
   * 手写 `density={density}` 更多接线」——算术是反的。需要覆盖的只有看板/
   * 四象限/日历三处，现在手写的却是五处（`search`/`upcoming`/`all`/`done`/
   * 清单标签的回退分支），3 < 5，这条不成立。
   *
   * ② 曾经说「忘传会安全降级到 `card`，不会静默出错」——只说对了一半。
   * **渲染**确实会安全降级：这个字段默认 `'card'`，忘传的那个视图就停在
   * 今天已经测过的样子，不会崩、不会显示错误内容。但**控件不会跟着降级**：
   * `density` 是 App 一层全局唯一一份 state，`DENSITY_VIEWS`（`App.tsx`）是
   * 另一张独立的表，单独决定哪些视图**显示**那颗开关。忘了在某个视图的调用点
   * 接 `density={density}`，那个视图的开关依然会出现（只要它在
   * `DENSITY_VIEWS` 里）——用户点「行」，别的视图真的换了，这一个视图纹丝
   * 不动：**同一颗开关在 A 视图管用、B 视图不管用，这不是安全降级，是静默
   * 失灵**。task-2 修复轮 1 的变异 C1/M4 就是实测证据：删掉四处
   * `density={density}`，`App.test.tsx` 原有的 138 条测试原样全绿、退出码 0
   * ——`density?` 是可选字段，类型系统在这条路上一句话都说不上。
   *
   * 真正兜住这条的不是类型系统，是 `App.test.tsx` 里那条对 `DENSITY_VIEWS`
   * 逐个视图循环一遍、断言「点了『行』之后这个视图的面板里真的渲染出
   * `TaskRow` 而不是 `TaskCard`」的测试（循环的名单直接从 `DENSITY_VIEWS`
   * 派生，不是抄一份写死的视图名字）。新加一个可切视图要同时做对三件事——
   * 进 `DENSITY_VIEWS`、在调用点写 `density={density}`、被这条循环测试盖到——
   * 这三件事之间目前没有编译期能查的结构性防护，靠的是这条测试和这段注释。
   */
  density?: Density;
  /**
   * 行档的紧凑排版（task-3-brief 修复轮 1 · C-2），原样转发给 `TaskRow`——
   * 见 `TaskRow.tsx` `TaskRowProps.compact` 的注释。**只有看板的调用点传**
   * （App.tsx），判据是「这一列只有 217px」，不是 `layout === 'cells'`——
   * 四象限也是 `cells` 但每格 455px，标题读得全，不该被一起改窄。默认
   * `undefined`（今天的行为不变），`density !== 'row'` 时这个 prop 天然
   * 用不上（`TaskCard` 没有紧凑排版这回事）。
   */
  compact?: boolean;
}

/** dnd-kit 的 `over`/`active` 会话数据在跨容器（多个 `SortableContext`）场景
 *  下携带 `sortable.containerId`——每个格子的 `SortableContext` 都显式给了
 *  `id={section.key}`（见下面 `GridCell`），所以这个字段就是「这条任务这一刻
 *  挂在哪个格子」，不用我们自己另外维护一份「拖拽来源是哪一格」的 state
 *  （以前 `dragging: { id, from }` 干的就是这件事）。落在格子本身的空白处
 *  （`over.id` 直接是格子的 key，不是某张卡）时没有这份 `sortable` 数据。 */
interface SortableData {
  sortable?: { containerId?: string };
}

/**
 * 复审修复轮 1 · I5：格子里的顺序从来不是任何人排出来的（`readTasks()` 的
 * 文件顺序，`handleDragEnd` 的 `from === to` 守卫也明确说过「同格拖放是
 * 空操作」）——但 `@dnd-kit/sortable` 默认的 `rectSortingStrategy` 会在拖动
 * 经过别的卡时让它们的 `transform` 挪位置「让路」，视觉上等于在演一次
 * 其实不会发生的重排（实测过：两张卡在同一格内拖动，`transform` 真的变成
 * `translate3d(0, ±50px, 0)`，松手 `onDropTo` 却调用 0 次）——这个动效自己
 * 兑现了 `CardProps.rank` 注释特意关照过的那句话「标上数字会让人以为能在
 * 格子里拖着重新排序」，只是换成了动效在替它说这句话。
 *
 * 传一个永远返回 `null` 的 strategy：`@dnd-kit/sortable` 不会再给「正在被
 * 拖过」但本身没被拖的卡计算位移——**被拖的那张卡自己不受影响**，它的
 * 跟手位移来自 `useDraggable` 自己的 `transform`（`SortableTaskItem` 里的
 * `style`），不经过这个 strategy，拖起来该跟手还是跟手，只是不再有「其它
 * 卡会让位」这个没有兑现过的视觉承诺。跨格键盘吸附（`sortableKeyboardCoordinates`）
 * 靠的是 `droppableRects`/碰撞检测，不读这个 strategy，不受影响——两件事
 * 互不相干，`TaskGrid.test.tsx` 里全部键盘拖拽测试改完之后原样绿，见
 * task-3-report.md 修复轮 1 的验证记录。
 */
const noReflowStrategy = () => null;

/**
 * 单张卡/行的可拖拽包装——调用 `useSortable`，把结果转成 `DragHandleProps`
 * 喂给 `children`（`renderTaskBody`）。**必须是独立的模块级组件**，不能内联
 * 写在 `.map()` 回调里：`useSortable` 是 hook，一个分组里卡片数量随
 * `sections()` 的结果变化，内联调用会导致同一次渲染里 hook 调用次数不固定，
 * 违反 Hooks 规则。
 *
 * `role="listitem"` 挂在这里（外层，不是 `renderTaskBody` 内部渲染的
 * `TaskCard`/`TaskRow`）——跟以前手写的 `<div role="listitem">` 是同一个
 * DOM 位置，`.ink-row-dragging` 也钉在这一层，改用 `isDragging`（dnd-kit
 * 自己算的，不用再靠我们自己的 `dragging` state 判断）。
 */
function SortableTaskItem({
  id, dragTitle, children,
}: {
  id: string;
  dragTitle: string;
  children: (drag: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useSortable({ id });
  // translate3d 手写，不引 @dnd-kit/utilities 的 CSS.Transform.toString——
  // 只是把 {x,y} 拼成一个字符串，没有必要为一行字符串拼接多装一个包
  // （这批任务本身要求只装 @dnd-kit/core + @dnd-kit/sortable，见报告依赖
  // 四问）。四舍五入避免拖拽跟手时子像素抖动。
  const style = transform
    ? { transform: `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` }
    : undefined;
  return (
    <div role="listitem" ref={setNodeRef} style={style} className={isDragging ? 'ink-row-dragging' : undefined}>
      {children({ title: dragTitle, disabled: false, attributes, listeners, setActivatorNodeRef })}
    </div>
  );
}

/**
 * 组头。**两处都用这一个**：能拖的格子（`GridCell`，看板/四象限）和不能拖的
 * 分组（下面 `sectionNodes` 的另一支）各自渲染自己的 `<section>`，但组头是
 * 同一个东西——各写一份的话，加一个字段只改到一处，另一处静默不长（这批
 * `section.action` 就是这么漏的：只加在 GridCell 里，「接下来」没有 onDropTo，
 * 走的是另一支，按钮一个都没出来）。
 */
function SectionHeading(
  { section, fold }: { section: GridSection; fold?: { folded: boolean; onToggle: () => void } },
) {
  const inner = (
    <>
      {section.title}
      {/* 计数不上群青：它是对现有卡片的机械统计，不是 AI 产出的新信息。
          双色墨水是配额制的，见 theme.css 顶部。 */}
      <span className="ink-grid-count ink-mono">{section.tasks.length}</span>
    </>
  );
  return (
    <h2 className="ink-grid-heading">
      {/* 能折的时候整个标题是一颗按钮（键盘也点得到），不是在旁边另摆一个
          小三角——标题本身就是最大、最好点的那个目标。`aria-expanded` 让读屏
          说得出「展开/折起」，光靠一个 ▸ 字形它读不出来。 */}
      {fold ? (
        <button type="button" className="ink-grid-fold" aria-expanded={!fold.folded} onClick={fold.onToggle}>
          <span className="ink-grid-caret" aria-hidden="true">{fold.folded ? '▸' : '▾'}</span>
          {inner}
        </button>
      ) : inner}
      {section.action}
    </h2>
  );
}

/**
 * 一个格子——`useDroppable` 让它自己（不只是格子里的卡）也是一个放置目标，
 * 拖到空白处/空格子照样能落。`useDndContext()` 读当前这一刻的 `active`/`over`，
 * 算「这一格该不该整格高亮」（`.ink-grid-section-over`）：**不能只用这个格子
 * 自己 `useDroppable` 返回的 `isOver`**——那个只在 `over` 精确等于这个格子
 * 自己（拖到空白处）时才是 true，悬停在格子里的某一张卡上时 `over` 是那张卡
 * 的 id，`isOver` 会是 false，导致「悬停在卡片上时格子不亮，只有悬停在空白处
 * 才亮」——跟以前原生拖放（`onDragOver` 在容器上，冒泡吃下子元素的悬停）这个
 * 行为对不上，见 task-3-brief 要点「拖拽手感」逐条对齐。这里改成看
 * `over` 归属的格子 key（卡片的话读 `sortable.containerId`，格子本身的话
 * `over.id` 直接就是），整格判断，不管悬停在格子里哪个位置。
 */
function GridCell({
  section, density, renderTask,
}: {
  section: GridSection;
  density: Density;
  renderTask: (t: Task, drag: DragHandleProps) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: section.key });
  const { over } = useDndContext();
  const overCellKey = over
    ? ((over.data.current as SortableData | undefined)?.sortable?.containerId ?? String(over.id))
    : null;
  return (
    <section
      ref={setNodeRef}
      className={['ink-grid-section', overCellKey === section.key ? 'ink-grid-section-over' : ''].filter(Boolean).join(' ')}
    >
      <SectionHeading section={section} />
      {/* 容器按密度二选一，不是叠加：卡档（默认）两列网格 .ink-card-grid，
          行档单列封顶 .ink-row-list——见 task-3-brief 第二条要点。两个类名
          互斥，切密度就是换这一个 className，不改内部结构。 */}
      <div className={density === 'row' ? 'ink-row-list' : 'ink-card-grid'} role="list">
        <SortableContext id={section.key} items={section.tasks.map((t) => t.id)} strategy={noReflowStrategy}>
          {section.tasks.map((t) => (
            <SortableTaskItem key={t.id} id={t.id} dragTitle="拖动可以放进另一个格子">
              {(drag) => renderTask(t, drag)}
            </SortableTaskItem>
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

/** 默认空集提到模块层：写成默认参数 `= new Set()` 的话每次渲染都是一个新对象，
 *  白白让下面那些 useMemo/依赖比较判成「变了」。 */
const EMPTY_LINGER: Set<string> = new Set();

export function TaskGrid({
  sections, now, empty, emptyFiltered, onPatch, onEditTask, onDelete, proposals, lists, allTasks, onDuplicate,
  layout = 'stack', keepEmpty = false, onDropTo, selection, onSelectionChange,
  editRequestId, onEditRequestHandled, onOpenDetail, openDetailId, focusMinutes, breakMinutes, offline,
  onSkip, onPromoteSubtask, density = 'card', compact,
  linger = EMPTY_LINGER,
}: Props): ReactNode {
  // `editingIds` 原本只有一个语义：「这张卡有没保存的草稿，别把它连草稿一起
  // 卸载了」（见上面 Props.sections 那段长注释）。行档接上「点标题展开成卡」
  // 之后（onOpen={() => setEditing(t.id, true)}，下面渲染处），它同时承担
  // 了第二个语义——「用户点开看了一眼，还没编辑」，因为这条路复用的就是同一份
  // state，没有另起一套「展开」集合。这两个语义共用同一个布尔值有两处能看见
  // 的副作用：① 下面 `home` 钉组逻辑会把「只是看了一眼」的卡也钉死在当前分组，
  // 跟一张真在编辑的卡待遇一样；② 调用方在算 `sections(editingIds)` 时要把
  // 它 OR 进自己的筛选/成员资格判断，于是一张「只是被点开看了一眼」的卡，从
  // 打开到关闭这段时间里也不受筛选/视图成员资格约束（跟真在编辑的卡一致）。
  // 这两点在「打开着」的这段时间都能接受——效果上跟一张真在编辑的卡完全一样，
  // 只是「编辑」换成了「看了一眼」；写在这里是为了让下一个读到这段代码、
  // 不知道这段历史的人不用重新想一遍「这是不是漏洞」。
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const setEditing = (id: string, editing: boolean) =>
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (editing) next.add(id); else next.delete(id);
      return next;
    });

  // 拖拽用的传感器——指针（鼠标/触屏，真实浏览器用）+ 键盘（Tab 到抓手→
  // Space 拿起→方向键移动→Space 放下，task-3-brief 的主要收益）。
  // **必须无条件调用**（Hooks 规则）：`onDropTo` 没给时下面压根不会挂
  // `DndContext`，这两个 sensor 描述对象造好放在这儿，不会被任何东西消费，
  // 运行期零开销（`useSensor` 只是包一层配置对象，不订阅任何事件）。
  // `activationConstraint: { distance: 4 }`：按下去要先挪 4px 才算开始拖，
  // 挡住「只是点一下手柄」被误判成一次拖拽——原生 HTML5 拖放本来就有操作
  // 系统级的类似阈值，这里给个小的等价物，不是新加的行为。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 拖拽会话的 id 追踪，见下面 `useCancelStuckDrag` 那次调用旁边的注释——
  // 放在这里只是因为 useState 调用要放在组件顶层，跟 sensors 挨着写。
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  /**
   * 折起来的组。**存的是「他点过什么」，不是「现在是折是展」**——后者每次
   * 渲染都要拿 `startFolded` 重算一遍，而 `sections()` 每次渲染都产出新对象，
   * 一算就会把他刚展开的那一组又折回去。这里只记显式点过的那几个 key，没点过
   * 的按 `startFolded` 走，跟 `TaskFields` 那个 `<details>` 只在挂载时算一次
   * 是同一条教训。
   */
  const [foldChoice, setFoldChoice] = useState<Record<string, boolean>>({});
  const isFolded = (s: GridSection) => foldChoice[s.key] ?? s.startFolded ?? false;
  const toggleFold = (s: GridSection) =>
    setFoldChoice((prev) => ({ ...prev, [s.key]: !(prev[s.key] ?? s.startFolded ?? false) }));

  // 每张（不在编辑中的）卡最后一次落在哪一组——用来把正在编辑的卡钉住。
  // ref 不是 state：这份记录不需要触发重渲染，只是给下面的钉组逻辑读上一轮
  // 的答案，跟 TodayView.tsx 的 lastMoveRef/buttonRefs 是同一个套路。
  const home = useRef(new Map<string, string>());
  // **刚勾完的那几条也要留住。** `linger` 跟 `editingIds` 并进同一个集合交给
  // `sections()`——对这个组件来说两者是同一件事：「这一屏的谓词已经不认它了，
  // 但现在还不能让它从眼前消失」。判据和时长在 App.tsx 的 `lingerDone`。
  const raw = sections(linger.size === 0 ? editingIds : new Set([...editingIds, ...linger]));
  const bins = new Map(raw.map((s) => [s.key, [] as Task[]]));
  for (const s of raw) {
    for (const t of s.tasks) {
      // 正在编辑：钉回上一次记的那一组（找不到就退回这次算出来的组，比如它
      // 是这一轮才第一次出现的）。不在编辑：正常跟着这次算出来的组走，
      // 顺便把这一组记成它的新「家」，供它下次进入编辑态时钉回来。
      const homeKey = editingIds.has(t.id) ? home.current.get(t.id) : undefined;
      const key = homeKey ?? s.key;
      (bins.get(key) ?? bins.get(s.key)!).push(t);
      if (!editingIds.has(t.id)) home.current.set(t.id, s.key);
    }
  }
  // 空组连标题都不出——「明天(0)」「7 天内(0)」一路排下去，屏幕上全是零。
  // keepEmpty（看板/四象限用）关掉这条：格子永远都在，才有地方能把卡拖进去。
  const withTasks = raw.map((s) => ({ ...s, tasks: bins.get(s.key)! }));
  const shown = keepEmpty ? withTasks : withTasks.filter((s) => s.tasks.length > 0);

  // Shift 连选用的「屏幕上看到的顺序」——从 `shown` 摊平，不是从原始
  // `sections`/`tasks` 另算：`shown` 已经是钉组、去空组之后**真正会渲染**的
  // 那份，两份顺序只有在这里算才保证一致，见 Props.selection 的注释。
  const orderedIds = shown.flatMap((s) => s.tasks.map((t) => t.id));

  // 拖到一半、被拖的那张卡从 sections() 里消失了（SSE 把它标成完成/删了/
  // 被 /expand 合并……都可能）——见 `lib/dnd.ts` `useCancelStuckDrag` 的
  // 注释，那里有完整的问题描述和为什么选这个修法（不重挂任何东西，不会像
  // 早前一版那样把同一格里别的卡的未保存草稿一起清空，见 task-3-report.md
  // 修复轮 1 · I2）。
  useCancelStuckDrag(activeDragId, shown.some((s) => s.tasks.some((t) => t.id === activeDragId)));

  if (layout !== 'cells' && shown.every((s) => s.tasks.length === 0)) {
    return <p className="ink-empty-note">{emptyFiltered ?? empty}</p>;
  }

  // 拖进格子改字段（看板/四象限用，onDropTo 没给时这套完全不接线）。
  const renderTaskBody = (t: Task, drag: DragHandleProps | undefined): ReactNode => {
    // 选中态：只有 selection/onSelectionChange 两个都给了才接线——见
    // Props.selection 的注释，今天所有调用方都没给，这里是 undefined，
    // 两个分支的行为都一个字不变。**在两个分支之外算一次、两个分支
    // 共用同一个表达式**（不是各自各写一份 `select={...}` 三元）——
    // 这就是「TaskRow 复用的是已经流到 TaskGrid 里的那套
    // selection/onSelectionChange，不是另起一套语义」在代码层面的
    // 落地：两个分支拿到的字面上是同一个对象，不是两份分别构造、
    // 可能悄悄分叉的同名字段。
    const selectWiring = selection && onSelectionChange ? {
      selected: selection.ids.has(t.id),
      // 只在「已经选中了至少一张」时出现，全局共享同一个判断，
      // 不是每张卡各自决定——见 task-3-brief 要点②。
      showCheckbox: selection.ids.size > 0,
      onClick: (mods: { shift: boolean; ctrlOrMeta: boolean }) =>
        onSelectionChange(clickToSelection(selection, orderedIds, t.id, mods)),
    } : undefined;
    // 待决建议记号（TaskRow.tsx Props.hasProposal 的注释）——布尔值，
    // 不是完整的 proposals 对象：行档只画「这条有事」，不画建议本身，
    // 用不上 onAccept/onDismiss。算式提成了 ProposalNote.tsx 的
    // `hasPendingProposal`，跟 TodayView.tsx 共用同一份（整分支审查
    // B1：以前两处各写一份一模一样的表达式，TodayView 那份没有测试）。
    const hasProposal = hasPendingProposal(proposals, t.id);

    // 「打开这一条」。给了 `onOpenDetail` 就交给右边那一栏，没给就退回原来
    // 那条路（就地膨胀成一张卡）——三处落点（点标题、⋯ 菜单里的「编辑」、
    // 'E' 键）共用这一个，不各写一遍 `onOpenDetail ? … : …`：三处本来就是
    // 同一个动作，写三遍就会有一天只改到其中两处。
    const open = (id: string, edit = false) =>
      (onOpenDetail ? onOpenDetail(id, edit ? { edit: true } : undefined) : setEditing(id, true));

    return density === 'row' && !editingIds.has(t.id) ? (
      // 行档、且这张卡没被「打开」：紧凑的一行。点标题（TaskRow 的
      // onOpen）复用既有的 editingIds/setEditing/home 钉组那一整套——
      // 不新起一个「展开」状态，见 Props.density 的注释。`setEditing`
      // 之后这张卡的 id 进了 editingIds，下一次渲染这个分支的条件
      // 不再成立，落进下面的 TaskCard 分支：默认是查看态（完整信息，
      // 不是表单）——TaskCard 自己的编辑表单只在用户点它的「编辑」
      // 时才会打开，onOpen 不会替用户点这一步。
      //
      // **`editRequestId`/`autoEdit`（'E' 键）在行档的落点**：行档没有就地
      // 编辑表单，「编辑」的意思就是展开那张卡——跟点标题、跟这一行 ⋯ 菜单里
      // 的「编辑」是同一件事。所以这里不透传 `autoEdit`，而是把 `editRequestId`
      // 指到自己时直接展开，然后立刻回调清掉那个请求（跟 TaskCard 的
      // `onAutoEdited` 同一个握手，否则那个 id 会一直挂着，下次渲染又展开一次）。
      // 这条以前是记在账上的缺口（表现是「行档按 E 没反应」）。
      <TaskRow
        t={t}
        now={now}
        onPatch={onPatch}
        onOpen={() => open(t.id)}
        select={selectWiring}
        hasProposal={hasProposal}
        drag={drag}
        compact={compact}
        // 「更多操作」菜单跟卡片共用一份（lib/taskMenu.ts）。`onEdit` 落到
        // 跟 onOpen 同一处——行档没有就地编辑表单，「编辑」的意思就是展开
        // 那张卡，跟点标题是同一件事。
        lists={lists}
        // 层级记号要看全表——跟下面 TaskCard 那一支传的是同一份。
        allTasks={allTasks}
        // **带上「他要改」这个意图**：点标题是「看看这条」，⋯ 菜单里的
        // 「编辑」和 'E' 键（TaskRow 内部也走 onEdit）是「我要改它」——
        // 后者直接把面板里那张卡开成表单，不让人开了面板再去翻一次 ⋯ 菜单。
        onEdit={(id) => open(id, true)}
        onDelete={onDelete}
        current={openDetailId != null && t.id === openDetailId}
        editRequested={t.id === editRequestId}
        onEditRequestHandled={onEditRequestHandled}
      />
    ) : (
      <TaskCard
        t={t}
        now={now}
        lists={lists}
        allTasks={allTasks}
        onDuplicate={onDuplicate}
        onPatch={onPatch}
        onEditTask={onEditTask}
        onDelete={onDelete}
        onEditingChange={setEditing}
        proposals={proposals}
        // 拖拽抓手复用「今天」视图已有的那套 rank/drag prop（TaskCard.tsx
        // 的注释），不新加第二套拖拽 prop——但**不传 rank**：这里的格子
        // 顺序是 readTasks() 的文件顺序，不是任何人排出来的，标上数字会
        // 让人以为能在格子里拖着重新排序，而同格拖放是下面故意做成的
        // 空操作。只传 drag，TaskCard 会换成不带编号的抓手字形，见
        // TaskCard.tsx 里 CardProps.rank 的注释。onDropTo 没给就不传
        // drag，抓手整个不出现。
        drag={drag}
        select={selectWiring}
        // 'E' 键的落点：只有 t.id 恰好等于 editRequestId 的那张卡拿到
        // true，其余卡（包括 editRequestId 是 undefined/null 的默认
        // 情况）拿到 false——见 Props.editRequestId 的注释。
        autoEdit={editRequestId != null && editRequestId === t.id}
        onAutoEdited={onEditRequestHandled}
        focusMinutes={focusMinutes}
        breakMinutes={breakMinutes}
        onSkip={onSkip}
        onPromoteSubtask={onPromoteSubtask}
        offline={offline}
      />
    );
  };

  /**
   * 一次拖拽落定（`@dnd-kit` 的 `onDragEnd`）——**两条守卫都在这里**：
   *
   * ① **外来拖拽不转发**：`@dnd-kit` 只在自己的 `DndContext` 里派发
   * `active`/`over`（指针/键盘事件只在挂了 `listeners` 的抓手节点上才会
   * 触发，选中一段文字拖进来走的是浏览器原生 Drag and Drop API，`@dnd-kit`
   * 完全不监听那套事件，见 `theme.css`/组件树里再也没有 `onDragOver`/
   * `onDrop` 这类原生属性）——`handleDragEnd` 只会在这个 `DndContext` 自己
   * 认定的一次拖拽真的结束时触发，天然进不来外来拖拽，不需要再像
   * `CalendarGrid.tsx` 那样手动读 `dataTransfer.getData('text/plain')`
   * 挡一道。这一点在 `TaskGrid.test.tsx` 里有一条真实的回归测试：直接对着
   * 格子 `fireEvent.dragStart`/`fireEvent.drop`（模拟原生拖放，不经过
   * `@dnd-kit` 的指针/键盘监听器），断言 `onDropTo` 不会被触发。
   *
   * ② **拖回原地不发回调**：`over` 有两种「原地」——`over` 本身是 `null`
   * （拖出了所有放置目标之外），或者算出来的目标格 `to` 就是来源格 `from`
   * （拖到同一格里的另一张卡、或者拖到格子自己的空白处，两种都会落在
   * `from === to`）。两种都要处理，见下面判断——跟 `over === null` 那半，
   * 用 `!over` 单独判断，不是靠 `to` 算出来的空值顺带盖过去。
   */
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveDragId(null);
    if (!onDropTo || !over) return;
    const activeId = String(active.id);
    // 被拖的那张卡在拖动中途从 shown 里消失了（SSE 刷新把它标成完成、
    // 被删、/expand 合并……都可能）：这一刻它对应的 SortableTaskItem 早就
    // 卸载了，`active`/`over` 里的 id 是陈旧的——不发一个打不中真实任务的
    // `onDropTo`。这道判断跟 `useCancelStuckDrag`（`lib/dnd.ts`）不是同一件
    // 事的两次检查：那边管的是「键盘会话卡死，收不到下一次 Space」这个
    // 单独的问题，靠派发 Escape 解决；这里管的是「万一 dragEnd 真的带着一个
    // 已经不存在的 id 触发了」（比如指针拖拽路径，`pointerup` 本来就会正常
    // 触发 dragEnd，不会被上面那条卡住），两条互不替代，都要留着。
    if (!shown.some((s) => s.tasks.some((t) => t.id === activeId))) return;
    const overId = String(over.id);
    // `over.id` 可能是「某个格子自己」（拖到空白处，来自 GridCell 的
    // useDroppable）或者「某张卡的 id」（拖到另一张卡上，来自
    // SortableTaskItem 的 useSortable）——先认「是不是格子 key 本身」，
    // 不是就去卡片自己的 sortable 会话数据里找它所在的格子。
    const to = shown.some((s) => s.key === overId)
      ? overId
      : (over.data.current as SortableData | undefined)?.sortable?.containerId;
    const from = (active.data.current as SortableData | undefined)?.sortable?.containerId;
    if (!to || !from || from === to) return;
    onDropTo(activeId, to);
  };

  const sectionNodes = shown.map((s) => (
    onDropTo ? (
      <GridCell key={s.key} section={s} density={density} renderTask={renderTaskBody} />
    ) : (
      <section key={s.key} className="ink-grid-section">
        {/* **每一组都能折。**（原来这儿写着「仿滴答清单：它那边每个组头前面
            都有一个小三角」——那是一句**关于界面长相**的断言，而 `docs/` 里
            的图片全被剥掉了，证不了。下面那两句理由本来就自足。）
            原来只有 `startFolded` 那两组（清单里的「已完成」「已放弃」）能点，
            别的组头是一段死文字——而「按来源」里把「AI 拆的」折起来只看自己
            记的、「今天」里折掉已经做完的那一组，是同样常用的动作。
            `startFolded` 的含义跟着收窄成它本来该有的那个：**一开始是不是
            折着的**，不再兼职「能不能折」。判据在 `isFolded`，没点过的按
            `startFolded ?? false` 走，所以那两组照旧默认折着。 */}
        <SectionHeading
          section={s}
          fold={{ folded: isFolded(s), onToggle: () => toggleFold(s) }}
        />
        {/* 折起来时整个列表不渲染，不是 `display: none`：那两百张卡连同它们
            各自的状态一起留在树里，折叠就只省了滚动、没省渲染。 */}
        {!isFolded(s) && (
          <div className={density === 'row' ? 'ink-row-list' : 'ink-card-grid'} role="list">
            {s.tasks.map((t) => (
              <div role="listitem" key={t.id}>{renderTaskBody(t, undefined)}</div>
            ))}
          </div>
        )}
      </section>
    )
  ));

  const grid = layout === 'cells' ? <div className="ink-cells">{sectionNodes}</div> : <>{sectionNodes}</>;
  // 没给 onDropTo 时完全不挂 DndContext——今天/接下来/全部……这些视图的
  // 渲染树里不多一个字节的 dnd-kit 痕迹，跟以前 onDragOver/onDrop 整个不挂
  // 是同一条纪律。
  return onDropTo ? (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }) => setActiveDragId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDragId(null)}
    >
      {grid}
    </DndContext>
  ) : grid;
}
