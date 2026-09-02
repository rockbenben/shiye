import type { InboxItem, Status, Task, TaskContext, Reminder } from '../types.js';

/** 五个合法状态值，顺序固定：待办 / 进行中 / 已完成 / 搁置 / 已放弃。导出是
 *  因为看板（`cells.ts` 的 `kanbanCells`）要按这个顺序建列——单一出处，别在
 *  别处再抄一份同样的数组。
 *
 *  「已放弃」跟「搁置」是两件事，仿滴答清单：搁置是「暂时不想看见它」，还会
 *  回来；放弃是「决定不做了，但不删，以后回顾还看得见」。两个都不进「今天」、
 *  都不提醒（`isSettled`），区别在于搁置的人心里还留着它。
 *
 *  **「进行中」是这个应用自己的，三份参照一个都没有。** 滴答那边它是**用户
 *  自建的分组名**（《看板视图：分类管理任务》：「按进度：未开始、
 *  进行中、已完成」——那是你自己敲进去的一列，不是内置状态）；Things 和
 *  OmniFocus 连状态这个概念都不这么建（前者靠 Today/Anytime/Someday 三个清单，
 *  后者的 Available/Blocked 是**算出来**的，不是人设的）。
 *
 *  焊进枚举而不是让人自建，是有意的：这个应用另有 `section`（用户自建分段），
 *  真想按自己的流程分列随时办得到；而「开始做了」是一件**每条任务都可能发生、
 *  而且值得全局统一**的事——看板的四列、卡片上那颗「开始」、撤销要回到哪个
 *  状态，都指望它是同一个值。代价是多一档人得学的状态，收益是这三处不用各自
 *  猜「哪一列算进行中」。写下来是因为它没有出处可引，是判断。 */
export const STATUSES: Status[] = ['todo', 'doing', 'done', 'later', 'abandoned'];

/**
 * 五个状态各叫什么。**住在这儿、跟 `STATUSES` 挨着**——原来它在
 * `components/TaskCard.tsx`，而读它的有筛选栏、批量操作条、侧栏的智能清单
 * 说明、卡片自己；另外三处（`lib/cells.ts` 的看板列头、`TaskBoard` 的筛选
 * 条、`TaskComposer` 的那句提示）干脆各抄了一份一模一样的五个字符串。
 *
 * `cells.ts` 那份的注释写着「文案在这个仓库里本来就没有单一出处……跟着抄
 * 一份是既有做法」——**而这一轮就在抄漏的那一份里抓到了后果**：`TaskBoard`
 * 手抄的那张表少了「已放弃」，于是「按来源」的筛选条只有五档，选不到放弃的
 * 任务（`countByStatus` 一直在数它，那个数字从来没有地方显示）。这跟筛选栏
 * 和批量操作条当初漏掉「已放弃」是同一个 bug，那两处修的时候没顺手修这里。
 */
export const STATUS_LABEL: Record<Status, string> = {
  todo: '待办', doing: '进行中', done: '已完成', later: '搁置', abandoned: '已放弃',
};

/**
 * 情境的中文名。**全站只此一份**——编辑表单的下拉、筛选栏那一维、人话预览、
 * 卡片上那个小记号、AI 建议里那句「情境改成 X」，读的都是这一份。理由跟上面
 * `STATUS_LABEL` 那段一模一样：文案抄第二份的那天起，两处就开始各自漂。
 *
 * 写成 `Record<TaskContext, string>`：`server/src/model.ts` 那个联合类型里
 * 加一档而这里没跟上，**编译就红**，不会安静地漏掉一档（`TaskBoard` 手抄的
 * 状态表漏掉「已放弃」正是这么来的）。
 */
export const CONTEXT_LABEL: Record<TaskContext, string> = {
  computer: '电脑前', out: '外出', home: '在家', contact: '联系人', easy: '省力',
};

/**
 * 下拉用的顺序。**不是 `Object.keys(CONTEXT_LABEL)`**：那份的顺序是写法的
 * 副产品，改一下字段位置就会悄悄换掉界面上的排序。这里的顺序是有意的——
 * 前四档按「人一天里待的地方」排（坐下来 → 出门 → 回家 → 找人），`easy`
 * 排最后，因为它答的是另一个问题（精力，见 model.ts 那条 ponytail 注释）。
 */
export const CONTEXTS: TaskContext[] = ['computer', 'out', 'home', 'contact', 'easy'];

/**
 * `x` 是数组就原样吐回去，不是就当空数组——`data/*.json` 是手改的，`?? []`
 * 只挡得住 null/undefined，挡不住手滑把方括号漏掉写成一个裸字符串。字符串没有
 * `.map`，直接崩会把整个 React 树带崩（这个仓库没有全局错误边界）。跟
 * `App.tsx` 的同名 helper 是同一个函数体，这里导出，App.tsx 改成从这儿引，
 * 别在两个文件里各存一份一模一样的判据。
 */
export function asArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

/**
 * 把一条任务上那五个数组字段补齐——**这是「磁盘上那份没人校验过」的收口处**。
 *
 * `GET /api/tasks` 是 `readAll` 的直通车：JSON.parse 之后直接当 `Task` 交出去，
 * 一次校验都没有（`upgradeTask` 只在一次性迁移时跑过）。手改文件时漏一个
 * `"tags": []`，类型上它还是 `Task`，运行时 `t.tags.length` 当场抛——而这个
 * 仓库没有全局错误边界，一条坏数据能白掉整页。
 *
 * 既有的做法是每个消费点各自 `asArray` 兜一次，于是漏一处就是一次白屏：实测
 * 卡片和行的标签那两行、`search.ts` 的全文匹配、`suggest.ts` 的推荐、批量
 * 加标签，五处都是裸的。**在入口补一次比在下游补一百次可靠**——下游还会长出
 * 新的消费点，入口只有这一个。
 *
 * 只补数组，不动别的字段：缺 `title` 是另一类问题（那条任务本来就没法显示），
 * 补一个空字符串等于把一条坏数据伪装成好的。
 */
