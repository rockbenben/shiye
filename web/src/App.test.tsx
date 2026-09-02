import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp, ConfigProvider, Modal } from 'antd';
import {
  NoMotion, pickCardMenu, btnIn, confirmDialog, keyboardDrag, mockDndRects, pressTab,
  installFullCalendarFakeLayout, fcDragEvent, fcSlotPoint, fcTimeGridDrag,
} from './test-utils.js';
import { App, DENSITY_VIEWS } from './App.js';
import { api } from './api.js';
import { CLIENT_API_VERSION } from './components/ServerSetup.js';
import { emptyDraft } from './components/TaskFields.js';
import { setApiBase } from './lib/apiBase.js';
import { OfflineUnsupportedError, resetOnlineCache } from './lib/dataSource.js';
import { pushBackIfDirty } from './lib/pushBack.js';
import { rescheduleLocalNotifications } from './lib/notifyNative.js';
import { calendarDays, dayKey } from './lib/calendar.js';
import { ACTION_SEND, type SharePayload } from './lib/sharePlan.js';
import { emptyFilter } from './lib/smartFilter.js';
import { findSpec } from './lib/views.js';
import { ink, theme as appTheme } from './theme.js';
import type { ConflictFile, Countdown, Folder, InboxItem, Insight, List, Settings, SmartFilter, Task, TrashItem } from './types.js';

// file 收 string 不是字面量联合，跟 api.ts 的 SseHandlers.onChange 对齐——
// 运行时它是 JSON.parse 出来的，可以是任何字符串，测试要能喂进去没见过的值。
type ChangeHandler = (file: string) => void;
type ReminderHandler = (t: Task) => void;

let currentTasks: Task[] = [];
let currentInbox: InboxItem[] = [];
let currentLists: List[] = [];
let currentInsights: Insight[] = [];
let currentCountdowns: Countdown[] = [];
let currentFolders: Folder[] = [];
let currentBroken: ConflictFile[] = [];
let currentTrash: TrashItem[] = [];
let currentConflicts: ConflictFile[] = [];
// onOpen 复审 C2 加的：直接调用它，钉住「SSE 重连会刷新离线记号」这条触发
// 路径，不用真的搭一个 EventSource 连接。
const handlers: { onChange?: ChangeHandler; onReminder?: ReminderHandler; onOpen?: () => void;
  // AI 状态那一路以前没人接过——「拆解结果那条提示」那族用例要靠它推状态。
  onAgentStatus?: (s: unknown) => void } = {};

// reload('lists' | 'tasks' | 'trash') 到底有没有真的去拉接口——几条测试要看的
// 是这个，不是看板上有没有变化（lists 目前还没有对应的可见 UI）。
let listsFetchCount = 0;
let tasksFetchCount = 0;
let trashFetchCount = 0;

// focusMinutes 特意不等于 TaskCard.tsx 里写死的默认值 25（final-review.md
// I1）：App.tsx 三处接线（gridWiring/TodayView/TaskBoard）要是漏传了
// focusMinutes，卡片会悄悄落回那个写死的默认值——如果这里的夹具也用 25，
// 「传对了」和「传漏了」在屏幕上长得一模一样，测试测不出来。45 分钟没有
// 别的含义，只是随手挑一个不等于 25 的数。
const settings: Settings = { webhookUrl: '', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60, focusMinutes: 45, breakMinutes: 5, dailySummaryAt: null, dailySummaryOn: null, defaultListId: null, defaultPriority: 0, defaultDue: 'none' as const, defaultRemindMinutes: null, defaultTags: [], weekStart: 1 as const, smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true, showLunar: true, showHolidays: true, aiMode: 'cli' as const, aiBaseUrl: '', aiKey: '', aiModel: '' };

vi.mock('./api.js', () => ({
  api: {
    inbox: vi.fn(async () => currentInbox),
    tasks: vi.fn(async () => { tasksFetchCount++; return currentTasks; }),
    settings: vi.fn(async () => settings),
    lists: vi.fn(async () => { listsFetchCount++; return currentLists; }),
    // vi.mock() 工厂里就地拼一份 List，跟上面 addTask 同一个理由（task()
    // 夹具这时候还没定义，TDZ）。
    // filter 第三参：task-4-brief「存成智能清单」传当前筛选，其余调用点
    // （Sidebar「新建清单」）不传，落 mock 自己的默认值 null——跟真实
    // api.addList() 的默认参数同一个约定。
    addList: vi.fn(async (name: string, color: string, filter: SmartFilter | null = null): Promise<List> =>
      ({ id: 'new-list', name, color, folderId: null, order: currentLists.length, archived: false, filter })),
    // 以前这里没这一条：reload() 的全量刷新分支（what 为 undefined，或者
    // 认不出来的字符串）会依次 await inbox/tasks/proposals/lists/settings，
    // proposals 排在 lists 前面，没这个 mock 的话 `api.proposals()` 直接
    // 抛「不是函数」，try 块整个跳进 catch，lists 那一行永远不会被跑到——
    // 挂载时那次不带参数的 reload() 一直在悄悄失败，只是以前没有测试
    // 依赖过它跑到底，才没被发现。Step 5 第二处变异验证挖出了这个洞。
    proposals: vi.fn(async () => []),
    insights: vi.fn(async () => currentInsights),
    // reload() 每次都会调它——不 mock 的话「不是函数」会在 reload 里抛出来，
    // 把整份刷新（任务/收件箱/设置……）一起带崩，而调用点在 try/catch 里，
    // 断言只看得到「什么都没刷新」。跟上面 patchTasks 那条注释同一个教训。
    countdowns: vi.fn(async () => currentCountdowns),
    addCountdown: vi.fn(async () => ({})),
    patchCountdown: vi.fn(async () => ({})),
    deleteCountdown: vi.fn(async () => ({ ok: true })),
    // 文件夹（把清单分组）。跟上面 countdowns 同一条：reload() 每次都调
    // `folders()`，不 mock 的话「不是函数」会在 reload 里抛出来，把整份刷新
    // 一起带崩，而调用点在 try/catch 里，断言只看得到「什么都没刷新」。
    // 「打不开的文件」那条横幅。跟 folders/countdowns 同一条：reload() 每次
    // 都调它，不 mock 的话「不是函数」会在 reload 里抛出来，把整份刷新一起
    // 带崩，而调用点在 try/catch 里，断言只看得到「什么都没刷新」。
    broken: vi.fn(async () => currentBroken),
    folders: vi.fn(async () => currentFolders),
    addFolder: vi.fn(async () => ({})),
    patchFolder: vi.fn(async () => ({})),
    deleteFolder: vi.fn(async () => ({ ok: true })),
    patchList: vi.fn(async () => ({})),
    deleteList: vi.fn(async () => ({ ok: true })),
    dismissInsight: vi.fn(async () => ({ ok: true })),
    // vi.mock() 的工厂在模块顶部就执行，这时候下面的 task() 工厂函数还没
    // 定义（TDZ），不能复用它——这里就地拼一份满足 Task 类型的默认值。
    addTask: vi.fn(async (patch: Partial<Task>): Promise<Task> => ({
      id: 'new-task', title: '', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
      source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
      postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
      ...patch,
    })),
    patchTask: vi.fn(async () => ({})),
    deleteTask: vi.fn(async () => ({ ok: true })),
    reorderTasks: vi.fn(async () => ({ ok: true })),
    // task-4-brief：批量操作两个端点的客户端封装——App.tsx 挂载时不调用
    // 它们（跟 tasks/lists 那种「无条件被 reload() 拉一次」不一样，批量
    // 操作要用户先选中、再触发），这里补 mock 纯粹是防炸：没有这两条的话，
    // 任何一条走到 api.patchTasks/deleteTasks 的测试都会在 try/catch 里
    // 静默吞掉「不是函数」的错误，弹一条没人看的提示，断言本身却读不到
    // 真实发生了什么，见上面 proposals mock 那条注释同一个教训。
    patchTasks: vi.fn(async (ids: string[]) => ({ updated: ids.length })),
    patchTasksEach: vi.fn(async (patches: unknown[]) => ({ updated: patches.length })),
    deleteTasks: vi.fn(async (ids: string[]) => ({ deleted: ids.length })),
    patchInbox: vi.fn(async () => ({})),
    deleteInbox: vi.fn(async () => ({ ok: true })),
    addInbox: vi.fn(async () => ({})),
    saveSettings: vi.fn(async () => ({})),
    expand: vi.fn(async () => ({ ok: true })),
    expandSkip: vi.fn(async () => ({ ok: true })),
    // 之前这里没这三条：App.tsx 的 reload() 会在挂载时无条件调用 api.trash()
    // （见下面 what === 'trash' 那个分支，跟 tasks/lists 同一个模式），mock
    // 里没有这个方法的话每次渲染 <App /> 都会在 reload 内部炸一个
    // 「api.trash is not a function」，被 try/catch 悄悄吞掉、弹一条没人
    // 看的错误提示——不会让任何一条既有测试变红，却是真实的运行时错误。
    trash: vi.fn(async () => { trashFetchCount++; return currentTrash; }),
    restoreTrash: vi.fn(async () => ({})),
    purgeTrash: vi.fn(async () => ({ ok: true })),
    conflicts: vi.fn(async () => currentConflicts),
    // 复审 C1 那组新加的测试用了带 attachments 的任务——这个函数不发请求
    // （只是拼字符串给 <a href> 用，见 api.ts 里它自己的注释），offline
    // 为真时 Attachments 组件根本不会调用它；但「一起改成 offline={false}」
    // 那类变异会让代码切进在线分支，这时候不 mock 会在渲染期直接抛
    // 「不是函数」，让测试因为一次无关的崩溃变红，而不是因为这里的断言本身
    // 不通过——跟 Attachments.test.tsx/TaskCard.test.tsx 同一份写法。
    attachmentUrl: vi.fn((taskId: string, name: string) => `/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`),
  },
  subscribe: (h: { onChange: ChangeHandler; onReminder: ReminderHandler; onAgentStatus: (s: unknown) => void; onOpen: () => void }) => {
    handlers.onChange = h.onChange;
    handlers.onReminder = h.onReminder;
    handlers.onOpen = h.onOpen;
    handlers.onAgentStatus = h.onAgentStatus;
    return () => {};
  },
}));

/**
 * 「把离线改动推回桌面」这一层（task-8-brief）在这个文件里**只验接线**：什么时候
 * 叫 `pushBackIfDirty()`、叫完屏幕上说什么、要不要顺手刷一次。所以这里把它换成
 * 替身，不关心它内部怎么组装请求体、怎么清记号——那是 `lib/pushBack.test.ts` 的事。
 *
 * **「推回去这件事真的发生了」不归这个文件管**，归 `PushBack.test.tsx`（Task 9）：
 * 那个文件不 mock 任何中间层，`App` → `api.ts` → `route()` → `pushBack.ts` → HTTP →
 * Hono 路由 → 落盘整条真的走一遍。两层分工是刻意的，理由是 144 那条教训——替身切在
 * 被测特性所在的那条链上，两侧的测试可以都真实、都绿，中间那段一次没被穿过。
 * 这个文件顶上那句 `vi.mock('./api.js')` 就已经把网络那一段切掉了，在这儿再怎么
 * 加断言也够不着真链。
 *
 * 默认返回 `null`（脏集是空的、什么也不用推）——文件里另外一百多条测试的前提因此
 * 一个字都没变。
 */
vi.mock('./lib/pushBack.js', () => ({
  pushBackIfDirty: vi.fn(async () => null),
  resetPushInflightForTest: vi.fn(),
}));

/**
 * 本地通知那一层（`lib/notifyNative.ts`）在这个文件里**只验接线**：`tasks` 变了
 * 有没有整包交出去、三种返回值屏幕上各说什么。替身切在插件那一侧的入口——它
 * 下游全是 jsdom 里根本不存在的东西（原生桥、AlarmManager），排哪些/排多少的
 * 纯逻辑在 `lib/notifyPlan.test.ts`，编排在 `lib/notifyNative.test.ts`。
 *
 * **默认钉 `'not-native'`**：跟真实现在 jsdom 里的返回值一致
 * （`Capacitor.isNativePlatform()` 为假），所以这个文件里另外几百条测试的前提
 * 一个字都没变——它们跑的还是「桌面/浏览器，通知这一层什么都不做」。
 *
 * ⚠️ **`onLocalWrite` 那条触发路不在这个文件里验**（144）：顶上那句
 * `vi.mock('./api.js')` 已经把 `api` → `route()` → `localApi` → `localStore`
 * 整条链切掉了，这里根本发不出本地写入事件，能造出来的只有「手动调
 * handlers.onChange」这一半。那条路在 `OfflineWrite.test.tsx` 里真穿一遍
 * （那个文件只换存储后端和 fetch）。
 */
vi.mock('./lib/notifyNative.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/notifyNative.js')>()),
  rescheduleLocalNotifications: vi.fn(),
}));

/**
 * 分享接入（share-target 那一批）在这个文件里验的是**接线**：原生事件进来 →
 * 真的走 `api.addInbox`（跟随手记同一个调用）→ 成功/失败两格屏幕上各说什么。
 *
 * **只替 `nativeSharePort` 这一个 export**：Capacitor 插件是外部系统，那是它的
 * 边界，`available()`/`onShared()` 下游全是 jsdom 里根本不存在的东西（原生桥、
 * Android intent）。**`subscribeShare` 和 `shareToInboxText` 都跑真的**——被测
 * 特性（Task 1 的判断 × Task 3 的订阅 × `api.addInbox` 的写入，三者的接缝）
 * 正好活在它们之间，把 `subscribeShare` 也 mock 掉的话，替身就切在被测特性所在
 * 的那条链上、零覆盖（parked-all 第 144 条，`shareNative.ts` 里那个 `SharePort`
 * 的注释也逐字写着这句）。
 *
 * ⚠️ **这个文件够不着「收件箱里真的多了一条」**：顶上那句 `vi.mock('./api.js')`
 * 已经把 `api` → `route()` → `localApi` → `localStore` 整条链换成了一组
 * `vi.fn()`，在这儿再怎么加断言也只能验到「`addInbox` 被喂了什么」为止。
 * 那后半段在 `OfflineWrite.test.tsx` 里真穿一遍（那个文件不 mock `./api.js`），
 * 跟 `onLocalWrite`、`pushBack` 两条路的分工是同一个（144）。
 */
let emitShared: ((p: SharePayload) => void) | null = null;
const shareUnsub = vi.fn();
let shareAvailable = true;
vi.mock('./lib/shareNative.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/shareNative.js')>()),
  // 工厂体在模块顶部就执行（这时候上面那几个 `let` 还在 TDZ 里），所以这里
  // 只许**造闭包**、不许当场读它们——`available`/`onShared` 都是被调用时才读，
  // 跟这个文件顶上 `vi.mock('./api.js')` 的工厂读 `currentTasks` 是同一个写法。
  nativeSharePort: {
    available: () => shareAvailable,
    onShared: (cb: (p: SharePayload) => void) => { emitShared = cb; return shareUnsub; },
  },
}));

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '交房租', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: null }], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

const list = (p: Partial<List> = {}): List =>
  ({ id: 'l1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null, ...p });

/**
 * `App` 挂载时会探一次 `/api/health`（`isOnline()`，不经过上面
 * `vi.mock('./api.js', ...)` 的那层——那个探测直接 `fetch`，跟拿 `api.ts`
 * 那份被完全 mock 掉的 base 无关）。**这个文件绝大多数测试都在模拟桌面**：
 * 不给这里一个默认的成功响应，每条测试挂载 `<App />` 都会去 fetch 一次不
 * 存在的 `http://localhost/api/health`，探测失败会让离线横幅挂在看板顶上，
 * 「连得上时不显示离线记号」那几条上限断言就永远测不出真假了。
 *
 * （这份桩以前还挡着另一件事：探测失败会让整页的 ServerSetup 顶掉主看板。
 * **那面墙已经删掉了**——没配过地址也要能用本地功能，见 App.tsx 里
 * `offline` state 定义处的注释。）
 */
const fakeHealth = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const desktopHealthy = () => fakeHealth({ ok: true, version: CLIENT_API_VERSION });

beforeEach(() => {
  currentTasks = [task()];
  currentInbox = [];
  currentLists = [];
  currentInsights = [];
  currentCountdowns = [];
  currentFolders = [];
  currentBroken = [];
  currentTrash = [];
  currentConflicts = [];
  listsFetchCount = 0;
  tasksFetchCount = 0;
  trashFetchCount = 0;
  delete handlers.onChange;
  delete handlers.onReminder;
  delete handlers.onOpen;
  // 每条测试都从「脏集是空的」开始——上一条 mockResolvedValue 出来的汇总不许漏
  // 过来（漏过来的表现是别的 describe 里莫名其妙多出一条「已把 N 条…」的提示，
  // 以及莫名其妙多刷一次整页）。
  vi.mocked(pushBackIfDirty).mockReset().mockResolvedValue(null);
  // 每条测试都从「这不是原生壳」开始（桌面/浏览器，通知这一层沉默）——上一条
  // 钉的 'denied'/reject 不许漏过来，漏过来的表现是别的 describe 里莫名其妙多
  // 出一条通知权限横幅或者一条红字。
  vi.mocked(rescheduleLocalNotifications).mockReset().mockResolvedValue('not-native');
  // 每条测试都从「还没有人订阅过分享」开始——`emitShared` 漏过来的话，别的
  // describe 里一次 `emitShared!(...)` 会打到上一次渲染留下的那棵已经卸载的树上。
  emitShared = null;
  shareUnsub.mockReset();
  shareAvailable = true;
  vi.stubGlobal('fetch', vi.fn(async () => desktopHealthy()));
});

/**
 * 侧栏导航按钮，查询限定在 `<nav>` 子树里，不用不加范围的 `screen.getByRole`。
 *
 * 原因跟上面 pickCardMenu/`.ink-view-panel-today` 那几处一样：两个视图常驻
 * 挂载之后，树里的 `<button>` 候选（每张任务卡的 ⋯ 菜单、筛选条的几颗筹码……）
 * 数量很大，`getByRole('button', …)` 不加范围地在整份文档里找的话，要对每个
 * 候选元素单独做一次可访问性判定（含祖先链上的 `getComputedStyle`），实测能
 * 从两位数毫秒膨胀到超过默认的 15 秒测试超时。先用 `getByRole('navigation', …)`
 * 定位这个唯一的 `<nav>`——landmark role 只匹配这一个元素，判定成本可以忽略——
 * 再把查询范围收进它的子树，候选集从「全站几十上百颗按钮」降到「导航里那
 * 十几颗」，两个数量级的差距就是这条注释想避开的那件事。
 */
/**
 * 切到看板。**看板不再是一个去处，是「全部」这类清单的显示方式**
 * （`lib/listMode.ts`）——所以这里是「先去一个任务去处，再点标题栏上的
 * 『看板』」，不是 `navButton(/看板/)`。默认去「全部」，跟改之前那个独立
 * 看板视图看的是同一批任务，下面那些断言原样成立。
 */
const goBoard = async (view: RegExp = /全部/, heading = '全部') => {
  // 人可能正站在一个模块上（日历/四象限/习惯），那儿清单侧栏整条不渲染，
  // 下面 navButton 找不到「全部」。先点竖栏上「任务」那一颗把侧栏带回来。
  if (screen.queryAllByRole('navigation', { name: '视图' }).length === 0) {
    fireEvent.click(within(screen.getByRole('navigation', { name: '模块' })).getByRole('button', { name: '任务' }));
    await waitFor(() => expect(screen.queryAllByRole('navigation', { name: '视图' })).toHaveLength(1));
  }
  fireEvent.click(navButton(view));
  await screen.findByRole('heading', { level: 1, name: heading });
  const sw = screen.getByRole('group', { name: '视图' });
  fireEvent.click(within(sw).getByRole('button', { name: '看板' }));
  await waitFor(() => {
    if (!document.querySelector('.ink-cells')) throw new Error('还没切成看板');
  });
};

/**
 * 打开那张完整的「新任务」表单。
 *
 * **标题栏上那颗「新任务」按钮删了**——照滴答清单文档，桌面版加任务只有
 * 「任务添加栏」这一个地方，附加选项挂在输入框右侧（QuickAdd 那一行右端的
 * `⌄`）。这里统一按 `C`：那条路一直通向同一个 `openCompose`，而且在没有
 * 加任务行的去处（收件箱、已完成）也照样开得出来。
 */
const openTaskForm = async () => {
  fireEvent.keyDown(window, { key: 'c' });
  await screen.findByPlaceholderText('标题');
};

/**
 * 打开搜索弹层，返回里面那个输入框。
 *
 * **侧栏顶上那个搜索框删了**——搜索现在是最左那条竖栏上的一颗，点开是一个
 * 浮层（`SearchModal`）。`/` 也开得出来，这里走键盘：不用管人现在在哪个模块上。
 */
/**
 * 搜一个词，并进「搜索结果」那个去处。
 *
 * 弹层里**回车 = 看全部结果**（`onSeeAll`），这才是「搜索结果」那一屏的入口
 * ——原来是「在侧栏搜索框里打字就自动切过去」，现在打字只更新弹层里那一列，
 * 切去处是一次明确的动作。
 */
const searchFor = async (q: string) => {
  const box = await openSearch();
  fireEvent.change(box, { target: { value: q } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

const openSearch = async () => {
  fireEvent.keyDown(window, { key: '/' });
  return screen.findByLabelText('搜索任务');
};

const navButton = (name: RegExp) => {
  // **两条导航都找**：清单侧栏那条（`aria-label="视图"`）装收件箱/今天/……，
  // 最左那条竖图标栏（`aria-label="模块"`）装任务/日历/看板/四象限/习惯/……。
  // 调用方要的一直是「导航到那个去处的那颗按钮」，它在哪条栏上是版面的事。
  //
  // **两条都用 queryAllByRole，不是 getByRole。** 清单侧栏只有任务模块才渲染
  // （lib/views.tsx 的 `showsSidebar`）——站在日历/习惯上时它整条不在，`getByRole`
  // 会直接抛「找不到 navigation 视图」。这条踩过：那一改之后，凡是先切到看板/
  // 日历、再用这个 helper 点下一个去处的测试全都在 waitFor 里空转到超时（单条
  // 三百多秒），报错说的还是「找不到导航」，看着像导航坏了，其实是这个 helper
  // 假设了一个已经不成立的前提。
  // 试过把这两行换成 `document.querySelectorAll('nav[aria-label=…]')`——语义等价
  // 而且便宜得多（`*ByRole` 要给整份文档的每个元素算角色和可访问名，而这个
  // helper 有 242 个调用点、还常被 `waitFor` 每 50ms 重调）。**但实测整个文件
  // 没有可测的改善**（209.9s → 223.2s，差值在噪声里），所以没留：多数用例渲染的
  // DOM 很小，扫一遍本来就不贵；真正慢的是**大 DOM 上反复重试**的那种查询
  // （见下面「以后再说」那条用例上面的计时）。
  //
  // 顺带记下那次试探踩到的坑，省得下一个人再走一遍：不能只按 `[aria-label="视图"]`
  // 找，屏幕上还有一个 `role="group" aria-label="视图"` 的密度开关
  // （`.ink-density-switch`，装着「列表 / 看板 / 行 / 卡」），`navButton(/看板/)`
  // 会同时命中那颗，变成「有 2 个，期望 1 个」。
  const bars = [
    ...screen.queryAllByRole('navigation', { name: '视图' }),
    ...screen.queryAllByRole('navigation', { name: '模块' }),
  ];
  const hits = bars.flatMap((bar) => within(bar).queryAllByRole('button', { name }))
    // 清单和标签每行还挂着一颗「⋯」（改名/归档/删除，见 Sidebar.tsx），它的
    // 可访问名里带着那份清单/标签的名字，`/工作/` 这种子串正则会同时命中两颗。
    // **在这儿滤掉，不是让十几个调用点各自去加 `^…$`**：调用方要的一直是
    // 「导航到那个去处的那颗按钮」，行内的动作按钮从来不是候选。
    .filter((b) => !/的更多操作$/.test(b.getAttribute('aria-label') ?? ''));
  if (hits.length !== 1) throw new Error(`导航里匹配 ${name} 的去处有 ${hits.length} 个，期望 1 个`);
  return hits[0];
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // jsdom 的 location 在同一个测试文件里是共享的——不清的话「带着 hash
  // 打开」那条会把 hash 串到后面所有测试，表现随执行顺序而定。
  window.location.hash = '';
  // apiBase 的内存缓存是这个测试文件生命周期内的单例（见 apiBase.ts 的
  // 注释）——不清的话，下面「手机没配过地址」那组测试留下的 setApiBase()
  // 会漏到后面所有测试里，「桌面」的默认前提就不成立了。
  setApiBase('');
  // isOnline() 的探测结果也是模块级缓存（5 秒 TTL，见 lib/dataSource.ts），
  // 同一条理由：不清的话，下面「离线记号」那组测试喂的 fetch 桩（连不上/
  // 抛异常）会在缓存窗口内被后面的测试复用，跟这份测试文件自己的 fetch 桩
  // 对不上——「连得上时不显示记号」那条上限断言尤其怕这个：真正原因如果是
  // 「缓存里还留着上一条测试的 false」，会长得跟「这条断言真的在守着什么」
  // 一模一样，见 task-2-report 里同族的假绿。
  resetOnlineCache();
  // density.ts 直接读写真实的 window.localStorage（jsdom 里是有的，但会
  // 跨用例串，见 CLAUDE.md）——不清的话「密度开关」那组测试留下的
  // setDensity('row') 会漏到后面所有测试里。
  //
  // **修复轮 1 · I1：这里曾经写的是 `setDensity('card')`**——看起来是清理，
  // 实际是往 localStorage 里写进了后面「默认是卡片」那条断言要验证的值，
  // 让那条断言测的是「localStorage 里存着 card 时渲染出来是卡片」，不是
  // brief 要的「没设置过 localStorage 时渲染出来是卡片」（parked-all.md
  // 「夹具恰好等于写死的值」那一类假绿）。改成直接删键——回到「真的没存过」
  // 这个状态，`getDensity()` 自己的兜底逻辑（density.test.ts 已经测过）
  // 才是「默认是卡片」这条断言唯一的依据。
  localStorage.removeItem('density');
  // 同一条：`listMode` 也是直接读写 localStorage 的本机偏好，「列表/看板」那组
  // 测试点完看板会留下 `board`，漏到后面所有测试里——表现是别的用例一进去就
  // 已经是看板了，而它们断言的是「一开始是一条一条的列表」。**踩过**：加完
  // 看板模式之后，两条本来无关的用例莫名其妙红了。删键，不是写 'list'，理由
  // 跟上面 density 那段一字不差。
  localStorage.removeItem('listMode');
  // 第三个同款的本机偏好：四象限按哪套规则分格（`quadrantRule.ts`）。
  // **这一条是补账补出来的，而且账单很长**：加完「按时间 + 优先级」那个开关，
  // 点它的那条用例把 `time-priority` 留在了 localStorage 里，后面**八条**四象限
  // 用例一起红——而失败信息是「这个面板不是行档——density='row' 可能被删了」，
  // 指向一个完全无关的地方（真正的原因是任务改按截止时间分格、全挪了位置，
  // 那几个格子空了，`querySelector('.ink-trow')` 自然找不到东西）。
  //
  // 也就是说：**新加一个直接读写 localStorage 的偏好，就得在这儿加一行**，
  // 忘了不会得到一句「你忘了清 quadrantRule」，只会得到几条指着别处的红。
  localStorage.removeItem('quadrantRule');

  // 兜底还原假时钟。这个文件里钉时钟的测试各自都在 `finally` 里调过
  // `vi.useRealTimers()`，这一句是**第二道**：没钉过的时候它是空操作，
  // 钉过但某条路径没走到 `finally`（断言在 try 里抛、或者以后有人忘了写
  // finally）的时候，它挡住假时钟漏给下一条测试——那种污染的表现是
  // 「单独跑绿、连着跑红」，属于最难查的一类。
  vi.useRealTimers();
});

/**
 * 一条**渲染时必定抛异常**的任务，给错误边界那两条用。
 *
 * 原来是拿 `subtasks: 'boom'` 制造崩溃——那依赖「卡片会裸读 `.map`」这个
 * 实现细节，而那处后来加了 `asArray` 兜底（跟 API 入口那道 `normalizeTaskArrays`
 * 同一批加固），崩溃就不发生了，这两条测试跟着变成「渲染正常、断言错误提示」
 * 的假绿。改成在 `title` 上挂一个会抛的取值器：**要测的是「一个视图崩了不
 * 拖累另一个」，不是某个字段恰好没兜底**，这么写以后再怎么加固都还成立。
 */
const explodingTask = (over: Partial<Task> = {}): Task => {
  const t = task({ id: 'bad', ...over });
  Object.defineProperty(t, 'title', {
    get() { throw new Error('渲染这条任务时炸了（测试故意的）'); },
    enumerable: true,
  });
  return t;
};

describe('App：提醒横幅跟着任务走', () => {
  it('任务变成 done 之后，横幅自动消失——不需要手动关', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());

    act(() => handlers.onReminder!(currentTasks[0]));
    expect(await screen.findByText('该做了：交房租')).toBeDefined();

    // 任务完成：文件 → SSE data-changed('tasks') → reload，跟真实链路一致，
    // 不手动 setState 去关横幅。
    currentTasks = [{ ...currentTasks[0], status: 'done' }];
    act(() => handlers.onChange!('tasks'));

    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
  });

  it('任务被删掉之后，横幅自动消失', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());

    act(() => handlers.onReminder!(currentTasks[0]));
    expect(await screen.findByText('该做了：交房租')).toBeDefined();

    currentTasks = [];
    act(() => handlers.onChange!('tasks'));

    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
  });

  it('任务被搁置之后，横幅自动消失——搁置就是「暂时不想看见它」，横幅还钉在最上面正好相反', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());

    act(() => handlers.onReminder!(currentTasks[0]));
    expect(await screen.findByText('该做了：交房租')).toBeDefined();

    currentTasks = [{ ...currentTasks[0], status: 'later' }];
    act(() => handlers.onChange!('tasks'));

    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
  });
});

/**
 * 提醒横幅上的两颗按钮（仿滴答清单的提醒弹窗「完成 / 稍后提醒 / 忽略」）。
 *
 * 存在的理由不是「多两个按钮更方便」：**桌面版的原生通知早就有「完成」和
 * 「推迟 10 分钟」**（desktop/src/main.ts 的协议激活），网页横幅却只能关掉——
 * 同一条提醒在两个壳里能做的事不一样，没有道理。
 */
/**
 * 提醒横幅摆不下时摄起来。**不是为了好看**：开着应用出去半天，回来时八个
 * 横幅摔在最上面，看板整个被推出屏幕——而你想看的恰恰是看板。
 */
describe('App：提醒横幅摆不下就收起来', () => {
  const raiseMany = async (n: number) => {
    currentTasks = Array.from({ length: n }, (_, i) => task({ id: `t${i}`, title: `提醒${i}` }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());
    for (const t of currentTasks) act(() => handlers.onReminder!(t));
    await screen.findByText('该做了：提醒0');
  };
  const banners = () => document.querySelectorAll('.ant-alert-warning');

  it('三条以内全摆出来，不多一行', async () => {
    await raiseMany(3);
    expect(banners()).toHaveLength(3);
    expect(document.querySelector('.ink-due-more')).toBeNull();
  });

  it('超过三条：只摆三条，剩下的报个数', async () => {
    await raiseMany(6);
    expect(banners()).toHaveLength(3);
    expect(document.querySelector('.ink-due-more')?.textContent).toContain('还有 3 条到点了');
  });

  it('**「全部知道了」只把横幅摘掉，不动任务也不动提醒**——跟每条那颗 × 一样', async () => {
    await raiseMany(6);
    fireEvent.click(screen.getByRole('button', { name: '全部知道了' }));
    await waitFor(() => expect(banners()).toHaveLength(0));
    expect(api.patchTask).not.toHaveBeenCalled();
    expect(api.patchTasksEach).not.toHaveBeenCalled();
  });

  it('**那颗按钮不常驻**——三条以内逐条点 × 本来就不费事，而一颗能清掉十几条提醒的按钮误点代价更大', async () => {
    await raiseMany(2);
    expect(screen.queryByRole('button', { name: '全部知道了' })).toBeNull();
  });
});

describe('App：提醒横幅上能直接处理这条提醒', () => {
  const raise = async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());
    act(() => handlers.onReminder!(currentTasks[0]));
    expect(await screen.findByText('该做了：交房租')).toBeDefined();
  };
  const banner = () => screen.getByText('该做了：交房租').closest('.ant-alert') as HTMLElement;

  it('「完成」直接把这条标成 done，横幅跟着收掉', async () => {
    await raise();

    fireEvent.click(btnIn(banner(), '完成'));

    await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith(currentTasks[0].id, { status: 'done' }));
    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
  });

  /**
   * 「稍后 10 分钟」**挪的是刚响过的那一条，不再追加**。判据在
   * `lib/reschedule.test.ts`（含「一条盖过章的都没有就退回追加」那条兜底），
   * 这里测接线：横幅上点下去发的是什么。
   *
   * 夹具的提醒要**盖着章**——横幅本来就是服务端发出去之后才推上来的，
   * 而 `firedAt` 正是「哪一条刚响过」的唯一线索。
   */
  it('「稍后 10 分钟」把刚响过的那一条挪到十分钟后，不再追加一条', async () => {
    const stamp = '2026-08-01T00:00:01.000Z';
    currentTasks = [task({ reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: stamp }] })];
    await raise();

    fireEvent.click(btnIn(banner(), '稍后10分钟'));

    await waitFor(() => expect(api.patchTask).toHaveBeenCalled());
    const [, patch] = (api.patchTask as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const reminders = (patch as { reminders: Array<{ at: string; firedAt: string | null }> }).reminders;
    // **还是一条**：连按五次也不会攒成六条。
    expect(reminders).toHaveLength(1);
    const delta = Date.parse(reminders[0].at) - Date.now();
    expect(delta).toBeGreaterThan(9 * 60_000);
    expect(delta).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    // 章清掉了才响得起来（服务端按时刻比对，新时刻本来就配不上旧章，这里
    // 发 null 只是把意图说明白）。
    expect(reminders[0].firedAt).toBeNull();
    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
  });

  /**
   * **旁边那个小箭头能换一个时长**（仿 Things 的 10/30/60）。名单和文案在
   * `lib/reschedule.ts`，那边还有一条守卫钉着「第一档 === 桌面通知那颗」。
   *
   * 这里测的是接线：菜单里点 1 小时，发出去的真的是一小时后。
   */
  it('小箭头里能选 1 小时——推的量跟点的那一档一致', async () => {
    const stamp = '2026-08-01T00:00:01.000Z';
    currentTasks = [task({ reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: stamp }] })];
    await raise();

    fireEvent.click(btnIn(banner(), '⌄'));
    const item = await screen.findByText('稍后 1 小时');
    fireEvent.click(item);

    await waitFor(() => expect(api.patchTask).toHaveBeenCalled());
    const [, patch] = (api.patchTask as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const reminders = (patch as { reminders: Array<{ at: string }> }).reminders;
    expect(reminders).toHaveLength(1);
    const delta = Date.parse(reminders[0].at) - Date.now();
    // 一小时，不是十分钟——菜单点了却按主按钮的量推，是这一条要挡的。
    expect(delta).toBeGreaterThan(59 * 60_000);
    expect(delta).toBeLessThanOrEqual(60 * 60_000 + 5_000);
  });

  it('**主按钮那一档不在菜单里**——同一件事摆两个入口，点哪个都一样，纯噪音', async () => {
    currentTasks = [task({ reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: '2026-08-01T00:00:01.000Z' }] })];
    await raise();

    fireEvent.click(btnIn(banner(), '⌄'));
    await screen.findByText('稍后 30 分钟');
    // **在菜单里找，不在整屏找**：主按钮上写的正是「稍后 10 分钟」，
    // 满屏搜必然搜得到它，那条断言会恒红——跟菜单里有没有这一项无关。
    const menu = document.querySelector('.ant-dropdown-menu')!;
    const items = [...menu.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s/g, ''));
    expect(items).toContain('稍后30分钟');
    expect(items).not.toContain('稍后10分钟');
  });

  /**
   * **「去做」把那条任务打开。** 对应滴答清单提醒弹窗里那颗「开始专注」
   * （《超强大的提醒功能》：「你可以…选择『忽略』、『开始专注』、
   * 『完成』以及『稍后提醒』」）——这个应用的番茄钟长在任务卡里，所以这一颗
   * 做的是把卡打开，专注按钮就在那儿。
   *
   * 补的是一个两边不一致：**桌面通知点本体一直会打开那条任务**
   * （`desktop-open-task` → `openTask`），网页横幅在这之前只能「完成」或
   * 「稍后」——想真去做它得先关掉横幅再自己去找。
   *
   * 断言落在**详情面板里出现了这条任务**，不是「`openTask` 被调用了」：
   * 后者要么去 mock 组件内部的函数，要么就只是把实现重抄一遍。
   */
  it('「去做」打开那条任务，横幅跟着收掉', async () => {
    await raise();
    // **比增量，不比 `not.toHaveBeenCalled()`。** 这个文件的 mock 在用例之间
    // 不清零，那句断言实际问的是「整个文件跑到这儿为止有没有人 PATCH 过」——
    // 同一族里前面两条（「完成」「稍后 10 分钟」）各发过一次，于是它单独跑绿、
    // 跟整个文件一起跑红。实测出来的。
    const patches = () => (api.patchTask as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = patches();

    fireEvent.click(btnIn(banner(), '去做'));

    // 详情面板那一栏出现，里面是这条任务。
    const panel = await screen.findByRole('complementary');
    await waitFor(() => expect(within(panel).getByText('交房租')).toBeDefined());
    await waitFor(() => expect(screen.queryByText('该做了：交房租')).toBeNull());
    // **不改任何东西**：打开一条任务不是处理它，一个 PATCH 都不该发。
    expect(patches(), '「去做」发了 PATCH——它只该打开面板').toBe(before);
  });
});

/**
 * 勾完之后那一次撤销（仿滴答清单）。**算什么在 `lib/undoDone.test.ts`**，
 * 这里只测接线：提示弹不弹、点了撤销发的是什么。
 *
 * 借提醒横幅那颗「完成」进来，是因为它跟五个视图上的勾选框走的是同一个
 * `patchOne`——那正是「只走一个入口」这件事要守住的东西，而横幅这条路
 * render 一次就能到，不用先摆好一屏卡片。
 */
describe('App：勾完给一次撤销', () => {
  // 取那条提示不走 findByRole({name})：可访问名要给页面上每一颗按钮算一遍，
  // 在 App 这一屏上慢到分钟级（实测跑一条要好几分钟）。这块内容只有这一处，
  // 按 class 取就够。
  const undoNotice = async () => {
    await waitFor(() => expect(document.querySelector('.ink-undo')).not.toBeNull());
    return document.querySelector('.ink-undo') as HTMLElement;
  };

  const complete = async (over: Partial<Task> = {}) => {
    currentTasks = [task({ ...over })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onReminder).toBeDefined());
    act(() => handlers.onReminder!(currentTasks[0]));
    const alert = (await screen.findByText('该做了：交房租')).closest('.ant-alert') as HTMLElement;
    fireEvent.click(btnIn(alert, '完成'));
    await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('t1', { status: 'done' }));
  };

  it('弹一条带「撤销」的提示，提示里带标题——点完成之后那张卡当场消失，不给退路的话得去「已完成」里翻', async () => {
    await complete();
    expect((await undoNotice()).textContent).toContain('已完成「交房租」');
  });

  it('点「撤销」发的是改回原来那个状态的 patch，不是一律 todo', async () => {
    await complete({ status: 'doing' });
    fireEvent.click((await undoNotice()).querySelector('button')!);
    await waitFor(() => expect(api.patchTask).toHaveBeenLastCalledWith('t1', { status: 'doing' }));
  });

  it('有连带（这条会生成重复的下一条）时把「撤销只改回这一条」说出来——不然那颗按钮在许一个它做不到的承诺', async () => {
    await complete({ repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null } });
    expect((await undoNotice()).textContent).toContain('撤销只把这一条改回来');
  });

  /**
   * 「下次 X」。判据在 `lib/undoDone.test.ts`（日期怎么算更在服务端的
   * `repeat.ts`，跟真正生成下一条走的是同一个 `advance`），这里只测接线：
   * 那句话真的画进了提示里，而且只对重复任务说。
   */
  it('重复任务的提示里报出下一次落在哪——点完成那张卡当场消失，「下一条生成了没有、生在哪天」正是这时候最想知道的', async () => {
    const due = new Date();
    due.setDate(due.getDate() + 2);
    due.setHours(23, 59, 0, 0);
    const next = new Date(due);
    next.setDate(next.getDate() + 1);
    await complete({
      due: due.toISOString(),
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null },
    });
    const text = (await undoNotice()).textContent ?? '';
    expect(text).toContain('下次 ');
    // 日期用的是行上那颗到期 chip 同一套说法（`dueChip`），不另发明第二种写法。
    expect(text).toContain(`${next.getMonth() + 1}月${next.getDate()}日`);
  });

  it('不重复的任务不说「下次」——它没有下次', async () => {
    await complete();
    expect((await undoNotice()).textContent).not.toContain('下次');
  });

  it('没有连带时不说那句话', async () => {
    await complete();
    expect((await undoNotice()).textContent).not.toContain('撤销只把这一条改回来');
  });
});

describe('App：reload 认全服务端会发的几种 data-changed（文件监听器改成递归之后新增的那几种）', () => {
  it('收到 lists 的 data-changed 会重新拉清单——监听器已经会发这四种新的了', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined());
    const before = listsFetchCount;

    act(() => handlers.onChange!('lists'));

    await waitFor(() => expect(listsFetchCount).toBeGreaterThan(before));
  });

  it('收到不认识的 file 时做一次全量刷新，不是什么都不做', async () => {
    // 服务端将来加一种新表、而前端还没跟上时，宁可多拉一次也不要静默不刷新——
    // 「写成功了但界面看上去什么也没发生」是这个仓库栽过五次的坑。
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined());
    const before = tasksFetchCount;

    act(() => handlers.onChange!('将来才有的表'));

    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(before));
  });
});

describe('App：垃圾箱接线——reload 认得 trash 这个 file，不是接了线但没人盯着（reload 那段注释点名的坑）', () => {
  it('挂载时会拉一次垃圾箱数据；收到 trash 的 data-changed 会重新拉，新增的条目能在垃圾箱视图里看到', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(trashFetchCount).toBeGreaterThan(0));
    const before = trashFetchCount;

    currentTrash = [{ ...task(), id: 'x1', title: '删掉的那条', deletedAt: '2026-08-10T00:00:00.000Z' }];
    act(() => handlers.onChange!('trash'));
    await waitFor(() => expect(trashFetchCount).toBeGreaterThan(before));

    fireEvent.click(navButton(/垃圾箱/));
    expect(await screen.findByText('删掉的那条')).toBeDefined();
  });

  /**
   * 「还原」之后这一屏唯一的变化是少了一行，而那条任务落在别处——不说的话
   * 跟「删掉了」在屏幕上长得一模一样。这是 `TaskComposer.report()` 早就立过
   * 的规矩：写成功了、界面看上去什么也没发生。
   */
  it('还原之后说清楚它去哪了——未完成的落「全部」', async () => {
    currentTrash = [{ ...task(), id: 'x1', title: '删掉的那条', deletedAt: '2026-08-10T00:00:00.000Z' }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/垃圾箱/)).toBeDefined());
    fireEvent.click(navButton(/垃圾箱/));
    await screen.findByText('删掉的那条');

    fireEvent.click(screen.getByRole('button', { name: '还原' }));

    expect(await screen.findByText('已还原「删掉的那条」——在「全部」里')).toBeTruthy();
  });

  it('已完成的那条落「已完成」——判据跟别处「跳到那条任务」共用同一条，不新造一个「装得下它的去处」', async () => {
    currentTrash = [{ ...task(), id: 'x1', title: '早做完了', status: 'done', deletedAt: '2026-08-10T00:00:00.000Z' }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/垃圾箱/)).toBeDefined());
    fireEvent.click(navButton(/垃圾箱/));
    await screen.findByText('早做完了');

    fireEvent.click(screen.getByRole('button', { name: '还原' }));

    expect(await screen.findByText('已还原「早做完了」——在「已完成」里')).toBeTruthy();
  });
});

// 离线时 api.settings() 抛的那种失败——**类型要跟真实的那条路一致**：
// api.ts 走的是 offlineUnsupported()，抛的是 OfflineUnsupportedError，
// App.tsx 的 reload() 正是靠这个类型分辨「离线时的预期失败」（安静）和
// 「在线时 /api/settings 真的出事了」（弹提示），见下面那组测试。这里要是
// 图省事抛一个裸 Error，测的就成了另一条分支。
const offlineSettingsFailure = () => new OfflineUnsupportedError('离线时无法读取设置，连接服务器之后再试');

// task-2-report 修复轮 2 C2：settings 读取失败（离线时的正常情况，
// api.settings() 走 offlineUnsupported，不再伪造一份 DEFAULT_SETTINGS）
// 不该拖累 reload() 里排在它后面的字段一起不更新，也不该让整个组件炸掉。
describe('App：reload 里 settings 单独 catch，失败不连累别的字段、不崩组件（task-2-report 修复轮 2 C2）', () => {
  it('api.settings() 拒绝时，任务/收件箱这些字段照样正常刷新，组件不崩', async () => {
    vi.mocked(api.settings).mockRejectedValueOnce(offlineSettingsFailure());
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // settings 读取失败没有连累 tasks 更新——挂载时的这次 reload 是 all=true，
    // tasks 排在 settings 前面，但排在 settings 后面的 trash 这次也照样要更新，
    // 证明外层 try 没有在 settings 抛出的地方整个中断。默认视图会在不止一处
    // 渲染同一条任务标题（比如「今天」+ 别处的候选区），用 findAllBy 不要求
    // 唯一匹配。
    expect((await screen.findAllByText('交房租')).length).toBeGreaterThan(0);
    await waitFor(() => expect(trashFetchCount).toBeGreaterThan(0));
  });

  it('settings 挂载时失败一次之后，收到 settings 的 data-changed 不会让组件卡死——照样能正常触发别的 reload', async () => {
    // 不用 toHaveBeenCalledTimes 数 api.settings 的调用次数——这个 mock 是
    // vi.mock('./api.js', ...) 工厂里那份跨用例共享的 vi.fn()，这个文件的
    // afterEach 不清它的调用历史（这也是这个文件别处宁可自己维护
    // tasksFetchCount/listsFetchCount/trashFetchCount 这类手动计数器、不直接
    // 断言 mock 调用次数的原因）。这里改用行为断言：settings 失败一次之后，
    // 再收到任意一个 data-changed（这里拿 tasks 举例）照样能正常触发刷新，
    // 证明组件没有卡在某个坏状态里。
    vi.mocked(api.settings).mockRejectedValueOnce(offlineSettingsFailure());
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findAllByText('交房租');
    await waitFor(() => expect(handlers.onChange).toBeDefined());
    const before = tasksFetchCount;

    act(() => handlers.onChange!('settings'));
    act(() => handlers.onChange!('tasks'));

    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(before));
  });
});

/**
 * 整分支审查 I1：「从没成功读到过的 Settings」不能被整份 PUT 回去。
 *
 * 这一批已经堵过同形状的第一扇门（`route()` 离线伪造一份 `DEFAULT_SETTINGS`
 * 当答案，task-2-report 修复轮 2 C2）。这里是剩下的两扇：
 * - **门一**：`settings` state 的初值曾经是本文件顶部硬编码的
 *   `DEFAULT_SETTINGS`（`webhookUrl: ''`）——整场离线里抽屉拿它当草稿初值，
 *   恢复联网到 `reload()` 写回真值之间点保存，桌面真实的 webhookUrl 被 `''`
 *   覆盖。改法是让 state 能表达「还没读到」（`null`），抽屉在那个状态下
 *   **根本不渲染表单**，见 SettingsModal.test.tsx 同名那组。
 * - **门二**：`reload()` 里 settings 那个光秃秃的 `catch {}` 连**在线**时
 *   `/api/settings` 真的 500（device.json 损坏之类）也一起吞了，用户看不到
 *   任何错误。改法是只吞 `OfflineUnsupportedError`。
 */
describe('App：从没读到过的设置不可能被 PUT 回去（整分支审查 I1）', () => {
  const openSettings = async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findAllByText('交房租');
    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    return await screen.findByRole('dialog');
  };

  it('门一：settings 一次都没读到过时，设置弹层里没有那张表单——没有草稿就没有能保存的东西', async () => {
    vi.mocked(api.settings).mockRejectedValueOnce(offlineSettingsFailure());
    const settingsDialog = await openSettings();

    // 设置从抽屉换成了分区弹层（SettingsModal），一次只画一页——断言之前
    // 得先站到那一页上，页签按屏幕上的名字点。
    const goto = (label: string) => fireEvent.click(within(settingsDialog).getByRole('tab', { name: label }));

    goto('提醒与通知');
    // Webhook 输入框不在（表单整个不渲染），说明为什么的那句话在。
    expect(within(settingsDialog).queryByPlaceholderText('https://…')).toBeNull();
    expect(within(settingsDialog).getByText(/还没读到这台服务上的设置/)).toBeTruthy();
    // 设置表单那颗「保存」不存在——站在一页要草稿的分区上也没有。
    const saves = within(settingsDialog).getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '保存');
    expect(saves.length).toBe(0);
    // 连不上时最需要能改的那份（存在这台设备本地）照常在，在「数据与服务」那页。
    goto('数据与服务');
    expect(within(settingsDialog).getByLabelText('服务地址')).toBeTruthy();
  });

  it('对照：settings 真的读到了，表单照常出现、能保存——上面那条不是把抽屉整个测没了', async () => {
    const settingsDialog = await openSettings();
    fireEvent.click(within(settingsDialog).getByRole('tab', { name: '提醒与通知' }));

    expect(within(settingsDialog).getByPlaceholderText('https://…')).toBeTruthy();
    expect(within(settingsDialog).queryByText(/还没读到这台服务上的设置/)).toBeNull();
    // 这一页有服务端设置可存，所以设置表单那颗「保存」在；ServerSetup 自己
    // 那颗在「数据与服务」那一页，不在这儿——两页各一颗，不再挤在同一屏。
    const saves = within(settingsDialog).getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '保存');
    expect(saves.length).toBe(1);
  });

  it('门二：在线时 /api/settings 真的失败（device.json 坏了之类），弹错误提示——不是悄悄咽下去', async () => {
    vi.mocked(api.settings).mockRejectedValueOnce(new Error('device.json 读不出来'));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    expect(await screen.findByText('device.json 读不出来')).toBeTruthy();
    // 别的字段照样刷新——「弹提示」不该退回成「整个 reload 中断」。
    expect((await screen.findAllByText('交房租')).length).toBeGreaterThan(0);
    await waitFor(() => expect(trashFetchCount).toBeGreaterThan(0));
  });

  it('门二的另一半：离线那种预期失败照旧安静，不会每次刷新都弹一条「离线时无法读取设置」', async () => {
    vi.mocked(api.settings).mockRejectedValueOnce(offlineSettingsFailure());
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await screen.findAllByText('交房租');
    await waitFor(() => expect(trashFetchCount).toBeGreaterThan(0));
    expect(screen.queryByText('离线时无法读取设置，连接服务器之后再试')).toBeNull();
  });
});

describe('App：全局吃掉真实文件的 dragover/drop——不让浏览器把窗口导航到 file:///…', () => {
  // final-review.md「专项判定」：卡片之外（视图空白处、卡片缝隙、侧栏……）
  // 没有任何全局 preventDefault 的话，文件掉在那里会走浏览器默认动作，把
  // 整个窗口导航到 file:///…，正在编辑的草稿和选中态一起没。这道兜底跟
  // TaskCard 的拖放区扩不扩到整张卡无关，两边都要有。
  it('window 收到带 Files 的 dragover/drop 都会被 preventDefault', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined()); // 等 useEffect 都跑完，监听器都挂上了

    const dragOverNotCanceled = fireEvent.dragOver(window, { dataTransfer: { types: ['Files'] } });
    expect(dragOverNotCanceled).toBe(false);

    const dropNotCanceled = fireEvent.drop(window, { dataTransfer: { types: ['Files'] } });
    expect(dropNotCanceled).toBe(false);
  });

  it('卡片拖拽（text/plain）不受影响——这道全局兜底只吃真的文件', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined());

    const notCanceled = fireEvent.dragOver(window, { dataTransfer: { types: ['text/plain'] } });
    expect(notCanceled).toBe(true);
  });
});

describe('App：三栏都挂着自己的类名——min-width 全靠它落到 CSS 上', () => {
  /**
   * **这两条以前钉的是内联 `style={{ minWidth: 0 }}`**，那一批把它搬进了 theme.css：
   * 宽屏下三栏要的不是 0 而是各自的下限（200 / 380 / 300），而内联样式压过样式表、
   * 写不出两档。数值那一半现在由 `theme.css.test.ts` 盯着（它比原来强——原来只断言
   * 「是 0px」，现在断言的是每一栏那个具体的数）。
   *
   * 留在这一层的是它管不了的那半：**类名还挂着没有**。谁把 `className` 改了名或者
   * 漏了，CSS 那三条规则一条都落不下来，而 `theme.css.test.ts` 只读样式表、看不见
   * JSX 那边是不是还叫这个名字。
   */
  it('侧栏、任务列表、详情三栏的 className 都在', async () => {
    localStorage.setItem('density', 'row');
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const title = await waitFor(() => {
      const el = container.querySelector('.ink-trow-title');
      expect(el, '行档里该有那条任务的标题').not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 15_000 });

    expect(container.querySelector('.ink-rail-col'), '侧栏那一列').not.toBeNull();
    expect(container.querySelector('.ink-board-col'), '任务列表那一列').not.toBeNull();

    // 详情那一列点开才有。
    fireEvent.click(title);
    await waitFor(() => expect(container.querySelector('.ink-detail-col'), '详情那一列').not.toBeNull());
  });

});

describe('App：去处写进 URL hash', () => {
  it('切去处会写进 hash，刷新回到同一个去处', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    expect(window.location.hash).toBe('#/done');
  });

  it('带着 hash 打开就落在那个去处，不是「今天」——初始读自己做到的，不是靠 hashchange 补的', async () => {
    // 光是「赋值 hash → render → findByRole」测不出初始读：jsdom 里赋值 hash
    // 会排一个 hashchange 任务落在 mount 之后，App.tsx 里那个 hashchange 监听器会把
    // view 兜回来，绿的是监听器不是 useState 的初值（见 final-review.md I1）。
    // 这里把 hashchange 这条路堵死，逼 useState(() => viewFromHash(...)) 单独
    // 扛住这条断言。
    window.location.hash = '#/upcoming';
    const realAdd = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, ...rest: unknown[]) => {
      if (type === 'hashchange') return;
      (realAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener);
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    expect(await screen.findByRole('heading', { level: 1, name: '接下来' })).toBeTruthy();
  });

  it('后退回到上一个去处', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    window.location.hash = '#/today';                       // 模拟后退
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 1, name: '今天' })).toBeTruthy();
  });
});

// 看板/四象限现在固定行档（task-3-brief 要点①）——非编辑态渲染的是
// TaskRow，它的拖拽抓手（.ink-trow-handle）常驻挂在 DOM 里，没悬停/没聚焦
// 时只是视觉上用 .ink-trow-handle-hidden 藏起来（复审修复轮 1 · I4：早前
// 一版是悬停/聚焦才挂进 DOM，纯键盘正向 Tab 摸不到，见 TaskRow.tsx 同款
// 注释），不像以前 TaskCard 的 .ink-rank 抓手那样从来没有过这个门槛。
// 这里先在 scope 里悬停第一个 .ink-trow 让它显示出来，再取抓手，下面几处
// 拖拽测试共用这个工具，别各写一份。
//
// 修复轮 1 · C-1：`.ink-trow` 不在时**必须抛错**，不能悄悄退回全局查询
// ——那样会转手把 TaskCard 常驻的 `.ink-rank` 抓手递出去，density="row"
// 被删掉（看板悄悄退回卡片档）这件事会被这个工具的静默兜底吃掉：拖拽测试
// 照样能找到一个「可拖的东西」、照样能拖成功，但拖的已经不是 TaskRow 了，
// 测试却依然全绿。抛错让这个降级路径直接失败，不再靠巧合。task-3-brief
// （拖拽换成 @dnd-kit）之后同样抛错：悬停之后找不到 `.ink-trow-handle`
// 也是接线断了的信号，不该悄悄返回 null 让调用方在 null 上继续操作、抛出
// 一个指向错误位置的 TypeError。
const hoverAndGetHandle = (scope: HTMLElement): HTMLElement => {
  const row = scope.querySelector('.ink-trow');
  if (!row) throw new Error('这个面板不是行档——density="row" 可能被删了');
  fireEvent.mouseEnter(row);
  const handle = scope.querySelector<HTMLElement>('.ink-trow-handle');
  if (!handle) throw new Error('悬停之后没有找到 .ink-trow-handle——拖拽抓手可能没有正确接线');
  return handle;
};

describe('App：看板 / 四象限两个视图接进导航', () => {
  it('切到看板，四列都在（哪怕某列是空的），而且是并排的格子布局', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '写周报' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await goBoard();
    // 只有「待办」有任务，其余三列空着——keepEmpty 要求空列的标题也在，
    // 不能只看到有任务的那一列。
    expect(screen.getByRole('heading', { level: 2, name: /^待办/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /^进行中/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /^已完成/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /^搁置/ })).toBeTruthy();
    // App 真的传了 layout="cells"——没传的话看板退化成竖着摞的分组，四列标题
    // 依然齐全（那是 keepEmpty 管的，上面四条断言跨得过去），但不再是并排的
    // 看板。TaskGrid.test.tsx 只证明了组件收到 layout='cells' 之后行为对，
    // 没有东西证明 App 真的传了这个 prop，见 final-review.md I2。
    const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;
    expect(panel.querySelector('.ink-cells')).not.toBeNull();
  });

  // 修复轮 1 · C-1：`App.tsx` 里看板/四象限那两个 `TaskGrid` 调用点各自写死
  // `density="row"`，但在这条测试补上之前，删掉看板那一行 `density="row"`
  // 之后 `App.test.tsx` 140/140 照样全绿——拖拽测试靠的是
  // `hoverAndGetHandle`，`.ink-trow` 不在时它悄悄退回全局
  // `[draggable="true"]` 查询，转手把 `TaskCard` 常驻的 `.ink-rank` 抓手
  // 递出去，「看板还能拖」测得住，「看板是用行在拖」测不住——这正是这个
  // 仓库反复栽的「N 个接线点只覆盖一部分」，跟 `App.test.tsx` 上面
  // `DENSITY_VIEWS` 那个循环（1749 行前后）同一个形状，这里补齐看板/四象限
  // 两个没被那个循环覆盖到的接线点（它们不在 `DENSITY_VIEWS` 里，见
  // `App.tsx` 顶部注释）。
  it('看板固定行档——面板里渲染的是 TaskRow，不是 TaskCard（修复轮 1 · C-1）', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '写周报' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await goBoard();
    const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;
    // 变异验证锚点：App.tsx 里看板那个 TaskGrid 调用点的 `density="row"`
    // 被删掉——这条会红（面板退回默认档，渲染出 .ink-task-card 而不是
    // .ink-trow）。
    expect(panel.querySelector('.ink-trow'), '看板面板没有 .ink-trow——density="row" 可能被删了').not.toBeNull();
    expect(panel.querySelector('.ink-task-card'), '看板面板还在渲染 TaskCard').toBeNull();
  });

  /**
   * 复审修复轮 1 · I4：看板固定行档（`density="row"`），非编辑态渲染的是
   * `TaskRow`——它的拖拽抓手是复审点名「三处接线点里两个中招」之一（另一处
   * 是四象限，两处都靠 `App.tsx` 固定 `density="row"`）。`TaskRow.tsx` 那边
   * 已经修过（抓手常驻挂载 + `.ink-trow-handle-hidden` 视觉隐藏，见
   * `TaskRow.test.tsx` 同款注释），这里在真实的看板集成场景里再确认一遍——
   * **真的按 Tab**，不是 `.focus()`/先 `mouseEnter` 冒充。
   */
  it('键盘：真的按 Tab，看板卡片的抓手排在正向 Tab 顺序最前面，不用 Shift+Tab 折回去摸——I4', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '写周报' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await goBoard();
    const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;
    // 只在这一行自己的范围里找「下一个」——`panel` 这一层还套着 `FilterBar`
    // （task-3-brief「筛选栏叠在视图之上」），它自己的输入框/按钮会先拿到
    // 焦点，跟这条要验的事无关（真实 Tab 顺序里筛选栏确实排在前面，这条只
    // 关心「进了这一行之后，抓手是不是排在最前面」）。
    const row = panel.querySelector('.ink-trow') as HTMLElement;

    // 变异验证锚点：TaskRow.tsx 把抓手挂载条件从 `{drag && (...)}` 改回
    // `{hover && drag && (...)}`——这条会红：不悬停/不聚焦时抓手不在 DOM
    // 里，pressTab 找到的「下一个」会跳过它，直接落到勾选圈上。
    pressTab(row);
    expect(document.activeElement?.className).toContain('ink-trow-handle');
  });

  it('键盘：Tab 到抓手→Space 拿起→ArrowRight→Space 放下——看板里把卡拖进「进行中」，发出的是 status 的 PATCH', async () => {
    const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
    try {
      currentTasks = [task({ id: 'a', status: 'todo', title: '写周报' })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await goBoard();

      // 「今天」「按来源」是 keepMounted 的，切走之后还挂在树上（只是 hidden）——
      // 这条任务同时是「今天」的成员（默认 task() 夹具的 reminders 是过期的），
      // 那边也会渲染出一张同一个 id 的卡。把查询范围锁在 .ink-view-panel-kanban
      // 里，不然拿到的可能是「今天」那张（DOM 顺序里排在看板前面），不是这次
      // 真正要拖的这张。
      const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;
      const handle = hoverAndGetHandle(panel);
      // kanbanCells 的列顺序固定：待办/进行中/已完成/搁置——ArrowRight 一次
      // 从「待办」（第 0 格）移到「进行中」（第 1 格）。
      await keyboardDrag(handle, ['ArrowRight']);

      await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('a', { status: 'doing' }));
    } finally {
      restore();
    }
  });

  /**
   * 复审修复轮 2：`useCancelStuckDrag`（lib/dnd.ts）发的合成 Escape 之前
   * `bubbles: true`——`App.tsx` 的全局 `keydown` 监听器挂在 `window` 上
   * （冒泡阶段），Escape 分支不看 `e.target` 直接 `clearSelection()`，冒泡
   * 上去会顺带清空用户当时选中的、跟这次「拖拽卡死」毫无关系的其它任务。
   * `KeyboardSensor` 的取消监听器直接挂在 `document` 自己身上，`bubbles:
   * false` 不影响它收到——见 `lib/dnd.ts` 顶部注释。这里钉住修完之后的
   * 行为：选中甲、乙两张卡，对第三张（丙）走一次键盘拾取，丙在拖拽中途
   * 消失——甲、乙的选中必须原样还在，批量条也不该消失。
   *
   * 变异验证锚点：`lib/dnd.ts` 里派发事件的 `bubbles: false` 改回 `true`
   * ——这条会红（选中数从 2 掉到 0，批量条消失）。
   */
  it('看板里键盘拖拽卡死自动取消，不会把用户选中的其它卡一起清空（复审修复轮 2）', async () => {
    const restore = mockDndRects('.ink-grid-section', { vertical: false, gap: 300 });
    try {
      currentTasks = [
        task({ id: 'a', status: 'todo', title: '任务甲' }),
        task({ id: 'b', status: 'todo', title: '任务乙' }),
        task({ id: 'c', status: 'todo', title: '任务丙' }),
      ];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await goBoard();
      const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;

      fireEvent.click(within(panel).getByTitle('任务甲'), { ctrlKey: true });
      fireEvent.click(within(panel).getByTitle('任务乙'), { ctrlKey: true });
      await waitFor(() => expect(panel.querySelectorAll('.ink-trow-selected').length).toBe(2));

      const row3 = within(panel).getByText('任务丙').closest('.ink-trow') as HTMLElement;
      fireEvent.mouseEnter(row3);
      const handle3 = row3.querySelector<HTMLElement>('.ink-trow-handle')!;
      handle3.focus();
      fireEvent.keyDown(handle3, { code: 'Space', key: ' ' });
      await new Promise((r) => setTimeout(r, 0));

      // 丙消失：文件 → SSE data-changed('tasks') → reload，跟真实链路一致，
      // 不手动 setState。甲、乙没被碰过，原样留在新的任务列表里。
      currentTasks = currentTasks.filter((t) => t.id !== 'c');
      act(() => handlers.onChange!('tasks'));
      // useCancelStuckDrag 的派发在 useEffect 里，等它跑完这一轮。
      await new Promise((r) => setTimeout(r, 0));

      expect(panel.querySelectorAll('.ink-trow-selected').length).toBe(2);
      expect(screen.queryByRole('toolbar', { name: '批量操作' })).not.toBeNull();
    } finally {
      restore();
    }
  });

  // 修复轮 1 · C-1（跟上面看板那条同一个理由，同一个形状）：四象限那个
  // `TaskGrid` 调用点的 `density="row"` 同样没有专门的正面断言守着——它以前
  // 只是被「四象限：正在编辑的卡被…标成完成」那条 SSE 用例巧合守住（那条
  // 里有一句 `fireEvent.click(within(panel).getByTitle('重要的事'))`，是为了
  // 把行展开成卡才加的，不是为了守 density），谁以后重构掉那一行点击，
  // 四象限的守卫就跟着消失，而且失败信息不会指向密度。这里单独补一条。
  it('四象限固定行档——面板里渲染的是 TaskRow，不是 TaskCard（修复轮 1 · C-1）', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '重要的事', due: null })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const panel = container.querySelector('.ink-view-panel-quadrant') as HTMLElement;
    await waitFor(() => expect(within(panel).getByText('重要的事')).toBeDefined());
    // 变异验证锚点：App.tsx 里四象限那个 TaskGrid 调用点的 `density="row"`
    // 被删掉——这条会红。
    expect(panel.querySelector('.ink-trow'), '四象限面板没有 .ink-trow——density="row" 可能被删了').not.toBeNull();
    expect(panel.querySelector('.ink-task-card'), '四象限面板还在渲染 TaskCard').toBeNull();

  });

  /**
   * **两套象限规则（仿滴答清单的「规则组合1 / 规则组合2」）真的换得动。**
   *
   * `cells.test.ts` 只证明 `quadrantCells` 认 `rule` 那个参数——证明不了那两个
   * 单选钮接上了它。`quadRule` 忘了往下传、或者只传给两处调用点里的一处
   * （四象限那一屏调了两次 `quadrantCells`：一次喂 allFilteredOut/拖拽找源格，
   * 一次喂真正渲染的 sections），纯函数那一层全绿，而屏幕上点了没反应。
   * 这一条从点击出发，看格子标题里那个数字。
   */
  it('四象限：切到「按时间 + 优先级」，任务真的换格子', async () => {
    // priority 0 + 今天到期：按优先级那套落「不重要也不紧急」（priority 0 那格），
    // 按时间那套落「不重要但紧急」（今天到期）。挑的就是两套规则给不同答案的
    // 那种任务——挑一条两套都落同一格的，这条用例会永远绿。
    const due = new Date();
    due.setHours(20, 0, 0, 0);
    currentTasks = [task({ id: 'a', status: 'todo', title: '今天的小事', priority: 0, due: due.toISOString() })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const panel = container.querySelector('.ink-view-panel-quadrant') as HTMLElement;

    /** 某一格标题里那个计数。锚在 <h2> 上按标题开头找，不用 getByText：
     *  格子标题里「不重要也不紧急」和「不重要但紧急」只差一个字，而
     *  getByText 的子串匹配会同时命中两个。 */
    const countIn = (title: string) => [...panel.querySelectorAll('h2.ink-grid-heading')]
      .find((el) => el.textContent?.startsWith(title))
      ?.querySelector('.ink-grid-count')?.textContent;

    await waitFor(() => expect(within(panel).getByText('今天的小事')).toBeDefined());
    expect(countIn('不重要也不紧急'), '默认档是按优先级：priority 0 该落「不重要也不紧急」').toBe('1');
    expect(countIn('不重要但紧急'), '默认档下不该有东西在「紧急」那一列').toBe('0');

    fireEvent.click(within(panel).getByLabelText('按时间 + 优先级'));

    await waitFor(() => expect(countIn('不重要但紧急')).toBe('1'));
    expect(countIn('不重要也不紧急'), '换了规则它不该还留在原来那格').toBe('0');
    // 说明那行也得跟着换——不然屏幕上摆着「跟截止时间无关」，而格子正是按
    // 截止时间分的，人有理由认为是算错了。
    expect(panel.textContent, '切了规则，那行说明没跟着换').toContain('3 天内到期');
  });

  // 修复轮 1 · C-2：`compact` 只该接在看板那一个调用点上——四象限同样是
  // `layout="cells"`，但每格 455px，标题读得全，不该被一起改窄（brief 原话
  // 「四象限也是 cells，但它有 455px，标题读得全，别把它一起弄坏」）。同一份
  // 带标签的任务，看板渲染成紧凑（标签不在 DOM 里），四象限渲染成非紧凑
  // （标签还在）——一次对比覆盖两个方向，比分别断言「看板 compact」+
  // 「四象限不 compact」更不容易在中间态漏出一个「两边都 compact」或
  // 「两边都不 compact」的坏实现。
  it('看板紧凑、四象限不紧凑——同一份带标签的任务，看板不渲染标签，四象限渲染（修复轮 1 · C-2）', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '写周报', tags: ['紧急'], due: null })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await goBoard();
    const kanbanPanel = container.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(kanbanPanel).getByTitle('写周报')).toBeDefined());
    // 变异验证锚点 a：App.tsx 看板那个 TaskGrid 调用点的 `compact` 被删掉
    // ——这条会红（标签照样渲染）。
    expect(kanbanPanel.querySelector('.ink-trow-tags'), '看板的行不该渲染标签——compact 可能被删了').toBeNull();

    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const quadrantPanel = container.querySelector('.ink-view-panel-quadrant') as HTMLElement;
    await waitFor(() => expect(within(quadrantPanel).getByTitle('写周报')).toBeDefined());
    // 变异验证锚点 b：`compact` 被误传到四象限那个调用点——这条会红（标签
    // 消失，四象限的标题会被一起改窄，重演 C-2）。
    expect(quadrantPanel.querySelector('.ink-trow-tags'), '四象限的行标签不该被 compact 挤掉').not.toBeNull();
  });

  it('键盘：Tab 到抓手→Space 拿起→ArrowUp→Space 放下——四象限里把卡拖进「重要」那一行，发出的是 priority 的 PATCH，不带 due', async () => {
    // .ink-cells-2x2 是真正的 2×2 网格（上下两行按重要程度、左右两列按
    // 紧急程度）——columns:2 让 mockDndRects 按网格（行优先）摆位置，ArrowUp/
    // ArrowDown 才能对应「换重要程度那一行」这个真实语义，1D 的横向/纵向
    // 堆叠算不出这种「同列换行」的移动。
    const restore = mockDndRects('.ink-cells-2x2 .ink-grid-section', { columns: 2, gap: 300 });
    try {
      // due:null 让这条任务的紧急/不紧急判定跟真实系统时钟无关，稳落在
      // min-later（不重要也不紧急，QUADRANT_KEYS 第 4 格）。
      currentTasks = [task({ id: 'a', status: 'todo', priority: 0, due: null })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/四象限/));
      await screen.findByRole('heading', { level: 1, name: '四象限' });

      // 同上一条：锁定在这个视图自己的面板里，避开「今天」keepMounted 之后
      // 挂在树上的同一张卡。
      const panel = container.querySelector('.ink-view-panel-quadrant') as HTMLElement;
      // 跟看板那条对称：直接钉住 layout="cells" 真的传下去了。
      // `.ink-cells-2x2 .ink-grid-section` 是**后代**选择器，拿掉 layout 之后
      // section 仍然是 .ink-cells-2x2 的后代（只是少了中间那层 .ink-cells），
      // 下面那些查询照样命中、这条测试照样绿——所以必须单独断言 .ink-cells 在。
      // 定向复审实测：拿掉四象限的 layout，54 条里只有「都做完/搁置了」那条
      // 巧合红，这条正常路径全绿。看板那边补过同款断言（:280），四象限漏了。
      expect(panel.querySelector('.ink-cells')).not.toBeNull();
      const handle = hoverAndGetHandle(panel);
      // QUADRANT_KEYS 顺序：imp-urg / imp-later / min-urg / min-later——这条
      // 任务落在第 4 格（min-later，网格里是第 2 行第 2 列），ArrowUp 一次
      // 移到同一列（不紧急）的第 1 行，也就是第 2 格（imp-later）。
      await keyboardDrag(handle, ['ArrowUp']);

      // toHaveBeenCalledWith 精确匹配这一个 patch 对象的全部键——不是
      // objectContaining/toMatchObject 那种「至少含有这几个键」的部分匹配。
      // 后者对「多带了一个 due」也成立，正好是这里要防的：拖拽换象限只改
      // priority，due 是他自己填的事实，不该被这次拖拽凭空造出来或者销毁。
      await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('a', { priority: 2 }));
      // 这条任务还在四象限里可见（拖拽只改了 priority，不会把它滤空）——
      // allFilteredOut 的 every 一旦被错改成 some，只要四格里有任何一格是空的
      // 就会显示「都做完或搁置了」，这里四格里明明有一张可见的卡，那句话不该
      // 出现。以前唯一守着这个方向的断言被 `tasks.length > 0` 挡住，永远走不到
      // `every`/`some` 那一步（那条测试里 currentTasks 是空数组），见
      // final-review.md I3。
      expect(screen.queryByText(/都做完/)).toBeNull();
    } finally {
      restore();
    }
  });

  // task-4-brief 修复轮 1 · B：这句说明以前是常驻的一整行（.ink-quadrant-hint），
  // 跟日历那句「拖动任务到别的日期……」同一个待遇，挪进了 .ink-cells-2x2
  // 的原生 `title`（悬停才弹出）——上限（不再常驻显示成一整行文字）+ 正向
  // （title 里还有这句话，不是被整个删掉）各一条断言，跟 CalendarGrid.test.tsx
  // 那条「挪进 title」的写法是同一个套路。
  /**
   * 四象限那两句话按「**鼠标独占与否**」分开放，这条把两边都钉住。
   *
   * 上一版这条叫「说明挪进 title，不再常驻占一整行」（修复轮 1 · B），钉的是
   * 「一行常驻文案都没有」。那个结论建立在一个**已经退役的模型**上：当时横轴
   * （紧急）是按 `due` 算出来的只读坐标，那句话讲的纯粹是「左右拖不动」这个
   * 鼠标动作，触屏上看不到它的人本来就做不了那个动作。
   *
   * 向滴答清单靠齐那一轮把模型换成了「四格 = 四档优先级」（见 lib/cells.ts），
   * 那句话因此装了两件事，而只有一件该藏：
   * - **拖到哪一格就是设成那一档**：仍然是鼠标独占（HTML5 drag-and-drop 触屏
   *   不触发），留在 `title` 里；
   * - **四格就是四档优先级**：这是**怎么读这一屏**，跟输入设备无关。藏起来的
   *   后果是手机上完全看不到，而屏幕上摆着看似矛盾的证据（一条今天到期的任务
   *   坐在「不紧急」格里）。
   *
   * 所以现在两边都要在，而且**不许互相重复**。
   */
  it('拖拽那句留在 title，怎么读这一屏那句常驻——两边都在，且不重复', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const panel = document.querySelector('.ink-view-panel-quadrant') as HTMLElement;

    // 拖拽那句：精确匹配整句原文，不是子串（跟 CalendarGrid.test.tsx 那条
    // 修复轮 1 · m-1 同一条教训：`toContain`/正则子串会放过被压缩成两三个字的
    // 写死文案）。
    expect(within(panel).getByTitle('拖到哪一格，就是把这条任务的优先级设成那一档。')).toBeTruthy();

    // 怎么读那句：常驻，不靠悬停。
    const note = panel.querySelector('.ink-quadrant-note');
    expect(note, '四象限少了那行常驻说明——手机上没有悬停，藏进 title 等于没有').not.toBeNull();
    expect(note!.textContent).toContain('四格就是四档优先级');
    expect(note!.textContent).toContain('跟截止时间无关');

    // **两边不重复**：常驻那行不讲拖拽（触屏上根本拖不动，讲了也做不了），
    // title 里也不再跟着念一遍「高 / 中 / 低 / 无」。
    expect(note!.textContent).not.toContain('拖');
  });

  it('四象限：任务都完成/搁置了时，显示一句提示——不是四个空盒子，跟「一条任务都没有」分得清', async () => {
    currentTasks = [task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'later' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    // 不用「搁置」这种宽泛的词单独匹配——卡片自己的状态徽标上就有一个
    // 「搁置」字样，会撞车（同一个字符串出现在两处）。锁住这句话的完整措辞。
    expect(screen.getByText('都做完、搁置，或者还没到开始时间——四象限只看现在能做的')).toBeTruthy();
    // 格子骨架还在——这句话是加在旁边的，不是把四个格子换掉。
    expect(screen.getByRole('heading', { level: 2, name: /重要且紧急/ })).toBeTruthy();
  });

  it('四象限：真的一条任务都没有时，不显示「都做完了」这句话——那句话专指「有任务但被滤空」', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    expect(screen.queryByText(/都做完/)).toBeNull();
  });

  /**
   * **上面那条只证了「不该出现的那句不在」，没证「该出现的那句在」**——于是
   * 真空手时四象限一句话都不说这件事，一直没有任何测试盯着，是实拍才发现的：
   * 一个刚上手的人打开四象限，看到四个带标题的空盒子，没有一个字告诉他这屏
   * 是干什么的、下一步该做什么。
   *
   * 这一屏的 `empty` prop 帮不上忙：`quadrantCells` 恒返回四格（那是一个坐标
   * 系，缺一个就不成立），`TaskGrid` 因此永远不认为它空。
   */
  it('四象限：真的一条任务都没有时，说一句话——不是四个没有任何说明的空盒子', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    expect(await screen.findByText(/还没有任务。新建一条/)).toBeTruthy();
    // 格子骨架还在——这句话是加在旁边的，不是把坐标系换掉。
    expect(screen.getByRole('heading', { level: 2, name: /重要且紧急/ })).toBeTruthy();
  });

  // 组件那一层（cells.test.ts）只证明 quadrantCells 支持 keep 参数——不证明
  // App.tsx 真的把 TaskGrid 回传的 editing 传了进去。这条钉住接线那一层：
  // 编辑态里状态按钮整个被换掉（TaskCard.tsx 的 draft ? 保存/取消 : MOVES…），
  // 这张卡自己没法在编辑框里把自己标成完成——真实触发路径是另一个客户端
  // （浏览器标签页/桌面版）改的，这里用同一条真实链路模拟：改 currentTasks →
  // SSE data-changed('tasks') → reload，不是绕过链路手动 setState。
  it('四象限：正在编辑的卡被（另一个客户端）标成完成，卡还在、草稿还在——不然编辑框会在手底下蒸发', async () => {
    currentTasks = [task({ id: 'a', status: 'todo', title: '重要的事', due: null })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const panel = container.querySelector('.ink-view-panel-quadrant') as HTMLElement;
    await waitFor(() => expect(within(panel).getByText('重要的事')).toBeDefined());

    // 走行上那颗 ⋯ 的「编辑」：它现在直接把**右边那一栏详情面板**里的卡开成
    // 表单（带 edit 意图，见 TaskGrid.tsx Props.onOpenDetail），不再是当场把
    // 这一行膨胀成一张卡。⋯ 只在悬停/聚焦时才挂进 DOM。
    const row = within(panel).getByTitle('重要的事').closest('.ink-trow') as HTMLElement;
    fireEvent.mouseEnter(row);
    await pickCardMenu('编辑', { scope: row });
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    fireEvent.change(within(detail).getByPlaceholderText('标题'), { target: { value: '改到一半还没存' } });

    currentTasks = [{ ...currentTasks[0], status: 'done' }];
    act(() => handlers.onChange!('tasks'));

    // 先等 SSE 更新真的落地、这一整棵子树按新的 tasks 重渲染过一轮——不能
    // 直接断言「输入框里的值还是刚才那个」：reload() 是异步的，act() 一返回
    // 那一刻更新多半还没落地，此时输入框当然还在、值当然没变，waitFor 第一次
    // 同步检查就会通过，测不出「更新落地之后卡是不是还在」这件事（这条踩过：
    // 单独跑这个变异——App.tsx 那处 sections 忘了传 editing——这条断言照样
    // 全绿，因为它从来没等到更新真的发生过）。
    // 「都做完或搁置了」这句提示来自 App.tsx 里另一份 `cells`（quadrant 那段
    // 顶部、keep 恒为 new Set() 的那份，只用于这句提示和 onDropTo 的 fromCell
    // 查找，注释里写明了不需要感知 editing），只要 tasks 状态真的变成
    // done，这句提示就会出现，跟正在验证的 `sections={(editing) => …}` 那一行
    // 是否传对了 editing 完全无关——拿它当「更新落地了」的中性信号，不会跟
    // 正在验证的那半段代码混在一起自我印证。
    await screen.findByText('都做完、搁置，或者还没到开始时间——四象限只看现在能做的');

    // **详情面板按 id 从全量 tasks 现查**，压根不经过 quadrantCells 那份
    // sections——这张卡被标成 done、从四个格子里全部消失，面板里的编辑框和
    // 草稿一个字都不动。这比原来那条契约（`editing` 兜住被筛掉的卡）强：那个
    // 要每个视图各自记得把 editing 传进 sections，漏一个就丢一次草稿，而这条
    // 测试当初就是为了钉住其中一次漏传。
    const liveDetail = screen.getByRole('complementary', { name: '任务详情' });
    const input = within(liveDetail).getByPlaceholderText('标题') as HTMLInputElement;
    expect(input.value).toBe('改到一半还没存');
  });

  it('地址栏跟着变（#/quadrant）——**看板没有 hash 了**，它是显示方式不是去处', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    expect(window.location.hash).toBe('#/quadrant');

    // 切成看板不动 hash：同一个去处、换个摆法，刷新之后还该在这个去处上。
    await goBoard();
    expect(window.location.hash).toBe('#/all');
  });
});

// CalendarGrid 收十个 prop（days/mode/anchor/now/selectedKey/onSelectDay/
// onShift/onToday/onModeChange/onDropOnDay）。CalendarGrid.test.tsx 只证明组件
// *支持*这十个 prop——不证明 App 真的传了它们，那正是 board-and-quadrant 批栽了
// 四次的形状（final-review 第八节）。下面每条测试都点名了它在守哪几个 prop。
// **`onToday` 是唯一一个还没有 App 层测试的**：CalendarView 里那行改成
// `() => {}` 的话，类型过、CalendarGrid.test.tsx 那颗本地 vi.fn() 也过，
// 「今天」会安安静静地什么都不做。
describe('App：日历接进导航', () => {
  it('默认月视图 42 格，今天那一格标着 now 的日期——守 days/mode/now 三个 prop', async () => {
    // 只固定 Date，不连 setTimeout/setInterval 一起 fake——这个 App 的导航
    // 靠 hash 驱动（点导航写 window.location.hash，jsdom 派发 hashchange
    // 走的是一次排队的宏任务），把 setTimeout 也 fake 掉的话 hashchange
    // 收不到、findByRole 的轮询也收不到，两个都会一路等到测试自己的 15s
    // 超时——实测踩过。只 fake Date 就够：不用裸 new Date()（见「必须遵守
    // 的全局约束」，这个仓库已经在这一批别的测试里踩过三次），又不动真实
    // 定时器，hashchange/findByRole 照常工作。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      expect(window.location.hash).toBe('#/calendar');

      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
      // days：默认月视图必须是 42 个格子（不是硬编码的别的数、也不是空数组）。
      expect(panel.querySelectorAll('.fc-daygrid-day')).toHaveLength(42);
      // now：「今天」标记必须落在 now 那一天——把 now 写死成别的日期，这条会红。
      const todayCell = panel.querySelector('.fc-day-today');
      expect(todayCell).not.toBeNull();
      expect(todayCell!.querySelector('.ink-cal-daynum')?.textContent).toBe('16');
    } finally {
      vi.useRealTimers();
    }
  });

  // final-review.md I1：默认夹具里 anchor（CalendarView 自己的 useState(now)）
  // 挂载那一刻恒等于 now——上面那条「今天标记对不对」的断言全跑在这一刻，
  // 分不清 CalendarGrid 内部读的是 now 还是 anchor：把实现里的 dayKey(now)
  // 改成 dayKey(anchor)，79/79 照样全绿；把 CalendarView 传给 CalendarGrid
  // 的 now={now} 写成 now={anchor}，62/62 也照样全绿。这里翻一页把 anchor
  // 和 now 分开：now 钉死在 8/16（CalendarView 自己的 useState 只在挂载
  // 那一刻取值一次，翻页不影响它），翻到下一页后 anchor 变成 9/1，两者
  // 第一次真的不相等。
  it('翻到下一页：「今天」的标记消失（真实的 8/16 不在 9 月这页里），不是跟着锚点冒到 9 月 1 日——守 now 这个 prop，防的是「传串成 anchor」', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0)); // 今天钉死在 2026-08-16（周日）
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 挂载那一刻 anchor 恒等于 now（8/16），今天标记落在 8/16——这一步
      // 单独测不出「读的是哪个」，跟上一条测试同一个道理。
      expect(panel.querySelector('.fc-day-today')).not.toBeNull();

      // 翻到下一页：anchor 变成 9 月 1 日（2026-09-01 是周二），9 月的月
      // 视图从「9/1 所在周的周一」即 8/31 开始，8/16 落不进这份 42 格网格。
      // 如果「今天」读的是 now，这一页根本不该出现任何一格 today 标记；
      // 读成了 anchor，则会在 9/1（当页新的锚点，一定在网格里）冒出一格
      // 假的「今天」。
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('2026年9月');
      expect(panel.querySelector('.fc-day-today')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // onToday 这个 prop 只有 CalendarGrid.test.tsx 那颗本地 vi.fn() 守着——那只证明
  // 「按钮点了会调 onToday」，不证明 App 真的把它接到了会动锚点的东西上。改成
  // `onToday={() => {}}` 的话类型过、那条也过，「今天」安静地什么都不做。这是
  // 上面那段注释点名的形状，补掉最后一个没有 App 层测试的 prop。
  it('翻页之后点「今天」：标题回到本月、今天那一格重新出现——守 onToday 这个 prop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 先真的翻走两页——不翻的话 anchor 本来就等于 now，点不点「今天」都一样，
      // 这条测试会变成一条永远绿的废话。
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('2026年10月');
      expect(panel.querySelector('.fc-day-today')).toBeNull();

      fireEvent.click(within(panel).getByRole('button', { name: '今天' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('2026年8月');
      expect(panel.querySelector('.fc-day-today')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 翻页之后切档，不许把刚翻的页撤销回去。
   *
   * `handleModeChange` 会把锚点同步到 `selectedKey`（「点『日』九成是想看我刚点的
   * 那天」），但那个 key 在翻页之后可能早就不在屏幕上了——当天列表按派生守卫
   * 藏了起来，`selectedKey` 本身却还留着。少了 `days.some(...)` 那道守卫，这里
   * 点「周」会把标题拽回 8 月，用户刚翻到的 9 月凭空消失，而他什么都没点。
   *
   * 这条路是「上一页/下一页」，不是「今天」——同一个 bug 三条路都会犯，守卫在
   * `handleModeChange` 里只写一次。以前它只在 `onToday` 那个调用方补过一句
   * `setSelectedKey(null)`，翻页这两条一直漏着。
   */
  it('选了某天再翻页，之后切「周」：停在翻到的那一页，不跳回选中那天所在的月', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 选中当月的某一天（8/25）。走的是跟既有那条「点某一天」测试同一条路：
      // 在格子上敲回车，而不是 click 日期数字——jsdom 里后者不会触发
      // FullCalendar 的 dateClick，selectedKey 压根不会被设上。
      const cell = panel.querySelector('[data-date="2026-08-25"]') as HTMLElement;
      expect(cell, '月格里找不到 8/25 那一格').toBeTruthy();
      fireEvent.keyDown(cell, { key: 'Enter' });
      // **这条中间断言不能省**：选中没真的生效的话，下面整条测试会变成
      // 「selectedKey 一直是 null」的空跑——把守卫删掉它照样绿（实测过，
      // 变异验证当场发现的假绿）。
      expect(cell.getAttribute('aria-current'), '8/25 没被选中，后面的断言全是空跑').toBe('date');

      // 翻走一页：selectedKey 还是 8/25，但它已经不在这一页的 42 格里了。
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('2026年9月');

      // 切档。**必须还停在翻到的那一页**——回到 8/25 那一周就说明陈旧的
      // selectedKey 把锚点拽回去了，而用户从头到尾没要求回 8 月。
      // 周视图标题是「该周第一天 - 最后一天」，9 月第一周跨月，所以正确答案是
      // 「8月31日 - 9月6日」——断言写成 /^9月/ 会错杀（这里踩过一次）。判据用
      // 「含 9月」+「不是 8/25 所在的那一周」两条，跨月周和错误答案都区分得开。
      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
      const heading = panel.querySelector('.ink-cal-heading')!.textContent!;
      expect(heading, '切档后应该还在 9 月那一页').toContain('9月');
      expect(heading, '不该跳回 8/25 所在的那一周').not.toContain('8月24日');
    } finally {
      vi.useRealTimers();
    }
  });

  it('切到周视图渲染 7 列小时格，「周」按钮变成按下态——守 mode/onModeChange 两个 prop', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

    fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
    // task-6：周视图走 FullCalendar 的 timeGridWeek（`.fc-timegrid-col`，
    // 时间轴那半，不含 `.fc-timegrid-axis` 那一列本身），不再是月视图的
    // 42/7 格 dayGrid 网格；也不是退役前 CalendarHours 手写的 `.ink-calh-col`。
    expect(panel.querySelectorAll('.fc-timegrid-col:not(.fc-timegrid-axis)')).toHaveLength(7);
    // 格子数只证明内部 mode state 变了（驱动 calendarDays 重算 days）——
    // 不证明 CalendarGrid 收到的 `mode` prop 本身对不对，那个 prop 唯一的
    // 可见效果是这两颗按钮的按下态。把 `mode` prop 写死会让格子数照样对，
    // 但这两个断言会红。
    // **档位从三颗按钮换成了一个下拉**（档数长到五档，照滴答清单改的），
    // 「当前在哪一档」由 select 自己的 value 表达，不再需要手挂 aria-pressed。
    expect((within(panel).getByLabelText('看哪一档') as HTMLSelectElement).value).toBe('week');
  });

  it('翻到下一页，表头的年月变了——守 anchor/onShift 两个 prop', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

    const before = panel.querySelector('.ink-cal-heading')!.textContent;
    fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
    expect(panel.querySelector('.ink-cal-heading')!.textContent).not.toBe(before);
  });

  it('点某一天，下面出现当天的任务列表（行档，task-3-brief 固定）——守 selectedKey/onSelectDay 两个 prop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 16, 18, 30, 0, 0); // 今天 18:30，不用 00:00
      currentTasks = [task({ id: 'a', title: '今天要做的事', due: due.toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 没点之前，当天列表整个不在——不是「显示但是空的」。
      expect(panel.querySelector('.ink-row-list')).toBeNull();

      const todayCell = panel.querySelector('.fc-day-today')!;
      fireEvent.keyDown(todayCell, { key: 'Enter' });
      // selectedKey 真的传回了 CalendarGrid：点过的那一天标着 aria-current。
      expect(todayCell.getAttribute('aria-current')).toBe('date');
      // 当天列表（`.ink-row-list`，task-3-brief 固定行档）出现，里面是这张卡的
      // 完整标题——查询范围收进 `.ink-row-list` 里，不用不加范围的
      // findByText：同一段标题文字同时也出现在日历格子里的截断标题（同一张
      // 卡，两处都合理地显示它），不加范围会撞上「找到两处」。
      const grid = await waitFor(() => {
        const g = panel.querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g;
      });
      expect(within(grid as HTMLElement).getByText('今天要做的事')).toBeTruthy();
      // 修复轮 1 · C-1（跟看板/四象限同一个理由、同一个形状）：`TaskGrid.tsx`
      // 273 行的容器 class 是按 `density === 'row'` 二选一（`.ink-row-list`/
      // `.ink-card-grid`），不是同一个容器换里面渲染的内容——`density="row"`
      // 被删掉之后容器整个变成 `.ink-card-grid`，上面那个
      // `waitFor(() => panel.querySelector('.ink-row-list'))` 会直接超时，
      // 走不到下面这条断言，不是「容器还在、只是内容变了，上面的断言测不出
      // 这件事」。这条留着是给 `.ink-trow`/`.ink-task-card` 这两半当正面
      // 断言：容器类对了之后，容器*里面*渲染的确实是 `TaskRow` 不是
      // `TaskCard`，不是防上面那种「整个容器类都错了」的失败模式（那种会在
      // waitFor 那步先红，报的是「当天列表还没出现」，不是这里的诊断信息）。
      expect(grid.querySelector('.ink-trow'), '当天列表没有 .ink-trow——density="row" 可能被删了').not.toBeNull();
      expect(grid.querySelector('.ink-task-card'), '当天列表还在渲染 TaskCard').toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('点一天但那天没有任务：列表区说一句话，不是空白', async () => {
    currentTasks = [];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

    fireEvent.keyDown(panel.querySelector('.fc-day-today')!, { key: 'Enter' });
    expect(await within(panel).findByText(/这天还空着/)).toBeTruthy();
    expect(panel.querySelector('.ink-row-list')).toBeNull();
  });

  // final-review.md I2：上面那条「没有任务时说一句话」的测试名字以前提了
  // sections(editing) 契约，但从头到尾没打开过编辑框，守不住这件事——去掉
  // CalendarView.tsx 里 `editing.has(t.id) ||` 那半句，62/62 照样全绿。这条
  // 补真正的契约：正在编辑的卡被另一个客户端把 due 改到别的日子，当天列表
  // 重算不该把编辑框连同草稿一起摘掉——跟 Task 1 刚为四象限修的是同一类
  // 数据丢失（377 行那条）。写法照抄那一条：改 currentTasks → SSE
  // data-changed('tasks') → 等一个中性信号 → 断言草稿还在，不能在更新落地
  // 之前就断言（那样测不出问题，那条测试上面有整段注释讲这个坑）。
  it('当天列表：正在编辑的卡被（另一个客户端）把 due 改到别的日子，卡还在、草稿还在——不然编辑框会连草稿一起从当天列表消失', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      currentTasks = [task({
        id: 'a', status: 'todo', title: '今天要做的事',
        due: new Date(2026, 7, 16, 18, 30, 0, 0).toISOString(),
      })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      const todayCell = panel.querySelector('.fc-day-today')! as HTMLElement;
      fireEvent.keyDown(todayCell, { key: 'Enter' });
      const grid = await waitFor(() => {
        const g = panel.querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g as HTMLElement;
      });

      // 走行上那颗 ⋯ 的「编辑」：它现在直接把**右边那一栏详情面板**里的卡
      // 开成表单（带 edit 意图，见 TaskGrid.tsx Props.onOpenDetail），不再是
      // 当场把这一行膨胀成一张卡。⋯ 只在悬停/聚焦时才挂进 DOM。
      const row = within(grid).getByTitle('今天要做的事').closest('.ink-trow') as HTMLElement;
      fireEvent.mouseEnter(row);
      await pickCardMenu('编辑', { scope: row });
      const detail = await screen.findByRole('complementary', { name: '任务详情' });
      fireEvent.change(within(detail).getByPlaceholderText('标题'), { target: { value: '改到一半还没存' } });

      // 另一个客户端把这张卡的 due 改到 8/20——当天列表（selectedKey 还停在
      // 8/16）按 due 重新筛选，8/16 这份 sections 不该再包含这张卡，除非
      // editing 契约兜住它。
      currentTasks = [{ ...currentTasks[0], due: new Date(2026, 7, 20, 18, 30, 0, 0).toISOString() }];
      act(() => { handlers.onChange!('tasks'); });

      // 中性信号：等更新真的落地，不能直接断言输入框还在——act() 一返回
      // 那一刻 reload() 多半还没跑完，此时输入框当然还在、值当然没变，会
      // 在更新真的发生之前就通过，测不出问题（跟 377 行那条同一个坑）。用
      // 「今天格子里这张卡的截断标题」当中性信号：due 真的挪走了，8/16
      // 这一格不会再有它——这件事跟正在验证的「草稿还在」完全无关，不会
      // 跟被测的那半段代码自我印证。
      await waitFor(() => {
        expect(within(todayCell).queryByText('今天要做的事')).toBeNull();
      });

      // 重新从 panel 现查 `.ink-row-list`，不能接着用上面那个 `grid`
      // 引用——契约要是真被拿掉，这张卡会连同它挂的 TaskGrid 一起被筛没、
      // 整个 `.ink-row-list` 都不在了（TaskGrid 转去显示 `empty` 文案），
      // React 把旧的那棵子树摘下来之后不会再更新它，`grid` 会变成一个脱离
      // 文档树、内容却停在摘除前那一刻的死引用——用它查询会读到「摘除前
      // 输入框还在」这个早已过时的快照，测不出契约被拿掉这件事（踩过一次：
      // 直接复用 `grid`，62/62 照样全绿）。
      // **详情面板按 id 从全量 tasks 现查**，压根不经过当天列表那份 sections
      // ——due 挪到别的日子、这张卡从 8/16 那一列消失，面板里的编辑框和草稿
      // 一个字都不动。这比原来那条契约（`editing` 兜住被筛掉的卡）强：那个
      // 要每个视图各自记得把 editing 传进 sections，漏一个就丢一次草稿。
      const liveDetail = screen.getByRole('complementary', { name: '任务详情' });
      const input = within(liveDetail).getByPlaceholderText('标题') as HTMLInputElement;
      expect(input.value).toBe('改到一半还没存');
    } finally {
      vi.useRealTimers();
    }
  });

  // final-review.md「日历/今天/按来源三处没接选中」：日历这一处的当天列表
  // 就是一个 TaskGrid（跟全部/看板/四象限……同一个组件），`gridWiring` 也
  // 确实把 selection/onSelectionChange/editRequestId/onEditRequestHandled
  // 四个字段传给了 CalendarView（App.tsx 493 行前后），只是以前 CalendarView
  // 自己的 `Props` 没声明它们，被 TypeScript 的 spread 规则静默丢掉——卡片
  // 长得跟别处一模一样但点不了。这条测试守住「现在接上了」：Ctrl 点当天
  // 列表里的卡片，选中标记要出现，跟全部/看板那些视图行为一致。
  it('日历当天列表接上了选中——Ctrl 点卡片会被选中，跟全部/看板等视图一样', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      currentTasks = [task({
        id: 'a', title: '今天要做的事',
        due: new Date(2026, 7, 16, 18, 30, 0, 0).toISOString(),
      })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      fireEvent.keyDown(panel.querySelector('.fc-day-today')!, { key: 'Enter' });
      const grid = await waitFor(() => {
        const g = panel.querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g as HTMLElement;
      });

      // 没点之前不该有选中标记——先证明这份夹具本身干净，不是巧合通过。
      // 固定行档：选中标记是 .ink-trow-selected（TaskRow.tsx），不是
      // TaskCard 的 .ink-task-card-selected——跟全部/看板那些视图用的是
      // 同一份 selection/onSelectionChange 接线，只是渲染成的组件不同。
      expect(panel.querySelector('.ink-trow-selected')).toBeNull();

      // Ctrl 点标题按钮触发选中——TaskRow 没有 TaskCard 那层 .ink-swipe
      // 手势包裹，`select` 接线直接挂在 .ink-trow-open 这颗按钮上，见
      // TaskRow.tsx Props.select 的注释。
      fireEvent.click(within(grid).getByTitle('今天要做的事'), { ctrlKey: true });

      expect(panel.querySelector('.ink-trow-selected')).not.toBeNull();
      // 批量条也该出现——跟别的视图接上选中之后同一套下游反应。
      expect(screen.queryByRole('toolbar', { name: '批量操作' })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // final-review.md I2：日历这一处以前是选中态那四个字段被静默丢掉（上面
  // 那条测试守的就是补上之后的结果），这一批加 focusMinutes 第五个字段时
  // 同一个位置又踩了一次——CalendarView 不声明也不转发它，当天列表里的卡片
  // 永远是写死的 25 分钟，用户在设置里改的值在日历这一处不生效。CalendarView
  // 现在改成 Props extends GridWiring、整体 {...wiring} 转发，这条测试守住
  // 「真的到达了」——用不等于 25 的夹具值（见上面 settings 常量），传对了
  // 显示 45:00，传漏了会露馅成 25:00。
  it('日历当天列表接上了番茄钟时长——45 分钟，不是写死的 25', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      currentTasks = [task({
        id: 'a', title: '今天要做的事',
        due: new Date(2026, 7, 16, 18, 30, 0, 0).toISOString(),
      })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      fireEvent.keyDown(panel.querySelector('.fc-day-today')!, { key: 'Enter' });
      const grid = await waitFor(() => {
        const g = panel.querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g as HTMLElement;
      });

      // 番茄钟按钮是 TaskCard 才有的（TaskRow 只画标题/到期/标签/建议记号），
      // 而点标题现在打开的是**右边那一栏详情面板**（不再是当场膨胀成一张卡，
      // 见 TaskDetail.tsx）——面板里渲染的就是同一张 TaskCard，同一份
      // gridWiring/cardWiring，所以番茄钟时长这条接线照样在那儿验。
      fireEvent.click(within(grid).getByTitle('今天要做的事'));
      const detail = await screen.findByRole('complementary', { name: '任务详情' });
      fireEvent.click(within(detail).getByText('开始专注'));
      expect(within(detail).getByText('45:00')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('日历锚点/模式是这个视图自己的 state：切走再切回来重置到当月——不是 keepMounted，会真的卸载重挂', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = () => container.querySelector('.ink-view-panel-calendar') as HTMLElement;

    const initialHeading = panel().querySelector('.ink-cal-heading')!.textContent;
    fireEvent.click(within(panel()).getByRole('button', { name: '下一页' }));
    expect(panel().querySelector('.ink-cal-heading')!.textContent).not.toBe(initialHeading);

    await goBoard();
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    expect(panel().querySelector('.ink-cal-heading')!.textContent).toBe(initialHeading);
  });

  it('把卡拖到另一天，发出的 PATCH 是 due 改成那天、时刻分毫不变——守 onDropOnDay 这个 prop，兼守 App 层的 due 换算', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      // 时刻特意用 18:30，不用 00:00：「保留了」和「归零了」在 00:00 这种
      // 夹具下会得到同一个结果，这个仓库已经在别处栽过这个坑四次，见
      // 「必须遵守的全局约束」。
      const base = new Date(2026, 7, 16, 9, 0, 0);
      const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 18, 30, 0, 0);
      const target = new Date(due);
      target.setDate(target.getDate() + 2); // 本地墙钟算术，跟 dayKey/calendarDays 同一套
      currentTasks = [task({ id: 'a', title: '交房租', due: due.toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 跟 CalendarView 内部同一个公式算目标格排第几。
      const days = calendarDays([], base, 'month');
      const srcIdx = days.findIndex((d) => d.key === dayKey(due));
      const targetIdx = days.findIndex((d) => d.key === dayKey(target));

      // FullCalendar 的月格拖拽走它自己的指针交互引擎（PointerDragging →
      // HitDragging → EventDragging），不是原生 HTML5 drag/drop——
      // `fireEvent.dragStart/dragOver/drop` 在这里用不上，见 test-utils.tsx
      // 里 `installFullCalendarFakeLayout` 上面那段长注释，跟
      // CalendarFull.test.tsx 用的是同一套辅助函数。
      const restoreLayout = installFullCalendarFakeLayout();
      try {
        const eventEl = panel.querySelector('.fc-daygrid-event')!;
        fcDragEvent(eventEl, srcIdx, targetIdx);

        // 不用 toHaveBeenCalledTimes(1)：`api.patchTask` 这个 mock 的调用
        // 历史是整个文件共用的、beforeEach 不清空（只有 3078 行那个专门的
        // describe 块自己清），跑到这条测试时已经带着前面用例攒下的调用
        // 记录——原来那条测试用的是 toHaveBeenCalledWith（只要历史里存在
        // 一条匹配的调用就算过，不管总数），这里延续同一个约定，不引入
        // 对总调用数的假设。
        //
        // 不直接断言 `target`：`fcDragEvent` 的落点是「往哪个方向拖」，不是
        // 像素级精确到哪一天（见它自己的文档注释——这套假布局的坐标换算跟
        // FullCalendar 内部校准逻辑不是完全同一个坐标系，会有系统性偏移，
        // 真实浏览器里像素连续，不会有这层因为「格子矩形是手写死数字」带来
        // 的跳变）。改成从调用历史里找一条「id 对上、时刻分毫不变、日期真的
        // 变了」的记录——这条记录只可能来自这次拖拽（同一个 due 时刻 + id
        // 'a' 的组合在这个文件里不会重复出现），比死等某个具体的 `target`
        // 更贴近这条测试真正要守住的两件事。
        const patchedDue = await waitFor(() => {
          const hit = vi.mocked(api.patchTask).mock.calls.find(([id, patch]) => {
            if (id !== 'a') return false;
            const d = new Date((patch as { due?: string }).due ?? '');
            return !Number.isNaN(d.getTime())
              && d.getHours() === due.getHours() && d.getMinutes() === due.getMinutes()
              && d.getSeconds() === due.getSeconds() && d.getMilliseconds() === due.getMilliseconds()
              && dayKey(d) !== dayKey(due);
          });
          if (!hit) throw new Error('还没收到那条「时刻不变、日期变了」的 PATCH');
          return new Date((hit[1] as { due: string }).due);
        });
        // 拖拽方向是往后（target 比 due 晚两天），落点即使跟像素偏移有出入，
        // 也不该早于原来的 due——这条钉住「往后挪」这个方向本身没错。
        expect(patchedDue.getTime()).toBeGreaterThan(due.getTime());
      } finally {
        restoreLayout();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // task-3：翻页在三档下各自对——上一页/下一页对三档都要生效，不是只有月
  // 视图接了 onShift。标题文案变了就足以证明 anchor 真的挪动了、CalendarGrid
  // 也真的重新算了 headingText。
  it('上一页/下一页在周/日视图下也生效——不是只有月视图接了 onShift', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0)); // 周三
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月17日 - 8月23日');
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月24日 - 8月30日');

      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });
      // 切档不改 anchor，翻页之后的锚点（8/26，上面那次「下一页」+7 天）留着。
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月26日 周三');
      fireEvent.click(within(panel).getByRole('button', { name: '上一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月25日 周二');
    } finally {
      vi.useRealTimers();
    }
  });

  // 修复轮 1 · I-3：`<CalendarHours now={now} .../>` 这条接线没有任何测试
  // 碰过——把 `now={now}` 手滑写成 `now={anchor}`，`CalendarHours.test.tsx`
  // 那 23 条全绿（它用注入的 `now` 守住了组件本身，接线对不对够不着它），
  // `App.test.tsx` 之前也没有任何一条会红。后果不是抽象的：当前时刻线会画
  // 在**锚定的那一天**而不是今天——日视图里只有一列，`todayKey =
  // dayKey(anchor)` 一旦跟 `dayKey(now)` 搞混，翻到哪天都会在那一列画一条
  // 假的「现在」。
  //
  // 断言思路：真今天是 8/16（周日）。切到周视图，第一页（8/10-8/16）本来就
  // 包含今天，出现一条线测不出「传对了 now 还是传串了 anchor」——跟月视图
  // I1 那条同一个坑（两个变量挂载那一刻恒相等）。翻一页到 8/17-8/23，真
  // 今天 8/16 已经不在这页里：如果 `now` 传对了，这一页不该有任何一条线；
  // 如果被串成了 `anchor`（这时候 anchor 已经翻页变成了 8/23，且 8/23 正好
  // 是这页最后一天，在 `days` 范围内），会在 8/23 那一列冒出一条假的线。
  it('周/日视图的当前时刻线用的是 now，不是被串成 anchor——翻页翻走之后线不能跟着冒到新锚点那天', async () => {
    // task-6：当前时刻线换成 FullCalendar 自带的 nowIndicator
    // （`.fc-timegrid-now-indicator-line`）——`nowIndicatorTop` 要读
    // `slatCoords`（内部量 DOM 得到），jsdom 默认全零布局，不垫
    // `installFullCalendarFakeLayout` 的 offsetHeight 那道垫片，这条线
    // 永远不会画出来（不是「今天不在这页」，是压根没建出坐标缓存）——两个
    // 页面都得垫。
    const restoreLayout = installFullCalendarFakeLayout();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0)); // 今天钉死 8/16（周日）
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月10日 - 8月16日');
      // 挂载这一刻 anchor 恒等于 now，这一页出现线测不出传对了哪个——只是
      // 确认「正常情况下线是会画的」，不是本条要守的那半。
      expect(panel.querySelectorAll('.fc-timegrid-now-indicator-line')).toHaveLength(1);

      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月17日 - 8月23日');
      // 真正要守的那半：真今天（8/16）不在这页里，线必须整棵树都不出现——
      // 如果 now 被串成了 anchor（这时候是 8/23，页里最后一天），这里会
      // 收到 1 条，不是 0。
      expect(panel.querySelectorAll('.fc-timegrid-now-indicator-line')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      restoreLayout();
    }
  });

  // task-3：三档切换（月/周/日）——CalendarGrid.tsx 那个三档切换以前只硬编码两颗
  // 按钮，`mode` 是 'day' 时两颗的 aria-pressed 都是 false、也没有第三颗按钮。
  // 照抄 CalendarGrid 那对「周/月」按钮的写法（这个文件上面「切到周视图……」
  // 那条），三个方向都断言，不是只测点下去的那颗。
  it('三档切换按钮：月/周/日，aria-pressed 三个方向都要断言', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
    const sel = () => within(panel).getByLabelText('看哪一档') as HTMLSelectElement;
    const pick = (m: string) => fireEvent.change(sel(), { target: { value: m } });

    // 默认月视图。
    expect(sel().value).toBe('month');

    pick('week');
    expect(sel().value).toBe('week');

    pick('day');
    expect(sel().value).toBe('day');

    // 修复轮 1 · C-2：三颗按钮 × 两条接线（aria-pressed + onClick）= 6 个
    // 接线点，上面三段只点过「周」「日」，从没点过「月」本身——`grep "name:
    // '月'"` 全仓只有读 aria-pressed 那两处，onClick 那半从未被点过、也就
    // 从未被验证过：`onModeChange('month')` 手滑写成 `onModeChange('week')`
    // 之类的错误不会被任何测试挡住。这里从「日」点回「月」，同时守住
    // aria-pressed 三个方向和真实的格子形态（`.fc-daygrid-day` 重新出现、
    // `.ink-calh-col` 消失）——只查 aria-pressed 不够：把 `onModeChange`
    // 整个替换成空函数，aria-pressed 三个断言全红是不错，但那测的是「点了
    // 没反应」，这里还要证明「点了之后真的回到了月视图这个具体状态」。
    pick('month');
    expect(sel().value).toBe('month');
    expect(panel.querySelectorAll('.fc-daygrid-day')).toHaveLength(42);
    expect(panel.querySelectorAll('.fc-timegrid-col:not(.fc-timegrid-axis)')).toHaveLength(0);
  });

  // task-3 要点②/task-6：月走 dayGridMonth，周/日走 timeGridWeek/Day——
  // 上限断言两个方向都要：月视图里没有时间轴列，周/日视图里没有 42 格月格。
  // **周/日视图的全天带背后仍然是 dayGrid 组件**（`.fc-daygrid-day`，跟月
  // 视图共用同一套渲染机制）——不是「一个都不该有」，是「恰好等于列数」，
  // 见 CalendarView.test.tsx 那条同名断言旁边的注释。
  it('三档互斥：月视图里没有时间轴列，周/日视图里没有 42 格月格（两个方向都要断言）', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

    // 月视图（默认）：42 格月格，没有时间轴列。
    expect(panel.querySelectorAll('.fc-daygrid-day')).toHaveLength(42);
    expect(panel.querySelectorAll('.fc-timegrid-col:not(.fc-timegrid-axis)')).toHaveLength(0);

    fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
    // 7 个全天带格（`.fc-daygrid-day`，不是 42），7 列时间轴。
    expect(panel.querySelectorAll('.fc-daygrid-day')).toHaveLength(7);
    expect(panel.querySelector('.ink-cal-weekdays')).toBeNull();
    expect(panel.querySelectorAll('.fc-timegrid-col:not(.fc-timegrid-axis)')).toHaveLength(7);

    fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });
    expect(panel.querySelectorAll('.fc-daygrid-day')).toHaveLength(1);
    expect(panel.querySelector('.ink-cal-weekdays')).toBeNull();
    expect(panel.querySelectorAll('.fc-timegrid-col:not(.fc-timegrid-axis)')).toHaveLength(1);
  });

  // task-3 要点③：标题栏文案。精确匹配，不是 toContain——'2026年8月19日'
  // 含 '8月19日'，上一批 I-1 就是这个坑（见 task-3-brief）。系统时间钉在
  // 2026-08-19（周三）：周视图那周的周一到周日是 8/17-8/23，跟 brief 举的
  // 例子一模一样。
  it('标题栏文案：月「2026年8月」，周「8月17日 - 8月23日」，日「8月19日 周三」——精确文案', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('2026年8月');

      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'week' } });
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月17日 - 8月23日');

      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月19日 周三');
    } finally {
      vi.useRealTimers();
    }
  });

  // ⚠️ 修复轮 1（复审 C1）：上一轮这里删掉了三条原生 drag/drop 测试，理由是
  // "FullCalendar 的小时槽指针交互在这个仓库当前的 jsdom + ResizeObserver
  // 空壳测试环境下走不通"——**这句话是错的**，实测排查纠正过：FullCalendar
  // 6.1.21 压根不用 `ResizeObserver`，真正的卡点是 `installFullCalendarFake
  // Layout`（`test-utils.tsx`）当时只垫了 `offsetHeight` 没垫
  // `clientHeight`，让 `computeScrollbarWidthsForEl` 算出一条假的 960px
  // "滚动条"，把 timeGrid 区域的坐标裁在了 clipping 范围外——垫上
  // `clientHeight`、再给时间轴列/小时行各配一份不跟 dayGrid 网格重叠的假
  // 矩形（`fcSlotPoint`/`fcTimeGridDrag`，`test-utils.tsx`）之后，小时槽的
  // 点选/拖拽完全测得出来，落点比全天带更精确——**这个"精确"是假布局的
  // 坐标映射保证的**（`getBoundingClientRect`/`elementFromPoint` 跟测试
  // 坐标用的是同一个 `colIdx * cell` 公式），验证的是「`CalendarFull`
  // 正确转发了 FullCalendar 内部命中管线算出的列/小时」，不是「FullCalendar
  // 在真实像素噪声下有多鲁棒」，详见 test-utils.tsx 的说明。三条原来的
  // 测试照原样恢复，用的是真实的 FullCalendar 指针拖拽，不是替身。
  it('周/日视图：拖到某个小时格，due 落在目标小时且分秒毫秒归零——本地墙钟构造，钉死东八区守住 Date.UTC 那类回归', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 19, 9, 15, 30, 500);
      currentTasks = [task({ id: 'a', title: '看医生', due: due.toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      const restoreLayout = installFullCalendarFakeLayout();
      try {
        fireEvent.click(navButton(/日历/));
        await screen.findByRole('heading', { level: 1, name: '日历' });
        const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
        fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });

        const eventEl = panel.querySelector('.fc-timegrid-event')!;
        fcTimeGridDrag(eventEl, { colIdx: 0, hour: 9 }, { colIdx: 0, hour: 14 });

        const expected = new Date(2026, 7, 19, 14, 0, 0, 0);
        await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('a', { due: expected.toISOString() }));
      } finally {
        restoreLayout();
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  // task-3 要点③：拖到全天带 = 那天零点——按时任务（不是已经全天的任务）
  // 从时间轴拖进全天带，跨 timeGrid/dayGrid 两个交互组件，实测过 FullCalendar
  // 原生支持这种跨区域拖拽（真实浏览器里就是这样用的），假布局的
  // elementFromPoint 按 Y 坐标路由到对应的组件即可。
  it('周/日视图：拖到全天带，due 是那天零点', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 19, 9, 0, 0, 0);
      currentTasks = [task({ id: 'a', title: '看医生', due: due.toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      const restoreLayout = installFullCalendarFakeLayout();
      try {
        fireEvent.click(navButton(/日历/));
        await screen.findByRole('heading', { level: 1, name: '日历' });
        const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
        fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });

        // 这两条按「第 h 小时那一格」算坐标（`fcSlotPoint`），而日历默认只画
        // `hourBand` 那一段（07-23），凌晨那几格在屏幕上不存在、换算会整条偏
        // 掉。先把「显示全天 24 小时」打开，坐标系才跟 fcSlotPoint 对得上。
        fireEvent.click(within(panel).getByLabelText('显示全天 24 小时'));

        const eventEl = panel.querySelector('.fc-timegrid-event')!;
        const src = fcSlotPoint(0, 9);
        const alldayCell = panel.querySelector('.fc-daygrid-day')!;
        const alldayRect = alldayCell.getBoundingClientRect();
        fireEvent.mouseDown(eventEl, { button: 0, clientX: src.x, clientY: src.y });
        const dst = { x: alldayRect.left + alldayRect.width / 2, y: alldayRect.top + alldayRect.height / 2 };
        for (let i = 1; i <= 10; i++) {
          fireEvent.mouseMove(document, { clientX: src.x + (dst.x - src.x) * (i / 10), clientY: src.y + (dst.y - src.y) * (i / 10) });
        }
        for (let i = 0; i < 4; i++) fireEvent.mouseMove(document, { clientX: dst.x, clientY: dst.y });
        fireEvent.mouseUp(document, { button: 0, clientX: dst.x, clientY: dst.y });

        const expected = new Date(2026, 7, 19, 0, 0, 0, 0);
        await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('a', { due: expected.toISOString() }));
      } finally {
        restoreLayout();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // 修复轮 1 · M-3：`isAllDay` 把"本地时分秒毫秒全为 0"判成全天，拖到 0 点
  // 那个小时格算出来的 due 就是那天零点，跟拖到全天带算出来的值完全没法
  // 区分——这不是 bug，是 Task 1 `isAllDay` 那条 `ponytail:` 注释早就承认的
  // 启发式天花板，写明的设计而不是意外。拖拽手势 + PATCH 落地之后的真实
  // 渲染位置都测，不只是算出同一个 due 值就到此为止。
  it('周/日视图：拖到 0 点那个小时格——写明的设计：due 是零点，落地之后这条任务会出现在全天带，不在 0 点那一格', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 19, 9, 0, 0, 0);
      currentTasks = [task({ id: 'a', title: '半夜出发', due: due.toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      const restoreLayout = installFullCalendarFakeLayout();
      try {
        fireEvent.click(navButton(/日历/));
        await screen.findByRole('heading', { level: 1, name: '日历' });
        const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
        fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });

        // 这两条按「第 h 小时那一格」算坐标（`fcSlotPoint`），而日历默认只画
        // `hourBand` 那一段（07-23），凌晨那几格在屏幕上不存在、换算会整条偏
        // 掉。先把「显示全天 24 小时」打开，坐标系才跟 fcSlotPoint 对得上。
        fireEvent.click(within(panel).getByLabelText('显示全天 24 小时'));

        const eventEl = panel.querySelector('.fc-timegrid-event')!;
        fcTimeGridDrag(eventEl, { colIdx: 0, hour: 9 }, { colIdx: 0, hour: 0 });

        // 跟「拖到全天带」那条算出来的是同一个值——这正是这条测试要钉住的
        // 「没法区分」。
        const midnight = new Date(2026, 7, 19, 0, 0, 0, 0);
        await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('a', { due: midnight.toISOString() }));

        // 模拟这次 PATCH 真的落地：due 变成零点，SSE 通知刷新。
        currentTasks = [{ ...currentTasks[0], due: midnight.toISOString() }];
        act(() => { handlers.onChange!('tasks'); });

        await waitFor(() => {
          expect(panel.querySelector('.fc-daygrid-day')!.textContent).toContain('半夜出发');
        });
        expect(panel.querySelectorAll('.fc-timegrid-event')).toHaveLength(0);
      } finally {
        restoreLayout();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // task-3 要点④/task-6：周/日视图点某个小时格的任务该干什么——选了「点
  // 『+N』」（`.fc-timegrid-more-link`，MoreLinkClicking 走的是普通
  // click，不经过测不出来的坐标命中引擎，见 CalendarFull.test.tsx 那组）
  // 跟月格点某一天一致：选中那一天，下面出当天列表。这里用 4 条挤在同一个
  // 小时（超过日视图的上限 3）触发「+N」。
  it('周/日视图：点某个小时格的「+N」，选中那一天并显示当天列表——跟月格点某一天一致', async () => {
    // eventMaxStack 的堆叠判定要读 slatCoords（真实的时间-像素换算），跟
    // CalendarFull.test.tsx「一格摆几条」那组同一条限制——不垫
    // installFullCalendarFakeLayout 的 offsetHeight，「+N」不会出现。
    const restoreLayout = installFullCalendarFakeLayout();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      currentTasks = Array.from({ length: 4 }, (_, i) =>
        task({ id: `t${i}`, title: `任务${i}`, due: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString() }));
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });

      expect(panel.querySelector('.ink-row-list')).toBeNull();
      const more = await waitFor(() => {
        const m = panel.querySelector('.fc-timegrid-more-link');
        if (!m) throw new Error('「+N」链接还没出现');
        return m;
      });
      fireEvent.click(more);

      const grid = await waitFor(() => {
        const g = panel.querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g as HTMLElement;
      });
      expect(within(grid).getByText('任务0')).toBeTruthy();
    } finally {
      vi.useRealTimers();
      restoreLayout();
    }
  });

  // ⚠️ 修复轮 1 · C-1（Critical，回归，之前误判成测不出来）：日视图某小时格
  // 只有 1 条任务（没有溢出，冒不出「+N」）时，点这一格本身也能选中这一天。
  // 上一版这里留了个空的 `it.skip`——`dateClick` 走坐标命中引擎，跟拖拽同一
  // 条链路，实测排查过（见上面拖拽那组测试头顶的注释、`test-utils.tsx`
  // `installFullCalendarFakeLayout` 的长注释）：卡点是假布局漏垫
  // `clientHeight`，不是这条路径本身走不通，垫上之后 `fireEvent.mousedown/
  // mousemove/mouseup`（`dateClick` 走的是这套指针序列，不是单发的
  // `fireEvent.click`）能真的触发它。
  it('周/日视图：小时格没有溢出（只有 1 条任务，冒不出「+N」）也能点选中那一天——之前唯一的入口只有「+N」，正常使用几乎碰不到', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    try {
      currentTasks = [task({ id: 'a', title: '看医生', due: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      const restoreLayout = installFullCalendarFakeLayout();
      try {
        fireEvent.click(navButton(/日历/));
        await screen.findByRole('heading', { level: 1, name: '日历' });
        const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;
        fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });

        // 只有 1 条任务，「+N」压根不存在——不是这条测试没找它，是它根本不该出现。
        expect(panel.querySelector('.fc-timegrid-more-link')).toBeNull();
        expect(panel.querySelector('.ink-row-list')).toBeNull();

        const col = panel.querySelector('.fc-timegrid-col')!;
        const p = fcSlotPoint(0, 15); // 空白小时格
        fireEvent.mouseDown(col, { button: 0, clientX: p.x, clientY: p.y });
        fireEvent.mouseMove(document, { clientX: p.x, clientY: p.y });
        fireEvent.mouseUp(document, { button: 0, clientX: p.x, clientY: p.y });

        const grid = await waitFor(() => {
          const g = panel.querySelector('.ink-row-list');
          if (!g) throw new Error('当天列表还没出现');
          return g as HTMLElement;
        });
        expect(within(grid).getByText('看医生')).toBeTruthy();
      } finally {
        restoreLayout();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // 修复轮 1 · M-4（附在 C-1 上的走味）：审查者实测——月视图选 8/19 → 切
  // 日视图 → 点下一页，标题变成 8/20，下面的列表还留着 8/19 的内容，屏幕上
  // 唯一那一天和列表说的那一天对不上。派生守卫：selectedKey 不在当前这批
  // days 里就不渲染列表。这条测试覆盖两半：先证明「切档、没翻页」列表正常
  // 还在（守卫没有误伤正常场景），再证明「翻页翻出了这一天」列表消失。
  it('日视图翻页翻走了选中的那一天，列表跟着消失——不是继续显示翻页前那天的陈旧内容', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0)); // 今天 8/19（周三）
    try {
      currentTasks = [task({ id: 'a', title: '今天要做的事', due: new Date(2026, 7, 19, 18, 30, 0, 0).toISOString() })];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = container.querySelector('.ink-view-panel-calendar') as HTMLElement;

      // 月视图选中今天（8/19）。
      fireEvent.keyDown(panel.querySelector('.fc-day-today')!, { key: 'Enter' });
      await waitFor(() => expect(panel.querySelector('.ink-row-list')).not.toBeNull());

      // 切到日视图：anchor 没变（还是 8/19），选中的那天还在当前 days 里，
      // 列表应该照样在——守卫不能误伤这个正常场景。
      fireEvent.change(within(panel).getByLabelText('看哪一档'), { target: { value: 'day' } });
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月19日 周三');
      expect(panel.querySelector('.ink-row-list')).not.toBeNull();

      // 翻一页：anchor 变成 8/20，选中的 8/19 不在这页的 days 里了，列表必须
      // 消失，不能继续显示 8/19 的内容。
      fireEvent.click(within(panel).getByRole('button', { name: '下一页' }));
      expect(panel.querySelector('.ink-cal-heading')!.textContent).toBe('8月20日 周四');
      expect(panel.querySelector('.ink-row-list')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// C1：四象限横向拖拽（同一行、两个格子）必须是空操作——界面上那行字明说
// 「左右…拖不动」。QUADRANT_KEYS 顺序固定：imp-urg(0) / imp-later(1) /
// min-urg(2) / min-later(3)，第 0/1 格是「重要」那一行，第 2/3 格是
// 「不重要」那一行，同一行内的两格拖来拖去不该发任何 PATCH。
//
// 夹具的 priority 特意用 3 和 1，不用 QUADRANT_PRIORITY 里的规范值 2 和 0：
// 如果修法写成「拿这张卡当前的 priority 直接跟目标格的规范值比，相等就不发」，
// 用规范值当夹具的话「改写了」和「没改写」会算出同一个结果（2 跟 2 比，本来
// 就相等），测试照样绿，但对 priority 是 3/1 这种非规范值的真实任务，这种
// 错误修法一样会误发 PATCH——这个仓库在这一批之前已经因为「夹具恰好等于
// 写死的值」踩过好几次假绿，见 final-review.md C1 和「必须遵守的全局约束」。
/**
 * **四格 = 四档优先级**（仿滴答清单），所以四个格子都拖得动，落进哪一格就是
 * 把优先级设成那一档。
 *
 * 这一族用例换掉了原来那批「横向拖拽不改写 priority」（final-review.md C1）
 * ——那条规矩属于旧模型：那时候横轴按 `due` 自动分列、是只读坐标，同一行的
 * 两格代表同一个 priority，所以横向拖必须什么都不发。现在四格四个值，横向
 * 拖跟纵向拖一样是一次明确的改档。
 */
describe('App：四象限四个格子都拖得动，落哪一格就是设成那一档', () => {

  const openQuadrant = async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    return container.querySelector('.ink-view-panel-quadrant') as HTMLElement;
  };

  // .ink-cells-2x2 是真正的 2×2 网格（行优先：0/1 是第一行，2/3 是第二行）
  // ——mockDndRects 的 columns:2 网格模式让 ArrowUp/Down/Left/Right 分别对应
  // 换行/换列，见这个文件顶部「重要」那条测试同款注释。这里所有用例共用
  // 同一份 mock，beforeEach/afterEach 装卸，不在每条测试里各写一份 try/finally。
  let restoreRects: () => void;
  beforeEach(() => { restoreRects = mockDndRects('.ink-cells-2x2 .ink-grid-section', { columns: 2, gap: 300 }); });
  afterEach(() => restoreRects());

  // fromIdx/toIdx 都是 0..3 的网格下标（行优先）——同一行只会左右移，
  // 跨行只会上下移，这批夹具全是「恰好差一格」的相邻移动，不需要处理
  // 对角线那种没有单一方向键能到达的情况。
  const directionFor = (fromIdx: number, toIdx: number): string => {
    const fromRow = Math.floor(fromIdx / 2);
    const fromCol = fromIdx % 2;
    const toRow = Math.floor(toIdx / 2);
    const toCol = toIdx % 2;
    if (fromRow === toRow) return toCol > fromCol ? 'ArrowRight' : 'ArrowLeft';
    return toRow > fromRow ? 'ArrowDown' : 'ArrowUp';
  };

  const drag = async (panel: HTMLElement, fromIdx: number, toIdx: number) => {
    const sections = panel.querySelectorAll('.ink-cells-2x2 .ink-grid-section');
    // 固定行档：抓手挂在 TaskRow 悬停才出现的 .ink-trow-handle 上，跟这个
    // 文件顶部的 hoverAndGetHandle 同一条理由，这里只能拆开写——要悬停的
    // 是「源格」这一格，不是整个面板（面板里只有一张卡，效果其实一样，
    // 但按语义精确到源格更不容易在以后加夹具时踩坑）。
    const handle = hoverAndGetHandle(sections[fromIdx] as HTMLElement);
    await keyboardDrag(handle, [directionFor(fromIdx, toIdx)]);
  };

  // `api.patchTask` 是这个文件顶部 `vi.mock()` 工厂里造的一个模块级 vi.fn()，
  // 不是每条测试各自的局部 mock——`afterEach` 里的 `vi.restoreAllMocks()`
  // 只清 `vi.spyOn` 那种真正的 spy，管不到它，调用记录会在整个文件的测试
  // 之间一路累积（这个文件里其它用到 api.* 的断言全是 toHaveBeenCalledWith，
  // 没有一条用 not.toHaveBeenCalled()，就是因为这个）。横向拖拽这四条不能
  // 直接断言「一次都没被调用过」——之前的测试早就调用过它了；也不能只用
  // toHaveBeenCalledWith 断言纵向那两条——同一个 id 'a' 配同样的 {priority:2}
  // 之前的测试可能已经调过一次，会让「这次拖拽真的发了 PATCH」这个断言不
  // 依赖这次拖拽也照样通过。改成读调用次数的前后差值：横向要求差值为 0，
  // 纵向要求差值为 1 且最后一次调用的参数精确匹配。
  const patchCalls = () => vi.mocked(api.patchTask).mock.calls;

  // 四格的下标（行优先）跟档位：0=高 1=中 2=低 3=无。
  it.each([
    ['高 → 中（横向）', 3, 0, 1, 2],
    ['中 → 高（横向）', 2, 1, 0, 3],
    ['低 → 无（横向）', 1, 2, 3, 0],
    ['无 → 低（横向）', 0, 3, 2, 1],
    ['低 → 高（纵向，跨行）', 1, 2, 0, 3],
    ['高 → 低（纵向，跨行）', 3, 0, 2, 1],
  ] as const)('%s：精确发一次 PATCH', async (_n, from, fromIdx, toIdx, want) => {
    currentTasks = [task({ id: 'a', priority: from })];
    const panel = await openQuadrant();
    const before = patchCalls().length;
    await drag(panel, fromIdx, toIdx);
    await waitFor(() => expect(patchCalls().length).toBe(before + 1));
    expect(patchCalls().at(-1)).toEqual(['a', { priority: want }]);
  });

  // 对照组：拖回原来那一格什么都不发——TaskGrid 的 `from !== s.key` 挡着。
  // 上面六条不能是靠「每次拖都发一发」蒙对的。
  it('拖回原来那一格：一个 PATCH 都不发', async () => {
    currentTasks = [task({ id: 'a', priority: 3 })];
    const panel = await openQuadrant();
    const before = patchCalls().length;
    await drag(panel, 0, 0);
    expect(patchCalls().length).toBe(before);
  });
});

describe('App：今天 / 按来源两个顶层视图', () => {
  it('默认显示「今天」——过期任务出现，「今天」标签被选中，「按来源」没有', async () => {
    currentTasks = [task({ title: '早该做了', due: '2000-01-01T00:00:00.000Z' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 两个视图都常驻挂载（见 App.tsx 的注释），这条任务同时满足「今天」和
    // 「按来源」（默认筛选「全部」）两边的成员资格，标题文字在 DOM 里会出现
    // 两次——用 .ink-view-panel-today 把断言限定在真正展示给用户看的那一份。
    const todayPanel = () => within(container.querySelector('.ink-view-panel-today') as HTMLElement);
    await waitFor(() => expect(todayPanel().getByText('早该做了')).toBeDefined());
    // 侧栏导航按钮可能带一个计数徽标（比如「今天2」），可访问名不再是纯
    // 「今天」两个字，用正则匹配前缀而不是精确相等。
    expect(navButton(/今天/).getAttribute('aria-current')).toBe('page');
    expect(navButton(/按来源/).getAttribute('aria-current')).toBeNull();
  });

  it('点击「按来源」切到按来源分组的看板——能看到「单独记的」分组标题', async () => {
    currentTasks = [task({ title: '手工记的', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(navButton(/按来源/));

    expect(await screen.findByText('单独记的')).toBeDefined();
    expect(screen.getByText('手工记的')).toBeDefined();
    expect(navButton(/按来源/).getAttribute('aria-current')).toBe('page');
  });

  it('「今天」什么都不符合成员资格时显示「今天没有要做的」，不是「空的」', async () => {
    currentTasks = [task({ title: '还没到', due: '2999-01-01T00:00:00.000Z', reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    expect(await screen.findByText('今天没有要做的')).toBeDefined();
  });

  it('切到「按来源」再切回「今天」，正在编辑的草稿还在——顶层视图切换不该像旧写法那样把整棵子树卸载掉，两个视图各自的 editingIds 机制本来就是防这个的，但被顶层的 view === ? : 绕过了', async () => {
    currentTasks = [task({ title: '早该做了', due: '2000-01-01T00:00:00.000Z' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    // 这条任务同时满足两个视图的成员资格、在 DOM 里出现两次（两个视图都
    // 常驻挂载）——限定在「今天」那一份，也确保点的是「今天」卡片上的
    // 「编辑」，不是 TaskBoard 里那张没进入编辑态的同名卡。
    const todayPanelEl = () => container.querySelector('.ink-view-panel-today') as HTMLElement;
    const todayPanel = () => within(todayPanelEl());
    await waitFor(() => expect(todayPanel().getByText('早该做了')).toBeDefined());

    // 不用 getAllByRole('button')：两个视图常驻挂载之后，`getByRole`/`getAllByRole`
    // 要对整棵树里每个候选元素做一次可访问性判定（含判断是不是被隐藏祖先挡住，
    // 内部会走到 jsdom 的 getComputedStyle），这一步在 jsdom 下的耗时不随 DOM
    // 节点数线性增长——实测同一次点击，两个视图都挂载时比只挂载「今天」单独
    // 测试慢了两个数量级（从两位数毫秒变成几十秒），而 React 自己的渲染/commit
    // 只花了几十到一百多毫秒（用 React Profiler 量过），说明这几十秒完全花在
    // jsdom 的属性查询上，不是应用变慢了、也不是真实浏览器里会有的开销
    // ——`getByRole` 是纯测试期的 API，用户的浏览器从不会走这条代码路径。
    // 换成纯 DOM 查询（按文本找 <button>），不触发这一层计算。
    // 「编辑」现在收在卡片的 ⋯ 菜单里，pickCardMenu 内部同样只用 DOM 查询，
    // 就是为了不把这个坑踩回来——见 test-utils.tsx 里那段注释。
    await pickCardMenu('编辑', { scope: todayPanelEl() });
    fireEvent.change(todayPanel().getByPlaceholderText('标题'), { target: { value: '改到一半还没存' } });

    fireEvent.click(navButton(/按来源/));
    fireEvent.click(navButton(/今天/));

    expect((todayPanel().getByPlaceholderText('标题') as HTMLInputElement).value).toBe('改到一半还没存');
  });

  it('切到「今天」再切回「按来源」，用户看到的筛选选择没被清空回「全部」', async () => {
    // 名字特意不提 keepMounted/卸载重挂：boardFilter 是提到 App 里的状态
    // （见那行 useState 上的注释），不属于 TaskBoard 自己，就算顶层真把
    // TaskBoard 卸载重挂，boardFilter 也不会被带走——这条测不出「有没有被
    // 卸载重挂」，只测得出「用户看到的筛选选择没变」这件事本身，这件事仍然
    // 值得测（回归的话用户也会看见筛选被清空），只是跟 keepMounted 这条
    // 不变量无关。真正对卸载重挂敏感的是下一条「正在编辑的草稿」用例——
    // 组件本地 state（TaskCard 的编辑草稿）父树卸载必丢，才是有效信号。
    currentTasks = [
      task({ id: 't1', title: '待办的', status: 'todo', due: null, reminders: [] }),
      task({ id: 't2', title: '进行中的', status: 'doing', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(navButton(/按来源/));
    await screen.findByText('单独记的');
    // 限定在筛选条那一组里找。松散地在整页找 /进行中/ 会同时命中这张卡的
    // ⋯ 按钮——它的可访问名是「「进行中的」的更多操作」，带着任务标题（一页
    // 七颗 ⋯ 全叫「更多操作」对读屏没用，标题必须在名字里）。
    const filters = within(screen.getByRole('group', { name: '按状态筛选' }));
    fireEvent.click(filters.getByRole('button', { name: /进行中/ }));
    expect(screen.queryByText('待办的')).toBeNull();
    expect(screen.getByText('进行中的')).toBeDefined();

    fireEvent.click(navButton(/今天/));
    fireEvent.click(navButton(/按来源/));

    expect(screen.queryByText('待办的')).toBeNull();
    expect(screen.getByText('进行中的')).toBeDefined();
  });

  it('切走再切回来，「按来源」里正在编辑的草稿也还在——两个 keepMounted 视图各自都要扛住这层保护，不能只顾「今天」', async () => {
    // 注意：这条**不能**靠 boardFilter（「按来源」的状态筛选）来验证——那份
    // 状态被提到了 App 里（见 boardFilter 那行 useState 上的注释），不属于
    // TaskBoard 自己，顶层切换就算真把 TaskBoard 卸载重挂，boardFilter 也
    // 不会被带走，用筛选选择测不出卸载重挂发生过没有（这里当时写反过一次：
    // 一条几乎一样但靠筛选选择的用例，在下面 Step 6 的变异验证里死活不变红，
    // 才换成这条——TaskCard 里草稿是纯本地 state，父树卸载它必丢，才是真正
    // 对「有没有被卸载重挂」敏感的信号）。
    currentTasks = [task({ title: '手工记的', due: null, reminders: [] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/按来源/)).toBeDefined());

    fireEvent.click(navButton(/按来源/));
    const sourcePanelEl = () => container.querySelector('.ink-view-panel-source') as HTMLElement;
    const sourcePanel = () => within(sourcePanelEl());
    await waitFor(() => expect(sourcePanel().getByText('手工记的')).toBeDefined());

    await pickCardMenu('编辑', { scope: sourcePanelEl() });
    fireEvent.change(sourcePanel().getByPlaceholderText('标题'), { target: { value: '改到一半还没存' } });

    fireEvent.click(navButton(/今天/));
    fireEvent.click(navButton(/按来源/));

    expect((sourcePanel().getByPlaceholderText('标题') as HTMLInputElement).value).toBe('改到一半还没存');
  });
});

/**
 * final-review.md I1：Settings.focusMinutes 从设置弹层到卡片这条链路，三处
 * 接线（App.tsx 的 gridWiring/TodayView/TaskBoard）互相独立、各自手写一遍——
 * 删掉任何一处都不影响另外两处，也不会有任何东西报错，卡片只是悄悄落回
 * TaskCard.tsx 写死的默认值 25。三条各守一处，夹具用不等于 25 的 45（见上面
 * settings 常量的注释），传对了显示 45:00，传漏了会露馅成 25:00。
 */
describe('App：设置里的番茄钟时长真的传到了卡片上——三处独立接线各自守一次（I1）', () => {
  it('「全部」（App.tsx 的 gridWiring）：卡片上是 45:00，不是写死的 25', async () => {
    currentTasks = [task({ id: 'a', title: '任务甲' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;

    fireEvent.click(within(panel).getByText('开始专注'));
    expect(within(panel).getByText('45:00')).toBeTruthy();
  });

  it('「今天」（App.tsx 手写的 focusMinutes prop）：卡片上是 45:00，不是写死的 25', async () => {
    currentTasks = [task({ id: 'a', title: '早该做了', due: '2000-01-01T00:00:00.000Z' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const panel = () => container.querySelector('.ink-view-panel-today') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('早该做了')).toBeDefined());

    fireEvent.click(within(panel()).getByText('开始专注'));
    expect(within(panel()).getByText('45:00')).toBeTruthy();
  });

  it('「按来源」（App.tsx 手写的 focusMinutes prop）：卡片上是 45:00，不是写死的 25', async () => {
    currentTasks = [task({ id: 'a', title: '手工记的', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/按来源/));
    const panel = () => document.querySelector('.ink-view-panel-source') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('手工记的')).toBeDefined());

    fireEvent.click(within(panel()).getByText('开始专注'));
    expect(within(panel()).getByText('45:00')).toBeTruthy();
  });
});

describe('App：收件箱现在也是一个可切换的视图，切走不能把正在编辑的草稿卸载掉（I1）', () => {
  it('切走再切回来，「收件箱」里正在编辑的草稿还在——以前它常驻在左栏，不会被顶层切换影响，现在它自己也是一个视图，得靠 keepMounted 补回同样的保护', async () => {
    currentInbox = [{ id: 'i1', text: '原话', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/收件箱/)).toBeDefined());

    fireEvent.click(navButton(/收件箱/));
    const panel = () => container.querySelector('.ink-view-panel-inbox') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('原话')).toBeDefined());

    // 「编辑」在 InboxRow 上是个直接可见的按钮，不像 TaskCard 那样收在 ⋯
    // 菜单里——按钮文字找，不用 getByRole（同一条 jsdom 性能教训）。
    const editBtn = [...panel().querySelectorAll('button')].find((b) => b.textContent === '编辑');
    if (!editBtn) throw new Error('收件箱这一行没有「编辑」按钮');
    fireEvent.click(editBtn);
    const textarea = () => panel().querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea(), { target: { value: '改到一半还没存' } });

    fireEvent.click(navButton(/今天/));
    fireEvent.click(navButton(/收件箱/));

    expect(textarea().value).toBe('改到一半还没存');
  });
});

describe('App：「新任务」在收件箱这类视图里也能点，得说清楚新卡去哪了（I2）', () => {
  it('从「收件箱」建一条任务，提示说清楚它在「按来源」里——不是一句不痛不痒、看不出去哪了的「已添加」', async () => {
    currentTasks = [];
    currentInbox = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/收件箱/)).toBeDefined());

    fireEvent.click(navButton(/收件箱/));
    // 切去处现在经 hash 往返（写 hash → hashchange → setView），jsdom 里
    // hashchange 是排到 setTimeout(0) 才触发的——不等它落地，TaskComposer
    // 拿到的 view 还是切换前的那个，「已添加」提示会算错地方。
    await screen.findByRole('heading', { level: 1, name: '收件箱' });
    await openTaskForm();
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '临时任务' } });
    // 「添加」恰好两个汉字、没有图标，antd 会插一个空格（渲染成「添 加」）——
    // 应用在 main.tsx 用 autoInsertSpace: false 关掉了这个行为，但这里直接
    // 渲染 App、没走那层 ConfigProvider，按钮文字在测试里还是带空格的。
    // btnIn 比对前会先去空白，见 test-utils.tsx 的注释。
    fireEvent.click(btnIn(document.body, '添加'));

    expect(await screen.findByText('已添加。这条在「按来源」里')).toBeDefined();
  });
});

describe('App：新建任务时 TaskDraft 的字段不能被 App.tsx 手挑漏掉', () => {
  // 根因：TaskComposer 把整份 TaskDraft 传给 onCreate，但 App.tsx 里
  // `onCreate={(d) => api.addTask({ ... })}` 是手挑字段拼请求体，不是把 d
  // 原样展开——TaskDraft 新增一个字段，这里不会自动带上，服务端收不收无所谓，
  // 请求根本没发出去。这条测试打穿组件边界、走到真正发给 api.addTask 的
  // 请求体，不能只测到「TaskFields 把值传给了 onChange」就停（那止步于
  // TaskComposer 内部，够不到这一层）。
  //
  // 查询全部限定在 composer 卡片这个小子树里（.ink-task-composer），不用
  // 不加范围的 screen.getByRole——App 常驻挂载今天/按来源/收件箱/回顾/垃圾箱
  // 好几个视图，未限定范围的可访问性查询要对全树候选元素逐个算可访问名，
  // 见本文件 108 行 navButton 上面那段注释同样的教训。
  //
  // listId 是 Task 3 补的第三个字段——同一条根因，同一种测法：组件级的
  // TaskComposer.test.tsx 只断言到被 mock 的 onCreate prop 收到了 listId，
  // 够不到 App.tsx 那行手挑字段有没有把它带上，只有打穿到 api.addTask 的
  // 这一层才测得出来。
  //
  // repeat 是 Task 4 补的第四个字段——同一条根因：App.tsx 的 onCreate 手挑
  // 字段这一行漏了 `repeat: d.repeat` 的话，新建表单里设的重复规则会被静默
  // 丢弃，界面照样弹「已添加」，跟 tags/priority/listId 曾经栽过的是同一种坏。
  it('新建表单里打标签、选「高」优先级、选一个清单、设成「每周一」重复再提交，四个字段都真的进了发给 api.addTask 的请求体', async () => {
    currentTasks = [];
    currentLists = [list({ id: 'L1', name: '工作' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    await openTaskForm();
    const card = document.querySelector('.ink-task-composer') as HTMLElement;
    const form = within(card);

    fireEvent.change(form.getByPlaceholderText('标题'), { target: { value: '临时任务' } });
    const tagBox = form.getByLabelText('加标签');
    fireEvent.change(tagBox, { target: { value: '紧急' } });
    fireEvent.keyDown(tagBox, { key: 'Enter' });
    fireEvent.click(form.getByRole('button', { name: '高' }));
    fireEvent.change(form.getByLabelText('归到哪个清单'), { target: { value: 'L1' } });
    fireEvent.change(form.getByLabelText('重复'), { target: { value: 'week' } });
    fireEvent.click(form.getByRole('button', { name: '周一' }));
    fireEvent.click(btnIn(card, '添加'));

    await waitFor(() => expect(api.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['紧急'], priority: 3, listId: 'L1',
        repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
      }),
    ));

    // 结构性守卫，不是又一条挑字段的断言：上面那条 objectContaining 只锁住
    // 了写这条测试那天存在的四个字段，第十个字段再被 App.tsx 手挑漏掉，这条
    // 测试不会拦——它只检查列出的那几个键在不在，不检查「TaskDraft 有的键，
    // 请求体是不是也都有」。这里改成反过来问：TaskDraft（emptyDraft() 的键）
    // 一个个过一遍，每一个都得能在请求体里找到对应的键——remindAt 是唯一的
    // 例外，它在 App.tsx 里被转成了 reminders。这样以后 TaskDraft 加第十个
    // 字段，App.tsx 的 onCreate 手挑字段那行忘了带上，这里会红，且报错信息
    // 点名是哪个字段。
    const body = vi.mocked(api.addTask).mock.calls[0]![0] as Record<string, unknown>;
    for (const k of Object.keys(emptyDraft())) {
      expect(Object.keys(body), `TaskDraft.${k} 没进请求体`).toContain(k === 'remindAt' ? 'reminders' : k);
    }
  });
});

/**
 * 收件箱那颗「变成任务」的**分行**。接线本身在 InboxSidebar.test.tsx（点了报不报
 * id），这里测的是 App.tsx 里那一段：随手记是个多行框（提示语就写着「想到
 * 什么写什么，不用整理」），而任务的标题是一行。
 */
describe('收件箱「变成任务」：第一行当标题，剩下的进备注', () => {
  /**
   * **只留这一条端到端。** 拆行本身（第一行当标题、剩下的进备注）是纯函数
   * `splitCapture`，在 `lib/composeDefaults.test.ts` 里单测，不用为它再渲染一次整个 App
   * ——那一次渲染实测会把用例压到 15s 超时线上（全量跑时红、单跑绿，见
   * vitest.config.ts 里为什么不放宽 TIMEOUT 那段）。这一条留着，是因为它钉的是
   * **接线**：下拉里点一下 → 真的发出一个带 later 的建任务请求，而且带着拆好的
   * 标题/备注——那是单测看不到的那一段。
   */
  /**
   * **这条用例曾经压在 15s 超时线上**（上面那段注释里「实测会把用例压到 15s
   * 超时线上」说的就是它），全量跑时随机红。逐步计时之后原因很单一：
   *
   *     render(<App/>)        310ms
   *     waitFor 导航按钮       230ms
   *     click 收件箱            94ms
   *     findByRole 变成任务   4323ms   ← 85%~90%
   *     click ▾                 55ms
   *     click 以后再说           15ms
   *     waitFor addTask          1ms
   *
   * `*ByRole` 要给 DOM 里**每个**元素算可访问名，而这里渲染的是整棵 App（还含
   * `keepMounted` 的几个视图）——一次扫两秒多，而收件箱是异步来的、至少要重试
   * 一次。换成 `findByText`（不碰可访问性树）之后整条从 ~5.0s 降到 ~0.9s。
   *
   * 断言强度的差别（不再顺带确认它是个 `button`）在这里不要紧：这一步的作用只是
   * **等收件箱那一屏渲染出来**，真正要钉的是下面那几下点击和最后发出的请求。
   */
  it('▾ 里点「以后再说」：**建出来就是搁置**，不是建完再改一次状态', async () => {
    currentInbox = [{
      // 多行：同一条用例顺便钉住「拆好的标题/备注真的跟着这条请求走了」。
      id: 'i1', text: ['学日语', '先把五十音图背下来'].join('\n'),
      createdAt: '2026-08-25T02:00:00.000Z', processed: false, taskIds: [],
    }];
    // 这个文件的 api mock 不在用例之间清，`not.toHaveBeenCalled()` 在全量跑时没意义
    // （实测：已经被前面的用例调了 20 次）。比的是**这一下有没有新增**。
    const patchesBefore = vi.mocked(api.patchTask).mock.calls.length;
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/收件箱/)).toBeDefined());
    fireEvent.click(navButton(/收件箱/));
    // `findByText` 不是 `findByRole`：理由和实测数字在这条用例上面那段注释里。
    await screen.findByText('变成任务');

    fireEvent.click(document.querySelector('.ant-dropdown-trigger') as HTMLElement);
    const hit = await waitFor(() => {
      const el = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent?.includes('以后再说'));
      if (!el) throw new Error('菜单里没有「以后再说」');
      return el;
    });
    fireEvent.click(hit);

    await waitFor(() => expect(api.addTask).toHaveBeenCalled());
    const body = vi.mocked(api.addTask).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(body.title).toBe('学日语');
    expect(body.notes).toBe('先把五十音图背下来');
    expect(body.status).toBe('later');
    // 建完没再补一次改状态的 PATCH——那正是这条测试要拦的退化实现。
    expect(vi.mocked(api.patchTask).mock.calls.length).toBe(patchesBefore);
  });

});

describe('App：建一条任务 → 归到某个清单 → 切到那个清单的视图 → 那条任务在（Task 3 端到端）', () => {
  // 「清单区永远是空的」是两批前就有的问题——导航的「清单」区和「新建清单」
  // 早就在了，但没有任何办法把一条任务放进清单。这条测试打穿组件边界走完
  // 整条真实链路：新建一条不带清单的任务 → 打开它的编辑态、在 TaskCard 内嵌
  // 的表单里选一个清单、保存（这一步走的是 TaskCard.tsx 的 save()）→ 模拟
  // SSE data-changed('tasks') 触发的 reload → 切到那个清单的导航项 → 断言
  // 卡片真的出现在那个清单的视图里。
  //
  // 变异验证：把 TaskCard.tsx 的 save() 里 `listId: draft.listId` 删掉，
  // 这条必须红——那正是这条测试要守住的接线。
  it('新建一条任务、编辑态里选一个清单再保存，切到那个清单的视图能看到它', async () => {
    currentTasks = [];
    currentLists = [list({ id: 'L1', name: '工作' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());

    // 建一条不带清单的任务。
    await openTaskForm();
    const composerCard = document.querySelector('.ink-task-composer') as HTMLElement;
    fireEvent.change(within(composerCard).getByPlaceholderText('标题'), { target: { value: '交给工作清单的任务' } });
    fireEvent.click(btnIn(composerCard, '添加'));
    await waitFor(() => expect(api.addTask).toHaveBeenCalled());

    // 模拟落盘 + SSE data-changed('tasks') → reload 这条真实链路：新任务
    // 出现在「按来源」（默认视图是「今天」，这条任务没有时间字段，进不去）。
    currentTasks = [task({ id: 'new-task', title: '交给工作清单的任务', listId: null, due: null, reminders: [] })];
    act(() => handlers.onChange!('tasks'));

    fireEvent.click(navButton(/按来源/));
    const sourcePanel = () => container.querySelector('.ink-view-panel-source') as HTMLElement;
    await waitFor(() => expect(within(sourcePanel()).getByText('交给工作清单的任务')).toBeDefined());

    // 编辑它，在 TaskCard 内嵌的表单里选一个清单，保存——这一步走的是
    // TaskCard.tsx 的 save()，见上面的变异验证注释。
    await pickCardMenu('编辑', { scope: sourcePanel() });
    fireEvent.change(within(sourcePanel()).getByLabelText('归到哪个清单'), { target: { value: 'L1' } });
    fireEvent.click(btnIn(sourcePanel(), '保存'));
    await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('new-task', expect.objectContaining({ listId: 'L1' })));

    // 模拟这次 PATCH 落盘之后的 SSE 刷新。
    currentTasks = [task({ id: 'new-task', title: '交给工作清单的任务', listId: 'L1', due: null, reminders: [] })];
    act(() => handlers.onChange!('tasks'));

    fireEvent.click(navButton(/工作/));
    const scopedPanel = () => container.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(within(scopedPanel()).getByText('交给工作清单的任务')).toBeDefined());

    // 审查 I-3：光看任务标题在不在，挡不住 App.tsx 把 gridWiring.lists 悄悄
    // 传成 [] ——那样任务照样会出现在清单视图里（scopedSections 按 t.listId
    // 筛，不看 App 有没有把 lists 传给 TaskGrid），只是卡片上不画竖条。
    // 这一行同时钉住 gridWiring 那条线和 App→TaskGrid→TaskCard 的整条穿透。
    expect(scopedPanel().querySelector('.ink-list-bar')).not.toBeNull();
  });
});

describe('App：建一条任务 → 编辑态里设成「每周一」重复 → 保存 → 卡片上出现「↻ 每周一」（Task 4 端到端）', () => {
  // 同一条根因、同一种测法：App.tsx 的 onCreate 是手挑字段拼请求体（这一批
  // 加了 `repeat: d.repeat`），组件级的 TaskFields.test.tsx/RepeatFields.test.tsx
  // 只够得到 onChange/onCreate 被 mock 的那一层，够不到 App.tsx 那行手挑字段
  // 有没有把它带上。这条走 TaskCard 的编辑态而不是新建表单，是为了同时把
  // TaskCard.tsx 的 save() 也钉住——那里这一批加了 `repeat: draft.repeat`。
  //
  // 变异验证：把 TaskCard.tsx 的 save() 里 `repeat: draft.repeat` 删掉，
  // 这条必须红。
  it('新建一条任务、编辑态里把重复设成「每周一」再保存，卡片上出现「↻ 每周一」', async () => {
    currentTasks = [];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // 建一条不带时间的任务——不会进「今天」，去「按来源」找它。
    await openTaskForm();
    const composerCard = document.querySelector('.ink-task-composer') as HTMLElement;
    fireEvent.change(within(composerCard).getByPlaceholderText('标题'), { target: { value: '每周一开会' } });
    fireEvent.click(btnIn(composerCard, '添加'));
    await waitFor(() => expect(api.addTask).toHaveBeenCalled());

    currentTasks = [task({ id: 'new-task', title: '每周一开会', due: null, reminders: [] })];
    act(() => handlers.onChange!('tasks'));

    fireEvent.click(navButton(/按来源/));
    const sourcePanel = () => container.querySelector('.ink-view-panel-source') as HTMLElement;
    await waitFor(() => expect(within(sourcePanel()).getByText('每周一开会')).toBeDefined());

    // 编辑它，在 TaskCard 内嵌的表单里把重复设成「每周一」，保存——这一步走的
    // 是 TaskCard.tsx 的 save()，见上面的变异验证注释。
    await pickCardMenu('编辑', { scope: sourcePanel() });
    fireEvent.change(within(sourcePanel()).getByLabelText('重复'), { target: { value: 'week' } });
    fireEvent.click(within(sourcePanel()).getByRole('button', { name: '周一' }));
    fireEvent.click(btnIn(sourcePanel(), '保存'));
    await waitFor(() => expect(api.patchTask).toHaveBeenCalledWith('new-task', expect.objectContaining({
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })));

    // 模拟这次 PATCH 落盘之后的 SSE 刷新，断言卡片上真的出现了那句人话，
    // 不是渲染 JSON——describeRepeat 的活儿由 TaskCard 接过去。
    currentTasks = [task({
      id: 'new-task', title: '每周一开会', due: null, reminders: [],
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })];
    act(() => handlers.onChange!('tasks'));

    await waitFor(() => expect(within(sourcePanel()).getByText('↻ 每周一')).toBeDefined());
  });
});

describe('App：「今天」视图里的卡片也要看得到清单归属（TodayView 那条 lists 接线，审查 I-3 的另一半）', () => {
  it('今天视图里一条挂着清单的任务，卡片上有竖条——防止 App.tsx 把 lists={[]} 传给 TodayView 却没有测试兜住', async () => {
    currentLists = [list({ id: 'L1', name: '工作' })];
    // 用过期任务而不是精确的「今天」时刻，避免跟运行测试的机器时区绑定
    // ——跟本文件别处「早该做了」那批夹具同一个写法。
    currentTasks = [task({ id: 't1', title: '今天该处理的', listId: 'L1', due: '2000-01-01T00:00:00.000Z', reminders: [] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    const todayPanel = () => container.querySelector('.ink-view-panel-today') as HTMLElement;
    await waitFor(() => expect(within(todayPanel()).getByText('今天该处理的')).toBeDefined());
    expect(todayPanel().querySelector('.ink-list-bar')).not.toBeNull();
  });
});

describe('App：每个视图的 <section> 都留着可访问名（I3）', () => {
  it('keepMounted 的三个视图（今天/按来源/收件箱）各自的 <section> 都有 aria-label，不会静默丢成没有 region 角色的 generic 容器', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // <section> 只有带上可访问名（aria-label/aria-labelledby）才会算作
    // role="region"——按 region 角色 + 名字查，丢了某个视图的 aria-label
    // 会让对应那一条直接找不到元素报错，不用另外拿 getAttribute 判空。
    // 不用 { hidden: true } 去连没被选中、原生 hidden 藏着的那两个一起查：
    // dom-testing-library 算可访问名的时候，display:none 的元素名字会
    // 直接算成空字符串（哪怕 aria-label 属性本身还在），"hidden: true"
    // 只是把这一类元素重新纳入候选，算名字这一步不受它影响——用这个选项
    // 反而测不出真正的问题。改成依次点过去，每次都只断言**当前可见**
    // 的那一个，这也更贴近真实场景：一个隐藏元素的可访问名对屏幕阅读器
    // 用户本来就没有意义，不值得单独测。
    for (const [navName, label] of [[/今天/, '今天'], [/按来源/, '按来源'], [/收件箱/, '收件箱']] as const) {
      fireEvent.click(navButton(navName));
      // 切去处经 hash 往返，hashchange 在 jsdom 里排到 setTimeout(0) 才触发——
      // 不等它落地，region 的 hidden 祖先还没换，getByRole 会找错那个。
      await waitFor(() => expect(screen.getByRole('region', { name: label })).toBeDefined());
    }
  });
});

describe('App：两个视图各自的错误边界互不影响', () => {
  it('「按来源」渲染崩溃不会拖累「今天」——旧写法共用一个边界、不随视图切换重置，一边崩了切到另一边也只看得到错误提示', async () => {
    currentTasks = [
      task({ id: 'good', title: '好任务（今天）', due: '2000-01-01T00:00:00.000Z' }),
      // status: later 的坏数据只会被「按来源」渲染到——「今天」的成员资格
      // 直接排除 later，用它制造一次只发生在「按来源」那一侧的真实渲染异常。
      explodingTask({ status: 'later', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await waitFor(() => expect(screen.getByText('好任务（今天）')).toBeDefined());

    fireEvent.click(navButton(/按来源/));
    await waitFor(() => expect(screen.getByText('任务看板加载失败')).toBeDefined());

    fireEvent.click(navButton(/今天/));

    // 「今天」自己的树从来没碰过那条坏数据，应该正常显示——不该被「按来源」
    // 那边炸出来的错误边界状态拖着一起显示失败提示。「按来源」的错误提示
    // 还在 DOM 里（两个视图都常驻挂载），但必须是不可见/不可达的那一份
    // （hidden 祖先），不能是当前展示给用户看的这一份。
    // 切去处经 hash 往返，hashchange 在 jsdom 里排到 setTimeout(0) 才触发——
    // 等它落地，「按来源」那份才会真的挂上 hidden。
    await waitFor(() => expect(screen.getByText('任务看板加载失败').closest('[hidden]')).not.toBeNull());
    expect(screen.getByText('好任务（今天）')).toBeDefined();
  });
});

describe('App：任务看板崩了不能带走整个页面', () => {
  it('看板渲染期间炸出异常时，设置按钮和收件箱照常能用，只有看板本身换成错误提示', async () => {
    // 用一个目前还没专门 guard 类型的字段（subtasks）触发一次真实的渲染期
    // 异常——错误边界要接住的是「任何没预料到的崩」，不是只有 #2 号已经在
    // taskView.ts 里修掉的 taskIds 那一种。data/tasks.json 同样是手改的，
    // 这类问题随时可能换一张新面孔出现，边界是最后一道兜底，不是替代那些
    // 具体字段的类型 guard。due 特意给一个早就过去的日子、status 留默认
    // 的 todo——这张坏卡「今天」（过期未完成）和「按来源」（默认筛选「全部」）
    // 都会渲染到：两个视图现在常驻挂载、各自包一层边界，这张卡会让两边各
    // 炸一次，这里不关心炸了几次，只关心「看板之外」的东西没被拖下水。
    currentTasks = [explodingTask({ due: '2000-01-01T00:00:00.000Z' })];

    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 看板报错了，但设置按钮（跟坏文件无关的功能）还在，还能点。
    await waitFor(() => expect(screen.getAllByText('任务看板加载失败').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /设置/ })).toBeDefined();
  });
});

describe('App：清单/标签是动态去处，不在 registry 里，靠 lib/scoped.ts 的一条回退分支渲染', () => {
  // 不测这一层的话，App.tsx 里那一整段「点清单/标签导航项该渲染什么」的接线
  // 是零覆盖的——scoped.ts 自己的单测只管纯函数对不对，接不接得到 TaskGrid、
  // 点不点得进去，是这一层才验得出来的事。
  const scopedPanel = (container: HTMLElement) =>
    within(container.querySelector('.ink-view-panel-scoped') as HTMLElement);

  it('点清单导航项，只看到这个清单里的任务，别的清单/没清单的任务不出现', async () => {
    currentLists = [list({ id: 'L1', name: '工作' })];
    currentTasks = [
      task({ id: 'a', title: '清单内的', listId: 'L1', due: null, reminders: [] }),
      task({ id: 'b', title: '清单外的', listId: null, due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());

    fireEvent.click(navButton(/工作/));

    await waitFor(() => expect(scopedPanel(container).getByText('清单内的')).toBeDefined());
    expect(scopedPanel(container).queryByText('清单外的')).toBeNull();
    expect(navButton(/工作/).getAttribute('aria-current')).toBe('page');
  });

  it('点标签导航项，只看到带这个标签的任务', async () => {
    currentTasks = [
      task({ id: 'a', title: '带标签的', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '没标签的', tags: [], due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/紧急/)).toBeDefined());

    fireEvent.click(navButton(/紧急/));

    await waitFor(() => expect(scopedPanel(container).getByText('带标签的')).toBeDefined());
    expect(scopedPanel(container).queryByText('没标签的')).toBeNull();
  });

  it('清单里一条任务都没有时说一句话，不是一片空白——而且说的是「这一屏空着」，不是「你没有任务」（别的清单可能满满当当）', async () => {
    currentLists = [list({ id: 'L1', name: '空清单' })];
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/空清单/)).toBeDefined());

    fireEvent.click(navButton(/空清单/));

    expect(await screen.findByText(/这儿还空着/)).toBeDefined();
  });

  it('编辑中切清单，另一个清单不能带着上一个清单正在编辑的卡跟过来——回退分支只有一个 TaskGrid 实例服务所有 list:/tag:，没有 key 的话 React 不会卸载重挂，editingIds 会带着上一个清单的 id 活下来', async () => {
    currentLists = [list({ id: 'L1', name: '工作' }), list({ id: 'L2', name: '生活' })];
    currentTasks = [
      task({ id: 'a', title: '甲任务', listId: 'L1', due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', listId: 'L2', due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());

    fireEvent.click(navButton(/工作/));
    const panel = () => container.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());

    // 打开「甲任务」的编辑器——标题这时候被一个输入框取代，正是没有 key
    // 时会被带过去的那份本地状态（TaskGrid 的 editingIds）。
    await pickCardMenu('编辑', { scope: panel() });
    expect(within(panel()).getByPlaceholderText('标题')).toBeDefined();

    fireEvent.click(navButton(/生活/));

    await waitFor(() => expect(within(panel()).getByText('乙任务')).toBeDefined());
    // 只有一张卡：甲任务（连同它没存的编辑框）不该跟着漏过来。
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(1);
    expect(within(panel()).queryByText('甲任务')).toBeNull();
    expect(within(panel()).queryByPlaceholderText('标题')).toBeNull();
  });
});

describe('App：搜索', () => {
  it('**搜索结果按紧急度排**——它是在 tasks 上 filter 出来的，不排的话保留的是服务端读目录的顺序（文件名是 uuid，等于随机）', async () => {
    const at = (d: number) => new Date(2026, 7, d, 9).toISOString();
    // 故意按「该排最后的放最前」传进去：不排序的实现会原样吐回来，这条就红。
    currentTasks = [
      task({ id: 'c', title: '报告三', due: at(30), reminders: [] }),
      task({ id: 'b', title: '报告二', due: at(1), reminders: [] }),
      task({ id: 'a', title: '报告一', due: at(31), reminders: [], pinned: true }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await searchFor('报告');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });

    const panel = container.querySelector('.ink-view-panel-search') as HTMLElement;
    // 卡片标题是 antd 的 Typography.Text（没有自己的 class），按 `strong` 取。
    const titles = [...panel.querySelectorAll('.ant-typography strong, strong.ant-typography')]
      .map((e) => e.textContent);
    expect(titles).toEqual(['报告一', '报告二', '报告三']);   // 置顶 → 过期 → 按时间
  });

  it('搜到的东西在弹层里，回车进「搜索结果」那个去处，只显示匹配的任务', async () => {
    currentTasks = [
      task({ id: 'a', title: '写周报', due: null, reminders: [] }),
      task({ id: 'b', title: '买菜', due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 先看弹层里那一列：打字就出结果，不用回车。
    const box = await openSearch();
    fireEvent.change(box, { target: { value: '周报' } });
    const modal = screen.getByRole('dialog');
    expect(within(modal).getByText('写周报')).toBeTruthy();
    expect(within(modal).queryByText('买菜')).toBeNull();

    // 回车 = 看全部结果：进「搜索结果」那个去处。
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('heading', { level: 1, name: '搜索结果' })).toBeTruthy();
    expect(window.location.hash).toBe('#/search');

    // 只看匹配到的那条——不搜「买菜」不该在搜索结果面板里出现，否则一个
    // 忽略 hits、把 tasks 原样塞给 TaskGrid 的坏实现也能让上面那条标题
    // 断言通过。
    const panel = within(container.querySelector('.ink-view-panel-search') as HTMLElement);
    expect(panel.getByText('写周报')).toBeTruthy();
    expect(panel.queryByText('买菜')).toBeNull();
  });

  it('**没打字不进搜索结果**——空着回车是白跑一趟', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const box = await openSearch();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.location.hash).toBe('');
  });

  /**
   * 搜索也认清单和标签（仿滴答清单搜索页的三个类型）。这里守的是接线：
   * 匹配到的清单/标签有没有真的出现在搜索结果上面、点了会不会跳过去。
   * 匹配判据本身在 lib/search.test.ts。
   */
  it('搜到的清单和标签摆在任务列表上面，点了跳过去', async () => {
    currentLists = [list({ id: 'L1', name: '工作台账' })];
    currentTasks = [task({ id: 'a', title: '写周报', tags: ['工作'], due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await searchFor('工作');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });

    const jumps = await waitFor(() => {
      const el = document.querySelector('.ink-search-jumps') as HTMLElement | null;
      if (!el) throw new Error('「跳转到」那一排还没出现');
      return el;
    });
    // 清单名匹配「工作」，标签「工作」也匹配——两个都该在同一排里
    expect(within(jumps).getByRole('button', { name: '工作台账' })).toBeTruthy();
    expect(within(jumps).getByRole('button', { name: '#工作' })).toBeTruthy();

    fireEvent.click(within(jumps).getByRole('button', { name: '工作台账' }));
    expect(window.location.hash).toBe('#/list:L1');
  });

  it('只搜到任务、没搜到清单/标签时那一排整个不出现', async () => {
    currentLists = [];
    currentTasks = [task({ id: 'a', title: '写周报', tags: [], due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await searchFor('周报');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });

    expect(document.querySelector('.ink-search-jumps')).toBeNull();
  });

  /**
   * **这一条演的是「有任务、只是没搜着」**（`currentTasks` 非空），所以要的是
   * 「没匹配上 + 换个词」那一支。一条任务都没有时是另一句（先去建一条）——
   * 分档在 `App.tsx` 那处 `tasks.length === 0`，弹层那份在 `SearchModal.test.tsx`。
   */
  it('搜索没有命中：说清没匹配上，并给下一步，不是一片空白', async () => {
    currentTasks = [task({ id: 'a', title: '写周报', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await searchFor('压根搜不到的词');

    await screen.findByRole('heading', { level: 1, name: '搜索结果' });
    expect(await screen.findByText(/没有匹配的任务/)).toBeDefined();
    expect(screen.getByText(/换个词试试/), '只说「没匹配」是死胡同——空态要给下一步').toBeDefined();
  });
});

/**
 * 「接下来」里「已过期」那一组的组头上那颗「全部改到今天」（仿滴答清单右键
 * 分组的「全部延期到今天」）。**算什么在 `lib/reschedule.test.ts`**，这里只测
 * 接线：挂在哪一组、推的是哪几条。
 */
describe('App：「已过期」整组顺延', () => {
  const overdue = (id: string, daysAgo: number): Task => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(9, 0, 0, 0);
    return task({ id, title: `过期${id}`, due: d.toISOString(), reminders: [] });
  };

  const openUpcoming = async (ts: Task[]) => {
    currentTasks = ts;
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/接下来/)).toBeDefined());
    fireEvent.click(navButton(/接下来/));
    // 卡片上也有一枚「已过期」的记号（.ink-overdue-mark），按文字取会撞上——
    // 等的是组头那一个。
    // `includes` 不是 `startsWith`：每一组都能折之后，组头文字前面多了一个
    // 折叠三角（`.ink-grid-caret` 的 ▾），「已过期」不再是第一个字。
    await waitFor(() => expect(
      [...document.querySelectorAll('.ink-grid-heading')].some((h) => h.textContent?.includes('已过期')),
    ).toBe(true));
  };

  // 按 class 取，不走 findByRole({name})：可访问名要给这一屏每颗按钮算一遍，
  // 慢到分钟级，见「勾完给一次撤销」那组上面的注释。
  const deferBtn = () => document.querySelector('.ink-grid-action') as HTMLButtonElement | null;

  it('「已过期」那一组的组头上有这颗按钮——这个应用没有「全选」，八条过期任务得点八下才轮得到批量改期', async () => {
    await openUpcoming([overdue('a', 3), overdue('b', 1)]);
    expect(deferBtn()?.textContent).toBe('全部改到今天');
  });

  it('别的组没有——「明天」「7 天内」整组顺延不是一个说得通的动作', async () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 1);
    soon.setHours(9, 0, 0, 0);
    currentTasks = [task({ id: 'x', title: '明天的', due: soon.toISOString(), reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/接下来/)).toBeDefined());
    fireEvent.click(navButton(/接下来/));
    await screen.findByText('明天');
    expect(deferBtn()).toBeNull();
  });

  /**
   * 钉住时钟：夹具那几条都是 09:00 的，而这颗按钮的落点跟「现在几点」有关——
   * 09:00 今天还没到就照原样搬过来，已经过去了就落 23:59（`reschedule.ts` 的
   * ③）。不钉的话这条测试上午绿、下午红。这里钉在**下午**，测的正是这颗按钮
   * 真正要兑现的那件事：按完之后它们不再是过期的。
   */
  it('点了逐条发 patch，组里有几条就发几条——而且每条都不再是过去的时刻', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 22, 15, 0, 0));
    try {
      await openUpcoming([overdue('a', 3), overdue('b', 1)]);

      fireEvent.click(deferBtn()!);

      await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalled());
      const [patches] = (api.patchTasksEach as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const list = patches as Array<{ id: string; patch: { due: string } }>;
      expect(list.map((e) => e.id).sort()).toEqual(['a', 'b']);
      for (const e of list) {
        const d = new Date(e.patch.due);
        expect(d.toDateString()).toBe(new Date().toDateString());
        // **这才是这颗按钮的意义**：原来那个 09:00 今天已经过去了，照原样搬
        // 过来的话它当场又是过期的，「已过期」那一组按完还是原样。
        expect(d.getTime()).toBeGreaterThan(Date.now());
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('App：四个网格视图各自的空状态文案', () => {
  // 这几条视图空的时候各显示一句不一样的话（App.tsx 里各自的 `empty` prop）——
  // 全仓之前零引用，改错一个字、或者四个都塞成同一句，没有任何测试会红。
  // 清单/标签那句已经在别处有断言，这里不重复。
  it('「接下来」没有排期的任务时，说清这一屏收什么——空屏正是解释规则的时候', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/接下来/)).toBeDefined());

    fireEvent.click(navButton(/接下来/));

    expect(await screen.findByText(/还没有排上日子的任务/)).toBeDefined();
  });

  it('「全部」一条任务都没有时，指向上面那行输入——一个空屏是一句邀请，不是一张讣告', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());

    fireEvent.click(navButton(/全部/));

    expect(await screen.findByText(/还没有任务。新建一条/)).toBeDefined();
  });

  it('「已完成」还空着时，说清这一屏是个去处不是个筛子——做完的会留在这儿', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/已完成/)).toBeDefined());

    fireEvent.click(navButton(/已完成/));

    expect(await screen.findByText(/做完的会留在这儿/)).toBeDefined();
  });
});

describe('App：密度开关（task-2-brief）——只在「可切」的几个视图出现，切换真的换渲染，状态记在本机', () => {
  // 密度开关是一个 role="group" aria-label="密度" 的容器，里面两颗按钮
  // 「行」/「卡」，见 App.tsx 渲染处。**查询一律限定在 `container` 这棵树里**
  // （不用不加范围的 `screen.getByRole`/`screen.queryByRole`）——这两个视图
  // 常驻挂载（今天/收件箱 keepMounted）之后，`screen` 顶层查询失败时 RTL 会
  // 序列化整个 document.body（含隐藏的常驻视图），一条用例实测跑到 307 秒
  // 才红；限定范围之后失败时只序列化 `container` 这一棵子树，几秒内就能看到
  // 结果。跟 navButton 顶上那条注释是同一条教训，只是这次连「失败路径」也
  // 要一起限定，不能只顾着成功路径快。
  const densityGroup = (container: HTMLElement) =>
    within(container).queryByRole('group', { name: '密度' });
  const clickDensity = (container: HTMLElement, label: '行' | '卡') =>
    fireEvent.click(within(densityGroup(container)!).getByRole('button', { name: label }));

  it('看板 / 四象限 / 日历 / 按来源：找不到密度开关（上限）', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // **「按来源」先测。** 它在清单侧栏上，而侧栏只有任务模块才渲染
    // （lib/views.tsx 的 `showsSidebar`）——先切去看板/日历，侧栏就没了，
    // 再想点「按来源」压根找不到那颗按钮。三个模块视图放后面，它们在最左
    // 那条竖栏上，任何时候都点得到。
    fireEvent.click(navButton(/按来源/));
    await screen.findByRole('heading', { level: 1, name: '按来源' });
    expect(densityGroup(container)).toBeNull();

    await goBoard();
    expect(densityGroup(container)).toBeNull();

    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    expect(densityGroup(container)).toBeNull();

    fireEvent.click(navButton(/日历/));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    expect(densityGroup(container)).toBeNull();
  });

  /**
   * 修复轮 1 · M-1：`canToggleDensity` 曾经写的是 `DENSITY_VIEWS.has(view) ||
   * !findSpec(view)`——`!findSpec(view)` 对任何不在 `VIEW_SPECS` 里的字符串
   * 都成立，包括走到 `scopedSections` 返回 null、落进「没有这个去处」那条
   * 死路的野生 view 值（比如一个指向已删清单的旧书签）。那种情况下页面主体
   * 是一句空状态提示，标题栏却会多出一颗点了没反应的密度开关。改成显式判断
   * `list:`/`tag:` 前缀，跟 `viewTitle()` 的口径对齐。
   */
  it('侧栏点一个情境：真的只剩那一档的任务，标题写中文名不写英文 key', async () => {
    // 三条：一条 @电脑前、一条 @外出、一条没分情境。后两条都不该出现——
    // 尤其是没分情境那一条：它是这一维跟「清单」不一样的地方（那边有一档
    // 「不属于任何清单」可以显式勾，这边没有），也是最容易写反的一步。
    currentTasks = [
      task({ id: 'a', title: '写周报', context: 'computer' }),
      task({ id: 'b', title: '取快递', context: 'out' }),
      task({ id: 'c', title: '没分情境的', context: null }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(navButton(/电脑前/));

    // 标题是中文名。写成 'computer' 就是把存盘的实现细节搔到了人脸上。
    await screen.findByRole('heading', { level: 1, name: '电脑前' });
    // **只在当前这一屏里找**：注册表那几个视图是 keepMounted 的，它们的 DOM
    // 一直挂在树上（只是 hidden），不限定的话同一个标题会在好几屏里各命中一次。
    const panel = document.querySelector('.ink-view-panel-scoped') as HTMLElement;
    expect(within(panel).getByText('写周报')).toBeDefined();
    expect(within(panel).queryByText('取快递')).toBeNull();
    expect(within(panel).queryByText('没分情境的')).toBeNull();
  });

  it('乱填一个完全不认识的去处（既不在注册表也没有 list:/tag: 前缀）：兜底页「没有这个去处」不该长出密度开关', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // hashView.ts 的 viewFromHash：认不出的 hash 原样当成 view，不强行改回
    // 'today'——这里模拟带着一个野生 hash 打开/后退到这里。**不能用
    // `list:xxx`/`tag:xxx`**：scopedSections 对这两种前缀从不返回
    // null（找不到那个清单/标签就退回空的「未完成/已完成」两组，走的是
    // TaskGrid 自己的空状态，不是「没有这个去处」），必须是完全没有前缀、
    // 也不在 VIEW_SPECS 里的字符串才会真的落进这条死路。
    window.location.hash = '#/some-junk-key-nobody-registered';
    fireEvent(window, new HashChangeEvent('hashchange'));

    // 标题和正文各说一半：标题「没有这个去处」，正文说下一步。这里认正文那句。
    await screen.findByText(/这个地址多半来自一个旧书签/);
    // 变异验证锚点：canToggleDensity 换回 `!findSpec(view)`——这条会红
    // （空状态页上会多出一颗密度开关）。
    expect(densityGroup(container)).toBeNull();
  });

  it('今天 / 接下来 / 全部 / 已完成 / 搜索 / 某清单 / 某标签：能看到密度开关', async () => {
    currentLists = [list({ id: 'L1', name: '工作' })];
    currentTasks = [task({ id: 'a', title: '带标签的', tags: ['紧急'] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());

    // 「今天」是挂载时的默认视图，不用点就能看——task-5 补的那个（task-2
    // 交出去时漏了它，见 App.tsx DENSITY_VIEWS 上面的注释）。
    expect(densityGroup(container)).not.toBeNull();

    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    expect(densityGroup(container)).not.toBeNull();

    fireEvent.click(navButton(/接下来/));
    await screen.findByRole('heading', { level: 1, name: '接下来' });
    expect(densityGroup(container)).not.toBeNull();

    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    expect(densityGroup(container)).not.toBeNull();

    fireEvent.click(navButton(/工作/));
    await screen.findByRole('heading', { level: 1, name: '工作' });
    expect(densityGroup(container)).not.toBeNull();

    fireEvent.click(navButton(/紧急/));
    await screen.findByRole('heading', { level: 1, name: '紧急' });
    expect(densityGroup(container)).not.toBeNull();

    await searchFor('带标签的');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });
    expect(densityGroup(container)).not.toBeNull();
  });

  /**
   * 修复轮 1 · C1：以前这里只测了「全部」一个视图从卡片变成行——`density`
   * 是可选 prop，删掉某个视图调用点上的 `density={density}` 不报编译错，
   * `gridWiring` 也是没有类型标注的对象字面量，类型系统在这条路上一句话
   * 都说不上。审查者把 search/upcoming/done/scoped 四处的 `density={density}`
   * 同时删掉，原来那条测试和其余 137 条一起全绿、退出码 0——「只测了一个
   * 就当五个都测了」正是这个仓库栽过五次的「写成功了但界面看上去什么也
   * 没发生」。这条改成对 `DENSITY_VIEWS` 里每一个视图循环一遍 + 单独测一次
   * scoped（清单），一个都不漏。
   *
   * **循环的名单直接从 `DENSITY_VIEWS` 派生**（`App.tsx` 现在 export 了它），
   * 不是这里手抄一份字符串数组——那张表漏了/多了哪个视图，这个循环自动
   * 跟着变，不需要有人记得回来同步两处（M-2 那条注释点名的坑）。
   *
   * task-5：`DENSITY_VIEWS` 加了 `'today'`（原来 4 个变 5 个），循环自动
   * 跟着把它测到，这里不用改一个字——但「今天」不是 `TaskGrid` 调用点，
   * `TodayView` 自己手写 row/card 分支（保留 rank/手动排序），这条测试
   * 断言的是「面板里渲染出的是 `.ink-trow` 还是 `.ink-task-card`」这个
   * 结果，不关心走的是哪条内部路径，对它没有区别。现在总共 6 个（5 个
   * `DENSITY_VIEWS` + 1 个 scoped）。
   */
  it('每个可切密度的去处都真的收到了 density——点一次「行」，挨个切到每个视图，面板里必须是 TaskRow 不是 TaskCard', async () => {
    // **时钟钉死，不用真实 `Date.now()`。** 这条以前的写法是
    // `due: new Date(Date.now() + 1h)`，注释说「App 自己的 `now` 是真实
    // `new Date()`，不是测试能注入的固定时钟」——**那句话是错的**：
    // `vi.useFakeTimers({ toFake: ['Date'] })` 连 App 内部的 `new Date()`
    // 一起钉住，这个文件里另外五处日历测试早就这么做了（见上面 619/648/…）。
    //
    // 代价是这条测试变成了**跟真实时刻有关**的偶发：`Date.now() + 1h` 在
    // 真实 UTC 时间落进 23:00–24:00 那一小时的时候会跨过 UTC 日界，甲任务
    // 就不再落进「接下来」，`TZ=UTC` 下这条当场红。整分支审查实测到了，
    // 而且在原始基线上用 `git worktree` 复现过——**同一台机器、同一个时区，
    // 深夜跑红、过一小时跑绿**，比「换个时区才红」那三处更难查。
    //
    // 这是这个仓库那条「测试里绝对不要无参数 `new Date()`」的漏网：
    // `Date.now()` 是同一件事的另一个拼法。
    //
    // 只 fake `Date`：整套 fake timers 会饿死 `waitFor`/`findByRole` 的轮询
    // 和 hashchange，这个仓库踩过（见 619 行上面那段注释）。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));

    currentLists = [list({ id: 'L1', name: '工作' })];
    currentTasks = [
      // 甲任务：todo + 有 due（进「接下来」）+ 带标签（进「搜索」）+ 挂着清单
      // （进「工作」清单的 scoped 回退分支）——同一条任务喂给 search/
      // upcoming/all/scoped 四个接线点。`due` 是钉死的「今天 10:00」，
      // 相对上面那个固定的「现在」（今天 9:00）永远是一小时后。
      task({
        id: 'a', title: '甲任务', tags: ['紧急'], listId: 'L1',
        due: new Date(2026, 7, 16, 10, 0, 0).toISOString(), reminders: [],
      }),
      // 乙任务：done，专门喂给「已完成」——甲任务是 todo，allSections/
      // doneSections 互斥，装不进「已完成」。
      task({ id: 'b', title: '乙任务', status: 'done', completedAt: '2026-01-01T00:00:00.000Z', due: null, reminders: [] }),
      // 丙任务：todo + **不挂清单**，专门喂给「未归类」。甲任务挂着 L1，进不了那一屏，
      // 少了这条的话 `nolist` 面板一条任务都不渲染，循环到它就红在「一条都没渲染」上。
      // （`nolist` 是这一批加进 `DENSITY_VIEWS` 的——它是 `groupable` 的去处，
      // 切成看板之后连行/卡开关都没有，见 App.tsx 那处注释里那次实测复现。）
      task({ id: 'c', title: '丙任务', listId: null, due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());

    // 先切到「全部」把密度切成「行」——density 是 App 一层唯一一份全局
    // state，不是每个视图各自的开关；点一次之后带着这份 state 挨个切视图，
    // 才验得出「这个视图的 TaskGrid 调用点真的读了它」，不是「开关存在但
    // 没接」（I2 那条另外单独测开关自己的按下态）。
    fireEvent.click(navButton(/全部/));
    await waitFor(() => expect(container.querySelector('.ink-view-panel-all')).not.toBeNull());
    clickDensity(container, '行');

    for (const key of DENSITY_VIEWS) {
      const label = findSpec(key)!.label;
      if (key === 'search') {
        // 「搜索」不在导航里，走搜索框，见 App.tsx「不在导航里显示」的注释。
        await searchFor('任务');
      } else {
        fireEvent.click(navButton(new RegExp(label)));
      }
      await screen.findByRole('heading', { level: 1, name: label });
      const panel = container.querySelector(`.ink-view-panel-${key}`) as HTMLElement;
      expect(panel, `${key} 面板没找到`).not.toBeNull();
      await waitFor(() => expect(panel.querySelector('.ink-trow, .ink-task-card'), `${key} 面板一条任务都没渲染`).not.toBeNull());
      // 变异验证锚点：那个视图调用点上的 `density={density}` 被删掉——这条
      // 断言会红（面板退回默认档，渲染出 .ink-task-card 而不是 .ink-trow）。
      expect(panel.querySelector('.ink-trow'), `${key} 面板没有 .ink-trow——这个视图的 TaskGrid 调用点可能没接 density`).not.toBeNull();
      expect(panel.querySelector('.ink-task-card'), `${key} 面板还在渲染 TaskCard`).toBeNull();
    }

    // 第 6 个接线点：清单/标签的回退分支（scoped）——不在 DENSITY_VIEWS 这张
    // 表里（它走的是 `view.startsWith('list:')`/`('tag:')` 判断，不是枚举
    // 出来的注册表 key），单独测一次，别漏掉。
    fireEvent.click(navButton(/工作/));
    await screen.findByRole('heading', { level: 1, name: '工作' });
    const scopedPanel = container.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(scopedPanel.querySelector('.ink-trow, .ink-task-card')).not.toBeNull());
    expect(scopedPanel.querySelector('.ink-trow'), 'scoped 面板没有 .ink-trow').not.toBeNull();
    expect(scopedPanel.querySelector('.ink-task-card'), 'scoped 面板还在渲染 TaskCard').toBeNull();

    // 顺带验证反方向：点「卡」，scoped 面板也能切回去——不是单向开关。
    clickDensity(container, '卡');
    expect(scopedPanel.querySelector('.ink-task-card')).not.toBeNull();
    expect(scopedPanel.querySelector('.ink-trow')).toBeNull();
  });

  /**
   * 修复轮 1 · I2：开关自己「选中了哪一档」以前没有任何测试——把两颗按钮的
   * `ink-density-btn-active` 三元都改成永远不加 class，原有 4 条测试原样
   * 全绿、退出码 0（两颗按钮长一样、都不高亮，用户看不出自己在哪一档）。
   * 照抄 App.test.tsx 日历「周/月」那对按钮的写法：两个方向都断言
   * `aria-pressed`，这里再加上高亮 class。
   */
  it('「行」/「卡」两颗按钮的按下态和高亮 class 都要两个方向各断言一次', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务' })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await waitFor(() => expect(container.querySelector('.ink-view-panel-all')).not.toBeNull());

    const rowBtn = () => within(densityGroup(container)!).getByRole('button', { name: '行' });
    const cardBtn = () => within(densityGroup(container)!).getByRole('button', { name: '卡' });

    // 默认档：「卡」按下 + 高亮，「行」没按下 + 不高亮。
    expect(cardBtn().getAttribute('aria-pressed')).toBe('true');
    expect(cardBtn().className).toContain('ink-density-btn-active');
    expect(rowBtn().getAttribute('aria-pressed')).toBe('false');
    expect(rowBtn().className).not.toContain('ink-density-btn-active');

    clickDensity(container, '行');

    // 变异验证锚点：两颗按钮的 `ink-density-btn-active` 三元都换成永远加/
    // 永远不加同一个结果——下面四条里总有一条会红（要么两颗都高亮，要么
    // 都不高亮，跟切换前状态一样）。
    expect(rowBtn().getAttribute('aria-pressed')).toBe('true');
    expect(rowBtn().className).toContain('ink-density-btn-active');
    expect(cardBtn().getAttribute('aria-pressed')).toBe('false');
    expect(cardBtn().className).not.toContain('ink-density-btn-active');
  });

  it('切换会记在 localStorage；重新挂载（模拟刷新）之后还是上次选的那档，不用再点一次', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务' })];
    const { container, unmount } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await waitFor(() => expect(container.querySelector('.ink-view-panel-all')).not.toBeNull());

    clickDensity(container, '行');
    expect(localStorage.getItem('density')).toBe('row');
    unmount();

    const { container: container2 } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    const panel2 = () => container2.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(panel2()).getByText('甲任务')).toBeDefined());

    // 查询范围限定在「全部」这个面板里——「今天」是 keepMounted 的视图，
    // 这条任务同时也会渲染在它自己那个（隐藏的）面板里，不限定范围的话
    // 会读到「今天」那份不受 density 影响的 TaskCard，跟这里要证明的事
    // （「全部」这个面板记住了上次选的档）无关。
    // 变异验证锚点：App.tsx 把初值写成 useState<Density>('card')（不读
    // getDensity()）——这次重新挂载没有再点「行」，如果初值不是从
    // localStorage 读出来的，这里只会看到 .ink-task-card。
    expect(panel2().querySelector('.ink-trow')).not.toBeNull();
    expect(panel2().querySelector('.ink-task-card')).toBeNull();
  });
});

describe('App：回顾里点已完成任务的标题，落到装得下它的去处', () => {
  it('点一条已完成任务，顶部标题变成「已完成」，那条任务在新视图里看得到——「全部」按 allSections 的定义排除了 done，装不下它', async () => {
    currentTasks = [task({ id: 't1', title: '早就弄完了', status: 'done', due: null, reminders: [] })];
    currentInsights = [{
      id: 'ins1', kind: 'note', text: '一句观察', taskIds: ['t1'],
      createdAt: '2026-08-10T00:00:00.000Z', dismissedAt: null,
    }];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/回顾/)).toBeDefined());

    fireEvent.click(navButton(/回顾/));
    // 「回顾」不是 keepMounted：切去处经 hash 往返，hashchange 在 jsdom 里
    // 排到 setTimeout(0) 才触发，不等它落地这个 <section> 压根还没挂到树上。
    await waitFor(() => expect(container.querySelector('.ink-view-panel-review')).not.toBeNull());
    const reviewPanel = within(container.querySelector('.ink-view-panel-review') as HTMLElement);
    const link = await reviewPanel.findByRole('button', { name: '早就弄完了' });
    fireEvent.click(link);

    expect(await screen.findByRole('heading', { level: 1, name: '已完成' })).toBeTruthy();
    // hash 也要跟着变——这处 onOpen 走的是 `openTask`（手写的 navigate），
    // 不是 Sidebar 的 onSelect={navigate}，独立守一遍，见 final-review.md I2。
    expect(window.location.hash).toBe('#/done');
    // **落地之后那条卡的编辑表单是打开的**：跳到一个装着两百条任务的去处、
    // 却不指出是哪一条，等于让人自己再找一遍。四个入口（回顾/习惯/专注统计/
    // 桌面通知点开）现在共用同一个 `openTask`，这一条以前只 navigate、不指人。
    //
    // **「指出来」现在的意思是「摊在右边那一栏详情面板里」**，不再是「把它的
    // 编辑表单打开」（原来那条路要 App→TaskGrid→TaskCard 三层转发 + 一次回
    // 握手，而且只有那条任务恰好渲染在当前视图里才生效，见 App.tsx openTask
    // 的注释）。面板是查看态：点了一条提醒/一条回顾，想先看清是什么，不是
    // 一上来就把它变成一张表单——「完成」「搁置」这些按钮也只有查看态才有。
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByText('早就弄完了')).toBeTruthy();
  });

  /**
   * **「看过了」发的是什么。** 仿 OmniFocus 的 Mark Reviewed。
   *
   * `ReviewView.test.tsx` 那族证明这颗按钮把 id 交了出去，`weeklyReview.test.ts`
   * 证明盖了章之后那一条不再出现——两边都不证明 `App.tsx` 那一行接对了字段。
   * 接错的表现是静默的：PATCH 发出去了、200 也回了，只是章没盖上，那颗按钮
   * 下次打开还在原地。
   */
  it('回顾里点「看过了」，发的是 reviewedAt 的章，任务本身一个字不动', async () => {
    currentTasks = [
      task({ id: 'p', title: '装修', due: null, reminders: [] }),
      task({ id: 'p-kid', parentId: 'p', status: 'later', due: null, reminders: [] }),
    ];
    currentInsights = [];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/回顾/)).toBeDefined());

    fireEvent.click(navButton(/回顾/));
    await waitFor(() => expect(container.querySelector('.ink-view-panel-review')).not.toBeNull());
    const reviewPanel = within(container.querySelector('.ink-view-panel-review') as HTMLElement);

    fireEvent.click(await reviewPanel.findByRole('button', { name: '看过了' }));

    await waitFor(() => expect(api.patchTask).toHaveBeenCalled());
    const [id, patch] = (api.patchTask as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(id).toBe('p');
    // **只有这一个键**：这颗按钮不改状态、不改标题、不动任何别的东西——
    // 「我看过了，就这样」的字面意思。
    expect(Object.keys(patch as object)).toEqual(['reviewedAt']);
    // 盖的是「现在」，不是一个空章（`{ reviewedAt: null }` 会让这一条永远
    // 留在清单上，而且同样发得出去、同样 200）。
    const at = Date.parse((patch as { reviewedAt: string }).reviewedAt);
    expect(Number.isNaN(at)).toBe(false);
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  });
});

// Task 2（通知带图标和按钮）第④点：桌面版点通知本体打开的是「那条任务」，
// 不是笼统地打开窗口——desktop/src/main.ts 的 openTask() 打开窗口之后，往
// 页面派发一个 `desktop-open-task` 自定义事件带上任务 id，这里接住它。
// main.ts 引 electron 进不了 vitest（main.test.ts 顶部注释），main.ts 那边
// 只能测「派发的事件名/detail 形状对不对」这种源文本断言；这里能测到网页
// 接到事件之后真的做了什么——是这条协议里唯一能端到端跑起来验证的一半。
describe('App：接住桌面版「desktop-open-task」事件，定位到那条具体的任务', () => {
  const dispatch = (id: string) => {
    act(() => {
      window.dispatchEvent(new CustomEvent('desktop-open-task', { detail: id }));
    });
  };

  // 修复轮 1 · m4：原来两条正向用例的夹具都只有一条任务——`setEditRequest(id)`
  // 改成 `setEditRequest(tasksRef.current[0]?.id ?? id)`（「不管派发的是哪个
  // id，反正打开第一张卡」）这种坏法照样能让原断言全绿，因为夹具里第一张
  // 就是唯一一张、也正好是被派发的那张，分不清「定位到那条」和「打开随便
  // 第一张」。两条都补成两条任务，派发**不是数组第一个**的那条 id，用标题
  // 输入框里的值反过来证明打开的确实是被点的那一条——跟 `toNotification`
  // 「body 是这一条的标题，不是写死的」用的是同一个手法（第二个不同的夹具
  // 才分得清「读了这一条」和「永远读同一条」）。
  it('未完成的任务：切到「全部」，并把它摊在右边那一栏详情面板里——跟只打开窗口不一样', async () => {
    currentTasks = [
      task({ id: 't0', title: '别的任务', status: 'todo' }),
      task({ id: 't1', title: '交房租', status: 'todo' }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' }); // 等页面起来，确认起点不是「全部」

    dispatch('t1'); // 不是数组第一个（t0）

    expect(await screen.findByRole('heading', { level: 1, name: '全部' })).toBeTruthy();
    expect(window.location.hash).toBe('#/all');
    // 不只是切了视图——右边那一栏详情面板里摊着的是**它**，不是随便哪张卡。
    // 面板取代了原来那条「打开它的编辑表单」（`editRequest` 三层转发 + 回
    // 握手，见 App.tsx openTask 的注释）：点一条提醒想先看清是什么，而
    // 「完成」「推迟」这些按钮只有查看态才有。
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByText('交房租')).toBeTruthy();
    expect(within(detail).queryByText('别的任务')).toBeNull();
  });

  it('已完成的任务：切到「已完成」——「全部」按 allSections 的定义排除了 done，装不下它', async () => {
    currentTasks = [
      task({ id: 't0', title: '别的任务', status: 'todo' }),
      task({ id: 't1', title: '早就弄完了', status: 'done' }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' });

    dispatch('t1'); // 不是数组第一个（t0）

    expect(await screen.findByRole('heading', { level: 1, name: '已完成' })).toBeTruthy();
    expect(window.location.hash).toBe('#/done');
    // 同上：不只是切了视图，面板里摊着的要是 t1，不是 t0。**面板压根不经过
    // 视图那份 sections**（按 id 从全量 tasks 现查），所以这一条对「已完成」
    // 和「全部」是同一套机制，不像原来的 autoEdit 要那条任务恰好渲染出来。
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByText('早就弄完了')).toBeTruthy();
    expect(within(detail).queryByText('别的任务')).toBeNull();
  });

  it('id 对不上任何一条任务（通知发出之后任务被删了）：不导航、不崩，弹一句提示', async () => {
    currentTasks = [task({ id: 't1', title: '交房租', status: 'todo' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' });

    dispatch('已经不存在的id');

    expect(await screen.findByText('那条任务已经不在了')).toBeTruthy();
    // 上限：没有任何导航发生——还停在「今天」，hash 没变成 #/all 或 #/done。
    expect(screen.queryByRole('heading', { level: 1, name: '今天' })).toBeTruthy();
    expect(window.location.hash).toBe('');
  });
});

describe('App：侧栏「新建清单」调 addList，颜色从调色盘按现有清单数轮着取', () => {
  it('还没有清单时，第一条用调色盘第一个颜色', async () => {
    currentLists = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/新建清单/)).toBeDefined());

    fireEvent.click(navButton(/新建清单/));
    const input = screen.getByLabelText('清单名字');
    fireEvent.change(input, { target: { value: '买菜' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(api.addList).toHaveBeenCalledWith('买菜', '#C2410C'));
  });

  it('已经有一条清单时，新的一条轮到调色盘第二个颜色——不是重复用第一个', async () => {
    currentLists = [list({ id: 'L1', name: '已有的' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/新建清单/)).toBeDefined());

    fireEvent.click(navButton(/新建清单/));
    const input = screen.getByLabelText('清单名字');
    fireEvent.change(input, { target: { value: '第二条' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(api.addList).toHaveBeenCalledWith('第二条', '#15803D'));
  });
});

describe('App：同步冲突的常驻横幅——不解决，只是让人看见', () => {
  it('有冲突副本时常驻横幅，说清是哪一类、几个', async () => {
    currentConflicts = [
      { kind: 'tasks', file: '甲 (冲突副本 2026-08-15).json' },
      { kind: 'tasks', file: '乙 (冲突副本 2026-08-15).json' },
      { kind: 'inbox', file: '丙 (冲突副本 2026-08-15).json' },
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const banner = await screen.findByRole('alert', { name: /冲突/ });
    expect(banner.textContent).toContain('3');       // 总数
    expect(banner.textContent).toContain('任务');     // kind 说人话
    expect(banner.textContent).toContain('收件箱');
    // 上面三条 toContain 挡不住去重被拿掉：夹具里 tasks 出现两次，「任务、
    // 任务、收件箱」一样能让三条 toContain 通过——甚至连 `banner.textContent`
    // 里找 '任务、收件箱' 这个子串都挡不住：「任务、任务、收件箱」本身就以
    // '任务、收件箱' 结尾，toContain 一样会绿（真的试过，这个坑比想的更深）。
    // 这里改成整串相等：直接取 <span> 的第一个子节点——JSX 里
    // `{expr}` 后面紧跟一段字面量文本，两者在真实 DOM 里是两个独立的文本
    // 节点，不会被拼到一起，取第一个就精确对应 join(...) 的结果，不受它
    // 后面那段说明文字干扰。变异验证：把 App.tsx 里 `[...new Set(...)]`
    // 去掉，这一条会红（值变成「任务、任务、收件箱」）。
    const span = banner.querySelector('span');
    expect(span?.childNodes[0]?.textContent).toBe('任务、收件箱');
  });

  it('总数跟着夹具变——两个冲突文件时显示 2，不是写死的 3', async () => {
    // 上面那条测试的夹具恰好是 3 个，`conflicts.length` 被写死成字面量 `3`
    // 也一样能让「总数」那条 toContain('3') 通过——这个仓库已经在「夹具恰好
    // 等于写死的值」上栽过三次。换一个不是 3 的数量，才挡得住这种写死。
    currentConflicts = [
      { kind: 'tasks', file: '甲 (冲突副本 2026-08-15).json' },
      { kind: 'inbox', file: '丙 (冲突副本 2026-08-15).json' },
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const banner = await screen.findByRole('alert', { name: /冲突/ });
    expect(banner.textContent).toContain('2');
    expect(banner.textContent).not.toContain('3');
  });

  it('没有冲突时整条横幅不渲染——不是渲染一个空的', async () => {
    currentConflicts = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' });   // 等页面起来
    expect(screen.queryByRole('alert', { name: /冲突/ })).toBeNull();
  });

  it('data-changed 之后会重新拉一次——同步客户端随时可能放进新的冲突副本', async () => {
    currentConflicts = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined());
    expect(screen.queryByRole('alert', { name: /冲突/ })).toBeNull();

    currentConflicts = [{ kind: 'tasks', file: '甲 (冲突副本 2026-08-15).json' }];
    act(() => handlers.onChange!('tasks'));
    expect(await screen.findByRole('alert', { name: /冲突/ })).toBeTruthy();
  });
});

describe('App：全局快捷键——N / / / 1..9 / Esc（task-2-brief）', () => {
  it('按 1..9 切到导航上第 1..9 个去处，而且地址栏跟着变', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // 挑首尾两个数字键，不只挑中间的——挡住「顺序整体错位一格」这种
    // 只测中间某一位置测不出来的坏实现。
    fireEvent.keyDown(window, { key: '1' });
    await screen.findByRole('heading', { level: 1, name: '收件箱' });
    expect(window.location.hash).toBe('#/inbox');

    // 第 9 个：注册表里第 9 条。**「未归类」插进来之后这里往后挪了一位**
    // （原来第 9 是四象限）——它是 `listId` 为 null 的那些，摆在「全部」后面，
    // 见 lib/views.tsx 那条 spec。这条测的是「数字键跟着屏幕上的顺序走」，
    // 不是钉死在某个视图上——下一条测试才是顺序本身的真相来源（从 DOM 读）。
    fireEvent.keyDown(window, { key: '9' });
    await screen.findByRole('heading', { level: 1, name: '日历' });
    expect(window.location.hash).toBe('#/calendar');
  });

  // 核心断言：见 task-2-brief 第 ① 条。从 DOM 里读导航按钮实际显示的文字，
  // 跟按 1..9 各自切到的视图标题对照——顺序的唯一真相来源是 Sidebar 真正
  // 渲染出来的那份 DOM，不是又找一份 App.tsx 自己算出来的列表跟它比。
  it('快捷键的顺序跟导航上显示的顺序完全一致', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // **导航跨着两个 UI 区域**：清单侧栏那一段（任务）+ 最左那条竖图标栏
    // （换种看法 / 模块，见 lib/views.tsx 的 RAIL_GROUPS）。数字键数的是
    // 「导航上第几个」这一整份顺序，所以两边都得摊进来——只取侧栏的话只有
    // 七项，第 8、9 位（日历、看板）在竖栏上。
    //
    // 侧栏用 .ink-nav-label（不是整颗 <button>）：按钮里可能跟着一个计数徽标
    // （比如「收件箱」旁边的未拆解数），会拼进 textContent 变成「收件箱7」。
    // 竖栏那几颗只有记号、没有文字，名字在 aria-label 上。
    const labels = [
      ...Array.from(container.querySelectorAll('.ink-nav-views .ink-nav-label')).map((el) => el.textContent),
      // **`.slice(1)` 掐掉第一颗**：竖栏上第一颗是「任务」那个模块
      // （lib/views.tsx 的 TASKS_MODULE_KEY）——它对应的是一整段、不是某一条
      // 去处，数字键不数它。
      ...Array.from(container.querySelectorAll('.ink-modrail-list .ink-modrail-btn')).slice(1).map((el) => el.getAttribute('aria-label')),
    ];
    expect(labels.length).toBeGreaterThanOrEqual(9);

    // 顶部标题用 .ink-view-title 直接取，不用 getByRole('heading', {level:2})——
    // 「今天」这个去处自己还带一个屏幕阅读器专用的 <h2 class="ink-sr-only">
    // （见 TodayView），同一时刻树里会有两个 level-2 heading，不限定 name
    // 的角色查询在切到「今天」那一位会直接因为「找到不止一个」报错。
    for (let i = 0; i < 9; i++) {
      fireEvent.keyDown(window, { key: String(i + 1) });
      await waitFor(() => expect(container.querySelector('.ink-view-title')?.textContent).toBe(labels[i]));
    }
  });

  /**
   * `C` = 「新任务」表单。建任务的两条路原来只有随手记那条有键——而 `N`
   * 通向的是「丢进收件箱等 AI 拆」（默认 60 秒），「已经知道自己要做什么」
   * 该走的那条一直只能用鼠标点视图标题栏那颗按钮。
   */
  it('按 C 展开「新任务」表单', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByPlaceholderText('标题')).toBeNull();

    fireEvent.keyDown(window, { key: 'c' });

    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();
  });

  it('**C 不 preventDefault**——跟 N/「/」不一样：这一下没把焦点换到任何已经存在的输入框上，表单是下一帧才挂出来的，那个 c 落不进去', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(fireEvent.keyDown(window, { key: 'c' })).toBe(true);
  });

  it('按 N 聚焦到随手记输入框，且不会在框里留下一个字面的 n', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // final-review.md C1：真 Chrome 里实测过，少这行 preventDefault 的话，
    // keydown 的默认动作会打在 focusQuickCapture() 刚换过去的新焦点上——
    // 按下的 n 被浏览器原样打进随手记框，回车就把一个脏字符提交进
    // data/inbox/。跟 '/' 那条同一个写法：defaultPrevented 比 value 更
    // 直接地钉住「有没有 preventDefault」这件事本身，不依赖 jsdom 会不会
    // 真的模拟打字插入字符（它不会）。
    const notCancelled = fireEvent.keyDown(window, { key: 'n' });
    expect(notCancelled).toBe(false);

    const composerTextarea = document.querySelector('.ink-nav-composer textarea') as HTMLTextAreaElement;
    expect(composerTextarea).not.toBeNull();
    expect(document.activeElement).toBe(composerTextarea);
    expect(composerTextarea.value).toBe('');
  });

  it('按 / 聚焦到搜索框，而且搜索框里没有多出一个斜杠', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // dispatchEvent 对可取消事件返回 false，当且仅当某个监听器调用了
    // preventDefault——比检查 searchInput.value 更直接地钉住「有没有
    // preventDefault」这件事本身，不依赖 jsdom 会不会真的模拟打字插入
    // 字符（它不会，keydown 在 jsdom 里本来就不会自动改 value）。
    const notCancelled = fireEvent.keyDown(window, { key: '/' });
    expect(notCancelled).toBe(false);

    const searchInput = (await screen.findByLabelText('搜索任务')) as HTMLInputElement;
    expect(document.activeElement).toBe(searchInput);
    expect(searchInput.value).toBe('');
  });

  it('在任务标题输入框里按 1，视图不变', async () => {   // 上限方向
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    await openTaskForm();
    const titleInput = await screen.findByPlaceholderText('标题');
    fireEvent.keyDown(titleInput, { key: '1' });

    expect(document.querySelector('.ink-view-title')?.textContent).toBe('今天');
    expect(window.location.hash).toBe('');
  });

  it('在备注里按 n，焦点不动', async () => {   // 上限方向
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    await openTaskForm();
    const notesInput = await screen.findByPlaceholderText(/^备注/);
    (notesInput as HTMLElement).focus();
    fireEvent.keyDown(notesInput, { key: 'n' });

    expect(document.activeElement).toBe(notesInput);
  });

  it('组字中按 1，视图不变', async () => {   // 上限方向
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: '1', isComposing: true });

    expect(document.querySelector('.ink-view-title')?.textContent).toBe('今天');
    expect(window.location.hash).toBe('');
  });

  // final-review.md「中文输入法那两道守卫」：isComposing 在组字第一个键上
  // 是 false（compositionstart 在它之后才派发），inField 结构性地堵住第一
  // 个键，但这条不测那一刻——测的是 compositionstart 之后的第二个键起，
  // 一个不依赖 inField 的独立守卫是不是真的在拦。组字结束之后必须恢复
  // 正常，不能变成永久失效的死键。
  it('compositionstart 之后（组字中）第二个键起被拦住，compositionend 之后恢复', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    window.location.hash = '';

    fireEvent.compositionStart(window);
    fireEvent.keyDown(window, { key: '1' });
    expect(document.querySelector('.ink-view-title')?.textContent).toBe('今天');
    expect(window.location.hash).toBe('');

    fireEvent.compositionEnd(window);
    fireEvent.keyDown(window, { key: '1' });
    await screen.findByRole('heading', { level: 1, name: '收件箱' });
    expect(window.location.hash).toBe('#/inbox');
  });

  it('**Esc 关掉搜索弹层**——不再是「清空搜索框并退回上一个视图」那一套', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const box = await openSearch();
    fireEvent.change(box, { target: { value: '交房租' } });

    // 弹层的 Esc 由 antd 的 Modal 自己接（跟命令面板同一个处理）。
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('搜索任务')).toBeNull());

    // **人还在原来那个去处**：打了字没回车就等于没搜，不该把人挪走。原来那
    // 一版是「打字就自动切到搜索结果」，Esc 于是得负责把人送回去；现在切去处
    // 是一次明确的动作（回车 / 「看全部结果」），Esc 只管关窗。
    expect(window.location.hash).toBe('');
  });

  it('卸载之后监听被摘掉（不泄漏）', async () => {
    const { unmount } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    window.location.hash = '';

    unmount();
    fireEvent.keyDown(window, { key: '9' });   // 卸载前会切到「已完成」

    // 组件已经卸载，全局监听该已经被摘掉——这个按键不该再改 hash。
    expect(window.location.hash).toBe('');
  });
});

// task-4-brief：命令面板接进 App。CommandPalette 组件自己的行为
// （过滤/箭头键/Enter/Esc）已经在 CommandPalette.test.tsx 守住了——这里只守
// App 这一层的接线：open/commands/onClose 三个 prop 是不是真的传对了。
// 命令面板打开靠 `screen.getByRole('listbox', { name: '命令列表' })` 之后
// 用 within() 限定查询范围——不加范围的 getByText 在 Sidebar 导航里也能
// 找到同名文字（比如「已完成」既是导航按钮的 label，也是命令面板里的一条
// 命令），会报「找到不止一个」。
/**
 * 最左那条竖图标栏（`Rail.tsx`）。侧栏回答「看哪一批任务」，这条栏回答「用哪个
 * 模块」——习惯/专注统计/纪念日/回顾跟侧栏上那列清单、标签一点关系都没有。判据
 * （哪几项归这儿）在 `lib/views.tsx` 的 `RAIL_GROUPS`。
 *
 * **原来这四项横着排在顶栏上**，这一批搬到了最左那条竖栏。测试跟着改的只有
 * 「名字从哪儿读」：竖栏上的按钮只有记号、没有文字，名字在 `aria-label` 上。
 */
describe('App：最左那条竖图标栏', () => {
  const modules = () => screen.getByRole('navigation', { name: '模块' });

  it('「任务」那一颗排第一，后面两段六项，一项都不在侧栏', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // 只有记号、没有文字，所以读 aria-label。**「设置」不在这个地标里**
    // （Rail.tsx 特意把它放在 nav 外面：它开的是抽屉，不是一个去处），
    // 所以这里数出来正好是四项，不用另外滤掉它。
    const inBar = within(modules()).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    // 「任务」排第一（它对应一整段，不是某一条去处），然后是两段：日历/看板/
    // 四象限 + 习惯/专注统计/纪念日/回顾。判据在 lib/views.tsx 的 RAIL_GROUPS。
    expect(inBar).toEqual(['任务', '日历', '四象限', '习惯', '专注统计', '纪念日', '回顾']);

    const sidebar = within(screen.getByRole('navigation', { name: '视图' }));
    for (const label of ['日历', '四象限', '习惯', '专注统计', '纪念日', '回顾']) {
      expect(sidebar.queryByRole('button', { name: new RegExp(`^${label}`) }), label).toBeNull();
    }
  });

  it('**切到「习惯」这类模块，整条清单侧栏不渲染**——站在习惯上看着一列「今天/全部/工作」，那一栏什么也解释不了', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(container.querySelector('.ink-rail-col'), '「今天」上侧栏该在').not.toBeNull();

    fireEvent.click(within(modules()).getByRole('button', { name: '习惯' }));
    await screen.findByRole('heading', { level: 1, name: '习惯' });
    await waitFor(() => expect(container.querySelector('.ink-rail-col')).toBeNull());
  });

  it('**日历/四象限一样没有侧栏**——它们在滴答那边就列在「功能模块」里，是一个个独立的界面', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(within(modules()).getByRole('button', { name: '四象限' }));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    await waitFor(() => expect(container.querySelector('.ink-rail-col')).toBeNull());
  });

  it('**「任务」那一颗把侧栏带回来，而且回到你上次待的那个去处**——不是每次都固定跳「今天」', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());

    // 先在「全部」上待着
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });

    // 去日历上瞄一眼——侧栏没了
    fireEvent.click(within(modules()).getByRole('button', { name: '日历' }));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    await waitFor(() => expect(container.querySelector('.ink-rail-col')).toBeNull());

    // 点回「任务」：侧栏回来，而且落回「全部」不是「今天」
    fireEvent.click(within(modules()).getByRole('button', { name: '任务' }));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    expect(container.querySelector('.ink-rail-col')).not.toBeNull();
  });

  it('**站在「全部」上时「任务」那一颗照样是当前**——它对应的是一整段，不是某一条去处', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });

    expect(within(modules()).getByRole('button', { name: '任务' }).getAttribute('aria-current')).toBe('page');

    // 切到日历就不该再是它了
    fireEvent.click(within(modules()).getByRole('button', { name: '日历' }));
    await screen.findByRole('heading', { level: 1, name: '日历' });
    expect(within(modules()).getByRole('button', { name: '任务' }).getAttribute('aria-current')).toBeNull();
    expect(within(modules()).getByRole('button', { name: '日历' }).getAttribute('aria-current')).toBe('page');
  });

  it('**在没有侧栏的模块上按 N，先切回「今天」再把光标送进随手记**——不然那是一个按了完全没反应的键，而「随手记的成本不能变高」是硬约束', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(within(modules()).getByRole('button', { name: '习惯' }));
    await screen.findByRole('heading', { level: 1, name: '习惯' });
    expect(document.querySelector('.ink-nav-composer textarea')).toBeNull();

    fireEvent.keyDown(window, { key: 'n' });

    await screen.findByRole('heading', { level: 1, name: '今天' });
    await waitFor(() => {
      const box = document.querySelector('.ink-nav-composer textarea');
      expect(box).not.toBeNull();
      expect(document.activeElement).toBe(box);
    });
  });

  it('**在任何模块上按 `/` 都开得出搜索**——它现在是个弹层，不再是侧栏顶上那个框（那个框在模块视图里根本不渲染）', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(within(modules()).getByRole('button', { name: '习惯' }));
    await screen.findByRole('heading', { level: 1, name: '习惯' });

    fireEvent.keyDown(window, { key: '/' });

    const box = await screen.findByLabelText('搜索任务');
    await waitFor(() => expect(document.activeElement).toBe(box));
    // **人没有被挪走**：原来那一版为了让侧栏那个框出现，会先把人切回任务模块。
    expect(screen.getByRole('heading', { level: 1, name: '习惯' })).toBeTruthy();
  });

  it('点了真的切过去，地址栏也跟着变', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(within(modules()).getByRole('button', { name: /^习惯/ }));

    await screen.findByRole('heading', { level: 1, name: '习惯' });
    expect(window.location.hash).toBe('#/habits');
  });

  it('当前那一项标了 aria-current——只有记号的按钮全靠它才说得出「在哪儿」', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(within(modules()).getByRole('button', { name: /^纪念日/ }));

    await waitFor(() => expect(
      within(modules()).getByRole('button', { name: /^纪念日/ }).getAttribute('aria-current'),
    ).toBe('page'));
    expect(within(modules()).getByRole('button', { name: /^习惯/ }).getAttribute('aria-current')).toBeNull();
  });
});

describe('App：命令面板接进 App（task-4-brief）', () => {
  // 守 `open` prop：面板打开前输入框不在树里，Ctrl+K 之后才出现——不是
  // 「本来就渲染着，只是 CSS 藏起来」。两次各自独立 render/unmount，不依赖
  // onClose 能不能把面板关掉（那是下面另一条测试要守的东西，这里不能对它
  // 有隐性依赖，否则 onClose 坏了这条也会跟着红，就不是「各自恰好一条」了）。
  // final-review.md I4：没能实测（CDP 注入的按键绕过浏览器快捷键层），是
  // 读代码 + 已知浏览器键位（Ctrl+K 跳地址栏、Firefox Ctrl+Shift+K 开控制台）
  // 推出来的，照做。跟 '/' 那条同一个写法：defaultPrevented 直接钉住「有没有
  // preventDefault」这件事本身。
  it('Ctrl+K 会 preventDefault——不拦的话浏览器自己的地址栏快捷键会抢走它', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    const notCancelled = fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(notCancelled).toBe(false);
  });

  // final-review.md I5：面板开着、焦点在面板输入框里时 1..9 被 inField 挡住
  // （已经实测过），但焦点一旦离开输入框（`.ant-modal` 带 tabindex="-1"，
  // 点面板空白处焦点就会落上去）就没人管了——1 会在背后切视图，N 会把焦点
  // 拽到遮罩底下看不见的随手记框。这里用 blur() 模拟「焦点离开面板输入框」，
  // 断言全局快捷键在面板开着的整段时间里都不生效，不只是输入框聚焦那一刻。
  it('面板开着时，即使焦点跑出输入框，全局快捷键也不再生效', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    window.location.hash = '';

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: '1' });
    expect(window.location.hash).toBe('');

    fireEvent.keyDown(window, { key: 'n' });
    const composerTextarea = document.querySelector('.ink-nav-composer textarea');
    expect(document.activeElement).not.toBe(composerTextarea);

    // 面板本身还开着——不是被这两次按键误关掉了。`<input>` 即使面板关着也
    // 留在 DOM 里（antd Modal destroyOnHidden 默认 false，见下面「跑一条
    // 视图切换命令」那条测试的注释），查它存不存在测不出「开没开」，要查
    // `.ant-modal-wrap` 有没有被 rc-dialog 加上 display:none。
    const wrap = document.querySelector<HTMLElement>('.ant-modal-wrap');
    expect(wrap?.style.display).not.toBe('none');
  });

  it('Ctrl+K 打开面板，Cmd+K 也打开', async () => {
    const first = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByPlaceholderText('输入命令…')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();
    first.unmount();

    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByPlaceholderText('输入命令…')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();
  });

  // 守 `commands` prop（清单这一半）：两条清单，点名字带「生活」的那条，
  // 断言切到的是 l2 不是 l1——用两条不用一条，是为了挡住「run 被错接到
  // 另一个同类型的清单」这种总账第九节点名的换位错误，一条清单测不出来
  // （随便接哪个 run 结果看起来都「对」）。
  it('面板里能切到某个清单——数字键做不到的事', async () => {
    currentLists = [list({ id: 'l1', name: '工作' }), list({ id: 'l2', name: '生活' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '生活' } });
    const listbox = screen.getByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText('清单「生活」'));

    await waitFor(() => expect(window.location.hash).toBe('#/list:l2'));
  });

  // 同上，标签那一半——两个标签，同一个换位理由。故意点「紧急」不点
  // 「个人」：allTags() 按 .sort() 排序，'个人' 排在 '紧急' 前面（是数组第
  // 0 项）——如果点第 0 项那条，「run 被错接到 allTags(tasks)[0]」这种
  // 换位 bug 会巧合地算出同一个结果，测不出来（踩过一次，见 task-4-report）。
  // 点排第二的「紧急」，换位 bug 会导致落到「个人」而不是「紧急」，断言才
  // 真的能分辨。
  it('面板里能切到某个标签', async () => {
    currentTasks = [
      task({ id: 'a', tags: ['紧急'] }),
      task({ id: 'b', tags: ['个人'] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '紧急' } });
    const listbox = screen.getByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText('标签「紧急」'));

    await waitFor(() => expect(window.location.hash).toBe(`#/tag:${encodeURIComponent('紧急')}`));
  });

  // 守 `onClose` prop：CommandPalette 的 runAt() 不管 onClose 对不对都会调用
  // cmd.run()（见 CommandPalette.tsx），所以「地址栏跟着变」这半句不受
  // onClose 是否接对影响——真正只有 onClose 才能决定的是「面板关没关」，
  // 这条断言必须留在这里，不能只测地址栏。
  //
  // 「关掉」不能用 `queryByPlaceholderText(...).toBeNull()` 判——antd Modal
  // 默认 `destroyOnHidden` 是 false，`open` 变 false 之后 `<input>` 还留在
  // DOM 里（CommandPalette.tsx 顶部注释、task-3-report 都提过这件事），
  // 只是外层 `.ant-modal-wrap` 被 rc-dialog 的 Dialog（node_modules/
  // @rc-component/dialog/es/Dialog/index.js:137）加了 `display:none`。
  // 断言这一层的行内样式，不是「元素消失」。
  it('跑一条视图切换命令之后面板关掉，地址栏跟着变', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '已完成' } });
    const listbox = screen.getByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText(/已完成/));

    await waitFor(() => expect(window.location.hash).toBe('#/done'));
    await waitFor(() => {
      const wrap = document.querySelector<HTMLElement>('.ant-modal-wrap');
      expect(wrap?.style.display).toBe('none');
    });
  });

  it('在输入框里按 Ctrl+K 照样打开', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    await openTaskForm();
    const titleInput = await screen.findByPlaceholderText('标题');
    fireEvent.keyDown(titleInput, { key: 'k', ctrlKey: true });

    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();
  });

  // 上限：默认夹具没有清单（currentLists 是 []）——命令面板不该崩，也不该
  // 出现任何「清单「xxx」」字样的命令。固定视图命令照常在（面板本身还能用）。
  it('没有清单时面板里不出现清单那一段，也不崩', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText('输入命令…');
    const listbox = screen.getByRole('listbox', { name: '命令列表' });

    expect(within(listbox).queryByText(/^清单「/)).toBeNull();
    expect(within(listbox).getByText('收件箱')).toBeTruthy();
  });

  // final-review.md I3：命令表里唯一一条不是「切视图」的命令，也是
  // focusQuickCapture 的第二个调用点——`focusQuickCapture` 上面那段「提成函数不内联」的
  // 论证靠的就是这条命令跟 N 走同一个函数，这条命令整个被删掉的话，那段
  // 论证落空但没有任何东西会红，见 I3。
  it('面板里也有一条「新任务」——两条建任务的路，原来只有随手记那条进了面板', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '新任务' } });
    const listbox = screen.getByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText('新任务'));

    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();
  });

  it('面板里的「随手记」命令聚焦到随手记输入框', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '随手记' } });
    const listbox = screen.getByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText('随手记'));

    const composerTextarea = document.querySelector('.ink-nav-composer textarea');
    await waitFor(() => expect(document.activeElement).toBe(composerTextarea));
  });

  // final-review.md I1：App.tsx 顶部注释自称数字 hint 是「快捷键唯一的可
  // 发现入口」，这条之前两层都零覆盖——这里守的是 App 这一层算出来的 hint
  // 是不是真的接进了面板：从 DOM 读回 .ink-cmd-key 的文字，跟导航上显示的
  // 顺序逐行对照，不是又拿一份 App.tsx 自己算出来的列表跟自己比。回顾/
  // 垃圾箱数字键够不到，面板里也不该有 hint；随手记的 hint 固定是 'N'。
  it('面板里的数字 hint 徽章跟导航顺序逐行对应；第 10 项往后没有 hint，随手记是 N', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    // **两条栏一起摊平**：侧栏那两段（任务 / 换种看法，各一个 `.ink-nav-views`
    // <ul>）加最左那条竖图标栏（习惯/专注统计/纪念日/回顾）。命令面板列的是同
    // 一份 navDefs，顺序也是同一个——它跨着两个 UI 区域，所以这里也得跨着数。
    //
    // 竖栏那几颗按钮**只有记号、没有文字**，名字在 `aria-label` 上（Rail.tsx）
    // ——所以这一半读的是 aria-label，不是 textContent。原来它们是顶栏上带文字
    // 的按钮，读的是 `firstChild.textContent`。
    const labels = [
      ...Array.from(container.querySelectorAll('.ink-nav-views .ink-nav-label')).map((el) => el.textContent),
      // **`.slice(1)` 掐掉第一颗**：竖栏上第一颗是「任务」那个模块
      // （lib/views.tsx 的 TASKS_MODULE_KEY），它对应的是一整段、不是某一条
      // 去处，命令面板里没有它，数字键也不数它。
      ...Array.from(container.querySelectorAll('.ink-modrail-list .ink-modrail-btn')).slice(1).map((el) => el.getAttribute('aria-label')),
    ];
    // 14 = 注册表里 14 条去处（**加了「未归类」之后从 13 变 14**，见
    // lib/views.tsx 那条 spec）：9 个带 hint 的 + 后面 5 个没有。
    expect(labels.length).toBe(14);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const listbox = await screen.findByRole('listbox', { name: '命令列表' });
    const items = within(listbox).getAllByRole('option');
    // 18 = 14 个视图命令（**加了「未归类」之后从 13 变 14**）+ 随手记 + 新任务
    // + 快捷键 + 「把 N 条过期的改到今天」。默认夹具那条任务带着一个
    // 2026-08-01、没盖章的提醒，按 `isTaskOverdue` 就是过期的，所以那一条命令
    // 真的该出现。
    expect(items.length).toBe(18);

    for (let i = 0; i < 9; i++) {
      expect(items[i].textContent).toContain(labels[i]);
      expect(items[i].querySelector('.ink-cmd-key')?.textContent).toBe(String(i + 1));
    }
    // 第 10 项往后：数字键够不到，面板里也不该有 hint。（**「看板」删掉之后
    // 这里从 5 项变 4 项**：习惯/专注统计/纪念日/回顾——四象限往前挪进了前九个。
    // 数字键的契约一直是「导航上第 N 个」，它跟着屏幕上的顺序走，不是钉死在
    // 某几项上。）
    // 第 10 项往后到第 14 项（**加了「未归类」之后从 4 项变 5 项**）：
    // 日历/习惯/专注统计/纪念日/回顾——数字键够不到，面板里也不该有 hint。
    for (let i = 9; i < labels.length; i++) {
      expect(items[i].textContent).toContain(labels[i]);
      expect(items[i].querySelector('.ink-cmd-key')).toBeNull();
    }
    // 视图命令之后那三条固定项，下标跟着 labels 的长度走，不写死数字——
    // 再往注册表里加一个去处时，这里不该又红一次。
    const after = labels.length;
    // 随手记：不是数字键，hint 固定是 'N'。
    expect(items[after].textContent).toContain('随手记');
    expect(items[after].querySelector('.ink-cmd-key')?.textContent).toBe('N');
    // 新任务：建任务的另一条路，hint 是 'C'——原来它既没有键、也不在面板里。
    expect(items[after + 1].textContent).toContain('新任务');
    expect(items[after + 1].querySelector('.ink-cmd-key')?.textContent).toBe('C');
    // 快捷键一览：`?` 本身要先知道才按得出来，所以两条路都通（`?` 和这里）。
    expect(items[after + 2].textContent).toContain('快捷键');
    expect(items[after + 2].querySelector('.ink-cmd-key')?.textContent).toBe('?');
  });
});

// task-4-brief：批量操作接到 App——E 编辑、Del 批量删除、切视图/Esc 清空
// 选中、命令面板里的批量命令。选中态本身（Ctrl/Shift 点、勾选框出现条件、
// 渲染顺序）已经在 TaskGrid.test.tsx/TaskCard.test.tsx 用真实的多分组渲染
// 守住了，这里只守 App 这一层的接线：键盘动作有没有接对、确认框文案、
// 切视图/Esc 有没有真的清空、api.patchTasks/deleteTasks 走的是一次请求
// 不是对每个选中的 id 各发一条。
describe('App：批量操作接线——E / Del / 切视图清空 / Esc 清空 / 命令面板（task-4-brief）', () => {
  // `vi.mock('./api.js', ...)` 工厂里的 vi.fn() 是模块级的、整份文件共用
  // 一份——文件顶部 afterEach 的 `vi.restoreAllMocks()` 对它们不生效
  // （那个方法只清 `vi.spyOn` 出来的 spy，不清 `vi.mock` 工厂里手写的
  // `vi.fn()`，这是 vitest 的既有行为，不是这次改动引入的坑）。这批
  // 断言要看「有没有被调用」而不是「被什么参数调用过」（后者不受历史
  // 调用次数影响，前面的测试可以随便调），所以在每条用例开始前手动清一次
  // 调用记录，不依赖执行顺序。
  beforeEach(() => {
    vi.mocked(api.deleteTasks).mockClear();
    vi.mocked(api.deleteTask).mockClear();
    vi.mocked(api.patchTasks).mockClear();
    vi.mocked(api.patchTasksEach).mockClear();
    vi.mocked(api.patchTask).mockClear();
  });

  // 「今天」也是 keepMounted 的视图（切走只是 hidden，不卸载，见
  // lib/views.tsx keepMounted 的注释），默认夹具的任务挂着 reminders，
  // 可能同时落在「今天」和「全部」两边——不把查询范围锁在 .ink-view-panel-all
  // 里的话，getByText 会在两棵子树里各找到一份同名标题，报「找到不止一个」
  // （final-review.md 那几处 .ink-view-panel-xxx scoping 是同一条教训）。
  const panel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;
  /** 按标题文字找到那张卡可点击的外层（TaskCard 渲染的 .ink-swipe）——
   *  跟 TaskGrid.test.tsx 的 cardFor 同一个写法，多了查询范围限定。 */
  const cardFor = (title: string) => within(panel()).getByText(title).closest('.ink-swipe') as HTMLElement;

  /** 「批量操作条」出没：count===0 时组件自己不渲染（role="toolbar" 整个
   *  找不到），这比按文字找「已选中 N 条」更不依赖具体措辞。 */
  const batchBar = () => screen.queryByRole('toolbar', { name: '批量操作' });

  async function renderOnAll(rows?: Task[]) {
    currentTasks = rows ?? [
      task({ id: 'a', title: '任务甲' }),
      task({ id: 'b', title: '任务乙' }),
      task({ id: 'c', title: '任务丙' }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
  }

  it('选中恰好一张按 E：进入它的编辑态', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'e' });

    // 编辑态是 TaskFields 的表单，标题输入框的 placeholder 固定是「标题」。
    expect(await screen.findByPlaceholderText('标题')).toBeTruthy();
  });

  it('**选中两张按 E：说一句，不是一声不吭**——他刚选了三条、按了 E，屏幕上没动静，分不清是「键不管用」还是「没有批量编辑」', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
    await waitFor(() => expect(panel().querySelectorAll('.ink-task-card-selected').length).toBe(2));

    fireEvent.keyDown(window, { key: 'e' });

    expect(await screen.findByText('选中了 2 条，「编辑」一次只能改一条')).toBeTruthy();
  });

  it('选中两张按 E：什么都不做——上限', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
    // 上限断言在「选中压根没发生」时也会天然成立（E 对 0 张卡也是什么都不
    // 做）——这条防的正是那种假绿，先证明真的选中了两张，这条断言不是
    // 因为选中态从没接上才通过的。
    // 范围锁在 .ink-view-panel-all 里，跟上面 `cardFor` 同一条：「今天」也是
    // keepMounted 的视图，这几条夹具任务同时落在两边，而选中态是全局一份——
    // 两棵子树里各有两张带 .ink-task-card-selected 的卡，不锁范围会数出 4。
    await waitFor(() => expect(panel().querySelectorAll('.ink-task-card-selected').length).toBe(2));

    fireEvent.keyDown(window, { key: 'e' });

    expect(screen.queryByPlaceholderText('标题')).toBeNull();
  });

  // 「完成」和「改期」这几个键。补的是键盘上一个说不通的空缺：编辑（E）和
  // 删除（Delete）都有，唯独这个应用里最高频的那一步要用鼠标点。判据在
  // `lib/keymap.test.ts`，这里测的是接线：作用在选中的那几条上、走的是
  // 批量操作条那两个同一份处理。
  it('按 D 把选中的几条标成已完成——一份 patch 套所有选中的', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'd' });
    await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a', 'b'], { status: 'done' }));
  });

  /**
   * 批量标完成也给一次撤销。单条勾完有（`patchOne`），而 `D` 一下可以把
   * 二十条标成完成、却一点退路都没有——风险大的那一边反而没有兵器。
   */
  it('批量标完成之后弹一条带「撤销」的提示，数字是真的改了几条', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'd' });

    await waitFor(() => expect(document.querySelector('.ink-undo')).not.toBeNull());
    expect(document.querySelector('.ink-undo')?.textContent).toContain('2 条标成了已完成');
  });

  it('**点撤销逐条改回各自原来那个状态**，不是一律 todo——所以走的是逐条不同的那条批量接口', async () => {
    await renderOnAll([
      task({ id: 'a', title: '任务甲', status: 'todo' }),
      task({ id: 'b', title: '任务乙', status: 'doing' }),
    ]);
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'd' });
    await waitFor(() => expect(document.querySelector('.ink-undo')).not.toBeNull());

    fireEvent.click(document.querySelector('.ink-undo button') as HTMLElement);

    await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalledWith([
      { id: 'a', patch: { status: 'todo' } },
      { id: 'b', patch: { status: 'doing' } },
    ]));
  });

  it('**只认「完成」**——批量搁置/放弃是从下拉里挑出来的，是想过才点的，跟单条那条规矩一致', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    // 「搁置」在「改状态」那个 Dropdown 里，弹层挂在 body 上、不在 .ink-batch-bar 内。
    fireEvent.click(within(document.querySelector('.ink-batch-bar') as HTMLElement).getByText('改状态'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '搁置' }));
    await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a'], { status: 'later' }));
    expect(document.querySelector('.ink-undo')).toBeNull();
  });

  it('按 T 改到今天——**逐条不同**的写，每条保留自己原来的钟点', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 't' });

    await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalled());
    const patches = (api.patchTasksEach as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect((patches as Array<{ id: string }>).map((p) => p.id)).toEqual(['a']);
  });

  /**
   * **不切视图，直接在首屏上用键盘批量。** 这一组别的测试都经 `renderOnAll()`
   * 先点一下导航——那一下让 `view` 变了、全局按键的 effect 重跑、闭包换新。
   * 不点的话，首屏那次订阅捕获的 `tasks` 是 `[]`，`reload()` 填满之后 effect 不
   * 重跑（原来依赖只有 `[view, paletteOpen]`），监听器手里的 `batchReschedule`
   * 永远看见空数组：Ctrl+点一张卡按 T，`tasks.find` 是 undefined，零请求、零
   * 提示。修法是把处理函数放进每次渲染都更新的 ref（App.tsx 那段注释）。
   */
  it('首屏不切视图：Ctrl+点一张卡按 T，照样发出改期——监听器不能拿着首屏的空任务表', async () => {
    currentTasks = [task({ id: 'a', title: '任务甲', due: new Date().toISOString() })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const today = await waitFor(() => document.querySelector('.ink-view-panel-today') as HTMLElement);
    const card = await waitFor(() => within(today).getByText('任务甲').closest('.ink-swipe') as HTMLElement);
    fireEvent.click(card, { ctrlKey: true });

    fireEvent.keyDown(window, { key: 't' });

    await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalled());
    const patches = (api.patchTasksEach as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect((patches as Array<{ id: string }>).map((p) => p.id)).toEqual(['a']);
  });

  it('一条都没选中时按 D 什么都不做——不发一个改零条的写', async () => {
    await renderOnAll();
    fireEvent.keyDown(window, { key: 'd' });
    expect(api.patchTasks).not.toHaveBeenCalled();
  });

  it('按 Del 弹确认，文案里有数量，也说清进垃圾箱可还原', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'Delete' });

    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('2');
    expect(dialog.textContent).toContain('还原');
  });

  it('确认之后发的是一次批量请求，不是对每条选中的任务各发一次', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'Delete' });
    const dialog = await confirmDialog();
    fireEvent.click(btnIn(dialog, '删除'));

    await waitFor(() => expect(api.deleteTasks).toHaveBeenCalledTimes(1));
    expect(api.deleteTasks).toHaveBeenCalledWith(['a', 'b']);
    // 一次批量请求，不是对每个选中的 id 各发一条单条删除。
    expect(api.deleteTask).not.toHaveBeenCalled();
  });

  it('取消之后一条都没删——上限', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'Delete' });
    const dialog = await confirmDialog();
    fireEvent.click(btnIn(dialog, '取消'));

    expect(api.deleteTasks).not.toHaveBeenCalled();
  });

  it('一张都没选时按 Del：什么都不发生，不弹确认框——上限', async () => {
    await renderOnAll();

    fireEvent.keyDown(window, { key: 'Delete' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.deleteTasks).not.toHaveBeenCalled();
  });

  it('切视图之后选中被清空——不然会删掉看不见的卡（数据丢失防线）', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
    await waitFor(() => expect(batchBar()).not.toBeNull());

    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });

    // 批量操作条不该再出现，卡片上也不该再有选中标记——选中已经在切走的
    // 那一刻被清空，不是切回来才发现「原来还选着」。
    expect(batchBar()).toBeNull();
    expect(document.querySelector('.ink-task-card-selected')).toBeNull();
  });

  // I4（final-review.md）：上一条测的是「切视图」这一道口子——设计③要防的
  // 是「选了几张、看不见了、按了删」这种数据丢失。但搜索视图里改查询词根本
  // 不换 view（一直是 'search'），这道口子绕得过去：搜「甲」选中两条，把
  // 查询词改成「丙」，两条卡从 DOM 里消失，选中却原样留着，批量条也原样
  // 留着——跟切视图那条是同一条防线，只是绕开了「view 变了」这一扇门。
  it('搜索视图里改查询词也要清空选中——不然能删掉屏幕上已经看不见的卡（I4）', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲甲甲', due: null, reminders: [] }),
      task({ id: 'b', title: '甲乙乙', due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await searchFor('甲');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });

    const panel = () => container.querySelector('.ink-view-panel-search') as HTMLElement;
    const cardIn = (title: string) => within(panel()).getByText(title).closest('.ink-swipe') as HTMLElement;
    fireEvent.click(cardIn('甲甲甲'), { ctrlKey: true });
    fireEvent.click(cardIn('甲乙乙'), { ctrlKey: true });
    await waitFor(() => expect(batchBar()).not.toBeNull());

    // 改查询词——两条都不再匹配，view 还是 'search'，没有切走。**再开一次弹层**
    // 改词：搜索框现在长在弹层里，回车之后弹层关掉了，那个框已经不在树上。
    const box2 = await openSearch();
    fireEvent.change(box2, { target: { value: '丙' } });
    await waitFor(() => expect(within(panel()).queryByText('甲甲甲')).toBeNull());

    // 批量操作条不该还挂着「已选中 2 条」，卡片上也不该还有选中标记——
    // 挖掉这条依赖之后批量条会原样留着，见 App.tsx 那段依赖数组的注释。
    expect(batchBar()).toBeNull();
    expect(document.querySelector('.ink-task-card-selected')).toBeNull();
  });

  // final-review.md C1：筛选栏是第三条会让「屏幕上看得见的集合」发生变化的
  // 轴（前两条是切视图、改查询词，上面两条测试各守一条）。这条之前完全没有
  // 断言守——筛选把选中的卡筛掉之后，批量条照样说「已选中 2 条」，确认框
  // 只报数量不报名字，点确认会删掉屏幕上已经看不见的那条。
  it('筛选变了也要清空选中——不然批量操作会打在筛选之后已经看不见的卡上（final-review.md C1）', async () => {
    currentTasks = [
      task({ id: 'a', title: '任务甲', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '任务乙', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });

    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
    await waitFor(() => expect(batchBar()).not.toBeNull());

    // 筛选栏收窄成只剩「任务甲」——view 没变（一直是 'all'），query 也没变
    // （一直是空串），只有 filter 变了，这是这条清空选中的 effect 依赖数组
    // 要补的第三条轴。
    //
    // 筛选栏默认收起（task-4-brief）——先展开，跟本文件其它地方
    // openFilterSelect 里同一步。
    fireEvent.click(btnIn(document.body, '筛选'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '标签' }));
    const option = [...document.querySelectorAll('.ant-select-item-option')]
      .find((e) => e.textContent === '紧急');
    if (!option) throw new Error('筛选栏「标签」下拉里没有「紧急」');
    fireEvent.click(option);
    await waitFor(() => expect(within(panel()).queryByText('任务乙')).toBeNull());

    // 批量操作条不该还挂着「已选中 2 条」——任务乙已经被筛掉、看不见了，
    // 选中却原样留着的话，批量删除会打在这张看不见的卡上。
    expect(batchBar()).toBeNull();
    expect(document.querySelector('.ink-task-card-selected')).toBeNull();
  });

  it('Esc 清空选中', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
    await waitFor(() => expect(batchBar()).not.toBeNull());

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(batchBar()).toBeNull());
  });

  it('选中为空时命令面板里没有批量命令——上限', async () => {
    await renderOnAll();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const listbox = await screen.findByRole('listbox', { name: '命令列表' });
    expect(within(listbox).queryByText(/删除选中/)).toBeNull();
    expect(within(listbox).queryByText('取消选择')).toBeNull();
  });

  it('选中非空时命令面板里出现批量命令，点「删除选中的 N 条」跑的是跟 Del 键同一套确认', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const listbox = await screen.findByRole('listbox', { name: '命令列表' });
    fireEvent.click(within(listbox).getByText('删除选中的 1 条'));

    // 跑的是同一个 confirmBatchDelete：会弹确认框，不是点了就直接删掉。
    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('1');
    fireEvent.click(btnIn(dialog, '删除'));
    await waitFor(() => expect(api.deleteTasks).toHaveBeenCalledWith(['a']));
  });

  /**
   * 「选中就跑」的那几个批量动作也进命令面板。收哪些的判据是**要不要再问一步**
   * ——完成 / 改到今天·明天·下周 / 推迟 1 小时都不需要，改清单、加标签、改
   * 优先级需要（各自还要问「哪个」），那三个继续留在批量操作条里。
   * 这也是 D / T / M / W 那几个单键的唯一出口：不进面板的话它们只在 `?` 那张
   * 表里出现过一次。
   */
  const openPalette = async () => {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    return await screen.findByRole('listbox', { name: '命令列表' });
  };

  it('「把选中的 N 条标成已完成」跑的是跟 D 键同一个动作', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.click(within(await openPalette()).getByText('把选中的 1 条标成已完成'));

    await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a'], { status: 'done' }));
  });
  /**
   * 把**全部**过期的改到今天。跟上面那几条批量命令不同：它**不需要选中**，
   * 范围是全表。「今天」里过期的和今天要做的混在一排（分不出组，见 TodayView
   * 里那段），而那正是最想整批顺建的时候。
   */
  it('没选中任何卡片也叫得出来，标题里写着要动多少条', async () => {
    await renderOnAll();
    const listbox = await openPalette();
    expect(within(listbox).getByText(/把 \d+ 条过期的改到今天/)).toBeTruthy();
  });

  it('**要确认一句**——改期把原来那些日期覆盖掉了，而命令面板是模糊搜索命中、回车就跑的一步', async () => {
    await renderOnAll();
    fireEvent.click(within(await openPalette()).getByText(/把 \d+ 条过期的改到今天/));

    // 确认框弹出来了，而且在点「改到今天」之前一个请求都没发。
    // 标题和 aria 各有一份同样的文字，取标题那一个。
    expect(await screen.findByText(/条过期的改到今天？/, { selector: '.ant-modal-title' })).toBeTruthy();
    expect(api.patchTasksEach).not.toHaveBeenCalled();
  });


  it('三个改期去处都在，「去掉截止时间」不在——批量清空所有选中的截止时间，误点的代价比单条大一个量级', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    const listbox = await openPalette();
    // 写全「把选中的 N 条……」：面板里还有一条「把 N 条过期的改到今天」
    // （全表范围、带确认框），只写「改到今天」会同时命中两条。
    for (const label of ['把选中的 1 条改到今天', '改到明天', '改到下周']) {
      expect(within(listbox).getByText(new RegExp(label))).toBeTruthy();
    }
    expect(within(listbox).queryByText(/去掉截止时间/)).toBeNull();
  });

  it('「推迟 1 小时」也在——它同样不需要再问一步', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    fireEvent.click(within(await openPalette()).getByText(/推迟 1 小时/));

    await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalled());
  });

  it('**还要再问一步的那几个仍然不收**——命令面板的命令没有再问的地方', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    const listbox = await openPalette();
    for (const nope of [/改清单/, /加标签/, /改优先级/]) {
      expect(within(listbox).queryByText(nope), String(nope)).toBeNull();
    }
  });

  it('在输入框里按 Del 不触发批量删除——上限（防的是编辑标题时选中一段文字按 Delete 被当成批量删除）', async () => {
    await renderOnAll();
    fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

    await openTaskForm();
    const titleInput = await screen.findByPlaceholderText('标题');
    fireEvent.keyDown(titleInput, { key: 'Delete' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.deleteTasks).not.toHaveBeenCalled();
  });

  // 批量操作条其余四个动作——改状态/改清单/改优先级都是「同一个 patch 套
  // 所有选中的任务」，直接走 api.patchTasks；加标签是唯一的例外（见 App.tsx
  // BatchBar 那段 onAddTag 上面的注释），这里单独用一条测试守住「合并」这件
  // 事本身，不只是「函数被调用了」。BatchBar 组件自己的下拉/输入框交互已经
  // 在 BatchBar.test.tsx 用 mock 回调守住了，这里只守 App 这一层接的回调
  // 真的调对了 api。
  describe('批量操作条：改状态/改清单/改优先级/加标签', () => {
    async function openMenu(triggerLabel: string, itemLabel: string) {
      fireEvent.click(screen.getByRole('button', { name: triggerLabel }));
      const item = await waitFor(() => {
        const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
          .find((e) => e.textContent === itemLabel);
        if (!hit) throw new Error(`「${triggerLabel}」菜单里没有「${itemLabel}」`);
        return hit;
      });
      fireEvent.click(item);
    }

    it('改状态：一次 patchTasks，patch 是 { status }，ids 是选中的那些', async () => {
      await renderOnAll();
      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
      fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

      await openMenu('改状态', '进行中');

      await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a', 'b'], { status: 'doing' }));
      expect(api.patchTasks).toHaveBeenCalledTimes(1);
    });

    it('改清单：patch 是 { listId }', async () => {
      currentLists = [list({ id: 'L1', name: '工作' })];
      await renderOnAll();
      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

      fireEvent.change(screen.getByLabelText('批量改清单'), { target: { value: 'L1' } });

      await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a'], { listId: 'L1' }));
    });

    it('改优先级：patch 是 { priority }', async () => {
      await renderOnAll();
      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });

      await openMenu('改优先级', '高');

      await waitFor(() => expect(api.patchTasks).toHaveBeenCalledWith(['a'], { priority: 3 }));
    });

    // 「加标签」没法走 patchTasks 那条「同一个 patch 套所有选中任务」的路：
    // 选中的任务各自已有的 tags 不一样，用同一个数组覆盖会把没打算动的旧
    // 标签冲掉，见 App.tsx 那段 onAddTag 上面的注释。这里用三条标签各不相同
    // 的任务验证：新增的合并到各自已有的标签后面，已经有这个标签的那条
    // 跳过不发请求——不是「反正都发一遍，服务端自己去重」。
    it('加标签：每条任务各自合并自己已有的标签，已经有这个标签的那条跳过不发请求', async () => {
      currentTasks = [
        task({ id: 'a', title: '任务甲', tags: ['工作'] }),
        task({ id: 'b', title: '任务乙', tags: ['生活'] }),
        task({ id: 'c', title: '任务丙', tags: ['工作', '紧急'] }), // 已经有「紧急」
      ];
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await waitFor(() => expect(navButton(/今天/)).toBeDefined());
      fireEvent.click(navButton(/全部/));
      await screen.findByRole('heading', { level: 1, name: '全部' });

      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
      fireEvent.click(cardFor('任务乙'), { ctrlKey: true });
      fireEvent.click(cardFor('任务丙'), { ctrlKey: true });

      const input = screen.getByLabelText('批量加标签');
      fireEvent.change(input, { target: { value: '紧急' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // 一次请求，每条各带自己的新数组——**不是 N 条 patchTask**（那是 N 轮
      // 目录监听器 + N 轮 SSE 广播，选 20 张就是 20 轮），也不是 patchTasks
      // （那份共享 patch 会把每条各自原有的标签冲掉）。
      await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalledTimes(1));
      expect(api.patchTasksEach).toHaveBeenCalledWith([
        { id: 'a', patch: { tags: ['工作', '紧急'] } },
        { id: 'b', patch: { tags: ['生活', '紧急'] } },
        // 「丙」已经有「紧急」——整条不在这批里，不是发一条内容没变的 patch。
      ]);
      expect(api.patchTask).not.toHaveBeenCalled();
      expect(api.patchTasks).not.toHaveBeenCalled();
    });

    it('批量改期：每条各改各的，原来几点还是几点', async () => {
      // 钉在早上八点：两条的钟点（18:00 / 09:00）今天都还没到，所以走的是
      // 「原来几点还是几点」那一支——不钉的话下午跑这条，09:00 那条会落到
      // 23:59（`reschedule.ts` 的 ③），断言的就不是这条测试要说的事了。
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 7, 22, 8, 0, 0));
      currentTasks = [
        // 本地墙钟：断言读的是本地小时数，用固定 UTC 'Z' 会让这条只在 UTC 机器上绿。
        task({ id: 'a', title: '任务甲', due: new Date(2026, 7, 20, 18).toISOString() }),
        task({ id: 'b', title: '任务乙', due: new Date(2026, 7, 19, 9).toISOString() }),
      ];
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await waitFor(() => expect(navButton(/今天/)).toBeDefined());
      fireEvent.click(navButton(/全部/));
      await screen.findByRole('heading', { level: 1, name: '全部' });

      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
      fireEvent.click(cardFor('任务乙'), { ctrlKey: true });

      fireEvent.click(btnIn(document.body, '改期'));
      const item = await waitFor(() => {
        const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
          .find((e) => e.textContent?.replace(/\s/g, '') === '今天');
        if (!hit) throw new Error('菜单里没有「今天」');
        return hit;
      });
      fireEvent.click(item);

      await waitFor(() => expect(api.patchTasksEach).toHaveBeenCalledTimes(1));
      const sent = (api.patchTasksEach as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ id: string; patch: { due: string } }>;
      // 两条原来的钟点不一样（18:00 / 09:00），挪到今天之后各自保留
      expect(new Date(sent.find((e) => e.id === 'a')!.patch.due).getHours()).toBe(18);
      expect(new Date(sent.find((e) => e.id === 'b')!.patch.due).getHours()).toBe(9);
      vi.useRealTimers();
    });

    it('批量推迟：选中的全都没有时间时说一句，不静默什么都不做', async () => {
      currentTasks = [task({ id: 'a', title: '任务甲', due: null, reminders: [] })];
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await waitFor(() => expect(navButton(/今天/)).toBeDefined());
      fireEvent.click(navButton(/全部/));
      await screen.findByRole('heading', { level: 1, name: '全部' });

      fireEvent.click(cardFor('任务甲'), { ctrlKey: true });
      fireEvent.click(btnIn(document.body, '推迟1小时'));

      expect(await screen.findByText(/没有可以推迟的/)).toBeTruthy();
      expect(api.patchTasksEach).not.toHaveBeenCalled();
    });
  });
});

// task-3-brief：筛选栏叠在视图之上。要点①「每个用 TaskGrid 的视图都要接」
// ——跟上一批 selection 的「八处接线点」同一个教训，这里逐处验证：search/
// upcoming/kanban/quadrant/all/done/scoped（list:/tag: 共用同一处接线，只
// 测 list: 那条）/calendar，一共八处，每处都断言「筛选真的把不匹配的那条
// 收窄掉了」，不是只断言筛选栏出现了（出现了不代表真的接到了收窄逻辑上）。
describe('App：筛选栏叠在视图之上——task-3-brief', () => {
  /** 打开筛选栏某个多选下拉，返回选项文字数组——跟 FilterBar.test.tsx 的
   *  openSelect 同一个写法（下拉面板挂在 body 末尾的浮层里，不在渲染出来的
   *  子树内，从 document 找）。这个套件里任一时刻最多只有一个视图挂着筛选栏
   *  （不是 keepMounted 的那几个视图切走就真的卸载），不用另外限定查询范围。
   *
   *  筛选栏默认收起（task-4-brief）——下拉只在展开状态下存在，先按一次
   *  「筛选」展开它；筛选已经非空（组件自己会强制展开）时找不到这颗按钮，
   *  跳过就行，不是 bug。跟 FilterBar.test.tsx 的 openFilterBar 同一个写法。 */
  function openFilterSelect(label: string) {
    const toggle = [...document.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === '筛选');
    if (toggle) fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
    return [...document.querySelectorAll('.ant-select-item-option')];
  }
  function pickFilterOption(label: string, optionText: string) {
    const options = openFilterSelect(label);
    const hit = options.find((e) => e.textContent === optionText);
    if (!hit) throw new Error(`筛选栏「${label}」下拉里没有「${optionText}」，实际选项：${options.map((e) => e.textContent).join('、')}`);
    fireEvent.click(hit);
  }

  it('① search：筛选叠在搜索结果之上', async () => {
    currentTasks = [
      task({ id: 'a', title: '写周报甲', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '写周报乙', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await searchFor('周报');
    await screen.findByRole('heading', { level: 1, name: '搜索结果' });
    const panel = () => document.querySelector('.ink-view-panel-search') as HTMLElement;
    // 中间断言：筛选之前两条命中都在——不然下面「筛掉一条」证明不了筛选
    // 真的起了作用（上限断言在功能没接上时天然成立，见 parked-all.md 97 条
    // 的判据：这里反过来先证明「窄化前是宽的」）。
    await waitFor(() => expect(within(panel()).getByText('写周报甲')).toBeDefined());
    expect(within(panel()).getByText('写周报乙')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('写周报乙')).toBeNull());
    expect(within(panel()).getByText('写周报甲')).toBeDefined();
  });

  it('② upcoming（接下来）：筛选叠在议程之上', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/接下来/));
    await screen.findByRole('heading', { level: 1, name: '接下来' });
    const panel = () => document.querySelector('.ink-view-panel-upcoming') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
  });

  it('③ kanban（看板）：筛选叠在四列之上', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', status: 'todo', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', status: 'todo', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await goBoard();
    const panel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
  });

  it('④ quadrant（四象限）：筛选叠在四格之上', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', status: 'todo', priority: 0, tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', status: 'todo', priority: 0, tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });
    const panel = () => document.querySelector('.ink-view-panel-quadrant') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
  });

  it('⑤ all（全部）：筛选叠在全部之上，且显示「N / M 条」，不是写死的占位符', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    const panel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
    expect(panel().textContent).toContain('1 / 2 条');
  });

  it('⑥ done（已完成）：筛选叠在已完成之上', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', status: 'done', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', status: 'done', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    const panel = () => document.querySelector('.ink-view-panel-done') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
  });

  it('⑦ scoped（清单/标签回退分支，list:/tag: 共用同一处接线，这里测 list:）：筛选叠在清单视图之上', async () => {
    currentLists = [list({ id: 'L1', name: '工作' })];
    currentTasks = [
      task({ id: 'a', title: '甲任务', listId: 'L1', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', listId: 'L1', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());
    fireEvent.click(navButton(/工作/));
    const panel = () => document.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).getByText('乙任务')).toBeDefined();

    pickFilterOption('标签', '紧急');

    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();
  });

  it('⑧ calendar（日历当天列表）：筛选叠在当天列表之上', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 16, 18, 0, 0, 0).toISOString();
      currentTasks = [
        task({ id: 'a', title: '甲任务', due, tags: ['紧急'] }),
        task({ id: 'b', title: '乙任务', due, tags: ['闲杂'] }),
      ];
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = () => container.querySelector('.ink-view-panel-calendar') as HTMLElement;
      fireEvent.keyDown(panel().querySelector('.fc-day-today')!, { key: 'Enter' });

      const grid = await waitFor(() => {
        const g = panel().querySelector('.ink-row-list');
        if (!g) throw new Error('当天列表还没出现');
        return g;
      });
      expect(within(grid as HTMLElement).getByText('甲任务')).toBeDefined();
      expect(within(grid as HTMLElement).getByText('乙任务')).toBeDefined();

      pickFilterOption('标签', '紧急');

      await waitFor(() => expect(within(panel().querySelector('.ink-row-list') as HTMLElement).queryByText('乙任务')).toBeNull());
      expect(within(panel().querySelector('.ink-row-list') as HTMLElement).getByText('甲任务')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // final-review.md m1：calendar 分支的 total/matched 之前直接用
  // `tasks.length`/`filterMatchedIds.size`（全部任务），跟另外七处
  // withFilterBar 用「这个视图自己的候选数」不是同一个口径——月格标记和
  // 当天列表都从 due 算，没有 due 的任务在这个视图里从头到尾不会出现。
  it('日历「N / M 条」的分母只数有 due 的任务，不是全部任务（final-review.md m1）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 16, 18, 0, 0, 0).toISOString();
      currentTasks = [
        task({ id: 'a', title: '甲任务', due, tags: ['紧急'] }),
        task({ id: 'b', title: '乙任务', due: null, reminders: [], tags: [] }),
        task({ id: 'c', title: '丙任务', due: null, reminders: [], tags: [] }),
      ];
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      const panel = () => document.querySelector('.ink-view-panel-calendar') as HTMLElement;

      pickFilterOption('标签', '紧急');

      // 这个视图从头到尾只可能显示「甲任务」（唯一有 due 的一条）——分母该
      // 是 1，不是全部任务数 3；改动前会显示「1 / 3 条」。
      await waitFor(() => expect(panel().textContent).toContain('1 / 1 条'));
      expect(panel().textContent).not.toContain('1 / 3 条');
    } finally {
      vi.useRealTimers();
    }
  });

  it('智能清单（filter 非 null）按 applyFilter 取任务，不看 listId——App 层接线，scoped.ts 的分叉真的用上了 lists', async () => {
    currentLists = [
      list({ id: 'L1', name: '进行中的事', filter: { ...emptyFilter(), status: ['doing'] } }),
    ];
    currentTasks = [
      // 'a' 的 listId 指向这个智能清单，但 status 不满足它的 filter——
      // 智能清单不是容器，listId 对上没用，不该出现。
      task({ id: 'a', title: '甲任务', listId: 'L1', status: 'todo', due: null, reminders: [] }),
      // 'b' 的 listId 跟这个智能清单毫无关系（甚至是 null），但 status
      // 满足 filter——该出现，这是「查询不是容器」这条设计的核心断言。
      task({ id: 'b', title: '乙任务', listId: null, status: 'doing', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/进行中的事/)).toBeDefined());
    fireEvent.click(navButton(/进行中的事/));
    const panel = () => document.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('乙任务')).toBeDefined());
    expect(within(panel()).queryByText('甲任务')).toBeNull();
  });

  it('普通清单（filter 为 null）还是按 listId 取——上一条智能清单分叉没有带偏这条老路径', async () => {
    currentLists = [list({ id: 'L1', name: '工作', filter: null })];
    currentTasks = [
      task({ id: 'a', title: '甲任务', listId: 'L1', status: 'todo', due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', listId: null, status: 'todo', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());
    fireEvent.click(navButton(/工作/));
    const panel = () => document.querySelector('.ink-view-panel-scoped') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('甲任务')).toBeDefined());
    expect(within(panel()).queryByText('乙任务')).toBeNull();
  });

  // 设计②：跟「切视图清空选中」（本文件上面「批量操作接线」describe 里
  // 「切视图之后选中被清空」那条）语义相反——选中是「对这几条做事」，跨视图
  // 无意义还危险；筛选是「只想看这一类」，跨视图正是它有用的地方。这两条
  // 分开钉：那条守「选中要清」，这条守「筛选不能清」，一个 useEffect 的
  // 依赖数组旁边很容易顺手把两件事写成同一件事。
  it('切视图不清空筛选——切到看板，筛选还在生效，不是被悄悄重置回空（对照「切视图清空选中」，语义相反）', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', status: 'todo', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', status: 'todo', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });

    pickFilterOption('标签', '紧急');
    const allPanel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(allPanel()).queryByText('乙任务')).toBeNull());

    await goBoard();

    // 核心断言：筛选没被清空——看板里同样只看到「甲任务」。如果切视图那个
    // useEffect 顺手把 filter 也清了（这批最容易犯的错，见上面这个 describe
    // 顶部的注释），这里会看到「乙任务」重新冒出来，两条都在。
    const kanbanPanel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;
    await waitFor(() => expect(within(kanbanPanel()).getByText('甲任务')).toBeDefined());
    expect(within(kanbanPanel()).queryByText('乙任务')).toBeNull();

    // 筛选栏本身显示的选择也还在（不是「效果碰巧一样，但用户看到的芯片已经
    // 被清空」这种巧合）——scope 到「标签」这颗 Select 内部，避免跟任务卡
    // 自己的标签 chip（同样显示文字「紧急」）撞在一起。
    const tagsSelect = within(kanbanPanel()).getByRole('combobox', { name: '标签' }).closest('.ant-select') as HTMLElement;
    expect(within(tagsSelect).getByText('紧急')).toBeDefined();
  });

  // final-review.md I2：App.tsx filterSections 里 `|| editing.has(t.id)`
  // 那半句是这一批为「编辑到一半的卡不能连草稿一起消失」加的保护，之前
  // 一条断言都没有——整段挖掉（`s.tasks.filter((t) => filterMatchedIds.has(t.id))`）
  // App.test.tsx 119 条照样全绿、Errors 无、退出码 0。跟 TaskGrid.tsx
  // Props.sections 顶部那段契约、CalendarView 当天列表那条（这个文件上面
  // 「重算不该把编辑框连同草稿一起摘掉」）是同一件事在筛选这一层的版本。
  it('筛选变了，正在编辑的卡不能连草稿一起消失（final-review.md I2）', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    const panel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;

    // 筛选栏默认收起（task-4-brief）——先展开。
    fireEvent.click(btnIn(document.body, '筛选'));

    // 中间断言：先筛出「甲」，证明筛选文本这一维真的接到了收窄逻辑上——
    // 不然下面「乙任务重新出现」测不出「筛选变了」这件事真的发生过。
    fireEvent.change(screen.getByLabelText('筛选文本'), { target: { value: '甲' } });
    await waitFor(() => expect(within(panel()).queryByText('乙任务')).toBeNull());
    expect(within(panel()).getByText('甲任务')).toBeDefined();

    // 选中甲、按 E 进编辑态，改一半标题——草稿还没存。
    fireEvent.click(within(panel()).getByText('甲任务').closest('.ink-swipe') as HTMLElement, { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'e' });
    const input = await screen.findByPlaceholderText('标题');
    fireEvent.change(input, { target: { value: '改到一半还没存' } });

    // 把筛选文本改成「乙」——甲不再匹配 filterMatchedIds，但正在编辑，
    // 不该连草稿一起从屏幕上消失。
    fireEvent.change(screen.getByLabelText('筛选文本'), { target: { value: '乙' } });

    // 中性信号：等这次筛选真的生效，不能直接断言「编辑框还在」——那样可能
    // 在筛选重算完成之前就通过，测不出问题（跟本文件上面「当天列表」那条
    // I2 姊妹测试同一个坑）。「乙任务重新出现」跟「甲的编辑框还在不在」
    // 完全无关，不会跟被测的那半句自我印证。
    // 用 heading 角色定位，不是裸 getByText：甲现在处在编辑态，它的「上级
    // 任务」下拉里有一个 <option>乙任务</option>（多级任务那批加的候选表），
    // 裸文本查询会同时命中那个 option 和真正的卡片标题。
    await waitFor(() => expect(within(panel()).getAllByText('乙任务').some((el) => el.tagName !== 'OPTION')).toBe(true));

    const liveInput = within(panel()).getByPlaceholderText('标题') as HTMLInputElement;
    expect(liveInput.value).toBe('改到一半还没存');
  });
});

// task-4-brief：筛选组合存成智能清单。POST /api/lists 的 filter 带上当前
// 筛选（服务端 sanitizeSmartFilter 校验得比前端能写的严，这里不重复一份
// 校验），名字必须用户填（不自动生成），空名字不让提交，存完之后导航上
// 走 data-changed → reload 那条路自己冒出来，不是本地塞一条。
// 「点开一个智能清单，看到的是 filter 算出来的任务，不是 listId 匹配的」
// 已经在上面 task-3-brief 那组测试里守住（'智能清单（filter 非 null）按
// applyFilter 取任务，不看 listId……'），这里不重复。
describe('App：筛选组合存成智能清单——task-4-brief', () => {
  // `vi.mock('./api.js', ...)` 工厂里的 vi.fn() 是模块级的、整份文件共用
  // 一份——文件顶部 afterEach 的 `vi.restoreAllMocks()` 对它们不生效（那
  // 个方法只清 `vi.spyOn` 出来的 spy，不清 `vi.mock` 工厂里手写的
  // `vi.fn()`，见上面「批量操作接线」describe 顶部同一条注释）。这批断言
  // 要看「被调用了几次/有没有被调用」，不清的话会被更早的用例（比如上面
  // 「侧栏『新建清单』」那组、以及这个 describe 自己前一条用例）留下的调用
  // 记录污染，在每条用例开始前手动清一次，不依赖执行顺序。
  beforeEach(() => {
    vi.mocked(api.addList).mockClear();
  });

  // 筛选栏默认收起（task-4-brief）——先展开，见上面 task-3-brief 那组
  // describe 里同一个 helper 上的注释（这里访问不到那个闭包，只能各自
  // 重复一份）。
  function openFilterSelect(label: string) {
    const toggle = [...document.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === '筛选');
    if (toggle) fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
    return [...document.querySelectorAll('.ant-select-item-option')];
  }
  function pickFilterOption(label: string, optionText: string) {
    const options = openFilterSelect(label);
    const hit = options.find((e) => e.textContent === optionText);
    if (!hit) throw new Error(`筛选栏「${label}」下拉里没有「${optionText}」，实际选项：${options.map((e) => e.textContent).join('、')}`);
    fireEvent.click(hit);
  }

  // 查询限定在「全部」这一个视图面板里，不用不加范围的 screen.getByRole——
  // 变异挖掉 onSaveAsList 接线之后这颗按钮会找不到，不限范围地在整棵 App
  // 树上找“找不到”会连着现算一遍全树的可访问角色去拼诊断信息，这个仓库
  // 已经在别处测出单条用例因此跑到几百秒，见 test-utils.tsx pickCardMenu
  // 顶部同一条教训、以及这次任务说明书「做变异之前先给测试里的查询限定
  // 范围」那条硬性要求。
  const panel = () => document.querySelector('.ink-view-panel-all') as HTMLElement;

  /** 切到「全部」、筛出「标签=紧急」，回到调用方手上继续操作弹窗——四条
   *  测试共用同一段前置，跟上面 task-3-brief 那组不共用（那边的 helper
   *  是那个 describe 自己的闭包，这里访问不到，见下面报告里的取舍）。 */
  async function setupWithFilter() {
    currentTasks = [
      task({ id: 'a', title: '甲任务', tags: ['紧急'], due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', tags: ['闲杂'], due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    pickFilterOption('标签', '紧急');
  }

  it('POST 的 body 里 filter 是当前筛选——toEqual 精确匹配整个 filter 对象', async () => {
    await setupWithFilter();
    fireEvent.click(await within(panel()).findByRole('button', { name: '存成智能清单' }));
    const input = await screen.findByLabelText('智能清单名字');
    fireEvent.change(input, { target: { value: '紧急事项' } });
    fireEvent.click(screen.getByRole('button', { name: '保存智能清单' }));

    await waitFor(() => expect(api.addList).toHaveBeenCalledTimes(1));
    // 名字、颜色（调色盘轮转，跟 Sidebar「新建清单」同一套逻辑，不在这条
    // 测试的范围内，用 any(String) 放过）各占一个参数；第三个参数就是这条
    // 测试的题目——精确等于当前筛选算出来的整个 SmartFilter 对象，多一个
    // 键、少一个键、某个字段的值不对，这里都会红（toEqual 不是
    // toMatchObject，见 brief）。
    expect(api.addList).toHaveBeenCalledWith('紧急事项', expect.any(String), {
      status: [], listIds: [], tags: ['紧急'], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '',
      // 高级筛选那两个字段也要原样存进去——存下来的智能清单打开之后必须跟
      // 存的时候筛出同一批任务，少存一个键就不是同一份查询了。
      tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
    });
    const [, , calledFilter] = (api.addList as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledFilter).toEqual({
      status: [], listIds: [], tags: ['紧急'], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '',
      tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
    });
  });

  it('名字为空时不能提交——上限', async () => {
    await setupWithFilter();
    fireEvent.click(await within(panel()).findByRole('button', { name: '存成智能清单' }));
    await screen.findByLabelText('智能清单名字');
    const okBtn = screen.getByRole('button', { name: '保存智能清单' });
    // 这个仓库没装 jest-dom，断言 disabled 一律走原生属性，跟
    // FilterBar.test.tsx 同一个约定。
    expect(okBtn.hasAttribute('disabled')).toBe(true);
    fireEvent.click(okBtn);
    expect(api.addList).not.toHaveBeenCalled();
  });

  // final-review.md I3：`submitSaveAsList` 开头 `if (!name) return` 的注释
  // 说自己是「第二道防线」，其实不是——<Input onPressEnter> 不看 OK 按钮的
  // disabled，回车这条路上它是唯一一道。上面那条「上限」测试点的是 OK
  // 按钮，走不到这一行；挖掉这一行 App.test.tsx 119 条照样全绿、Errors 无、
  // 退出码 0。这条走 onPressEnter 那条独立路径。
  it('空名字按回车也不提交——OK 按钮 disabled 拦不住 onPressEnter，回车这条路上只有这一道防线（final-review.md I3）', async () => {
    await setupWithFilter();
    fireEvent.click(await within(panel()).findByRole('button', { name: '存成智能清单' }));
    const input = await screen.findByLabelText('智能清单名字');

    // 不点 OK 按钮——那条路已经被上面「上限」测试守住。名字留空，直接按
    // 回车，走 <Input onPressEnter> 这条路径。
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(api.addList).not.toHaveBeenCalled();
  });

  // final-review.md m6：submitSaveAsList 的 catch 块只 message.error，不
  // setSavingList(false)、不清 listNameDraft——注释引了 TaskComposer.submit()
  // 同一条教训（TaskComposer.test.tsx「创建失败时表单和草稿都留着」），但
  // 这条逻辑本身之前没有测试守着。
  it('存失败时弹窗留着、草稿不清——不能把用户刚打的名字弄丢（final-review.md m6）', async () => {
    vi.mocked(api.addList).mockRejectedValueOnce(new Error('磁盘满了'));
    await setupWithFilter();
    fireEvent.click(await within(panel()).findByRole('button', { name: '存成智能清单' }));
    const input = await screen.findByLabelText('智能清单名字');
    fireEvent.change(input, { target: { value: '别弄丢我' } });
    fireEvent.click(screen.getByRole('button', { name: '保存智能清单' }));

    await waitFor(() => expect(screen.getByText('磁盘满了')).toBeTruthy());
    // 弹窗还开着——不是失败之后自己关掉。
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 草稿没被清空。
    expect((screen.getByLabelText('智能清单名字') as HTMLInputElement).value).toBe('别弄丢我');
  });

  it('存完之后导航上出现它，带智能清单的记号——走 data-changed → refetch，不是本地塞一条', async () => {
    await setupWithFilter();
    fireEvent.click(await within(panel()).findByRole('button', { name: '存成智能清单' }));
    const input = await screen.findByLabelText('智能清单名字');
    fireEvent.change(input, { target: { value: '紧急事项' } });
    fireEvent.click(screen.getByRole('button', { name: '保存智能清单' }));
    await waitFor(() => expect(api.addList).toHaveBeenCalledTimes(1));

    // 弹窗自己关掉，不用户再点一次「取消」。antd Modal 默认不
    // destroyOnClose——`open` 变 false 之后 DOM 还留着（display:none），
    // 只是从可访问树里退出，所以不能靠 queryByLabelText（不看可见性）
    // 断言它「消失」，要用 queryByRole（默认排除 hidden 元素）。
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // 导航上这时候还没有它——证明下面真的是 data-changed 之后才冒出来，
    // 不是 POST 的返回值被顺手塞进了本地状态（brief 明确不让这么做）。
    expect(screen.queryByText('紧急事项')).toBeNull();

    // 服务端真正落盘之后走的是 data-changed → reload('lists')，不是这次
    // POST 的返回值直接进 state——手动模拟这条真实链路，跟本文件别处
    // 「文件 → watcher → SSE → reload」同一个测法（比如最上面「任务变成
    // done 之后，横幅自动消失」那组）。
    currentLists = [list({ id: 'new-smart', name: '紧急事项', filter: { ...emptyFilter(), tags: ['紧急'] } })];
    act(() => handlers.onChange!('lists'));

    await waitFor(() => expect(navButton(/紧急事项/)).toBeDefined());
    // 带智能清单的记号——Sidebar.tsx 那颗 title="智能清单" 的 ✦。
    // 那颗 ✦ 的 title 现在还带上了条件本身（「智能清单：待办 · #工作」）
    // ——侧栏里一份存下来的查询原本只有一个名字，见 lib/describeFilter.ts。
    expect(within(navButton(/紧急事项/)).getByTitle(/^智能清单/)).toBeDefined();
  });

  // withFilterBar（search/upcoming/kanban/quadrant/all/done/scoped 共七处）
  // 和 calendar 是两处各自独立的 <FilterBar onSaveAsList=…> 接线（calendar
  // 不吃 GridSection[]，没法直接塞进 withFilterBar，见 App.tsx calendar
  // 分支顶上的注释）——上面几条测试都走「全部」，只验了 withFilterBar 那处，
  // 这条单独验 calendar 那处，不然漏接不会有任何测试挂红，见总账「N 个
  // 接线点只改一处」同一条教训。
  it('calendar 视图的筛选栏也接了「存成智能清单」——跟 withFilterBar 是两处独立接线，各自要验', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 16, 9, 0, 0));
    try {
      const due = new Date(2026, 7, 16, 18, 0, 0, 0).toISOString();
      currentTasks = [task({ id: 'a', title: '甲任务', due, tags: ['紧急'] })];
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      fireEvent.click(navButton(/日历/));
      await screen.findByRole('heading', { level: 1, name: '日历' });
      pickFilterOption('标签', '紧急');
      // 限定在日历面板里找——理由同上面 panel() 那条注释。
      const calPanel = document.querySelector('.ink-view-panel-calendar') as HTMLElement;
      const btn = within(calPanel).getByRole('button', { name: '存成智能清单' });
      expect(btn.hasAttribute('disabled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 群青那件事：Modal 的 OK 按钮默认 type="primary"、Input 的聚焦边框都直接读
// colorPrimary（全局是群青）——theme.css 的前缀扫描守不到这个（颜色不是
// CSS 文件里的规则，是 antd 运行时按 token 现算的 css-var），跟
// FilterBar.test.tsx「Select 的选中底色不是群青」同一套办法：渲染出来读
// 实际的 --ant-color-primary 自定义属性。先做对照组证明这份夹具本身能
// 复现群青，再证明 App 里这个弹窗被局部 ConfigProvider 压回了 ink.you。
describe('App：存成智能清单弹窗——OK 按钮和输入框不是群青', () => {
  it('对照：这份夹具本身确实会让 Modal 的 OK 按钮读到群青——不是随手挑的主题恰好不是群青', () => {
    render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          {/* 没有局部 ConfigProvider 包裹——直接摆一个裸 Modal，证明外层
              appTheme 本身就是群青，下一条测试读到「不是群青」是因为
              App 内部压回来了，不是这份夹具凑巧不是群青。okText 特意不用
              恰好两个汉字的词——测试没经过 main.tsx 那层关掉
              autoInsertSpace 的 ConfigProvider，「确定」会被插空格渲染成
              「确 定」，getByRole 按文字精确匹配会找不到，见
              test-utils.tsx btnIn 顶部注释、App.tsx 里这颗按钮 okText 上
              同一条注释。 */}
          <Modal open title="探针" okText="确认新建" />
        </AntApp>
      </ConfigProvider>,
    );
    const okBtn = screen.getByRole('button', { name: '确认新建' });
    const primary = getComputedStyle(okBtn).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.ai.toLowerCase());
  });

  it('实际弹窗里 OK 按钮和输入框读到的 --ant-color-primary 都是你的墨，不是群青', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', tags: ['紧急'], due: null, reminders: [] }),
    ];
    render(
      <ConfigProvider theme={appTheme}>
        <NoMotion><AntApp><App /></AntApp></NoMotion>
      </ConfigProvider>,
    );
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    // 筛选栏默认收起（task-4-brief）——先展开。
    fireEvent.click(btnIn(document.body, '筛选'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '标签' }));
    const opt = [...document.querySelectorAll('.ant-select-item-option')].find((e) => e.textContent === '紧急');
    if (!opt) throw new Error('标签下拉里没有「紧急」');
    fireEvent.click(opt);

    // 限定在「全部」面板里找触发按钮——理由见上一个 describe 里 panel()
    // 那条注释：这颗按钮如果被谁误删接线，整棵 App 树上找不到时不该现算
    // 一遍全树可访问角色去拼诊断信息。
    const allPanel = document.querySelector('.ink-view-panel-all') as HTMLElement;
    fireEvent.click(within(allPanel).getByRole('button', { name: '存成智能清单' }));
    const okBtn = await screen.findByRole('button', { name: '保存智能清单' });
    const input = screen.getByLabelText('智能清单名字');

    const primaryBtn = getComputedStyle(okBtn).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    const primaryInput = getComputedStyle(input).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primaryBtn).toBe(ink.you.toLowerCase());
    expect(primaryInput).toBe(ink.you.toLowerCase());
    expect(primaryBtn).not.toBe(ink.ai.toLowerCase());
    expect(primaryInput).not.toBe(ink.ai.toLowerCase());
  });
});

// **没配过服务地址也直接进主看板**——拥有者原话「服务地址连不到，也可以使用
// 本地功能，不一定要服务器」。这里曾经有一面墙：没配过 base、又探不到本机
// 服务时 App.tsx 整页 return 一个 `.ink-server-onboarding`（「这台设备上没
// 找到本机的『办事师爷』服务」+ 一份全屏 ServerSetup），把本地功能全挡在后面。
// 这一组现在守的是**墙真的没了**，不是被某个条件藏起来了。
//
// 这个文件顶部的 beforeEach 已经给了一个默认「/api/health 通」的 fetch 桩
// （见 desktopHealthy() 定义处的注释），所以下面每条要模拟「连不上」的都得
// 自己覆盖它。
describe('App：没配过服务地址也能用（那面「先填地址」的墙已经删了）', () => {
  it('上限断言：探得到本机服务（桌面）时看板正常出现，离线记号不出现', async () => {
    const fetchMock = vi.fn(async () => desktopHealthy());
    vi.stubGlobal('fetch', fetchMock);
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 主看板从第一帧就在，不用等任何异步结果。
    expect(navButton(/今天/)).toBeDefined();
    expect(screen.queryByLabelText('服务地址')).toBeNull();

    // 等探测真的跑完再断言一遍——证明「不出现」不是因为探测还没来得及跑完，
    // 是探测真的跑完、判定为「连得上」之后仍然不出现。
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByLabelText('服务地址')).toBeNull();
    expect(navButton(/今天/)).toBeDefined();
    // 复审 M2：离线记号也顺手守在这里——这是「没配过地址、连得上」这一整类
    // （文件里约 160 条跑在桌面夹具上的既有测试）唯一有断言盯着离线记号的
    // 地方。变异「记号强制常显」之前只有下面「离线记号」describe 里的
    // 「上限断言①」一条会红，这一大类桌面场景测试一条都不会因为记号误现
    // 而红——补这一行，让这一类也守住。
    expect(screen.queryByRole('status', { name: '离线' })).toBeNull();
  });

  it('墙没了：没配过 base、本机也探不到（从没配过地址的手机），主看板照样渲染，那面全屏的「没找到本机的『办事师爷』服务」查不到', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 主看板在——这是这条测试的正面：以前这里是 `queryByRole('navigation')`
    // 断言为 null（墙顶掉了整棵树），现在反过来。
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    // 墙的三个记号一个都查不到：容器类名、那句话、以及它内联的那份 ServerSetup
    // （设置弹层没打开，屏幕上不该有「服务地址」输入框）。
    expect(document.querySelector('.ink-server-onboarding')).toBeNull();
    expect(screen.queryByText(/没找到本机的「办事师爷」服务/)).toBeNull();
    expect(screen.queryByLabelText('服务地址')).toBeNull();
  });

  it('横幅指路（整分支审查 M2，桌面那句是后续复审加的）：没配过 base、连不上时横幅在，对桌面和手机各给一句该做什么，还说了地址长什么样', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    const banner = await screen.findByRole('status', { name: '离线' });
    // 指路：base 空串同时覆盖两种人，不靠平台嗅探分支，两句话都要在——
    // 桌面（该做的是重开服务）和手机（该做的是去填地址），说得出入口的
    // 名字、地址长什么样，人才找得到（以前只说「连不上服务端」）。
    expect(banner.textContent).toContain('把「办事师爷」服务重新起起来');
    expect(banner.textContent).toContain('服务地址');
    expect(banner.textContent).toContain('http://192.168.1.5:30035');
    // 三条真实后果一条都不能因为加了指路而被挤掉。
    expect(banner.textContent).toContain('本地数据');
    expect(banner.textContent).toContain('还没同步');
    expect(banner.textContent).toContain('AI 拆解');
    // 纯文字指路，不做成按钮——role="status" 是 live region，里面不塞交互元素。
    expect(banner.querySelector('button, a')).toBeNull();
  });

  it('已经配过 base、这次连不上：一样进主看板，不会因为「配过」就换一套界面', async () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByLabelText('服务地址')).toBeNull();
  });

  it('横幅指的那条路真的走得通：设置弹层里有「服务地址」输入框——墙删了之后这是唯一的入口', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /设置/ }));
    // 设置是分区弹层，服务地址在「数据与服务」那一页。
    fireEvent.click(await screen.findByRole('tab', { name: '数据与服务' }));
    expect(await screen.findByLabelText('服务地址')).toBeDefined();
  });
});

// task-3-brief：「离线记号」——「没连上桌面服务」在这个应用里唯一的表现。
// 「有没有配过地址」曾经是另一件事（配过 → 横幅；没配过 → 一面墙），**现在
// 不是了**：墙删掉之后两种人落到同一条路上，看到同一条横幅，见上面那组。
// isOnline()（lib/dataSource.ts）是这条判据唯一的实现，直接调用真实的 fetch
// （不经过上面 `vi.mock('./api.js', ...)` 那层），所以这里每条都要显式喂一份
// fetch 桩。
describe('App：离线记号', () => {
  it('已经配置过、这次连不上：进主看板，顶上出现离线记号，三句话都在', async () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 主看板正常出现，横幅只是顶上加一条，不顶掉任何东西。
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByLabelText('服务地址')).toBeNull();

    // 离线记号出现，三句话（现在用本地数据/改动还没同步/随手记的东西要
    // 回到桌面才会被 AI 拆解）各自都要在，不是随便哪句提了一嘴就算数。
    const banner = await screen.findByRole('status', { name: '离线' });
    expect(banner.textContent).toContain('本地数据');
    expect(banner.textContent).toContain('还没同步');
    expect(banner.textContent).toContain('AI 拆解');
  });

  it('上限断言①：已经配置过、这次连得上——不显示离线记号（桌面/手机联网时不该天天挂一条离线提示）', async () => {
    setApiBase('http://192.168.1.5:30035');
    const fetchMock = vi.fn(async () => desktopHealthy());
    vi.stubGlobal('fetch', fetchMock);
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    // 等 isOnline() 的探测真的跑完再断言——证明「不出现」不是因为探测还没
    // 来得及跑完，是探测真的跑完、判定为「连得上」之后仍然不出现。跟上面
    // 那条同名的上限断言同一个套路。
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status', { name: '离线' })).toBeNull();
  });

  it('从没配置过、连不上：横幅跟「配过但连不上」那条一字不差——两种人共用同一句话，不再是互斥的两个分支', async () => {
    // 这条以前断言的是相反的事：「只有 ServerSetup，离线记号不会同时出现」。
    // 墙删掉之后「从没配过」不再是一个单独的分支，它跟「配过但连不上」落到
    // 同一条路上——文案因此必须对两种人都成立（不能预设「你配过服务器」）。
    // 这里守的正是「同一句话」：跟上面那条（配过、连不上）逐字比对，不是各
    // 断言各的。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const { unmount } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const neverConfigured = (await screen.findByRole('status', { name: '离线' })).textContent;
    unmount();

    setApiBase('http://192.168.1.5:30035');
    resetOnlineCache();
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const configured = (await screen.findByRole('status', { name: '离线' })).textContent;

    expect(neverConfigured).toBe(configured);
    // 而且不是「两边都是空的」这种恒真——那句话得真的在。
    expect(neverConfigured).toContain('本地数据');
  });
});

/**
 * 复审 C1：`offline` 从 App state 到卡片附件区一共八棒——App.tsx 的
 * gridWiring / 手写传给 TodayView / 手写传给 TaskBoard 三处，TaskGrid.tsx/
 * TodayView.tsx/TaskBoard.tsx（TaskBoard 内部还分两步：传给 GroupSection、
 * GroupSection 再传给 TaskCard）各自的转发四处，最后 TaskCard.tsx 转发给
 * Attachments 一处。只有最后这一棒之前有测试守（Attachments.test.tsx/
 * TaskCard.test.tsx），前面七棒实测过：一起改成 `offline={false}`，
 * 81 文件 / 2020 测试原样全绿。
 *
 * 照抄 `focusMinutes` 那组三处独立接线的测试（这个文件上面「设置里的番茄钟
 * 时长真的传到了卡片上」那个 describe，final-review.md I1）——那组同样是
 * 「App 三处 + 三个组件各自的转发」共七个字面接线点，只用三条测试（全部/
 * 今天/按来源）就各自能被单独打红，因为每条测试走的是一条完整的链路，
 * 链上任何一棒断了都会让终点（这里是「打开」变提示文字这件事）现出原形。
 * `offline` 走的是同一条链形状，这里同样三条，不需要另外为 TaskGrid.tsx/
 * TodayView.tsx/TaskBoard.tsx 三个组件文件各开一份新的单测文件。
 */
describe('App：offline 传到卡片的附件区——照抄 focusMinutes 那组「三条测试守七个接线点」的写法（复审 C1）', () => {
  it('「全部」（App.tsx 的 gridWiring → TaskGrid.tsx → TaskCard）：离线时附件「打开」变成提示文字，不是死链接', async () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    currentTasks = [task({ id: 'a', title: '任务甲', attachments: ['报告.pdf'] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });

    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    const panel = container.querySelector('.ink-view-panel-all') as HTMLElement;

    await waitFor(() => expect(within(panel).getByText('报告.pdf')).toBeDefined());
    expect(within(panel).queryByRole('link', { name: '打开' })).toBeNull();
    expect(within(panel).getByText('要连上服务才能看')).toBeTruthy();
  });

  it('「今天」（App.tsx 手写的 offline prop → TodayView.tsx → TaskCard）：离线时附件「打开」变成提示文字，不是死链接', async () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    currentTasks = [task({ id: 'a', title: '早该做了', due: '2000-01-01T00:00:00.000Z', attachments: ['报告.pdf'] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });
    const panel = () => container.querySelector('.ink-view-panel-today') as HTMLElement;

    await waitFor(() => expect(within(panel()).getByText('报告.pdf')).toBeDefined());
    expect(within(panel()).queryByRole('link', { name: '打开' })).toBeNull();
    expect(within(panel()).getByText('要连上服务才能看')).toBeTruthy();
  });

  it('「按来源」（App.tsx 手写的 offline prop → TaskBoard.tsx → GroupSection → TaskCard，两棒转发都在这条链上）：离线时附件「打开」变成提示文字，不是死链接', async () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    currentTasks = [task({ id: 'a', title: '手工记的', due: null, reminders: [], attachments: ['报告.pdf'] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });

    fireEvent.click(navButton(/按来源/));
    const panel = () => document.querySelector('.ink-view-panel-source') as HTMLElement;

    await waitFor(() => expect(within(panel()).getByText('报告.pdf')).toBeDefined());
    expect(within(panel()).queryByRole('link', { name: '打开' })).toBeNull();
    expect(within(panel()).getByText('要连上服务才能看')).toBeTruthy();
  });
});

/**
 * 复审 C2/I3：离线记号有三处触发点——挂载、SSE `onOpen`（重连）、60 秒心跳。
 * 挂载那一次已经被上面「离线记号」那组测过；这里补另外两处，各自删掉都该
 * 单独打红。
 *
 * `onOpen` 直接调用上面新增的 `handlers.onOpen`（跟 `handlers.onChange`/
 * `onReminder` 同一个套路，不用真的搭一个 EventSource）。60 秒心跳没有
 * 现成的钩子可以直接调用——`setInterval(callback, 60_000)` 是挂载 effect
 * 内联的一段代码，这里 spy `window.setInterval`，从它记录的调用参数里把
 * 那个回调函数本身抠出来直接调，不必真的等 60 秒，也不必把 Date/setTimeout
 * 一起 fake 掉——这个文件另一处「日历接进导航」那组测试已经写明过那样做的
 * 后果：`hashchange`/`findByRole` 的轮询都收不到，会一路等到测试自己的
 * 15 秒超时（实测踩过），这两条测试都要用到 `waitFor`，不能冒这个险。
 *
 * 两条测试顺带验证 I3：翻回在线的那一刻会重新 `reload()` 一次（用
 * `tasksFetchCount` 判断有没有真的多打了一次 `api.tasks()`），不是记号
 * 消失了、看板上却还是离线时的本地快照。
 */
describe('App：离线记号还有两处触发点——SSE 重连和 60 秒心跳（复审 C2），恢复联网顺手 reload（复审 I3）', () => {
  it('SSE 重连（onOpen）会刷新离线记号，恢复联网时顺手 reload 一次', async () => {
    setApiBase('http://192.168.1.5:30035');
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!healthy) throw new Error('offline');
      return desktopHealthy();
    }));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });
    await waitFor(() => expect(handlers.onOpen).toBeDefined());
    const fetchCountBeforeRecovery = tasksFetchCount;

    // isOnline() 探测结果缓存 5 秒（dataSource.ts 的 ONLINE_CACHE_MS）——
    // 真实场景里 SSE 断线重连总要经过几秒钟，缓存早过期了；这里同一个测试
    // 里瞬间从「刚探测过一次」跳到「触发重连」，中间没有真实时间流逝，不清
    // 缓存的话 isOnline() 会直接把上一次「离线」的缓存值原样吐回来，
    // 探测都不会重新发生——这不是产品代码的 bug，是测试没有时间流逝这件事
    // 本身要单独处理。
    resetOnlineCache();
    healthy = true; // 联网恢复
    act(() => handlers.onOpen!());

    await waitFor(() => expect(screen.queryByRole('status', { name: '离线' })).toBeNull());
    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(fetchCountBeforeRecovery));
  });

  it('60 秒心跳会刷新离线记号，恢复联网时顺手 reload 一次——不是只有挂载那一次会去问', async () => {
    setApiBase('http://192.168.1.5:30035');
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!healthy) throw new Error('offline');
      return desktopHealthy();
    }));
    const intervalSpy = vi.spyOn(window, 'setInterval');
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });

    const tickCall = intervalSpy.mock.calls.find((c) => c[1] === 60_000);
    expect(tickCall, '没有找到 60 秒一次的 setInterval 调用').toBeDefined();
    const tickFn = tickCall![0] as () => void;
    const fetchCountBeforeRecovery = tasksFetchCount;

    // 同上一条测试——isOnline() 的 5 秒缓存在真实的 60 秒心跳之间早过期了，
    // 这里模拟的是瞬间触发，得手动清一次，见上一条测试同一处的注释。
    resetOnlineCache();
    healthy = true; // 联网恢复
    act(() => { tickFn(); });

    await waitFor(() => expect(screen.queryByRole('status', { name: '离线' })).toBeNull());
    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(fetchCountBeforeRecovery));
  });
});

/**
 * task-8-brief：**回到在线就把离线改动推回桌面，推完的结果屏幕上说得出来。**
 *
 * 接线只有一处（`App.tsx` 的 `refreshOffline`），但**叫它的地方有三个**：挂载、
 * SSE `onOpen`（重连）、60 秒心跳。三个各有一条测试——第一类假绿（这个仓库栽过
 * 27 次）说的正是「N 个接线点只覆盖一部分」，而这里恰恰是反过来用它：三条路径
 * 全都能推，才证明「挂在唯一的咽喉上」这个说法是真的，不是只有跃迁那一条能走。
 *
 * `pushBackIfDirty` 是替身（见文件顶部那段 `vi.mock('./lib/pushBack.js')` 的注释），
 * 汇总里的数字**特意避开 0 和 1**（141）：`已把 1 条…` 这种句子在「数字传丢了、
 * 落回某个默认值」的坏法下照样长得对。
 */
describe('App：回到在线就把离线改动推回桌面（task-8-brief）', () => {
  /** 从「连不上」翻到「连得上」的那台手机。返回 60 秒心跳的那个回调，用法见上一组。 */
  const renderRecovering = async () => {
    setApiBase('http://192.168.1.5:30035');
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!healthy) throw new Error('offline');
      return desktopHealthy();
    }));
    const intervalSpy = vi.spyOn(window, 'setInterval');
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });
    const tickCall = intervalSpy.mock.calls.find((c) => c[1] === 60_000);
    expect(tickCall, '没有找到 60 秒一次的 setInterval 调用').toBeDefined();
    /** 触发一次 60 秒心跳。`resetOnlineCache()` 的理由见上一组同一处注释。 */
    const tick = () => {
      resetOnlineCache();
      act(() => { (tickCall![0] as () => void)(); });
    };
    return {
      tick,
      /** 联网恢复，然后触发一次心跳。 */
      recover: () => { healthy = true; tick(); },
    };
  };

  /** 一直连得上的桌面/手机。 */
  const renderOnline = () => {
    setApiBase('http://192.168.1.5:30035');
    vi.stubGlobal('fetch', vi.fn(async () => desktopHealthy()));
    return render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
  };

  it('从离线翻回在线（60 秒心跳这条路）：推一次，然后刷新一次', async () => {
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 2, conflicted: 0, revived: 0 });
    const { recover } = await renderRecovering();
    const pushesBefore = vi.mocked(pushBackIfDirty).mock.calls.length;
    const fetchesBefore = tasksFetchCount;

    recover();

    await waitFor(() => expect(vi.mocked(pushBackIfDirty).mock.calls.length).toBeGreaterThan(pushesBefore));
    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(fetchesBefore));
  });

  it('SSE 重连（onOpen 这条路）也推——不是只有心跳会推', async () => {
    setApiBase('http://192.168.1.5:30035');
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!healthy) throw new Error('offline');
      return desktopHealthy();
    }));
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 2, conflicted: 0, revived: 0 });
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '离线' });
    await waitFor(() => expect(handlers.onOpen).toBeDefined());
    const pushesBefore = vi.mocked(pushBackIfDirty).mock.calls.length;

    resetOnlineCache();
    healthy = true;
    act(() => handlers.onOpen!());

    await waitFor(() => expect(vi.mocked(pushBackIfDirty).mock.calls.length).toBeGreaterThan(pushesBefore));
    expect(await screen.findByText('已把 2 条离线改动推回桌面')).toBeTruthy();
  });

  it('挂载时本来就在线、而脏集非空：也推——手机在飞行模式下被杀掉、回到 Wi-Fi 之后才重开，那一刻没有任何「跃迁」', async () => {
    // 这条是「只挂在离线→在线跃迁那一刻」那种写法唯一挡不住的场景：`offline`
    // 初值就是 `false`，第一次探测判在线，跃迁永远不发生，脏集里的东西永远推不回去。
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 3, conflicted: 0, revived: 0 });
    renderOnline();

    await waitFor(() => expect(pushBackIfDirty).toHaveBeenCalled());
    expect(await screen.findByText('已把 3 条离线改动推回桌面')).toBeTruthy();
  });

  it('一直在线、脏集是空的：不白刷一次整页——60 秒心跳不该变成每分钟一次强制刷新', async () => {
    // `pushBackIfDirty()` **还是会被叫**（它自己判脏集空、一次网络都不发，见
    // lib/pushBack.ts），这条守的是后面那半：它返回 `null` 时不许触发 `reload()`。
    setApiBase('http://192.168.1.5:30035');
    const fetchMock = vi.fn(async () => desktopHealthy());
    vi.stubGlobal('fetch', fetchMock);
    const intervalSpy = vi.spyOn(window, 'setInterval');
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await waitFor(() => expect(pushBackIfDirty).toHaveBeenCalled());
    const tickFn = intervalSpy.mock.calls.find((c) => c[1] === 60_000)![0] as () => void;
    const probesBefore = fetchMock.mock.calls.length;
    const pushesBefore = vi.mocked(pushBackIfDirty).mock.calls.length;
    const fetchesBefore = tasksFetchCount;

    resetOnlineCache();
    act(() => { tickFn(); });

    // 先等这一拍真的跑完（探测发生过、推也叫过），不然下面「没多刷」测的只是
    // 「还没来得及刷」——那种绿是假的。
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(probesBefore));
    await waitFor(() => expect(vi.mocked(pushBackIfDirty).mock.calls.length).toBeGreaterThan(pushesBefore));
    expect(tasksFetchCount).toBe(fetchesBefore);
    expect(screen.queryByText(/离线改动/)).toBeNull();
  });

  it('撞车了：报出冲突条数，指向顶上那条冲突横幅，而那条横幅真的会出来', async () => {
    // 撞车不是错误——你那份进了冲突副本，去看一眼。两个数字都要报出来：只报
    // 「有冲突」不说推回去几条，用户分不清是「全撞了」还是「大部分回去了」。
    //
    // 冲突副本是**这次推送**在服务端刚写出来的，挂载那次 reload 早就拉过一轮
    // `api.conflicts()` 了，那时候还没有它。所以这里让替身在返回汇总的同时把
    // 服务端那份也改掉——横幅要出得来，只能靠**推完之后再刷一次**。这条同时钉住
    // 「先推后刷」这个顺序：反过来先刷再推的话，拉到的是推送之前的状态，横幅照样
    // 出不来。
    vi.mocked(pushBackIfDirty).mockImplementation(async () => {
      currentConflicts = [{ kind: 'tasks', file: 't1 的冲突副本 2026-08-21.json' }];
      return { pushed: 2, conflicted: 3, revived: 0 };
    });
    renderOnline();

    const toast = await screen.findByText(/条撞车/);
    expect(toast.textContent).toContain('推回 2 条');
    expect(toast.textContent).toContain('3 条撞车');
    // 指向顶上那条常驻横幅（App.tsx 里 aria-label 就叫「同步冲突」）——不指
    // 的话「已另存成冲突副本」是句没有下文的话，用户不知道去哪看。
    expect(toast.textContent).toContain('同步冲突');

    const banner = await screen.findByRole('alert', { name: '同步冲突' });
    expect(banner.textContent).toContain('1 个文件');
  });

  it('推成功和撞车是两档严重程度：success / warning，不是同一档 info', async () => {
    // 混成一档 info 的话，「全推回去了」和「三条撞车等你处理」在屏幕上长得一模一样。
    // 顺带钉住颜色：这三档的图标色 theme.ts 压成了你的墨/过期橙，一点群青都不带——
    // 群青（colorPrimary）是 AI 产出内容的配额，同步/冲突不许借。
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 3, conflicted: 0, revived: 0 });
    const { unmount } = renderOnline();
    await screen.findByText('已把 3 条离线改动推回桌面');
    expect(document.querySelector('.ant-message-success')).toBeTruthy();
    expect(document.querySelector('.ant-message-info')).toBeNull();
    unmount();

    resetOnlineCache();
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 2, conflicted: 3, revived: 0 });
    renderOnline();
    await screen.findByText(/条撞车/);
    expect(document.querySelector('.ant-message-warning')).toBeTruthy();
    expect(document.querySelector('.ant-message-info')).toBeNull();
  });

  it('全判成「两边本来就一样」那一拍：离线删掉的又回来了，屏幕上得有东西解释——不许默默复活', async () => {
    // 决定⑥那张表最后一行：旧格式的脏记号没有基准，删除判不出桌面这期间动没动过
    // → 不删。于是「推回 0 条、撞车 0 条」，success/warning 两档一档都不成立，而推完
    // 那次 reload 会把那几条任务重新拉回看板上。这一整批要消灭的正是这种「界面自己
    // 变了、屏幕上一个字都没有」（整分支审查 M3）。
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 0, conflicted: 0, revived: 2 });
    renderOnline();

    const toast = await screen.findByText(/离线删掉的没带基准/);
    expect(toast.textContent).toContain('2 条');
    // 光说「没删」不够，要说清后果和怎么收场。收件箱那半也数进 revived（见
    // pushBack.ts 的 revivedCount），所以复活的地方不能只写「看板」。
    expect(toast.textContent).toContain('会重新出现');
    expect(toast.textContent).toContain('随手记回收件箱');
    expect(toast.textContent).toContain('再删一次');
    // 既不是错误也不是「推成功了」：用 info 这一档。theme.ts 把 colorInfo 一并压成了
    // 你的墨（56-81 行），群青是 AI 产出内容的配额，同步/冲突一点都不许借。
    expect(document.querySelector('.ant-message-info')).toBeTruthy();
    expect(screen.queryByText(/已把 .* 条离线改动推回桌面/)).toBeNull();
  });

  it('既推成功了又有复活的：两句都说——复活那件事不许被「已把 N 条推回桌面」盖掉', async () => {
    // 旧版本升上来的那台手机的常态：同一批里既有改过的（推成功）又有删掉的（没基准、
    // 不删）。这一句要是接在 success/warning 那条链**后面**当 else，这一拍就只会看到
    // 「已把 3 条推回桌面」，而屏幕上凭空多出来的那两条任务照样没人解释。
    vi.mocked(pushBackIfDirty).mockResolvedValue({ pushed: 3, conflicted: 0, revived: 2 });
    renderOnline();

    expect(await screen.findByText('已把 3 条离线改动推回桌面')).toBeTruthy();
    expect(await screen.findByText(/离线删掉的没带基准/)).toBeTruthy();
  });

  it('推送本身报错：弹红字、不假装推成功，也不挡住后面的刷新', async () => {
    // 这一整批从头到尾防的就是「静默」。把这个 catch 吞成「推完了」，用户以为
    // 改动回去了、其实还在手机上——这也是「一条畸形条目让整批永远 400」
    // （Task 6 复审 M3）唯一会被人看见的地方。
    // 服务端那句话原样带上来（`req()` 把 400 响应体里的 error 字段包成 Error）。
    // 夹具用的是真实的那一句，**带 id**——「哪条卡住了」这个信息服务端刚判完就知道，
    // 一路传到屏幕上才算数，断在中间任何一层用户都还是没辙。
    vi.mocked(pushBackIfDirty).mockRejectedValue(
      new Error('任务里的「坏掉的那条-9527」（第 2 条）不合形状，这一批整批没推'),
    );
    const { recover } = await renderRecovering();
    const fetchesBefore = tasksFetchCount;

    recover();

    const toast = await screen.findByText(/把离线改动推回桌面时出错/);
    expect(toast.textContent).toContain('坏掉的那条-9527');
    // 说清后果：东西还在本地，不是丢了，也不用手动重来。
    expect(toast.textContent).toContain('改动还留在本地');
    expect(document.querySelector('.ant-message-error')).toBeTruthy();
    // 不假装成功。
    expect(screen.queryByText(/已把 .* 条离线改动推回桌面/)).toBeNull();
    // 推砸了不该连累「翻回在线要刷一次」——横幅已经说「现在是在线的」了，
    // 看板还停在离线快照上就成了互相打脸。
    await waitFor(() => expect(tasksFetchCount).toBeGreaterThan(fetchesBefore));
  });

  it('修不掉的那种错误不许每分钟叠一条：连着两拍都失败，屏幕上还是只有一条', async () => {
    // 一条畸形条目让整批**永远** 400，而心跳每 60 秒跑一拍——不去重的话它每分钟往
    // 屏幕上堆一条同样的红字，是在惩罚用户。固定 `key` 让 antd 换掉那一条。
    vi.mocked(pushBackIfDirty).mockRejectedValue(new Error('任务里的「坏掉的那条-9527」（第 2 条）不合形状'));
    const { recover, tick } = await renderRecovering();

    recover();
    await screen.findByText(/把离线改动推回桌面时出错/);
    const pushesAfterFirst = vi.mocked(pushBackIfDirty).mock.calls.length;

    tick();
    // **第二拍真的失败过一次**，这句不能省：不等它，「屏幕上只有一条」可能只是因为
    // 第二条压根还没来得及弹——那种绿是假的，跟去重一点关系都没有。
    await waitFor(() => expect(vi.mocked(pushBackIfDirty).mock.calls.length).toBeGreaterThan(pushesAfterFirst));

    // 断的是**屏幕上真的有几条**，不是「message.error 被调用过几次」——调用两次正是
    // 预期行为，去重是 antd 那一侧按 key 做的，只数调用次数证明不了界面上的结果。
    expect(screen.getAllByText(/把离线改动推回桌面时出错/)).toHaveLength(1);
  });
});

/**
 * 本地通知的接线（真机上到底弹没弹、重启后还在不在，在 android/冒烟清单.md
 * 第 9 步——这里守的是接线和界面，不是插件）。
 *
 * 接线点只有一个：`tasks` state。设计正本第十一节要的两个触发点在 App.tsx 里
 * 本来就汇成同一件事（SSE `onChange` → `reload()` → `setTasks`；离线
 * `onLocalWrite` → 同一个 `reload()`）。这个文件验在线那半，
 * `OfflineWrite.test.tsx` 验离线那半——两条路各一条测试，不是只验一条就宣布
 * 「单一接线点覆盖全部」（那正是 28 次假绿的说法本身）。
 */
describe('本地通知接线：tasks 是唯一输入，权限被拒挂常驻记号', () => {
  const notifBanner = () => screen.queryByRole('status', { name: '通知权限' });

  it('挂载拉到任务之后，把这一份整包交给重排（不是只交改动的那条）', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications))
      .toHaveBeenCalledWith(currentTasks, expect.any(Date)));
  });

  // 复审 C1。挂载那一帧的 effect 跑在 `reload()` 落地之前，那一轮手里的 `tasks`
  // 还是初值 `[]`——拿它去重排就是「只取消、没得排」，手机上已排的那些被**硬删**
  // （`cancel()` 底下是 `storage.deleteNotification()`，开机 receiver 也捞不回），
  // 而界面完全沉默。窗口也不是毫秒级：离线开 App 时 `reload()` 卡在 `isOnline()`
  // 那个 1.5 秒探测后面；`reload()` 抛出去的话窗口**无界**——`route()` 在 `http()`
  // 抛时不回退本地，`tasks` 就一直停在 `[]`，每一轮重排都只是把手机清空。典型
  // 触发是出门那一刻 Wi-Fi 切蜂窝，而那正是本地通知最该顶用的时刻。
  it('第一次 reload 还没成功过：一次都不排——空数组是「还不知道」，不是「一条都没有」', async () => {
    vi.mocked(api.tasks).mockRejectedValueOnce(new Error('拉任务失败'));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 等这一轮 reload 真的失败完（这条红字是它 catch 里弹的），此刻 `tasks`
    // 仍是初值 `[]`——不等的话「还没排」可能只是因为还没轮到它。
    await screen.findByText('拉任务失败');
    expect(vi.mocked(rescheduleLocalNotifications)).not.toHaveBeenCalled();

    // 闸门的含义是「还没读到过」，不是「从此别排了」：下一次 reload 成功就照常排。
    act(() => handlers.onChange?.('tasks'));
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications))
      .toHaveBeenCalledWith(currentTasks, expect.any(Date)));
  });

  // 同一道闸门的反面，**按住「别拿 `tasks.length === 0` 当判据」**：用户真把任务
  // 全删光的那一格必须照常重排，那一轮什么都不排、只把昨天排的取消掉。拿长度当
  // 闸门的话这条会红，而上面那条照样绿。
  it('任务真的被删光：照样拿空数组重排（昨天排的那些得取消）', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications))
      .toHaveBeenCalledWith([], expect.any(Date)));
  });

  it('在线那条路：SSE 报 tasks 变了 → reload → 拿着新的那份再排一次', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalled());

    // **换成一份新数据**，不是原地改：`api.tasks()` 每次返回的都是新解析出来的
    // 数组，effect 认的就是这个 identity。断言也断在**内容**上而不是「调用次数
    // 涨了」——多调一次可能只是拿着上一轮的闭包又排了一遍旧数据，那种绿是假的。
    currentTasks = [task({ id: 't2', title: '买菜' })];
    act(() => handlers.onChange?.('tasks'));

    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications))
      .toHaveBeenCalledWith(currentTasks, expect.any(Date)));
  });

  it('权限被拒：常驻石墨记号，说清后果（一条都不会响）和出路（去系统里开）', async () => {
    vi.mocked(rescheduleLocalNotifications).mockResolvedValue('denied');
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    const banner = await screen.findByRole('status', { name: '通知权限' });
    expect(banner.textContent).toContain('通知权限没开，到点手机不会响');
    // 出路：不说去哪开等于只报警不指路（跟离线横幅同一条教训）。
    expect(banner.textContent).toContain('设置 → 应用 → 办事师爷 → 通知');
    // **承诺只许说做得到的**（复审 Important）：记号是重排的返回值翻出来的，
    // 而重排只挂在 `tasks` 上——从系统设置页切回来不会让 `tasks` 变（没有
    // resume 监听，也不该为它加一个），所以横幅不许说「回到这里自己就消失」，
    // 得说出真正会让它消失的那件事。
    expect(banner.textContent).toContain('改一条任务、或者重开应用');
    // 常驻记号，不是 toast——石墨那一族的类名，样式守卫在 theme.css.test.ts。
    expect(banner.className).toContain('ink-notif-banner');
  });

  it('非原生壳（桌面/浏览器）：一条记号都不挂——「什么都没发生」这一格是对的沉默', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 先等重排真的跑过一轮：不等的话「没有横幅」可能只是因为还没轮到它，
    // 那种绿跟这条断言守的东西没有关系。
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalled());
    expect(notifBanner()).toBeNull();
  });

  // ⚠️ 名字改准过一次（复审 Important）：这条触发重排用的是
  // `handlers.onChange('tasks')`——**一次数据变更**，不是「从系统设置页切回来」。
  // 原来的名字写着「不用回来点任何东西」，而测试里根本没有「切回来」这件事
  // （也造不出来：没有 resume 监听，`tasks` 不变就不重排）。名字说成那样，它
  // 就成了一条替横幅那句做不到的承诺背书的假绿。
  it('权限好了之后的下一次数据变更：重排返回 ok，记号跟着消失（不用手动关）', async () => {
    vi.mocked(rescheduleLocalNotifications).mockResolvedValue('denied');
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('status', { name: '通知权限' });

    vi.mocked(rescheduleLocalNotifications).mockResolvedValue('ok');
    currentTasks = [task({ id: 't2', title: '买菜' })];
    act(() => handlers.onChange?.('tasks'));

    await waitFor(() => expect(notifBanner()).toBeNull());
  });

  it('重排自己抛了：文案说出「此刻这台手机可能一条提醒都没有」，不是轻描淡写的一句失败', async () => {
    // 抛出来的时候 `cancel()` 可能已经跑过了（`schedule()` 自己 reject 那条挪
    // 不掉，它就是排程本身，见 notifyNative.ts）——真实状态是**旧的全取消了、
    // 新的一条没排上**。一句「通知排程失败」会让人以为提醒还在。
    vi.mocked(rescheduleLocalNotifications).mockRejectedValue(new Error('not implemented on android'));
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    const toast = await screen.findByText(/重排本地通知失败/);
    expect(toast.textContent).toContain('not implemented on android');
    expect(toast.textContent).toContain('这台手机到点不会响');
    expect(document.querySelector('.ant-message-error')).toBeTruthy();
    // 出错不冒充「权限被拒」：那条横幅说的是另一件事（去系统里开权限也修不了
    // 这个），挂上去只会把人指到错的地方。
    expect(notifBanner()).toBeNull();
  });
});

/**
 * **分享接入的接线**（share-target 那一批 Task 4）：别的 App 里选中文字 →
 * 分享到「办事师爷」→ 进收件箱。
 *
 * 这一族测试守的是**三个 Task 之间的接缝**，不是任何一个 Task 内部：Task 1 的
 * 判断（`sharePlan.ts`，15 条自己的测试）× Task 3 的订阅（`shareNative.ts`，
 * 7 条自己的测试）× `api.addInbox` 的写入。三边各自都绿、中间那两道缝一次没被
 * 穿过，正是 parked-all 第 157 条那个家族（上一批两条 Critical 都长在这种地方）。
 * 所以这里**一条都不 mock 中间层**，只把最外面那个 Capacitor 插件换成替身
 * （见文件上方 `vi.mock('./lib/shareNative.js')` 那段）。
 *
 * 「什么都没发生」的三格全部清点了（parked-all 第 155 条）：普通启动、
 * 是分享但没文字、压根不在原生壳里。前两格的断言**都不是干等一拍看有没有事
 * 发生**——那种绿分不出「守卫真的挡住了」和「订阅根本就没活着」，两格都紧跟着
 * 补发一条真的分享当活性证明。
 */
describe('App：分享进来的文字，走随手记同一条路进收件箱', () => {
  beforeEach(() => {
    // `mockReset()` 一并清掉 `mockRejectedValueOnce` 排的队（@vitest/spy 的
    // `mockReset` 会把 `onceMockImplementations` 清空）——失败那一格万一断言先
    // 抛出去、没消费掉那次 reject，不许漏给后面的测试。清完补一个稳定的成功值：
    // 这个文件别处（随手记）也用它，`mockReset` 之后不补实现的话它会返回
    // undefined，`.then` 直接炸。
    vi.mocked(api.addInbox).mockReset().mockResolvedValue(
      { id: 'i-shared', text: '', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
    );
  });

  /** 渲染并等到分享订阅真的挂上——之后 `emitShared!(…)` 打的才是活着的那棵树。 */
  const renderShared = async () => {
    const r = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(emitShared).not.toBeNull());
    return r;
  };

  it('浏览器分享一个带标题的链接：整份文字交给 api.addInbox（标题在前、换行、正文在后），只交一次', async () => {
    await renderShared();

    act(() => { emitShared!({ action: ACTION_SEND, type: 'text/plain', subject: '排期表', text: 'https://example.invalid/q3' }); });

    await waitFor(() => expect(vi.mocked(api.addInbox).mock.calls.length).toBe(1));
    // 断的是**整份实参**、而且只调一次，不是「被调过」（parked-all 第 158 条：
    // 替身切得对，穿过替身的那份数据却没人验）。只断「被调过」的话，接线只把
    // `text` 传下去、或者把标题和正文拼反、或者一条分享写进两条，全都是绿的。
    expect(vi.mocked(api.addInbox).mock.calls[0]![0]).toBe('排期表\nhttps://example.invalid/q3');
    // 走的是随手记那一个调用，不是新开的写入路径——这里没有第二个能写收件箱
    // 的东西可断，「只有它被调过」就是这条约束在这一层的形状。
    const toast = await screen.findByText(/已存进收件箱/);
    expect(toast.textContent).toContain('排期表');
  });

  it('存进去了要说一声：主看板停在「今天」、新条目根本不在屏幕上，这句是唯一的落地信号', async () => {
    await renderShared();
    // 前提就在这两条断言里：分享落地那一刻他看的是「今天」；收件箱那一屏虽然
    // 一直挂在树上（keepMounted，见 App.tsx 里 `keepMounted` 那两段注释），却带着原生 `hidden`
    // ——不在可访问树里，也就是新条目**真的不在他眼前**。这正是这个仓库
    // 「成功不说话」那条规矩的前提（结果就在屏幕上）在这条路径上不成立的地方。
    expect(navButton(/今天/).getAttribute('aria-current')).toBe('page');
    const inboxPanel = document.querySelector('.ink-view-panel-inbox') as HTMLElement;
    expect(inboxPanel.hidden).toBe(true);

    act(() => { emitShared!({ action: ACTION_SEND, text: '买酱油' }); });

    const toast = await screen.findByText(/已存进收件箱/);
    expect(toast.textContent).toContain('买酱油');
    // 成功那一格不是红的：绿字那族，不是 `.ant-message-error`。
    expect(document.querySelector('.ant-message-error')).toBeNull();
    // **不切去处**：他分享完多半直接切回原来那个 App，把看板从「今天」掀到
    // 「收件箱」是他没要过的副作用（连分享三条还会被掀三次）。
    expect(navButton(/今天/).getAttribute('aria-current')).toBe('page');
    expect(inboxPanel.hidden).toBe(true);
  });

  it('存完不多刷一次收件箱：在线靠 SSE、离线靠 onLocalWrite，跟随手记一模一样', async () => {
    await renderShared();
    // 挂载那一轮把 reload() 跑完再数——`rescheduleLocalNotifications` 挂在
    // `tasks` 上，它响过就说明 reload() 里排在 tasks 前面的 `api.inbox()` 早落定了。
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalled());
    // 基线**当场数出来**，不写死一个数：挂载时拉几次收件箱是别处的事，这条只
    // 关心「分享之后有没有多出来一次」。
    const before = vi.mocked(api.inbox).mock.calls.length;

    act(() => { emitShared!({ action: ACTION_SEND, text: '买酱油' }); });
    await screen.findByText(/已存进收件箱/);

    expect(vi.mocked(api.inbox).mock.calls.length).toBe(before);
  });

  it('写失败：说清「没存进去」和「回去重新分享一次」，不是一句轻描淡写的失败', async () => {
    vi.mocked(api.addInbox).mockRejectedValueOnce(new Error('磁盘满了'));
    await renderShared();

    act(() => { emitShared!({ action: ACTION_SEND, text: '买酱油' }); });

    const toast = await screen.findByText(/分享的内容没存进收件箱/);
    expect(toast.textContent).toContain('磁盘满了');
    // **出路是这条文案的一半**：`route()` 在线那一支失败之后不回落本地
    // （dataSource.ts 的 `route()`），所以这段文字哪儿都没写成、本地也没有——不指路的话
    // 他不知道该干什么，而那段文字还在他刚才那个 App 里，回去重发一次是全部代价。
    // 这句指路型文案的正确性取决于读它的人，而这条路径上的读者只有一种
    // （刚从别的 App 分享过来的人），对他成立（parked-all 第 149/155 条）。
    expect(toast.textContent).toContain('回去重新分享一次');
    expect(document.querySelector('.ant-message-error')).toBeTruthy();
    // 失败不许同时冒充成功。
    expect(screen.queryByText(/已存进收件箱/)).toBeNull();
  });

  it('普通点图标启动（ACTION_MAIN）：一个字都不写、一句都不说——这条路每次启动都会走到', async () => {
    await renderShared();

    // 原生那半对每一次 onNewIntent 都发事件、不筛（判断落进 Java 就只剩真机
    // 可验），所以这一格是**最常跑的一格**，为它弹一句提示等于把正常启动变成报错。
    act(() => { emitShared!({ action: 'android.intent.action.MAIN' }); });
    // 活性证明：紧跟着发一条真的分享。它到得了，就说明这根管子是通的，上面那条
    // 确实是被 sharePlan 的 action 闸门挡下来的，而不是订阅压根没活着。
    act(() => { emitShared!({ action: ACTION_SEND, text: '买酱油' }); });

    await waitFor(() => expect(vi.mocked(api.addInbox).mock.calls.length).toBe(1));
    expect(vi.mocked(api.addInbox).mock.calls[0]![0]).toBe('买酱油');
    expect(document.querySelector('.ant-message-error')).toBeNull();
  });

  it('是分享、但正文只有空白：同样一个字都不写、一句都不说（有意的沉默，理由在 App.tsx 那段注释里）', async () => {
    await renderShared();

    // 全角空格也算空白（`trim()` 那套 Unicode 白名单，sharePlan.ts 有专测）。
    // **这一格屏幕上不说话是算过账的、不是漏了**：manifest 只声明 text/plain，
    // 分享图片时「办事师爷」压根不在系统分享菜单里；而剩下这一格要在 App.tsx 判出来
    // 就得再订一次 `onShared`，那个第二监听者恰恰拿不到冷启动那条分享
    // （Plugin.java:629/636 只在第一个监听者注册时补发，:719 补发前先 remove）
    // ——一道在最需要它时不会响的提示，不是守卫。
    act(() => { emitShared!({ action: ACTION_SEND, type: 'text/plain', text: '　 \n\t' }); });
    act(() => { emitShared!({ action: ACTION_SEND, text: '买酱油' }); });

    await waitFor(() => expect(vi.mocked(api.addInbox).mock.calls.length).toBe(1));
    expect(vi.mocked(api.addInbox).mock.calls[0]![0]).toBe('买酱油');
    expect(document.querySelector('.ant-message-error')).toBeNull();
  });

  it('桌面/浏览器（插件不在）：压根不订阅——断在「没订上」这一层，不靠「addInbox 没被调」倒推', async () => {
    shareAvailable = false;
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 先等首屏真的落定：不等的话「没订上」可能只是还没轮到那个 effect，
    // 那种绿跟这条断言守的东西没关系。
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalled());
    expect(emitShared).toBeNull();
    expect(shareUnsub).not.toHaveBeenCalled();
  });

  it('卸载就退订：`subscribeShare` 的返回值直接当 effect 的 cleanup 用，恰好退一次', async () => {
    const { unmount } = await renderShared();
    // 卸载之前一次都没退过——少了这句，「退过一次」也可能是反复退订重订抖出来的
    // （依赖数组里塞了会变的东西就长那样）。
    expect(shareUnsub).not.toHaveBeenCalled();

    unmount();

    expect(shareUnsub).toHaveBeenCalledTimes(1);
  });

  it('长文本只在提示里露一小段，按码点切不按 length 切（emoji 不会被劈成半个）', async () => {
    await renderShared();
    // 25 个 emoji，每个占两个 UTF-16 码元：`text.slice(0, 24)` 会切在第 12 个的
    // 中间、渲染出一个替换字符。分享来的文字里 emoji 很常见，不是边角料。
    const text = '🍎'.repeat(25);

    act(() => { emitShared!({ action: ACTION_SEND, text }); });

    const toast = await screen.findByText(/已存进收件箱/);
    expect(toast.textContent).toBe(`已存进收件箱：${'🍎'.repeat(24)}…`);
    expect(toast.textContent).not.toContain('�');
    // **截断只发生在这句提示上**：存进收件箱的是整份原文。
    expect(vi.mocked(api.addInbox).mock.calls[0]![0]).toBe(text);
  });
});

/**
 * 实测 UI/UX 那一轮补的两条：都是「什么时候**不该**说话」，两条都没有测试
 * 守过——条件渲染少一个条件不会让任何既有断言变红，只会在界面上多出一句
 * 常驻的废话，而废话是这个仓库文案约定里最贵的那种问题。
 */
describe('App：两处「不该说话就闭嘴」', () => {
  it('收件箱空的时候，顶栏不挂一句「收件箱 0 条待拆解」', async () => {
    currentInbox = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(handlers.onChange).toBeDefined());

    expect(screen.queryByText(/条待拆解/)).toBeNull();
  });

  it('有待拆的时候照样说——上一条不是把整句删了', async () => {
    currentInbox = [{ id: 'i1', text: '随手记一句', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    expect(await screen.findByText(/条待拆解/)).toBeDefined();
  });

  it('**「回顾」这一屏整个不挂那条脚注**——那句「怎么再跑一遍」由这一屏自己常驻的那颗按钮说（ReviewView 的 runBlock），脚注说的是另一件事（有 N 条过期了），两句上下摆着就是一句话说两遍', async () => {
    // 过期没做完的任务：countStale 数的就是这种，脚注的第一个条件。
    currentTasks = [task({ due: '2020-01-01T00:00:00.000Z', status: 'todo' })];
    currentInsights = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 别的视图上照旧挂着（默认落在「今天」）——先钉住这一半，不然下面那半
    // 就算把整条脚注删光了也一样绿。
    expect(await screen.findByText(/条已经过期了/)).toBeDefined();

    fireEvent.click(navButton(/^回顾/));

    await waitFor(() => expect(screen.queryByText(/条已经过期了/)).toBeNull());
    // 换成这一屏自己那颗按钮：脚注只是路标，真正能点的出口在这儿。
    // **按名字找 button，不是找一段文字**：把按钮退化成一句说明也该变红。
    // **不再断言空状态**：有一条过期任务时「这一周该过一遍的」就会列出
    // 「1 条已经过期」，这一屏不再是空的——那正是加那份清单要的效果。
    expect(await screen.findByRole('button', { name: /让 AI 回顾一遍/ })).toBeDefined();
  });

  /**
   * 上一条的另一半，也是它自己挖出来的坑：抑制的判据是「回顾视图这一刻显示的
   * 是不是空状态」，不是「人在不在回顾视图上」。
   *
   * 只写上一条的话，一句 `view !== 'review'` 就能让它全绿——而那样写的代价是
   * 这条场景：回顾视图上摆着上一轮的观察（所以空状态不渲染）、同时又攒了过期
   * 任务，脚注被挡掉、空状态又不出现，「怎么再跑一次」在那一屏上一个出口都不剩。
   * 两条测试互为上下限，缺一条另一条就挡不住对面那个错误实现。
   */
  it('「回顾」视图**有观察**的时候也不挂脚注——那颗「让 AI 回顾一遍」由这一屏自己常驻着，不靠空状态、也不靠脚注', async () => {
    currentTasks = [task({ due: '2020-01-01T00:00:00.000Z', status: 'todo' })];
    currentInsights = [{
      id: 'ins1', kind: 'note', text: '一句上一轮留下的观察', taskIds: [],
      createdAt: '2026-08-10T00:00:00.000Z', dismissedAt: null,
    }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    expect(await screen.findByText(/条已经过期了/)).toBeDefined();

    fireEvent.click(navButton(/^回顾/));

    // 观察本身渲染出来了（确认这一屏真的进了「非空」那条分支，不是压根没切过去）。
    expect(await screen.findByText(/一句上一轮留下的观察/)).toBeDefined();
    // 空状态不在（有观察时它本来就不渲染）。
    expect(screen.queryByText(/还没有回顾/)).toBeNull();
    // 脚注也不在——它说的是另一件事（有 N 条过期了），跟下面这句上下摆着
    // 就是一句话说两遍。
    expect(screen.queryByText(/条已经过期了/)).toBeNull();
    // 「怎么再跑一遍」由这一屏自己常驻的那颗按钮说。
    expect(screen.getByRole('button', { name: /让 AI 回顾一遍/ })).toBeDefined();
  });
});

/**
 * 分组排序**一个去处一份**（仿滴答清单：排序方式是每份清单自己记住的）。
 * 存取判据在 `lib/grouping.test.ts`，这里测的是接线里唯一会错的那件事：
 * 换了去处之后，界面上显示的是不是**那个去处**的档。
 */
describe('分组排序跟着去处走', () => {
  const groupSelect = () => screen.getByLabelText('分组') as HTMLSelectElement;

  it('在「全部」里改成按清单，翻到「已完成」还是默认档，翻回来又是按清单', async () => {
    currentTasks = [task({ title: '写周报', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());

    fireEvent.click(navButton(/全部/));
    await waitFor(() => expect(groupSelect()).toBeTruthy());
    fireEvent.change(groupSelect(), { target: { value: 'list' } });
    await waitFor(() => expect(groupSelect().value).toBe('list'));

    // 换个去处：不该跟着变——两份清单想要的顺序本来就不一样。
    // 「已完成」有它自己的默认档（按完成时间，见 lib/grouping.ts 的
    // VIEW_DEFAULT），所以这里更严：不只是「没跟着变成按清单」，而是
    // **回到了它自己的那一档**。
    fireEvent.click(navButton(/已完成/));
    await waitFor(() => expect(groupSelect().value).toBe('completed'));

    // 翻回来，那个去处自己的档还在。
    fireEvent.click(navButton(/全部/));
    await waitFor(() => expect(groupSelect().value).toBe('list'));
  });
});

/**
 * 编辑智能清单的筛选条件（仿滴答清单）。侧栏那一项在 `Sidebar.test.tsx`；
 * 这里测弹窗这一端：预填的是那份存下来的筛选、只发 `filter`、空筛选存不得。
 */
describe('App：改一份智能清单的筛选条件', () => {
  const SMART: List = {
    id: 's1', name: '本周要紧的', color: '#C2410C', folderId: null, order: 0, archived: false,
    filter: {
      status: [], listIds: [], tags: [], priority: [3], contexts: [], dueWithinDays: null,
      hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
    },
  };

  const openEditor = async () => {
    currentLists = [SMART];
    currentTasks = [task({ id: 'a', title: '写周报', priority: 3, due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(screen.getByLabelText('清单 本周要紧的 的更多操作')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('清单 本周要紧的 的更多操作'));
    const hit = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent === '编辑筛选条件');
      if (!found) throw new Error('菜单里没有「编辑筛选条件」');
      return found;
    });
    fireEvent.click(hit);
    await screen.findByText(/编辑「本周要紧的」的筛选条件/);
  };

  /**
   * **一份缺字段的智能清单，打开「编辑筛选条件」不该崩。**
   *
   * `data/lists/` 里的 filter 少一个字段是有来路的（手改、旧版本存下来的、同步
   * 过来的半截文件——`smartFilter.ts` 那段注释里写着这个威胁模型，服务端的
   * `checkSmartFilter` 只拦得住经过 API 写进来的）。那一批为此加了
   * `normalizeFilter`，补在「三个消费点」上，**漏了这一个**。
   *
   * 而它偏偏是**修复路径**：清单坏了，人自然会来点「编辑筛选条件」重存一次。
   * 这儿崩了就只剩手改 JSON 一条路。
   *
   * 夹具挑的是 `noList: true` 且 `listIds` 缺失——`FilterBar` 里
   * `[...group.listIds, NO_LIST]` 那个展开会当场抛，正是这条路上真实的崩法。
   */
  it('筛选条件少了字段也打得开——那是坏清单唯一的修复入口', async () => {
    currentLists = [{ ...SMART, filter: { noList: true } as unknown as SmartFilter }];
    currentTasks = [task({ id: 'a', title: '写周报', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(screen.getByLabelText('清单 本周要紧的 的更多操作')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('清单 本周要紧的 的更多操作'));
    const hit = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent === '编辑筛选条件');
      if (!found) throw new Error('菜单里没有「编辑筛选条件」');
      return found;
    });
    fireEvent.click(hit);
    // 弹窗真的开出来了 = 没崩。
    await screen.findByText(/编辑「本周要紧的」的筛选条件/);
  });

  it('弹窗里那份筛选栏预填的是**存下来的那条**，不是视图上叠着的临时筛选', async () => {
    await openEditor();
    // 存下来的是「优先级 = 高」，筛选栏应该显示它已经选中了。
    const dialog = await screen.findByRole('dialog');
    // 限在下拉那一份：筛选栏下面那句人话预览里也有一个「高」（
    // lib/describeFilter.ts），裸的 getByText 会同时命中两个。
    expect(within(dialog).getByText('高', { selector: '.ant-select-selection-item-content' })).toBeTruthy();
  });

  it('保存只发 filter 一个字段——名字/颜色/位置不该被「改了个档位」顺手动一下', async () => {
    await openEditor();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存筛选条件' }));

    await waitFor(() => expect(api.patchList).toHaveBeenCalled());
    const [id, patch] = (api.patchList as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(id).toBe('s1');
    expect(Object.keys(patch as object)).toEqual(['filter']);
  });
});

/**
 * 「打不开的文件」那条横幅。补的是一个一直空着的承诺——服务端跳过读不出来的
 * 实体文件时只 console.warn 一句，界面上一个字都没有，于是一条同步坏掉的任务
 * 就这么无声消失。
 */
describe('App：打不开的文件', () => {
  it('有坏文件时常驻一条横幅，说清那几条现在不在界面上、而且不是被删了', async () => {
    currentBroken = [{ kind: 'tasks', file: 'a1b2.json' }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    const banner = await screen.findByRole('alert', { name: '打不开的文件' });
    expect(banner.textContent).toContain('1');
    expect(banner.textContent).toContain('不是被删了');
  });

  it('**跟同步冲突分成两条**——冲突是「有两份挑一份」，打不开是「这一条现在读不出来」，两种处置说不到一块去', async () => {
    currentBroken = [{ kind: 'tasks', file: 'a1b2.json' }];
    currentConflicts = [{ kind: 'inbox', file: 'x (冲突副本).json' }];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    expect(await screen.findByRole('alert', { name: '打不开的文件' })).toBeTruthy();
    expect(await screen.findByRole('alert', { name: '同步冲突' })).toBeTruthy();
  });

  it('没有坏文件就不出——一条干净的数据目录不该常驻一条横幅', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    expect(screen.queryByRole('alert', { name: '打不开的文件' })).toBeNull();
  });
});

/**
 * 「跳过重复区块」那颗（WCAG 2.4.1 A 级）。
 *
 * 键盘走查实测（用 CDP 发真的 Tab 键）：模块栏 9 站 + 侧栏 51 站 + 随手记 2 站
 * + 拖拽界线 1 站 = **按 63 下 Tab 才够得着任务那一栏**，而这一串在每个去处都
 * 一模一样地重来。加了这颗之后是 2 下。
 */
describe('App：「跳到任务列表」', () => {
  it('它是 DOM 里第一颗按钮——排在第二位就等于还要先 Tab 过别的东西', async () => {
    // 这颗按钮和落点都是外壳的一部分，不等数据回来就在——所以这里不 await
    // 任何任务文案，省得跟别处的夹具状态耦合。
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const skip = screen.getByRole('button', { name: '跳到任务列表' });
    expect(screen.getAllByRole('button')[0]).toBe(skip);
  });

  /**
   * **落点是任务那一栏，不是 `<main>`。** 侧栏就住在 `<main>` 里——焦点送到
   * main 上，下一下 Tab 又回到侧栏第一项，等于什么都没跳过。这条断言钉的就是
   * 这件事：谁把落点改成 main 或者别的祖先，这里当场红。
   */
  it('点它，焦点落到任务那一栏本身', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    const target = document.getElementById('ink-tasks');
    expect(target, '任务那一栏没有 id=ink-tasks，跳过链接就没有落点了').not.toBeNull();
    expect(target!.className).toContain('ink-board-col');
    fireEvent.click(screen.getByRole('button', { name: '跳到任务列表' }));
    expect(document.activeElement).toBe(target);
  });
});

/**
 * 列表顶上常驻的那一行「添加任务」（`QuickAdd`，仿滴答清单）。组件自己的行为
 * 在 `components/QuickAdd.test.tsx` 里测（认时间、清空、失败留字……），这里只
 * 测两件够不到那一层的事：**这一行出现在哪些去处**，以及**它发出去的请求体真的
 * 带上了当前这个去处的预填**。
 */
describe('App：列表顶上那一行「添加任务」', () => {
  const row = () => screen.queryByLabelText('添加任务');

  it('在「全部」这类任务列表上有，在「已完成」里没有——在已完成里建一条待办，它当场就不在这一屏', async () => {
    currentTasks = [];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());

    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    expect(row()).not.toBeNull();

    fireEvent.click(navButton(/已完成/));
    await screen.findByRole('heading', { level: 1, name: '已完成' });
    expect(row()).toBeNull();
  });

  it('站在清单「工作」里打一句话回车，请求体里 listId 就是这个清单——预填跟「新任务」表单同一份', async () => {
    currentTasks = [];
    currentLists = [list({ id: 'L1', name: '工作' })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());

    fireEvent.click(navButton(/工作/));
    await screen.findByRole('heading', { level: 1, name: '工作' });
    const input = row()!;
    fireEvent.change(input, { target: { value: '写周报' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(api.addTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: '写周报', listId: 'L1' }),
    ));
  });
});

/**
 * 右边那一栏详情面板（`TaskDetail`，仿滴答清单第三栏）。面板长什么样在
 * `TaskDetail.test.tsx`，"点开这一条去哪了"在 `TaskGrid`/`TodayView` 各自的
 * 测试里；这里测的是只有整棵树才够得到的四件事：**那一栏真的出现了**、
 * 关得掉、Esc 关得掉、以及那条任务没了它跟着收起来。
 */
describe('App：详情面板', () => {
  const panel = () => screen.queryByRole('complementary', { name: '任务详情' });

  const openFirstRow = async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    // 密度开关那两颗按钮自己在另一个 describe 里有 helper，这一组够不着它
    // （那是块级作用域）——就地点一次，限定在「密度」那个 group 里，别在
    // 整页里按「行」这一个字瞎找。
    fireEvent.click(within(screen.getByRole('group', { name: '密度' })).getByRole('button', { name: '行' }));
    const row = await waitFor(() => {
      const el = document.querySelector('.ink-trow-open');
      if (!el) throw new Error('还没渲染出行档');
      return el as HTMLElement;
    });
    fireEvent.click(row);
    return row;
  };

  it('点行档里一条任务：右边那一栏出现，而且**那一行没有当场膨胀成一张卡**（列表不跳）', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    expect(await waitFor(() => panel()!)).toBeTruthy();
    expect(within(panel()!).getByText('甲任务')).toBeTruthy();
    // 列表那一侧还是一行。`.ink-task-card` 会在面板里出现一张（面板里渲染的
    // 就是 TaskCard），所以限定在视图面板里数，不在整页数。
    const listPanel = document.querySelector('.ink-view-panel-all') as HTMLElement;
    expect(listPanel.querySelector('.ink-trow')).not.toBeNull();
    expect(listPanel.querySelector('.ink-task-card')).toBeNull();
  });

  it('列表里那一行标出来了——详情在右、列表在左，对不上号这个面板就是半残的', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(document.querySelector('.ink-trow-current')).not.toBeNull();
  });

  it('「关闭」把那一栏收起来', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());
    fireEvent.click(within(panel()!).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('Esc 也关得掉——它是「当前打开着的一个东西」，跟选中态同一条语义', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('⋯ 菜单里的「编辑」**直接把面板里那张卡开成表单**——他按的是「编辑」，不该开了面板还要再翻一次 ⋯ 菜单', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    fireEvent.click(within(screen.getByRole('group', { name: '密度' })).getByRole('button', { name: '行' }));
    const row = await waitFor(() => {
      const el = document.querySelector('.ink-trow');
      if (!el) throw new Error('还没渲染出行档');
      return el as HTMLElement;
    });
    // ⋯ 只在悬停/聚焦时才挂进 DOM，见 TaskRow.tsx。
    fireEvent.mouseEnter(row);
    await pickCardMenu('编辑', { scope: row });

    // 变异验证锚点：App.tsx 那处 `key={detail!.id}` 被删掉——查看着 A 再点带
    // 「编辑」意图的 B 时 autoEdit 不会重新从假变真，B 只会停在查看态。
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    const input = await waitFor(() => within(detail).getByPlaceholderText('标题'));
    expect((input as HTMLInputElement).value).toBe('甲任务');
  });

  it('**换看另一条任务不丢草稿**——改到一半点了别的，再点回来那份草稿还在（卡片自己那份 draftStash）', async () => {
    currentTasks = [
      task({ id: 'a', title: '甲任务', due: null, reminders: [] }),
      task({ id: 'b', title: '乙任务', due: null, reminders: [] }),
    ];
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    fireEvent.click(within(screen.getByRole('group', { name: '密度' })).getByRole('button', { name: '行' }));
    const rows = await waitFor(() => {
      const els = [...document.querySelectorAll('.ink-trow')];
      if (els.length < 2) throw new Error('两行还没都渲染出来');
      return els as HTMLElement[];
    });

    // 甲：从 ⋯ 进编辑态，改一半
    fireEvent.mouseEnter(rows[0]);
    await pickCardMenu('编辑', { scope: rows[0] });
    let detail = await screen.findByRole('complementary', { name: '任务详情' });
    fireEvent.change(within(detail).getByPlaceholderText('标题'), { target: { value: '改到一半还没存' } });

    // 去看乙（查看态，面板重挂了一次）
    fireEvent.click(rows[1].querySelector('.ink-trow-open') as HTMLElement);
    await waitFor(() => {
      detail = screen.getByRole('complementary', { name: '任务详情' });
      expect(within(detail).getByText('乙任务')).toBeTruthy();
    });

    // 再点回甲：草稿接回来了
    fireEvent.click(rows[0].querySelector('.ink-trow-open') as HTMLElement);
    await waitFor(() => {
      detail = screen.getByRole('complementary', { name: '任务详情' });
      const input = within(detail).getByPlaceholderText('标题') as HTMLInputElement;
      expect(input.value).toBe('改到一半还没存');
    });
  });

  it('**切到别的模块，右边那一栏跟着收起来**——它摊的是一条任务，习惯/日历各是一个独立界面，挂在那儿摊着一条毫无关系的任务就是「切了模块右边根本没变」', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());

    fireEvent.click(within(screen.getByRole('navigation', { name: '模块' })).getByRole('button', { name: '习惯' }));
    await screen.findByRole('heading', { level: 1, name: '习惯' });
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('**点回「任务」也不会自己弹回来**——清的是 state，换模块就是关掉，不是藏起来', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());
    const rail = () => within(screen.getByRole('navigation', { name: '模块' }));

    fireEvent.click(rail().getByRole('button', { name: '习惯' }));
    await screen.findByRole('heading', { level: 1, name: '习惯' });
    await waitFor(() => expect(panel()).toBeNull());

    fireEvent.click(rail().getByRole('button', { name: '任务' }));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    expect(panel()).toBeNull();
  });

  it('**四象限里点开一条任务照样看得到详情**——那一栏不按模块挡渲染，挡了的话那两个视图里的任务从此打不开', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', status: 'todo', due: null, reminders: [] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/四象限/)).toBeDefined());
    fireEvent.click(navButton(/四象限/));
    await screen.findByRole('heading', { level: 1, name: '四象限' });

    const row = await waitFor(() => {
      const el = container.querySelector('.ink-trow-open');
      if (!el) throw new Error('四象限里还没渲染出行');
      return el as HTMLElement;
    });
    fireEvent.click(row);
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(within(panel()!).getByText('甲任务')).toBeTruthy();
  });

  it('**焦点在输入框里时 Esc 不关面板**——那一下是面板里那张卡的「取消编辑」，一起关掉等于改错一个字就整条任务看不见了', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', due: null, reminders: [] })];
    await openFirstRow();
    await waitFor(() => expect(panel()).toBeTruthy());
    // 随便一个输入框就行，这条测的是「焦点在字段里」这个条件本身。用加任务
    // 那一行的输入框——原来用的是侧栏顶上那个搜索框，它已经搬去弹层了。
    const input = screen.getByLabelText('添加任务');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(panel()).not.toBeNull();
  });
});

/**
 * 「列表 / 看板」——**看板是清单的显示方式，不是一个去处**（`lib/listMode.ts`）。
 * 照滴答清单改的：它那边看板在每份清单的「视图」一栏里，跟「列表」「时间轴」
 * 并排，不在功能模块栏上。改之前这里是反的：`看板` 是注册表里一条独立的去处，
 * 摆的固定是全部任务，于是「工作这个清单按状态分列看看」根本没有。
 */
describe('App：列表 / 看板', () => {
  const modeSwitch = () => screen.queryByRole('group', { name: '视图' });
  const densitySwitch = () => screen.queryByRole('group', { name: '密度' });

  const go = async (label: RegExp, heading: string) => {
    fireEvent.click(navButton(label));
    await screen.findByRole('heading', { level: 1, name: heading });
  };

  it('「看板」不再是一个去处——竖栏上、命令面板里都没有它', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    const rail = within(screen.getByRole('navigation', { name: '模块' }));
    expect(rail.queryByRole('button', { name: '看板' })).toBeNull();
  });

  it('**任何一个任务去处都能就地切成看板**：切完是几列格子，不是一条一条', async () => {
    currentTasks = [task({ id: 'a', title: '甲任务', status: 'todo', due: null, reminders: [] })];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    await go(/全部/, '全部');

    expect(container.querySelector('.ink-cells')).toBeNull();
    fireEvent.click(within(modeSwitch()!).getByRole('button', { name: '看板' }));
    await waitFor(() => expect(container.querySelector('.ink-cells')).not.toBeNull());
    // 分组轴的下拉跟着出来——看板的重点就是「按什么分列」。
    expect(screen.getByLabelText('看板按什么分列')).toBeTruthy();
  });

  it('**摆的是这一屏自己的那批任务**，不是永远的全部——原来那个独立看板视图就是后者', async () => {
    currentLists = [list({ id: 'L1', name: '工作' })];
    currentTasks = [
      task({ id: 'a', title: '工作里的', status: 'todo', listId: 'L1', due: null, reminders: [] }),
      task({ id: 'b', title: '别处的', status: 'todo', listId: null, due: null, reminders: [] }),
    ];
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/工作/)).toBeDefined());
    await go(/工作/, '工作');

    fireEvent.click(within(modeSwitch()!).getByRole('button', { name: '看板' }));
    const cells = await waitFor(() => {
      const el = container.querySelector('.ink-cells');
      if (!el) throw new Error('还没切成看板');
      return el as HTMLElement;
    });
    expect(within(cells).getByText('工作里的')).toBeTruthy();
    expect(within(cells).queryByText('别处的')).toBeNull();
  });

  it('「今天」「接下来」没有这个开关——今天的顺序是他自己拖出来的，分成几列之后那个顺序没地方落', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await go(/今天/, '今天');
    expect(modeSwitch()).toBeNull();

    await go(/接下来/, '接下来');
    expect(modeSwitch()).toBeNull();
  });

  it('**在「全部」上切成看板之后，回「今天」行/卡开关还得在**——listMode 是一份全局偏好，只看它的话那个开关会跟着消失，而今天压根没有看板可切', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/全部/)).toBeDefined());
    await go(/全部/, '全部');
    fireEvent.click(within(modeSwitch()!).getByRole('button', { name: '看板' }));
    // 看板模式下「全部」自己不该有行/卡（那几列固定行档）
    await waitFor(() => expect(densitySwitch()).toBeNull());

    await go(/今天/, '今天');
    expect(densitySwitch(), '「今天」上行/卡开关不该跟着消失').not.toBeNull();
  });
});

/**
 * **切了屏，标签页得跟着说。**
 *
 * 在这之前十五个视图的 `document.title` 全是 index.html 里那句写死的
 * 「办事师爷」：标签页、任务栏、桌面版窗口标题上都看不出人在哪一屏。对读屏
 * 更要紧——这是个 hash 路由的单页应用，切视图不产生真正的导航，**标题变化
 * 是读屏播报「换页了」唯一的信号**。
 *
 * 拼法和还原那半在 `lib/pageTitle.test.tsx`（`.tsx` 不是 `.ts`——那个后缀是
 * 承重的，jsdom 档才有 `document`，理由写在那个文件顶上），这儿测的是
 * 「App 真的接上了」。
 */
describe('App：标签页标题跟着视图走', () => {
  it('切到哪一屏，document.title 就带上哪一屏的名字', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' });
    await waitFor(() => expect(document.title).toContain('今天'));

    fireEvent.click(navButton(/全部/));
    await screen.findByRole('heading', { level: 1, name: '全部' });
    await waitFor(() => expect(document.title).toContain('全部'));
    expect(document.title, '换了屏还留着上一屏的名字').not.toContain('今天');
  });

  it('应用自己的 h1 有且只有一个，内容就是这一屏的名字——读屏用它回答「我在哪儿」', async () => {
    const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await screen.findByRole('heading', { level: 1, name: '今天' });
    // **要把备注里的 markdown 排除掉。** 任务备注是真的渲染成 markdown 的
    // （`TaskCard.test.tsx` 那条「notes 里的 markdown 标题渲染成 <h1>」），
    // 所以一条备注只要以 `# ` 开头，页面上就会多出一个 h1——那是用户内容，
    // 不是应用的结构，而且它 16px 比视图标题的 15px 还大（theme.css
    // `.ink-notes-md h1`）。原来这条断言数的是全页 h1，任何人给夹具的备注
    // 加一行 `# 背景` 都会把它弄红，而红的原因跟它想守的东西无关。
    const own = [...container.querySelectorAll('h1')].filter((h) => !h.closest('.ink-notes-md'));
    expect(own).toHaveLength(1);
    expect(own[0].textContent).toBe('今天');
  });
});

/**
 * **认不出的去处，标题里不许印内部 key。**
 *
 * `viewTitle()` 原来的兜底是 `return view`，于是一个指向已删清单的旧书签会把
 * `list:9f2c1a4e-dead-…` 印在 h1 上；而同一屏的正文写的是「没有这个去处」，
 * 两句自相矛盾。加了 `lib/pageTitle.ts` 之后这句话还会写进**标签页、任务栏和
 * 桌面版窗口标题**——一个内部 id 就这么挂在 Alt-Tab 里。
 *
 * `viewTitle()` 自己的注释早就写着「标题栏上写 'computer' 是把实现细节搔到了
 * 人脸上」，只是当时没管住这几条兜底路径。
 */
describe('App：认不出的去处，标题说人话', () => {
  const go = async (hash: string) => {
    window.location.hash = hash;
    fireEvent(window, new HashChangeEvent('hashchange'));
    await waitFor(() => expect(document.querySelector('h1')).not.toBeNull());
  };

  it('指向已删清单的旧书签：标题说「找不到这份清单」，不印 id', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await go('#/list:9f2c1a4e-dead-beef-0000-000000000000');
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('找不到这份清单'));
    // **要有一条肯定式的。** jsdom 起手 `document.title === ''`，只写 `not.toContain`
    // 的话，把 `setBaseTitle` 那个 effect 整个删掉这些断言照样全绿。
    expect(document.title).toContain('找不到这份清单');
    expect(document.title, 'id 漏进了标签页/窗口标题').not.toContain('9f2c1a4e');
  });

  it('完全认不出的 hash：标题跟正文说同一句', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await go('#/some-junk-key-nobody-registered');
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('没有这个去处'));
    expect(document.title).toContain('没有这个去处');
    expect(document.title).not.toContain('junk');
  });

  it('认不出的情境 key：不把英文 key 印出来', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await go('#/context:bogus');
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('没有这个去处'));
    expect(document.title).toContain('没有这个去处');
    expect(document.title).not.toContain('bogus');
  });

  /**
   * **原型链上的名字不能当成情境。** `CONTEXT_LABEL` 是普通对象字面量，
   * `#/context:toString` 取到的是 `Object.prototype.toString`——一个 function，
   * `?? ` 根本不触发。以前这只让 React 报个警告；加了 `setBaseTitle` 之后那个
   * function 会进 `viewLabel.trim()`，副作用里抛 TypeError，而 `<App/>` 上面
   * 没有错误边界，整棵树卸载——**白屏**。实测过 `.ink-page` 都不在了。
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    '#/context:%s 不当成情境，也不把应用干掉', async (key) => {
      const { container } = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await waitFor(() => expect(navButton(/今天/)).toBeDefined());
      await go(`#/context:${key}`);
      expect(container.querySelector('.ink-page'), '整棵树被卸载了（白屏）').not.toBeNull();
      expect(document.querySelector('h1')?.textContent).toBe('没有这个去处');
    });

  it('#/tag: （空标签名）不留一个空的 h1', async () => {
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
    await waitFor(() => expect(navButton(/今天/)).toBeDefined());
    await go('#/tag:');
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('没有这个去处'));
    expect(document.title).not.toBe('办事师爷');
  });
});


/**
 * **拆完那条提示自己走，失败那条不走，切走的时候不计时。**
 *
 * 三条规矩各有各的理由，写在 App.tsx 那个 effect 上面：成功/告知类自动消失
 * （antd 自己的 message/notification 默认就是这么分的），错误留着等人读，
 * 而计时只在页面可见时走——人点完「立即拆解」多半会切走干别的，挂死定时器
 * 的话他回来时提示已经没了，跟「什么都没发生」一模一样。
 */
describe('App：AI 拆解结果那条提示', () => {
  const 推状态 = (state: string, message = '') => {
    act(() => { handlers.onAgentStatus?.({ state, message }); });
  };

  it('「拆解完成」几秒后自己消失', async () => {
    vi.useFakeTimers();
    try {
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await act(async () => { await Promise.resolve(); });
      推状态('ok', '拆出 3 条');
      expect(screen.queryByText('AI 拆解完成')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(6_000); });
      expect(screen.queryByText('AI 拆解完成'), '到点了还赖着').toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('**「拆解失败」不自动消失**——它带着要读的原因，而人可能不在屏幕前', async () => {
    vi.useFakeTimers();
    try {
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await act(async () => { await Promise.resolve(); });
      推状态('failed', 'claude 退出码 1');
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(screen.queryByText('AI 拆解失败'), '失败那条被自动收走了').not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('页面切走的时候不计时——回来还看得见', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(document, 'visibilityState', 'get');
    try {
      spy.mockReturnValue('hidden');
      render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
      await act(async () => { await Promise.resolve(); });
      推状态('ok', '拆出 3 条');
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(screen.queryByText('AI 拆解完成'), '人不在的时候把提示走完了').not.toBeNull();
      // 切回来，这才开始计时
      spy.mockReturnValue('visible');
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      act(() => { vi.advanceTimersByTime(6_000); });
      expect(screen.queryByText('AI 拆解完成')).toBeNull();
    } finally { spy.mockRestore(); vi.useRealTimers(); }
  });
});

/**
 * **详情那一栏的界线，接线对不对。**
 *
 * 界线本身（拖多少、方向、键盘、上下限）在 `ColGrip.test.tsx`，那边有 10 条。
 * 这里只盯 `App.tsx` 传下去的那几个值——**传错了不会有任何东西红**：`side`
 * 传成 `"right"` 的话拖动方向整个反过来（拖着往右走、栏却往左缩），而
 * `ColGrip` 自己那份测试是拿显式的 `side` 渲染的，看不见调用方传了什么。
 * 上下限和存储键同理：写错了只会「拖不动那么宽」或者「刷新之后宽度没了」。
 */
describe('App：任务详情那一栏的可拖界线', () => {
  /** 打开详情要点行档里的标题——卡片档那一档每张卡本来就摊开，没有这条路。 */
  const openDetail = async () => {
    localStorage.setItem('density', 'row');
    render(<AntApp><App /></AntApp>);
    // 按 `.ink-trow-title` 定位，不用 `findByText('交房租')`：那条任务同时出现在
    // 行档标题和顶上那条提醒横幅里，按文字找会撞上「found multiple elements」。
    const title = await waitFor(() => {
      const el = document.querySelector('.ink-trow-title');
      expect(el, '行档里该有那条任务的标题').not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 15_000 });
    fireEvent.click(title);
    return waitFor(() => {
      const g = document.querySelector('.ink-detail-col [role="separator"]');
      expect(g, '点开详情之后那一栏该有一条界线').not.toBeNull();
      return g as HTMLElement;
    });
  };

  it('贴的是左缘——详情在最右边，往右拖该是把它拖窄', async () => {
    const grip = await openDetail();
    expect(grip.className).toContain('ink-col-grip-left');
  });

  it('报的上下限是详情那一栏自己的（300～640），不是侧栏那一份', async () => {
    const grip = await openDetail();
    expect(grip.getAttribute('aria-valuemin')).toBe('300');
    expect(grip.getAttribute('aria-valuemax')).toBe('640');
    expect(grip.getAttribute('aria-valuenow')).toBe('360');
  });

  it('读屏念得出拖的是哪一栏——页面上有两条界线，只说「分隔条」不够', async () => {
    const grip = await openDetail();
    expect(grip.getAttribute('aria-label')).toContain('任务详情');
    const nav = document.querySelector('.ink-rail-col [role="separator"]');
    expect(nav?.getAttribute('aria-label')).toContain('清单侧栏');
  });

  /** 两栏各存各的：共用一个键的话拖宽侧栏会顺手把详情也改了。 */
  it('拖完存进 detailWidth，跟侧栏的 navWidth 不是同一个键', async () => {
    const grip = await openDetail();
    fireEvent.keyDown(grip, { key: 'End' });
    await waitFor(() => expect(localStorage.getItem('detailWidth')).toBe('640'));
    expect(localStorage.getItem('navWidth')).toBeNull();
  });

  it('存过的宽度下次进来还在', async () => {
    localStorage.setItem('detailWidth', '520');
    const grip = await openDetail();
    expect(grip.getAttribute('aria-valuenow')).toBe('520');
  });

  it('存了个超出上限的值，夹回 640——不信任存进去的那个数', async () => {
    localStorage.setItem('detailWidth', '9999');
    const grip = await openDetail();
    expect(grip.getAttribute('aria-valuenow')).toBe('640');
  });
});
