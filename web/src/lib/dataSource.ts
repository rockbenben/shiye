import { applyReorder, applyTaskPatch, cascadeAll, maybeSpawnNextInstance, patchMany, restoreFromTrash, softDeleteTasks } from '../../../server/src/mutate.js';
import { skipPatch } from '../../../server/src/repeat.js';
import { looksLikeOwnServer, testConnection } from '../components/ServerSetup.js';
import type { ConflictFile, Countdown, Folder, InboxItem, Insight, List, Proposal, Task, TrashItem } from '../types.js';
import { getApiBase } from './apiBase.js';
import {
  dirtyInbox, dirtyTasks, localCountdowns, localFolders, localInbox, localInsights, localLists, localProposals, localTasks, localTrash,
  serialized,
} from './localStore.js';

/**
 * 「选谁」——task-2-brief 点名的最高危处，跟上一批 `?client=desktop`/
 * `desktop-open-task` 同一个形状：**两侧契约、各自供给同一个字面量、谁都
 * 没断言它**。那两次都是「改一头，另一头的测试照样全绿」。
 *
 * 这里的解法是让「连不连得上」这件事只有一处实现：`isOnline()` 是唯一
 * 判断它的函数，`route()` 是唯一读它做分支的地方——`api.ts` 那 28 个走
 * 网络的方法（不含同步的 `attachmentUrl`）**全部**经这一个 `route()`，
 * 没有任何方法另外写一份「是不是在线」的判断。不存在「第二份」，也就不
 * 存在「一头改了另一头没跟着改」的可能——这不是靠两边各自测过一遍来
 * 保证一致，是结构上只有一份。
 *
 * `server/src/mutate.ts` 的三个纯函数（`applyTaskPatch`/
 * `maybeSpawnNextInstance`/`softDeleteTasks`）从三层相对路径引入——
 * Task 1 已经验过 `web → server` 这个方向干净（`tsc --noEmit` + `vite build`
 * 都过，产物里零 node 内置命中），这是这个仓库第一次真的接上这条路径。
 *
 * **修复轮 1（回填）**：`tasks`/`inbox`/`lists`/`insights`/`proposals` 五类
 * 在线读成功之后，`route()` 的 `backfill` 参数把这次拿到的数据写一份进本地
 * 缓存——这样「一次都没离线过的设备第一次断网」看到的不是空列表，是上一次
 * 在线时看到的那份，这才是「apk 可以不连桌面」这句话的第一用途（不用先离线
 * 编辑过一次才有东西可看）。**不回填的三类**：
 * - `settings`：`GET /api/settings` 读到的是**桌面那台机器**的 `device.json`
 *   （webhook 地址、系统通知开关……跟机器绑定，见 `server/src/store.ts`
 *   `deviceConfigPath` 的注释），不是「这台手机的设置」——缓存它、离线时
 *   拿出来用，等于把桌面的配置冒充成手机自己的。**修复轮 2（C2）**：这不是
 *   「不回填」就完了——初版在这里干了一件比不回填更糟的事：不缓存真实值，
 *   转头伪造一份 `DEFAULT_SETTINGS` 当答案返回，调用方拿到的是一个跟「真的
 *   读到了」逐字节相同的 `Settings` 对象，**分辨不出这是假的**。真实链路：
 *   `App.tsx` 的 `reload()` 把它塞进 `settings` state（没有任何错误提示，
 *   因为调用方看来这次读取「成功」了）→ `SettingsModal` 用这份假数据当
 *   草稿的初值 → 用户改一个字段（比如 `focusMinutes`）点保存，此时可能已经
 *   恢复在线 → `api.saveSettings()` **整份 `PUT`**，桌面真实的 `webhookUrl`
 *   被这份伪造值里的 `''` 覆盖——**离线兜底值造成真实数据丢失，且没有任何
 *   信号提示过用户**。这条改动之前（Task 2 存在之前）这条路本来是安全的：
 *   `reload()` 会在更早的 `api.inbox()` 那一步就直接抛出、走 `catch` 弹错误，
 *   `setSettings` 根本跑不到，`SettingsModal` 拿不到假草稿——Task 2 把
 *   「离线时每个读方法都不再抛错」这件事本身做对了，却让 `settings` 这一个
 *   意外地从「读取失败」变成了「悄悄读到假数据」，两者对用户的观感一样
 *   （界面正常），后果却天差地别。**改法**：`settings` 离线时跟附件同一条
 *   路——`api.ts` 直接走 `offlineUnsupported('读取设置')`，不留 `localApi`
 *   实现，也不再有 `DEFAULT_SETTINGS` 这份字面量（顺带解决了它是
 *   `server/src/model.ts`/`web/src/App.tsx` 之外第三份同样字面量、没有
 *   任何东西断言三者一致这件事）。`App.tsx` 的 `reload()` 需要单独 catch
 *   这一条，不能让它的失败连带把 `tasks`/`inbox` 这些已经读成功的字段也
 *   一起挡在 `setXxx` 之前——这处属于 `App.tsx`，不在 Task 2 原定的文件
 *   范围内，但复审直接指出了这条数据丢失链路，一并改在这次提交里。
 * - `conflicts`：同步冲突副本本来就是「桌面文件系统里躺着哪些冲突文件」
 *   这个问题的答案，离线的手机上这个问题不成立（这一批也没有本地→服务端
 *   的同步，不会产生冲突），缓存一份「桌面那边上次的冲突」离线时给手机看
 *   没有意义。
 * - `trash`：coordinator 划定的回填名单里没有它，见 task-2-report「修复轮 1」
 *   ——离线时只看得到离线软删除过的那些，看不到「在线时已经在垃圾箱里」的
 *   条目，是有意留白。附件也不回填：二进制，`data/attachments/` 是服务端
 *   文件系统，这一批明确不做（task-2-brief）。
 *
 * `tasks`/`inbox` 的回填要多护一步：不能让服务端的旧版本覆盖「还没同步」
 * 的本地改动，见下面 `backfillTasks`/`backfillInbox` 的注释。
 */

