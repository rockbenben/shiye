import type { FocusSession, Task, WeekStart } from '../types.js';
import { dayKey, weekStartOf } from './calendar.js';
import { asArray, CONTEXT_LABEL } from './taskView.js';

/**
 * 专注统计——仿滴答清单的「专注数据统计」。
 *
 * **这些数一直在存，只是从来没人看得到。** 卡片上的番茄钟跑完会往
 * `task.focusSessions` 追加一条（`TaskCard` 的 `onComplete`），而这个字段在
 * 界面上**一处都没有被读过**——每一次专注都被记下来又立刻消失。它那边这一整块
 * 存在的理由是「没有对事件的追踪和记录，你就永远不知道自己错在哪里」，
 * 而这里连追踪都白做了。
 *
 * 三样：总览（今天/本周/本月）、最近若干天的趋势、按任务的排行。它那边还有
 * 年度热力图、最佳专注时间段、按清单/标签的分布——那几样要么需要更长的历史
 * 才有意义，要么是同一批数据的另一种切法，先把「有没有」这件事解决掉。
 *
 * 纯函数，不读时钟（`now` 由调用方传）。
 */

export interface FocusTotal {
  /** 几次番茄。 */
  count: number;
  /** 一共多少分钟。 */
  minutes: number;
}

export interface FocusDay {
  /** 本地日期 `YYYY-MM-DD`，同时是 React key。 */
  key: string;
  date: Date;
  total: FocusTotal;
}

export interface FocusOnTask {
  id: string;
  title: string;
  total: FocusTotal;
}

const EMPTY: FocusTotal = { count: 0, minutes: 0 };

/** 一条记录的时刻。解析不了或者分钟数不是正数的一律跳过——`data/tasks/` 是
 *  手改得到的文件，一条坏记录不该让整块统计变成 NaN。 */
function validAt(s: FocusSession): number | null {
  if (typeof s?.minutes !== 'number' || !Number.isFinite(s.minutes) || s.minutes <= 0) return null;
  const t = Date.parse(s?.startedAt);
  return Number.isNaN(t) ? null : t;
}

/** 把一条任务上的记录摊平成 `[时刻, 分钟]`，顺带滤掉坏的。 */
const sessionsOf = (t: Task): Array<{ at: number; minutes: number }> =>
  asArray<FocusSession>(t.focusSessions)
    .map((s) => ({ at: validAt(s), minutes: s.minutes }))
    .filter((x): x is { at: number; minutes: number } => x.at !== null);

const add = (a: FocusTotal, minutes: number): FocusTotal => ({ count: a.count + 1, minutes: a.minutes + minutes });

/** 本地某一天的零点。 */
const startOfDay = (d: Date, plusDays = 0): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);

export interface FocusTotals {
  today: FocusTotal;
  week: FocusTotal;
  month: FocusTotal;
  all: FocusTotal;
}

/**
 * 今天 / 本周 / 本月 / 至今，各多少次、多少分钟。
 *
 * 边界一律**本地墙钟**：本周是「本地的那个周首零点起」，不是「往前 168 小时」
 * ——人心里的「这周」是日历上的这周。同一条教训见 `agenda.ts` 的 `endOfDay`。
 *
 * **周首读设置**（`Settings.weekStart`），走 `calendar.ts` 那唯一的 `weekStartOf`。
 * 这儿原来自己抄了一份写死周一的 `mondayOf`：把「每周开始于」改成周日之后，
 * 日历那七列跟着变了，而这里报的「本周专注 3 小时」还是按周一到周日算——那是
 * 一个**算错了的数字**，不是排版偏好。不给这个参数就按周一，跟设置的默认档
 * 一致（离线读不到设置时走的也是这条）。
 */
export function focusTotals(tasks: Task[], now: Date, weekStartsOn: WeekStart = 1): FocusTotals {
  const dayStart = startOfDay(now).getTime();
  const weekStart = weekStartOf(now, weekStartsOn).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let today = EMPTY; let week = EMPTY; let month = EMPTY; let all = EMPTY;
  for (const t of tasks) {
    for (const s of sessionsOf(t)) {
      all = add(all, s.minutes);
      if (s.at >= monthStart) month = add(month, s.minutes);
      if (s.at >= weekStart) week = add(week, s.minutes);
      if (s.at >= dayStart) today = add(today, s.minutes);
    }
  }
  return { today, week, month, all };
}

/**
 * 最近 `days` 天，每天一格（含今天，最早的在前）。**没有记录的那天也在**——
 * 趋势图上缺的那几根柱子本身就是信息（那几天一次都没专注），把它们跳过会让
 * 图看起来是连续的。
 */
