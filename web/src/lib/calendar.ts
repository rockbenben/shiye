import type { Task } from '../types.js';
import { allFutureOccurrences } from './repeatProjection.js';
import { countdownsInRange } from './countdown.js';
import { activityMarks } from './calendarMarks.js';
// 本模块自己也要用（`daySlots` 分桶）。`export ... from` 只转出去，不带进作用域。
import { hasTimeBlock, isAllDay, type Timed } from './taskView.js';
import type { Countdown, WeekStart } from '../types.js';

export interface CalDay {
  /** 本地日期的 YYYY-MM-DD，同时是 React key 和拖放的目标 key。 */
  key: string;
  date: Date;
  /** 不属于当前锚定月份（月视图头尾补的那几天）。周视图里恒为 false。 */
  outside: boolean;
  tasks: Task[];
  /**
   * 重复任务推演出来的「以后还会有的那几次」（仿滴答清单的「显示未来重复
   * 周期」）。**跟 `tasks` 分开放，不混进同一个数组**：它们不是任务——没有
   * id、勾不了、拖不动、编辑不了，混在一起早晚有人对着一个影子调
   * `onPatch(t.id, …)`。默认是空数组（那个开关默认关着）。
   */
  marks: CalMark[];
}

/**
 * 格子上那些**不是任务**的标记：推演出来的未来重复周期、倒数纪念日、专注
 * 记录、习惯打卡（依次对应滴答清单日历显示设置里的四档开关）。
 *
 * **一个数组带 `kind`，不是四个平行数组。** 四个数组意味着 `CalendarFull`
 * 里四段几乎一样的 flatMap、`CalDay` 上四个要记得初始化的字段——加第五种的
 * 时候漏掉其中一处不会报错，只会让那一种静默不显示。它们共同的性质就是
 * 「不是任务：没有 id 可以 PATCH、拖不动、勾不掉」，那正好是一个类型。
 */
/**
 * 标记的四种。**提成一份运行时的值，不只是类型**：`CalendarFull` 的
 * `eventClick` 要在运行时分辨「这个事件 id 是任务还是标记」，而类型在那儿
 * 是不存在的。以前它用的是反向判据（`id.includes(':')`），有两个毛病——
 * 任务 id 里出现冒号就点不开（`isSafeId` 只拦 `..` 和斜杠，冒号是放行的，
 * 而 `POST /api/push` 收的是别的设备给的 id），而且改了标记 id 的拼法之后
 * 每个标记都会被当成任务、带着一个假 id 去开卡片。
 */
export const MARK_KINDS = ['repeat', 'countdown', 'focus', 'checkin'] as const;

export type MarkKind = (typeof MARK_KINDS)[number];

export interface CalMark {
  kind: MarkKind;
  /** 同一天里唯一即可——跟 `kind` 一起拼成 React key 和 FullCalendar 的事件 id。 */
  id: string;
  title: string;
  /** 全天标记给 `YYYY-MM-DD`，带时刻的给 ISO。 */
  start: string;
  /** 结束时刻（ISO）。只有专注记录有——它是唯一有时长的那一种。 */
  end?: string;
  allDay: boolean;
}

/** `calendarDays` 的可选项。**这一层的默认值是「今天的行为」**（全都显示、
 *  不推演）；产品默认档（隐藏已完成）在 `calendarPrefs.ts` 里，由界面那一层
 *  传进来——两个默认不是同一件事：这个纯函数的默认意思是「没人告诉我要筛，
 *  那就别筛」。 */
export interface CalendarOpts {
  /** 已完成的任务落不落格。 */
  showDone?: boolean;
  /** 推演不推演未来的重复周期。 */
  showFutureRepeats?: boolean;
  /** 要在格子上标出来的倒数纪念日。**给了就显示**——「显不显示」这个开关
   *  由调用方决定（不给/给空数组就是不显示），这一层不另设一个布尔量：
   *  两个字段表达同一件事，迟早出现「开关开着但没给数据」那种说不清的状态。 */
  countdowns?: Countdown[];
  /** 标出专注记录（仿滴答清单的「显示专注记录」）。数据就在 `tasks` 里
   *  （`focusSessions`），所以这一个是布尔量，不像 countdowns 那样传数据。 */
  showFocus?: boolean;
  /** 标出习惯打卡（仿滴答清单的「显示打卡」）。同上，数据在 `tasks` 里。 */
  showCheckins?: boolean;
  /**
   * 一周从周几开始（仿滴答清单「日期与时间 → 每周开始于」）。`1` = 周一
   * （默认，也是加这个选项之前写死的值），`0` = 周日。
   *
   * 只有这两档：月格的头尾补齐、周格的七天、表头那一行星期几，全是同一个数
   * 算出来的，而「从周二开始的一周」不是任何地方的真实需求。
   */
  weekStart?: WeekStart;
}

