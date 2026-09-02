import { describe, it, expect } from 'vitest';
import { undoDonePlan } from './undoDone.js';
import type { Repeat, Task } from '../types.js';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: '任务', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false,
  pinned: false, reviewedAt: null, parentId: null, ...over,
});

// 只有重复任务才用得上它（算「下次落在哪」）；别的用例它不参与。
const NOW = new Date(2026, 7, 22, 12);

const EVERY_DAY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null };

describe('undoDonePlan：算不算「勾完了一条」', () => {
  it('勾完了：给一条改回原状态的 patch', () => {
    const t = task();
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)).toEqual({ patch: { status: 'todo' }, partial: false, title: '任务', nextDue: null, cascades: [] });
  });

  it('**改回它原来那个状态，不是一律 todo**——从「进行中」勾完的，撤销该回到「进行中」', () => {
    const t = task({ status: 'doing' });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.patch).toEqual({ status: 'doing' });
  });

  it('从「搁置」直接勾完也算，撤销回「搁置」', () => {
    const t = task({ status: 'later' });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.patch).toEqual({ status: 'later' });
  });

  it('不是改状态的 patch（改个标题）不弹撤销', () => {
    const t = task();
    expect(undoDonePlan(t, { title: '改个名' }, [t], NOW)).toBeNull();
  });

  it('改成别的状态不弹——「搁置」「放弃」走的是卡片菜单，是想过才点的', () => {
    const t = task();
    expect(undoDonePlan(t, { status: 'abandoned' }, [t], NOW)).toBeNull();
    expect(undoDonePlan(t, { status: 'later' }, [t], NOW)).toBeNull();
  });

  it('done → done 不弹——服务端三个连带看的都是跃迁，这一下什么都没发生', () => {
    const t = task({ status: 'done' });
    expect(undoDonePlan(t, { status: 'done', notes: '补一句' }, [t], NOW)).toBeNull();
  });
});

describe('undoDonePlan：提示里那个标题', () => {
  it('长标题掐到 16 字——一条长标题会把提示撑成三行，把「撤销」挤出屏幕', () => {
    const t = task({ title: '一二三四五六七八九十一二三四五六七八' });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.title).toBe('一二三四五六七八九十一二三四五六…');
  });

  it('刚好 16 字不加省略号', () => {
    const t = task({ title: '一二三四五六七八九十一二三四五六' });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.title).toBe('一二三四五六七八九十一二三四五六');
  });
});

describe('undoDonePlan：partial（这一下不只改了它自己）', () => {
  it('重复任务：服务端会生成下一条，撤销收不回来', () => {
    const t = task({ repeat: EVERY_DAY });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.partial).toBe(true);
  });

  it('有还没了结的子任务：会被连带完成', () => {
    const p = task({ id: 'p' });
    const kid = task({ id: 'k', parentId: 'p' });
    expect(undoDonePlan(p, { status: 'done' }, [p, kid], NOW)?.partial).toBe(true);
  });

  it('子任务全都已经了结了就不算连带——`cascadeChildrenDone` 一条都不会碰', () => {
    const p = task({ id: 'p' });
    const kids = [task({ id: 'a', parentId: 'p', status: 'done' }), task({ id: 'b', parentId: 'p', status: 'abandoned' })];
    expect(undoDonePlan(p, { status: 'done' }, [p, ...kids], NOW)?.partial).toBe(false);
  });

  it('自己是最后一个没做完的孩子：父任务会跟着完成', () => {
    const p = task({ id: 'p' });
    const a = task({ id: 'a', parentId: 'p', status: 'done' });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, a, b], NOW)?.partial).toBe(true);
  });

  it('还有别的兄弟没做完就不算——父任务不会动', () => {
    const p = task({ id: 'p' });
    const a = task({ id: 'a', parentId: 'p' });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, a, b], NOW)?.partial).toBe(false);
  });

  it('放弃的兄弟不挡着父任务收口（跟 rollUpParentDone 一致）', () => {
    const p = task({ id: 'p' });
    const a = task({ id: 'a', parentId: 'p', status: 'abandoned' });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, a, b], NOW)?.partial).toBe(true);
  });

  it('父任务已经了结了就不会再被卷一次', () => {
    const p = task({ id: 'p', status: 'done' });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, b], NOW)?.partial).toBe(false);
  });

  it('parentId 指向一条已经不在的任务：不炸，也不算连带', () => {
    const b = task({ id: 'b', parentId: '删掉了' });
    expect(undoDonePlan(b, { status: 'done' }, [b], NOW)?.partial).toBe(false);
  });
});

/**
 * 「下次 X」。**点完成那张卡当场从眼前消失**，一条「每周一交周报」最需要当场
 * 确认的恰恰是「下一条生成了没有、生在哪天」——`partial` 那句「还连带改了
 * 别的」说的正是这件事，但它没说是哪一天。日期怎么算在 `server/src/repeat.ts`
 * （跟服务端真正生成下一条走的是同一个 `advance`），这里只测这个字段。
 */
