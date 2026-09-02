import { describe, it, expect } from 'vitest';
import { suggestGroups } from './suggest.js';
import type { Task } from '../types.js';

/** 本地墙钟：候选池的判据（`isInTodayView`）和几个边界都按本地日历日算。 */
const local = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 22, 10);

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: '任务', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 1),
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

const keys = (ts: Task[]) => suggestGroups(ts, NOW).map((g) => g.key);
const group = (ts: Task[], key: string) => suggestGroups(ts, NOW).find((g) => g.key === key);

describe('suggestGroups：候选范围', () => {
  it('已完成、已搁置的不推荐', () => {
    expect(keys([task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'later' })])).toEqual([]);
  });

  it('重复任务不推荐——它天生「一直在」，创建时间和改期次数说明不了拖延', () => {
    const rep = task({ id: 'r', repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null } });
    expect(keys([rep])).toEqual([]);
  });

  it('已经在「今天」里的不推荐——这个面板存在的意义就是「今天之外还有什么」', () => {
    // 今天到期 → isInTodayView 为真
    expect(keys([task({ id: 'a', due: iso(2026, 8, 22, 18) })])).toEqual([]);
    // 已过期同理（也在「今天」里）
    expect(keys([task({ id: 'b', due: iso(2026, 8, 1) })])).toEqual([]);
  });

  it('一条都没有时返回空数组，不是四个空组——界面靠它决定连按钮都不出', () => {
    expect(suggestGroups([], NOW)).toEqual([]);
  });
});

