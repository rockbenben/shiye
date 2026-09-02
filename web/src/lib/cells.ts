import type { GridSection } from '../components/TaskGrid.js';
import type { Task } from '../types.js';
// 文案跟「值+顺序」一样从 taskView 的单一出处拿。这儿原来抄了一份一模一样的
// 五个字符串，注释还写着「跟着抄一份是既有做法」——而抄漏的那一份（TaskBoard
// 的筛选条少了「已放弃」）就是那句话的代价，见 taskView.ts 里 STATUS_LABEL
// 上面那段。
import { isSettled, isStatus, sortByUrgency, STATUS_LABEL, STATUSES } from './taskView.js';
import { notStartedDeep } from './hierarchy.js';
// `URGENT_WITHIN_DAYS` 原来定义在这个文件里。搬去 `agenda.ts` 了——行/卡上
// 那颗「快到期」的 chip 用的是同一条边界，而「N 天内算急」跟四象限没有特殊
// 关系，不该住在它的文件里。**再导出一次**：这个文件的既有消费方（测试、
// 别处的注释引用）不必跟着改 import，而它仍然只有一份定义。
import { endOfDay, URGENT_WITHIN_DAYS } from './agenda.js';
export { URGENT_WITHIN_DAYS };
import { DEFAULT_QUADRANT_RULE, type QuadrantRule } from './quadrantRule.js';

/**
 * 看板的四列，顺序固定：待办 / 进行中 / 已完成 / 搁置。key 就是 `Status` 的值。
 *
 * **空列也在返回值里**——看板要能往空列里拖，不能因为暂时没有卡就把整列
 * 藏起来（那是 `TaskGrid` 默认行为的事，这里的责任只是产出完整的四列）。
 *
 * `status` 不是四选一之一（服务端不校验文件里写的东西，手改或者 AI 手滑都
 * 能写出别的字符串）的任务落进 `todo` 列，不能凭空吃掉——卡片上另有「状态
 * 异常」标签负责说清这件事。
 *
 * **列内按紧急度排**（`sortByUrgency`：置顶的最前，然后过期的，再按时间）。
 * 在这之前每一列是**服务端读目录的顺序**——`readdirSync().sort()`，文件名是
 * uuid，也就是**随机**。别的每一个列表面都排过序（「全部」「接下来」「清单」
 * 都是 sortByUrgency，「今天」是他自己拖的顺序），唯独看板和四象限没有；
 * 而 `byPinned` 那句注释写着「**所有排序的第一个比较键**」，在这两个视图里
 * 一直不成立——置顶的卡压根不浮上来。
 *
 * 排序不会跟手动顺序打架：看板**没有列内拖拽排序**（`TaskGrid` 的
 * `handleDragEnd` 在 `from === to` 时直接 return），没有「他自己排的顺序」
 * 可以被覆盖掉。
 */
export function kanbanCells(tasks: Task[], now: Date): GridSection[] {
  const bins = new Map(STATUSES.map((s) => [s, [] as Task[]]));
  for (const t of tasks) {
    const key = isStatus(t.status) ? t.status : 'todo';
    bins.get(key)!.push(t);
  }
  return STATUSES.map((key) => ({ key, title: STATUS_LABEL[key], tasks: sortByUrgency(bins.get(key)!, now) }));
}

/**
 * 四象限边界：`URGENT_WITHIN_DAYS` 天后那一天的 23:59:59.999——**整日边界**，
 * 不是「往后推 N 天的同一时刻」。直接复用 `agenda.ts` 的 `endOfDay`（「接下来」
 * 视图的 `todayEnd`/`tomorrowEnd`/`weekEnd` 都走它），不要在这个文件里再写
 * 一遍 `setHours(23,59,59,999)`——同一个界面里两套「N 天内」算法、给出两种
 * 不一致的判断，是没人会想到去比对的那种缺陷。
 *
 * 「3 天内到期」在人的直觉里是「3 天后那一天之内」，不是「3 天后那一刻之前」：
 * `now` 是 8/16 12:00、`due` 是 8/19 23:00（三天后的深夜）该算紧急，用同一
 * 时刻语义的话它会被误判成「不急」——那是这条注释存在之前的版本踩过的坑，
 * 见 `cells.test.ts` 里「三天后深夜也算紧急」那条。
 */
function urgentBoundary(now: Date): number {
  return endOfDay(now, URGENT_WITHIN_DAYS);
}

/** `due` 落在 `[负无穷, boundary]` 里就算紧急——已过期（`due` 在过去）也算，
 *  不是「已经来不及所以不急了」。解析不了或者没有 `due` 一律当成不紧急。 */
