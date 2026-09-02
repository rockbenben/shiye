import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createAutoExpand } from './autoExpand.js';
import { invalidate } from './entityStore.js';
import { Bus } from './events.js';
import { createAgentRunner, type Spawner } from './expand.js';
import { DEFAULT_SETTINGS, deviceConfigPath, ensureDataFiles, paths, writeInbox, writeSettings, type InboxItem } from './store.js';

/** 假子进程：只实现测试用得到的三样——'exit' 事件、kill()，跟 expand.test.ts 同款。 */
function fakeProc(): ChildProcess & { emitExit: (code: number) => void } {
  const e = new EventEmitter() as unknown as ChildProcess & { emitExit: (code: number) => void };
  e.kill = vi.fn() as unknown as ChildProcess['kill'];
  e.emitExit = (code: number) => e.emit('exit', code);
  return e;
}

const statusEvents = (bus: Bus) => {
  const seen: Array<{ state: string; message?: string; at?: string }> = [];
  bus.subscribe((event, d) => { if (event === 'agent-status') seen.push(d as { state: string }); });
  return seen;
};

let n = 0;
const inboxItem = (over: Partial<InboxItem> = {}): InboxItem =>
  ({ id: `inbox-${++n}`, text: '随手记的', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...over });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-autoexpand-'));
  process.env.DATA_DIR = dir;
  // 设置现在存在设备本地，不指到临时目录的话 writeSettings 会落到这台机器
  // 真实的平台惯例位置（比如 %APPDATA%\shiye\device.json）。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
  ensureDataFiles();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.DATA_DIR;
  delete process.env.DEVICE_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

/** 建一整套：bus + 假 spawner 的 agentRunner + autoExpand，外加拿到已发出的
 * agent-status 列表和每次 spawn 出来的假进程（`procs`，用来在测试里控制它退出）。 */
function setup() {
  const bus = new Bus();
  const seen = statusEvents(bus);
  const procs: Array<ReturnType<typeof fakeProc>> = [];
  const spawnFn: Spawner = vi.fn(() => {
    const p = fakeProc();
    procs.push(p);
    return p;
  });
  const runner = createAgentRunner(bus, spawnFn);
  const autoExpand = createAutoExpand(bus, runner);
  return { bus, seen, spawnFn, procs, runner, autoExpand };
}

const inboxChanged = (bus: Bus) => bus.emit('data-changed', { file: 'inbox' });
const settingsChanged = (bus: Bus) => bus.emit('data-changed', { file: 'settings' });

describe('createAutoExpand：去抖', () => {
  it('60 秒内连着来三条，只排一次、只跑一次，不是三次', () => {
    const { bus, spawnFn, autoExpand } = setup();

    writeInbox([inboxItem({ id: 'a' })]);
    inboxChanged(bus);

    vi.advanceTimersByTime(10_000);
    writeInbox([inboxItem({ id: 'a' }), inboxItem({ id: 'b' })]);
    inboxChanged(bus);   // 重置倒计时

    vi.advanceTimersByTime(10_000);
    writeInbox([inboxItem({ id: 'a' }), inboxItem({ id: 'b' }), inboxItem({ id: 'c' })]);
    inboxChanged(bus);   // 再重置一次

    // 还没到最后一次重置之后的 60 秒，不该跑
    vi.advanceTimersByTime(59_000);
    expect(spawnFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    autoExpand.dispose();
  });

  it('排上之后广播 scheduled，带着算好的绝对时间', () => {
    const { bus, seen, autoExpand } = setup();

    writeInbox([inboxItem()]);
    inboxChanged(bus);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ state: 'scheduled', at: new Date(Date.now() + 60_000).toISOString() });

    autoExpand.dispose();
  });
});

