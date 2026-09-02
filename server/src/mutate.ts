import type { InboxItem, Proposal, Task, TrashItem, Subtask } from './store.js';
import { nextInstance } from './repeat.js';
import { isSettled } from './task.js';
import { canBeHabit } from './model.js';

/**
 * 服务端三件写入语义，提成平台无关的纯函数——进出都是纯数据（`Task[]` 之类），
 * 不碰 `node:fs`，也不碰 `crypto` 之外的 node 内置（`nextInstance` 用的是
 * `globalThis.crypto.randomUUID`，见 repeat.ts）。
 *
 * **放在 `server/src`，不是 `web/src/lib`**：这两个包对「跨包引用」的容忍度不对称，
 * 实测过——`server/tsconfig.json` 显式设了 `rootDir: "src"`，`web/src/App.tsx`
 * 一类文件哪怕只 `import` 一个 `web/src/lib/*.ts`，`tsc -p server/tsconfig.json`
 * 都会报 TS6059「File is not under 'rootDir'」（`noEmit` 也一样会报）；反过来
 * `web`（`moduleResolution: "bundler"`、没设 `rootDir`）typecheck 和 `vite build`
 * 都能正常引用 `server/src/*.ts`，两边都实测过。放这儿是唯一不用改任一侧
 * tsconfig（server 的 outDir 结构会牵连 `npm start` 用的 `node server/dist/index.js`）
 * 就能让 server 和 web 共用同一份的位置——Task 2 要接线本地存储时，`web/src/lib/`
 * 下的文件直接用相对路径 `../../../server/src/mutate.js` 引用这里，不用另建
 * `shared/` workspace。
 *
 * `server/src/app.ts` 的路由改成调这里，行为要一个字节不变——`applyTaskPatch.test.ts`
 * 是唯一直接 `import` 这个函数的既有测试（`from './app.js'`，2 个参数），见下面
 * `applyTaskPatch` 自己的注释，app.ts 保留了一个同名的兼容包装，不用改那份测试。
 */

/**
 * 把一个 patch 应用到一条已有任务上，算出新的那条。**两个调用方共用：**
 * `PATCH /api/tasks/:id`（人在卡片上直接改）和 `POST /api/proposals/:id/accept`
 * （人接受了 AI 的一条建议），批量 `PATCH /api/tasks` 也走这一份。
 *
 * `now` 由调用方传入（服务端传 `nowIso()`）——**必填，没有默认值**：跟
 * `nextInstance(done, at)` 同一个规矩，纯函数不读系统时钟，调用方没传就该是
 * 类型错误，不是悄悄落回 `new Date()`——那样这个函数就不再是「调什么时间进去
 * 就吐什么时间出来」，测试也没法再冻结时钟去断言它。`server/src/app.ts` 顶部
 * 那个同名的 `export function applyTaskPatch(prev, patch, now = nowIso())`
 * 是唯一的例外，纯粹是为了 `applyTaskPatch.test.ts`（2 个参数调用）不用改。
 *
 * 抽出来不是为了少写几行，是因为下面这两条规则**必须两条路都走到**。
 * 「接受提议」如果自己重写一遍应用逻辑，最容易漏掉的就是第一条——漏了之后
 * 「接受一条改期建议」等于悄悄取消那个提醒，永远不会响，而界面上没有任何
 * 东西会告诉你。
 */
