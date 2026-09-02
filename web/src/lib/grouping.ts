import type { List, Task } from '../types.js';
import { DUE_BUCKETS, dueBucketOf, endOfDay } from './agenda.js';
import { asArray, byPinned, isSettled, isStatus, STATUS_LABEL, STATUSES } from './taskView.js';
import { nestChildren } from './hierarchy.js';
import { reschedulePatch } from './reschedule.js';
import type { GridSection } from '../components/TaskGrid.js';

/**
 * 「分组」和「排序」——仿滴答清单的「分组排序」（它那边在每份清单右上角的
 * 「···」里）。**只作用在平铺列表那几个去处**（全部 / 已完成 / 搜索结果 /
 * 清单 / 标签），不碰另外几个：
 *
 * - 「今天」的顺序是他自己拖出来的，那就是内容本身，不能被一个下拉框打乱；
 * - 「接下来」已经按时间分好组了（`agenda.ts`），再套一层分组是两套语义打架；
 * - 看板 / 四象限 / 日历的格子本身就是分组轴，换轴是另一件事（滴答清单的
 *   看板确实能换分组轴，这里没做，见 README）。
 *
 * 存 `localStorage` 不进 `Settings`：跟 `density.ts` 同一类——「这台机器上我
 * 喜欢怎么看」，不是跟着同步盘跑到别的设备上的东西。
 */
export type GroupBy = 'none' | 'status' | 'list' | 'section' | 'priority' | 'due' | 'tag' | 'completed' | 'created' | 'updated';
export type SortBy = 'default' | 'due' | 'priority' | 'created' | 'updated' | 'estimate';

export interface GroupSort {
  groupBy: GroupBy;
  sortBy: SortBy;
  /** 倒序。**只翻转「有值的那些」之间的先后**，没有值的（没设截止时间）
   *  恒在最后——见 `compareBy`。 */
  desc: boolean;
}

export const GROUP_LABEL: Record<GroupBy, string> = {
  none: '不分组', status: '按状态', list: '按清单', section: '按分段', priority: '按优先级',
  due: '按时间', tag: '按标签', completed: '按完成时间', created: '按创建时间', updated: '按修改时间',
};

/** 看板那一排列可以按什么分。**`'none'` 不在里面**：一块只有一列的看板不是
 *  看板。默认 `'status'`——那是这个应用原来写死的四列，行为不变。 */
// `section` 也在里面：一块按分段分列的看板正好就是一个项目板（Things 的
// Headings 在项目里就是这个用法），而且往某一列里拖 = 把它归进那一段，
// 这个动作在看板上比在列表里自然。
export const KANBAN_AXES: Exclude<GroupBy, 'none'>[] = ['status', 'due', 'priority', 'list', 'section', 'tag'];
export type KanbanAxis = (typeof KANBAN_AXES)[number];
export const SORT_LABEL: Record<SortBy, string> = {
  default: '默认顺序', due: '按截止时间', priority: '按优先级', created: '按创建时间', updated: '按修改时间',
  // 「我现在只有二十分钟，能做点什么」——这个应用一直有 `estimateMinutes`
  // （编辑表单里填、卡片上「已专注 50 分钟 / 预计 45 分钟」、「今天」头上求和），
  // 却没有任何地方能按它排。**升序**（短的在前）正是上面那句话要的答案；
  // 想反过来找「今天最大那块石头」，勾上「倒序」就是。
  estimate: '按预计时长',
};

export const DEFAULT_GROUP_SORT: GroupSort = { groupBy: 'none', sortBy: 'default', desc: false };

const KEY = 'groupSort';

/**
 * **一个去处一份，不是全局一份**（仿滴答清单：排序方式是每个清单自己记住的）。
 *
 * 全局一份的时候，在「工作」里改成按优先级，翻到「购物」也变成按优先级——
 * 而这两份清单想要的顺序本来就不一样：一份要「最要紧的在最上面」，另一份要
 * 「我自己拖出来的那个顺序」。改一处等于改了所有地方，于是每换一个去处都要
 * 再改回来，这个下拉框反而变成了负担。
 *
 * 存的键就是**去处的 key**（`all` / `done` / `search` / `list:<id>` /
 * `tag:<名字>`），跟 `hashView.ts` 用的是同一个字符串——不另造一套 scope 命名，
 * 那样迟早会出现「两边对同一个去处的叫法不一样」。
 *
 * **没设过的去处一律回默认档，不继承别处**：继承的话「每个去处自己记住」
 * 这句话就是半真的，而半真的规则比没有规则更难预测。
 */
