import type { LocalNotificationSchema } from '@capacitor/local-notifications';
import type { Task } from '../types.js';
import { isSettled } from './taskView.js';

/**
 * 手机本地通知的窗口纯逻辑：排哪些、排多少、文案怎么拼。零插件调用、零 DOM——
 * node 档全测。真的调插件在 notifyNative.ts。
 *
 * **刻意不共用 server/src/reminder.ts 的 isDue**：那份选「已到点该现在发」
 * （at <= now，firedAt 做已发过滤），这份选「还没到点将来要响」（at > now）——
 * 方向相反，共用就得造一个翻转自身含义的方向开关。物理上也进不来：reminder.ts
 * 顶部 import 了 node:child_process，进不了浏览器 bundle。文案形状抄它的
 * toast()（title=任务标题，body=截止…/notes/兜底），改那边记得看这边。
 *
 * firedAt 在这里不是「桌面响过我就不响」的抑制信号（防重复响的是「只排未来」
 * ——响过的那条时间已过去，下次重排自然落选）；它过滤的是「时间在未来却标成
 * 发过」这种按数据模型不该存在（applyTaskPatch 改时刻会清 firedAt）、只可能
 * 手改文件造出来的条目——跳过一条来历不明的数据比替它响一声安全。
 * 设计正本：2026-08-13-full-rebuild-design.md 第十一节。
 */
export interface PlannedNotification {
  /** 批内序号 1..N。整体重排（先全取消再重排）让 id 不需要跨批稳定，也就
   *  不需要 uuid→32 位 int 的映射和碰撞处理——取消凭 getPending() 现查。 */
  id: number;
  taskId: string;
  title: string;
  body: string;
  at: Date;
}

/**
 * 三半都摆出来。只返回排上的那半，另外两半就没人断言得了（153），界面上也就
 * 只剩「什么都没发生」。
 *
 * - `planned`：这次真要交给插件排的。
 * - `overflow`：**未来的、被 limit 窗口切掉的**。不是丢了——下次重排它进了
 *   窗口就会被排上（设计正本第十一节，冒烟清单第 9 步）。
 * - `missed`：**到点了，而谁都没发过**。注意不是「手机没排上」：`firedAt` 是
 *   **服务端**盖的章（server/src/reminder.ts 的 fireReminders），桌面服务只要
 *   在跑就会盖上。所以「时间已过、firedAt 仍为空」的含义是**那个时刻到来时
 *   桌面也没开着**。
 *   这个数不会一直涨：桌面下次启动后 `fireReminders` 会把这些补盖上 firedAt
 *   （`isDue` 的判据是 `at <= now && !firedAt`，**没有下界**），它们随即从这个
 *   数里掉出去，所以它天然是「最近这段没人管的」而不是历史累计。
 *   （这段原来挂着一句「⚠️ 是从 isDue 读出来推的，没核过」。核过了，结论不变：
 *   `fireReminders` 每一轮把 `dueTasks` 选出的**全部**盖上章，跟「响不响」是
 *   两个范围——超过补响窗口的那些只盖章不响（`CATCH_UP_MS`），盖章这一步照做，
 *   正是为了不让这个数一直挂着。）
 */
export interface NotifyPlan {
  planned: PlannedNotification[];
  overflow: number;
  missed: number;
}

/** due 显示成本地格式；解析不了原样吐回（server/src/reminder.ts formatDue 同形状）。 */
function formatDue(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString('zh-CN');
}

