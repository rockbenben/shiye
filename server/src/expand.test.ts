import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createAgentRunner, parseCustomArgs, resolveCliInvocation, type Spawner } from './expand.js';
import { Bus } from './events.js';
import { aiSeesSameData, newTask, writeSettings, writeTasks } from './store.js';
import { DEFAULT_SETTINGS } from './model.js';

/** 假子进程：只实现测试用得到的三样——'error'/'exit' 事件和 kill()。 */
function fakeProc(): ChildProcess & { emitExit: (code: number) => void } {
  const e = new EventEmitter() as unknown as ChildProcess & { emitExit: (code: number) => void };
  e.kill = vi.fn() as unknown as ChildProcess['kill'];
  e.emitExit = (code: number) => e.emit('exit', code);
  return e;
}

const statusEvents = (bus: Bus) => {
  const seen: unknown[] = [];
  bus.subscribe((event, d) => { if (event === 'agent-status') seen.push(d); });
  return seen;
};

describe('createAgentRunner：单飞', () => {
  it('跑着的时候再 start 一次，回不 ok，不再 spawn 第二个进程', () => {
    const proc = fakeProc();
    const spawnFn: Spawner = vi.fn(() => proc);
    const runner = createAgentRunner(undefined, spawnFn);

    expect(runner.start()).toEqual({ ok: true });
    expect(runner.isRunning()).toBe(true);

    const second = runner.start();
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toMatch(/还在跑/);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('进程退出之后单飞锁解开，能再 start 一次', () => {
    const proc = fakeProc();
    const spawnFn: Spawner = vi.fn(() => proc);
    const runner = createAgentRunner(undefined, spawnFn);

    runner.start();
    proc.emitExit(0);
    expect(runner.isRunning()).toBe(false);
    expect(runner.start()).toEqual({ ok: true });
  });
});

describe('createAgentRunner：状态广播', () => {
  it('start 广播 running', () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => proc);

    runner.start();
    expect(seen[0]).toEqual({ state: 'running', kind: 'expand' });
  });

  // 时序是固定的：AI 把 outbox 文件写完之后还要花几秒生成收尾文字、打印
  // `--output-format json` 才真的退出；文件监听器的去抖只有 200ms。所以真实
  // 运行里，合并（mergeOutbox 发的 agent-status）几乎总是先于子进程的 'exit'
  // 事件到达。退出处理器如果无条件发一句自己的结论，就会用一句过时的话盖掉
  // 合并早就给出的真实结论——这三条测试锁死「谁先说话谁算数，退出处理器只在
  // 没人说过话的时候才补一句」这条规则。
  describe('退出码 0：不能让退出处理器的话盖掉合并已经给出的真实结论', () => {
    it('合并已经先广播过 failed —— 退出处理器不再发 ok，最终状态还是那条 failed', () => {
      const proc = fakeProc();
      const bus = new Bus();
      const seen = statusEvents(bus);
      const runner = createAgentRunner(bus, () => proc);

      runner.start();
      // 模拟真实时序：outbox 文件早合并完了，子进程几秒后才退出。
      bus.emit('agent-status', { state: 'failed', message: 'outbox-a.json 第 1 项没通过校验' });
      proc.emitExit(0);

      const last = seen[seen.length - 1] as { state: string; message: string };
      expect(last.state).toBe('failed');
      expect(last.message).toBe('outbox-a.json 第 1 项没通过校验');
    });

    it('合并已经先广播过 ok（带数量）—— 退出处理器不再用「正在等合并结果」覆盖它', () => {
      const proc = fakeProc();
      const bus = new Bus();
      const seen = statusEvents(bus);
      const runner = createAgentRunner(bus, () => proc);

      runner.start();
      bus.emit('agent-status', { state: 'ok', message: '拆解完成，新增 2 个任务' });
      proc.emitExit(0);

      const last = seen[seen.length - 1] as { state: string; message: string };
      expect(last.state).toBe('ok');
      expect(last.message).toBe('拆解完成，新增 2 个任务');
    });

    it('期间没有任何合并发生（AI 什么都没写出来）—— 诚实说清楚，不能是绿色的「已经跑完」', () => {
      const proc = fakeProc();
      const bus = new Bus();
      const seen = statusEvents(bus);
      const runner = createAgentRunner(bus, () => proc);

      runner.start();
      proc.emitExit(0);   // 中间没有任何 bus.emit('agent-status', ...)

      const last = seen[seen.length - 1] as { state: string; message: string };
      expect(last.state).toBe('skipped');
      expect(last.message).toContain('没有写出任何拆解结果');
    });
  });

  it('退出码非零广播 failed，带退出码', () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => proc);

    runner.start();
    proc.emitExit(1);

    const last = seen[seen.length - 1] as { state: string; message: string };
    expect(last.state).toBe('failed');
    expect(last.message).toContain('1');
  });

  it('spawn 报 ENOENT —— 用中文说清楚，不是原样甩 Node 的错误', () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => proc);

    runner.start();
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    proc.emit('error', err);

    const last = seen[seen.length - 1] as { state: string; message: string };
    expect(last.state).toBe('failed');
    expect(last.message).toContain('PATH');
    expect(runner.isRunning()).toBe(false);
  });

  it('同步 spawn 抛异常（比如参数错误）也报 failed，不让异常往上冒', () => {
    const bus = new Bus();
    const seen = statusEvents(bus);
    const spawnFn: Spawner = () => { throw new Error('坏掉了'); };
    const runner = createAgentRunner(bus, spawnFn);

    const result = runner.start();

    expect(result.ok).toBe(false);
    expect((seen[seen.length - 1] as { state: string }).state).toBe('failed');
    expect(runner.isRunning()).toBe(false);
  });

  it('超时会杀掉进程并广播 failed，之后单飞锁解开', async () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => proc, 10);   // 10ms 超时，测试用

    runner.start();
    await new Promise((r) => setTimeout(r, 40));

    expect(proc.kill).toHaveBeenCalled();
    const last = seen[seen.length - 1] as { state: string; message: string };
    expect(last.state).toBe('failed');
    expect(last.message).toMatch(/超时|10 分钟/);
    expect(runner.isRunning()).toBe(false);
  });
});

