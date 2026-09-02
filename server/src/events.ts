import { watch } from 'node:fs';
import { join } from 'node:path';
import { invalidate, invalidateAll } from './entityStore.js';
import { mergeOutbox } from './outbox.js';
import { OUTBOX_RE } from './store.js';

export type Listener = (event: string, data: unknown) => void;

/**
 * 桌面端心跳的过期窗口。`/api/events` 的 SSE 连接每 25 秒发一次 `ping`
 * （见 app.ts），桌面端的那条连接每次心跳都顺带调用 `Bus#markDesktopOnline`——
 * 超过这个窗口没刷新过，就当桌面端已经不在了。取将近 3 倍 ping 间隔，
 * 给单次心跳漏发（进程卡顿、GC 暂停）留余量，同时不让「提醒静默」的窗口开太久。
 *
 * 这只是兜底：正常的干净断开（应用退出、连接被主动关掉）走的是
 * `markDesktopOffline`，立刻生效，不用等这个窗口——见下面 `subscribe`/`isDesktopOnline`
 * 的注释。这个常量只在心跳没能按时刷新（比如进程被强杀、没能走到断开回调）
 * 时才起作用。
 */
const DESKTOP_HEARTBEAT_TTL_MS = 70_000;

/** 一个进程内的极简广播。订阅者就是当下连着的那几个 SSE 流。 */
export class Bus {
  private listeners = new Set<Listener>();
  // 桌面端（Electron）SSE 订阅带 `?client=desktop`，跟网页订阅区分开——网页
  // 开着不代表有人能收到原生通知，只有桌面端在线才该把 PowerShell 兜底关掉。
  // 见 reminder.ts 里 `settings.toastEnabled && !bus.isDesktopOnline(now)` 那行。
  private desktopLastSeenAt = 0;
  // 引用计数，不是「有没有」的布尔：同一时刻可能不止一条桌面端 SSE 连接活着——
  // SSE 重连的交接窗口（旧连接的 onAbort 比新连接的 subscribe 晚触发，TCP 半开/
  // 代理场景下会发生）、或者以后加的别的壳（手机？）也带 `?client=desktop` 连一下。
  // 如果直接用「断开就置离线」，先建立的新连接会被后断开的旧连接误伤成「离线」，
  // 明明还有一条好好活着。只有减到 0（最后一条也断了）才真的标记离线——
  // 见 connectDesktop/disconnectDesktop。
  private desktopConnCount = 0;
  // 只记 agent-status 这一路的最新一条，不是通用的事件历史——data-changed/
  // reminder 补不回来也无所谓（补一次全量 reload / 到期扫描就找齐了），但
  // agent-status 不一样：服务启动时的补合并跑在第一个浏览器连上之前，一个
  // 卡在磁盘上的坏 outbox 文件会把 'failed' 广播给零个订阅者——这正是「重试」
  // 这个功能存在的场景，不能让用户永远看不到。刷新页面丢掉「正在拆解」也是
  // 同一个道理：新连上的订阅者应该立刻看到「当下是什么状态」，不是从零开始。
  private lastAgentStatus: unknown = null;
  private lastAgentStatusAt = 0;

  /**
   * `replayTtlMs`：终态（ok/failed/skipped）超过这么久就不再重放——没有这个
   * 上限的话，昨天那条「拆解完成」会钉在每次打开的新页面/新标签页/EventSource
   * 自动重连上，横幅的 `onClose` 只改前端 state，改不了 Bus 里存的这一份，
   * 下次连上照样原样带回来，在下一次真的跑之前永远关不掉。
   *
   * `running` 不受这个限制——见 `shouldReplay()`。
   */
  constructor(private replayTtlMs = 5 * 60 * 1000) {}

