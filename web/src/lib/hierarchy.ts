import type { Subtask, Task } from '../types.js';
import { isSettled, notStarted } from './taskView.js';
// 上限、环检测、深度判据只有一份，在服务端那个文件里——web 直接引它
// （`dataSource.ts` 早就这么引 `mutate.js` 了），不在这边抄第二份。
import { MAX_TASK_DEPTH, checkParentLink, depthOf, descendantIds } from '../../../server/src/mutate.js';

/**
 * 多级任务（仿滴答清单）——**最多五层**，跟它那边一样
 * （《多级任务》：「现阶段，我们只允许5级任务嵌套」）。
 * 上限、环检测和深度判据都在服务端 `mutate.ts` 的 `checkParentLink`
 * （web 直接引它，不在这边抄第二份），这里是界面这一侧怎么摆、怎么显示。
 *
 * 这个应用原来**只做一层**，理由是「十二个视图各自要处理无限层级的缩进和
 * 排序」。放开之后那个成本是真付掉了：下面 `nestChildren` 按深度展开、
 * `parentCandidates` 直接问服务端那条判据、`stalledProjects` 要看整棵子树。
 *
 * **只用在平铺列表那几个去处**（全部 / 已完成 / 清单 / 标签 / 搜索）。
 * 「今天」的顺序是他自己拖出来的、「接下来」按时间分组、看板/四象限/日历
 * 按格子落位——那几个地方「把孩子挪到父亲后面」会打乱本来有意义的位置。
 */

/** `parentId` 指向的那条。找不到（删了、还没拉到）返回 undefined。 */
export const parentOf = (t: Task, all: Task[]): Task | undefined =>
  (t.parentId ? all.find((x) => x.id === t.parentId) : undefined);

/** **直接**子任务，只有一层。要整棵子树用 `mutate.ts` 的 `descendantIds`。 */
export const childrenOf = (id: string, all: Task[]): Task[] => all.filter((t) => t.parentId === id);

/**
 * **挡着这条任务的那个祖先**——它自己还没到开始时间，所以底下这条现在也做不了。
 * 没有就是 `undefined`。有好几层都还没开始时返回**最近的那个**：屏幕上要写出
 * 它的名字，而「装修」比「今年的事」更能解释眼前这条为什么不在。
 *
 * ## 为什么要有它
 *
 * `startAt` 这个字段的出处是 OmniFocus 的 Defer Date（判据和理由整段写在
 * `types.ts` 那个字段上），而**「容器的 defer 罩住里面所有东西」是那个概念
 * 定义的一部分**，不是附加功能：
 *
 * > Assigning a Defer Date to an action group or project tells OmniFocus that
 * > **neither the item nor any contained items** are Available for work until
 * > the Defer Date has passed.
 * >
 * > —— 《The Outline》「Inherited Defer Date」
 *
 * 在这之前 `parentId` 在这个仓库里**从不参与任何日期或可用性判断**（只管显示
 * 嵌套、父任务选择器、提升、复制）。后果是给「装修」设了 9 月 1 日开始之后，
 * 父任务正确地从四象限和「现在做什么」里隐去了，**它的三条子任务照常出现、
 * 照常被推荐**——Defer 存在的全部意义就是挡住这个。
 *
 * 而且这跟这个仓库自己的模型不一致：**状态是双向连带的**（勾父，子跟着完成；
 * 最后一个子完成，父跟着收），日期却一个方向都不传。
 *
 * ## 只传递，不钳制
 *
 * OmniFocus 还有一条：子项的 defer「cannot be earlier than」父的、子项的 due
 * 「cannot be later than」父的，填了会被拉回去。**这一条这里有意不做**，它跟
 * 本仓库一条既有约定正面冲突——`server/src/task.ts` 有意收下「开始晚于截止」
 * 「结束早于开始」这类自相矛盾的输入，理由写在那儿：「那是一句自相矛盾的话，
 * 但它是用户的话，当场拒掉会让那一次编辑整个失败」。所以这里只改**怎么看**
 * （父没开始，子也算做不了），不改写也不拒绝他填的日期。
 *
 * `all` **必须是完整的那一份任务**，不是筛过的：祖先要在里面找得到。筛过的
 * 数组会让一条被筛掉的父任务凭空「不再挡着」谁。
 */
