import type { ReactNode } from 'react';
import type { InboxItem, Insight, Task } from '../types.js';
import { isInTodayView } from './taskView.js';
import { inAllView } from './simpleViews.js';
import { openInsights } from '../components/ReviewView.js';

/**
 * 一个「去处」的定义。
 *
 * 存在的理由：`App.tsx` 里原来是 `view === 'today' ? <A/> : <B/>`。两个分支还看得过去，
 * 而这个应用要长到十种视图 + 数量不定的清单和标签——十几个分支塞进一个 400 行的
 * 文件，下次加第十一种就没人敢碰了。把「一个视图是什么」抽出来，导航和渲染都从
 * 这张表来，加视图只是往表里加一项。
 */
export interface ViewCountSource {
  tasks: Task[];
  inbox: InboxItem[];
  now: Date;
  /**
   * 「回顾」那个数要用。**加这一项是这个类型第一次为某一个视图扩容**——
   * 原来那条注释写着「加进那个类型会让所有现有 count 的签名跟着动，
   * 下一批一起改」，实际改起来一个签名都不用动：`count` 收的是整个
   * source 对象，多一个键，既有那三个 `({ tasks })`/`({ inbox })` 的解构
   * 一个字都不用碰。那条顾虑当时高估了成本。
   */
  insights: Insight[];
}

export interface ViewDef {
  key: string;
  label: string;
  /**
   * 切走的时候**不卸载**，只用原生 `hidden` 藏起来。
   *
   * 默认 false。设成 true 的视图，`App` 会把它一直挂在树上。两个理由（`App.tsx`
   * 里那段长注释的原话）：① 视图自己的 `editingIds`（正在编辑的卡不能被筛选结果
   * 摘掉）防的就是「树被卸载、草稿跟着没」，顶层切换如果整棵子树卸载重挂，等于
   * 绕过了这层保护；`TaskBoard` 的筛选选择同理会被悄悄重置。② 每个视图各包一层
   * `BoardErrorBoundary`：共用一个的话，一边渲染崩溃之后 `state.error` 不会因为
   * 孩子换成另一个视图就自动清空（React 错误边界不认「孩子换了」这件事），会把
   * 另一个原本能正常渲染的视图也拖进错误提示里。
   *
   * 代价是这些视图的 DOM 一直在。所以**只给真正有本地状态要保的视图开**，
   * 不是默认开——十几个视图全常驻是另一个方向的错。
   */
  keepMounted?: boolean;
  /** 导航上那个数字。不给就不显示数字（不是显示 0）。 */
  count?: (s: ViewCountSource) => number;
  /**
   * 侧栏上归到哪一段。**必填**——加一个新去处时必须做这个决定，不然它会
   * 悄悄落进某一段的末尾（或者干脆不显示），而那正是这次改动要治的病。
   *
   * 分三段是因为这十四项**本来就是三类东西**，原来却摆成一排长得一样的行：
   *
   * - `tasks`「任务」：换一批任务看（收件箱/今天/接下来/全部/按来源/已完成/
   *   垃圾箱）。对应滴答清单侧栏的「智能清单」那一区。
   * - `views`「换种看法」：**同一批任务的另一种摆法**（日历/看板/四象限）。
   *   滴答那边这类是最左那条图标栏上的模块（看板在它那儿干脆不是导航项，
   *   是某份清单的显示方式）。
   * - `more`「别的」：跟任务列表不是一回事的模块（习惯/专注统计/纪念日/回顾）。
   *
   * **这张表的顺序必须按段连续**（下面那条测试盯着）：数字键 `1`–`9` 和命令
   * 面板里的 hint 都是按「导航上第几个」算的，表的顺序一旦跟屏幕上的顺序对
   * 不上，按 `3` 会跳到另一个地方去。
   */
  group: NavGroup;
  // 不接参数：三个视图（收件箱/今天/按来源）的 render 在 App.tsx 里注入时都是
  // 零参箭头函数，闭包捕获 App 自己的 state——`ViewProps`（tasks/inbox/proposals/
  // now）曾经在这里声明过，但从来没有一个 render 真的读过它，App.tsx 调用处
  // 传的四个值也全部被忽略。真需要「视图不看 App 的 state、只看调用时传入的
  // 这一份」的注入式写法时再加回来，现在加只是没人用的参数。
  render: () => ReactNode;
}