export function applyTaskPatch(prev: Task, patch: Partial<Task>, now: string): Task {
  // 提醒时间变了就把「已提醒」的章清掉。不清的话改期等于取消提醒——
  // 而界面上没有任何东西会告诉你这件事。
  //
  // reminders 把「时刻」和「章」绑在同一个字段里，所以不能像以前那样靠
  // 「patch 里有没有 remindedAt」来判断意图——客户端发上来的一定是整个数组。
  // 改成按时刻逐条比对：这个时刻在旧数组里出现过就沿用它原来的章，是个新
  // 时刻就从「还没提醒过」算起。语义跟旧的那条完全一样，只是判断方式换了。
  const reminders = patch.reminders
    ? patch.reminders.map((r) => ({
        at: r.at,
        firedAt: prev.reminders.find((p) => p.at === r.at)?.firedAt ?? null,
      }))
    : undefined;

  // 从「搁置」恢复待办、从「已完成」重开——这两条都是「今天」成员资格
  // 之外的状态回到之内。恢复之前的 order 是几天前排过的一个老数字，
  // `applyMove`（web/src/lib/taskView.ts）每次移动都把当前可见列表整份
  // 重新编号成 0..n-1，同一个数字早被别的卡占用了；带着这个老数字回来，
  // 会跟当前占着那个位置的卡撞车，`createdAt` 兜底比较通常还让它跳到
  // 最上面——盖过用户特意排在第一的卡。清成 null 让它退回「新任务」那条
  // 待遇：沉到「今天」末尾，直到用户重新碰过它，见 README「新任务……
  // 沉在最下面」那句承诺，恢复的任务也该照这条走，不是例外。
  // `doing -> todo`（退回）不算：这两个状态本来就都在「今天」成员资格
  // 之内，没有「离开又回来」这一步，不该清。调用方显式传了 order 就尊重
  // 那个值，不覆盖——这里只补「调用方没提」的默认行为。
  const restored = patch.status === 'todo' && !('order' in patch)
    && isSettled(prev.status);

  // 完成时间由服务端盖章。只在**状态跃迁**时动：done→done（改个备注）
  // 不重新盖章，否则「什么时候完成的」会被后来的每一次编辑推后。
  // 跃迁时调用方传上来的 completedAt 会被覆盖掉，这跟上面 order 那条
  // 「显式传了就尊重」不一样，是有意的：order 是人的排序意图，completedAt
  // 是事实记录，不该由调用方编。
  const toDone = patch.status === 'done' && prev.status !== 'done';
  const fromDone = patch.status !== undefined && patch.status !== 'done' && prev.status === 'done';

  // 推迟计数：只认「本来有截止日期，被往后挪了」。第一次设日期不是推迟，
  // 往前提不是推迟（也不减——推迟次数是历史，不是净值），清空不是推迟。
  // 两边有任何一个解析不了就不动，别让坏数据把计数搞乱。
  const prevDue = prev.due ? Date.parse(prev.due) : NaN;
  const nextDue = patch.due ? Date.parse(patch.due) : NaN;
  const postponed = 'due' in patch && !Number.isNaN(prevDue) && !Number.isNaN(nextDue) && nextDue > prevDue;

  // `completedAt`（跃迁到 done 时）和 `updatedAt` 现在共用同一个 `now`——跟这次
  // 重构之前不是逐字节一样：旧版这两处各自现读一次 `nowIso()`，理论上可能差
  // 不到 1ms（两次 `Date.toISOString()` 调用之间那点间隙，跨毫秒边界才会体现）。
  // 没有测试断言过这两个字段不相等，这是抽成纯函数带来的一个更正确的副作用
  // （同一次 patch 里「完成时间」和「更新时间」现在保证是同一个时刻），不是
  // 行为倒退。
  // 检查事项全部勾完 → 这条任务自动完成（滴答清单帮助文档原话：「检查事项
  // 全部完成后，主任务将自动完成」）。
  //
  // **三条限制**，缺一条都会让它从「省一步」变成「替你做决定」：
  // ① 只在这次 patch 真的动了 `subtasks` 时判——不然改个备注也会把一条
  //    早就勾满、但他有意留着没完成的任务偷偷标完成。
  // ② 只从「没勾满」跨到「勾满」那一次触发。已经勾满的任务被他手动退回
  //    todo（「还有点收尾」），下一次编辑不该再把它推回 done。
  // ③ 这次 patch 自己带了 `status` 就听他的——他明确说了要什么状态。
  // 一条子项都没有的任务不适用：空列表不算「全部完成」。
  const subsNow = patch.subtasks ?? prev.subtasks;
  const allChecked = (xs: Subtask[]) => xs.length > 0 && xs.every((x) => x.done);
  // `!isSettled` 而不是 `!== 'done'`：搁置和放弃跟完成一样，都是人已经对这条
  // 做过判断了。在一条**已放弃**的任务上勾掉最后一个检查事项，把它自动改成
  // 已完成，是拿一个顺手的动作推翻一个明确的决定。（这行原来只认 done——
  // later/abandoned 是后加的状态，跟 ics/日历/横幅那几处漏的是同一批。）
  const autoDone = 'subtasks' in patch && !('status' in patch)
    && !isSettled(prev.status) && allChecked(subsNow) && !allChecked(prev.subtasks);

  // **只挪了 `startAt`、没给 `endAt` 时，把 `endAt` 跟着挪同样多**（时长不变）。
  //
  // 不补这一条，一条「只有时间段、没有 due」的任务会**从所有日历面上消失**：
  // `startAt` 推过 `endAt` 之后 `hasTimeBlock`（判据是 `end > start`）变假，
  // `calendarAnchor` 退回看 `due`，而 `due` 是 null，于是返回 null，那条任务
  // 哪一格都落不进去；`ics.ts` 又本来就跳过没有 `due` 的，导出的日历里也没有。
  // 全程不报错。而「只有时间段、没有 due」是这个应用明确支持的状态，`ics.ts`
  // 顶上那段注释专门说了它「在这个应用自己的日历上画得好好的」。
  //
  // **这条路是被设计出来的用法，不是边角**：`PROPOSABLE` 收 `startAt` 但不收
  // `endAt`（见 `task.ts`），而把 `startAt` 放进白名单的理由，那段注释写的正是
  // 「AI 可以提『等 9 月开学再说』」——一条只改 `startAt` 的建议。实测复现过：
  // 接受之后 startAt 到了 9/21、endAt 还在 9/7。
  //
  // 「成对搬、间隔不变」是这个仓库的既有做法，`duplicate.ts` 和 `reschedule.ts`
  // 的 `shiftTimesPatch` 都这么干，理由同样写着「带一半等于把时长弄没了」。
  // 这里补的是第三处，也是唯一一处两个字段会被拆开的入口。
  //
  // **只在「拆开了、而且拆坏了」时动**：patch 自己给了 `endAt` 就听它的（调用方
  // 明确说了两头在哪）；本来就没有时间段的不动（那是在第一次设开始时间）；
  // 挪完仍然 `end > start` 的也不动（会议只是开始得晚了、结束时间是人定的）。
  const shifted = (() => {
    if (!("startAt" in patch) || "endAt" in patch) return null;
    const ps = prev.startAt ? Date.parse(prev.startAt) : NaN;
    const pe = prev.endAt ? Date.parse(prev.endAt) : NaN;
    const ns = patch.startAt ? Date.parse(patch.startAt) : NaN;
    // 本来就不成块（含第一次设开始时间）、或者新值解析不了：不碰 endAt。
    if (Number.isNaN(ps) || Number.isNaN(pe) || Number.isNaN(ns) || !(pe > ps)) return null;
    // 挪完还是好的块：人只是改了开始时刻，尊重它。
    if (pe > ns) return null;
    return { endAt: new Date(pe + (ns - ps)).toISOString() };
  })();
  /**
   * **重复档改得不再够格当习惯时，把习惯记号一起摘掉。**
   *
   * `checkTaskPatch` 只在这次 patch 里**有 `habit`** 时守这条不变量（它看不见
   * 这条任务原来的 repeat，理由写在那儿）。反方向没人守：只改 `repeat`、不带
   * `habit` 的 patch 一路通过，留下一条 `habit: true` + 每月重复的任务。
   *
   * **这条路是被设计出来的用法**：`repeat` 在 `PROPOSABLE` 里、`habit` 不在
   * （`task.ts`），所以 AI 提一条「改成每月一次」、他点接受，就是这个走法。
   *
   * 后果不是崩，是**两块屏幕各说各话**：读侧一律走 `isHabit`（同时看记号和
   * 重复档），所以卡片上的连续天数、打卡格、月度打卡表全都当它不是习惯了；
   * 而任务编辑器里那个「当成习惯」的勾读的是**原始的 `t.habit`**，照样勾着。
   * 更闷的是再往后：他随手改个标题一保存，`TaskCard.tsx` 那句归一化就把记号
   * 摘了——记号在一次跟习惯毫无关系的编辑里消失，屏幕上没有任何交代。
   *
   * **摘记号而不是拒收**：拒收的理由（`task.ts` 里 `status:'later'` 那条）是
   * 「悄悄改正会把 AI 的错误藏起来」，那说的是**patch 本身不合法**。这儿的
   * patch 完全合法——「以后改成每月做一次」是他真的想要的，因为它顺带让另一个
   * 字段失效就整条拒掉，才是把话说反。归一化的口径也不是新的：`TaskCard.tsx`
   * 保存时早就这么做，这里只是把它挪到两条 PATCH 和「接受建议」都必经的那一处。
   */
  const demoted = 'repeat' in patch && prev.habit === true
    && patch.habit === undefined && !canBeHabit(patch.repeat);

  return {
    ...prev, ...patch,
    ...(shifted ?? {}),
    ...(demoted ? { habit: false } : {}),
    ...(reminders ? { reminders } : {}),
    ...(autoDone ? { status: 'done' as const, completedAt: now } : {}),
    ...(restored ? { order: null } : {}),
    ...(toDone ? { completedAt: now } : {}),
    ...(fromDone ? { completedAt: null } : {}),
    ...(postponed ? { postponeCount: prev.postponeCount + 1 } : {}),
    updatedAt: now,
  };
}