export function blockingAncestor(t: Task, now: Date, all: Task[]): Task | undefined {
  // 上限用层数：服务端 `checkParentLink` 保证不成环，这个界只是不留一个没有
  // 上界的 while——跟 `repeat.ts` 那条「不留没有上界的循环」同一条。
  let cur = parentOf(t, all);
  for (let depth = 0; cur && depth < MAX_TASK_DEPTH; depth++) {
    if (notStarted(cur, now)) return cur;
    cur = parentOf(cur, all);
  }
  return undefined;
}

/**
 * **这条任务现在做不了**：自己还没到开始时间，或者某个祖先还没到。
 *
 * 跟 `notStarted`（`taskView.ts`）不是一件事，也不是它的第二份实现：那个答的是
 * 「**它自己**填的开始时间到了没」，卡片和行档上那枚「9月1日 起」的记号问的
 * 正是这个，不该因为父亲而变。这个答的是「现在能不能动它」——OmniFocus 管这
 * 叫 Availability。
 */
export const notStartedDeep = (t: Task, now: Date, all: Task[]): boolean =>
  notStarted(t, now) || blockingAncestor(t, now, all) !== undefined;

/**
 * **卡住的项目**——GTD 里最经典的那种失灵：一个还挂着的项目，底下**一个能动
 * 的下一步都没有**。
 *
 * 「项目」在这个应用里就是「有子任务的任务」（多级只做一层，见文件顶部）。
 * 判据三条，缺一不可：
 *   1. 它自己还没了结（`isSettled` 认 done/later/abandoned 三种）；
 *   2. 底下至少有一条子任务——没有子任务的就是一条普通任务，不是项目，
 *      「没有下一步」对它没有意义；
 *   3. **没有任何一条子任务是能动的**（能动 = 不 settled，也就是 todo/doing）。
 *      子任务全做完的那种走不到这里：`server/src/mutate.ts` 的 `rollUpParentDone`
 *      会在最后一条做完的那一刻把父任务也标完成。所以这里逮到的实际是
 *      「全搁置了」「全放弃了」「一半放弃一半搁置」这几种——它们都不会触发
 *      那个自动收尾，于是这个项目就一直挂在列表里，看起来还活着，其实没有
 *      任何一步动得了。
 *
 * 为什么值得单独算：这件事**看不出来**。父任务卡片上写着「子任务 0/2」，
 * 那个记号说的是「还没做完」，不是「没有下一步了」；而在列表里它跟别的
 * 待办长得一模一样。GTD 的每周回顾专门有一条就是查这个。
 *
 * 纯函数，不读时钟：卡不卡住跟今天几号无关。
 */
export function stalledProjects(all: Task[]): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  return all.filter((t) => {
    if (isSettled(t)) return false;
    // **看整棵子树，不是只看直接子任务**（放开到五层之后）。一个项目下面
    // 挂着一个搁置的阶段、而那个阶段里还有一条能动的任务——它没有卡住，
    // 只看一层会把它误报成卡住，而这份清单一旦开始误报就不再被当真。
    const under = descendantIds(all, t.id);
    if (under.size === 0) return false;
    for (const id of under) {
      const kid = byId.get(id);
      if (kid && !isSettled(kid)) return false;
    }
    return true;
  });
}

export interface ChildProgress { done: number; total: number }

/**
 * 「子任务 1/3」。没有子任务返回 null——卡片上就不画这个记号。
 *
 * **放弃了的子任务整个不算数**，分子分母都不进：它既不是「做完了」，也不该
 * 永远挂在分母上。三个孩子里放弃一个，剩下两个做完一个，说的是「1/2」而不是
 * 「1/3」——后者会让这个记号永远到不了满，而那一格其实早就不需要了。
 * 搁置的照常算在分母里：搁置是「暂时不想做」，那件事还在。
 */
export function childProgress(id: string, all: Task[]): ChildProgress | null {
  const kids = childrenOf(id, all).filter((t) => t.status !== 'abandoned');
  if (kids.length === 0) return null;
  return { done: kids.filter((t) => t.status === 'done').length, total: kids.length };
}

