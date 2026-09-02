import type { ReactNode } from 'react';
import { CAL_MODES, CAL_MODE_LABEL, assertExhaustiveMode, type CalDay, type CalMode } from '../lib/calendar.js';
import { CalendarFull } from './CalendarFull.js';
import { weekdayFull, weekdayHeader } from '../lib/weekday.js';
import type { WeekStart } from '../types.js';

interface Props {
  days: CalDay[];
  mode: CalMode;
  anchor: Date;
  now: Date;
  selectedKey: string | null;
  onSelectDay: (key: string) => void;
  onShift: (delta: -1 | 1) => void;
  /** 回到今天所在的那一页。三档共用一个动作，不用按 mode 分——锚点设回
   *  `now`，该显示哪一页由 `mode` 自己算（`CalendarView` 里 days 是从
   *  anchor + mode 派生的）。翻走之后唯一的退路以前是切到别的视图再切回来
   *  （calendar 不在 keepMounted 名单里，重挂时 anchor 会重置成 now），
   *  那条路径没有任何可见的入口。 */
  onToday: () => void;
  onModeChange: (m: CalMode) => void;
  /** 周/日视图的正文（`CalendarHours`）——这个组件只管三档共用的导航行
   *  （翻页/三个模式按钮/标题）和月视图自己的 42 格网格，不认识
   *  `CalendarHours`，也不需要认识：认了就得跟着接 `onDropOnSlot`/
   *  `onSelectDay` 这两个跟月格毫不相干的 prop（`onSelectDay` 这个名字
   *  跟月格自己那个 `onSelectDay` prop 重名，但各是各的——月格的挂在
   *  `CalendarGrid` 自己身上，`CalendarHours` 的那个是它自己的独立 prop，
   *  两者从没混在一起过，见 `CalendarView.tsx` 分别转发的写法）。周/日
   *  两档正文长得一样
   *  （`CalendarHours` 自己按 `days.length` 认列数，不认 `CalMode`），
   *  调用方（`CalendarView`）算好了直接整块传进来，见下面渲染那句
   *  `mode === 'month' ? … : children`——这半是安全的两路三元：不是把
   *  三档人为拆成两支，是「月有自己的正文，另外两档公用调用方给的正文」
   *  这件事本身就只有两种可能，`CalendarView` 那边算 `children` 用的才是
   *  真正需要穷举三档的地方（见 assertExhaustiveMode）。 */
  children?: ReactNode;
  /** 拖到某一天改期。**跟上一批「四象限拖拽不做改期」不矛盾**：四象限横轴是
   * 「紧急/不紧急」，拖成紧急没有唯一答案（后天？三天后？），拖出来反而会
   * 销毁人自己填的真实日期，所以那边选择不做；日历的格子就是一个具体日期，
   * 「拖到 8 月 20 日」的答案唯一，所以这边做。
   *
   * 这一层只转发 `(任务 id, 目标日期的 key)`——不算真正要写回的 `due`：
   * 时分秒怎么保留、没有 `due` 的任务落在哪个默认时刻，是调用方（App.tsx）
   * 的事，跟 `TaskGrid.tsx` 的 `onDropTo` 只转发 `(任务 id, 目标格 key)`、
   * 不算 PATCH 内容同一个分工。**「拖回它本来所在的那一天」不发这个
   * 回调**——见下面 `onDrop` 的实现，跟 `onDropTo` 同一条理由：没有变化的
   * 拖拽不该白白写一次盘。不给这个 prop 时格子不是放置目标，标题也不会
   * 冒出可拖的手感（`draggable`）。 */
  onDropOnDay?: (taskId: string, dayKey: string) => void;
  /** 点月格里的任务 → 打开那一条。原样转发给 `CalendarFull`，这一层不判断
   *  什么是任务什么是标记（那是 CalendarFull 按事件 id 前缀分的）。 */
  onOpenTask?: (taskId: string) => void;
  /** 从「安排任务」那一栏拖进来一条没日期的任务。这一层只往下转发给月视图的
   *  `CalendarFull`——周/日两档的正文是调用方直接给的 `children`，它自己已经
   *  拿到了同一个回调，不经过这里。契约见 CalendarFull 的同名 prop。 */
  onScheduleTo?: (taskId: string, at: Date, allDay: boolean) => void;
  /** 「安排任务」那颗开关：`null` = 这一屏不提供这个功能，整颗不画。 */
  schedule?: { open: boolean; onToggle: () => void };
  /** 一周从周几开始（1=周一，默认；0=周日）。月视图那行星期表头靠它转。 */
  weekStart?: WeekStart;
  /** 日历上一条任务被拖动的两拍，转发给 `CalendarFull`——「拖回安排任务栏
   *  = 取消日期」那条路的中间一段，判断落点是不是那一栏的是 `CalendarView`
   *  （那一栏的 DOM 在它手上）。 */
  onEventDrag?: (phase: 'start' | 'stop', taskId: string, at: { x: number; y: number }) => void;
  /** 格子里写不写农历/节气、标不标「休 / 班」（设置里那两个开关）。
   *  **只给月和周/日两档**：年视图一天十来个像素，写不下也没人在那个尺度上
   *  找节气；日程视图每一行本来就有完整日期。 */
  showLunar?: boolean;
  showHolidays?: boolean;
}

// task-5-brief：月视图正文换成 FullCalendar（CalendarFull.tsx）——「样式怎么
// 守」这件事在最小面上先解决掉，周/日仍然是这个文件自己画（Task 6 的事）。
// 星期名和表头顺序全在 `lib/weekday.ts`——这儿原来存了两份数组、外加一句
// 只认得两档的轮转判断，见那个文件顶部。