/**
 * 完成一条重复任务时要不要顺手生成下一条。**单条 `PATCH /api/tasks/:id` 和
 * 批量 `PATCH /api/tasks` 共用这份判断**——批量那条如果自己重写一遍（或者
 * 干脆漏掉），最容易漏的就是这整段：一条「每周一写周报」批量标成已完成，
 * 重复链条会静默断掉，而卡片上点完成、看板拖进「已完成」列都会正常生成
 * 下一条，用户过一周才会发现「写周报」没出现（这个仓库真的栽过一次，见
 * 已归档的 docs/superpowers/specs/2026-08-15-parked-all.md 第十一节 96）。
 *
 * `prevStatus` 是这条任务改之前的状态（判断要用它，不能用 `next.status`，
 * 否则 done→done 的编辑也会被当成一次跃迁）。`rows` 是查重范围：当前完整
 * 任务列表，加上同一次批量请求里、本轮已经生成过的候选——不然同一批里
 * 两条同标题同 due 的重复任务会各自生成一条。
 *
 * 「取消完成再完成一次」（done → todo → done）会在这一步第二次跃迁到
 * done：candidate 又照样算出一条「下一条」，但上一轮完成时其实已经生成
 * 过一模一样的那条了（还在 rows 里，状态还是 todo）——两条叠起来变成
 * 两张标题、due 都相同的卡，而用户只完成过一次。生成前查一眼 rows 里
 * 有没有同款：同一个 repeat、同标题、同 due、还没完成的，命中就当
 * 「已经生成过」，不再重复生成。
 *
 * 这是个取舍，不是万能判定：如果真的存在两条 repeat 都非空、标题和 due
 * 完全相同、都还没完成的任务，这里会漏生成一次——用户需要自己再碰一下
 * 那条任务。要求 repeat 非空是为了把这个误判的前提收窄到「两条重复任务
 * 标题和 due 完全撞车」这种本来就很少见的场景，换来的是「点错了撤销
 * 一下」这条正常路径不再静默造重复。
 */
export function maybeSpawnNextInstance(prevStatus: Task['status'], next: Task, rows: Task[], at: Date): Task | null {
  const candidate = prevStatus !== 'done' && next.status === 'done' ? nextInstance(next, at) : null;
  if (!candidate) return null;
  return hasTwinInstance(rows, candidate) ? null : candidate;
}

/**
 * 完成一条父任务时，顺手完成它下面还没了结的子任务（仿滴答清单）。没有可连带
 * 的就返回 `null`——**调用方据此决定写不写盘**，跟 `detachDeletedTasks` 同一条。
 *
 * 补的是一个真的会让人看不懂的状态：父任务「装修」标成已完成，卡片上却还写着
 * 「子任务 1/2」，而「刷墙」照旧躺在今天里。父任务完成的意思就是这件事结束了，
 * 底下那两步不该继续要求他做。这跟已有的「检查事项全部勾完 → 主任务自动完成」
 * 是同一件事的另一半：一层是检查事项，一层是子任务。
 *
 * **三条边界**：
 * ① 只在**跃迁**到 done 那一刻做一次，跟 `maybeSpawnNextInstance` 同一个判据——
 *    done → done（改个备注）不该反复把他手动重开过的子任务再按下去。
 * ② 已经了结的子任务一概不碰（`isSettled`：done / later / abandoned）。搁置和
 *    放弃都是他明确做过的判断，「父任务完成了」不是推翻那个判断的理由；
 *    尤其 later 被改写成 done 会让它从「暂时不想做」变成一条假的完成记录。
 * ③ **连带完成的子任务不生成重复的下一条。** 调用方的 spawn 那一步只遍历这次
 *    显式 patch 过的 id，连带出来的不在里面——这不是巧合，是有意的：一条被
 *    「父任务结束了」顺带关掉的重复子任务，再生成一条挂在已完成父亲下面的新
 *    实例，等于凭空造一件没人要求做的事。
 *
 * **走整棵子树**（`descendantIds`）：放开到五层之后，「子任务底下不会再有
 * 子任务」那句话不再成立，只关一层会把孙辈落在一个已完成的父亲下面。
 *
 * 反方向**不做**：父任务重开不会把子任务一起翻回来。完成是「这件事结束了」，
 * 一句话覆盖得住底下每一步；重开只是「还有点收尾」，哪一步要重做只有他知道。
 */
export function cascadeChildrenDone(
  prevStatus: Task['status'], parent: Task, rows: Task[], now: string,
): Task[] | null {
  if (prevStatus === 'done' || parent.status !== 'done') return null;
  // **整棵子树**，不是只有直接子任务：勾掉一个三层的项目，孙辈也该跟着完成
  // ——留着它们等于一个已完成的项目下面挂着一串还没做完的事，而那正是
  // 「卡住的项目」那份清单要抓的形状。
  const under = descendantIds(rows, parent.id);
  const kids = new Set(
    rows.filter((t) => under.has(t.id) && !isSettled(t.status)).map((t) => t.id),
  );
  if (kids.size === 0) return null;
  // 走 applyTaskPatch，不是手写 `{...t, status: 'done'}`——「一条任务变成已完成」
  // 该盖的章（completedAt、updatedAt）只该有一处实现。
  return rows.map((t) => (kids.has(t.id) ? applyTaskPatch(t, { status: 'done' }, now) : t));
}

