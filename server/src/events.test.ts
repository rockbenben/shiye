import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, watchData } from './events.js';
import { createApp } from './app.js';
import { ensureDataFiles, newTask, paths, readTasks, writeInbox } from './store.js';

// 只包一层 watch，其余原样透传——「监听器挂了之后缓存要旁路」这条测试需要
// 拿到 fs.watch 真实返回的那个 FSWatcher 实例，好在它上面手动 emit('error')
// 模拟一次真实的监听中断（跨平台真的制造一次 fs.watch 报错不好复现）。跟
// entityStore.test.ts 包 renameSync 是同一个手法。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});
const watchMock = vi.mocked(watch);

describe('Bus', () => {
  it('订阅者收到 emit 的事件', () => {
    const bus = new Bus();
    const seen: Array<[string, unknown]> = [];
    bus.subscribe((e, d) => seen.push([e, d]));
    bus.emit('data-changed', { file: 'tasks' });
    expect(seen).toEqual([['data-changed', { file: 'tasks' }]]);
  });

  it('退订之后不再收到', () => {
    const bus = new Bus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    bus.emit('a', null);
    off();
    bus.emit('b', null);
    expect(seen).toEqual(['a']);
    expect(bus.size).toBe(0);
  });

  it('一个订阅者抛异常不影响其余的 —— 一个断掉的 SSE 连接不该让提醒全网静音', () => {
    const bus = new Bus();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error('这个连接已经断了'); });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.emit('reminder', null)).not.toThrow();
    expect(seen).toEqual(['reminder']);
  });

  describe('agent-status 重放（E）', () => {
    it('新订阅者立刻收到最近一条 agent-status —— 覆盖启动时补合并跑在浏览器连上之前、以及刷新页面丢状态两个场景', () => {
      const bus = new Bus();
      bus.emit('agent-status', { state: 'failed', message: '启动时补合并发现一个坏文件' });

      const seen: unknown[] = [];
      bus.subscribe((e, d) => seen.push([e, d]));

      expect(seen).toEqual([['agent-status', { state: 'failed', message: '启动时补合并发现一个坏文件' }]]);
    });

    it('只重放最新一条，不是完整历史', () => {
      const bus = new Bus();
      bus.emit('agent-status', { state: 'running' });
      bus.emit('agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' });

      const seen: unknown[] = [];
      bus.subscribe((e, d) => seen.push([e, d]));

      expect(seen).toEqual([['agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' }]]);
    });

    it('还没发生过 agent-status 时，新订阅者不会平白收到东西', () => {
      const bus = new Bus();
      const seen: string[] = [];
      bus.subscribe((e) => seen.push(e));
      expect(seen).toEqual([]);
    });

    it('别的事件类型不参与重放，只有 agent-status 记这一份', () => {
      const bus = new Bus();
      bus.emit('data-changed', { file: 'tasks' });
      bus.emit('reminder', { id: 't1' });

      const seen: string[] = [];
      bus.subscribe((e) => seen.push(e));
      expect(seen).toEqual([]);
    });

    describe('重放时效', () => {
      // replayTtlMs 传一个很短的值，不用真的等几分钟——生产用的是构造函数默认值
      // （5 分钟），这里只是同一份逻辑换一个跑得快的时间尺度。

      it('刚发生的终态会重放给新订阅者', () => {
        const bus = new Bus(50);
        bus.emit('agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' });

        const seen: unknown[] = [];
        bus.subscribe((e, d) => seen.push([e, d]));

        expect(seen).toEqual([['agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' }]]);
      });

      it('超过重放时效的终态不再重放 —— 横幅关掉之后不能靠刷新页面/新开标签页/SSE 自动重连原样带回来', async () => {
        const bus = new Bus(50);
        bus.emit('agent-status', { state: 'ok', message: '拆解完成，新增 1 个任务' });

        await new Promise((r) => setTimeout(r, 80));

        const seen: unknown[] = [];
        bus.subscribe((e) => seen.push(e));
        expect(seen).toEqual([]);
      });

      it('running 不受时效限制，多久之前发的都照样重放', async () => {
        const bus = new Bus(50);
        bus.emit('agent-status', { state: 'running' });

        await new Promise((r) => setTimeout(r, 80));

        const seen: unknown[] = [];
        bus.subscribe((e, d) => seen.push([e, d]));
        expect(seen).toEqual([['agent-status', { state: 'running' }]]);
      });
    });
  });
});

