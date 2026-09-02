import { describe, expect, it } from 'vitest';
import { applyTaskPatch } from './app.js';
import type { Task } from './store.js';

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
  completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});

// —— 先给两条既有规则补表征测试。这个函数至今零直接覆盖，而下面要往里加东西。——
describe('applyTaskPatch：既有规则（表征）', () => {
  it('提醒时刻变了就把那条的已提醒章清掉，没变的沿用', () => {
    const prev = task({ reminders: [
      { at: '2026-08-15T09:00:00.000Z', firedAt: '2026-08-15T09:00:01.000Z' },
      { at: '2026-08-16T09:00:00.000Z', firedAt: '2026-08-16T09:00:01.000Z' },
    ] });
    const out = applyTaskPatch(prev, { reminders: [
      { at: '2026-08-15T09:00:00.000Z', firedAt: null },   // 没变 → 沿用旧章
      { at: '2026-08-20T09:00:00.000Z', firedAt: '2026-08-19T00:00:00.000Z' },  // 新时刻 + 客户端伪造的章 → 都不算数
    ] });
    expect(out.reminders).toEqual([
      { at: '2026-08-15T09:00:00.000Z', firedAt: '2026-08-15T09:00:01.000Z' },
      { at: '2026-08-20T09:00:00.000Z', firedAt: null },
    ]);
  });

  it('从 later/done 回到 todo 要清 order；doing→todo 不清', () => {
    expect(applyTaskPatch(task({ status: 'later', order: 3 }), { status: 'todo' }).order).toBeNull();
    expect(applyTaskPatch(task({ status: 'done', order: 3 }), { status: 'todo' }).order).toBeNull();
    // doing→todo 本来就都在「今天」之内，没有「离开又回来」这一步
    expect(applyTaskPatch(task({ status: 'doing', order: 3 }), { status: 'todo' }).order).toBe(3);
    // 调用方显式传了 order 就尊重那个值
    expect(applyTaskPatch(task({ status: 'done', order: 3 }), { status: 'todo', order: 7 }).order).toBe(7);
  });
});