describe('suggestGroups：四组', () => {
  it('最近添加：昨天/今天记下、还没排时间的，新的在前', () => {
    const old = task({ id: 'old', createdAt: iso(2026, 8, 1) });
    const y = task({ id: 'y', createdAt: iso(2026, 8, 21, 9) });
    const t = task({ id: 't', createdAt: iso(2026, 8, 22, 9) });
    expect(group([old, y, t], 'recent')!.tasks.map((x) => x.id)).toEqual(['t', 'y']);
  });

  it('已经排过时间的不算「最近添加」——那一组要的是「记下但没安排」', () => {
    const scheduled = task({ id: 's', createdAt: iso(2026, 8, 22, 9), due: iso(2026, 9, 30) });
    expect(group([scheduled], 'recent')).toBeUndefined();
  });

  it('一拖再拖：改过 2 次期以上，次数多的在前', () => {
    const a = task({ id: 'a', postponeCount: 2, createdAt: iso(2026, 8, 20) });
    const b = task({ id: 'b', postponeCount: 5, createdAt: iso(2026, 8, 20) });
    const c = task({ id: 'c', postponeCount: 1, createdAt: iso(2026, 8, 20) });
    expect(group([a, b, c], 'postponed')!.tasks.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('躺很久了：建了 7 天以上还没做完，老的在前', () => {
    const veryOld = task({ id: 'v', createdAt: iso(2026, 7, 1) });
    const old = task({ id: 'o', createdAt: iso(2026, 8, 10) });
    const fresh = task({ id: 'f', createdAt: iso(2026, 8, 20) });
    expect(group([veryOld, old, fresh], 'stale')!.tasks.map((x) => x.id)).toEqual(['v', 'o']);
  });

  it('即将到来：明天、后天到期，早的在前', () => {
    const tmr = task({ id: 'tmr', due: iso(2026, 8, 23, 9), createdAt: iso(2026, 8, 20) });
    const day2 = task({ id: 'day2', due: iso(2026, 8, 24, 9), createdAt: iso(2026, 8, 20) });
    const day3 = task({ id: 'day3', due: iso(2026, 8, 25, 9), createdAt: iso(2026, 8, 20) });
    expect(group([day2, tmr, day3], 'upcoming')!.tasks.map((x) => x.id)).toEqual(['tmr', 'day2']);
  });

  it('又建了很久、又明天到期：进「即将到来」不进「躺很久了」——具体的截止日期比一句抱怨有用', () => {
    const both = task({ id: 'b', createdAt: iso(2026, 7, 1), due: iso(2026, 8, 23, 9) });
    expect(keys([both])).toEqual(['upcoming']);
  });

  it('空组不返回', () => {
    expect(keys([task({ id: 'a', postponeCount: 3, createdAt: iso(2026, 8, 20) })])).toEqual(['postponed']);
  });
});

describe('suggestGroups：一条任务只进第一个符合的组', () => {
  it('又拖过期又躺很久，只出现一次——同一张卡出现两次会让「加到今天」按两次', () => {
    const both = task({ id: 'x', postponeCount: 4, createdAt: iso(2026, 7, 1) });
    const groups = suggestGroups([both], NOW);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['x']);
    // 分组顺序照滴答清单帮助文档：最近添加 → 一拖再拖 → 躺很久了 → 即将到来
    expect(groups.map((g) => g.key)).toEqual(['postponed']);
  });

  it('四组同时有东西时按文档顺序排', () => {
    const ts = [
      task({ id: 'recent', createdAt: iso(2026, 8, 22, 9) }),
      task({ id: 'post', postponeCount: 3, createdAt: iso(2026, 8, 20) }),
      task({ id: 'stale', createdAt: iso(2026, 7, 1) }),
      task({ id: 'soon', due: iso(2026, 8, 23, 9), createdAt: iso(2026, 8, 20) }),
    ];
    expect(keys(ts)).toEqual(['recent', 'postponed', 'stale', 'upcoming']);
  });
});

/**
 * **还没到开始时间的不推荐。** 这个面板的四组全在说「这条你是不是忘了」，
 * 而一条设了开始时间的任务恰恰相反：他记得，而且明确说了「那天之前别管它」。
 */
describe('suggestGroups：还没开始的不进候选', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const at = (h: number) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();
  const flat = (gs: { tasks: { id: string }[] }[]) => gs.flatMap((g) => g.tasks.map((t) => t.id));

  it('开始时间在将来 → 不出现在任何一组里', () => {
    const t = task({ id: 'a', createdAt: NOW.toISOString(), startAt: at(72) });
    expect(flat(suggestGroups([t], NOW))).toEqual([]);
  });

  it('开始时间在更早的某一天 → 照常参与（那就是一条普通的没排期任务）', () => {
    const t = task({ id: 'a', createdAt: NOW.toISOString(), startAt: at(-48) });
    expect(flat(suggestGroups([t], NOW))).toEqual(['a']);
  });

  /**
   * **今天才开始的那一条不推荐，理由跟「还没开始」正好相反：它已经在「今天」了。**
   *
   * 这一条上一版写的是 `at(-1)`（一小时前）并断言「照常参与」，理由写着「那就是
   * 一条普通的没排期任务」。`isInTodayView` 补上「今天开始的算今天的」那一支之后，
   * 这句话不成立了——一小时前开始就是今天开始，它已经摆在「今天」那一屏上。
   *
   * 而这个面板的每一组问的都是**「要不要加到今天」**（`isCandidate` 最后一行
   * `!isInTodayView`）。对一条已经在今天里的任务问这句，是在让人做一次已经做过
   * 的决定。所以这不是回归，是那一支该有的连带效果。
   */
  it('今天才到开始时间 → 不推荐，因为它已经在「今天」里了', () => {
    const t = task({ id: 'a', createdAt: NOW.toISOString(), startAt: at(-1) });
    expect(flat(suggestGroups([t], NOW))).toEqual([]);
  });

  it('没设开始时间 → 行为一个字不变', () => {
    const t = task({ id: 'a', createdAt: NOW.toISOString(), startAt: null });
    expect(flat(suggestGroups([t], NOW))).toEqual(['a']);
  });
});

/**
 * 「现在做什么」四组问的都是「这条你是不是忘了」。一条父任务被 defer 到 9/1
 * 的子任务，他没忘——他明确说了那天之前别管，只是那句话写在父亲身上。
 */
describe('建议：父亲还没开始的，不推荐它的孩子', () => {
  const LATER = iso(2026, 9, 1, 9);
  const ids = (ts: Task[]) => suggestGroups(ts, NOW).flatMap((g) => g.tasks.map((x) => x.id));

  it('**父亲 9/1 才开始：它的孩子不进候选池**', () => {
    const rows = [
      task({ id: 'p', title: '装修', startAt: LATER }),
      task({ id: 'c', title: '量尺寸', parentId: 'p' }),
    ];
    expect(ids(rows)).not.toContain('c');
  });

  it('对照：同一条任务，父亲的开始时间过了就推荐得出来——证明它本来够格进候选，不是因为别的被挡在外面', () => {
    const rows = [
      task({ id: 'p', title: '装修', startAt: iso(2026, 8, 1, 9) }),
      task({ id: 'c', title: '量尺寸', parentId: 'p' }),
    ];
    expect(ids(rows)).toContain('c');
  });
});

/**
 * **在等别人的任务不进候选池。**
 *
 * 这四组问的是「这条你是不是忘了」，而一条写着「在等 张律师」的任务，他不但
 * 记得，而且现在根本推不动——下一步在别人手里。出处是 Things
 * （《How to Deal with Waiting To-Dos》）那句「**这一步很关键，
 * 它把这些任务弄出 Today**——反正你现在也做不了」。
 *
 * 在这之前 `waitingFor` 全仓只有两个消费方：卡片上那句「多久没动静」和筛选栏
 * 的一维。它对「现在能做什么」这几屏**一点作用都没有**。
 */
describe('建议：在等别人的不推荐', () => {
  const ids = (ts: Task[]) => suggestGroups(ts, NOW).flatMap((g) => g.tasks.map((x) => x.id));

  it('**填了「在等谁」就不进候选池**', () => {
    const rows = [task({ id: 'w', title: '等法务回合同', waitingFor: '张律师', createdAt: iso(2026, 8, 1) })];
    expect(ids(rows)).not.toContain('w');
  });

  it('对照：同一条任务，「在等谁」是空的就推荐得出来——证明它本来够格进候选，不是因为别的被挡在外面', () => {
    const rows = [task({ id: 'w', title: '等法务回合同', waitingFor: null, createdAt: iso(2026, 8, 1) })];
    expect(ids(rows)).toContain('w');
  });

  it('空字符串不算「在等谁」——那是清空之后的形状，不是「在等一个没名字的人」', () => {
    const rows = [task({ id: 'w', waitingFor: '', createdAt: iso(2026, 8, 1) })];
    expect(ids(rows)).toContain('w');
  });
});
