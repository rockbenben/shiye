import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeOutbox } from './outbox.js';
import { createApp } from './app.js';
import { Bus } from './events.js';
import * as store from './store.js';
import {
  dataDir, ensureDataFiles, newTask, paths, readProposals, readTasks,
  writeProposals, writeTasks, type Proposal, type Task,
} from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-proposals-'));
  process.env.DATA_DIR = dir;
  // 这个文件里的 createApp() 目前都没传 bus，autoExpand 的 evaluate() 因此
  // 不会走到 readSettings()——但这个文件本身不该靠着「没人传 bus」这个隐性
  // 前提才算安全，跟别处一样显式指到临时目录，防的是以后有人在这个文件里
  // 加一条 createApp(bus) 却忘了这茬。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
  ensureDataFiles();
});

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.DEVICE_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

const outboxPath = (name = 'a') => join(dataDir(), `outbox-${name}.json`);
const writeOutbox = (v: unknown, name = 'a') => writeFileSync(outboxPath(name), JSON.stringify(v), 'utf8');

const seedTask = (over: Partial<Task> = {}): Task => {
  const t = newTask({ id: 'task-1', title: '写周报', source: 'ai', ...over });
  writeTasks([...readTasks(), t]);
  return t;
};

const lastStatus = (bus: Bus) => {
  const seen: Array<{ state: string; message?: string }> = [];
  bus.subscribe((e, d) => { if (e === 'agent-status') seen.push(d as { state: string; message?: string }); });
  return () => seen[seen.length - 1];
};

describe('proposals 是第四张常驻表', () => {
  it('ensureDataFiles 会重建它的目录——新 clone 下来第一次读不该炸', () => {
    // proposals 现在是一目录一张表，不是单个文件——删除要带 recursive。
    rmSync(paths().proposals, { recursive: true, force: true });
    expect(existsSync(paths().proposals)).toBe(false);
    ensureDataFiles();
    expect(existsSync(paths().proposals)).toBe(true);
    expect(readProposals()).toEqual([]);
  });
});

