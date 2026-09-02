import { spawn as spawnNode } from 'node:child_process';
import type { ResolvedPaths } from './paths.js';

export interface ChildHandle {
  stop(): void;
  /** 子进程自己退出时回调（崩了还是被我们 kill 的）。 */
  onExit(cb: (code: number | null, killedByUs: boolean) => void): void;
}

export interface StartOptions {
  paths: ResolvedPaths;
  port: number;
  /** 注入用；默认 node:child_process 的 spawn。照 expand.ts 的先例。 */
  spawnFn?: typeof spawnNode;
  /** 注入用；默认 globalThis.fetch。探「这个端口上是不是已经有一个我们自己」。 */
  fetchFn?: typeof fetch;
}

/** 跟 server/src/index.ts 的 `alreadyOurs()` 一个数——同一个探测超时。 */
const PROBE_TIMEOUT_MS = 1500;

// 导出给 main.ts 复用（见下面的 waitUntilHealthy）：起服务和探活是不是我们自己
// 用的是同一条判断，不该抄两份。
export async function isHealthy(port: number, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return r.ok && ((await r.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export interface WaitOptions {
  fetchFn?: typeof fetch;
  /** 注入用；默认真的 setTimeout。 */
  sleepFn?: (ms: number) => Promise<void>;
  /** 注入用；默认 Date.now。测试靠它摆脱真实挂钟时间，不用真的等 10 秒。 */
  nowFn?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * 轮询 `/api/health` 直到通或者超过 `timeoutMs`。main.ts 在 `loadURL` 之前调用
 * 它：子进程刚 spawn 出来那一刻端口还没绑上，这中间直接 loadURL 只会看到
 * ERR_CONNECTION_REFUSED（白屏），等服务真的答应了再加载页面。
 *
 * 先探一次再决定要不要等：`startServer` 返回 `null`（端口上已经有一个健康的
 * 我们自己）时不该再白等一个 `intervalMs`。
 */
export async function waitUntilHealthy(port: number, opts: WaitOptions = {}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowFn = opts.nowFn ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 300;

  const deadline = nowFn() + timeoutMs;
  for (;;) {
    if (await isHealthy(port, fetchFn)) return true;
    if (nowFn() >= deadline) return false;
    await sleepFn(intervalMs);
  }
}

/** 端口上已经有一个健康的本应用时返回 null（不重复起），否则起一个。 */
export async function startServer(o: StartOptions): Promise<ChildHandle | null> {
  const spawnFn = o.spawnFn ?? spawnNode;
  const fetchFn = o.fetchFn ?? fetch;

  // 用户可能已经双击过 启动.cmd：旧进程占着这个端口时，新进程绑端口会
  // EADDRINUSE 悄悄死掉（server/src/index.ts 的 'error' 处理会 exit(1)），
  // 窗口一闪就没了。先探一下，是我们自己就直接复用，不重复起第二个。
  if (await isHealthy(o.port, fetchFn)) {
    return null;
  }

  // process.execPath 而不是字面量 'node'：打包后用户机器上不一定装了 node，
  // 但 Electron 自带的那个二进制本身就是一份 Node 运行时——加
  // ELECTRON_RUN_AS_NODE=1 之后它会当纯 Node 跑（不当 Electron 起第二个
  // GUI 进程）。这条环境变量 brief 给的测试里没写，是本 Task 自己加的断言。
  const child = spawnFn(process.execPath, [o.paths.serverEntry], {
    env: {
      ...process.env,
      PORT: String(o.port),
      DATA_DIR: o.paths.dataDir,
      AGENT_CWD: o.paths.agentCwd,
      // 服务默认会开浏览器；Electron 自己有窗口，再弹一个浏览器是错的。
      NO_OPEN: '1',
      ELECTRON_RUN_AS_NODE: '1',
    },
    // 默认的 'pipe' 没人读的话，子进程写满缓冲区就会阻塞——server/src/expand.ts
    // 82-87 行记录过同一件事：孙进程 claude 用 stdio:'inherit' spawn，写的东西
    // 直接进了这条没人排空的管道，十分钟后被超时杀掉。'inherit' 跟 expand.ts
    // 用同一个先例：打包后 GUI 进程没有控制台，写到无效句柄不阻塞；开发模式下
    // 还能在终端看到服务自己的输出。
    stdio: 'inherit',
  });

  // 闭包里的布尔量：stop() 先置位再 kill()，'exit'/'error' 回调靠它分清「崩了」
  // 还是「我们让它退的」——前者该告诉用户，后者不该。也拿它当 stop() 的幂等
  // 守卫，不用另开一个变量：两者本来就该同时置位，从不分叉。
  let killedByUs = false;
  let cb: ((code: number | null, killedByUs: boolean) => void) | undefined;
  // undefined = 还没退；退了之后存的是退出码，供 onExit() 晚注册时补发。
  let exited: number | null | undefined;

  // 'exit' 和 'error' 都要在 spawn 之后立刻挂，不能等 onExit() 被调用才挂：
  // EventEmitter 不重放，晚挂的监听器会错过这中间已经发生的事件——调用方
  // 可能在 await startServer() 和挂 onExit() 之间还 await 了别的事（比如
  // win.loadURL()），子进程要是这段时间里退出，这条消息就永远没人收到了。
  const settle = (code: number | null) => {
    if (exited !== undefined) return; // 只处理一次：'error' 之后 Node 可能接着发 'exit'
    exited = code;
    cb?.(code, killedByUs);
  };
  child.on('exit', settle);
  // spawn 失败（比如被杀软拦截进程创建）发的是 'error' 不是 'exit'：没有监听者
  // 的话会变成 uncaughtException，在 Electron 主进程里就是一次崩溃对话框，
  // 而不是「告诉用户服务崩了」。
  child.on('error', () => settle(null));

  return {
    stop() {
      if (killedByUs) return; // 幂等：调两次不抛，也不重复 kill
      killedByUs = true;
      child.kill();
    },
    onExit(f) {
      cb = f;
      if (exited !== undefined) f(exited, killedByUs); // 迟到也补发
    },
  };
}
