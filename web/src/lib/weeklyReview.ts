import type { InboxItem, SmartFilter, Task } from '../types.js';
import {
  countStale, isSettled, parkedQuietLabel, waitingQuietLabel, recentlyReviewed,
  PARKED_QUIET_DAYS, WAITING_QUIET_DAYS,
} from './taskView.js';
import { stalledProjects } from './hierarchy.js';
// 只借那个门槛常量，不借它的候选池——理由写在 `postponedToReview` 上面那段。
import { POSTPONE_MIN } from './suggest.js';

/**
 * 「这一周该过一遍的」——GTD 每周回顾的那份清单，一次看完。
 *
 * ## 为什么要有这份清单
 *
 * 这几件事**判据都已经有了、也都在界面上标出来了**：过期的红着、等别人的写着
 * 「12 天没动静」、搁很久的写着「搁了 97 天」、卡住的项目在下面那一段列着。
 * 但它们各自散在不同的去处，而 GTD 的每周回顾是**一次性过一遍**的仪式——
 * 「这一周有什么需要我做个决定的」，答案不该要人自己去五个地方数。
 *
 * ## 判据一条都不新写
 *
 * 每一行都调既有的那个判据函数（`countStale` / `waitingQuietLabel` /
 * `parkedQuietLabel` / `stalledProjects`），不在这儿重新定义一遍「多久算久」。
 * 这一条是硬的：清单上写「3 条等太久了」而卡片上一个记号都没有（或者反过来），
 * 比不显示这份清单更糟——人会开始不信这些数字。
 *
 * ## 空行不出现，全清就说一句
 *
 * 数为 0 的那一行整条不渲染：一份「0 条这个、0 条那个」的清单是噪音，而且会
 * 让真的有东西的那两行淹没在里面。全都为 0 时调用方显示一句「都过完了」，
 * 判据就是这个函数返回空数组。
 */
export interface ReviewRow {
  /** 稳定的 key，也是调用方决定「点了跳去哪」的依据。 */
  key: 'inbox' | 'overdue' | 'stalled' | 'waiting' | 'parked' | 'postponed';
  /** 这一行说的那句话，数字已经拼进去了。 */
  text: string;
  count: number;
  /** 点了切到哪个去处（`viewFromHash` 那套 key）。null = 不跳，看下面那一段就行。 */
  go: string | null;
  /**
   * 跳过去之前先把筛选栏设成这个（叠在那个去处之上）。不给就不动筛选。
   *
   * **补的是「只给了个数字」那个弱点**：「1 条在等别人」点过去落在「全部」的
   * 十九条里，人还得自己找那一条——那不叫回顾，那叫又交给他一次。
   *
   * 筛选比这一行的口径**宽**（`SmartFilter` 没有「几天没动静」这一维）：这一行
   * 数的是超过门槛的那些，筛选给出的是整份等待/搁置清单。这是有意的——GTD 的
   * 每周回顾本来就要把整份清单过一遍，而卡片上那个「12 天没动静」的记号会告诉
   * 他哪几条是触发这一行的。所以文案里**把门槛写出来**（「超过 3 天没动静」），
   * 数字和清单对不上时人看得懂为什么。
   */
  filter?: Partial<SmartFilter>;
}

/**
 * **这一屏该拿出来问的卡住项目**——结构上卡住的，减去他最近已经看过的。
 *
 * 两步刻意分开，也刻意合在这一个函数里：
 *
 * - `stalledProjects` 是**结构事实**，它自己写着「纯函数，不读时钟：卡不卡住
 *   跟今天几号无关」。那句话该继续成立——「卡住了」和「他看过了」是两件事，
 *   前者不该因为后者而变成假的。
 * - 而这一屏问的是另一个问题：**这一周有什么需要我做个决定的**。他上周已经
 *   看过、并且决定维持原样的那一条，这一周不该再问一遍。
 *
 * **合成一个函数是因为有两个消费方**：下面那一行数字，和 `ReviewView` 里那份
 * 列表。两边各自 filter 一遍就是两份能各自改漏的口径，而「清单上写 3 条、
 * 底下只列出 1 条」比不显示这份清单更糟——人会开始不信这些数字。
 */
export function stalledToReview(tasks: Task[], now: Date): Task[] {
  return stalledProjects(tasks).filter((t) => !recentlyReviewed(t, now));
}