/**
 * **「默认」这件事是按去处算的，不是全局一份。**
 *
 * `VIEW_DEFAULT` 里「已完成」的默认是按完成时间分组，跟全局默认（不分组）不是
 * 一回事。原来这个判断只比全局默认，于是**一进「已完成」，「恢复默认」就亮着
 * ——而他什么都没改**（空实例上截图确认）；更糟的是点下去执行的是
 * `onChange(DEFAULT_GROUP_SORT)`，把分组从「按完成时间」改成「不分组」，
 * 那不是恢复，是把他带离这一屏的默认，而且 `setGroupSort` 会把这一下当成一条
 * 明确偏好存下来，下次进来还是那样。
 *
 * 判据挪到跟 `setGroupSort` 同一条（它下面那段注释早就写着「**用 VIEW_DEFAULT
 * 而不是全局默认**」）——同一个模块里对「默认」有两种算法，本来就是迟早分叉的
 * 形状。签名跟着带上 `view`：少一个参数就不可能算对，让类型把这件事钉死。
 */
export const viewDefaultGroupSort = (view: string): GroupSort =>
  VIEW_DEFAULT[view] ?? DEFAULT_GROUP_SORT;

export const isDefaultGroupSort = (view: string, v: GroupSort): boolean => {
  const mine = viewDefaultGroupSort(view);
  return v.groupBy === mine.groupBy && v.sortBy === mine.sortBy && v.desc === mine.desc;
};

const legacyOne = (v: Partial<GroupSort> | null | undefined): GroupSort => ({
  groupBy: v?.groupBy && v.groupBy in GROUP_LABEL ? v.groupBy : 'none',
  sortBy: v?.sortBy && v.sortBy in SORT_LABEL ? v.sortBy : 'default',
  desc: v?.desc === true,
});

/** 存下来的整张表。旧版本存的是**一个裸的 GroupSort**（全局一份），认出来之后
 *  归到 `all` 名下——那是默认落地的平铺去处，最可能是他当初改的那个。
 *  丢掉也只是少一份偏好，但「昨天设的东西今天没了」正是这个仓库反复躲的形状。 */
function readAll(): Record<string, GroupSort> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return {};
    // 裸的旧值：顶层直接带着 groupBy/sortBy/desc 里的任意一个。
    if ('groupBy' in v || 'sortBy' in v || 'desc' in v) {
      return { all: legacyOne(v as Partial<GroupSort>) };
    }
    const out: Record<string, GroupSort> = {};
    for (const [k, one] of Object.entries(v)) {
      if (typeof one === 'object' && one !== null) out[k] = legacyOne(one as Partial<GroupSort>);
    }
    return out;
  } catch {
    // 隐私模式/配额满会抛，JSON 坏了也会抛——当没存过处理，不炸调用方。
    // 跟 density.ts 的兜底同一条。
    return {};
  }
}

/**
 * 一个去处**没设过**时用哪一档。绝大多数是 `DEFAULT_GROUP_SORT`（不分组、
 * 维持各视图自己排好的顺序）。
 *
 * 「已完成」是例外：那个去处一直是一整条按时间倒序的流水，攒到几百条之后
 * 就是一堵墙，没有任何可以落脚的地方——而它每一条都有完成时间，「什么时候
 * 做完的」几乎是这份列表唯一有用的轴。默认按它分组，不是等人自己去下拉框里
 * 找出来：一个要先发现才有用的默认，对「墙」这个问题没有帮助。
 * 他改成别的照样记得住（改完就有自己的那一条记录了，见 setGroupSort）。
 */
const VIEW_DEFAULT: Record<string, GroupSort> = {
  done: { groupBy: 'completed', sortBy: 'default', desc: false },
};

/** 这个去处存的档。没设过、读不到、形状不对，一律回它自己的默认档。 */
export function getGroupSort(view: string): GroupSort {
  return readAll()[view] ?? viewDefaultGroupSort(view);
}