describe('outbox 的 updates 条目', () => {
  it('写进 proposals.json，不碰 tasks.json', () => {
    const t = seedTask();
    const before = readTasks();
    writeOutbox([{ updates: [{ id: t.id, patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] }, reason: '过期五天了' }] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toEqual(before);
    const ps = readProposals();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ taskId: t.id, reason: '过期五天了', patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] } });
    // id 由服务端生成，AI 在 outbox 里没写这个字段
    expect(ps[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('跟 tasks 条目可以混在同一个文件里', () => {
    const t = seedTask();
    writeOutbox([
      { inboxId: 'nope', tasks: [{ title: '新任务' }] },
      { updates: [{ id: t.id, patch: { notes: '补一句' }, reason: '原文有提到' }] },
    ]);

    mergeOutbox(new Bus());

    expect(readTasks().map((x) => x.title)).toContain('新任务');
    expect(readProposals()).toHaveLength(1);
  });

  it('只提了建议、没拆出新任务时，横幅不能说「没有新增任务」', () => {
    const t = seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    writeOutbox([{ updates: [{ id: t.id, patch: { notes: 'x' }, reason: '理由' }] }]);

    mergeOutbox(bus);

    expect(last()?.state).toBe('ok');
    expect(last()?.message).toContain('1 条修改建议');
    expect(last()?.message).not.toContain('没有新增任务');
  });
});

describe('updates 的白名单：不合法就整个文件退回，不悄悄过滤', () => {
  // `expectField` 打在横幅上说得出是哪个字段——不只是 state:'failed'，
  // 不然测试通不过校验的姿势（是否真的挡住了）却抓不住原因说错了指哪个字段
  // 这种问题（I2：五种失败共用一句模板，`due` 那种「字段在白名单里、形状
  // 不对」的失败被说成了假话）。
  const rejected = (patch: unknown, why: string, expectField: string) => {
    it(`拒收 ${why}`, () => {
      const t = seedTask();
      const bus = new Bus();
      const last = lastStatus(bus);
      writeOutbox([{ updates: [{ id: t.id, patch, reason: '理由' }] }]);

      mergeOutbox(bus);

      expect(readProposals()).toEqual([]);
      // 文件原样留着，改好重写一遍就行——跟 status:'later' 同一条路径
      expect(existsSync(outboxPath())).toBe(true);
      expect(last()?.state).toBe('failed');
      expect(last()?.message).toContain(expectField);
    });
  };

  rejected({ status: 'done' }, 'status——完成与否是人的判断', 'status');
  rejected({ order: 3 }, 'order——先做哪个是人的判断', 'order');
  rejected({ source: 'user' }, 'source——改了它等于篡改「这条是谁写的」', 'source');
  rejected({ remindedAt: null }, 'remindedAt——那是服务发完提醒盖的章', 'remindedAt');
  rejected({ aiComment: '改口' }, 'aiComment——拆解当时的记录是历史事实', 'aiComment');
  rejected({}, '空 patch——点了「接受」什么也不会发生', 'patch');
  rejected({ due: '下周三' }, '解析不了的时间', 'due');

  // I2 的原始案例：`due` 就在白名单（PROPOSABLE）里，patch 也不是空对象——
  // 旧版 `sanitizeProposalPatch` 返回裸 null，外面拼出来的横幅却恒定是
  // 「只能改 title/…，而且不能是空对象」，两条理由对这个输入都不成立，
  // AI 照着这句话唯一能做的是把 due 删掉、放弃这条建议。现在 due 的形状
  // 校验交给了 checkTaskPatch，横幅说的应该是真正的原因（ISO 8601 格式）。
  it('due 解析不了时，横幅说的是真正的原因（ISO 8601），不是假称字段不在白名单/patch 是空对象', () => {
    const t = seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    writeOutbox([{ updates: [{ id: t.id, patch: { due: '下周三' }, reason: '理由' }] }]);

    mergeOutbox(bus);

    const message = last()?.message ?? '';
    expect(message).toContain('due');
    expect(message).toContain('ISO');
    expect(message).not.toContain('只能改');       // 旧文案：假称字段不在白名单
    expect(message).not.toContain('不能是空对象');   // 旧文案：假称 patch 是空对象，due 显然不是
  });

  it('缺 reason 也拒收——没有理由他没法判断该不该接受', () => {
    const t = seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    writeOutbox([{ updates: [{ id: t.id, patch: { notes: 'x' }, reason: '  ' }] }]);

    mergeOutbox(bus);

    expect(readProposals()).toEqual([]);
    expect(last()?.message).toContain('reason');
  });

  it('五个白名单字段都放行', () => {
    const t = seedTask();
    writeOutbox([{ updates: [{
      id: t.id,
      patch: { title: '新标题', notes: '新备注', due: '2026-09-01T00:00:00.000Z', startAt: null, reminders: [], subtasks: [{ text: '一步', done: false }] },
      reason: '理由',
    }] }]);

    mergeOutbox(new Bus());

    expect(readProposals()).toHaveLength(1);
  });
});

describe('updates 的去重与容错', () => {
  it('taskId 找不到就丢弃这条建议，不算校验失败', () => {
    seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    writeOutbox([{ updates: [{ id: '这条任务他已经删了', patch: { notes: 'x' }, reason: '理由' }] }]);

    mergeOutbox(bus);

    expect(readProposals()).toEqual([]);
    // 不是校验失败：文件被正常删掉，不会原样留在 data/ 里反复重试
    expect(existsSync(outboxPath())).toBe(false);
    expect(last()?.state).not.toBe('failed');
  });

  // updates 没有 tasks 那道「id 已存在就丢弃」的防线——提议的 id 是合并时现生成的。
  it('内容一字不差的重复不再入库一次', () => {
    const t = seedTask();
    const entry = { updates: [{ id: t.id, patch: { notes: '补一句' }, reason: '同一个理由' }] };

    writeOutbox([entry], 'a');
    mergeOutbox(new Bus());
    expect(readProposals()).toHaveLength(1);

    writeOutbox([entry], 'b');
    mergeOutbox(new Bus());
    expect(readProposals()).toHaveLength(1);
  });

  it('同一条任务上理由不同的两条建议都留着——不替他合并掉一条他还没看过的意见', () => {
    const t = seedTask();
    writeOutbox([{ updates: [
      { id: t.id, patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] }, reason: '在等外部回复' },
      { id: t.id, patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] }, reason: '这周排不下' },
    ] }]);

    mergeOutbox(new Bus());

    expect(readProposals()).toHaveLength(2);
  });
});

