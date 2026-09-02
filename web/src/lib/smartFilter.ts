import type { SmartFilter, Task } from '../types.js';
import { searchTasks } from './search.js';
import { endOfDay } from './agenda.js';
import { taggedWith } from './tagTree.js';
import { notStarted } from './taskView.js';

/**
 * 每一维的「什么都不筛」。每一维单独看都表示「这一维不参与」，跟
 * `server/src/list.ts` 的 `checkSmartFilter` 认的合法形状一致（空数组、
 * `null`、`false`、空字符串都是各自类型里的合法值，不是校验失败）。
 */
export function emptyFilter(): SmartFilter {
  return {
    status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null,
    hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false,
    isRepeating: false, notStarted: false, estimateWithinMinutes: null, or: [], not: [],
  };
}

/**
 * 把一份**存下来的**筛选补全成完整形状。
 *
 * 这不是防御性编程的洁癖，是一条实测出来的白屏：`data/lists/` 里任何一个
 * `filter` 少一个字段（手改、旧版本存下来的、同步过来的半截文件），
 * `f.status.length` 就是「读 undefined 的 length」——整个应用当场白屏，
 * 侧栏、任务、随手记一起没，而那条清单本身可能根本不在当前视图里。
 * 实测复现过：只把 `status` 写成 `statuses`，整站白屏。
 *
 * 这个仓库对**任务**那一侧早就认过同一件事（TaskCard 里那句「GET /api/tasks
 * 不校验文件写入的数据，一个漏写这个字段的任务不该让整页白屏」，靠 `asArray`
 * 兜底），智能清单这一侧一直没有。服务端 `list.ts` 的 `checkSmartFilter` 只
 * 拦得住**经过 API 写进来**的，拦不住直接落在磁盘上的文件——而那正是这个
 * 应用的常态（AI 写 outbox、同步、手改）。
 *
 * 补的是形状，不是猜意图：缺的字段一律取「这一维不参与」（`emptyFilter()`
 * 那份），类型不对的（本该是数组的不是数组）也按缺处理。`or` 一并补，
 * 只补一层——嵌套的第二层恒为空，服务端校验拦着。
 */
export function normalizeFilter(f: SmartFilter | null | undefined): SmartFilter {
  const e = emptyFilter();
  if (!f || typeof f !== 'object') return e;
  const arr = <T,>(v: unknown, fb: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fb);
  return {
    status: arr(f.status, e.status),
    listIds: arr(f.listIds, e.listIds),
    tags: arr(f.tags, e.tags),
    priority: arr(f.priority, e.priority),
    contexts: arr(f.contexts, e.contexts),
    dueWithinDays: typeof f.dueWithinDays === 'number' ? f.dueWithinDays : null,
    hasWaitingFor: f.hasWaitingFor === true,
    text: typeof f.text === 'string' ? f.text : '',
    tagsAll: f.tagsAll === true,
    noList: f.noList === true,
    noTag: f.noTag === true,
    noDue: f.noDue === true,
    isRepeating: f.isRepeating === true,
    notStarted: f.notStarted === true,
    // 正数才算数。0 / 负数 / NaN 一律当没填——「预计不超过 0 分钟」筛出来恒为空，
    // 那不是一个人会想表达的意思，多半是控件清空时漏了归 null。服务端那份
    // （`list.ts` 的 `checkGroup`）对同一件事是**整份拒收**，两边不一样是有意的：
    // 那边守的是「别把脏东西存进文件」，这边守的是「文件里已经有脏东西时别崩」。
    estimateWithinMinutes: typeof f.estimateWithinMinutes === 'number'
      && Number.isFinite(f.estimateWithinMinutes) && f.estimateWithinMinutes > 0
      ? f.estimateWithinMinutes : null,
    // 只补一层：`or`/`not` 里那几份自己的恒为空（服务端校验拦着）。
    or: arr<SmartFilter>(f.or, []).map((g) => ({ ...normalizeFilter(g), or: [], not: [] })),
    not: arr<SmartFilter>(f.not, []).map((g) => ({ ...normalizeFilter(g), or: [], not: [] })),
  };
}

/**
 * 一组条件里七维都没填。**不看 `tagsAll`**：那是「标签这一维怎么算」的修饰，
 * 标签为空时它什么都不影响，把它算进来会让一份「什么都没筛、只是勾了个且」
 * 的筛选被当成非空，筛选栏就再也收不起来了。
 */
function isGroupEmpty(f: SmartFilter): boolean {
  return f.status.length === 0
    && f.listIds.length === 0
    && f.tags.length === 0
    && f.priority.length === 0
    && f.contexts.length === 0
    && f.dueWithinDays === null
    && !f.hasWaitingFor
    // `noList`/`noTag` **算填了**，跟 `tagsAll` 不一样：那个是「标签这一维怎么
    // 算」的修饰，标签为空时它什么都不影响；这两个自己就是一条筛选条件
    // （「没归进任何清单的」），勾上了筛选栏就该是展开的、就该能存成智能清单。
    && !f.noList
    && !f.noTag
    && !f.noDue
    && !f.isRepeating
    && !f.notStarted
    && f.estimateWithinMinutes === null
    && f.text.trim() === '';
}

