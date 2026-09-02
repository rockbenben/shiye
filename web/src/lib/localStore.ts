import { Preferences } from '@capacitor/preferences';
import type { Countdown, Folder, InboxItem, Insight, List, Proposal, Task, TrashItem } from '../types.js';

/**
 * 离线本地层的落盘位置：复用 `apiBase.ts` 已经在用的同一个
 * `@capacitor/preferences`——桌面/浏览器回退 `localStorage`，Android 走真的
 * 原生桥，同一份代码三个平台都能跑，**零新增依赖**（见 task-2-report「选存储」
 * 那节的四问）。个人单用户量级（当前 7 条任务、7 条收件箱，现实上限也就
 * 几百条）远在它的容量之下——真长到需要索引/分页查询的地步，IndexedDB
 * （`idb`）是下一步的升级路径，这一批不需要。
 *
 * **修复轮 1**：这里原来的注释说「不做在线时的镜像缓存」——那是把 brief
 * 「上限：连得上时不许走本地」读成了「连得上时一个字节都不许写本地」，读窄了。
 * 实际判据只管「**答案从哪来**」（在线时答案必须是 `http()` 的返回值，不能拿
 * 本地缓存顶），不管「http() 成功之后要不要顺手把结果写进本地缓存留着离线用」
 * ——那是两件事，见 `dataSource.ts` 的 `route()` 现在的第三个参数 `backfill`。
 * **`tasks`/`inbox`/`lists`/`insights`/`proposals` 五类在线时回填**——
 * `trash` **不在这份名单里**（复审 task-2-report 修复轮 2 I6 指出这里曾经
 * 写错成六类、把 trash 也算了进去，`localTrash` 唯一的写入方是离线软删除，
 * 没有 `backfillTrash` 这个函数）；`settings`/`conflicts` 也不回填（各自的
 * 理由见 `dataSource.ts` 模块注释，`settings` 修复轮 2 之后连本地实现都
 * 没有了，离线直接报错，不是「不回填」这么简单）。附件仍然不做（二进制，
 * `data/attachments/` 是服务端文件系统）。
 */

const KEY = {
  tasks: 'local:tasks',
  inbox: 'local:inbox',
  trash: 'local:trash',
  lists: 'local:lists',
  folders: 'local:folders',
  insights: 'local:insights',
  countdowns: 'local:countdowns',
  proposals: 'local:proposals',
  dirtyTasks: 'local:dirtyTaskIds',
  dirtyInbox: 'local:dirtyInboxIds',
} as const;

async function readArr<T>(key: string): Promise<T[]> {
  const r = await Preferences.get({ key });
  if (!r.value) return [];
  try {
    const v: unknown = JSON.parse(r.value);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    // 存的东西不是合法 JSON（几乎不会发生，但读到坏数据不该让整个离线层炸掉）
    // ——当成空表处理，跟「这个 key 还没写过」同一种效果。
    return [];
  }
}

async function writeArr<T>(key: string, v: T[]): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(v) });
}

export const localTasks = {
  read: (): Promise<Task[]> => readArr<Task>(KEY.tasks),
  write: (v: Task[]): Promise<void> => writeArr(KEY.tasks, v),
};

export const localInbox = {
  read: (): Promise<InboxItem[]> => readArr<InboxItem>(KEY.inbox),
  write: (v: InboxItem[]): Promise<void> => writeArr(KEY.inbox, v),
};

export const localTrash = {
  read: (): Promise<TrashItem[]> => readArr<TrashItem>(KEY.trash),
  write: (v: TrashItem[]): Promise<void> => writeArr(KEY.trash, v),
};

/**
 * 这三类**这一批不支持离线写**（只有 tasks/inbox/trash 三类才有，见上面），
 * 但支持在线时回填——写只用来存「上一次在线读到的快照」，`write()` 的唯一
 * 调用方是 `dataSource.ts` 的 backfill* 函数，不是给某个「离线新建一条
 * proposal」之类的写路径用的（这一批没有那种写路径）。
 */
export const localLists = {
  read: (): Promise<List[]> => readArr<List>(KEY.lists),
  write: (v: List[]): Promise<void> => writeArr(KEY.lists, v),
};

/** 文件夹（把清单分组，仿滴答清单）。跟 lists 一样：只读缓存 + 在线回填，
 *  没有离线写路径——增删改一律 `offlineUnsupported`。 */
export const localFolders = {
  read: (): Promise<Folder[]> => readArr<Folder>(KEY.folders),
  write: (v: Folder[]): Promise<void> => writeArr(KEY.folders, v),
};

export const localInsights = {
  read: (): Promise<Insight[]> => readArr<Insight>(KEY.insights),
  write: (v: Insight[]): Promise<void> => writeArr(KEY.insights, v),
};

