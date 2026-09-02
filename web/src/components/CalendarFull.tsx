import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventDropArg } from '@fullcalendar/core';
import { MARK_KINDS, MAX_VISIBLE_TASKS, calendarAnchor, dayKey, hourBand, isAllDay, isoWeek, daySlots, type CalDay, type CalMark } from '../lib/calendar.js';
import { hasTimeBlock } from '../lib/taskView.js';
import { holidayMark, lunarAria, lunarLabel } from '../lib/lunar.js';
import type { WeekStart } from '../types.js';
import { pointerXY } from '../lib/schedulePanel.js';
import { useIsNarrow } from '../lib/narrow.js';

interface Props {
  /** 月视图 42 天 / 周视图 7 天 / 日视图 1 天——跟 `CalendarGrid`/`CalendarView`
   *  同一份 `calendarDays(tasks, anchor, mode)` 产出。这个组件自己不认
   *  `CalMode`，靠 `days.length` 反推该画哪一档（42→月，7→周，1→日）——
   *  跟 `CalendarHours.tsx`（已退役）当年靠 `days.length` 认列数、不额外收
   *  `mode` prop 同一条思路：`days.length` 已经是权威数据，另开一条 `mode`
   *  只会变成第二份可能漂开的拷贝。 */
  days: CalDay[];
  anchor: Date;
  now: Date;
  selectedKey: string | null;
  onSelectDay: (key: string) => void;
  /**
   * **点格子里的任务块 → 打开那一条。**
   *
   * 在这之前格子里的任务是点不动的：`dateClick` 把整格的点击都收走了（选中
   * 那一天），而任务块自己没有任何点击处理——于是「在日历上看见一条任务，
   * 想看看它是什么」这件事，得先点那一天、再去下面的当天列表里找同一条。
   *
   * **只对真任务生效**：格子里还画着四种标记（未来重复周期 / 纪念日 / 专注
   * 记录 / 打卡），它们的事件 id 带 `kind:` 前缀（见下面 `marks` 那段），
   * 不是任务 id——它们没有卡片可开，点了不该有反应。判据就是那个前缀。
   *
   * 不给这个 prop 时行为跟以前一字不差。
   */
  onOpenTask?: (taskId: string) => void;
  /** 月视图：拖到某一天改期。跟 CalendarGrid.tsx 的 onDropOnDay 同一份契约：
   *  不算真正的 due，只转发 (任务 id, 目标日期的 key)，保留原时刻是调用方
   *  （CalendarView）的事。不给这个 prop 时格子不可编辑。 */
  onDropOnDay?: (taskId: string, dayKey: string) => void;
  /** 周/日视图：拖到某个小时格/全天带改期。跟 CalendarView.tsx 的
   *  onDropOnSlot 同一份契约——`hour` 是 0-23 或 `'allday'`，分秒毫秒怎么
   *  归零、"拖到 0 点=变成全天"这条既定设计，都是调用方的事，这里只负责
   *  从 FullCalendar 的 eventDrop 结果里读出 (dayKey, hour|'allday') 转发
   *  出去。不给这个 prop 时格子不可编辑。 */
  onDropOnSlot?: (taskId: string, dayKey: string, hour: number | 'allday') => void;
  /**
   * **从日历外面拖进来一条没日期的任务**（「安排任务」那一栏，见
   * `SchedulePanel.tsx`）。跟上面两个都不一样，所以是第三个 prop 而不是复用：
   *
   * - `onDropOnDay` 保留**原来的时刻**（它处理的是「已经排好的，换一天」）；
   *   拖进来的这条压根没有原来的时刻，没得保留。
   * - `onDropOnSlot` 只在周/日视图有；这条路月/周/日三档都要走。
   *
   * 交出去的是 `(任务 id, 落点时刻, 是不是全天)`——`due` 具体怎么写（全天
   * 落在几点、分秒毫秒归不归零）还是调用方的事，跟上面两个的分工一致。
   * 不给这个 prop 时日历不接受外来拖拽（`droppable` 关着）。
   */
  onScheduleTo?: (taskId: string, at: Date, allDay: boolean) => void;
  /** 一周从周几开始（1=周一，默认；0=周日）。周/日视图的表头列序靠它。
   *  月视图的 42 天由 `days` 决定，这里传给 FullCalendar 只是让它别按自己的
   *  默认（周日）去排——两处不一致会让表头和格子错开一列。 */
  weekStart?: WeekStart;
  /**
   * 日历上一条任务被拖动的**两拍**：`start` 和 `stop`（`stop` 带指针坐标）。
   *
   * 这是「从日历拖回『安排任务』栏 = 取消日期」那条路的日历这一侧。跟
   * `onDropOnDay` / `onDropOnSlot` 的分工很清楚：那两个是**落在日历里**
   * （FullCalendar 的 `eventDrop`）；这个是拖到**日历外面**去了，
   * FullCalendar 认不出落点、会把事件弹回原处，只剩 `eventDragStop` 这一拍。
   *
   * **日历只报「松手时指针在屏幕的这个点」，不判断那是什么。** 落点在它自己
   * 的盒子外面，它没有立场认识「安排任务栏」这种东西——那一栏的 DOM 和它的
   * 位置都在 `CalendarView` 手上，命中判断也该在那儿。
   *
   * 四种标记（重复影子/纪念日/专注记录/打卡）不会走到这里：它们
   * `editable: false`，压根拖不动。
   */
  onEventDrag?: (phase: 'start' | 'stop', taskId: string, at: { x: number; y: number }) => void;
  /** 周/日视图画满 0-24 点（`CalendarPrefs.showAllHours`）。默认按内容取那一段
   *  （`hourBand`）——那一段之外的小时在屏幕上不存在，也就没法往那儿拖东西，
   *  这个开关是那个出口。 */
  allHours?: boolean;
  /** 格子里写不写农历/节气（`Settings.showLunar`）。默认不写：这个组件在
   *  测试里被单独渲染很多次，多一行小字会让一堆无关断言跟着抖。 */
  showLunar?: boolean;
  /** 标不标「休 / 班」（`Settings.showHolidays`）。默认不标，理由同上。 */
  showHolidays?: boolean;
}

