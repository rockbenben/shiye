/**
 * **每天重复的任务，过了 0 点自动顺延到第二天——这一份是「落盘」。**
 *
 * ## 这条路要解决什么
 *
 * 重复任务在这个应用里**只由人的动作推进**：完成（`nextInstance`）或者手动
 * 「跳过本次」（`skipPatch`）。所以一条每天重复的任务昨天没做完，今天会一直
 * 红着「过期 N 天」躺在「今天」里，提醒昨天响过一次今天也不会再响，
 * 而且**永远不会有「今天那一次」**。
 *
 * 「每天重复」的任务有一种别的档没有的性质：**这一天没做完，不要紧**。
 * 过了 0 点它自己变成第二天的同一条——日期换成新的一天，时刻不变。
 *
 * ## 三份文件各管一段
 *
 * - `model.ts` 的 `canRollOverDaily`：**谁**该顺延（每天 + 每一天 + 按截止日算）。
 * - `repeat.ts` 的 `rolloverPatch`：**挪成什么样**（纯函数，不碰盘）。
 * - 这个文件：**落盘**（读 → 改 → 只写动过的那几条）。
 *
 * 判据和算法分开，是因为它们该被分别测：判据是九档重复里挑哪一档，
 * 算法是「挪到哪天、提醒怎么挪」。合成一个函数就只能整体测，
 * 而整体测会把「挑错档」和「算错日子」两种错混成一条。
 *
 * ## 为什么写盘，而不是只在界面上投影
 *
 * 提醒要走三路（网页横幅 / Windows 通知 / webhook），那是服务端的事；
 * 而且「今天视图 / 议程 / 日历 / `.ics` 导出 / 建议 / 习惯连续天数 /
 * 逾期横幅」每一处都判 `due`，只在显示层投影就得把这一处处改成问投影——
 * 那个仓库为「同一条判据抄了四份、其中一份悄悄分叉」栽过好几次
 * （`dueOverdue` 那四份、`dueBucketOf` 刚统一过一次）。数据本身是今天的，
 * 这些地方就都不用改。
 *
 * ## 为什么只写动过的那几条
 *
 * `writeTasks(整份数组)` 底下是 `syncAll`，它会**删掉不在新数组里的文件**。
 * 读盘和写盘之间用户正在网页上新建一条任务，那条就会被删掉——
 * AGENTS.md 开头那段说的正是这件事。所以走 `writeTask`（单文件原子写）。
 */
import type { Task } from './model.js';
import { applyTaskPatch } from './mutate.js';
import { rolloverPatch } from './repeat.js';
import { readTasks, writeTask } from './store.js';

/**
 * 挪完之后的**那一条**。不该挪就返回 `null`（不动它）。
 *
 * 补丁的套用走 `applyTaskPatch`——跟网页上改一条任务、接受一条 AI 建议
 * 是同一份「怎么把一个 patch 落到任务上」：提醒时刻变了章要清、重复档变了
 * 习惯记号要跟着摘、`updatedAt` 要更新。这些都在那儿，不在这儿重写一遍。
 */
export function rolledTask(t: Task, at: Date): Task | null {
  const patch = rolloverPatch(t, at);
  if (!patch) return null;
  const next = applyTaskPatch(t, patch, at.toISOString());
  // **两个字段原样留着：这一下不是他动过这条任务。**
  //
  // - **`postponeCount`**：顺延不是拖延。拖延是「同一次要做的事往后挪」，
  //   顺延是「这一次没做，换一次」——塞进去的话这条任务就开始出现在
  //   「一拖再拖」的推荐里，AI 回顾也会把它当成长期拖延的典型，而那是句假话。
  //
  // - **`updatedAt`**：它量的是「这条任务多久没被动过了」——卡片上那个
  //   「N 天没动静」的记号算的就是它（`web/src/lib/taskView.ts` 的 `daysQuiet`）。
  //   **每天自动挪一次日期，等于每天替他把这条任务「动」了一次**，而他并没有
  //   为「在等谁」做任何事——那个记号就永远不会亮，一条每天都在等张老师的
  //   任务就永远不会被提醒。仓库自己写过同一条教训：在回顾里点一下「看过了」
  //   会顺带更新 `updatedAt`，拿 `updatedAt` 当复查依据的话，那一下就把
  //   「等了 12 天」清零了「而他并没有去催谁」（`taskView.ts` 里
  //   `REVIEWED_QUIET_DAYS` 那段）。
  //
  //   还有一条更硬的理由：`.ics` 的 `DTSTAMP` 是「全部 `updatedAt` 的最大值」
  //   （`server/src/ics.ts` 的 `latestUpdate`），**刻意不读时钟**——两台机器
  //   拿到同一份任务必须算出字节一致的那份 `.ics`，否则同步客户端会把它们
  //   当成冲突、「冲突副本 .ics」越堆越多。盖上「现在」的话，两台机器各自在
  //   各自的时刻顺延同一批任务，盖出来的值就不同，同一份任务写出两份不同的
  //   `.ics`。**不盖它，顺延就是一台机器算出来的确定结果**：不管谁在什么时候
  //   跑，落到的都是「今天同一个时刻」。
  //
  //   代价说清楚：`.ics` 里那条事件的 `DTSTAMP` 因此不动，而内容变了
  //   （每天那条的 `DTSTART` 挪到了今天）。订阅端大多按内容重导，不受影响；
  //   而「重复到期、规则被摘掉」那一种，手机上可能还留着那条循环事件。
  return { ...next, updatedAt: t.updatedAt, postponeCount: t.postponeCount };
}

/**
 * 把所有该顺延的每天重复任务挪到今天。**返回真的挪了的那些。**
 *
 * **可以随时调，重复调没有副作用**：挪过的任务截止日期落在今天，
 * 第二遍再扫它就不在「该挪」的范围里了（判据在 `rolloverPatch`）。
 * 所以它既能挂在定时器上（每轮扫一遍），也能在服务启动时补一次
 * （服务停了几天那几天没做过的，第一次扫到就一次推到今天）。
 */
export function rollOverDailyTasks(at = new Date()): Task[] {
  const rolled: Task[] = [];
  for (const t of readTasks()) {
    const next = rolledTask(t, at);
    if (!next) continue;
    writeTask(next);
    rolled.push(next);
  }
  return rolled;
}