export function setGroupSort(view: string, v: GroupSort): void {
  try {
    const all = readAll();
    // 回到**这个去处自己的**默认档就把记录删掉，不存一份跟默认一模一样的
    // 记录——一个去处一份的表，不清理的话会随着「点进过的清单」无限长大，
    // 而里面多数是废话。**用 VIEW_DEFAULT 而不是全局默认**：在「已完成」里
    // 手动选回「不分组」，那跟它的默认（按完成时间）不一样，得存下来，
    // 不然下次进来又变回按完成时间——他刚明确改掉的那一下会被无视。
    const mine = viewDefaultGroupSort(view);
    if (v.groupBy === mine.groupBy && v.sortBy === mine.sortBy && v.desc === mine.desc) delete all[view];
    else all[view] = v;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* 存不进去就只在这个会话里有效，跟 density.ts 同一条 */ }
}

/**
 * 一个排序键。`null` = 这条没有这个值（没设截止时间、时间字符串坏掉）。
 *
 * **没有值的恒排最后，不参与 `desc` 翻转。** 倒序想看的是「最晚到期的排前面」，
 * 不是「一堆没有日期的先糊一屏」——`byWhen`（taskView.ts）用
 * `MAX_SAFE_INTEGER` 沉底是同一个意图，只是那边没有倒序这一档。
 */
type SortKey = (t: Task) => number | null;

const parseOr = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
};

const SORT_KEY: Record<Exclude<SortBy, 'default'>, SortKey> = {
  due: (t) => parseOr(t.due),
  // 优先级取负：这个字段是「越大越重要」，而所有比较器都按升序写，取负之后
  // 「升序」就是「高优先级在前」，跟另外三个时间键（越小越早、越早越前）
  // 语义对齐，不用在比较器里为它开一个特例分支。
  priority: (t) => -(t.priority ?? 0),
  created: (t) => parseOr(t.createdAt),
  updated: (t) => parseOr(t.updatedAt),
  // 没估过的返回 null，跟「没设截止时间」走同一条路：恒沉底、倒序也不上来
  // （见 `sortTasks` 里那三行 null 判断）。这正是想要的——「只有二十分钟」
  // 那一问，答案不该是一堆没人估过的任务。磁盘上手改坏的（字符串/负数/0）
  // 一律当没估过，跟 `lib/workload.ts` 同一条判据。
  estimate: (t) => {
    const m = t.estimateMinutes;
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null;
  },
};

function sortTasks(tasks: Task[], gs: GroupSort): Task[] {
  // 'default' 档不重排，但置顶还是要提上来——那一档的意思是「维持这个视图
  // 自己排好的顺序」，而各视图的排序器（`sortByUrgency` 等）本来就已经把
  // 置顶排在最前了，这里只是别把它打乱。
  if (gs.sortBy === 'default') return tasks;
  const key = SORT_KEY[gs.sortBy];
  const flip = gs.desc ? -1 : 1;
  // Array.prototype.sort 在现代引擎里是稳定排序：键相同的两条维持传进来的
  // 相对顺序，也就是这个视图自己排好的那个顺序，不会因为「都没设优先级」
  // 就变成随机的。
  return [...tasks].sort((a, b) => {
    // 置顶压过用户选的排序键：他按了「置顶」就是要它在最上面，选一个排序
    // 方式不该把这条决定推翻。判据跟别处共用同一个 `byPinned`。
    const pin = byPinned(a, b);
    if (pin !== 0) return pin;
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return (ka - kb) * flip;
  });
}

interface Bucket { key: string; title: string; tasks: Task[] }

/**
 * 时间分组。**分档本身不在这里写**——调 `agenda.ts` 的 `dueBucketOf`，跟「接下来」
 * 那一屏同一份实现。
 *
 * 这里原来是另外手写的一份六档，只共享了 `endOfDay`，靠一句注释（「同一套边界、
 * 同一批名字」）维持不变量——然后就真的飘了：「还没开始」那一组只加进了议程那一侧，
 * 于是同一条「9/1 才开始」的任务在「接下来」里归「还没开始」、在「全部」里归
 * 「没有时间」。一个界面里两套算法给出两种答案，这个仓库已经为它栽过一次（四象限
 * 那条「紧急边界」，见 smartFilter.ts）。
 *
 * 第四档为什么叫「7 天内」而不是「本周内」，见 `agenda.ts` 顶部。
 */
