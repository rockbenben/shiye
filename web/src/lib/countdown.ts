import { lunarOf, solarFromLunar } from '../../../server/src/chineseDays.js';
import type { Countdown } from '../types.js';

/**
 * 倒数纪念日的「还有几天 / 已经几天」——仿滴答清单的倒数日。
 *
 * **全程按本地日历日算，不按毫秒差。** 「还有几天」是两个日历日之间的差：
 * 今天晚上 23:00 到明天早上 01:00 只隔两小时，但那是「明天」，得是 1 天。
 * 用 `(b - a) / 86400000` 会得到 0，而且碰上夏令时那天还会算出 0.958。
 * 同一条教训见 `calendar.ts` 的 `dayKey` 和 `agenda.ts` 的 `endOfDay`。
 */

export type CountdownKind = 'down' | 'up' | 'today';

export interface CountdownState {
  /** 天数，恒为非负——方向看 `kind`。 */
  days: number;
  /** `down` 还有几天、`up` 已经过去几天、`today` 就是今天。 */
  kind: CountdownKind;
  /** 这一次落在哪一天（每年重复的是「下一个」那一次，否则就是它自己）。 */
  at: Date;
}

/** `YYYY-MM-DD` → 本地那一天的零点。形状不对返回 null。 */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // 2026-02-30 会溢出成 3 月 2 日。服务端校验挡过一道（`countdown.ts` 的
  // `isDateString`），这里再挡一次：`data/countdowns/` 是手改得到的文件，
  // `GET` 不校验里面写的东西，跟这个仓库到处那条兜底同一个理由。
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** 两个本地日历日之间差几天。**按日历日算**，见模块顶部。 */
export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * 每年重复时，从 `now` 看**下一次**是哪天（今天算「下一次」）。
 *
 * 2 月 29 日这种日子：那一年没有 2/29 时落到 2/28——`new Date(y, 1, 29)` 会
 * 溢出成 3 月 1 日，一个「2 月的纪念日」跑到三月去了。跟 `repeat.ts` 里
 * `nextOccurrence` 处理闰日是同一条。
 */
export function nextYearly(month: number, day: number, now: Date): Date {
  const clamp = (y: number): Date => {
    const last = new Date(y, month + 1, 0).getDate();
    return new Date(y, month, Math.min(day, last));
  };
  const thisYear = clamp(now.getFullYear());
  return daysBetween(now, thisYear) >= 0 ? thisYear : clamp(now.getFullYear() + 1);
}

/**
 * 农历每年重复时，从 `now` 看**下一次**是哪天。算不出来返回 `null`。
 *
 * **`from` 存的是公历**，这儿先用 `lunarOf` 问出「它在农历里是几月几号」，
 * 再用 `solarFromLunar` 把那个农历日号换成今年（不够就明年）的公历日。
 * **跟 `server/src/repeat.ts` 的 `lunar-year` 一模一样的做法**——那边也是拿
 * 公历锚点反查农历再换回去。两处同一个套路是有意的：农历的「哪一天」本来
 * 就该从一个确定的公历日推出来，存一个「农历八月十五」的字符串反而要自己
 * 回答闰月怎么办。
 *
 * **两次都要试**（今年、明年）：农历生日在公历上每年漂十几天，今年那个日子
 * 可能已经过去了。`solarFromLunar` 自己负责「那天不存在就截到当月最后一天」
 * 和往返验证（农历也有大小月，「九月三十」在小月那年不存在）。
 *
 * **不设年份闸门**：农历是算出来的（天文算法 + 一张压缩月表），跟法定节假日
 * 那张「发布出来的表」不是一回事——那边有 `holidayYearKnown` 闸门，这边没有。
 * 换不出来（表真到头了）就返回 `null`，调用方按「日期坏了」处理。
 */
export function nextLunarYearly(from: Date, now: Date): Date | null {
  const base = lunarOf(from);
  for (const y of [lunarOf(now).year, lunarOf(now).year + 1]) {
    const solar = solarFromLunar(y, base.month, base.day);
    if (solar && daysBetween(now, solar) >= 0) return solar;
  }
  return null;
}