/**
 * 整份筛选「什么都没筛」——第一组空、一个「或」组都没有、**一个「排除」组也
 * 没有**。
 *
 * 最后那一条是必须的：一份只有排除组的筛选（「全部，但不要 #工作」）在
 * 第一组上确实是空的，可它筛掉了东西。判成「什么都没筛」的后果是筛选栏
 * 自己收起来、存不成智能清单，而屏幕上少了一批任务却没有任何地方说得清为什么。
 */
export function isFilterEmpty(raw: SmartFilter): boolean {
  const f = normalizeFilter(raw);
  return isGroupEmpty(f) && asGroups(f).length === 1 && asNot(f).length === 0;
}

/** `not` 缺失（加这个字段之前存下来的智能清单）当成没有「排除」组。 */
const asNot = (f: SmartFilter): SmartFilter[] => (Array.isArray(f.not) ? f.not : []);

/** `or` 缺失（加这个字段之前存下来的智能清单）当成没有「或」组。 */
const asGroups = (f: SmartFilter): SmartFilter[] => [f, ...(Array.isArray(f.or) ? f.or : [])];

/**
 * 应用一份 `SmartFilter`。七维「与」的关系：每一维先单独判断要不要参与
 * （空数组/null/false/空字符串 = 这一维不筛，见 `emptyFilter`），参与的维度
 * 之间取交集，不参与的维度放行全部——**空数组是「所有值都要」，不是「一个
 * 都不匹配」**，这是这个函数最容易写反的一处。
 *
 * `text` 直接复用 `searchTasks`（`web/src/lib/search.ts`）——那是搜索框认的
 * 「文本命中什么」的唯一出处，不在这里另写一份匹配范围，否则同一个词在
 * 搜索框和智能清单里会给出不同结果。`dueWithinDays` 复用 `agenda.ts` 的
 * `endOfDay`（整日边界，含已过期），跟 `cells.ts` 的 `urgentBoundary` 同一条
 * 口径——这个仓库已经为「同一界面两种『N 天内』」栽过一次（四象限的紧急
 * 边界），别再造第三种。
 *
 * 不改传入的数组（每一步用 `.filter` 产出新数组），保持原有顺序。
 */
export function applyFilter(tasks: Task[], raw: SmartFilter, now: Date): Task[] {
  const f = normalizeFilter(raw);
  const groups = asGroups(f);
  // 只有第一组时走老路，一次 filter 都不多做——绝大多数筛选都是这种。
  // **「排除」组在最外面减一次**，三条出口都要过它：包括下面「全都空了、
  // 放行全部」那一条——一份只写了排除组的筛选（「全部，但不要 #工作」）
  // 在每一个「或」组上都是空的，可它确实要筛掉东西。
  if (groups.length === 1) return applyNot(applyGroup(tasks, f, now), f, now);

  // **多语句查询**（滴答清单的「高级筛选」）：组与组之间取并集。
  //
  // **空组不参与，不是「匹配全部」。** 这一条跟单组时正好相反，而且必须相反：
  // 单组为空是「什么都不筛」（放行全部，这个文件从头到尾的规矩）；多组时如果
  // 空组也按「匹配全部」算，那么第一行控件被清空的那一刻，整份查询就退化成
  // 「全部」——用户明明还在下面那组里筛着东西，屏幕上却是所有任务。加「或」
  // 这个功能会变得没有意义。
  const active = groups.filter((g) => !isGroupEmpty(g));
  // 全都空了：回到「什么都不筛」，放行全部——不是「一组都没命中所以什么都
  // 不显示」。跟空数组是「所有值都要」同一条道理。
  if (active.length === 0) return applyNot(tasks, f, now);

  // 用 Set 认命中，不是把每组的结果拼起来——那样同时满足两组的任务会出现两次。
  // 顺序按原数组走，不按组走：一份筛选结果的顺序不该因为「它命中的是第几组」
  // 而跳来跳去。
  const hit = new Set<string>();
  for (const g of active) for (const t of applyGroup(tasks, g, now)) hit.add(t.id);
  return applyNot(tasks.filter((t) => hit.has(t.id)), f, now);
}

/**
 * 「排除」组：命中其中任何一组的任务一律拿掉。
 *
 * **减在最后、对整份结果减一次**，不是每个「或」组各减各的：后者会把
 * 「A 或 B，排除 C」变成「(A 排除 C) 或 B」——那是另一句话，而且是人从界面上
 * 读不出来的那一句。
 *
 * 空组不参与（跟「或」那边一字不差的理由）：一个刚加出来、还没填任何条件的
 * 排除组如果按「匹配全部」算，屏幕会当场清空——而人只是点了一下「加一个排除」。
 */
function applyNot(tasks: Task[], f: SmartFilter, now: Date): Task[] {
  const groups = asNot(f).filter((g) => !isGroupEmpty(g));
  if (groups.length === 0) return tasks;
  const banned = new Set<string>();
  for (const g of groups) for (const t of applyGroup(tasks, g, now)) banned.add(t.id);
  return tasks.filter((t) => !banned.has(t.id));
}