function dueBuckets(tasks: Task[], now: Date): Bucket[] {
  const out = new Map<string, Task[]>(DUE_BUCKETS.map((b) => [b.key, [] as Task[]]));
  for (const t of tasks) out.get(dueBucketOf(t, now))!.push(t);
  return DUE_BUCKETS.map(({ key, title }) => ({ key, title, tasks: out.get(key)! }));
}

/**
 * 按**完成时间**分桶（今天 / 昨天 / 7 天内 / 更早）。
 *
 * 「按时间」那一档分的是 `due`——对一份做完的清单来说那几乎没有意义：一件
 * 上周就该做、昨天才做完的事，按 due 分会落进「已过期」，而你想知道的是
 * 「昨天做完的」。已完成那个去处一直是一整条按时间倒序的流水，攒到几百条
 * 之后就是一堵墙，没有任何可以落脚的地方。
 *
 * **已了结、但没有 `completedAt` 的退到 `updatedAt`**，跟 `doneSections` 的排序
 * 用的是同一个退路（同一个理由：迁移过来的老任务没有这个字段；放弃的任务
 * 服务端根本不盖这个章，它的「最后一次动它」就是「什么时候放弃的」）。
 * 还没了结的**不套这个退路**，单独一组——见下面那段。
 */
function completedBuckets(tasks: Task[], now: Date): Bucket[] {
  // 边界跟 dueBuckets 一样按**本地日历天**算，不是「往前 24 小时」——
  // 人心里的「昨天」是日历上的昨天。
  const todayStart = endOfDay(now, -1);
  const yesterdayStart = endOfDay(now, -2);
  const weekStart = endOfDay(now, -8);
  const out: Record<string, Task[]> = { today: [], yesterday: [], week: [], older: [], unknown: [], open: [] };
  for (const t of tasks) {
    // **还没了结的单独一组**，不拿 `updatedAt` 顶上去充数：这个维度在别的
    // 去处（「全部」「某个清单」）也选得到，那里多数任务还没完成——按「最后
    // 动过的时间」分组、标题却写着「按完成时间」，是在说一件不成立的事。
    if (!isSettled(t)) { out.open.push(t); continue; }
    const at = parseOr(t.completedAt) ?? parseOr(t.updatedAt);
    if (at === null) { out.unknown.push(t); continue; }
    if (at > todayStart) out.today.push(t);
    else if (at > yesterdayStart) out.yesterday.push(t);
    else if (at > weekStart) out.week.push(t);
    else out.older.push(t);
  }
  return [
    { key: 'today', title: '今天', tasks: out.today },
    { key: 'yesterday', title: '昨天', tasks: out.yesterday },
    { key: 'week', title: '7 天内', tasks: out.week },
    { key: 'older', title: '更早', tasks: out.older },
    { key: 'unknown', title: '不知道什么时候', tasks: out.unknown },
    { key: 'open', title: '还没完成', tasks: out.open },
  ];
}

/**
 * 按**创建时间**分桶（今天 / 昨天 / 7 天内 / 更早）。
 *
 * 滴答清单把这一档单独标了「新增」，用途写得很具体：「整理刚添加到 Inbox 的
 * 任务；回顾近期记录的想法和事项」（《用分组和排序管理任务》）。
 * 那正是这个应用最本命的那一步——收件箱拆出来一批任务之后，「哪些是刚进来
 * 还没安排的」按别的轴都答不上：按时间分的是 `due`（新任务多半没有），按状态
 * 全在「待办」那一格。
 *
 * **桶的边界跟 `completedBuckets` 一字不差**（本地日历天，不是「往前 24 小时」）
 * ——同一个界面上两个「昨天」是这个仓库反复栽过的形状。
 *
 * 跟 `completedBuckets` 不一样的是**没有「还没完成」那一组**：每条任务都有
 * `createdAt`，这个维度对所有任务都成立，不像「完成时间」对没完成的任务
 * 是一句不成立的话。解析不出来的（手改文件）落 `unknown`，跟那边同一条。
 */