// ── 判据：isOnline() / route() ──

const ONLINE_CACHE_MS = 5000;

let cache: { at: number; online: boolean } | null = null;
// 复审 M1：`cache` 只在 `await probeOnline()` **之后**才写入——挂载那一刻
// `App.tsx` 的 `reload()`（内部第一步 `api.inbox()` 就会走 `route()` →
// `isOnline()`）和 `refreshOffline()` 是同一拍并排调用的两个 `isOnline()`，
// 两次都读到 `cache === null`，5 秒 TTL 挡不住这种「还没来得及写缓存」的
// 并发调用，实测过 `Promise.all([isOnline(), isOnline()])` 真的打两次
// fetch。`pending` 记的是「探测正在飞」的那一个 promise：第二个及以后的
// 并发调用直接复用它，不再各自发起一次 `probeOnline()`。
let pending: Promise<boolean> | null = null;

/**
 * 复审 I1：这里以前是一份手写的探测（同样的路径、同样的 1500ms 超时、同样
 * 「`res.ok` 且 `body.ok===true`」的成功条件），注释里写着「跟 ServerSetup.tsx
 * 的 testConnection 用同一个数字」——**契约写在注释里，没有代码强制两者一致**。
 * 这是 `?client=desktop`/`desktop-open-task`/`DEFAULT_SETTINGS` 之后第四次
 * 出现「两处手写同一份判断，谁都没断言过它们真的相等」的形状（变异实测过：
 * 把这里的超时改成 9000，`ServerSetup.tsx` 那份 1500 原样不变，
 * `dataSource.test.ts` + `ServerSetup.test.tsx` + `api.test.ts` 三个文件全绿）。
 *
 * 改法是删掉这第二份实现，直接复用 `ServerSetup.tsx` 已经导出的
 * `testConnection`/`looksLikeOwnServer`——`looksLikeOwnServer` 为真的条件是
 * `kind==='ok'`（`res.ok && body.ok===true && body.version===CLIENT_API_VERSION`）
 * 或者 `kind==='version-mismatch'`（同上，只是版本号对不上），两种合起来
 * 恰好就是原来这里 `res.ok && body?.ok===true`（不看版本号）那一句话——
 * 版本号在这里从来就不重要，`isOnline()` 只关心「连不连得上这个服务」，
 * 不是「版本对不对」，语义完全没变，只是不再自己重复一份判断。
 * `HEALTH_TIMEOUT_MS` 这个常量也一并删掉——`testConnection` 内部自己有
 * 一份（`ServerSetup.tsx`），这里不再需要另一份数字。
 */
async function probeOnline(): Promise<boolean> {
  return looksLikeOwnServer(await testConnection(getApiBase()));
}