export function normalizeTaskArrays<T extends object>(t: T): T {
  const raw = t as Record<string, unknown>;
  return {
    ...t,
    reminders: asArray(raw.reminders),
    subtasks: asArray(raw.subtasks),
    tags: asArray(raw.tags),
    attachments: asArray(raw.attachments),
    focusSessions: asArray(raw.focusSessions),
  };
}

/**
 * status 是否是三个合法值之一。文件是接口，手改或者 AI 手滑都能写出别的字符串。
 *
 * 用来做 `out[status]` 的索引收窄：直接用未经检查的字符串当 key 有个边角情况——
 * `Object.prototype.toString` 是真的存在且是函数，`out['toString']?.push` 不会
 * 因为 `?.` 短路掉，反而会在 `toString` 上调用 `.push` 炸出一个跟本意无关的报错。
 * 收窄成字面量之后，这条路径直接走不到。
 */
export function isStatus(s: unknown): s is Status {
  return STATUSES.includes(s as Status);
}

/**
 * 「人已经对这条做过判断了」——做完了 / 放弃了 / 暂时搁置。
 *
 * **这是这个界面上重复次数最多的一条判据**：过期标红、进不进「今天」、要不要
 * 提醒、进不进议程/四象限/推荐池、要不要推演未来的重复周期——七处各自内联写
 * 过一遍 `t.status === 'done' || t.status === 'later'`。加第四种「已放弃」的
 * 时候，七处里漏改任何一处都是一个静默的错：一条放弃了的任务照样标红、照样
 * 到点响。提成一个函数之后，加第五种状态只要改这一行。
 *
 * 服务端有一份同名的（`server/src/task.ts`）——两个包传不过来，跟 `STATUSES`
 * 是同一种没法消灭的重复，靠 `types.sync.test.ts` 盯着 `Status` 本身不飘。
 */
export const isSettled = (t: Task): boolean =>
  t.status === 'done' || t.status === 'later' || t.status === 'abandoned';

/**
 * 标签全集，从任务上现算，不建表——省掉「标签表和任务对不上」那一整类 bug。
 *
 * **住在这里，不在 `Sidebar.tsx`**（它原来是侧栏的一个导出）。读它的已经有
 * 侧栏、命令面板（`App.tsx`）、筛选栏，还有卡片 `⋯` 里那组「打标签」——一份
 * 谁都要用的算法挂在某个组件上，等于让别的组件为了算标签去 import 侧栏。
 * 也不放 `tagTree.ts`：那个模块整个不认识 `Task`，只做标签名的字符串活。
 * 两处标签全集的口径必须一致，见 task-4-brief。
 */
export const allTags = (tasks: Task[]): string[] =>
  [...new Set(tasks.flatMap((t) => asArray<string>(t.tags)))].sort();

/**
 * 展示用的过期判定：截止时间过了、而且还没做完。
 *
 * **这跟提醒判定不是一回事**，别把两者合并：提醒看的是 reminders 数组，
 * 判据在 server 的 reminder.ts，只有那一处。这里只管这张卡画不画成红的。
 *
 * `later`（搁置）跟 `done` 一样不算：搁置的意图是「暂时不想看见它」，红标
 * 加上 `bubbleOverdue`/`sortByUrgency` 的置顶，会把用户刚刚主动挪开的卡
 * 变成页面上最显眼的那张，跟意图正相反。「按来源」是档案、不藏东西——
 * 搁置的卡仍然显示在原来的分组里，只是不再被标红、不再被排到最前面。
 */
/**
 * 这条任务是不是「全天」——`Task` 没有 `allDay` 字段（那是另一批的事），唯一
 * 能用的信号是 `due` 的本地时/分/秒/毫秒全为 0。没有 `due` 或解析不了都算
 * 「不是全天」。
 *
 * **住在这儿而不是 `calendar.ts`**（原来在那边，`calendar.ts` 现在只转出去）：
 * 它是 `Task` 的语义，不是日历的画法。放在日历里的时候下面那个 `isOverdue`
 * 看不见它，两个模块对同一个值给出了两种答案——见 `isOverdue` 的注释。
 *
 * ponytail: 这是启发式，天花板很明确——真的想在当地零点做的任务会被误判成
 * 全天。救济路径是把它拖到任意一个非零点的小时格（哪怕 00:01）。等 `Task`
 * 真的加了 `allDay` 字段再换成读那个字段，不用再猜时刻。
 */
