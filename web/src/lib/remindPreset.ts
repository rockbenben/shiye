import { calendarAnchor } from './calendar.js';
import { hasTimeBlock, type Timed } from './taskView.js';

/**
 * 提醒的「提前多久」预设（仿滴答清单）。
 *
 * 在这之前提醒只有一个绝对时间的选择器：想要「截止前半小时提醒我」，得先看
 * 一眼截止是几点、在脑子里减三十分钟、再去日历上点出那个时刻——而这是设提醒
 * 最常见的一种。滴答清单那边整个提醒界面就是这排预设，绝对时间反而是次要入口。
 *
 * **这里两个都留着**：预设解决高频的那一半，绝对时间留给「周五下午三点提醒我」
 * 这种跟截止时间没有固定偏移关系的情形。
 *
 * 「提前」相对哪一刻算，见下面的 `RemindAnchor`——**不只是截止时间**。
 *
 * 纯函数，不读时钟。引 `calendar.ts` 只为拿 `calendarAnchor`（那份判据的正本），
 * 不成环：`calendar.ts` 不引这个文件。
 */

export interface RemindPreset {
  /** 提前多少分钟。0 = 准时。 */
  minutes: number;
  label: string;
}

/**
 * 六档。**没有「提前 1 周」**：偏移越大，「提前多久」这个说法本身就越不成立
 * ——一周前的提醒实际上是另一件事（「该开始准备了」），那是一条自己的任务，
 * 不是这条的提醒。
 */
export const REMIND_PRESETS: RemindPreset[] = [
  { minutes: 0, label: '准时' },
  { minutes: 5, label: '提前 5 分钟' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 60 * 24, label: '提前 1 天' },
  { minutes: 60 * 24 * 2, label: '提前 2 天' },
];

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * **预设相对哪个时刻算。**
 *
 * - `'main'` —— 这条任务自己的那一刻：**有时间段的是起点，否则是截止时间**。
 *   判据不在这儿，是 `calendar.ts` 的 `calendarAnchor`——日历落格问的是同一个
 *   问题（「这条任务在哪一刻」），两处各判一遍迟早给出两个答案。
 * - `'end'` —— 时间段的**结束**那一刻。没有时间段就没有这一档。
 *
 * 加 `'end'` 是补第六批留下的半截：那一批给任务加了时间段（`startAt`+`endAt`，
 * 日历上占一段高度），提醒这边却还整排锚在 `due` 上——于是一场只有时间段、
 * 没有截止时间的会，**一档预设都点不出来**，只能自己去日历上挑一个绝对时刻。
 * 而滴答那边这一档是明写的：
 *
 * > 结束时间提醒：当你有一个会议或活动安排时，如何轻松知道活动何时结束，
 * > 不错过任何截止期限呢？……在设置任务时间段后，选择「提醒」，勾选「结束时」即可。
 * >
 * > —— 《超强大的提醒功能》
 */
export type RemindAnchor = 'main' | 'end';

/** 一颗预设按钮：相对哪个时刻、提前多久。 */
export interface RemindChoice {
  anchor: RemindAnchor;
  minutes: number;
  label: string;
}

/**
 * 编辑表单里那排按钮。**从 `REMIND_PRESETS` 派生**，不另抄一份六档——那六个
 * 偏移量还有第二个读者（设置里的「默认提醒」，`SettingsModal.tsx`），抄一份
 * 出来就是同一个名单的第二份定义。
 *
 * 「结束时」排在最后：它是唯一一个锚点不同的，而且只在有时间段时才出现，
 * 摆在中间会让那排按钮的个数跟着任务变、位置也跟着跳。
 */
export const REMIND_CHOICES: RemindChoice[] = [
  ...REMIND_PRESETS.map((p) => ({ anchor: 'main' as const, minutes: p.minutes, label: p.label })),
  { anchor: 'end', minutes: 0, label: '结束时' },
];

/** 点亮哪几颗要按「哪一档」认，不能只按分钟数——`main/0`（准时）和 `end/0`
 *  （结束时）分钟数一样，锚点不一样。 */
export const choiceKey = (c: RemindChoice): string => `${c.anchor}:${c.minutes}`;

