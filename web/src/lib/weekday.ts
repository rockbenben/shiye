import type { WeekStart } from '../types.js';

/**
 * 星期几的名字，以及「表头该从哪个星期几排起」——**全仓唯一的一份**。
 *
 * 在它之前，同样七个汉字在四个地方各存了一份：`CalendarGrid` 里两份
 * （一份周一开头给月视图表头、一份按 `getDay()` 索引给标题栏，注释还写着
 * 「恰好同一批汉字，不能合并」）、`CalendarYear` 一份、`RepeatFields` 一份。
 * 更要紧的是「表头怎么转」那行判断被抄了两遍：
 *
 * ```
 * weekStart === 0 ? [WEEKDAYS[6]!, ...WEEKDAYS.slice(0, 6)] : WEEKDAYS
 * ```
 *
 * 那是一句**只认得两档**的写法。`WeekStart` 加进周六那一档的时候，它不会报错，
 * 只会把周六静默当成周一——两处一起错，而且错得一模一样，对着看也看不出来。
 * 下面 `weekdayHeader` 是同一件事的通用式，加档不用改它。
 */

/** 按 `Date#getDay()` 索引：0=周日……6=周六。这是「星期几叫什么」的正本。 */
export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 「周三」这种全称。`d` 是 `getDay()` 的值。 */
export const weekdayFull = (d: number): string => `周${WEEKDAY_SHORT[d % 7]}`;

/**
 * 表头七列的名字，从 `weekStart` 那一天排起。
 *
 * 通用式：第 i 列是 `(weekStart + i) % 7`。三档各自的结果——
 * 周一起：一二三四五六日；周日起：日一二三四五六；周六起：六日一二三四五。
 */
export function weekdayHeader(weekStart: WeekStart): string[] {
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(weekStart + i) % 7]);
}