export function isAllDayIso(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/**
 * **只要这三个时间字段。** `Task` 满足它，编辑表单里的那份草稿（`TaskDraft`）
 * 也满足——「有没有时间段」「落在哪一刻」这两个判断对两者是同一个问题，
 * 收窄参数类型就能共用同一份实现，不用为草稿再写一遍。
 */
export interface Timed {
  due: string | null;
  startAt: string | null;
  endAt: string | null;
}

/**
 * 这条任务在日历上占不占一段高度——`startAt` 和 `endAt` 都在，而且 `endAt`
 * 真的晚于 `startAt`（滴答清单的「时间段」）。
 *
 * **`endAt <= startAt` 当成没有时间段**：那是一句自相矛盾的话，但校验器有意
 * 收下它（跟「开始晚于截止」同一条既有约定，见 `server/src/task.ts`）——照它
 * 画会得到一个负高度的块。
 *
 * 住在这个文件而不是 `calendar.ts`：`isAllDay` 要用它，而 `calendar.ts` 引这个
 * 文件、反过来不成立（会成环）。
 */
export function hasTimeBlock(t: Timed): boolean {
  const start = t.startAt ? Date.parse(t.startAt) : NaN;
  const end = t.endAt ? Date.parse(t.endAt) : NaN;
  return !Number.isNaN(start) && !Number.isNaN(end) && end > start;
}

/**
 * 「这一整天」——没有具体时刻的任务。
 *
 * **有时间段的一律不是全天**，哪怕 `due` 恰好是本地零点：一场九点到十二点的
 * 会占的是那三个小时，把它扔进全天那一条等于把唯一有用的信息（几点到几点）
 * 丢掉。这一条是加 `endAt` 时补的——在那之前这个函数只看 `due`。
 */
export const isAllDay = (t: Task): boolean => !hasTimeBlock(t) && isAllDayIso(t.due);

/**
 * 这个到期时刻过没过——**不看任务状态**，纯粹是「这个时刻算过期了吗」。
 *
 * 单独提出来是因为它有两个调用方：`isOverdue`（要先看状态）和 `dueChip`
 * （只拿到一个 ISO 字符串，没有任务）。`dueChip` 原来自己写 `t < now.getTime()`
 * ——同一条判据的第三份拷贝，而且是没跟上全天规则的那份：卡片上「过期」的
 * 红色标签（走 `isOverdue`）和到期 chip 自己的 `overdue` 会对同一条任务给出
 * 相反的答案。
 */
export function dueOverdue(due: string | null, now: Date): boolean {
  if (!due) return false;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return false;
  if (isAllDayIso(due)) {
    // 那一天的**结束**（= 第二天零点）过了才算过期。用 `getDate() + 1` 让
    // Date 自己处理月末/年末/夏令时，不做 +86400000 那种会在 DST 那天差一
    // 小时的算术。
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() <= now.getTime();
  }
  return t < now.getTime();
}

/**
 * 过期了没有。
 *
 * **全天任务按「天」比，不按「时刻」比**——本地零点在这个应用里的意思是
 * 「这一整天」（`isAllDay`，日历那半一直是这么用的），一整天的任务在那一天
 * 之内不算过期，过完那一天才算。
 *
 * 这一条是量出来才补上的：从「安排任务」栏把一条没日期的任务拖到今天那一格，
 * `due` 落在今天零点（全天），当天下午那张卡上同时写着「**过期 13 小时**」和
 * 「截止 今天 00:00」——日历按「整天」理解这个值，这里按「一个时刻」理解。
 * 服务端 `dailySummary.ts` 早就是按天比的（`localDay(due) < localDay(now)`），
 * 三处里网页这一处是分叉的那个。
 *
 * 定了具体钟点的照旧按时刻比：「今天 09:00 交表」下午一点就是过期了，
 * 「过期 4 小时」正是那时候该说的话。
 */
export function isOverdue(t: Task, now: Date): boolean {
  return !isSettled(t) && dueOverdue(t.due, now);
}

/**
 * 置顶的排前面。**所有排序的第一个比较键**，仿滴答清单的「置顶」。
 *
 * 提成一个函数、在每个比较器最前面 `||` 上去，不是在各处各写一遍
 * `Number(b.pinned) - Number(a.pinned)`——这个仓库已经证明过一次「同一条判据
 * 抄在四个地方，其中一个悄悄分叉」的形状（`isTaskOverdue` 那段注释）。
 *
 * `pinned` 缺失（手改文件、老数据）时 `Number(undefined)` 是 `NaN`，`NaN - NaN`
 * 还是 `NaN`，比较器返回 NaN 会被当成「相等」——正好是「都没置顶」该有的结果，
 * 但那是碰巧对。显式 `=== true` 收成布尔，不靠巧合。
 */
export const byPinned = (a: Task, b: Task): number =>
  Number(b.pinned === true) - Number(a.pinned === true);

/** 排序用的截止时间。没设或者格式坏掉的沉到最后。 */
const byWhen = (t: Task): number => {
  const due = t.due ? Date.parse(t.due) : NaN;
  return Number.isNaN(due) ? Number.MAX_SAFE_INTEGER : due;
};

/**
 * 过期置顶 → 截止时间升序 → 没期限的最后。两个键分开比，不要用「过期的返回
 * -Infinity」那种单键写法：两张都过期时 `-Infinity - (-Infinity)` 是 NaN，
 * 比较器返回 NaN 会被当成「相等」，于是最该先做的那几张之间完全不排序，
 * 顺序全看它们在文件里的先后。
 *
 * 「单独记的」那组任务彼此没有叙事顺序（不像同源任务有 AI 拆解出的先后步骤，
 * 那种顺序直接沿用 inbox.taskIds 数组本身的顺序，见 groupBySource），
 * 退回到按紧急程度排是唯一说得通的排法。
 */
export function sortByUrgency(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort((a, b) =>
    byPinned(a, b) || Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || byWhen(a) - byWhen(b));
}

/**
 * 过期置顶，但**不**像 `sortByUrgency` 那样把剩下的也按截止时间重排——同源组
 * 有 AI 拆解出的步骤顺序（taskIds 数组本身的顺序，见 groupBySource），那个
 * 顺序有意义（先做这条、它卡住了才轮到下一条），只有「过期」这一件事值得
 * 打破它。用在 TaskBoard 给同源组排序：过期的浮到组内最前面，没过期的几条
 * 之间维持原来的相对顺序（`Array.prototype.sort` 在现代引擎里是稳定排序，
 * 两个都不过期时比较器返回 0 就是「保持原样」，不是碰巧）。
 *
 * 「单独记的」那组没有这层顺序要保留，继续用 `sortByUrgency` 整个重排。
 */
export function bubbleOverdue(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort((a, b) => {
    // 置顶压过「同源组内的步骤顺序」：那个顺序是 AI 拆出来的，置顶是他自己
    // 按的——人的判断在这个界面里一律压过推断出来的东西。
    const pin = byPinned(a, b);
    if (pin !== 0) return pin;
    const aOver = isOverdue(a, now);
    const bOver = isOverdue(b, now);
    if (aOver && bOver) return byWhen(a) - byWhen(b);
    if (aOver !== bOver) return Number(bOver) - Number(aOver);
    return 0;
  });
}

export type StatusFilter = 'all' | Status;

/**
 * 「按来源」那条筛选条的档位：**「全部」+ 五个状态，顺序跟 `STATUSES` 一致**。
 * 值和顺序都从 `STATUSES` 拿，不手抄——`TaskBoard` 原来手抄的那份少了「已放弃」，
 * 那正是这份存在的理由，见 `STATUS_LABEL` 上面那段。
 */
export const STATUS_FILTERS: StatusFilter[] = ['all', ...STATUSES];

/** 上面那几档各叫什么。「全部」不是一个状态，单独加一条。 */
export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = { all: '全部', ...STATUS_LABEL };

export interface TaskGroup {
  /** null 表示这组任务没有来源收件箱条目：手工建的任务，或者来源条目被删了。 */
  source: InboxItem | null;
  tasks: Task[];
}

/**
 * 按「来自哪句话」分组——用 inbox[].taskIds 这条本来就存在的血缘关系，
 * 不是新发明一个字段。组的顺序按收件箱条目写下的时间升序：先写的笔记排前面，
 * 跟手稿翻页的顺序一致。
 *
 * 一个任务在所有 inbox 条目的 taskIds 里都找不到，就落进最后一组「单独记的」：
 * 这一条判据天然覆盖两种情况——手工建的任务（source: 'user'，从来没进过任何
 * taskIds）、和来源条目被删掉的任务（曾经在某个 taskIds 里，那条 inbox 记录
 * 现在已经不存在了，所以同样找不到）。不用额外去查 task.source 或者记一份
 * 「这条任务原来属于哪条」的旁路状态，删除操作本身已经让这条血缘线索消失，
 * 用「现在找不找得到」代替「记住它曾经在哪」，少一条要维护的状态。
 */
/** 排序用的 inbox 写下时间。缺失或解析不出来的沉到最后——跟 byWhen() 同一条教训：
 * NaN 参与比较恒为「相等」，混在中间的一条坏记录会让比较器对它牵扯到的每一对
 * 都判「相等」，结果排序不再是「按时间升序」，是这一版排序算法恰好怎么处理
 * 「相等」的实现细节。 */
const byCreated = (item: InboxItem): number => {
  const t = Date.parse(item.createdAt);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
};

export function groupBySource(tasks: Task[], inbox: InboxItem[]): TaskGroup[] {
  // id -> 共享这个 id 的所有任务。正常情况下每个 id 只对应一条，多存一层数组
  // 是为了扛住 id 撞车（手改文件、AI 手滑）：那种情况下 `Map<id, Task>` 会让
  // 后一条覆盖前一条，前一条从此在这个 Map 里找不到了。
  const byId = new Map<string, Task[]>();
  for (const t of tasks) {
    const bucket = byId.get(t.id);
    if (bucket) bucket.push(t);
    else byId.set(t.id, [t]);
  }
  // 记的是「用过的任务对象」本身，不是 id 字符串——两个不同的任务碰巧共享
  // 同一个 id 时，按 id 记会把没被任何 taskIds 提到的那一条也一起标记成
  // 「用过」，它就会同时从所有分组和 leftover 里消失，明明还在文件里，
  // 这比「同一个 id 被两条 taskIds 都提到、重复出现两次」严重得多。
  const used = new Set<Task>();
  const groups: TaskGroup[] = [];

  const sorted = [...inbox].sort((a, b) => byCreated(a) - byCreated(b));
  for (const item of sorted) {
    // taskIds 缺失或类型不对（比如手改文件漏了方括号，写成裸字符串）时兜底成
    // 空数组：跟 InboxSidebar 同一条教训，GET /api/inbox 不校验文件写入的数据，
    // 字符串没有 .map，不 guard 会把整个 React 树带崩。
    // 每个 id 只认领 byId 里还没被用过的那一条——同一个 id 被两条 taskIds
    // 都提到时，先写下的那条（sorted 已经按时间升序）先认领，后来的那条
    // 认领不到就跳过，不会重复出现两次。
    const groupTasks = asArray<string>(item.taskIds)
      .map((id) => byId.get(id)?.find((t) => !used.has(t)))
      .filter((t): t is Task => t !== undefined);
    if (groupTasks.length === 0) continue;
    for (const t of groupTasks) used.add(t);
    groups.push({ source: item, tasks: groupTasks });
  }

  const leftover = tasks.filter((t) => !used.has(t));
  if (leftover.length > 0) groups.push({ source: null, tasks: leftover });
  return groups;
}

/** 状态筛选：'all' 不筛，其余三个只留匹配的——未知 status 按 todo 处理，跟 isStatus 的兜底一致。 */
export function filterTasks(tasks: Task[], filter: StatusFilter): Task[] {
  if (filter === 'all') return tasks;
  return tasks.filter((t) => (isStatus(t.status) ? t.status : 'todo') === filter);
}

/** 顶部筛选按钮上的实时计数。 */
export function countByStatus(tasks: Task[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = { all: tasks.length, todo: 0, doing: 0, done: 0, later: 0, abandoned: 0 };
  for (const t of tasks) out[isStatus(t.status) ? t.status : 'todo']++;
  return out;
}

/**
 * 时间显示成本地时间，`YYYY-MM-DD HH:mm`——不用 `toLocaleString('zh-CN', …)`：
 * 那个输出斜杠、不补零、还带秒（`2026/8/16 18:00:00`），跟设计里别处的
 * `2026-08-16` 对不上，秒也是噪音（见 2026-08-12-ux-audit.md「时间戳带秒、
 * 用斜杠」）。手动拼、手动补零，格式不看运行环境的 ICU 实现怎么想。
 * 传进来的一律是 ISO 字符串，取的是本地时区（`Date` 的 getFullYear 等
 * getter 本身就是本地时区，不用另外转换）。
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// ── 「今天」视图 ──
// 见 已归档的 docs/superpowers/specs/2026-08-12-today-view.md。跟按来源分组是并列的
// 两个视图：那边回答「这条哪来的」，这边回答「我现在该干哪个」，顺序是人的
// 判断，不是自动算出来的。

/** 跟 `now` 是不是同一个本地日历日——按浏览器所在时区的年/月/日比较，不是
 * 「24 小时以内」这种滚动窗口。用户感觉里「今天」是日历上的今天，不是
 * 「还剩多少小时」，`due` 23:59 和明天 00:01 在直觉上是两天，这里也要是。 */
function isSameLocalDay(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const d = new Date(t);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/**
 * 最早的那个提醒时刻，没有就是 null。
 *
 * **数组是按时刻排好序的**（`lib/remindPreset.ts` 的 `setNthReminder` 存的时候
 * 就排过），所以第一条就是最早那条——「有没有一个已经过去的提醒」这个问题
 * 只看它就够。
 *
 * 这个注释以前写的是「这一版界面只做到一条提醒」——那已经不成立了，表单现在
 * 编辑得了任意多个。凡是「任意一个提醒满足某条件」的判断都不能再只看它，
 * 见下面 `hasReminderOn`。
 */
const firstReminderAt = (t: Task): string | null => t.reminders[0]?.at ?? null;

/**
 * **界面上该显示哪一个提醒**：还没到的里面最早的那个；全都过去了就显示最后
 * 那个（最近刚响过的那次）。没有提醒就是 null。
 *
 * 卡片和行档原来直接取 `reminders[0]`，也就是**最早**那个。一条任务只有一个
 * 提醒时这没区别；有好几个时它会一直显示那个早就响过的时刻，而人想知道的是
 * 「下一次什么时候响」——8/20 响过、8/25 还有一个，卡片却写着「提醒 8月20日」。
 */
export function displayReminderAt(t: Task, now: Date): string | null {
  const times = asArray<Reminder>(t.reminders)
    .map((r) => r?.at)
    .filter((at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at)));
  if (times.length === 0) return null;
  return times.find((at) => Date.parse(at) >= now.getTime()) ?? times[times.length - 1];
}

/**
 * **今天有没有哪个提醒**。不是「第一个提醒是不是今天」——一条任务可以有好几个
 * 提醒，而排在最前的是最早那个：8/20 设过一个、8/25 又设一个，到了 8/25 那天
 * 只看第一个会答「不是今天」，于是这条任务不因为「今天要提醒」进「今天」，
 * 而是靠 `isReminderOverdue` 那一支勉强留下来，卡片上还挂着一个「已过期」
 * ——今天真正要响的那一个反倒一个字都没提。
 */
const hasReminderOn = (t: Task, now: Date): boolean =>
  asArray<Reminder>(t.reminders).some((r) => isSameLocalDay(r?.at ?? null, now));

/**
 * 提醒在更早的一天已经触发过、任务还没做完。
 *
 * 跟 `isOverdue` 是两件不同的事——`isOverdue` 只看 `due`。存在的理由：一条
 * 任务只设了提醒、没设 `due`（卡片编辑器能清空 `due` 只留提醒时间），提醒
 * 当天会因为 `isSameLocalDay` 出现在「今天」，但过了那天，`isSameLocalDay`
 * 不再成立、`isOverdue` 因为没有 `due` 也恒为 false——这条任务会从「今天」
 * 默默消失，任何地方都不会再提示它还没做完。这里补上「提醒时间是更早某一天」
 * 这个分支：`isInTodayView` 用它维持成员资格，`TaskCard` 用它决定要不要也画
 * 「已过期」标签，让用户看得出这张卡是因为这个原因才留在「今天」的。
 */
export function isReminderOverdue(t: Task, now: Date): boolean {
  const remindAt = firstReminderAt(t);
  if (isSettled(t) || !remindAt) return false;
  const at = Date.parse(remindAt);
  return !Number.isNaN(at) && at < now.getTime() && !isSameLocalDay(remindAt, now);
}

/** 有一个**还没到**的截止时间。时刻解析不出来（坏数据）不算——见下面那段。 */
function dueUpcoming(due: string | null, now: Date): boolean {
  if (!due) return false;
  return !Number.isNaN(Date.parse(due)) && !dueOverdue(due, now);
}

/**
 * 「该关注了却没处理」的总判据——`isOverdue`（只看 `due`）跟
 * `isReminderOverdue`（补的是「只设了提醒、没设 due」那个分支）取一。
 * `TaskCard.tsx` 的红色「已过期」标签、下面 `countStale` 的计数原来都是
 * 各自内联写这个 OR，`TaskRow.tsx` 只抄了半句（只写了 `isOverdue`）——
 * 整分支审查 C2：只设了提醒、没设 `due` 的任务在行档上会一个记号都没有，
 * 却出现在底部「有 N 条已经过期了」的计数里。提成这一个函数，三处都调，
 * 不再各自维护一份可能悄悄分叉的 OR。
 *
 * ## 有截止时间的，**由截止时间说了算**
 *
 * 第一行那个闸门是补账补出来的，来自一次真实的困惑：一条任务
 * `due` 是今晚 21:00（没到），提醒有两个——昨天 10:00 那个已经响过、
 * 今天 15:00 那个还没到。卡片上显示的是「下一个还没到的」（`displayReminderAt`），
 * 一切正常；而 `isReminderOverdue` 取的是 `reminders[0]`（**最早**那个），
 * 于是「已过期」为真。**屏幕上一点红都没有，底下却写着「有 1 条已经过期了」**，
 * 而且改日期怎么改都消不掉——改的是 `due`，动不到提醒。
 *
 * 这一支的**本意**从一开始就写在 `TaskCard.tsx` 里：「补的是 remindAt 在更早一天
 * 已经触发过、**没有 due 兜底**」。只是代码从来没检查过「有没有 due 兜底」这半句。
 * 有截止时间的任务，提醒是**提前叫你去做那件事**的——它响过正是它该做的事，
 * 不该反过来把一条还没到期的任务标成过期。
 *
 * **只关这一支，不动 `isInTodayView`**（它自己直接调 `isReminderOverdue`）：
 * 那是另一个问题——一条昨天响过、还没处理的任务该不该浮到「今天」来，答案
 * 仍然是该。两个问题，两个答案。
 *
 * `due` 解析不出来时（手改文件写坏了）**不算「还没到」**，照旧走下面那条 OR：
 * 一个坏掉的字段不该有能力把提醒那一支静默关掉。
 */
export function isTaskOverdue(t: Task, now: Date): boolean {
  if (dueUpcoming(t.due, now)) return false;
  return isOverdue(t, now) || isReminderOverdue(t, now);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * 过期了多久，一句话。没过期返回 `null`。
 *
 * 补的是卡片上那个记号的一个空洞：它一直只写「已过期」——**欠了一小时和欠了
 * 三个星期长得一模一样**。而这个应用里那些一直没做完的任务恰恰是靠这个记号
 * 被看见的，「多久」正是决定先干哪个的那半句。滴答清单那边的做法是日期本身
 * 就写成「昨天」这种相对说法，同一个意思。
 *
 * 参照的时刻跟 `isTaskOverdue` 走同一条路：`due` 过了就看 `due`，否则看那条
 * 更早某天已经响过的提醒（只设提醒、没设 `due` 的任务）。`due` 还没到时
 * `isTaskOverdue` 直接是 false，这个函数第一行就回 `null`，走不到下面。
 * **那两支各自都已经
 * 解析过一次时刻**（`isOverdue`/`isReminderOverdue` 的 `Number.isNaN` 判断），
 * 所以下面那个 `已过期` 兜底照理走不到——留着是因为这两支的判据在别处，
 * 哪天它们放宽了，这里该退回一句最朴素的话，不是印一个 `NaN` 出来。
 *
 * 三档粒度：一小时内「刚过期」（写「过期 0 小时」是句废话），一天内报小时，
 * 再往上报天。天数按经过的毫秒整除，不按日历天：日历天要处理「昨天 23:00 到
 * 今天 01:00 算一天还是两小时」这种歧义，而经过时间没有歧义，也更能说明
 * 「欠了多久」。
 */
export function overdueLabel(t: Task, now: Date): string | null {
  if (!isTaskOverdue(t, now)) return null;
  const since = isOverdue(t, now) ? t.due : firstReminderAt(t);
  const at = since ? Date.parse(since) : NaN;
  if (Number.isNaN(at)) return '已过期';
  const ms = now.getTime() - at;
  if (ms < HOUR) return '刚过期';
  if (ms < DAY) return `过期 ${Math.floor(ms / HOUR)} 小时`;
  return `过期 ${Math.floor(ms / DAY)} 天`;
}

/**
 * **还没到开始时间**（OmniFocus 的 Defer Date，也就是 GTD 里那个「等到那天
 * 再说」；为什么不是滴答的「时间段」，见 `types.ts` 的 `startAt`）。没设开始
 * 时间、或者已经到了，都返回 false。
 *
 * 有了它，「现在还做不了」终于跟「暂时不想做」（搁置）分开了——在这之前
 * 只有后者，于是两种完全不同的意图挤在同一个状态里，「搁置」那一档因此
 * 变得说不清。
 *
 * **只看时刻本身，不看 `due`。** 「开始晚于截止」是一句自相矛盾的话，但
 * 校验器有意收下它（那是用户的话，见 server/src/task.ts）；这里也不替他
 * 解释——那条任务确实还没到能做的时候，同时确实已经欠着了，两个记号都
 * 该出现。
 */
export function notStarted(t: Task, now: Date): boolean {
  if (!t.startAt) return false;
  const at = Date.parse(t.startAt);
  return !Number.isNaN(at) && at > now.getTime();
}

/**
 * 「在等谁」这条**多久没动静了**——`null` = 没在等，或者才刚动过。
 *
 * GTD 的「等待清单」每周要过一遍，问的就是一句话：**这条该催了吗。** 而屏幕上
 * 只写「在等 张老师」，答不了这个问题——等了两天和等了三个星期长得一模一样，
 * 正是「已过期」那个记号当初踩过的同一个坑（`overdueLabel` 上面那段注释）。
 *
 * **口径是「多久没动静」，不是「等了多久」。** 这个应用没有记「从哪一刻开始
 * 等」（`waitingFor` 是个普通字段，改它不盖章），能拿到的只有 `updatedAt`
 * ——它的意思是「这条任务上一次被动过是什么时候」。所以文案照这个意思写：
 * 「12 天没动静」句句属实，而「等了 12 天」在他中途改过一次备注之后就是假话。
 *
 * **三天以下不说。** 等了一天很正常，标出来只是噪音；这个门槛跟「一拖再拖」
 * 那个 `POSTPONE_MIN` 一样是拍出来的，但方向是保守的：宁可晚一点提醒他去催，
 * 不要每条都挂一个数字。
 *
 * **只排掉做完的和放弃的，搁置的照说**（`isSettled` 会把搁置也算进去，这里
 * 不能用它）。「搁置 + 在等别人」恰恰是最需要知道等了多久的那个组合——做不了
 * 正是因为在等人，于是它被搁置；用 `isSettled` 挡掉的话，最该提醒去催的那些
 * 一条都不会显示。这条是实测撞出来的：夹具里唯一那条等待任务就是搁置的。
 */
export const WAITING_QUIET_DAYS = 3;
/** 搁置多久算「该回头看一眼了」。**比等待那个门槛大一个量级**：搁置本来就是
 *  「暂时不做」，三天没动静是它应有的样子；GTD 那边「将来也许」是按月过一遍
 *  的东西，30 天正是那个节奏。 */
export const PARKED_QUIET_DAYS = 30;

/**
 * 在回顾里点过「看过了」之后，多少天内不再拿这一条烦他。
 *
 * **7 天**：这一屏叫「这一周该过一遍的」，而 GTD 的回顾就是每周一次——
 * 两个说法碰到同一个数上，就不用再为它单独辩护。
 *
 * （这儿原来还写着第三条「OmniFocus 给新项目的默认复查间隔也是一周」。
 * **我们留的那份手册里查不到这个数**：《Settings》 的
 * 「By Default, Review Projects Every」只说「新项目建出来用这个值」，没给
 * 默认值。它可能碰巧是对的，但按这个仓库自己的规矩——改动前先去 `docs/`
 * 查一句原文——查不到的断言不该摆在这儿当论据。）
 *
 * 跟上面两个门槛不是一类东西，虽然长得像：那两个量的是「这条任务多久没动
 * 静了」（`updatedAt`，系统观察到的事实），这个量的是「他上一次亲自看过它
 * 是什么时候」（`reviewedAt`，他做的一个动作）。混用会出事——在回顾里点一下
 * 「看过了」会顺带更新 `updatedAt`，要是拿 `updatedAt` 当复查依据，这一下
 * 就同时把「等了 12 天」那个记号清零了，而他并没有去催谁。
 */
export const REVIEWED_QUIET_DAYS = 7;

/**
 * **他最近已经看过这一条了。** `reviewedAt` 是空的、解析不了、或者已经超过
 * `REVIEWED_QUIET_DAYS` 天，都返回 false。
 *
 * 这是 `reviewedAt` 唯一的判据出口——回顾清单上的数字和列表都问它，两处
 * 各写一遍就是两份可以各自改漏的口径，而这个仓库对「同一件事两个数字」
 * 最敏感。
 */
export function recentlyReviewed(t: Task, now: Date): boolean {
  const at = Date.parse(t.reviewedAt ?? '');
  if (Number.isNaN(at)) return false;
  return now.getTime() - at < REVIEWED_QUIET_DAYS * DAY;
}

/** 上一次被动过是多少天前。解析不了返回 null。两个记号共用这一步。 */
function daysQuiet(t: Task, now: Date): number | null {
  const at = Date.parse(t.updatedAt);
  if (Number.isNaN(at)) return null;
  return Math.floor((now.getTime() - at) / DAY);
}

export function waitingQuietLabel(t: Task, now: Date): string | null {
  if (!t.waitingFor || t.status === 'done' || t.status === 'abandoned') return null;
  const days = daysQuiet(t, now);
  return days !== null && days >= WAITING_QUIET_DAYS ? `${days} 天没动静` : null;
}

/**
 * 搁置了很久的那些——GTD 的「将来也许」，**不定期回头看就是个黑洞**。
 *
 * 这条补的正是那个黑洞：搁置的任务不进「今天」「接下来」「四象限」，也不进
 * 推荐面板（`lib/suggest.ts` 的 `isCandidate` 用 `isSettled`，而它把搁置算作
 * 「了结」）——它只在「全部」和看板那一列里混着，没有任何地方说过「这条你
 * 三个月前搁下的，还要吗」。
 *
 * 口径跟等待那条一样是「多久没动静」（`updatedAt`），理由也一样：这个应用
 * 没记「哪一刻搁下的」。**这个方向上它只会少说不会多说**——搁置那一下本身
 * 就会更新 `updatedAt`，所以真实的搁置时长只会比这个数更长。
 */
export function parkedQuietLabel(t: Task, now: Date): string | null {
  if (t.status !== 'later') return null;
  const days = daysQuiet(t, now);
  return days !== null && days >= PARKED_QUIET_DAYS ? `搁了 ${days} 天` : null;
}

/**
 * 有多少条任务「烂着」——已经过期、还没做完。
 *
 * 判据直接复用 `isTaskOverdue`，也就是卡片上那个红色「已过期」标签的条件，
 * 不另发明一个「躺了几天算久」的阈值：新造一个数字就要为它辩护，而这条
 * 判据已经是这个界面对「该关注却没处理」的既有定义了。
 *
 * 用来决定要不要提一句「可以让 AI 回顾一遍」——**只在真有东西可回顾的时候提**。
 * 看板空的时候提这句是荒谬的：没有任务，回顾什么。
 */
export function countStale(tasks: Task[], now: Date): number {
  return tasks.filter((t) => isTaskOverdue(t, now)).length;
}

/**
 * 「今天」视图的成员资格：已过期未完成的、今天要提醒的、今天截止的、
 * 提醒在更早一天已经触发过的、**今天开始的**，五者取一。`done`（做完了）和
 * `later`（人主动搁置的）一律不进——这两个都是人已经对这条任务做过判断了，
 * 不用再放在「该干哪个」的列表里烦他。
 *
 * ## 跟提醒有关的那两条（第二、第四）是这个应用自己加的
 *
 * 三份参照**没有一个**把提醒算进「今天」的成员资格：Things 明说判据是
 * 「if the **start date, deadline, or repeating rule** of any to-do matches
 * today's date」（《An In-Depth Look at Today, Upcoming, Anytime, and Someday》），
 * 滴答的「今天」按日期算，OmniFocus 的 Forecast 按 due 和
 * defer 排格子——提醒在那三家都只是一次通知，不改变这条任务属于哪一屏。
 *
 * 加进来的理由：**那三家的提醒都是可选的附属品，而这个应用的提醒是它的骨架**
 * ——AI 拆一句话出来，产出的就是「截止时间 + 提醒时间」，服务端有一整个
 * `reminder.ts` 按分钟扫、桌面端弹通知、还有「持续提醒」。一条今天会响的任务
 * 不出现在「今天」，等于这一屏和那次响各说各话；而「提醒响过了但没处理」
 * （第四条）正是最需要它出现在眼前的时刻。
 *
 * 代价写在这儿：一条没有截止时间、只设了提醒的任务会进「今天」，而按 Things
 * 的判据它不该进。这是有意的，不是漏了那三家的判据。
 *
 * ## 第五条（`startAt` 落在今天）是补的，补的是一个没兑现的承诺
 *
 * 在这之前，`startAt` 只在三个地方起作用：卡片上一个「9 月 1 日 开始」的记号、
 * 「接下来」里那一组默认折起来的「还没开始」、以及推荐面板把它们排除
 * （`suggest.ts`）。**三处全是「现在别烦我」那一半**，没有一处负责另一半。
 *
 * 后果是这个字段最关键的那一刻什么都不会发生：9 月 1 日到了，那条任务悄悄
 * 离开「还没开始」，落进「没有时间」那一组（没有 due 的话）——**一个还没
 * 开始的任务和一条随手记下的杂事，从此长得一模一样**。人当初设这个日期，
 * 要的就是「到那天再提醒我」，而系统只做了「在那之前藏起来」。
 *
 * 两份参考文档都把「到期那天自己冒出来」当成这个字段的**定义**：
 *
 * - Things（《An In-Depth Look at Today, Upcoming, Anytime, and Someday》）：
 *   「if the **start date**, deadline, or repeating rule of any to-do matches
 *   today's date, it shows up here」，以及那句更直白的
 *   「Come Saturday, it **hops into Today**, a gentle nudge of commitment」。
 * - OmniFocus（《Glossary》 的 Defer Date）：
 *   「The date and time that an item becomes **Available** for work…knowing that
 *   it will **return when it's ready for work**」，而 Forecast 那一屏正是按
 *   defer date 把它排到那一天的格子上。
 *
 * ## 为什么是「就今天这一天」，不是「已经开始了的都算」
 *
 * 后者会让「今天」变成一个只进不出的池子：三个月前设了开始时间、至今没做完
 * 又没有截止日期的任务，会永远赖在今天。Things 的说法是 **matches today's
 * date**——到期那天推你一下，第二天它就回到「随时可做」的那一堆里去。
 *
 * ## 跟「还没开始」不矛盾
 *
 * `startAt` 是个时刻，不是日期：今天 14:00 开始的任务，上午看它同时是
 * 「今天的事」和「还没到点」。两个记号都对，卡片上那个「14:00 开始」把后半句
 * 说完。按天算是有意的——人心里的「哪天开始做」就是一天，不是一个时刻。
 *
 * **改这里必须同时改 `server/src/dailySummary.ts` 的 `summaryTasks`**，
 * 两边的口径由 `todayParity.guard.test.ts` 逐条对账。
 */
export function isInTodayView(t: Task, now: Date): boolean {
  if (isSettled(t)) return false;
  return isOverdue(t, now) || hasReminderOn(t, now) || isSameLocalDay(t.due, now)
    || isReminderOverdue(t, now) || isSameLocalDay(t.startAt, now);
}

/**
 * 今天做完的那几条。给「今天」底下那一节用。
 *
 * 补的是这个应用里最高频那一步之后的空白：点完成，卡片当场从「今天」消失
 * （`isInTodayView` 第一行就把了结的挡在外面）。两个后果——**看不到自己今天
 * 做了什么**，一整天的成果不留痕迹；以及**点错了没有退路**，那张卡当场不见，
 * 想撤销得先想起来去「已完成」里翻。
 *
 * 只认 `done`，不含放弃的：这一节的名字是「今天完成的」，把放弃的算进来是在
 * 抬高那个数字。也只认**今天**完成的（本地日历天，按 `completedAt`）——
 * 昨天做完的属于历史，那是「已完成」那个去处的事。
 */
export function isDoneToday(t: Task, now: Date): boolean {
  return t.status === 'done' && isSameLocalDay(t.completedAt, now);
}

/**
 * 「今天」视图的排序：按 `order` 升序，`null`（还没被手动排过序）排在最后；
 * `null` 这一段内部退回 `sortByUrgency`（过期优先、再按截止时间升序）——
 * 一条任务在被用户碰过之前，不该随便摆，用回原来那套紧急度排法。
 *
 * `order` 相同的两条（比如手改文件、或者两个不同路径先后写入撞了同一个值）
 * 排序结果依然是确定的：先比 `createdAt`（更早创建的排前面），两者也相同
 * 就按 `id` 兜底——两个都是任务自带的稳定值，不受传入数组原始顺序影响。
 * `||` 在这里能生效是因为差值为 0（相等）或 `NaN`（解析失败）在 JS 里都是
 * falsy，会自然落到下一个比较项，跟这个文件里 `byWhen`/`byCreated` 那些
 * NaN 兜底是同一条教训。
 */
export function sortTodayOrder(tasks: Task[], now: Date): Task[] {
  const ordered = tasks.filter((t) => t.order !== null && t.order !== undefined);
  const unordered = tasks.filter((t) => t.order === null || t.order === undefined);
  ordered.sort((a, b) =>
    (a.order as number) - (b.order as number)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.id.localeCompare(b.id));
  // 置顶在**最后**才提上来，跨过「排过序的」和「没排过的」这条界线：不然一条
  // 置顶但没手动排过位置的任务会卡在所有手动排序之后，而置顶的意思就是
  // 「不管别的，先看这条」。手动排序本身在置顶组内部照样生效（sort 是稳定的）。
  const all = [...ordered, ...sortByUrgency(unordered, now)];
  return [...all.filter((t) => t.pinned === true), ...all.filter((t) => t.pinned !== true)];
}

/**
 * 把一条任务挪到指定下标——拖放用的。跟 `applyMove` 产出同一种东西
 * （整份可见列表的 id→order），落定规则也一样：一动就全部落定。
 *
 * 跟 `applyMove` 的区别只是「挪多远」：按钮一次换一格，拖放直接指定落点。
 * 两条路共用同一个提交通道（`TodayView` 的 `commit`），所以键盘和鼠标
 * 得到的结果完全一致，不会出现「拖出来的顺序」和「按出来的顺序」两套语义。
 *
 * `toIndex` 会被夹进 [0, length-1]。这不是防御性摆设：列表容器那层的放置
 * 处理（`TodayView`）在指针落在首行之上时传 0、否则传 `length - 1`，而
 * `applyMove` 复用这个函数时会传 `i ± 1`，越界的那一步靠夹取变成
 * `from === to`、进而返回 null，边界行为跟它原来自己判断时一致。
 * 落点跟原位置相同时返回 null，调用方不该发起任何写。
 */
export function moveTo(visible: Task[], id: string, toIndex: number): Array<{ id: string; order: number }> | null {
  const from = visible.findIndex((t) => t.id === id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(visible.length - 1, toIndex));
  if (from === to) return null;
  const next = [...visible];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((t, k) => ({ id: t.id, order: k }));
}

/**
 * 上/下移一格：在当前可见列表（已经按 `sortTodayOrder` 排好）里把 `id` 那条
 * 跟相邻一条互换位置，然后把**整份可见列表**重新编号成连续的 `0..n-1`。
 *
 * 「一移就全部落定」：不是只改被移动的那一条，是让整份可见列表从此都有
 * 显式的 `order`——半自动半手动的列表最难解释，规格里明确要避免这种状态。
 *
 * **实现上就是 `moveTo` 挪一格。** 原来这里另写了一遍交换 + 重新编号，
 * 跟 `moveTo` 一字不差地重复，还得靠一条「两者结果一致」的测试盯着它们别飘。
 * 越界那一步交给 `moveTo` 的夹取：`i ± 1` 出界会被夹成 `from === to`，
 * 而那本来就返回 null，跟原来自己判断边界的行为完全一样。
 *
 * 越界（已经在最前/最后）或者 `id` 不在列表里，返回 `null`：调用方不该
 * 发起任何写。正常情况下这条路径走不到，因为按钮本身在边界处会被禁用，
 * 这里只是把「什么都不做」这件事讲清楚，不是留了个静默失败的口子。
 */
export function applyMove(visible: Task[], id: string, direction: 'up' | 'down'): Array<{ id: string; order: number }> | null {
  const i = visible.findIndex((t) => t.id === id);
  if (i < 0) return null;
  return moveTo(visible, id, direction === 'up' ? i - 1 : i + 1);
}
