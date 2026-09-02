import { dayKey, weekStartOf } from './calendar.js';
import type { WeekStart } from '../types.js';

/**
 * 年度热力图的格子布局——仿滴答清单的「年度热力图」（「总览你一年的专注
 * 情况，色块深浅代表每天专注时间的长短」）。
 *
 * **纯布局，不认识专注也不认识打卡**：给它「哪天是多少」，它排出一张
 * 一周一列的网格。专注统计和习惯概览共用同一份——两处各画一张 53×7 的网格，
 * 「一年从哪天算起、周几在第几行」这种事迟早排出两种样子。
 */

/** 一年多少天。365 而不是 366：闰年少画一格，比每年重算一次「今天往前一年
 *  是哪天」（还要处理 2/29 那种没有对应日的情况）省事，而热力图看的是形状，
 *  不是精确的天数。 */
export const HEATMAP_DAYS = 365;

/** 深浅分几档（不含「没有」那档）。跟 GitHub 那种热力图一样四档，再多眼睛
 *  分不出来。 */
export const HEATMAP_LEVELS = 4;

export interface HeatCell {
  /** 本地 `YYYY-MM-DD`，同时是 React key 和查值用的键。 */
  key: string;
  date: Date;
  /** 落在这一年窗口之外——第一列前面那几格（补齐到周首）用它占位。
   *  **要画成空白而不是「值为 0」**：一个还没开始统计的日子跟一个真的什么
   *  都没做的日子，在图上不该长得一样。 */
  pad: boolean;
}

/**
 * 一周一列，从「一年前那天所在周的周首」排到今天。
 *
 * 第一列开头那几格可能落在窗口之外（`pad: true`）——**补齐到周首是必须的**，
 * 不然每一行代表的星期几会随「今年今天是周几」变，横着扫一行看不出规律。
 *
 * **周首读设置**（`Settings.weekStart`），走 `calendar.ts` 那唯一的 `weekStartOf`。
 * 这儿原来抄了一份写死周一的 `mondayOf`，注释还写着「跟 `calendar.ts` 同一条」
 * ——那句话当时就不成立了。后果比统计那处轻（错的是每行代表周几，不是一个
 * 数字），但形状一样：同一个应用里两个「一周从哪天开始」。
 */
export function heatmapWeeks(now: Date, weekStartsOn: WeekStart = 1, days = HEATMAP_DAYS): HeatCell[][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  const start = weekStartOf(first, weekStartsOn);

  const cols: HeatCell[][] = [];
  const cur = new Date(start);
  while (cur.getTime() <= today.getTime()) {
    const col: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + i);
      col.push({
        key: dayKey(date),
        date,
        pad: date.getTime() < first.getTime() || date.getTime() > today.getTime(),
      });
    }
    cols.push(col);
    cur.setDate(cur.getDate() + 7);
  }
  return cols;
}

/**
 * 一个值该染第几档（0 = 没有，1..`HEATMAP_LEVELS` 由浅到深）。
 *
 * 按 `max` 线性分档，不按绝对数值：一天专注 25 分钟的人和一天 4 小时的人，
 * 看到的都该是一张有深浅的图——写死阈值会让前者整年全是最浅那档。跟
 * `FocusStats` 里柱子高度按峰值算是同一条。
 */
export function heatLevel(value: number, max: number): number {
  if (!(value > 0)) return 0;
  if (!(max > 0)) return 0;
  // Math.ceil 让「有值」至少是第 1 档——`value/max` 很小时向下取整会得到 0，
  // 那格就跟「什么都没做」画得一样了。
  return Math.min(HEATMAP_LEVELS, Math.ceil((value / max) * HEATMAP_LEVELS));
}

/**
 * 每一列头上标不标月份：这一列的第一天跨进新的月份就标。给 53 列一个横向
 * 参照——没有它，一张 53 列的网格没法定位到「大概是几月」。
 *
 * **两个标签挨在一起时，丢掉前面那个。** 一列只有 13px（10px 格 + 3px 间隙），
 * 而「12月」这种标签有二十来像素宽，隔一列的两个标签会在屏幕上叠成一坨——
 * 实测「8月」和「9月」叠出来是「8月月」。这不是罕见情况：窗口从月中开始，
 * 第一个月往往只占一列，**每年都会撞上**。
 *
 * 丢前面那个而不是后面那个：撞车的总是「只占一两列的那个残月」和它后面那个
 * 完整的月，留下残月会让图上出现「8月 …… 10月」这种断档，看着像九月的数据
 * 没了；留后面那个，第一列不标，剩下的十一个月一个不少。
 */
export function monthLabels(cols: HeatCell[][]): Array<string | null> {
  let prev = -1;
  const out: Array<string | null> = cols.map((col) => {
    const m = col[0].date.getMonth();
    if (m === prev) return null;
    prev = m;
    return `${m + 1}月`;
  });
  // 回头扫一遍消碰撞。**必须是回头扫**：能不能标要看后面那个标签在哪儿，
  // 一边生成一边判断只知道前面的。
  let lastAt = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === null) continue;
    if (i - lastAt < 2) out[lastAt] = null;
    lastAt = i;
  }
  return out;
}