describe('AI 和服务必须看同一个目录', () => {
  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.AGENT_CWD;
  });

  it('两边指向同一个目录时放行——哪怕它不是仓库自带的 data/', () => {
    process.env.DATA_DIR = '/tmp/某个同步盘/data';
    process.env.AGENT_CWD = '/tmp/某个同步盘';
    expect(aiSeesSameData()).toBe(true);
  });

  it('两边不一致时拦下', () => {
    process.env.DATA_DIR = '/tmp/甲/data';
    process.env.AGENT_CWD = '/tmp/乙';
    expect(aiSeesSameData()).toBe(false);
  });

  it('都不设时用默认值，两边天然一致', () => {
    delete process.env.DATA_DIR;
    delete process.env.AGENT_CWD;
    expect(aiSeesSameData()).toBe(true);
  });

  it('路径写法不同但指向同一处也算一致（. 和 .. 要先解析）', () => {
    process.env.DATA_DIR = '/tmp/x/./data';
    process.env.AGENT_CWD = '/tmp/x/y/..';
    expect(aiSeesSameData()).toBe(true);
  });
});

/**
 * 设置里选了「调接口」之后，`start()` 走的是 `aiApi.ts` 那条路。
 *
 * 这一组只管**接线**：单飞锁是不是同一把、状态发得对不对、超时会不会中止请求。
 * 请求本身怎么发、JSON 怎么抠，在 `aiApi.test.ts`。
 */
