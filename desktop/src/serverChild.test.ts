import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startServer, waitUntilHealthy } from './serverChild.js';
import type { ResolvedPaths } from './paths.js';

const paths: ResolvedPaths = {
  serverEntry: '/repo/server/dist/index.js',
  dataDir: '/repo/data',
  agentCwd: '/repo',
};

/** 假子进程：EventEmitter + 记录 kill 有没有被调用。 */
function fakeChild() {
  const p = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; killed: boolean };
  p.kill = vi.fn(() => { p.killed = true; return true; });
  p.killed = false;
  return p;
}

// vi.fn(() => fakeChild()) 推出来的类型不带参数（0 元函数），spawnFn.mock.calls[0]
// 就是长度 0 的元组，取不到第 0/1/2 个元素——desktop/tsconfig.typecheck.json 现在
// 真的检测试文件，这类推断问题会直接报错，不再等到打包才发现。补一个 rest 参数
// 让 vi.fn 推出「不限参数个数」的签名，调用行为不变（mock 实现本身不看参数）。
const spawn = () => vi.fn((..._args: unknown[]) => fakeChild());

const notOurs = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
const isOurs = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

describe('startServer：端口上已经有一个我们自己', () => {
  it('不重复起——用户可能已经双击过启动.cmd', async () => {
    const spawnFn = vi.fn();
    const h = await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: isOurs });
    expect(h).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // 端口用非默认值 31111（不是全篇都在用的 30035）：探测 URL 里的 ${port} 要是
  // 被写死成字面量 30035，这条测试才抓得出来——全篇只用一个端口的话，写死和
  // 真的读 o.port 两种实现看起来一样绿。
  it('探的是 /api/health，不是随便连一下端口——别的程序占着这个端口不算「我们自己」', async () => {
    const seen: string[] = [];
    const probe = (async (u: string) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await startServer({ paths, port: 31111, spawnFn: vi.fn() as never, fetchFn: probe });
    expect(seen[0]).toContain('/api/health');
    expect(seen[0]).toContain('31111');
  });

  it('回的不是 ok:true 就当没有——别的程序占着这个端口', async () => {
    const someoneElse = (async () => new Response('<html>别人的服务</html>', { status: 200 })) as unknown as typeof fetch;
    const spawnFn = spawn();
    const h = await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: someoneElse });
    expect(h).not.toBeNull();
    expect(spawnFn).toHaveBeenCalled();
  });
});

