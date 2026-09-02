import { asArray, normalizeTaskArrays } from './lib/taskView.js';
import type { ConflictFile, Countdown, Folder, InboxItem, Insight, List, Proposal, Settings, SmartFilter, Task, TrashItem } from './types.js';
// 推送体/回执体从服务端那份 import type，web 侧不抄第二份——`server/src/push.ts`
// 是零 import 的平台无关文件，正是为两边共用同一份类型放在那里的（那个文件顶部
// 有理由）。**从这里出发是两层**（`web/src/api.ts` → 仓库根），`lib/dataSource.ts`
// 那种在 `lib/` 里的文件才是三层。
import type { PushBody, PushResponse } from '../../server/src/push.js';
import { getApiBase } from './lib/apiBase.js';
import {
  backfillCountdowns, backfillFolders, backfillInbox, backfillInsights, backfillLists, backfillProposals, backfillTasks,
  localApi, offlineUnsupported, route,
} from './lib/dataSource.js';

/**
 * 手机可以不连桌面（task-2-brief）：下面每个方法都经 `route()` 多一层
 * 选路——连得上服务端就走 `req()`（跟原来一模一样），连不上就走
 * `localApi`（`lib/dataSource.ts`，落在 `@capacitor/preferences` 里）。
 * 判据只有 `dataSource.ts` 的 `isOnline()`/`route()` 这一处实现，这里的
 * 每个方法只是把「HTTP 怎么打」和「本地怎么落」这两份闭包递给它，不自己
 * 判断在不在线——见 `route()` 定义处的注释「这一批同族形状里最高危的
 * 一处」。
 *
 * `tasks`/`inbox`/`lists`/`insights`/`proposals` 这五个读方法多传第三个
 * 参数 `backfill*`——在线读成功之后顺手把这次拿到的数据写一份进本地缓存，
 * 给下次离线时用（回填，不是同步，见 `route()` 定义处修复轮 1 那段注释）。
 * `settings`/`trash`/`conflicts` 不回填，理由见 `lib/dataSource.ts` 模块
 * 顶部注释。
 *
 * 附件（`uploadAttachment`/`attachmentUrl`/`deleteAttachment`）不做离线：
 * 二进制文件，`data/attachments/` 是服务端文件系统，这一批明确不做
 * （task-2-brief）。`attachmentUrl` 本身不发请求（只是拼字符串给 `<a href>`
 * 用），不需要选路；`uploadAttachment`/`deleteAttachment` 离线时走
 * `offlineUnsupported()`，清楚地报错而不是给一个死链接。
 */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiBase() + path, {
    ...init,
    // 只有字符串 body（body() 序列化出来的 JSON）才补 json 头。附件上传传的是
    // FormData（见下面 uploadAttachment）——那种 body 必须让浏览器自己按内容
    // 生成带 boundary 的 Content-Type，这里硬塞 'application/json' 会让服务端
    // parseBody() 按错误的类型解析 multipart 表单。
    headers: typeof init?.body === 'string' ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

const body = (v: unknown) => JSON.stringify(v);

export const api = {
  inbox: () => route(() => req<InboxItem[]>('/api/inbox'), () => localApi.inbox(), backfillInbox),
  addInbox: (text: string) => route(
    () => req<InboxItem>('/api/inbox', { method: 'POST', body: body({ text }) }),
    () => localApi.addInbox(text),
  ),
  patchInbox: (id: string, patch: Partial<InboxItem>) => route(
    () => req<InboxItem>(`/api/inbox/${id}`, { method: 'PATCH', body: body(patch) }),
    () => localApi.patchInbox(id, patch),
  ),
  deleteInbox: (id: string) => route(
    () => req<{ ok: true }>(`/api/inbox/${id}`, { method: 'DELETE' }),
    () => localApi.deleteInbox(id),
  ),

  /**
   * 「拆得不对，再来一轮」。`note` 是他补的那句要求，留空就是单纯重拆一遍。
   *
   * 服务端一趟做完四件事（旧任务进垃圾箱、要求追加进原文、条目翻回未处理、
   * 立刻再拆一次），见 app.ts 那条路由。`started` 说的是第四件——单飞锁挡住
   * 时它是 false，而前三件已经成了，界面得照实说。
   */
  redoInbox: (id: string, note: string) => route(
    () => req<{ item: InboxItem; trashed: number; started: boolean }>(
      `/api/inbox/${id}/redo`, { method: 'POST', body: body({ note }) },
    ),
    offlineUnsupported('重新拆解'),
  ),

  /**
   * **这里把每条任务的五个数组字段补齐**（`normalizeTaskArrays`）——磁盘上那份
   * 没人校验过（见那个函数的注释），漏一个 `"tags": []` 就能让整页白掉。
   * 补在这个入口，不是补在每个消费点：下游还会长出新的消费点，入口只有一个。
   * 在线离线两条路都经过这儿。
   */
  tasks: async (): Promise<Task[]> => asArray<Task>(await route(
    () => req<Task[]>('/api/tasks'), () => localApi.tasks(), backfillTasks,
  )).map((t) => normalizeTaskArrays(t)),
  // TaskComposer 传的是 TaskDraft 挑出来的那几个字段（标题/备注/截止/提醒/
  // 优先级/标签/清单/重复规则）——`Partial<Task>` 类型上能传任何字段，但真正
  // 调这个函数的只有 App.tsx 里那一处手挑字段的 onCreate，界面没有入口能填
  // id/status:'todo'/source:'user'/order:null 这些不该由界面决定的字段，服务端 `newTask()`
  // 负责补上。**加新字段时留意 App.tsx 那处 onCreate 是手挑的，不会自动带上
  // TaskDraft 新增的字段**——这正是 tags/priority 曾经被静默丢在这一层的原因。
  addTask: (patch: Partial<Task>) => route(
    () => req<Task>('/api/tasks', { method: 'POST', body: body(patch) }),
    () => localApi.addTask(patch),
  ),
  patchTask: (id: string, patch: Partial<Task>) => route(
    () => req<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: body(patch) }),
    () => localApi.patchTask(id, patch),
  ),
  /**
   * 跳过重复任务的这一次。**走自己的路由，不是发一个改 due 的 PATCH**——
   * 那条路上服务端的推迟计数是字段级的，会把每一次跳过都记成一次拖延，
   * 于是这条任务慢慢混进「一拖再拖」的推荐里。理由写在服务端那条路由上。
   */
  skipTask: (id: string) => route(
    () => req<Task>(`/api/tasks/${id}/skip`, { method: 'POST' }),
    () => localApi.skipTask(id),
  ),
  deleteTask: (id: string) => route(
    () => req<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' }),
    () => localApi.deleteTask(id),
  ),
  // 「今天」手动排序专用：ids 是当前可见列表从上到下的顺序，数组下标就是
  // 新的 order。一次请求、服务端一次读一次写——不是给每张可见的卡各发一条
  // patchTask，见 server/src/app.ts 这条路由顶部的注释。
  reorderTasks: (ids: string[]) => route(
    () => req<{ ok: true }>('/api/tasks/reorder', { method: 'PATCH', body: body({ ids }) }),
    () => localApi.reorderTasks(ids),
  ),
  // 批量操作用的两个端点（见 server/src/app.ts、2026-08-17-selection.md）。
  // 一次 fetch，不是对选中的每个 id 各发一条 patchTask/deleteTask——理由
  // 跟上面 reorderTasks 一模一样：N 次独立写各自触发一轮目录监听器 → SSE
  // 广播 → 所有开着的页面 refetch，选 20 张就是 20 轮。
  patchTasks: (ids: string[], patch: Partial<Task>) => route(
    () => req<{ updated: number }>('/api/tasks', { method: 'PATCH', body: body({ ids, patch }) }),
    () => localApi.patchTasks(ids, patch),
  ),
  /**
   * 批量、但**每条各改各的**——批量改期、「推迟一小时」这种：「原计划整个
   * 往后挪一小时」逐条算出来的时刻互不相同，`patchTasks` 那份共享 patch
   * 表达不了。走的是同一个端点（服务端把两种请求体归一，见 app.ts），
   * 仍然是一次请求、一次读一次写，不是对每个 id 各发一条。
   */
  patchTasksEach: (patches: Array<{ id: string; patch: Partial<Task> }>) => route(
    () => req<{ updated: number }>('/api/tasks', { method: 'PATCH', body: body({ patches }) }),
    () => localApi.patchTasksEach(patches),
  ),
  deleteTasks: (ids: string[]) => route(
    () => req<{ deleted: number }>('/api/tasks', { method: 'DELETE', body: body({ ids }) }),
    () => localApi.deleteTasks(ids),
  ),

  proposals: () => route(() => req<Proposal[]>('/api/proposals'), () => localApi.proposals(), backfillProposals),
  // 接受：服务端一个端点里把 patch 应用到任务 + 删掉这条提议两件事做完，
  // 不是网页发两个请求——中间断了会留下一条已经生效却还挂着的提议。离线时
  // 没有本地实现——提议本身就是 AI 连着服务端产出的东西，见
  // lib/dataSource.ts 的 offlineUnsupported 名单。
  acceptProposal: (id: string) => route(
    () => req<Task>(`/api/proposals/${id}/accept`, { method: 'POST' }),
    offlineUnsupported('接受这条建议'),
  ),
  // 忽略是打墓碑不是删行——留着那一行，下一轮回顾的内容去重才认得出来，
  // 否则同一条建议会原样再提一遍。见服务端这条路由的注释。
  dismissProposal: (id: string) => route(
    () => req<{ ok: true }>(`/api/proposals/${id}/dismiss`, { method: 'PATCH' }),
    offlineUnsupported('忽略这条建议'),
  ),

  // 离线不支持——见 lib/dataSource.ts 模块注释「settings 为什么走
  // offlineUnsupported 不是伪造默认值」（task-2-report 修复轮 2 C2）：
  // GET /api/settings 读到的是桌面那台机器的 device.json，伪造一份默认值
  // 当答案返回，调用方分辨不出这是真的还是假的——App.tsx 的 reload() 会把
  // 它塞进 state，界面显示的是假数据但看起来完全正常，用户改一下再保存
  // 还会把假数据整份 PUT 回服务端、覆盖掉桌面真实的 webhookUrl 之类。
  settings: () => route(() => req<Settings>('/api/settings'), offlineUnsupported('读取设置')),
  saveSettings: (s: Settings) => route(
    () => req<Settings>('/api/settings', { method: 'PUT', body: body(s) }),
    offlineUnsupported('保存设置'),
  ),

  lists: () => route(() => req<List[]>('/api/lists'), () => localApi.lists(), backfillLists),
  // filter 缺省 null——大多数调用点（Sidebar「新建清单」）建的是普通清单。
  // 「存成智能清单」（task-4-brief）传当前筛选进来，服务端 sanitizeSmartFilter
  // 校验得比这里能写的严，这里不重复一份，原样透传。
  addList: (name: string, color: string, filter: SmartFilter | null = null) => route(
    () => req<List>('/api/lists', { method: 'POST', body: body({ name, color, filter }) }),
    offlineUnsupported('新建清单'),
  ),
  /**
   * 改一份清单（改名 / 归档 / 取消归档）。**服务端这两条路由早就通了，前端
   * 一直只接了 `addList`** ——于是清单建出来就改不动也删不掉，`archived` 这个
   * 字段（`fileableLists` 一直在认它）压根没有任何入口能置成 true。
   *
   * 离线不支持，跟 `addList` 同一档：清单的增删改不是「随手记一句」那种非做
   * 不可的动作，回到局域网再改就是了。
   */
  patchList: (id: string, patch: Partial<Pick<List, 'name' | 'color' | 'archived' | 'folderId' | 'order' | 'filter'>>) => route(
    () => req<List>(`/api/lists/${id}`, { method: 'PATCH', body: body(patch) }),
    offlineUnsupported('改清单'),
  ),
  /** 删一份清单。**里面的任务不会跟着删**，服务端会把它们的 `listId` 置空
   *  （见 server/src/app.ts 那条路由里的注释）。 */
  deleteList: (id: string) => route(
    () => req<{ ok: true }>(`/api/lists/${id}`, { method: 'DELETE' }),
    offlineUnsupported('删清单'),
  ),

  /**
   * 文件夹——把清单分组（仿滴答清单）。**四条路由服务端早就通了，
   * `List.folderId` 这个字段也一直在，前端一处都没有接**：于是清单只能平铺，
   * 攒到十几份之后侧栏就没法看了，而这正是文件夹要解决的那件事。
   *
   * 写一律离线不支持，跟清单的增删改同一档。
   */
  folders: () => route(() => req<Folder[]>('/api/folders'), () => localApi.folders(), backfillFolders),
  addFolder: (name: string) => route(
    () => req<Folder>('/api/folders', { method: 'POST', body: body({ name }) }),
    offlineUnsupported('新建文件夹'),
  ),
  patchFolder: (id: string, patch: Partial<Pick<Folder, 'name' | 'order'>>) => route(
    () => req<Folder>(`/api/folders/${id}`, { method: 'PATCH', body: body(patch) }),
    offlineUnsupported('改文件夹'),
  ),
  /** 删文件夹。**里面的清单不会跟着删**，服务端把它们的 `folderId` 置空、
   *  回到顶层（见 server/src/app.ts 那条路由里的注释）。 */
  deleteFolder: (id: string) => route(
    () => req<{ ok: true }>(`/api/folders/${id}`, { method: 'DELETE' }),
    offlineUnsupported('删文件夹'),
  ),

  // GET 已经把 dismissedAt 非空的滤掉了，见 server/src/app.ts 那条路由的注释。
  insights: () => route(() => req<Insight[]>('/api/insights'), () => localApi.insights(), backfillInsights),

  // 倒数纪念日。读走本地缓存那条路（离线时看得到上次在线读到的那份），
  // 三个写离线一律 offlineUnsupported——跟清单的增删改同一档：它们不是
  // 「随手记一句」那种非做不可的动作，回到局域网再改就是了。
  countdowns: () => route(() => req<Countdown[]>('/api/countdowns'), () => localApi.countdowns(), backfillCountdowns),
  addCountdown: (title: string, date: string, yearly: boolean, lunar: boolean) => route(
    () => req<Countdown>('/api/countdowns', { method: 'POST', body: body({ title, date, yearly, lunar }) }),
    offlineUnsupported('新建纪念日'),
  ),
  patchCountdown: (id: string, patch: { title?: string; date?: string; yearly?: boolean; lunar?: boolean }) => route(
    () => req<Countdown>(`/api/countdowns/${id}`, { method: 'PATCH', body: body(patch) }),
    offlineUnsupported('改纪念日'),
  ),
  deleteCountdown: (id: string) => route(
    () => req<{ ok: true }>(`/api/countdowns/${id}`, { method: 'DELETE' }),
    offlineUnsupported('删纪念日'),
  ),
  // 「知道了」是打墓碑不是删行，服务端负责——这里只是发请求，见服务端那条
  // 路由的注释。
  dismissInsight: (id: string) => route(
    () => req<{ ok: true }>(`/api/insights/${id}/dismiss`, { method: 'PATCH' }),
    offlineUnsupported('忽略这条观察'),
  ),

  // 单飞已经在跑时回 409，req() 把响应体里的 error 字段包成 Error 抛出来——
  // 跟别的写操作一样走 guard()，不需要在这单独处理。手机上没有 claude 子
  // 进程，离线时本来就做不到，见 已归档的 docs/superpowers/plans/2026-08-21-offline-core.md 开工前①。
  expand: () => route(() => req<{ ok: true }>('/api/expand', { method: 'POST' }), offlineUnsupported('拆解收件箱')),
  // 「这次不拆」：取消已经排上的自动拆解，不运行、不影响下次排期资格。
  expandSkip: () => route(() => req<{ ok: true }>('/api/expand/skip', { method: 'POST' }), offlineUnsupported('跳过这次拆解')),
  // 让 AI 把已有任务回顾一遍。跟 expand 共用服务端那把单飞锁，所以同样可能 409
  // （「上一次拆解还在跑」），同样由 guard() 把错误弹出来。
  // `listId` 给了就只回顾那一份清单（服务端认不出来会 400，不会悄悄扫全部）。
  review: (listId?: string) => route(
    () => req<{ ok: true }>('/api/review', { method: 'POST', ...(listId ? { body: body({ listId }) } : {}) }),
    offlineUnsupported('回顾现有任务'),
  ),

  /**
   * 设置页 AI 那三格旁边的「测试连接」。**传的是此刻框里那份**，不是存着的那份
   * ——这颗按钮问的就是「我刚填完，对不对」。
   *
   * 密钥那一格照原样送回去：界面读回来的是打码串，他不碰它就该原样往回传，
   * 服务端认得出（见 `aiApi.ts` 的 `aiKeyFrom`）。
   *
   * **连不通也是 200**：那是这条接口要报告的结果，不是它自己失败了。
   */
  testAi: (cfg: { baseUrl: string; model: string; apiKey: string }) => route(
    () => req<{ ok: true } | { ok: false; error: string }>('/api/ai/test', { method: 'POST', body: body(cfg) }),
    offlineUnsupported('测试 AI 接口'),
  ),

  /** 垃圾箱里那几条同样是任务，同样要补——还原之后它们会直接回到界面上。 */
  trash: async (): Promise<TrashItem[]> => asArray<TrashItem>(await route(
    () => req<TrashItem[]>('/api/trash'), () => localApi.trash(),
  )).map((t) => normalizeTaskArrays(t)),
  restoreTrash: (id: string) => route(
    () => req<Task>(`/api/trash/${id}/restore`, { method: 'POST' }),
    () => localApi.restoreTrash(id),
  ),
  purgeTrash: (id: string) => route(
    () => req<{ ok: true }>(`/api/trash/${id}`, { method: 'DELETE' }),
    offlineUnsupported('彻底删除'),
  ),
  /** 清空垃圾箱。**离线不做**，跟单条彻底删除同一档：这是不可逆的破坏性
   *  操作，而离线时垃圾箱里只看得见离线删掉的那几条——在一份不完整的列表上
   *  按「清空」，人以为清掉的是全部。 */
  purgeAllTrash: () => route(
    () => req<{ purged: number }>('/api/trash', { method: 'DELETE' }),
    offlineUnsupported('清空垃圾箱'),
  ),

  // 只读，不解决——见 server/src/conflicts.ts 顶部的注释。离线时本来就没有
  // 同步冲突这回事（这一批不做同步），本地分支恒为空数组。
  conflicts: () => route(() => req<ConflictFile[]>('/api/conflicts'), () => localApi.conflicts()),
  /** 读不出来的实体文件。跟 conflicts 一样离线时恒空——「哪个文件坏了」是
   *  桌面那份数据的事实，手机上本地缓存里没有这回事。 */
  broken: () => route(() => req<ConflictFile[]>('/api/broken'), () => localApi.conflicts()),

  // 手机把离线期间的改动推回桌面（见 server/src/app.ts 的 POST /api/push）。离线时
  // 当然做不到——这条路由本身的前提就是「现在连得上了」，`route()` 判离线就直接报错，
  // 不装作推成功。组装请求体、按回执清记号那一半在 lib/pushBack.ts。
  pushBack: (payload: PushBody) => route(
    () => req<PushResponse>('/api/push', { method: 'POST', body: body(payload) }),
    offlineUnsupported('把离线改动推回桌面'),
  ),

  // 附件：拖文件到卡片上（Attachments.tsx），三条路由见 server/src/app.ts。
  // taskId/name 都过 encodeURIComponent——name 来自浏览器文件名，可能带空格、
  // 括号、中文（重名去重加的 ` (2)` 后缀也是这类字符），不编码会拼出带歧义
  // 字符的 URL。二进制文件这一批不做离线，见本文件顶部的注释。
  uploadAttachment: (taskId: string, file: File) => route(
    () => {
      const form = new FormData();
      form.append('file', file);
      return req<Task>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, { method: 'POST', body: form });
    },
    offlineUnsupported('上传附件'),
  ),
  // 下载链接，直接当 <a href> 用——这里要的是浏览器原生的下载行为（服务端
  // 回的是文件字节 + Content-Disposition，不是 JSON），不经过 req()，也不
  // 经过 route()：这个函数本身不发任何请求，选路判断留给 Task 3 的界面层
  // （离线时这里显示的链接要换成「需要联网」提示，不是一个死链接）。
  attachmentUrl: (taskId: string, name: string) =>
    `${getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}`,
  deleteAttachment: (taskId: string, name: string) => route(
    () => req<{ ok: true }>(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    offlineUnsupported('删除附件'),
  ),
};