/**
 * 日历有哪几档。**照滴答清单那个下拉抄的**——它那边是「日 / 周 / 月 / 年 /
 * 日程」，外加两档可配参数的「多日（4 天）」「多周（2 周）」。
 *
 * 这里做前五档。多日/多周没做：它们是周/月的参数化变体（「看几天」是一个
 * 数字，不是一种新的看法），而这个应用还没有任何一处让人调那个数字的地方，
 * 加进来就是一个只能看不能改的档。见 README。
 *
 * 顺序就是下拉里的顺序，也是数字键 1..5 的顺序。
 */
export const CAL_MODES = ['day', 'week', 'month', 'year', 'agenda'] as const;
export type CalMode = (typeof CAL_MODES)[number];

/** 下拉里的字 + 那一档的快捷键首字母（滴答那边是 `D/1`、`W/2`……）。 */
export const CAL_MODE_LABEL: Record<CalMode, string> = {
  day: '日', week: '周', month: '月', year: '年', agenda: '日程',
};
export const CAL_MODE_KEY: Record<CalMode, string> = {
  day: 'D', week: 'W', month: 'M', year: 'Y', agenda: 'A',
};

/** 穷举检查：给 `CalMode` 收尾用。任何要对三档分别产出不同结果的地方（标题
 *  文案、哪个组件当正文……），写成 `if (mode === 'month') {…} else if (mode
 *  === 'week') {…} else if (mode === 'day') {…} else { return
 *  assertExhaustiveMode(mode); }`——最后这一支正常情况下走不到，`mode` 在
 *  这里的类型已经被收窄成 `never`。新增第四档 `CalMode` 字面量之后，任何
 *  忘了加对应分支的地方，最后这一支的 `mode` 类型不再是 `never`，
 *  `assertExhaustiveMode(mode)` 这一行会直接编译报错——不用等到运行时或
 *  测试才发现「漏了一档」。跟两路三元（`mode === 'month' ? A : B`）不一样：
 *  三元不会因为漏了第三档而报错，只会把新档静默并进 B，这正是 task-3-brief
 *  点名要躲开的坑。 */
export function assertExhaustiveMode(mode: never): never {
  throw new Error(`CalMode 没有穷举完：${String(mode)}`);
}

/** 一个格子最多摆几行标题/几条任务块，摆不下的收进「还有 N 条」/「+N」。
 *  月格（`CalendarGrid.tsx`）和小时格（`CalendarHours.tsx`）共用这一个数——
 *  以前这个常量只在 `CalendarGrid.tsx` 里私有定义，小时格照抄一份的话就是
 *  总账第 119 条「同一个算式被复制了一份到另一个组件、测试没跟过去」那个
 *  坑的下一次发作，所以提到这个数据层，两边都从这里 import。 */
export const MAX_VISIBLE_TASKS = 3;

/** 本地年月日拼 `YYYY-MM-DD`——**不能用 `toISOString().slice(0,10)`**，那是 UTC
 *  日期：东八区当地 00:30 的任务，UTC 是前一天 16:30，会被切到前一天的格子里。
 *  同一条教训见 `agenda.ts` 的 `endOfDay`。 */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 这个 ISO 时刻带不带具体钟点。全天判据跟 `isAllDay(t)` 完全一致，只是
 *  从一个字符串出发（推演出来的影子没有 `Task` 可以喂进去）。 */
export function hasClock(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0;
}

