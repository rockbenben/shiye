import type { Status, Task } from '../types.js';
import { isSettled } from './taskView.js';
// 从 server 那一侧引「下一次落在哪」，不在 web 抄一份——跟 `lib/taskMenu.ts`
// 引 `skipPatch` 同一条理由（两份实现会在 from:'done'、拖过好几个周期这几条
// 上悄悄漂开）。
import { nextAfterDone } from '../../../server/src/repeat.js';
// 「连带完成的有几条」跟服务端真正级联的范围必须是同一份判据，见下面那处注释。
import { descendantIds } from '../../../server/src/mutate.js';

/**
 * 改完状态之后那一次「撤销」（仿滴答清单：点完成，屏幕下方弹一条带撤销的提示）。
 *
 * 补的是这个应用里最高频那一下之后的一个坑：**点完成，那张卡当场从眼前消失**
 * ——每个视图都会（看板/清单/四象限按状态或筛选摆卡，日历只画没了结的），
 * 点错了想改回来，得先想起来去「已完成」里翻。`isDoneToday` 那一节只补了
 * 「今天」一个视图（它自己的注释就是这么说的），别的地方一直是空的。
 *
 * ## 为什么搁置和放弃也有一份撤销
 *
 * 原来这里只认「完成」一个，理由写在注释里：「搁置/放弃走的是卡片菜单，是想过
 * 才点的；勾选框是一个手滑就中的目标」。**这个理由对完成成立，对搁置/放弃不
 * 成立**——它假设了人会点自己看懂了的那一格。
 *
 * 而这两格恰恰是全站最难看懂的两个词：「搁置」和「放弃」只差一个字，含义是
 * 「以后还会回来」和「决定不做了」（区别写在 `lib/taskView.ts` 的 `STATUSES`
 * 上方，而那段注释只在源码里）。**猜错的那一下原本没有任何退路**——而「完成」
 * 有六秒撤销。风险大的那一边反而没有兵器。
 *
 * 结论是：**菜单也会点错，跟手滑是同一件事。** 搁置/放弃同样给一次撤销。
 *
 * ## 为什么这两档的 `partial` 恒为 false
 *
 * 服务端那边 `mutate.ts` 只有三处会连带改别的东西——生成重复的下一条
 * （`maybeSpawnNextInstance`）、连带完成子任务、父任务上卷——**三处都只认
 * `status === 'done'`**（`:211` 那个判据）。搁置和放弃除了状态本身不碰任何别
 * 的东西（它们只是不再发提醒、退出那些视图，而那是状态的**后果**，改回去就跟着
 * 回去）。所以撤销这一下是完整的，不带任何「只改回一部分」。
 *
 * 那为什么还需要 `to`：提示语要说「已搁置」还是「已放弃」，不能写死「已完成」。
 */
export interface UndoPlan {
  /** 改完之后落成的那一档。**提示语拿它拼动词**（`STATUS_LABEL`），不另抄一份
   *  「已完成 / 已搁置 / 已放弃」的话——抄一份的话，加第六个状态那天它就开始说错。 */
  to: Status;
  /** 撤销要发的 patch——**改回它原来那个状态**，不是一律 `todo`：从「进行中」
   *  勾完的，撤销该回到「进行中」。 */
  patch: { status: Status };
  /**
   * 这一下**不只改了它自己**：服务端会连带生成重复的下一条（`maybeSpawnNextInstance`）、
   * 连带完成还没了结的子任务（`cascadeChildrenDone`）、或者把最后一个孩子做完的
   * 父任务一并标完成（`rollUpParentDone`）。撤销只发一条 patch，收不回那些。
   *
   * 为真时提示语要把「撤销只把这一条改回来」说出来——一个写着「撤销」的按钮，
   * 人默认它把刚才那一下整个抹掉。**批量那条提示只用得上这个布尔量**：二十条
   * 各有各的连带，一条提示里摊不开。
   */
  partial: boolean;
  /**
   * 连带的那几件事，**各说各的一句人话**。单条那条提示用它。
   *
   * 原来这里只有上面那个布尔量，提示语说的是「还连带改了别的」——一句**只交代
   * 了『有事发生』、不交代『发生了什么』**的话，人读完还得自己去猜是哪一条被
   * 动了。现在改了什么就说什么：「连带做完了 3 条子任务」「「装修」也跟着完成了」。
   *
   * **重复那一条不在这儿**（它由 `nextDue` 拼成「下次 9月1日」，日期格式是
   * 界面的事）——除非那条重复任务压根没有截止时间：那时候报不出日期，但
   * 「下一条排上了」这件事仍然要说，于是这里补一句。
   *
   * **子任务和父任务这两件互斥**：层级只做一层（`hierarchy.ts`），一条有孩子
   * 的任务不可能同时是别人的孩子。所以这个数组最多两条（重复那句 + 其中一条）。
   */
  cascades: string[];
  /**
   * 提示里显示的标题，**掐到 16 字**。连着勾三条就是三条各带一个「撤销」的
   * 提示，光写「已完成」分不出哪条是哪条；而一条长标题会把这条提示撑成
   * 三行、把那颗按钮挤到屏幕外面去。
   */
  title: string;
  /**
   * 这条是重复任务时，**下一次落在哪**（ISO）。不重复、次数用完、或者它本来
   * 就没有 `due`（下一条也不会有日期）时是 `null`。
   *
   * 为什么值得单说一句：点完成那张卡当场从眼前消失，而一条「每周一交周报」
   * 最需要当场确认的恰恰是「下一条生成了没有、生在哪天」——`partial` 那句
   * 「还连带改了别的」说的正是这件事，但它没说是哪一天。
   *
   * **它说的是规则算出来的下一次，不是「我刚刚造了一条」**：服务端还会查一次
   * 「是不是已经有一条同样的了」（`hasTwinInstance`），那种情形下新的一条不会
   * 生成——但「下一次是 9月1日」这句话照样成立（那条卡已经在了）。
   */
  nextDue: string | null;
}

