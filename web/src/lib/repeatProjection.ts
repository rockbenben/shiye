import type { Task } from '../types.js';
import { nextOccurrence } from '../../../server/src/repeat.js';
import { isSettled } from './taskView.js';

/**
 * 把一条重复任务**往后推演**出它在某段时间里还会出现的那几次——仿滴答清单
 * 日历显示设置里的「显示未来重复周期」。
 *
 * 为什么需要：这个应用的重复是「完成一条才生成下一条」（`nextInstance`），
 * 所以一条「每周一开例会」在日历上**只有一个格子**有它。翻到下个月，那一整
 * 页空空如也，而实际上每个周一都有会——日历回答的是「什么时候要做什么」，
 * 这种回答是错的。
 *
 * **推演出来的不是任务。** 它们没有 id、不能勾完成、不能拖、不能编辑——那几次
 * 还没发生，数据库里也没有对应的记录。界面上必须看得出区别（`CalendarFull`
 * 用一个单独的 className + `editable: false`），不然人会去点一个点不动的影子。
 *
 * 从 `server/src/repeat.js` 引 `nextOccurrence`，不在这边照抄一份：那是「下
 * 一次是哪天」的唯一判据（月末溢出、DST、weekdays、until 全在里面），抄一份
 * 迟早跟服务端算出不一样的日子，而这两个数字摆在同一个界面上。`pushBack.ts`
 * 从 `server/src/push.js` 引 `decidePush` 是同一个先例。
 */
export interface RepeatGhost {
  /** 从哪条任务推演出来的。给界面做 key、也让人点了能跳回本体。 */
  taskId: string;
  title: string;
  /** 这一次落在什么时候（ISO）。 */
  at: string;
}

/** 一条任务最多往后推几次。防的是 `interval` 很小、窗口很大时无谓地转几千圈
 *  ——月视图一页 42 天，「每天」也就 42 次，这个上限只在数据坏掉时起作用。 */
const MAX_STEPS = 400;

/**
 * `[from, to]` 这段时间里，这条重复任务还会出现在哪几天。
 *
 * 三条不推演的情况：
 * - **没有 `repeat`**：不是重复任务。
 * - **没有 `due`**：`nextOccurrence` 要一个起点，没有 due 就没有起点——这类
 *   任务（多半是习惯）本来就不落在日历上任何一格，推演也无处可落。
 * - **已完成 / 已搁置**：完成那一刻服务端已经把下一条真的建出来了（`nextInstance`），
 *   再推演一遍就是把同一次画两遍；搁置的意图是「暂时不想看见它」。
 */
export function futureOccurrences(t: Task, from: Date, to: Date): RepeatGhost[] {
  if (!t.repeat || !t.due) return [];
  if (isSettled(t)) return [];
  const base = new Date(t.due);
  if (Number.isNaN(base.getTime())) return [];

  const out: RepeatGhost[] = [];
  // `count` 是「还要再重复几次」——推演不能比它承诺的次数多画一格，那是
  // 在屏幕上凭空多出一次永远不会发生的会。缺这个字段（老数据）是一直重复。
  const budget = typeof t.repeat.count === 'number' ? t.repeat.count : Infinity;
  let cur = base;
  // **预算按「走了几步」扣，不按「画了几个」扣。** 每一步都是一次真的会发生的
  // 重复，不管它落不落在当前这一页的窗口里；用 `out.length` 计数的话，窗口之前
  // 那些步走过却不扣预算，于是**每翻一页都重新给满额度**。
  //
  // 实测复现过：`count: 2`（还要再重复两次）、9/3 起每天一次，本月画 2 个、
  // 下月又画 2 个、再下月还画 2 个——后面那些是第 30、31 次，永远不会发生。
  // 一条快结束的重复任务因此会在所有未来的日历页上留下幽灵。
  let walked = 0;
  for (let i = 0; i < MAX_STEPS && walked < budget; i++) {
    // 艾宾浩斯的间隔跟「走到第几步」有关，而 `nextOccurrence` 只看规则里的
    // `step`——推演时它不会自己往前走，不手动递增的话推出来是一串等距的
    // 「第一次间隔」，跟真实节奏差一个量级。
    const rule = t.repeat.every === 'ebbinghaus'
      ? { ...t.repeat, step: (t.repeat.step ?? 0) + i }
      : t.repeat;
    const next = nextOccurrence(rule, cur);
    if (!next) break;              // 超过 until，或者算出了 Invalid Date
    if (next.getTime() > to.getTime()) break;
    walked += 1;
    if (next.getTime() >= from.getTime()) {
      out.push({ taskId: t.id, title: t.title, at: next.toISOString() });
    }
    cur = next;
  }
  return out;
}

/** 一整页的推演。`tasks` 里每条各推一遍，拍平。 */
export const allFutureOccurrences = (tasks: Task[], from: Date, to: Date): RepeatGhost[] =>
  tasks.flatMap((t) => futureOccurrences(t, from, to));
