import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Col, ConfigProvider, Dropdown, Input, Modal, Row, Space } from 'antd';
import { api, subscribe, type AgentStatus, type DataFile } from './api.js';
import { BatchBar } from './components/BatchBar.js';
import { BoardErrorBoundary } from './components/BoardErrorBoundary.js';
import { CalendarView } from './components/CalendarView.js';
import { CommandPalette, type Command } from './components/CommandPalette.js';
import { FilterBar } from './components/FilterBar.js';
import { FocusStats } from './components/FocusStats.js';
import { HabitStats } from './components/HabitStats.js';
import { CountdownView } from './components/CountdownView.js';
import { GroupSortBar } from './components/GroupSortBar.js';
import { InboxComposer } from './components/InboxComposer.js';
import { InboxSidebar } from './components/InboxSidebar.js';
import { ReviewView } from './components/ReviewView.js';
import { ScheduledBanner } from './components/ScheduledBanner.js';
import { SearchJumps } from './components/SearchJumps.js';
import { SuggestPanel } from './components/SuggestPanel.js';
import { NavShell, NAV_DEFAULT, clampNavWidth } from './components/NavShell.js';
import { ColGrip, clampWidth } from './components/ColGrip.js';
import { Sidebar, SKIP_IN_NAV } from './components/Sidebar.js';
import { isNarrowNow, useIsNarrow, useIsTight } from './lib/narrow.js';
import { setBaseTitle } from './lib/pageTitle.js';
import { SettingsModal } from './components/SettingsModal.js';
import { ShortcutHelp } from './components/ShortcutHelp.js';
import { TaskBoard } from './components/TaskBoard.js';
import { TaskComposer } from './components/TaskComposer.js';
import { QuickAdd } from './components/QuickAdd.js';
import { TaskDetail } from './components/TaskDetail.js';
import { Rail } from './components/Rail.js';
import { SearchModal } from './components/SearchModal.js';
import { emptyDraft, type TaskDraft } from './components/TaskFields.js';
import { TaskGrid, type GridSection } from './components/TaskGrid.js';
import { groupProposals } from './components/ProposalNote.js';
import { TodayView } from './components/TodayView.js';
import { TrashView } from './components/TrashView.js';
import { buildRegistry, findSpec, RAIL_GROUPS, showsSidebar, TASKS_MODULE_KEY, VIEW_SPECS } from './lib/views.js';
import { hashFromView, viewFromHash } from './lib/hashView.js';
import { keyAction, toKeyLike, isInteractiveTarget } from './lib/keymap.js';
import { agendaSections } from './lib/agenda.js';
import { canBeHabit } from './lib/habit.js';
import { allSections, doneSections } from './lib/simpleViews.js';
import { kanbanCells, quadrantCells, priorityOfQuadrant } from './lib/cells.js';
import { scopedSections } from './lib/scoped.js';
import { searchLists, searchTags, searchTasks } from './lib/search.js';
import { applyFilter, emptyFilter, isFilterEmpty, normalizeFilter } from './lib/smartFilter.js';
import { type SelState } from './lib/selection.js';
import { allTags, asArray, countStale, isInTodayView, isSettled, isTaskOverdue, sortByUrgency, CONTEXT_LABEL } from './lib/taskView.js';
import { undoDonePlan } from './lib/undoDone.js';
import { dueChip } from './lib/dueChip.js';
import { archiveNote } from './lib/archiveNote.js';
import { deleteManyConfirm } from './lib/deleteConfirm.js';
import { duplicateDraft } from './lib/duplicate.js';
import { getDensity, setDensity, type Density } from './lib/density.js';
import { getListMode, setListMode, type ListMode } from './lib/listMode.js';
import { parentCandidates, promoteSubtask } from './lib/hierarchy.js';
import { composeDefaults, smartDraft, splitCapture } from './lib/composeDefaults.js';
import { presetToRemindAt } from './lib/remindPreset.js';
import { LIST_COLORS } from './lib/listIcon.js';
import { deleteTagPatches, renameTagPatches, TAG_SEP } from './lib/tagTree.js';
import {
  POSTPONE_MINUTES, postponePatch, reschedulePatch, snoozePatch, snoozeLabel, SNOOZE_CHOICES,
  RESCHEDULE_KEYS, RESCHEDULE_LABEL, type RescheduleTo,
} from './lib/reschedule.js';
import {
  GROUP_LABEL, KANBAN_AXES, cellPatch, getGroupSort, getKanbanAxis, regroupSections,
  setGroupSort, setKanbanAxis, type GroupSort, type KanbanAxis,
  sectionNames,
} from './lib/grouping.js';
import { canAuto, getNavModes, setNavModes, visibleViews, type NavModes } from './lib/navVisibility.js';
import { getCalendarPrefs, setCalendarPrefs, type CalendarPrefs } from './lib/calendarPrefs.js';
import { calendarAnchor } from './lib/calendar.js';
import {
  getQuadrantRule, setQuadrantRule, QUADRANT_RULES, QUADRANT_RULE_LABEL, type QuadrantRule,
} from './lib/quadrantRule.js';
import { isOnline, OfflineUnsupportedError } from './lib/dataSource.js';
import { onLocalWrite, takeDirtyReadFailure } from './lib/localStore.js';
import { rescheduleLocalNotifications } from './lib/notifyNative.js';
import { pushBackIfDirty, type PushSummary } from './lib/pushBack.js';
import { nativeSharePort, subscribeShare } from './lib/shareNative.js';
import { boardLocalTheme } from './theme.js';
import type { ConflictFile, Countdown, Folder, InboxItem, Insight, List, Proposal, Settings, SmartFilter, Status, Task, TaskContext, TrashItem } from './types.js';
import type { StatusFilter } from './lib/taskView.js';

// 这里曾经有一份硬编码的 DEFAULT_SETTINGS 当 settings state 的初值。**整分支
// 审查 I1 把它删了**：见下面 settings 定义处的注释，一份「编出来的设置」跟
// 「真的读到的设置」在类型上分不开，就迟早会被整份 PUT 回服务端、把桌面上
// 真实的 webhookUrl 冲成空串。顺带也消掉了它跟 server/src/model.ts 的 `DEFAULT_SETTINGS` 那份
// 各写各的、没有任何东西断言两者一致的问题（task-2-report 修复轮 2 记过这笔账）。

// 清单的分类色。只上 background-color，永不上 color——见 theme.css 里
// .ink-nav-dot 的注释。**群青 #2E3ED4 不在这盘里**：它是 AI 墨水的配额，
// 让用户建的清单借走它，双色墨水这套记号就废了（服务端 sanitizeListPatch
// 也会拒收这个颜色，这里只是不让界面先撞上那道墙）。放在 App.tsx 顶部而
// 不是 lib/views.tsx：那张表是「去处」的定义，清单颜色跟「去处」无关。

// 密度开关只在这几个注册表视图里出现（任务行/卡片是列表类视图的两种渲染，
// 见 task-2-brief「哪些视图有这个开关」）。清单/标签（scoped，动态 key，
// 不在 VIEW_SPECS 里）额外用 `!findSpec(view)` 判断，见下面 canToggleDensity。
//
// 不在这张表里、也走不到 `!findSpec` 分支的视图，都是有意排除的——但排除
// 的理由不都是「密度概念对它不适用」，有几处是「不给挑，固定成某一档」：
// - 看板/四象限/日历当天列表：task-3-brief 固定成 `density="row"`（下面
//   `kanban`/`quadrant` 两个 render 函数、`CalendarView.tsx` 里的 `TaskGrid`
//   各自写死了这个 prop，不读这里的 `density` state）。这三处不给开关的
//   理由是「没必要切」，不是「TaskRow 接不住」——task-2 时 `TaskRow` 确实
//   还没有拖拽抓手，那一版把这三处固定成了卡片；这一批给 `TaskRow` 接上了
//   跨列拖拽（`TaskGrid.tsx` 的 `dragWiring`，行/卡两个分支共用同一份），
//   看板/四象限的核心交互（拖卡改状态/优先级）没有再依赖卡片。固定行档
//   是因为这三处的意义就是「一屏看见尽可能多条」，用户没有理由想切回卡片，
//   不是退而求其次的权宜之计。
// - 按来源：存在的意义就是展示 aiComment 整段文字，固定卡片，规格正面答过。
// - 收件箱：`InboxSidebar` 自己手写渲染，不经过 `TaskGrid`——收件箱条目
//   不是 `Task`，行/卡密度这个概念对它不适用。
//
// **`'today'` 是 task-5 补的**——task-2 交出去时漏了它，是全应用最常用的
// 那个视图，见 task-5-brief.md。`TodayView` 同样不经过 `TaskGrid`（它自己
// 手写 `TaskRow`/`TaskCard` 的分支，为的是留住 `rank`/手动排序那套
// `TaskGrid` 没有的东西，见 `TodayView.tsx` 顶部说明），但密度偏好是这里
// 唯一一份全局 state，没道理让用得最多的这个视图独漏一个开关。
//
// export：App.test.tsx 的密度开关测试从这里派生要循环的视图名单，不是抄
// 一份写死的字符串数组——这张表漏了/多了哪个视图，测试自动跟着变，不需要
// 有人记得回来手工同步两张表（task-2 修复轮 1 · C1）。
// `nolist`（未归类）在这儿曾经漏掉：它是 `withFilterBar({ groupable: true })` 的
// 去处，切成看板之后那一屏连行/卡开关都没有，跟 `canToggleListMode` 漏它是同一个
// 洞的两半（详见那处注释里那次实测复现）。
export const DENSITY_VIEWS = new Set(['search', 'upcoming', 'all', 'nolist', 'done', 'today']);

// 列表顶上那一行「添加任务」出现在哪些去处（`QuickAdd`）。**比密度开关那张
// 名单短**，两张表回答的不是同一个问题：密度问「这一屏是不是一列任务」，这张
// 表问「在这儿新建一条讲不讲得通」。
//
// - `search`/`done` 不给：在搜索结果里、在「已完成」里新建一条待办，它当场
//   就不在这一屏——那正是这个应用最不想制造的那种「写成功了界面没反应」。
// - `upcoming` **给**。这一条原来写的是「不给」，理由是「那个去处的成员资格是
//   『有个将来的时间』，而这一行只收一句标题，要么建完就消失，要么替他猜一个
//   日期」——**而下面那行代码里 `upcoming` 一直在名单里**，界面上那一行也一直
//   画着（空实例上截图确认）。同一份文件再往下十几行的另一句注释（`QUICKADD_VIEWS`
//   只有今天/接下来/全部/按来源）说的才是实情，这条是它没跟上。
//   「建完就消失」那个顾虑后来是另一条路解决的：`lib/createdNote.ts` 会说清楚
//   它去哪了（这一支落到兜底那句「已添加。这条在「按来源」里」），不是靠不给
//   输入框。
// - `list:`/`tag:` 给（下面 startsWith 判）：预填会把它归进当前这个清单/标签，
//   建完就在眼前，见 lib/composeDefaults.ts。
const QUICKADD_VIEWS = new Set(['today', 'upcoming', 'all', 'source']);
const canQuickAdd = (v: string) => QUICKADD_VIEWS.has(v) || v.startsWith('list:') || v.startsWith('tag:') || v.startsWith('context:');

/**
 * **一条任务都没有的时候说什么。**
 *
 * 「全部」「四象限」「看板」这三屏原来各写了一遍一模一样的「一条任务都没有」
 * ——同一句话三份拷贝，改一处另外两处就开始漂。收成一份。
 *
 * 更要紧的是那句话本身：它只报告了「没有」，而这一刻**恰恰是最该说下一步的
 * 时候**——一个空屏是一句邀请，不是一张讣告。
 *
 * **但不指认某一个控件。** 第一版写的是「上面那行写一句」，而这句话会落在
 * **没有那行输入的屏上**：`QUICKADD_VIEWS` 只有今天/接下来/全部/按来源（外加
 * 清单、标签、情境），而这个常量还用在四象限和「已完成」的看板档上——那两屏
 * 顶上没有输入框，那句话是假的。屏幕上说一句做不到的话，比只报告「没有」更糟。
 * 所以这里只说「新建一条会怎样」，不说去哪儿建；真的挨着输入框的那几屏
 * （清单/标签）有它们自己那句，就地指得准。
 *
 * 跟 `emptyFiltered`（「这 N 条都被筛选挡住了」）是两句不同的话，别混：那句
 * 说的是「有东西但被挡住了」，这句说的是「真的还没有」。
 */
/** 认不出的去处，标题和正文共用这一句——两处各写一遍迟早会分叉。 */
/** 拆解结果那条提示自己消失前留多久（毫秒，只在页面可见时计时）。
 *  6 秒：antd 的 notification 默认 4.5 秒，而这条带一句 description，
 *  给到能读完一句话的长度。 */
const AGENT_TOAST_MS = 6000;

/** 侧栏宽度存在哪儿。跟 `density` 那个键同一层，都是「这台设备上的偏好」。 */
const NAV_WIDTH_KEY = 'navWidth';

/**
 * 任务详情那一栏的宽度：上下限、默认值、存哪个键。
 *
 * 下限 300 是「一行标题加右边那排按钮还排得下」，上限 640 是别把看板挤没
 * （看板是主角，详情是配角）。默认 360 就是它加这条界线之前钉死的那个数——
 * 从没拖过的人看到的东西一个像素都不变。
 */
const DETAIL_MIN = 300;
const DETAIL_MAX = 640;
const DETAIL_DEFAULT = 360;
const DETAIL_WIDTH_KEY = 'detailWidth';

const UNKNOWN_VIEW = '没有这个去处';

const EMPTY_NO_TASKS = '还没有任务。新建一条，它就会出现在这儿。';

// 这一行**画在哪**分两处，因为这几个去处的头部长得不一样：
// - 「今天」（TodayView 手写的列表）和「按来源」（看板）没有筛选/分组那两条，
//   直接画在视图标题下面，跟滴答清单一样。
// - 走 `withFilterBar` 的那几个（全部、各个清单、各个标签）画在筛选条和分组条
//   **下面**、列表正上方：那两条是这一屏的取景器，输入框跟它添进去的那个列表
//   之间夹三行控件，看起来就不像是同一件事了。
const QUICKADD_AT_TOP = new Set(['today', 'source']);

// `1..9` 快捷键要切到的去处，顺序**从 VIEW_SPECS 推导**，跟 Sidebar 导航上
// 显示的顺序同源——用同一个 SKIP_IN_NAV 过滤同一份 VIEW_SPECS，不是另外
// 手写一份键位表。手写的话，下次有人往 VIEW_SPECS 里插一项，导航变了而
// 快捷键没跟着变，两套顺序会悄悄分叉，见 keyboard 计划文档第 ③ 条。
// 只有 9 个数字键：VIEW_SPECS 里排在第 10 个之后的去处（四象限、习惯、专注统计、
// 纪念日、回顾）数字键够不到，命令面板才是它们的入口（见下面 commands 那段构造）。
// **前九个是**：收件箱 / 今天 / 接下来 / 全部 / 未归类 / 按来源 / 已完成 /
// 垃圾箱 / 日历——这份名单 README 也抄了一份，`views.test.tsx` 拿 VIEW_SPECS
// 现算的那份去比，两边飘了会红（原来那份漏了「未归类」、还留着早就不是去处的
// 「看板」，而且这条注释自己把「垃圾箱」写成了够不到的，它其实是第 8）。
const NAV_VIEW_SPECS = VIEW_SPECS.filter((v) => !SKIP_IN_NAV.has(v.key));

// 冲突横幅说人话用的——key 是 paths() 的目录名，跟 ConflictFile.kind 一一对应。
const KIND_LABEL: Record<string, string> = {
  tasks: '任务', inbox: '收件箱', proposals: '建议', lists: '清单',
  folders: '文件夹', insights: '回顾', countdowns: '纪念日', trash: '垃圾箱',
};