/**
 * 是否连得上服务端——路由判据的唯一来源。
 *
 * 探一次缓存 5 秒：`App.tsx` 的 `reload()` 一次会顺序 `await` 七八个
 * `api.*` 方法，不缓存的话离线时每个方法各等一次 1.5 秒的探测超时，一次
 * 刷新要十几秒。**并发调用会去重成一份飞行中的 promise**（见上面 `pending`
 * 的注释）——挂载/每次 SSE 重连时 `reload()` 和 `refreshOffline()` 并排
 * 触发的两次调用，实际只发一次 `/api/health`，不是分别各打一次。
 *
 * ponytail：5 秒是固定 TTL，不是「联网了立刻感知」——设备真的从离线恢复
 * 到在线，最多要等 5 秒下一次探测才会翻过来。真要即时感知，下一批可以让
 * SSE 的 `onopen`/`onerror`（`api.ts` 的 `subscribe()`）直接推状态，这一批
 * 先用这个简单、能测的版本。
 */
export async function isOnline(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < ONLINE_CACHE_MS) return cache.online;
  if (!pending) {
    pending = probeOnline().then((online) => {
      cache = { at: Date.now(), online };
      pending = null;
      return online;
    });
  }
  return pending;
}

/** 仅供测试：清掉缓存，下一次 `isOnline()` 重新探测。 */
export function resetOnlineCache(): void {
  cache = null;
  pending = null;
}

/**
 * 仅供测试：跳过真实探测，把 `isOnline()` 的结果直接钉死。`api.test.ts` 里
 * 大量既有用例的前提本来就是「在线」（桌面场景），不该因为多了这一层选路，
 * 就要求每条既有用例的 fetch mock 都学会额外答一次 `/api/health`——那样
 * 会让这一批的改动波及一整份跟路由无关的既有断言。传 `null` 等价于
 * `resetOnlineCache()`。
 */
export function setOnlineForTest(v: boolean | null): void {
  cache = v === null ? null : { at: Date.now(), online: v };
  // 一并清掉——不清的话，上一条测试留下的一份还没落定的 `pending`（比如
  // 它的 fetch mock 从没被真的 resolve 过）晚一拍写回 `cache`，会把这里
  // 刚钉死的值覆盖掉，读到的是上一条测试的答案，不是这一条钉的这个。
  pending = null;
}

/**
 * 路由判据的唯一落点。**两个分支互斥，但「互斥」管的是「答案从哪来」，
 * 不是「碰没碰本地存储」**——修复轮 1 之前这里的注释把这两件事混成了一件，
 * 导致读操作干脆不回填本地缓存，代价是从没离线过的设备第一次断网时
 * `api.tasks()` 读到空数组，见 task-2-report「修复轮 1」。
 *
 * - `isOnline()` 为 true：**返回值**只能来自 `http()`——`local` 一次都不会
 *   被调用，哪怕本地缓存里躺着旧数据也不许拿它顶（上限①：连得上时返回
 *   的必须是 `http()` 的值，不是缓存的值）。`http()` 成功之后，如果调用方
 *   传了 `backfill`，把这次拿到的新数据写一份进本地缓存——这是**回填**，
 *   给下次离线时用，不算「走本地」：它发生在答案已经从 `http()` 拿到**之后**，
 *   不参与「这次返回值是什么」的决定，也不是「本地改动」（回填是单向的
 *   服务端→本地，这一批仍然不做本地推回服务端那个方向，「还没同步」的
 *   记号只认离线写入产生的改动，不认回填）。
 *   **回填失败不能带崩这次在线请求**（配额满/`Preferences` 抛异常之类）——
 *   已经拿到 `http()` 的答案了，本地缓存这次没写成功不该让调用方看见异常，
 *   原样把 `http()` 的结果返回，回填的错误吞掉。
 * - `isOnline()` 为 false：只调用 `local`，`http`（真正打向 `/api/...`
 *   的那次 fetch）一次都不会被调用，`backfill` 也不会被调用——上限②
 *   「连不上时不许发 HTTP」。`isOnline()` 自己探测用的那次 `/api/health`
 *   请求不算数：不试着连一次就没办法诚实地知道连不连得上，这次探测本身
 *   是「怎么判断在线」的实现细节，不是「这次用户请求被发出去了」。
 *
 * 不做「http 失败就退回 local」这种 try/catch 兜底——那样一条业务校验
 * 失败（比如「标题不能为空」的 400）会被悄悄当成「大概是离线了」，写成
 * 一条看起来正常、实际上服务端从没见过的本地任务，是比直接报错更糟的
 * 结果。选哪条路只看 `isOnline()`，走了哪条路，那条路的错误就原样抛出去。
 */
