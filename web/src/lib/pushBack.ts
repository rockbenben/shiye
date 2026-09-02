import { api } from '../api.js';
import type { InboxItem, Task } from '../types.js';
import { stableKey, type PushEntry, type PushKindResult } from '../../../server/src/push.js';
import { dirtyInbox, dirtyTasks, localInbox, localTasks, serialized, type DirtyMap } from './localStore.js';

/**
 * 回到局域网时，把离线期间的改动推回桌面。**这一半只负责「发什么、回来之后清哪些
 * 记号」，判定在服务端**（`server/src/push.ts` 的 `decidePush`，两边共用同一份）。
 *
 * `localTrash` 一个字节都不读：`localApi.deleteTask` 是先把条目从 `localTasks` 挪进
 * `localTrash`、再打记号，所以「脏集里有、本地任务表里没有」就是「离线删掉的」，
 * 这一句话就够判。少读一张表，也就少一条「trash 和脏集会不会对不上」的隐性契约。
 * 删除条目只带基准（服务端要判的是「服务端那份跟基准一不一样」，手机那份长什么样
 * 对删不删这个决定没有影响）。
 */
export interface PushSummary {
  pushed: number;
  conflicted: number;
  /** 「离线删掉的、但服务端没删」几条——那几条任务会重新出现。见 `revivedCount`。 */
  revived: number;
}

// 「正在飞」的那一次。60 秒心跳、SSE 重连、离线→在线跃迁可能同一拍都叫过来，
// 跟 `dataSource.ts` 里 `isOnline()` 的 `pending` 同一个套路、同一个理由。
let inflight: Promise<PushSummary | null> | null = null;

/** 仅供测试：清掉「正在飞」的那一份。 */
export function resetPushInflightForTest(): void { inflight = null; }

/** 脏集空就返回 `null`（一次网络都不发）。并发调用去重成同一次飞行中的请求。 */
export function pushBackIfDirty(): Promise<PushSummary | null> {
  if (!inflight) inflight = run().finally(() => { inflight = null; });
  return inflight;
}

/**
 * 「改还是删」只看一件事：**脏集里的这个 id 在本地那张表里还在不在**。在 → `upsert`，
 * 不在 → `delete`。
 *
 * `base` 是**本地第一次改它之前服务端那份**（脏集的值），`value` 是**手机上现在那份**
 * （本地表里那份）。搞反的症状是服务端每条都判 `clear`、静默不推，而这一层自己不会
 * 报任何错——所以夹具里这两个值必须明显不同（`pushBack.test.ts` 那两条 `upsert` 用例）。
 */
function entriesFor<T extends { id: string }>(dirty: DirtyMap<T>, rows: T[]): PushEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Object.entries(dirty).map(([id, base]) => {
    const mine = byId.get(id);
    return mine
      ? { id, op: 'upsert' as const, base, value: mine }
      : { id, op: 'delete' as const, base, value: null };
  });
}

/**
 * 清记号。**三个桶都清**——正本写死的一条：不清的话每次重连都再撞一次、再写一份
 * 副本，实体目录会堆满。**没出现在任何桶里的保留记号**（服务端只处理了一部分，或者
 * 整个请求根本没到）。这两句话就是「部分成功」的全部表达，没有第四个桶。
 *
 * 清之前**重读一次本地**：推送在飞的时候用户又离线改了同一条的话，那次改动的记号
 * 不能被这次的回执顺手清掉——清了它就再也推不回去，而且没有任何信号。
 *
 * **记号留着的那几条要顺手换基准**（整分支审查 I2）。只留记号是做对了一半：基准
 * 还停在「上一次改它之前服务端那份」`B0`，而服务端此刻已经是刚推上去的 `V1` 了，
 * 下一拍三方比较得到「服务端 != 我现在这份、服务端 != 基准」→ **判成冲突**。于是
 * 没有第二台设备参与，用户自己接着改的第二次被写成冲突副本、屏幕上弹「N 条撞车」
 * ——三方比较存在的意义就是不让这种假撞车发生。所以这几条的记号留着不动，**基准
 * 换成服务端现在真的那份**：
 *
 * - **`upsert`**：就是这次发出去的 `value`——`pushed` 是刚写进去的那份，`cleared`
 *   是「服务端本来就等于它」。`conflicted` 那几条服务端留的是桌面自己那份、而回执
 *   里只有 id 没有内容，拿 `value` 当基准是个猜；方向无害：三者仍然互不相同，下一拍
 *   照样判冲突，跟留着 `B0` 同一个结果。
 * - **`delete`**：新基准是 `null`（`value` 本来就是 `null`），也就是「没有基准」。
 *   推成功时服务端**真的没有这条了**，而「服务端没有」正是 `null` 在 `decidePush`
 *   里的含义——本地又新建回来的那份下一拍走「离线新建 → 直接创建」，正确。删除判成
 *   `clear`/`conflict` 时服务端那份同样不在回执里，只能是「没有基准」，而那条路的
 *   方向本来就是保守那侧（不删、撞车写副本），不会因为基准是 `null` 多丢东西。
 *
 * **换基准走 `setBase`，不是 `unmark` 之后再 `mark`**（整分支审查 I-A）。两个理由：
 * `mark` 对已有记号**不覆盖**基准（`localStore.ts` 的 `addToDirty`，Task 1 的设计，
 * 有测试守着），指望它覆盖是覆盖不掉的；而先 `unmark` 再 `mark` 会让**记号真的离开
 * 存储一小会儿**——进程在这中间被杀（手机上很常见）或者第二趟抛错，那条离线改动的
 * 记号就没了，此后永远推不回去、零信号，正好是这个函数存在的理由本身。所以
 * `localStore.ts` 那边加了一个一次读改写的 `setBase`：**留下的记号一刻都不离开存储**。
 */