describe('接受 / 忽略', () => {
  const app = () => createApp();
  const proposal = (over: Partial<Proposal> = {}): Proposal => {
    const p: Proposal = {
      id: 'p-1', taskId: 'task-1', patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] },
      reason: '过期五天了', createdAt: '2026-08-12T00:00:00.000Z', ...over,
    };
    writeProposals([...readProposals(), p]);
    return p;
  };

  // 规格里最要命的一条：只复用校验器、不复用 PATCH 的业务逻辑的话，接受一条
  // 改期建议 = 悄悄取消那个提醒，永远不会响，界面上没有任何东西会告诉你。
  it('接受一条改期建议会把已经提醒过的章清掉', async () => {
    seedTask({ reminders: [{ at: '2026-08-10T01:00:00.000Z', firedAt: '2026-08-10T01:00:05.000Z' }] });
    proposal();

    const res = await app().request('/api/proposals/p-1/accept', { method: 'POST' });

    expect(res.status).toBe(200);
    const t = readTasks()[0];
    expect(t.reminders[0].at).toBe('2026-08-20T01:00:00.000Z');
    expect(t.reminders[0].firedAt).toBeNull();
  });

  /**
   * **接受一条建议之后，该跑的连带一个都不能少。**
   *
   * 上面那条注释说的「只复用校验器、不复用 PATCH 的业务逻辑」是同一族问题——
   * 那一版补的是提醒的章，而三条连带和「生成下一次」当时一条都没补上。两个
   * 场景实测复现过（真实接口，不是构造）：
   *
   * - `listId` 在 `PROPOSABLE` 里：接受「把父任务移到清单 B」，父任务到了 B、
   *   **子任务还留在 A**，而同一个动作走 PATCH 是会带上子任务的。
   * - `subtasks` 在 `PROPOSABLE` 里、`status` 不在，于是 `applyTaskPatch` 那条
   *   「勾满就自动完成」的守卫（`!('status' in patch)`）必然通过：接受「把子任务
   *   都勾上」，一条**每周重复**的任务就地变成 done、盖了 completedAt，**下一次
   *   没有生成**——重复链断在这儿，界面上没有任何提示。
   */
  it('接受一条改清单的建议，子任务跟着走（cascadeListToChildren）', async () => {
    seedTask({ id: 'p', listId: 'A' });
    writeTasks([...readTasks(), newTask({ id: 'k', title: '子', listId: 'A', parentId: 'p' })]);
    proposal({ taskId: 'p', patch: { listId: 'B' } });

    await app().request('/api/proposals/p-1/accept', { method: 'POST' });

    const all = readTasks();
    const parent = all.find((t) => t.id === 'p')!;
    const kid = all.find((t) => t.id === 'k')!;
    expect(parent.listId).toBe('B');
    expect(kid.listId, '子任务被落在原清单里了').toBe('B');
  });

  it('接受一条勾满子任务的建议：重复任务要生成下一次，链不能断', async () => {
    seedTask({
      id: 'w', due: '2026-09-04T01:00:00.000Z',
      repeat: { every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
      subtasks: [{ text: 's1', done: false }],
    });
    proposal({ taskId: 'w', patch: { subtasks: [{ text: 's1', done: true }] } });

    await app().request('/api/proposals/p-1/accept', { method: 'POST' });

    const all = readTasks();
    const done = all.find((t) => t.id === 'w')!;
    expect(done.status, '勾满就自动完成，这一步本来就会发生').toBe('done');
    expect(all.length, '没有生成下一次——这条重复链断了').toBe(2);
    expect(all.find((t) => t.id !== 'w')!.status).toBe('todo');
  });

  it('接受之后这条建议就没了', async () => {
    seedTask();
    proposal();

    await app().request('/api/proposals/p-1/accept', { method: 'POST' });

    expect(readProposals()).toEqual([]);
  });

  it('忽略不动任务，而且**留下墓碑**——删掉的话下一轮回顾会把同一条原样再提一遍', async () => {
    const t = seedTask();
    proposal();

    const res = await app().request('/api/proposals/p-1/dismiss', { method: 'PATCH' });

    expect(res.status).toBe(200);
    expect(readTasks()[0]).toEqual(t);
    // 行还在，只是标了 dismissed——outbox 的内容去重靠它认出「这条提过、他不要」
    expect(readProposals()).toHaveLength(1);
    expect(readProposals()[0].dismissed).toBe(true);
  });

  it('被忽略的建议不再吐给界面', async () => {
    seedTask();
    proposal();
    await app().request('/api/proposals/p-1/dismiss', { method: 'PATCH' });

    const res = await app().request('/api/proposals');

    expect(await res.json()).toEqual([]);
  });

  it('忽略过的建议，下一轮回顾原样再提也不会重新出现', async () => {
    const t = seedTask();
    const entry = { updates: [{ id: t.id, patch: { notes: '补一句' }, reason: '同一个理由' }] };

    writeOutbox([entry], 'a');
    mergeOutbox(new Bus());
    const p = readProposals()[0];

    await app().request(`/api/proposals/${p.id}/dismiss`, { method: 'PATCH' });

    writeOutbox([entry], 'b');
    mergeOutbox(new Bus());

    // 还是那一条（已忽略），没有冒出第二条
    expect(readProposals()).toHaveLength(1);
    expect(readProposals()[0].dismissed).toBe(true);
  });

  it('任务在他点「接受」之前被删了：不炸，顺手把这条建议也清掉', async () => {
    proposal({ taskId: '不存在' });

    const res = await app().request('/api/proposals/p-1/accept', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(readProposals()).toEqual([]);
  });

  it('删任务会连带删掉它名下的建议——不然是永远看不见也删不掉的垃圾', async () => {
    const t = seedTask();
    proposal({ id: 'p-1', taskId: t.id });
    proposal({ id: 'p-2', taskId: '别人的' });

    await app().request(`/api/tasks/${t.id}`, { method: 'DELETE' });

    expect(readProposals().map((p) => p.id)).toEqual(['p-2']);
  });

  it('GET /api/proposals 读得到', async () => {
    seedTask();
    proposal();

    const res = await app().request('/api/proposals');

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});

/**
 * 真实事故留下的回归测试：做界面审查时另起一个 `DATA_DIR=<临时目录>` 的实例，
 * 它看见夹具收件箱里有待拆解条目、排了一次自动拆解，spawn 出去的 AI 却对着
 * **真实**的收件箱跑了一遍——`claude -p` 的 cwd 钉死在仓库根目录，AGENTS.md
 * 里又全是 `data/inbox.json` 这样的相对路径。那次它判断「没什么要拆的」、
 * 一个字节没写，纯属运气好。
 */
describe('DATA_DIR 指到别处时，不许真的 spawn AI', () => {
  it('用默认 spawner + 非默认数据目录 → 拒绝，并说清为什么', async () => {
    // 这个 describe 跑在外层 beforeEach 里，DATA_DIR 已经是临时目录了
    const { createAgentRunner } = await import('./expand.js');
    const runner = createAgentRunner();   // 不注入 spawner = 用真的 spawn

    const r = runner.start();

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('DATA_DIR');
    expect(!r.ok && r.error).toContain('不是同一份数据');
  });

  it('注入了假 spawner 就不拦——它不读磁盘，而所有服务端测试都把 DATA_DIR 指到临时目录', async () => {
    const { createAgentRunner } = await import('./expand.js');
    const fake = () => ({ on: () => {}, kill: () => {} }) as never;
    const runner = createAgentRunner(undefined, fake);

    expect(runner.start().ok).toBe(true);
  });
});

describe('评审查出来的三处静默丢数据', () => {
  it('一个条目同时写了 tasks 和 updates：整批退回，不能只处理一半', () => {
    const t = seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    // AGENTS.md 说「两种可以混在同一个文件里」，容易被读成「一个条目里塞两个键」
    writeOutbox([{
      inboxId: 'i-1',
      tasks: [{ title: '不能被丢掉的任务' }],
      updates: [{ id: t.id, patch: { notes: 'x' }, reason: '理由' }],
    }]);

    mergeOutbox(bus);

    // 改之前：tasks 和 inboxId 被静默丢弃，文件照样删掉，人只看到「提了 1 条建议」
    expect(readTasks().map((x) => x.title)).not.toContain('不能被丢掉的任务');
    expect(readProposals()).toEqual([]);
    expect(existsSync(outboxPath())).toBe(true);          // 原样留着，能改了重来
    expect(last()?.state).toBe('failed');
    expect(last()?.message).toContain('同时写了 tasks 和 updates');
  });

  it('只有 updates 的合并不碰 inbox——没有 inboxId 要标记时不该有一次空转的写', () => {
    // inbox 现在是一目录一张表，写入不再产生 .bak（历史版本交给同步服务，
    // 见 entityStore.ts 的注释）。「不碰 inbox」这件事换成直接数 writeInbox
    // 被调用几次——比 .bak 有没有被烧掉更直接。
    const t = seedTask();
    const writeInboxSpy = vi.spyOn(store, 'writeInbox');
    writeInboxSpy.mockClear();

    writeOutbox([{ updates: [{ id: t.id, patch: { notes: 'x' }, reason: '理由' }] }]);
    mergeOutbox(new Bus());

    expect(readProposals()).toHaveLength(1);
    // 没有 inboxId 要标记（这个文件里只有 updates，没有 tasks 条目），
    // writeInbox 就不该被调用。
    expect(writeInboxSpy).not.toHaveBeenCalled();
    writeInboxSpy.mockRestore();
  });

  it('指向已删除任务而被丢弃的建议要进横幅，不能只进日志', () => {
    seedTask();
    const bus = new Bus();
    const last = lastStatus(bus);
    writeOutbox([{ updates: [{ id: '他已经删了这条', patch: { notes: 'x' }, reason: '理由' }] }]);

    mergeOutbox(bus);

    expect(last()?.message).toContain('指向已经不存在的任务');
  });
});

describe('接受路径的信任边界', () => {
  it('磁盘上的 patch 也要过白名单——手改过的 proposals.json 不能改掉任务的 id', async () => {
    const t = seedTask();
    writeProposals([{
      id: 'p-bad', taskId: t.id,
      patch: { id: '换个 id', status: 'later' } as never,
      reason: '手改进去的', createdAt: '2026-08-12T00:00:00.000Z',
    }]);

    const res = await createApp().request('/api/proposals/p-bad/accept', { method: 'POST' });

    expect(res.status).toBe(422);
    expect(readTasks()[0].id).toBe(t.id);        // id 没被换
    expect(readTasks()[0].status).toBe('todo');  // status 没被改
    expect(readProposals()).toEqual([]);         // 坏行丢掉，不会一直卡在那儿
  });
});
