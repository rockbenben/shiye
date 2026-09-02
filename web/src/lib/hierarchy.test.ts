import { describe, it, expect } from 'vitest';
import { blockingAncestor, childProgress, childrenOf, nestChildren, notStartedDeep, parentCandidates, parentOf, parentOptionsFor, promoteSubtask, stalledProjects } from './hierarchy.js';
import { notStarted } from './taskView.js';
import type { Task } from '../types.js';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: '任务', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false,
  pinned: false, reviewedAt: null, parentId: null, ...over,
});

const ids = (ts: Task[]) => ts.map((t) => t.id);

describe('parentOf / childrenOf / childProgress', () => {
  const p = task({ id: 'p', title: '装修' });
  const a = task({ id: 'a', parentId: 'p', status: 'done' });
  const b = task({ id: 'b', parentId: 'p' });
  const all = [p, a, b];

  it('parentOf 找得到，没有父的返回 undefined', () => {
    expect(parentOf(a, all)?.id).toBe('p');
    expect(parentOf(p, all)).toBeUndefined();
  });

  it('parentId 指向一条已经不在的任务时返回 undefined，不炸', () => {
    expect(parentOf(task({ id: 'x', parentId: '删掉了' }), all)).toBeUndefined();
  });

  it('childrenOf 只认直接子任务', () => {
    expect(ids(childrenOf('p', all))).toEqual(['a', 'b']);
  });

  it('childProgress 数已完成/总数；没有子任务返回 null，卡片上就不画这个记号', () => {
    expect(childProgress('p', all)).toEqual({ done: 1, total: 2 });
    expect(childProgress('a', all)).toBeNull();
  });
});

describe('nestChildren', () => {
  it('孩子挪到父亲后面，父亲保留自己排出来的位置', () => {
    const list = [
      task({ id: 'x' }),
      task({ id: 'kid', parentId: 'p' }),
      task({ id: 'p' }),
      task({ id: 'y' }),
    ];
    expect(ids(nestChildren(list))).toEqual(['x', 'p', 'kid', 'y']);
  });

  it('多个孩子按原有相对顺序跟在后面', () => {
    const list = [task({ id: 'k2', parentId: 'p' }), task({ id: 'p' }), task({ id: 'k1', parentId: 'p' })];
    expect(ids(nestChildren(list))).toEqual(['p', 'k2', 'k1']);
  });

  it('父亲不在这份列表里（被筛掉了/在别的分组里）的孩子留在原地，不上提也不丢', () => {
    const list = [task({ id: 'a' }), task({ id: 'orphan', parentId: '不在这儿' })];
    expect(ids(nestChildren(list))).toEqual(['a', 'orphan']);
  });

  it('一条父子关系都没有时原样返回同一个数组——不白造一份新的', () => {
    const list = [task({ id: 'a' }), task({ id: 'b' })];
    expect(nestChildren(list)).toBe(list);
  });

  it('幂等：排好的再跑一次不变', () => {
    const list = [task({ id: 'p' }), task({ id: 'k', parentId: 'p' }), task({ id: 'z' })];
    const once = nestChildren(list);
    expect(ids(nestChildren(once))).toEqual(ids(once));
  });

  it('一条都不会丢：进去几条出来几条', () => {
    const list = [
      task({ id: 'k', parentId: 'p' }), task({ id: 'p' }),
      task({ id: 'orphan', parentId: 'gone' }), task({ id: 'z' }),
    ];
    expect(nestChildren(list)).toHaveLength(4);
  });
});

