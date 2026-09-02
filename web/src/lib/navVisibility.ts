import type { ViewCountSource, ViewDef } from './views.js';

/**
 * 导航上每个去处的显示方式——仿滴答清单的「智能清单」设置（它给的三档就是
 * 显示 / 隐藏 / 有内容时显示）。
 *
 * 这个应用的导航现在有十一项，而多数人天天用的只有其中三四个：「四象限」
 * 「时间线」这种是为特定工作方式准备的，用不上的人每一屏都要从它们中间
 * 找过去。滴答清单的答案就是让人自己关掉，这里照抄。
 *
 * 存 `localStorage` 不进 `Settings`：跟 `density`/`groupSort` 同一类——
 * 「这台机器上我想看到哪几个入口」，不是数据。
 */
export type NavMode = 'show' | 'hide' | 'auto';

export const NAV_MODE_LABEL: Record<NavMode, string> = {
  show: '显示', hide: '隐藏', auto: '有内容时显示',
};

/** key → 显示方式。没记的一律 `'show'`——**默认全显示，今天的行为不变**。 */
export type NavModes = Record<string, NavMode>;

const KEY = 'navModes';

/** 读不到、坏了、值不认识，都当没设过。 */
export function getNavModes(): NavModes {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return {};
    const out: NavModes = {};
    for (const [k, mode] of Object.entries(v)) {
      if (mode === 'hide' || mode === 'auto') out[k] = mode;
      // `'show'` 不存：它是默认值，记下来只是让这份表越长越大，
      // 而「没记 = 显示」这条规矩本身就够表达它。
    }
    return out;
  } catch {
    return {};
  }
}

export function setNavModes(v: NavModes): void {
  try {
    // 只留非默认的那几条，理由同上。
    const lean = Object.fromEntries(Object.entries(v).filter(([, m]) => m !== 'show'));
    localStorage.setItem(KEY, JSON.stringify(lean));
  } catch { /* 存不进去就只在这个会话里有效，跟 density.ts 同一条 */ }
}

/**
 * 一个去处**能不能**选「有内容时显示」。
 *
 * 只有定义了 `count` 的才行——`auto` 要有一个「有没有内容」的答案，而这个
 * 应用里那个答案就是导航上那个数字。给「四象限」这种没有 count 的也摆上
 * 这一档，选了跟「显示」一模一样，是一个点了没反应的选项。
 */
export const canAuto = (v: Pick<ViewDef, 'count'>): boolean => v.count !== undefined;

/**
 * 按显示方式筛一遍导航项。
 *
 * **当前正看着的那个永远留下**，不管设成什么：把它藏掉会让导航上没有任何一项
 * 是 `aria-current`，而屏幕上明明就是它——那看着像是导航坏了。人是从设置里
 * 把它关掉的，下次切走之后自然就不见了。
 */
export function visibleViews(defs: ViewDef[], modes: NavModes, current: string, src: ViewCountSource): ViewDef[] {
  return defs.filter((v) => {
    if (v.key === current) return true;
    const mode = modes[v.key] ?? 'show';
    if (mode === 'hide') return false;
    if (mode === 'auto') return (v.count?.(src) ?? 0) > 0;
    return true;
  });
}