export function focusByDay(tasks: Task[], now: Date, days: number): FocusDay[] {
  const out: FocusDay[] = [];
  const byKey = new Map<string, FocusDay>();
  for (let i = days - 1; i >= 0; i--) {
    const date = startOfDay(now, -i);
    const d: FocusDay = { key: dayKey(date), date, total: EMPTY };
    out.push(d);
    byKey.set(d.key, d);
  }
  for (const t of tasks) {
    for (const s of sessionsOf(t)) {
      const d = byKey.get(dayKey(new Date(s.at)));
      if (d) d.total = add(d.total, s.minutes);
    }
  }
  return out;
}

/**
 * 时间花在哪几件事上，多的在前。**只列真的有记录的**——一个全是 0 的排行榜
 * 没有信息。滴答清单那边是个饼图，这里是一份排序过的列表：一份「哪几件事吃
 * 掉了我的时间」的答案，读列表比读扇形角度快。
 */
export function focusByTask(tasks: Task[]): FocusOnTask[] {
  return tasks
    .map((t) => {
      let total = EMPTY;
      for (const s of sessionsOf(t)) total = add(total, s.minutes);
      return { id: t.id, title: t.title, total };
    })
    .filter((x) => x.total.count > 0)
    // 分钟多的在前；一样多时按次数，再一样就按标题——不留「顺序取决于
    // readTasks() 的文件顺序」这种会随手一改就变的排法。
    .sort((a, b) => b.total.minutes - a.total.minutes
      || b.total.count - a.total.count
      || a.title.localeCompare(b.title, 'zh'));
}

/**
 * 这一条任务一共专注了多少分钟。给卡片上那句「已专注 …」用。
 *
 * **这批数一直在存，卡片上却一个字都没说过**——「专注统计」那一页补的是
 * 汇总的那一半，而「我在这件事上已经投了多久」这个问题是在卡片上问的，
 * 那正是做决定的地方。跟 `focusByTask` 用的是同一份 `sessionsOf`。
 */
export function taskFocusMinutes(t: Task): number {
  let n = 0;
  for (const s of sessionsOf(t)) n += s.minutes;
  return n;
}