describe('createAgentRunner：设置成「调接口」时走 HTTP，不 spawn 进程', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'expand-api-'));
    process.env.DATA_DIR = join(dir, 'data');
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: 'm' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
  });

  /** 回一个「模型说了这段话」的 OpenAI 兼容响应。 */
  const replying = (content: string): typeof fetch => vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

  const settle = () => new Promise((r) => setImmediate(r));

  it('一个子进程都不起——这条路压根不需要命令行工具', async () => {
    const spawnFn: Spawner = vi.fn(() => fakeProc());
    const runner = createAgentRunner(undefined, spawnFn, 1000, replying('[]'));

    expect(runner.start()).toEqual({ ok: true });
    await settle();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  /**
   * 两条路读写的是同一份 `data/`、同一批 outbox 文件，各锁各的等于没锁——
   * 所以这里验的是「HTTP 那次没结束时，第二次 start 照样被同一把锁挡下」。
   */
  it('单飞锁是同一把：HTTP 还没回来时再 start 一次会被挡下', () => {
    // 永远不 resolve 的 fetch：模拟请求还在路上。
    const hanging = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const runner = createAgentRunner(undefined, () => fakeProc(), 1000, hanging);

    expect(runner.start()).toEqual({ ok: true });
    expect(runner.isRunning()).toBe(true);
    const second = runner.start('review');
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toMatch(/上一次拆解还在跑/);
  });

  it('地址或模型没填就明确说缺哪一格，不把空 model 打出去', () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: '' });
    const f = vi.fn() as unknown as typeof fetch;
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => fakeProc(), 1000, f);

    const r = runner.start();
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/模型名还没填/);
    expect(f).not.toHaveBeenCalled();
    expect(seen).toEqual([{ state: 'failed', kind: 'expand', message: expect.stringMatching(/模型名还没填/) }]);
  });

  /**
   * 写出 outbox 文件之后**一个字都不发**：合并结果是 mergeOutbox 自己广播的，
   * 这里补一句「完成了」就是拿过时的话盖掉真实结论——跟 CLI 那条路退出时的
   * 规矩一模一样。
   */
  it('写出了 outbox 文件：只有 running，没有第二条状态', async () => {
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => fakeProc(), 1000, replying('[{"inboxId":"a","tasks":[]}]'));

    runner.start();
    await settle();
    expect(seen).toEqual([{ state: 'running', kind: 'expand' }]);
    expect(runner.isRunning()).toBe(false);
  });

  /** 空数组 = 模型明确说没什么可产出。不是失败，不该标红。 */
  it('模型回空数组：补一条 skipped，不是 failed', async () => {
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => fakeProc(), 1000, replying('[]'));

    runner.start();
    await settle();
    expect(seen).toEqual([
      { state: 'running', kind: 'expand' },
      { state: 'skipped', kind: 'expand', message: expect.stringMatching(/没有写出任何拆解结果/) },
    ]);
  });

  it('接口报错：failed，而且带上接口自己那句话', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => fakeProc(), 1000, f);

    runner.start();
    await settle();
    expect(seen[1]).toEqual({ state: 'failed', kind: 'expand', message: expect.stringMatching(/拆解失败.*Incorrect API key/) });
    expect(runner.isRunning()).toBe(false);
  });

  it('超时：中止请求、报 failed、解开单飞锁', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const hanging = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); });
      })) as unknown as typeof fetch;
      const bus = new Bus();
      const seen = statusEvents(bus);
      const runner = createAgentRunner(bus, () => fakeProc(), 1000, hanging);

      runner.start();
      await vi.advanceTimersByTimeAsync(1001);
      expect(aborted).toBe(true);
      expect(seen[1]).toEqual({ state: 'failed', kind: 'expand', message: expect.stringMatching(/超过 10 分钟没结束/) });
      expect(runner.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** 超时那条已经发过 failed 了，随后 fetch 的 reject 不能再发第二条。 */
  it('超时之后请求的失败不再重复报一遍', async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
      const bus = new Bus();
      const seen = statusEvents(bus);
      createAgentRunner(bus, () => fakeProc(), 1000, hanging).start();

      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('回顾走的也是这条路，报错里说的是「回顾」不是「拆解」', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const bus = new Bus();
    const seen = statusEvents(bus);
    createAgentRunner(bus, () => fakeProc(), 1000, f).start('review');
    await settle();
    expect(seen[1]).toEqual({ state: 'failed', kind: 'review', message: expect.stringMatching(/^回顾失败/) });
  });

  it('设置改回 cli 就还是起子进程——这一格是每次 start 现读的，不是启动时定死的', () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'cli' });
    const spawnFn: Spawner = vi.fn(() => fakeProc());
    const runner = createAgentRunner(undefined, spawnFn, 1000, replying('[]'));
    runner.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe('parseCustomArgs：解析自定义 CLI 参数模板', () => {
  it('模板为空：默认返回 -p <prompt>', () => {
    expect(parseCustomArgs('', '提示词')).toEqual(['-p', '提示词']);
    expect(parseCustomArgs('   ', '提示词')).toEqual(['-p', '提示词']);
  });

  it('模板包含 {prompt}：正确替换并保留其它参数', () => {
    expect(parseCustomArgs('-p "{prompt}" --dangerously-skip-permissions', '请拆解')).toEqual([
      '-p', '请拆解', '--dangerously-skip-permissions',
    ]);
    expect(parseCustomArgs('--prompt="{prompt}"', '测试')).toEqual(['--prompt=测试']);
  });

  it('模板不包含 {prompt}：在末尾追加提示词', () => {
    expect(parseCustomArgs('--execute --yes', '提示词')).toEqual(['--execute', '--yes', '提示词']);
  });
});