/**
 * 把父任务挪到别的清单时，**原来跟它在一起的子任务跟着走**。没有可动的就
 * 返回 `null`。
 *
 * 补的是一个说不通的分裂：`promoteSubtask`（检查事项转子任务）建出来的子任务
 * **就是从父亲那儿继承的 `listId`**，理由写在那儿——「同一件事的一步，不该掉
 * 进收件箱」。而父亲后来换清单时，那几步却原地留在旧清单里：清单 A 里是一条
 * 写着「子任务 0/2」的父任务、两个孩子看不见，清单 B 里是两条挂着「属于
 * 「装修」」、而那条装修不在这个清单里的孤儿。
 *
 * **只带走「原来跟父亲在同一个清单里」的那几个。** 有人特意把某一步放到别的
 * 清单里（「这步归采购」），那是一个明确的安排，不该被父亲的一次移动顺手
 * 收编回去。判据就是「它此刻的 listId 等于父亲挪走之前的那个」——跟着走的
 * 是本来就跟着的，不是所有的。
 */
export function cascadeListToChildren(
  prev: Task, next: Task, rows: Task[], now: string,
): Task[] | null {
  if (prev.listId === next.listId) return null;
  // **整棵子树**（放开到五层之后）：把一个项目挪去别的清单，孙辈跟着走，
  // 否则同一棵树会散在两份清单里。判据仍然是「原来跟父亲在同一份清单」——
  // 自己另外归过类的那几条不动，那是他明确做过的决定。
  const under = descendantIds(rows, next.id);
  const moving = new Set(
    rows.filter((t) => under.has(t.id) && (t.listId ?? null) === (prev.listId ?? null)).map((t) => t.id),
  );
  if (moving.size === 0) return null;
  // 走 applyTaskPatch，跟另外两条连带一样：`updatedAt` 该怎么盖只有一处实现。
  return rows.map((t) => (moving.has(t.id) ? applyTaskPatch(t, { listId: next.listId }, now) : t));
}

/**
 * 最后一个子任务做完 → 父任务自动完成。**这是「检查事项全部勾完 → 主任务
 * 自动完成」那条规矩的另一半**：一层是检查事项（`applyTaskPatch` 里的
 * `autoDone`），一层是子任务，而子任务这一半一直没有——四步全做完了，头上
 * 那条「装修」还开着，要再点一下才算完。
 *
 * 反方向（完成父任务连带完成子任务）是 `cascadeChildrenDone`，两条凑成一对。
 * 没有可改的就返回 `null`，调用方据此不写盘。
 *
 * **判据**：
 * ① 只在这条子任务**跃迁**到 done 那一刻看一次，跟另外两条同一个判据；
 * ② 父亲还开着才动它——已完成的不用管，**搁置和放弃的不碰**：那是他明确
 *    做过的判断，「孩子都做完了」不是推翻它的理由（跟 `cascadeChildrenDone`
 *    边界②同一条）；
 * ③ **放弃了的兄弟不算数**，既不挡也不算完成——跟 `childProgress` 那个
 *    「子任务 1/2」的记号用的是同一套（放弃的分子分母都不进），否则界面上
 *    显示 2/2 了、父亲却还开着。搁置的兄弟**挡**：那件事还在。
 *
 * **自动完成的父亲不生成重复的下一条**，也不再往下连带——调用方的 spawn 只
 * 遍历这次显式 patch 过的 id，父亲不在里面。跟 `cascadeChildrenDone` 边界③
 * 同一个理由：这不是「他做完了那条重复任务」，是一次连带。
 */
export function rollUpParentDone(
  prevStatus: Task['status'], child: Task, rows: Task[], now: string,
): Task[] | null {
  if (prevStatus === 'done' || child.status !== 'done' || !child.parentId) return null;

  /**
   * **一路往上收，不是只收一层。** 五层下，勾掉最深那一条可能把它上面三代
   * 一起收掉——只收一层的话，中间那个父亲变成已完成，而**它的父亲**还挂着，
   * 而且底下一条能动的都没有：那正是「卡住的项目」那份清单要抓的形状，
   * 由一次正常的完成动作造出来，说不过去。
   *
   * 每一层的判据跟原来一字不差：这个父亲还没了结，而它**除放弃之外的直接
   * 子任务**全都做完了。放弃的不算数——它既不是做完也不该永远挡着。
   */
  let out = rows;
  let cursor: string | null = child.parentId;
  const seen = new Set<string>();          // 盘上的文件可能有环，见 descendantIds
  let changed = false;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent: Task | undefined = out.find((t) => t.id === cursor);
    if (!parent || isSettled(parent.status)) break;
    const siblings = out.filter((t) => t.parentId === parent.id && t.status !== 'abandoned');
    if (siblings.length === 0 || !siblings.every((t) => t.status === 'done')) break;
    // 走 applyTaskPatch，不是手写 `{...t, status: 'done'}`——「一条任务变成
    // 已完成」该盖的章只该有一处实现。
    out = out.map((t) => (t.id === parent.id ? applyTaskPatch(t, { status: 'done' }, now) : t));
    changed = true;
    cursor = parent.parentId;
  }
  return changed ? out : null;
}