/**
 * 一条纪念日此刻的状态。日期解析不了返回 `null`——调用方据此把这一条画成
 * 「日期坏了」，不是显示 NaN 天。
 */
export function countdownState(c: Countdown, now: Date): CountdownState | null {
  const day = parseDay(c.date);
  if (!day) return null;
  // 每年重复的永远在倒数（生日、周年）——「已经过去 300 天」对一个每年都来的
  // 日子没有意义，人想知道的是「还有几天」。
  // 农历那一档只在「每年」下成立——不重复的日子是一个固定的公历点，
  // 「距离那天多少天」跟农历没有关系（判据写在 `Countdown.lunar` 上）。
  const at = c.yearly
    ? (c.lunar ? nextLunarYearly(day, now) : nextYearly(day.getMonth(), day.getDate(), now))
    : day;
  // 农历换不出来（月表到头了）跟日期解析不了同一个下场：这一条画成「坏了」，
  // 不显示一个算错的天数。
  if (!at) return null;
  const diff = daysBetween(now, at);
  if (diff === 0) return { days: 0, kind: 'today', at };
  return diff > 0 ? { days: diff, kind: 'down', at } : { days: -diff, kind: 'up', at };
}

/**
 * 排序：**先今天，再倒数（近的在前），最后正数（近的在前）**。
 *
 * 这个顺序就是「哪件事此刻最该被看见」：今天就是今天；还有三天的比还有三百天的
 * 急；而已经过去的那些不催任何人，排在最后、刚过去的在前。日期坏掉的沉到最底，
 * 跟这个仓库到处「解析不了的沉底」同一条。
 */
export function sortCountdowns(rows: Countdown[], now: Date): Countdown[] {
  const rank = (c: Countdown): [number, number] => {
    const st = countdownState(c, now);
    if (!st) return [3, 0];
    if (st.kind === 'today') return [0, 0];
    return st.kind === 'down' ? [1, st.days] : [2, st.days];
  };
  return [...rows].sort((a, b) => {
    const [ga, da] = rank(a);
    const [gb, db] = rank(b);
    return ga - gb || da - db || a.title.localeCompare(b.title, 'zh');
  });
}

export interface CountdownMark {
  id: string;
  title: string;
  /** 落在哪一天（本地零点）。 */
  at: Date;
}

/**
 * `[from, to]` 这段时间里，这些纪念日各落在哪一天——给日历用（仿滴答清单
 * 日历显示设置里的「显示倒数纪念日」）。
 *
 * **每年重复的要按年铺开**：一个 3 月 10 日的生日，翻到明年三月那一页也该
 * 看得见。所以不是「它自己那一天在不在范围里」，而是「范围里跨过的每一年，
 * 那一年的那一天在不在范围里」。范围最多跨两个年份（月视图一页 42 天），
 * 两年都试一遍就够，不用循环。
 *
 * 不重复的就只有它自己那一天。日期坏掉的整条跳过——跟 `countdownState`
 * 返回 null 是同一条兜底。
 */
export function countdownsInRange(rows: Countdown[], from: Date, to: Date): CountdownMark[] {
  const out: CountdownMark[] = [];
  const inRange = (d: Date) => daysBetween(from, d) >= 0 && daysBetween(d, to) >= 0;
  for (const c of rows) {
    const day = parseDay(c.date);
    if (!day) continue;
    if (!c.yearly) {
      if (inRange(day)) out.push({ id: c.id, title: c.title, at: day });
      continue;
    }
    for (const y of new Set([from.getFullYear(), to.getFullYear()])) {
      // 闰日在平年落到 2/28，跟 `nextYearly` 同一条——不夹的话 `new Date(y, 1, 29)`
      // 会溢出到三月，一个「2 月的纪念日」跑到三月那一页去。
      const last = new Date(y, day.getMonth() + 1, 0).getDate();
      const at = new Date(y, day.getMonth(), Math.min(day.getDate(), last));
      if (inRange(at)) out.push({ id: c.id, title: c.title, at });
    }
  }
  return out;
}