/**
 * **这条任务落在日历的哪一刻**——「落格看什么」在这个仓库里唯一的一份判据。
 *
 * 原来的规矩是一句话：**只看 `due`**（`due`/`reminders` 各管各的，日历回答的是
 * 「哪天到期」不是「哪天提醒」）。这一条给它开了唯一的例外：
 *
 * - **有时间段的**（`startAt` 和 `endAt` 都在，而且 `endAt` 真的晚于 `startAt`）
 *   按**时间段的起点**落格。一场九点到十二点的会，它属于九点那一格——按 `due`
 *   落格的话它会跑到「什么时候之前得做完」那一天去，而那多半是另一天。
 * - 其余一律照旧看 `due`。
 *
 * **收成一个函数，不散在几处判断**：落格（`calendarDays`）、落到哪个小时
 * （`daySlots`）、FullCalendar 那份事件的 `start`，三处问的是同一个问题。
 * 各写一遍的后果是「月视图画在这天、周视图画在那天」——而这个仓库对
 * 「同一件事两个答案」最敏感。
 *
 * **`endAt <= startAt` 当成没有时间段**（那是一句自相矛盾的话，但校验器有意
 * 收下它，见 `server/src/task.ts`）：照它画会得到一个负高度的块。
 *
 * 解析不出来的一律当成没有，返回 `null`——那条任务不落在任何一格里，跟
 * `due` 解析不了时的既有行为一字不差。
 */
export function calendarAnchor(t: Timed): Date | null {
  // 判据只有一份，在 `taskView.ts` 的 `hasTimeBlock`——`isAllDay` 也问它。
  if (hasTimeBlock(t)) return new Date(Date.parse(t.startAt as string));
  const due = t.due ? Date.parse(t.due) : NaN;
  return Number.isNaN(due) ? null : new Date(due);
}

/** 本地墙钟的「当天零点」，`setDate`/`setMonth` 这套算术不碰毫秒。 */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * `d` 所在周的第一天。取值见 `types.ts` 的 `WeekStart`。
 *
 * 算法对每一档是同一句：往回退 `(今天是周几 - 周首) mod 7` 天。`+ 7` 再取模是
 * 因为 JS 的 `%` 对负数返回负数（`(0 - 1) % 7 === -1`），周日 + 周一开头那一档
 * 正好踩中——少了它，周日会被算成「下周一往前 -1 天」，整周错位。加进周六那一
 * 档不用改这一行：它本来就是通用式。
 *
 * **导出，而且是这件事在这个仓库里唯一的一份实现。** 在它导出之前，
 * `focusStats.ts` 和 `heatmap.ts` 各自抄了一份写死周一的 `mondayOf`，两处注释
 * 都写着「跟 `calendar.ts` 同一条」——而那句话当时就已经不成立了（这边读设置，
 * 那两边不读）。三份拷贝里有两份是错的，正是「同一个概念别写第二遍」要防的。
 */
export function weekStartOf(d: Date, weekStart: WeekStart): Date {
  const day = localMidnight(d);
  const dow = day.getDay(); // 0=周日..6=周六
  day.setDate(day.getDate() - ((dow - weekStart + 7) % 7));
  return day;
}

/**
 * 第几周（ISO 8601）——滴答清单月视图每一行最左边、周视图表头最左边那个
 * 「35周」。
 *
 * **用 ISO 的定义，不自己数**：ISO 说「一年的第 1 周是包含那年第一个周四的
 * 那一周」。自己按「1 月 1 日所在的周算第 1 周」会在跨年那两周给出跟所有
 * 日历软件都不一样的数字，而这个数字唯一的用途就是跟别人对齐（「我们第 35
 * 周交」）。
 *
 * 算法是那个标准写法：把日期挪到它所在 ISO 周的**周四**，再看它是当年第几个
 * 七天。挪到周四是关键——ISO 周的归属年由周四决定，12 月 31 日可能属于下一
 * 年的第 1 周。
 *
 * **不看 `weekStart`**：ISO 周恒从周一起算。设置里选了「周日开头」只改屏幕上
 * 那七列怎么排，不改「第几周」这件事本身——那是一个跟别人对齐用的编号，
 * 换个人看就得是同一个数。
 */
export function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay(): 0=周日..6=周六 → ISO 里周一=1..周日=7
  const iso = t.getDay() === 0 ? 7 : t.getDay();
  t.setDate(t.getDate() + 4 - iso);          // 挪到本周周四
  const jan1 = new Date(t.getFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
}