/** 掐到 16 字，掐了才加省略号。按字符数不按显示宽度：这里只是不让它撑破一条
 *  提示，不像 `ProposalNote` 的 `width` 那样要决定排版形态。 */
const short = (s: string): string => (s.length > 16 ? `${s.slice(0, 16)}…` : s);

/**
 * 这一次 patch 算不算「刚改过一档状态」，算的话撤销要发什么。不算就返回 `null`。
 *
 * 纯函数，`rows` 是发这一下之前的全部任务（连带判断要看兄弟和孩子）。`t` 收
 * `undefined`：调用方是 `tasks.find(...)`，表里没有（刚被别处删掉、id 打错）
 * 时不该为了「有没有撤销」这种事把一次写挡下来。
 */
export function undoPlan(t: Task | undefined, patch: Partial<Task>, rows: Task[], now: Date): UndoPlan | null {
  if (!t) return null;
  const to = patch.status;
  // 只认「跃迁」：done → done（改个备注顺手带上状态）什么连带都不会触发，也
  // 没什么可撤销的——跟服务端三个连带函数的第一行判据一致：看的是**跃迁**，
  // 不是终态。
  if (to === undefined || t.status === to) return null;
  // 搁置 / 放弃：干净的一下，撤销就是改回去。理由见上面「partial 恒为 false」。
  if (to === 'later' || to === 'abandoned') {
    return { to, patch: { status: t.status }, partial: false, title: short(t.title), nextDue: null, cascades: [] };
  }
  if (to !== 'done') return null;
  const next = nextAfterDone(t, now);
  const cascades: string[] = [];
  // 重复：有日期时那句「下次 X」由调用方拿 `nextDue` 拼（要本地日期格式，
  // 用的是行上那颗到期 chip 同一套说法），这儿不再重复说一遍；**没日期时
  // 那句就没人说了**，补一句——「下一条排上了」跟「下一条是几号」是两件事。
  if (next.spawns && next.due === null) cascades.push('重复的下一条已经排上了');
  // 连带完成还没了结的子任务（`cascadeChildrenDone`）。
  //
  // **数的是整棵子树，不是只有直接子任务。** 服务端那边走的是 `descendantIds`
  // （它自己的注释：「放开到五层之后，只关一层会把孙辈落在一个已完成的父亲
  // 下面」），预览这边原来只数 `parentId === t.id` 那一层——一个三层的项目上
  // 提示说「连带做完了 2 条」，实际做完的是 5 条。**预览少报比不预览更糟**：
  // 他据这句话决定要不要撤销。
  const under = descendantIds(rows, t.id);
  const kids = rows.filter((r) => under.has(r.id) && !isSettled(r)).length;
  if (kids > 0) cascades.push(`连带做完了 ${kids} 条子任务`);
  // 最后一个孩子做完 → 父任务跟着完成（`rollUpParentDone`）。
  const parent = rollUpParent(t, rows);
  if (parent) cascades.push(`「${short(parent.title)}」也跟着完成了`);
  return {
    to,
    patch: { status: t.status },
    // **不再是「有 repeat 就算连带」那种多报**：次数用完（`count` 为 0）的那一次
    // 是最后一次，服务端不会再生成任何东西，撤销确实能把这一下整个抹掉。判据
    // 交给 `nextAfterDone`，它跟真正生成下一条走的是同一个 `advance`。
    //
    // 恒等式：`partial` 为真时上面那几句里**一定至少有一句能说**（`nextDue`
    // 非空，或者 `cascades` 非空）——所以提示语里不再需要「还连带改了别的」
    // 这种什么都没说的兜底。
    partial: cascades.length > 0 || next.due !== null,
    title: short(t.title),
    nextDue: next.due,
    cascades,
  };
}

/**
 * 这一下会不会把父任务一并带完成——会的话返回那条父任务，不会返回 `null`。
 * 判据照着 `server/src/mutate.ts` 的 `rollUpParentDone` 抄。
 *
 * 放弃的兄弟不算数（跟服务端一致），但 `t` 自己就算现在是「放弃」也要算进来：
 * 它马上就是 done 了。
 *
 * 服务端在重复那一支还会查一次「是不是已经有一条同样的了」（`hasTwinInstance`，
 * 完成→取消→再完成的情形），那份判据留在服务端不复制过来——多报一次「下一条
 * 排上了」，比复制一份会跟着飘的判据强，何况那种情形下「下一次是 9月1日」
 * 照样成立（那张卡已经在了）。
 */
function rollUpParent(t: Task, rows: Task[]): Task | null {
  if (t.parentId === null || t.parentId === undefined) return null;
  const parent = rows.find((r) => r.id === t.parentId);
  if (!parent || isSettled(parent)) return null;
  const sibs = rows.filter((r) => r.parentId === parent.id && (r.id === t.id || r.status !== 'abandoned'));
  return sibs.length > 0 && sibs.every((r) => r.id === t.id || r.status === 'done') ? parent : null;
}