function createdBuckets(tasks: Task[], now: Date): Bucket[] {
  const todayStart = endOfDay(now, -1);
  const yesterdayStart = endOfDay(now, -2);
  const weekStart = endOfDay(now, -8);
  const out: Record<string, Task[]> = { today: [], yesterday: [], week: [], older: [], unknown: [] };
  for (const t of tasks) {
    const at = parseOr(t.createdAt);
    if (at === null) { out.unknown.push(t); continue; }
    if (at > todayStart) out.today.push(t);
    else if (at > yesterdayStart) out.yesterday.push(t);
    else if (at > weekStart) out.week.push(t);
    else out.older.push(t);
  }
  return [
    { key: 'today', title: '今天', tasks: out.today },
    { key: 'yesterday', title: '昨天', tasks: out.yesterday },
    { key: 'week', title: '7 天内', tasks: out.week },
    { key: 'older', title: '更早', tasks: out.older },
    { key: 'unknown', title: '不知道什么时候', tasks: out.unknown },
  ];
}

/**
 * 按**最后修改时间**分桶（今天 / 昨天 / 7 天内 / 更早）。
 *
 * 冲着「这个项目最近动了什么」来的：一个人手上同时有几十份清单时，真正要问的
 * 不是「这条什么时候建的」，而是「这周哪几摊有进展、哪几摊一个月没碰」。在
 * 「全部」里选这一档就是一条按天的更新流水，在某一份清单里选就是那个项目自己的。
 *
 * **桶的边界跟 `createdBuckets` / `completedBuckets` 一字不差**（本地日历天，
 * 不是「往前 24 小时」）——同一个界面上两个「昨天」是这个仓库反复栽过的形状。
 * 跟 `createdBuckets` 一样**没有「还没完成」那一组**：每条任务都有 `updatedAt`，
 * 这个维度对所有任务都成立。
 *
 * **它只记「最后一次」，不是完整历史。** 一条上周改过、今天又改的任务只出现在
 * 「今天」，上周那次不留痕。这一档回答的是「最近动了什么」；要「某个字段什么
 * 时候从什么变成什么」得另建事件日志，不是这里能顺带给的——不写明这一句，这个
 * 分组看起来像在承诺一份它给不出的变更史。
 *
 * 信号干净这件事是查过写盘路径的，不是假设：
 * - `updatedAt` 只在 `server/src/mutate.ts` 一处盖章（那儿注释写着「该盖的章
 *   只该有一处实现」），重排还要 `order` 真的变了才盖；
 * - 提醒响了只写 `reminders[].firedAt`（`server/src/reminder.ts` 那次 `writeTasks`
 *   不碰 `updatedAt`），一夜的提醒不会让任务假装被动过；
 * - 重复任务的下一实例由「人点完成」触发（`mutate.ts` 里 `prevStatus !== 'done'
 *   && next.status === 'done'` 那一支），不是定时器每天自动滚。
 * 所以落进这些桶里的每一条，都对应一次真实的人为动作或 AI 拆解落地。
 */
function updatedBuckets(tasks: Task[], now: Date): Bucket[] {
  const todayStart = endOfDay(now, -1);
  const yesterdayStart = endOfDay(now, -2);
  const weekStart = endOfDay(now, -8);
  const out: Record<string, Task[]> = { today: [], yesterday: [], week: [], older: [], unknown: [] };
  for (const t of tasks) {
    const at = parseOr(t.updatedAt);
    if (at === null) { out.unknown.push(t); continue; }
    if (at > todayStart) out.today.push(t);
    else if (at > yesterdayStart) out.yesterday.push(t);
    else if (at > weekStart) out.week.push(t);
    else out.older.push(t);
  }
  return [
    { key: 'today', title: '今天', tasks: out.today },
    { key: 'yesterday', title: '昨天', tasks: out.yesterday },
    { key: 'week', title: '7 天内', tasks: out.week },
    { key: 'older', title: '更早', tasks: out.older },
    { key: 'unknown', title: '不知道什么时候', tasks: out.unknown },
  ];
}