/** 各档标题文案。逐档列出、不写两路三元，最后一支交给 `assertExhaustiveMode`
 *  ——新增一档漏改这里会直接编译不过，见 calendar.ts 那个函数的文档注释。
 *
 *  **月/日程/年都是「这是哪一页」那种说法**（`YYYY年M月` / `YYYY年`），跟
 *  滴答清单那个大标题一致；周/日才报具体日期，因为那两档的一页短到一句话
 *  说得完。 */
function headingText(mode: CalMode, anchor: Date, days: CalDay[]): string {
  if (mode === 'month' || mode === 'agenda') {
    return `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
  }
  if (mode === 'year') {
    return `${anchor.getFullYear()}年`;
  }
  if (mode === 'week') {
    const first = days[0]?.date ?? anchor;
    const last = days[days.length - 1]?.date ?? anchor;
    return `${first.getMonth() + 1}月${first.getDate()}日 - ${last.getMonth() + 1}月${last.getDate()}日`;
  }
  if (mode === 'day') {
    return `${anchor.getMonth() + 1}月${anchor.getDate()}日 ${weekdayFull(anchor.getDay())}`;
  }
  return assertExhaustiveMode(mode);
}

/** 月格/周格组件。格子里只放截断的标题行，不是卡片——`TaskGrid` 在这一层
 *  用不上，点开某一天之后的当天列表才用它（见调用方）。 */
export function CalendarGrid({
  days, mode, anchor, now, selectedKey, onSelectDay, onOpenTask, onShift, onToday, onModeChange, onDropOnDay,
  onScheduleTo, schedule, weekStart = 1, showLunar, showHolidays, onEventDrag, children,
}: Props): ReactNode {
  // 月格自己的拖拽提示（挂在日期数字上，不是整张网格）现在是
  // CalendarFull.tsx 的事——那句话是 dayCellContent 渲染出来的
  // .ink-cal-daynum 自己的 title，这里不用再操心。
  return (
    <div>
      {/* 顶上这一行照滴答清单排：**左边是大标题，右边一串控件**。
          原来是「上一页 / 标题 / 下一页 / 今天 / 月 / 周 / 日」七颗一样重的
          按钮挤在一起，标题混在按钮中间——那一行读不出主次，也看不出「现在
          是哪一页」这件事比「怎么翻页」重要。 */}
      <div className="ink-cal-nav">
        <h2 className="ink-cal-heading">{headingText(mode, anchor, days)}</h2>

        <div className="ink-cal-tools">
          {/* 看哪一档。**下拉，不是一排按钮**：档数从三档长到五档之后，一排
              按钮已经比标题还长；滴答那边也是一个下拉。原生 select 不套
              antd——它的选中色直接读 colorPrimary（群青），而群青是配给制。 */}
          <label className="ink-cal-mode">
            <span className="ink-sr-only">看哪一档</span>
            <select
              className="ink-cal-modesel"
              aria-label="看哪一档"
              value={mode}
              onChange={(e) => onModeChange(e.target.value as CalMode)}
            >
              {CAL_MODES.map((m) => (
                <option key={m} value={m}>{CAL_MODE_LABEL[m]}</option>
              ))}
            </select>
          </label>

          {/* 翻页那一组三颗连在一起（滴答那边是一个分段控件）：它们是同一件
              事的三个方向，分开摆会让「今天」看着像另一个功能。 */}
          <div className="ink-cal-pager" role="group" aria-label="翻页">
            <button type="button" aria-label="上一页" onClick={() => onShift(-1)}>‹</button>
            {/* 「今天」不做 disabled：要判断「当前这一页是不是已经包含今天」
                得按 mode 各算一次，而点它的代价本来就是零（已经在今天这一页
                时锚点设回 now，什么都不变）。 */}
            <button type="button" onClick={onToday}>今天</button>
            <button type="button" aria-label="下一页" onClick={() => onShift(1)}>›</button>
          </div>

          {/* 「安排任务」（仿滴答清单，它那边收在日历右上角的「···」里）。
              这里直接摆出来、不收进菜单：这个应用的日历本来就没有那颗「···」，
              为一个开关新造一个菜单层比多一颗按钮贵；而且这一栏最大的问题跟
              「显示未来重复周期」一样——**没人知道它存在**。 */}
          {schedule && (
            <button
              type="button"
              className="ink-cal-schedbtn"
              aria-pressed={schedule.open}
              onClick={schedule.onToggle}
            >安排任务</button>
          )}
        </div>
      </div>

      {mode === 'month' ? (
        <>
          {/* 表头从周几开始跟着设置转，判据在 `lib/weekday.ts`（全仓唯一一份）。 */}
          <div className="ink-cal-weekdays">
            {weekdayHeader(weekStart)
              .map((w) => <div key={w} className="ink-cal-weekday">{w}</div>)}
          </div>
          <CalendarFull
            days={days}
            anchor={anchor}
            now={now}
            selectedKey={selectedKey}
            onSelectDay={onSelectDay}
                  onOpenTask={onOpenTask}
            onDropOnDay={onDropOnDay}
            onScheduleTo={onScheduleTo}
            onEventDrag={onEventDrag}
            weekStart={weekStart}
            showLunar={showLunar}
            showHolidays={showHolidays}
          />
        </>
      ) : children}
    </div>
  );
}