describe('resolveCliInvocation：按设置解析 CLI 命令与参数', () => {
  const origEnv = process.env;
  beforeEach(() => { process.env = { ...origEnv }; });
  afterEach(() => { process.env = origEnv; });

  it('默认或 claude：使用 claude 及 Claude Code 参数', () => {
    delete process.env.CLAUDE_CLI;
    const inv = resolveCliInvocation({ aiCli: 'claude' }, '测试提示词');
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual([
      '-p', '测试提示词',
      '--allowedTools', 'Read,Edit,Write,Bash',
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
    ]);
  });

  it('claude 支持 CLAUDE_CLI 环境变量与自定义路径覆盖', () => {
    process.env.CLAUDE_CLI = '/custom/claude';
    expect(resolveCliInvocation({ aiCli: 'claude' }, 'x').command).toBe('/custom/claude');

    delete process.env.CLAUDE_CLI;
    expect(resolveCliInvocation({ aiCli: 'claude', aiCliPath: 'D:\\claude.cmd' }, 'x').command).toBe('D:\\claude.cmd');
  });

  it('agy：使用 agy 及对应参数', () => {
    delete process.env.AGY_CLI;
    const inv = resolveCliInvocation({ aiCli: 'agy' }, '测试提示词');
    expect(inv.command).toBe('agy');
    expect(inv.args).toEqual(['-p', '测试提示词', '--mode', 'accept-edits', '--dangerously-skip-permissions']);
  });

  it('agy 支持 AGY_CLI 环境变量与自定义路径覆盖', () => {
    process.env.AGY_CLI = '/opt/bin/agy';
    expect(resolveCliInvocation({ aiCli: 'agy' }, 'x').command).toBe('/opt/bin/agy');

    delete process.env.AGY_CLI;
    expect(resolveCliInvocation({ aiCli: 'agy', aiCliPath: 'C:\\agy\\agy.exe' }, 'x').command).toBe('C:\\agy\\agy.exe');
  });

  it('codex：使用 codex 及对应参数，支持 CODEX_CLI 与路径覆盖', () => {
    delete process.env.CODEX_CLI;
    const inv = resolveCliInvocation({ aiCli: 'codex' }, '测试提示词');
    expect(inv.command).toBe('codex');
    expect(inv.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '测试提示词']);

    process.env.CODEX_CLI = '/usr/bin/codex';
    expect(resolveCliInvocation({ aiCli: 'codex' }, 'x').command).toBe('/usr/bin/codex');
  });

  it('gemini：使用 gemini 及对应参数，支持 GEMINI_CLI 与路径覆盖', () => {
    delete process.env.GEMINI_CLI;
    const inv = resolveCliInvocation({ aiCli: 'gemini' }, '测试提示词');
    expect(inv.command).toBe('gemini');
    expect(inv.args).toEqual(['-p', '测试提示词', '-y']);

    process.env.GEMINI_CLI = 'gemini.cmd';
    expect(resolveCliInvocation({ aiCli: 'gemini' }, 'x').command).toBe('gemini.cmd');
  });

  it('aider：使用 aider 及对应参数，支持 AIDER_CLI 与路径覆盖', () => {
    delete process.env.AIDER_CLI;
    const inv = resolveCliInvocation({ aiCli: 'aider' }, '测试提示词');
    expect(inv.command).toBe('aider');
    expect(inv.args).toEqual(['--message', '测试提示词', '--yes-always']);

    process.env.AIDER_CLI = '/opt/aider';
    expect(resolveCliInvocation({ aiCli: 'aider' }, 'x').command).toBe('/opt/aider');
  });

  it('custom：使用自定义路径与参数模板', () => {
    const inv = resolveCliInvocation({
      aiCli: 'custom',
      aiCliPath: 'my-agent',
      aiCliCustomArgs: '--run "{prompt}" --auto',
    }, '测试提示词');
    expect(inv.command).toBe('my-agent');
    expect(inv.args).toEqual(['--run', '测试提示词', '--auto']);
  });
});