/**
 * 注册表本身。**渲染函数在 `App.tsx` 里注入**——`ViewDef.render` 需要
 * `onPatch`/`onDelete` 这些回调，它们绑在 App 的 state 上；把回调塞进这张静态表
 * 会让这个模块反过来依赖 App，环就绕回去了。这里只声明「有哪些去处、叫什么、
 * 数字怎么算、要不要常驻」，`render` 由 `buildRegistry()` 在 App 里填。
 */
export interface ViewSpec extends Omit<ViewDef, 'render'> {}

/** 导航的三段。顺序就是渲染顺序（也是数字键 `1`–`9` 数的那个顺序）。 */
export type NavGroup = 'tasks' | 'views' | 'more';

export const NAV_GROUPS: NavGroup[] = ['tasks', 'views', 'more'];

/**
 * **哪几段画在最左那条竖图标栏上（`Rail.tsx`），哪一段画在清单侧栏里。**
 *
 * 判据直接照搬滴答清单自己在设置里的分法（它设置弹层里就是两页）：
 * - **功能模块**：日历 / 四象限 / 习惯打卡 / 番茄专注 / 倒数纪念日——一个个
 *   独立的界面，各带各的开关。这些上竖栏。
 * - **智能清单**：所有 / 今天 / 最近7天 / 收集箱 / 已完成 / 已放弃 / 垃圾桶，
 *   外加标签和过滤器。这些留在清单侧栏。
 *
 * 一句话：**侧栏回答「看哪一批任务」，竖栏回答「用哪个模块」。**
 *
 * `views`（日历/看板/四象限）**这一批从侧栏挪上了竖栏**。之前留在侧栏的理由
 * 是「它们摆的还是同一批任务」——那句话没错，但分类不是按「摆的是不是任务」
 * 分的，是按「这是一批任务还是一个界面」分的，而日历和四象限在滴答那边明明
 * 白白就列在「功能模块」里。
 */
export const RAIL_GROUPS: NavGroup[] = ['views', 'more'];

/**
 * 竖栏上「任务」那一颗的 key。
 *
 * **它不是一个视图，是一个模块**——竖栏上其余每一颗都对应注册表里一条具体的
 * 去处（日历、习惯……），只有这一颗对应的是**一整段**（`tasks`：收件箱/今天/
 * 接下来/全部/按来源/已完成/垃圾箱，外加清单和标签）。点它回到你上次在的那个
 * 任务去处，而不是固定跳「今天」。
 *
 * 值得单起一个哨兵值而不是借用 `today`：借用的话，站在「全部」上时竖栏上
 * 那一颗不会高亮（`current === key` 不成立），而人明明就在任务模块里。
 *
 * **不能跟任何视图 key 撞车**，`views.test.tsx` 有一条守卫钉着。
 */
export const TASKS_MODULE_KEY = 'tasks';

/**
 * 这个去处要不要清单侧栏。**只有任务模块有**。
 *
 * 判据：这一条属于 `tasks` 那一段，或者是清单/标签那种运行时才知道的动态去处
 * （`list:xxx` / `tag:xxx`——它们本来就是从侧栏点出来的）。
 *
 * 日历、看板、四象限**也没有侧栏**：它们在滴答那边就列在「功能模块」里，是
 * 一个个独立的界面。站在一个界面里看着另一个模块的导航，那一整栏什么也解释
 * 不了——这跟习惯/专注统计是同一条理由，只是当初漏想了一层。
 */
export function showsSidebar(view: string): boolean {
  if (view.startsWith('list:') || view.startsWith('tag:') || view.startsWith('context:')) return true;
  return findSpec(view)?.group === 'tasks';
}

