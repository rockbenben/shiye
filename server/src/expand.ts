import { spawn, type ChildProcess } from 'node:child_process';
import type { Bus } from './events.js';
import { agentCwd, agentDataDir, aiSeesSameData, dataDir, readSettings } from './store.js';
import { configProblem, runViaApi, scopeLine, type Fetcher, type ReviewScope } from './aiApi.js';

export type { ReviewScope };

export interface AgentStatus {
  // 'scheduled'：autoExpand.ts 排上了一次自动拆解，`at` 是绝对触发时间（ISO），
  // 前端拿它算倒计时。'idle'：排期被取消（设置关了自动拆解、这次不拆、或者
  // 排上的条目已经没有资格了）且没有别的状态接着说话——只用来把前端的倒计时
  // 收起来，不代表任何结果，见 autoExpand.ts 的 cancel()。
  //
  // 'skipped'：没有产出新任务，但不是错误——outbox.ts 的 mergeOutbox 在「条目
  // 全都已经处理过」「AI 判断都不是任务」「收件箱里压根没内容」几种情况下发
  // 这个状态；下面这个模块自己在「AI 进程正常退出、但期间没有任何合并发生」
  // 时也发一条（AI 什么都没写出来）。共同点是：不该用红色的失败吓人，但也
  // 不能假装绿色的成功——用户点了「立即拆解」/「让 AI 回顾一遍」却看不到新卡片、
  // 看不到新建议，得知道为什么。
  state: 'scheduled' | 'running' | 'ok' | 'failed' | 'skipped' | 'idle';
  message?: string;
  /** 只有 state === 'scheduled' 时才有意义。 */
  at?: string;
}

export function emitAgentStatus(bus: Bus | undefined, status: AgentStatus): void {
  bus?.emit('agent-status', status);
}

/**
 * 这个 runner 能叫起 AI 干的两件事：拆收件箱、回顾已有任务。
 *
 * **两件事共用下面那把单飞锁，不是各锁各的**：它们读的是同一份 `data/`、写的是
 * 同一批 `outbox-*.json`，同时起两个 `claude` 对着同一个目录写，等于赌两次
 * `mergeOutbox` 不撞车。慢一件事，不赌。
 */
export type AgentKind = 'expand' | 'review';

/**
 * 服务端只指路，不抄规则。规则的正本在 `workflows/expand.md` / `workflows/review.md`
 * （field 层的细则又转指 `AGENTS.md`）——两边都在提示词里写一遍，迟早有一边改了
 * 另一边忘了改。
 *
 * 这两句必须跟 `.claude/commands/` 下那两条斜杠命令说的是同一件事：界面上那两颗
 * 按钮，和他自己在终端里敲 `/expand`、`/review`，该走同一条路——不然「按钮跑出来
 * 的」和「手敲跑出来的」是两个结果，而界面上没有任何地方会提示这种分叉。
 */
/**
 * 服务叫起 AI 时发的那两句话，**这里是正本**。
 *
 * 导出只为一件事：`AGENTS.md` 开头把这两句逐字抄了一遍（AI 靠它们认出「我这次
 * 被叫来拆解还是回顾」），`agentsMd.guard.test.ts` 拿这份去比，两边飘了会红。
 * 产品代码只在下面 `start()` 里用。
 */
export const PROMPT: Record<AgentKind, string> = {
  expand: '读 AGENTS.md 和 workflows/expand.md，处理收件箱里还没处理的条目。',
  review: '读 AGENTS.md 和 workflows/review.md，回顾一遍现有任务。',
};



/** 报错和状态里怎么称呼这件事——这些字符串会原样出现在界面上，别把 'expand' 漏出去。 */
const WORD: Record<AgentKind, string> = { expand: '拆解', review: '回顾' };

/** 跑完了却什么都没写出来时，各自该说的实话。见下面 'exit' 里那段长注释。 */
const NOTHING: Record<AgentKind, string> = {
  expand: 'AI 跑完了，但没有写出任何拆解结果（收件箱里可能没有要拆的内容）',
  review: 'AI 跑完了，但没有提出任何建议（现有的任务里可能没什么值得说的）',
};

const TEN_MINUTES = 10 * 60 * 1000;

