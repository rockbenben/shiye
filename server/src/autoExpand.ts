import type { Bus } from './events.js';
import { emitAgentStatus, type createAgentRunner } from './expand.js';
import { readInbox, readSettings } from './store.js';

type ExpandRunner = ReturnType<typeof createAgentRunner>;

const MIN_DELAY_SEC = 10;
const MAX_DELAY_SEC = 3600;

/** 防止手改 settings.json 塞进一个越界值——PUT /api/settings 已经在写入前
 * 夹好了，这里是第二道防线，属于读这份数据的另一个信任边界。 */
const clampDelaySec = (v: number): number =>
  Number.isFinite(v) ? Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, v)) : 60;

export interface AutoExpand {
  /** 「重新拆解」把某条收件箱记录翻回未处理时用来把它从尝试记录里摘掉，
   * 不这样做的话那条记录永远出不了自动触发的候选池，按钮对自动模式等于没用。 */
  forget: (inboxId: string) => void;
  /** 手动触发（POST /api/expand）清空整份尝试记录——用户明确要求重来就是重来，
   * 不管这次触发本身是不是因为单飞锁被 409 挡掉了。 */
  clearAll: () => void;
  /** 「这次不拆」：取消当前排期，不运行、不碰尝试记录——下次任何相关变化
   * 都可能重新排上，这不是「关掉自动拆解」。 */
  skip: () => void;
  /** 测试/进程退出时清理定时器和订阅，不留悬挂的 handle。 */
  dispose: () => void;
}

/**
 * 事件驱动的自动拆解调度器。见 已归档的 `docs/superpowers/specs/2026-08-11-auto-expand-design.md`。
 *
 * **状态只有一份，就是这个闭包里的 `attempted`/`scheduledSince`/`timer` 三个变量**——
 * 不写进任何数据文件，服务重启就清空（这是设计要求的：「重启不频繁，且重启后再
 * 试一次通常是对的」）。之所以不落盘、不挂在 `InboxItem` 上加一个字段：`attempted`
 * 记的是「自动调度器有没有为这个 id 花过一次额度」，这件事跟 `processed` 是两个
 * 独立的维度（一条可以不 processed 但已经 attempted，也可以 processed 但从没被
 * 自动尝试过——比如全程都是手动触发）。放进 `tasks.json`/`inbox.json` 会让这两个
 * 文件多一个只有服务自己关心、AI 和用户都不关心的字段，还得额外考虑「AI 写
 * outbox 的时候要不要保留它」——真正的收益只是「重启也不清空」，跟设计明确要的
 * 「重启清空」正好反着。内存变量不写盘，天然满足「重启清空」，也天然不会跟
 * 数据文件产生第二份互相矛盾的状态。
 */