/**
 * 未完成（不是 done/later——搁置跟完成一样不提醒，服务端 dueTasks 同一条
 * 规矩）+ 没发过 + 解析得出来，按时间切成两堆：未来的按时间近的取前 limit 条
 * 排上，已经过去的数进 `missed`。
 *
 * 32 的理由：安卓待定闹钟有数量上限（各 OEM 不同，这里不依赖具体数字），
 * 32 离任何已知红线都差一个数量级；个人量级下「未来最近 32 条」覆盖几周
 * 开外，且每次数据变化/打开应用都重排回满。超出窗口的下次进窗口就排上，
 * 见 android/冒烟清单.md 第 9 步。
 *
 * **同一条任务的多个 reminders 各排一条**，不合并。数据模型允许「提前一天 +
 * 到点」这种排法，合并成一条等于把早的那个静默吞掉——那正是设置多个提醒的
 * 全部意义。（服务端 fireReminders 里「同一条任务多个提醒同时到期只通知一次」
 * 是另一回事：那些是**同一时刻**的，这里是不同时刻。同一时刻的两条在这里会
 * 排成两条通知，属于手改文件才造得出的数据，不额外去重。）
 *
 * 文案的取舍——**锁屏上只看得见一行，多写一个字都是抢那一行的空间**：
 * - title 放**任务标题**：不放它这条通知就没有意义。
 * - body 放**截止时间**（有 due 时）：通知是在提醒时刻弹的，「现在几点」用户
 *   自己知道，而截止时刻可能跟提醒时刻差着一天——这是**唯一一条用户此刻不
 *   知道、又直接决定他现在做不做**的信息。
 * - 没 due 就退到 notes，再没有就「该做这件事了」。
 * - **清单名、标签、优先级一概不放**：清单和标签是他自己归的类，看标题就知道
 *   在哪一格；优先级早已体现在「他给这条设了提醒」这件事本身上。三样都是
 *   「看了也不改变下一步动作」的信息，占掉的却是那一行里最贵的位置。
 * - 形状跟服务端 toast() 一模一样是**故意的**：同一条提醒在桌面和手机上说的
 *   是同一句话，不会让人以为是两件事。
 */
export function planNotifications(tasks: Task[], now: Date, limit = 32): NotifyPlan {
  const live = tasks
    // **`isSettled`，不是手写 `!== 'done' && !== 'later'`。** 这里原来漏了
    // 「已放弃」：那个状态是后加的，而这一行没跟上——一条明确决定不做的任务，
    // 手机上照样会在提醒时刻弹出来。服务端那条同源判断（reminder.ts 的
    // `isDue`）用的一直是 `isSettled`，两边一个漏一个不漏，是这个仓库反复
    // 栽过的那种「同一个概念两份实现，其中一份悄悄飘了」。
    .filter((t) => !isSettled(t))
    .flatMap((t) => t.reminders
      .filter((r) => r.firedAt === null)
      .map((r) => ({ t, at: Date.parse(r.at) }))
      // 解析不了的显式跳过（多半是手改文件时写了「下周三」）。**不能靠
      // 「NaN > now 恒为 false」兜底**：那只兜得住排程那半，NaN 会顺着
      // 掉进 missed 里冒充「错过一条」，界面上就多出一条不存在的错过。
      .filter((x) => !Number.isNaN(x.at)));
  const future = live.filter((x) => x.at > now.getTime()).sort((a, b) => a.at - b.at);
  const planned = future.slice(0, limit).map((x, i) => ({
    id: i + 1,
    taskId: x.t.id,
    title: x.t.title,
    body: x.t.due ? `截止 ${formatDue(x.t.due)}` : x.t.notes || '该做这件事了',
    at: new Date(x.at),
  }));
  // 恰好等于 now 的算进 missed 那半：它不在未来所以排不了，而服务端的
  // isDue（at <= now）认为它此刻就该发——归到「到点了没人管」是一致的。
  return { planned, overflow: future.length - planned.length, missed: live.length - future.length };
}

/** 翻成插件的参数形状。allowWhileIdle：Doze 里也要按点响——提醒晚几分钟是真损伤。 */
export function toNotificationSchema(p: PlannedNotification): LocalNotificationSchema {
  return {
    id: p.id,
    title: p.title,
    body: p.body,
    schedule: { at: p.at, allowWhileIdle: true },
  };
}
