/**
 * 日历的两个显示开关——仿滴答清单的「显示设置」（它那边一整排：显示已完成 /
 * 显示检查事项 / 显示所有重复周期 / 显示打卡 / 显示专注记录……这里只做真正
 * 改变「日历回答什么」的那两个）。
 *
 * 存 `localStorage`，跟 `density`/`groupSort`/`navModes` 同一类：「这台机器上
 * 我想在日历上看到什么」，不是数据。
 */
export interface CalendarPrefs {
  /**
   * 已完成的任务落不落格。**默认关，这是一次有意的行为变化**——在这之前日历
   * 无条件显示全部有截止时间的任务，包括做完的。日历回答的是「什么时候要做
   * 什么」，做完的是历史；一个月做完三十件事之后，那一页上真正要做的那两件
   * 会被埋掉。想看回来一键就开。
   *
   * **滴答那边这一档默认是开的**（《月视图：每月总结复盘》 教的是
   * 「点击右上角「···」-「显示设置」，**关闭**「显示已完成」即可」——用「关闭」
   * 就说明它本来开着）。这里反过来，理由是上面那句。这行字原来写的是
   * 「滴答清单这一档默认也是关的」，那是句错话。
   */
  showDone: boolean;
  /**
   * 推演不推演未来的重复周期。**默认关。**
   *
   * 这个应用的重复是「完成一条才生成下一条」，所以一条「每周一开例会」在
   * 日历上只有一个格子有它——翻到下个月是空的，而实际上每个周一都有会。
   * 开了之后那些格子上会出现推演出来的影子（点不动、勾不掉，它们还没发生），
   * 判据在 `repeatProjection.ts`。默认关是因为它会让一页凭空多出很多东西，
   * 而多数时候人想看的是「已经排好的这些」。
   */
  showFutureRepeats: boolean;
  /**
   * 在格子上标出倒数纪念日（仿滴答清单的「显示倒数纪念日」）。**默认开。**
   *
   * 跟上面两个不一样：那两个默认关，是因为它们会让一页凭空多出很多东西
   * （所有做完的、所有未来的重复）。纪念日通常只有几条，而它们本来就是
   * 「哪天有什么事」——那正是日历回答的问题，藏起来才需要理由。
   */
  showCountdowns: boolean;
  /**
   * 在格子上标出专注记录（仿滴答清单的「显示专注记录」）。**默认关。**
   *
   * 它是这个日历上唯一**有时长**的东西，在周/日视图的小时格里是一个有高度
   * 的块——那正是「我那天下午到底干了什么」最好的答案。默认关是因为它跟
   * 真正的日程混在一起会很挤：一天四五段番茄，加上本来的任务，一列就满了。
   */
  showFocus: boolean;
  /**
   * 在格子上标出习惯打卡（仿滴答清单的「显示打卡」）。**默认关。**
   *
   * 恒全天：打卡的粒度是「这一天做了」，`completedAt` 里那个几点几分是
   * 「点完成的时刻」，画成时刻块是在暗示一个并不存在的时间安排。
   */
  showCheckins: boolean;
  /**
   * 右边那条「安排任务」栏开着没有（仿滴答清单，它那边收在「···」里）。
   * **默认关**：日历这一屏的主角是格子，一条常驻的侧栏会把它压窄；而这一栏
   * 回答的是「还有什么没排」，那是想起来才会问的一件事。
   *
   * 跟这个接口里另外五个不是同一类东西（那五个是「格子上画什么」，这个是
   * 「屏幕上多不多一栏」），但存法、生命周期、以及「换个设备就该重新决定」
   * 这几点完全一致，为它单开一个 localStorage 键只会多一处要记的地方。
   */
  showSchedule: boolean;
  /**
   * 周/日视图画满 0-24 点，还是只画「真的会安排事的那一段」。**默认关**
   * （只画那一段，`hourBand`：默认 07-23，带外有任务就自己张开到包住它）。
   *
   * 为什么需要这个开关：不开的话，凌晨那几个小时**在屏幕上不存在**，于是也
   * 没法往那儿拖东西——「看不见」和「做不到」被绑成了一件事。band 会为已经
   * 存在的任务张开，但没法为一件**还不存在**的安排张开。这一档就是那个出口：
   * 想把什么排到凌晨三点，先把 24 小时打开。
   *
   * 默认关是因为反过来的代价更大：24 行 × 40px = 960px 塞进一个 600 出头的
   * 容器，一进来就得滚，而滚过去的那七行通常一件事都没有。
   */
  showAllHours: boolean;
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  showDone: false, showFutureRepeats: false, showCountdowns: true, showFocus: false, showCheckins: false,
  showSchedule: false, showAllHours: false,
};

const KEY = 'calendarPrefs';

/** 读不到、坏了、类型不对，一律回默认档。 */
export function getCalendarPrefs(): CalendarPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CALENDAR_PREFS;
    const v = JSON.parse(raw) as Partial<CalendarPrefs>;
    return {
      showDone: v.showDone === true,
      showFutureRepeats: v.showFutureRepeats === true,
      // 这个默认是**开**，所以判据是「明确存了 false 才关」，不是
      // 「=== true 才开」——照抄上面两条会让它变成默认关。
      showCountdowns: v.showCountdowns !== false,
      showFocus: v.showFocus === true,
      showCheckins: v.showCheckins === true,
      showSchedule: v.showSchedule === true,
      showAllHours: v.showAllHours === true,
    };
  } catch {
    return DEFAULT_CALENDAR_PREFS;
  }
}

export function setCalendarPrefs(v: CalendarPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* 同 density.ts */ }
}