// 月视图星期表头还是 CalendarGrid.tsx 自己画的 .ink-cal-weekdays（周一起）；
// 周/日视图没有那一行，表头就是 FullCalendar 自己的 dayHeaders——这份是给
// 那份表头用的，index 是 Date#getDay()（0=周日……6=周六），跟旧实现
// CalendarHours.tsx 的 WEEKDAY_CHARS 是同一份数据，组件退役了但这份小小的
// 映射表没有第二个合理的家，就地重建一份（7 个字符，不值得为它跨文件 import）。
const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];

/** ISO 时间戳 → 本地的 `H:MM`。月格那一条右边写的就是它——不补前导零的小时，
 *  跟滴答那边一样（「9:00」不是「09:00」）：一格只有一百多像素宽，能省一个
 *  字符就省一个。 */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 周/日视图拖拽提示——挂在表头日期格上（跟月格拖拽提示分开挂在 .ink-cal-daynum
 *  同一个道理：小而不会被误认成整片可滚动区域）。原文照抄退役前的
 *  CalendarHours.tsx，这句话改的是日期*和*时刻两样，跟月格那句只改日期不是
 *  同一句，要单独写。 */
/**
 * 日号底下那半行：农历/节气 + 「休 / 班」。月格和周/日表头共用一份。
 *
 * 屏幕上是两截碎字（「廿三」「休」），读屏读到的是一整句（`lunarAria`）——
 * 所以这里 `aria-hidden` 掉可见的那两截，再挂一个只有读屏看得到的整句。
 * 两截各自朗读的话，日号后面会跟一串没有主语的碎片。
 */
function CellSub({ date, lunar, holiday }: { date: Date; lunar: boolean; holiday: boolean }): ReactNode {
  const mark = holiday ? holidayMark(date) : null;
  const text = lunar ? lunarLabel(date) : '';
  if (!text && !mark) return null;
  return (
    <span className="ink-cal-sub">
      <span className="ink-sr-only">{lunarAria(date)}</span>
      {text && <span className="ink-cal-lunar" aria-hidden="true">{text}</span>}
      {mark && (
        <span className={`ink-cal-mark ink-cal-mark-${mark === '休' ? 'off' : 'on'}`} aria-hidden="true">{mark}</span>
      )}
    </span>
  );
}

// 「排到那一刻」而不是「改到期日期和时间」：有时间段的那种拖的是那场会本身
// （`startAt`/`endAt` 一起挪、时长不变），不是它的截止时间，见 CalendarView.tsx
// 的 `onDropOnSlot`。
const HOUR_DRAG_HINT = '拖动任务到某个时刻，就把它排到那一刻；提醒时间不会跟着挪，还在原来那一刻响。';

/** 进来滚动但那一天一条任务都没有时的兜底小时。 */
const DEFAULT_SCROLL_HOUR = 8;

/**
 * 周/日视图进来要滚到哪个小时：「当天」（`now` 那一天，如果它在这批 `days`
 * 里）第一条非全天任务所在的小时减一；`now` 那天不在 `days` 里就退回
 * `days[0]`；一条任务都没有就 `DEFAULT_SCROLL_HOUR`——原样搬自退役前的
 * `CalendarHours.tsx`，那份组件退役了，但这条算法是行为契约的一部分，不是
 * 实现细节，原样保留。
 *
 * **修复轮 1（复审 C3）导出**：退役前的 `CalendarHours.tsx` 故意不导出这个
 * 函数，理由是"真正要守住的是‘算出来的这个小时真的把滚动容器带过去了’，那
 * 只能在组件渲染层断言"（当时有 `scrollIntoView` 这个可以 spy 的 DOM 出口）。
 * FullCalendar 的 `scrollTime` 是纯配置 prop，没有对应的可 spy 出口，这条
 * 理由已经不成立——不导出的代价是这个纯函数的 7 条边界断言（有任务/没任务/
 * 0 点半边界/全天任务不算进第一条/今天不在 days 里退回 days[0]/空数组不崩）
 * 整组失去了测试，改成导出，直接单测。 */
export function scrollTargetHour(days: CalDay[], now: Date): number {
  const target = days.find((d) => d.key === dayKey(now)) ?? days[0];
  if (!target) return DEFAULT_SCROLL_HOUR;
  const firstHour = daySlots(target).hours.findIndex((tasks) => tasks.length > 0);
  return firstHour === -1 ? DEFAULT_SCROLL_HOUR : Math.max(0, firstHour - 1);
}