  private shouldReplay(): boolean {
    const s = this.lastAgentStatus as { state?: string } | null;
    // 'running' 永远重放：它只会被同一次运行后续的 ok/failed/skipped 覆盖，
    // 不会像终态那样一直摆着不过期——真卡住的话十分钟超时也会把它换成
    // 'failed'，服务重启则直接清空整个 Bus，不存在残留一条陈年 'running' 的情况。
    //
    // 'scheduled' 是同一类：延迟最长能配到 3600 秒，超过 5 分钟的默认重放
    // 时效很容易被踩到——一个开着倒计时的页面被 TTL 拦下变成空白，用户会
    // 以为排期没了。它会被同一次排期后续的 running/idle/别的 scheduled 覆盖，
    // 不会无限期挂着：autoExpand.ts 的 cancel() 在排期失效时会主动发 'idle'。
    if (s?.state === 'running' || s?.state === 'scheduled') return true;
    return Date.now() - this.lastAgentStatusAt < this.replayTtlMs;
  }

  private safeCall(l: Listener, event: string, data: unknown): void {
    // 一个订阅者抛异常不能带走其余的：SSE 流可能刚断，
    // 而正在发的这一条也许是别人的提醒。
    try {
      l(event, data);
    } catch (e) {
      console.warn('[events] 订阅者出错：', (e as Error).message);
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    if (this.lastAgentStatus !== null && this.shouldReplay()) this.safeCall(l, 'agent-status', this.lastAgentStatus);
    return () => { this.listeners.delete(l); };
  }

  emit(event: string, data: unknown): void {
    if (event === 'agent-status') {
      this.lastAgentStatus = data;
      this.lastAgentStatusAt = Date.now();
    }
    for (const l of this.listeners) this.safeCall(l, event, data);
  }

  /** expand.ts 用来判断「从我发出 running 到现在，有没有别的 agent-status 落地过」——
   * 比较的是对象引用，不是深比较：只要没人再 `emit('agent-status', ...)`，这里
   * 拿到的就还是 running 那个时候塞进去的同一个对象。 */
  get lastStatus(): unknown {
    return this.lastAgentStatus;
  }

  get size(): number {
    return this.listeners.size;
  }

  /** 桌面端表明自己还在——SSE 连上那一刻（`connectDesktop` 内部调）、以及连接
   * 存续期间的每次心跳都调用一次。只刷新时间戳，不动引用计数——一条连接活着
   * 期间会调很多次，不是「又连上一条」。`now` 是显式参数、默认 `new Date()`：
   * 生产环境靠真实时钟，测试环境（fireReminders 那边）传的是同一个假时钟，
   * 两边比的是同一把尺子。 */
  markDesktopOnline(now: Date = new Date()): void {
    this.desktopLastSeenAt = now.getTime();
  }

  /** 一条桌面端 SSE 连接建立（`/api/events?client=desktop` 的 `streamSSE` 回调
   * 一进来就调）。引用计数 +1，同时刷新一次时间戳（等价于 `markDesktopOnline`，
   * 别再另外调一遍）。 */
  connectDesktop(now: Date = new Date()): void {
    this.desktopConnCount++;
    this.markDesktopOnline(now);
  }

  /** 一条桌面端 SSE 连接断开（`onAbort`）时调用。引用计数 -1，只有减到 0——
   * 最后一条桌面端连接也断了——才真的标记离线；不等心跳窗口过期，干净退出
   * 没道理让提醒静默一两分钟。`DESKTOP_HEARTBEAT_TTL_MS`（见 isDesktopOnline）
   * 是给「引用计数没能归零」（比如漏调了这个方法）或者「进程被强杀，
   * onAbort 压根没走到」兜底的，不是唯一的判据。 */
  disconnectDesktop(): void {
    this.desktopConnCount = Math.max(0, this.desktopConnCount - 1);
    if (this.desktopConnCount === 0) this.desktopLastSeenAt = 0;
  }

  /** 桌面端是不是在线：最近一次心跳还在 TTL 窗口内。`now` 由调用方传入（不内部读
   * 实时时钟）——`fireReminders` 已经有一个统一的 `now`，判「到期」和判「桌面端在不在」
   * 该看同一个时间点，测试用假时钟推时间的时候尤其不能各看各的。 */
  isDesktopOnline(now: Date): boolean {
    return now.getTime() - this.desktopLastSeenAt < DESKTOP_HEARTBEAT_TTL_MS;
  }
}

// settings 不在这个名单里——它根本不在 data/ 里，是设备本地的 device.json
// （见 store.ts 的 deviceConfigPath），这个监听器压根看不到它的变化，也不
// 需要看：PUT /api/settings 自己会 emit data-changed{file:'settings'}，
// 见 app.ts。这个名单本身是**目录名**，不是文件名（见下面 watchData 的
// 分派逻辑）：一实体一文件之后，任务/收件箱/建议等等各自是 data/ 下一个
// 子目录。
// `countdowns` **原来漏在名单外**，而它的整条链路早就通了：`DataFile` 里列着
// 它、`App.tsx` 的 `reload('countdowns')` 认它、纪念日那几条写路由也不自己
// emit——也就是说加一条纪念日之后，**界面上什么都不会发生**，得等到别的东西
// 触发一次刷新才冒出来。这正是这个仓库最怕的那个形状（「写成功了但界面看
// 上去什么也没发生」）。补进名单即可，不用改任何路由。
const WATCHED = ['inbox', 'tasks', 'proposals', 'lists', 'folders', 'insights', 'countdowns', 'trash'] as const;

/**
 * 监听数据目录，文件一变就广播 data-changed（outbox 例外，见下）。
 *
 * **去抖是必须的**：Windows 上一次写会连发好几个 change 事件，
 * 而 store 的原子写还额外产生一个 .tmp 的创建和一次 rename。
 * 前端每收一条就重新拉一次数据，不去抖等于一次编辑刷四五遍。
 *
 * 这个去抖窗口同时是「outbox 不会读到写了一半的半截 JSON」的保证：AI 的 Write
 * 工具对这么小的文件（几 KB 的任务数组）是一次系统调用写完、写完就关文件，不是
 * 边写边可见的流式写法；即便某次写触发了不止一个 fs 事件，去抖也会等到最后一个
 * 事件之后再等满 `debounceMs` 的静默期才真的去读——读的时候那次写早就落盘完毕了。
 * 跟 tasks.json/inbox.json 这些本来就假设「一次写完整文件」的路径是同一个前提，
 * 不是给 outbox 单独加的特例。真出现读到坏 JSON 的极端情况，`mergeOutbox` 也不会
 * 崩——校验失败就留着文件、报错，不会误判成合法内容合并进去。
 *
 * 监听是**递归**的（`{ recursive: true }`）：一实体一文件之后，任务/收件箱/
 * 建议这些各是 `data/` 下一个子目录，非递归监听只看得到顶层、永远等不到子
 * 目录里的变化。递归之后 `filename` 变成相对路径（`tasks/<uuid>.json`，
 * Windows 上分隔符是反斜杠），分派靠的是**第一段目录名**，不是文件名——
 * 实体文件名是 uuid，拿它去比对 `WATCHED` 永远不会中。
 *
 * 顶层的散落文件（旧格式的 `tasks.json.tmp`/`tasks.json.bak` 这种、或者随手扔在
 * `data/` 根目录的杂物）天然没有目录分隔符，取「第一段」拿到的就是整个文件名，
 * 不会命中 `WATCHED` 里的目录名，照样被挡在外面，不需要专门加排除规则。
 *
 * outbox 文件（`outbox-*.json`）不在上面那个固定名单里，另外用 `OUTBOX_RE` 认——
 * 这条正则跟 `store.ts` 列目录时用的是同一份，两处不会飘。多个 outbox 文件的变化
 * 共用一个去抖定时器（键固定是 `'outbox'`，不是具体文件名）：两个 AI 进程前后脚
 * 各写一个文件，合并应该等两个都落盘静默之后一次性扫描处理，不是谁先写完就先触发
 * 一次只顾得上自己那个文件的合并。
 *
 * `settings.json` 不在 `WATCHED` 里，也不会另外单独认——它已经搬到设备本地的
 * `device.json`（Task 5），根本不在这个函数监听的 `dir` 底下，这个监听器永远
 * 看不到它的变化，也不用看：`data-changed{file:'settings'}` 现在由
 * `PUT /api/settings` 自己 emit（见 `app.ts`），`autoExpand.ts` 拿它重算已经
 * 排上的那次倒计时，`App.tsx` 拿它做多标签页设置同步——这两个消费方都没变，
 * 变的只是谁负责发出这个事件。
 *
 * 不做「这次是不是我自己写的」的自我抑制：server 写完文件前端多拉一次数据无害，
 * 而维护那个状态要在每个写入点埋标记，是真会腐坏的复杂度。
 */
export function watchData(bus: Bus, dir: string, debounceMs = 200): () => void {
  const timers = new Map<string, NodeJS.Timeout>();

  const schedule = (key: string, run: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      // `run()` 这里是裸的 `setTimeout` 回调——没有人在调用栈上游接得住异常，
      // 抛出去就是一个 uncaughtException，整个服务跟着没了。`mergeOutbox` 内部
      // 已经把能想到的失败都收敛成了返回值/日志，这层 try/catch 是最后一道
      // 保险：万一还是漏了什么（比如 readInbox/readTasks 读到的是别的原因写坏
      // 的文件），降级成一条警告，好过带走整个进程。
      try {
        run();
      } catch (e) {
        console.warn('[events] 定时任务出错，不应该发生：', (e as Error).message);
      }
    }, debounceMs));
  };

  const watcher = watch(dir, { recursive: true }, (_type, filename) => {
    if (!filename) return;
    const raw = filename.toString();

    // 顶层的 outbox-*.json 没有分隔符，这一条判断照旧。
    if (OUTBOX_RE.test(raw)) {
      // 合并本身会去写 tasks.json / inbox.json，那两个写入会各自再触发一轮这个
      // 监听器，data-changed 是在那一轮里发出去的——前端因此照样会刷新，
      // 不需要在这里另外处理。
      schedule('outbox', () => mergeOutbox(bus));
      return;
    }

    // 递归监听之后 filename 是相对路径（`tasks/abc.json`）。表名是第一段目录，
    // 不是文件名——实体文件名是 uuid，拿它去比对 WATCHED 永远不会中。
    // 分隔符两种都要认：Windows 给的是反斜杠。
    const table = raw.split(/[/\\]/)[0];
    if (!(WATCHED as readonly string[]).includes(table)) return;

    // 先失效缓存再排广播，顺序不能反：反过来的话前端收到通知立刻来拉，
    // 服务端还在拿旧缓存答复它——刷新了个寂寞，看起来就像「写没生效」。
    // invalidate 是同步的 Map.delete，便宜到不需要跟着去抖。
    invalidate(join(dir, table));
    schedule(table, () => bus.emit('data-changed', { file: table }));
  });

  watcher.on('error', (e) => {
    // 监听挂了不该拖垮服务，但也不能假装只是「不自动刷新」这么轻——挂了之后
    // 再也没有人会调用 invalidate（那是这个监听器自己的活），entityStore 的
    // 内存缓存会一直吐旧数据，光是 F5 都救不回来，得重启服务才行。
    // invalidateAll() 把它切换成「以后每次都读盘」：手动刷新至少能看到最新
    // 内容，不会被一份永远新鲜不了的缓存卡死（WebDAV/网络挂载盘上 fs.watch
    // 报错、漏事件很常见，正是这次改造要扛住的场景）。
    invalidateAll();
    console.warn('[events] 数据目录监听中断，已经切换成每次都读盘（不会再自动刷新，但手动刷新能看到最新内容）：', e.message);
  });

  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