/**
 * 月格/周格要显示哪些天、每天有哪些任务。
 *
 * 月视图固定 42 天（6 周 × 7 天，含头尾补的相邻月），周视图固定 7 天，一律从
 * 周一开始。落格只看 `due` 的本地日期——`due`/`reminders` 各管各的（AGENTS.md），
 * 日历回答的是「哪天到期」，不是「哪天提醒」，跟 `agendaSections`/`quadrantCells`
 * 同一条口径。解析不了或没有 `due` 的任务不落在任何格子里。
 *
 * 不收 `agendaSections`/`quadrantCells` 那个 `keep` 参数（正在编辑的卡不能因为
 * 字段被清空就从格子里消失）：这一层的格子只放截断标题，不是卡片，没有草稿会丢；
 * 真正需要保命的卡只出现在点开某一天之后的当天列表，那是一个真实的 `TaskGrid`，
 * 自己履行 `sections(editing)` 契约（见 `CalendarView.tsx` 的当天列表）。
 */
export function calendarDays(tasks: Task[], anchor: Date, mode: CalMode, opts: CalendarOpts = {}): CalDay[] {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const anchorMonth = monthStart.getMonth();
  // 三档各自的起点/天数——特意不写成两路三元（`mode === 'month' ? A : B`），
  // 那种写法会把新加的 'day' 悄悄并进 else 分支（当成周视图）。三档 if/else if
  // 逐个列出，最后一支交给 assertExhaustiveMode——Task 3 修复轮 1 · I-2 指出
  // 这里之前虽然逐档列出了，但落到最后那个普通 `else`，新增第四档照样会
  // 静默落进「当 1 天」这一支，编译器不会拦；这个函数决定「显示哪些天」，
  // 是三档穷举里权重最高的两处之一（另一处是下面 shiftAnchor），穷举保护
  // 只挂在 headingText/calendarBody 那两个「文案/正文」的地方却漏了这两个
  // 「数据」的地方，等于把界面上最容易看见的两处焊死了，最容易出问题的
  // 两处却没焊——这条改完之后才是真的全仓统一。
  // 认不出的落回默认档由类型保证（`WeekStart`），这儿只补「没给」这一种。
  const weekStart = opts.weekStart ?? 1;
  let start: Date;
  let count: number;
  if (mode === 'month') {
    start = weekStartOf(monthStart, weekStart);
    count = 42;
  } else if (mode === 'week') {
    start = weekStartOf(anchor, weekStart);
    count = 7;
  } else if (mode === 'day') {
    start = localMidnight(anchor);
    count = 1;
  } else if (mode === 'year') {
    // 整年，1 月 1 日到 12 月 31 日。**一天一个 `CalDay`**（365/366 个）而不是
    // 十二个「月」——年视图上每一格就是一天，它要回答的是「这一天有没有事」，
    // 那正是 `CalDay.tasks` 的形状。闰年靠「下一年 1 月 1 日减一天」算，不写
    // 闰年规则。
    start = new Date(anchor.getFullYear(), 0, 1);
    count = Math.round((new Date(anchor.getFullYear() + 1, 0, 1).getTime() - start.getTime()) / 86400000);
  } else if (mode === 'agenda') {
    // 日程：**这个月**，从 1 号到月末。跟月视图不一样的是它不补头尾那几天
    // ——那是格子网格为了凑满 6×7 才需要的，一份从上往下读的清单里，
    // 「上个月 27 号」出现在开头只会让人以为翻错页了。
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    count = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  } else {
    return assertExhaustiveMode(mode);
  }

  const days: CalDay[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    days.push({
      key: dayKey(date),
      date,
      outside: mode === 'month' && date.getMonth() !== anchorMonth,
      tasks: [],
      marks: [],
    });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));

  for (const t of tasks) {
    // 已完成和已放弃的：`showDone` 关着就不落格。**搁置的照常显示**——
    // 搁置是「暂时不想做」，它仍然占着那一天的位置；已完成是历史，已放弃是
    // 「这件事不做了」，日历回答的是「什么时候要做什么」，那两样都不是。
    //
    // 放弃这一档原来漏了（这个状态是后加的，这行还停在只认 done）：一件已经
    // 决定不做的事继续占着那一天，跟「全部」那个去处的规矩也对不上——
    // 那边一直是「排除已完成和已放弃，保留搁置」（lib/simpleViews.ts）。
    if ((t.status === 'done' || t.status === 'abandoned') && opts.showDone === false) continue;
    // 落格判据只有一份，见 `calendarAnchor`：有时间段的按起点，其余看 `due`。
    const at = calendarAnchor(t);
    if (at) byKey.get(dayKey(at))?.tasks.push(t);
  }

  if (opts.showFutureRepeats && days.length > 0) {
    // 窗口是这一页的第一天零点到最后一天的末尾——推演只算屏幕上看得见的
    // 那几天，翻页时重算。判据在 lib/repeatProjection.ts。
    const first = days[0].date;
    const lastDay = days[days.length - 1].date;
    const to = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate(), 23, 59, 59, 999);
    for (const g of allFutureOccurrences(tasks, first, to)) {
      byKey.get(dayKey(new Date(g.at)))?.marks.push({
        kind: 'repeat', id: `${g.taskId}:${g.at}`, title: g.title, start: g.at, allDay: !hasClock(g.at),
      });
    }
  }

  if (opts.countdowns && opts.countdowns.length > 0 && days.length > 0) {
    // 每年重复的纪念日要按年铺开（翻到明年三月也该看见那个生日），判据在
    // lib/countdown.ts 的 countdownsInRange。
    for (const m of countdownsInRange(opts.countdowns, days[0].date, days[days.length - 1].date)) {
      // 纪念日恒是全天：它存的就是 `YYYY-MM-DD`，没有时刻这回事。
      byKey.get(dayKey(m.at))?.marks.push({
        kind: 'countdown', id: m.id, title: m.title, start: dayKey(m.at), allDay: true,
      });
    }
  }

  if (opts.showFocus || opts.showCheckins) {
    const first = days[0].date;
    const lastDay = days[days.length - 1].date;
    const to = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate(), 23, 59, 59, 999);
    for (const m of activityMarks(tasks, first, to, { focus: !!opts.showFocus, checkins: !!opts.showCheckins })) {
      // 打卡的 `start` 已经是本地 `YYYY-MM-DD`，直接拿它当键——**不能再
      // `new Date(m.start)` 绕一圈**：只有日期的字符串按 ISO 规矩解析成 UTC
      // 零点，在负时区会退回前一天。同一条教训见 dayKey 的注释。
      byKey.get(m.start.length === 10 ? m.start : dayKey(new Date(m.start)))?.marks.push(m);
    }
  }

  /**
   * **格子里按时间排。** 上面那几个循环是 `push` 进去的，也就是任务数组进来的
   * 顺序——服务端 `readdirSync().sort()`，文件名是 uuid，**等于随机**。实拍过：
   * 8/26 那格显示成「背单词 21:00 / 晨跑 7:00 / 给房东打电话 20:00」。
   *
   * 这跟看板/四象限当初那处是同一个形状（见 `lib/cells.ts` 的 `kanbanCells`：
   * 「在这之前每一列是服务端读目录的顺序……随机」），日历格子是漏掉的最后一处，
   * 而且它更要紧：**一格日历的全部意义就是「这天按顺序有什么」**。
   *
   * **不用 `sortByUrgency`**（看板那边用的那个）：它把置顶的和过期的提到最前，
   * 那正好会打乱时序。日历要的就是时间序。
   *
   * **排的判据跟落格是同一个 `calendarAnchor`，不是 `due`。** 这里曾经写着
   * 「没有 due 的进不了格子，所以不用管 null」，配一个 `x.due as string` 的
   * 断言——那句话在时间段（`startAt`+`endAt`）加进来之后就不成立了：一场
   * 只有时间段的会落得进格子，`due` 却是 `null`，`Date.parse(null)` 是 NaN，
   * `NaN || …` 落到后面那个 `localeCompare`，于是**它按标题排**。实测排出过
   * 「晨跑 07:00 / 背单词 21:00 / 开会 09:00」——正是这段注释说它消灭掉的
   * 那个形状，换了个入口又长了回来。那个 `as string` 断言正是它藏住的地方。
   *
   * 同一时刻的按标题定序——不留「顺序取决于 readTasks() 的文件顺序」这种一改
   * 就变的排法，跟 `habitStats` 末尾那句同一条。
   *
   * `marks` 一起排：那几种标记（未来重复周期 / 纪念日 / 专注 / 打卡）跟任务
   * 摆在同一格里，只排一半的话格子照样是乱的。全天的没有时刻，排在带时刻的
   * 前面——跟日历「全天带在最上面」的通例一致。
   */
  const byStart = (a: number, b: number, ta: string, tb: string) =>
    (a - b) || ta.localeCompare(tb, 'zh');
  for (const d of days) {
    d.tasks.sort((x, y) => byStart(
      calendarAnchor(x)?.getTime() ?? NaN, calendarAnchor(y)?.getTime() ?? NaN, x.title, y.title,
    ));
    d.marks.sort((x, y) => {
      if (x.allDay !== y.allDay) return x.allDay ? -1 : 1;
      return byStart(Date.parse(x.start), Date.parse(y.start), x.title, y.title);
    });
  }

  return days;
}