describe('watchData', () => {
  let dir: string;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-watch-'));
    process.env.DATA_DIR = dir;
    ensureDataFiles();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('写 data/tasks/<id>.json 会广播一条 data-changed（file 是 tasks）—— 锁住递归监听', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    stop = watchData(bus, dir, 50);

    // 一实体一文件之后，任务不再是顶层的 tasks.json，是 data/tasks/<uuid>.json
    // 这个子目录里的一条实体。非递归监听（去掉 watch() 的 { recursive: true }）
    // 永远看不到这个子目录的变化，这条测试就会红。
    writeFileSync(join(paths().tasks, 'some-id.json'), '{}', 'utf8');
    await vi.waitFor(() => expect(seen).toContainEqual({ file: 'tasks' }), { timeout: 3000 });
  });

  // settings 已经搬出 data/（Task 5），走的是设备本地的 device.json——这个
  // 监听器只看 dir（dataDir()）底下的变化，写 device.json 天然触发不到它。
  // data-changed{file:'settings'} 现在由 PUT /api/settings 自己 emit，
  // 见 app.ts 和 app.test.ts 里对应的端到端测试；这里不再需要一条同名测试。
  /**
   * 纪念日**原来漏在 `WATCHED` 外**，而它的整条链路早就通了：`DataFile` 里
   * 列着它、`App.tsx` 的 `reload('countdowns')` 认它、而纪念日那几条写路由
   * 也不自己 emit。结果是加一条纪念日之后**界面上什么都不会发生**。
   * 现在 `.ics` 也要跟着重写，更不能漏。
   */
  it('写 data/countdowns/<id>.json 也广播一条（file 是 countdowns）', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    stop = watchData(bus, dir, 50);

    writeFileSync(join(paths().countdowns, 'some-id.json'), '{}', 'utf8');
    await vi.waitFor(() => expect(seen).toContainEqual({ file: 'countdowns' }), { timeout: 3000 });
  });


  it('忽略顶层散落的 .tmp/.bak 命名的文件 —— 没有目录分隔符，取不出表名，天然被挡在外面', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    stop = watchData(bus, dir, 50);

    writeFileSync(join(dir, 'tasks.json.tmp'), '[]', 'utf8');
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
  });

  it('连着写多次只广播一条 —— Windows 一次写会连发好几个事件', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    stop = watchData(bus, dir, 150);

    const file = join(paths().tasks, 'some-id.json');
    for (let i = 0; i < 5; i++) writeFileSync(file, `{"n":${i}}`, 'utf8');
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([{ file: 'tasks' }]);
  });

  it('外部直接改 data/tasks/<id>.json 之后，readTasks() 读到的是新内容 —— 缓存失效不能晚于广播', async () => {
    const original = newTask({ id: 'cache-me', title: '原始标题' });
    const file = join(paths().tasks, `${original.id}.json`);
    writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    // 先读一次，把 entityStore 的内存缓存焐热——不这样的话下面这次读到新内容
    // 测不出「失效」这件事，因为压根还没缓存过旧的。
    expect(readTasks().find((t) => t.id === original.id)?.title).toBe('原始标题');

    const bus = new Bus();
    // 第五次「跑完 510/510 全绿」还是假绿：原来这里的断言长在 vi.waitFor 的
    // 回调**外面**的调用点没变，变的是回调里读的是「随时间反复调用
    // readTasks()」——那对「invalidate 排在 emit 之前」和「invalidate 晚
    // 50ms 才在 emit 之后发生」两种实现同样会通过，因为 waitFor 只关心
    // 「最终」收敛到新值，不关心收到 data-changed 那一刻是不是已经收敛了。
    // 复审者实测：把 events.ts 的 invalidate 从「emit 之前」挪到「emit 之后」
    // （同一次去抖回调内部，只是顺序颠倒），旧写法的测试照样绿。
    //
    // 改成在**订阅回调内部**、`data-changed` 触发的那一刻同步调用
    // readTasks()——这一刻就是真实前端「收到通知，立刻重新拉数据」的那一刻，
    // 直接编码「顺序不能反」这条不变量，而不是「等它某个时候变新」。外层的
    // vi.waitFor 只用来等这唯一一次 data-changed 真的发生（去抖定时器是异步
    // 的，等不掉），不再重复读 readTasks()。
    let titleSeenAtEmit: string | undefined;
    bus.subscribe((e) => {
      if (e === 'data-changed') titleSeenAtEmit = readTasks().find((t) => t.id === original.id)?.title;
    });
    stop = watchData(bus, dir, 50);

    // 绕过 writeOne，直接用 writeFileSync 模拟「同步客户端拉下了别的设备的
    // 改动」或者「人手改了文件」——这两种场景服务自己的写入路径都不会经过，
    // 监听器必须靠这次 fs 事件才知道要 invalidate。
    const updated = { ...original, title: '外部改过的标题' };
    writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

    await vi.waitFor(() => expect(titleSeenAtEmit).toBe('外部改过的标题'), { timeout: 3000 });
  });

  it('监听器自己挂掉（fs.watch 报 error）之后，缓存退化成每次都读盘——不用重启服务，也不用等谁再调用 invalidate', () => {
    const original = newTask({ id: 'watcher-error-probe', title: '原始标题' });
    const file = join(paths().tasks, `${original.id}.json`);
    writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    expect(readTasks().find((t) => t.id === original.id)?.title).toBe('原始标题');   // 焐热缓存

    const bus = new Bus();
    stop = watchData(bus, dir, 50);
    // 拿到 watchData 内部真正 watch() 出来的那个 FSWatcher——它本身就是一个
    // EventEmitter，直接在它上面 emit('error', ...) 就能触发 watchData 里
    // 注册的 watcher.on('error', ...) 处理器，不用真的在文件系统层面制造一次
    // 监听中断（跨平台不好复现，Windows/Linux/macOS 报错时机和方式都不一样）。
    const watcher = watchMock.mock.results[watchMock.mock.results.length - 1].value as { emit: (event: string, e: Error) => void };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    watcher.emit('error', new Error('模拟一次监听中断'));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[events]') && String(c[0]).includes('切换成每次都读盘'))).toBe(true);
    warn.mockRestore();

    // 监听器已经挂了，不会再有任何 fs 事件触发 invalidate——绕过 entityStore
    // 的写入口直接改文件，模拟这之后同步客户端/人手又改了一次。旁路是同步
    // 生效的（不依赖任何异步事件），不需要 vi.waitFor。
    const updated = { ...original, title: '监听器挂了之后改的标题' };
    writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    expect(readTasks().find((t) => t.id === original.id)?.title).toBe('监听器挂了之后改的标题');
  });

  it('outbox-*.json 出现不走 data-changed，走合并——合并完成后才看到 tasks 那一轮 data-changed', async () => {
    writeInbox([{ id: 'inbox-1', text: 'x', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }]);
    const bus = new Bus();
    const changed: unknown[] = [];
    const agentStatus: unknown[] = [];
    bus.subscribe((e, d) => {
      if (e === 'data-changed') changed.push(d);
      if (e === 'agent-status') agentStatus.push(d);
    });
    stop = watchData(bus, dir, 50);

    const task = newTask({ id: 'new-task', title: '合并出来的任务' });
    writeFileSync(join(dir, 'outbox-abc123.json'), JSON.stringify([{ inboxId: 'inbox-1', tasks: [task] }]), 'utf8');

    await vi.waitFor(() => expect(agentStatus).toContainEqual({ state: 'ok', message: '拆解完成，新增 1 个任务' }), { timeout: 3000 });

    // 合并本身同步写了 tasks.json / inbox.json，那两次写各自再触发一轮 watcher，
    // 前端真正刷新看到新任务靠的是这一轮 data-changed，不是 outbox 那次。
    await vi.waitFor(() => expect(changed).toContainEqual({ file: 'tasks' }), { timeout: 3000 });
    expect(changed).not.toContainEqual({ file: 'outbox' });
    expect(readTasks().map((t) => t.title)).toContain('合并出来的任务');
    expect(existsSync(join(dir, 'outbox-abc123.json'))).toBe(false);
  });

  it('忽略 .bak —— change 4 引入的备份文件不该触发一轮刷新，也不该被当成数据文件', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    stop = watchData(bus, dir, 50);

    writeFileSync(join(dir, 'tasks.json.bak'), '[]', 'utf8');
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
  });

  it('mergeOutbox 本身抛出的异常不会带走定时器回调（B：防止 EPERM/EBUSY 之类把整个服务拖垮）', async () => {
    // 不用真的制造一次 EPERM——那样跨平台不好复现。这里换一个一样能让 mergeOutbox
    // 内部抛出未被捕获异常的路径：把 DATA_DIR 指向一个已经存在、但不是目录的路径，
    // `outboxFiles()` 里的 `readdirSync` 会直接抛 ENOTDIR，这一步在 mergeOutbox
    // 里没有包 try/catch（它本来就不该包——校验/落盘失败已经在 mergeOneFile
    // 那一层收敛成返回值了，这里要验证的是「万一还是漏了什么，events.ts 那层
    // 兜底能不能接住」）。`watchData` 监听的 `dir` 和 `mergeOutbox` 内部读的
    // DATA_DIR 是两回事：前者是 fs.watch 需要的真实目录，后者随时读环境变量，
    // 可以互不相干地分别指向不同路径。
    const notADir = join(tmpdir(), `todo-not-a-dir-${Date.now()}`);
    writeFileSync(notADir, 'x', 'utf8');
    process.env.DATA_DIR = notADir;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new Bus();
    stop = watchData(bus, dir, 30);

    // 这一步本身不该抛——`schedule` 只是把 `mergeOutbox` 派进一个 setTimeout，
    // 真正的异常要等去抖窗口过了才会在回调里冒出来。
    expect(() => writeFileSync(join(dir, 'outbox-x.json'), '[]', 'utf8')).not.toThrow();

    await new Promise((r) => setTimeout(r, 200));

    expect(warn.mock.calls.some((c) => String(c[0]).includes('[events]') && String(c[0]).includes('定时任务出错'))).toBe(true);

    warn.mockRestore();
    rmSync(notADir, { force: true });
  });

  it('两个 outbox-*.json 前后脚写入，共用一次去抖，一次合并里都处理到', async () => {
    writeInbox([
      { id: 'inbox-1', text: 'x', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
      { id: 'inbox-2', text: 'y', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
    ]);
    const bus = new Bus();
    const agentStatus: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'agent-status') agentStatus.push(d); });
    stop = watchData(bus, dir, 100);

    writeFileSync(join(dir, 'outbox-1.json'), JSON.stringify([{ inboxId: 'inbox-1', tasks: [newTask({ id: 't1', title: '任务一' })] }]), 'utf8');
    writeFileSync(join(dir, 'outbox-2.json'), JSON.stringify([{ inboxId: 'inbox-2', tasks: [newTask({ id: 't2', title: '任务二' })] }]), 'utf8');

    await vi.waitFor(() => expect(readTasks().map((t) => t.title).sort()).toEqual(['任务一', '任务二']), { timeout: 3000 });
    expect(existsSync(join(dir, 'outbox-1.json'))).toBe(false);
    expect(existsSync(join(dir, 'outbox-2.json'))).toBe(false);
  });
});