export function App() {
  const { message, modal } = AntApp.useApp();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // **`tasks` 的初值 `[]` 的含义是「还不知道」，不是「一条都没有」**——而下面
  // 那个重排 effect 分不出这两者：`[]` 进去，`planned` 为空，于是「先取消后排」
  // 只剩下取消，手机上排着的通知**全被硬删**（`cancel()` 底下是
  // `storage.deleteNotification()`，开机 receiver 也捞不回），界面完全沉默。
  // 挂载那一帧就会走一次这条路——effect 跑在 `reload()` 落地之前。
  //
  // 窗口不是「相邻两个 await」那种毫秒级（那种在 notifyNative.ts 里裁过、可接受）：
  // - 离线开 App 时 `reload()` 卡在 `isOnline()` 后面，那个探测是
  //   `AbortSignal.timeout(1500)`（`components/ServerSetup.tsx` 的 `testConnection`，
  //   `isOnline()` 复用的就是它，不另写第二份——见 lib/dataSource.ts 复审 I1），**这 1.5 秒里手机上零条通知**；
  // - `reload()` 抛的话窗口**无界**——`route()` 在 `http()` 抛时不回退本地
  //   （lib/dataSource.ts），`reload()` 只弹一条 toast，`setTasks` 不跑，`tasks` 停在
  //   `[]`，于是每一轮重排都只是把手机清空，直到下一次 reload 成功。典型触发是
  //   出门那一刻 Wi-Fi 切蜂窝：探测在 Wi-Fi 上过了、`GET /api/tasks` 在切换中断掉
  //   ——**那正是本地通知最该顶用的时刻**。
  //
  // 所以闸门判的是「第一次真的读到过任务没有」，**不是 `tasks.length === 0`**：
  // 用户真把任务全删光的那一格必须照常取消（否则昨天排的那些会继续响）。
  // 用 state 不用 ref：ref 变了不会让 effect 重跑，得指望「`tasks` 的 identity
  // 恰好也变了」——那是一条不写在依赖数组里的隐含约定，哪天 `api.tasks()` 复用
  // 了数组它就静默不排了。多一次渲染，换 React 自己按依赖数组保证这件事。
  const [tasksLoaded, setTasksLoaded] = useState(false);
  // AI 提的、还没被接受/忽略的修改建议。渲染在各自对应的任务卡里。
  const [proposals, setProposals] = useState<Proposal[]>([]);
  // **`null` 是「还没成功读到过这台服务的设置」，是一个真实的状态，不是占位**
  // （整分支审查 I1）。以前这里的初值是一份硬编码的 `DEFAULT_SETTINGS`，类型
  // 上跟真的读到的 `Settings` 一模一样，谁都分辨不出手上这份是编的还是真的
  // ——而 `SettingsModal` 拿它当草稿初值、`onSave` PUT 的是**整份**
  // `Settings`：离线时打开设置改一项、或者在线时 `/api/settings` 单独 500
  // 之后打开设置改一项，桌面真实的 `webhookUrl` 就被这份编出来的 `''` 冲掉了。
  // 这一批已经在 `lib/dataSource.ts` 里删掉过同形状的第一扇门（伪造
  // `DEFAULT_SETTINGS` 当离线读取的答案，task-2-report 修复轮 2 C2），这是
  // 剩下的另外两扇。
  //
  // 改成可空之后，「从没读到过」这件事在类型上就摊开了：`SettingsModal` 收
  // `Settings | null`，`null` 时**根本不渲染那张表单**（连草稿 state 都是
  // `null`，没有输入框、没有保存按钮），不是「渲染出来但拦一下保存」——**没有
  // 草稿就没有能 PUT 的东西**，这条数据丢失路径是结构上不存在，不是靠一句
  // 判断挡住。番茄钟时长这类只影响观感的读取方用 `settings?.focusMinutes`，
  // 落到 `TaskCard` 自己写明的默认值 25（它本来就是可选 prop）。
  const [settings, setSettings] = useState<Settings | null>(null);
  // 只记 id：横幅内容（标题、备注）现从 tasks 里现查，任务完成或被删掉时
  // 横幅要跟着消失——不加一份「这条还有效吗」的旁路状态去追这件事，用
  // tasks（页面已经有的那份数据）当唯一依据：查不到、或者查到的 status
  // 是 done，渲染时就把它滤掉。这是这个代码库的规矩：一个更新路径。
  const [due, setDue] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 离线记号（task-3-brief）。**这是「连不上服务端」在这个应用里唯一的
  // 表现**——这里曾经还有一个 `needsServerSetup`：手机没配过地址、又探不到
  // 本机服务时整页 return 一面「先填服务地址」的墙，把本地功能全挡在后面。
  // 拥有者的原话是「服务地址连不到，也可以使用本地功能，不一定要服务器」，
  // 那面墙跟这句话正面冲突，**整面删掉了**（不是加一个「跳过」按钮）：没配
  // 过地址的手机打开就是主看板，走 `route()` → `localStore` 那条离线路，
  // 增删改查照常，顶上挂这一条记号；填地址的入口常驻在设置弹层里
  // （`SettingsModal` 的「服务地址」一节），横幅自己指路过去。
  //
  // 「配过的地址现在连不连得上」会随时间变化，靠下面 refreshOffline() 反复
  // 刷新。初值 false——先假设在线，等第一次探测真的落定（见 isOnline() 的
  // 5 秒缓存）再翻成 true，桌面正常联网时不会闪过这条记号，也是「连得上时
  // 不显示」这条上限断言成立的原因（不是靠平台嗅探，是靠 isOnline() 这个
  // 判据本身——跟 lib/dataSource.ts 里 api.ts 每个方法内部路由读的是同一个
  // 函数，不是另外发一次探测/另判一套「在不在线」）。
  const [offline, setOffline] = useState(false);
  // 手机通知权限被拒的记号（本地通知那一批）。**只有 'denied' 挂横幅**：
  // 'not-native'（桌面/浏览器，压根没排过本地通知）和 'ok' 都沉默——桌面有
  // 自己的提醒路（fireReminders → Electron 原生通知 / PowerShell 兜底），
  // 那边没什么可说的，说了反而是在替一个不存在的问题报警。
  const [notifDenied, setNotifDenied] = useState(false);
  // 只留最新一条：跑起来时置灰按钮、失败时弹红色横幅，都只看「最后一次」，
  // 不需要一份历史记录。
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  // 「过期」是跟当下比出来的。不定时推进这个值，页面开一整天，
  // 中午过期的那张卡到晚上还是不红。
  const [now, setNow] = useState(() => new Date());
  // 顶部的去处，默认「今天」——这是这次重做要回答的问题（我现在该干哪个），
  // 「按来源」是档案，翻看的时候才切过去。见 2026-08-12-today-view.md。
  // 类型是 string 不是字面量联合：注册表以后会长出清单/标签这类动态去处
  // （'list:xxx'/'tag:xxx'），穷举不完，见 lib/views.tsx 的设计说明。
  const [view, setView] = useState(() => viewFromHash(window.location.hash));
  // 搜索框里的文字，受控。空字符串是「没在搜」的状态，不是「搜出空结果」——
  // searchTasks 自己也把空查询当空结果处理，两边约定一致，见 lib/search.ts。
  const [query, setQuery] = useState('');

  /**
   * 搜索弹层开着没有。**搜索是个动作，不是去处**——理由整段在 SearchModal.tsx。
   * 跟设置弹层、命令面板同一类：App 一层的一个开关，不进视图注册表。
   */
  const [searching, setSearching] = useState(false);
  // 「新任务」表单展开着没有——手工建任务的入口，见 TaskComposer 的注释。
  const [composing, setComposing] = useState(false);
  // 打开表单时预填的截止日期。**只在日历上「在这天新建」那条路上有值**——
  // 它是这一次打开的上下文，不是设置里那种长期偏好（那两个在 settings 里）。
  // 关掉表单时清掉：下一次从顶上的「新任务」进来不该还带着上回那天。
  const [composeDue, setComposeDue] = useState<string | null>(null);
  // 命令面板（Ctrl/Cmd+K）开着没有。跟 composing 同一个量级：纯 UI 展开态，
  // 不用告诉服务端。
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 快捷键一览（`?`，仿滴答清单）。跟命令面板并列一个 state，不复用它：
  // 面板是「做一件事」，这张表是「有哪些键」，两者同时开着没有意义但也
  // 不冲突，硬合成一个反而要在里面再分一次页。
  const [helpOpen, setHelpOpen] = useState(false);
  // 「按来源」的状态筛选。放在这里而不是 TaskBoard 里，是为了让新建任务能判断
  // 「这张新卡会不会被当前筛选藏起来」——见 TaskComposer 的 report()。
  const [boardFilter, setBoardFilter] = useState<StatusFilter>('all');
  // 筛选栏（FilterBar）的当前筛选，叠在视图之上——见 task-3-brief 设计②。
  // **切视图/改查询词/改筛选都不会清空它自己**：下面那个清 selection/
  // editRequest 的 useEffect 依赖 [view, query, filter]——filter 在依赖数组
  // 里，是为了「筛选一变就清选中」（见那个 effect 上方的注释和
  // final-review.md C1），effect 体里没有 setFilter，不会把这行状态本身
  // 清掉。选中是「对这几条做事」，跨视图/跨筛选无意义还危险（会删掉看不见
  // 的卡）；筛选是「只想看这一类」，跨视图保留正是它有用的地方——两条语义
  // 相反，别把 setFilter(emptyFilter()) 加进那个 effect 体里。
  const [filter, setFilter] = useState<SmartFilter>(emptyFilter());
  // 「存成智能清单」的弹窗（task-4-brief 要点②）：名字必须让用户填，不自动
  // 生成——自动生成的名字（「状态=待办 标签=家」）在导航里长得像乱码。
  // listSaveBusy 只管 Modal 的 OK 按钮转不转，失败时弹窗留着、草稿不清，
  // 跟 TaskComposer 的 submit() 同一条教训（清空等于把用户刚打的字连同这次
  // 失败一起弄丢）。
  const [savingList, setSavingList] = useState(false);
  const [listNameDraft, setListNameDraft] = useState('');
  // 「编辑筛选条件」的弹窗（仿滴答清单：智能清单建完还能改）。存的是**正在
  // 编辑哪一份**加一份草稿——草稿独立于视图上那条 ad-hoc 筛选（`filter`）：
  // 那两者在这个应用里是分层的两件事（一个智能清单 + 叠在它上面的临时筛选，
  // 见下面 scoped 那段），共用一份 state 会把它们搅成一个。
  const [editingFilterList, setEditingFilterList] = useState<List | null>(null);
  const [filterDraft, setFilterDraft] = useState<SmartFilter>(() => emptyFilter());
  const [filterSaveBusy, setFilterSaveBusy] = useState(false);
  const [listSaveBusy, setListSaveBusy] = useState(false);
  // 侧栏「清单」分组要渲染的数据，来源见 reload() 里的 api.lists()。
  const [lists, setLists] = useState<List[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  // 「回顾」视图要渲染的数据。GET /api/insights 服务端已经把 dismissedAt
  // 非空的滤掉了，见 ReviewView 里那处双保险的注释。
  const [insights, setInsights] = useState<Insight[]>([]);
  // 倒数纪念日（仿滴答清单的倒数日）。跟任务是两类东西，单独一份 state。
  const [countdowns, setCountdowns] = useState<Countdown[]>([]);
  // 「垃圾箱」视图要渲染的数据。软删除的任务落在这里，直到还原或彻底删除。
  const [trash, setTrash] = useState<TrashItem[]>([]);
  // 同步客户端留下的冲突副本——不解决，只是让人看见，见 server/src/conflicts.ts
  // 顶部的注释和规格第十节。
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  // 读不出来的实体文件。跟 conflicts 并排放、并排拉：两者都是「data/ 目录
  // 现在的状态」，不属于任何一张表，也都不解决问题、只是让人看见。
  const [broken, setBroken] = useState<ConflictFile[]>([]);

  // 批量操作的地基（见 2026-08-17-selection.md）。放在 App 一层、不是某个
  // TaskGrid 内部 state：切视图要能清空，TaskGrid 实例一多，state 分散在
  // 每个实例里没法统一清，见 TaskGrid.tsx Props.selection 的注释。
  const [selection, setSelection] = useState<SelState>({ ids: new Set(), anchor: null });
  const clearSelection = () => setSelection({ ids: new Set(), anchor: null });
  // 下面全局 keydown 监听器的依赖数组只列 [view, paletteOpen]（见那个
  // useEffect），不把 selection 塞进去——它几乎每次点击卡片都会变，塞进
  // 依赖数组会让全局键盘监听器跟着频繁重新订阅。用 ref 存一份「总是最新」
  // 的镜像，keydown 处理器和 confirmBatchDelete 都读它，不读闭包里可能
  // 过期的 selection state 本身。
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // 'E' 键的落点——选中恰好一张时，这里放那张卡的 id；TaskGrid/TaskCard
  // 收到匹配自己 t.id 的这个值就调用内部的 startEdit()，然后立刻回调把这里
  // 清回 null，见 TaskCard.tsx CardProps.autoEdit 的注释。
  const [editRequest, setEditRequest] = useState<string | null>(null);

  /**
   * 右边那一栏详情面板里现在摊着哪一条、以及**打开它的那一下是不是「要改」**
   * （`null` = 那一栏不出现）。
   *
   * 存 id 不存整条任务：任务本体的唯一真相在 `tasks` 里，存一份副本下来，
   * 别处改了这条（勾完成、AI 接受了一条建议、SSE 推过来一次外部改动）面板
   * 里那份就是旧的——而它跟列表里那一行并排放着，两份不一样当场就看得见。
   * 每次渲染按 id 现查，见下面 `detailTask`。
   */
  const [detail, setDetail] = useState<{ id: string; edit: boolean } | null>(null);

  /**
   * 打开详情面板。`edit` 是**他按的那一下想干什么**：点标题是「看看这条」，
   * ⋯ 菜单里的「编辑」和 'E' 键是「我要改它」——后者直接把面板里那张卡开成
   * 表单。都当成查看态的话，等于让他开了面板再去翻一次 ⋯ 菜单。
   */
  const openDetail = (id: string, opts?: { edit?: boolean }) =>
    setDetail({ id, edit: opts?.edit === true });

  // 行/卡密度偏好（task-2-brief）。初值从 localStorage 读（`getDensity()`
  // 本身是同步的，不用像 `apiBase.ts` 那样等一拍）。`density.ts` 自己的模块
  // 注释解释过为什么这里不需要那套「内存镜像 + 异步落盘」。
  //
  // **没存过时：窄屏给行，宽屏给卡。** 390×844 上实测，卡片档一条 134px、
  // 行档 33px——首屏能看见的从 4 条变成 17 条，而「今天」这一屏的全部意义就是
  // 「一眼看完今天要做什么」。`density.ts` 里那句「手机该用行」原来标着「后面
  // 的事」，就是这一行。
  //
  // 用 `isNarrowNow()` 不用 `useIsNarrow()`：这是 `useState` 的初值函数，
  // 那会儿还没到调 hook 的地方（`isNarrow` 在两千行以下）。而且这里要的正是
  // 一锤子的判断——屏宽后来变了不该把他挑过的档位改掉。
  const [density, setDensityState] = useState<Density>(() => getDensity(isNarrowNow() ? 'row' : 'card'));

  /**
   * 这一份清单怎么摆：竖着一条一条，还是分成几列。**看板是显示方式，不是
   * 去处**——判据和理由整段在 lib/listMode.ts。
   */
  const [listMode, setListModeState] = useState<ListMode>(() => getListMode());
  const changeListMode = (m: ListMode) => { setListModeState(m); setListMode(m); };
  const toggleDensity = (d: Density) => {
    setDensity(d);
    setDensityState(d);
  };

  // 分组/排序（仿滴答清单的「分组排序」）。**跟 density 一模一样的形状**：
  // localStorage 里一份、组件里一份镜像，改的时候两边一起写——它跟密度是
  // 同一类偏好（「这台机器上我喜欢怎么看」），没有理由用第二套存法。
  // 默认档就是今天的行为（不分组、维持各视图自己排好的顺序）。
  // **一个去处一份**（见 lib/grouping.ts）：换去处时要把那个去处存的档读回来。
  //
  // **在渲染里算，不是用一条「view 变了就重读」的 effect。** 那个写法有一个
  // 真实的后果：effect 在换视图那一帧之后才跑，于是「导航过去」和「分组档
  // 变了」是两次渲染；两次之间分组的 section key 变了，TaskGrid 整棵子树会
  // 卸载重挂，而这中间刚打开的编辑态（桌面版「打开这条任务」事件、E 键）
  // 就跟着没了。以前两个去处的档通常都是默认值、看不出来，「已完成」有了
  // 自己的默认档之后每次进去都会踩到。
  //
  // `tick` 是「这个会话里刚改过」的信号：`getGroupSort` 读的是 localStorage，
  // 落盘之后要让这一帧重新读一次。useMemo 的代价是一次 JSON.parse，只在
  // view 变或者真的改过档时发生，比每帧都读便宜、也比 effect 那条正确。
  const [groupSortTick, setGroupSortTick] = useState(0);
  const groupSort = useMemo(() => getGroupSort(view), [view, groupSortTick]);
  const changeGroupSort = (g: GroupSort) => {
    setGroupSort(view, g);
    setGroupSortTick((n) => n + 1);
  };

  // 导航上哪几项显示（仿滴答清单的「智能清单」显示/隐藏/有内容时显示）。
  // 第三份跟 density/groupSort 一模一样形状的偏好：localStorage 一份、
  // 组件里一份镜像，改的时候两边一起写。默认全显示，今天的行为不变。
  // 看板按什么分列（仿滴答清单：看板不是独立功能，是清单的一种显示方式，
  // 分组轴可换）。跟 groupSort 分开存，理由见 lib/grouping.ts 的 getKanbanAxis。
  const [kanbanAxis, setKanbanAxisState] = useState<KanbanAxis>(() => getKanbanAxis());
  const changeKanbanAxis = (a: KanbanAxis) => {
    setKanbanAxis(a);
    setKanbanAxisState(a);
  };

  // 日历的两个显示开关（仿滴答清单的「显示设置」）。第四份跟 density 一样
  // 形状的偏好：localStorage 一份、组件里一份镜像。**这一份的默认档不等于
  // 「今天的行为」**——「显示已完成」默认关是一次有意的行为变化，理由写在
  // lib/calendarPrefs.ts 那个字段上。
  const [calPrefs, setCalPrefsState] = useState<CalendarPrefs>(() => getCalendarPrefs());
  const changeCalPrefs = (p: CalendarPrefs) => {
    setCalendarPrefs(p);
    setCalPrefsState(p);
  };

  // 四象限按哪套规则分格（仿滴答清单的两套内置规则组合）。跟 calPrefs 同一个
  // 形状：localStorage 一份、组件里一份镜像。**默认档就是今天的行为**——加这个
  // 开关不改任何人现在看到的四象限，理由写在 lib/quadrantRule.ts 那个常量上。
  const [quadRule, setQuadRuleState] = useState<QuadrantRule>(() => getQuadrantRule());
  const changeQuadRule = (r: QuadrantRule) => {
    setQuadrantRule(r);
    setQuadRuleState(r);
  };

  const [navModes, setNavModesState] = useState<NavModes>(() => getNavModes());
  const changeNavModes = (m: NavModes) => {
    setNavModes(m);
    setNavModesState(m);
  };

  const reload = useCallback(async (what?: string) => {
    // 认不出来的一律当全量刷。文件监听器改成递归之后，服务端现在也会为
    // lists/folders/insights/trash 发 data-changed；服务端加一种新表而前端
    // 还没跟上时，宁可多拉一次也不能静默不刷新——「写成功了但界面看上去
    // 什么也没发生」是这个仓库栽过五次的坑，而这条路径上编译器帮不了忙：
    // 事件里的 file 是 JSON.parse 出来的 any，onChange 的类型标着联合类型也
    // 拦不住运行时传进来的别的字符串。
    // 类型标成 DataFile[]：数组里任何一个元素拼错都会在编译期报出来，不用等
    // 运行时漏刷新才发现——这是 known 存在的全部意义，写成 string[] 的话
    // 这条约束就只是注释里的一句话，没人拦得住手滑。
    const known: DataFile[] = ['inbox', 'tasks', 'settings', 'proposals', 'lists', 'folders', 'insights', 'countdowns', 'trash'];
    // what 是运行时传进来的 string | undefined（见上面注释），跟 DataFile[]
    // 比较不能用 .includes()——它要求参数本身就是 DataFile，what 做不到这个
    // 保证。用 .some() 逐个比较，两边只要字面值相等就行，不用收窄 what 的类型。
    const all = !what || !known.some((k) => k === what);
    try {
      // GET /api/tasks 和 /api/inbox 不校验文件里写的是什么——一个把顶层写成
      // `{"tasks":[...]}` 而不是数组的 AI 手滑，产出的仍是合法 JSON，直到传进
      // board() / InboxSidebar 里 .map 才会炸。这里兜一道，非数组一律当空数组。
      if (all || what === 'inbox') setInbox(asArray<InboxItem>(await api.inbox()));
      // 这两句一起写：`tasksLoaded` 的含义就是「这一行成功跑过了」，`api.tasks()`
      // 抛出去的话下面一行不会执行，闸门保持关着（见 tasksLoaded 定义处）。
      if (all || what === 'tasks') { setTasks(asArray<Task>(await api.tasks())); setTasksLoaded(true); }
      if (all || what === 'proposals') setProposals(asArray<Proposal>(await api.proposals()));
      if (all || what === 'lists') setLists(asArray<List>(await api.lists()));
      if (all || what === 'folders') setFolders(asArray<Folder>(await api.folders()));
      if (all || what === 'insights') setInsights(asArray<Insight>(await api.insights()));
      if (all || what === 'countdowns') setCountdowns(asArray<Countdown>(await api.countdowns()));
      // settings 单独 catch，不跟上面几行共用外层的 try：离线时 api.settings()
      // 必然抛（task-2-report 修复轮 2 C2——离线没有「这台设备的设置」可读，
      // GET /api/settings 读到的其实是桌面机器的 device.json）。不单独 catch
      // 的话，这一行抛出会连累外层 catch 直接跳过下面 trash/conflicts 的
      // 更新——settings 读不到是离线时的正常状态，不该拖累别的字段没能刷新，
      // 也不需要弹一条错误提示（真正的「离线」记号是 Task 3 的界面层要做的
      // 事，不是每次 reload 都弹一条不能操作的提示）。
      //
      // **只吞 OfflineUnsupportedError 这一种**（整分支审查 I1「门二」）：
      // 这里曾经是个光秃秃的 `catch {}`，注释论证的是离线场景，实际连**在线**
      // 时 `/api/settings` 单独 500（device.json 手改坏了之类）也一起吞了——
      // 用户看不到任何错误、tasks/inbox 都正常，`settings` state 却停在
      // 「从没读到过」，正是上面那条数据丢失链的起点。改这一批之前这行是
      // 裸的 `setSettings(await api.settings())`，抛出去会走外层 catch 弹
      // message.error（`git show c4c154a:web/src/App.tsx` 可证），那个响亮
      // 的失败不该在做离线的路上被顺手弄没。
      //
      // 失败时保留当前 state：要么是 `null`（从没读到过，抽屉不给草稿），
      // 要么是上一次真正成功读到的值，绝不会是一份编出来的默认设置。
      if (all || what === 'settings') {
        try {
          setSettings(await api.settings());
        } catch (e) {
          if (!(e instanceof OfflineUnsupportedError)) void message.error((e as Error).message);
        }
      }
      if (all || what === 'trash') setTrash(asArray<TrashItem>(await api.trash()));
      // folders 列进 known 但这里没有对应分支：它的视图在下一批，
      // 现在还没有 state 可刷。列进去表示「认得，只是现在没有要刷的东西」——
      // 不列的话会掉进上面的 all 分支，每次都白拉一轮全量。
      // conflicts 不挂在 all/what 判断上：冲突副本落在 `paths()` 那几个实体目录里的哪一个都
      // 可能，watcher 报的 file 是那个目录名本身（比如 'tasks'），不会是专门的
      // 'conflicts'——只在 all 分支拉的话，真实发生的「某个目录里多了一份冲突
      // 副本」（file==='tasks' 这类已知值，all 判定为 false）反而会被漏掉。
      // 每次 reload 都问一遍，成本是一次目录扫描，不值得为它专门抠 what。
      setConflicts(asArray<ConflictFile>(await api.conflicts()));
      setBroken(asArray<ConflictFile>(await api.broken()));
    } catch (e) {
      void message.error((e as Error).message);
    }
  }, [message]);

  // 离线记号的刷新——`isOnline()` 是 lib/dataSource.ts 那份路由判据的唯一
  // 实现，直接调用它，不是另外发一次探测：并发调用会去重成一份飞行中的
  // promise（见 dataSource.ts 里 `pending` 的注释——复审 M1 指出「这里不
  // 额外打请求」曾经是错的，5 秒缓存只挡得住依次调用，挡不住挂载时
  // reload()/refreshOffline() 并排触发的并发调用）。isOnline() 自己吞掉了
  // fetch 异常，不会抛给这里，不需要 catch。
  //
  // 前一次算出来的结果，镜像进一个 ref——跟本文件 selectionRef/tasksRef
  // 同一个套路（见那两处定义时的注释），不是多此一举：下面判断「是不是刚
  // 从离线翻回在线」不能靠 `setOffline` 的函数式更新参数去读旧值，那样等于
  // 把 `reload()` 这个副作用塞进了 state updater 里——`main.tsx` 用
  // `<StrictMode>` 包着整棵树，updater 函数会被刻意调用两次来揪这类不纯
  // 代码，副作用藏在里面的话开发环境里 `reload()` 会莫名其妙多打一次。
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const refreshOffline = useCallback(() => {
    void isOnline().then(async (online) => {
      // 前一拍是不是离线，要在 setOffline 之前读——下面有 await，await 之后
      // offlineRef.current 已经被这次的 setOffline 引发的重渲染改掉了。
      const wasOffline = offlineRef.current;
      setOffline(!online);

      // ── 连得上了就把离线期间的改动推回桌面（task-8-brief）──
      //
      // **只挂在这一个地方。** 挂载、SSE `onOpen`（重连）、60 秒心跳、离线→在线
      // 跃迁四条路全都经过 `refreshOffline()`，逐处各接一次就是这个仓库栽过 27 次
      // 的「N 个接线点，漏掉一处不会报错、只会静默失灵」。
      //
      // **为什么不是只挂在「离线→在线跃迁」那一刻**（那个判据现在只管 reload，
      // 不管推送）：手机在飞行模式下被系统杀掉、等回到 Wi-Fi 之后才重开，`offline`
      // 初值是 `false`、第一次探测就判在线——**那条跃迁永远不会发生**，上次没推
      // 成功的东西会永远躺在脏集里。判据是「在线 + 脏集非空」，两种情况都覆盖。
      //
      // 常态成本仍然是零：脏集空的时候 `pushBackIfDirty()` 自己返回 `null`，一次
      // 网络都不发（桌面上脏集永远是空的，这条心跳对它来说什么也没变）。并发也不
      // 用管——它自带 `inflight` 去重，同一拍被叫几次都是同一次飞行。
      let summary: PushSummary | null = null;
      if (online) {
        try {
          summary = await pushBackIfDirty();
        } catch (e) {
          // **推失败就说推失败，绝不吞。** 吞掉的话用户以为改动回去了、其实还在
          // 手机上，那正是这一整批要消灭的静默失败。这里也是「一条畸形条目/不安全
          // id 让整批永远 400」（Task 6 复审 M3）唯一会被人看见的地方——服务端那两
          // 条 400 文案里没有 id，至少要让他知道「推不回去」这件事真的在发生。
          // 「还留在本地」不是安慰话，是 `pushBack.ts` 写死的性质：抛出来的时候一个
          // 记号都没清，下次重连原样再推一遍。
          // **固定 `key`**：这条错误很可能是修不掉的（一条畸形条目让整批永远 400），而
          // `refreshOffline` 每 60 秒跑一拍——不给 key 的话它每分钟往屏幕上叠一条，是在
          // 惩罚用户。同一个 key 让 antd 换掉那一条而不是再堆一条。
          // **成功和撞车那两条故意不给 key**：那两个是「刚发生了一件事」，本来就该每次都说。
          void message.error({
            key: 'push-back-failed',
            content: `把离线改动推回桌面时出错：${(e as Error).message}。改动还留在本地，下次连上会再试`,
          });
        }
        // 「这次推得怎么样」分两档：success / warning，加上上面 catch 里那条 error。
        // 撞车不是错误（你那份进了冲突副本，去看一眼），但也不是「一切正常」，两者
        // 混成一档就分不出来了。顺带核过颜色：antd 6 的 message 图标色读的是
        // colorSuccess/colorWarning/colorError/colorInfo（`node_modules/antd/es/
        // notification/style/notification.js` 那张表），theme.ts（56-81 行）把这四个
        // 分别压成了你的墨和过期橙，**没有一处读 colorPrimary**——群青是 AI 产出内容
        // 的配额，同步/冲突一点都不许借。
        if (summary && summary.conflicted > 0) {
          void message.warning(`推回 ${summary.pushed} 条，${summary.conflicted} 条撞车、已另存成冲突副本——看顶上那条「同步冲突」`);
        } else if (summary && summary.pushed > 0) {
          void message.success(`已把 ${summary.pushed} 条离线改动推回桌面`);
        }
        // **独立的一句，不接在上面那条链后面**：它说的不是「推得怎么样」，而是另一件
        // 用户马上会看到的事——你离线删掉的那几条又回来了（计划⑥那张表最后一行，
        // 旧格式的脏记号没有基准、判不出桌面动没动过、于是不删）。接进链里的话，一批
        // 里既有推成功的又有复活的（旧版本升上来的手机的常态）就只会看到「已把 N 条
        // 推回桌面」，复活那件事照样没人说；而全是复活那一拍，`pushed`/`conflicted`
        // 两个数都是 0，上面两档一档都不成立，任务默默回到看板上、零解释
        // （整分支审查 M3）。这一整批要消灭的正是这种静默。
        if (summary && summary.revived > 0) {
          void message.info(`${summary.revived} 条离线删掉的没带基准（上一版留下的记号），判不出桌面这期间动没动过，这次一条都没删——桌面上还在的会重新出现（任务回看板、随手记回收件箱），再删一次就行`);
        }
      }

      // 脏集读到坏数据（`localStore.ts` 的 `readDirty`）——Task 1 记下的那条欠账。
      // 那边只 `console.error`，用户这一侧看不见，而丢掉的是「这几条本地改过、还没
      // 推回去」这个事实本身，那些改动此后永远推不回服务端。**放在 `online` 判断
      // 外面**：离线时的每一次写入都会读一遍脏集（`mark()`），坏数据在那时候就被
      // 发现了，等回到在线才说等于白等一场飞行模式。
      const broken = takeDirtyReadFailure();
      if (broken) void message.error(broken);

      // 刷新分两种理由，都不成立就别刷：
      // - 复审 I3：翻回在线的那一刻要刷，不然横幅消失了（说「现在是在线的」），
      //   看板上其实还是离线时的本地快照，两者互相打脸。
      // - 真推过东西也要刷：服务端刚被这次推送改过；而且撞车写出来的冲突副本要靠
      //   这一次 reload 里的 `api.conflicts()` 才出得来，上面那条 warning 让人「看
      //   顶上那条同步冲突」，横幅得真的在那儿。
      // **推完才刷，不是先刷再推**：先刷拉到的是推送之前的服务端状态，冲突横幅正好
      // 差这一次推送写出来的那几份副本。
      // 一直在线、脏集又是空的（桌面的常态）两条都不成立——那样会把这条本来只是
      // 「问一声在不在线」的心跳，变成每 60 秒一次的强制整页刷新。
      if (wasOffline || summary) void reload();
    });
  }, [reload, message]);

  useEffect(() => {
    void reload();
    refreshOffline();
    const off = subscribe({
      onChange: (file) => void reload(file),
      onReminder: (t) => setDue((prev) => (prev.includes(t.id) ? prev : [...prev, t.id])),
      // 'idle' 不代表任何结果，只是「排期没了、没别的状态接着说话」——收起来，
      // 等价于回到没有 agent 状态时的样子，见 server/src/autoExpand.ts 的 cancel()。
      onAgentStatus: (s) => setAgent(s.state === 'idle' ? null : s),
      // SSE 连上了本身就是「联网了」的信号，顺手刷新一次离线记号——不用等
      // 到下面 60 秒的 tick 才翻回「在线」。
      onOpen: () => { void reload(); refreshOffline(); },
    });
    // 60 秒的心跳：`now` 本来就要定时推进（过期判断要跟当下比），离线记号
    // 顺手搭这班车一起刷，不单开一个 interval。真的离线时 SSE 连不上、也
    // 不会有 onChange/onOpen 事件把 reload()/refreshOffline() 再叫起来，
    // 这个 tick 是「有没有恢复联网」唯一会主动去问一次的地方。
    const tick = setInterval(() => { setNow(new Date()); refreshOffline(); }, 60_000);
    // 离线时「写进文件 → watcher → SSE → reload」这条链整段不存在（见
    // guard() 上面的注释和 lib/localStore.ts 的 onLocalWrite）。本地存储自己
    // 叫的这一声接的是同一个 reload()——**不是第二条更新路径**：界面永远只从
    // reload() 拿数据，变的只是「谁把它叫起来」，在线是 SSE，离线是这里。
    // 一处接线覆盖全部离线写入，不经 guard() 的那几个写入点（编辑态保存的
    // onEditTask/onEditText、随手记的 addInbox、手动排序的 reorderTasks）
    // 跟经 guard() 的一视同仁，不用在每个调用点各补一次刷新。
    const offLocalWrite = onLocalWrite(() => void reload());
    return () => {
      off();
      clearInterval(tick);
      offLocalWrite();
    };
  }, [reload, refreshOffline]);

  // 手机本地通知的整体重排——**单一接线点**。设计正本第十一节要的两个触发点
  // （`reload()` 之后、`onLocalWrite` 之后）在这个组件里本来就是同一件事：界面
  // 只从 `reload()` 拿数据，而 `onLocalWrite` 的唯一订阅者就是 `reload()`（上面
  // 那个挂载 effect 最后一行），两条路最后都落在 `setTasks` 上。挂在 `tasks`
  // 这一处等于两条都覆盖到，**不在各个触发点上各接一次**——「N 个接线点，漏掉
  // 一处不报错、只是静默失灵」是这个仓库栽过 28 次的形状。
  // 依据是数组 identity：`api.tasks()` 每次都是新解析出来的（在线是 JSON 响应，
  // 离线是 localStore 里 JSON.parse 出来的），所以 reload 一次就重排一次，哪怕
  // 内容没变——整体重排本来就是幂等的（全取消再排一遍），多排一轮没有代价。
  //
  // 非原生壳里 `rescheduleLocalNotifications` 第一行就返回 'not-native'，一个
  // 插件方法都不碰：桌面那条提醒路已经存在（fireReminders → Electron 原生通知 /
  // PowerShell 兜底），这里再排一份就是同一台机器响两次。
  //
  // **两件用户可见的事没有显示，理由记在这儿**（都不是漏了）：
  // - **精确闹钟没给时，提醒可能晚几分钟**：不显示。**严重性差一个量级**——下面
  //   那条横幅说的是「一条都不会响」（功能没有），这条是「还是会响，可能晚几
  //   分钟」（精度降级）；两条并排常驻会让真正致命的那条贬值，而新装的机器上
  //   两种权限往往一起缺，他该先看见的是「根本不会响」。收益也接近零：知道了
  //   也不改变他此刻的下一步动作。落点是冒烟清单（Task 5）。
  //   ⚠️ 代价要说清：Task 3 改成显式排不精确之后，插件那条「把用户送进系统
  //   『闹钟和提醒』设置页」的分支和 `ScheduleResult.warning` 都**到不了**，
  //   但两格走的是两条分支（LocalNotificationsPlugin.kt 120-133 / 180-182）：
  //   权限给了 ⇒ `honorExact` 为真、而 `canScheduleExactAlarms()` 也真，跳过；
  //   没给 ⇒ 我们写死 `isExactNotification: false`，`any{}` 恒假，也跳过。
  //   置位要的是「想要精确 + 没有权限」这个**组合**，而它被我们拆散了
  //   （notifyNative.ts 里那段说得准，这里别抄漏）。结论：降级现在是静默的，
  //   **冒烟清单是唯一的告知路径，不是补充说明**。
  // - **`planNotifications` 的 `missed`（到点了而 `firedAt` 还空着）**：这一批
  //   之后它不再等于「谁都没提醒过你」。手机自己排的通知响过**不会回写
  //   `firedAt`**（本地通知根本不联网），所以每一条手机真的响过的提醒，下一次
  //   重排都会落进 `missed`；而它们在桌面那半也不会丢——服务下次起来时
  //   `fireReminders` 会把到期还没盖章的补发一遍（server/src/reminder.ts）。
  //   在最该显示它的那台设备上，「你错过了 N 条」恰恰是假的。这个字段留着是
  //   因为它是 notifyPlan.ts 里那道 NaN 守卫唯一守得住的地方，不是为了上界面。
  useEffect(() => {
    // 还没成功读到过任务就什么都别做——**空数组在这里是「不知道」不是「没有」**，
    // 拿它去重排等于把手机清空。理由和窗口有多长写在 `tasksLoaded` 定义处。
    if (!tasksLoaded) return;
    void rescheduleLocalNotifications(tasks, new Date())
      .then((r) => setNotifDenied(r === 'denied'))
      // 抛出来的不是「一次失败」，是**「此刻这台手机上可能一条提醒都没有」**：
      // 排程本身（`schedule()`）reject 的时候，前面那句 `cancel()` **上一轮真排
      // 过东西的话**（`ids.length > 0`，notifyNative.ts 里 `port.cancel(ids)` 那一步）已经跑过了——旧的
      // 全取消了、新的一条没排上，要等下一次重排才恢复。文案说「最坏的情况是」
      // 就是因为这个「可能」，但那件最坏的事必须说出来，一句轻描淡写的「排程
      // 失败」会让人以为提醒还在。
      // （`exactPermission()` 那条已经靠挪到 `cancel` 之前解决了，见
      // notifyNative.ts；剩下这条挪不掉，它就是排程本身。）
      // **固定 key**：`tasks` 每变一次这里就跑一次，不给 key 的话同一个毛病会
      // 在屏幕上叠一摞，跟 push-back-failed 同一条理由。
      .catch((e) => void message.error({
        key: 'notif-reschedule-failed',
        content: `重排本地通知失败：${(e as Error).message}。这一轮排到一半断了——最坏的情况是旧提醒已经取消、新的一条都没排上，也就是这台手机到点不会响；改一条任务、或者重开应用，会自动再排一次。`,
      }));
  }, [tasks, tasksLoaded, message]);

  // 分享接入（设计正本第十一节「分享接入」小节）：别的 App 里选中文字 →
  // 分享到「办事师爷」→ 直接进收件箱。**这一层只剩两件事**：存哪儿、屏幕上说什么。
  // 「算不算一次分享」「标题跟正文怎么拼」全在 `lib/sharePlan.ts`，「在不在
  // 原生壳里」「怎么订阅退订」在 `lib/shareNative.ts`，这儿一个判断都不该长。
  //
  // **走的是随手记那一条路，一个字都不新开**：`api.addInbox(text)` 自己会选路
  // （在线 POST、离线落本地 + 打脏记号 + 回到局域网自动推回桌面，见 api.ts 里 `inbox` 那条
  // 和 lib/dataSource.ts 的 `route()`）。新开一条写入路径就是这个仓库栽过 28 次
  // 的「N 个接线点只覆盖一部分」。
  //
  // **存完不刷新、也不切去处，跟 InboxComposer 一模一样**（下面那个
  // `onSubmit={async (text) => { await api.addInbox(text); }}`）：在线靠服务端
  // watcher → SSE data-changed → `reload()`，离线靠 `onLocalWrite` → `reload()`
  // （上面那个挂载 effect 最后一行）。这里再调一次 `reload()` 就是第二条刷新
  // 路径。冷启动分享时 POST 可能早于 SSE 连上——那一格由上面 `subscribe` 的
  // `onOpen: () => { void reload(); … }` 兜住，不用在这儿补第三条。
  // **切去处也不做**：他分享完多半直接切回原来那个 App，把他的看板从「今天」
  // 掀到「收件箱」是他没要过的副作用，连分享三条还会被掀三次。
  //
  // **成功也说一句话，虽然这个仓库的规矩是「成功不说话」**：那条规矩的前提是
  // 「结果就在屏幕上」。随手记存完，条目就在眼前的收件箱列表里；而分享是从
  // **别的 App** 过来的，落地那一刻主看板还是默认的「今天」，新条目根本不在
  // 屏幕上——这一句是这条路径上唯一的「它真的进去了」的信号。带一小段原文有
  // 两个用处：固定 key 会让连着分享的两条互相顶掉，没有原文就分不出说的是哪
  // 一条；顺带也让他看见标题真的拼在正文前面了（`sharePlan.ts` 的拼法）。
  // 按码点切不按 `.length` 切：分享来的文字里 emoji 很常见，`slice` 会把代理对
  // 劈成两半、渲染出一个替换字符。
  //
  // **失败必须说，而且要说清是「没存进去」不是「没同步」**：`route()`
  // （lib/dataSource.ts 的 `route()`）**在线那一支失败之后不会回落到本地**——`isOnline()`
  // 为真就只走 `http()`，它抛出来就是直接抛到这里。所以走到下面 `.then` 第二个
  // 参数时，这段文字**哪儿都没写成**，本地也没有一份。手机上这不是罕见格：
  // 探测结果有 5 秒缓存（`ONLINE_CACHE_MS`，dataSource.ts），进电梯那几秒
  // 探测说「在线」而 POST 已经发不出去了，正好落这一格。
  // **不做重试队列**：那段文字还在他刚才那个 App 里，重新分享一次是全部代价；
  // 一个「待重试的分享」队列意味着一份新的持久化状态、一条新的写入路径和一套
  // 新的冲突语义。所以文案要指路（「回去重新分享一次」），不是只报个错。
  //
  // **「是分享、但一个字都没有」那一格这里不提示，是算过账的，不是漏了**：
  // ① 进得来的只剩一种情况——manifest 那条 intent-filter 只声明了 `text/plain`
  //    （AndroidManifest.xml，Task 2），分享图片/文件时「办事师爷」压根不出现在系统
  //    的分享菜单里，收都收不到；剩下的只有「某个 App 发了 text/plain、
  //    EXTRA_TEXT 却是空白」。
  // ② 而这一层**判不出这一格**：`subscribeShare` 只在有文字时才回调
  //    （`shareNative.ts` 的 `onShared`）。要判就得拿 `nativeSharePort.onShared` 再订
  //    一次，而**第二个监听者恰恰拿不到冷启动那条分享**：Plugin.java 的
  //    `sendRetainedArgumentsForEvent` 只在**第一个**监听者注册时才调
  //    （`:629` 的 `listeners == null || listeners.isEmpty()` 那一支进去，
  //    `:636` 调用；javadoc `:709` 也写着 only when the first listener is added），
  //    而且 `:719` 补发前先 `remove` ⇒ 只消费一次。也就是说，为这一格加的那道
  //    提示，在最需要它的冷启动分享上正好不会响——那不是一道守卫，是一句谎。
  // 换个活法就得改 Task 3 那个已经定稿、有测试的签名。**一句罕见提示不值这两样
  // 里的任何一样**；这一格在测试里清点了（「什么都没发生」也要有断言），
  // 不是没人管。
  //
  // 依赖数组只有 `[message]`（`useApp()` 给的实例是稳的，跟下面
  // desktop-open-task 那个 effect 同一条）：**订阅只该建一次**。把 tasks 之类
  // 会变的东西放进来会让它反复退订重订——不会丢事件（退订到重订之间进来的那条
  // 会被 `retainUntilConsumed` 留住、下次注册时补发），但那是白白多绕一圈。
  useEffect(() => subscribeShare(nativeSharePort, (text) => {
    void api.addInbox(text).then(
      () => {
        const cs = [...text];
        void message.success({
          key: 'share-in',
          content: `已存进收件箱：${cs.length > 24 ? `${cs.slice(0, 24).join('')}…` : text}`,
        });
      },
      (e: Error) => void message.error({
        key: 'share-in',
        content: `分享的内容没存进收件箱：${e.message}。这段文字还在你刚才那个 App 里，回去重新分享一次。`,
      }),
    );
  }), [message]);

  // 这里曾经有一个「要不要弹 ServerSetup」的挂载探测（`apiBaseReady()` →
  // `getApiBase() !== ''` → `testConnection('')` → `looksLikeOwnServer`），
  // 结果喂给上面那个已经删掉的 `needsServerSetup`。整个删了，理由见 `offline`
  // state 定义处：「没配过地址」不再是一种要先过一道墙的状态，它跟「配过但
  // 连不上」在这个应用里落到同一个地方——`isOnline()` 判 false，走离线那条
  // 路，顶上挂一条记号。少一处探测，也少一份「在不在线」的第二判据。

  // 去处写进 URL hash：hashchange 驱动 view state（浏览器前进/后退因此白捡，
  // 不用自己维护栈）。切去处只经 navigate() 写 hash，不直接 setView——
  // 两头都写的话，后退时 hashchange 和直接调用会打架。见 lib/hashView.ts。
  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  // 赋值（不是 replaceState）：会进历史，后退能回到上一个去处，这是想要的。
  /** 一个去处属于哪个模块。任务那一整段（今天/全部/某个清单/某个标签……）算
   *  一个，其余每一个去处各算一个——判据复用 `showsSidebar`，不另写一份。 */
  const moduleOf = (v: string) => (showsSidebar(v) ? 'tasks' : v);

  const navigate = (v: string) => {
    // **换一个模块，右边那一栏收起来**：它摊的是一条任务，而习惯/专注统计/
    // 日历/四象限各是一个独立界面——从「今天」切到「习惯」之后它还挂在右边、
    // 摊着一条跟这一屏毫无关系的任务，那正是「切了模块右边根本没变」。
    //
    // **写在这儿，不是写成一个盯着 view 的 effect。** effect 那一版试过，
    // 它在 hash 往返落地之后才跑：`openTask`（回顾里点关联任务、桌面通知点
    // 开那一条）先 navigate 再 setDetail，那个 effect 随后把刚设好的这一条
    // 又清掉了——表现是从回顾里点一条任务，切过去了，右边却是空的。写在
    // navigate 里则是同一次事件里先清后设，后者赢。
    if (moduleOf(v) !== moduleOf(view)) setDetail(null);
    window.location.hash = hashFromView(v);
  };

  /**
   * 「把这一条指出来」——切到装得下它的那个去处，再把它摊在右边那一栏详情
   * 面板里。
   *
   * **原来是 `setEditRequest(id)`**（借 'E' 键那条路把那张卡的编辑表单打
   * 开）。改成开面板之后这条路短了一大截：`editRequest` 要 App→TaskGrid→
   * TaskCard 三层转发、外加一次 `onAutoEdited` 回握手把 id 清掉，而且**只有
   * 那条任务恰好渲染在当前视图里才生效**——切视图是 hash 往返（异步），卡片
   * 挂出来又是下一帧，中间任何一处没对上就是"点了没反应"。面板不经过列表：
   * setDetailId 之后那一栏当场就有内容，跟那条任务在哪个视图里、有没有被筛
   * 掉都无关。
   *
   * **四个地方要问同一个问题**：回顾里点关联任务、习惯页点习惯名、专注统计
   * 里点任务名、桌面通知点开那一条。判据一模一样，原来是四份复制（其中三份
   * 各带一段说同一件事的注释）——而它是那种漏改一处不会有任何东西报错、
   * 只会在一个入口上「点了跳错地方」的判断。
   *
   * 判据：**已完成的落「已完成」，其余落「全部」**。「全部」按 `allSections`
   * 的定义排除了 done（`keep` 是空 Set，刚切过去还没有任何卡在编辑），而
   * 「今天」按时间筛、清单按 `listId` 筛，都可能不含它——那两个是唯一保证
   * 装得下任意一条任务的去处。
   *
   * 找不到（这条任务已经被删了）就说一声，不假装跳成功了。
   */
  const openTask = (id: string) => {
    const t = tasksRef.current.find((x) => x.id === id);
    if (!t) {
      void message.warning('那条任务已经不在了');
      return;
    }
    // 面板不依赖列表，但**还是要切过去**：这条任务同时在列表里被指出来，
    // 才看得出它跟别的任务的关系（前后、同一组里还有什么）。
    navigate(t.status === 'done' ? 'done' : 'all');
    openDetail(id);
  };

  // 桌面版（Electron）点了提醒通知本体（不是「完成/推迟 10 分钟」两个按钮——
  // 那两个走 desktop/src/main.ts 的协议激活直接 PATCH 服务端，不经过网页）
  // 会打开窗口、再往这棵页面派发一个 `desktop-open-task` 自定义事件带上任务
  // id（见 main.ts openTask()）。这里接住它，决定「定位到那条任务」具体是
  // 什么意思：切到装得下这条任务的去处——跟 `registry.review` 的 `onOpen`
  // 同一个判据（done 状态落「已完成」，其余落「全部」，是唯一保证不管
  // due/清单/标签是什么、都装得下任意一条未完成任务的去处）——再用已有的
  // editRequest/autoEdit 机制（'E' 键同一条路，见上面 editRequest 定义处的
  // 注释）把它的编辑表单打开，等于把这张卡指出来，不是只把窗口带到前台。
  //
  // tasksRef：这个监听器只在挂载时订阅一次（依赖数组只有 [message]），
  // 事件真正触发时要读的是当下最新的任务列表，不能读订阅那一刻的旧闭包——
  // 跟上面 selectionRef 同一条理由。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    // 判据整份在 `openTask` 里——四个入口共用同一个，见那儿的注释。
    // 通知发出之后、点击之前这条任务被删了，它会说一句「那条任务已经不在了」，
    // 不假装跳成功了。
    const onDesktopOpenTask = (e: Event) => openTask((e as CustomEvent<string>).detail);
    window.addEventListener('desktop-open-task', onDesktopOpenTask);
    return () => window.removeEventListener('desktop-open-task', onDesktopOpenTask);
  }, [message]);

  // 全局兜底：文件掉在卡片之外（视图空白处、卡片缝隙、侧栏……）时，浏览器
  // 默认会把整个窗口导航到 file:///…，正在编辑的草稿和选中态一起没
  // （final-review.md「专项判定」）。TaskCard 自己的拖放目标（见
  // Attachments.tsx 的 useFileDrop）只接住落在卡片上的文件，接不住这个——
  // 无论拖放区扩不扩到整张卡都要有这一道，卡片之间的缝隙、空视图、侧栏永远
  // 是裸的。只吃「真的是文件」这一种拖拽（`types` 含 'Files'），卡片之间的
  // 排序拖拽（`text/plain`）原样放行，不受影响。
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  // 切视图必须清空选中——不然会出现「在『今天』选了三张，切到『垃圾箱』按
  // Del，删掉了看不见的三张」，这是数据丢失，不是观感问题，见
  // 2026-08-17-selection.md 设计③。
  //
  // **这个依赖数组列的不是「view / query / filter 这三样东西」，而是决定
  // 屏幕上看得见哪些卡的全部输入。** 凡是某个 state 一变，就可能让某张卡从
  // 当前视图的渲染结果里消失或出现，它就必须在这里——不然 selection 会停在
  // 变化前的那一批上，批量操作（尤其删除）打在用户已经看不见的卡上。以后
  // 再加一条这样的轴（比如分页、日期范围筛选；纯粹换个排序不改变「集合里有
  // 哪些」，不算），先问这一句：这个新 state 会不会让某张卡从渲染结果里
  // 消失，而 selection 没跟着变？答案是会，就把它加进来——不要等下一轮审查
  // 抓出来才补，这条防线已经因为漏了一条轴而被打穿两次：
  //   - view：换了视图，候选集合整个换一批（设计③，最初的那道口子）。
  //   - query：待在同一个视图里（典型是「搜索」）改查询词，view 不变
  //     （从进第一个字起就一直是 'search'），但 hits（下面
  //     searchTasks(tasks, query) 算出来的那份）跟着每一次敲字变化，卡片
  //     从 DOM 里消失，selection 却原样留着——见 final-review.md I4。
  //   - filter（这一批新加）：筛选栏收窄 sections 用的是
  //     filterMatchedIds，跟 query 是同一件事的另一种写法——筛选栏一变，
  //     屏幕上的集合跟着变，selection 却原样停在旧的那一批上，见
  //     final-review.md C1。
  //   - boardFilter：「按来源」那一屏顶上那排状态筛选片。它是**另一个**
  //     筛选 state（`filter` 是筛选栏那份，两者互不相干），而那一屏原来
  //     选不中任何东西，所以这条轴以前不存在。接上选中的同一批改动里把它
  //     补进来：不补的话，在那一屏选中三张、点一下「已完成」把它们筛没了，
  //     选中还停在那三张上，接着按 Del 就是删掉看不见的卡——正是上面那句
  //     「这是数据丢失，不是观感问题」说的那件事。
  //
  // 依赖不写 [view] 本身在每个改 view/query/filter 的入口各调用一次
  // clearSelection()：不管这次变化是点导航、后退前进（hashchange）、命令
  // 面板、接受提议之后的程序化 navigate()、搜索框打字、还是筛选栏任何一颗
  // 控件，只要三者之一真的变了就清，一个口子堵住所有路径，不用担心漏了
  // 某一条入口。
  //
  // **`filter` 本身不会被这个 effect 清空**——effect 体只调
  // clearSelection()/setEditRequest(null)，不碰 setFilter。切视图/改查询词/
  // 改筛选都不会重置筛选栏本身（设计②：筛选跨视图保留正是它有用的地方），
  // 这里清的是「选中」，跟「筛选栏当前是什么」是两件反方向的事——别把
  // setFilter(emptyFilter()) 也加进 effect 体里。
  useEffect(() => {
    clearSelection();
    setEditRequest(null);
    // clearSelection 是每次渲染新建的箭头函数，不能进依赖数组——那样会让
    // 这个 effect 在每次渲染后都重跑，选中态永远清不掉。只在 view/query/
    // filter 真的变化时触发才是「切视图/改查询词/改筛选清空」该有的语义。
    // filter 是 state 里的对象，只在真的变化时换新引用（FilterBar 每次
    // onChange 都传一个新对象），不会让这个 effect 每次渲染都重跑。
  }, [view, query, filter, boardFilter]);

  // 「新任务」按钮开的是 TaskComposer 表单；N（以及命令面板里那条「随手记」
  // 命令，见下面 commands）对应的是产品说明里「随手记」那个更轻的入口
  // （Sidebar 底部 .ink-nav-composer 里的 InboxComposer），两个不是同一个
  // 东西，见 task-2-brief。textarea 不用 ref 往上暴露——它经 Sidebar 的
  // composer prop 传进来，是 App 拼好的一段 ReactNode，转发 ref 得给
  // InboxComposer/Sidebar 都加 forwardRef；这个仓库目前没有这个模式，也
  // 没有第二处要转发。.ink-composer 是 InboxComposer 自己的根 class，里面
  // 只有这一个 textarea，选择器比转发 ref 更省——认组件自己的根、不认装它的
  // 那个容器，见下面 focusQuickCapture 的注释。
  // 提成函数（不是内联在 case 'new' 里）：命令面板的「随手记」命令要跑
  // 一模一样的动作，见 brief「一条『新任务』（跑跟 N 同一个动作）」——
  // 两处各写一遍选择器的话，以后 class 名一改，容易只改掉一处。
  /**
   * 光标送进随手记那个框。
   *
   * **框不在屏幕上时先切回「今天」。** 习惯/专注统计/纪念日/回顾这几个模块整
   * 条清单侧栏都不渲染（`hideSidebar`），而随手记就长在那一栏底下——不管这
   * 一档的话，站在「习惯」上按 `N` 是一个按了完全没反应的键，而「随手记的成本
   * 不能变高」是这个产品的硬约束。切过去之后那一栏就在了，同一帧还聚不了焦
   * （React 下一帧才挂出来），所以放进 `requestAnimationFrame`。
   *
   * **选择器认的是这个框自己（`.ink-composer`，`InboxComposer` 的根），不是
   * 装它的那个位置。** 原来写的是 `.ink-nav-composer textarea`——那是**侧栏
   * 里**的容器；窄屏下随手记搬到了任务列表下面（`.ink-narrow-composer`，见
   * NavShell 那段），那个选择器当场找不到东西，`N` 和命令面板里的「随手记」
   * 在手机上变成两个按了没反应的入口。认组件自己的根，摆在哪儿都找得到。
   */
  const focusQuickCapture = () => {
    const box = () => document.querySelector<HTMLTextAreaElement>('.ink-composer textarea');
    if (box()) { box()!.focus(); return; }
    navigate(lastTaskViewRef.current);
    requestAnimationFrame(() => box()?.focus());
  };

  /**
   * 展开「新任务」表单。**三个入口共用**：顶上那颗按钮、`C` 键、命令面板里
   * 那条命令——各写一遍的话，「顺带清掉上一次从日历带过来的那一天」这种事
   * 早晚会漏在某一处。
   *
   * 跟 `focusQuickCapture` 是一对，而它们通向的是**两条不同的路**：随手记
   * 是「想到什么先记下来、还没想清楚是几件事」（丢进收件箱等 AI 拆，默认
   * 60 秒）；这个表单是「已经知道自己要做什么」（标题里写「明天下午两点交
   * 周报 #工作」当场就成一条任务）。在这之前只有前者有键，也只有前者进了
   * 命令面板——键盘上快的那一个通向慢的那条路。
   */
  const openCompose = () => {
    setComposeDue(null);
    setComposing(true);
  };

  // 中文输入法那道缝：`isComposing` 在组字第一个 keydown 上是 false（
  // compositionstart 在它之后才派发），今天靠 inField 结构性地堵住第一个键
  // （输入法只能在可编辑元素持有焦点时开始组字）——但那是「这棵 DOM 树今天
  // 的性质」，不是 keyAction 的性质。这里补一道不依赖「焦点在哪种元素上」的：
  // 记住「现在正在组字」，从 compositionstart 之后的第二个键起短路，不用等
  // isComposing/inField 任何一个。第一个键仍然只靠 inField 兜底，
  // 见 final-review.md「中文输入法那两道守卫」一节。
  const composingRef = useRef(false);

  // 全局快捷键：N 聚焦随手记、/ 聚焦搜索框、1..9 切视图、Esc 在搜索框里清空
  // 退回、Ctrl/Cmd+K 开命令面板。所有「这个键该不该触发」的判断都在
  // keyAction 里（纯函数，见 lib/keymap.ts），这里只管把翻译出来的动作接到
  // 已有的东西上——切视图只经 navigate()，不直接 setView，跟点导航、搜索框
  // 打字、回顾里点关联任务是同一条规矩（见上面 navigate 定义处的注释）。
  //
  // **处理函数放在一个每次渲染都更新的 ref 里，监听只订阅一次。** 原来这整段
  // 写在 effect 里、依赖 `[view, paletteOpen]`，注释说「只有 Esc 分支需要知道
  // 现在在哪个去处」——那句话在写下时是对的，后来 `batchStatus`/`batchReschedule`/
  // `confirmBatchDelete` 接进来了，它们直接读渲染闭包里的 `tasks` 和 `now`。于是
  // 首屏那次订阅捕获的是 `tasks = []`，`reload()` 填满任务之后 effect 不重跑
  // （依赖没变），**监听器手里的那三个函数永远看见空数组**：Ctrl+点几张卡再按
  // T/M/W，`tasks.find` 全是 undefined、零请求零提示；按 D 能改状态但撤销提示
  // 不出来；按 Delete 时确认框数不到子任务、服务端却把子任务一起删了。只要
  // 切过一次视图就好了，所以已有的测试（先点一下导航）从没撞上。
  // 一个个函数改成读 `tasksRef` 是在追每一个闭包；这儿改成每次渲染把最新的
  // 处理函数放进 ref，监听器经 ref 调用——闭包永远是最新那份，以后再接什么
  // 进来也不会再有这一类账。
  const onKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyDownRef.current = (e: KeyboardEvent) => {
      if (composingRef.current) return;
      const action = keyAction(toKeyLike(e));
      if (!action) return;
      switch (action.kind) {
        case 'new':
          // 必须 preventDefault：不拦的话，这个 keydown 的默认动作打在
          // focusQuickCapture() 刚换过去的新焦点（随手记 textarea）上——
          // 按下的那个 N/n 会被浏览器原样打进这个刚聚焦的框里，回车就把
          // 一个脏字符提交进 data/inbox/。跟下面 'search' 分支同一个道理。
          e.preventDefault();
          focusQuickCapture();
          break;
        case 'compose':
          // 「新任务」表单。**不用 preventDefault**：跟上面 'new'/'search'
          // 不一样，这一下没有把焦点换到任何一个已经存在的输入框上——表单
          // 是这一帧之后才挂出来的，它自己的标题框靠 `autoFocusTitle` 在挂载
          // 时聚焦，那时候这个 keydown 早结束了，`C` 落不进去。
          //
          // 已经开着时这一下什么都不做（`setComposing(true)` 幂等）——不是
          // 静默失灵：他要的那个表单就在屏幕上开着。
          openCompose();
          break;
        case 'search':
          // 必须 preventDefault：不拦的话，这个 keydown 的默认动作打在
          // focus() 刚换过去的新焦点（搜索框）上，会多打出一个 '/'——不是
          // 「焦点本来就在输入框里」（那种情况 inField 已经让 keyAction 提前
          // 返回 null 了），是「焦点这一刻被这行代码换了过去」。
          e.preventDefault();
          // 搜索现在是一个弹层（SearchModal），不是侧栏顶上那个框——所以这里
          // 不用再「先切回任务模块再聚焦」了：弹层在哪个模块上都开得出来。
          setSearching(true);
          break;
        case 'view': {
          const spec = NAV_VIEW_SPECS[action.index];
          // 9 个数字键，VIEW_SPECS 里第 10 项之后（回顾、垃圾箱）够不到，
          // 不是 bug——命令面板才是它们的入口，见 NAV_VIEW_SPECS 上面的注释。
          if (spec) navigate(spec.key);
          break;
        }
        case 'escape':
          // **搜索框那一支没了**：它现在是一个弹层（SearchModal），Esc 由 antd
          // 的 Modal 自己接（跟命令面板同一个处理，见 CommandPalette 的注释），
          // 这里不用重复处理。
          // 选中态跟上面搜索框那半是两件事，不受「焦点在不在搜索框」影响：
          // Esc 是「从当前状态里退出来」这条语义的一部分（跟上一批 Esc 的
          // 用法一致），选中着卡片时按 Esc 该清空，不管这一下 Esc 焦点在
          // 哪儿。见 2026-08-17-selection.md 设计③。
          clearSelection();
          setEditRequest(null);
          // 详情面板也归 Esc 收——它是「当前打开着的一个东西」，跟选中态
          // 一样。**但焦点在输入框里时不收**：那一下 Esc 是面板里那张卡的
          // 「取消编辑」（TaskFields 的 onCancel），一起把面板关掉等于他
          // 改错一个字、整条任务连看都看不见了。`isInteractiveTarget` 是
          // keymap 那份现成的判据，不在这儿另写一个 tagName 判断。
          if (!isInteractiveTarget(e.target)) setDetail(null);
          break;
        case 'edit': {
          // 选中恰好一张才进入编辑态。**选中多张时说一句**，不是什么都不做
          // ——他刚选了三条、按了 `E`，屏幕上一点动静都没有，分不清是「这个键
          // 不管用」还是「这个应用没有批量编辑」。跟 `D`/`T`/`Delete` 那几条
          // 「一条都没选就什么都不做」不一样：那几下没有对象，这一下有对象、
          // 只是这个动作一次只能改一条。
          const n = selectionRef.current.ids.size;
          if (n === 1) setEditRequest([...selectionRef.current.ids][0]);
          else if (n > 1) void message.info(`选中了 ${n} 条，「编辑」一次只能改一条`);
          break;
        }
        case 'delete':
          // 一条都没选中时 Del 什么都不做——不弹一个「删除选中的 0 条？」
          // 出来。这是三个能碰到 confirmBatchDelete 的入口之一，其余两个
          // （BatchBar 的删除按钮、命令面板那条命令）各自也保证了「选中为空
          // 时压根不出现」，见 confirmBatchDelete 定义处的注释。
          if (selectionRef.current.ids.size > 0) confirmBatchDelete();
          break;
        // 完成 / 改期：作用在**选中的那几条**上，跟 Delete 同一个语义。
        // 一条都没选中时什么都不做——不发一个改零条的写。两者都复用批量操作
        // 条那两个现成的处理（一份 patch 套所有 / 逐条不同），不在这儿另写
        // 一遍：写第二遍就会有第二种「完成」和第二种「改期」。
        case 'done':
          if (selectionRef.current.ids.size > 0) batchStatus('done');
          break;
        case 'due':
          if (selectionRef.current.ids.size > 0) batchReschedule(action.to);
          break;
        case 'help':
          // 不用 preventDefault：`?` 在浏览器里没有默认动作，而 keyAction 已经
          // 挡掉了输入框（那里按 `?` 是在打字）。开着再按一次是幂等的。
          setHelpOpen(true);
          break;
        case 'palette':
          // 必须 preventDefault：Ctrl+K/Cmd+K 是浏览器自己的「跳到地址栏」
          // 快捷键，Ctrl+Shift+K 在 Firefox 是打开 Web 控制台——不拦的话面板
          // 开了，焦点却被浏览器抢到地址栏/控制台，接下来打的字全进不了这个
          // 面板。keyAction 里这一支排在 inField 判断之前（见 keymap.ts），
          // 输入框里按也会翻出这个动作——打开面板不用管当前焦点在哪儿。
          // setPaletteOpen(true) 是幂等的：面板已经开着时再按一次不会有任何
          // 副作用，也不会多挂一份监听——这个 useKeyDown 只有这一份，跟面板
          // 开没开无关。
          e.preventDefault();
          setPaletteOpen(true);
          break;
      }
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => onKeyDownRef.current(e);
    // 面板开着时，这整份全局监听直接不处理任何键：面板打开后焦点未必停在
    // 它自己的输入框里（antd Modal 的 `.ant-modal` 带 tabindex="-1"，点面板
    // 空白处焦点就会落到它上面），inField 这时候已经守不住——1..9 会在背后
    // 切视图、N 会把焦点拽到被遮罩挡住看不见的随手记框，见 final-review.md
    // I5。面板自己的 Esc/输入框按键走的是 CommandPalette 组件自己的处理器
    // 和 antd Modal 的键盘陷阱，不依赖这份监听，直接整段跳过不影响它们。
    if (paletteOpen) return;
    const onCompositionStart = () => { composingRef.current = true; };
    const onCompositionEnd = () => { composingRef.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('compositionstart', onCompositionStart);
      window.removeEventListener('compositionend', onCompositionEnd);
    };
  }, [paletteOpen]);

  // 每个写操作之后不手动刷新状态：写进文件 → watcher → SSE → reload。
  // 少一条更新路径，就少一处「界面和文件对不上」的可能。
  const guard = (fn: () => Promise<unknown>) => {
    void fn().catch((e: Error) => void message.error(e.message));
  };

  /**
   * **单条任务的写只走这一个入口**——五个视图原本各写一遍
   * `guard(() => api.patchTask(id, patch))`，「勾完给一次撤销」要是也各写一遍，
   * 漏掉的那一处不会报错，只会在那一个视图上静默没有撤销。同 `gridWiring`
   * 上面那段的道理。
   *
   * 撤销这件事本身仿的是滴答清单：点完成，屏幕下方那条提示里有个「撤销」。
   * 判据（算不算勾完、撤销该改回哪个状态、这一下有没有连带）全在
   * `lib/undoDone.ts`，这里只接线。
   */
  /**
   * 刚勾完的那几条**先留在原地划着删除线，停一下再移走**（仿滴答清单）。
   *
   * 在这之前是当场蒸发：一勾，那张卡从这一屏的谓词里掉出去，React 立刻把它
   * 卸载——手指还在原处，眼睛要重新找「我刚才点的是哪条、点对了没有」。
   * 撤销提示补的是「点错了怎么办」，补不了「我点的是不是这条」。
   *
   * 1.2 秒：够看清那一下划掉了哪一条，又不至于让人以为列表卡住了。
   *
   * **只影响这一屏什么时候把它移走，不影响数据**——`status` 那一刻就已经
   * 写进去了，服务端、别的客户端、别的视图一律按已完成算。
   */
  const LINGER_MS = 1200;
  const [lingerDone, setLingerDone] = useState<Set<string>>(new Set());
  const lingerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // 卸载时把还没到点的计时器清掉——不清的话它们会在组件没了之后调 setState。
  useEffect(() => () => {
    for (const h of lingerTimers.current.values()) clearTimeout(h);
    lingerTimers.current.clear();
  }, []);
  const startLinger = (id: string) => {
    const old = lingerTimers.current.get(id);
    if (old) clearTimeout(old);
    setLingerDone((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    lingerTimers.current.set(id, setTimeout(() => {
      lingerTimers.current.delete(id);
      setLingerDone((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, LINGER_MS));
  };

  const patchOne = (id: string, patch: Partial<Task>) => {
    // 勾完先留一会儿再让它走，见 startLinger。**在发请求之前就挂上**：请求
    // 回来之后 SSE 会立刻推一份新数据，那时候再挂就已经晚了一帧。
    if (patch.status === 'done') startLinger(id);
    const undo = undoDonePlan(tasks.find((t) => t.id === id), patch, tasks, now);
    guard(async () => {
      await api.patchTask(id, patch);
      if (!undo) return;
      const nextText = undo.nextDue ? dueChip(undo.nextDue, now)?.text ?? '' : '';
      // **提示里带上标题**：连着勾三条，屏幕上就是三条各带一个「撤销」的提示，
      // 光写「已完成」分不出哪条是哪条。六秒（默认三秒）：一个要人反应过来、
      // 伸手去点的按钮，三秒不够。
      void message.success({
        duration: 6,
        content: (
          <span className="ink-undo">
            {/* **连带改了什么就说什么。** 原来这里是一句「还连带改了别的」
                ——只交代了「有事发生」、不交代「发生了什么」，人读完还得自己
                去猜是哪一条被动了。现在重复的报「下次 9月1日」（日期用
                `dueChip` 拼，跟行上那颗到期 chip 同一套说法，不另发明第二种
                写法），子任务的报「连带做完了 3 条子任务」，父任务的报
                「「装修」也跟着完成了」。判据全在 `lib/undoDone.ts`。
                `partial` 为真时上面那几句一定至少有一句能说，所以括号里只剩
                「撤销只把这一条改回来」——那才是这句话真正要提醒的事。 */}
            已完成「{undo.title}」{nextText ? `，下次 ${nextText}` : ''}{undo.cascades.length > 0 ? `，${undo.cascades.join('，')}` : ''}{undo.partial ? '（撤销只把这一条改回来）' : ''}
            <button type="button" onClick={() => patchOne(id, undo.patch)}>撤销</button>
          </span>
        ),
      });
    });
  };

  /**
   * 「创建副本」（仿滴答清单）。**照抄内容，不照抄经历**——带什么、不带什么
   * 以及各自的理由都在 `lib/duplicate.ts`，那边还有一条结构性守卫盯着
   * 「`Task` 加了新字段这里必须做一次决定」（`estimateMinutes` 就是这么漏
   * 掉过的）。这里只剩发请求这一下。
   */
  const duplicateTask = (t: Task) => guard(() => api.addTask(duplicateDraft(t)));

  /**
   * 把一个检查事项转成真正的子任务（仿滴答清单「转为子任务」）。
   *
   * **先建再摘，不是先摘再建**：中间断了（离线、500）的两种结果不对等——
   * 先建的话最坏是同一句话既是子任务又还在检查事项里，看得见、删得掉；
   * 先摘的话最坏是那句话从此不存在了。判据（能不能转、转过去带什么）在
   * `lib/hierarchy.ts`，这里只管两次请求的顺序。
   */
  const promoteToChild = (t: Task, index: number) => guard(async () => {
    const p = promoteSubtask(t, index);
    if (!p) return;
    await api.addTask(p.child);
    await api.patchTask(t.id, { subtasks: p.rest });
  });

  /**
   * 标签改名 / 删除（仿滴答清单的标签管理）。标签不是一张表，它就是任务上的
   * 字符串（见 lib/tagTree.ts），所以这两件事都是**一批逐条不同的写**——
   * 走 `patchTasksEach` 一次请求发完，不是对每条任务各发一条 PATCH：
   * 那样十二条任务就是十二次读-改-写，理由跟「今天」的手动排序那条路由一样，
   * 写在 server/src/app.ts 的 `/api/tasks/reorder` 顶部。
   *
   * 改名之后**当前如果正站在这个标签的去处上，得跟着走**——不跟的话页面会
   * 停在一个已经不存在的 `tag:旧名` 上，显示「没有这个去处」，看起来像是
   * 改名把标签弄丢了。
   */
  const renameTag = (from: string, to: string) => guard(async () => {
    const patches = renameTagPatches(tasks, from, to);
    if (patches.length === 0) return;
    await api.patchTasksEach(patches);
    if (view === `tag:${from}`) navigate(`tag:${to.trim()}`);
    else if (view.startsWith(`tag:${from}${TAG_SEP}`)) {
      navigate(`tag:${to.trim()}${view.slice(`tag:${from}`.length)}`);
    }
  });

  /**
   * 删除要先问一句。**这一步没有垃圾箱兜底**——垃圾箱装的是任务，而这里删掉的
   * 是一种叫法：确认之后那十二条任务身上的这个标签就没了，只能一条条打回去。
   * 文案里写清「任务不会被删」：多数人看到「删除标签」的第一反应是怕连着
   * 那些任务一起删。
   */
  const askDeleteTag = (tag: string) => {
    const n = deleteTagPatches(tasks, tag).length;
    modal.confirm({
      title: `删掉标签「${tag}」？`,
      content: n === 0
        ? '现在没有任务打着这个标签，删掉只是让它从侧栏消失。'
        : `会从 ${n} 条任务上摘掉这个标签（连同它的子标签）。任务本身不会被删，只是不再有这个叫法——这一步没有垃圾箱兜底，想要回来得一条条重新打上。`,
      okText: '删掉标签',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => guard(async () => {
        const patches = deleteTagPatches(tasks, tag);
        if (patches.length > 0) await api.patchTasksEach(patches);
        // 正站在这个标签上的话，退回「全部」——不退的话页面停在一个已经
        // 不存在的去处上，看起来像是删标签把任务也删了。
        if (view === `tag:${tag}` || view.startsWith(`tag:${tag}${TAG_SEP}`)) navigate('all');
      }),
    });
  };

  /**
   * 删一份清单要先问一句。**里面的任务不会跟着删**——服务端会把它们的
   * `listId` 置空（见 server/src/app.ts 那条路由里的注释），文案必须把这句
   * 说出来：多数人看到「删除清单」的第一反应就是怕连着那一批任务一起没了。
   * 顺带指一下「归档」：想删清单的时刻多半只是「这份不用了、别再看见它」，
   * 那条路更轻，而且回得来。
   */
  const askDeleteList = (id: string) => {
    const l = lists.find((x) => x.id === id);
    const n = tasks.filter((t) => t.listId === id).length;
    modal.confirm({
      title: `删掉清单「${l?.name ?? ''}」？`,
      content: n === 0
        ? '这份清单里没有任务。只是不想再看见它的话，用「归档」更轻——归档的还能取消。'
        : `里面那 ${n} 条任务不会被删，只是不再属于任何清单。只是不想再看见它的话，用「归档」更轻——归档的还能取消。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => guard(async () => {
        await api.deleteList(id);
        if (view === `list:${id}`) navigate('all');
      }),
    });
  };

  /**
   * 删文件夹要先问一句。**里面的清单不会跟着删**——服务端会把它们的
   * `folderId` 置空、放回顶层（见 server/src/app.ts 那条路由）。文案必须把
   * 这句说出来，理由跟删清单那条一模一样：人看到「删除文件夹」第一反应是
   * 怕连着里面那几份清单、以及清单里的任务一起没了。
   */
  const askDeleteFolder = (id: string) => {
    const f = folders.find((x) => x.id === id);
    const n = lists.filter((l) => l.folderId === id).length;
    modal.confirm({
      title: `删掉文件夹「${f?.name ?? ''}」？`,
      content: n === 0
        ? '这个文件夹是空的，删掉只是让它从侧栏消失。'
        : `里面那 ${n} 份清单不会被删，会回到顶层——连同它们的任务，一条都不会少。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => guard(() => api.deleteFolder(id)),
    });
  };

  /**
   * 批量改状态 / 批量改期。**抽出来是因为现在有两个入口**：批量操作条上的
   * 控件，和键盘（`D` / `T` / `M` / `W`）。各写一份的话迟早出现「按钮那条
   * 会清空选中、键盘那条不会」这种只在一条路上成立的行为。
   *
   * 改状态是「一份 patch 套所有选中的」，改期是**逐条不同**的（每条保留自己
   * 原来的钟点、提醒跟着平移，见 lib/reschedule.ts），所以走的是两条不同的
   * 批量接口——这个区别不能合并掉。
   */
  const batchStatus = (status: Status) => {
    const ids = [...selectionRef.current.ids];
    /**
     * **批量标完成也给一次撤销。** 单条勾完有撤销（`patchOne`），而 `D` 一下可以
     * 把二十条标成完成、却一点退路都没有——**风险大的那一边反而没有兵器**。
     *
     * 跟单条那条规矩一样，**只认「完成」**：搁置/放弃是从下拉里挑出来的，
     * 是想过才点的；`D` 是一个按键。判据直接复用 `undoDonePlan`（连「还连带改了
     * 别的」那半句一起），不在这儿另写一份。
     */
    const plans = ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => t !== undefined)
      .map((t) => ({ id: t.id, plan: undoDonePlan(t, { status }, tasks, now) }))
      .filter((x): x is { id: string; plan: NonNullable<typeof x.plan> } => x.plan !== null);

    guard(async () => {
      await api.patchTasks(ids, { status });
      clearSelection();
      if (plans.length === 0) return;
      // 改回去是**逐条不同**的（各自回各自原来那个状态，不是一律 todo），
      // 所以走 `patchTasksEach`——跟批量改期同一个理由。
      void message.success({
        duration: 6,
        content: (
          <span className="ink-undo">
            {plans.length} 条标成了已完成
            {plans.some((x) => x.plan.partial) ? '（还连带改了别的，撤销只把这几条改回来）' : ''}
            <button
              type="button"
              onClick={() => guard(() => api.patchTasksEach(plans.map((x) => ({ id: x.id, patch: x.plan.patch }))))}
            >撤销</button>
          </span>
        ),
      });
    });
  };

  const batchReschedule = (to: RescheduleTo) => guard(async () => {
    const patches = [...selectionRef.current.ids]
      .map((id) => tasks.find((x) => x.id === id))
      .filter((t): t is Task => t !== undefined)
      .map((t) => ({ id: t.id, patch: reschedulePatch(t, to, now) }));
    if (patches.length === 0) return;
    await api.patchTasksEach(patches);
    clearSelection();
  });

  /**
   * 「已过期」那一组的组头上那颗「全部改到今天」（仿滴答清单：右键分组 →
   * 全部延期到今天）。
   *
   * 存在的理由是这个应用里没有「全选」：想把八条过期任务一起推到今天，得先
   * 点八下把它们一条条选中，才轮得到批量改期。而「已过期」正是最常被整组顺延
   * 的那一组——那八下点的全是同一个意思。
   *
   * **推的是屏幕上那几条**，不是「所有过期的」：调用方传进来的是筛选之后、
   * 组头计数所数的那一批（见 `withDeferAll` 挂进去的位置）。一颗按钮改掉几条
   * 看不见的任务，比没有这颗按钮糟得多。
   *
   * 逐条一份 patch（`patchTasksEach`），跟 `batchReschedule` 同一条：每条保留
   * 自己原来的钟点（**今天已经过了的那个钟点落当天 23:59**，不然推完还是过期
   * 的、这颗按钮等于什么都没做）、提醒跟着平移，判据都在 `lib/reschedule.ts`。
   */
  const deferAll = (overdue: Task[]) => guard(async () => {
    if (overdue.length === 0) return;
    await api.patchTasksEach(overdue.map((t) => ({ id: t.id, patch: reschedulePatch(t, 'today', now) })));
    void message.success(`${overdue.length} 条过期的改到了今天`);
  });

  /**
   * 命令面板里那一条：把**全部**过期的改到今天。
   *
   * 跟上面那颗按钮不是同一个范围：那颗在「接下来」的「已过期」组头上，
   * 推的是**屏幕上那几条**；这一条从哪个视图都叫得出来，推的是全表。
   * 「今天」里的过期任务跟今天要做的混在一排（那一排的顺序是他自己拖的，
   * 分不出一个组来，见 TodayView 里那段），而那正是最想整批顺建的时候。
   *
   * **要确认一句**，跟批量删除一样：改期把原来那些日期覆盖掉了，没地方
   * 找回来。批量操作条上的改期不问，是因为那条路已经要他**先选中、再从
   * 下拉里挑**两步；命令面板是模糊搜索命中、回车就跑的一步。同一条理由
   * 让「去掉截止时间」根本没进面板（见下面那段）——这一条用确认框换到了
   * 可以进来。
   */
  /** 全表里过期没做完的那几条。判据跟卡片上那个过期记号、底部「有 N 条已经
   *  过期了」那句提示同一个（`isTaskOverdue`），不另发明一份。 */
  const overdueAll = tasks.filter((t) => isTaskOverdue(t, now));

  const confirmDeferAllOverdue = (overdue: Task[]) => {
    modal.confirm({
      title: `把 ${overdue.length} 条过期的改到今天？`,
      // 「保留自己原来的钟点」**只在那个钟点今天还没到时成立**：已经过去的
      // 落当天 23:59（`lib/reschedule.ts` 的 ③），否则推完还是过期的，这颗
      // 按钮等于什么都没做。这句话原来只说了前半句。
      content: '每条保留自己原来的钟点（今天已经过了的落当天 23:59），提醒跟着平移。原来那几个日期没地方找回来。',
      okText: '改到今天',
      cancelText: '取消',
      onOk: () => deferAll(overdue),
    });
  };

  const withDeferAll = (sections: GridSection[]): GridSection[] => sections.map((s) => (
    // 空组不挂：那一组这时候整个不渲染，挂了也看不见，但 `s.tasks.length === 0`
    // 这一条要写出来——将来空组改成渲染成一句「没有过期的」，一颗点了什么都
    // 不会发生的按钮就会跟着冒出来。
    s.key !== 'overdue' || s.tasks.length === 0 ? s : {
      ...s,
      action: (
        <button type="button" className="ink-grid-action" onClick={() => deferAll(s.tasks)}>
          {/* 跟 TodayView 那颗同一个名字、同一条理由，见那里的注释。 */}
          全部改到今天
        </button>
      ),
    }
  ));

  const batchPostpone = (minutes: number) => guard(async () => {
    const patches = [...selectionRef.current.ids]
      .map((id) => tasks.find((x) => x.id === id))
      .filter((t): t is Task => t !== undefined)
      .map((t) => ({ id: t.id, patch: postponePatch(t, minutes) }))
      .filter((e): e is { id: string; patch: Partial<Task> } => e.patch !== null);
    // 选中的全都没有任何时间：说一句，不是静默什么都不做——「推迟」这三个字
    // 看起来一定会有效果，点了没反应跟坏了长得一样。
    if (patches.length === 0) {
      void message.info('选中的这些都没有截止时间或提醒，没有可以推迟的');
      return;
    }
    await api.patchTasksEach(patches);
    clearSelection();
  });

  // 预填什么由 `lib/composeDefaults.ts` 算——纯函数，判断挪出组件才测得动。
  const composeDefaults_ = composeDefaults(
    view,
    lists,
    settings ? {
      defaultListId: settings.defaultListId,
      defaultPriority: settings.defaultPriority,
      defaultDue: settings.defaultDue,
      defaultRemindMinutes: settings.defaultRemindMinutes,
      defaultTags: settings.defaultTags,
      smartDate: settings.smartDate,
      smartStripDate: settings.smartStripDate,
      smartTag: settings.smartTag,
      smartStripTag: settings.smartStripTag,
    } : null,
    composeDue,
    now,
  );

  /**
   * 建一条任务。**两个入口共用**：「新任务」那张表单和列表顶上那一行
   * `QuickAdd`——手挑字段是这里栽过 Critical 的地方（tags/priority 曾经被
   * 静默丢掉，见 App.test.tsx「新建任务时 TaskDraft 的字段不能被 App.tsx
   * 手挑漏掉」那组测试），一份就够，别为第二个入口再抄一遍。加新字段时记得
   * 这一行不会自动带上。
   *
   * firedAt 写 null 是对的——服务端会按时刻自己重算章，客户端发什么都不算数。
   */
  /**
   * 收件箱里那条原话**直接变成一条任务**，不劳烦 AI（仿滴答清单：它那边收件箱
   * 里躺的本来就是任务）。
   *
   * 草稿怎么拼跟列表顶上那条「添加任务」**共用同一份** `smartDraft`——标题里的
   * 日期/标签/重复照样认，设置里的「任务默认值」照样落。两处各写一份的话，
   * 同一句话从两个入口进来会建出两条不一样的任务。
   *
   * 建完把这条收件箱记录标成已处理、并记下它拆出了哪条任务（`taskIds`）——
   * 跟 AI 拆解那条路留下的痕迹是同一种，「已拆解」那个折叠面板里点得进去。
   *
   * `view` 传 `'inbox'`：`composeDefaults` 认的「站在某个清单/标签里就归进去」
   * 那两支在这儿都不成立，收件箱不是任何一个清单的上下文。
   */
  const makeTaskFromInbox = (id: string, opts?: { later?: boolean }) => {
    const item = inbox.find((x) => x.id === id);
    if (!item) return;
    guard(async () => {
      const defaults = composeDefaults('inbox', lists, settings, null, now);
      // **第一行当标题，剩下的整段进备注。**
      //
      // 随手记是个多行框，提示语就写着「想到什么写什么，不用整理」——一段
      // 五行的脑内倒倒是它邀请的结果，不是意外。而任务的标题是一行：整段塞
      // 进 `title`，卡片上就是一条被压成一行、长到读不下去的标题，而备注是空的。
      //
      // AI 拆解那条路不会撞上这个（它本来就把一段拆成几条），**只有手动这条会**。
      //
      // 智能识别只喂第一行：埋在备注里的一个「明天」不该把整条任务的截止时间
      // 定到明天——那句话是背景，不是安排。
      const { head, body } = splitCapture(item.text);
      const built = smartDraft(head, defaults, now, { presetToRemindAt });
      if (!built.title) return;
      // `later`：直接建成搁置（GTD 的「将来也许」）。**建的时候就写，不是建完再发
      // 一条 PATCH 改状态**：后者中间那一下它真的以「待办」落了盘，会闪进「全部」、
      // 进得了徒教徒法、也可能卡在两次请求之间——而他刚刚表达的意思恰恰是「现在不做」。
      const task = await createTask({ ...emptyDraft(), ...built, notes: body }, opts?.later ? 'later' : undefined);
      await api.patchInbox(id, { processed: true, taskIds: [task.id] });
      // 两句话分开说：一条直接搁置的任务**不会出现在「今天」「接下来」里**，
      // 报一句「已变成任务」会让人去那几屏里找它，而那几屏里没有。
      void message.success(opts?.later ? `已存成「以后再说」：${built.title}` : `已变成任务：${built.title}`);
    });
  };

  /**
   * `status` 单独一个参数，不是 `TaskDraft` 的字段——那份草稿**刻意不含 status**
   * （见 TaskFields.tsx `TaskDraft` 顶上那段：状态由卡片上的流转按钮走，不是填
   * 出来的）。不给就是服务端 `newTask()` 的 'todo'，跟以前一样。
   */
  const createTask = (d: TaskDraft, status?: Status) => api.addTask({
    ...(status ? { status } : {}),
    title: d.title, notes: d.notes, due: d.due, startAt: d.startAt, endAt: d.endAt, persistentReminder: d.persistentReminder, priority: d.priority, tags: d.tags, listId: d.listId, section: d.section,
    repeat: d.repeat, parentId: d.parentId, estimateMinutes: d.estimateMinutes,
    habit: canBeHabit(d.repeat) ? d.habit : false,
    waitingFor: d.waitingFor,
    context: d.context,
    reminders: d.reminders.map((at) => ({ at, firedAt: null })),
  });

  // 批量删除的确认框——BatchBar 的删除按钮、命令面板里的「删除选中的 N 条」
  // 和 Del 键三处共用这一个函数，不是各写一份文案：见 2026-08-17-selection.md
  // 设计⑤「不能一个说『删了找不回来』另一个说『可还原』」。文案照抄
  // TaskCard.tsx 单条删除那句的说法（先进垃圾箱、能还原、搁置更轻，
  // 见那边 modal.confirm 上面的注释），只是把「这条」换成「选中的 N 条」，
  // 「搁置」也从「用『搁置』更轻」换成「批量改成『搁置』更轻」——批量操作条
  // 本来就有「改状态」这个入口，提醒的是同一件事。
  //
  // 读 selectionRef.current 而不是闭包里的 selection：这个函数会被存进
  // JSX props（BatchBar.onDelete、命令面板 command.run）里，也会被上面
  // keydown 那个 useEffect 的处理器调用——后者的依赖数组是 [view,
  // paletteOpen]，不含 selection，直接读 selection 会读到订阅那一刻的旧值。
  //
  // 不在这里再判断一遍「一条都没选就别弹」：三个调用点各自已经保证了
  // 「选中为空时压根碰不到这个函数」——BatchBar 的删除按钮在 count===0 时
  // 组件自己返回 null（BatchBar.tsx），命令面板的那条命令只在
  // selection.ids.size > 0 时才会被 spread 进 commands 数组（见下面），
  // 上面 keydown 的 'delete' 分支也有同样的判断。写第四道形同虚设的判断
  // 只会是一段没有任何调用路径能碰到、因此也没有任何测试能证明它真的在
  // 挡什么的死代码——见 task-4-report「confirmBatchDelete 的空选中判断」
  // 一节，那道判断原来在这里，写变异测试的时候发现它测不出来，才确认是
  // 多余的，删掉了。
  const confirmBatchDelete = () => {
    const ids = [...selectionRef.current.ids];
    modal.confirm({
      // 文案跟单条那句同一份（lib/deleteConfirm.ts），只差「搁置」怎么点。
      ...deleteManyConfirm(ids, tasks),
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => guard(async () => {
        await api.deleteTasks(ids);
        clearSelection();
      }),
    });
  };

  // 手动排序：TodayView 传来的 pairs 已经是「整份可见列表 + 新 order」
  // （见 taskView.ts 的 applyMove，下标本身就是 order），这里原样转成
  // ids 数组发给批量端点 PATCH /api/tasks/reorder——一次请求、服务端一次
  // 读一次写，不是给每张可见的卡各发一条 patchTask：那样 N 条并发 PATCH
  // 会把只有一份的 tasks.json.bak 冲成重排到一半的中间态，也会把没挪动的
  // 邻居一起刷新 updatedAt，见 server/src/app.ts 这条路由顶部的注释。
  // 不经 guard()——跟 onEditTask 同一个考量：调用方（TodayView）要自己
  // await 到结果，失败了得把这件事播报给键盘用户听/看到，不能被 guard
  // 吞掉只弹一条消失得很快的提示。
  const onReorder = (pairs: Array<{ id: string; order: number }>) =>
    api.reorderTasks(pairs.map((p) => p.id));

  // 接受/忽略都不经 guard()——ProposalNote 要自己 await 到结果：失败时得把
  // 按钮的 loading 收回来、把错误说出来，被 guard 吞掉的话按钮会一直转。
  // 成功之后不动本地状态：proposals.json 变化 → watcher → SSE → refetch，
  // 那条提议自然从列表里消失。一条更新路径。
  // 接受之后必须说一声。典型的建议就是改期，而改期会把这张卡从「今天」的
  // 成员资格里踢出去——SSE 一刷新，卡片和提议一起消失，什么提示都没有：
  // 跟「删掉了」「点了没反应」长得一模一样。TaskComposer 专门写了 report()
  // 防这一类，接受这条路当时漏了。
  const proposalWiring = {
    byTask: groupProposals(proposals),
    onAccept: async (id: string) => {
      const t = await api.acceptProposal(id);
      const gone = view === 'today' && !isInTodayView(t, now);
      // 服务端把「任务改了、但建议没能从文件里清掉」降级成了一句 warning
      // 带回来（见 POST /api/proposals/:id/accept）——改动是真生效了，
      // 不能报成失败，但也不能装作干干净净。
      const w = (t as Task & { warning?: string }).warning;
      if (w) void message.warning(w);
      else void message.success(gone ? '已接受。时间改到了今天之后，这条不在「今天」里了' : '已接受');
      return t;
    },
    onDismiss: async (id: string) => {
      await api.dismissProposal(id);
      // 说清「不会再提了」——忽略是打墓碑，同一条建议下一轮回顾不会原样再来。
      // 这件事人看不见（文件里的 dismissed 标记），但它正是「忽略」值不值得点
      // 的关键：不说的话，他会以为跟以前一样，下次还得再点一遍。
      void message.success('已忽略。这条不会再提了');
    },
  };

  // 七个 TaskGrid（search/upcoming/kanban/quadrant/all/done/scoped）+
  // CalendarView 共用的接线。分开写的话，以后改一处回调要记得改每一处——
  // 而漏掉的那一处不会有任何东西报错，只会在某一个视图上静默失灵，这也是
  // 为什么批量操作的 selection/onSelectionChange/editRequestId/
  // onEditRequestHandled 这四个字段也放在这一份共用对象里，不是每个视图
  // 各写一遍——那样漏接一处不会报错，只会在那一个视图上选不中卡片，
  // 是这批改动最容易埋下的那类静默失灵。
  /**
   * 详情面板里那一条，每次渲染现查——见 `detailId` 的注释。
   *
   * **查不到就是 `null`，那一栏整个不渲染，不用另外写一个"清掉 id"的
   * effect。** 查不到只有一种来路：这条任务被删了（面板里那颗「删除」，或者
   * 别处删的、SSE 推过来）。那正好就是「面板该收起来」，而删掉的任务不会再
   * 回来，那个 id 留在 state 里不会让它凭空复活；下次打开别的任务就把它盖掉
   * 了。多一个 effect 只是多一次渲染和一处能写错的顺序。
   */
  const detailTask = detail ? tasks.find((t) => t.id === detail.id) ?? null : null;

  /**
   * 一张 `TaskCard` 要的那一整套接线。**拆出来是因为详情面板也要同一份**
   * （`TaskDetail` 里渲染的就是 `TaskCard`）——两处各写一份的话，下一个新
   * prop 只会被接上其中一处，而漏掉的那一处不会有任何东西报错，跟
   * `App.tsx` 那行手挑字段的 `createTask` 是同一类账。
   */
  const cardWiring = {
    now,
    onPatch: patchOne,
    // 编辑态保存不经 guard()：失败必须让卡片自己 await 到，把编辑框和草稿留着，
    // 不能被 guard 吞掉。跟 InboxSidebar 的 onEditText 同一个道理。
    onEditTask: (id: string, patch: Partial<Task>) => api.patchTask(id, patch),
    onDelete: (id: string) => guard(() => api.deleteTask(id)),
    proposals: proposalWiring,
    lists,
    // 多级任务那两个记号要看全表（这条的父亲叫什么、名下有几个孩子），
    // 「创建副本」要发请求——两个都只是转交给每张 TaskCard，见那边的注释。
    allTasks: tasks,
    onDuplicate: duplicateTask,
    onPromoteSubtask: promoteToChild,
    onSkip: (id: string) => guard(() => api.skipTask(id)),
    // 番茄钟一轮的时长——转交给每张 TaskCard，见 TaskCard.tsx CardProps
    // 的注释。「今天」「按来源」两个视图不用 gridWiring，各自的 render 调用
    // 下面单独传一次，见 today/source 两条。
    focusMinutes: settings?.focusMinutes,
    breakMinutes: settings?.breakMinutes,
    // 离线记号——转交给每张 TaskCard 再转交给 Attachments，见那两处的注释。
    // 同一个理由，「今天」「按来源」不用 gridWiring，各自的 render 调用下面
    // 单独传一次。
    offline,
  };

  /** 上面那一份，加上只有网格才有的四个（选中、'E' 键的落点）。 */
  const gridWiring = {
    ...cardWiring,
    // 刚勾完的那几条先别移走，见 startLinger。挂在 gridWiring 上而不是逐个
    // 视图传：所有走 TaskGrid 的去处都该是同一个手感。
    linger: lingerDone,
    // 点一条任务打开右边那一栏，而不是让那一行当场膨胀成一张卡。判据和理由
    // 在 TaskDetail.tsx 顶部；TaskGrid 收到这个 prop 才会改行为，没收到就是
    // 原来那样（就地展开），见那边 Props.onOpenDetail 的注释。
    onOpenDetail: openDetail,
    // 列表里那一行要标出来是哪条被打开了，见 TaskRow.current。
    openDetailId: detail?.id ?? null,
    // 批量操作的地基（见 2026-08-17-selection.md Task 4）——两个都给，
    // TaskGrid 才会接选中 UI，见 TaskGrid.tsx Props.selection 的注释。
    // 「今天」「按来源」两个视图不用 gridWiring（各自手写 props，见下面
    // registry 里 today/source 两条），没有勾选框/批量条，跟这批「只做
    // TaskGrid」的范围一致。
    selection,
    onSelectionChange: setSelection,
    editRequestId: editRequest,
    onEditRequestHandled: () => setEditRequest(null),
  };

  // 搜索结果集。放在 buildRegistry 之前——search 视图的 render 闭包要用它。
  const hits = searchTasks(tasks, query);

  // 标签全集，命令面板和筛选栏共用同一份——见 allTags 定义处的注释「两处
  // 标签全集的口径必须一致」，这里加了筛选栏之后是第三处引用，同样不重写。
  const tagList = allTags(tasks);

  // 筛选叠在视图之上——先按视图取候选，再用这份 SmartFilter 收窄，见
  // task-3-brief 要点①。这里算一次匹配 id 集合，七个 TaskGrid 接线点、
  // scoped 回退分支、日历共用同一份，不各自重复调用 applyFilter：
  // applyFilter 的每一维都是纯粹按单条任务自己的字段判断（不比较任务和
  // 任务之间的关系，text 那维复用的 searchTasks 也是同一个性质），一条
  // 任务在不在 applyFilter(tasks, filter, now) 的结果里，只取决于它自己，
  // 跟数组里还有哪些别的任务无关——所以在全量 tasks 上算一次，再拿 id 去
  // 跟每个视图自己的候选集合取交集，结果跟「每个视图各自调一遍
  // applyFilter」完全一样，不是抄近路抄出别的答案。空筛选时是 null（不是
  // 空 Set）：filterSections/withFilterBar 见到 null 就整段跳过，不用对着
  // 全部任务空跑一次 applyFilter。
  const filterMatchedIds = isFilterEmpty(filter) ? null : new Set(applyFilter(tasks, filter, now).map((t) => t.id));

  // 视图自己算出的候选分组（GridSection[]）上再叠一层筛选——正在编辑的卡
  // 即使被筛掉也留着，不然筛选栏一变，编辑到一半的卡会连草稿一起从屏幕上
  // 消失。跟 scopedSections 的 keep 参数、quadrantCells 等既有的 editing
  // 参数是同一条规矩，见 TaskGrid.tsx Props.sections 顶部那段长注释。
  const filterSections = (sections: GridSection[], editing: Set<string>): GridSection[] => {
    if (filterMatchedIds === null) return sections;
    return sections.map((s) => ({
      ...s,
      tasks: s.tasks.filter((t) => filterMatchedIds.has(t.id) || editing.has(t.id)),
    }));
  };

  // FilterBar 的「存成智能清单」按钮只在筛选非空时可点（组件自己挡，见
  // FilterBar.tsx onSaveAsList 那段注释），点了之后开这个弹窗问名字——不
  // 自动生成，见上面 savingList 那组 state 的注释。openSaveAsList 原样传给
  // 下面 withFilterBar 和 calendar 分支两处 FilterBar，跟 gridWiring 同一个
  // 「一处写、多处展开」的思路，不在每个视图分支里各写一份。
  const openSaveAsList = () => {
    setListNameDraft('');
    setSavingList(true);
  };

  /**
   * 保存改好的筛选条件。**只发 `filter` 这一个字段**——名字、颜色、位置、
   * 归档与否都不该被「改了个筛选档位」顺手动一下。
   */
  const submitEditFilter = async () => {
    const l = editingFilterList;
    if (!l || isFilterEmpty(filterDraft)) return;
    setFilterSaveBusy(true);
    try {
      // filter 一字不改地发过去：`PATCH /api/lists/:id` 的 sanitizeSmartFilter
      // 校验得比这里能写的严，不在这儿重复一份——跟「存成智能清单」同一条。
      await api.patchList(l.id, { filter: filterDraft });
      setEditingFilterList(null);
    } catch (e) {
      // 失败时弹窗留着、草稿不清——跟 submitSaveAsList 同一条教训：
      // 被 guard() 吞掉的话弹窗会关上，刚调好的那几个档位一起没了。
      void message.error((e as Error).message);
    } finally {
      setFilterSaveBusy(false);
    }
  };

  const submitSaveAsList = async () => {
    const name = listNameDraft.trim();
    // OK 按钮已经 disabled（见下面 Modal 的 okButtonProps），但那道防线只挡
    // 得住点 OK 按钮这一条路——<Input onPressEnter> 不看 OK 按钮的
    // disabled，回车这条路上这一行是唯一一道防线，不是「第二道」，见
    // final-review.md I3。
    if (!name) return;
    setListSaveBusy(true);
    try {
      // 颜色跟 Sidebar「新建清单」同一个轮转指针（LIST_COLORS[lists.length %
      // ...]）——智能清单和普通清单共用同一份颜色池，不用另起一套。filter
      // 一字不改地带上当前筛选：POST /api/lists 的 sanitizeSmartFilter 校验
      // 得比这里能写的严（连嵌套结构、未知键都挡），这里不重复一份，见
      // task-4-brief 要点①。
      await api.addList(name, LIST_COLORS[lists.length % LIST_COLORS.length].hex, filter);
      // 不手动往 lists 里塞一条——data-changed → reload('lists') 会把它带来，
      // 跟别处「写操作之后不手动刷新状态」（见上面 guard() 定义处的注释）
      // 同一条规矩，导航上会自己冒出来。
      setSavingList(false);
    } catch (e) {
      // 失败时弹窗留着、草稿不清——跟 TaskComposer 的 submit() 同一条教训。
      void message.error((e as Error).message);
    } finally {
      setListSaveBusy(false);
    }
  };

  // 筛选栏 + 筛选收窄过的 sections 的公共外壳——task-3-brief 要点①点名的
  // 「八处接线点」，这批同样容易漏，用一个共用函数逐处套，结构上没法漏接：
  // 忘了套的那个视图不会显示筛选栏、也不会被收窄，跟上面 gridWiring「一处
  // 写、多处展开」是同一个思路，别在每个视图分支里各自手写一份。
  //
  // buildRaw 是这个视图自己的候选分组函数，签名跟直接喂给 TaskGrid.sections
  // 的那个函数一样（参数是「哪些卡正在编辑」）。这里额外调一次
  // buildRaw(new Set()) 只是为了算「N / M 条」这两个显示数字：真正喂给
  // TaskGrid 的那次调用在 renderGrid 拿到的函数里，会在 TaskGrid 自己渲染
  // 时才执行，用的是 TaskGrid 内部真正的 editingIds——跟下面 scoped 分支
  // 判断「这个 key 归不归 scopedSections 管」时先用空 Set 探一次路、真正
  // 渲染再用 editingIds 精算一遍是同一个套路，不是多余的重复调用。
  /**
   * 新任务表单。开它的是加任务行右端那颗 ⌄（也可以是 `C` 键、命令面板）。
   *
   * **它必须紧挨着那一行渲染。** 原来它固定画在视图标题正下方——那是「新任务」
   * 按钮还在标题栏右上角的年代，表单从按钮底下展开是对的。那颗按钮删掉之后
   * 触发点挪到了加任务行的**右端**，而表单还留在原地，于是点一下行末尾的
   * ⌄，一张表单在那一行**上面**冒出来，加任务行被推到表单底下——点这儿、
   * 那儿弹出来，看着像是点错了什么。
   */
  const composerNode = composing ? (
    <TaskComposer
      view={view}
      boardFilter={boardFilter}
      now={now}
      lists={lists}
      // 任务默认值（仿滴答清单）。`settings` 是 `Settings | null`——没读到就
      // 整个不传，让表单什么都不预填，不在这里编一份默认值出来（跟
      // SettingsModal 收 null 同一条道理）。
      defaults={composeDefaults_}
      // 能挂到哪条任务下面。新任务还没有 id，`parentCandidates` 的第一个参数
      // 传 null——排除「自己」那一条对它不适用。
      parentOptions={parentCandidates(tasks, null).map((t) => ({ id: t.id, title: t.title }))}
      sectionOptions={sectionNames(tasks)}
      onClose={() => { setComposing(false); setComposeDue(null); }}
      onCreate={createTask}
    />
  ) : null;

  // 列表顶上那一行（仿滴答清单）。**一个节点、两个位置**，见 QUICKADD_AT_TOP。
  // 跟新任务表单共用 createTask 和 composeDefaults_，理由见 QuickAdd.tsx。
  // 表单跟在这一行**后面**——它是从这一行右端那颗 ⌄ 展开出来的。
  const quickAdd = canQuickAdd(view) ? (
    <>
      <QuickAdd
        onCreate={createTask}
        view={view}
        boardFilter={boardFilter}
        now={now}
        defaults={composeDefaults_}
        // 「今天」的行左边常驻一段抓手位（那个视图能拖着排序），这一行跟着让
        // 一样多才对得齐——判据和度量在 QuickAdd 的 `indent` 上。
        indent={view === 'today'}
        // 下面那片东西铺不铺满整列——铺满了这一行也得铺满，不然右边界对不齐
        // （度量在 QuickAdd 的 `wide`）。`source`（按来源）单列出来是因为它
        // **不在 `DENSITY_VIEWS` 里**：那一屏是瀑布流、没有密度开关，不管全局
        // 密度是什么，它下面永远是铺满整列的那一档。
        wide={view === 'source' || density !== 'row'}
        onOpenForm={openCompose}
      />
      {composerNode}
    </>
  ) : null;

  const withFilterBar = (
    buildRaw: (editing: Set<string>) => GridSection[],
    /**
     * `emptyFiltered` 是「筛选把东西全挡掉了」时该说的那句，没被挡掉时是
     * `undefined`——调用方原样交给 `TaskGrid` 的同名 prop（那边只有真的渲染
     * 成空的时候才用它，见那个 prop 的注释）。
     */
    renderGrid: (
      sections: (editing: Set<string>) => GridSection[],
      emptyFiltered?: string,
    ) => ReactNode,
    // 分组/排序那一条只给**平铺列表**那几个去处开（全部/已完成/搜索/清单/
    // 标签）。不给「今天」（顺序是他拖出来的）、「接下来」（本来就按时间分好
    // 组了）、看板/四象限/日历（格子本身就是分组轴）——理由写在
    // lib/grouping.ts 顶部。默认不开，忘了传的视图行为一个字不变。
    { groupable = false }: { groupable?: boolean } = {},
  ) => {
    const shape = (secs: GridSection[]) => (groupable ? regroupSections(secs, groupSort, { lists, now }) : secs);

    /**
     * 同一批任务摆成看板的那几列。**「看板」是清单的显示方式，不是一个去处**
     * ——理由整段在 lib/listMode.ts。这里把这一屏本来要竖着列的那些任务摊平，
     * 再按当前的分组轴重新分列，所以「工作这个清单按状态分列看看」「搜索结果
     * 按优先级分列看看」这些用法就地成立，不用先跳去一个固定看全部任务的去处。
     *
     * `flatMap` 之前先过一遍 `filterSections`：筛选栏是叠在视图之上的一层
     * （task-3-brief 要点①），列表模式受它管，看板没有理由不受。
     */
    const boardCells = (editing: Set<string>) => {
      const flat = filterSections(buildRaw(editing), editing).flatMap((sec) => sec.tasks);
      // `status` 那根轴走 kanbanCells：四列**固定顺序、空列也在**，而且
      // 「status 是脏值」的兜底就写在那儿；别的轴走通用分组，keepEmpty 让空列
      // 也留着（能往里拖）。这两句是从原来那个独立看板视图整段搬过来的。
      return kanbanAxis === 'status'
        ? kanbanCells(flat, now)
        : regroupSections(
          [{ key: 'all', title: '', tasks: flat }],
          { groupBy: kanbanAxis, sortBy: groupSort.sortBy, desc: groupSort.desc },
          { lists, now, keepEmpty: true },
        );
    };
    const raw = buildRaw(new Set());
    // 「N / M 条」两个数字在**分组之前**算：分组只是把同一批任务换个摆法，
    // 不增不减，拿分组后的结果去数只会因为空组被滤掉而白绕一圈。
    const total = raw.reduce((n, s) => n + s.tasks.length, 0);
    const matched = filterMatchedIds === null
      ? total
      : raw.reduce((n, s) => n + s.tasks.filter((t) => filterMatchedIds.has(t.id)).length, 0);

    // **看板模式**：同一屏、同一批任务，换个摆法。筛选栏照旧在最上面（它是
    // 叠在视图之上的一层），底下那条分组轴下拉替掉「分组/排序」——看板列内的
    // 顺序不是这个模式的重点，摆三个控件在几列之上太重。
    if (groupable && listMode === 'board') {
      return (
        <>
          <FilterBar
            filter={filter}
            onChange={setFilter}
            lists={lists}
            allTags={tagList}
            matched={matched}
            total={total}
            onSaveAsList={openSaveAsList}
          />
          <div className="ink-groupsort-bar" role="group" aria-label="看板分组">
            <select
              className="ink-groupsort-select"
              aria-label="看板按什么分列"
              value={kanbanAxis}
              onChange={(e) => changeKanbanAxis(e.target.value as KanbanAxis)}
            >
              {KANBAN_AXES.map((a) => <option key={a} value={a}>{GROUP_LABEL[a]}</option>)}
            </select>
          </div>
          <TaskGrid
            {...gridWiring}
            layout="cells"
            keepEmpty
            // 固定行档 + 紧凑：一列只有 217px，到期 chip/标签这些不换行的元
            // 数据会把标题挤没，见 TaskGrid.tsx Props.compact。跨列拖拽走的是
            // 行/卡共用的同一份 dragWiring，行档一样拖得动。
            density="row"
            compact
            sections={boardCells}
            // 落进哪一列就改哪个字段——轴换了，拖拽的含义跟着换。判据在
            // lib/grouping.ts 的 cellPatch；它返回 null 表示这一列没有对应的
            // 值可写（「已过期」「7 天内」「没有标签」这几格），那种情况不发
            // 请求，跟四象限横轴那条既有约定一样。
            onDropTo={(id, key) => {
              const t = tasks.find((x) => x.id === id);
              if (!t) return;
              const patch = kanbanAxis === 'status'
                ? { status: key as Status }
                : cellPatch(kanbanAxis, key, t, now);
              if (patch) gridWiring.onPatch(id, patch);
            }}
            empty={EMPTY_NO_TASKS}
            emptyFiltered={matched === 0 && total > 0 ? `这 ${total} 条都被筛选挡住了——清掉筛选就看得到` : undefined}
          />
        </>
      );
    }
    return (
      <>
        <FilterBar
          filter={filter}
          onChange={setFilter}
          lists={lists}
          allTags={tagList}
          matched={matched}
          total={total}
          onSaveAsList={openSaveAsList}
        />
        {/* `view` 得传：「默认」是按去处算的，见 GroupSortBar 的 `view` 那段。 */}
        {groupable && <GroupSortBar view={view} value={groupSort} onChange={changeGroupSort} />}
        {!QUICKADD_AT_TOP.has(view) && quickAdd}
        {/* 本来有东西、筛完一条不剩：把空状态那句话换掉。「一条任务都没有」
            在这时候是一句假话——你有 N 条，只是这个筛选一条都没匹配上，而这
            句话还刚好长得像「数据没了」。 */}
        {renderGrid(
          (editing) => shape(filterSections(buildRaw(editing), editing)),
          matched === 0 && total > 0 ? `这 ${total} 条都被筛选挡住了——清掉筛选就看得到` : undefined,
        )}
      </>
    );
  };

  // 渲染函数在这里注入而不是写进 lib/views.tsx：它们要用 guard/api 这些绑在
  // App 上的东西，塞进那张静态表会让那个模块反过来依赖 App。
  const registry = buildRegistry({
    search: () => withFilterBar(
      (editing) => [{
        key: 'hits',
        title: `“${query.trim()}”`,
        // 正在编辑的卡留下：编辑到一半把标题里那个词删掉，卡不该当场消失
        //
        // **排一遍序**：`searchTasks` 是在 `tasks` 上 filter 出来的，保留的是
        // 传进去那份的先后——而那是服务端读目录的顺序（文件名是 uuid，等于
        // 随机）。搜出八条，最急的那条可能排在第五。别的每个平铺列表都走
        // `sortByUrgency`（「全部」「清单」「标签」），搜索结果没有理由例外。
        // 这个视图是 groupable 的，但 `sortBy: 'default'` 档沿用的正是这里交
        // 出去的顺序，所以得在这儿排。
        tasks: sortByUrgency(tasks.filter((t) => editing.has(t.id) || hits.includes(t)), now),
      }],
      (sections, emptyFiltered) => (
        <>
          {/* 匹配到的清单/标签（仿滴答清单搜索页的三个类型）。摆在任务列表
              **上面**：它们是「跳过去」，任务是「就在这儿看」，前者是更短的
              那条路，藏在一屏任务下面等于没有。 */}
          <SearchJumps
            lists={searchLists(lists, query)}
            tags={searchTags(tagList, query)}
            onOpen={navigate}
          />
          {/* **一条任务都没有的时候，「没有匹配的任务」是句误导。** 真实原因不是
              「你搜的词没命中」，是「这个实例里压根没有东西可搜」——而这两种情况
              该说的下一步完全不同：前者改个词再搜，后者先去建一条任务。空实例上
              实测过：这一屏只剩那五个字，既不解释也不给出路，是全应用唯一一处
              「只有断言、没有下一步」的空状态。
              分档照「未归类」那处的现成做法（见下面 `nolist`）：真的还没有 →
              `EMPTY_NO_TASKS`；有任务、只是没搜着 → 说清是没命中，并提示换个词。 */}
          <TaskGrid
            {...gridWiring}
            density={density}
            sections={sections}
            empty={tasks.length === 0 ? EMPTY_NO_TASKS : '没有匹配的任务。换个词试试——标题、备注、标签、子任务都会搜。'}
            emptyFiltered={emptyFiltered}
          />
        </>
      ),
      { groupable: true },
    ),
    inbox: () => (
      <InboxSidebar
        items={inbox}
        now={now}
        onDelete={(id) => guard(() => api.deleteInbox(id))}
        // **不经 guard()**：失败必须让 RedoButton 自己 await 到，把他刚打的那句
        // 要求留在框里——跟下面 onEditText 是同一条理由。成功那句话在这儿说，
        // 因为 `trashed` / `started` 两个数只有这一层拿得到。
        onRedo={async (id, note) => {
          const r = await api.redoInbox(id, note);
          const moved = r.trashed > 0 ? `上一轮的 ${r.trashed} 条已经移进垃圾箱，` : '';
          // `started: false` = 单飞锁挡住了（正有一次拆解或回顾在跑）。前三件事
          // 都已经落盘了，不能说成失败，但也不能说「正在重新拆解」——那是假话。
          void message[r.started ? 'success' : 'warning'](r.started
            ? `${moved}AI 正在重新拆解`
            : `${moved}这条已经翻回未处理；有一次 AI 正在跑，等它结束后再拆一次`);
        }}
        onMakeTask={makeTaskFromInbox}
        // 编辑态保存专用，不经 guard()：失败必须让 InboxRow 自己 await 到，
        // 把编辑框和草稿留着，不能被 guard 吞掉。
        onEditText={(id, text) => api.patchInbox(id, { text })}
        onExpand={() => guard(() => api.expand())}
        expanding={agent?.state === 'running'}
      />
    ),
    today: () => (
      <>
        {/* 「推荐任务」（仿滴答清单「今天」右上角那颗灯泡）。摆在列表**上面**
            而不是下面：「今天」空的时候那句「今天没有要做的」就是这一屏的
            全部内容，把「那接下来干什么」压在它下面等于藏起来。默认收起，
            没有推荐时整个组件返回 null，见 SuggestPanel.tsx。 */}
        <SuggestPanel tasks={tasks} now={now} onPatch={patchOne} onOpen={openTask} />
        <TodayView
          proposals={proposalWiring}
          // 每周那种习惯的「本周 N/M」跟日历那七列、专注统计的「本周」
          // 读同一个设置。
          weekStart={settings?.weekStart ?? 1}
          // 勾完先留一会儿再落到「今天完成的」那一节，见 startLinger。
          // 「今天」不走 gridWiring（它自己手写一套 props），所以这里单挂一次。
          linger={lingerDone}
          tasks={tasks}
          now={now}
          lists={lists}
          density={density}
          onPatch={patchOne}
          onEditTask={(id, patch) => api.patchTask(id, patch)}
          onDelete={(id) => guard(() => api.deleteTask(id))}
          onDuplicate={duplicateTask}
          onSkip={cardWiring.onSkip}
          onPromoteSubtask={cardWiring.onPromoteSubtask}
          onReorder={onReorder}
          focusMinutes={settings?.focusMinutes}
          breakMinutes={settings?.breakMinutes}
          offline={offline}
          // 点一条任务打开右边那一栏，不让那一行当场膨胀成一张卡——跟七个
          // TaskGrid 视图同一个 prop、同一份理由，见 TaskDetail.tsx 顶部。
          // 这个视图不用 gridWiring（手写 props），所以单独接一次。
          onOpenDetail={openDetail}
          openDetailId={detail?.id ?? null}
          // 批量操作的地基。**这个视图原来是唯一不能多选的**——而它恰恰是最
          // 常用的那个：「把今天这五条一起推到明天」是最典型的批量需求，
          // `D`/`T`/`M`/`W`/`Delete` 那一整套快捷键也跟着够不着（它们全都
          // 作用在选中集合上）。当初的范围是「只做 TaskGrid」，两个手写
          // props 的视图就这么落在了外面，见 gridWiring 那段注释。
          selection={selection}
          onSelectionChange={setSelection}
          // 上面那行刚报完「12 条（9 条已过期）」——**看见了债，却没有就地还债
          // 的地方**：这个动作原来只在命令面板和「接下来」的组头上有，而「今天」
          // 才是最常看见这个数字的地方。范围是屏幕上那几条，跟组头那颗一致。
          onDeferOverdue={confirmDeferAllOverdue}
        />
      </>
    ),
    upcoming: () => withFilterBar(
      (editing) => agendaSections(tasks, now, editing),
      // 「全部改到今天」挂在 `sections()` 外面、不是挂在上面那个 buildRaw 里：
      // 筛选是 withFilterBar 在 buildRaw **之后**叠的（filterSections），挂在
      // 里面的话那颗按钮拿到的是筛选前那一批，会去改几条屏幕上看不见的任务。
      (sections, emptyFiltered) => (
        <TaskGrid
          {...gridWiring}
          density={density}
          sections={(editing) => withDeferAll(sections(editing))}
          empty="还没有排上日子的任务。给一条任务加个日期，它就会出现在这儿。"
          emptyFiltered={emptyFiltered}
        />
      ),
    ),
    // {...gridWiring} 带上 now/onPatch/onEditTask/onDelete/proposals/lists——
    // 拖拽改期也走这同一个 onPatch，CalendarView 内部只是把拖拽发来的
    // (任务 id, 目标日期) 换算成 due 之后照样调这一个 prop，不是另开一条
    // 写路径。跟 upcoming/kanban/quadrant/all/done 同一个写法。
    //
    // selection/onSelectionChange/editRequestId/onEditRequestHandled 这四个
    // 批量操作相关的字段现在也接上了——CalendarView 的 `Props` 声明了它们，
    // 原样转发给日历里那个「当天列表」`TaskGrid`（CalendarView.tsx，它的 Props 直接 extends GridWiring）。
    // final-review.md 指出过这里以前是「传了但被静默丢掉」（`Props` 没声明，
    // 多出来的字段经 spread 传进一个没有对应参数的组件，TypeScript/React 都
    // 不会报错），日历这一处跟今天/按来源不一样——它本来就是一个 TaskGrid，
    // 没有理由不接，这里补上。
    //
    // **「今天」那半句已经过期了，改掉。** 这段原话是「今天/按来源两个视图
    // 仍然不用 gridWiring……『今天』还有手动排序，Shift 连选跟拖拽排序抢同一个
    // 手势，留给以后单独想」——后来那件事做掉了：`<TodayView>` 现在接着
    // `selection`/`onSelectionChange`（就在下面那条 render 里，注释也写着
    // 「这个视图**原来**是唯一不能多选的」）。手势没有真的打架：拖拽的抓手是
    // `.ink-trow-handle`/`.ink-rank` 那一小块，Shift 点的是标题那一片。
    // 留着这句话的代价是下一个人照它去判断「今天能不能多选」，答案是错的。
    //
    // 仍然成立的只剩「按来源」：`TaskBoard` 到今天也没声明 selection 那几个
    // 字段，那个视图确实还多选不了。两个视图**不用 gridWiring** 这件事本身
    // 也照旧（它们各自手写 props）。
    //
    // **「按来源」那一支不是漏了，是形状不支持 Shift 连选。** 那一屏用瀑布流
    // 摆卡（TaskBoard.tsx 那段注释：「这一组里的任务**没有顺序**……『第 4 条
    // 排在第 3 条正下方还是隔壁列』不损失任何信息」）。而 Shift 连选要的正是
    // 「屏幕上看到的那个顺序」（TaskGrid.tsx `orderedIds` 那段注释：顺序一分叉，
    // 连选会选中「屏幕上不连续的一段」，用户完全看不懂）——顺序本身不携带
    // 信息的地方，连选就没有意义。
    // 真要给它多选，得先决定 Shift 在那一屏是什么（退化成单点加减？那就是
    // 全站唯一一个 Shift 行为不一样的视图），那是一个产品决定，不是接几个
    // prop 的事。写在这儿是为了下一个人不必再推一遍。
    //
    // 筛选栏也接到日历了（task-3-brief 要点①「每个用 TaskGrid 的视图都要
    // 接」——日历下面的当天列表本来就是一个 TaskGrid）。跟上面 withFilterBar
    // 套的那几个视图不一样：CalendarView 不吃 GridSection[]（它自己算月格
    // 标记和当天列表），没法直接塞进 withFilterBar 那套「buildRaw/renderGrid」
    // 的形状，这里改成直接喂一份筛选收窄过的 tasks——月格标记和当天列表都是
    // 从这个 prop 算出来的（CalendarView.tsx 的 anchorDayKey/calendarDays），
    // 传一份筛过的数组进去就够，不用碰 CalendarView.tsx 本身。
    // ponytail: 这样做的代价是当天列表里正在编辑的卡如果被筛选筛掉会跟着从
    // tasks 里消失——CalendarView 内部那道「editing.has(t.id) || 命中」的
    // 保护只对还留在 tasks 里的卡有效，这里已经在它够不到的地方把卡筛没了。
    // 空筛选（默认状态）不触发这条：filterMatchedIds 是 null 时 tasks 原样
    // 传入，跟改动前完全一样。真要补全，两条路：在 CalendarView.tsx 里加一份
    // 跟 filterMatchedIds 配合的 editing 例外，或者把 filterMatchedIds 整个
    // 传下去让它自己判断——都不难，只是不在这批 scoped.ts/App.tsx/
    // Sidebar.tsx 三个文件的改动范围内。
    calendar: () => {
      // 分母/分子都以「在日历上落得进某一天」为候选集，跟另外七处
      // （withFilterBar 的 total/matched 用的是各自视图自己的候选数）对齐——
      // 落不进任何一天的任务在这个视图里从头到尾不会出现，拿全部任务当分母/
      // 分子会数进不可能出现在这里的那些，见 final-review.md m1。
      //
      // **判据是 `calendarAnchor`，不是 `t.due`。** 这里原来写 `t.due` 并注着
      // 「没有 due 的任务在这个视图里从头到尾不会出现」——时间段
      // （`startAt`+`endAt`）加进来之后那句话是假的：一场只有时间段的会落得进
      // 月格、也画得进周/日视图，却不算进这个分母，于是筛选栏上那个「N / M」
      // 比屏幕上真的看得见的条数少。
      const dueTasks = tasks.filter((t) => calendarAnchor(t) !== null);
      const total = dueTasks.length;
      const matched = filterMatchedIds === null ? total : dueTasks.filter((t) => filterMatchedIds.has(t.id)).length;
      const visible = filterMatchedIds === null ? tasks : tasks.filter((t) => filterMatchedIds.has(t.id));
      return (
        <>
          <FilterBar
            filter={filter}
            onChange={setFilter}
            lists={lists}
            allTags={tagList}
            matched={matched}
            total={total}
            onSaveAsList={openSaveAsList}
          />
          <CalendarView
            tasks={visible} countdowns={countdowns} prefs={calPrefs} onPrefs={changeCalPrefs}
            // 「每周开始于」。读不到设置（离线）时按周一——那是加这个设置
            // 之前写死的值。
            weekStart={settings?.weekStart ?? 1}
            // 农历和「休 / 班」。读不到设置（离线）时**不画**——加这两个开关
            // 之前日历上就没有这半行，离线时凭空多出一行小字比少一行更奇怪。
            showLunar={settings?.showLunar ?? false}
            showHolidays={settings?.showHolidays ?? false}
            // 「安排任务」那一栏里的 ↑/↓ 手动排序，跟「今天」那份是同一个
            // 批量端点、同一份契约。
            onReorder={onReorder}
            // 点「在这天新建」：把那天的 23:59 预填进顶上那个表单再展开它。
            // 落 23:59 跟自然语言识别「只说了哪天」是同一条——零点会被
            // `isOverdue` 当成一个真实时刻，那天 00:01 就标成过期，红一整天。
            onComposeOn={(key) => {
              const [y, m, d] = key.split('-').map(Number);
              setComposeDue(new Date(y, m - 1, d, 23, 59).toISOString());
              setComposing(true);
            }}
            {...gridWiring}
          />
        </>
      );
    },
    // **「看板」这一条整个删了。** 它现在是清单的显示方式，不是去处——
    // 每一个走 `withFilterBar({ groupable: true })` 的任务去处（全部/已完成/
    // 搜索/清单/标签）都能就地切成看板，分支就写在那个函数里，分组轴、拖拽
    // 落列那两段逻辑原样搬了过去。理由整段在 lib/listMode.ts。
    quadrant: () => {
      // 这份 cells 只喂 allFilteredOut 提示和下面 onDropTo 里找 fromCell——
      // 两处都用不着知道哪张卡正在编辑：拖拽只在拖拽的那一刻发生，届时
      // TaskGrid 传出来的 editing 才是权威答案；「都做完或搁置了」本来就是
      // 个大概齐的提示，编辑框还开着时不该显示「都做完了」，晚一拍不算错。
      //
      // 真正喂给 TaskGrid 渲染的那份**不能**复用这份 keep=new Set()：一张
      // done/later 的卡该不该被钉住，取决于 TaskGrid 自己的 editingIds 内部
      // state，这个函数体执行的时候 TaskGrid 还没渲染过，这里拿不到——下面
      // sections 单独再调一遍 quadrantCells，把 TaskGrid 回传的 editing 原样
      // 传进去，跟 `agendaSections`（agenda.ts）同一个写法、同一个参数位置
      // 和名字 `keep`。这是 TaskGrid.tsx 的 Props 契约里「调用方负责这一半」——
      // 以前这里没做，编辑到一半的卡被标成完成会连草稿一起从四象限消失。
      const cells = quadrantCells(tasks, now, new Set(), quadRule);
      // 四象限滤掉了 done/later（见 cells.ts quadrantCells 的注释）——一个
      // 任务都做完/搁置了的人打开这里会看到四个空盒子，跟「你一条任务都没有」
      // 分不清。只有「确实有任务、但被这次过滤全滤空了」才提示，别在真正
      // 空手的时候也显示这句话（那样反而更误导：听起来像是「原本有事做完了」）。
      const allFilteredOut = tasks.length > 0 && cells.every((c) => c.tasks.length === 0);
      return withFilterBar(
        (editing) => quadrantCells(tasks, now, editing, quadRule),
        (sections) => (
          <>
            {/* **一条任务都没有时也得说句话。** 这一屏的 `empty` prop 是死的：
                `quadrantCells` 恒返回四格（那四格是一个坐标系，缺一个坐标系就
                不成立），`TaskGrid` 因此永远不认为它是空的。于是一个刚上手的人
                打开四象限，看到的是四个带标题的空盒子和**一句话都没有**——实测
                出来的。上面那句 `allFilteredOut` 补不了：它明写着 `tasks.length
                > 0`，专管「有任务但都被滤掉了」，真空手时不该说「都做完了」。
                两句互斥，一次只出一句。 */}
            {tasks.length === 0 && <p className="ink-empty-note">{EMPTY_NO_TASKS}</p>}
            {allFilteredOut && (
              <p className="ink-empty-note">都做完、搁置，或者还没到开始时间——四象限只看现在能做的</p>
            )}
            {/* **怎么读这一屏**：格子按的是优先级，不是截止时间。不说的话，一条
                「今天 20:00」到期的任务坐在「不紧急」格里看起来就是算错了。
                单独一个类名、不蹭 `.ink-empty-note`：那个专指「这里空空如也」，
                而这句话不管有没有任务都要在（理由跟 `.ink-trash-note` 那处一字
                不差，口吻也照它）。 */}
            {/* 两套规则的切换。滴答那边收在「···」-「编辑」里，这里直接摆出来，
                理由跟日历那排勾选框一字不差：一共就两档，收起来要多点两下才知道
                「四象限还能按时间分」这件事存在——而这正是最没人知道的那一件。
                原生 <label>+<input>，不套 antd Radio：那个的选中态直接读全局
                colorPrimary（群青），而群青在这个界面里是配给制、只标 AI 产出，
                见 theme.ts 顶部 boardLocalTheme 的注释。 */}
            <div className="ink-quadrant-rule" role="radiogroup" aria-label="四象限规则">
              {QUADRANT_RULES.map((r) => (
                <label key={r} className="ink-quadrant-rule-opt">
                  <input
                    type="radio"
                    name="quadrant-rule"
                    checked={quadRule === r}
                    onChange={() => changeQuadRule(r)}
                  />
                  {QUADRANT_RULE_LABEL[r]}
                </label>
              ))}
            </div>
            <p className="ink-quadrant-note">
              {quadRule === 'time-priority'
                ? '纵轴是优先级（高 / 中算重要），横轴按截止时间算出来：3 天内到期、含已过期算紧急。横轴拖不动。'
                : '四格就是四档优先级（高 / 中 / 低 / 无），跟截止时间无关。'}
            </p>
            {/* 这句提示为什么在原生 `title` 里（悬停才弹出），不常驻占一行：
                task-4-brief 修复轮 1 · B，跟日历那句「拖动任务到别的日期……」
                同一个待遇。**当时的理由是**：它描述的是拖拽这个鼠标独占的动作
                （HTML5 drag-and-drop，触屏不触发、没有键盘路径），看不到这句话
                的人本来就做不了这个动作。不用群青：这是写给人看的界面文案，
                不是 AI 产出，跟 .ink-trash-note 同一个「安静次要文字」的角色。

                **这段解释以前还写着「横轴（紧急与否）是按 due 算出来的只读坐标，
                拖不动」——那已经不成立了。** 那个二维模型（重要 = priority >= 2，
                紧急 = due 三天内）在向滴答清单靠齐那一轮整个退役：现在四格就是
                四档优先级，`due` 不参与分格，四个格子都拖得动。见 lib/cells.ts
                `QUADRANT_PRIORITY` 上面那段。`title` 的文案当时跟着改了，这段
                注释没有。

                **那句话原来装着两件事，现在按「鼠标独占与否」切开了：**
                「拖到哪一格就是设成那一档」留在这个 `title` 里（触屏上根本拖不动，
                看不到这句话的人本来就做不了这个动作）；而「四格 = 四档优先级」是
                **怎么读这一屏**，跟输入设备无关，摆成上面那行常驻小字。

                不切开的话，后半句在触屏上完全看不到，而屏幕上摆着看起来自相矛盾的
                证据：一条「今天 20:00」到期的任务坐在「不紧急」格里，一条「明天」
                到期的坐在「紧急」格里——只读标题的人有理由认为这是算错了。

                两处**不重复**：这句 `title` 里不再跟着念一遍「高 / 中 / 低 / 无」，
                上面那行已经说了。 */}
            <div
              className="ink-cells-2x2"
              /* 四格 = 四档优先级（仿滴答清单），所以四个格子都拖得动，落进
                 哪一格就是设成那一档。**按名字说，不按位置说**：窄屏下这四格
                 会拆成单列（theme.css 的 .ink-cells-2x2 媒体查询），「上下两行
                 左右两列」那种说法当场就成了假的。 */
              title={quadRule === 'time-priority'
                ? '上下拖，就是把这条任务标成重要 / 不重要。左右两列是按截止时间算出来的，拖了不改期。'
                : '拖到哪一格，就是把这条任务的优先级设成那一档。'}
            >
              <TaskGrid
                {...gridWiring}
                layout="cells"
                keepEmpty
                // 固定行档，同看板——task-3-brief 要点①，见 DENSITY_VIEWS
                // 上面那段注释。纵向拖拽（改重要程度）走的也是行/卡共用的
                // 同一份 dragWiring，横向那道「同一行不改写 priority」的
                // 守卫（下面 onDropTo）跟密度无关，不受影响。
                density="row"
                sections={sections}
                // **四个格子都拖得动**：落进哪一格就是把优先级设成那一档
                // （高/中/低/无），跟滴答清单一致。判据在 lib/cells.ts 的
                // QUADRANT_PRIORITY。
                //
                // 原来那道「拖到同一行的另一格不发 PATCH」的守卫跟着退役了：
                // 那时候横轴按 due 分列、同一行两格代表同一个 priority，
                // TaskGrid 的 `from !== s.key` 挡不住那种「换了格子没换值」的
                // 拖动。现在四格四个值，换格必然换值，TaskGrid 那道守卫就够了。
                onDropTo={(id, key) => {
                  const p = priorityOfQuadrant(key, quadRule);
                  if (p === null) return;
                  // **time-priority 下同一行的两格是同一个 priority**（横轴按 due
                  // 分列、只读），而 TaskGrid 那道 `from !== s.key` 只挡「拖回同一
                  // 格」，挡不住「拖到同一行的另一格」。判断的是这张卡**现在在哪
                  // 一格**，不能拿它当前的 priority 直接跟目标格的规范值比：
                  // priority 不等于 0/2 这两个规范值时（手动定过 1 或 3），跟规范值
                  // 比必然不相等，会被误判成「变了」而误发 PATCH——正是横向拖拽
                  // 静默改写 priority 那个坑，见
                  // .superpowers/sdd/2026-08-16-board-and-quadrant/final-review.md C1。
                  //
                  // priority 那套规则下这两行是空转（四格四个不同的值，同格已经被
                  // TaskGrid 挡掉了），留着不分叉：两套规则一条代码路径。
                  const fromCell = cells.find((c) => c.tasks.some((t) => t.id === id));
                  if (fromCell && priorityOfQuadrant(fromCell.key, quadRule) === p) return;
                  // priorityOfQuadrant 只会返回那两张表里的字面量（0/1/2/3），
                  // 类型上是 number——cast 到 Task['priority'] 收窄。
                  gridWiring.onPatch(id, { priority: p as Task['priority'] });
                }}
                empty={EMPTY_NO_TASKS}
              />
            </div>
          </>
        ),
      );
    },
    all: () => withFilterBar(
      (editing) => allSections(tasks, now, editing),
      (sections, emptyFiltered) => (
        <TaskGrid {...gridWiring} density={density} sections={sections} empty={EMPTY_NO_TASKS} emptyFiltered={emptyFiltered} />
      ),
      { groupable: true },
    ),
    /**
     * 未归类：`listId` 是 null 的那些（仿滴答清单的「收集箱」，名字避开这个
     * 应用已经占掉的「收件箱」，理由在 lib/views.tsx 那条 spec 上）。
     *
     * 复用 `allSections` 再过一道筛，不另写一份分组：这一屏跟「全部」是同一种
     * 摆法，只是任务少一批。`editing`/`linger` 原样透传——正在编辑的那张卡
     * 和刚勾完的那几条要留住，判据跟别处一模一样。
     */
    nolist: () => withFilterBar(
      (editing) => allSections(tasks.filter((t) => t.listId === null || editing.has(t.id)), now, editing),
      (sections, emptyFiltered) => (
        <TaskGrid
          {...gridWiring}
          density={density}
          sections={sections}
          /* **一条任务都没有的时候不能说「都有归处了」。** 那句话的意思是「东西
             都在，而且都归好了」——在一个刚装好、零任务零清单的实例上它是假的，
             还顺带恭维了一件他没做过的事。空实例上实测确认：这一屏只有这一句，
             没有下一步。
             分档用的就是文件靠前那两句现成的：真的还没有 → `EMPTY_NO_TASKS`；
             有任务、只是没有一条落在这一屏 → 原来那句。`emptyFiltered`（「有东西
             但被筛选挡住了」）是第三种，不混。 */
          empty={tasks.length === 0 ? EMPTY_NO_TASKS : '没有未归类的任务——都有归处了'}
          emptyFiltered={emptyFiltered}
        />
      ),
      { groupable: true },
    ),
    done: () => withFilterBar(
      (editing) => doneSections(tasks, editing),
      (sections, emptyFiltered) => (
        <TaskGrid {...gridWiring} density={density} sections={sections} empty="还没有做完的任务。做完的会留在这儿，不会消失。" emptyFiltered={emptyFiltered} />
      ),
      { groupable: true },
    ),
    source: () => (
      <TaskBoard
        // 「按来源」原来是全站唯一选不中的视图。接上之后 Shift 在这一屏退化成
        // 单点加减，一次选一排交给组头那颗「选中这 N 条」——理由写在
        // TaskBoard.tsx GroupSection 里那段注释。
        selection={selection}
        onSelectionChange={setSelection}
        filter={boardFilter}
        onFilterChange={setBoardFilter}
        proposals={proposalWiring}
        tasks={tasks}
        inbox={inbox}
        now={now}
        lists={lists}
        onPatch={patchOne}
        // 同上：编辑态保存不经 guard()，失败要留住编辑框和草稿。
        onEditTask={(id, patch) => api.patchTask(id, patch)}
        onDelete={(id) => guard(() => api.deleteTask(id))}
        onDuplicate={duplicateTask}
        onSkip={cardWiring.onSkip}
        onPromoteSubtask={cardWiring.onPromoteSubtask}
        focusMinutes={settings?.focusMinutes}
        breakMinutes={settings?.breakMinutes}
        offline={offline}
      />
    ),
    review: () => (
      <ReviewView
        insights={insights}
        tasks={tasks}
        // 「这一周该过一遍的」第一行数没处理的收件箱条目，见 lib/weeklyReview.ts。
        inbox={inbox}
        now={now}
        // 清单上某一行点了就切过去——跟侧栏点那一项是同一个动作，走同一个 setView。
        // 先设筛选再切过去——「1 条在等别人」要落在一份**只剩等待中的**列表上，
        // 不是「全部」的十九条里。筛选栏本身会把当前筛选写成一句话摆在顶上
        // （FilterBar 的 summary），所以这不是一次偷偷改状态。
        onGo={(v, f) => {
          if (f) setFilter({ ...emptyFilter(), ...f });
          navigate(v);
        }}
        onDismiss={(id) => guard(() => api.dismissInsight(id))}
        // 点关联任务就切到装得下它的去处，判据在 `openTask`（四个入口共用）。
        // insight 是回顾时写的，那之后任务被做完是很正常的事，不能假设它还是
        // 「未完成」——`openTask` 正是按当下的状态挑去处。
        onOpen={openTask}
        // 「看过了」：给那条卡住的项目盖一个 `reviewedAt` 的章，这一屏
        // REVIEWED_QUIET_DAYS 天内不再问它。走 `patchOne` 跟别处一样，不新开
        // 一条写路径——写进文件 → watcher → SSE → reload，界面自己会更新
        // （`guard()` 上面那条规矩）。
        onReviewed={(id) => patchOne(id, { reviewedAt: new Date().toISOString() })}
        // 「让 AI 回顾一遍」。跟「立即拆解」是同一条链路的两个提示词，服务端
        // 共用一把单飞锁（server/src/expand.ts 的 AgentKind），所以 `reviewing`
        // 直接用同一个 agent 状态——正在拆解时点回顾会被 409，不如先别让点。
        onReview={() => guard(() => api.review())}
        reviewing={agent?.state === 'running'}
      />
    ),
    // 专注统计（仿滴答清单）。**不套 withFilterBar**：这一块回答的是「我的
    // 时间花在哪儿了」，是一份对全部历史的统计——按当前筛选收窄之后那些数字
    // 就不再是「我的专注时间」，而是「符合这个筛选的那部分专注时间」，
    // 一个没人会想要、又看不出来的数。
    // 排行榜和记录列表里的任务名点得开——判据跟习惯页那颗、ReviewView 的
    // onOpen 完全一样（done 落「已完成」，其余落「全部」，那是唯一保证装得下
    // 任意一条任务的去处），复用同一个 `openTask`。
    // `weekStart` 跟日历那一屏读的是同一个设置：「本周专注了多久」和日历上
    // 那七列必须对同一个「本周」。读不到设置（离线）按周一，跟默认档一致。
    focus: () => <FocusStats tasks={tasks} lists={lists} now={now} onPatch={patchOne} onOpen={openTask} weekStart={settings?.weekStart ?? 1} />,
    // 习惯概览（仿滴答清单的「打卡概览」+「月度打卡表」）。跟专注统计同一条：
    // 不套 withFilterBar——「这个月坚持得怎么样」是对全部历史的回答，按当前
    // 筛选收窄之后那个数字就不再是它了。
    // 点一个习惯跳到那条任务：判据跟 ReviewView 的 onOpen、桌面通知点开那条
    // 完全一样（done 落「已完成」，其余落「全部」，那是唯一保证装得下任意一条
    // 任务的去处），再用已有的 editRequest 机制把它指出来。
    countdown: () => (
      <CountdownView
        rows={countdowns}
        now={now}
        onAdd={(title, date, yearly, lunar) => guard(() => api.addCountdown(title, date, yearly, lunar))}
        onDelete={(id) => guard(() => api.deleteCountdown(id))}
        // 关掉「每年」时把「农历」一起关掉：农历那一档只在每年下成立，
        // 留一个不起作用的 true 在数据里，下次再勾上「每年」会莫名其妙地
        // 变成农历。判据写在 `types.ts` 的 `Countdown.lunar` 上。
        onToggleYearly={(id, yearly) => guard(() => api.patchCountdown(id, yearly ? { yearly } : { yearly, lunar: false }))}
        onToggleLunar={(id, lunar) => guard(() => api.patchCountdown(id, { lunar }))}
        onEdit={(id, patch) => guard(() => api.patchCountdown(id, patch))}
      />
    ),
    habits: () => (
      <HabitStats
        tasks={tasks}
        now={now}
        // 跟专注统计那张热力图、跟日历那七列，读的是同一个设置。
        weekStart={settings?.weekStart ?? 1}
        // 打卡就是把那条实例标完成，走的是**跟卡片上勾它完全同一个处理**
        // （`patchOne`）——撤销提示、「下次 X」、连带判断全都白来，不在这儿
        // 另写一份「打卡」。
        onCheckIn={(id) => patchOne(id, { status: 'done' })}
        onOpen={openTask}
      />
    ),
    trash: () => (
      <TrashView
        items={trash}
        now={now}
        // **说一声它去哪了**：这一屏上「还原」之后唯一的变化是少了一行，
        // 而那条任务落在别处（已完成的落「已完成」，其余落「全部」——跟
        // `openTask` 同一条判据，不新造一个「装得下它的去处」）。不说的话
        // 跟「删掉了」在屏幕上长得一模一样，而这是 `TaskComposer.report()`
        // 早就立过的规矩：写成功了、界面看上去什么也没发生，是这个仓库栽过
        // 五次的那一类。
        onRestore={(id) => guard(async () => {
          const it = trash.find((x) => x.id === id);
          await api.restoreTrash(id);
          if (it) void message.success(`已还原「${it.title}」——在「${it.status === 'done' ? '已完成' : '全部'}」里`);
        })}
        onPurge={(id) => guard(() => api.purgeTrash(id))}
        onPurgeAll={() => guard(() => api.purgeAllTrash())}
      />
    ),
  });

  // 任务了结（完成/搁置/放弃）或者被删掉，横幅跟着消失：查不到（删了）、
  // 或者 isSettled 就不渲染，不需要专门监听这几个事件。
  // 搁置跟完成同一个道理必须一起挡：搁置的意图是「暂时不想看见它」，横幅继续
  // 钉在最上面、点进去却发现卡片已经不在「今天」里了，比放着不搁置还糟。
  // **放弃原来漏了**——而它比搁置更该挡：横幅点进去会跳到「全部」，而「全部」
  // 本来就把放弃的排除在外（lib/simpleViews.ts），于是点了之后落到一个页面上
  // 找不到那条任务，正是上面那句话描述的那种糟糕。
  /** 最多同时摆几条提醒横幅。三条是「一屏看得完、又不至于把看板顶没」那一档。 */
  const DUE_BANNERS = 3;

  const dueTasks = due
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined && !isSettled(t));

  /** 横幅上的「忽略」（右上角那颗 ×）和「完成」共用：只把它从这一屏摘掉。 */
  /**
   * 横幅右上角那个 `×`（忽略）——**只把横幅从这一屏上拿掉，一个字节都不改**。
   *
   * 对开了「没处理就一直提醒」的任务，这**不算处理**：`firedAt` 原样留着，
   * 十分钟后服务端照样再喊一声。那正是那个开关要挡的动作，见 `model.ts` 里
   * `Task.persistentReminder`。想让它真的停下来，走完成/搁置/放弃、「稍后」、
   * 或者把提醒删掉。
   */
  const dismissDue = (id: string) => setDue((prev) => prev.filter((x) => x !== id));

  /**
   * 「稍后 10 分钟」——**把刚响过的那一条挪到十分钟后**。判据在
   * `lib/reschedule.ts` 的 `snoozePatch`。
   *
   * 这里原来是「追加一条新的」，理由写着「原来那条盖过 `firedAt`，挪它不会
   * 再响」。**那个前提是错的**：服务端 `applyTaskPatch` 按时刻逐条比对来沿用
   * 旧章，`at` 一变就配不上任何一条旧的、从「还没提醒过」重新算起——挪它照样
   * 响得起来。而追加的代价是实打实的：连着按五次「稍后」就攒下六条提醒、
   * 五条是死的，编辑表单里并排六个日期选择器。
   *
   * 十分钟是照着桌面版原生通知那颗按钮取的（`desktop/src/notify.ts` 的
   * `SNOOZE_MINUTES`），两个壳里点「稍后」推的量该一样，不在这里另挑一个。
   * **没有 import 过来共用一份**：那是 web → desktop 方向的依赖（现在只有
   * 反过来的，web 被打进桌面壳），为一个数字开这条边不划算；漂了的后果也只是
   * 两个壳各自自洽地推了不同的分钟数，不是坏数据。
   *
   * **跟桌面那边现在做的是同一件事**（`desktop/src/protocol.ts` 的
   * `patchForAction`：先把任务取回来，再挪 `firedAt` 最新的那一条）。这一段
   * 上一版写着「这里是追加，那边是整个替换」——两句都过时了，两边都改过之后
   * 忘了回来改这段话。真要有一天分叉，分叉的是**取不到任务时的退路**：网页
   * 整条任务本来就在手里，桌面那条路上只有一个 id。
   *
   * **对开了「没处理就一直提醒」的任务，按这颗按钮是「处理」**：`at` 一变，
   * 服务端配不上任何旧章，`firedAt` 归 null，这条提醒回到普通那条路。
   * 见 `model.ts` 里 `Task.persistentReminder`。
   */
  /** 主按钮那一档。名单在 `lib/reschedule.ts`，这儿只取第一个——不写死 10。 */
  const SNOOZE_MIN = SNOOZE_CHOICES[0];
  const snoozeDue = (t: Task, minutes: number) => {
    guard(() => api.patchTask(t.id, snoozePatch(t, minutes, now)));
    dismissDue(t.id);
    // 提示里的数字跟真正推的量读同一个参数，不是另写一个字面量。
    void message.success(`${snoozeLabel(minutes)}后再提醒你`);
  };

  // 顶栏那行小字用的：收件箱里还有多少条没被 AI 读走。这是「AI 队列还有多少
  // 活」，跟群青「标记 AI 产出」是同一件事的另一面，所以数字本身用群青——
  // 导航上「收件箱」旁边那个徽标数的其实是同一个数字（见 lib/views.tsx 里
  // inbox 视图的 count），但那边统一用 --dim（导航徽标不单独强调某一项）。
  // 两处颜色不一样是故意的：这里是把「AI 还有多少活没干」单独拎出来强调，
  // 不是两份不同语义的计数——上一版注释说两边算的是不同的数，那时候侧栏还
  // 有独立的「待拆解」小标题；换成导航之后已经不成立了。
  const pendingInboxCount = inbox.filter((x) => !x.processed).length;

  // 「可以让 AI 回顾一遍」那句提示的触发条件，见下面渲染处的注释。
  const staleCount = countStale(tasks, now);

  // 顶部 <h1> 标题。registry 里找不到（导航「清单」「标签」两组点出来的
  // 'list:xxx'/'tag:xxx'，见下面 scopedSections 那段渲染）时落到清单名/
  // 标签名——那两组信息 App 已经有（lists 状态、tasks 上的
  // tags），不用等内容接上才能显示一个像样的标题。再退一步（清单已经被删掉
  // 之类）就显示原始 key，空字符串是唯一不该出现的结果：空 <h1> 是可访问性
  // 异味，量测夹具会当成「没有标题」逮到。
  const viewTitle = (): string => {
    const spec = findSpec(view);
    if (spec) return spec.label;
    // 找不到那份清单就说找不到，**不把 id 原样印出来**。旧书签指向一份已经
    // 删掉的清单时，屏幕上原来是 `list:9f2c1a4e-dead-…`——而这一屏的正文是
    // 一个空任务列表，两下加起来读者只能猜。这句话顺带解释了列表为什么是空的。
    //
    // **已知边界：`lists` 初值是空数组，填它的是异步的 `reload()`。** 所以在
    // 第一次拿到清单之前，这句话对一份真实存在的清单也会说「找不到」。实测
    // 一般看不到：本地缓存（`CapacitorStorage.local:lists`）让首帧就有数据。
    // 真会停在这句上的是「缓存也没有 + 请求失败」——而那种情况下离线横幅已经
    // 在顶上说了话，整屏都是降级的。为这一句单加一个「首次加载完成」标记，
    // 代价大于收益，所以是**知道并接受**，不是没想到。
    if (view.startsWith('list:')) {
      // `?.name ?? …` 挡不住「名字是空白」：`POST /api/push` 不校验字段值，别的
      // 设备推一份 `name: ''` 的清单过来就够了，于是 h1 空着、标题退化成光秃秃的
      // 应用名——正是上面那句「空字符串是唯一不该出现的结果」。`tag:` 那支已经
      // 用 `.trim() ||` 加固过，这支当时漏了。
      return lists.find((l) => l.id === view.slice('list:'.length))?.name?.trim() || '找不到这份清单';
    }
    // 标签没有实体（`tagTree.ts`：从任务上现算），前缀后面那截就是标签名本身
    // ——是人写的字，照印。**但空的不算**：`#/tag:` 会让 `slice` 得到空串，
    // 于是 h1 是空的、标题退化成光秃秃的应用名——正是上面那句「空字符串是唯一
    // 不该出现的结果」说的事。这条路够得到：`POST /api/push` 故意不过
    // `checkTaskPatch`（「不认：字段的值」），别的设备推一条 `tags: ['']` 上来
    // 就够了。
    if (view.startsWith('tag:')) return view.slice('tag:'.length).trim() || UNKNOWN_VIEW;
    // 中文名，不是存进文件的那个英文 key——标题栏上写 'computer' 是把实现细节
    // 搔到了人脸上。
    //
    // **必须用 `Object.hasOwn`，不能靠 `?? `**：`CONTEXT_LABEL` 是个普通对象
    // 字面量，`#/context:toString` 取到的是原型链上那个函数，`??` 根本不触发，
    // 返回值是个 function。以前它只让 React 报个警告；加了 `setBaseTitle` 之后
    // 那个 function 会被送进 `viewLabel.trim()`——一个副作用里抛 TypeError，
    // 而 `<App/>` 上面没有错误边界（`BoardErrorBoundary` 只包看板正文），
    // 整棵树卸载，**白屏**。实测 `#/context:toString`：`.ink-page` 都不在了。
    // constructor / valueOf / hasOwnProperty 同理。
    if (view.startsWith('context:')) {
      const c = view.slice('context:'.length);
      return Object.hasOwn(CONTEXT_LABEL, c) ? CONTEXT_LABEL[c as TaskContext] : UNKNOWN_VIEW;
    }
    // **认不得就说认不得，跟正文那句一致。** 这儿原来是 `return view`，于是
    // 同一屏上标题印着 `some-junk-key`、正文写着「没有这个去处」，自相矛盾；
    // 而标题现在还会写进标签页、任务栏和桌面版窗口标题（`lib/pageTitle.ts`），
    // 一个内部 key 就这么挂在 Alt-Tab 里——上面那句「实现细节别搔到人脸上」
    // 说的正是这件事，只是当初没管住这条兜底路径。
    return UNKNOWN_VIEW;
  };

  /**
   * 把当前这一屏的名字写进标签页/窗口标题。
   *
   * 在这之前十五个视图的标题全是 index.html 里那句写死的「办事师爷」——
   * 标签页、任务栏、桌面版窗口上看不出人在哪一屏。对读屏更要紧：hash 路由
   * 切视图不产生真正的导航，**标题变化是读屏播报「换页了」唯一的信号**。
   *
   * 走 `setBaseTitle` 而不是直接写 `document.title`：番茄钟跑起来时会临时
   * **占用**标题写秒数，占用期间这一句不会盖掉屏幕上那一行，只更新「他走了
   * 之后该显示什么」——两层的理由整段在 lib/pageTitle.ts。
   */
  /**
   * **拆完那条绿色提示自己走，失败那条不走。**
   *
   * 这条 Alert 原来只有 `closable`：点 × 才消失。它自称「一闪而过的绿色提示」，
   * 实际会一直杵在那儿，直到人手动关掉或者下一次拆解覆盖它。
   *
   * ## 别人怎么分这条线
   *
   * 通行做法是**按「要不要人做点什么」分**，不是按「好消息坏消息」分：
   *
   * - 成功 / 告知类自动消失。antd 自己的默认值就是这个意思（`message` 3 秒、
   *   `notification` 4.5 秒），Material 的 Snackbar、Polaris 的 Toast 也都只
   *   给这一类配自动消失。
   * - **错误不自动消失。** 它可能带着要读的原因（`agent.message` 里是子进程的
   *   报错），而人恰恰可能不在屏幕前——自动收走等于把唯一一次告知丢了。
   *
   * 所以这里只让 `ok` 和 `skipped` 自己走，`failed` 原样留着等人点 ×。
   *
   * ## 不可见的时候不计时
   *
   * 这一条是这个场景特有的，也是上面那类通行做法里容易漏的一半：**人点了
   * 「立即拆解」之后多半会切走干别的**（一轮要几十秒），而这条提示存在的全部
   * 意义就是他回来时能看见「办完了」。挂个死定时器的话，切走 90 秒回来提示
   * 已经自己走了，屏幕上跟「什么都没发生」一模一样——正是它当初要解决的问题。
   *
   * 做法是只在 `document.visibilityState === 'visible'` 时计时，切走就停、
   * 回来接着走。Sonner、react-hot-toast 这类 toast 库对「hover 时暂停」用的
   * 是同一个思路，这里把触发条件换成页面可见性。
   */
  const agentState = agent?.state;
  useEffect(() => {
    if (agentState !== 'ok' && agentState !== 'skipped') return undefined;
    let left = AGENT_TOAST_MS;
    let since: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (since !== null) { left -= Date.now() - since; since = null; }
    };
    const start = () => {
      if (timer !== undefined || left <= 0) return;
      since = Date.now();
      timer = setTimeout(() => setAgent(null), left);
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [agentState]);

  /**
   * 清单侧栏宽度。**可拖，落 localStorage。**
   *
   * 原来钉死 280px。宽屏上人想多看几个清单名、或者想把地方让给看板，都只能
   * 干看着。宽度这种「每个人不一样、定一次就不再想」的偏好，跟行/卡密度
   * （`density.ts`）是同一类，所以照它的办法：初值同步从 localStorage 读，
   * 读不出来用默认值，写失败就当没这回事（隐私模式）。
   */
  const [navWidth, setNavWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(NAV_WIDTH_KEY);
      return raw ? clampNavWidth(Number(raw)) || NAV_DEFAULT : NAV_DEFAULT;
    } catch { return NAV_DEFAULT; }
  });

  /** 详情那一栏同上，两栏各存各的——它们是两个独立的偏好。 */
  const [detailWidth, setDetailWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
      return raw ? clampWidth(Number(raw), DETAIL_MIN, DETAIL_MAX) || DETAIL_DEFAULT : DETAIL_DEFAULT;
    } catch { return DETAIL_DEFAULT; }
  });

  const pageTitle = viewTitle();
  useEffect(() => { setBaseTitle(pageTitle); }, [pageTitle]);

  // 密度开关在视图标题栏里出不出现——`DENSITY_VIEWS` 那四个注册表视图，
  // 或者 `view` 是 `list:xxx`/`tag:xxx`（清单/标签，`scopedSections` 认的
  // 那两种前缀，跟上面 `viewTitle()` 判断同一件事、同一个口径）。
  //
  // **修复轮 1 · M-1：这里曾经写的是 `!findSpec(view)`**，看起来跟
  // `viewTitle()`/下面渲染「清单/标签」那条回退分支（`{!findSpec(view) &&
  // (...)}`）是同一条判据，实际不是——`!findSpec(view)` 对**任何**不在
  // `VIEW_SPECS` 里的字符串都成立，包括走到 `scopedSections` 返回 `null`、
  // 落进「没有这个去处」那条死路的野生 `view` 值。那种情况下页面主体是一句
  // 空状态提示，标题栏却会多出一颗点了没反应的密度开关——收窄成显式判断
  // 这两个前缀，跟 `viewTitle()` 的口径完全对齐，不再依赖「不在注册表里」
  // 这个更宽的条件。
  const canToggleDensity = DENSITY_VIEWS.has(view) || view.startsWith('list:') || view.startsWith('tag:') || view.startsWith('context:');

  /**
   * 这一屏能不能切「列表 / 看板」。**必须覆盖每一个 `withFilterBar({ groupable:
   * true })` 的去处**——看板分支就写在那个函数里，`groupable && listMode ===
   * 'board'` 一成立它就渲染成看板，跟这里给不给开关无关。
   *
   * **这句话曾经是假的，而且真的把人关在里面过。** 上一版写着「跟 `groupable`
   * 是同一批去处（全部/已完成/搜索/清单/标签）」，漏了**未归类**：它是
   * `groupable` 的，而 `listMode` 又是**一个全局偏好**（`lib/listMode.ts`，
   * 整个应用一个 `localStorage` 值）。于是在「全部」切成看板、再走到「未归类」，
   * 那一屏也是看板，**却既没有列表/看板开关、也没有密度开关**——退不出去。
   * 实测复现过（无头浏览器走完整条路：切看板 → 去未归类 → 两个开关都不在）。
   *
   * 「今天」不给：那一屏的顺序是他自己拖出来的，分成几列之后那个顺序没有地方
   * 落。「接下来」不给：它本来就按时间分好组了。这两屏也**不是** `groupable`，
   * 所以不会被上面那条渲染成看板，给不给开关都不会卡住。
   *
   * ponytail: 判据仍然是手写的两份（这里 + 各处 `withFilterBar` 的 `groupable`）。
   * 正解是把它变成 `ViewSpec` 上的一个字段（`views.tsx` 已经带着 `keepMounted`
   * 之类），那样只有一份正本；`DENSITY_VIEWS` 同理。没顺手做是因为那两个常量
   * 被好几条测试直接引用，搬家的面比这个 bug 大得多。下面那条守卫先把两边
   * 钉住：漏一个就红。
   */
  const canToggleListMode = ['all', 'nolist', 'done', 'search'].includes(view)
    || view.startsWith('list:') || view.startsWith('tag:') || view.startsWith('context:');

  // 命令面板（Ctrl/Cmd+K）的命令表。规格那句「能跑所有视图切换和批量操作」
  // 后半句在这一批接上了（见下面 selection.ids.size > 0 那段 spread）——
  // 上一批留的口子正是「这里是一个扁平数组，加批量操作就是往里追加一段
  // spread，不用改 CommandPalette 本身（它的 Command 类型已经是扁平的）」。
  //
  // 九个固定视图（NAV_VIEW_SPECS 前 9 项）带上数字键 hint——这是快捷键唯一
  // 的可发现入口，不带的话没人知道有 1..9。第 10 项往后（四象限、习惯、专注统计、
  // 纪念日、回顾）数字键够不到（keymap.ts 只认 '1'..'9'），不给 hint，但照样在
  // 命令表里，命令面板本来就是它们的入口。
  //
  // 清单和标签是运行时才知道有多少条的——这正是命令面板比数字键有用的地方
  // （brief 原话）：数字键是固定的 9 个，清单/标签数量不定，只有搜索式的
  // 面板才装得下。key 直接用视图 key 本身（'list:<id>'/'tag:<name>'）：
  // 它们跟 navigate() 的目标是同一个字符串，不用另起一套 id。
  // 设置弹层里那份「导航显示」的候选表。跟导航渲染读的是同一份 registry、
  // 同一个 SKIP_IN_NAV——两处各写一份「有哪些去处」迟早分叉（设置里关得掉
  // 一个导航上根本不存在的入口，或者反过来）。
  // 带上 `group`：这份表现在要**按段分开列**——导航本身已经分成侧栏两段 +
  // 顶栏模块栏，设置里还摊成平平一列十四项的话，「习惯」关不掉的时候人会
  // 先在侧栏上找一遍（它根本不在那儿）。
  const navOptions = registry
    .filter((v) => !SKIP_IN_NAV.has(v.key))
    .map((v) => ({ key: v.key, label: v.label, group: v.group, canAuto: canAuto(v) }));

  // 真正喂给 Sidebar 的那一份，按显示方式筛过。**当前正看着的那个永远留下**，
  // 判据在 lib/navVisibility.ts。
  const navDefs = visibleViews(registry, navModes, view, { tasks, inbox, now, insights });
  // 顶栏那条模块栏那几项。跟侧栏分的是同一份 navDefs，只是画在两个地方。
  // 竖栏上那两段（日历/看板/四象限 + 习惯/专注统计/纪念日/回顾），按 RAIL_GROUPS
  // 的顺序摊平，段与段之间画一道分隔（见 Rail.tsx 的 `items[].group`）。
  const railDefs = RAIL_GROUPS.flatMap((g) => navDefs.filter((v) => v.group === g));

  /**
   * 这一屏要不要清单侧栏。**只有任务模块有**——判据和理由整段在
   * lib/views.tsx 的 `showsSidebar`。
   */
  const inTaskModule = showsSidebar(view);

  /**
   * 手机上清单侧栏改成划出来的抽屉，不待在文档流里。
   *
   * 之前它就摆在任务列表**上面**：竖栏躺平成顶上一条，紧接着是整条侧栏
   * （导航 + 清单 + 标签 + 随手记），实测 390×844 上占掉七百多像素——
   * **打开应用，第一屏一条任务都看不见**，得先把整个侧栏划过去。而这个
   * 应用打开就是为了看今天要做什么。
   *
   * 照滴答清单的做法：它手机端的侧边栏是划出来/点出来的，不占列表那一屏
   * （帮助文档「在清单详情页，向右滑动即可快速打开侧边栏」）。这里用抽屉
   * ——手势要自己实现一套，而 antd `Drawer` 的焦点陷阱、Esc 关闭、遮罩都是
   * 现成的。（原来这儿写的是「而这个应用的设置抽屉本来就是 antd Drawer」
   * ——设置早就换成了分区弹层（`SettingsModal`），那条「反正已经有一个了」的
   * 理由不成立了；`Drawer` 留着靠的是它自己那几样现成的东西，不是同类相认。）
   *
   * **随手记不进抽屉。** 「随手记的成本不能变高」是这个产品的硬约束，
   * 藏进一个要先点开的抽屉正是把成本抬高；它挪到任务列表**下面**，
   * 顺序变成「今天要做什么 → 想到什么随手写 → 去别处看看」，正是手机上
   * 这三件事的频次顺序。
   */
  const isNarrow = useIsNarrow();
  /** 窄到放不下三栏（< 1000px）。详情那一栏在这一档退成整屏浮层，见 lib/narrow.ts。 */
  const isTight = useIsTight();
  const [navOpen, setNavOpen] = useState(false);
  // 不经 guard()：失败要把输入框和草稿留着，让 InboxComposer 自己的 catch 去
  // 处理——guard() 会把 reject 吞掉，InboxComposer 就会误以为存成功了，把刚打
  // 的字清空。（这句原来写在下面那个 prop 上，提成变量之后跟着搬过来。）
  const composer = <InboxComposer onSubmit={async (text) => { await api.addInbox(text); }} />;


  /**
   * 上一次待过的那个任务去处。点竖栏上「任务」那一颗回到这儿，不是每次都
   * 固定跳「今天」——人在「工作」那个清单里看了半天，去日历上瞄一眼再点回来，
   * 落回「今天」等于把他刚才的位置丢了。
   *
   * ref 不是 state：它只在点那一颗的时候被读一次，不需要触发任何重渲染
   * （跟 tasksRef/selectionRef 同一个套路）。
   */
  const lastTaskViewRef = useRef<string>('today');
  if (inTaskModule) lastTaskViewRef.current = view;

  const commands: Command[] = [
    ...NAV_VIEW_SPECS.map((spec, i): Command => ({
      key: spec.key,
      label: spec.label,
      hint: i < 9 ? String(i + 1) : undefined,
      run: () => navigate(spec.key),
    })),
    ...lists.filter((l) => !l.archived).map((l): Command => ({
      key: `list:${l.id}`,
      label: `清单「${l.name}」`,
      run: () => navigate(`list:${l.id}`),
    })),
    ...tagList.map((t): Command => ({
      key: `tag:${t}`,
      label: `标签「${t}」`,
      run: () => navigate(`tag:${t}`),
    })),
    // 跟 N 同一个动作（brief 原话：「一条『新任务』（跑跟 N 同一个动作）」）——
    // 不是打开 TaskComposer 那个「新任务」按钮，两者的区别见 focusQuickCapture
    // 定义处的注释。
    { key: 'new', label: '随手记', hint: 'N', run: focusQuickCapture },
    // 快捷键一览也进命令面板：`?` 本身要先知道才按得出来，而这个应用的
    // 快捷键在别处一个字都没写。滴答清单同样两条路都通（`?` 和指令菜单里
    // 的「显示键盘快捷键」）。
    // 「新任务」也进面板。原来只有「随手记」那条——而这两个是建任务的两条
    // 路，一条在面板里、另一条既没有键也不在面板里，只在视图标题栏那颗按钮上。
    { key: 'compose', label: '新任务', hint: 'C', run: openCompose },
    { key: 'help', label: '快捷键', hint: '?', run: () => setHelpOpen(true) },
    // 把全部过期的改到今天。**只在真有过期的时候出现**，跟批量那几条同一条
    // 上限：面板里不该摆一个「把 0 条改到今天」。数字写在标题里，因为这条的
    // 范围是全表、不是屏幕上那几条，得让人先看见它要动多少条。
    ...(overdueAll.length > 0 ? [{
      key: 'defer-overdue',
      label: `把 ${overdueAll.length} 条过期的改到今天`,
      run: () => confirmDeferAllOverdue(overdueAll),
    }] : []),
    // 批量命令——选中非空时才出现（上限：一张都没选，面板里不该出现「删除
    // 选中的 0 条」这种没有意义的入口），跑的是跟批量操作条同一个动作，不是
    // 另开一套：删除复用 confirmBatchDelete（跟 Del 键、BatchBar 的删除按钮
    // 三处共用同一份确认文案），取消选择复用 clearSelection。
    //
    // **收哪些的判据是「选中就跑」**：命令面板的 `Command` 没有再问一步的
    // 地方。改清单、加标签、改优先级仍然不收——它们各自还要问「哪个清单」
    // 「什么标签文字」「哪档优先级」，那得靠批量操作条上的下拉/输入框。
    //
    // 但**「完成」「改到今天/明天/下周」「推迟 1 小时」这五个已经不需要再问了**
    // ——它们本来就是固定的一个动作（键盘上的 D / T / M / W 跑的正是这几个）。
    // 原来那条注释把它们跟「改状态」笼统地归成一类挡在外面，现在按判据本身
    // 一条条看：不需要再问的就收进来。这也是那几个单键的唯一出口——不进面板
    // 的话，它们只在 `?` 那张表里出现过一次。
    ...(selection.ids.size > 0 ? [
      { key: 'batch-done', label: `把选中的 ${selection.ids.size} 条标成已完成`, hint: 'D', run: () => batchStatus('done') },
      // **`clear`（去掉截止时间）不进面板**，虽然它同样「不需要再问」。它是这四档
      // 里唯一不可逆的一步（原来那个日期没别处记着，见 lib/reschedule.ts），而
      // 命令面板恰恰是最容易误触的入口：模糊搜索命中一条、回车就跑，中间没有
      // 任何一步能反悔。删除也在面板里，但删除有确认框兜着（confirmBatchDelete），
      // 这一条没有。批量操作条上那个下拉里它一直都在，够得到。
      ...RESCHEDULE_KEYS.filter((k) => k !== 'clear').map((k): Command => ({
        key: `batch-due-${k}`,
        label: `把选中的 ${selection.ids.size} 条改到${RESCHEDULE_LABEL[k]}`,
        hint: { today: 'T', tomorrow: 'M', nextWeek: 'W' }[k as 'today' | 'tomorrow' | 'nextWeek'],
        run: () => batchReschedule(k),
      })),
      { key: 'batch-postpone', label: `把选中的 ${selection.ids.size} 条推迟 1 小时`, run: () => batchPostpone(POSTPONE_MINUTES) },
      { key: 'batch-delete', label: `删除选中的 ${selection.ids.size} 条`, run: confirmBatchDelete },
      { key: 'batch-clear', label: '取消选择', run: clearSelection },
    ] : []),
  ];

  return (
    <div className="ink-page">
      {/**
       * **跳过重复区块**（WCAG 2.4.1 A 级）。键盘走查实测：模块栏 9 站 + 侧栏
       * 51 站 + 随手记 2 站 + 那条拖拽界线 1 站 = **按 63 下 Tab 才够得着任务
       * 那一栏**，而这一整串在每一个去处都一模一样地重来一遍。
       *
       * **落点是任务那一栏，不是 `<main>`。** 侧栏就住在 `<main>` 里，焦点送到
       * main 上，下一下 Tab 又回到侧栏第一项——等于什么都没跳过。实测确认过。
       *
       * **是按钮，不是 `<a href="#…">`。** 这个应用的路由就住在 hash 上
       * （`#/today`，见 `lib/hashView.ts`），锚点式跳转会被路由当成一次换去处，
       * 跳去一个不存在的「#ink-tasks」——那是这个仓库特有的坑，不是通用写法的
       * 问题。所以直接把焦点挪过去。
       */}
      <button
        type="button"
        className="ink-skip"
        onClick={() => document.getElementById('ink-tasks')?.focus()}
      >跳到任务列表</button>
      {/* 最左那条竖图标栏（仿滴答清单第一栏）。**模块从顶栏搬到了这儿**——
          理由整段在 Rail.tsx 顶部。它在 .ink-page 这一层，跟「顶栏 + 内容」
          那一整块并排，所以是整屏通高的，不是挤在某一栏里面。 */}
      {railDefs.length > 0 && (
        <Rail
          items={[
            // **「任务」那一颗排第一**（滴答那条竖栏上第一颗也是它）。它不对应
            // 注册表里任何一条去处，对应的是一整段——所以 `active` 得自己算：
            // 站在「全部」或者某个清单里时，它照样是「当前」。
            {
              key: TASKS_MODULE_KEY,
              label: '任务',
              group: 'tasks',
              active: inTaskModule,
            },
            ...railDefs.map((v) => ({
              key: v.key,
              label: v.label,
              group: v.group,
              count: v.count?.({ tasks, inbox, now, insights }),
            })),
          ]}
          current={view}
          // 「任务」那一颗是个哨兵值，不是去处：把它翻译成「上次待过的那个
          // 任务去处」，别的原样导航过去。
          onSelect={(k) => navigate(k === TASKS_MODULE_KEY ? lastTaskViewRef.current : k)}
          onSearch={() => setSearching(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* **顶栏整条删了。** 它只装着一个字号「办事师爷」和右边那一串状态，
          却吃掉整屏最上面 68px——而应用名在窗口标题栏上已经有一份，竖栏顶上
          那个记号又是第三份。状态那几句挪到了视图标题那一行的右边（它们本来
          就大部分时间是空的，那一行有的是地方）。 */}
      <div className="ink-shell">
      <main className="ink-main">
        {/* 竖排的横幅 + 那一行栏。**原来是 antd 的 <Space direction="vertical">**
            ——换成自己的 div 是因为这一层现在要参与高度分配（下面那一行栏要吃掉
            剩余高度、自己滚，见 theme.css 的 .ink-main-stack）。用 Space 的话得去
            够 `.ant-space-item` 这种它的内部 class 才够得着那一项，那是随它版本
            变的东西。间距一样是 16px，写在样式表里。 */}
        <div className="ink-main-stack">
          {/* 常驻横幅，不是 toast——冲突不是「刚发生的一件事」，是「现在有一堆
              文件在那儿等你处理」，划过去就没了的提示不适合它。没有冲突时
              整条不渲染（不是渲染一个空的），见 theme.css 里 .ink-conflict-banner
              上面的注释：报警橙不是群青，群青是 AI 墨水的配额，这是「你的数据
              出岔子了」。 */}
          {/* 读不出来的文件。**跟冲突副本分开一条**：两者要人做的事完全不
              一样——冲突副本是「有两份，挑一份」，坏文件是「这一条现在打不开」。
              混成一条会让两种处置说不清。
              这条横幅补的是一个一直空着的承诺：`entityStore.readAll` 跳过坏
              文件时的注释写着「界面上由上层负责把坏文件列出来」，而上层从来
              没做过——于是一条同步坏掉的任务就这么从界面上无声消失。
              **措辞不说「出错了」**：多数时候这是同步软件写到一半，文件还在
              那儿、内容也还在，说「打不开」比说「坏了」更接近事实，也不至于
              让人以为数据已经没了。 */}
          {broken.length > 0 && (
            <div className="ink-conflict-banner" role="alert" aria-label="打不开的文件">
              <strong>有 {broken.length} 个文件打不开</strong>
              <span>
                {[...new Set(broken.map((c) => KIND_LABEL[c.kind] ?? c.kind))].join('、')}
                里有读不出来的文件，<b>那几条现在不在界面上</b>——不是被删了，是这一份读不出来（多半是同步写到一半，或者手改时格式写坏了）。去数据目录看一眼那几个文件：修好格式它们就回来了，确认不要了再删掉。
              </span>
            </div>
          )}

          {conflicts.length > 0 && (
            <div className="ink-conflict-banner" role="alert" aria-label="同步冲突">
              <strong>同步冲突：{conflicts.length} 个文件</strong>
              <span>
                {[...new Set(conflicts.map((c) => KIND_LABEL[c.kind] ?? c.kind))].join('、')}
                里有同步客户端留下的冲突副本。<b>那几份改动没有进看板</b>——两台设备同时改了同一条时，同步软件会把其中一份另存成副本。去数据目录看一眼，自己决定留哪份、删掉另一份。
              </span>
            </div>
          )}

          {/* 离线记号（task-3-brief）：没连上桌面服务时常驻在主看板顶上。常驻
              不是 toast：这不是「刚发生的一件事」，是「现在正处在这个状态」，
              跟上面冲突横幅同一个考量。

              **文案对三种人都得成立**：配过地址、这会儿连不上的（飞行模式的
              手机）；从没配过、也不打算配的（就拿它当本地待办用）；以及
              base 恒为空串、自己的服务没跑起来的桌面用户（拥有者本人主要
              这么用）。所以开头不说「连不上服务端」——对后两种人那不是
              报错，是常态；说「没连上桌面服务」，陈述状态，不暗示出了故障。

              三条真实后果一条都不能少：看到的不是桌面那份最新的、这段时间的
              改动还没同步回去、随手记的东西要回到桌面才会被 AI 拆解——
              AGENTS.md 开头那句「你把它读走、拆成任务」靠的是桌面那台在跑的
              服务（`server/src/expand.ts`：起一个 `claude` 子进程，或者按设置
              调一个接口），手机上没有这回事，不说清楚的话用户会以为写了就跟
              平时一样等着被拆。

              **最后两句指路**（整分支审查 M2，桌面那半句是后续复审加的）：
              以前这条横幅只说「连不上」，不说该怎么办。base 空串这一个值
              同时对应两种完全不同的人——桌面上服务没起来的（该做的是把
              服务重新起起来）、手机上从没填过地址的（该做的是去填）——
              **不靠平台嗅探去分支**，两句话都说，桌面那句放前面（拥有者
              本人是主要用户）。手机填写地址的入口是设置弹层里的「服务
              地址」（`SettingsModal.tsx`，在 `settings` 为 null 的条件
              分支之外，离线时照样渲染）。**纯文字指路，不做成按钮**：
              `role="status"` 是 live region，往里塞交互元素不干净。地址
              长什么样也一并说了，不然「去填地址」等于让人去猜填什么。

              不用群青——群青是 AI 产出内容的配额，这条记号说的是「数据从哪
              来」，不是 AI 写的话，见 theme.css 里 .ink-offline-banner 上面
              的注释。 */}
          {offline && (
            <div className="ink-offline-banner" role="status" aria-label="离线">
              <strong>没连上桌面服务，现在看到的是这台设备上的本地数据</strong>
              <span>
                不是桌面那份最新的；这段时间做的改动还没同步回去；随手记的东西要等回到能连上桌面服务的时候，才会被 AI 拆解。在桌面上看到这条，该做的是把「办事师爷」服务重新起起来；在手机上看到这条，在「设置 → 服务地址」里填桌面那台电脑的地址，形如{' '}
                <code className="ink-mono">http://192.168.1.5:30035</code>
                （局域网 IP + 端口，不是 localhost）。
              </span>
            </div>
          )}

          {/* 通知权限记号（本地通知那一批）：跟上面离线记号同族——常驻不是
              toast（「权限没给」是持续状态，不是刚发生的一件事），石墨不是
              群青（说的是这台手机的系统权限，不是 AI 产出的内容）。
              只在原生壳里、且权限真的没拿到时出现：没拿到权限就是**一条提醒
              都不会响**，而这正是这个仓库反复在防的静默失败，设计正本第十一节
              写死了「要么明确说出来，要么就别装作提醒功能存在」。
              纯文字指路、不做成按钮：`role="status"` 是 live region，往里塞
              交互元素不干净（跟离线横幅同一条理由）。
              **最后一句只承诺做得到的事**（复审 Important）：这条记号是重排的
              返回值翻出来的，而重排只挂在 `tasks` 上——从系统设置页切回来不会
              让 `tasks` 变，也就不会重排：`web/src` 里零 `visibilitychange` /
              `appStateChange`（`@capacitor/app` 也没装），Capacitor 的
              `Bridge.onResume()` 只通知插件、不重载 WebView，而**授予**权限也
              不杀进程（撤销才会）。所以「回到这里记号自己就消失」是句做不到的
              话，改成说真话——跟上面 `.catch` 那条文案同一个说法。
              不为它加一个 resume 监听：要装新依赖、多一个接线点（28 次那个
              形状每多一处就多一分），换来的只是横幅早几秒消失。 */}
          {notifDenied && (
            <div className="ink-notif-banner" role="status" aria-label="通知权限">
              <strong>通知权限没开，到点手机不会响</strong>
              <span>
                提醒还好好地留在任务上，只是这台手机不会弹通知。去系统的「设置 → 应用 → 办事师爷 → 通知」里打开；打开之后改一条任务、或者重开应用，就会重新排上，这条记号也跟着消失。
              </span>
            </div>
          )}

          {dueTasks.slice(0, DUE_BANNERS).map((t) => (
            <Alert
              key={t.id}
              type="warning"
              showIcon
              closable
              message={`该做了：${t.title}`}
              description={t.notes || undefined}
              /* 提醒弹出来的那一刻，人想做的事就那么几件：现在就去做、做完了、
                 待会儿再说、知道了。

                 仿滴答清单的提醒弹窗。**它那边是四个**——「忽略」「开始专注」
                 「完成」「稍后提醒」（原文见《超强大的提醒功能》；
                 这段注释上一版写的是「完成 / 稍后提醒 / 忽略」三个，漏掉的正是
                 「开始专注」那一颗）。

                 这里摆三颗，「忽略」就是右边那颗 × ，不另摆一颗：

                 - **「去做」** 对应它那颗「开始专注」。这个应用的番茄钟长在任务
                   卡里（`TaskCard` 里那个 `FocusTimer`，而且带一把全局锁），
                   横幅里当场起一个计时器既不合适也不对——所以这一颗做的是把那条
                   任务打开，专注按钮就在那儿，一步之遥。
                 - 完成 / 稍后：**桌面版的原生通知早就有这两颗**
                   （`desktop/src/main.ts` 的协议激活）。

                 「去做」补的是同一个形状的另一处：**桌面通知点本体会打开那条任务**
                 （下面那个 `desktop-open-task` 事件 → `openTask`），而网页横幅在这
                 之前只能「完成」或「稍后」——想真去做它，得先把横幅关掉再自己去
                 找。同一条提醒在两个壳里能做的事不一样，没有道理，这句话上一版
                 就写在这儿，只是当时只兑现了一半。 */
              action={(
                <Space size={4}>
                  <Button
                    size="small"
                    onClick={() => {
                      patchOne(t.id, { status: 'done' });
                      dismissDue(t.id);
                    }}
                  >完成</Button>
                  {/* 分钟数读同一个常量，不写死。`desktop/src/notify.ts` 顶上
                      为这件事留了一整段注释（「按钮文案和实际改的提醒时间必须
                      读同一个常量」），桌面端照做了，网页端这一颗恰恰没有：
                      文案写死 10、改的却是 SNOOZE_MIN，改常量的人不会想到这里
                      还有一份，而按钮说的话会当场变成假的。 */}
                  {/* 走 `openTask` 而不是 `openDetail`：那个会先切到装得下任意
                      一条任务的去处（「全部」/「已完成」）再开面板，也会在任务
                      已经被删掉时说一声。桌面通知点本体走的是同一个函数。
                      顺手把横幅摘掉——面板已经开着那条任务了，横幅再堆在上面
                      是在挡自己。`dismissDue` 只摘横幅，不动任务也不动提醒。 */}
                  <Button
                    size="small"
                    onClick={() => {
                      openTask(t.id);
                      dismissDue(t.id);
                    }}
                  >去做</Button>
                  {/* 主按钮是第一档（十分钟），其余收在小箭头里——一个正在被
                      打断的人不该为「推多久」多做一次选择，而 10 分钟是绝大多数
                      情况要的那一下。三档的名单和文案都在 `lib/reschedule.ts`，
                      这儿不写死任何一个数（桌面端那颗按钮为「文案和实际偏移
                      必须读同一个常量」栽过一次，见 `desktop/src/notify.ts`）。 */}
                  <Space.Compact size="small">
                    <Button size="small" onClick={() => snoozeDue(t, SNOOZE_MIN)}>
                      稍后 {snoozeLabel(SNOOZE_MIN)}
                    </Button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: SNOOZE_CHOICES.filter((m) => m !== SNOOZE_MIN)
                          .map((m) => ({ key: String(m), label: `稍后 ${snoozeLabel(m)}` })),
                        onClick: ({ key }) => snoozeDue(t, Number(key)),
                      }}
                    >
                      <Button size="small" aria-label="换一个推迟时长">⌄</Button>
                    </Dropdown>
                  </Space.Compact>
                </Space>
              )}
              onClose={() => dismissDue(t.id)}
            />
          ))}
          {/* 摆不下的那几条收成一行。**不是为了好看**：开着应用出去半天，
              回来时八个横幅摔在最上面，看板整个被推出屏幕——而你想看的恰恰是看板。
              摄到三条（一屏看得完、又不至于把内容顶没），剩下的只报个数。

              那颗「全部知道了」**只在真的摆不下时才出现**：三条以内逐条点 ×
              本来就不费事，而一颗能一下子清掉十几条提醒的按钮常驻在那儿，误点
              的代价比它省的那几下大。它只把横幅摘掉，**不动任务也不动提醒**
              ——跟每条那颗 × 一样（`dismissDue`）。 */}
          {dueTasks.length > DUE_BANNERS && (
            <div className="ink-due-more" role="status">
              <span>还有 {dueTasks.length - DUE_BANNERS} 条到点了</span>
              <Button size="small" onClick={() => setDue([])}>全部知道了</Button>
            </div>
          )}

          {/* 排上了一次自动拆解：倒计时 + 「立即拆解」/「这次不拆」。跟下面的
              失败/完成横幅不共用——那几个是「结果」，这个是「即将发生的事」，
              文案和动作都不一样，硬塞进同一个 Alert 只会让 JSX 更难读。 */}
          {agent?.state === 'scheduled' && agent.at && (
            <ScheduledBanner
              at={agent.at}
              onRunNow={() => guard(() => api.expand())}
              onSkip={() => guard(() => api.expandSkip())}
            />
          )}

          {/* 拆解失败必须显眼——这个仓库已经栽过好几次静默失败：条目静静躺在收件箱里，
              用户以为在处理。跟到期提醒共用同一套 Alert 横幅，不另起一套机制。
              'skipped'（outbox 里的条目全都已经处理过、或者本来就没有要拆的、
              或者 AI 判断都不算任务，总之这次没有新增任务）是同一个道理：没出错，
              但也没有新卡片出现，用户一样得知道为什么——只是不该用「失败」这个词
              吓人，所以另起一档 warning。'ok' 之前完全不渲染：用户点了「立即拆解」
              等了 90 秒，跑完之后卡片确实出现了，但没有任何东西告诉他「结束了」，
              跟真的卡住长得一模一样。这里补一条一闪而过的绿色提示，不是警告，
              就是「办完了」。 */}
          {agent && (agent.state === 'failed' || agent.state === 'skipped' || agent.state === 'ok') && (
            <Alert
              type={agent.state === 'failed' ? 'error' : agent.state === 'skipped' ? 'warning' : 'success'}
              showIcon
              closable
              message={agent.state === 'failed' ? 'AI 拆解失败' : agent.state === 'skipped' ? '没有新增任务' : 'AI 拆解完成'}
              description={agent.message}
              onClose={() => setAgent(null)}
            />
          )}

          {/* 手机宽度下这一行必须堆叠，而不是被两栏网格的内容最小宽度撑破——
              见计划文档「实施后的修正」表里 Row/Col 那一行。用 antd 的响应式 Row/Col
              代替裸 CSS grid：md 以下堆叠成一列，md 以上恢复成侧栏+看板两栏。
              侧栏用 flex（不是 span）钉死在 280px——span=7 会随窗口变宽跟着变宽，
              跟原设计 minmax(220px,280px) 的「侧栏封顶、看板吃掉剩下空间」不是一回事。
              看板列 flex: '1 1 0%' 吃满剩余宽度，两栏之间不会露出空隙——这个值
              不是 'auto'，见下面 Col 上的注释：TaskBoard 按来源分组重做之后卡片
              内容变宽，'auto' 的 flex-basis 会在真实窗口宽度下把这一列挤到
              侧栏下面去，这是 pass 2 上线后才暴露的真实回归，不是本来就有的。
              手机宽度下两栏堆叠成一列时，视觉顺序跟这里的 JSX 书写顺序一致——
              导航（含随手记）在前、看板在后。曾经这里靠 .ink-rail-col/
              .ink-board-col 在 theme.css 里的 order 规则把顺序反过来（任务在前、
              导航在后），那是左栏还装着收件箱输入框时的取舍；现在左栏装的是
              导航，反转会把它和随手记埋在整份任务列表底下，理由不再成立，
              order 规则已经去掉，见 theme.css 里 .ink-rail-col 那段注释。

              align="stretch"（不是 antd 默认的 "top"）：两栏拉齐到较高那一栏
              的高度，侧栏（通常比任务列表矮）会被撑到跟看板一样高——
              .ink-nav-composer 的 margin-top: auto 就是靠这个才有余量可分，
              把随手记推到侧栏视觉上的底部，见 theme.css 里那条规则的注释。
              "top" 时侧栏的 Col 高度恒等于自己内容高度，没有多余空间，
              margin-top: auto 实测 computed 值恒为 0px。 */}
          {/* gutter 从 24 收到 12：24 那会儿模块栏边缘到侧栏第一个字有 32px
              （24 的一半 + 列自己的 12px 内边距），在这套本来就疏朗的排版里
              是一道白带。竖向那个 24 留着——行与行之间不嫌松。 */}
          {/* **`wrap` 由 Row 自己关，不写一条 CSS 去盖它。**
              antd 的 `.ant-row` 带着 `flex-flow: row wrap`，写一条同名同特异度的
              `.ink-cols { flex-wrap: nowrap }` 去压它，赢的只是「谁的样式表注入得
              晚」——今天赢是因为 antd 的 cssinjs 用 `:where()`（零特异度）且 prepend
              到 head 顶上。换个 StyleProvider、开 hashPriority='high'、上 SSR 抽取、
              或者哪次升级改了注入顺序，换行就悄悄回来了：详情掉到第二行、任务列表
              被顶出屏幕外，正是这一批要修的那个 1024px 故障，而三条测试全绿因为它们
              只读 CSS 文本。`wrap={false}` 走的是 antd 自己那个 `-no-wrap` 类，没有
              这场比赛。

              窄屏要留着换行：`xs={24}` 的堆叠正是靠它实现的。 */}
          <Row gutter={[12, 24]} align="stretch" wrap={isNarrow} className="ink-cols">
            {/* **三栏的 `min-width` 现在全在 theme.css 里**，不再有内联的那一份。
                不加它的话，flex 子项的自动最小宽度默认是「内容的 min-content 尺寸」，
                一段不带空格的长文本（比如粘一段 URL 进收件箱）会把这个 Col 的自动
                最小宽度顶到 500px+，压过 flex-basis 定的 280px：这一列不再收缩，
                任务列表被挤没了宽度、卡片被压扁。

                搬去 CSS 是因为宽屏下要的不是 0 而是**各自的下限**（200 / 380 / 300），
                而内联样式压过样式表、写不出两档。 */}
            {/* 清单侧栏。**切到「习惯」这类模块时整条不渲染**——判据在
                lib/views.tsx 的 NO_SIDEBAR_GROUP，理由也在那儿。 */}
            {inTaskModule && (
            <NavShell
              narrow={isNarrow}
              open={navOpen}
              onClose={() => setNavOpen(false)}
              width={navWidth}
              onResize={(w) => { setNavWidth(w); try { localStorage.setItem(NAV_WIDTH_KEY, String(w)); } catch { /* 隐私模式下写不了，宽度就只活这一次 */ } }}
            >
              <Sidebar
                viewDefs={navDefs}
                current={view}
                onSelect={(v) => { setNavOpen(false); navigate(v); }}
                tasks={tasks}
                insights={insights}
                inbox={inbox}
                now={now}
                lists={lists}
                onAddList={(name) => guard(async () => {
                  // 颜色从调色盘里按现有清单数轮着取——不用管理一份「用到哪个
                  // 颜色了」的状态，清单数本身就是够用的轮转指针。
                  await api.addList(name, LIST_COLORS[lists.length % LIST_COLORS.length].hex);
                })}
                onRenameTag={renameTag}
                onDeleteTag={askDeleteTag}
                onRenameList={(id, name) => guard(() => api.patchList(id, { name }))}
                // 「让 AI 回顾这份清单」。**跟「回顾」那一屏那颗按钮是同一条链路**，
                // 只多带一个 listId——服务端共用同一把单飞锁，所以正在跑的时候点它
                // 会拿到 409，`guard` 会把那句话原样摆出来（「上一次拆解还在跑」），
                // 那正是此刻该说的实话，不用在这儿再判一次。
                onReviewList={(l) => guard(async () => {
                  await api.review(l.id);
                  void message.success(`已经让 AI 去回顾「${l.name}」了`);
                })}
                onArchiveList={(id, archived) => guard(async () => {
                  const l = lists.find((x) => x.id === id);
                  await api.patchList(id, { archived });
                  // 归档的清单从上面那份列表里消失（挪到「已归档」那一组）。
                  // 正站在它上面的话退回「全部」——不退的话页面停在一个
                  // 侧栏里已经找不到的去处上。
                  if (archived && view === `list:${id}`) navigate('all');
                  // **里面那些任务会怎样，得说一声**：删清单的确认框写得清清楚楚
                  // （「里面那 12 条不会被删」），而它顺手推荐的「归档」这条路
                  // 一直一声不吭——那些任务照旧留在「全部」「今天」里。判据和
                  // 措辞在 lib/archiveNote.ts。停六秒，跟撤销那条一样：一句要
                  // 读完才有用的话，默认三秒不够。
                  const note = archived && l ? archiveNote(l, tasks) : null;
                  if (note) void message.info({ content: note, duration: 6 });
                })}
                onDeleteList={askDeleteList}
                onRecolorList={(id, color) => guard(() => api.patchList(id, { color }))}
                folders={folders}
                onAddFolder={(name) => guard(() => api.addFolder(name))}
                onRenameFolder={(id, name) => guard(() => api.patchFolder(id, { name }))}
                onDeleteFolder={askDeleteFolder}
                onMoveListToFolder={(id, folderId) => guard(() => api.patchList(id, { folderId }))}
                onEditListFilter={(l) => {
                  setEditingFilterList(l);
                  // **`normalizeFilter` 不是 `?? emptyFilter()`**：后者只挡得住
                  // `filter` 整个是 `null`，挡不住「少一个字段」——而那正是这一层
                  // 要防的东西（`smartFilter.ts` 那段注释写着威胁模型：手改、
                  // 旧版本存下来的、同步过来的半截文件；服务端的 `checkSmartFilter`
                  // 只拦得住经过 API 写进来的）。
                  //
                  // 那一批修的是「三个消费点」（`describeFilter` 和 `smartFilter`
                  // 里那两个），**这里是漏掉的第四个**。而它偏偏是**修复路径**：
                  // 一份坏掉的智能清单，人自然会来点「编辑筛选条件」重存一次，
                  // 这儿崩了就只剩手改 JSON 一条路。
                  // （`FilterBar` 里 `[...group.listIds, NO_LIST]` 那种展开，
                  // 遇上 `noList: true` 而 `listIds` 缺失就当场抛。）
                  setFilterDraft(normalizeFilter(l.filter));
                }}
                onReorder={(what, patches) => guard(async () => {
                  // **顺序发，不 Promise.all**：清单和文件夹各自是一个文件，
                  // N 条并发 PATCH 就是 N 次读-改-写同一份，最后一个赢——这正是
                  // 「今天」的手动排序当初专门开一条批量路由要避开的那件事
                  // （server/src/app.ts 的 /api/tasks/reorder 顶上写着）。
                  // 这里一次最多两条（换位置），顺序发的代价可以忽略，不值得
                  // 为它再开一条批量路由。
                  for (const p of patches) {
                    if (what === 'list') await api.patchList(p.id, { order: p.order });
                    else await api.patchFolder(p.id, { order: p.order });
                  }
                })}
                // 搜索那两个 prop 没了——搜索框搬去了竖栏上的弹层（SearchModal）。
                // 「想到什么写什么，不用整理」的占位符还在 InboxComposer 里，
                // 见那个组件自己的注释。不经 guard()：失败要把输入框和草稿
                // 留着，让 InboxComposer 自己的 catch 去处理——跟 InboxSidebar
                // 的 onEditText 是同一条道理，guard() 会把 reject 吞掉，
                // InboxComposer 就会误以为存成功了，把刚打的字清空。
                // **窄屏下这里给 null**：随手记不进抽屉，它摆到任务列表下面去
                // 了（下面 .ink-narrow-composer 那一段）。「随手记的成本不能变高」
                // 是这个产品的硬约束，藏进一个要先点开的抽屉正是把成本抬高。
                composer={isNarrow ? null : composer}
              />
            </NavShell>
            )}
            {/* flex: '1 1 0%'，不是 'auto'——antd Col 的 parseFlex() 把字符串
                'auto' 转成 CSS `flex: 1 1 auto`，flex-basis: auto 意味着换行
                前的「假设尺寸」要现测内容有多宽：TaskBoard 里任务卡的标题、
                aiComment 这类不定长文本撑出的固有宽度（实测能到 1700px+）
                一旦超过侧栏让出的剩余空间，Row 的 flex-wrap 就会把整列换到
                侧栏下面，而不是把它压缩到剩余宽度——这跟内容多宽无关，纯粹
                是 flex-basis:auto 用「内容多宽」当基准这一步就已经错了。
                写成裸字符串 '1 1 0%'（不是 'auto'/数字，parseFlex 遇到这种
                原样透传）让 flex-basis 从 0 起算，宽度完全由 flex-grow 按
                剩余空间分配，不再看内容一眼——这是「让 flex 子项吃满剩余
                空间」的标准写法，从根上避开这一类基准测量。minWidth: 0 是
                第二道保险：万一某处子内容仍然有 min-content 下限，shrink
                阶段也不会被那个下限卡住。

                **`minWidth` 从内联搬去了 theme.css**：内联样式压过样式表，而宽屏
                下这一栏需要的是一个**下限**（别被拖宽的另外两栏挤没），不是 0。
                窄屏那一档仍然是 0，两档在 theme.css 里分开写，见那边的注释。 */}
            {/* `id` + `tabIndex` 是给顶上那颗「跳到任务列表」当落点的，见
                `.ink-skip` 那段。`tabIndex={-1}` 只让它**能被脚本聚焦**，不进
                Tab 序列——这一栏本身不是一个可操作的控件。 */}
            <Col xs={24} md={{ flex: '1 1 0%' }} className="ink-board-col" id="ink-tasks" tabIndex={-1}>
              <div className="ink-view-bar">
                {/* 窄屏下清单侧栏收进抽屉（NavShell），这是打开它的那颗。
                    摆在标题左边——手机上「打开导航」惯常就在这个位置，而且
                    它跟标题是一件事：「现在在哪儿、想去哪儿」。宽屏不出现，
                    那边侧栏一直摆着。 */}
                {inTaskModule && isNarrow && (
                  <button
                    type="button"
                    className="ink-view-nav"
                    aria-label="打开清单侧栏"
                    aria-expanded={navOpen}
                    onClick={() => setNavOpen(true)}
                  >☰</button>
                )}
                {/* 用上面那个 `pageTitle`，不再单独调一次 `viewTitle()`：
                    标签页标题读的就是它，两处各算一遍迟早会各说各话——而
                    `lib/pageTitle.ts` 存在的意义正是「屏幕上和标签页上是同
                    一句话」。 */}
                <h1 className="ink-view-title">{pageTitle}</h1>
                <div className="ink-view-actions">
                  {/* AI 那边挂着多少东西。原来在顶栏右边，顶栏删掉之后挪到这儿
                              ——三句全是「有才说」，大部分时间这一整块不渲染。 */}
                          <div className="ink-header-status">
                  {agent?.state === 'running' && <span>AI 拆解中……</span>}
          {/* 0 的时候整句不渲染，跟侧栏导航「计数为 0 不渲染数字」同一条规矩
                      （Sidebar.tsx 的 `count ? … : null`）：一个常驻的「收件箱 0 条
                      待拆解」是噪音，而且收件箱本来就大部分时间是空的——那才是正常
                      状态，不需要每一屏都汇报一次。下面「AI 建议 N 条待确认」从一开始
                      就是这么写的（`proposals.length > 0 &&`），这里补齐。 */}
                  {pendingInboxCount > 0 && <span>收件箱 <b>{pendingInboxCount}</b> 条待拆解</span>}
          {/* 建议只渲染在各自的任务卡里，而那张卡很可能不在「今天」——回顾专挑
                      「在 doing 里躺很久的」，那种任务多半没有时间字段、进不了今天视图。
                      横幅说「在对应的任务卡上等你确认」，人却在默认视图上什么也看不到，
                      而且横幅关掉就再没有任何线索了。这里给一个常驻的计数，跟收件箱
                      那个同一个位置、同一个作用：告诉你 AI 那边还有多少东西挂着。
                      数字用群青——它数的是 AI 产出的东西，跟收件箱那个计数同一个语义。 */}
                  {proposals.length > 0 && <span>AI 建议 <b>{proposals.length}</b> 条待确认</span>}
          {/* 「设置」沉到最左那条竖栏底下了（Rail.tsx），不在这儿。 */}
                </div>

                  {/* 行/卡密度开关，只在「可切」的那几个视图出现（DENSITY_VIEWS/
                      canToggleDensity 的注释）——纯 CSS 两颗按钮，不用 antd：
                      跟 TaskRow.tsx 同一个选择，绕开 antd 组件选中色直接读全局
                      colorPrimary（群青）那个已知盲区，这个控件也不该借群青——
                      密度是人这一侧的偏好，不是 AI 产出的内容。 */}
                  {/* **列表 / 看板**（仿滴答清单：它那边「看板」不在功能模块栏
                      上，而在每份清单的「视图」一栏里，跟「列表」「时间轴」并排）。
                      同一批任务换个摆法，不是换一个去处——理由整段在
                      lib/listMode.ts。样式跟密度开关共用一套，它俩是同一类东西
                      （「这一屏怎么摆」的本机偏好），不该长两个样。 */}
                  {canToggleListMode && (
                    <div className="ink-density-switch" role="group" aria-label="视图">
                      <button
                        type="button"
                        className={`ink-density-btn${listMode === 'list' ? ' ink-density-btn-active' : ''}`}
                        aria-pressed={listMode === 'list'}
                        onClick={() => changeListMode('list')}
                      >列表</button>
                      <button
                        type="button"
                        className={`ink-density-btn${listMode === 'board' ? ' ink-density-btn-active' : ''}`}
                        aria-pressed={listMode === 'board'}
                        onClick={() => changeListMode('board')}
                      >看板</button>
                    </div>
                  )}
                  {/* 看板模式下不出行/卡：那几列固定是行档（一列 217px 摆不下
                      卡片），开关摆在那儿点了不会有任何变化。

                      **判据要连 `canToggleListMode` 一起看**：`listMode` 是一份
                      全局偏好，在「全部」上切成看板之后它就一直是 `board`——只看
                      它的话，「今天」上的行/卡开关会跟着消失，而那一屏压根没有
                      看板可切。实测过一次：切完看板再回今天，行/卡就没了。 */}
                  {canToggleDensity && !(canToggleListMode && listMode === 'board') && (
                    <div className="ink-density-switch" role="group" aria-label="密度">
                      <button
                        type="button"
                        className={`ink-density-btn${density === 'row' ? ' ink-density-btn-active' : ''}`}
                        aria-pressed={density === 'row'}
                        onClick={() => toggleDensity('row')}
                      >行</button>
                      <button
                        type="button"
                        className={`ink-density-btn${density === 'card' ? ' ink-density-btn-active' : ''}`}
                        aria-pressed={density === 'card'}
                        onClick={() => toggleDensity('card')}
                      >卡</button>
                    </div>
                  )}
                  {/* **「新任务」这颗按钮删了。** 滴答清单文档里桌面版加任务只有
                      一个地方：「在任务列表页顶部的『任务添加栏』输入内容，按回车
                      键即创建成功」，附加选项挂在**输入框右侧**。这里跟着改成
                      同一个形状——那张完整表单的入口挪进了 QuickAdd 那一行的右端。
                      `C` 键和命令面板里那条照旧通向它，没有变。 */}
                </div>
              </div>

              {/* 这一屏没有加任务行的时候（日历、四象限、习惯……）表单画在这儿。
                  有加任务行的去处，表单跟在那一行后面展开，见 `quickAdd`——
                  `C` 键和命令面板在两种去处上都开得出它。 */}
              {!canQuickAdd(view) && composerNode}

              {/* 「今天」和「按来源」没有筛选/分组那两条，这一行直接画在视图
                  标题下面。别的去处的那一行在 withFilterBar 里，见
                  QUICKADD_AT_TOP。 */}
              {QUICKADD_AT_TOP.has(view) && quickAdd}

              {/* 侧栏「清单」「标签」两组导航项点出来的 key（'list:xxx'/'tag:xxx'）
                  在 registry 里找不到对应项——它们是运行时才知道数量的动态去处，
                  塞不进那张静态表，见 lib/views.tsx「为什么动态 key 不进
                  VIEW_SPECS」那段说明。渲染交给 lib/scoped.ts 的
                  scopedSections：清单和标签用的是同一个 TaskGrid，区别只在
                  谓词，一条回退分支就够，不用为每个清单/标签各注册一项。
                  不 keepMounted：切到另一个清单/标签本来就该重新算「未完成/
                  已完成」两组，没有跨清单/标签要保的本地状态。

                  **key={view} 不能省。** 这一段只有一个 <section>/<TaskGrid>
                  实例服务所有 list:xxx/tag:xxx，元素类型和在树里的位置从不
                  变——没有 key 的话，从 list:L1 切到 list:L2，React 认为
                  还是「同一个」TaskGrid，不会卸载重挂，它内部的 editingIds/
                  home（钉住正在编辑的卡回它原来那一组）会带着上一个清单的
                  痕迹活到下一个清单：正在编辑的那个 id 被 scopedSections 的
                  `keep` OR 进新清单的结果里，变成一张「别的清单的卡，长在
                  这个清单顶上，标题还被编辑框吃掉认不出是哪张卡」的鬼畜卡片。
                  给 key，视图一换 React 直接卸载重挂整棵子树，state 归零，
                  跟注册表那几个视图各自 `<section key={v.key}>` 是同一个
                  道理——只是那边靠 key 本来就不同的静态项拿到这层保护，
                  这里数量不定的动态 key 得自己显式写。 */}
              {!findSpec(view) && (
                <section key={view} className="ink-view-panel ink-view-panel-scoped" aria-label={viewTitle()}>
                  <BoardErrorBoundary>
                    {scopedSections(tasks, view, now, new Set(), lists) ? (
                      // 筛选栏也接到这条回退分支——task-3-brief 要点①。智能
                      // 清单自己的 filter 已经在 scopedSections 内部分叉过
                      // 一次（见那个函数顶部的注释），这里叠的是筛选栏当前
                      // 选的那份，两层筛选各管各的，不冲突：一个智能清单就是
                      // 「存下来的查询」，筛选栏在它之上再收窄，跟在普通清单
                      // 上再收窄是同一件事。
                      withFilterBar(
                        (editing) => scopedSections(tasks, view, now, editing, lists)!,
                        // 清单/标签这一屏的空状态。**不用上面那句
                        // `EMPTY_NO_TASKS`**：那句说的是「你一条任务都还没
                        // 有」，而站在一个空清单里，别的清单可能满满当当——
                        // 说错了话比不说更糟。这句只说这一屏的事，并把下一步
                        // 指向就在上面的那行输入。
                        (sections, emptyFiltered) => (
                          <TaskGrid
                            {...gridWiring}
                            density={density}
                            sections={sections}
                            empty="这儿还空着。上面那行写一句，就归到这里。"
                            emptyFiltered={emptyFiltered}
                          />
                        ),
                        { groupable: true },
                      )
                    ) : (
                      // 既不在注册表里、又不是 list:/tag: 的 key。正常操作到不了
                      // 这里（导航上没有这样的入口），但 view 是个自由的
                      // string，兜住它比渲染一片空白强——空白正是这个仓库
                      // 那条「写成功了但界面看上去什么也没发生」的形状。
                      //
                      // **这儿不重复标题那句。** 标题现在也说「没有这个去处」
                      // 了（`viewTitle()` 的兜底），同一句话在一屏上写两遍是
                      // 噪音；空状态该说的是下一步，不是把坏消息说第二遍。
                      //
                      // **但不指认某一个控件**——跟 `EMPTY_NO_TASKS` 上面那段
                      // 同一条规矩，而且这句话第一版就踩了：写的是「从左边挑一个
                      // 去处」，而窄屏（≤767px）上那条侧栏根本不在文档流里，整条
                      // 收进了 ☰ 后面的抽屉。屏幕上说一句做不到的话，比只报告
                      // 「没有」更糟。
                      <p className="ink-empty-note">
                        这个地址多半来自一个旧书签，或者那份清单已经删了。换一个去处就行。
                      </p>
                    )}
                  </BoardErrorBoundary>
                </section>
              )}

              {/* keepMounted 的视图一直挂在树上，用原生 hidden 藏起来；其余的
                  按需渲染。理由见 lib/views.tsx 里 keepMounted 那段注释——简单说
                  是 editingIds 那层保护和各自独立的错误边界，两样都靠「不卸载」
                  才成立。hidden 是原生属性，不在可访问树和 Tab 顺序里，对用户和
                  屏幕阅读器的效果跟卸载一样，区别只在 React 组件状态被留住了。 */}
              {registry.filter((v) => v.keepMounted || v.key === view).map((v) => (
                <section
                  key={v.key}
                  className={`ink-view-panel ink-view-panel-${v.key}`}
                  aria-label={v.label}
                  hidden={v.key !== view}
                >
                  <BoardErrorBoundary>
                    {v.render()}
                  </BoardErrorBoundary>
                </section>
              ))}

              {/* 回顾这个功能的入口只在设置弹层底部，要滚一段才看得到——发现性
                  太弱。这里在**它真的能帮上忙的时候**补一句，两个条件都要满足：
                  1) 确实有过期没做完的任务（看板空着、或者一切正常的时候提
                     「让 AI 回顾一遍」是废话，回顾什么呢）
                  2) 手上没有还没处理的提议（上一轮提的你都还没看，再催一轮
                     只会堆成两份意见，跟 workflows/review.md 里让 AI 跳过
                     已有待决提议的任务是同一个道理）
                  **这里仍然不是那颗按钮，是去按钮那儿的路标。** 按钮在回顾那一屏
                  （ReviewView 的 runBlock），这条脚注渲染在所有视图外面、贴着看板
                  末尾——把一颗会花一两分钟和一次 AI 额度的按钮摆在人正在滚动的
                  列表底下，是把它放在了最容易被顺手点到的地方。两级：这儿说明
                  「有这么条路」，切过去才看得到那颗按钮和它的说明。 */}
              {/* 3) **回顾视图正在自己说这句话**的时候才闭嘴，不是「只要人在回顾
                     视图上」就闭嘴。这条脚注渲染在所有视图外面（Col 底部），所以在
                     回顾视图里也会出现——而那个视图的空状态说的是同一件事
                     （ReviewView.tsx：「还没有回顾。在这个文件夹里敲 /review，让 AI
                     回头看一遍现有任务……」，跟这条脚注同一批改的），两句隔着几十
                     像素上下摆着，一句话说了两遍。
                     但那个空状态**只在没有未处理的观察时**才渲染：回顾视图上已经
                     摆着上一轮的观察、同时又攒了过期任务的时候，一句 `view !== 'review'`
                     会把脚注也挡掉，「怎么再跑一次」在那一屏上一个出口都不剩（只剩
                     设置弹层底部那份，正是上面说的「发现性太弱」那条路）。所以判据
                     是「那边这一刻显示的是不是空状态」，跟 ReviewView 共用
                     `openInsights()` 算。**那条判据现在退役了**：加了「这一周该
                     过一遍的」之后它永远为假——这条脚注只在有过期任务时才出现，
                     而有过期任务就意味着清单里有「N 条已经过期」那一行，那一屏
                     就不是空的。所以「怎么再跑一遍」这件事收进了 ReviewView 自己
                     （常驻的 `runBlock`，现在是一颗按钮），这里干脆在那一屏整个
                     闭嘴：两句话说同一件事的问题也一并没了。

                     下面那句**整句不断行**：JSX 把文本里的换行 + 缩进折成一个半角
                     空格，原来断在「建议：」后面，渲染出来就是「…的建议： 在这个
                     文件夹里敲」——中文全角冒号后面凭空多一个空格。跟 ReviewView
                     那句空状态同一个坑、同一批改动，那边修了这边漏了。 */}
              {staleCount > 0 && proposals.length === 0
                && view !== 'review' && (
                <p className="ink-review-nudge">
                  有 {staleCount} 条已经过期了。<button type="button" className="ink-review-link" onClick={() => navigate('review')}>去回顾</button>那一屏，一颗按钮就能让 AI 回头看一遍、提点建议。
                </p>
              )}
              {/* 随手记。**窄屏专属的位置**：宽屏它在侧栏底下，而窄屏侧栏
                  整条收进了抽屉，藏进去等于把「随手记的成本」抬高——那是这个
                  产品的硬约束。摆在任务列表下面，顺序就成了「今天要做什么 →
                  想到什么随手写 → 去别处看看（抽屉）」，正是手机上这三件事的
                  频次顺序。

                  **它跟着整页滚，所以列表一长就在首屏之外。** 390×844 上实测
                  （「今天」，卡片档）：1 条任务时框顶 y=549 还在首屏，**3 条就
                  掉出去了**（y=845），12 条要往下滚 1.8 屏，15 条 2.3 屏。
                  桌面那次同样的事（看板把它顶到折线以下）是靠侧栏自己滚解决的，
                  这边没有那个结构。

                  **仍然维持现状，理由是量过之后的三条：**
                  ① 顶上那条「添加任务」是钉住的、永远 1 次点击，多数捕获它就
                     接得住（日期/标签/`@情境` 都认）；随手记要的是「还说不成
                     一件事」的那类文字，本来就少一些；
                  ② 抽屉那条路还在——☰ → 收件箱，**恒定 2 次点击**，比滚 2.3 屏
                     便宜。上面那句「藏进抽屉等于抬高成本」说的是「只留抽屉这
                     一条」，不是说它不存在；
                  ③ 任何「常驻可见」的做法都要永久吃掉这块屏：实测它高 171px
                     ＝ 20%，把标题和多行框压到最扁也还有 126px ＝ 15%。
                     （`position: sticky` 在这儿还直接不生效——它是这一列的最后
                     一个孩子，粘性区间为零；桌面那份能用是因为上面有
                     `margin-top: auto` 撑出的空间。）

                  也就是说这不是「没想到」，是**量过之后认下的代价**。真要改，
                  得先决定拿 15% 的屏换什么。 */}
              {inTaskModule && isNarrow && <div className="ink-narrow-composer">{composer}</div>}
            </Col>
            {/* 第三栏：详情面板（仿滴答清单）。**只在真的打开了一条任务时
                才存在**——空着的一栏会白占三百像素，而这一屏本来就把正文收在
                `--measure` 以内、右边留着空白，那正是它的位置。

                `xs={24}`：窄屏上它会换行掉到列表下面，看着像"点了没反应"
                （得往下滚才看得见）。所以窄屏那一档在 CSS 里改成整屏浮层，
                见 theme.css 的 `.ink-detail-col`。

                接线整份来自 `cardWiring`，跟列表里的卡片是同一份，见那儿的
                注释。**`onEditingChange` 是个空函数**：那个回调存在的意义是
                「筛选把这张卡滤掉时别把它连草稿一起卸载」（TaskCard.tsx 那条
                prop 的注释），而这一栏根本不经过筛选——它按 id 现查，谁也滤
                不掉它。 */}
            {/* 换模块时这一栏会被收起来（上面那个 effect），但**不按模块挡渲染**
                ——四象限、日历里点开一条任务照样要看得到它的详情。挡渲染试过一版，
                代价是那两个视图里的任务从此打不开了。 */}
            {/* `0 1`，不是 `0 0`——**shrink 留成 1**：两栏都拖到最宽时总宽会超过
                窗口，shrink 是 0 的话谁都不肯让，最后全压在看板那一栏上（实测
                1280 上看板只剩 88px、内容横向溢出）。留成 1 之后空间不够时是这两栏
                各让一点，而看板有自己的下限守着，见 theme.css 里 .ink-cols 那段。 */}
            {detailTask && (
              <Col xs={24} md={{ flex: `0 1 ${detailWidth}px` }} className="ink-detail-col">
                {/* 界线贴在这一列的**左**缘（详情在最右边），所以往右拖是把它拖窄。
                    **判据是 `isTight`（< 1000）不是 `isNarrow`（< 768）**：放不下三栏
                    时这一栏是盖在整屏上的浮层（.ink-detail-col 的 position: fixed），
                    没有「这一列多宽」这回事，画一条骑在浮层边上、拖了什么都不会发生
                    的线比不画更糟。 */}
                {!isTight && (
                  <ColGrip
                    width={detailWidth}
                    min={DETAIL_MIN}
                    max={DETAIL_MAX}
                    side="left"
                    label="拖动改变任务详情栏的宽度"
                    onResize={(w) => {
                      setDetailWidth(w);
                      try { localStorage.setItem(DETAIL_WIDTH_KEY, String(w)); } catch { /* 隐私模式下写不了，宽度就只活这一次 */ }
                    }}
                  />
                )}
                <TaskDetail
                  {...cardWiring}
                  // key 换一条任务就重挂一次。**`autoEdit` 靠这一下才成立**：
                  // 它是「从假变真那一刻进编辑态」（TaskCard.tsx 那条 prop 的
                  // 注释），不重挂的话，看着 A 再点带「编辑」意图的 B，那个
                  // 布尔值一直是 true、没有变化，B 只会停在查看态。顺带把卡片
                  // 自己那份 draft 归零，换一条任务不带着上一条的编辑痕迹
                  // （真要改到一半跑了也不丢：草稿另有一份 draftStash）。
                  key={detail!.id}
                  t={detailTask}
                  autoEdit={detail!.edit}
                  onEditingChange={() => {}}
                  onClose={() => setDetail(null)}
                />
              </Col>
            )}
          </Row>
        </div>
      </main>
      </div>

      {/* 批量操作条——选中至少一张才出现，`count===0` 时组件自己返回 null
          （见 BatchBar.tsx），不用在这里另外判断要不要渲染它。放在
          Row/Col/Space 外面：它是 `position: fixed`（theme.css 的
          .ink-batch-bar），不占任何布局位置，摆哪里都不影响别处，跟
          SettingsModal/CommandPalette 这两个同样「弹出层」性质的组件放在
          一起比嵌进内容区域更说得清楚它是什么。 */}
      {/* 搜索弹层。跟 BatchBar/SettingsModal/CommandPalette 放在一起：它们
          都是浮在版面之上的东西，不占任何布局位置。 */}
      <SearchModal
        open={searching}
        onClose={() => setSearching(false)}
        query={query}
        onQuery={setQuery}
        // 已经按 query 筛过的那一批，跟「搜索」那个去处用的是同一份
        // `searchTasks`（上面的 `hits`），不在弹层里另算一遍。
        hits={hits}
        // 分空态的档用：一条任务都没有时，「没有匹配的任务」是句误导。
        hasAnyTask={tasks.length > 0}
        now={now}
        lists={lists}
        // 点中一条：切到装得下它的那个去处 + 摊在详情面板里，跟回顾里点
        // 关联任务、桌面通知点开那一条走的是同一个 `openTask`。
        onOpen={openTask}
        onSeeAll={() => navigate('search')}
      />
      <BatchBar
        count={selection.ids.size}
        lists={lists}
        onChangeStatus={batchStatus}
        onChangeList={(listId) => guard(async () => {
          await api.patchTasks([...selectionRef.current.ids], { listId });
          clearSelection();
        })}
        // 「加标签」走不了上面那种「一份 patch 套所有选中的」的路：选中的任务
        // 各自已有的 tags 通常不一样，用同一个数组覆盖所有人会把没打算动的旧
        // 标签冲掉。**但它也不该退回「每条各发一条 patchTask」**——那是 N 轮
        // 目录监听器 + N 轮 SSE 广播，选 20 张就是 20 轮。`patchTasksEach`
        // 就是为这种「批量、但每条各改各的」开的：客户端算好每条自己的新数组，
        // 一次请求发上去（这条以前真的是 N 次并发 patchTask，加了那个端点
        // 之后一起收掉了）。
        onAddTag={(tagName) => guard(async () => {
          const patches = [...selectionRef.current.ids]
            .map((id) => tasks.find((x) => x.id === id))
            .filter((t): t is Task => t !== undefined && !t.tags.includes(tagName))
            .map((t) => ({ id: t.id, patch: { tags: [...t.tags, tagName] } }));
          // 选中的全都已经有这个标签了：一次请求都不发，也不清选中——什么都
          // 没发生的时候把选中态清掉，看着像「点了但没生效」。
          if (patches.length === 0) return;
          await api.patchTasksEach(patches);
          clearSelection();
        })}
        onChangePriority={(priority) => guard(async () => {
          await api.patchTasks([...selectionRef.current.ids], { priority });
          clearSelection();
        })}
        onChangeContext={(context) => guard(async () => {
          await api.patchTasks([...selectionRef.current.ids], { context });
          clearSelection();
        })}
        // 批量改期 / 推迟一小时（仿滴答清单）。两个都是**每条各改各的**：
        // 「原来几点还是几点」和「各自往后挪一小时」算出来的时刻逐条不同，
        // 一份共享 patch 表达不了，走 patchTasksEach。判据在 lib/reschedule.ts，
        // 跟卡片 ⋯ 里那组「改期」是同一个纯函数，不另写一套。
        onReschedule={batchReschedule}
        onPostpone={batchPostpone}
        onDelete={confirmBatchDelete}
        onClear={clearSelection}
      />

      {/* 「编辑筛选条件」的弹窗（仿滴答清单：智能清单建完还能改）。
          **复用同一个 FilterBar**，不另写一份七维表单——两份控件迟早会在
          「哪几个维度、每个维度有哪些档」上长歪，而它本来就是个受控组件。
          `onSaveAsList` 不传：在「编辑这一份」的弹窗里再放一颗「存成新的」
          是两个动作挤在一处。
          局部 ConfigProvider 压 colorPrimary，理由同下面那个弹窗。 */}
      <ConfigProvider theme={boardLocalTheme}>
        <Modal
          title={`编辑「${editingFilterList?.name ?? ''}」的筛选条件`}
          open={editingFilterList !== null}
          onOk={() => void submitEditFilter()}
          onCancel={() => setEditingFilterList(null)}
          confirmLoading={filterSaveBusy}
          okText="保存筛选条件"
          cancelText="取消"
          // 空筛选存不得：一份什么都不筛的智能清单等于「全部」，而它会顶着
          // 一个具体的名字待在侧栏里，点进去看到的东西跟名字对不上。
          okButtonProps={{ disabled: isFilterEmpty(filterDraft) }}
          destroyOnHidden
        >
          <FilterBar
            filter={filterDraft}
            onChange={setFilterDraft}
            lists={lists}
            allTags={tagList}
            // 现算「改成这样会匹配几条」——这是编辑筛选时唯一真正想知道的事，
            // 而它不用等保存。
            matched={applyFilter(tasks, filterDraft, now).length}
            total={tasks.length}
          />
        </Modal>
      </ConfigProvider>

      {/* 「存成智能清单」的命名弹窗——见 openSaveAsList/submitSaveAsList 定义
          处的注释。局部 ConfigProvider 压 colorPrimary：Modal 的 OK 按钮是
          type="primary"、Input 的聚焦边框都直接读全局 colorPrimary（也就是
          群青），这两颗是用户自己按的/打的字，不是 AI 产出，照 FilterBar/
          TaskComposer 的既有解法局部压回 ink.you，见 theme.ts 顶部
          boardLocalTheme 的注释。 */}
      <ConfigProvider theme={boardLocalTheme}>
        <Modal
          title="存成智能清单"
          open={savingList}
          onOk={() => void submitSaveAsList()}
          onCancel={() => setSavingList(false)}
          confirmLoading={listSaveBusy}
          // 不用「保存」——TaskCard 编辑态、SettingsModal 都已经有一颗
          // 同名按钮，测试用 getByRole 按文字精确匹配会撞在一起；这颗按钮
          // 又恰好是四个字，不会被 antd 的 autoInsertSpace（应用本体在
          // main.tsx 关掉了，测试没经过那层 ConfigProvider，见
          // test-utils.tsx btnIn 顶部注释）插空格拆成两半，getByRole 能
          // 直接精确匹配，不用像 TaskCard 那两处一样借 btnIn 绕开空格。
          okText="保存智能清单"
          cancelText="取消"
          okButtonProps={{ disabled: !listNameDraft.trim() }}
        >
          <Input
            aria-label="智能清单名字"
            autoFocus
            placeholder="给这份筛选起个名字"
            value={listNameDraft}
            onChange={(e) => setListNameDraft(e.target.value)}
            onPressEnter={() => void submitSaveAsList()}
          />
          {/* final-review.md I1：存的只是筛选栏那七个字段，不含「现在在哪个
              视图」——比如在「已完成」视图上筛出来的这几条，存成智能清单之后
              点开会看到全部状态的任务，不只是已完成的那些（除了「全部」视图，
              巧合对得上）。这行字说清楚存的是什么，不改行为：真要让存下来的
              范围跟视图当时看到的一致，得把视图的隐含条件并进 filter 或者给
              SmartFilter 加一个「基视图」字段，那两条路代价都不小（后者要动
              server/src/model.ts 和 web/src/types.ts 两份跨包复制的类型 +
              服务端校验），这一批只把话说清楚。 */}
          <div className="ink-hint" style={{ marginTop: 8 }}>
            只存筛选栏这几项，不含当前视图——比如在「已完成」视图上筛，存下的智能清单打开后不会只显示已完成的任务。
          </div>
        </Modal>
      </ConfigProvider>

      <SettingsModal
        open={settingsOpen}
        value={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={async (s) => { await api.saveSettings(s); }}
        navOptions={navOptions}
        navModes={navModes}
        onNavModes={changeNavModes}
        lists={lists}
      />

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