/** 上一页/下一页的锚点：month 加减一个月，week 加减七天，day 加减一天。
 *  三档 if 逐个列出、最后一支交给 assertExhaustiveMode——Task 3 修复轮 1 ·
 *  I-2：改之前这里最后是「落穿到月」的普通 else（`month` 分支写在最后、
 *  没有专属的 `if (mode === 'month')`），新增第四档会静默按月翻页，这条
 *  函数决定翻页翻多远，出错比标题文案错更容易造成实际的数据操作误会
 *  （翻到了不是自己以为的那一天/那一周/那一月）。 */
export function shiftAnchor(anchor: Date, mode: CalMode, delta: -1 | 1): Date {
  if (mode === 'year') {
    // 整年翻。跟月那一支同一条防溢出：先把日期归到 1 月 1 日再挪年份。
    return new Date(anchor.getFullYear() + delta, 0, 1);
  }
  if (mode === 'agenda') {
    // 日程是「从这天起往后一路列」，翻页 = 挪一个月，跟月视图同一个步长——
    // 它一屏能列很长，按天翻要按几十次；按月翻跟上面那个标题（`YYYY年M月`）
    // 说的也是同一件事。
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    d.setMonth(d.getMonth() + delta);
    return d;
  }
  if (mode === 'week') {
    const d = localMidnight(anchor);
    d.setDate(d.getDate() + 7 * delta);
    return d;
  }
  if (mode === 'day') {
    const d = localMidnight(anchor);
    d.setDate(d.getDate() + delta);
    return d;
  }
  if (mode === 'month') {
    // setMonth 会溢出：3/31 减一个月会变成 3/3（2 月没有 31 号）。翻页只关心
    // 「显示哪个月」，日号本身不重要，先把 date 归 1 再挪月份就完全绕开了
    // 溢出——同一条坑 `server/src/repeat.ts` 的 `nextOccurrence` 也踩过
    // （月/年分支）。
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    d.setMonth(d.getMonth() + delta);
    return d;
  }
  return assertExhaustiveMode(mode);
}