describe('createAutoExpand：重试限制（这个任务存在的理由）', () => {
  it('自动尝试失败一次之后，同一条不会再被自动排期——不然就是每分钟烧一次订阅额度', () => {
    const { bus, spawnFn, procs, seen, autoExpand, runner } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);

    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(runner.isRunning()).toBe(true);

    // AI 这次没能处理掉它：进程退出码非零，条目仍然 unprocessed。
    procs[0].emitExit(1);
    expect(runner.isRunning()).toBe(false);

    // 收件箱「又变了」（哪怕内容一样），evaluate 会重新算一遍——
    // 但这条 id 已经在尝试记录里，不该再排一次。
    inboxChanged(bus);
    vi.advanceTimersByTime(120_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);   // 还是只有第一次

    // 广播过 scheduled 之后，不该再出现第二条 scheduled
    const scheduledCount = seen.filter((s) => s.state === 'scheduled').length;
    expect(scheduledCount).toBe(1);

    autoExpand.dispose();
  });

  it('「重新拆解」（forget）之后，同一条重新有资格被自动排期', () => {
    const { bus, spawnFn, procs, autoExpand, runner } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    procs[0].emitExit(1);
    expect(runner.isRunning()).toBe(false);

    autoExpand.forget(item.id);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    autoExpand.dispose();
  });

  it('手动触发清空整份尝试记录（clearAll）——用户明确要求重来就是重来', () => {
    const { bus, spawnFn, procs, autoExpand, runner } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    procs[0].emitExit(1);
    expect(runner.isRunning()).toBe(false);

    autoExpand.clearAll();
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    autoExpand.dispose();
  });
});

describe('createAutoExpand：设置变化', () => {
  it('改延迟立刻生效——已经排上的那次按新延迟重算，不是从头再等一轮', () => {
    const { bus, spawnFn, seen, autoExpand } = setup();
    const scheduledSince = Date.now();   // vi.useFakeTimers() 不把时钟拨回纪元，起点是装假表那一刻的真实时间
    writeInbox([inboxItem()]);
    inboxChanged(bus);   // 默认延迟 60 秒排上

    vi.advanceTimersByTime(20_000);   // 过了 20 秒
    writeSettings({ ...DEFAULT_SETTINGS, autoExpandDelaySec: 30 });
    settingsChanged(bus);   // 改成 30 秒——从排期起点算，应该在 10 秒后触发，不是再等 30 秒

    vi.advanceTimersByTime(9_000);
    expect(spawnFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // 广播过的最后一条 scheduled 应该反映新的（更早的）触发时间：排期起点 + 30 秒，
    // 不是「改延迟这一刻」+ 30 秒。
    const last = [...seen].reverse().find((s) => s.state === 'scheduled')!;
    expect(last.at).toBe(new Date(scheduledSince + 30_000).toISOString());

    autoExpand.dispose();
  });

  it('关掉自动拆解取消已经排上的那次，并广播 idle 让前端收起倒计时', () => {
    const { bus, spawnFn, seen, autoExpand } = setup();
    writeInbox([inboxItem()]);
    inboxChanged(bus);
    expect(seen.some((s) => s.state === 'scheduled')).toBe(true);

    writeSettings({ ...DEFAULT_SETTINGS, autoExpand: false });
    settingsChanged(bus);

    expect(seen[seen.length - 1]).toEqual({ state: 'idle' });

    vi.advanceTimersByTime(120_000);
    expect(spawnFn).not.toHaveBeenCalled();

    autoExpand.dispose();
  });
});

describe('createAutoExpand：这次不拆（skip）', () => {
  it('只取消这一次排期，不运行、不动尝试记录——下次相关变化还能重新排上', () => {
    const { bus, spawnFn, seen, autoExpand } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);
    expect(seen.some((s) => s.state === 'scheduled')).toBe(true);

    autoExpand.skip();
    expect(seen[seen.length - 1]).toEqual({ state: 'idle' });

    vi.advanceTimersByTime(120_000);
    expect(spawnFn).not.toHaveBeenCalled();

    // 同一条还没被标成「尝试过」——收件箱再有点动静，一样能重新排上
    inboxChanged(bus);
    expect(seen[seen.length - 1].state).toBe('scheduled');

    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    autoExpand.dispose();
  });
});