describe('createAgentRunner：支持多款 CLI', () => {
  it('设置设为 agy 时，spawn 传入 agy 命令与对应参数', () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'cli', aiCli: 'agy' });
    const proc = fakeProc();
    const spawnFn: Spawner = vi.fn(() => proc);
    const runner = createAgentRunner(undefined, spawnFn);

    runner.start();
    expect(spawnFn).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining(['-p', expect.stringContaining('AGENTS.md'), '--mode', 'accept-edits', '--dangerously-skip-permissions']),
      expect.anything(),
    );
  });

  it('agy 工具未找到（ENOENT）时错误信息提示 agy', () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'cli', aiCli: 'agy' });
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    const runner = createAgentRunner(bus, () => proc);

    runner.start();
    const err = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    proc.emit('error', err);

    const last = seen[seen.length - 1] as { state: string; message: string };
    expect(last.state).toBe('failed');
    expect(last.message).toContain('确认 agy 在 PATH 里');
  });

  it('设置设为 custom 时，spawn 传入自定义可执行文件与模板参数', () => {
    writeSettings({
      ...DEFAULT_SETTINGS,
      aiMode: 'cli',
      aiCli: 'custom',
      aiCliPath: 'my-agent.cmd',
      aiCliCustomArgs: '-m "{prompt}" --force',
    });
    const proc = fakeProc();
    const spawnFn: Spawner = vi.fn(() => proc);
    const runner = createAgentRunner(undefined, spawnFn);

    runner.start();
    expect(spawnFn).toHaveBeenCalledWith(
      'my-agent.cmd',
      ['-m', expect.stringContaining('AGENTS.md'), '--force'],
      expect.anything(),
    );
  });

  it('设置设为 codex 时，spawn 传入 codex 命令与对应 exec 参数', () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'cli', aiCli: 'codex' });
    const proc = fakeProc();
    const spawnFn: Spawner = vi.fn(() => proc);
    const runner = createAgentRunner(undefined, spawnFn);

    runner.start();
    expect(spawnFn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--dangerously-bypass-approvals-and-sandbox', expect.stringContaining('AGENTS.md')],
      expect.anything(),
    );
  });
});




/**
 * **「让 AI 拆细这一条」**——四件事里的第四件，也是唯一**必须带范围**的那一件。
 *
 * 这一族只管接线：范围那句话进没进提示词、状态里的 `kind` 和措辞对不对。
 * 提示词里到底带了哪些数据、不带哪些，在 `aiApi.test.ts` 的「拆细带范围」那组。
 */