/** 「1 小时 25 分」。分钟数是整数分钟，不做秒。 */
export function formatMinutes(m: number): string {
  const mins = Math.max(0, Math.round(m));
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

// ── 补记 / 删掉一条专注记录（仿滴答清单的「补记专注记录」「删除专注记录」）──
//
// **这条路走得通，是因为 `focusSessions` 在客户端可写的白名单里**
// （`server/src/task.ts` 的 `TaskPatch`）。`completedAt` 不在——它是服务端在
// 状态跃迁到 done 那一刻盖的章，是「什么时候完成的」这个事实的唯一来源。
// 所以滴答清单那边的「补记打卡」（在月度打卡表里点某一天补一次卡）这里做不了：
// 习惯的历史是从 `completedAt` 推出来的，补记等于让客户端编一个完成时间，
// 那条不变量比这个功能值钱。要做得另开一条专门的端点，不是把 completedAt
// 放进白名单。

export interface SessionRow {
  taskId: string;
  title: string;
  /** 原样的 ISO 字符串——**同时是删除时的身份**，见 `removeSessionPatch`。 */
  startedAt: string;
  minutes: number;
}

/**
 * 补记一条。**追加，不覆盖**——调用方只知道「新加这一条」，这条任务上已经
 * 攒了几条不该由它操心，跟 `TaskCard` 接番茄钟 `onComplete` 时是同一个分工。
 */
export function addSessionPatch(t: Task, at: Date, minutes: number): Partial<Task> {
  return {
    focusSessions: [...asArray<FocusSession>(t.focusSessions), { startedAt: at.toISOString(), minutes }],
  };
}

/**
 * 删掉一条。**按 `startedAt` 字符串精确匹配，只删第一条命中的**——
 * `FocusSession` 没有 id，而同一条任务上两条记录的开始时刻撞到毫秒的概率
 * 可以忽略（番茄钟是在开始那一刻记的时刻）。真撞上了也只删一条，不会把两条
 * 一起抹掉。
 *
 * 找不到就返回 `null`：调用方不该发一个什么都不改的写。
 */
export function removeSessionPatch(t: Task, startedAt: string): Partial<Task> | null {
  const rows = asArray<FocusSession>(t.focusSessions);
  const i = rows.findIndex((s) => s.startedAt === startedAt);
  if (i < 0) return null;
  return { focusSessions: rows.filter((_, k) => k !== i) };
}

/**
 * 最近的若干条记录，新的在前。给「专注记录」那张列表用——**补记这个功能得
 * 配一张看得见的列表**：填错了一条（点错任务、多打一个 0）如果没地方看、
 * 没地方删，这个入口就是一扇单向门。
 */
export function recentSessions(tasks: Task[], limit: number): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const t of tasks) {
    for (const s of asArray<FocusSession>(t.focusSessions)) {
      if (validAt(s) === null) continue;
      rows.push({ taskId: t.id, title: t.title, startedAt: s.startedAt, minutes: s.minutes });
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

// ── 另外两种切法（仿滴答清单「专注时长分布」和「专注时间分布」）──
//
// 上面那三样回答的是「多少」和「哪几件事」。这两样换的是维度：**时间花在哪
// 一类事情上**（按清单 / 按标签），和**一天里的什么时候在专注**。同一批
// `focusSessions`，不多存一个字节。

/** 一天 24 个小时槽。 */
export const HOURS = 24;

export interface FocusHour {
  /** 0..23。 */
  hour: number;
  total: FocusTotal;
}

/**
 * 一天里各个钟点各专注了多少（仿滴答清单的「专注时间分布」）。
 *
 * **按开始时刻归一个整点，不按分钟摊到跨过的每个小时。** 一段 14:50 开始的
 * 25 分钟番茄整段算进 14 点，不是 14 点 10 分钟、15 点 15 分钟——这张图回答的
 * 是「我一般什么时候坐下来开始」，那正是能拿来安排明天的那个答案；摊开之后
 * 每一段都会在两个柱子上留下影子，反而看不出起点在哪。
 *
 * 24 个槽一个不少，没有记录的那几个小时也在——缺的那几根本身就是信息
 * （凌晨三点当然是空的），跟 `focusByDay` 同一条。
 */
export function focusByHour(tasks: Task[]): FocusHour[] {
  const out: FocusHour[] = Array.from({ length: HOURS }, (_, hour) => ({ hour, total: EMPTY }));
  for (const t of tasks) {
    for (const s of sessionsOf(t)) {
      // 本地钟点，不是 UTC——「我下午三点最能坐得住」说的是本地墙钟。
      const h = new Date(s.at).getHours();
      out[h].total = add(out[h].total, s.minutes);
    }
  }
  return out;
}

/** 记录最多的那个钟点。一条记录都没有返回 `null`——调用方据此不说那句话，
 *  而不是说一句「记录最多的是 0 点」。并列时取靠前的那个。 */
export function busiestHour(hours: FocusHour[]): FocusHour | null {
  let best: FocusHour | null = null;
  for (const h of hours) {
    if (h.total.minutes > 0 && (!best || h.total.minutes > best.total.minutes)) best = h;
  }
  return best;
}

export type FocusGroupBy = 'list' | 'tag' | 'context';

export interface FocusGroup {
  /** 分组的身份：清单 id，或者标签全名。`null` = 「不属于任何清单」那一档。 */
  key: string | null;
  label: string;
  total: FocusTotal;
}

/**
 * 时间花在哪一类事情上（仿滴答清单的「专注时长分布」）。
 *
 * **按标签分组时一段记录会算进它的每一个标签**，所以各组加起来会超过总时长。
 * 这是有意的，也必须在界面上说出来：一段既是 `#工作` 又是 `#紧急` 的番茄，
 * 摊成两个 12.5 分钟是在编造一个并不存在的精度——它整整二十五分钟都既属于
 * 工作也属于紧急。按清单分组不存在这个问题（一条任务只在一个清单里），
 * 那一档是真的划分。
 *
 * 没有记录的组不列——一份全是 0 的分布没有信息。
 *
 * **按情境分跟按清单分一样是真划分**（一条任务只有一个情境），各组加起来等于
 * 总时长，不需要标签那一档那句「加起来会比总时长多」的声明。它回答的是 GTD
 * 那个闭环的后半：按情境挑活干，那时间到底花在哪个情境上了。
 */
export function focusByGroup(
  tasks: Task[], by: FocusGroupBy, lists: Array<{ id: string; name: string }>,
): FocusGroup[] {
  const acc = new Map<string, FocusGroup>();
  const bump = (key: string | null, label: string, minutes: number) => {
    const k = key ?? '\u0000none';
    const cur = acc.get(k) ?? { key, label, total: EMPTY };
    acc.set(k, { ...cur, total: add(cur.total, minutes) });
  };
  const listName = new Map(lists.map((l) => [l.id, l.name]));

  for (const t of tasks) {
    const mins = sessionsOf(t);
    if (mins.length === 0) continue;
    for (const s of mins) {
      if (by === 'list') {
        const id = t.listId ?? null;
        // 指向一个已经删掉的清单时当成「不属于任何清单」，不显示一个裸 id。
        bump(id && listName.has(id) ? id : null, (id && listName.get(id)) || '不属于任何清单', s.minutes);
      } else if (by === 'context') {
        // 存的是英文 key，展示用中文名（全站只此一份，见 taskView.ts）。
        // 认不得的值（手改进来的旧数据）归「没分情境」，不印一个裸 key。
        const c = t.context;
        const label = c ? CONTEXT_LABEL[c] : undefined;
        bump(label ? c : null, label ?? '没分情境', s.minutes);
      } else {
        const tags = asArray<string>(t.tags);
        if (tags.length === 0) bump(null, '没有标签', s.minutes);
        else for (const tag of tags) bump(tag, tag, s.minutes);
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.total.minutes - a.total.minutes
    || b.total.count - a.total.count
    || a.label.localeCompare(b.label, 'zh'));
}