describe('undoDonePlan：下次落在哪', () => {
  const due = (y: number, m: number, d: number, h = 23, mi = 59) => new Date(y, m - 1, d, h, mi).toISOString();

  it('每天重复：下一次是第二天', () => {
    const t = task({ due: due(2026, 8, 22), repeat: EVERY_DAY });
    const got = undoDonePlan(t, { status: 'done' }, [t], NOW)?.nextDue;
    expect(got).toBe(due(2026, 8, 23));
  });

  it('不重复的任务没有「下次」', () => {
    const t = task({ due: due(2026, 8, 22) });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.nextDue).toBeNull();
  });

  it('**重复但没有截止时间的也没有「下次」**——下一条同样不会有日期，报不出一个来', () => {
    const t = task({ due: null, repeat: EVERY_DAY });
    expect(undoDonePlan(t, { status: 'done' }, [t], NOW)?.nextDue).toBeNull();
  });

  it('次数用完（count = 0）：这是最后一次，没有下次', () => {
    const t = task({ due: due(2026, 8, 22), repeat: { ...EVERY_DAY, count: 0 } });
    const plan = undoDonePlan(t, { status: 'done' }, [t], NOW);
    expect(plan?.nextDue).toBeNull();
    // **`partial` 也是假的**——这一条以前是「有 repeat 就算连带」的多报：次数
    // 用完那一次服务端不会再生成任何东西，撤销确实能把这一下整个抹掉，那时候
    // 再说一句「撤销只把这一条改回来」是在吓唬人。判据交给 `nextAfterDone`，
    // 它跟真正生成下一条走的是同一个 `advance`。
    expect(plan?.partial).toBe(false);
    expect(plan?.cascades).toEqual([]);
  });
});

/**
 * 连带的那几件事各说各的一句人话。原来提示里只有一句「还连带改了别的」——
 * **只交代了「有事发生」、不交代「发生了什么」**，人读完还得自己去猜是哪一条
 * 被动了。
 */
describe('undoDonePlan：连带改了什么就说什么', () => {
  const due = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59).toISOString();
  it('连带完成的子任务报条数——放弃/已完成的孩子不算，它们本来就了结了', () => {
    const p = task({ id: 'p', title: '装修' });
    const rows = [
      p,
      task({ id: 'a', parentId: 'p' }),
      task({ id: 'b', parentId: 'p', status: 'doing' }),
      task({ id: 'c', parentId: 'p', status: 'done' }),
    ];
    expect(undoDonePlan(p, { status: 'done' }, rows, NOW)?.cascades).toEqual(['连带做完了 2 条子任务']);
  });

  /**
   * **数的是整棵子树。** 服务端 `cascadeChildrenDone` 走 `descendantIds`（注释：
   * 「放开到五层之后，只关一层会把孙辈落在一个已完成的父亲下面」），预览这边
   * 原来只数直接子任务——三层的项目上提示说 2 条、实际做完 5 条。
   * **预览少报比不预览更糟**：他据这句话决定要不要撤销。
   */
  it('三层项目：孙辈也要算进「连带做完了几条」', () => {
    const p2 = task({ id: 'P' });
    const rows = [
      p2,
      task({ id: 'a', parentId: 'P' }),
      task({ id: 'b', parentId: 'P' }),
      task({ id: 'a1', parentId: 'a' }),
      task({ id: 'a2', parentId: 'a' }),
      task({ id: 'a1x', parentId: 'a1' }),
    ];
    expect(undoDonePlan(p2, { status: 'done' }, rows, NOW)?.cascades)
      .toEqual(['连带做完了 5 条子任务']);
  });

  it('最后一个孩子做完时报出父任务的名字', () => {
    const p = task({ id: 'p', title: '装修' });
    const a = task({ id: 'a', parentId: 'p', status: 'done' });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, a, b], NOW)?.cascades).toEqual(['「装修」也跟着完成了']);
  });

  it('**父任务的长名字也掐到 16 字**——跟标题同一条，一条提示不该被撑成三行', () => {
    const long = '一二三四五六七八九十一二三四五六七八';
    const p = task({ id: 'p', title: long });
    const b = task({ id: 'b', parentId: 'p' });
    expect(undoDonePlan(b, { status: 'done' }, [p, b], NOW)?.cascades)
      .toEqual([`「${long.slice(0, 16)}…」也跟着完成了`]);
  });

  it('**重复那句不在这儿**——有日期时由调用方拿 nextDue 拼成「下次 X」，这儿不重复说一遍', () => {
    const t = task({ due: due(2026, 8, 22), repeat: EVERY_DAY });
    const plan = undoDonePlan(t, { status: 'done' }, [t], NOW);
    expect(plan?.cascades).toEqual([]);
    expect(plan?.nextDue).not.toBeNull();
  });

  it('**重复但没有截止时间：报不出日期，但「下一条排上了」这件事仍然要说**', () => {
    const t = task({ due: null, repeat: EVERY_DAY });
    const plan = undoDonePlan(t, { status: 'done' }, [t], NOW);
    expect(plan?.nextDue).toBeNull();
    expect(plan?.cascades).toEqual(['重复的下一条已经排上了']);
    expect(plan?.partial).toBe(true);
  });

  it('什么连带都没有时是空数组，`partial` 为假', () => {
    const t = task();
    const plan = undoDonePlan(t, { status: 'done' }, [t], NOW);
    expect(plan?.cascades).toEqual([]);
    expect(plan?.partial).toBe(false);
  });

  it('**恒等式：`partial` 为真时一定至少有一句能说**——所以提示里不再需要「还连带改了别的」那种什么都没说的兜底', () => {
    const cases = [
      { t: task({ due: due(2026, 8, 22), repeat: EVERY_DAY }), rows: [] as ReturnType<typeof task>[] },
      { t: task({ due: null, repeat: EVERY_DAY }), rows: [] },
      { t: task({ id: 'p' }), rows: [task({ id: 'k', parentId: 'p' })] },
    ];
    for (const { t, rows } of cases) {
      const plan = undoDonePlan(t, { status: 'done' }, [t, ...rows], NOW);
      expect(plan?.partial).toBe(true);
      expect((plan?.cascades.length ?? 0) > 0 || plan?.nextDue !== null).toBe(true);
    }
  });
});