describe('createAutoExpand：候选消失', () => {
  it('排期期间条目被删掉——候选清零，取消排期并广播 idle', () => {
    const { bus, spawnFn, seen, autoExpand } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);
    expect(seen.some((s) => s.state === 'scheduled')).toBe(true);

    writeInbox([]);
    inboxChanged(bus);

    expect(seen[seen.length - 1]).toEqual({ state: 'idle' });
    vi.advanceTimersByTime(120_000);
    expect(spawnFn).not.toHaveBeenCalled();

    autoExpand.dispose();
  });

  it('别处（手动触发）已经在跑了——悄悄收起排期，不重复广播 idle 盖掉 running', () => {
    const { bus, spawnFn, seen, autoExpand } = setup();
    writeInbox([inboxItem()]);
    inboxChanged(bus);
    expect(seen.some((s) => s.state === 'scheduled')).toBe(true);

    bus.emit('agent-status', { state: 'running' });
    expect(seen[seen.length - 1]).toEqual({ state: 'running' });   // 不是被 idle 盖掉

    vi.advanceTimersByTime(120_000);
    expect(spawnFn).not.toHaveBeenCalled();   // 自己的排期已经被收起，不会再另外触发一次

    autoExpand.dispose();
  });
});

describe('createAutoExpand：越界延迟的第二道防线', () => {
  it('device.json 被手改成越界值时也会被夹回 [10, 3600]，不是被信任', () => {
    const { bus, seen, autoExpand } = setup();
    writeSettings({ ...DEFAULT_SETTINGS, autoExpandDelaySec: 3 });
    writeInbox([inboxItem()]);
    inboxChanged(bus);

    const scheduled = seen.find((s) => s.state === 'scheduled')!;
    expect(scheduled.at).toBe(new Date(Date.now() + 10_000).toISOString());

    autoExpand.dispose();
  });
});

describe('createAutoExpand：回归——运行「成功」结束后不能沉默（onSettled）', () => {
  it('outbox 合并先一步报 ok（那一刻 isRunning() 还是 true），子进程稍后才退出——期间冒出的新条目，退出后必须被重新评估排上期', () => {
    const { bus, spawnFn, procs, seen, autoExpand, runner } = setup();
    const item1 = inboxItem();
    writeInbox([item1]);
    inboxChanged(bus);

    vi.advanceTimersByTime(60_000);   // 自动触发
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(runner.isRunning()).toBe(true);

    // 真实时序：outbox 合并几乎总是先于子进程退出完成（expand.ts 'exit' 里的
    // 注释）。这里模拟 item1 被成功合并（inbox 标成 processed），同时收件箱
    // 又冒出一条全新的、从没被自动尝试过的 item2——用户在运行进行到一半时
    // 又丢了一条笔记，正是去抖鼓励的行为。
    const item2 = inboxItem();
    writeInbox([{ ...item1, processed: true, taskIds: ['t1'] }, item2]);
    bus.emit('agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' });

    // 子进程几秒后才真的退出，退出码 0。因为 mergeOutbox 已经说过话了
    // （`bus.lastStatus` 不再是 start() 那一刻的 running 对象），expand.ts
    // 的退出处理器这次什么都不会再发——没有 onSettled 的话，item2 就永远
    // 没有任何东西再看它一眼，直到下一次凑巧的收件箱变化。
    procs[0].emitExit(0);
    expect(runner.isRunning()).toBe(false);

    const last = seen[seen.length - 1];
    expect(last.state).toBe('scheduled');   // item2 应该被重新排上

    autoExpand.dispose();
  });
});