/**
 * **这一屏该拿出来问的「一拖再拖」**——改过 `POSTPONE_MIN` 次以上期的，减去他
 * 最近已经看过的。次数多的排前面：这一组的信息量全在那个数字上。
 *
 * ## 它跟「推荐任务」面板里那一组是什么关系
 *
 * 那一组（`lib/suggest.ts` 的 `postponed`）**已经把这几条摆出来了**，所以这一
 * 节存在的理由不是「没有地方看」——是**没有地方做那个决定**。那个面板长在
 * 「今天」里，它给的唯一动作是「加到今天」：**而那正是他做过八次的那个动作**。
 * 一条被推了八次的任务，缺的从来不是「再推回今天」，是「还要不要它」。
 * 那个面板自己也知道这一点，它的注释里写着「想做的**未必**是「加到今天」——
 * 也可能是打开它改小、或者干脆放弃」，只是它的形状装不下另一个动作。
 *
 * 这一屏装得下：它问的就是「这一周有什么需要我做个决定的」，而这一类的决定
 * 是**搁置**（暂时不做）或者**放弃**（决定不做），两个都在卡片 ⋯ 里。
 * 这一节只负责把判断摆出来，一颗「看过了」就够——**不去替他做那个决定**，
 * 跟「卡住的项目」一字不差的立场。
 *
 * ## 门槛共用，候选池不共用
 *
 * 门槛（`POSTPONE_MIN`）**跟推荐面板那组是同一个常量**，不在这儿另写一个 2
 * ——那个常量的注释专门讲过「两处各写一个，将来调门槛只会改到一处」。
 *
 * 但候选池**不一样，是有意的**：那边是 `isCandidate`（今天列表之外、还能动
 * 的），这边是「只要还挂着就算」。因为一条天天被他推迟的任务**很可能就赖在
 * 「今天」里**——那正是它一直被推迟的表现，而它恰恰是这一节最该问的那一条。
 * 照搬那个池子会把最典型的那种漏掉。
 */
export function postponedToReview(tasks: Task[], now: Date): Task[] {
  return tasks
    .filter((t) => !isSettled(t))
    // `typeof` 那一道：`data/tasks/` 是手改得到的文件，缺字段的老数据里
    // `postponeCount` 是 undefined，而 `undefined >= 2` 恰好是 false——不写
    // 也能跑。写出来是因为这里要的是「数过、而且够多」，不是「不比 2 小」。
    .filter((t) => typeof t.postponeCount === 'number' && t.postponeCount >= POSTPONE_MIN)
    .filter((t) => !recentlyReviewed(t, now))
    .sort((a, b) => b.postponeCount - a.postponeCount);
}

export function weeklyReview(tasks: Task[], inbox: InboxItem[], now: Date): ReviewRow[] {
  const rows: ReviewRow[] = [];

  // ① 清空收件箱——GTD 每周回顾的第一步，也是这个应用最本命的一步。
  const unprocessed = inbox.filter((x) => !x.processed).length;
  if (unprocessed > 0) {
    rows.push({ key: 'inbox', count: unprocessed, go: 'inbox', text: `收件箱还有 ${unprocessed} 条没处理` });
  }

  // ② 过期的。判据复用 `countStale`（就是卡片上那个红标签的条件），不另定义。
  const overdue = countStale(tasks, now);
  if (overdue > 0) {
    rows.push({ key: 'overdue', count: overdue, go: 'today', text: `${overdue} 条已经过期` });
  }

  // ③ 卡住的项目——底下一个能动的下一步都没有。不跳去处：下面那一段就列着它们。
  const stalled = stalledToReview(tasks, now).length;
  if (stalled > 0) {
    rows.push({ key: 'stalled', count: stalled, go: null, text: `${stalled} 个项目卡住了，一个能动的下一步都没有` });
  }

  // ④ 一拖再拖——改过好几次期还在原地的。**不跳去处**，跟上面那条同一个理由：
  //    下面那一段就列着它们，而且这一节要的那个决定（搁置 / 放弃）在卡片里，
  //    跳去一个筛选过的列表反而离答案更远。门槛从常量拿，不在这儿另写一个 2。
  const postponed = postponedToReview(tasks, now).length;
  if (postponed > 0) {
    rows.push({
      key: 'postponed',
      count: postponed,
      go: null,
      text: `${postponed} 条改过 ${POSTPONE_MIN} 次以上期，一直没动`,
    });
  }

  // ⑤ 在等别人、久没动静的——该催了吗。
  const waiting = tasks.filter((t) => waitingQuietLabel(t, now) !== null).length;
  if (waiting > 0) {
    rows.push({
      key: 'waiting',
      count: waiting,
      go: 'all',
      // 门槛从常量拿，不在文案里另写一个 3——改常量时这句话得跟着变。
      text: `${waiting} 条在等别人、超过 ${WAITING_QUIET_DAYS} 天没动静`,
      filter: { hasWaitingFor: true },
    });
  }

  // ⑥ 搁很久的（将来也许）——还要吗。
  const parked = tasks.filter((t) => parkedQuietLabel(t, now) !== null).length;
  if (parked > 0) {
    rows.push({
      key: 'parked',
      count: parked,
      go: 'all',
      text: `${parked} 条搁了超过 ${PARKED_QUIET_DAYS} 天`,
      filter: { status: ['later'] },
    });
  }

  return rows;
}