describe('parentCandidates', () => {
  const all = [
    task({ id: 'top1' }),
    task({ id: 'top2' }),
    task({ id: 'kid', parentId: 'top1' }),
    task({ id: 'finished', status: 'done' }),
  ];

  it('排除自己', () => {
    expect(ids(parentCandidates(all, 'top2'))).not.toContain('top2');
  });

  /**
   * **已经是别人子任务的现在是合法候选**——这一条跟只做一层那时候正好相反。
   * 五层下「挂到一个子任务下面」就是往深里再走一层，只要不超上限就是对的。
   */
  it('已经是别人子任务的也能当父亲——五层下这是正常操作', () => {
    expect(ids(parentCandidates(all, 'top2'))).toContain('kid');
  });

  it('排除已完成的——把一条活着的任务挂到一件做完的事下面多半是选错了', () => {
    expect(ids(parentCandidates(all, 'top2'))).not.toContain('finished');
  });

  /**
   * **自己名下有子任务时照样有候选**——同样跟只做一层那时候相反：带着子树
   * 挪到别人下面是合法的，只要挂完整棵树不超过上限。
   */
  it('自己名下有子任务时照样能挂到别人下面', () => {
    expect(ids(parentCandidates(all, 'top1'))).toContain('top2');
    // 但不能挂到自己的后代下面——那会绕成一个圈。
    expect(ids(parentCandidates(all, 'top1'))).not.toContain('kid');
  });

  it('新任务（还没有 id）传 null，「排除自己」那条不适用', () => {
    expect(ids(parentCandidates(all, null)).sort()).toEqual(['kid', 'top1', 'top2']);
  });

  /**
   * **上限那一条：判的不是「父亲的层数加一」。** 把一棵三层的子树挂到一棵
   * 三层的下面是 6 层，超了——只看父亲那一层的话这条会漏。
   */
  it('超过五层的候选不给：连整棵子树一起算', () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) =>
      task({ id: `c${i}`, parentId: i === 0 ? null : `c${i - 1}` }));
    const deep = [...chain(3), ...chain(3).map((t, i) => ({
      ...t, id: `d${i}`, parentId: i === 0 ? null : `d${i - 1}`,
    }))];
    // d0 是一棵三层子树的根，c2 在第三层：挂上去就是 3 + 3 = 6 层。
    expect(ids(parentCandidates(deep, 'd0'))).not.toContain('c2');
    // 挂到 c0（第一层）上是 1 + 3 = 4 层，可以。
    expect(ids(parentCandidates(deep, 'd0'))).toContain('c0');
  });
});

/**
 * 检查事项转为子任务（仿滴答清单「转为子任务」）。补的是一条走不通的路：
 * 一个检查事项发现需要自己的截止时间/备注，而它只有 `{ text, done }` 两个字段。
 */
describe('promoteSubtask', () => {
  const withSubs = (over: Partial<Task> = {}) =>
    task({ id: 'p', title: '装修', listId: 'l1', subtasks: [{ text: '刷墙', done: false }], ...over });

  it('转出来的子任务挂在父亲下面，清单跟着走', () => {
    expect(promoteSubtask(withSubs(), 0)!.child)
      .toEqual({ title: '刷墙', status: 'todo', listId: 'l1', parentId: 'p' });
  });

  it('原来的那一项从检查事项里摘掉，别的不动——这是挪，不是复制', () => {
    const t = withSubs({ subtasks: [{ text: '刷墙', done: false }, { text: '装灯', done: true }] });
    expect(promoteSubtask(t, 0)!.rest).toEqual([{ text: '装灯', done: true }]);
  });

  it('**勾掉的那一项转过去还是已完成**——改写状态等于伪造一条没发生过的事', () => {
    expect(promoteSubtask(withSubs({ subtasks: [{ text: '刷墙', done: true }] }), 0)!.child.status).toBe('done');
  });

  /**
   * **这一条整个换掉了。** 只做一层那时候「父任务自己已经是子任务」就转不了；
   * 五层下那是正常操作，真正转不了的是**父任务已经在第五层**——转出来的那条
   * 挂上去就是第六层。
   */
  it('父任务已经在第五层：转不了，别等服务端回 400', () => {
    const chain = Array.from({ length: 5 }, (_, i) =>
      task({ id: `L${i}`, parentId: i === 0 ? null : `L${i - 1}` }));
    const deepest = { ...withSubs({}), id: 'L4', parentId: 'L3' };
    const all = [...chain.slice(0, 4), deepest];
    expect(promoteSubtask(deepest, 0, all)).toBeNull();
  });

  it('父任务在第四层：转得了，那只是第五层', () => {
    const chain = Array.from({ length: 4 }, (_, i) =>
      task({ id: `L${i}`, parentId: i === 0 ? null : `L${i - 1}` }));
    const at4 = { ...withSubs({}), id: 'L3', parentId: 'L2' };
    const all = [...chain.slice(0, 3), at4];
    expect(promoteSubtask(at4, 0, all)).not.toBeNull();
  });

  /**
   * **不给 `all` 就不拦。** 深度是全表算出来的，拿不到表时这个函数无从判断——
   * 服务端仍然是最后那道防线，只是那时候按钮已经点下去了。宁可让它偶尔回一次
   * 400，也不要在拿不到表时把一颗本来能用的按钮永久藏掉。
   */
  it('不给 all：不拦，交给服务端', () => {
    expect(promoteSubtask(withSubs({ parentId: 'grand' }), 0)).not.toBeNull();
  });

  it('下标越界返回 null，不崩', () => {
    expect(promoteSubtask(withSubs(), 5)).toBeNull();
    expect(promoteSubtask(task({ id: 'p' }), 0)).toBeNull();
  });

  it('只有空白的那一项转不了——POST /api/tasks 要求标题非空', () => {
    expect(promoteSubtask(withSubs({ subtasks: [{ text: '   ', done: false }] }), 0)).toBeNull();
  });

  it('标题去掉首尾空白', () => {
    expect(promoteSubtask(withSubs({ subtasks: [{ text: '  刷墙 ', done: false }] }), 0)!.child.title).toBe('刷墙');
  });

  it('标签、优先级、截止时间都不继承——那几样是「这一条自己的判断」', () => {
    const t = withSubs({ tags: ['装修'], priority: 3, due: '2026-09-01T00:00:00.000Z' });
    expect(Object.keys(promoteSubtask(t, 0)!.child).sort()).toEqual(['listId', 'parentId', 'status', 'title']);
  });
});