/**
 * **三条连带，一次跑完。** 改一条任务之后要顺着做的事全在这儿，调用方只写
 * 一行——`cascadeAll(改之前那份, 改之后那份, 全部任务, 时间戳)`。
 *
 * 收成一份是因为**漏掉其中一条已经真的发生过两次**，两次都是静默的：
 *
 * - 接受一条 AI 建议原来只走 `applyTaskPatch`：接受「把父任务移到清单 B」之后
 *   子任务留在 A，接受「把子任务都勾上」之后一条每周重复的任务就地断链。
 * - 离线改任务（`web/src/lib/dataSource.ts` 的 `patchTask`）同样只走
 *   `applyTaskPatch`：手机上勾掉一个三层的项目，提示语照样说「连带做完了 5 条
 *   子任务」（那句话是界面自己按服务端的规矩算的，见 `lib/undoDone.ts`），
 *   而屏幕上那 5 条一条都没变。
 *
 * 三个调用点各自抄三行的写法下，「谁又漏了一条」没有任何东西挡得住——类型对、
 * 测试各测各的、界面不报错。收成一份之后那种漏法**没有位置发生**：要么调
 * `cascadeAll`，要么一条都没有。
 *
 * 顺序有讲究，不是随手排的：先向下（父完成 → 子跟着完成），再向上（最后一个
 * 子做完 → 父跟着完成），最后换清单。向下那条会把子任务变成 done，正是向上
 * 那条要看的输入；换清单跟完成无关，放最后免得中间那两条看见一半的 `listId`。
 *
 * **`maybeSpawnNextInstance` 不收进来**：它得在三条连带都跑完之后、只对
 * 「这次显式 patch 过的 id」跑（连带出来的子任务不能各自再生成下一条，
 * `cascadeChildrenDone` 边界③），而批量那条路的 spawn 是另一个循环、
 * 另一个时间戳。收进来就得多一个「哪些 id 算显式改过」的参数，那正是
 * 调用方之间真正不一样的地方。
 */
export function cascadeAll(prev: Task, next: Task, rows: Task[], now: string): Task[] {
  const down = cascadeChildrenDone(prev.status, next, rows, now) ?? rows;
  const up = rollUpParentDone(prev.status, next, down, now) ?? down;
  return cascadeListToChildren(prev, next, up, now) ?? up;
}

/**
 * **批量改，一次做完：各自 patch → 三条连带 → 生成下一条。** 服务端
 * `PATCH /api/tasks`（批量）和离线 `patchTasksEach` 共用这一份——原来两处
 * 逐字抄着同一个循环，下面这两条 bug 也就抄了两份。
 *
 * 结果的形状：`rows` 是改完的全表（顺序不变），`born` 是这次顺手生出来的
 * 下一条（们），`touched` 是真的命中了的 id（调用方拿它算 `updated`、打同步
 * 记号）。**批量的结果必须等于把每条单独 PATCH 一遍**——下面两条都是这个
 * 等式被打破的地方：
 *
 * ## 生成下一条看的是「他改的那份」，不是连带之后那份
 *
 * 父任务 a（不重复）和它底下一条每天重复的 b 同一批改：a 标完成、b 改优先级。
 * 原来 spawn 拿的是连带之后的 `rows[i]`——a 的连带把 b 也标成了 done，于是
 * b 那一轮看见 todo → done 的跃迁，**生了一条 b 的下一次**。可这两下分开发
 * 就不会生：b 自己改的是优先级，没碰状态；a 的连带只对显式 patch 过的 id 生成
 * （`cascadeChildrenDone` 边界③）。改成拿 `patchedRows[i]`（他这次真改成的那份），
 * 跟单条路由传 `next` 一个口径。`hasTwinInstance` 挡不住这个：那条幻影没有双胞胎。
 *
 * ## 连带按「深的先」跑，孙辈才知道该跟谁走
 *
 * p → k → g 三层都在清单 A，同一批把 p 挪去 B、k 挪去 C。连带的判据是
 * 「这条**此刻**的清单等于父亲挪走之前的清单」（`cascadeListToChildren`），在
 * 累积的 `rows` 上跑：先跑 p，g 被带去 B，再跑 k 时 g 已经不在 A 了、不动——
 * g 落在 B；先跑 k 则 g 落在 C。实测过：同一份请求体只换任务 id 的顺序，g 去
 * 的清单不一样。而遍历顺序是 `readdirSync().sort()` 的 uuid 文件名顺序，谁也
 * 控制不了。**深的先跑**：k 先把 g 带去 C，轮到 p 时 g 和 k 都已经不在 A，
 * 都不动——g 跟着离它最近的那个被改的祖先走，这是唯一说得通的答案。
 */
export function patchMany(
  all: Task[], patches: Map<string, Partial<Task>>, now: Date,
): { rows: Task[]; born: Task[]; touched: string[] } {
  const iso = now.toISOString();
  const touched: string[] = [];
  const patchedRows = all.map((t) => {
    const p = patches.get(t.id);
    if (!p) return t;
    touched.push(t.id);
    return applyTaskPatch(t, p, iso);
  });
  const hit = all.map((_, i) => i).filter((i) => patches.has(all[i].id));
  // 深的先（见上）。`depthOf` 按 `all`（改之前）算——parentId 也可能在这一批里改，
  // 但「谁的连带先跑」看的是他动手之前的树，跟 `cascadeAll` 拿 `prev` 当判据一致。
  const deepFirst = [...hit].sort((a, b) => depthOf(all, all[b].id) - depthOf(all, all[a].id));
  let rows = patchedRows;
  for (const i of deepFirst) rows = cascadeAll(all[i], patchedRows[i], rows, iso);
  // 生成下一条按文件顺序遍历，跟原来一样——`born` 的先后是写盘顺序，别跟着
  // 深度变来变去。
  const born: Task[] = [];
  for (const i of hit) {
    const spawned = maybeSpawnNextInstance(all[i].status, patchedRows[i], [...rows, ...born], now);
    if (spawned) born.push(spawned);
  }
  return { rows, born, touched };
}

