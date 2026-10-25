import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollOverDailyTasks, rolledTask } from './rollover.js';
import { ensureDataFiles, newTask, paths, readTasks, writeTask, writeTasks } from './store.js';
import type { Repeat, Task } from './model.js';

/**
 * **自动顺延的落盘这一段。**
 *
 * 算法在 `repeat.ts` 的 `rolloverPatch`（那儿测透），这里测的是**盘上的
 * 后果**：挪过的写进去了、没挪的没动、别的文件一个都没被碰。
 *
 * 最后那条是这段代码存在的理由：`writeTasks(整份数组)` 底下是 `syncAll`，
 * 它会**删掉不在新数组里的文件**——读盘和写盘之间用户正在网页上新建的
 * 那条任务会被静默删掉（AGENTS.md 开头那段讲的就是这件事）。所以自动顺延
 * 走 `writeTask`（单文件原子写），这条用例把它钉住。
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-rollover-'));
  process.env.DATA_DIR = dir;
  ensureDataFiles();
});

afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** 本地分量构造——不经过 UTC 'Z' 字符串，理由见 `repeat.test.ts` 顶部。 */
const local = (y: number, m: number, d: number, h = 0, mi = 0): Date =>
  new Date(y, m - 1, d, h, mi);

/** 过了 0 点五分钟。 */
const NOW = () => local(2026, 8, 15, 0, 5);

const R = (o: Partial<Repeat> = {}): Repeat =>
  ({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...o });

const dailyTask = (over: Partial<Task> = {}): Task =>
  newTask({
    id: 'daily-1',
    title: '每天喝八杯水',
    due: local(2026, 8, 14, 9).toISOString(),
    repeat: R({ every: 'day' }),
    ...over,
  });

describe('rollOverDailyTasks：把该挪的挪到今天', () => {
  it('挪过的那条写进盘了，截止日期变成今天的同一时刻', () => {
    writeTasks([dailyTask()]);
    const rolled = rollOverDailyTasks(NOW());
    expect(rolled.map((t) => t.id)).toEqual(['daily-1']);
    expect(readTasks()[0].due).toBe(local(2026, 8, 15, 9).toISOString());
  });

  it('不该挪的一条没动——没到 0 点的那一次、别的档、别的状态', () => {
    writeTasks([
      dailyTask({ id: 'a', due: local(2026, 8, 15, 9).toISOString() }),       // 今天的那一次
      dailyTask({ id: 'b', repeat: R({ every: 'week', weekdays: [1] }) }),      // 每周一
      dailyTask({ id: 'c', status: 'later' }),                                // 搁置
      newTask({ id: 'd', title: '不重复的' }),
    ]);
    expect(rollOverDailyTasks(NOW())).toEqual([]);
    expect(readTasks().every((t) => t.due === null || t.due === local(2026, 8, 15, 9).toISOString()
      || t.due === local(2026, 8, 14, 9).toISOString())).toBe(true);
  });

  it('**不算一次拖延**——顺延是「这一次没做，换一次」，不是把同一件事往后拖', () => {
    writeTasks([dailyTask({ postponeCount: 2 })]);
    rollOverDailyTasks(NOW());
    expect(readTasks()[0].postponeCount).toBe(2);
  });

  /**
   * **`updatedAt` 也不许动。** 它量的是「这条任务多久没被动过了」——
   * 卡片上那个「N 天没动静」的记号算的就是它。**每天自动挪一次日期，等于
   * 每天替他把这条任务「动」了一次**，而他并没有为「在等谁」做任何事：
   * 那个记号就永远不会亮。
   *
   * 还有一条更硬的理由在 `rollover.ts` 的注释里：`.ics` 的 `DTSTAMP` 是
   * 「全部 `updatedAt` 的最大值」且刻意不读时钟，两台机器各自顺延同一批
   * 任务时盖上各自的「现在」，就会写出两份不同的 `.ics`——同步客户端会把
   * 它们当成冲突。
   */
  it('**不改 `updatedAt`**——这一下不是他动过这条任务', () => {
    writeTasks([dailyTask({ updatedAt: '2026-08-01T00:00:00.000Z' })]);
    rollOverDailyTasks(NOW());
    expect(readTasks()[0].updatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('次数不减——自动顺延不消耗「还剩几次」的额度，只有完成才减', () => {
    writeTasks([dailyTask({ repeat: R({ count: 3 }) })]);
    rollOverDailyTasks(NOW());
    expect(readTasks()[0].repeat?.count).toBe(3);
  });

  it('幂等：第二遍扫没有东西可挪', () => {
    writeTasks([dailyTask()]);
    expect(rollOverDailyTasks(NOW())).toHaveLength(1);
    expect(rollOverDailyTasks(NOW())).toHaveLength(0);
    expect(readTasks()[0].due).toBe(local(2026, 8, 15, 9).toISOString());
  });

  it('规则到期（次数用完）：挪到今天，规则摘掉，习惯记号也跟着摘', () => {
    writeTasks([dailyTask({ repeat: R({ count: 0 }), habit: true })]);
    rollOverDailyTasks(NOW());
    const t = readTasks()[0];
    expect(t.due).toBe(local(2026, 8, 15, 9).toISOString());
    expect(t.repeat).toBeNull();
    // 重复档不再够格当习惯时，记号要跟着摘——`applyTaskPatch` 那条规矩。
    expect(t.habit).toBe(false);
  });
});

describe('writeTask：只写自己动过的那一条', () => {
  it('别的文件一个都不碰——特别是「读盘之后新建的那条」不会被当成多余的删掉', () => {
    const a = dailyTask({ id: 'a' });
    const b = newTask({ id: 'b', title: '别的任务' });
    writeTasks([a, b]);
    // 模拟「读盘之后、写盘之前，用户在网页上新建了一条」——
    // 直接落在盘上，绕开任何一次整表写。
    writeFileSync(join(paths().tasks, 'late.json'), JSON.stringify(newTask({ id: 'late', title: '刚建的' })), 'utf8');

    writeTask(a);

    expect(existsSync(join(paths().tasks, 'late.json')), '新建的那条被删了').toBe(true);
    expect(existsSync(join(paths().tasks, 'b.json')), '没动过的那条被删了').toBe(true);
  });
});

describe('rolledTask：挪完的那一条长什么样', () => {
  it('不改状态、不盖完成章', () => {
    const next = rolledTask(dailyTask(), NOW())!;
    expect(next.status).toBe('todo');
    expect(next.completedAt).toBeNull();
  });

  it('挪了就是挪了——截止日期确实变了', () => {
    const next = rolledTask(dailyTask(), NOW())!;
    expect(next.due).not.toBe(local(2026, 8, 14, 9).toISOString());
  });
});