/** 倒数纪念日。跟 lists/insights 一样只读缓存、没有离线写路径——离线时
 *  新建/改/删纪念日走 `offlineUnsupported`，见 `dataSource.ts` 那份名单。 */
export const localCountdowns = {
  read: (): Promise<Countdown[]> => readArr<Countdown>(KEY.countdowns),
  write: (v: Countdown[]): Promise<void> => writeArr(KEY.countdowns, v),
};

export const localProposals = {
  read: (): Promise<Proposal[]> => readArr<Proposal>(KEY.proposals),
  write: (v: Proposal[]): Promise<void> => writeArr(KEY.proposals, v),
};

/**
 * 「还没同步」的记号：**id → 基准快照**。基准 = 本地第一次改它之前、服务端那份
 * 长什么样（本地缓存里那份就是它——在线读成功时 `backfill*` 写进去的正是服务端
 * 那份）。`null` = 没有基准：离线新建的（服务端从来没有过这个 id），以及旧格式
 * 迁移过来的那些。
 *
 * **为什么存快照不存时间戳**：`Task` 有 `updatedAt`，**而 `InboxItem` 没有**。给
 * `InboxItem` 加字段要动那十五个跨包复制的类型、要迁移拥有者的真实数据；存快照
 * 两种实体共用一套判据，零 schema 改动、零迁移。代价是本地多存一份被改过的实体，
 * 个人量级可以忽略。
 *
 * **上一版这段注释里的两句话现在是错的，已经删掉**：「这个集合只增不减」——
 * 有了 `unmark()` 之后不再成立，推回去结清的记号要清掉，不然那条任务此后再也
 * 收不到服务端更新；「不需要区分新建/修改/删除」——三方比较正是靠 `base` 是不是
 * `null`、以及那条 id 还在不在 `localTasks` 里，把这三种分开的。
 * （144 附带的那条教训：注释里点名的每个依赖，换场景时挨个问一遍还在不在。）
 * 完整规矩见 已归档的 `docs/superpowers/plans/2026-08-22-push-back.md`。
 */
export type DirtyMap<T> = Record<string, T | null>;

async function readDirty<T>(key: string): Promise<DirtyMap<T>> {
  const r = await Preferences.get({ key });
  if (!r.value) return {};
  try {
    const v: unknown = JSON.parse(r.value);
    // 旧格式：`["id1","id2"]`。拥有者手机上装着的上一版就是这个形状，读到它不能炸，
    // 也不能整份丢掉（那等于把他离线改过的东西悄悄忘掉）——迁移成「有记号、没有
    // 基准」，推送时走 base===null 那几条规矩，见计划⑥那张表。
    if (Array.isArray(v)) {
      return Object.fromEntries(v.filter((x): x is string => typeof x === 'string').map((id) => [id, null]));
    }
    if (v && typeof v === 'object') return v as DirtyMap<T>;
  } catch {
    // 落到下面那条「坏数据」的统一出口。解析不出来和解析出来不是个对象，后果一模一样。
  }
  // **坏数据当空表，代价是把用户的改动悄悄弄丢。** 丢掉的不是一份重新联网就能拉回来
  // 的缓存，而是「这几条本地改过、还没推回去」这个事实：记号没了，`pushBack` 就再也
  // 看不见它们，那些改动**此后永远推不回服务端**。这正是这一整批工作要消灭的那个问题
  // 本身，所以它至少要留个信号——`console.error`，不要连痕迹都没有。
  //
  // 那为什么还是不抛：`ids()` 的消费方 `backfillTasks`/`backfillInbox` 在**每次在线读
  // 成功之后**都会调一次，抛的话会把在线主路径也一起牵连进去，「联网也用不了」比
  // 「丢掉记号」更大。（早先这里写的理由是「抛了整个离线层连读都读不了」——**那是错的**，
  // 复审核过：`localTasks`/`localInbox`/`localTrash` 走的是另一个函数 `readArr`、另一批
  // key，`readDirty` 抛不到它们头上，离线读照样读得出来。真正被牵连的是在线回填。）
  //
  // **这条欠账在 Task 8 还上了**：`console.error` 留给开发者（带 key 和字节数，
  // 排查用），`dirtyReadFailure` 留给用户——`App.tsx` 的 `refreshOffline()` 每一拍
  // 取一次，取到就弹一条红字。为什么是「取走并清掉」而不是订阅：这条信号一次
  // 有效，弹过就算说过了；`readDirty` 一趟能被 `mark()`/`ids()`/`all()` 叫好几次，
  // 每次都推给订阅方等于同一件事弹三条。
  dirtyReadFailure = '本地「哪些改动还没推回桌面」的记录读不出来，已当空的处理——那些离线改动推不回去了，只能重新改一遍';
  console.error(`[localStore] ${key} 里存的不是脏集（${r.value.length} 字节），当空表处理——这些还没推回服务端的记号就此丢了`);
  return {};
}

