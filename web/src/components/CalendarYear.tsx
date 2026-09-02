import type { ReactNode } from 'react';
import { dayKey, isoWeek, type CalDay } from '../lib/calendar.js';
import { weekdayHeader } from '../lib/weekday.js';
import type { WeekStart } from '../types.js';

interface Props {
  /** 整年 365/366 天，`calendarDays(tasks, anchor, 'year')` 的产出。 */
  days: CalDay[];
  anchor: Date;
  now: Date;
  selectedKey: string | null;
  onSelectDay: (key: string) => void;
  /** 一周从周几开始。1=周一（默认），0=周日。 */
  weekStart?: WeekStart;
}

/** 表头那七个字。周一开头那份写死，周日开头就是把最后一个挪到最前面——
 *  跟 `CalendarGrid` 那份同一个处理，不另存一份周日开头的表。 */

/**
 * 年视图——十二个小月历（仿滴答清单「年」那一档）。
 *
 * **它回答的问题跟另外几档都不一样**：月/周/日回答「这几天有什么」，年回答
 * **「这一年哪几段忙」**——一屏看完十二个月，有事的日子深、没事的浅，密集的
 * 那几块一眼就出来了。所以格子里不画标题（画不下，也不是重点），只按那天
 * 有几件事上深浅，跟专注统计那张热力图是同一个思路。
 *
 * 点一天跟别处一样：选中它，下面那份当天列表跟着换。**这是这一档唯一的
 * 交互**——年视图上一天只有十来个像素宽，拖拽落点根本按不准，所以不接
 * 任何拖拽（对应地，`CalendarView` 那边也不给它传落点回调）。
 */
export function CalendarYear({ days, anchor, now, selectedKey, onSelectDay, weekStart = 1 }: Props): ReactNode {
  const todayKey = dayKey(now);
  const byKey = new Map(days.map((d) => [d.key, d]));
  // 一年里最忙的那天有几件事——深浅按它归一，不写死阈值。跟 `heatLevel`
  // 同一条理由：一天一件事的人和一天十件事的人，看到的都该是一张有深浅的图。
  const max = days.reduce((n, d) => Math.max(n, d.tasks.length), 0);
  // 跟月视图表头同一个出处（`lib/weekday.ts`）——原来这儿抄了一份只认两档的
  // 轮转，加周六那一档时它会静默当成周一。
  const order = weekdayHeader(weekStart);

  return (
    <div className="ink-year">
      {Array.from({ length: 12 }, (_, m) => {
        const first = new Date(anchor.getFullYear(), m, 1);
        // 这个月的第一格往前补几天，才能让 1 号落在它真正的那一列。
        const lead = (first.getDay() - weekStart + 7) % 7;
        const len = new Date(anchor.getFullYear(), m + 1, 0).getDate();
        // 补齐到整周，最后一行才不会缺格子（缺了的话月与月之间高度不齐）。
        const cells = Math.ceil((lead + len) / 7) * 7;

        return (
          <section className="ink-year-month" key={m}>
            <h3 className="ink-year-name">{m + 1}月</h3>
            <div className="ink-year-head">
              {/* 左上角那一格空着：下面每一行最左边是周数，表头这一列没有对应
                  的东西可写。 */}
              <span className="ink-year-wk" aria-hidden="true" />
              {order.map((w) => <span className="ink-year-dow" key={w}>{w}</span>)}
            </div>
            <div className="ink-year-grid">
              {Array.from({ length: cells / 7 }, (_, row) => {
                // 这一行的第一天，用来算周数。整行都在这个月之外时（补齐出来的
                // 尾行）不画周数。
                const firstOfRow = new Date(anchor.getFullYear(), m, 1 + row * 7 - lead);
                return (
                  <div className="ink-year-row" key={row}>
                    <span className="ink-year-wk">{isoWeek(firstOfRow)}</span>
                    {Array.from({ length: 7 }, (_, col) => {
                      const dayNum = row * 7 + col - lead + 1;
                      if (dayNum < 1 || dayNum > len) {
                        return <span className="ink-year-day ink-year-day-pad" key={col} />;
                      }
                      const date = new Date(anchor.getFullYear(), m, dayNum);
                      const key = dayKey(date);
                      const d = byKey.get(key);
                      const n = d?.tasks.length ?? 0;
                      // 四档深浅（0 = 没有）。`Math.ceil` 让「有事」至少是第 1
                      // 档——向下取整会让一件事的那天跟空白长得一样。
                      const level = n === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
                      return (
                        <button
                          type="button"
                          key={col}
                          className={`ink-year-day${key === todayKey ? ' ink-year-day-today' : ''}${key === selectedKey ? ' ink-year-day-selected' : ''}`}
                          data-level={level}
                          // 一天一个格子，屏幕上只有一个数字——可访问名要把
                          // 「哪一天、几件事」说全，不然读屏读出来是一串裸数字。
                          aria-label={`${m + 1}月${dayNum}日，${n} 件事`}
                          onClick={() => onSelectDay(key)}
                        >{dayNum}</button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