/**
 * 把一份**已经排好序**的任务列表重排成「孩子紧跟在父亲后面」。
 *
 * 父亲保留它自己排出来的位置，孩子从原地摘走、按原有相对顺序插到父亲后面。
 * 父亲不在这份列表里（被筛掉了、在另一个分组里）的孩子**留在原地**，不往上
 * 提也不删掉——那条任务确实该出现在这一屏（它自己满足这个视图的条件），
 * 只是没有可挂靠的父亲，卡片上那句「属于……」仍然说得出它属于谁。
 *
 * 幂等：对已经排好的列表再跑一次结果不变。
 */
export function nestChildren(tasks: Task[]): Task[] {
  const present = new Set(tasks.map((t) => t.id));
  const kidsOf = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parentId || !present.has(t.parentId)) continue;
    const bucket = kidsOf.get(t.parentId);
    if (bucket) bucket.push(t);
    else kidsOf.set(t.parentId, [t]);
  }
  if (kidsOf.size === 0) return tasks;

  const claimed = new Set<string>();
  for (const kids of kidsOf.values()) for (const k of kids) claimed.add(k.id);

  /**
   * **深度优先往下铺**（放开到五层之后）。原来这儿是一层：把孩子接在父亲
   * 后面就完了，孙辈会留在原位——一棵三层的树在列表里会散成「父 + 子」和
   * 一个不知道从哪冒出来的孙子。
   *
   * `seen` 防环：`checkParentLink` 拦得住新造的环，但盘上的文件是人能手改的，
   * 而一个环会让这个递归永远转不出来——整个界面当场挂死。跟
   * `descendantIds` 那道守卫是同一件事、同一个理由。
   */
  const out: Task[] = [];
  const push = (t: Task, seen: Set<string>) => {
    if (seen.has(t.id)) return;
    out.push(t);
    const next = new Set(seen).add(t.id);
    for (const k of kidsOf.get(t.id) ?? []) push(k, next);
  };
  for (const t of tasks) {
    // 已经会被某个父亲带出来的，跳过原位。
    if (claimed.has(t.id)) continue;
    push(t, new Set());
  }
  /**
   * **兜底：一条都不许吞掉。**
   *
   * 上面那个循环只从「没有父亲的」开始铺。数据里有环时（x 的父亲是 y、
   * y 的父亲是 x，手改文件造得出来）**环里每一条都是别人的孩子**，于是一条
   * 都不会成为起点——整个环从列表上凭空消失，而文件里它们还在。实测出来的：
   * 这一族第一版只断言「不抛」，结果拿到的是一个空数组。
   *
   * 顺序上排在最后：它们本来就是坏数据，摆在末尾比插在中间容易被发现。
   */
  if (out.length !== tasks.length) {
    const shown = new Set(out.map((t) => t.id));
    for (const t of tasks) if (!shown.has(t.id)) out.push(t);
  }
  return out;
}

/**
 * 「这条任务能挂到谁下面」的候选表。三条排除跟服务端 `checkParentLink` 的
 * 判据一一对应——**界面先挡一道，不是替代那道**：服务端读得到全表、是唯一
 * 守得住的地方，这里只是别让人选出一个注定被 400 退回的选项。
 *
 * - 自己不在候选里
 * - 已经是别人子任务的不在候选里（挂上去就是第二层）
 * - `self` 自己名下已经有子任务时，一个候选都没有（它挂到谁下面都是第二层）
 *
 * 已完成和已放弃的也排除：把一条活着的任务挂到一件做完的、或者已经决定不做
 * 的事下面，多半是选错了。**搁置的留着**——搁置是「暂时不想做」，那件事还在，
 * 往它下面挂一步是合理的。
 */
export function parentCandidates(all: Task[], selfId: string | null): Task[] {
  return all.filter((t) => {
    // 已完成和已放弃的排除：把一条活着的任务挂到一件做完的、或者已经决定不做
    // 的事下面，多半是选错了。**搁置的留着**——搁置是「暂时不想做」，那件事
    // 还在，往它下面挂一步是合理的。这一条是界面自己的判断，服务端不管。
    if (t.status === 'done' || t.status === 'abandoned') return false;
    // 剩下的全部交给服务端那条判据。**新建任务（`selfId` 为 null）没有 id、
    // 也没有子树**，它挂上去之后就是父亲那一层再加一层。
    return selfId === null
      ? depthOf(all, t.id) + 1 <= MAX_TASK_DEPTH
      : checkParentLink(all, selfId, t.id) === null;
  });
}