/**
 * `rows` 里有没有一条跟 `candidate` 是同一次生成的下一条实例：同 `repeat`（非空）、
 * 同标题、同 due、还没完成，而且不是 `candidate` 自己。
 *
 * **两个调用方，必须共用同一份判据**（各写一份的话改一头另一头会静默分叉）：
 * - 上面的 `maybeSpawnNextInstance`——「取消完成再完成一次」（done → todo → done）
 *   不该生成第二条，详见它自己的注释；
 * - `POST /api/push`（Task 6）——手机离线完成生成了实例 A、桌面上也完成过生成了
 *   实例 B。A 没有基准（离线新建）、服务端也没有它的 id，照规矩会被直接创建，
 *   于是 A 和 B 并存：两张标题、due 都一样的卡，而用户只完成过一次。
 *
 * 五个条件每一条都担着事，放宽和收紧的坏法方向不同：判太松，重复实例照样并存
 * （看板上多一张一模一样的卡）；判太紧，本该独立存在的那一条会被当成「同款」。
 * `mutate.test.ts` 里五条各有一条自己的测试。
 *
 * **判太紧的代价两层不一样，这儿不下结论**：上面那层是「这一次没生成下一条」，
 * 用户再碰一下那条任务就有了；推送那层是「手机上真新建的那条进不了服务端」，重得多。
 * 两层各自怎么处理这个 `true`（以及为什么刻意不一致、别顺手改成一致），写在
 * `app.ts` 的 `applyTasksPush` 里那段——改这份判据之前先读那段。
 */
export const hasTwinInstance = (rows: Task[], candidate: Task): boolean =>
  rows.some((x) =>
    x.id !== candidate.id && x.repeat && x.title === candidate.title
    && x.due === candidate.due && x.status !== 'done');

/**
 * 任务被删（软删除）之后，收件箱的 `taskIds` 和提议的 `taskId` 里指向它们的引用要
 * 清掉——不清的话，收件箱「已拆解」区里会挂着一条点不开的死链接（用户看得到一条
 * 任务却怎么点都点不到），而提议只渲染在它对应的那张卡里，卡没了就成了永远看不见、
 * 也没有任何入口能删掉的孤儿。
 *
 * 返回 `null` = 这张表没有任何引用要清。**调用方据此决定写不写盘**：一次没有任何
 * 影响的写照样会触发目录监听器，给所有开着的网页推一次没道理的刷新。
 *
 * 三个调用方：`DELETE /api/tasks/:id`（传 `new Set([id])`）、`DELETE /api/tasks`、
 * `POST /api/push`（Task 6）。前两个本来各自手写了一份逐行同构的清理（区别只在
 * 单条 vs 集合），这次合并成这一份。
 */
export function detachDeletedTasks(
  inbox: InboxItem[], proposals: Proposal[], ids: Set<string>,
): { inbox: InboxItem[] | null; proposals: Proposal[] | null } {
  let inboxChanged = false;
  const nextInbox = inbox.map((x) => {
    const kept = x.taskIds.filter((tid) => !ids.has(tid));
    if (kept.length === x.taskIds.length) return x;
    inboxChanged = true;
    return { ...x, taskIds: kept };
  });
  const left = proposals.filter((p) => !ids.has(p.taskId));
  return {
    inbox: inboxChanged ? nextInbox : null,
    proposals: left.length === proposals.length ? null : left,
  };
}

/**
 * 从垃圾箱捞回来——**`softDeleteTasks` 的反向**，两个放一块，改一头时另一头
 * 就在眼前。垃圾箱里没有这一条时返回 `null`（调用方据此回 404 / 不写盘）。
 *
 * `deletedAt` 不能跟着回去——它是「在垃圾箱里」这件事本身的记号，留在任务上
 * 就成了一个没人读、也没人清的幽灵字段。
 *
 * `order` 清成 `null`，跟 `applyTaskPatch` 里「later/done 回到 todo 要清 order」
 * 同一条规矩：`applyReorder` 每次移动都把当前可见列表整份重新编号成 0..n-1，
 * 这条在垃圾箱里躺着的时候那个位置早被别的卡占了。带着老数字回来会撞车，
 * `createdAt` 兜底比较通常还让它跳到最上面——盖过用户特意排在第一的卡。
 * 清掉的代价只是沉到「今天」末尾、拖一下就回来；不清的代价是无声改掉一份他
 * 亲手排过的顺序。两个方向都会错，选会被看见的那个。
 *
 * **服务端的 `POST /api/trash/:id/restore` 和离线那条共用这一份**：这段判断
 * 原来只长在路由里，于是「离线能删、但永远还不了」——垃圾箱存在的意义正是
 * 让删除不是一扇单向门，而离线时它偏偏是。
 */
export function restoreFromTrash(
  tasks: Task[], trash: TrashItem[], id: string,
): { tasks: Task[]; trash: TrashItem[]; restored: Task; back: Task[] } | null {
  const it = trash.find((x) => x.id === id);
  if (!it) return null;
  // **同一次删进去的整棵子树一起捞回来。** 判据是 `deletedAt` 一模一样——那是
  // 「它们是同一下删的」唯一可靠的记号（`softDeleteTasks` 给一次调用里的每
  // 一条盖同一个戳）。不按「凡是 parentId 指着它的都捞」：上周单独删掉的那条
  // 子任务是他当时的决定，不该因为今天删了一次父任务又还原就自己回来。
  //
  // **一层层往下收，不只直接子任务。** `softDeleteTasks` 删的是整棵子树
  // （`descendantIds`），这儿原来只捞 `parentId === id` 那一层：三层的「装修 →
  // 刷墙 → 买涂料」删掉再还原，回来的是装修和刷墙，买涂料**永久留在垃圾箱**，
  // 刷墙回来后显示「子任务 0/0」——而删除确认框上写的是「还原时一起回来」。
  // 每一轮只认「父亲已经在回来名单里」的，所以链条中间被单独删过的那条
  // （`deletedAt` 不同）照样把它底下的截断——跟上面那条规矩一致。
  const backIds = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of trash) {
      if (x.deletedAt !== it.deletedAt || backIds.has(x.id) || !x.parentId || !backIds.has(x.parentId)) continue;
      backIds.add(x.id);
      grew = true;
    }
  }
  const strip = ({ deletedAt: _gone, ...task }: TrashItem): Task => ({ ...task, order: null } as Task);
  // 他点的那一条排第一（`restored` 就是它），其余按垃圾箱里的顺序。
  const back = [strip(it), ...trash.filter((x) => x.id !== id && backIds.has(x.id)).map(strip)];
  const restored = back[0];
  return {
    tasks: [...tasks, ...back],
    trash: trash.filter((x) => !backIds.has(x.id)),
    restored,
    // 捞回来的**全部**，不只是点的那一条。离线那条路要按它给每一条打同步
    // 记号（`web/src/lib/dataSource.ts` 的 `restoreTrash`）——只认 `restored`
    // 的话，一起回来的子任务下一次联网就又没了。服务端那条路只用 `restored`
    // 当响应体，多这一个字段对它没有影响。
    back,
  };
}

