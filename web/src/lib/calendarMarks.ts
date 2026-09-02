import type { Task } from '../types.js';
import type { CalMark } from './calendar.js';
import { dayKey } from './calendar.js';
import { isHabit } from './habit.js';
import { asArray } from './taskView.js';
import type { FocusSession } from '../types.js';

/**
 * 从任务里挖出「专注记录」和「习惯打卡」两种格子标记——仿滴答清单日历显示
 * 设置里的「显示专注记录」和「显示打卡」。
 *
 * 这两种跟前两种（未来重复周期、倒数纪念日）的区别是**数据就在 `tasks` 里**，
 * 不用另外传：专注记录是 `focusSessions`，打卡是「习惯任务的 `completedAt`」。
 * 所以 `CalendarOpts` 那边它们是两个布尔量，不是两份数据。
 *
 * 纯函数，不读时钟。
 */

export interface MarkWants {
  focus: boolean;
  checkins: boolean;
}

export function activityMarks(tasks: Task[], from: Date, to: Date, want: MarkWants): CalMark[] {
  const out: CalMark[] = [];
  const lo = from.getTime();
  const hi = to.getTime();

  for (const t of tasks) {
    if (want.focus) {
      for (const s of asArray<FocusSession>(t.focusSessions)) {
        const at = Date.parse(s?.startedAt);
        // 坏记录跳过——跟 `focusStats.ts` 的 `validAt` 同一条判据：
        // `data/tasks/` 是手改得到的文件。
        if (Number.isNaN(at) || typeof s.minutes !== 'number' || !(s.minutes > 0)) continue;
        if (at < lo || at > hi) continue;
        out.push({
          kind: 'focus',
          id: `${t.id}:${s.startedAt}`,
          title: t.title,
          start: new Date(at).toISOString(),
          // **专注记录是这个日历上唯一有时长的东西**：它在周/日视图的小时格里
          // 该是一个有高度的块，不是一个点。别的标记都没有 `end`。
          end: new Date(at + s.minutes * 60_000).toISOString(),
          allDay: false,
        });
      }
    }

    if (want.checkins) {
      // 打卡 = 一条习惯任务被完成了。**按天算、恒全天**：`completedAt` 是
      // 「几点几分点的完成」，但打卡这件事的粒度是「这一天做了」——把它画成
      // 一个 23:47 的时刻块，是在暗示一个并不存在的时间安排。
      if (!isHabit(t) || !t.completedAt) continue;
      const at = Date.parse(t.completedAt);
      if (Number.isNaN(at) || at < lo || at > hi) continue;
      out.push({
        kind: 'checkin',
        id: `${t.id}:checkin`,
        title: t.title,
        start: dayKey(new Date(at)),
        allDay: true,
      });
    }
  }
  return out;
}