describe('createAgentRunner：拆细', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'expand-breakdown-'));
    process.env.DATA_DIR = join(dir, 'data');
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'cli' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
  });

  /** spawn 那次调用的第二个 argv 就是提示词（claude 那条路的 `-p <prompt>`）。 */
  const promptOf = (spawnFn: Spawner): string =>
    (spawnFn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls[0][1][1];

  /**
   * **不带范围的话，`PROMPT.breakdown` 只是一句空话**——「把指定的那一条任务
   * 拆细」，而「指定的」是哪一条全靠 `scopeLine` 接在后面。这条钉的就是那一句
   * 真的接上了：少了它，模型拿到的是一个没有宾语的指令。
   */
  it('提示词里接着「只处理这一条」那句话', () => {
    const spawnFn: Spawner = vi.fn(() => fakeProc());
    createAgentRunner(undefined, spawnFn).start('breakdown', { taskId: 't1', taskTitle: '装修' });
    const prompt = promptOf(spawnFn);
    expect(prompt).toContain('把指定的那一条任务拆细');
    expect(prompt).toContain('任务「装修」');
    expect(prompt).toContain('t1');
  });

  /**
   * **没带范围时在起进程之前就拒绝。** 不拦的话两边都是坏的：CLI 这条路白起一个
   * 进程烧一次额度，跑的还是「把指定的那一条任务拆细」这句没有宾语的指令；
   * 接口那条路更糟——它拿回一句「没有拆细建议」，而他读到的是「这条可能已经
   * 够具体了」，实际是压根没说是哪一条。
   *
   * **两个入口都要拦**：「压根不给」是显然的那种，「给了一个清单范围」才是
   * 容易漏的那种——形状不对但类型过得去（`AgentScope` 是联合），递进来之后
   * `scopeLine` 会说出一句「这次只处理清单『工作』」，而拆细压根不认清单。
   * 路由那一层已经拦了（缺 `taskId` 就 400），这里是第二道。
   *
   * 还钉住「拒绝发生在 emit 之前」：先发 `running` 再拒绝的话，屏幕上会闪一条
   * 假的「AI 拆细中……」。
   */
  it('不带范围（或者给的是清单范围）时直接拒绝，一个进程都不起', () => {
    for (const scope of [undefined, { listId: 'l1', listName: '工作' }] as const) {
      const bus = new Bus();
      const seen = statusEvents(bus);
      const spawnFn: Spawner = vi.fn(() => fakeProc());
      const r = createAgentRunner(bus, spawnFn).start('breakdown', scope);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/指名是哪一条任务/);
      expect(spawnFn).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    }
  });

  /**
   * 跑完什么都没写出来时该说的是「没有拆细建议（这条可能已经够具体了）」，
   * 不是通用的「没有新增任务」——后者会让他以为是自己点错了按钮。
   */
  it('跑完什么都没写出来：说「没有提出拆细建议」，不是「没有新增任务」', () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    createAgentRunner(bus, () => proc).start('breakdown', { taskId: 't1', taskTitle: '装修' });
    proc.emitExit(0);
    expect(seen[1]).toEqual({
      state: 'skipped', kind: 'breakdown',
      message: expect.stringMatching(/没有提出拆细建议/),
    });
  });

  /** 状态里的 `kind` 决定界面上横幅叫什么——写错了就是「拆解失败」顶着拆细的事。 */
  it('状态里带的是 kind: breakdown', () => {
    const proc = fakeProc();
    const bus = new Bus();
    const seen = statusEvents(bus);
    createAgentRunner(bus, () => proc).start('breakdown', { taskId: 't1', taskTitle: '装修' });
    expect(seen[0]).toEqual({ state: 'running', kind: 'breakdown' });
    proc.emitExit(1);
    expect(seen[1]).toMatchObject({ state: 'failed', kind: 'breakdown' });
  });

  /** 四件事读写的是同一份 `data/`、同一批 outbox 文件，各锁各的等于没锁。 */
  it('跟别的三件事共用同一把单飞锁，而且报得出「正在跑的是哪一件」', () => {
    const runner = createAgentRunner(undefined, () => fakeProc());
    runner.start('breakdown', { taskId: 't1', taskTitle: '装修' });
    const second = runner.start('review');
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toMatch(/上一次拆细还在跑/);
  });

  /** 接口那条路：照样把范围带进 `buildMessages`，而且一个子进程都不起。 */
  it('接口模式：范围照样进提示词，不 spawn 进程', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: 'm' });
    writeTasks([{ ...newTask({ title: '装修' }), id: 't1' }]);
    const spawnFn: Spawner = vi.fn(() => fakeProc());
    const bodies: string[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const bus = new Bus();
    const seen = statusEvents(bus);

    createAgentRunner(bus, spawnFn, 1000, f).start('breakdown', { taskId: 't1', taskTitle: '装修' });
    await new Promise((r) => setImmediate(r));

    expect(spawnFn).not.toHaveBeenCalled();
    expect(bodies[0]).toContain('这次只处理任务');
    expect(bodies[0]).toContain('装修');
    expect(seen[1]).toEqual({
      state: 'skipped', kind: 'breakdown',
      message: expect.stringMatching(/没有提出拆细建议/),
    });
  });
});