describe('/api/events', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-sse-'));
    process.env.DATA_DIR = dir;
    // createApp(bus) 内部会建 autoExpand 调度器，它一订阅上 bus 就立刻
    // evaluate() 一次，里面调 readSettings()——不指到临时目录的话会落到这台
    // 机器真实的 %APPDATA%\shiye\device.json，把这个文件读写这件事绑在
    // 开发者本机的真实配置上。
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('把 bus 上的事件按 SSE 格式发出去', async () => {
    const bus = new Bus();
    const app = createApp(bus);
    const ctrl = new AbortController();

    const res = await app.request('/api/events', { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    // 连接建立是异步的：等 bus 上真出现订阅者再 emit，否则这一发会掉在地上。
    // 期望值是 2 不是 1：createApp(bus) 内部的 autoExpand 调度器也订阅了这个
    // bus（它要看 data-changed/agent-status 才能决定要不要排自动拆解），
    // 这份订阅在 createApp() 调用那一刻就注册了，早于这条 SSE 连接。
    await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });
    bus.emit('data-changed', { file: 'inbox' });

    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('event: data-changed');
    expect(chunk).toContain('"file":"inbox"');

    ctrl.abort();
    await reader.cancel().catch(() => {});
  });

  it('没传 bus 时不注册这条路由 —— 单测里的 createApp() 不该挂着一个开不掉的流', async () => {
    const res = await createApp().request('/api/events');
    expect(res.status).toBe(404);
  });

  // 桌面端和网页都订阅同一条 /api/events——服务端要能分清「桌面端在线」跟
  // 「随便什么东西订阅了 SSE」，不然网页开着就会把 PowerShell 兜底关掉
  // （reminder.ts 的 fireReminders 靠 bus.isDesktopOnline 判断）。这两条测的
  // 是路由层的接线，不是 Bus 自己的逻辑（那部分 events.test.ts 顶上的
  // 'Bus' describe 块之外没有专门测，是因为 markDesktopOnline/Offline/
  // isDesktopOnline 本身只是三行存取，真正容易漏接的是这里：query 参数
  // 判断、beat 心跳里的续期、onAbort 里的清空）。
  it('?client=desktop 订阅时标记桌面端在线，断开时立刻标记离线', async () => {
    // 只假 Date：markDesktopOnline() 用的是默认参数 `new Date()`（生产路径），
    // 这里跟它比的必须是同一把钟，不能各读各的真实时间——否则「刚连上」
    // 这个断言在测试跑得慢的机器上会偶发失败。不假 setTimeout/setInterval，
    // 下面 vi.waitFor 的轮询还得靠真实定时器跑。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date('2026-08-10T12:00:00.000Z');
      vi.setSystemTime(now);

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl = new AbortController();

      const res = await app.request('/api/events?client=desktop', { signal: ctrl.signal });
      const reader = res.body!.getReader();

      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });
      expect(bus.isDesktopOnline(now)).toBe(true);

      ctrl.abort();
      await reader.cancel().catch(() => {});

      await vi.waitFor(() => expect(bus.isDesktopOnline(now)).toBe(false), { timeout: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('没带 ?client=desktop 的普通订阅（网页）不会被当成桌面端在线', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date('2026-08-10T12:00:00.000Z');
      vi.setSystemTime(now);

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl = new AbortController();

      const res = await app.request('/api/events', { signal: ctrl.signal });
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      expect(bus.isDesktopOnline(now)).toBe(false);

      ctrl.abort();
      await res.body!.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('?client=phone 这种不是 "desktop" 的值，不会被当成桌面端在线——判据要求精确匹配 "desktop"，不是「有没有传这个参数」', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date('2026-08-10T12:00:00.000Z');
      vi.setSystemTime(now);

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl = new AbortController();

      const res = await app.request('/api/events?client=phone', { signal: ctrl.signal });
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      expect(bus.isDesktopOnline(now)).toBe(false);

      ctrl.abort();
      await res.body!.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  // 上面两条只看「连上那一刻」的状态，抓不住 beat 心跳里的续期逻辑本身
  // （app.ts 里 `beat` 那个 setInterval）——这两条把假时钟推过好几个心跳周期。
  // 只假 Date/setInterval/clearInterval，**setTimeout 留给真实定时器**：
  // 下面的 vi.waitFor 靠它轮询，整套都假掉的话会被饿死（CLAUDE.md 记过这个坑）。
  it('?client=desktop 连接存续期间，25 秒一次的心跳持续续期在线状态——不是连上那一刻钉死一次就不管了', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl = new AbortController();

      const res = await app.request('/api/events?client=desktop', { signal: ctrl.signal });
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      // 80 秒后：如果只在连上那一刻标记过一次、心跳没有续期，80 - 0 = 80s
      // 已经超过 70s 的 TTL，早该判成离线；心跳每 25 秒续一次（25/50/75 秒
      // 各一次），80 秒时最近一次续期是 75 秒那次，80-75=5s，仍应该在线——
      // 这条断言能分清「心跳真的续期了」和「只在连上那一刻标了一次」。
      await vi.advanceTimersByTimeAsync(80_000);

      expect(bus.isDesktopOnline(new Date())).toBe(true);

      ctrl.abort();
      await res.body?.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('没带 ?client=desktop 的普通订阅（网页），心跳定时器不会把桌面端标成在线——哪怕连接活很久', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl = new AbortController();

      const res = await app.request('/api/events', { signal: ctrl.signal });
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      await vi.advanceTimersByTimeAsync(80_000); // 至少 3 次心跳

      expect(bus.isDesktopOnline(new Date())).toBe(false);

      ctrl.abort();
      await res.body?.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('两条桌面端连接同时开着，断开其中一条不会把另一条也标成离线（引用计数，不是布尔覆盖）', async () => {
    // 场景：SSE 重连的交接窗口——旧连接的 onAbort 比新连接的 subscribe 晚触发，
    // 或者别的什么东西也带 ?client=desktop 连了一下。这里直接开两条模拟。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date('2026-08-10T12:00:00.000Z');
      vi.setSystemTime(now);

      const bus = new Bus();
      const app = createApp(bus);
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();

      const res1 = await app.request('/api/events?client=desktop', { signal: ctrl1.signal });
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      const res2 = await app.request('/api/events?client=desktop', { signal: ctrl2.signal });
      await vi.waitFor(() => expect(bus.size).toBe(3), { timeout: 3000 });

      expect(bus.isDesktopOnline(now)).toBe(true);

      ctrl1.abort();
      // 光 abort() 信号本身不够——没有人读这条流的 body 时，Hono 那边未必会
      // 及时感知到断开（跟上面「?client=desktop 订阅时标记桌面端在线」那条
      // 用 reader.cancel() 是同一个道理，这里改用 body.cancel() 因为没另外
      // 建 reader）。
      await res1.body?.cancel().catch(() => {});
      await vi.waitFor(() => expect(bus.size).toBe(2), { timeout: 3000 });

      // 第一条断了，第二条还活着——不该被牵连成离线。
      expect(bus.isDesktopOnline(now)).toBe(true);

      ctrl2.abort();
      await res2.body?.cancel().catch(() => {});
      await vi.waitFor(() => expect(bus.size).toBe(1), { timeout: 3000 });

      // 最后一条也断了，这时候才该真的离线。
      expect(bus.isDesktopOnline(now)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