/**
 * 下拉框里真正要摆的那几项：`parentCandidates` **加上这条任务当下挂着的那个
 * 父亲**（如果它已经不在候选里的话）。
 *
 * 两件只有加上它才成立的事：
 *
 * ① **显示不撞谎。** 父任务做完之后就不再是候选（上面那条判据），而 `<select>`
 *    的 value 找不到对应 `<option>` 时，浏览器显示的是第一项——于是打开一条
 *    子任务，下拉框写着「不是谁的子任务」，卡片上却画着「↳ 属于「装修」」，
 *    同一屏两句话对不上。那个 `<select>` 上方的注释一直写着「当前值指向的那条
 *    不在候选里时也要能显示出来」，而代码里从来没有这一步。
 * ② **摘得下来。** 下拉框只在有候选时才渲染。一条子任务，如果别的任务恰好都
 *    做完了（候选为空），这个框整个不出现——那条任务就再也没办法从父亲下面
 *    摘下来了，跟「习惯标记卡在非每天重复上」是同一类回不去的状态。
 *
 * 排在**最后**：它不是一个「可以选」的新去处，是「你现在在这儿」。
 */
export function parentOptionsFor(all: Task[], self: Task): Task[] {
  const candidates = parentCandidates(all, self.id);
  if (!self.parentId || candidates.some((t) => t.id === self.parentId)) return candidates;
  const current = all.find((t) => t.id === self.parentId);
  // 父亲整条已经不在表里（被删了、或者还没拉到）：没什么可显示的，也就没得摘
  // ——那种情况服务端的 `detachDeletedTasks` 会把 parentId 清掉，不是这里的事。
  return current ? [...candidates, current] : candidates;
}

export interface Promoted {
  /** 新建那条子任务要发的字段。`parentId` 由调用方填成父任务的 id。 */
  child: { title: string; status: 'todo' | 'done'; listId: string | null; parentId: string };
  /** 父任务的 `subtasks` 剩下什么——这一项被摘走了。 */
  rest: Subtask[];
}

/**
 * 检查事项转为子任务（仿滴答清单的「转为子任务」）。转不了返回 `null`。
 *
 * 补的是一条走不通的路：一个检查事项写着写着发现它需要自己的截止时间、备注、
 * 优先级——而检查事项只有 `{ text, done }` 两个字段，除了删掉重写成一条任务、
 * 再手动挂回父亲下面，没有别的办法。
 *
 * **三条转不了的情形**：
 * ① 父任务已经在第五层——转出来的那条挂上去就是第六层（要给 `all` 才判得了）
 *    不变量在服务端守着，这里提前判掉，免得点了才收到一句 400。
 * ② 下标越界（列表在别处被改过）。
 * ③ 文字去掉首尾空白之后是空的——`POST /api/tasks` 要求标题非空。
 *
 * **勾掉的那一项照样能转**，转过去还是已完成：这是「把它挪个地方」，不是
 * 「重新做一遍」，改写状态等于伪造一条没发生过的事。落地时 `POST /api/tasks`
 * 会在 status 已经是 done 的那一刻盖上 `completedAt`。
 *
 * `listId` 跟着父亲走（同一件事的一步，不该掉进收件箱）；标签、优先级、
 * 截止时间都不继承——那几样是「这一条自己的判断」，继承等于替他做决定，
 * 而他转过来的目的通常正是要单独设它们。
 */
export function promoteSubtask(t: Task, index: number, all?: Task[]): Promoted | null {
  // 父任务已经在第五层：转出来的那条要挂在它下面，那就是第六层。判据走同一个
  // `depthOf`，不在这儿另定一个数。**要给 `all` 才判得了**（深度是全表算的）；
  // 不给就不拦，服务端仍然是最后那道，只是那时候按钮已经点下去了。
  if (all && depthOf(all, t.id) + 1 > MAX_TASK_DEPTH) return null;
  const subs = t.subtasks ?? [];
  const item = subs[index];
  if (!item) return null;
  const title = (item.text ?? '').trim();
  if (!title) return null;
  return {
    child: { title, status: item.done ? 'done' : 'todo', listId: t.listId, parentId: t.id },
    rest: subs.filter((_, i) => i !== index),
  };
}
