export interface SseEvent {
  event: string;
  data: string;
}

/**
 * 增量解析 text/event-stream。帧之间用空行分隔（`\n\n`），一帧内 `event:`/`data:`
 * 各一行——这跟服务端 `server/src/app.ts` 用 Hono 的 `streamSSE` 写出来的格式对齐
 * （`event: <name>\ndata: <JSON.stringify 过的字符串>\n\n`，服务端从不写多行 data、
 * 不写 `id:`/`retry:`/注释行，见 node_modules/hono 里 `writeSSE` 的实现）。
 * chunk 边界可能切在一帧中间，没解析完的半帧原样放进 `rest`，等下一块拼上继续解析。
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: SseEvent[] = [];
  for (const frame of frames) {
    let event = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data = line.slice('data: '.length);
    }
    // 没有 event 行的帧不是这个服务会写出来的东西，防御性跳过而不是硬拼一个空字符串。
    if (event) events.push({ event, data });
  }
  return { events, rest };
}

export interface SubscribeOptions {
  /** 注入用；默认全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 断线后等多久重连；注入是为了测试不用真的等。 */
  sleepFn?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  /** 传了就能从外面喊停（比如应用退出时），不传就一直连到进程本身退出为止。 */
  signal?: AbortSignal;
}

/**
 * 手写而不是用 `EventSource`：Node 的全局 `EventSource` 到现在（写这段代码时
 * 用 `node -p process.version` 核过是 v24）还锁在 `--experimental-eventsource`
 * 标志后面，没有它 `typeof EventSource === 'undefined'`。写这段时的沙盒环境
 * 起不了真的 Electron GUI（`node_modules/electron/dist` 没下载），没法实测
 * Electron 的主进程到底带没带这个标志、`NODE_OPTIONS` 那条路在打包后的
 * 主进程里是否真的生效。（二进制后来装上了、GUI 也真起得来了——2026-09-04 升
 * Electron 44 那次实跑过一次，窗口画出来了。**但上面那两个问题仍然没有人量过**，
 * 现在只是「测得了而没测」，不再是「测不了」。）与其赌一个没量过的全局对象，
 * 不如用已经验证过在这个
 * 运行时里可用的 `fetch`（Task 2 的 `serverChild.ts` 靠它探活，这里靠它读
 * 流式响应体）。行为上尽量对齐 `EventSource`：断线（无论是流正常结束还是
 * fetch 直接失败）都自动重连，不需要调用方处理。
 */
export async function subscribeSse(
  url: string,
  onEvent: (event: string, data: unknown) => void,
  opts: SubscribeOptions = {},
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const signal = opts.signal;

  while (!signal?.aborted) {
    try {
      await readOnce(url, fetchFn, signal, onEvent);
    } catch {
      // fetch 被拒绝（服务还没起来）、流中途出错，都在这儿收——EventSource
      // 原生遇到这些也是直接重连，不会把异常甩给调用方。
    }
    if (signal?.aborted) break;
    await sleepFn(retryDelayMs);
  }
}

async function readOnce(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetchFn(url, { signal });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('/api/events 响应没有可读的 body');

  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const e of events) dispatch(e, onEvent);
  }
}

function dispatch(e: SseEvent, onEvent: (event: string, data: unknown) => void): void {
  try {
    // ping 心跳的 data 是空字符串——'' 不是合法 JSON，但也不该让整条订阅
    // 因为一次心跳就跳过重连以外的处理；当 null 处理，交给 onEvent 决定
    // （notify.ts 的 toNotification 反正只认 'reminder' 事件）。
    onEvent(e.event, e.data ? JSON.parse(e.data) : null);
  } catch {
    // 坏 JSON 不该把整条订阅炸掉，跳过这一条，下一条继续。
  }
}