/**
 * 「全天」的判据**搬去了 `taskView.ts`**，这里只是转出去——所有
 * `from './calendar.js'` 的调用点不用动。
 *
 * 搬家的理由：它是 `Task` 的语义（「本地零点 = 这一整天」），不是日历的画法。
 * 留在这儿的时候，`isOverdue`（taskView.ts）看不见它，于是「过期」按时刻硬比
 * ——一条拖到今天格子里的全天任务，`due` 是今天零点，当天下午读出来是
 * **「过期 13 小时」**（实测过，同一张卡上还同时写着「截止 今天 00:00」）。
 * 日历那半按「整天」理解零点，任务那半按「一个时刻」理解，两个模块对同一个
 * 值给出两种答案。
 */
export { isAllDay } from './taskView.js';

export interface DaySlots {
  allDay: Task[];
  /** 恒 24 项，index 是本地小时（0-23）。没有任务的小时也是空数组——渲染层
   *  直接按 index 取用，不用自己判断「这个小时存在吗」再补齐。 */
  hours: Task[][];
}

/**
 * 把 `calendarDays` 已经按本地日期落好格的一天，再按本地小时二次分桶：
 * 全天带一个，24 个小时槽各一个。`day.tasks` 里的任务已经保证 `due` 存在且
 * 能解析（`calendarDays` 的落格逻辑），这里不用重新判断一遍。
 */