/** 上一次 `readDirty` 读到坏数据留下的话，还没给人看过的那句。见 `readDirty` 末尾。 */
let dirtyReadFailure: string | null = null;

/** 取走并清掉那句话。没有就是 `null`。**唯一的消费方是 `App.tsx` 的 `refreshOffline()`。** */
export function takeDirtyReadFailure(): string | null {
  const msg = dirtyReadFailure;
  dirtyReadFailure = null;
  return msg;
}

/**
 * 「本地刚写过一次」的订阅点——**离线时替代 watcher → SSE 那条链**。
 *
 * `App.tsx` 的 `guard()` 上面写着这个仓库的规矩：「每个写操作之后不手动刷新
 * 状态：写进文件 → watcher → SSE → reload。少一条更新路径，就少一处『界面
 * 和文件对不上』的可能。」这条链**在线时成立，离线时整段不存在**（连不上
 * 服务端，就没有 watcher 也没有 SSE，`EventSource` 压根连不上），后果是
 * 飞行模式下点完成/编辑/随手记，数据真落进本地存储了，界面纹丝不动——
 * 整分支审查 C1。
 *
 * 补的这一声接在 `addToDirty` 里（也就是 `dirtyTasks.mark`/`dirtyInbox.mark`
 * 唯一的实现），不是接在 `dataSource.ts` 那九个离线写方法上。**`removeFromDirty`
 * （`unmark`）故意不叫**，理由见那个函数末尾。为什么接在这里：
 * - **它是所有离线写的唯一咽喉**。九个写方法（`addInbox`/`patchInbox`/
 *   `deleteInbox`/`addTask`/`patchTask`/`deleteTask`/`reorderTasks`/
 *   `patchTasks`/`deleteTasks`）每一个都在写完之后打这个记号，一个不漏；
 *   逐个方法各叫一声的话，就又是这个仓库栽过好几次的「N 个接线点，漏掉
 *   一处不会报错、只会静默失灵」。
 * - **它天然只在「真的写了东西」时响**。读（`localApi.tasks()` 之类）和
 *   在线回填（`backfillTasks` 只 `ids()` 不 `mark()`）都碰不到这里，所以
 *   `reload()` → 读 → 又触发一次 `reload()` 这种回环不可能发生；
 *   `patchTasks` 一条都没命中、`reorderTasks` 顺序没变时也不标记，那两种
 *   情况本来就没有新东西要画。
 *
 * 不用 `window.dispatchEvent`：这个文件跑在 vitest 的 node 档里（见
 * `localStore.test.ts` 顶部），node 的 `globalThis` 不是 `EventTarget`
 * （`addEventListener` 实测是 `undefined`），用 DOM 事件就得加一句
 * `typeof window !== 'undefined'` 的护栏，而那句护栏自己没人测。一个模块级
 * 的回调集合三行就够，两个环境里行为一样。
 */
const localWriteListeners = new Set<() => void>();

/** 订阅「本地刚写过一次」。返回退订函数——用法跟 `api.ts` 的 `subscribe()` 一样。 */
/**
 * **本地存储的读改写一律排队，一次只跑一个。**
 *
 * 这个文件里每一张表、每一个记号集合都是「读整份 → 改 → 写整份」，而
 * `Preferences.get/set` 是异步的：两个写同时在飞，两个都读到旧的那份，后写的把
 * 先写的整个盖掉。实测（`dataSource.test.ts`）：离线连点两张卡的「完成」，
 * `Promise.all` 一起发——**第一张的完成和它的脏记号都没了**（本地表 `a=todo`、
 * 脏集里只有 `b`）。屏幕上第一下像是没按到；就算按到了，没有记号的改动
 * `pushBack` 也不会推，下一次回填就把它换回服务端那份。
 *
 * 一条 promise 链当锁：后来的等前面的做完再开始。一次失败不能把后面的全卡死
 * （`catch` 那句），失败本身照样抛给它自己的调用方。放在这一层而不是每个
 * 调用点自己想：这一层的每个写方法、回填、推送回执的清记号，都是同一种
 * 读改写，漏一个就又是一条会静默丢数据的路。
 */
let chain: Promise<unknown> = Promise.resolve();
export function serialized<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => {
    const run = chain.then(() => fn(...args));
    chain = run.catch(() => undefined);
    return run;
  };
}

export function onLocalWrite(fn: () => void): () => void {
  localWriteListeners.add(fn);
  return () => { localWriteListeners.delete(fn); };
}