/**
 * 「放弃」这个状态是后加的，下面这两处判断当时都停在只认 `done`。
 */
describe('hierarchy：已放弃的那一档', () => {
  const kid = (id: string, status: Task['status']) => task({ id, parentId: 'p', status });

  it('**放弃了的子任务分子分母都不进**——不然那个记号永远到不了满，而那一格其实早就不需要了', () => {
    const all = [task({ id: 'p' }), kid('a', 'done'), kid('b', 'todo'), kid('c', 'abandoned')];
    expect(childProgress('p', all)).toEqual({ done: 1, total: 2 });
  });

  it('搁置的照常算在分母里——搁置是「暂时不想做」，那件事还在', () => {
    const all = [task({ id: 'p' }), kid('a', 'done'), kid('b', 'later')];
    expect(childProgress('p', all)).toEqual({ done: 1, total: 2 });
  });

  it('孩子全被放弃了就当没有孩子——不画一个 0/0 的记号', () => {
    expect(childProgress('p', [task({ id: 'p' }), kid('a', 'abandoned')])).toBeNull();
  });

  it('已放弃的不当上级候选——把一条活着的任务挂到一件决定不做的事下面，多半是选错了', () => {
    const all = [task({ id: 'gone', status: 'abandoned' }), task({ id: 'live' })];
    expect(parentCandidates(all, null).map((t) => t.id)).toEqual(['live']);
  });

  it('搁置的还是候选——那件事还在，往它下面挂一步是合理的', () => {
    const all = [task({ id: 'later', status: 'later' })];
    expect(parentCandidates(all, null).map((t) => t.id)).toEqual(['later']);
  });
});

/**
 * 下拉框真正要摆的那几项。**这一条修的是一个界面上回不去的状态**：父任务做完
 * 之后就不再是候选，而下拉框只在有候选时才渲染——一条子任务可能既显示成
 * 「不是谁的子任务」（跟卡片上的「↳ 属于…」自相矛盾），又摘不下来。
 */