// 过锁（`serialized`，见 localStore.ts）：「重读一次本地 → 清记号 / 换基准」是一次
// 读改写，跟推送在飞时用户的下一次离线写交错，正是上面那段要防的那种丢法。
const unmarkSettled = serialized(async <T extends { id: string }>(
  dirty: {
    setBase: (entries: Iterable<readonly [string, T | null]>) => Promise<void>;
    unmark: (ids: Iterable<string>) => Promise<void>;
  },
  read: () => Promise<T[]>,
  sent: PushEntry[],
  result: PushKindResult,
): Promise<void> => {
  const settled = [...result.pushed, ...result.cleared, ...result.conflicted];
  if (settled.length === 0) return;
  const sentById = new Map(sent.map((e) => [e.id, e]));
  const now = new Map((await read()).map((r) => [r.id, r]));
  const drop: string[] = [];
  const rebase: (readonly [string, T | null])[] = [];
  // 回执里出现了这次根本没发过的 id（推送途中才标脏的）一概不碰：记号和基准都留着。
  for (const id of settled) {
    const e = sentById.get(id);
    if (!e) continue;
    const stale = e.op === 'delete' ? now.has(id) : stableKey(now.get(id)) !== stableKey(e.value);
    if (stale) rebase.push([id, e.value as T | null]); else drop.push(id);
  }
  await dirty.unmark(drop);
  if (rebase.length > 0) await dirty.setBase(rebase);
});

/**
 * 「离线删掉的、但服务端没删」几条。旧格式的脏记号迁移过来时**没有基准**（上一版
 * 只存了 id），删除判不出服务端这期间动没动过，规矩是**不删也不写副本**，判成
 * `cleared`（`decidePush` 里 `entry.base === null` 那一支，计划⑥那张表的最后一行）
 * ——那条任务于是会在推完那次刷新里重新出现在看板上。
 *
 * **这是这一批唯一一种「界面自己变了，而 `pushed`/`conflicted` 两个数都是 0」的走法**：
 * 不数出来的话用户看到的是任务凭空复活、屏幕上一个字都没有（整分支审查 M3）。
 *
 * 会多数的那一格：服务端本来就没有这条（桌面上也删过）时同样判 `clear`，那种情况
 * 什么都不会重新出现。回执里只有 id、分不出是哪一支，所以文案说的是「桌面上还在的
 * 会重新出现」，不打包票每一条都会。
 */
const revivedCount = (sent: PushEntry[], result: PushKindResult): number => {
  const cleared = new Set(result.cleared);
  return sent.filter((e) => e.op === 'delete' && e.base === null && cleared.has(e.id)).length;
};

async function run(): Promise<PushSummary | null> {
  const [dt, di] = await Promise.all([dirtyTasks.all(), dirtyInbox.all()]);
  if (Object.keys(dt).length === 0 && Object.keys(di).length === 0) return null;
  const [taskRows, inboxRows] = await Promise.all([localTasks.read(), localInbox.read()]);
  const tasks = entriesFor<Task>(dt, taskRows);
  const inbox = entriesFor<InboxItem>(di, inboxRows);
  // 抛出去就抛出去：一个记号都不清，下次重连原样再推一遍。**绝不在这里 catch 成
  // 「推完了」**——那正是假绿总账 139 那条「把会报错的路改成静默成功的路」。
  const res = await api.pushBack({ tasks, inbox });
  await Promise.all([
    unmarkSettled(dirtyTasks, () => localTasks.read(), tasks, res.tasks),
    unmarkSettled(dirtyInbox, () => localInbox.read(), inbox, res.inbox),
  ]);
  return {
    pushed: res.tasks.pushed.length + res.inbox.pushed.length,
    conflicted: res.tasks.conflicted.length + res.inbox.conflicted.length,
    revived: revivedCount(tasks, res.tasks) + revivedCount(inbox, res.inbox),
  };
}
