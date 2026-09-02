import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Draggable } from '@fullcalendar/interaction';
import type { Countdown, Task, WeekStart } from '../types.js';
import { assertExhaustiveMode, calendarAnchor, calendarDays, dayKey, shiftAnchor, type CalMode } from '../lib/calendar.js';
import { hasTimeBlock } from '../lib/taskView.js';
import type { CalendarPrefs } from '../lib/calendarPrefs.js';
import { insideEl, pointerXY } from '../lib/schedulePanel.js';
import { reschedulePatch, shiftTimesPatch } from '../lib/reschedule.js';
import { CalendarGrid } from './CalendarGrid.js';
import { CalendarAgenda } from './CalendarAgenda.js';
import { CalendarFull } from './CalendarFull.js';
import { CalendarYear } from './CalendarYear.js';
import { SchedulePanel } from './SchedulePanel.js';
import { TaskGrid, type GridWiring } from './TaskGrid.js';

/**
 * 下面当天列表本来就是一个 `TaskGrid`，`Props` 直接 `extends GridWiring`
 * （TaskGrid.tsx）——不再逐个手写 `onPatch`/`selection`/`focusMinutes`……
 * 这些字段。以前这里手写过一份副本，`GridWiring` 加字段时要记得回来跟着补
 * 两处（`Props` 声明 + 下面转发那行），漏一次就是一次静默丢字段：先是
 * `selection`/`onSelectionChange`/`editRequestId`/`onEditRequestHandled`
 * 四个（TypeScript 对 JSX spread 不做多余属性检查，`gridWiring` 摊开传进来
 * 照样编译通过，只是这几个字段到不了这里），补上没多久又漏了新加的
 * `focusMinutes`——见 final-review.md I2。现在 `wiring` 是从 `Props` 上摘下来
 * 的剩余对象，下面 `<TaskGrid {...wiring} .../>` 整体转发，新增字段自动跟着
 * 到达，没有第二处要记得改。
 */
interface Props extends GridWiring {
  tasks: Task[];
  /** 倒数纪念日。给了才可能在格子上出现——真显不显示看下面那个开关。 */
  countdowns?: Countdown[];
  /** 日历自己的两个显示开关（仿滴答清单的「显示设置」）。**受控**——存
   *  localStorage 那半在 App 里，跟 density/groupSort 同一个形状。 */
  prefs: CalendarPrefs;
  onPrefs: (next: CalendarPrefs) => void;
  /** 在选中的那一天新建任务——只把日期交出去，表单还是顶上那一个。
   *  不给就不显示那颗按钮。 */
  onComposeOn?: (dayKey: string) => void;
  /** 「安排任务」那一栏里的 ↑/↓ 手动排序。契约同 `TodayView.onReorder`。
   *  不给就不画那两颗按钮，那一栏本身照常。 */
  onReorder?: (pairs: Array<{ id: string; order: number }>) => Promise<unknown>;
  /** 一周从周几开始（设置里的「每周开始于」）。1=周一（默认），0=周日。
   *  月/周格的起始列、月视图的星期表头都靠它。 */
  weekStart?: WeekStart;
  /** 格子里写不写农历/节气、标不标「休 / 班」（设置里那两个开关）。
   *  **只给月和周/日两档**：年视图一天十来个像素，写不下也没人在那个尺度上
   *  找节气；日程视图每一行本来就有完整日期。 */
  showLunar?: boolean;
  showHolidays?: boolean;
}

/** 这条任务落在本地哪一天；算不出锚点就是「不落在任何一天」。
 *
 *  **判据是 `calendarAnchor`，跟月格自己分桶用的是同一份**——这里原来叫
 *  `dueDayKey`，自己解 `t.due`，注释还写着「跟 `calendarDays` 同一条口径」。
 *  那句话在时间段（`startAt`+`endAt`）加进来之后就是假的了：`calendarDays`
 *  早就改成按 `calendarAnchor` 落格，这份副本没跟上。后果是一场只有时间段、
 *  没有截止时间的会**画在月格里，点开那天的列表却是空的**——同一屏上两句
 *  互相矛盾的话。不再留第二份实现，直接调那一份。 */
function anchorDayKey(t: Task): string | null {
  const at = calendarAnchor(t);
  return at ? dayKey(at) : null;
}