async function addToDirty<T>(key: string, entries: Iterable<readonly [string, T | null]>): Promise<void> {
  const cur = await readDirty<T>(key);
  // **先到的基准不许被后到的覆盖。** 连着离线改两次，基准要是「第一次改之前服务端
  // 那份」，不是「第二次改之前本地那份」——后者已经含着第一次的改动，拿它去跟服务端
  // 比，第一次的改动会被判成「服务端也改过」而撞车。
  for (const [id, base] of entries) if (!(id in cur)) cur[id] = base;
  await Preferences.set({ key, value: JSON.stringify(cur) });
  // 放在最后：九个写方法都是「先写数据、再打记号」，叫这一声的时候这次改动
  // 已经落盘了，订阅方（`App.tsx` 的 `reload()`）读到的一定是新的那份。
  for (const fn of localWriteListeners) fn();
}

/**
 * 换基准：**只改已经在表里的那几条，一次读改写。**
 *
 * 跟上面的 `addToDirty` 并列存在，两者对「已有记号」的态度**刻意相反**，不是其中
 * 一个写错了：
 * - `addToDirty`（`mark`）记的是「本地改过这一条」，基准必须是**第一次改它之前**
 *   服务端那份，所以**对已有记号不覆盖**（理由见它上面那段）。
 * - 这一个记的是另一件事：**记号还留着**（那次改动没结清），可服务端那份在这中间
 *   被这次推送改掉了，基准得跟着换成服务端现在那份，所以**明确要覆盖**。
 *   `pushBack.ts` 的 `unmarkSettled` 是唯一的调用方，那边写着为什么非换不可。
 *
 * **不新建记号**（`id in cur` 才改）：不在表里说明它已经结清了，凭空建一个记号会让
 * 一条已经推回去的东西下次再推一遍。
 *
 * **为什么是一个函数而不是 `unmark` + `mark` 两趟**：那两趟之间记号会真的离开存储，
 * 进程在这中间被杀（手机上很常见）或者第二趟抛错，那条离线改动的记号就没了——
 * 此后永远推不回去、零信号，正是这一整批在消灭的形状。原子性得由这一层保证，
 * 不能在调用方拿两次 IO 拼出来。
 *
 * **不叫 `onLocalWrite`**：跟 `removeFromDirty` 同一条理由，没改任何用户看得见的数据。
 */
async function setDirtyBase<T>(key: string, entries: Iterable<readonly [string, T | null]>): Promise<void> {
  const cur = await readDirty<T>(key);
  let changed = false;
  for (const [id, base] of entries) if (id in cur) { cur[id] = base; changed = true; }
  if (!changed) return;
  await Preferences.set({ key, value: JSON.stringify(cur) });
}

async function removeFromDirty(key: string, ids: Iterable<string>): Promise<void> {
  const cur = await readDirty<unknown>(key);
  // 一个都没命中就别写盘：推送流程每一轮回执都调一次，「这一轮什么都没结清」是常态。
  let changed = false;
  for (const id of ids) if (id in cur) { delete cur[id]; changed = true; }
  if (!changed) return;
  await Preferences.set({ key, value: JSON.stringify(cur) });
  // **不叫 `onLocalWrite`**：清记号不改任何用户看得见的数据。而且叫了会让 App.tsx
  // 立刻 reload() 一次，而推送流程自己在回执之后就 reload——那才是该刷的那一次。
}

export const dirtyTasks = {
  all: (): Promise<DirtyMap<Task>> => readDirty<Task>(KEY.dirtyTasks),
  ids: async (): Promise<Set<string>> => new Set(Object.keys(await readDirty(KEY.dirtyTasks))),
  mark: (entries: Iterable<readonly [string, Task | null]>): Promise<void> => addToDirty(KEY.dirtyTasks, entries),
  setBase: (entries: Iterable<readonly [string, Task | null]>): Promise<void> => setDirtyBase(KEY.dirtyTasks, entries),
  unmark: (ids: Iterable<string>): Promise<void> => removeFromDirty(KEY.dirtyTasks, ids),
};

export const dirtyInbox = {
  all: (): Promise<DirtyMap<InboxItem>> => readDirty<InboxItem>(KEY.dirtyInbox),
  ids: async (): Promise<Set<string>> => new Set(Object.keys(await readDirty(KEY.dirtyInbox))),
  mark: (entries: Iterable<readonly [string, InboxItem | null]>): Promise<void> => addToDirty(KEY.dirtyInbox, entries),
  setBase: (entries: Iterable<readonly [string, InboxItem | null]>): Promise<void> => setDirtyBase(KEY.dirtyInbox, entries),
  unmark: (ids: Iterable<string>): Promise<void> => removeFromDirty(KEY.dirtyInbox, ids),
};