describe('createAutoExpand：回归——不能在 Bus 监听器里同步嵌套 emit', () => {
  // 这条测的是「同步窗口」：紧跟着 failed 之后（微任务还没跑）连上的订阅者
  // 必须重放到 failed，不是被嵌套 emit 顶替掉的 scheduled。**不代表问题被
  // 彻底解决**——`queueMicrotask` 只是把嵌套 emit 挪出了这一个同步调用栈，
  // 微任务本身几乎立刻就会跑（比任何真实浏览器连接快得多），跑完之后
  // `lastAgentStatus` 照样会变成 `scheduled`；真实场景里稍晚一点点连上的
  // 浏览器，重放到的还是排期倒计时，看不见刚刚那条 failed。这条失败信息
  // 不是永久丢失——排上的那次运行跑完之后，它自己的 ok/failed/skipped 会
  // 重新成为最新状态——但中间那段等待期（默认延迟 60 秒 + 一次 AI 运行，
  // 加起来约两分半）看不到原因。结构性根因是 `Bus` 只有一个重放槽、前端
  // 只有一个 `agent` 状态，表达不了「排着一次运行，并且上一次失败了」这种
  // 复合状态——要不要单独加一个「粘性失败」槽是产品决定，这一轮不做。
  it('failed 广播时 autoExpand 同步排期会把 lastAgentStatus 顶成 scheduled——紧跟着连上的订阅者必须重放到 failed，不是 scheduled', () => {
    const { bus, autoExpand } = setup();
    writeInbox([inboxItem()]);   // 有资格被排期的未处理条目，触发条件成立

    // 模拟启动补合并发现一个坏 outbox 文件、广播 failed——这个 emit 本身
    // 会同步触发 autoExpand 的订阅回调，回调里决定要排期（推迟到微任务）。
    bus.emit('agent-status', { state: 'failed', message: '模拟启动补合并发现一个坏文件' });

    // 新订阅者在同一个同步调用栈里连上（对应浏览器刚打开页面那一刻）——
    // 此时推迟的 evaluate() 还没跑，重放到的必须是 failed。
    const replayed: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'agent-status') replayed.push(d); });

    expect(replayed).toEqual([{ state: 'failed', message: '模拟启动补合并发现一个坏文件' }]);

    autoExpand.dispose();
  });
});

describe('createAutoExpand：回归——onSettled 触发的 evaluate 不能被一份读不出来的实体文件带崩', () => {
  // 这条测试原来锁的是「evaluate 内部的 readInbox 抛错必须被 evaluate 自己接住」——
  // 那是「一个大数组文件，坏了就抛」年代的机制。一实体一文件之后 entityStore.readAll
  // 对单条实体读坏了是**跳过 + warn，不会再抛错**（一千条里坏一条，不该让另外
  // 999 条也打不开，见 entityStore.ts）。机制变了，但这条测试保护的意图没变：
  // 一份坏数据文件不能带崩进程。改成直接断言这个意图——inbox 目录里有一份读不出来
  // 的实体文件时，走「没有任何东西接得住异常」的那条路径（子进程 'exit' 事件里
  // 同步调用 onSettled -> evaluate()，EventEmitter.emit 不吞监听器抛出的异常）
  // 也不该抛、进程活着、其余条目照常走完排期/触发，不是「没崩但从此瘸了」。
  it('子进程退出那一刻 inbox 目录里正好有一份读不出来的实体文件——evaluate 不抛、进程活着，其余条目照常排期触发', () => {
    const { bus, spawnFn, procs, autoExpand, runner } = setup();
    const item = inboxItem();
    writeInbox([item]);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);   // 自动触发，进了 running
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(runner.isRunning()).toBe(true);

    // 服务跑着的时候 inbox 目录里多了一份读不出来的实体文件——同步中断、
    // 手改坏文件都会造成这个。绕过 entityStore 直接写文件，所以要手动
    // invalidate：真实场景里这一步由 events.ts 的文件监听器做，这里没有
    // 真的 fs.watch 在跑，不手动失效的话内存缓存会一直吐旧数据，读不到
    // 这份新写的坏文件，测试等于什么都没测。
    writeFileSync(join(paths().inbox, 'broken.json'), '{not json', 'utf8');
    invalidate(paths().inbox);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 不能崩：EventEmitter.emit 不吞监听器里抛出的异常，修复前（旧机制下）
    // 这一行会同步抛出——对应生产环境里没人接住的 uncaughtException，直接
    // 带走整个服务窗口。
    expect(() => procs[0].emitExit(0)).not.toThrow();
    expect(runner.isRunning()).toBe(false);
    // 坏文件真的被读到过、被跳过了，不是巧合地没被碰上。
    expect(warn.mock.calls.some((c) => String(c[0]).includes('broken.json'))).toBe(true);
    warn.mockRestore();

    // 后续流程正常：坏文件继续躺在目录里，新冒出来的条目照样能被排期、
    // 触发下一轮运行——不是「进程没崩但从此瘸了」。
    writeInbox([item, inboxItem()]);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(runner.isRunning()).toBe(true);

    // evaluate() 内部那把 try/catch（autoExpand.ts 的 evaluate 函数体）本身
    // 也需要测试覆盖，不能只靠上面那段坏实体文件顺带路过它：entityStore 对
    // 单条实体读坏了不再抛错之后，这把 catch 已经没有任何测试会让它真的接住
    // 一次异常了（改成 `throw e` 也会全绿）。它现在还有一个真实存在的理由：
    // device.json（设置搬去的地方，Task 5）仍然是扁平文件、仍然「坏了就抛」
    // （store.ts 的 readJson，见 store.test.ts「坏文件」describe 块），而
    // evaluate() 第一句就是 readSettings()。走同一条最危险的路径（子进程
    // 'exit' 事件同步触发 onSettled -> evaluate()，没有 Bus.safeCall 那把伞）
    // 验证它。
    writeFileSync(deviceConfigPath(), '{ 这不是合法 JSON', 'utf8');

    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => procs[1].emitExit(0)).not.toThrow();
    expect(warn2.mock.calls.some((c) => String(c[0]).includes('[autoExpand]'))).toBe(true);
    warn2.mockRestore();

    autoExpand.dispose();
  });
});