/** 选中日期的展示文案，不带年份——跟格子里 `.ink-cal-daynum` 只显示日号
 *  同一个「反正就在当前翻到的这页里」的假设。 */
function dayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${m}月${d}日`;
}

/**
 * 「日历」：月格/周格 + 点开某一天的当天列表，规格第 401 行。这一批十种视图
 * 里最后一个要接进导航的。
 *
 * 锚点月份、月/周模式、选中哪一天都是**这个组件自己的** `useState`，不提到
 * `App`——`views.tsx` 没给这个视图开 `keepMounted`，切走的时候这整棵子树会
 * 真的卸载（不是 `hidden`），状态跟着归零，下次点进来重新从「当月、月视图、
 * 没选中哪天」开始。这是故意的（brief 明确说「切走再回来重置到当月」），
 * 也是为什么这份状态不能直接摆在 `App` 组件里：`App` 本身不会因为切视图而
 * 卸载，摆在那儿的话状态会一直活着，回到日历时还停在离开前翻到的那一页。
 */
export function CalendarView({ tasks, countdowns, prefs, onPrefs, onComposeOn, onReorder, weekStart = 1, showLunar, showHolidays, ...wiring }: Props): ReactNode {
  // 这个组件自己只用得到 now/onPatch 两个：now 给锚点的初始值和月历表头，
  // onPatch 给拖拽改期。剩下的（lists/onEditTask/onDelete/proposals/
  // selection/onSelectionChange/editRequestId/onEditRequestHandled/
  // focusMinutes）自己不看，原样留在 `wiring` 里，靠下面 `{...wiring}`
  // 整体转发给当天列表——**不要**在这里把它们也解构出来单独变量再单独传，
  // 那样又会变回「逐个手写」，新字段还是会在这一步漏掉。
  const { now, onPatch } = wiring;
  const [anchor, setAnchor] = useState(now);
  const [mode, setMode] = useState<CalMode>('month');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 整分支审查 D：实测过的坑——月视图选中 8/25（当天列表出现）→ 点「日」→
  // 标题变成「8月19日 周三」（锚点那天，不是选中那天），刚出现的当天列表
  // 凭空消失（下面 `selectedKey && days.some(...)` 那道派生守卫算出
  // selectedKey 不在新一档的 `days` 里，是对的：不该显示陈旧内容）。缺的是
  // 切档时把 `anchor` 本身同步到 `selectedKey`——用户点「日」/「周」的意图
  // 九成是「看我刚点的那天」，不是「看锚点碰巧停在哪天」。`selectedKey` 是
  // `YYYY-MM-DD` 本地日期 key（`dayKey()`/`calendarDays()` 那一套口径，见
  // calendar.ts），本地分量构造成 Date，不走 `new Date(selectedKey)`
  // （那是 UTC 解析，东八区会差一天，同一条教训见 onDropOnDay/onDropOnSlot
  // 的注释）。没有 selectedKey 时什么都不做，锚点照旧——不是每次切档都把
  // 锚点拉到 `now`，那样会覆盖用户刚翻的页。
  // **`days.some(...)` 这道守卫是关键**：只有「选中的那天此刻真的在屏幕上」
  // 才把锚点同步过去。少了它，一个已经被翻页翻走、下面那份当天列表早就不
  // 渲染了的陈旧 selectedKey，会在下一次切档时把用户刚翻的页原样撤销：
  // 月视图选 8/25 → 点「下一页」到 9 月（列表按第 190 行那道派生守卫正确地
  // 藏了起来，但 selectedKey 本身还在）→ 点「周」，标题跳回 8 月 25 日那一周。
  // 三条路（上一页/下一页、今天、切档）都汇进这一个函数，守卫放在这里一次
  // 覆盖全部——`onToday` 那边曾经单独补过一句 `setSelectedKey(null)` 来治
  // 「点完今天再切档又跳回去」，那只是这同一个 bug 在其中一条路上的症状，
  // 补在调用方等于放着另外两条不管。
  const handleModeChange = (m: CalMode) => {
    setMode(m);
    if (selectedKey && days.some((d) => d.key === selectedKey)) {
      const [y, mo, d] = selectedKey.split('-').map(Number);
      setAnchor(new Date(y, mo - 1, d));
    }
  };

  // 月格/周格是只读展示，不需要感知「正在编辑」——真正会因为并发改写而需要
  // 保命的卡片只出现在下面的当天列表，那是一个真正的 TaskGrid，自己履行
  // sections(editing) 契约，见下面。
  const days = calendarDays(tasks, anchor, mode, {
    ...prefs,
    weekStart,
    // 开关关着时传空数组，不是传全部让下层去判——`calendarDays` 那一层只认
    // 「给了就显示」，一个数据一个开关两处表达同一件事迟早对不上，见那边
    // CalendarOpts.countdowns 的注释。
    countdowns: prefs.showCountdowns ? countdowns : undefined,
  });

  // 拖到某一天改期：CalendarGrid 只转发 (任务 id, 目标日期的 key)，`due`
  // 怎么算是这一层的事——时刻原样保留，跟 `dayKey`/`agenda.ts` 的 `endOfDay`
  // 同一套本地墙钟算术，不走 `toISOString().slice(0,10)` 那条会在东八区差
  // 一天的路。CalendarGrid 落到这里之前已经确认过这个 id 在 `days` 里（见
  // 它的 onDrop 守卫），而月格按 `calendarAnchor` 落格，所以正常情况下锚点
  // 一定算得出来——下面那句 `if (!old) return` 只是防御一次并发竞态（拖到
  // 一半这张卡被删了 / 时间被并发清空），不是要给「没有旧时刻」编一个默认
  // 时刻：以前这里有个 DEFAULT_DROP_HOUR 常量兜底那种情况，final-review.md
  // M2 指出那条分支在生产里走不到（落不进格子的任务根本不会到这儿，唯一能
  // 走到它的路径是外来拖拽——I3 已经把那条路径堵在 CalendarGrid 那一层），删掉。
  //
  // **判据是锚点，改的是整条。** 这里原来写 `if (!t?.due) return`，配一句
  // 「月格只按 `due` 落格」——时间段（`startAt`+`endAt`）加进来之后那句话就
  // 不成立了。后果是一场只有时间段、没有截止时间的会**在月视图上拖不动，
  // 而且是静默的**：卡片跟着手指走，松开弹回原处，没有任何一处说为什么。
  // 现在按锚点算位移，`shiftTimesPatch` 把时间段和 `due` 一起挪、间隔不变
  // ——跟 ⋯ 菜单的「改期」和批量「推迟一小时」共用那一份。
  // **提醒不跟着挪**（界面上那句 hint 说了：「提醒时间不会跟着挪，还在原来那一刻
  // 响」），而 ⋯ 菜单里的「改期」（`lib/reschedule.ts` 的 `reschedulePatch`）
  // **是跟着挪的**——同一个「换一天」，两条路两种结果。记在这儿，免得下一个人
  // 当成分叉去「统一」，或者像我一样从头推一遍。
  //
  // **两种都不是普遍正确的**，取决于那条提醒是什么意思：
  // - 「截止前一小时提醒我」——跟着 due 走。不挪的话，一条拖到下周的任务这周
  //   就会响一次，而那天它已经不到期了。
  // - 「周一早上提醒我准备一下」——它钉在周一，跟 due 挪去哪儿无关。挪了反而错。
  //
  // 这个应用的数据模型站在后者那边（AGENTS.md：`due` 和 `reminders` 各管各的，
  // due 决定过期与否、reminders 决定响不响），所以这条路不挪是守模型的；
  // `reschedulePatch` 挪，是因为那颗按钮的语义是「整条往后推一推」。
  // 真要动，得先决定「一条提醒到底是不是 due 的附属」——那是产品判断，不是
  // 这一层能顺手改的。
  const onDropOnDay = (taskId: string, key: string) => {
    const t = tasks.find((x) => x.id === taskId);
    const old = t ? calendarAnchor(t) : null;
    if (!t || !old) return;
    const [y, m, d] = key.split('-').map(Number);
    const at = new Date(y, m - 1, d, old.getHours(), old.getMinutes(), old.getSeconds(), old.getMilliseconds());
    onPatch(taskId, shiftTimesPatch(t, at.getTime() - old.getTime()));
  };

  // 拖到小时格（周/日视图）改期/改全天：跟 onDropOnDay 不是同一套算法——
  // 这里不用去找旧任务、也不用保留旧的时分秒，因为目标小时本身就是新时刻的
  // 一部分，拖到哪个格子就该落在哪个时刻，分秒毫秒统一归零；拖到全天带就是
  // 那天零点（跟 isAllDay 的判定口径一致：时分秒毫秒全为 0 才算全天）。
  // 同一套本地墙钟算术（`new Date(y, m-1, d, h)`），不走
  // `toISOString().slice(0,10)` 那条会在东八区差一天的路——跟上面 onDropOnDay
  // 同一条教训。CalendarHours 落到这里之前已经确认过这个 id 在 `days` 里、
  // 且目标格跟原来的格子不同（见它自己的 dropHandlers 守卫），这里不用
  // 重复找任务、也不用判断「有没有变化」。
  //
  // 修复轮 1 · M-3：拖到 0 点那个小时格，算出来的 due 是那天零点——`isAllDay`
  // （`calendar.ts`）把「本地时分秒毫秒全为 0」判成全天，跟拖到全天带算出来
  // 的时刻**完全没法区分**。后果是拖到 00:00 格的任务下一次渲染会跑去全天带，
  // 00:00 这个小时槽因此变成一个放不进任何东西的死格子——这不是这次改动
  // 引入新 bug，是 Task 1 `isAllDay` 那条 `ponytail:` 注释早就承认的启发式
  // 天花板（`Task` 没有独立的 `allDay` 字段，天花板在数据模型这一层，不在
  // 这个函数），这次「分秒毫秒归零」的算法只是把它从一个抽象的「有 0 点整
  // 的任务会被误判」变成了一个具体的、真的点得到的格子。**不在这里修数据
  // 模型**（那是另一批的事），只把它从「没人知道的意外」钉成「写明的设计」
  // ——`App.test.tsx` 里有一条测试钉住这个行为：
  // 拖到 0 点格，任务确实出现在全天带，不出现在 0 点那一格。
  //
  // **有时间段的走另一条：挪那场会，不写 `due`。** 这里原来无条件
  // `onPatch(id, { due })`——一场 09:00-12:00 的会拖到 15:00 那一格，写进去的是
  // `due = 15:00`，而时间段原地不动；落格看的是 `startAt`（`calendarAnchor`），
  // 于是它**当场弹回 09:00**，屏幕上等于什么都没发生，只是悄悄多了一个他没说过
  // 的截止时间。这是这一族里最坏的一处：另外几处只是不动，这一处是「看着没动、
  // 其实写坏了」。
  //
  // **全天带对有时间段的不接**：拖到那条带子上唯一说得通的写法是把
  // `startAt`/`endAt` 清掉（「这件事不再是几点到几点」），而那是在一次没有确认、
  // 事后看不出来的拖拽里**丢掉信息**。跟四象限横轴「拖了不改期」是同一条既有
  // 约定（`lib/cells.ts`）：没有一个「对」的值可以写的时候，不写。要把一场会
  // 变成全天的，清空表单里那两个时刻——那条路是明说的。
  const onDropOnSlot = (taskId: string, key: string, hour: number | 'allday') => {
    const [y, m, d] = key.split('-').map(Number);
    const t = tasks.find((x) => x.id === taskId);
    if (t && hasTimeBlock(t)) {
      if (hour === 'allday') return;
      const start = new Date(y, m - 1, d, hour);
      onPatch(taskId, shiftTimesPatch(t, start.getTime() - Date.parse(t.startAt as string)));
      return;
    }
    const due = hour === 'allday' ? new Date(y, m - 1, d) : new Date(y, m - 1, d, hour);
    onPatch(taskId, { due: due.toISOString() });
  };

  /**
   * 从「安排任务」那一栏拖进来一条**没有日期**的任务，给它排上时间。
   *
   * **跟 `onDropOnDay` 不共用**：那一个保留原来的时刻（它处理的是「已经排好
   * 的，换一天」），而拖进来的这条压根没有原来的时刻。也跟 `onDropOnSlot`
   * 不共用：那一个只在周/日视图有，而这条路三档都要走。
   *
   * 落成什么时刻：
   * - 全天（月格、周/日的全天带）→ **那天零点**。这个应用没有独立的 `allDay`
   *   字段，「本地时分秒毫秒全为 0」就是它表达全天的方式（`calendar.ts` 的
   *   `isAllDay`），跟 `onDropOnSlot` 拖到全天带算出来的完全一致。
   * - 落在某个小时格 → 就是那个时刻，分秒毫秒归零。理由同 `onDropOnSlot`：
   *   拖到哪个格子就该落在哪个时刻，多出来的秒是噪音。
   *
   * `new Date(y, m-1, d, h, min)` 走本地墙钟，不碰 `toISOString().slice(0,10)`
   * 那条在东八区会差一天的路——跟这个文件里另外两个落点函数同一条教训。
   */
  const onScheduleTo = (taskId: string, at: Date, allDay: boolean) => {
    if (Number.isNaN(at.getTime())) return;
    // **有时间段的按时间段整体挪，不写 `due`。** 正常情况下这一栏里不会有这种任务
    // （`unscheduled` 已经把 `hasTimeBlock` 的排掉了，理由在那个函数的注释里），
    // 这一支是防线：少了它，一条有时间段的任务被拖进来时**看起来毫无反应**——
    // 只写 `due` 而锚点仍是 `startAt`，事件一动不动，任务却悄悄多了个没人要的
    // 截止日期。同一个文件上面的 `onDropOnSlot` 早就这么分了，这里跟它对齐。
    const t = tasks.find((x) => x.id === taskId);
    if (t && hasTimeBlock(t)) {
      const start = allDay
        ? new Date(at.getFullYear(), at.getMonth(), at.getDate())
        : new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
      onPatch(taskId, shiftTimesPatch(t, start.getTime() - Date.parse(t.startAt as string)));
      return;
    }
    const due = allDay
      ? new Date(at.getFullYear(), at.getMonth(), at.getDate())
      : new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
    onPatch(taskId, { due: due.toISOString() });
  };

  /**
   * 把「安排任务」那一栏里的每一行变成 FullCalendar 认的**外部可拖元素**。
   *
   * `Draggable` 要的是「一个容器 + 一个 itemSelector」，它自己在容器上做事件
   * 委托——所以行怎么渲染、有多少行、换没换分组轴，这里都不用管，`SchedulePanel`
   * 那边也不用认识日历。
   *
   * **`eventData` 返回 `{ create: false }`** 是关键：不加的话 FullCalendar 会
   * 在落点上**自己造一个事件**塞进去，而这个日历的事件全部是从 `days` 算出来
   * 的（唯一数据源），凭空多出来的那一个下一次重渲染就没了——屏幕上是「拖进
   * 去、闪一下、消失」。`create: false` 让它只报 `drop`（落在哪儿），事件由
   * 数据写回之后正常长出来。
   *
   * 每次这一栏开合都要重建：`Draggable` 在构造时绑住那个容器 DOM 节点，
   * 栏收起来时节点没了，`destroy()` 必须跟着调用，不然监听器留在文档上。
   */
  /**
   * **反过来那一半：把日历上的一条任务拖回「安排任务」栏 = 取消它的日期。**
   *
   * 拖进去（栏 → 日历）走的是上面那个 `Draggable` + FullCalendar 的 `drop`；
   * 拖出来（日历 → 栏）没有对应的协议可用——落点在 FullCalendar 的盒子外面，
   * 它认不出来，只会把事件弹回原处，能抓到的只有 `eventDragStop` 那一拍的
   * 指针坐标。所以命中判断在这里做：这一栏的 DOM 在这儿，日历没有立场认识它。
   *
   * `dragging` 是「正在拖一条日历上的任务」，`over` 是「指针此刻在这一栏
   * 上」。两个都要：只有 `over` 的话，这一栏在没人拖东西的时候也会因为鼠标
   * 划过而亮起来；只有 `dragging` 的话，拖到一半没有「松手就落这儿」的回答。
   *
   * 落地那一步走 `reschedulePatch(t, 'clear')`——**跟菜单里那条「去掉截止
   * 时间」是同一个函数**，不是在这儿另写一份 `{ due: null }`。同一件事有两条
   * 路的时候，写两份就是等着它们哪天分叉：那边将来要是决定「清日期时把提醒
   * 也清掉」，这边不会自己跟上。（清日期**不连提醒一起清**这个决定本身写在
   * `reschedule.ts` 里，理由也在那儿。）
   */
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const schedRef = useRef<HTMLDivElement | null>(null);

  const onEventDrag = (phase: 'start' | 'stop', taskId: string, at: { x: number; y: number }) => {
    if (phase === 'start') {
      setDragging(true);
      return;
    }
    setDragging(false);
    setOver(false);
    // 落在日历里的那些拖动同样会走到这儿，`insideEl` 为假，什么都不做——
    // 改期是 `eventDrop` 那条路的事。
    if (!insideEl(schedRef.current, at.x, at.y)) return;
    const t = tasks.find((x) => x.id === taskId);
    if (t) onPatch(taskId, reschedulePatch(t, 'clear', now));
  };

  // 拖动过程中跟着指针更新「现在悬在栏上没有」。FullCalendar 拖拽时不会持续
  // 报位置，只好自己在文档上听一路——只在拖的这段时间挂着，松手就摘掉。
  //
  // **听 `mousemove`/`touchmove`，不是 `pointermove`**：FullCalendar 自己的拖拽
  // 引擎就是靠这两个驱动的，跟着它听才保证「它认为在拖」和「我们看到的位置」
  // 是同一串事件。（`pointermove` 那一版在 jsdom 里直接失灵——那儿的
  // `fireEvent.mouseMove` 不派生指针事件，而真浏览器里两个都有，于是这个洞
  // 只在测试里露得出来。）
  useEffect(() => {
    if (!dragging) return;
    const h = (e: MouseEvent | TouchEvent) => {
      const p = pointerXY(e);
      setOver(insideEl(schedRef.current, p.x, p.y));
    };
    document.addEventListener('mousemove', h);
    document.addEventListener('touchmove', h);
    return () => {
      document.removeEventListener('mousemove', h);
      document.removeEventListener('touchmove', h);
    };
  }, [dragging]);
  useEffect(() => {
    const el = schedRef.current;
    if (!el) return;
    const d = new Draggable(el, {
      itemSelector: '.ink-sched-item',
      eventData: () => ({ create: false }),
    });
    return () => d.destroy();
  }, [prefs.showSchedule]);

  // 三档里正文是哪个组件：月是 CalendarGrid 自己的 42 格网格（不用 children，
  // 见 CalendarGrid.tsx 的注释），周/日公用同一个 CalendarFull（task-6：
  // 手写的 CalendarHours 退役，周/日换成 FullCalendar 的 timeGridWeek/
  // timeGridDay——它自己按 `days.length` 认列数，不认 `CalMode`，见
  // CalendarFull.tsx 顶部注释）。逐档列出、不写两路三元，最后一支交给
  // assertExhaustiveMode——新增第四档漏改这里会直接编译不过，见 calendar.ts
  // 里这个函数的文档注释。「周/日点小时格该干什么」这里选的是：跟月格点
  // 某一天一致，点表头/全天带/小时格/「+N」都选中那一天（`CalendarFull` 的
  // `onSelectDay`）——跟 `CalendarGrid` 的 `onSelectDay` 是同一个 setter，
  // 当天列表不用关心是从哪个视图选出来的。
  let calendarBody: ReactNode = null;
  if (mode === 'month') {
    calendarBody = null;
  } else if (mode === 'week' || mode === 'day') {
    calendarBody = (
      <CalendarFull
        days={days}
        anchor={anchor}
        now={now}
        selectedKey={selectedKey}
        onSelectDay={setSelectedKey}
        // 点格子里的任务 → 打开右边那一栏。跟当天列表、日程视图走同一个回调
        // （`wiring.onOpenDetail`），所以「在哪儿点开的」不影响打开的是同一个
        // 东西。
        onOpenTask={wiring.onOpenDetail}
        onDropOnSlot={onDropOnSlot}
        onScheduleTo={onScheduleTo}
        onEventDrag={onEventDrag}
        allHours={prefs.showAllHours}
        weekStart={weekStart}
        showLunar={showLunar}
        showHolidays={showHolidays}
      />
    );
  } else if (mode === 'year') {
    // 年：十二个小月历，一天一格按忙闲上深浅。**不接任何拖拽**——一天只有
    // 十来个像素宽，落点按不准，落错了是一次真实的数据改动。
    calendarBody = (
      <CalendarYear
        days={days}
        anchor={anchor}
        now={now}
        selectedKey={selectedKey}
        onSelectDay={setSelectedKey}
        weekStart={weekStart}
      />
    );
  } else if (mode === 'agenda') {
    // 日程：按天从上往下列，空的那些天不画。同样不接拖拽——这一档里「一天」
    // 是一个标题，不是一块有面积的落点。
    calendarBody = (
      <CalendarAgenda
        days={days}
        now={now}
        selectedKey={selectedKey}
        onSelectDay={setSelectedKey}
        onOpen={wiring.onOpenDetail}
      />
    );
  } else {
    calendarBody = assertExhaustiveMode(mode);
  }

  return (
    // 日历本体和右边那条「安排任务」并排。**栏收起来时这一层还在**——一个
    // 只有一个孩子的 flex 容器不改变任何布局，而让它跟着开合出现/消失，等于
    // 每次开合都把整棵日历子树换一个父节点（React 会卸载重挂），FullCalendar
    // 那侧的滚动位置、当前翻到的页、正在编辑的当天列表全跟着重来一遍。
    <div className="ink-cal-shell">
      <div className="ink-cal-main">
      {/* 显示设置（仿滴答清单日历右上角「···」-「显示设置」里那几档）。
          两个勾选框直接摆出来，不收进一个菜单：一共就两个，收起来要多点两下
          才知道「原来重复任务能在日历上铺开」——这个功能最大的问题本来就是
          没人知道它存在。原生 <label>+<input>，不套 antd Checkbox：那个的
          选中态直接读全局 colorPrimary（群青），而群青在这个界面里是配给制，
          只标 AI 产出，见 theme.ts 顶部 boardLocalTheme 的注释。 */}
      <div className="ink-cal-prefs" role="group" aria-label="日历显示设置">
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={prefs.showDone}
            onChange={(e) => onPrefs({ ...prefs, showDone: e.target.checked })}
          />
          显示已完成
        </label>
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={prefs.showFutureRepeats}
            onChange={(e) => onPrefs({ ...prefs, showFutureRepeats: e.target.checked })}
          />
          显示未来重复周期
        </label>
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={prefs.showCountdowns}
            onChange={(e) => onPrefs({ ...prefs, showCountdowns: e.target.checked })}
          />
          显示纪念日
        </label>
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={prefs.showFocus}
            onChange={(e) => onPrefs({ ...prefs, showFocus: e.target.checked })}
          />
          显示专注记录
        </label>
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={prefs.showCheckins}
            onChange={(e) => onPrefs({ ...prefs, showCheckins: e.target.checked })}
          />
          显示打卡
        </label>
        {/* 只在周/日视图给这一档：月/年/日程压根没有小时这个维度，摆在那儿
            是一个点了不知道会发生什么的开关。 */}
        {(mode === 'week' || mode === 'day') && (
          <label className="ink-cal-pref">
            <input
              type="checkbox"
              checked={prefs.showAllHours}
              onChange={(e) => onPrefs({ ...prefs, showAllHours: e.target.checked })}
            />
            显示全天 24 小时
          </label>
        )}
      </div>

      <CalendarGrid
        days={days}
        mode={mode}
        anchor={anchor}
        now={now}
        selectedKey={selectedKey}
        onSelectDay={setSelectedKey}
        // 点月格里的任务 → 打开右边那一栏，跟周/日视图和当天列表同一个回调。
        onOpenTask={wiring.onOpenDetail}
        onShift={(delta) => setAnchor((a) => shiftAnchor(a, mode, delta))}
        // **只挪锚点，不动选中。** 这里一度还跟着 `setSelectedKey(null)`，用来治
        // 「点完今天再切档，标题又跳回选中那天」——但那是 `handleModeChange` 无条件
        // 信任 selectedKey 造成的，三条路（翻页/今天/切档）都会犯，补在这一个调用方
        // 等于放着「上一页」「下一页」那两条不管。守卫已经移进 `handleModeChange`
        // 本身（见那边的注释），这里就不需要了。
        //
        // 去掉它还顺带修掉一个更贵的副作用：下面那份当天列表是
        // `{selectedKey && …}` 条件渲染的，清掉 selectedKey 会把整棵 `TaskGrid`
        // 卸载，连带 `editingIds`（TaskGrid 本地）和正在编辑的 `draft`（TaskCard
        // 本地）一起没掉——已经在当月、点一下「今天」屏幕上什么都不该变，却把
        // 没保存的编辑悄悄丢了。「回到今天」说的是把视图带回今天，不是清空你的选择。
        onToday={() => setAnchor(now)}
        onModeChange={handleModeChange}
        onDropOnDay={onDropOnDay}
        onScheduleTo={onScheduleTo}
        onEventDrag={onEventDrag}
        weekStart={weekStart}
        showLunar={showLunar}
        showHolidays={showHolidays}
        schedule={{
          open: prefs.showSchedule,
          onToggle: () => onPrefs({ ...prefs, showSchedule: !prefs.showSchedule }),
        }}
      >
        {calendarBody}
      </CalendarGrid>
      {/* 派生守卫（修复轮 1 · C-1 附带的 M-4）：selectedKey 不在当前这批
          days 里就不渲染列表——不是加一份 state 去同步「选中的那天翻页翻走了
          就清空 selectedKey」，`days` 本来就是这一刻权威的可见范围，每次
          渲染直接查一遍最省事，也不会有 state 没同步好的时间差。实测过的
          场景：月视图选中 8/19 → 切日视图 → 点下一页，标题变成 8/20，之前
          下面的列表还留着 8/19 的内容——月视图翻页时这也发生，只是月视图
          一页 42 天，选中的日子多半还在页里，不容易注意到；日视图一页只有
          一天，这种「屏幕上找不到列表说的是哪天」的错位立刻就扎眼。 */}
      {selectedKey && days.some((d) => d.key === selectedKey) && (
        <TaskGrid
          {...wiring}
          // 固定行档，不读全局可切的 `density` state——task-3-brief 要点①。
          // 当天列表的意义是「这天有几件事，一眼扫过去」，行档比卡片更适合
          // 这个目的，没有理由让用户切回卡片，见 App.tsx DENSITY_VIEWS 上面
          // 那段注释。跨列拖拽这里用不上（日历的拖拽是月格→当天列表这个
          // 方向，`CalendarGrid.tsx` 自己接的，不经过 `TaskGrid` 的
          // `onDropTo`），`density="row"` 只影响这份当天列表怎么渲染每一行。
          density="row"
          // 正在编辑的卡留下：这张卡的 due 要是被另一个客户端并发改到了别的
          // 日子，筛选重算不该把编辑框连带草稿一起从当天列表里摘掉——跟
          // App.tsx 'search' 视图的 sections 同一个写法。
          sections={(editing) => [{
            key: selectedKey,
            title: dayLabel(selectedKey),
            tasks: tasks.filter((t) => editing.has(t.id) || anchorDayKey(t) === selectedKey),
          }]}
          empty="这天还空着。下面那颗「在这天新建」可以直接往这天加一条。"
        />
      )}

      {/* 「在这天新建」（仿滴答清单：在日历上点一天就能往那天加一条）。
          在这之前，日历上看出「周四空着」之后想往那天加一件事，得离开日历、
          去顶上开「新任务」、再自己把日期挑成周四——而那个日期你刚刚就是在
          日历上点出来的。
          **只是把日期带过去，不另开一个表单**：建任务这件事全应用只有一个
          入口（顶上那个「新任务」），在这儿再摆一份输入框等于第二份表单，
          两份迟早在字段上长歪。 */}
      {selectedKey && onComposeOn && (
        <button
          type="button"
          className="ink-cal-compose"
          onClick={() => onComposeOn(selectedKey)}
        >在这天新建</button>
      )}
      </div>

      {/* 「安排任务」——所有没日期的任务，拖到左边的格子上就排上时间。
          `schedRef` 挂在外面这层 div 上而不是 `SchedulePanel` 里面：
          `Draggable` 要的是一个**稳定的容器**做事件委托，而面板内部会因为
          换页签/收组整片重画。 */}
      {prefs.showSchedule && (
        <div
          className={`ink-cal-sched${dragging ? ' ink-cal-sched-drop' : ''}${over ? ' ink-cal-sched-over' : ''}`}
          ref={schedRef}
        >
          {/* 拖着一条日历上的任务时才出现的那一句。**不是常驻提示**：这一栏
              平时要回答的是「有哪些还没排期」，多一行说明会一直占着位置去
              解释一个此刻没人在做的动作。 */}
          {dragging && <p className="ink-cal-dropnote">松手 = 取消这条的日期</p>}
          <SchedulePanel
            tasks={tasks}
            lists={wiring.lists}
            now={now}
            onClose={() => onPrefs({ ...prefs, showSchedule: false })}
            onOpen={wiring.onOpenDetail}
            onReorder={onReorder}
          />
        </div>
      )}
    </div>
  );
}