describe('parentOptionsFor', () => {
  it('父亲还在候选里时，跟 parentCandidates 一模一样', () => {
    const p = task({ id: 'p' });
    const kid = task({ id: 'k', parentId: 'p' });
    expect(ids(parentOptionsFor([p, kid], kid))).toEqual(ids(parentCandidates([p, kid], 'k')));
  });

  it('**父亲已完成（不在候选里）时补进来，排在最后**——它不是一个「可以选」的新去处，是「你现在在这儿」', () => {
    const done = task({ id: 'p', status: 'done' });
    const other = task({ id: 'o' });
    const kid = task({ id: 'k', parentId: 'p' });
    const all = [done, other, kid];
    expect(parentCandidates(all, 'k').map((t) => t.id)).toEqual(['o']);
    expect(ids(parentOptionsFor(all, kid))).toEqual(['o', 'p']);
  });

  it('**候选一个都没有时也摆得出那一项**——不然这个框整个不渲染，这条子任务再也摘不下来', () => {
    const done = task({ id: 'p', status: 'done' });
    const kid = task({ id: 'k', parentId: 'p' });
    expect(parentCandidates([done, kid], 'k')).toEqual([]);
    expect(ids(parentOptionsFor([done, kid], kid))).toEqual(['p']);
  });

  it('自己没有父亲时不多补任何东西', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    expect(ids(parentOptionsFor([a, b], a))).toEqual(['b']);
  });

  it('父亲那条整个不在表里（删了/还没拉到）就不补——没什么可显示的，服务端会把 parentId 清掉', () => {
    const kid = task({ id: 'k', parentId: '没了' });
    expect(parentOptionsFor([kid], kid)).toEqual([]);
  });

  it('自己名下有子任务时照旧一个候选都没有——补进来的只有「当前的父亲」，而它这时候没有', () => {
    const dad = task({ id: 'p' });
    const kid = task({ id: 'k', parentId: 'p' });
    expect(parentOptionsFor([dad, kid], dad)).toEqual([]);
  });
});

/**
 * 卡住的项目（GTD：一个还挂着的项目，底下一个能动的下一步都没有）。
 *
 * 「子任务全做完」那种走不到这里——`server/src/mutate.ts` 的 `rollUpParentDone`
 * 会在最后一条做完的那一刻把父任务也标完成。所以这里逮的是「全搁置」「全放弃」
 * 「一半放弃一半搁置」这几种：它们都不触发自动收尾，项目就一直挂着。
 */
describe('stalledProjects', () => {
  const p = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const k = (id: string, over: Partial<Task> = {}) => task({ id, parentId: 'p', ...over });

  it('子任务全搁置 → 卡住了', () => {
    const all = [p(), k('a', { status: 'later' }), k('b', { status: 'later' })];
    expect(stalledProjects(all).map((t) => t.id)).toEqual(['p']);
  });

  it('子任务全放弃 → 也卡住了（这种连自动收尾都不会触发）', () => {
    const all = [p(), k('a', { status: 'abandoned' })];
    expect(stalledProjects(all).map((t) => t.id)).toEqual(['p']);
  });

  it('一半放弃一半搁置 → 还是没有下一步', () => {
    const all = [p(), k('a', { status: 'abandoned' }), k('b', { status: 'later' })];
    expect(stalledProjects(all).map((t) => t.id)).toEqual(['p']);
  });

  it.each([
    ['todo', 'todo'],
    ['doing', 'doing'],
  ] as const)('只要还有一条是 %s，就不算卡住', (_n, status) => {
    const all = [p(), k('a', { status: 'later' }), k('b', { status })];
    expect(stalledProjects(all)).toEqual([]);
  });

  it('**没有子任务的不算项目**——「没有下一步」对一条普通任务没有意义', () => {
    expect(stalledProjects([task({ id: 'x' })])).toEqual([]);
  });

  it('父任务自己已经了结的不算——它不再是一个挂着的项目', () => {
    for (const status of ['done', 'later', 'abandoned'] as const) {
      const all = [p({ status }), k('a', { status: 'later' })];
      expect(stalledProjects(all), status).toEqual([]);
    }
  });

  it('子任务全做完的那种这里不该看见——那一刻父任务已经被自动标完成了', () => {
    const all = [p({ status: 'done' }), k('a', { status: 'done' })];
    expect(stalledProjects(all)).toEqual([]);
  });

  it('多个项目各算各的，只吐卡住的那些', () => {
    const all = [
      task({ id: 'p1' }), task({ id: 'a', parentId: 'p1', status: 'later' }),
      task({ id: 'p2' }), task({ id: 'b', parentId: 'p2', status: 'todo' }),
    ];
    expect(stalledProjects(all).map((t) => t.id)).toEqual(['p1']);
  });
});