/** SSE agent-status 事件的 payload，跟 server/src/expand.ts 的 AgentStatus 手动对齐——
 * 只是个字面量联合类型，飘了 TypeScript 会在字面量比较的地方直接标红，不需要一份同步测试。 */
export interface AgentStatus {
  state: 'scheduled' | 'running' | 'ok' | 'failed' | 'skipped' | 'idle';
  message?: string;
  /** 只有 state === 'scheduled' 时才有意义：排定的绝对触发时间（ISO）。 */
  at?: string;
}

/** 服务端 data-changed 事件里的 file。跟 server/src/events.ts 的 WATCHED 对齐。 */
export type DataFile = 'inbox' | 'tasks' | 'settings' | 'proposals' | 'lists' | 'folders' | 'insights' | 'countdowns' | 'trash';

export interface SseHandlers {
  // 收 DataFile | string 而不是只收 DataFile：事件里的 file 是 JSON.parse 出来的，
  // 运行时可以是任何字符串。把这个事实写进类型，逼调用方处理未知值，而不是
  // 以为编译器替它挡住了——这条洞正是因为原来的类型只标四种、看着像能拦住。
  onChange: (file: DataFile | string) => void;
  onReminder: (task: Task) => void;
  onAgentStatus: (status: AgentStatus) => void;
  onOpen: () => void;
}

/**
 * 订阅服务端事件。返回断开函数。
 * EventSource 自带断线重连，不用自己写重试——但重连只会带来断线*之后*发生的事件，
 * 断线期间的变化永远补不回来。「关掉窗口、AI 改完 tasks.json、再打开窗口」是文档
 * 写明的正常流程，不是边缘情况，所以每次连上（含首次连接）都触发一次全量 reload，
 * 补齐这段空窗。首次挂载因此会多一次重复请求，无害。
 */
export function subscribe({ onChange, onReminder, onAgentStatus, onOpen }: SseHandlers): () => void {
  const es = new EventSource(`${getApiBase()}/api/events`);
  es.addEventListener('open', onOpen);
  es.addEventListener('data-changed', (e) => onChange(JSON.parse((e as MessageEvent<string>).data).file));
  es.addEventListener('reminder', (e) => onReminder(JSON.parse((e as MessageEvent<string>).data) as Task));
  es.addEventListener('agent-status', (e) => onAgentStatus(JSON.parse((e as MessageEvent<string>).data) as AgentStatus));
  return () => es.close();
}