export async function route<T>(http: () => Promise<T>, local: () => Promise<T>, backfill?: (v: T) => Promise<void>): Promise<T> {
  if (!(await isOnline())) return local();
  const v = await http();
  if (backfill) {
    try {
      await backfill(v);
    } catch {
      // 回填失败不该带崩在线主路径——见上面这个函数的注释。
    }
  }
  return v;
}

// ── 离线时明确不支持的操作 ──

/**
 * 专门的错误类型，不是裸 `Error`——调用方要分得出「这是离线时的预期失败」
 * 和「在线时真的出事了」。`App.tsx` 的 `reload()` 就靠它：`settings` 那一行
 * 离线必然失败（这一条没有本地实现），不该每次刷新都弹一条错误；但**在线**时
 * `GET /api/settings` 单独 500（`device.json` 损坏之类）是真的出事了，必须弹，
 * 不然界面停在一份从没读到过的设置上，用户改一项保存就把真配置冲掉了
 * （整分支审查 I1「门二」）。靠比对错误文案来区分会是同一个字面量写两份，
 * 这里给个类型让 `instanceof` 判。
 */
export class OfflineUnsupportedError extends Error {}

/**
 * 这一批没有本地实现的操作：AI 相关（`expand`/`expandSkip`/`review`/`redoInbox`
 * ——叫 AI 这件事整个发生在服务端，手机上既没有 `claude` 子进程、也没有那份
 * 存着接口地址和密钥的设置，见 已归档的
 * docs/superpowers/plans/2026-08-21-offline-core.md 开工前①。**`redoInbox` 尤其
 * 不能有本地实现**：它一趟要做四件事（旧任务进垃圾箱、要求追加进原文、条目翻回
 * 未处理、再拆一次），最后那件离线根本做不到，前三件做了等于把数据改成一个
 * 「等着被拆、却永远不会被拆」的中间态）、依赖 AI 产出的（`acceptProposal`/`dismissProposal`/
 * `dismissInsight`——提议和观察本身就是要连上服务端才会有的东西）、次要
 * 管理操作（`saveSettings`/`addList`/`restoreTrash`/`purgeTrash`）、附件
 * （二进制，`data/attachments/` 是服务端文件系统，这一批明确不做，见
 * task-2-brief）。
 *
 * 离线时调用这些，**直接抛一个说清楚的错误，不装作成功**——「没做的事
 * 不能在界面上暗示它做了」，见 task-2-brief「别做成一个假的同步」。会经
 * `App.tsx` 已有的 `guard()`/`message.error` 走到用户眼前，不需要额外接线。
 */
export const offlineUnsupported = (label: string) => (): never => {
  throw new OfflineUnsupportedError(`离线时无法${label}，连接服务器之后再试`);
};

// ── 回填：http() 成功之后，把结果顺手写一份进本地缓存 ──

/**
 * `tasks`/`inbox` 的回填要护住「还没同步」的本地改动，不能被服务端的旧
 * 版本覆盖掉——`dirtyTasks`/`dirtyInbox` 那个 id 集合正是为了这件事存在：
 * 服务端此刻还不知道这条本地编辑（这一批不做同步，编辑没推回去过），
 * 拿服务端的旧版本回填的话，会把「离线时改过的标题」悄悄换回「服务端
 * 原文」，用户等于白改了。做法：属于脏 id 的条目保留本地版本，其余的
 * （服务端有、本地没标脏的）用 `http()` 这次的新版本刷新。
 *
 * `lists`/`insights`/`proposals` 这一批没有离线写，没有脏 id 需要保护，
 * 直接整份覆盖。
 */
// 也过锁（`serialized`，见 localStore.ts）：回填是「读脏集 → 读本地 → 写本地」，
// 跟一次正在飞的离线写交错的话，读到的脏集还没有那条记号，写下去就把它盖了。
export const backfillTasks = serialized(async (v: Task[]): Promise<void> => {
  const dirty = await dirtyTasks.ids();
  if (dirty.size === 0) return localTasks.write(v);
  const dirtyLocal = (await localTasks.read()).filter((t) => dirty.has(t.id));
  await localTasks.write([...v.filter((t) => !dirty.has(t.id)), ...dirtyLocal]);
});

