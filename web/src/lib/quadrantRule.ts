/**
 * 四象限按哪套规则分格——仿滴答清单的两套内置规则，
 * 原文在《如何编辑四象限规则》：
 *
 * > 为了让你更容易上手，我们默认为你提供了两套常用的规则组合：
 * > 规则组合1：每个象限，对应优先级。
 * > 规则组合2：「重要」对应「优先级」，「紧急」则对应「时间」的维度。
 *
 * **滴答除这两套之外还能自定义**（同一篇往下：「我们提供了4个维度：
 * 清单/标签、时间、优先级」），这儿只做预设。自定义象限规则等于在四象限上
 * 再长一个筛选器编辑器，而这个应用的 `SmartFilter` 已经能表达同一件事
 * （清单、标签、优先级、日期范围、且/或/排除组都有）——真要「只看工作清单
 * 的四象限」，那是给四象限接一个筛选入口，不是给它自己造一套规则语言。
 *
 * 存 `localStorage`，跟 `density`/`calendarPrefs`/`navModes` 同一类：
 * 「这台机器上我想怎么看四象限」，不是数据，不进同步。
 */
export type QuadrantRule = 'priority' | 'time-priority';

/**
 * 默认走优先级那套（= 滴答的规则组合1）。
 *
 * 理由不是「它更好」——是这个应用在有这个开关之前一直就是这套，默认换掉
 * 等于替每个人改一次界面；而滴答自己给这套的定位也是「这个规则非常简单，
 * 适合刚入门的新用户」。想要真的二维坐标系，四象限那一屏上一键切。
 */
export const DEFAULT_QUADRANT_RULE: QuadrantRule = 'priority';

/** 两套规则各自在界面上怎么称呼。跟 `taskView.ts` 的 `STATUS_LABEL` 同一条：
 *  文案只有一份出处，别在组件里再抄一遍。 */
export const QUADRANT_RULE_LABEL: Record<QuadrantRule, string> = {
  priority: '按优先级',
  'time-priority': '按时间 + 优先级',
};

/** 顺序固定，`priority` 在前——它是默认档，也是滴答那边列在前面的那套。 */
export const QUADRANT_RULES = ['priority', 'time-priority'] as const;

const KEY = 'quadrantRule';

function isRule(v: unknown): v is QuadrantRule {
  return v === 'priority' || v === 'time-priority';
}

/** 读不到、坏了、不是这两个值之一，一律回默认档。跟 `getCalendarPrefs` 同一条。 */
export function getQuadrantRule(): QuadrantRule {
  try {
    const raw = localStorage.getItem(KEY);
    return isRule(raw) ? raw : DEFAULT_QUADRANT_RULE;
  } catch {
    return DEFAULT_QUADRANT_RULE;
  }
}

export function setQuadrantRule(v: QuadrantRule): void {
  try { localStorage.setItem(KEY, v); } catch { /* 同 density.ts */ }
}