/** 测试用换掉真的 `child_process.spawn`。签名对得上，用到的只有 'error' / 'exit' 两个事件和 kill()。 */
export type Spawner = (command: string, args: string[], options: { cwd: string; stdio: 'inherit' }) => ChildProcess;

/**
 * 单飞 + 超时 + 状态广播的 AI 触发器。拆解和回顾都从这里起。
 *
 * `child` 是这个闭包私有的一份状态——每次 `createAgentRunner()` 各自独立，
 * 测试建多份互不干扰；生产（`app.ts` 的 `createApp()`）只建一次，全进程也就一份，
 * 这就是「单飞」的全部实现：不是分布式锁，就是一个变量。
 */
export function createAgentRunner(bus?: Bus, spawnFn: Spawner = spawn, timeoutMs = TEN_MINUTES, fetchFn: Fetcher = fetch) {
  // 存着 kind 而不只是进程：单飞被拒时要说清「正在跑的是哪件事」——「上一次回顾
  // 还在跑」和「上一次拆解还在跑」，对着一颗刚点的按钮是两种完全不同的解释。
  //
  // 存的是 `stop` 而不是进程本身：两条路（CLI 子进程 / HTTP 请求）中止的方式
  // 不一样，一个 kill、一个 abort，但**单飞锁必须是同一把**——两条路读写的是
  // 同一份 `data/`、同一批 outbox 文件，各锁各的等于没锁。
  let child: { kind: AgentKind; stop: () => void } | null = null;
  let onSettled: (() => void) | undefined;

  /**
   * 设置里选了「调接口」时走这条。**只换「谁去想」，别的全不变**：单飞锁、
   * 十分钟超时、agent-status 的四种状态、outbox 文件的校验与合并，跟 CLI
   * 那条路共用同一套，见 `aiApi.ts` 顶上的分工那节。
   *
   * **写出 outbox 文件之后什么状态都不发**，这跟 CLI 那条路的收尾是同一条
   * 规矩（见下面 'exit' 里那段长注释）：合并结果是 `mergeOutbox` 自己广播的，
   * 这里再补一句「完成了」就是拿一句过时的话去盖掉真实结论——合并说校验没过，
   * 用户看到的却是绿色的成功。
   *
   * **也不在这里直接调 `mergeOutbox`**（那样确实能让状态早 200 毫秒到）：
   * `outbox.ts` 已经 import 了这个文件的 `emitAgentStatus`，反过来 import 它
   * 就是一个真的运行时循环依赖。让文件监听器去触发，跟 AI 自己写文件时走的是
   * 同一条路，一个分支都不多。
   */
  function startApi(kind: AgentKind, scope?: ReviewScope): { ok: true } | { ok: false; error: string } {
    const s = readSettings();
    const cfg = { baseUrl: s.aiBaseUrl, apiKey: s.aiKey, model: s.aiModel };

    // 配置有毛病就明确说是哪一格、毛病在哪。不这样的话请求会带着空 model
    // 或者一个含中文的请求头打出去，拿回一句各家措辞都不同的 400、或者 undici
    // 那句 ByteString 异常——用户对着那些话猜不出要去设置里改什么。
    const bad = configProblem(cfg);
    if (bad) {
      const message = `设置里的 AI ${bad}，改好再${WORD[kind]}`;
      emitAgentStatus(bus, { state: 'failed', message });
      return { ok: false, error: message };
    }

    emitAgentStatus(bus, { state: 'running' });
    const ac = new AbortController();
    child = { kind, stop: () => ac.abort() };

    let settled = false;
    const finish = (emit?: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      emit?.();
      onSettled?.();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      ac.abort();
      finish(() => emitAgentStatus(bus, { state: 'failed', message: `${WORD[kind]}超过 10 分钟没结束，已经中止` }));
    }, timeoutMs);
    timer.unref?.();

    void runViaApi(kind, cfg, fetchFn, ac.signal, scope)
      // wrote === false：模型明确回了空数组，等价于 CLI 那条路「跑完了什么都
      // 没写出来」。true 的话一个字都不发，等合并去说。
      .then((wrote) => finish(wrote ? undefined : () => emitAgentStatus(bus, { state: 'skipped', message: NOTHING[kind] })))
      // 超时那条已经自己发过 failed 了，`finish` 的幂等挡住第二次。
      .catch((e: Error) => finish(() => emitAgentStatus(bus, { state: 'failed', message: `${WORD[kind]}失败：${e.message}` })));

    return { ok: true };
  }

  // `kind` 默认 'expand'：`autoExpand.ts` 只会排拆解，它那条调用不必写这个参数。
  // 回顾没有自动触发，只会从路由上带着显式的 'review' 进来。
  // `scope` 只有回顾用得上（拆解的对象是收件箱，不属于任何清单）。默认 undefined
  // 就是老行为：扫全部任务。
  function start(kind: AgentKind = 'expand', scope?: ReviewScope): { ok: true } | { ok: false; error: string } {
    if (child) {
      return { ok: false, error: `上一次${WORD[child.kind]}还在跑，等它跑完或者超时（最多 10 分钟）再试一次` };
    }

    // **排在下面 aiSeesSameData 那道守卫之前，是有意的。** 那道守卫防的是
    // 「服务读 A 目录、spawn 出去的 AI 却对着 B 目录跑」——只有 CLI 那条路
    // 存在这个岔口（AI 是另一个进程，有自己的 cwd）。调接口这条路上模型
    // 没有文件系统，读盘写盘从头到尾都是这个服务自己干的，压根不存在
    // 「两边看的不是同一份数据」这回事，拿那道守卫拦它是拦错了对象。
    if (readSettings().aiMode === 'api') return startApi(kind, scope);

    // spawnFn 还是默认那个真 `spawn` 的时候，接下来会真的起一个 claude 进程，
    // 而它读的是 agentCwd() 下的 `data/`（AGENTS.md 里全是相对路径）。这时候
    // 服务自己如果指向别处，两边看的不是同一份数据——**宁可大声拒绝，也不能
    // 让它对着另一个目录跑一遍**，见 store.ts 的 aiSeesSameData 注释里那次
    // 真实事故。
    // 测试注入的假 spawner 不受影响：它压根不读磁盘，而所有服务端测试都会把
    // DATA_DIR 指到临时目录，一刀切会把它们全拦下来。
    if (spawnFn === spawn && !aiSeesSameData()) {
      const message = `服务在读 ${dataDir()}，而 AI 会去读 ${agentDataDir()}——两边不是同一份数据，不能${WORD[kind]}。把 DATA_DIR 和 AGENT_CWD 指到同一处再试。`;
      emitAgentStatus(bus, { state: 'failed', message });
      return { ok: false, error: message };
    }

    emitAgentStatus(bus, { state: 'running' });
    // 拿到「running 这条本身」的引用，不是拷贝一份快照——退出时拿它跟
    // `bus.lastStatus` 做引用比较，用来判断「这期间有没有别的 agent-status
    // 落地过」。见下面 'exit' 里的注释：这是 C 的一处回归修复。
    const statusAtStart = bus?.lastStatus;

    let proc: ChildProcess;
    try {
      // stdio: 'inherit'，不是默认的 'pipe'——`--output-format json` 加上
      // `--allowedTools` 允许的那几样，一次 8 轮的拆解能产出远超 OS 管道缓冲区
      // 的输出；'pipe' 没人读的话子进程写满缓冲区就会被阻塞，直到十分钟超时
      // 杀掉它，而失败时服务本来能报的原因只剩一个退出码。'inherit' 把子进程
      // 的输出直接接到这个服务自己的控制台——启动器窗口——上，那是这台机器
      // 唯一常驻的诊断面。
      proc = spawnFn(process.env.CLAUDE_CLI ?? 'claude', [
        // 范围**追加**在正本那句后面，不改 `PROMPT` 本身：那两句被 AGENTS.md
        // 逐字抄了一份，`agentsMd.guard.test.ts` 盯着两边一致。
        //
        // **这条路上这句话就是全部的约束力**：AI 是另一个进程、自己去读
        // `data/tasks/`，服务端筛不了它（调接口那条是真筛过的）。为什么
        // 没在合并那一步补硬拦截，见 `aiApi.ts` 的 `scopeLine`。
        '-p', scope ? `${PROMPT[kind]}${scopeLine(scope)}` : PROMPT[kind],
        '--allowedTools', 'Read,Edit,Write,Bash',
        '--permission-mode', 'acceptEdits',
        '--output-format', 'json',
      ], { cwd: agentCwd(), stdio: 'inherit' });
    } catch (e) {
      const message = `没能启动 AI：${(e as Error).message}`;
      emitAgentStatus(bus, { state: 'failed', message });
      return { ok: false, error: message };
    }

    child = { kind, stop: () => proc.kill() };
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child = null;
      proc.kill();
      emitAgentStatus(bus, { state: 'failed', message: `${WORD[kind]}超过 10 分钟没结束，已经中止` });
      onSettled?.();
    }, timeoutMs);
    timer.unref?.();

    // spawn 本身失败（比如 claude 不在 PATH）走 'error' 事件，不是同步抛异常——
    // Node 的 child_process 文档明确这一点，上面 try/catch 只挡得住参数错误那一类。
    proc.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      // 这是「没装 Claude Code」最常见的现场。**得把另一条路说出来**：设置里
      // 改成「调接口」就不需要这个命令行了，而光看这句报错的人不会知道有这个选项。
      const message = e.code === 'ENOENT'
        ? 'AI 命令行工具没找到，确认 claude 在 PATH 里；或者去设置 → AI 拆解，改成「调接口」'
        : `启动 AI 失败：${e.message}`;
      emitAgentStatus(bus, { state: 'failed', message });
      onSettled?.();
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;

      if (code !== 0) {
        emitAgentStatus(bus, { state: 'failed', message: `AI 进程退出码 ${code}` });
      } else if (bus?.lastStatus === statusAtStart) {
        // 退出码 0 只代表「AI 进程正常退出」，不代表拆解真的合并成功了——写没写
        // outbox 文件、outbox 校验过没过，是 outbox.ts 的 mergeOutbox 自己另外
        // 广播的一条 agent-status，而且时序上几乎总是先到：outbox 文件一落盘，
        // 文件监听器 200ms 去抖就触发了合并；AI 进程自己还要再花几秒收尾、
        // 打印 `--output-format json` 才退出。以前这里退出时无条件覆盖成
        // 「ok / 正在等合并结果」，等于拿一句过时的「正在等」盖掉合并早就发出的
        // 真实结论——合并说 failed，几秒后用户看到的却是绿色的「拆解完成」，
        // 比完全不提示还糟：这是明确地说反话。
        //
        // 现在只在「从我发 running 到这一刻，没有任何别的 agent-status 落地过」
        // 时才补一句——引用比较：只要 mergeOutbox（或别的什么）emit 过，
        // `bus.lastStatus` 就不再是 `statusAtStart` 那个对象了。真的什么都没发生
        // 过，说明 AI 没写出任何 outbox 文件（收件箱本来就没有要拆的，或者
        // AI 自己判断没什么好写的），诚实说清楚，不能用绿色的「完成」。
        emitAgentStatus(bus, { state: 'skipped', message: NOTHING[kind] });
      }
      // 不管上面发没发、发了哪一条：这次运行到此彻底结束了，单飞锁也已经解开
      // （`child = null` 在上面）。这是 autoExpand.ts 用来判断「要不要重新算一次
      // 排期」的唯一可靠信号——`agent-status` 的 ok/failed/skipped 不够：合并
      // 成功时 mergeOutbox 在子进程还没退出、`isRunning()` 还是 true 的时候就
      // 广播了 ok，autoExpand 那时候看到「还在跑」直接放弃评估；等到子进程真的
      // 退出，上面这段逻辑因为「已经有别的状态说过话了」什么都不发，如果没有这个
      // 钩子，运行期间冒出来的新条目就再也没有任何东西触发重新排期，一直卡到
      // 下一次凑巧的收件箱变化。
      onSettled?.();
    });

    return { ok: true };
  }

  return {
    start,
    isRunning: () => child !== null,
    /** autoExpand.ts 用来在「这次运行彻底结束」（正常退出/非零退出/spawn 报错/
     * 超时被杀，四种情况都算）时重新评估要不要排下一次——见上面 'exit' 里的
     * 长注释。只需要最后设置的这一个回调，不用支持多个订阅者。 */
    setOnSettled: (fn: () => void) => { onSettled = fn; },
  };
}