export const backfillInbox = serialized(async (v: InboxItem[]): Promise<void> => {
  const dirty = await dirtyInbox.ids();
  if (dirty.size === 0) return localInbox.write(v);
  const dirtyLocal = (await localInbox.read()).filter((x) => dirty.has(x.id));
  await localInbox.write([...v.filter((x) => !dirty.has(x.id)), ...dirtyLocal]);
});

export const backfillLists = (v: List[]): Promise<void> => localLists.write(v);
export const backfillFolders = (v: Folder[]): Promise<void> => localFolders.write(v);
export const backfillInsights = (v: Insight[]): Promise<void> => localInsights.write(v);
export const backfillCountdowns = (v: Countdown[]): Promise<void> => localCountdowns.write(v);
export const backfillProposals = (v: Proposal[]): Promise<void> => localProposals.write(v);

// ── 本地实现（离线读/写真正落地的地方）──
//
// 没有 DEFAULT_SETTINGS——修复轮 2（C2）删掉的，见上面模块注释：伪造一份
// 默认设置当「读到了」的答案比不支持离线更糟，settings 离线直接走
// offlineUnsupported（api.ts），这里不需要一个本地实现。

/**
 * 改动前后一比，**变了的每一条都打上记号**，基准是它改之前那份。
 *
 * 存在的理由是三条连带（`cascadeAll`）改的不止被 patch 的那一条：勾掉一个
 * 三层的项目会顺手改掉底下五条子任务，把父任务挪去别的清单会带走它的整棵
 * 子树。**那几条不打记号的话，改动只活到下一次联网**——`backfillTasks` 只
 * 护住脏 id，其余的一律换成服务端那份，于是子任务原地弹回未完成、弹回旧清单，
 * 屏幕上没有任何地方说得清刚才那一下为什么白做了。
 *
 * 按引用比（`!==`）够用且准确：`applyTaskPatch` 和三条连带都是写时复制
 * （`rows.map((t) => 命中 ? applyTaskPatch(t, ...) : t)`），没动过的那几条
 * 返回的就是原来那个对象。深比一遍反而会把「盖了新 updatedAt、别的没变」
 * 判成没变——那条确实得推回去。
 */
const marksFor = (before: Task[], after: Task[]): Array<readonly [string, Task]> => {
  const now = new Map(after.map((t) => [t.id, t]));
  return before.filter((t) => now.get(t.id) !== t).map((t) => [t.id, t] as const);
};

function newLocalTask(patch: Partial<Task> & { title: string }): Task {
  const at = new Date().toISOString();
  return {
    id: globalThis.crypto.randomUUID(),
    notes: '',
    status: 'todo',
    due: null,
    // 跟服务端 `newTask()` 一字不差：新任务不设开始时间（随时可以做）。
    // 这两份默认值必须一致——离线建的任务推回桌面之后不该跟在线建的长得不一样。
    startAt: null,
    endAt: null,
    reminders: [],
    persistentReminder: false,
    subtasks: [],
    source: 'user',
    aiComment: '',
    createdAt: at,
    updatedAt: at,
    order: null,
    listId: null,
    section: null,
    tags: [],
    priority: 0,
    repeat: null,
    completedAt: null,
    postponeCount: 0,
    waitingFor: null, context: null,
    attachments: [],
    estimateMinutes: null,
    focusSessions: [],
    habit: false,
    // 跟服务端 `newTask()` 的默认值一字不差——两边分叉的话，同一条任务在
    // 线上建和离线建会长得不一样，回到局域网推回去就是一次假冲突。
    pinned: false,
    reviewedAt: null,
    parentId: null,
    ...patch,
  };
}

/**
 * `api.ts` 每个方法的「local」分支——离线时真正被调用的那一条。**只有
 * inbox/tasks/trash 三类支持离线写**（随手记、看任务、改任务、完成任务，
 * 见开工前①）；`lists`/`insights`/`proposals` 不支持离线写，但支持在线时
 * 回填（见上面 `backfillLists` 等），离线读到的是「上一次在线时看到的
 * 快照」，不是恒定的空数组；`conflicts` 不回填，离线读到的是空数组。
 * **`settings` 不在这个对象里**——离线时走 `api.ts` 的 `offlineUnsupported`，
 * 不是本地实现，见本文件顶部模块注释「修复轮 2（C2）」那段。
 *
 * 写入任务的三件事（打补丁的 `firedAt` 重算、完成重复任务生成下一条、
 * 软删除进垃圾箱）**复用 Task 1 提出来的三个纯函数**，不在这里另写一份——
 * 这正是 `server/src/mutate.ts` 存在的意义，两边共用同一份语义，不会出现
 * 「桌面上完成一条重复任务会生成下一条，手机离线时完成同一条却不会」这种
 * 分叉。
 *
 * 这里不做 `checkTaskPatch` 那层白名单校验（`server/src/task.ts`，
 * Task 1 没有把它提成平台无关纯函数，不在这一批「能直接搬」的范围内）——
 * 离线写入信任调用方（网页自己的表单）已经产出了形状合理的 patch，跟
 * server 端面对不可信的外部请求不是同一个信任边界。
 */