describe('applyTaskPatch：完成时间盖章', () => {
  it('status 变成 done 时盖章', () => {
    const before = Date.now();
    const out = applyTaskPatch(task({ status: 'todo', completedAt: null }), { status: 'done' });
    // 不是随便一个字符串：必须落在「调用前」到「现在」这个区间里，两边夹死
    expect(out.completedAt).not.toBeNull();
    const stamped = Date.parse(out.completedAt!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('done 变成别的状态时把章清掉', () => {
    const prev = task({ status: 'done', completedAt: '2026-08-01T00:00:00.000Z' });
    expect(applyTaskPatch(prev, { status: 'todo' }).completedAt).toBeNull();
    expect(applyTaskPatch(prev, { status: 'later' }).completedAt).toBeNull();
  });

  it('done → done 不重新盖章——改个备注不该改完成时间', () => {
    const prev = task({ status: 'done', completedAt: '2026-08-01T00:00:00.000Z' });
    expect(applyTaskPatch(prev, { notes: '补一句' }).completedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(applyTaskPatch(prev, { status: 'done' }).completedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('todo → todo 不盖章', () => {
    expect(applyTaskPatch(task({ status: 'todo' }), { notes: 'x' }).completedAt).toBeNull();
  });

  it('跃迁时服务端的章赢——completedAt 不是调用方能编的', () => {
    const out = applyTaskPatch(task({ status: 'todo' }),
      { status: 'done', completedAt: '2000-01-01T00:00:00.000Z' });
    expect(out.completedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('applyTaskPatch：推迟计数', () => {
  const withDue = (due: string | null, n = 0) => task({ due, postponeCount: n });

  it('due 往后推 → +1', () => {
    const out = applyTaskPatch(withDue('2026-08-15T00:00:00.000Z'), { due: '2026-08-20T00:00:00.000Z' });
    expect(out.postponeCount).toBe(1);
  });

  it('推第二次 → +1 再 +1，不是永远停在 1', () => {
    // 这个仓库栽过「只调用一次测不到累加」的跟头，务必测第二次
    const a = applyTaskPatch(withDue('2026-08-15T00:00:00.000Z'), { due: '2026-08-20T00:00:00.000Z' });
    const b = applyTaskPatch(a, { due: '2026-08-25T00:00:00.000Z' });
    expect(b.postponeCount).toBe(2);
  });

  it('第一次设截止日期不算推迟', () => {
    // 初值给非零：due 为空不是 postponeCount 为零的前提（清空 due 之前可能已经推迟过好几次）
    expect(applyTaskPatch(withDue(null, 4), { due: '2026-08-20T00:00:00.000Z' }).postponeCount).toBe(4);
  });

  it('往前提不算，也不减', () => {
    const out = applyTaskPatch(withDue('2026-08-20T00:00:00.000Z', 3), { due: '2026-08-15T00:00:00.000Z' });
    expect(out.postponeCount).toBe(3);
  });

  it('清空截止日期不算', () => {
    expect(applyTaskPatch(withDue('2026-08-20T00:00:00.000Z', 2), { due: null }).postponeCount).toBe(2);
  });

  it('patch 里没有 due 就不动', () => {
    expect(applyTaskPatch(withDue('2026-08-20T00:00:00.000Z', 2), { notes: 'x' }).postponeCount).toBe(2);
  });

  it('时间解析不了就不动——别让坏数据把计数搞乱', () => {
    expect(applyTaskPatch(withDue('下周三', 1), { due: '下下周三' }).postponeCount).toBe(1);
  });
});

/**
 * 检查事项全部勾完 → 任务自动完成。滴答清单帮助文档原话：「检查事项全部完成
 * 后，主任务将自动完成」。
 *
 * 三条限制都要有测试盯着——缺任何一条，这个功能就从「省一步」变成「替他做
 * 决定」，而那种错误在界面上表现成「我明明没点完成，它自己完成了」。
 */
describe('applyTaskPatch：检查事项全部勾完就自动完成', () => {
  const half = [{ text: 'a', done: true }, { text: 'b', done: false }];
  const full = [{ text: 'a', done: true }, { text: 'b', done: true }];
  const NOW = '2026-08-20T10:00:00.000Z';

  it('勾完最后一个 → status 变 done，completedAt 盖章', () => {
    const out = applyTaskPatch(task({ subtasks: half }), { subtasks: full }, NOW);
    expect(out.status).toBe('done');
    expect(out.completedAt).toBe(NOW);
  });

  it('还没勾完不动', () => {
    expect(applyTaskPatch(task({ subtasks: [] }), { subtasks: half }, NOW).status).toBe('todo');
  });

  it('这次 patch 没动 subtasks 就不判——改个备注不该把一条早就勾满、他有意留着的任务偷偷标完成', () => {
    expect(applyTaskPatch(task({ subtasks: full }), { notes: 'x' }, NOW).status).toBe('todo');
  });

  it('已经勾满的任务被手动退回 todo 之后，下一次编辑不会再把它推回 done', () => {
    // 「勾满」在 patch 之前就已经成立，这次只是又勾了一遍同样的值
    expect(applyTaskPatch(task({ subtasks: full }), { subtasks: full }, NOW).status).toBe('todo');
  });

  it('这次 patch 自己带了 status 就听他的——他明确说了要什么状态', () => {
    expect(applyTaskPatch(task({ subtasks: half }), { subtasks: full, status: 'doing' }, NOW).status).toBe('doing');
  });

  it('一条检查事项都没有不适用：空列表不算「全部完成」', () => {
    expect(applyTaskPatch(task({ subtasks: [{ text: 'a', done: false }] }), { subtasks: [] }, NOW).status).toBe('todo');
  });

  it('本来就 done 的不重新盖章——那会让「什么时候完成的」被后来的每次编辑推后', () => {
    const prev = task({ status: 'done', subtasks: half, completedAt: '2026-08-01T00:00:00.000Z' });
    expect(applyTaskPatch(prev, { subtasks: full }, NOW).completedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

/**
 * **时间段成对搬。** 只挪 `startAt`、不给 `endAt` 时，`endAt` 跟着挪同样多。
 *
 * 不这么做的后果实测复现过（真实路径，不是构造的）：建一条「只有时间段、
 * 没有 due」的任务（`ics.ts` 顶上说这是合法状态、「在这个应用自己的日历上画得
 * 好好的」），让 AI 提一条只改 `startAt` 的建议——那正是 `startAt` 进
 * `PROPOSABLE` 的理由（`task.ts` 那段注释：「AI 可以提『等 9 月开学再说』」）——
 * 接受之后 startAt 到了 9/21、endAt 还在 9/7，`hasTimeBlock`（`end > start`）
 * 变假，`calendarAnchor` 退回看 `due` 而 `due` 是 null，**任务从所有日历面上
 * 消失**；`ics.ts` 又跳过没有 `due` 的，导出里也没有。全程不报错。
 */
describe('applyTaskPatch：只挪 startAt 时 endAt 跟着走', () => {
  const 会议 = (over: Partial<Task> = {}) => task({
    startAt: '2026-09-07T01:00:00.000Z', endAt: '2026-09-07T04:00:00.000Z', due: null, ...over,
  });

  it('往后挪两周：时长不变，块还在', () => {
    const next = applyTaskPatch(会议(), { startAt: '2026-09-21T01:00:00.000Z' });
    expect(next.startAt).toBe('2026-09-21T01:00:00.000Z');
    expect(next.endAt).toBe('2026-09-21T04:00:00.000Z');
    expect(Date.parse(next.endAt as string) - Date.parse(next.startAt as string)).toBe(3 * 3600_000);
  });

  it('**这就是那条会让任务从日历上消失的路径**：挪过 endAt 之后块必须还成立', () => {
    const next = applyTaskPatch(会议(), { startAt: '2026-09-21T01:00:00.000Z' });
    const ok = Date.parse(next.endAt as string) > Date.parse(next.startAt as string);
    expect(ok, 'end <= start：hasTimeBlock 变假，而 due 是 null，calendarAnchor 会返回 null').toBe(true);
  });

  // 三条不该动的：调用方明确给了两头、本来就没有块、挪完仍然成立。
  it('patch 自己给了 endAt：听它的，不覆盖', () => {
    const next = applyTaskPatch(会议(), { startAt: '2026-09-21T01:00:00.000Z', endAt: '2026-09-21T02:00:00.000Z' });
    expect(next.endAt).toBe('2026-09-21T02:00:00.000Z');
  });

  it('本来就没有时间段（第一次设开始时间）：不凭空造一个 endAt', () => {
    const next = applyTaskPatch(task({ startAt: null, endAt: null }), { startAt: '2026-09-21T01:00:00.000Z' });
    expect(next.endAt).toBeNull();
  });

  it('挪完仍然 end > start：不动 endAt——人只是把开始时刻改晚了', () => {
    const next = applyTaskPatch(会议(), { startAt: '2026-09-07T02:00:00.000Z' });
    expect(next.endAt).toBe('2026-09-07T04:00:00.000Z');
  });
});