/**
 * 日历正文：月视图 dayGridMonth（task-5），周/日视图 timeGridWeek/
 * timeGridDay（task-6，手写的 `CalendarHours` 退役）。三档共用同一个组件，
 * 靠 `days.length` 反推该画哪一档（见上面 Props.days 的注释），不收一个
 * 显式的 `mode` prop——`CalendarGrid.tsx` 调这个组件时（月视图）从来没传过
 * `mode`，如果这里改成必收，`CalendarGrid.tsx` 也得跟着改，这不是 task-6-
 * brief 列的两个文件之一。这个组件只管「格子网格本身」，不管上面的翻页/
 * 月周日按钮/标题——那些还留在 CalendarGrid.tsx 的导航行里。
 *
 * `key={...}`（挂在下面的**内层** `<FullCalendar>` 上，不是这个组件自己）：
 * 月视图翻页时重新挂载一个新的 FullCalendar 实例（不用 ref + gotoDate()
 * 这套命令式 API），因为月视图没有跨页要保留的内部状态。周/日视图同一个
 * key 套路（`timeMode` + 这一页第一天的 `key`），但代价不一样——
 * ⚠️ **修复轮 1（复审 m1）纠正了上一版这里的错话**：`scrollTime`（下面）
 * 是 `useMemo(() => ..., [])`，锁的是**这个 `CalendarFull` 组件自己**
 * 第一次渲染那一刻的值，不是内层 `<FullCalendar>` 的 `key`——`CalendarView.
 * tsx` 渲染这个组件时没有给它自己的 `key`，翻页/周↔日切档只改变
 * `days`/`anchor` 这些 **props**，`CalendarFull` 作为 React 组件本身**不会
 * 重新挂载**（同一个组件类型、同一个树位置），`useMemo(..., [])` 因此只在
 * "第一次切进周/日视图"那一刻算一次，之后不管翻多少页、周日切多少次都不
 * 会重算——内层 `<FullCalendar>` 的 `key` 变了只是让它用新一页的
 * `initialDate` 重新起 render，`scrollTime` 传给它的还是那个冻结在第一次
 * 进入时的旧值。**这其实比上一版声称的"翻页也会重新滚"更贴近退役前
 * `CalendarHours.tsx` 的原始语义**（那边是 `useEffect(() => {...}, [])`，
 * 同样只在真正打开这个视图那一刻滚一次，翻页/拖拽改期都不重新触发，
 * `CalendarHours` 当年在 `CalendarView.tsx` 里同样没有自己的 `key`）——
 * 上一版的错话只是描述错了机制（以为是内层 key 在管这件事），不是行为
 * 本身有问题，这轮只改注释，不改代码。 */
/** 四种标记各自的 className。**一张表，不是四个 if**——加第五种时漏掉一处
 *  会让它顶着别人的样式出现，而那种错在截图上看不出来。 */
const MARK_CLASS: Record<CalMark['kind'], string> = {
  repeat: 'ink-ghost-event',
  countdown: 'ink-cd-event',
  focus: 'ink-pomo-event',
  checkin: 'ink-checkin-event',
};