/**
 * 按**分段**分桶（`Task.section`，仿滴答清单的「分组」/ Things 的 Headings）。
 *
 * **顺序按第一次出现**，不是字典序：分段名多半带着次序（「第一阶段」「第二
 * 阶段」），而中文的字典序不认数字——`localeCompare` 会把「第一/第二/第三」
 * 排成一个跟人心里完全不同的顺序。按第一次出现走，等于跟着这一屏当下的排序
 * （手拖的顺序、按时间、按优先级……）自然摆出来，跟 Things 里 heading 的位置
 * 由它下面第一条任务决定是同一个道理。
 *
 * 「不在任何分段」排在**最后**，跟 `listBuckets`/`tagBuckets` 对「没有」那一
 * 档的处理一字不差。Things 那边这一堆是浮在最前的，这里不跟——那两条既有的
 * 分组轴已经定了这个仓库的习惯，为第三条破例只会让三条各说各的。
 */
function sectionBuckets(tasks: Task[]): Bucket[] {
  const order: string[] = [];
  const of = new Map<string, Task[]>();
  const loose: Task[] = [];
  for (const t of tasks) {
    const name = typeof t.section === 'string' && t.section.trim() !== '' ? t.section : null;
    if (name === null) { loose.push(t); continue; }
    const bucket = of.get(name);
    if (bucket) bucket.push(t);
    else { of.set(name, [t]); order.push(name); }
  }
  const buckets: Bucket[] = order.map((n) => ({ key: `s:${n}`, title: n, tasks: of.get(n)! }));
  buckets.push({ key: 's:none', title: '不在任何分段', tasks: loose });
  return buckets;
}

/**
 * 现有的分段名，给编辑表单里那个自由输入框当候选。
 *
 * **这是「已有哪些分段」在这个仓库里唯一的一份实现**——`sectionBuckets` 分桶
 * 时也要回答同一个问题，两处各扫一遍的后果是「分组里有这一段、下拉里没有」。
 *
 * **不按清单过滤**：段名只在它所属的那份清单里有意义，但这一份是**候选**不是
 * 约束——新建任务时清单可能还没选，而在别的清单用过的名字正是他最可能想复用
 * 的。给多了他不选就是了；给少了他就得重打一遍，而打错一个字就是凭空多一段
 * ——那正是「存名字不建表」这个决定唯一真正的风险，这份候选是挡它的那道防线。
 *
 * 顺序按第一次出现，跟 `sectionBuckets` 一致。
 */