/**
 * 软删除：把命中 `ids` 的任务从 `tasks` 里摘掉、搬进 `trash`，打 `deletedAt` 戳。
 * `DELETE /api/tasks/:id`（单条）和 `DELETE /api/tasks`（批量）共用这一份——
 * `ids` 传一个元素就是单条。
 *
 * 只管 tasks/trash 这两个数组：inbox 的 taskIds 清理、proposals 的清理是各自
 * 独立的副作用（读别的目录、跟软删除这件事本身没有耦合），留在 app.ts 里，
 * 不进这个纯函数——这份契约照 AGENTS.md「data/tasks/ 里少了一条多半是他删掉
 * 了，去了 data/trash/」，不是真的删除。
 *
 * **重复 id 的边界行为改了，是修复不是回归**：旧的单条 `DELETE /api/tasks/:id`
 * 用 `all.find(x => x.id === id)` 只挑**一条**塞进垃圾箱，却用
 * `all.filter(x => x.id !== id)` 把**所有**同 id 的条目一起从 `tasks` 摘掉——
 * 正常情况下 id 唯一，两者结果一样；`tasks/` 目录被手改出过两条同名文件之类
 * 的异常情况下，旧版会让多出来的那些条目直接从 tasks 蒸发、既不在任务列表也
 * 不进垃圾箱。这里统一用同一个 `idSet` 收集全部命中的任务、全部归档进
 * `trash`，不会再凭空丢任务。
 */
export function softDeleteTasks(
  tasks: Task[],
  trash: TrashItem[],
  ids: Iterable<string>,
  deletedAt: string,
): { tasks: Task[]; trash: TrashItem[] } {
  const asked = ids instanceof Set ? ids : new Set(ids);
  // **父任务连子任务一起删**（向滴答清单靠齐）。**整棵子树**，不是只有直接
  // 子任务——放开到五层之后，「一轮就够、不用递归」那句话不再成立，而漏掉
  // 孙辈的后果是它们当场变成指向空处的孤儿：父亲进了垃圾箱，它们还挂在一个
  // 不存在的 `parentId` 上，界面按顶层渲染，数据里却不是。
  //
  // 这里原来选的是保守那一侧：把子任务摘成顶层留下。换过来的理由有两条——
  //   1. 删除本来就有垃圾箱兜底，一起删是可还原的；而「摘成顶层」是**不可
  //      还原**的：`parentId` 当场被清成 null，从垃圾箱捞回父任务也接不回去，
  //      那条层级关系无声消失。
  //   2. 确认框现在会把「带走几条子任务」说出来（`web/src/lib/deleteConfirm.ts`），
  //      原来那条「用户点的是一张卡、确认框只说了这一条」的顾虑不再成立。
  // 还原那一侧同步跟上：`restoreFromTrash` 会把**同一次删进去的**子任务一起
  // 捞回来，见那儿。
  const idSet = new Set(asked);
  for (const id of asked) for (const kid of descendantIds(tasks, id)) idSet.add(kid);
  const gone = tasks.filter((t) => idSet.has(t.id));
  return {
    tasks: tasks.filter((t) => !idSet.has(t.id)),
    trash: [...trash, ...gone.map((t) => ({ ...t, deletedAt }))],
  };
}

/**
 * 多级任务最多几层。**跟滴答清单一样是 5**——它那边的原话是「现阶段，我们只
 * 允许5级任务嵌套，超过该上限则不能继续添加」
 * （《多级任务》）。
 *
 * 这个应用原来**只做一层**，理由写在 `model.ts` 里（十二个视图各自要处理无限
 * 层级的缩进和排序）。放开到五层之后那个成本是真的付掉了：下面这一族树工具，
 * 外加 `hierarchy.ts` 那边的展开和候选表。**上限本身是必须的**——没有上限就
 * 没有「超了怎么办」这个问题，而有了上限，答案就得是拒绝而不是悄悄压平。
 */
export const MAX_TASK_DEPTH = 5;

/** 按 `parentId` 建一张「谁是谁的孩子」。下面三个函数共用，不各建一遍。 */
function childIndex(tasks: Task[]): Map<string, string[]> {
  const kidsOf = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const bucket = kidsOf.get(t.parentId);
    if (bucket) bucket.push(t.id);
    else kidsOf.set(t.parentId, [t.id]);
  }
  return kidsOf;
}

/**
 * `id` 的**全部后代**（不含自己）。
 *
 * **带 `seen` 防环**：`checkParentLink` 拦得住新造的环，但盘上的文件是人能手改
 * 的，而一个环会让这个循环永远转不出来——整个进程挂死，跟 `nextOccurrence`
 * 顶部那道 Invalid Date 守卫防的是同一类事故。
 */
export function descendantIds(tasks: Task[], id: string): Set<string> {
  const kidsOf = childIndex(tasks);
  const out = new Set<string>();
  const stack = [...(kidsOf.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur) || cur === id) continue;
    out.add(cur);
    stack.push(...(kidsOf.get(cur) ?? []));
  }
  return out;
}

/** 从根数到 `id` 是第几层（顶层是 1）。链上有环时返回上限，不死循环。 */
export function depthOf(tasks: Task[], id: string): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let depth = 1;
  let cur = byId.get(id);
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
    if (!cur) break;
    depth += 1;
    if (depth > MAX_TASK_DEPTH * 2) break;
  }
  return depth;
}

/** 从 `id` 往下最深还有几层（自己算 1）。链上有环时到上限为止。 */
export function subtreeHeight(tasks: Task[], id: string): number {
  const kidsOf = childIndex(tasks);
  const walk = (cur: string, seen: Set<string>): number => {
    if (seen.has(cur) || seen.size > MAX_TASK_DEPTH * 2) return 1;
    const next = new Set(seen).add(cur);
    const kids = kidsOf.get(cur) ?? [];
    return kids.length === 0 ? 1 : 1 + Math.max(...kids.map((k) => walk(k, next)));
  };
  return walk(id, new Set());
}