export function CalendarFull({ days, anchor, now, selectedKey, onSelectDay, onOpenTask, onDropOnDay, onDropOnSlot, onScheduleTo, onEventDrag, allHours, weekStart = 1, showLunar, showHolidays }: Props): ReactNode {
  // 窄屏月格里只画时刻不画标题，判据见下面 eventContent 那段注释。直接在这里
  // 调 hook、不从 props 传：调用方（CalendarView）自己也不需要这个信息。
  const narrow = useIsNarrow();
  // 42→月，7→周，1→日——跟退役前 CalendarHours.tsx 认「几列」同一条思路。
  const timeMode: 'week' | 'day' | null = days.length === 7 ? 'week' : days.length === 1 ? 'day' : null;

  // 月视图：全部当全天事件处理（旧格从来不显示时刻，只显示标题）。周/日
  // 视图：这条启发式要接过去——`Task` 没有 `allDay` 字段（数据模型的既定
  // 约束，这一批不加字段），isAllDay() 判据是「due 的本地时/分/秒/毫秒全为
  // 0」，喂给 FullCalendar 自己的 `allDay` 字段，不让它自己猜（它默认按
  // ISO 字符串里带不带时间部分判断，这里的 `due` 恒是完整时间戳，猜出来会
  // 恒为 false）。
  /**
   * **格子里的先后由 `calendarDays` 说了算，不由 FullCalendar 猜。**
   *
   * 它默认的 `eventOrder` 是 `start,-duration,allDay,title`，而月视图把每条都当
   * 全天（下面那行 `allDay: timeMode ? … : true`）——`start` 只剩日期，四个键
   * 全部打平，于是它退到按**标题**排，用的还是 locale（拼音）序。实拍出来是
   * 「背单词 21:00 / 晨跑 7:00 / 给房东打电话 20:00」：bei < chen < gei，一字不差，
   * 而一格日历的全部意义就是「这天按顺序有什么」。
   *
   * 发一个递增的 `ord` 当排序键，**不在这儿另写一份排序规则**：`calendar.ts` 的
   * `calendarDays` 末尾已经排好了（按时刻、全天在前、同刻按标题定序，那儿有测试
   * 盯着），这里只是把那个顺序原样交出去。两处各排一份迟早会分头飘。
   *
   * 序号按**下标**算，不用一个在 `useMemo` 外面靠副作用递增的计数器：
   * FullCalendar 只在同一天的事件之间比较，所以序号只要在一天之内正确就够了。
   * 标记加上 1000 的偏移，让它们恒排在那天的任务后面——标记是背景信息
   * （未来重复周期 / 纪念日 / 专注 / 打卡），不该插在真任务中间。
   */
  const events = useMemo(
    () => [
      ...days.flatMap((d) => d.tasks.map((t, ti) => ({
        id: t.id,
        title: t.title,
        // 落格判据只有一份（`calendar.ts` 的 `calendarAnchor`）：有时间段的
        // 按起点，其余看 `due`。这儿以前直接写 `t.due`——那是同一条规矩的
        // 第二份拷贝，加了时间段之后它会跟月/周格子上的位置对不上。
        start: (calendarAnchor(t) ?? new Date(t.due as string)).toISOString(),
        // **有时间段的给一个 `end`**，FullCalendar 才会把它画成一段有高度的块
        // （滴答清单的「时间段」）。没有 `endAt` 的照旧是一个点，跟以前一字
        // 不差。月视图（`timeMode` 为假）全都当全天，那儿本来就不画高度。
        ...(timeMode && hasTimeBlock(t) ? { end: t.endAt as string } : {}),
        allDay: timeMode ? isAllDay(t) : true,
        // 月格那一条右边要写的时刻。**必须在这儿算好带过去**：月视图把每条都
        // 当全天（`allDay: true`），而 FullCalendar 对全天事件会把 `start` 的
        // 时间部分抹掉——渲染那一侧再去读 `event.start` 拿到的恒是零点，
        // 于是「18:00」永远显示不出来（实测过，一整屏一个时刻都没有）。
        // 月格右边那个时刻同样走锚点：有时间段的写「09:00」（起点），
        // 不是它 `due` 那一刻——两处显示同一条任务，说的得是同一个时间。
        extendedProps: {
          chipTime: isAllDay(t) ? null : (() => {
            const at = calendarAnchor(t);
            return at ? hhmm(at.toISOString()) : null;
          })(),
          ord: ti,
        },
        // **不写 `editable`**：真任务能不能拖由组件级的 `editable={canDrag}`
        // 决定（没接 onDrop* 的调用方就是不可拖）。在事件上写死 `true` 会
        // 盖过那个开关——FullCalendar 的 per-event `editable` 优先级更高，
        // 「没给 onDropOnDay 就不该能拖」那条会被静默推翻。
        classNames: [] as string[],
      }))),
      // 那四种**不是任务**的标记（未来重复周期 / 倒数纪念日 / 专注记录 /
      // 习惯打卡，依次对应滴答清单日历显示设置里的四档开关）。一段 flatMap
      // 全包，不是四段几乎一样的——判据在 `calendar.ts` 的 `CalMark`。
      //
      // 共同的三条：`editable: false`（它们没有 id 可以 PATCH，拖了也没处
      // 落）、各自一个 className（看得出跟真任务不一样）、`id` 带 kind 前缀
      // （FullCalendar 用 id 认「同一个事件」，跟任务本体撞 id 的话拖本体会
      // 把标记一起拖走）。
      ...days.flatMap((d) => d.marks.map((m, mi) => ({
        id: `${m.kind}:${m.id}`,
        title: m.title,
        start: m.start,
        // 月视图一律当全天（旧格从来不显示时刻）；周/日视图听标记自己的。
        allDay: timeMode ? m.allDay : true,
        // 只有专注记录有时长——`end` 给 undefined 时 FullCalendar 按「一个
        // 时间点」渲染，正是别的三种要的。
        ...(m.end && timeMode ? { end: m.end } : {}),
        extendedProps: { ord: 1000 + mi },
        editable: false,
        classNames: [MARK_CLASS[m.kind]],
      }))),
    ],
    [days, timeMode],
  );

  // 一格摆几条：月/日 3 条（MAX_VISIBLE_TASKS），周 1 条——跟退役前
  // CalendarHours.tsx 的 maxVisible 同一条规则（周视图一列窄，放不下 3 个
  // 标题，重演过看板 217px 列宽「买.」那个坑）。`dayMaxEvents` 管全天带
  // （跟月格共用同一个选项），`eventMaxStack` 管小时槽里同一时刻的堆叠——
  // 两者都吃同一个数字。
  const maxVisible = timeMode === 'week' ? 1 : MAX_VISIBLE_TASKS;

  // 只在真正挂载的那一刻算一次（见组件头顶 key 那段注释）——`useMemo(...,
  // [])` 冻结的是「这个 FullCalendar 实例第一次渲染时」的 days/now，不是
  // 每次 props 变化都重算。dayGrid（月视图）用不上这个选项，算了也没有副
  // 作用，不用另外用 timeMode 挡一层。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollTime = useMemo(() => `${String(scrollTargetHour(days, now)).padStart(2, '0')}:00:00`, []);

  /**
   * 周/日视图画哪一段小时 + 行高怎么定。这两件事是一件事的两半：
   *
   * 原来是 FullCalendar 的默认值（00:00-24:00），24 行 × 40px = 960px 塞进一个
   * 600 出头的容器——**一进来就得滚，滚到底是 23 点**，而滚过去的那七行凌晨
   * 通常一件事都没有。
   *
   * 现在：`hourBand` 算出「这一屏真的需要哪一段」（默认 07-23，带外有事就张开
   * 到包住它，见那个函数），配 `expandRows` —— FullCalendar 只**撑不缩**，
   * 所以有余量时行拉长填满容器（底下不留白纸），装不下时才退回滚动。
   * 两个方向都没有「藏起来一部分」这个选项。
   *
   * `slotMinTime`/`slotMaxTime` 每次渲染都跟着 `days` 重算，不 `useMemo`：
   * 它就是 `days` 的一个纯函数，翻一页内容变了带子就该跟着变。这跟
   * `scrollTime` 那个刻意冻结在首次渲染的值不是一回事（那个是「进来时滚到
   * 哪儿」，翻页不该重滚）。
   */
  const band = allHours ? { start: 0, end: 24 } : hourBand(days);

  const canDrag = timeMode ? !!onDropOnSlot : !!onDropOnDay;

  // aria-current="date"：`dayCellClassNames`/`dayHeaderClassNames` 每次渲染
  // 都重新求值，但 `dayCellDidMount`/`dayHeaderDidMount` 只在这一格的真实
  // DOM 节点第一次创建时触发一次——实测过（task-5）：只在挂载钩子里设
  // aria-current，点第二天之后属性还留在第一天上，不会跟着 selectedKey 挪。
  // 月格是 `.fc-daygrid-day`，周/日视图的表头格是 `.fc-col-header-cell`
  // （两者都会被 FullCalendar 打上 `data-date`，见下面各自的注释）——选择器
  // 按 timeMode 二选一，不用一个不加限定的 `[data-date=]` 通吃两种场景：
  // all-day 行背景格是否也带 data-date 不确定，显式限定到「表头格」/
  // 「月格」避免选到错误的元素。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const selector = timeMode ? '.fc-col-header-cell' : '.fc-daygrid-day';
    root.querySelectorAll('[aria-current="date"]').forEach((el) => el.removeAttribute('aria-current'));
    if (selectedKey) {
      root.querySelector(`${selector}[data-date="${selectedKey}"]`)?.setAttribute('aria-current', 'date');
    }
  });

  const calendar = (
    <FullCalendar
      key={timeMode ? `${timeMode}-${days[0]?.key ?? ''}` : `${anchor.getFullYear()}-${anchor.getMonth()}`}
      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
      initialView={timeMode === 'week' ? 'timeGridWeek' : timeMode === 'day' ? 'timeGridDay' : 'dayGridMonth'}
      initialDate={anchor}
      now={now}
      firstDay={weekStart}
      headerToolbar={false}
      // 月视图星期表头还是 CalendarGrid.tsx 自己画的 .ink-cal-weekdays，关掉
      // FullCalendar 自己那份，不重复。周/日视图没有别处画表头，这里必须
      // 开——这是这一批第一次真的用到 FullCalendar 原生的日期表头。
      dayHeaders={!!timeMode}
      // 两档都是 `100%`——外面那层壳（下面 return 里的 .ink-cal-timegrid /
      // .ink-cal-monthgrid）有确定高度，撑满它。月视图原来是 `'auto'`：格子
      // 网格自己按内容决定高度，1440×900 上画到 719px 就停了，底下 180px
      // 是空纸。滴答清单的月历铺满窗口、六行等高，改成跟周/日同一条路。
      height="100%"
      editable={canDrag}
      eventStartEditable={canDrag}
      // `editable` 同时打开拖动和缩放（FullCalendar 的 API 语义）——不关掉
      // 的话会渲染出 `.fc-event-resizer`，拖右边缘触发 `eventResize`，这里
      // 没接对应 handler，`Task` 也没有时长字段接不住这个交互出口，必须
      // 显式关掉（task-5 C1 同一条理由，两档视图共用）。
      eventDurationEditable={false}
      dayMaxEvents={maxVisible}
      // 见上面 `events` 那段：顺序的正本在 `calendar.ts`，这里只是不让
      // FullCalendar 用它那套（全都打平之后退到按标题排）覆盖掉。
      eventOrder="ord"
      eventMaxStack={maxVisible}
      displayEventTime={false}
      events={events}
      // 24 小时槽、每小时一格——跟退役前 CalendarHours.tsx 的 24 行小时格
      // 同一个粒度。这也是"拖到某个小时→分秒归零"的机制来源：FullCalendar
      // 拖拽默认吸附到 slotDuration 的整数倍（snapDuration 未设时继承
      // slotDuration），一小时一格意味着落点永远卡在整点，不用自己再补一次
      // 「分秒清零」的算术。dayGrid（月视图）不认这个选项，无副作用。
      slotDuration="01:00:00"
      // "08" 这种两位数、24 小时制、不带分钟——slotDuration 是整小时，加
      // 分钟位只会显示恒为 "00" 的噪音。不设 locale（这个仓库到目前为止没有
      // 给 FullCalendar 设过 locale，月视图靠自己画表头/按钮绕开了这件事），
      // hour12: false 已经足够避免出现 AM/PM 后缀。
      slotLabelFormat={{ hour: '2-digit', hour12: false }}
      scrollTime={scrollTime}
      // 当前时刻线——只在 timeMode 下开（dayGrid 月视图没有这个概念，也不该
      // 有）。FullCalendar 自己判断"今天"在不在当前视图范围内，不在就不画，
      // 不用像退役前的 CalendarHours 那样自己算 todayKey。
      nowIndicator={!!timeMode}
      allDayText="全天"
      // 周/日视图左上角那一格写「35周」（照滴答清单）。**只在时间轴那两档开**
      // ——月视图那边周数已经写在每行第一格的日期旁边了（`dayCellContent`），
      // 这里再开一次会在最左边多出一整列，同一个数字占两处。
      // 拖动的两拍。`eventDragStop` 对**每一次**拖动都会响，包括正常落在日历
      // 里的那种——坐标交出去，由调用方判断「这个点是不是安排任务栏」。落在
      // 日历里时那个判断为假，什么都不做，改期照旧走 `eventDrop`。
      // **0 = 不放那段「弹回原处」的动画**（默认 500ms）。这个日历里落在格子上
      // 的拖动全都是合法的，唯一会触发弹回的就是「拖到日历外面去了」——而那一
      // 种我们接住了（拖到「安排任务」栏 = 取消日期），事件本来就该消失，
      // 先花半秒钟弹回原位再消失是纯粹的多余动作。
      //
      // 顺带治好了一个测不出来的洞：`eventDragStop` 是在弹回动画**结束之后**
      // 才发的（见 @fullcalendar/interaction 里 `handleDragEnd` 上面那句
      // "must happen after revert animation"），而 jsdom 不跑 transition，
      // 那个动画永远不结束——于是这一整条路在测试里静默失灵，`eventDragStart`
      // 响了、`eventDragStop` 永远不响。
      dragRevertDuration={0}
      eventDragStart={onEventDrag ? (info) => onEventDrag('start', info.event.id, { x: 0, y: 0 }) : undefined}
      // 坐标走 `pointerXY`，不是直接读 `jsEvent.clientX`：触摸事件上没有那个
      // 属性（在 `changedTouches[0]` 上），读到 undefined 之后一路比下去全是
      // false——手指拖过去会「什么都没发生」，静默失效。
      eventDragStop={onEventDrag ? (info) => onEventDrag('stop', info.event.id, pointerXY(info.jsEvent)) : undefined}
      slotMinTime={`${String(band.start).padStart(2, '0')}:00:00`}
      slotMaxTime={`${String(band.end).padStart(2, '0')}:00:00`}
      // 只撑不缩：有余量就把行拉长填满容器，装不下时保持 40px 一行去滚。
      expandRows
      weekNumbers={!!timeMode}
      weekNumberContent={(arg) => `${arg.num}周`}
      // 「+3」而不是「还有 3 条」——照滴答清单。那一行摆在最后一条任务的右端，
      // 一句话会把它挤成两行；这个数字要回答的只是「还有几条没画出来」。
      moreLinkText={(n) => `+${n}`}
      moreLinkClick={(arg) => {
        onSelectDay(dayKey(arg.date));
        return 'none';
      }}
      dateClick={(arg) => {
        onSelectDay(dayKey(arg.date));
      }}
      /* 点任务块 → 打开那一条。**标记类的事件不响应**：它们的 id 是
         `${kind}:${id}`（calendar.ts 的 `MARK_KINDS`），不是任务 id，没有卡片可开。
         **判据是正向的**：只认那四种已知前缀，不写成「带冒号的都不是任务」
         ——任务 id 里出现冒号是可能的（`isSafeId` 只拦 `..` 和斜杠，而
         `POST /api/push` 收的是别的设备给的 id），那样的任务会变成日历上唯一
         点不开的东西，而且看不出为什么。反向判据还有第二个毛病：改了标记 id
         的拼法之后，每个标记都会被当成任务、带着一个假 id 去开卡片。

         **残留的那一点说清楚**：一条 id 恰好以 `repeat:`/`countdown:`/`focus:`/
         `checkin:` 开头的任务仍然点不开。四个已知前缀 vs「任何带冒号的」，
         范围小了几个数量级，但不是零——真出现的话得给标记的 id 换个不可能撞上
         的前缀（比如换一个不可能出现在 id 里的分隔符），而不是再退回反向判据。

         **不调 `stopPropagation()`**：这儿原来写着「不加的话会冒泡到格子上、
         `dateClick` 跟着把那一天也选中」——那句是错的。查过
         `@fullcalendar/core/internal-common.js` 的 `isValidDateDownEl`：它对
         `.fc-event:not(.fc-bg-event)` 直接返回 false，事件块上的按下根本走不到
         `dateClick`。而那一句不是无害的空操作——FullCalendar 的监听器挂在 React
         根容器**里面**，在这儿掐掉原生 click，React 19 的根级委托就收不到它，
         任何祖先的 `onClick`（antd 弹层的点外面关闭、以后加的面板级点击统计）
         都会静默失灵。 */
      eventClick={onOpenTask ? (arg) => {
        const id = arg.event.id;
        if (!id || MARK_KINDS.some((k) => id.startsWith(`${k}:`))) return;
        onOpenTask(id);
      } : undefined}
      // "今天"直接吃 FullCalendar 原生的 .fc-day-today（月格和周/日视图的
      // 表头格都会打上这个类，同一份 --fc-today-bg-color 映射两边通用）。
      // "选中"库没有对应概念，靠这两个回调补一个自定义类。
      dayCellClassNames={!timeMode ? (arg) => (dayKey(arg.date) === selectedKey ? ['ink-cal-day-selected'] : []) : undefined}
      dayHeaderClassNames={timeMode ? (arg) => (dayKey(arg.date) === selectedKey ? ['ink-cal-day-selected'] : []) : undefined}
      // 月视图的日期那一行：**左边日号、右边第几周**，照滴答清单排。
      //
      // 周数只画在每一行的第一格（那一行的周首），不是每格都画——它是「这
      // 一整行是第几周」，七格各写一遍是同一句话说七次。判据是「这一格是不是
      // 这一周的第一天」，用 `weekStart` 算，跟表头那一行同一个数。
      //
      // 拖拽提示还是挂在日号上（.ink-cal-daynum），不是整张格子。
      dayCellContent={!timeMode ? (arg) => (
        <>
          {/* 今天那一颗多一个类，**不写成 `.fc-day-today .ink-cal-daynum`**：
              那种祖先打头的选择器会从 theme.css.test.ts 的 `.ink-cal-*` 前缀
              扫描里整条隐形（那条守卫存在的理由就是它），跟 `.ink-ghost-event`
              当初不叫 `.ink-cal-ghost` 是同一条规矩——一个类名只进一个族，
              而且必须顶格扫得到。 */}
          <span
            className={`ink-cal-daynum${dayKey(arg.date) === dayKey(now) ? ' ink-cal-daynum-today' : ''}`}
            title={onDropOnDay ? '拖动任务到别的日期，钟点不变；提醒时间不会跟着挪，还在原来那一刻响。' : undefined}
          >
            {arg.dayNumberText}
          </span>
          {arg.date.getDay() === weekStart && (
            <span className="ink-cal-wk" aria-label={`第 ${isoWeek(arg.date)} 周`}>{isoWeek(arg.date)}周</span>
          )}
          {/* 农历那半行**摆在日号和周数下面自己占一行**，不是挤在日号旁边：
              它们回答的不是同一个问题，而一格最窄只有 45px（390 宽的月视图），
              横着并排一定是两样都读不出来。 */}
          {(showLunar || showHolidays) && <CellSub date={arg.date} lunar={!!showLunar} holiday={!!showHolidays} />}
        </>
      ) : undefined}
      // 周/日视图：拖拽提示挂在表头日期格上（跟月格那句不是同一句，见
      // HOUR_DRAG_HINT 的注释），格式沿用退役前 CalendarHours.tsx 的
      // "星期几 日期"（比如"一 16"）——不用 FullCalendar 自带的
      // dayHeaderFormat（默认英文月/日名，这个仓库没给它设过 locale）。
      dayHeaderContent={timeMode ? (arg) => (
        <span title={onDropOnSlot ? HOUR_DRAG_HINT : undefined}>
          {WEEKDAY_CHARS[arg.date.getDay()]} {arg.date.getDate()}
          {(showLunar || showHolidays) && <CellSub date={arg.date} lunar={!!showLunar} holiday={!!showHolidays} />}
        </span>
      ) : undefined}
      // 键盘可达：月格是 <td role="gridcell">，周/日表头格是
      // <th role="columnheader">，都不是字面的 <button>（DOM 结构由库控制），
      // 默认也不带 tabindex——补 tabIndex + keydown(Enter/Space) 让键盘用户
      // Tab 得到、能选中。这个 hook 只在 DOM 节点真正创建时触发一次。
      dayCellDidMount={!timeMode ? (arg) => {
        arg.el.tabIndex = 0;
        arg.el.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectDay(dayKey(arg.date));
          }
        });
      } : undefined}
      // 周/日视图的表头格默认不响应点击（`dateClick` 只覆盖格子本身/全天带/
      // 小时槽，不覆盖表头——那是 FullCalendar 的"导航链接"功能，这里没开
      // navLinks），也没有默认的 tabindex/键盘语义，这里手动补齐点击 +
      // Enter/Space，跟月格 dayCellDidMount 同一条思路。
      dayHeaderDidMount={timeMode ? (arg) => {
        arg.el.tabIndex = 0;
        arg.el.addEventListener('click', () => onSelectDay(dayKey(arg.date)));
        arg.el.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectDay(dayKey(arg.date));
          }
        });
      } : undefined}
      // 标题截断之后还能悬停看全文——`.fc-event-title`/`.fc-timegrid-event`
      // 都会截断长标题，FullCalendar 默认不给事件块挂 title，两档视图共用
      // 同一个钩子补回来（task-5 I3 同一条教训，这次不能再丢一次）。
      eventDidMount={(info) => {
        info.el.title = info.event.title;
      }}
      // 月格里那一条：**左边标题、右边时刻**（照滴答清单）。只在月视图接管
      // 渲染——周/日视图的块本来就画在时间轴的对应高度上，再写一遍时刻是同一
      // 句话说两遍。
      //
      // 全天的那些不写时刻（`isAllDay` 那条判据：本地时分秒毫秒全为 0），
      // 写出来会是一排「00:00」，那是这个应用表达「整天」的方式，不是真的
      // 约在零点。四种标记（重复影子/纪念日/专注/打卡）同样不写——它们的
      // id 带 kind 前缀，这里靠那个前缀认出来。
      /**
       * **窄屏的月格里不画标题，只画时刻。**
       *
       * 实测（390×844，全站扫描第二遍）：月格宽约 50px，标题被裁掉 98%——
       * 屏幕上是「给 14:30」「写 15:30」，那一个字是标题的第一个字，说明不了
       * 任何事。这个文件自己在 `maxVisible` 那儿就记着同一个坑（「看板 217px
       * 列宽『买.』」），只是没往月格上想。
       *
       * 时刻反而是有信息量的那一半：同一天三条事，时刻各不相同，认得出是哪条；
       * 首字一律是噪音。没有时刻的（整天的事、纪念日、打卡）画一个点，让格子
       * 里「这天有事」这件事仍然看得见。
       *
       * **标题不从 DOM 里拿掉**，只是视觉隐藏（`.ink-sr-only`）：读屏还是要
       * 念出这条事叫什么，手机上更依赖读屏。
       *
       * 判据用 `useIsNarrow()`（767px），跟侧栏收进抽屉、详情面板变浮层是
       * 同一个断点，不另挑一个数。
       */
      eventContent={!timeMode ? (arg) => {
        // `chipTime` 是造事件时算好的（见上面），不是这里读 `event.start`——
        // 全天事件的 `start` 被 FullCalendar 抹掉了时间部分。
        const time = arg.event.extendedProps.chipTime as string | null | undefined;
        if (narrow) {
          return (
            <div className="ink-cal-chip ink-cal-chip-narrow">
              <span className="ink-sr-only">{arg.event.title}</span>
              {time
                ? <span className="ink-cal-chiptime ink-cal-chiptime-narrow">{time}</span>
                : <span className="ink-cal-chipdot" aria-hidden="true" />}
            </div>
          );
        }
        return (
          <div className="ink-cal-chip">
            <span className="fc-event-title">{arg.event.title}</span>
            {time && <span className="ink-cal-chiptime">{time}</span>}
          </div>
        );
      } : undefined}
      // 接不接外面拖进来的东西。**跟能不能拖动已有事件是两件事**：
      // `editable` 管的是格子里那些事件块，`droppable` 管的是从
      // 「安排任务」那一栏拖进来的行——没接 `onScheduleTo` 就整个不接，跟
      // `canDrag` 那条「没给回调就不该有手感」是同一条规矩。
      droppable={!!onScheduleTo}
      // 用 `drop` 不用 `eventReceive`：后者会让 FullCalendar 自己**先造一个
      // 事件塞进去**，而这个日历的事件全部是从 `days` 算出来的（唯一数据源）
      // ——凭空多出来的那一个不在 `days` 里，下一次重渲染就消失，屏幕上是
      // 「拖进去、闪一下、没了」。`drop` 只报「落在哪儿」，写回数据之后由
      // SSE→重渲染把它正常画出来，一条数据路径。
      // （对应地，外部元素那侧的 `eventData` 返回 `{ create: false }`，
      //   见 CalendarView 里挂 Draggable 的地方。）
      drop={(info) => {
        if (!onScheduleTo) return;
        const id = info.draggedEl.dataset.taskId;
        if (!id) return;
        onScheduleTo(id, info.date, info.allDay);
      }}
      eventDrop={(info: EventDropArg) => {
        if (timeMode) {
          if (!onDropOnSlot) return;
          const start = info.event.start;
          if (!start) { info.revert(); return; }
          const key = dayKey(start);
          const hour: number | 'allday' = info.event.allDay ? 'allday' : start.getHours();
          // 拖回原地不发回调——跟月视图 eventDrop 同一条理由（task-5 M2）：
          // FullCalendar 自己在"没有真的移动"时根本不会触发 eventDrop
          // （读过 @fullcalendar/interaction 源码），这里留着是防御性写法，
          // 不把"库不会给这种输入"这个假设焊死进代码。
          const oldStart = info.oldEvent.start;
          const wasNoop = !!oldStart && dayKey(oldStart) === key
            && info.oldEvent.allDay === info.event.allDay
            && (info.event.allDay || oldStart.getHours() === hour);
          if (wasNoop) { info.revert(); return; }
          onDropOnSlot(info.event.id, key, hour);
          return;
        }
        if (!onDropOnDay) return;
        const oldStart = info.oldEvent.start;
        const newStart = info.event.start;
        if (!oldStart || !newStart) { info.revert(); return; }
        const oldKey = dayKey(oldStart);
        const newKey = dayKey(newStart);
        if (newKey === oldKey) { info.revert(); return; }
        onDropOnDay(info.event.id, newKey);
      }}
    />
  );

  // 两档各包一层固定高度的壳（`min(76vh, 960px)`——24 行 ×
  // 40px 的完整内容高度是 960px，跟退役前 CalendarHours.tsx 的
  // `.ink-calh-scroll` 同一个数字，视觉密度延续），FullCalendar 的
  // `height="100%"` 撑满这个容器，24 小时的内容超出时它自己的时间轴主体
  // （不是这层外壳）内部滚动——`scrollTime` 滚的就是那个内部滚动条。
  //
  // **月视图也包一层**（`.ink-cal-monthgrid`，同一个高度值）：以前是
  // `height="auto"`，六行按内容各自高矮不一、画完就停，底下留一大片空纸。
  // 两个类名分开写而不是共用一个，是因为它们要的不是同一件事——周/日那层
  // 内部会滚（24 小时装不下），月那层不滚（六行等分，装不下的走 `+N`）。
  return (
    <div ref={rootRef}>
      <div className={timeMode ? 'ink-cal-timegrid' : 'ink-cal-monthgrid'}>{calendar}</div>
    </div>
  );
}
