import type { ReactNode } from 'react';
import type { Task } from '../types.js';
import { calendarAnchor, dayKey, isAllDay, type CalDay } from '../lib/calendar.js';

interface Props {
  /** 这个月的每一天，`calendarDays(tasks, anchor, 'agenda')` 的产出。 */
  days: CalDay[];
  now: Date;
  selectedKey: string | null;
  onSelectDay: (key: string) => void;
  /** 点一条任务：打开它的详情。不给就只是一行字。 */
  onOpen?: (taskId: string) => void;
}

/** 周几，index 是 `Date#getDay()`（0=周日……6=周六）。 */
const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];

const p2 = (n: number) => String(n).padStart(2, '0');

/** 一条任务在这一档左边那一列写什么：有具体时刻写时刻，全天写「全天」。
 *  判据走 `isAllDay` + `calendarAnchor`，跟格子里那一套是同一份——不在这儿
 *  另写一遍「算不算全天」「落在哪一刻」。
 *
 *  **原来这里是 `isAllDay(t) || !t.due`**，于是一场「九点到十二点开会」
 *  （时间段在、截止时间空着）左边这一列写的是**「全天」**——`isAllDay` 明明
 *  已经判它不是全天了（它那段注释写着「把它扔进全天那一条等于把唯一有用的
 *  信息（几点到几点）丢掉」），这一行的后半句 `|| !t.due` 又把它扔了回去。
 *
 *  **只写起点，不写「09:00–12:00」**：这一列是 `flex: 0 0 3.4em` 的定宽
 *  （theme.css），一个区间放不下，为它加宽会牵动每一行；几点到几点在卡片和
 *  行档上都看得到。 */
function timeLabel(t: Task): string {
  if (isAllDay(t)) return '全天';
  const d = calendarAnchor(t);
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : '全天';
}

/**
 * 日程视图——按天从上往下列（仿滴答清单「日程」那一档）。
 *
 * **它跟「接下来」不是一件事**，虽然形状像：「接下来」按「今天/明天/这周/
 * 更远」分组，回答「接下来要干什么」；这一档按**日历上的这个月**逐日列，
 * 回答「这个月是怎么排的」——翻页、跟另外几档共用同一个锚点和同一份筛选，
 * 它是日历的一种看法，不是一个任务去处。
 *
 * **空的那些天不画**。一份从上往下读的清单里，二十几个「这天没有」中间夹着
 * 三条真的安排，是在用留白掩埋内容——格子网格必须画空格（那是网格的结构），
 * 清单不必。
 */
export function CalendarAgenda({ days, now, selectedKey, onSelectDay, onOpen }: Props): ReactNode {
  const todayKey = dayKey(now);
  const withTasks = days.filter((d) => d.tasks.length > 0);

  if (withTasks.length === 0) {
    /**
     * 原来只有半句「这个月还没有排任何事。」——那是一句**描述**，不是一条出路。
     *
     * 出路要说**这一屏此刻做得成的那两件**：翻月份（那两颗的名字是「上一页」/
     * 「下一页」），或者切到「月」那一档去点一天——**不能说「点下面任意一天」**，
     * 因为这句话正是在「一天都没有」时渲染的，下面什么都没有。而「在这天新建」
     * 那颗只在选中某天之后才出现，所以真要给这个月加东西，得先离开这一档。
     *
     * 指路**按名字指，不按方位指**：跟 `SettingsModal.tsx` 里那句「不说『左边的』」
     * 同一条理由——手机上那一排不在「上面」，照着方位找的人在最需要这句话的
     * 那一档里找不到。
     */
    return (
      <p className="ink-empty-note">
        这个月还没有排任何事。换月份按「上一页」/「下一页」；要往这个月里加一条，
        切到「月」那一档点一天，那天上面就会出「在这天新建」。
      </p>
    );
  }

  return (
    <div className="ink-agenda">
      {withTasks.map((d) => (
        <section
          className={`ink-agenda-day${d.key === selectedKey ? ' ink-agenda-day-selected' : ''}`}
          key={d.key}
        >
          {/* 日期那一块：大号的日号 + 右边小小的两行（周几）。点它 = 选中
              这一天，下面那份当天列表跟着换，跟格子里点一天是同一个动作。 */}
          <button
            type="button"
            className={`ink-agenda-date${d.key === todayKey ? ' ink-agenda-date-today' : ''}`}
            aria-label={`${d.date.getMonth() + 1}月${d.date.getDate()}日 周${WEEKDAY_CHARS[d.date.getDay()]}`}
            onClick={() => onSelectDay(d.key)}
          >
            <span className="ink-agenda-num">{d.date.getDate()}</span>
            <span className="ink-agenda-dow">周{WEEKDAY_CHARS[d.date.getDay()]}</span>
          </button>

          <ul className="ink-agenda-list" role="list">
            {d.tasks.map((t) => (
              <li className="ink-agenda-row" key={t.id}>
                <span className="ink-agenda-time">{timeLabel(t)}</span>
                {onOpen ? (
                  <button type="button" className="ink-agenda-title" onClick={() => onOpen(t.id)}>
                    {t.title}
                  </button>
                ) : <span className="ink-agenda-title">{t.title}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
