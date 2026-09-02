import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendExpandNote, applyReorder, applyTaskPatch, cascadeChildrenDone, cascadeListToChildren, checkParentLink,
  depthOf, descendantIds, detachDeletedTasks, subtreeHeight,
  hasTwinInstance,
  maybeSpawnNextInstance, patchMany, restoreFromTrash, rollUpParentDone, softDeleteTasks,
} from './mutate.js';
import type { InboxItem, Proposal, Repeat, Task, TrashItem } from './store.js';

// `nextInstance`（间接经 maybeSpawnNextInstance 调用）按本地墙钟做日历加法——
// 钉死时区，这份文件的断言才不会跟着宿主机时区飘，跟 repeat.test.ts 同一条规矩。
beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
  completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});

const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

// applyTaskPatch 本身的行为规则（提醒章重算、完成时间盖章、推迟计数……）已经
// 在 applyTaskPatch.test.ts 里逐条测过（那份文件经 app.ts 的兼容包装间接测
// 这同一个实现，见 mutate.ts 顶部的注释）。这里只补一条那份测不出来的：
// `now` 必须是显式参数，不能悄悄读系统时钟——这才是「纯函数」这句话的验收点。
describe('applyTaskPatch：now 是显式参数，不读系统时钟', () => {
  it('completedAt/updatedAt 精确等于传入的 now', () => {
    const out = applyTaskPatch(task({ status: 'todo' }), { status: 'done' }, '2020-01-01T00:00:00.000Z');
    expect(out.completedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(out.updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('同样的 prev/patch/now，两次调用结果逐字段相同——可重放，不依赖调用时刻', () => {
    const prev = task({ reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: null }] });
    const patch = { status: 'done' as const };
    const a = applyTaskPatch(prev, patch, '2026-08-05T00:00:00.000Z');
    const b = applyTaskPatch(prev, patch, '2026-08-05T00:00:00.000Z');
    expect(a).toEqual(b);
  });
});

describe('maybeSpawnNextInstance', () => {
  it('跃迁到 done 且有 repeat：生成下一条，due 按周期推进', () => {
    const next = task({ status: 'done', repeat: DAILY, due: '2026-08-10T09:00:00.000Z' });
    const born = maybeSpawnNextInstance('todo', next, [next], new Date('2026-08-10T10:00:00.000Z'));
    expect(born).not.toBeNull();
    expect(born!.status).toBe('todo');
    expect(born!.due).toBe('2026-08-11T09:00:00.000Z');
  });

  it('没有 repeat：不生成', () => {
    const next = task({ status: 'done' });
    expect(maybeSpawnNextInstance('todo', next, [next], new Date('2026-08-10T10:00:00.000Z'))).toBeNull();
  });

  it('done -> done（不是跃迁，比如改个备注）：不生成', () => {
    const next = task({ status: 'done', repeat: DAILY, due: '2026-08-10T09:00:00.000Z' });
    expect(maybeSpawnNextInstance('done', next, [next], new Date('2026-08-10T10:00:00.000Z'))).toBeNull();
  });

  it('rows 里已经有同 repeat、同标题、同 due、未完成的同款——查重挡住，不再生成第二条', () => {
    const next = task({ id: 'a', status: 'done', repeat: DAILY, title: '写周报', due: '2026-08-10T09:00:00.000Z' });
    const alreadyBorn = task({ id: 'b', status: 'todo', repeat: DAILY, title: '写周报', due: '2026-08-11T09:00:00.000Z' });
    expect(maybeSpawnNextInstance('todo', next, [next, alreadyBorn], new Date('2026-08-10T10:00:00.000Z'))).toBeNull();
  });
});

// 这份判据本来只长在 maybeSpawnNextInstance 的函数体里（`alreadyBorn` 那一句），
// 提出来是因为 `POST /api/push` 要用同一份：手机离线完成生成了实例 A、桌面上也
// 完成过生成了实例 B，A 作为「离线新建」推上来会跟 B 并存。
//
// 五个条件各有一条自己的测试，**每一条都能被单独变异出来**（把对应的合取项删掉，
// 恰好红一条）。少测一条的后果分两个方向，而且下面那个方向更糟：
//   - 判得太松 → 重复实例照样并存（看板上两张一模一样的卡）；
//   - 判得太紧 → 手机上真的新建的任务被当成「同款」静默丢弃（数据没了，没人知道）。
describe('hasTwinInstance：同一条重复任务的下一条实例已经有了', () => {
  const DUE = '2026-08-23T09:00:00.000Z';
  const cand = (p: Partial<Task> = {}) => task({ id: 'cand', title: '倒垃圾', due: DUE, repeat: DAILY, ...p });
  const row = (p: Partial<Task> = {}) => task({ id: 'x', title: '倒垃圾', due: DUE, repeat: DAILY, ...p });

  it('已经有一条同 repeat、同标题、同 due、还没完成的 → true', () => {
    expect(hasTwinInstance([row()], cand())).toBe(true);
  });

  it('那一条已完成 → false（完成过的不算「已经生成过」，下一条该照常生成）', () => {
    expect(hasTwinInstance([row({ status: 'done' })], cand())).toBe(false);
  });

  it('标题不同 → false（手机上真的新建的另一条任务，不许被当成同款静默丢掉）', () => {
    expect(hasTwinInstance([row({ title: '拖地' })], cand())).toBe(false);
  });

  it('due 不同 → false（下一个周期是另一条实例，不是同款）', () => {
    expect(hasTwinInstance([row({ due: '2026-08-24T09:00:00.000Z' })], cand())).toBe(false);
  });

  it('repeat 为空的普通任务不算同款 → false（手写了一条同名同日的一次性任务，不该挡住重复链条）', () => {
    expect(hasTwinInstance([row({ repeat: null })], cand())).toBe(false);
  });

  it('id 相同的那条是它自己，不算同款 → false（否则任何一条重复任务都判自己是同款）', () => {
    expect(hasTwinInstance([cand()], cand())).toBe(false);
  });

  it('rows 里混着一堆无关任务也照样命中——只要有一条同款就是 true', () => {
    expect(hasTwinInstance([task({ id: 'a' }), row(), task({ id: 'b' })], cand())).toBe(true);
  });
});

// 两条删除路由（单条 DELETE /api/tasks/:id、批量 DELETE /api/tasks）本来各自
// 手写了一份逐行同构的引用清理，这次合并成这一份；Task 6 的 POST /api/push 是
// 第三个调用方。变异这个函数，app.test.ts 单条和批量两边的删除用例必须同时红
// ——那才是「只有一份实现」的判据。
describe('detachDeletedTasks：任务删了，收件箱和提议里指向它的引用要清掉', () => {
  const box = (p: Partial<InboxItem> = {}): InboxItem =>
    ({ id: 'i1', text: '买菜', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['t1', 't2'], ...p });
  const prop = (p: Partial<Proposal> = {}): Proposal =>
    ({ id: 'p1', taskId: 't1', patch: { notes: 'x' }, reason: '理由', createdAt: '2026-08-01T00:00:00.000Z', ...p });

  it('清掉被删任务的 id，别的留着', () => {
    const r = detachDeletedTasks([box()], [], new Set(['t1']));
    expect(r.inbox![0].taskIds).toEqual(['t2']);
  });

  it('没引用被删任务的收件箱条目原样不动', () => {
    const untouched = box({ id: 'i2', taskIds: ['t9'] });
    const r = detachDeletedTasks([box(), untouched], [], new Set(['t1']));
    expect(r.inbox![1]).toBe(untouched);   // 同一个对象，连拷贝都没做
  });

  it('没有任何引用要清 → 两张表都回 null，调用方据此不写盘', () => {
    const r = detachDeletedTasks([box({ taskIds: ['t9'] })], [prop({ taskId: 't9' })], new Set(['t1']));
    expect(r.inbox).toBeNull();
    expect(r.proposals).toBeNull();
  });

  it('挂在被删任务名下的提议整条摘掉，别的任务的提议不受影响', () => {
    const r = detachDeletedTasks([], [prop({ id: 'p1', taskId: 't1' }), prop({ id: 'p2', taskId: 't9' })], new Set(['t1']));
    expect(r.proposals!.map((x) => x.id)).toEqual(['p2']);
  });

  it('一次清多个 id——批量删除传的是整个集合', () => {
    const r = detachDeletedTasks([box({ taskIds: ['t1', 't2', 't3'] })], [], new Set(['t1', 't3']));
    expect(r.inbox![0].taskIds).toEqual(['t2']);
  });
});

describe('softDeleteTasks', () => {
  it('把命中的任务从 tasks 摘掉、搬进 trash，并打 deletedAt', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const { tasks, trash } = softDeleteTasks([a, b], [], ['a'], '2026-08-10T00:00:00.000Z');
    expect(tasks).toEqual([b]);
    expect(trash).toEqual([{ ...a, deletedAt: '2026-08-10T00:00:00.000Z' }]);
  });

  it('接受数组或 Set，结果一样——单条 DELETE 传数组、批量 DELETE 传 Set', () => {
    const a = task({ id: 'a' });
    const viaArray = softDeleteTasks([a], [], ['a'], 'x');
    const viaSet = softDeleteTasks([a], [], new Set(['a']), 'x');
    expect(viaArray).toEqual(viaSet);
  });

  it('ids 里没有命中的——tasks 原样、trash 原有条目不受影响', () => {
    const a = task({ id: 'a' });
    const existingTrash: TrashItem[] = [{ ...task({ id: 'z' }), deletedAt: '2020-01-01T00:00:00.000Z' }];
    const { tasks, trash } = softDeleteTasks([a], existingTrash, ['不存在'], 'x');
    expect(tasks).toEqual([a]);
    expect(trash).toEqual(existingTrash);
  });

  it('trash 是追加，不是替换——原有的垃圾箱条目还在', () => {
    const a = task({ id: 'a' });
    const existingTrash: TrashItem[] = [{ ...task({ id: 'z' }), deletedAt: '2020-01-01T00:00:00.000Z' }];
    const { trash } = softDeleteTasks([a], existingTrash, ['a'], '2026-01-01T00:00:00.000Z');
    expect(trash).toHaveLength(2);
    expect(trash[0]).toEqual(existingTrash[0]);
    expect(trash[1]).toEqual({ ...a, deletedAt: '2026-01-01T00:00:00.000Z' });
  });
});

// task-2-report 修复轮 2 I5：这份原来在 app.ts 的 PATCH /api/tasks/reorder
// 里，Task 2 的离线本地实现（web/src/lib/dataSource.ts）逐行手抄了一份——
// 提出来共用，两边都不能悄悄分叉。
describe('applyReorder', () => {
  it('按 ids 的顺序重写 order，数组下标就是新的 order，真的变了的 id 才进 changedIds', () => {
    const a = task({ id: 'a', order: 0 });
    const b = task({ id: 'b', order: 1 });
    const { tasks, changedIds } = applyReorder([a, b], ['b', 'a'], '2026-08-10T00:00:00.000Z');

    expect(tasks.find((t) => t.id === 'a')!.order).toBe(1);
    expect(tasks.find((t) => t.id === 'b')!.order).toBe(0);
    expect(tasks.find((t) => t.id === 'a')!.updatedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(changedIds.slice().sort()).toEqual(['a', 'b']);
  });

  it('order 没变的任务不进 changedIds，updatedAt 也不重写——原样重新提交一次同样的顺序等于空转', () => {
    const a = task({ id: 'a', order: 0, updatedAt: '2020-01-01T00:00:00.000Z' });
    const { tasks, changedIds } = applyReorder([a], ['a'], '2026-08-10T00:00:00.000Z');

    expect(tasks[0]!.updatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(changedIds).toEqual([]);
  });

  it('ids 里有 tasks 中不存在的 id——直接忽略，不报错，其余任务照常按各自在 ids 里的位置重排', () => {
    const a = task({ id: 'a', order: 0 });
    const b = task({ id: 'b', order: 1 });
    const { tasks, changedIds } = applyReorder([a, b], ['不存在的id', 'b', 'a'], 'x');

    expect(tasks.find((t) => t.id === 'a')!.order).toBe(2);
    expect(tasks.find((t) => t.id === 'b')!.order).toBe(1); // 在 ids 里排第二位（下标 1），跟原来的 order 一样
    expect(changedIds).toEqual(['a']);
  });

  it('tasks 里有一条不在 ids 里——原样不动，不进 changedIds，不是当时不在可见列表里的那些不该被决定新顺序', () => {
    const a = task({ id: 'a', order: 3 }); // 不等于它在 ids 里的下标（0），确保真的算「变了」
    const b = task({ id: 'b', order: 5, updatedAt: '2020-01-01T00:00:00.000Z' });
    const { tasks, changedIds } = applyReorder([a, b], ['a'], 'x');

    expect(tasks.find((t) => t.id === 'a')!.order).toBe(0);
    expect(tasks.find((t) => t.id === 'b')).toEqual(b);
    expect(changedIds).toEqual(['a']);
  });
});

/**
 * 多级任务的完整性判据（仿滴答清单，**最多五层**）。这几条只有服务端判得了
 * ——校验器（`checkTaskPatch`）只看得见一份 patch，看不见别的任务长什么样。
 */
describe('checkParentLink', () => {
  const all = [
    task({ id: 'top' }),
    task({ id: 'other' }),
    task({ id: 'kid', parentId: 'top' }),
  ];

  it('挂到 null（取消关联）永远可以', () => {
    expect(checkParentLink(all, 'kid', null)).toBeNull();
  });

  it('挂到一条顶层任务下面可以', () => {
    expect(checkParentLink(all, 'other', 'top')).toBeNull();
  });

  it('不能挂到自己身上', () => {
    expect(checkParentLink(all, 'top', 'top')).toMatch(/自己/);
  });

  it('父任务不存在（删了、id 打错）', () => {
    expect(checkParentLink(all, 'other', '不存在')).toMatch(/找不到/);
  });

  /**
   * **这两条跟只做一层那时候正好相反**，整条换掉了——五层下「挂到一个子任务
   * 下面」和「带着子树挪到别人下面」都是正常操作，只要不超上限。
   */
  it('挂到一个子任务下面：合法，那只是往深里再走一层', () => {
    expect(checkParentLink(all, 'other', 'kid')).toBeNull();
  });

  it('不能挂到自己的后代下面——那会绕成一个圈，nestChildren 会无限递归', () => {
    expect(checkParentLink(all, 'top', 'kid')).toMatch(/圈/);
  });

  /**
   * **上限判的是「父亲的层数 + 自己整棵子树的高度」**，不是「父亲的层数 + 1」。
   * 把一棵三层的子树挂到一棵三层的下面是 6 层，超了——只看父亲那一层会漏。
   */
  it('挂上去超过五层：拒绝，并且说清是因为深度', () => {
    const chain = (p: string, n: number): Task[] => Array.from({ length: n }, (_, i) =>
      task({ id: `${p}${i}`, parentId: i === 0 ? null : `${p}${i - 1}` }));
    const deep = [...chain('c', 3), ...chain('d', 3)];
    expect(checkParentLink(deep, 'd0', 'c2')).toMatch(/6 层|最多 5 层/);
    // 挂到第一层上是 1 + 3 = 4 层，可以。
    expect(checkParentLink(deep, 'd0', 'c0')).toBeNull();
  });

  it('自己名下有子任务时照样能挂到别人下面——带着子树一起挪是合法的', () => {
    expect(checkParentLink(all, 'top', 'other')).toBeNull();
  });
});

describe('softDeleteTasks：删父任务时子任务跟着一起进垃圾箱（仿滴答清单）', () => {
  it('父子一起进垃圾箱，层级原样留着', () => {
    const all = [task({ id: 'p' }), task({ id: 'k', parentId: 'p' }), task({ id: 'z' })];
    const out = softDeleteTasks(all, [], ['p'], '2026-08-20T00:00:00.000Z');
    expect(out.tasks.map((t) => t.id)).toEqual(['z']);
    expect(out.trash.map((t) => t.id).sort()).toEqual(['k', 'p']);
    // parentId **不清**：还原时靠它把层级接回去
    expect(out.trash.find((t) => t.id === 'k')!.parentId).toBe('p');
    // 同一次删的盖同一个戳——`restoreFromTrash` 按这个认「它俩是一起删的」
    expect(new Set(out.trash.map((t) => t.deletedAt)).size).toBe(1);
  });

  it('删子任务不会反过来带走父亲——连带只往下走，不往上', () => {
    const all = [task({ id: 'p' }), task({ id: 'k', parentId: 'p' })];
    const out = softDeleteTasks(all, [], ['k'], '2026-08-20T00:00:00.000Z');
    expect(out.tasks.map((t) => t.id)).toEqual(['p']);
    expect(out.trash.map((t) => t.id)).toEqual(['k']);
  });

  it('不是这次删的那些原样不动，连 updatedAt 都不碰', () => {
    const all = [task({ id: 'p' }), task({ id: 'z', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const out = softDeleteTasks(all, [], ['p'], '2026-08-20T00:00:00.000Z');
    expect(out.tasks.find((t) => t.id === 'z')!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});


/**
 * 完成父任务连带完成子任务（仿滴答清单）。补的是「父任务已完成、卡片上却还写
 * 着『子任务 1/2』，而那一条照旧躺在今天里」这个看不懂的状态。
 */
describe('cascadeChildrenDone', () => {
  const NOW = '2026-08-20T10:00:00.000Z';
  const parent = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const kid = (id: string, over: Partial<Task> = {}) => task({ id, title: id, parentId: 'p', ...over });

  it('父任务跃迁到 done，底下没了结的子任务一起完成，章也盖上', () => {
    const done = parent({ status: 'done' });
    const rows = cascadeChildrenDone('todo', done, [done, kid('k1'), kid('k2', { status: 'doing' })], NOW)!;
    expect(rows.slice(1).map((t) => t.status)).toEqual(['done', 'done']);
    expect(rows[1].completedAt).toBe(NOW);
  });

  it('**只在跃迁那一刻做一次**——done → done 改个备注，不该把他手动重开过的子任务再按下去', () => {
    const done = parent({ status: 'done' });
    expect(cascadeChildrenDone('done', done, [done, kid('k1')], NOW)).toBeNull();
  });

  it('父任务不是变成 done 就什么都不做', () => {
    const doing = parent({ status: 'doing' });
    expect(cascadeChildrenDone('todo', doing, [doing, kid('k1')], NOW)).toBeNull();
  });

  it('搁置和放弃的子任务不碰——那是他明确做过的判断，「父任务完成了」不是推翻它的理由', () => {
    const done = parent({ status: 'done' });
    const rows = cascadeChildrenDone('todo', done, [
      done, kid('later', { status: 'later' }), kid('gone', { status: 'abandoned' }), kid('open'),
    ], NOW)!;
    expect(rows.map((t) => t.status)).toEqual(['done', 'later', 'abandoned', 'done']);
  });

  it('已经完成的子任务不重新盖章——完成时刻是「什么时候做完的」，不该被父亲改写', () => {
    const done = parent({ status: 'done' });
    const already = kid('k1', { status: 'done', completedAt: '2026-08-01T00:00:00.000Z' });
    const rows = cascadeChildrenDone('todo', done, [done, already, kid('k2')], NOW)!;
    expect(rows[1].completedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('一条可连带的都没有就返回 null——调用方据此不写盘，空转的写会白占一次 .bak', () => {
    const done = parent({ status: 'done' });
    expect(cascadeChildrenDone('todo', done, [done], NOW)).toBeNull();
    expect(cascadeChildrenDone('todo', done, [done, kid('k1', { status: 'done' })], NOW)).toBeNull();
  });

  it('别人家的子任务不受牵连', () => {
    const done = parent({ status: 'done' });
    const other = task({ id: 'x', parentId: 'other' });
    const rows = cascadeChildrenDone('todo', done, [done, other, kid('k1')], NOW)!;
    expect(rows[1].status).toBe('todo');
  });
});

/**
 * 从垃圾箱捞回来。**服务端的还原路由和离线那条共用这一份**——这段判断原来
 * 只长在路由里，于是「离线能删、但永远还不了」，而垃圾箱存在的全部意义就是
 * 让删除不是一扇单向门。
 */
describe('restoreFromTrash', () => {
  const AT = '2026-08-20T10:00:00.000Z';
  const inTrash = (over: Partial<Task> = {}) => ({ ...task({ id: 'gone', title: '写周报', ...over }), deletedAt: AT });

  it('捞回 tasks、从 trash 里摘掉', () => {
    const next = restoreFromTrash([task({ id: 'a' })], [inTrash()], 'gone')!;
    expect(next.tasks.map((t) => t.id).sort()).toEqual(['a', 'gone']);
    expect(next.trash).toEqual([]);
  });

  it('**deletedAt 不跟着回去**——它是「在垃圾箱里」这件事本身的记号，留在任务上就是个没人读也没人清的幽灵字段', () => {
    const next = restoreFromTrash([], [inTrash()], 'gone')!;
    expect('deletedAt' in next.restored).toBe(false);
  });

  it('**order 清成 null**——在垃圾箱里躺着的时候那个位置早被别的卡占了，带着老数字回来会盖过他亲手排在第一的卡', () => {
    const next = restoreFromTrash([], [inTrash({ order: 0 })], 'gone')!;
    expect(next.restored.order).toBeNull();
  });

  it('别的字段一个不动', () => {
    const next = restoreFromTrash([], [inTrash({ status: 'doing', priority: 3, tags: ['紧急'] })], 'gone')!;
    expect(next.restored).toMatchObject({ status: 'doing', priority: 3, tags: ['紧急'] });
  });

  /**
   * **同一次删进去的子任务一起捞回来。** 这是 `softDeleteTasks` 那条「父任务
   * 连子任务一起删」的另一半：只删不还，等于把「删除是可还原的」这条规矩在
   * 层级这一维上撕掉——删完父任务再还原，孩子会留在垃圾箱里，比不级联更糟。
   */
  it('同一次删进去的子任务跟着回来，层级原样接上', () => {
    const trash = [inTrash({ id: 'p' }), { ...task({ id: 'k', parentId: 'p' }), deletedAt: AT }];
    const next = restoreFromTrash([], trash, 'p')!;
    expect(next.tasks.map((t) => t.id).sort()).toEqual(['k', 'p']);
    expect(next.tasks.find((t) => t.id === 'k')!.parentId).toBe('p');
    expect(next.trash).toEqual([]);
    // 返回的 restored 仍然是他点的那一条
    expect(next.restored.id).toBe('p');
  });

  /**
   * **整棵子树，不只直接子任务。** `softDeleteTasks` 删的是整棵（`descendantIds`），
   * 这儿原来只捞一层：三层的「装修 → 刷墙 → 买涂料」删掉再还原，买涂料永久留在
   * 垃圾箱，刷墙回来后显示「子任务 0/0」。删除确认框上写的是「还原时一起回来」。
   * 离线那条路按 `back` 打同步记号，孙辈不在 `back` 里的话下一次联网也一起没了。
   */
  it('三层一起删的，三层一起回来——孙辈不能留在垃圾箱里', () => {
    const trash = [
      inTrash({ id: 'p' }),
      { ...task({ id: 'k', parentId: 'p' }), deletedAt: AT },
      { ...task({ id: 'g', parentId: 'k' }), deletedAt: AT },
    ];
    const next = restoreFromTrash([], trash, 'p')!;
    expect(next.tasks.map((t) => t.id).sort()).toEqual(['g', 'k', 'p']);
    expect(next.back.map((t) => t.id).sort()).toEqual(['g', 'k', 'p']);
    expect(next.trash).toEqual([]);
    expect(next.restored.id).toBe('p');
  });

  it('链条中间那条是另一次删的：从它往下截断，上面的照回', () => {
    const trash = [
      inTrash({ id: 'p' }),
      { ...task({ id: 'k', parentId: 'p' }), deletedAt: '2026-08-13T10:00:00.000Z' },
      { ...task({ id: 'g', parentId: 'k' }), deletedAt: AT },   // 跟 p 同一次删的，但父亲 k 不回来
    ];
    const next = restoreFromTrash([], trash, 'p')!;
    expect(next.tasks.map((t) => t.id)).toEqual(['p']);
    expect(next.trash.map((t) => t.id).sort()).toEqual(['g', 'k']);
  });

  it('**不是同一次删的不捞**——上周单独删掉的那条子任务是他当时的决定', () => {
    const trash = [
      inTrash({ id: 'p' }),
      { ...task({ id: 'k', parentId: 'p' }), deletedAt: '2026-08-13T10:00:00.000Z' },
    ];
    const next = restoreFromTrash([], trash, 'p')!;
    expect(next.tasks.map((t) => t.id)).toEqual(['p']);
    expect(next.trash.map((t) => t.id)).toEqual(['k']);
  });

  it('子任务也 order 清成 null——跟父亲同一条理由', () => {
    const trash = [inTrash({ id: 'p' }), { ...task({ id: 'k', parentId: 'p', order: 3 }), deletedAt: AT }];
    const next = restoreFromTrash([], trash, 'p')!;
    expect(next.tasks.find((t) => t.id === 'k')!.order).toBeNull();
  });

  it('垃圾箱里没有这一条就返回 null——调用方据此回 404 / 不写盘', () => {
    expect(restoreFromTrash([], [inTrash()], '别的')).toBeNull();
  });

  it('垃圾箱里别的条目不受影响', () => {
    const other = { ...task({ id: 'other' }), deletedAt: AT };
    const next = restoreFromTrash([], [inTrash(), other], 'gone')!;
    expect(next.trash.map((x) => x.id)).toEqual(['other']);
  });
});

/**
 * 最后一个子任务做完 → 父任务自动完成。**这是「检查事项全部勾完 → 主任务
 * 自动完成」那条规矩的另一半**：一层是检查事项，一层是子任务，而子任务这
 * 一半一直没有——四步全做完了，头上那条「装修」还开着。
 */
describe('rollUpParentDone', () => {
  const NOW = '2026-08-20T10:00:00.000Z';
  const parent = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const kid = (id: string, status: Task['status'] = 'todo') => task({ id, parentId: 'p', status });

  const run = (rows: Task[], child: Task, prev: Task['status'] = 'todo') =>
    rollUpParentDone(prev, child, rows, NOW);

  it('最后一个做完，父亲跟着完成，章也盖上', () => {
    const last = kid('k2', 'done');
    const rows = run([parent(), kid('k1', 'done'), last], last)!;
    expect(rows.find((t) => t.id === 'p')!.status).toBe('done');
    expect(rows.find((t) => t.id === 'p')!.completedAt).toBe(NOW);
  });

  it('还有没做完的兄弟就不动', () => {
    const done = kid('k1', 'done');
    expect(run([parent(), done, kid('k2')], done)).toBeNull();
  });

  it('**搁置的兄弟挡着**——那件事还在，只是暂时不想做', () => {
    const done = kid('k1', 'done');
    expect(run([parent(), done, kid('k2', 'later')], done)).toBeNull();
  });

  it('**放弃了的兄弟不算数**——跟卡片上「子任务 1/2」那个记号用的是同一套，否则会出现显示 2/2 了父亲还开着', () => {
    const done = kid('k1', 'done');
    const rows = run([parent(), done, kid('k2', 'abandoned')], done)!;
    expect(rows.find((t) => t.id === 'p')!.status).toBe('done');
  });

  it('只在**跃迁**那一刻做一次——done → done（改个备注）不该把他手动重开过的父亲再按下去', () => {
    const done = kid('k1', 'done');
    expect(run([parent(), done], done, 'done')).toBeNull();
  });

  it('子任务不是变成 done 就什么都不做', () => {
    const doing = kid('k1', 'doing');
    expect(run([parent(), doing], doing)).toBeNull();
  });

  it('**搁置/放弃的父亲不碰**——那是他明确做过的判断，「孩子都做完了」不是推翻它的理由', () => {
    for (const st of ['later', 'abandoned'] as const) {
      const done = kid('k1', 'done');
      expect(run([parent({ status: st }), done], done), st).toBeNull();
    }
  });

  it('顶层任务（没有父亲）什么都不做', () => {
    const lone = task({ id: 'x', status: 'done' });
    expect(run([lone], lone)).toBeNull();
  });

  it('父亲已经不在了（被删了）也不崩', () => {
    const orphan = task({ id: 'k', parentId: '没了', status: 'done' });
    expect(run([orphan], orphan)).toBeNull();
  });
});

describe('applyTaskPatch：检查事项自动完成的那条也认了结', () => {
  const NOW = '2026-08-20T10:00:00.000Z';
  const withSubs = (status: Task['status']) =>
    task({ id: 'a', status, subtasks: [{ text: '一', done: false }] });

  it('待办的照旧自动完成', () => {
    const next = applyTaskPatch(withSubs('todo'), { subtasks: [{ text: '一', done: true }] }, NOW);
    expect(next.status).toBe('done');
  });

  it('**已放弃的不自动完成**——勾掉最后一个检查事项，不该拿一个顺手的动作推翻一个明确的决定', () => {
    const next = applyTaskPatch(withSubs('abandoned'), { subtasks: [{ text: '一', done: true }] }, NOW);
    expect(next.status).toBe('abandoned');
  });

  it('搁置的同理', () => {
    const next = applyTaskPatch(withSubs('later'), { subtasks: [{ text: '一', done: true }] }, NOW);
    expect(next.status).toBe('later');
  });
});

/**
 * **重复档改到不够格当习惯，习惯记号跟着摘掉。**
 *
 * `checkTaskPatch` 只守「patch 里带了 `habit`」那半边（它看不见原任务的
 * repeat）。反方向一直没人守：只改 `repeat` 的 patch 一路通过，留下
 * `habit: true` + 每月重复。
 *
 * 而这条路正是被设计出来的用法——`repeat` 在 `PROPOSABLE` 里、`habit` 不在，
 * AI 提一条「改成每月一次」他点接受就是这个走法。症状不是崩，是两块屏幕
 * 各说各话：卡片按 `isHabit` 当它不是习惯（连续天数、打卡格全没了），
 * 编辑器里那个勾读原始的 `t.habit`、照样勾着。
 */
describe('applyTaskPatch：重复档不够格了就摘掉习惯记号', () => {
  const NOW = '2026-08-20T10:00:00.000Z';
  const daily = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };
  const habit = () => task({ id: 'h', habit: true, repeat: daily });

  it('改成每月：记号摘掉——「每月打卡」不是习惯，是一条普通的重复任务', () => {
    const next = applyTaskPatch(habit(), { repeat: { ...daily, every: 'month' } }, NOW);
    expect(next.habit).toBe(false);
    expect(next.repeat!.every).toBe('month');
  });

  it('改成不重复：同理，习惯的定义里就含着「反复做」', () => {
    expect(applyTaskPatch(habit(), { repeat: null }, NOW).habit).toBe(false);
  });

  it('每天改成每周：还够格，记号留着——「一周三次」也是习惯', () => {
    const next = applyTaskPatch(habit(), { repeat: { ...daily, every: 'week', weekdays: [1, 3, 5] } }, NOW);
    expect(next.habit).toBe(true);
  });

  it('这次 patch 没碰 repeat 的一律不动——改个标题不该把习惯记号摘了', () => {
    expect(applyTaskPatch(habit(), { title: '改个标题' }, NOW).habit).toBe(true);
  });

  it('patch 自己带了 habit 就听它的——那半边归 checkTaskPatch 守，这儿不抢', () => {
    const next = applyTaskPatch(task({ id: 'h', habit: false, repeat: null }), { repeat: daily, habit: true }, NOW);
    expect(next.habit).toBe(true);
  });

  it('本来就不是习惯的不受影响', () => {
    const next = applyTaskPatch(task({ id: 'x', habit: false, repeat: daily }), { repeat: null }, NOW);
    expect(next.habit).toBe(false);
  });
});

/**
 * 父任务换清单，子任务跟着走。补的是一个说不通的分裂：`promoteSubtask` 建出来
 * 的子任务就是从父亲那儿继承的 `listId`（「同一件事的一步，不该掉进收件箱」），
 * 而父亲后来换清单时那几步却原地留在旧清单里。
 */
describe('cascadeListToChildren', () => {
  const NOW = '2026-08-20T10:00:00.000Z';
  const p = (listId: string | null) => task({ id: 'p', title: '装修', listId });
  const kid = (id: string, listId: string | null) => task({ id, parentId: 'p', listId });

  it('原来跟父亲在一起的跟着走', () => {
    const rows = cascadeListToChildren(p('A'), p('B'), [p('B'), kid('k1', 'A'), kid('k2', 'A')], NOW)!;
    expect(rows.filter((t) => t.parentId === 'p').map((t) => t.listId)).toEqual(['B', 'B']);
  });

  it('**特意放在别的清单里的那个不动**——那是一个明确的安排，不该被父亲的一次移动顺手收编', () => {
    const rows = cascadeListToChildren(p('A'), p('B'), [p('B'), kid('跟着的', 'A'), kid('另放的', 'C')], NOW)!;
    expect(rows.find((t) => t.id === '另放的')!.listId).toBe('C');
    expect(rows.find((t) => t.id === '跟着的')!.listId).toBe('B');
  });

  it('从「不属于任何清单」挪出去时，同样在收件箱里的那几个跟着走', () => {
    const rows = cascadeListToChildren(p(null), p('B'), [p('B'), kid('k', null)], NOW)!;
    expect(rows.find((t) => t.id === 'k')!.listId).toBe('B');
  });

  it('挪回「不属于任何清单」也跟着——两个方向一样', () => {
    const rows = cascadeListToChildren(p('A'), p(null), [p(null), kid('k', 'A')], NOW)!;
    expect(rows.find((t) => t.id === 'k')!.listId).toBeNull();
  });

  it('清单没变就什么都不做——不是每次 patch 都去动一遍孩子', () => {
    expect(cascadeListToChildren(p('A'), p('A'), [p('A'), kid('k', 'A')], NOW)).toBeNull();
  });

  it('没有孩子、或者一个都不在同一个清单里，返回 null——调用方据此不写盘', () => {
    expect(cascadeListToChildren(p('A'), p('B'), [p('B')], NOW)).toBeNull();
    expect(cascadeListToChildren(p('A'), p('B'), [p('B'), kid('k', 'C')], NOW)).toBeNull();
  });

  it('别人家的孩子不受牵连', () => {
    const other = task({ id: 'x', parentId: '别的父亲', listId: 'A' });
    const rows = cascadeListToChildren(p('A'), p('B'), [p('B'), other, kid('k', 'A')], NOW)!;
    expect(rows.find((t) => t.id === 'x')!.listId).toBe('A');
  });
});

/**
 * 回归：**跳过本次不该算拖延**。`applyTaskPatch` 的推迟计数是字段级的
 * （「due 往后挪了就 +1」），而 `skipPatch` 正好也把 due 往后挪——于是每跳过
 * 一次，`postponeCount` 就悄悄涨一格，攒几次之后这条任务开始出现在「一拖再拖」
 * 的推荐里，AI 回顾也会把它当成长期拖延的典型。
 *
 * 两件事根本不是一回事：拖延是「同一次要做的事往后挪」，跳过是「这一次不做了，
 * 日程往前走一格」。
 */
describe('跳过本次不算拖延', () => {
  it('**patch 层面确实会误判**——这条钉住那个字段级判断的行为本身，改这条之前先看清楚它为什么在', () => {
    const t = task({ id: 'r', due: '2026-08-20T01:00:00.000Z', postponeCount: 0 });
    const next = applyTaskPatch(t, { due: '2026-08-21T01:00:00.000Z' }, '2026-08-20T10:00:00.000Z');
    expect(next.postponeCount).toBe(1);
  });
});

/**
 * **树工具**（放开到五层之后加的）——`descendantIds` / `depthOf` /
 * `subtreeHeight`。三个函数是这个仓库里「树长什么样」唯一的一份实现：
 * 删除连带、完成连带、换清单连带、`checkParentLink` 的深度和环判据、
 * web 那边的候选表和删除确认，全都问它们。
 */
describe('树工具：后代 / 层数 / 子树高度', () => {
  /** a → b → c → d，外加一条没关系的 z。 */
  const chain = [
    task({ id: 'a' }),
    task({ id: 'b', parentId: 'a' }),
    task({ id: 'c', parentId: 'b' }),
    task({ id: 'd', parentId: 'c' }),
    task({ id: 'z' }),
  ];

  it('descendantIds：整棵子树，不含自己', () => {
    expect([...descendantIds(chain, 'a')].sort()).toEqual(['b', 'c', 'd']);
    expect([...descendantIds(chain, 'c')]).toEqual(['d']);
    expect([...descendantIds(chain, 'd')]).toEqual([]);
    expect([...descendantIds(chain, 'z')]).toEqual([]);
  });

  it.each([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['z', 1]] as const)(
    'depthOf(%s) = %s', (id, want) => expect(depthOf(chain, id)).toBe(want));

  it.each([['a', 4], ['b', 3], ['c', 2], ['d', 1], ['z', 1]] as const)(
    'subtreeHeight(%s) = %s', (id, want) => expect(subtreeHeight(chain, id)).toBe(want));

  /**
   * **盘上的文件是人能手改的，而一个环会让这几个函数永远转不出来**——整个
   * 进程挂死，跟 `nextOccurrence` 顶部那道 Invalid Date 守卫防的是同一类事故。
   * `checkParentLink` 拦得住新造的环，拦不住已经写进文件的。
   */
  it('数据里已经有环：三个函数都不死循环', () => {
    const ring = [
      task({ id: 'x', parentId: 'y' }),
      task({ id: 'y', parentId: 'x' }),
    ];
    expect(() => descendantIds(ring, 'x')).not.toThrow();
    expect(() => depthOf(ring, 'x')).not.toThrow();
    expect(() => subtreeHeight(ring, 'x')).not.toThrow();
    expect(descendantIds(ring, 'x').has('y')).toBe(true);
  });
});

/**
 * **四条连带都要走整棵子树**（放开到五层之后）。只走一层的后果各不相同，
 * 但形状一样：孙辈被落下。
 */
describe('多级连带：整棵子树', () => {
  const stamp = '2026-09-01T00:00:00.000Z';
  const tree = (over: Partial<Task> = {}) => [
    task({ id: 'p', ...over }),
    task({ id: 'k', parentId: 'p' }),
    task({ id: 'g', parentId: 'k' }),
  ];

  it('删除：孙辈跟着进垃圾箱，不留成指向空处的孤儿', () => {
    const { tasks, trash } = softDeleteTasks(tree(), [], ['p'], stamp);
    expect(tasks).toEqual([]);
    expect(trash.map((t) => t.id).sort()).toEqual(['g', 'k', 'p']);
  });

  it('完成往下：孙辈也跟着完成', () => {
    const rows = tree({ status: 'done' });
    const out = cascadeChildrenDone('todo', rows[0]!, rows, stamp)!;
    expect(out.every((t) => t.status === 'done')).toBe(true);
  });

  it('换清单往下：孙辈也跟着走，一棵树不会散在两份清单里', () => {
    const rows = tree();
    const next = { ...rows[0]!, listId: 'L2' };
    const out = cascadeListToChildren(rows[0]!, next, rows.map((t) => (t.id === 'p' ? next : t)), stamp)!;
    expect(out.map((t) => t.listId)).toEqual(['L2', 'L2', 'L2']);
  });

  /**
   * **完成往上要一路收。** 只收一层的话，中间那个父亲变成已完成、而**它的
   * 父亲**还挂着且底下一条能动的都没有——那正是「卡住的项目」那份清单要抓的
   * 形状，由一次正常的完成动作造出来，说不过去。
   */
  it('完成往上：勾掉最深那条，上面两代一起收', () => {
    const rows = [
      task({ id: 'p' }),
      task({ id: 'k', parentId: 'p' }),
      task({ id: 'g', parentId: 'k', status: 'done' }),
    ];
    const out = rollUpParentDone('todo', rows[2]!, rows, stamp)!;
    expect(out.find((t) => t.id === 'k')!.status).toBe('done');
    expect(out.find((t) => t.id === 'p')!.status).toBe('done');
  });

  it('完成往上：还有别的兄弟没做完就停住，不越级收', () => {
    const rows = [
      task({ id: 'p' }),
      task({ id: 'k', parentId: 'p' }),
      task({ id: 'k2', parentId: 'p' }),
      task({ id: 'g', parentId: 'k', status: 'done' }),
    ];
    const out = rollUpParentDone('todo', rows[3]!, rows, stamp)!;
    expect(out.find((t) => t.id === 'k')!.status).toBe('done');
    // p 还有一个没做完的孩子 k2，不该被收掉。
    expect(out.find((t) => t.id === 'p')!.status).not.toBe('done');
  });
});

describe('appendExpandNote：一轮一行，轮次自己数', () => {
  it('第一次补要求算第 2 轮——第一次拆解就是第 1 轮', () => {
    expect(appendExpandNote('买猫粮', '按周分开')).toBe('买猫粮\n\n补充要求（第 2 轮）：按周分开');
  });

  it('已经有一行就接着数', () => {
    const once = appendExpandNote('买猫粮', '按周分开');
    expect(appendExpandNote(once, '还是太粗')).toMatch(/补充要求（第 3 轮）：还是太粗$/);
    // 前面几轮原样留着——他自己得看得见提过什么。
    expect(appendExpandNote(once, '还是太粗')).toContain('补充要求（第 2 轮）：按周分开');
  });

  /**
   * 只认行首。他自己在原话里写了「……我的补充要求（第 2 轮）：……」这种句子的话，
   * 不该被当成一轮——轮次数错了，下一轮的编号就跟着错，而这串编号是 AI 判断
   * 「最后一轮要求是哪句」的唯一依据。
   */
  it('句子中间出现同样的字不算一轮', () => {
    expect(appendExpandNote('我写了补充要求（第 2 轮）：随便说说', '按周分开'))
      .toMatch(/补充要求（第 2 轮）：按周分开$/);
  });
});

/**
 * **批量改的结果必须等于把每条单独 PATCH 一遍。** 服务端批量路由和离线
 * `patchTasksEach` 共用 `patchMany`，这里测的两条都是这个等式曾经被打破的地方。
 */
describe('patchMany：批量 = 逐条', () => {
  const NOW = new Date('2026-08-21T10:00:00.000Z');
  const daily: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

  /**
   * 父任务 a（不重复）+ 底下每天重复的 b，同一批：a 标完成、b 只改优先级。
   * a 的连带把 b 标成 done；原来 spawn 拿的是连带之后的那份，于是 b 那一轮看见
   * todo → done、生了一条幻影。分开发两次就不会生：b 没碰状态，a 的连带只对
   * 显式 patch 过的 id 生成（边界③）。`hasTwinInstance` 挡不住——幻影没有双胞胎。
   */
  it('连带完成的重复子任务不生成下一条——它自己改的不是状态', () => {
    const all = [
      task({ id: 'a-parent' }),
      task({ id: 'b-child', parentId: 'a-parent', repeat: daily, due: '2026-08-22T09:00:00.000Z' }),
    ];
    const { rows, born } = patchMany(all, new Map([['a-parent', { status: 'done' }], ['b-child', { priority: 2 }]]), NOW);
    expect(rows.find((t) => t.id === 'b-child')!.status).toBe('done');   // 连带照样发生
    expect(born, '不该多出一条 b 的下一次').toEqual([]);
  });

  it('对照：b 自己标完成时照样生成下一条', () => {
    const all = [task({ id: 'b', repeat: daily, due: '2026-08-22T09:00:00.000Z' })];
    const { born } = patchMany(all, new Map([['b', { status: 'done' }]]), NOW);
    expect(born).toHaveLength(1);
  });

  /**
   * p → k → g 三层都在 A，同一批 p 挪去 B、k 挪去 C。原来按文件顺序跑连带，
   * 先跑到谁 g 就跟谁走——同一份请求体只换 id 顺序，g 去的清单不一样。
   * 深的先：k 先把 g 带去 C，轮到 p 时两个都不在 A 了。g 跟最近的那个被改的
   * 祖先走，两种顺序答案一样。
   */
  it.each([
    ['p 在前', ['p', 'k', 'g']],
    ['k 在前', ['k', 'p', 'g']],
    ['g 在前', ['g', 'k', 'p']],
  ])('孙辈跟最近的被改祖先走，跟文件顺序无关（%s）', (_name, order) => {
    const byId: Record<string, Task> = {
      p: task({ id: 'p', listId: 'A' }),
      k: task({ id: 'k', parentId: 'p', listId: 'A' }),
      g: task({ id: 'g', parentId: 'k', listId: 'A' }),
    };
    const all = order.map((id) => byId[id]);
    const { rows } = patchMany(all, new Map([['p', { listId: 'B' }], ['k', { listId: 'C' }]]), NOW);
    const got = Object.fromEntries(rows.map((t) => [t.id, t.listId]));
    expect(got).toEqual({ p: 'B', k: 'C', g: 'C' });
  });

  it('touched 只数真的命中的 id，不存在的 id 忽略', () => {
    const { touched } = patchMany([task({ id: 'x' })], new Map([['x', { title: '改' }], ['没有的', { title: '改' }]]), NOW);
    expect(touched).toEqual(['x']);
  });
});