/**
 * 「能不能把 `id` 挂到 `parentId` 下面」——不行就返回一句人话，行就返回 null。
 *
 * 四条判据。**前两条跟只做一层那时候一字不差，后两条是放开到五层之后换掉的**：
 *
 * 1. 挂到自己身上——一条自己是自己父亲的任务，任何按 `parentId` 分组的地方
 *    都会把它算成「有父」又「有子」，两边都显示不出来。
 * 2. 父任务不存在（删了、id 打错）——留着就是一条指向空处的关系，界面会当成
 *    顶层渲染，而数据里它不是，两者说的不是一回事。
 * 3. **不能挂到自己的后代下面。** 一层的时候这件事不可能发生，所以原来没有
 *    这条；五层下它是**最要紧的一条**——绕成一个环之后 `nestChildren` 会无限
 *    递归，整个界面当场挂死，而盘上那份数据从此打不开。
 * 4. **挂上去之后整棵树不能超过 `MAX_TASK_DEPTH` 层。** 判的不是「父亲的层数
 *    加一」——把一棵三层的子树挂到一棵三层的下面同样超限，得**连整棵子树一起
 *    算**（`depthOf(父) + subtreeHeight(自己)`）。滴答那边的说法是「超过该上限
 *    则不能继续添加」，所以这里是**拒绝**，不是悄悄把超出的层压平：压平会静默
 *    改掉他已经建好的结构，而那是不可逆的。
 *
 * 原来的第 3、4 条（「父任务本身有父」「自己已经有孩子」）就是「只做一层」那
 * 两句话，五层下它们都不成立了，整条换掉。
 *
 * 纯函数、不读盘：两条 PATCH 路由（单条和批量）共用这一份，别在两处各写一遍
 * ——这个仓库里「批量那条自己重写一遍、漏掉其中一条规则」已经发生过（见
 * `maybeSpawnNextInstance` 顶部那段）。
 */
export function checkParentLink(tasks: Task[], id: string, parentId: string | null): string | null {
  if (parentId === null) return null;
  if (parentId === id) return '不能把一条任务挂到它自己下面';
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) return '找不到要挂上去的那条任务';
  if (descendantIds(tasks, id).has(parentId)) {
    return '不能把一条任务挂到它自己的子任务下面——那会绕成一个圈';
  }
  const after = depthOf(tasks, parentId) + subtreeHeight(tasks, id);
  if (after > MAX_TASK_DEPTH) {
    return `挂上去就有 ${after} 层了，多级任务最多 ${MAX_TASK_DEPTH} 层——先把它下面那几层拆浅一点`;
  }
  return null;
}

/**
 * 「今天」手动排序的批量写：`ids` 是当前可见列表从上到下的顺序，数组下标
 * 就是新的 `order`。`PATCH /api/tasks/reorder`（`app.ts`）和 Task 2 的离线
 * 本地实现（`web/src/lib/dataSource.ts` 的 `localApi.reorderTasks`）共用
 * 这一份——**这条本来是第四份手抄**（复审 task-2-report 修复轮 2 I5 指出），
 * 服务端和离线各写了一份逐行同构的排序逻辑，没有任何东西挡着两边悄悄分叉：
 * 服务端改了排序规则，离线端会静默地继续用旧规则，两边测试都绿。提出来
 * 之后跟另外三个纯函数一样进这个文件的平台无关守卫射程
 * （`platformAgnostic.test.ts`）。
 *
 * `ids` 里找不到对应任务的（`tasks` 里没有这个 id）——那个 id 直接被忽略，
 * 不报错：`targetOrder` 只是个查表用的 Map，没人会去读一个不存在的键。
 * `tasks` 里有的、但没出现在 `ids` 里的——原样不动，`order`/`updatedAt` 都
 * 不碰，见调用方 `app.ts` 那条路由顶部关于「当时不在客户端可见列表里」的
 * 注释，这里只是原样保留那份语义，不是新加的。
 *
 * 只有 `order` 真的变了才进 `changedIds`、才盖 `updatedAt`——调用方据此判断
 * 要不要写盘：一次原样重新提交的排序（`order` 全部没变）不该触发一次空转的
 * 写，见 `app.ts` 那条路由顶部「没有任何变化就不写」的注释。
 */
export function applyReorder(tasks: Task[], ids: string[], now: string): { tasks: Task[]; changedIds: string[] } {
  const targetOrder = new Map<string, number>();
  ids.forEach((id, i) => targetOrder.set(id, i));
  const changedIds: string[] = [];
  const next = tasks.map((t) => {
    const order = targetOrder.get(t.id);
    if (order === undefined || order === t.order) return t;
    changedIds.push(t.id);
    return { ...t, order, updatedAt: now };
  });
  return { tasks: next, changedIds };
}

/**
 * 「这次拆得不对」时，把他补充的一句要求追加到收件箱条目的原文后面。
 *
 * ## 为什么是追加进 `text`，不是给 `InboxItem` 加一个 `notes` 字段
 *
 * 加字段的代价不止是 model.ts 那一行：`AGENTS.md` 里那份契约、web 那份类型
 * 副本、types.sync 那道守卫、outbox 的校验，全都要跟着动一遍。而追加进原文
 * 有两个字段给不了的好处：**AI 那边一个字都不用改**（它读的本来就是整段
 * `text`，规则里没有任何一处需要知道「这段里有几轮要求」），以及**人自己看得见
 * 他提过什么**——收件箱侧栏原样显示这段文字，一条一条列在原话下面。
 *
 * 轮次从 2 起：第一次拆解是第 1 轮，所以第一句补充要求属于第 2 轮。数的是
 * 文本里已有的「补充要求（第 N 轮）」有几处，不信任传进来的数字。
 */
export function appendExpandNote(text: string, note: string): string {
  const rounds = [...text.matchAll(/^补充要求（第 \d+ 轮）：/gm)].length;
  return `${text}\n\n补充要求（第 ${rounds + 2} 轮）：${note}`;
}