/** 侧栏上分段渲染的那几段。**从 `NAV_GROUPS` 减出来，不另写一份**。 */
export const SIDEBAR_GROUPS: NavGroup[] = NAV_GROUPS.filter((g) => !RAIL_GROUPS.includes(g));

/** 段标题。侧栏那一段跟「清单」「标签」共用同一个 `.ink-nav-group` 样式——
 *  它们是同一类东西（侧栏上的一段），不该长两个样；竖栏那两段的标题只用作
 *  可访问名和分隔（屏幕上不画字，一排记号本身就说清楚了）。 */
export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  tasks: '任务', views: '换种看法', more: '模块',
};

export const VIEW_SPECS: ViewSpec[] = [
  {
    key: 'search',
    group: 'tasks',
    label: '搜索结果',
    // 不在导航里显示——它是打字之后才出现的去处。Sidebar 会跳过它，
    // 见那边 SKIP_IN_NAV 的注释。
  },
  {
    key: 'inbox',
    group: 'tasks',
    label: '收件箱',
    // 在这次改动之前，InboxSidebar 常驻在左栏里，没有任何切换能卸载它。
    // 现在它自己也是一个可以切走的视图——`InboxRow.draft`（本地 useState）
    // 和 `editingIds`（哪些行的编辑器开着）都是纯组件状态，正是 keepMounted
    // 文档注释里「只给真正有本地状态要保的视图开」点名要保的那两种形状。
    // 漏了这一行，切走再切回来会把正在编辑的收件箱草稿悄悄冲掉——
    // 跟这次改动本来要防的「今天」/「按来源」那类回归是同一个问题，
    // 只是发生在第三个视图上。
    keepMounted: true,
    // 数的是「还没拆的」，不是收件箱总条数——已经拆过的条目留在那儿是档案，
    // 把它们算进这个数字，导航上那个红点就永远消不掉。
    count: ({ inbox }) => inbox.filter((e) => !e.processed).length,
  },
  {
    key: 'today',
    group: 'tasks',
    label: '今天',
    keepMounted: true,
    count: ({ tasks, now }) => tasks.filter((t) => isInTodayView(t, now)).length,
  },
  {
    key: 'upcoming',
    group: 'tasks',
    label: '接下来',
    // 不 keepMounted：它没有自己的本地状态要保（编辑草稿在 TaskGrid 里，
    // 而 TaskGrid 是这个视图自己的孩子，一起卸载一起重建，没有跨视图的
    // 东西会丢）。keepMounted 是给「切走再回来必须原样」的视图开的，
    // 不是默认开——十个视图全常驻是另一个方向的错。
  },
  {
    key: 'all',
    group: 'tasks',
    label: '全部',
    // 跟 `allSections` 用同一份判据，不在这儿手写第二遍——原来这里是
    // `status !== 'done'`，漏了「已放弃」（那个状态是后加的），徽标于是比
    // 点进去看到的多。
    count: ({ tasks }) => tasks.filter(inAllView).length,
  },
  {
    /**
     * 没归进任何清单的任务。
     *
     * **滴答清单里每条任务都属于某个清单**——没指定的落进「收集箱」，那是一个
     * 真的去处，点得进去。这个应用一直没有对应的东西：`listId` 是 `null` 的
     * 任务只能在「全部」里混着看，或者他自己建一条 `noList` 的智能清单。于是
     * 「还没分拣的那一堆」这个 GTD 里最基本的概念，在界面上没有落点。
     *
     * **不叫「收集箱」**：这个应用的「收件箱」已经是另一件事（随手记下来、
     * 还没让 AI 拆的原文），两个名字挨在一起只会让人以为是同一个东西的两半。
     * 「未归类」说的正是它的判据本身。
     */
    key: 'nolist',
    group: 'tasks',
    label: '未归类',
    // 口径跟「全部」同一条（`inAllView`：做完的和放弃的都不算），不在这儿
    // 手写第二遍——两个数字挨着摆，判据不一样的话看起来就是其中一个错了。
    count: ({ tasks }) => tasks.filter((t) => inAllView(t) && t.listId === null).length,
  },
  {
    key: 'source',
    group: 'tasks',
    label: '按来源',
    keepMounted: true,
  },
  {
    key: 'done',
    group: 'tasks',
    label: '已完成',
    // 不给 count：完成的数量只会越来越大，导航上挂一个一直在涨的数字
    // 既不是待办也不需要盯着。
  },
  {
    key: 'trash',
    group: 'tasks',
    label: '垃圾箱',
    // 不给 count：垃圾箱里有几条不是待办，导航上挂个数字只会一直在那儿。
  },
  {
    key: 'calendar',
    group: 'views',
    label: '日历',
    // 不 keepMounted：锚点月份/月周模式/选中哪天是 CalendarView 自己的
    // useState，切走再回来要归零回「当月、月视图、没选中哪天」——这正是要
    // 靠真的卸载重挂才成立的效果（不是「有本地状态要保」，是反过来「有本地
    // 状态要不保」），跟 keepMounted 文档注释里点名的那两条理由（保草稿、
    // 保错误边界）不沾边，见 CalendarView.tsx 顶部的说明。不给 count：
    // 落在哪天的任务数没有一个天然的「导航上该挂哪个数字」的答案。
  },
  // **「看板」不再是一条去处。** 它是清单的显示方式，判据和理由在
  // lib/listMode.ts——照滴答清单改的：它那边看板在每份清单的「视图」一栏里，
  // 跟「列表」「时间轴」并排，不在功能模块栏上。原来这里有一条 key: 'kanban'
  // 的注册表项，摆的固定是全部任务；现在每一个任务去处都能就地切成看板。
  {
    key: 'quadrant',
    group: 'views',
    label: '四象限',
    // 理由同 kanban：不 keepMounted、不给 count。
  },
  {
    key: 'habits',
    group: 'more',
    label: '习惯',
    // 不 keepMounted、不给 count：跟「专注统计」同一条——整块从 tasks 现算，
    // 没有本地状态要保；「有几个习惯」不是一件要处理的事，导航上挂个数字
    // 只会一直在那儿。
  },
  {
    key: 'focus',
    group: 'more',
    label: '专注统计',
    // 不 keepMounted：没有本地状态要保（整块是从 tasks 现算出来的），
    // 跟 upcoming/kanban 同一个理由。不给 count：专注了多少分钟不是「待办」，
    // 导航上挂一个一直在涨的数字既不需要盯着、也不是一件要处理的事，
    // 跟「已完成」不给数字同一条。
  },
  {
    key: 'countdown',
    group: 'more',
    label: '纪念日',
    // 不 keepMounted：那个「添加」小表单是纯组件状态，切走再回来清空正是
    // 想要的（跟日历的锚点同一类「有本地状态要**不**保」）。不给 count：
    // 「有几个纪念日」不是待办。
  },
  {
    key: 'review',
    group: 'more',
    label: '回顾',
    // 没看过的回顾就是待办，跟收件箱里没拆的、今天要做的是同一类数字。
    // 判据走 `openInsights`（ReviewView 导出的那一个），不在这儿另写一遍
    // `filter(i => !i.dismissedAt)`——那个函数存在的理由正是「两处各写一遍
    // 就是两份可以各自改漏的判据」，见它自己的注释。
    count: ({ insights }) => openInsights(insights).length,
  },
];

/** `App` 把 render 填进来之后的完整注册表。 */
export function buildRegistry(renders: Record<string, ViewDef['render']>): ViewDef[] {
  return VIEW_SPECS.map((s) => {
    const render = renders[s.key];
    // 注册了却没给 render，等于导航上一个点了没反应的入口——宁可在开发时炸出来。
    if (!render) throw new Error(`视图「${s.key}」注册了但没有 render`);
    return { ...s, render };
  });
}

export const findSpec = (key: string): ViewSpec | undefined => VIEW_SPECS.find((v) => v.key === key);
