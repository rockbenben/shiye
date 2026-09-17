import { describe, it, expect } from 'vitest';
import { postponedToReview, stalledToReview, weeklyReview } from './weeklyReview.js';
import { task } from '../test-utils.js';
import { PARKED_QUIET_DAYS, REVIEWED_QUIET_DAYS, WAITING_QUIET_DAYS } from './taskView.js';
import { stalledProjects } from './hierarchy.js';
import { POSTPONE_MIN } from './suggest.js';
import type { InboxItem, Task } from '../types.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
const inbox = (n: number, processed = false): InboxItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`, text: `条目${i}`, createdAt: daysAgo(1), processed, taskIds: [],
  }));
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('weeklyReview：这一周该过一遍的', () => {
  it('什么都没有就是空数组——调用方据此说「都过完了」，不是列一串 0', () => {
    expect(weeklyReview([task({ id: 'a' })], [], NOW)).toEqual([]);
  });

  it('收件箱只数没处理的', () => {
    const rows = weeklyReview([], [...inbox(2), ...inbox(3, true)], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'inbox', count: 2, go: 'inbox' });
    expect(rows[0].text).toContain('2 条');
  });

  it('过期的：判据跟卡片上那个红标签同一条（countStale），点了去「今天」', () => {
    const rows = weeklyReview([task({ id: 'a', due: daysAgo(3) })], [], NOW);
    expect(rows).toEqual([expect.objectContaining({ key: 'overdue', count: 1, go: 'today' })]);
  });

  it('**卡住的项目不跳去处**——下面那一段就列着它们，跳走反而是把人带离答案', () => {
    const rows = weeklyReview(
      [task({ id: 'p' }), task({ id: 'k', parentId: 'p', status: 'later' })],
      [], NOW,
    );
    expect(rows).toEqual([expect.objectContaining({ key: 'stalled', count: 1, go: null })]);
  });

  it('在等别人、久没动静的——带一份筛选过去，不然点过去还是十九条', () => {
    const rows = weeklyReview([task({ id: 'a', waitingFor: '张老师', updatedAt: daysAgo(12) })], [], NOW);
    expect(rows).toEqual([expect.objectContaining({
      key: 'waiting', count: 1, go: 'all', filter: { hasWaitingFor: true },
    })]);
  });

  it('搁了很久的——同样带筛选', () => {
    const rows = weeklyReview([task({ id: 'a', status: 'later', updatedAt: daysAgo(90) })], [], NOW);
    expect(rows).toEqual([expect.objectContaining({
      key: 'parked', count: 1, go: 'all', filter: { status: ['later'] },
    })]);
  });

  /**
   * **门槛写进文案里。** 筛选比这一行的口径宽（`SmartFilter` 没有「几天没
   * 动静」这一维），点过去看到的是整份等待/搁置清单——数字和清单对不上时，
   * 人得看得懂为什么。所以那个数字必须来自常量，不能在文案里另写一个。
   */
  it.each([
    ['等待', { waitingFor: '张老师', updatedAt: daysAgo(12) } as Partial<Task>, WAITING_QUIET_DAYS],
    ['搁置', { status: 'later', updatedAt: daysAgo(90) } as Partial<Task>, PARKED_QUIET_DAYS],
  ])('%s 那一行把门槛写出来', (_n, over, days) => {
    const rows = weeklyReview([task({ id: 'a', ...over })], [], NOW);
    expect(rows[0].text).toContain(String(days));
  });

  it('过期和收件箱那两行不带筛选——它们各自的去处本来就只装那一类', () => {
    const rows = weeklyReview([task({ id: 'a', due: daysAgo(3) })], inbox(1), NOW);
    expect(rows.every((r) => r.filter === undefined)).toBe(true);
  });

  /**
   * **门槛一条都不新写。** 清单上的数字必须跟卡片上那些记号出自同一个判据，
   * 不然人会开始不信这些数字——那比不显示这份清单更糟。
   */
  it.each([
    ['等待没到门槛（2 天）', { waitingFor: '张老师', updatedAt: daysAgo(2) } as Partial<Task>],
    ['搁置没到门槛（29 天）', { status: 'later', updatedAt: daysAgo(29) } as Partial<Task>],
  ])('%s 不进清单——跟卡片上那个记号同一条门槛', (_n, over) => {
    expect(weeklyReview([task({ id: 'a', ...over })], [], NOW)).toEqual([]);
  });

  it('顺序固定：收件箱 → 过期 → 卡住 → 一拖再拖 → 等待 → 搁置（从「该分拣的」到「该做决定的」）', () => {
    const rows = weeklyReview([
      task({ id: 'a', due: daysAgo(3) }),
      task({ id: 'p' }), task({ id: 'k', parentId: 'p', status: 'later' }),
      task({ id: 's', postponeCount: POSTPONE_MIN }),
      task({ id: 'w', waitingFor: '张老师', updatedAt: daysAgo(12) }),
      task({ id: 'l', status: 'later', updatedAt: daysAgo(90) }),
    ], inbox(1), NOW);
    expect(keys(rows)).toEqual(['inbox', 'overdue', 'stalled', 'postponed', 'waiting', 'parked']);
  });

  it('一条任务同时满足两档时两边都数——它确实两件事都占着（搁着、又在等人）', () => {
    const rows = weeklyReview(
      [task({ id: 'a', status: 'later', waitingFor: '张老师', updatedAt: daysAgo(90) })], [], NOW,
    );
    expect(keys(rows)).toEqual(['waiting', 'parked']);
  });
});

/**
 * **「看过了」之后，这一屏 `REVIEWED_QUIET_DAYS` 天不再问同一条。**
 *
 * 仿 OmniFocus 的 Mark Reviewed。这一族守的是两件事：章真的生效，以及
 * **数字和列表用的是同一个出口**——`stalledToReview` 只有一份，`weeklyReview`
 * 那一行和 `ReviewView` 那份列表都问它。两边各自 filter 一遍的话，会出现
 * 「清单上写 3 条、底下只列出 1 条」，而这一屏一旦开始说不一致的数字，
 * 人就不再信它。
 */
describe('stalledToReview：盖过章的暂时不再问', () => {
  /** 一个卡住的项目：父任务还挂着，唯一的子任务已经搁置。 */
  const stalledPair = (id: string, over: Partial<Task> = {}): Task[] => [
    task({ id, title: `项目${id}`, ...over }),
    task({ id: `${id}-kid`, parentId: id, status: 'later' }),
  ];

  it('没盖过章：照常出现', () => {
    expect(stalledToReview(stalledPair('p'), NOW).map((t) => t.id)).toEqual(['p']);
  });

  it('刚盖过章：不出现', () => {
    expect(stalledToReview(stalledPair('p', { reviewedAt: daysAgo(1) }), NOW)).toEqual([]);
  });

  it.each([
    ['差一天到期', REVIEWED_QUIET_DAYS - 1, []],
    ['刚好到期', REVIEWED_QUIET_DAYS, ['p']],
    ['早就过期', REVIEWED_QUIET_DAYS + 10, ['p']],
  ] as const)('%s：%s 天前盖的章', (_n, days, want) => {
    expect(stalledToReview(stalledPair('p', { reviewedAt: daysAgo(days) }), NOW).map((t) => t.id))
      .toEqual(want);
  });

  it('章解析不出来时当没盖过——不能让一个坏字符串把一条卡住的项目永久藏起来', () => {
    expect(stalledToReview(stalledPair('p', { reviewedAt: '上周' }), NOW).map((t) => t.id)).toEqual(['p']);
  });

  /**
   * **上限方向**：章只挡「卡住」这一件事的复述，不改变它到底卡没卡住。
   * `stalledProjects` 自己写着「纯函数，不读时钟」，那句话该继续成立。
   */
  it('盖了章的项目在 stalledProjects 里还在——「卡住了」是事实，「他看过了」是另一件事', () => {
    const all = stalledPair('p', { reviewedAt: daysAgo(1) });
    expect(stalledProjects(all).map((t) => t.id)).toEqual(['p']);
    expect(stalledToReview(all, NOW)).toEqual([]);
  });

  it('清单上那一行跟着一起消失——数字和列表是同一个出口', () => {
    const all = stalledPair('p');
    expect(keys(weeklyReview(all, [], NOW))).toContain('stalled');
    const reviewed = stalledPair('p', { reviewedAt: daysAgo(1) });
    expect(keys(weeklyReview(reviewed, [], NOW))).not.toContain('stalled');
  });

  it('两个卡住的项目只盖了一个的章：那一行说 1，不是 2 也不是 0', () => {
    const all = [...stalledPair('p1', { reviewedAt: daysAgo(1) }), ...stalledPair('p2')];
    const row = weeklyReview(all, [], NOW).find((r) => r.key === 'stalled')!;
    expect(row.count).toBe(1);
    expect(row.text).toContain('1 个');
    expect(stalledToReview(all, NOW).map((t) => t.id)).toEqual(['p2']);
  });
});

/**
 * **「一拖再拖」——改过好几次期还在原地的。**
 *
 * 这一族守四件事：
 *
 * ① **门槛是 `POSTPONE_MIN` 那个常量，不是这儿另写的 2**。那个常量的注释
 *    专门讲过「两处各写一个，将来调门槛只会改到一处」——所以下面用
 *    `POSTPONE_MIN ± 1` 构造边界，不写死数字。
 * ② **排序按次数倒序**：这一组的信息量全在那个数字上，最多的一条要在最前。
 * ③ **候选池故意比推荐面板那组宽**：那边是 `isCandidate`（今天列表之外、还能
 *    动的），这边「只要还挂着就算」——一条天天被他推迟的任务很可能就赖在
 *    「今天」里，而它恰恰是这一节最该问的那一条。
 * ④ **已经了结的（做完 / 搁置 / 放弃）一条都不进**：`isSettled` 认那三种，
 *    而这个决定他**已经做过了**——再问一遍就是「一份劝不动你的清单」。
 */
describe('postponedToReview：一拖再拖', () => {
  const ids = (ts: Task[]) => ts.map((t) => t.id);

  it('门槛以下不进——差一次就是差一次', () => {
    expect(postponedToReview([task({ id: 'a', postponeCount: POSTPONE_MIN - 1 })], NOW)).toEqual([]);
  });

  it.each([
    ['刚好到门槛', POSTPONE_MIN],
    ['远超门槛', POSTPONE_MIN + 6],
  ] as const)('%s：进', (_n, count) => {
    expect(ids(postponedToReview([task({ id: 'a', postponeCount: count })], NOW))).toEqual(['a']);
  });

  it('次数多的排前面——这一组的信息量全在那个数上', () => {
    const all = [
      task({ id: '少', postponeCount: POSTPONE_MIN }),
      task({ id: '多', postponeCount: POSTPONE_MIN + 6 }),
      task({ id: '中', postponeCount: POSTPONE_MIN + 2 }),
    ];
    expect(ids(postponedToReview(all, NOW))).toEqual(['多', '中', '少']);
  });

  /**
   * **候选池比推荐面板那组宽，是有意的。** 那边（`suggest.ts` 的 `postponed`）
   * 用 `isCandidate`，会把「已经在今天」的排除掉——而一条被推了八次的任务
   * 大概率就赖在「今天」里，那正是它一直被推迟的表现。
   *
   * 这条用「它已经在今天」这个最典型的情形钉住：`due` 是今天，`isCandidate`
   * 会排除它，而这里必须收下它。
   */
  it('**赖在「今天」里的照样进**——那正是它一直被推迟的表现，也是这一节最该问的那条', () => {
    const 今天到期 = task({ id: 'a', postponeCount: POSTPONE_MIN + 6, due: NOW.toISOString() });
    expect(ids(postponedToReview([今天到期], NOW))).toEqual(['a']);
  });

  it.each([
    ['已经做完', { status: 'done' as const }],
    ['已经搁置', { status: 'later' as const }],
    ['已经放弃', { status: 'abandoned' as const }],
  ])('%s 的不进——那个决定他已经做过了', (_n, over) => {
    expect(postponedToReview([task({ id: 'a', postponeCount: POSTPONE_MIN + 6, ...over })], NOW)).toEqual([]);
  });

  it('没数过的（老数据里字段是 undefined）不进——数都没数，谈不上「好几次」', () => {
    const 老数据 = { ...task({ id: 'a' }), postponeCount: undefined } as unknown as Task;
    expect(postponedToReview([老数据], NOW)).toEqual([]);
  });

  it('刚盖过章的暂时不问——跟「卡住的项目」共用同一套「看过了」', () => {
    const all = [task({ id: 'a', postponeCount: POSTPONE_MIN + 6, reviewedAt: daysAgo(1) })];
    expect(postponedToReview(all, NOW)).toEqual([]);
  });

  it(`盖了章的过了 ${REVIEWED_QUIET_DAYS} 天自己回来`, () => {
    const all = [task({ id: 'a', postponeCount: POSTPONE_MIN + 6, reviewedAt: daysAgo(REVIEWED_QUIET_DAYS) })];
    expect(ids(postponedToReview(all, NOW))).toEqual(['a']);
  });

  it('清单上那一行跟着一起消失——数字和列表是同一个出口', () => {
    const all = [task({ id: 'a', postponeCount: POSTPONE_MIN + 6 })];
    expect(keys(weeklyReview(all, [], NOW))).toContain('postponed');
    const reviewed = [task({ id: 'a', postponeCount: POSTPONE_MIN + 6, reviewedAt: daysAgo(1) })];
    expect(keys(weeklyReview(reviewed, [], NOW))).not.toContain('postponed');
  });

  it('两个只盖了一个的章：那一行说 1，不是 2 也不是 0', () => {
    const all = [
      task({ id: 'a', postponeCount: POSTPONE_MIN + 6, reviewedAt: daysAgo(1) }),
      task({ id: 'b', postponeCount: POSTPONE_MIN }),
    ];
    const row = weeklyReview(all, [], NOW).find((r) => r.key === 'postponed')!;
    expect(row.count).toBe(1);
    expect(ids(postponedToReview(all, NOW))).toEqual(['b']);
  });

  /** **不跳去处**，跟「卡住的项目」同一个理由：下面那一段就列着它们，而且
   *  这一节要的那个决定（搁置 / 放弃）在卡片的 ⋯ 里，跳去一个筛选过的列表
   *  反而离答案更远。 */
  it('那一行不跳去处——答案就在下面那一段里', () => {
    const row = weeklyReview([task({ id: 'a', postponeCount: POSTPONE_MIN })], [], NOW)[0];
    expect(row).toMatchObject({ key: 'postponed', go: null });
  });

  /** 门槛写进文案里（跟「等待」「搁置」那两行同一条规矩）：那个数字必须来自
   *  常量，不能在文案里另写一个——改常量时这句话得跟着变。 */
  it('那一行把门槛写出来', () => {
    const row = weeklyReview([task({ id: 'a', postponeCount: POSTPONE_MIN })], [], NOW)[0];
    expect(row.text).toContain(String(POSTPONE_MIN));
  });
});