describe('startServer：起一个新的', () => {
  it('spawn 的是 node + 解析出来的入口', async () => {
    const spawnFn = spawn();
    await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: notOurs });
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/server/dist/index.js']);
  });

  // 这条也用非默认端口（31111）：PORT: String(o.port) 要是被写死成字面量
  // '30035'，只有换一个端口才抓得出来。
  it('三个路径 + NO_OPEN 都传进去了', async () => {
    const spawnFn = spawn();
    await startServer({ paths, port: 31111, spawnFn: spawnFn as never, fetchFn: notOurs });
    const opts = spawnFn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.PORT).toBe('31111');
    expect(opts.env.DATA_DIR).toBe('/repo/data');
    expect(opts.env.AGENT_CWD).toBe('/repo');
    // 服务默认会开浏览器；Electron 自己有窗口，再弹一个浏览器是错的
    expect(opts.env.NO_OPEN).toBe('1');
  });

  // 默认的 'pipe' 没人读的话，子进程写满缓冲区就会阻塞——server/src/expand.ts
  // 82-87 行记录过同一件事：孙进程 claude 直接往这条没人排空的管道里写，
  // 十分钟后被超时杀掉。ChildHandle 不暴露 child，调用方压根读不到这条管道，
  // 唯一安全的选择是 'inherit'（跟 expand.ts 同一个先例）。
  it("stdio 是 'inherit'，不是默认的 'pipe'——没人读的管道会把服务写阻塞、十分钟后超时", async () => {
    const spawnFn = spawn();
    await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: notOurs });
    const opts = spawnFn.mock.calls[0]![2] as { stdio: string };
    expect(opts.stdio).toBe('inherit');
  });

  it('其余环境变量原样继承——用户可能在 .env 或系统里设了 CLAUDE_CLI', async () => {
    const spawnFn = spawn();
    process.env.__TEST_INHERITED = '带过去';
    try {
      await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: notOurs });
      const opts = spawnFn.mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env.__TEST_INHERITED).toBe('带过去');
    } finally {
      delete process.env.__TEST_INHERITED;
    }
  });

  // brief 的测试里没写这一条：打包后用户机器上不一定有 node，spawn 用的是
  // process.execPath（Electron 自己的二进制），必须配 ELECTRON_RUN_AS_NODE=1
  // 它才会当纯 Node 跑，不然会真的把自己当 Electron 启动第二个 GUI 进程。
  it('env 里带 ELECTRON_RUN_AS_NODE=1——process.execPath 是 Electron 二进制，没这个环境变量它不会当纯 Node 跑', async () => {
    const spawnFn = spawn();
    await startServer({ paths, port: 30035, spawnFn: spawnFn as never, fetchFn: notOurs });
    const opts = spawnFn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('startServer：停', () => {
  it('stop() 真的 kill 了它', async () => {
    const child = fakeChild();
    const h = await startServer({ paths, port: 30035, spawnFn: (() => child) as never, fetchFn: notOurs });
    h!.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('stop() 调两次不抛，也不重复 kill——幂等守卫跟 killedByUs 是同一个变量', async () => {
    const child = fakeChild();
    const h = await startServer({ paths, port: 30035, spawnFn: (() => child) as never, fetchFn: notOurs });
    h!.stop();
    expect(() => h!.stop()).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('分得清「崩了」和「我们让它退的」——前者该告诉用户，后者不该', async () => {
    const child = fakeChild();
    const h = await startServer({ paths, port: 30035, spawnFn: (() => child) as never, fetchFn: notOurs });
    const seen: Array<[number | null, boolean]> = [];
    h!.onExit((code, killedByUs) => seen.push([code, killedByUs]));

    child.emit('exit', 1, null);          // 崩了
    expect(seen).toEqual([[1, false]]);

    const child2 = fakeChild();
    const h2 = await startServer({ paths, port: 30035, spawnFn: (() => child2) as never, fetchFn: notOurs });
    const seen2: Array<[number | null, boolean]> = [];
    h2!.onExit((code, killedByUs) => seen2.push([code, killedByUs]));
    h2!.stop();
    child2.emit('exit', 0, 'SIGTERM');    // 我们杀的
    expect(seen2).toEqual([[0, true]]);
  });

  // spawn 失败（比如被杀软拦截进程创建）发的是 'error' 不是 'exit'。没有人
  // 监听的话 Node 会把它当 uncaughtException 扔出来——在 Electron 主进程里
  // 是一次崩溃对话框，不是「告诉用户服务崩了」。
  it("挂了 'error' 监听——spawn 失败不该变成 uncaughtException", async () => {
    const child = fakeChild();
    const h = await startServer({ paths, port: 30035, spawnFn: (() => child) as never, fetchFn: notOurs });
    const seen: Array<[number | null, boolean]> = [];
    h!.onExit((code, killedByUs) => seen.push([code, killedByUs]));

    child.emit('error', new Error('EPERM'));
    expect(seen).toEqual([[null, false]]);
  });

  // 'exit'/'error' 必须在 spawn 之后立刻挂，不能等 onExit() 被调用才挂：
  // EventEmitter 不重放，调用方可能在 await startServer() 和挂 onExit() 之间
  // 还 await 了别的事（比如 win.loadURL()），子进程要是这段时间里退出，
  // 晚挂的监听器就永远收不到这条事件了。
  it('子进程先退出、onExit() 后注册——照样收到，不是错过', async () => {
    const child = fakeChild();
    const h = await startServer({ paths, port: 30035, spawnFn: (() => child) as never, fetchFn: notOurs });

    child.emit('exit', 1, null); // 先退出，这时候还没人挂 onExit

    const seen: Array<[number | null, boolean]> = [];
    h!.onExit((code, killedByUs) => seen.push([code, killedByUs])); // 后注册
    expect(seen).toEqual([[1, false]]);
  });
});

describe('waitUntilHealthy：main.ts 在 loadURL 之前拿它等服务真的起来', () => {
  it('第一次探测就通——不 sleep，直接返回 true', async () => {
    const sleepFn = vi.fn(async () => {});
    const ok = await waitUntilHealthy(30035, { fetchFn: isOurs, sleepFn });
    expect(ok).toBe(true);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('前两次没通，第三次通了——重试几次就返回 true，不是第一次没通就放弃', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const sleepFn = vi.fn(async () => {});
    const ok = await waitUntilHealthy(30035, { fetchFn, sleepFn });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleepFn).toHaveBeenCalledTimes(2); // 两次失败之间各等一次
  });

  it('两次探测之间真的等了 intervalMs，不是写死的别的值', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 2) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const sleepFn = vi.fn(async () => {});
    await waitUntilHealthy(30035, { fetchFn, sleepFn, intervalMs: 777 });
    expect(sleepFn).toHaveBeenCalledWith(777);
  });

  it('一直不通、超过 timeoutMs 就返回 false——重试了不止一次才放弃，不是探一次就死心', async () => {
    // nowFn 注入一个假表，不依赖真实挂钟时间：0（算 deadline）→ 5（还没到 20，继续）
    // → 25（过了，收工）。中间那次 5 逼着它必须真的走了「探测失败→没超时→sleep→
    // 再探一次」这条路，不是随便判一次就返回。
    const clock = [0, 5, 25];
    let i = 0;
    const nowFn = () => clock[Math.min(i++, clock.length - 1)];
    const sleepFn = vi.fn(async () => {});
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls += 1;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const ok = await waitUntilHealthy(30035, { fetchFn, sleepFn, nowFn, timeoutMs: 20 });
    expect(ok).toBe(false);
    expect(fetchCalls).toBe(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('超时之后不会再多探一次——最后一次失败直接返回，不是先 sleep 再判断', async () => {
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls += 1;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    let nowCalls = 0;
    const nowFn = () => (nowCalls++ === 0 ? 0 : 1000); // 第一次探测完，deadline 已经过去了
    const sleepFn = vi.fn(async () => {});
    await waitUntilHealthy(30035, { fetchFn, sleepFn, nowFn, timeoutMs: 20 });
    expect(sleepFn).not.toHaveBeenCalled();
    expect(fetchCalls).toBe(1);
  });
});