const unlocked = {
  // ── 收件箱 ──
  inbox: (): Promise<InboxItem[]> => localInbox.read(),

  addInbox: async (text: string): Promise<InboxItem> => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('文本不能为空');
    const item: InboxItem = {
      id: globalThis.crypto.randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
      processed: false,
      taskIds: [],
    };
    await localInbox.write([...(await localInbox.read()), item]);
    // 基准是 `null`：离线新建的，服务端从来没有过这个 id，没有「改之前那份」。
    await dirtyInbox.mark([[item.id, null]]);
    return item;
  },

  patchInbox: async (id: string, patch: Partial<InboxItem>): Promise<InboxItem> => {
    const all = await localInbox.read();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('没有这一条');
    const next = { ...all[i], ...patch };
    await localInbox.write(all.map((x, k) => (k === i ? next : x)));
    await dirtyInbox.mark([[id, all[i]]]);
    return next;
  },

  deleteInbox: async (id: string): Promise<{ ok: true }> => {
    const all = await localInbox.read();
    // 先把要删的那条捞出来当基准——本地删掉之后它就没别的副本了。
    const gone = all.find((x) => x.id === id);
    if (!gone) throw new Error('没有这一条');
    await localInbox.write(all.filter((x) => x.id !== id));
    await dirtyInbox.mark([[id, gone]]);
    return { ok: true };
  },

  // ── 任务 ──
  tasks: (): Promise<Task[]> => localTasks.read(),

  addTask: async (patch: Partial<Task>): Promise<Task> => {
    if (!patch.title) throw new Error('标题不能为空');
    const task = newLocalTask({ ...patch, title: patch.title });
    await localTasks.write([...(await localTasks.read()), task]);
    // 同 addInbox：离线新建的，没有基准。
    await dirtyTasks.mark([[task.id, null]]);
    return task;
  },

  patchTask: async (id: string, patch: Partial<Task>): Promise<Task> => {
    const all = await localTasks.read();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('没有这个任务');
    const now = new Date();
    const iso = now.toISOString();
    const next = applyTaskPatch(all[i], patch, iso);
    // 三条连带跟服务端走同一份 `cascadeAll`。**离线漏掉它们不只是「少做一点」**：
    // 「连带做完了 N 条子任务」那句提示是界面自己按服务端的规矩算出来的
    // （`lib/undoDone.ts`），离线时照样弹——提示说做了、屏幕上没做，一屏之内
    // 自相矛盾。
    const rows = cascadeAll(all[i], next, all.map((x, k) => (k === i ? next : x)), iso);
    const born = maybeSpawnNextInstance(all[i].status, next, rows, now);
    await localTasks.write(born ? [...rows, born] : rows);
    // 改的那条**和被连带改到的那几条**各带各的基准（改之前那份，见 `marksFor`）；
    // 顺手生出来的下一条带 `null`——服务端从来没有过它这个 id，没有基准可言。
    await dirtyTasks.mark(born ? [...marksFor(all, rows), [born.id, null]] : marksFor(all, rows));
    return next;
  },

  /**
   * 跳过这一次。**离线也做得了**：任务本来就是可离线写的那一类，而跳过是
   * 日常动作，没有理由让它比「改期」金贵。
   *
   * `postponeCount` 按回原值，跟服务端那条路由一字不差——跳过不是拖延，
   * 理由写在 `POST /api/tasks/:id/skip` 上面。
   */
  skipTask: async (id: string): Promise<Task> => {
    const all = await localTasks.read();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('没有这个任务');
    const patch = skipPatch(all[i], new Date());
    if (!patch) throw new Error('这条跳不动：不重复、没有截止时间，或者次数已经用完');
    const next = { ...applyTaskPatch(all[i], patch, new Date().toISOString()), postponeCount: all[i].postponeCount };
    await localTasks.write(all.map((x, k) => (k === i ? next : x)));
    await dirtyTasks.mark([[id, all[i]]]);
    return next;
  },

  deleteTask: async (id: string): Promise<{ ok: true }> => {
    const all = await localTasks.read();
    // 先把要删的那条捞出来当基准——软删除之后本地任务列表里就没有它了，
    // 垃圾箱里那份还多盖了个 `deletedAt`，不是「服务端那份」的样子。
    const gone = all.find((x) => x.id === id);
    if (!gone) throw new Error('没有这个任务');
    const trash = await localTrash.read();
    const next = softDeleteTasks(all, trash, [id], new Date().toISOString());
    await localTrash.write(next.trash);
    await localTasks.write(next.tasks);
    await dirtyTasks.mark([[id, gone]]);
    return { ok: true };
  },

  // 算法本身（下标就是新 order、跳过没变的、找不到的 id 忽略）是
  // server/src/mutate.ts 的 applyReorder——不在这里另写一份会悄悄跟服务端
  // 分叉的排序逻辑，见那份函数的注释（task-2-report 修复轮 2 I5）。
  reorderTasks: async (ids: string[]): Promise<{ ok: true }> => {
    const all = await localTasks.read();
    // 排序之前那份，按 id 查得到——`applyReorder` 返回的是排完的那份，
    // 从它里面取会拿到新 `order`，那就不是基准了。
    const before = new Map(all.map((t) => [t.id, t]));
    const { tasks: next, changedIds } = applyReorder(all, ids, new Date().toISOString());
    if (changedIds.length > 0) {
      await localTasks.write(next);
      await dirtyTasks.mark(changedIds.map((id) => [id, before.get(id)!] as const));
    }
    return { ok: true };
  },

  patchTasks: (ids: string[], patch: Partial<Task>): Promise<{ updated: number }> =>
    localApi.patchTasksEach(ids.map((id) => ({ id, patch }))),   // 经 localApi：拿的是锁过的那份

  /** 每条各改各的。`patchTasks` 是它的退化情况（同一份 patch 套给每个 id），
   *  两边共用这一份实现——服务端那条路由也是先把两种请求体归一成同一种再走
   *  同一段代码，两侧的分工方式保持一致。 */
  patchTasksEach: async (patches: Array<{ id: string; patch: Partial<Task> }>): Promise<{ updated: number }> => {
    const byId = new Map(patches.map((e) => [e.id, e.patch]));
    const all = await localTasks.read();
    // 各自 patch → 三条连带（深的先）→ 生成下一条，跟服务端批量 PATCH 是**同一个
    // 函数**（`mutate.ts` 的 `patchMany`）。原来这儿逐字抄着服务端那个循环，两条
    // 「批量 ≠ 逐条」的 bug 也跟着抄了一份，来龙去脉写在它顶上。
    const { rows, born, touched } = patchMany(all, byId, new Date());
    if (touched.length > 0) {
      await localTasks.write(born.length ? [...rows, ...born] : rows);
      // 基准是**改之前那份**（`all`）。从 `rows` 里取会成了「基准 == 我改的那份」，
      // 推回去时判成没改过、静默不推。被连带改到的那几条一并进去，见 `marksFor`。
      await dirtyTasks.mark([...marksFor(all, rows), ...born.map((b) => [b.id, null] as const)]);
    }
    return { updated: touched.length };
  },

  deleteTasks: async (ids: string[]): Promise<{ deleted: number }> => {
    const idSet = new Set(ids);
    const all = await localTasks.read();
    const gone = all.filter((t) => idSet.has(t.id));
    if (!gone.length) return { deleted: 0 };
    const trash = await localTrash.read();
    const next = softDeleteTasks(all, trash, idSet, new Date().toISOString());
    await localTrash.write(next.trash);
    await localTasks.write(next.tasks);
    // `gone` 是 `softDeleteTasks` 之前捞的，还没盖 `deletedAt`——正是基准该有的样子。
    await dirtyTasks.mark(gone.map((t) => [t.id, t] as const));
    return { deleted: gone.length };
  },

  // ── 垃圾箱。
  //    trash 不参与在线回填（coordinator 划定的回填名单里没有它，见
  //    task-2-report「修复轮 1」）——离线时只看得到离线软删除过的那些，
  //    看不到「在线时已经在垃圾箱里」的条目，这是有意留白，不是漏做。
  trash: (): Promise<TrashItem[]> => localTrash.read(),

  /**
   * 还原。**补的是一扇单向门**：离线删得掉、却永远还不了，而垃圾箱存在的
   * 全部意义就是让删除不是单向的。离线看得见的又恰好只有「离线删掉的那几条」
   * （见上面那段），也就是说，撤销的正是刚刚那一下。
   *
   * **记号要自己打，`pushBack` 那条「翻面」不够。** 原来这儿一条记号都不打，
   * 理由是：`pushBack` 判「改还是删」只看脏集里的 id 在本地任务表里还在不在
   * （见 pushBack.ts 顶部），还原把它放回 `localTasks`，那条判断自动从 `delete`
   * 翻成 `upsert`。**这话只在记号还在的时候成立**，而记号是会走的：
   *
   * 离线删掉 → 中间连上一下、这条删除推回去了（`unmarkSettled` 把记号清掉，
   * 它的活儿干完了）→ 又离线。**而 `localTrash` 从来不修剪**（写它的只有
   * 软删除和这儿），所以垃圾箱里照样列着它，照样点得动还原。这一下没有任何
   * 记号：下一次联网 `pushBackIfDirty` 看到空脏集直接不发，`backfillTasks`
   * 拿服务端那份整个盖掉本地——服务端早就没有它了。**任务从看板上没了，
   * 垃圾箱里也没了**（还原那一步已经把它从 `localTrash` 摘掉），两个地方都
   * 找不回来，屏幕上一个字都没有。
   *
   * 基准给 `null`，两种情形都对：记号还在的（删除没推过）走 `addToDirty` 的
   * 「先到的基准不许被后到的覆盖」，原基准原封不动；记号没了的（删除推过了）
   * 服务端此刻**真的没有这条**，而「服务端没有」正是 `null` 在 `decidePush`
   * 里的含义，下一拍走「离线新建 → 直接创建」把它建回去。反过来把删之前那份
   * 当基准才是错的：那条路判 `conflict`，给他自己的一次还原写一份撞车副本。
   *
   * 顺带补上的第二件事：`onLocalWrite` 只在 `addToDirty` 里叫（localStore.ts），
   * 所以原来还原完屏幕不刷——提示语说「已还原」，列表上没动静，得自己切一下
   * 屏幕才看得到。
   */
  restoreTrash: async (id: string): Promise<Task> => {
    const next = restoreFromTrash(await localTasks.read(), await localTrash.read(), id);
    if (!next) throw new Error('垃圾箱里没有这一条');
    await localTasks.write(next.tasks);
    await localTrash.write(next.trash);
    // `back` 而不是 `[restored]`：同一次删进去的子任务是一起捞回来的。
    await dirtyTasks.mark(next.back.map((t) => [t.id, null] as const));
    return next.restored;
  },

  // ── 没有离线写，但在线时会被 backfillLists/backfillInsights/
  //    backfillProposals 回填（见上面），所以这里读到的不再是恒定的空数组
  //    ——第一次离线之前只要成功上线读过一次，这里就有上一次看到的快照。
  proposals: (): Promise<Proposal[]> => localProposals.read(),
  lists: (): Promise<List[]> => localLists.read(),
  folders: (): Promise<Folder[]> => localFolders.read(),
  insights: (): Promise<Insight[]> => localInsights.read(),

  countdowns: (): Promise<Countdown[]> => localCountdowns.read(),

  // 不回填，理由见 dataSource.ts 模块顶部注释——离线的手机上「同步冲突」
  // 这个问题本来就不成立。
  conflicts: (): Promise<ConflictFile[]> => Promise.resolve([]),
};

/**
 * **每一个写方法都过 `serialized`**（理由见 localStore.ts 那段）。读方法不过：
 * 读不改盘，排队只会让界面刷新等在写后面。`patchTasks` 不在名单里，它只是转调
 * `patchTasksEach`（已经在名单里）——自己也拿锁的话会等自己，死锁。
 * `localWrites.guard.test.ts` 盯着这份名单跟对象里真正会写的方法对得上。
 */
export const LOCAL_WRITES = [
  'addInbox', 'patchInbox', 'deleteInbox',
  'addTask', 'patchTask', 'skipTask', 'deleteTask', 'reorderTasks', 'patchTasksEach', 'deleteTasks',
  'restoreTrash',
] as const;
export const localApi: typeof unlocked = {
  ...unlocked,
  ...Object.fromEntries(LOCAL_WRITES.map((k) => [k, serialized(unlocked[k] as (...a: unknown[]) => Promise<unknown>)])),
};