/**
 * **展开和「卡住」都要走整棵子树**（放开到五层之后）。
 */
describe('nestChildren / stalledProjects：五层', () => {
  const chain = [
    task({ id: 'z' }),
    task({ id: 'a' }),
    task({ id: 'b', parentId: 'a' }),
    task({ id: 'c', parentId: 'b' }),
  ];

  /**
   * 原来这儿是一层：把孩子接在父亲后面就完了，孙辈留在原位——一棵三层的树
   * 在列表里会散成「父 + 子」和一个不知道从哪冒出来的孙子。
   */
  it('孙辈跟在父亲后面，不留在原位', () => {
    // 故意把 c 摆在最前面，证明它是被 b 带过去的，不是本来就在那儿。
    expect(ids(nestChildren([chain[3]!, chain[0]!, chain[1]!, chain[2]!])))
      .toEqual(['z', 'a', 'b', 'c']);
  });

  it('数据里已经有环：不无限递归，也不吞掉任何一条', () => {
    const ring = [task({ id: 'x', parentId: 'y' }), task({ id: 'y', parentId: 'x' })];
    expect(() => nestChildren(ring)).not.toThrow();
    expect(ids(nestChildren(ring)).sort()).toEqual(['x', 'y']);
  });

  /**
   * **「卡住」看整棵子树。** 一个项目下面挂着一个搁置的阶段、而那个阶段里
   * 还有一条能动的任务——它没有卡住。只看一层会把它误报，而这份清单一旦
   * 开始误报就不再被当真。
   */
  it('孙辈里还有能动的：不算卡住', () => {
    const all = [
      task({ id: 'p' }),
      task({ id: 'k', parentId: 'p', status: 'later' }),
      task({ id: 'g', parentId: 'k', status: 'todo' }),
    ];
    expect(ids(stalledProjects(all))).toEqual([]);
  });

  it('整棵子树都不能动了：算卡住', () => {
    const all = [
      task({ id: 'p' }),
      task({ id: 'k', parentId: 'p', status: 'later' }),
      task({ id: 'g', parentId: 'k', status: 'abandoned' }),
    ];
    expect(ids(stalledProjects(all))).toEqual(['p']);
  });
});

/**
 * **父任务的「开始时间」向下传。**
 *
 * `startAt` 的出处是 OmniFocus 的 Defer Date，而「容器的 defer 罩住里面所有
 * 东西」是那个概念定义的一部分：
 *
 * > Assigning a Defer Date to an action group or project tells OmniFocus that
 * > **neither the item nor any contained items** are Available for work until
 * > the Defer Date has passed.  —— 《The Outline》
 *
 * 在这之前 `parentId` 在整个仓库里**从不参与任何日期或可用性判断**——给
 * 「装修」设 9 月 1 日开始，父任务正确地从四象限和「现在做什么」里隐去了，
 * 它底下那三条活儿照常摆着、照常被推荐。
 */