export function sectionNames(all: Task[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of all) {
    const n = typeof t.section === 'string' ? t.section.trim() : '';
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 状态分组的桶。**值、顺序、文案全部从 `taskView.ts` 拿**——`STATUSES` 给顺序，
 *  `STATUS_LABEL` 给中文名，这个文件上面就 import 了它们，一个字都不在这儿抄。
 *  （早先这儿抄过一份写死的四个状态，「已放弃」加进来时没跟上；`cells.ts` 的
 *  `QUADRANT_TITLE` 是另一类——那四格是这个应用自己定义的，没有别处的正本。） */
function statusBuckets(tasks: Task[]): Bucket[] {
  // status 不是四选一之一（手改文件、AI 手滑）的落 todo，不能凭空吃掉——
  // 卡片上另有「状态异常」标签负责说清这件事，跟 cells.ts 的 kanbanCells
  // 同一条兜底。
  return STATUSES.map((st) => ({
    key: `s:${st}`,
    title: STATUS_LABEL[st],
    tasks: tasks.filter((t) => (isStatus(t.status) ? t.status : 'todo') === st),
  }));
}

const PRI_TITLE: Record<number, string> = { 3: '高优先级', 2: '中优先级', 1: '低优先级', 0: '没有优先级' };

function priorityBuckets(tasks: Task[]): Bucket[] {
  return [3, 2, 1, 0].map((p) => ({
    key: `p${p}`,
    title: PRI_TITLE[p],
    // 手改文件写出 priority: 7 这种越界值时归进「没有优先级」，不另开一档：
    // `GET /api/tasks` 不校验文件里的东西（这个仓库到处是这条兜底）。
    tasks: tasks.filter((t) => ([0, 1, 2, 3] as number[]).includes(t.priority) ? t.priority === p : p === 0),
  }));
}

function listBuckets(tasks: Task[], lists: List[]): Bucket[] {
  // 只有真的有任务落进来的清单才成组——把全部清单都摆出来（哪怕空的）会让
  // 一个建了二十份清单的看板变成二十个空标题。空组 TaskGrid 自己也会滤掉，
  // 这里先滤一道只是少造对象。
  const normal = [...lists].filter((l) => l.filter === null).sort((a, b) => a.order - b.order);
  const buckets: Bucket[] = normal.map((l) => ({
    key: `l:${l.id}`, title: l.name, tasks: tasks.filter((t) => t.listId === l.id),
  }));
  const known = new Set(normal.map((l) => l.id));
  // listId 指向一个已经不存在的清单（删掉了、或者智能清单的 id）也归这儿：
  // 「不属于任何清单」在界面上的含义就是「导航里点不到它的归属」，跟
  // listId 字段里到底写着什么无关。
  buckets.push({ key: 'l:none', title: '不属于任何清单', tasks: tasks.filter((t) => !t.listId || !known.has(t.listId)) });
  return buckets;
}

function tagBuckets(tasks: Task[]): Bucket[] {
  // **一条任务只进第一个标签的组，不复制到每个标签下。** 复制的话同一张卡
  // 会在一屏里出现两次——批量选中会算两遍、拖拽排序两个位置指同一条，
  // 而 React 的 key 也会撞（`GridSection.tasks` 最终按 task.id 渲染）。
  // 滴答清单那边一条任务确实会出现在每个标签清单里，但那是「点进某个标签」
  // 的场景，跟「在一屏里按标签分组」不是一回事。
  const first = (t: Task): string | null => asArray<string>(t.tags)[0] ?? null;
  const names = [...new Set(tasks.map(first).filter((x): x is string => x !== null))].sort((a, b) => a.localeCompare(b, 'zh'));
  const buckets: Bucket[] = names.map((n) => ({ key: `t:${n}`, title: `#${n}`, tasks: tasks.filter((t) => first(t) === n) }));
  buckets.push({ key: 't:none', title: '没有标签', tasks: tasks.filter((t) => first(t) === null) });
  return buckets;
}

export interface GroupCtx {
  lists: List[];
  now: Date;
  /** 空组也返回。只有看板要（能往空列里拖），平铺列表不要（一排空标题）。 */
  keepEmpty?: boolean;
}

/**
 * 把一张卡拖进某个格子，该改哪个字段。返回 `null` = **这个格子没有对应的
 * 值可写**，调用方不该发任何请求。
 *
 * 有三个格子天生没有对应值，这不是漏了：
 * - 按时间分组的「已过期」——没有「把它设成过期」这个动作；
 * - 「7 天内」「以后」——一个范围对不出一个具体日期，替他挑一天是编的；
 * - 按标签分组的「没有标签」——落进去要清掉全部标签，那是删数据，
 *   不该由一次拖拽触发。
 *
 * 四象限的横轴早就是同一个形状（`priorityOfQuadrant` 返回 null 时不发 PATCH，
 * 见 `cells.ts`），这里沿用那条既有约定，不新发明一种「拖了没反应」的语义。
 */
export function cellPatch(groupBy: GroupBy, cellKey: string, t: Task, now: Date): Partial<Task> | null {
  // 组的 key 统一带 `g:` 前缀（见 regroupSections），先剥掉。
  const key = cellKey.startsWith('g:') ? cellKey.slice(2) : cellKey;
  if (groupBy === 'status') {
    const st = key.slice(2);
    return isStatus(st) ? { status: st } : null;
  }
  if (groupBy === 'priority') {
    const p = Number(key.slice(1));
    return [0, 1, 2, 3].includes(p) ? { priority: p as Task['priority'] } : null;
  }
  if (groupBy === 'list') {
    const id = key.slice(2);
    return { listId: id === 'none' ? null : id };
  }
  if (groupBy === 'section') {
    const name = key.slice(2);
    // 拖进「不在任何分段」= 把它从分段里摘出来。**这一条跟标签那边相反**
    // （那边落进「没有标签」返回 null，因为要清掉的是一整个数组、那是删数据）：
    // 分段只有一个值，摘出来是「不属于任何一段」这句话本身，不是删掉什么。
    return { section: name === 'none' ? null : name };
  }
  if (groupBy === 'tag') {
    const name = key.slice(2);
    if (name === 'none') return null;
    // 加上去，不是换掉——一条任务可以有好几个标签，拖进「#工作」不该把
    // 「#紧急」抹掉。已经有了就什么都不用做（返回 null，不发空 PATCH）。
    return asArray<string>(t.tags).includes(name) ? null : { tags: [...asArray<string>(t.tags), name] };
  }
  if (groupBy === 'due') {
    if (key === 'none') return { due: null };
    if (key === 'today' || key === 'tomorrow') {
      // 走跟卡片「改期」菜单同一个纯函数：原来几点还是几点、提醒跟着平移。
      // 不在这里另写一份「怎么算今天」。
      return reschedulePatch(t, key, now);
    }
    return null;
  }
  return null;
}

/**
 * 把视图自己算好的那几组**重新分组、重新排序**。
 *
 * 接的是 `GridSection[]` 而不是 `Task[]`：每个视图对「哪些任务该出现」有自己
 * 的判据（「全部」排除已完成、清单页分未完成/已完成两组、搜索结果只有命中的
 * 那些），那一步不该被这个模块重做一遍——它只负责「已经定下来要显示的这些，
 * 怎么摆」。
 *
 * **`groupBy: 'none'` 时保留视图原来的分组**，只在组内排序：清单页那两组
 * 「未完成 / 已完成」是这个视图的结构，不该因为选了「按截止时间排序」就被
 * 拍平成一坨。
 */
export function regroupSections(sections: GridSection[], gs: GroupSort, ctx: GroupCtx): GridSection[] {
  if (gs.groupBy === 'none') {
    // 'default' 档整份原样交回去（视图自己已经排好、也已经把子任务挪到父亲
    // 后面了）；换了排序档就要重排，重排会把父子拆开，所以排完再挪一次。
    return gs.sortBy === 'default'
      ? sections
      : sections.map((s) => ({ ...s, tasks: nestChildren(sortTasks(s.tasks, gs)) }));
  }
  // 拍平：分组轴换了，原来的组标题就不再成立。顺序沿用拍平前的先后，
  // 'default' 排序档靠它维持「视图本来的顺序」。
  const all = sections.flatMap((s) => s.tasks);
  const buckets = gs.groupBy === 'due' ? dueBuckets(all, ctx.now)
    : gs.groupBy === 'section' ? sectionBuckets(all)
      : gs.groupBy === 'created' ? createdBuckets(all, ctx.now)
        : gs.groupBy === 'updated' ? updatedBuckets(all, ctx.now)
        : gs.groupBy === 'completed' ? completedBuckets(all, ctx.now)
          : gs.groupBy === 'priority' ? priorityBuckets(all)
            : gs.groupBy === 'status' ? statusBuckets(all)
              : gs.groupBy === 'list' ? listBuckets(all, ctx.lists)
                : tagBuckets(all);
  // 空组直接不返回。TaskGrid 自己也会滤（见那边的契约注释），这里滤掉是为了
  // 让「N / M 条」那两个数字不受空组影响，也少造一批对象。
  // **看板例外**（`keepEmpty`）：那边要能往空列里拖，一列没卡就把整列藏起来
  // 等于把落点也一起藏了。
  return buckets
    .filter((b) => ctx.keepEmpty || b.tasks.length > 0)
    .map((b) => ({ key: `g:${b.key}`, title: b.title, tasks: nestChildren(sortTasks(b.tasks, gs)) }));
}

const AXIS_KEY = 'kanbanAxis';

/** 看板的分组轴。**跟 `groupSort` 分开存**：在「全部」里选了「按标签」不该
 *  顺手把看板的四列也换掉——那是两个视图各自的摆法，共用一份 state 会让
 *  改一个动两个。读不到/不认识一律回 `'status'`（原来写死的四列）。 */
export function getKanbanAxis(): KanbanAxis {
  try {
    const v = localStorage.getItem(AXIS_KEY);
    return (KANBAN_AXES as string[]).includes(v ?? '') ? (v as KanbanAxis) : 'status';
  } catch {
    return 'status';
  }
}

export function setKanbanAxis(v: KanbanAxis): void {
  try { localStorage.setItem(AXIS_KEY, v); } catch { /* 同 density.ts */ }
}