function isUrgent(due: string | null, boundary: number): boolean {
  if (!due) return false;
  const t = Date.parse(due);
  return !Number.isNaN(t) && t <= boundary;
}

const QUADRANT_KEYS = ['imp-urg', 'imp-later', 'min-urg', 'min-later'] as const;
type QuadrantKey = (typeof QUADRANT_KEYS)[number];

/**
 * 每一格对应哪一档 `priority`——**这一份是 `priority` 那套规则**：四格就是
 * 四档优先级（高/中/低/无），`due` 完全不参与。
 *
 * 滴答清单内置**两套**规则，这个应用现在两套都有（`QuadrantRule`），
 * 出处都在《如何编辑四象限规则》：
 *
 * - `priority`（默认，= 滴答的「规则组合1」）：「4种优先级，对应4个象限」，
 *   而且「拖动调整任务的象限时，任务的优先级也会发生对应的变化」——跟
 *   `priorityOfQuadrant` 是同一件事。滴答给它的定位是「适合刚入门的新用户」。
 * - `time-priority`（= 滴答的「规则组合2」）：「优先级代表『重要程度』，
 *   时间代表『紧急程度』」，也就是真的二维坐标系——行 = `priority >= 2`，
 *   列 = `due` 在 `URGENT_WITHIN_DAYS` 天内（`QUADRANT_PRIORITY_2D`）。
 *
 * **这里曾经只有第一套，注释还写着「换掉是明确要求向滴答靠齐」**——那句话
 * 方向反了：被删掉的那个二维模型正是滴答的第二套。准确说法是「在滴答的两套
 * 预设里选了给新手的那一套」。现在两套都在，他自己选。
 *
 * **跟滴答还差一处，是有意留的差**：滴答在组合2 下拖动会**连时间一起改**
 * （「拖动任务调整任务的象限时，任务的时间和优先级也会发生对应的变化」）。
 * 这里的横轴是只读的，拖了不改 `due`。理由：往「不紧急」那一列拖的时候，
 * 没有任何一个「对」的日期可以填——清空 `due` 是丢信息，随手推一个日期是
 * 替他做决定，而这两件事都发生在一次拖拽里、没有确认、事后看不出来。
 * 想改期有日历和卡片上的日期选择器，那两条路都是明说的。
 */
const QUADRANT_PRIORITY = new Map<QuadrantKey, number>([
  ['imp-urg', 3],
  ['imp-later', 2],
  ['min-urg', 1],
  ['min-later', 0],
]);

/**
 * `time-priority` 规则下每一格对应的 `priority`：**只有行有意义**——重要 = 2、
 * 不重要 = 0，同一行的两格是同一个值，因为横轴是按 `due` 算出来的只读坐标。
 *
 * 同一行两格同值这件事有个后果，调用方必须处理：`TaskGrid` 那道
 * `from !== s.key` 守卫只挡「拖回同一格」，挡不住「拖到同一行的另一格」，
 * 而那种拖动不该发 PATCH。见 `App.tsx` 里 `fromCell` 那两行。
 */
const QUADRANT_PRIORITY_2D = new Map<QuadrantKey, number>([
  ['imp-urg', 2],
  ['imp-later', 2],
  ['min-urg', 0],
  ['min-later', 0],
]);

/** 反过来：一档优先级落在哪一格。`priority` 不是 0..3 之一时（服务端不校验
 *  文件里写的东西，手改或者 AI 手滑都能写出别的数）落进「不重要也不紧急」，
 *  跟 `kanbanCells` 对不合法 `status` 的兜底同一条：不能凭空吃掉一条任务。 */
const QUADRANT_OF_PRIORITY = new Map<number, QuadrantKey>(
  [...QUADRANT_PRIORITY].map(([k, v]) => [v, k]),
);

const QUADRANT_TITLE: Record<QuadrantKey, string> = {
  'imp-urg': '重要且紧急',
  'imp-later': '重要不紧急',
  'min-urg': '不重要但紧急',
  'min-later': '不重要也不紧急',
};