export function daySlots(day: CalDay): DaySlots {
  const hours: Task[][] = Array.from({ length: 24 }, () => []);
  const allDay: Task[] = [];
  for (const t of day.tasks) {
    if (isAllDay(t)) {
      allDay.push(t);
      continue;
    }
    // 落到哪个小时跟落到哪一天用的是同一个锚点（`calendarAnchor`）——一场
    // 九点到十二点的会属于九点那一行，不是它 `due` 那一刻。`isAllDay` 已经
    // 把没有时刻的挑走了，走到这儿的锚点一定解得出来；兜底成 0 点只是不让
    // 一个手改坏的文件把整屏日历炸掉。
    hours[calendarAnchor(t)?.getHours() ?? 0].push(t);
  }
  return { allDay, hours };
}

/** 周/日视图默认画哪一段（本地小时，`[start, end)`）。
 *
 *  凌晨那几个小时对绝大多数人是空的，而它们占掉的高度是实打实的：24 行 ×
 *  40px = 960px，塞进一个 600 出头的容器里，结果是一进来就得滚，滚到底是
 *  23 点。07-23 这 16 行是「一天里真的会安排事的那段」。 */
export const DEFAULT_HOUR_BAND: { start: number; end: number } = { start: 7, end: 23 };

/**
 * 这一屏该画哪一段小时。**默认那段之外只要有一件事，带子就张开到包住它**。
 *
 * 这是这个设计跟滴答清单那种「把 00:00-07:00 折成一行」的分歧点：折叠带把
 * 「有没有东西」和「看不看得见」拆成了两件事——凌晨三点那条会议躲在一行
 * 折叠条后面，要点一下才知道。这里换成「按内容张开」：**看不见就等于没有**，
 * 不需要谁去点一下确认。代价是带子的高度会随内容变，那正是它该做的事。
 *
 * 全天任务不参与：它们在上面的全天带里，不占小时槽。四种标记（重复影子/
 * 纪念日/专注记录/打卡）同样不参与——`day.tasks` 里本来就没有它们，它们走
 * `day.marks`。**这是有意的**：一条凌晨四点的打卡记录不该把整个视图的时段
 * 拉开，它是「已经发生的事」的注脚，不是要看的安排。
 *
 * **张开的判据跟落格是同一个 `calendarAnchor`。** 这里曾经读 `t.due`，配一个
 * `as string` 断言——时间段（`startAt`+`endAt`）加进来之后那是错的，而且错得
 * 无声：`new Date(null)` **不是** Invalid Date，是 1970-01-01T00:00Z，在东八区
 * 取到 8 点，**恰好落在默认带里**，于是带子纹丝不动。一场 05:00 或 23:30、
 * 只有时间段没有截止时间的会，`binByHour` 把它放进 5 点/23 点那一槽，这里再
 * 把那一槽切掉——**整条在周/日视图上画不出来**。那正是这个函数存在的理由的
 * 反面：说好了「看不见就等于没有」，结果做成了「有东西但看不见」。
 */
export function hourBand(days: CalDay[]): { start: number; end: number } {
  let lo = DEFAULT_HOUR_BAND.start;
  let hi = DEFAULT_HOUR_BAND.end;
  for (const d of days) {
    for (const t of d.tasks) {
      if (isAllDay(t)) continue;
      const at = calendarAnchor(t);
      if (!at) continue; // 锚点算不出来的画不出来，也就不该撑开带子
      const h = at.getHours();
      if (h < lo) lo = h;
      // 落在 h 点的任务要看得见，就得画到 h+1（`end` 是开区间的右端）。
      if (h + 1 > hi) hi = h + 1;
      // **时间段要整段看得见，不是只看得见起点那一行**：22:00-23:30 那种
      // 否则会被从中间切掉。整点结束的不用多要一行（12:00 结束的块占到
      // 11 点那行的底，12 点那行是空的）。跨过午夜的（23:30-00:30）算出来
      // 的小时反而更小，而这里只抬不降，正好把它留在 24 那一头——每日网格
      // 本来也画不出第二天那半截。
      const e = hasTimeBlock(t) ? new Date(Date.parse(t.endAt as string)) : null;
      if (e) {
        const sharp = e.getMinutes() === 0 && e.getSeconds() === 0 && e.getMilliseconds() === 0;
        const need = e.getHours() + (sharp ? 0 : 1);
        if (need > hi) hi = need;
      }
    }
  }
  return { start: Math.max(0, lo), end: Math.min(24, hi) };
}