/** 一组条件（七维「且」）。 */
function applyGroup(tasks: Task[], f: SmartFilter, now: Date): Task[] {
  let out = tasks;
  if (f.status.length > 0) out = out.filter((t) => f.status.includes(t.status));
  // 清单这一维：选中的那几份，**并上**「没归进任何清单的」（如果勾了）。
  // 两者是「或」不是「且」——勾了「没有清单」又选了「工作」，要的是「还没
  // 归类的，加上工作里的」，判成「既没清单又在工作里」是空集，等于这一维
  // 一勾上就什么都筛不出来。
  if (f.listIds.length > 0 || f.noList) {
    out = out.filter((t) => (t.listId !== null && f.listIds.includes(t.listId)) || (f.noList && t.listId === null));
  }
  // 默认「任一命中即可」；`tagsAll` 打开就是「选中的每一个都得有」——
  // 滴答清单的「同一个筛选条件内（仅标签支持）的且/或」。
  // **父标签连子标签一起算**（二级标签，lib/tagTree.ts）：筛「工作」要能筛出
  // `#工作/项目A` 的任务，跟点侧栏那个标签看到的是同一批，不然同一个标签在
  // 两个入口给出两种结果。
  if (f.tags.length > 0 || f.noTag) {
    const tags = f.tags;
    // `tagsAll` 只管选中的那几个标签之间怎么算，**跟「没有标签」无关**：
    // 「每个都得有」加上「一个都没有」本身就是矛盾，两者只能是「或」。
    const named = f.tagsAll
      ? (t: Task) => tags.every((tag) => taggedWith(t.tags, tag))
      : (t: Task) => tags.some((tag) => taggedWith(t.tags, tag));
    out = out.filter((t) => (tags.length > 0 && named(t)) || (f.noTag && t.tags.length === 0));
  }
  if (f.priority.length > 0) out = out.filter((t) => f.priority.includes(t.priority));
  // 情境：**没分情境的任务一律筛不到**，跟「没有清单」不一样——那一维有一档
  // 「不属于任何清单」可以显式勾，这一维没有。理由是这一维的用法是「我现在
  // 在电脑前，给我能干的」，而「没分情境的」既不是能干也不是不能干，混进来
  // 只会让这份清单不能直接照着做。真要捞没分的，用「全部」。
  if (f.contexts.length > 0) out = out.filter((t) => t.context !== null && f.contexts.includes(t.context));
  // 「没有截止时间的」。**跟 `dueWithinDays` 是同一维的两档，不是「或」**：
  // 界面上它们共用一个单选下拉，选了这一档就没选那一档。手改文件同时写了两个，
  // 得到的是空集——那就是这两句话摆在一起的字面意思（「没有日期」且「7 天内」），
  // 这里不替他挑一个更「合理」的解释。
  //
  // 日期**读不出来**的也算没有：`due` 手改成「下周三」时，「N 天内」筛不到它、
  // 日历不画它、「今天」不收它、排序把它沉底——功能上它就是没有日期，而那正是
  // 这一档要捞的那一堆。
  if (f.noDue) {
    out = out.filter((t) => !t.due || Number.isNaN(Date.parse(t.due)));
  }
  if (f.dueWithinDays !== null) {
    const boundary = endOfDay(now, f.dueWithinDays);
    out = out.filter((t) => {
      if (!t.due) return false; // 没有 due 的任务，「N 天内」这一维天然不满足
      const due = Date.parse(t.due);
      return !Number.isNaN(due) && due <= boundary;
    });
  }
  if (f.hasWaitingFor) out = out.filter((t) => t.waitingFor !== null && t.waitingFor.trim() !== '');
  // 「只看重复任务」。判据就是有没有 `repeat`，跟卡片上那句「每周一」是同一个
  // 依据——一条任务要么挂着重复规则要么没有，没有中间态。
  if (f.isRepeating) out = out.filter((t) => t.repeat !== null && t.repeat !== undefined);
  // 「还没到开始时间」。**复用 `notStarted`**，跟卡片上那个「9 月 1 日 开始」的
  // 记号、「接下来」里那一组、四象限的排除是同一个函数。这一维自己写一遍
  // 「什么叫还没开始」的后果是：筛出来一条卡片上没有那个记号的任务。
  if (f.notStarted) out = out.filter((t) => notStarted(t, now));
  // 「预计不超过 N 分钟」。**没估过的筛不到**——「没估过」既不是二十分钟以内
  // 也不是以外，混进来这份清单就不能直接照着做（跟 `contexts` 那一维对「没分
  // 情境」的态度一字不差）。`<=` 不是 `<`：人说「只有二十分钟」时，一件正好
  // 估二十分钟的事显然算数。
  if (f.estimateWithinMinutes !== null) {
    const cap = f.estimateWithinMinutes;
    out = out.filter((t) => typeof t.estimateMinutes === 'number' && t.estimateMinutes <= cap);
  }
  if (f.text.trim() !== '') out = searchTasks(out, f.text);
  return out;
}