/**
 * 这条任务上，某个锚点对应的时刻（ISO）。算不出来返回 `null`：没有截止时间
 * 也没有时间段（`'main'`），或者根本没有时间段（`'end'`）。
 */
export function remindAnchorAt(t: Timed, anchor: RemindAnchor): string | null {
  if (anchor === 'end') return hasTimeBlock(t) ? t.endAt : null;
  return calendarAnchor(t)?.toISOString() ?? null;
}

/** 点某一档得到的提醒时刻。算不出锚点就返回 `null`，调用方据此不显示那一颗。 */
export function choiceToRemindAt(t: Timed, c: RemindChoice): string | null {
  // 减法只有一份，在 `presetToRemindAt`——这儿只负责把锚点找出来。
  return presetToRemindAt(remindAnchorAt(t, c.anchor), c.minutes);
}

/**
 * 一条任务上那几个提醒，各自点亮哪几颗。**一条任务可以有多个提醒**
 * （数据模型一直支持，服务端也一直逐条判、逐条发），所以点亮的可能不止一颗。
 * 对不上任何一档的（自己挑的绝对时刻）不点亮任何一颗。
 *
 * **按毫秒比，不按字符串比**：手改 `data/tasks/` 下的文件能写出同一瞬间的
 * 另一种写法（带不带毫秒、`+08:00` 还是 `Z`），那时候按字符串比会漏掉一颗
 * 本该亮的按钮。
 */
export function activePresets(t: Timed, reminders: string[]): Set<string> {
  const at = new Set(reminders.map((r) => ms(r)).filter((x): x is number => x !== null));
  const out = new Set<string>();
  for (const c of REMIND_CHOICES) {
    const want = ms(choiceToRemindAt(t, c));
    if (want !== null && at.has(want)) out.add(choiceKey(c));
  }
  return out;
}

/**
 * 点某一档得到的提醒时刻。没有截止时间就返回 `null`——「提前多久」没有参照物，
 * 调用方据此整排都不显示。
 *
 * 用毫秒减，不用 `setMinutes`：这里算的是「同一个瞬间往前推固定时长」，
 * 不是日历加减。跨夏令时那一小时时，「提前 30 分钟」要的正是真实的三十分钟，
 * 而不是墙钟上的 30 分——跟 `repeat.ts` 加日历天数刻意用 `setDate` 是相反的
 * 两种需求，别顺手统一。
 */
export function presetToRemindAt(due: string | null, minutes: number): string | null {
  const d = ms(due);
  if (d === null) return null;
  return new Date(d - minutes * 60_000).toISOString();
}


/**
 * 改第 `i` 个提醒（`null` = 删掉它）。**末尾那个空位算第 `n` 个**：表单永远
 * 多摆一个空的选择器当「加一个」，在它上面选个时刻就是追加一条。
 *
 * 顺带**去重并排序**：同一个时刻设两遍没有意义（服务端也只会发一次——
 * `applyTaskPatch` 按时刻沿用旧章），而排好序之后「提前一天」和「提前半小时」
 * 在界面上的先后跟它们真正响的先后一致。
 */
export function setNthReminder(reminders: string[], i: number, at: string | null): string[] {
  const next = [...reminders];
  if (at === null) next.splice(i, 1);
  else next[i] = at;
  return sortUniq(next);
}

/** 点某一档：有了就删掉那一个，没有就加一个。算不出锚点时原样返回
 *  （那颗按钮本来也不显示）。 */
export function togglePreset(t: Timed, reminders: string[], c: RemindChoice): string[] {
  const at = choiceToRemindAt(t, c);
  if (at === null) return reminders;
  const want = ms(at);
  // 删的时候同样按毫秒认，跟 `activePresets` 一条口径：亮着的按钮点一下就该灭。
  const hit = reminders.find((r) => ms(r) === want);
  return hit !== undefined ? reminders.filter((r) => r !== hit) : sortUniq([...reminders, at]);
}

const sortUniq = (xs: string[]): string[] =>
  [...new Set(xs.filter(Boolean))].sort((a, b) => (ms(a) ?? 0) - (ms(b) ?? 0));