describe('createAutoExpand：回归——start() 返回 ok:false 不该再补一条 idle 把已经发过的真实状态抹掉', () => {
  it('spawn 同步抛错：start() 内部已经发过带原因的 failed，fire() 不能再拿 idle 盖上去', () => {
    const bus = new Bus();
    const seen = statusEvents(bus);
    const spawnFn: Spawner = () => { throw new Error('坏掉了'); };
    const runner = createAgentRunner(bus, spawnFn);
    const autoExpand = createAutoExpand(bus, runner);

    writeInbox([inboxItem()]);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);   // 触发 fire()，内部 runner.start() 同步抛错

    // start() 自己已经发过一条带具体原因的 failed（"没能启动 AI：坏掉了"）。
    // 这必须是最后一条——不能被 fire() 补的 idle 盖掉，不然用户看到的是
    // 「什么都没有」，不是「AI 命令行工具没找到」这种能看懂的原因。
    const last = seen[seen.length - 1];
    expect(last.state).toBe('failed');
    expect(last.message).toContain('坏掉了');

    autoExpand.dispose();
  });
});

/**
 * **配置不全的 api 模式不会变成重试风暴。**
 *
 * 加「调接口」那条路之后，`start()` 多了一条真会走到的 `ok:false`——地址或模型
 * 没填全时它当场就失败。`fire()` 在调 `start()` **之前**已经把所有未处理条目标进
 * `attempted`，所以失败之后它们不会再被自动排上；再加收件箱条目也只会各自触发
 * 一次，不会对着同一条反复烧。
 */
describe('自动拆解：start() 当场失败时不重试', () => {
  it('失败之后同一条不会再被排上，新条目也只触发一次', () => {
    const bus = new Bus();
    let starts = 0;
    const runner = {
      start: () => { starts++; return { ok: false as const, error: '设置里的 AI 模型名还没填，改好再拆解' }; },
      isRunning: () => false,
      setOnSettled: () => {},
    };
    writeSettings({ ...DEFAULT_SETTINGS, autoExpand: true, autoExpandDelaySec: 10 });
    const a = inboxItem({ id: 'a' });
    writeInbox([a]);

    const autoExpand = createAutoExpand(bus, runner);
    inboxChanged(bus);
    vi.advanceTimersByTime(11_000);
    expect(starts, '第一条该触发一次').toBe(1);

    // 那一条还躺在收件箱里（配置没修好，什么都没拆掉）：再怎么敲都不该再触发。
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(starts, '同一条不该再触发第二次——它已经在 attempted 里了').toBe(1);

    // 又记了一条新的：它没被尝试过，该触发一次，而且只有一次。
    writeInbox([a, inboxItem({ id: 'b' })]);
    inboxChanged(bus);
    vi.advanceTimersByTime(11_000);
    expect(starts).toBe(2);
    inboxChanged(bus);
    vi.advanceTimersByTime(60_000);
    expect(starts, '新条目也只该触发一次').toBe(2);

    autoExpand.dispose();
  });
});