/**
 * 四象限的四格，key 固定为 `'imp-urg' | 'imp-later' | 'min-urg' | 'min-later'`。
 *
 * **四格 = 四档优先级**（高/中/低/无），判据和出处都在 `QUADRANT_PRIORITY`
 * 那段注释里。`due` 不参与分格——所以一条三天后到期的低优先级任务
 * 待在「不重要但紧急」这一格里是对的：那一格的含义是「低优先级」，格子的
 * 名字沿用艾森豪威尔那套叫法。**空格子也在返回值里**：四个格子是一个坐标系，
 * 缺一个这个坐标系就不成立。
 *
 * 已完成/已搁置/**还没到开始时间**的任务不参与——四象限回答的是「接下来做
 * 什么」，这三种都是他已经明确做过的决定（做完了 / 现在不做 / 那天之前别管它），
 * 跟 `isInTodayView` 那族判据同一条口径。它们不会因此消失，看板、「全部」、
 * 「接下来」里都还在，只是不该被摆进四象限的坐标格——那等于替他推翻自己刚做
 * 的决定。
 *
 * **`notStarted` 那一支是后加的**，加的理由跟 `suggest.ts` 里那段一字不差：
 * 一条设了开始时间的任务，人是**记得**它的，而且明确说了「那天之前别管」。
 * OmniFocus 把这种状态单独定义成一个词——Unavailable，「not yet ready for
 * work…as they have a future Defer Date」（《Glossary》），
 * 而它的标准视图默认不显示 Unavailable 的条目。
 *
 * 具体坏在哪：四象限是这个应用里唯一一屏「就这么多事，挑一件」。混进两条
 * 下个月才能动的任务，「重要且紧急」那一格的数字就是虚的——而这一格存在的
 * 全部意义就是那个数字可信。
 *
 * **后来这一支从 `notStarted` 换成了 `notStartedDeep`：父亲还没开始的，
 * 孩子现在也做不了。** 在那之前 defer 只挡住父任务自己——给「装修」设了
 * 9 月 1 日开始，它从这一屏正确地消失了，**它底下那三条活儿照常摆在格子里**，
 * 而那三条现在一件都动不了。上一段那句「那个数字可信」当时是假的。
 * 出处（OmniFocus「neither the item nor any contained items」）和为什么只传递
 * 不钳制，都在 `hierarchy.ts` 的 `blockingAncestor` 上。
 *
 * 但正在编辑的留下：`keep` 是调用方从 `TaskGrid` 的 `sections(editing)` 原样
 * 转过来的「哪些卡正在编辑」，参数位置和名字跟 `agendaSections`（agenda.ts）
 * 一致。不接这个参数、或者调用方不传 `editing` 进来的后果：编辑到一半的卡被
 * （通常是另一个客户端）标成完成，这张卡会连同没保存的草稿一起从四象限消失
 * ——`TaskGrid.tsx` 的 Props 契约注释里「调用方负责这一半」说的就是这件事，
 * 这里以前没做，只做了 `TaskGrid` 自己那一半（钉住原来的格子）。
 */
export function quadrantCells(
  /** **完整的那一份任务**，不是筛过的：`notStartedDeep` 要在里面找祖先。
   *  筛选是叠在这之上的一层（`App.tsx` 的 `withFilterBar`：`buildRaw` 先出
   *  原始分组，`filterSections` 再筛），所以这里拿到的一直是全量。 */
  tasks: Task[],
  now: Date,
  keep: Set<string>,
  rule: QuadrantRule = DEFAULT_QUADRANT_RULE,
): GridSection[] {
  const boundary = urgentBoundary(now);
  const bins = new Map(QUADRANT_KEYS.map((k) => [k, [] as Task[]]));
  for (const t of tasks) {
    // `notStartedDeep` 不是 `notStarted`：**父亲还没开始的，孩子现在也做不了**
    // ——四象限只看现在能做的，而一条被 defer 的父任务底下的活儿现在动不了。
    // 出处和为什么在 `hierarchy.ts` 的 `blockingAncestor` 上。
    if (!keep.has(t.id) && (isSettled(t) || notStartedDeep(t, now, tasks))) continue;
    const key: QuadrantKey = rule === 'time-priority'
      ? `${t.priority >= 2 ? 'imp' : 'min'}-${isUrgent(t.due, boundary) ? 'urg' : 'later'}`
      : QUADRANT_OF_PRIORITY.get(t.priority) ?? 'min-later';
    bins.get(key)!.push(t);
  }
  // 格内也按紧急度排，理由跟 `kanbanCells` 那段一字不差。
  return QUADRANT_KEYS.map((key) => ({ key, title: QUADRANT_TITLE[key], tasks: sortByUrgency(bins.get(key)!, now) }));
}

/**
 * 给拖放用：某个象限 key 对应的 `priority` 值。**四个格子都拖得动**，落进
 * 哪一格就是把优先级设成那一档——这跟原来那版不一样，那时候横轴是只读的
 * （按 `due` 自动分列），同一行的两格代表同一个 priority。
 *
 * 不认识的 key 返回 `null`，调用方据此判断不发 PATCH。
 */
export function priorityOfQuadrant(
  cellKey: string,
  rule: QuadrantRule = DEFAULT_QUADRANT_RULE,
): number | null {
  const m = rule === 'time-priority' ? QUADRANT_PRIORITY_2D : QUADRANT_PRIORITY;
  return m.get(cellKey as QuadrantKey) ?? null;
}