describe('blockingAncestor / notStartedDeep：父亲还没开始，孩子也做不了', () => {
  const NOW = new Date(2026, 7, 25, 12, 0, 0);
  const LATER = new Date(2026, 8, 1, 9).toISOString();   // 9/1，未来
  const PAST = new Date(2026, 7, 1, 9).toISOString();    // 8/1，已经过了

  const parent = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const child = (over: Partial<Task> = {}) => task({ id: 'c', title: '量尺寸', parentId: 'p', ...over });

  it('**父亲 9/1 才开始：孩子现在也做不了**，而且说得出是谁挡着', () => {
    const all = [parent({ startAt: LATER }), child()];
    expect(blockingAncestor(all[1], NOW, all)?.title).toBe('装修');
    expect(notStartedDeep(all[1], NOW, all)).toBe(true);
  });

  it('**孩子自己没有开始时间**——这一条是重点：`notStarted` 对它恒为 false，挡住它的只可能是父亲', () => {
    const all = [parent({ startAt: LATER }), child()];
    expect(all[1].startAt).toBeNull();
    expect(notStarted(all[1], NOW)).toBe(false);
    expect(notStartedDeep(all[1], NOW, all)).toBe(true);
  });

  it('父亲的开始时间已经过了：谁都不挡着，孩子照常可做', () => {
    const all = [parent({ startAt: PAST }), child()];
    expect(blockingAncestor(all[1], NOW, all)).toBeUndefined();
    expect(notStartedDeep(all[1], NOW, all)).toBe(false);
  });

  it('父亲压根没设开始时间：同上', () => {
    const all = [parent(), child()];
    expect(notStartedDeep(all[1], NOW, all)).toBe(false);
  });

  it('**隔代也挡得住**——爷爷 9/1 才开始，孙子现在做不了', () => {
    const all = [
      parent({ startAt: LATER }),
      task({ id: 'm', title: '找工人', parentId: 'p' }),
      task({ id: 'g', title: '打电话', parentId: 'm' }),
    ];
    expect(blockingAncestor(all[2], NOW, all)?.title).toBe('装修');
    expect(notStartedDeep(all[2], NOW, all)).toBe(true);
  });

  it('**好几层都没开始时报最近的那个**——屏幕上要写它的名字，「装修」比「今年的事」更能解释眼前这条为什么不在', () => {
    const all = [
      task({ id: 'y', title: '今年的事', startAt: LATER }),
      task({ id: 'p', title: '装修', parentId: 'y', startAt: new Date(2026, 8, 15, 9).toISOString() }),
      task({ id: 'c', title: '量尺寸', parentId: 'p' }),
    ];
    expect(blockingAncestor(all[2], NOW, all)?.title).toBe('装修');
  });

  it('自己就没开始的：`notStartedDeep` 为真，跟有没有父亲无关', () => {
    const lone = task({ id: 'x', startAt: LATER });
    expect(notStartedDeep(lone, NOW, [lone])).toBe(true);
    expect(blockingAncestor(lone, NOW, [lone])).toBeUndefined();
  });

  it('顶层任务没有父亲可查，也不该崩', () => {
    const lone = task({ id: 'x' });
    expect(blockingAncestor(lone, NOW, [lone])).toBeUndefined();
    expect(notStartedDeep(lone, NOW, [lone])).toBe(false);
  });

  it('`parentId` 指向一条不存在的任务（删了、还没拉到）：当没有父亲，不挡也不崩', () => {
    const orphan = task({ id: 'c', parentId: '不存在' });
    expect(blockingAncestor(orphan, NOW, [orphan])).toBeUndefined();
    expect(notStartedDeep(orphan, NOW, [orphan])).toBe(false);
  });

  /**
   * 服务端 `checkParentLink` 保证不成环，但这里不留一个没有上界的 while——
   * 手改 `data/tasks/` 造得出环，而一个转不出来的循环比一条显示不对糟得多。
   */
  it('**手改文件造出的环不会把它转死**：有上界，返回一个答案就完事', () => {
    const a = task({ id: 'a', title: 'A', parentId: 'b' });
    const b = task({ id: 'b', title: 'B', parentId: 'a' });
    expect(() => blockingAncestor(a, NOW, [a, b])).not.toThrow();
    expect(() => notStartedDeep(a, NOW, [a, b])).not.toThrow();
  });

  /**
   * **只传递，不钳制。** OmniFocus 还有一条「子项的 defer 不能早于父的」，
   * 填了会被拉回去。这里有意不做——它跟本仓库「收下用户自相矛盾的输入」那条
   * 既有约定正面冲突（`server/src/task.ts`）。这条钉住「不改写他填的日期」。
   */
  it('孩子自己填了一个比父亲更早的开始时间：**原样留着，不被改写**，只是照样做不了', () => {
    const all = [parent({ startAt: LATER }), child({ startAt: new Date(2026, 7, 26, 9).toISOString() })];
    expect(all[1].startAt).toBe(new Date(2026, 7, 26, 9).toISOString()); // 没被拉到 9/1
    expect(notStartedDeep(all[1], NOW, all)).toBe(true);
  });
});