export function createAutoExpand(bus: Bus | undefined, runner: ExpandRunner): AutoExpand {
  const attempted = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let scheduledSince: number | null = null;

  /** 取消当前排期。`hide`：要不要把这件事广播出去——`agent-status` 已经被别的
   * 状态（比如 'running'）覆盖时不用再补一条，重复了也没人看。 */
  function cancel(hide: boolean): void {
    if (timer) clearTimeout(timer);
    timer = null;
    const wasScheduled = scheduledSince !== null;
    scheduledSince = null;
    if (hide && wasScheduled) emitAgentStatus(bus, { state: 'idle' });
  }

  function fire(): void {
    timer = null;
    scheduledSince = null;
    try {
      // 这一轮会处理收件箱里所有还没处理的条目（AGENTS.md 的约定），不只是「没
      // 被尝试过」的那几条——把它们全标成「尝试过」才如实：这次自动触发之后，
      // 不管结果如何，它们都不该再无条件地引发下一次自动触发。
      for (const x of readInbox()) {
        if (!x.processed) attempted.add(x.id);
      }
      // **这个分支是真会走到的**（这句话原来写着「当前代码走不到」，加了「调接口」
      // 那条路之后不成立了）：设置成 api 模式、但地址或模型没填全时，`start()`
      // 当场返回 `ok:false`。剩下三种也各自真实——单飞锁挡住、spawn 同步抛错、
      // 服务和 AI 看的不是同一个目录。
      //
      // 走到时**不**补一条 `idle`：`start()` 自己在每一条 `ok:false` 的路上都已经
      // 发过一条更有信息量的 `agent-status`（别的运行的 `running`，或者带具体
      // 原因的 `failed`）。这里再 emit `idle` 只会把那条更真实的状态抹掉——前端
      // 看到的是「什么都没有」，不是「设置里的 AI 模型名还没填」，正是这个仓库
      // 反复栽过的静默失败。只留一条日志，不动 `agent-status`。
      //
      // **不会变成重试风暴**：上面那个循环在 `start()` 之前就把所有未处理条目标进
      // 了 `attempted`，配置一直不全的话它们不会再被自动排上。
      //
      // 能让它们重新排上的有三条：他自己点「立即拆解」、记一条新的收件箱条目、
      // 或者**去设置里把 AI 那几格改对**——最后这一条是后补的（`app.ts` 的
      // `PUT /api/settings` 里那段 `aiChanged`）。补之前这句话是假的：横幅让他
      // 去填模型名，他填完保存，却什么都不会发生。
      const result = runner.start();
      if (!result.ok) console.warn('[autoExpand] 触发排期时 start() 没有成功：', result.error);
    } catch (e) {
      // 裸的 setTimeout 回调，没有人在调用栈上游接得住异常——`readInbox()` 遇到
      // 手改坏的 JSON 会按 store.ts 的设计抛错，不包一层就是 uncaughtException
      // 带走整个服务。跟 events.ts 给自己的定时回调包 try/catch 是同一个道理。
      console.warn('[autoExpand] 触发排期时出错，不应该发生：', (e as Error).message);
      emitAgentStatus(bus, { state: 'idle' });
    }
  }

  /**
   * 重新评估要不要排期 / 要不要把已经排上的那次重算。
   *
   * `resetClock`：true 表示「有理由把倒计时从现在重新起算」——新条目出现、
   * 「重新拆解」翻回未处理、上一轮运行刚结束。false 只用在设置变化触发的
   * 重新评估上：不重置起点，只用新的 `autoExpandDelaySec` 重新算 `at`，这样
   * 「改延迟立刻生效，已经排上的那次按新延迟重算」才成立——如果这里也重置
   * 起点，效果会变成「改一次延迟就多等一轮完整延迟」，不是设计要的「重算」。
   */
  function evaluate(resetClock: boolean): void {
    if (!bus) return;

    // `evaluate` 现在从四个没有保护伞的地方被调用：下面 `queueMicrotask` 里
    // 那次、以及 `runner.setOnSettled` 挂的那个——它自己是从一个裸 setTimeout
    // 回调和两个 ChildProcess 事件处理器（'error'/'exit'）里触发的。这几处都
    // 没有人接得住异常（`index.ts` 也没装 `uncaughtException`），修复前
    // `evaluate` 是在 `Bus.safeCall` 的 try/catch 伞下被调用的（`data-changed`/
    // `agent-status` 订阅回调走的是 `Bus.emit` → `safeCall`），挪到这几个新
    // 调用点之后那把伞就没了——`readSettings()`/`readInbox()` 遇到手改坏的
    // JSON 会按 store.ts 的设计抛错，不包一层就是 uncaughtException 带走
    // 整个服务。守卫放在这四个调用点共同经过的地方，不在每个调用点各包一层。
    try {
      const settings = readSettings();
      if (!settings.autoExpand || runner.isRunning()) {
        cancel(true);
        return;
      }

      const eligible = readInbox().filter((x) => !x.processed && !attempted.has(x.id));
      if (eligible.length === 0) {
        cancel(true);
        return;
      }

      if (resetClock || scheduledSince === null) scheduledSince = Date.now();
      const at = scheduledSince + clampDelaySec(settings.autoExpandDelaySec) * 1000;

      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, at - Date.now()));
      timer.unref?.();

      emitAgentStatus(bus, { state: 'scheduled', at: new Date(at).toISOString() });
    } catch (e) {
      console.warn('[autoExpand] 评估排期时出错，不应该发生：', (e as Error).message);
    }
  }

  const off = bus?.subscribe((event, data) => {
    if (event === 'data-changed') {
      const file = (data as { file?: string } | null)?.file;
      if (file === 'inbox') evaluate(true);
      else if (file === 'settings') evaluate(false);
      return;
    }
    if (event === 'agent-status') {
      const state = (data as { state?: string } | null)?.state;
      // 别人（手动触发、我自己 fire() 出来的那次）已经在跑了：我的排期没有意义，
      // 悄悄收掉——不广播 'idle'，因为 'running' 已经把前端的显示接管了。
      // `cancel(false)` 不带 hide，不会 emit，不存在下面那段嵌套 emit 的问题。
      if (state === 'running') cancel(false);
      // 一次运行刚结束：可能收件箱里还有没处理完的（校验失败、还在 attempted
      // 里，不会重新排上），也可能运行期间又冒出了新条目（没在 attempted 里，
      // 值得排一次全新的等待）。两种情况都交给 evaluate 判断。
      //
      // **必须 queueMicrotask，不能同步调用。** 这里是 `Bus.emit` 遍历监听器
      // 的调用栈里——`Bus.emit` 先把 `lastAgentStatus` 设成这次的 data，再挨个
      // 通知监听器；如果这里同步调 `evaluate(true)` 并且它决定要排期/取消，
      // 会同步再 `bus.emit('agent-status', ...)` 一次，那次嵌套 emit 会把
      // `lastAgentStatus` 顶掉成 scheduled/idle——外层这条 ok/failed/skipped
      // 从此在 `lastAgentStatus` 里再也找不到了。实测能复现：启动补合并发现
      // 一个坏 outbox 文件、广播 failed，这条监听器嵌套发出 scheduled，新连上
      // 的浏览器重放到的是倒计时，那条失败信息永远消失——而 events.ts 顶上
      // 那段重放缓冲的注释白纸黑字写着它存在就是为了不让这种「补合并跑在
      // 浏览器连上之前」的结论丢失。挪到微任务里，外层 `bus.emit` 先跑完、
      // `lastAgentStatus` 先稳定成 failed，微任务里再发的 scheduled/idle
      // 才是紧随其后的第二条独立事件，不会覆盖谁。`evaluate` 第一件事就是
      // 重新读 `runner.isRunning()`/`readSettings()`/`readInbox()`，跳出同步
      // 调用栈之后状态可能已经变了，它会看到最新的，不是这里捕获的快照。
      else if (state === 'ok' || state === 'failed' || state === 'skipped') queueMicrotask(() => evaluate(true));
    }
  });

  // autoExpand.ts 自己的排期只覆盖「我们自己 start() 的那次」——outbox 合并
  // 完成的时间点几乎总是早于子进程真正退出（见 expand.ts 'exit' 里的注释），
  // 那一刻 `runner.isRunning()` 还是 true，上面 agent-status 分支里的
  // `evaluate` 会直接判定「还在跑」放弃评估；等子进程真退出，因为合并早就
  // 说过话了，expand.ts 那边不会再补一条 agent-status，上面那条订阅也就
  // 没有第二次机会——如果这中间有新条目冒出来，永远没有东西再看它一眼，
  // 直到下一次凑巧的收件箱变化。`setOnSettled` 是唯一不依赖任何 agent-status
  // 有没有发生的信号：不管这次运行怎么结束（正常退出、非零退出、spawn 报错、
  // 超时被杀），闭包里的 `child` 变成 null 的那一刻必然调用它。
  runner.setOnSettled(() => evaluate(true));

  // 补一次启动时的检查：createAutoExpand 是随 createApp() 一起建的，这时候
  // inbox.json 里完全可能已经躺着服务没开着时攒下的未处理条目。
  evaluate(true);

  return {
    forget: (id) => { attempted.delete(id); },
    clearAll: () => { attempted.clear(); },
    skip: () => { cancel(true); },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      off?.();
      // 不摘掉的话 runner 还攥着这个闭包的 evaluate 引用——它下次 settle
      // 时照样会跑，`bus` 还在（这里不清），会平白发一条 disposed 之后的
      // agent-status，这个实例明明已经交代过「不再关心」了。
      runner.setOnSettled(() => {});
    },
  };
}
