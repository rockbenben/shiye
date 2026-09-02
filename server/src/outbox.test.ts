import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeOutbox } from './outbox.js';
import { Bus } from './events.js';
import {
  dataDir, ensureDataFiles, newTask, outboxFiles, paths, readInbox, readInsights, readTasks,
  writeInbox, writeTasks, type InboxItem,
} from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-outbox-'));
  process.env.DATA_DIR = dir;
  ensureDataFiles();
});

afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const inboxItem = (over: Partial<InboxItem> = {}): InboxItem =>
  ({ id: 'inbox-1', text: '随手记的', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...over });

const rawTask = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'ai', aiComment: '拆自收件箱',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...over,
});

/** name 只是文件名里 `outbox-` 后面那截，不带路径不带扩展名——凑的是新约定
 * `data/outbox-<unique>.json`，`writeOutbox()` 不传就用默认名，多份并存时自己传不同的。 */
const outboxPath = (name = 'a') => join(dataDir(), `outbox-${name}.json`);
const writeOutbox = (v: unknown, name = 'a') => writeFileSync(outboxPath(name), JSON.stringify(v), 'utf8');

const statusEvents = (bus: Bus) => {
  const seen: unknown[] = [];
  bus.subscribe((e, d) => { if (e === 'agent-status') seen.push(d); });
  return seen;
};

describe('mergeOutbox：成功合并', () => {
  it('把 tasks 追加进 tasks.json，把对应 inbox 条目标成 processed 并回填 taskIds', () => {
    writeInbox([inboxItem()]);
    writeTasks([newTask({ title: '已经有的任务' })]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'new-1' }), rawTask({ id: 'new-2', title: '第二条' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    const tasks = readTasks();
    expect(tasks.map((t) => t.title)).toEqual(['已经有的任务', '写周报', '第二条']);

    const inbox = readInbox();
    expect(inbox[0].processed).toBe(true);
    expect(inbox[0].taskIds).toEqual(['new-1', 'new-2']);

    expect(existsSync(outboxPath())).toBe(false);
    expect(seen).toEqual([{ state: 'ok', message: '拆解完成，新增 2 个任务' }]);
  });

  it('缺 id/createdAt/updatedAt 就照 newTask 的默认值补——不算校验失败', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [{ title: '没给 id 的任务', status: 'todo', source: 'ai' }] }]);

    mergeOutbox(new Bus());

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tasks[0].title).toBe('没给 id 的任务');
  });
});

describe('mergeOutbox：校验不过', () => {
  it('某个任务标题为空 —— 整批不合并，文件原样留着，tasks.json 一个字节不动', () => {
    writeInbox([inboxItem()]);
    writeTasks([newTask({ title: '已经有的任务' })]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask(), rawTask({ id: 'bad', title: '' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks().map((t) => t.title)).toEqual(['已经有的任务']);   // 一个新任务都没进来
    expect(readInbox()[0].processed).toBe(false);
    expect(existsSync(outboxPath())).toBe(true);   // 文件还在
    expect(seen).toHaveLength(1);
    expect((seen[0] as { state: string }).state).toBe('failed');
  });

  it('某个任务 status 不是三选一之一 —— 同样整批拒绝', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ status: 'pending' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toEqual([]);
    expect(existsSync(outboxPath())).toBe(true);
  });

  it('横幅点名是哪个字段、为什么，定位信息（第几项第几个任务）没丢，别报成不相干的原因', () => {
    writeInbox([inboxItem()]);
    // status 写错（不是 'later'——那条走 mergeOneFile 里另一个特判分支，见下面
    // 「order/later 是人的字段」那个 describe）。
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ status: 'pending' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    const message = (seen[0] as { message: string }).message;
    expect(message).toContain('status');
    expect(message).toContain('todo');            // 原因里列出了合法值
    expect(message).toContain('第 1 项第 1 个任务');   // 定位信息没丢
    expect(message).not.toContain('不能缺');         // 别报成不相干的原因（title 缺失走的是另一条 bad('title', ...)）
  });

  // I3：task.ts 里共用的 status 文案「要是 todo / doing / done / later 之一」
  // 对 PATCH /api/tasks/:id（人经网页发起的写）是对的，但 outbox 这条路的
  // 读者是 AI，AGENTS.md 明写 AI 只能写 todo——把 later 列成选项等于诱导 AI
  // 去写一个会被另一条特判（见下面「order/later 是人的字段」）单独拒收的值，
  // 1/3 概率再退回一次。这里确认 outbox 横幅换成了 outbox 语境的版本。
  it('status 校验失败的横幅不把 later 列成选项——AI 写了 later 会被另一条特判单独拒收，不该被这句话诱导', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ status: 'pending' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    const message = (seen[0] as { message: string }).message;
    expect(message).toContain('todo');
    // 不是「later 不能出现」——解释「为什么不能写 later」本来就得提到这个词。
    // 真正要挡住的是旧文案那种把 later 摆进四选一、暗示它是个能选的合法值
    // 的枚举句式；新文案提到 later 时要点明它会被拒收，不是同一个句式。
    expect(message).not.toContain('doing / done / later 之一');
    expect(message).toContain('单独拒收');
  });

  // M1：task.ts 共用的 'body' 分支说的是「要是一个对象（整个请求体）」——
  // 那是 HTTP 路由的词汇，outbox 这条路上没有「请求体」这回事，AI 会去找
  // 一个不存在的东西。这里数组里塞一个字符串（AI 把整条任务写成了一句话，
  // 不是对象），确认横幅换成了 outbox 语境的话。
  it('任务不是对象（数组里塞了个字符串）时，横幅不说「请求体」——outbox 没有这个概念', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: ['这不是一个任务对象'] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    const message = (seen[0] as { message: string }).message;
    expect(message).toContain('任务对象');
    expect(message).not.toContain('请求体');
  });

  it('任务没写 title（不是空字符串，是压根没有这个键）—— 报的是标题缺失，不是某个字段形状不对', () => {
    writeInbox([inboxItem()]);
    const { title: _title, ...noTitle } = rawTask();   // 整个键都不存在，跟 title:'' 是两回事
    writeOutbox([{ inboxId: 'inbox-1', tasks: [noTitle] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    const message = (seen[0] as { message: string }).message;
    expect(message).toContain('标题');
    expect(message).toContain('第 1 项第 1 个任务');
  });

  it('entry 形状不对（缺 inboxId 或 tasks 不是数组）—— 拒绝、文件保留', () => {
    writeOutbox([{ tasks: [rawTask()] }]);   // 没有 inboxId

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks()).toEqual([]);
    expect(existsSync(outboxPath())).toBe(true);
    expect((seen[0] as { message: string }).message).toMatch(/形状不对/);
  });

  it('outbox 文件本身不是合法 JSON（模拟半截写入）—— 不崩、不合并、文件留着', () => {
    writeFileSync(outboxPath(), '[{"inboxId":"inbox-1","tasks":[{"titl', 'utf8');

    const bus = new Bus();
    const seen = statusEvents(bus);
    expect(() => mergeOutbox(bus)).not.toThrow();

    expect(readTasks()).toEqual([]);
    expect(existsSync(outboxPath())).toBe(true);
    expect((seen[0] as { state: string }).state).toBe('failed');
  });
});

describe('mergeOutbox：inboxId 找不到', () => {
  it('任务照样入库，只是标不到来源条目；日志记一行', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeInbox([]);   // 对应的收件箱条目已经被用户删了
    writeOutbox([{ inboxId: '早就不存在的id', tasks: [rawTask()] }]);

    mergeOutbox(new Bus());

    expect(readTasks().map((t) => t.title)).toEqual(['写周报']);
    expect(existsSync(outboxPath())).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[outbox]') && String(c[0]).includes('早就不存在的id'))).toBe(true);
    warn.mockRestore();
  });
});

describe('mergeOutbox：inboxId 已经 processed —— 幂等', () => {
  it('已经标成 processed:true 的条目整条跳过，不二次入库、不碰 inbox 那一条', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 模拟：这条收件箱记录已经被前一次拆解处理过了（比如网页「立即拆解」跟终端
    // 里的 /expand 前后脚都在跑，两边各自写了一份 outbox）。
    writeInbox([{ ...inboxItem(), processed: true, taskIds: ['old-task'] }]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'dup-task', title: '重复拆出来的' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks()).toEqual([]);   // 一个任务都没入库
    const inbox = readInbox();
    expect(inbox[0].processed).toBe(true);
    expect(inbox[0].taskIds).toEqual(['old-task']);   // 没被改动，也没被重写成新数组的等价内容
    expect(existsSync(outboxPath())).toBe(false);   // 文件已经被完整处理过，照样删掉
    expect(seen).toEqual([{
      state: 'skipped',
      message: '1 条收件箱记录都已经处理过，本次没有新增任务（可能是拆解被重复触发了）',
    }]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('跳过已处理过的收件箱条目') && String(c[0]).includes('inbox-1'))).toBe(true);
    warn.mockRestore();
  });

  it('跟「inboxId 找不到」是两种不同情况：processed:true 跳过，条目缺失（被删）照样入库', () => {
    writeInbox([
      { ...inboxItem({ id: 'processed-1' }), processed: true, taskIds: [] },
      // inboxId 'deleted-1' 压根不在 inbox.json 里——用户在 AI 跑的时候把它删了
    ]);
    writeOutbox([
      { inboxId: 'processed-1', tasks: [rawTask({ id: 'should-not-appear', title: '不该出现' })] },
      { inboxId: 'deleted-1', tasks: [rawTask({ id: 'should-appear', title: '活是真的，照样入库' })] },
    ]);

    mergeOutbox(new Bus());

    const titles = readTasks().map((t) => t.title);
    expect(titles).toEqual(['活是真的，照样入库']);   // 只有「找不到」那条的任务入库了
    expect(readInbox()[0].taskIds).toEqual([]);   // processed 那条没被碰
  });

  it('整份 outbox 里的条目全部已处理 —— 文件照样删掉，但要让用户看得见「为什么没新增」', () => {
    writeInbox([{ ...inboxItem(), processed: true, taskIds: [] }]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask()] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(existsSync(outboxPath())).toBe(false);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { state: string }).state).toBe('skipped');
  });
});

describe('mergeOutbox：多个文件', () => {
  it('按文件名排序依次合并，都写进同一份 tasks.json', () => {
    writeInbox([inboxItem({ id: 'inbox-1' }), inboxItem({ id: 'inbox-2', text: '第二条' })]);
    writeOutbox([{ inboxId: 'inbox-2', tasks: [rawTask({ id: 'b-task', title: 'B 文件的任务' })] }], 'b-later');
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'a-task', title: 'A 文件的任务' })] }], 'a-earlier');

    mergeOutbox(new Bus());

    expect(readTasks().map((t) => t.title)).toEqual(['A 文件的任务', 'B 文件的任务']);
    expect(existsSync(outboxPath('a-earlier'))).toBe(false);
    expect(existsSync(outboxPath('b-later'))).toBe(false);
  });

  it('一个文件校验不过，不影响别的文件照常合并、删除', () => {
    writeInbox([inboxItem({ id: 'inbox-1' }), inboxItem({ id: 'inbox-2', text: '第二条' })]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'good-task', title: '好文件的任务' })] }], 'good');
    const badContent = [{ inboxId: 'inbox-2', tasks: [rawTask({ status: '进行中' })] }];   // 非法 status
    writeOutbox(badContent, 'bad');

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    // 好的那份：任务入库、来源条目标 processed、文件被删。
    expect(readTasks().map((t) => t.title)).toEqual(['好文件的任务']);
    expect(readInbox().find((x) => x.id === 'inbox-1')?.processed).toBe(true);
    expect(existsSync(outboxPath('good'))).toBe(false);

    // 坏的那份：原样留在磁盘上，内容一个字节不少，来源条目没被动过。
    expect(existsSync(outboxPath('bad'))).toBe(true);
    expect(JSON.parse(readFileSync(outboxPath('bad'), 'utf8'))).toEqual(badContent);
    expect(readInbox().find((x) => x.id === 'inbox-2')?.processed).toBe(false);

    // 状态汇总成一条：既说了新增了什么，也点名了哪个文件没通过。
    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain('新增 1 个任务');
    expect(status.message).toContain('bad');
  });

  it('outboxFiles() 按文件名排好序，且只认 outbox-*.json，不认 .tmp / .bak', () => {
    writeOutbox([], 'z');
    writeOutbox([], 'a');
    writeFileSync(join(dataDir(), 'outbox-half.json.tmp'), '[', 'utf8');
    writeFileSync(join(dataDir(), 'tasks.json.bak'), '[]', 'utf8');

    const files = outboxFiles().map((f) => f.split(/[\\/]/).pop());
    expect(files).toEqual(['outbox-a.json', 'outbox-z.json']);
  });
});

describe('mergeOutbox：空数组', () => {
  it('直接删掉，不算错——但要广播「收件箱里没有要拆的」，不能一声不吭', () => {
    // 之前这里断言「不广播状态」：那正是 C 类静默失败——用户点了「立即拆解」
    // 等了 90 秒，AI 看了一圈发现收件箱是空的，写了个空数组交差，界面上却什么
    // 反应都没有，跟卡住了长得一模一样。现在要求给一条诚实的、不吓人的提示。
    writeOutbox([]);
    const bus = new Bus();
    const seen = statusEvents(bus);

    mergeOutbox(bus);

    expect(existsSync(outboxPath())).toBe(false);
    expect(seen).toEqual([{ state: 'skipped', message: '收件箱里没有需要拆的内容，本次没有新增任务' }]);
  });

  it('没有任何 outbox-*.json 文件也一样安全，这次调用跟拆解无关，不广播任何状态', () => {
    // 这跟上面那条不是一回事：上面是「AI 写了一个空数组交差」，这里是「压根没
    // 有 outbox 文件」——服务每次启动都会调一次 mergeOutbox 例行补检查，这种
    // 最常见的「什么都没发生」不该在用户压根没点过按钮的时候弹一条横幅。
    expect(outboxFiles()).toEqual([]);
    const bus = new Bus();
    const seen = statusEvents(bus);
    expect(() => mergeOutbox(bus)).not.toThrow();
    expect(readTasks()).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('mergeOutbox：AI 判断都不是任务（C：produced-nothing 的另一种）', () => {
  it('entry 里 tasks 是空数组、inboxId 是真的——照样标 processed，但要说清楚「AI 跑完了但没产出任务」', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks()).toEqual([]);
    expect(readInbox()[0]).toMatchObject({ processed: true, taskIds: [] });
    expect(existsSync(outboxPath())).toBe(false);
    // 跟「收件箱里没有要拆的」用不一样的话——这里是有内容、AI 真处理了，
    // 只是判断都不算任务，两种「没有新任务」不能共用一句话糊弄过去。
    expect(seen).toEqual([{
      state: 'skipped',
      message: 'AI 跑完了，但没有产出新任务（可能是内容都不算需要拆的任务，或者对应的任务已经存在）',
    }]);
  });
});

describe('mergeOutbox：A——同 id 撞车（中断重试 / AI 复用了旧 id）', () => {
  it('模拟中断在两次写之间：tasks.json 已经有这个任务、inbox 还没标 processed、outbox 文件还在。' +
     '重跑合并之后应该恰好一个任务、inbox 那条被标完成，而不是两个任务或者永远卡着。', () => {
    // 这就是上一次中断留下的现场：写完 tasks.json 之后、写 inbox.json 之前，
    // 进程被杀掉或者磁盘满了——outbox 文件还在，inbox 那条还是 processed:false。
    const existing = newTask({ id: 'dup-id', title: '已经落地的任务' });
    writeTasks([existing]);
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'dup-id', title: '已经落地的任务' })] }]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeOutbox(new Bus());

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);   // 不是两个——原任务没被复制一份
    expect(tasks[0]).toEqual(existing);   // 原任务一个字段都没被覆盖

    const inbox = readInbox();
    expect(inbox[0].processed).toBe(true);   // inbox 那半边照样完成了
    expect(inbox[0].taskIds).toEqual(['dup-id']);

    expect(existsSync(outboxPath())).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('跳过 id 已存在的任务') && String(c[0]).includes('dup-id'))).toBe(true);
    warn.mockRestore();
  });

  it('PATCH/DELETE 依赖 id 唯一——回归验证：撞车之后按 dup-id 只能查到一个任务', () => {
    const existing = newTask({ id: 'dup-id', title: '原任务', notes: '不应该被动过' });
    writeTasks([existing]);
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'dup-id', title: '被拆出来的重名任务' })] }]);

    mergeOutbox(new Bus());

    const matches = readTasks().filter((t) => t.id === 'dup-id');
    expect(matches).toHaveLength(1);
    expect(matches[0].notes).toBe('不应该被动过');
  });
});

describe('mergeOutbox：order/later 是人的字段，AI 写的不算数', () => {
  it('AI 写的 order 不管是什么值，落地之后一律是 null——跟 source 一样被强制覆盖', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'has-order', order: 7 })] }]);

    mergeOutbox(new Bus());

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].order).toBeNull();
  });

  it("AI 写的 order 类型不对（比如手滑塞了个字符串），文件照样正常合并，落地是 null——不是校验拒收整个文件，AGENTS.md 明确承诺「order 不管你写什么都会被悄悄改成 null，不会报错」", () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'bad-order', order: '第一' })] }]);

    mergeOutbox(new Bus());

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].order).toBeNull();
  });

  it('AI 没写 order 字段，落地的任务 order 照样是 null（newTask 的默认值）', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'no-order' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].order).toBeNull();
  });

  it("AI 写 status:'later'——整个文件拒收，不是静默改成别的状态，tasks.json 一个字节不动", () => {
    writeInbox([inboxItem()]);
    writeTasks([newTask({ title: '已经有的任务' })]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ status: 'later' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks().map((t) => t.title)).toEqual(['已经有的任务']);   // 没有新任务落地
    expect(readInbox()[0].processed).toBe(false);
    expect(existsSync(outboxPath())).toBe(true);   // 文件原样留着，可以改好重试
    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain("'later'");
  });

  it("AI 写 status:'abandoned'——跟 later 同一条路径：整个文件拒收，横幅点名是「放弃」", () => {
    // 放弃跟搁置一样是人的决定（仿滴答清单的「放弃」）。它是五个合法值之一，
    // AI 手滑写出来看起来完全正常，静默改掉会把这个错误藏起来。
    writeInbox([inboxItem()]);
    writeTasks([newTask({ title: '已经有的任务' })]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ status: 'abandoned' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(readTasks().map((t) => t.title)).toEqual(['已经有的任务']);
    expect(readInbox()[0].processed).toBe(false);
    expect(existsSync(outboxPath())).toBe(true);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain("'abandoned'");
    // 横幅要说清是哪一种越权——两条走同一段代码，文案不能只写死「搁置」
    expect(status.message).toContain('放弃');
  });

  it("一份 entry 里一好一坏（好任务在前）——命中 later 的那个坏任务照样让整个文件不合并", () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'ok-1', title: '正常那条' }), rawTask({ id: 'bad-1', status: 'later' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toEqual([]);   // 正常那条也没有单独落地——整批拒收
    expect(existsSync(outboxPath())).toBe(true);
  });
});

describe('mergeOutbox：D——写入失败要跟校验失败分开说，且报真实落盘数量', () => {
  it('tasks.json 写成功、inbox.json 写失败：报「写入失败」不是「没通过校验」，newTaskCount 算真实写入的那份', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'landed-task', title: '应该落地的任务' })] }]);

    // 模拟 inbox 那一步落盘失败：inbox 现在是一目录一张表，entityStore.writeOne
    // 会往 `<dir>/<id>.json.tmp` 写——这条 inboxItem() 的 id 固定是 'inbox-1'，
    // 如果那个 tmp 路径已经是个目录，writeFileSync 会抛 EISDIR——不用 mock
    // 模块，直接用真实的文件系统制造一次写失败，跟旧版同一个手法，只是换成
    // 新的实体文件布局。
    mkdirSync(join(paths().inbox, 'inbox-1.json.tmp'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);
    warn.mockRestore();

    // 任务已经落地——tasks.json 那一步先于 inbox.json，先成功了。
    expect(readTasks().map((t) => t.title)).toEqual(['应该落地的任务']);
    // inbox 那条还是没标上——写入真的失败了，不是假装成功。
    expect(readInbox()[0].processed).toBe(false);
    // outbox 文件原样留着，可以重试。
    expect(existsSync(outboxPath())).toBe(true);

    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain('新增 1 个任务');   // 真实写入数量，不是 0
    expect(status.message).not.toContain('没通过校验');   // 不能报成校验失败
    expect(status.message).toContain('落盘/清理时出了问题');
  });
});

describe('AI 写不了的字段一律强制归零', () => {
  // 「打算花多久」跟 priority/order 同一类：AI 写什么都不算数——这件事要花
  // **你**多久，它没有依据（stripForced 把它摘掉，toTask 落回 null）。
  it('AI 填了 estimateMinutes 也不算数', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'e-1', estimateMinutes: 480 })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].estimateMinutes).toBeNull();
  });

  it('estimateMinutes 写坏了也不拒收整个文件——一个反正不采信的字段不该让整份文件退回', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'e-2', estimateMinutes: '很久' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toHaveLength(1);
    expect(readTasks()[0].estimateMinutes).toBeNull();
  });

  it('AI 填了 priority 也不算数', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'p-1', priority: 3 })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].priority).toBe(0);
  });

  it('AI 填了 stuckNote / completedAt / postponeCount / focusSessions / attachments 都不算数', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({
        id: 'p-2', completedAt: '2026-01-01T00:00:00.000Z', postponeCount: 9,
        focusSessions: [{ startedAt: '2026-01-01T00:00:00.000Z', minutes: 25 }], attachments: ['x.png'],
      })],
    }]);

    mergeOutbox(new Bus());

    const t = readTasks()[0];
    // `stuckNote` 字段已删，但 stripForced 仍要接住老 AI 写来的那把键（否则
    // 白名单外的键会把整份文件退回）——铉的是「没被拒收」，不再是字段值。
    expect('stuckNote' in t).toBe(false);
    expect(t.completedAt).toBeNull();
    expect(t.postponeCount).toBe(0);
    expect(t.focusSessions).toEqual([]);
    expect(t.attachments).toEqual([]);
  });

  it('AI 填的 repeat / tags / waitingFor 算数——那些是原文里的事实', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({
        id: 'p-3', title: '写周报', tags: ['工作'], waitingFor: '张老师回邮件',
        repeat: { every: 'week', interval: 1, weekdays: [1], until: null },
      })],
    }]);

    mergeOutbox(new Bus());

    const t = readTasks()[0];
    expect(t.tags).toEqual(['工作']);
    expect(t.waitingFor).toBe('张老师回邮件');
    expect(t.repeat?.every).toBe('week');
  });

  // 六个字段类型全写错（不是「填对了但会被覆盖」，是「压根不合法」）也照样
  // 合并——跟 order 是同一条路径：stripForced 在校验之前就把它们摘掉了，
  // sanitizeTaskPatch 根本看不见这些值，不会因为它们不合法而拒收整份文件。
  // 对照组见上面「order/later 是人的字段」那个 describe 里 `order: '第一'`
  // 那条：同样是类型错了，同样正常合并。
  it('六个强制字段就算类型完全错了，也照常合并、落地用默认值——不会让整个文件被拒', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({
        id: 'weird-1',
        priority: 5,              // 合法范围是 0..3
        stuckNote: 123,            // 应该是字符串或 null
        completedAt: '明天',        // 不是合法的 ISO 时间
        postponeCount: -1,         // 应该是非负整数
        focusSessions: 'x',        // 应该是数组
        attachments: 'x.png',      // 应该是数组
      })],
    }]);

    mergeOutbox(new Bus());

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);   // 没有被拒收
    expect(tasks[0].priority).toBe(0);
    expect('stuckNote' in tasks[0]).toBe(false);
    expect(tasks[0].completedAt).toBeNull();
    expect(tasks[0].postponeCount).toBe(0);
    expect(tasks[0].focusSessions).toEqual([]);
    expect(tasks[0].attachments).toEqual([]);
  });

  it('I-2：reminders 里每一条的 firedAt 无论 AI 写什么都强制归 null——stripForced 摘的是顶层键，摘不到嵌在数组里的字段，AI 写一个过去的 firedAt 能让提醒静默失效', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({
        id: 'r-1',
        reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: '2026-08-19T00:00:00.000Z' }],
      })],
    }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].reminders).toEqual([{ at: '2026-08-20T01:00:00.000Z', firedAt: null }]);
  });
});

describe('I-1：AI 写的任务 id 试图路径穿越——拒收，不写到 data/ 之外，不假装成功', () => {
  it('id 带 ../.. ——任务没有落进 tasks.json，来源那条收件箱记录不会被误标成 processed，横幅老实说出问题', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: '../../逃出去的任务' })] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    expect(() => mergeOutbox(bus)).not.toThrow();

    // 没有幽灵任务：tasks.json（entityStore 视角）里什么都没有。
    expect(readTasks()).toEqual([]);
    // 收件箱那条不能被标成「已处理」——标了的话这条记录再也不会被重新拆解，
    // 而对应的任务其实压根没有落地，taskIds 会指向一个不存在的任务。
    expect(readInbox()[0].processed).toBe(false);
    // 横幅不能说「新增 1 个任务」这种假话。
    expect(seen.some((s) => (s as { state: string }).state === 'ok')).toBe(false);
  });
});

describe('I-1b：坏 id 混在好任务旁边——好任务不能被静默落盘，横幅不能撒谎说『没有改动』', () => {
  // Task 1 的探针实测出的现场：checkTask 以前不校验 id 是否安全，一份 entry
  // 里 [好任务, 坏 id 任务] 走到写盘那一步，syncAll 逐条 writeOne 没有事务——
  // 好任务先被写进磁盘，坏 id 那条才让 writeTasks() 整体抛出异常。异常发生在
  // `tasksWritten = true` 赋值之前，catch 块因此报「tasks.json 没有改动」，
  // 而磁盘上 good-1.json 已经真的落地了——这句话是假的。而且这份 outbox 文件
  // 不会被删（校验失败/写入失败都不会走到 safeDelete），下次任何触发都会重新
  // 扫到它、重新踩一遍同一个坏 id，同一个错永远重复。
  it('好任务在前、坏 id 任务在后：checkTask 在任何写盘动作之前就拒收整份文件，两条都不落地', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({ id: 'good-1', title: '好任务' }), rawTask({ id: '../逃出去', title: '坏任务' })],
    }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    // 核心回归点：好任务没有被单独落地。
    expect(readTasks()).toEqual([]);
    expect(readInbox()[0].processed).toBe(false);
    expect(existsSync(outboxPath())).toBe(true);   // 校验没过，原样留着，可以改好重试

    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).toContain('id');
    expect(status.message).toContain('没通过校验');   // 走的是校验失败这条路，不是写入失败
    expect(status.message).not.toContain('没有改动');   // 校验失败的措辞跟写入失败不一样，不该出现这句
  });

  it('重新触发合并（模拟服务重启补检查 / 下一次自动拆解）——每次都是同一句说得清楚的校验失败，不会越滚越乱', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({ id: 'good-1', title: '好任务' }), rawTask({ id: '../逃出去', title: '坏任务' })],
    }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);   // 第一次
    mergeOutbox(bus);   // 第二次，模拟下一次触发重新扫到同一个文件

    expect(readTasks()).toEqual([]);   // 两轮下来磁盘依然是空的，没有累积出半成品
    expect(existsSync(outboxPath())).toBe(true);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);   // 两次结果完全一样——稳定的「需要人改」，不是逐步恶化的死循环
  });
});

describe('outbox 写入过程中途失败——横幅不能撒谎说『tasks.json 没有改动』', () => {
  // 跟上面 I-1b 不同：这里两个 id 都是安全的（不会被 checkTask 挡住），模拟的
  // 是校验全部通过、真正调用 writeTasks() 之后才出的意外（entityStore.syncAll
  // 逐条 writeOne，没有事务）。这条路径不是这次修的那个具体触发点（id 不安全），
  // 但触发方式是同一类：newTasks 有好几条时，前面几条可能已经真落盘，中间
  // 某一条才让这次 writeTasks() 调用整体抛异常——`tasksWritten` 那个标志位
  // 记录的是「这次调用有没有跑完」，不是「有没有真的写了点什么」，两者不是一回事。
  it('syncAll 处理多条新任务时中途失败（某条的临时文件路径被占用）——前面那条已经真落盘，横幅不能说没有改动', () => {
    writeInbox([inboxItem()]);
    // entityStore.writeOne 会往 `<dir>/<id>.json.tmp` 写：这里提前把 'blocked-1'
    // 这条的临时文件路径占成一个目录，逼 writeFileSync 抛 EISDIR——跟现有
    // 「D：写入失败」describe 里对 inbox 用的是同一个手法，这里换成 tasks。
    mkdirSync(join(paths().tasks, 'blocked-1.json.tmp'), { recursive: true });

    writeOutbox([{
      inboxId: 'inbox-1',
      tasks: [rawTask({ id: 'ok-1', title: '先落地这个' }), rawTask({ id: 'blocked-1', title: '这个会卡住' })],
    }]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);
    warn.mockRestore();

    // 前面那条真的已经落盘了——这就是 syncAll 没有事务带来的固有形状。
    expect(readTasks().map((t) => t.id)).toEqual(['ok-1']);
    expect(readInbox()[0].processed).toBe(false);
    expect(existsSync(outboxPath())).toBe(true);

    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('failed');
    expect(status.message).not.toContain('没有改动');   // 在这个场景下这句话是假的
    expect(status.message).toContain('可能已经被部分改动');
  });
});

describe('presentKeys 的键检查不能在非对象条目上炸出 TypeError', () => {
  // 审查发现：`k in entry` 在 entry 不是对象时直接抛 TypeError，不是返回
  // false。AI 手滑把顶层数组写成裸值（null/字符串/数字）不算稀奇，这几条
  // 锁住「不管条目长什么样，mergeOutbox 都不能抛出去」这条底线——服务启动时
  // 补合并那条路径没有 try/catch 接着，抛出去就是直接崩服务，而且文件永远
  // 删不掉，每次重启都崩。
  it.each([
    ['null', null],
    ['字符串', '我是一句话'],
    ['数字', 123],
  ])('条目是%s（不是对象）—— 优雅拒收，不抛异常', (_label, value) => {
    writeOutbox([value]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    expect(() => mergeOutbox(bus)).not.toThrow();

    expect(readTasks()).toEqual([]);
    expect(existsSync(outboxPath())).toBe(true);   // 原样留着，能改了重来
    expect(seen).toHaveLength(1);
    expect((seen[0] as { state: string }).state).toBe('failed');
  });
});

describe('只有 insights 的横幅不能说假话', () => {
  it('没有 proposal、只有 insight：不能说「提了 0 条修改建议」，也不能说要去任务卡上确认', () => {
    writeOutbox([{ insights: [{ kind: 'note', text: '一条观察', taskIds: [] }] }]);

    const bus = new Bus();
    const seen = statusEvents(bus);
    mergeOutbox(bus);

    expect(seen).toHaveLength(1);
    const status = seen[0] as { state: string; message: string };
    expect(status.state).toBe('ok');
    expect(status.message).toContain('记录了 1 条观察');
    expect(status.message).not.toContain('提了 0 条');   // insight 不是 proposal，不能替它报数
    expect(status.message).not.toContain('任务卡');       // insight 不挂在任何一张任务卡上
  });
});

describe('presentKeys 键出现即算，不管值是什么', () => {
  // 协议语义变更（裁决要求补测试锁住，别让它悬着）：旧版
  // `isUpdateEntry(entry) && isValidEntry(entry)` 只在 updates 真的是数组时
  // 才判定「同时写了两种」；现在只要键出现——哪怕值是 null——就算。
  it('inboxId+tasks 之外混进一个值是 null 的 updates 键，键出现即算，整份文件同样拒收', () => {
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'x-1' })], updates: null }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(true);
  });
});

describe('第三种条目：insights', () => {
  it('落进 insights 表', () => {
    writeOutbox([{ insights: [{ kind: 'pattern', text: '写作任务都在深夜完成', taskIds: ['t1'] }] }]);

    mergeOutbox(new Bus());

    const all = readInsights();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('写作任务都在深夜完成');
    expect(all[0].id).toBeTruthy();
    expect(all[0].dismissedAt).toBeNull();
    expect(existsSync(outboxPath())).toBe(false);   // 合并成功，文件该被删掉
  });

  it('kind 不在四个值里就整个文件拒收', () => {
    writeOutbox([{ insights: [{ kind: '瞎编的', text: 'x', taskIds: [] }] }]);

    mergeOutbox(new Bus());

    expect(readInsights()).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(true);   // 原样留着，能改了重来
  });

  it('text 为空就整个文件拒收——一条什么都没说的观察比没有更糟', () => {
    writeOutbox([{ insights: [{ kind: 'note', text: '   ', taskIds: [] }] }]);

    mergeOutbox(new Bus());

    expect(readInsights()).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(true);   // 原样留着，能改了重来
  });

  // 自选的第二处否定用例（跟 Step 6 点名的 priority 不是同一处）：taskIds
  // 里混进了非字符串，toInsight 里 taskIds 那条校验要能拦住它。
  it('taskIds 不是字符串数组就整个文件拒收', () => {
    writeOutbox([{ insights: [{ kind: 'note', text: '有效文本', taskIds: ['ok', 123] }] }]);

    mergeOutbox(new Bus());

    expect(readInsights()).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(true);
  });

  it('一模一样的观察不重复入库', () => {
    const one = { insights: [{ kind: 'note', text: '同一句话', taskIds: [] }] };
    writeOutbox([one]);
    mergeOutbox(new Bus());
    writeOutbox([one]);
    mergeOutbox(new Bus());

    expect(readInsights()).toHaveLength(1);
  });

  it('一个条目里同时出现 tasks 和 insights：整个文件拒收', () => {
    writeOutbox([{ inboxId: 'inbox-1', tasks: [{ title: 'x' }], insights: [{ kind: 'note', text: 'y', taskIds: [] }] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toHaveLength(0);
    expect(readInsights()).toHaveLength(0);
    expect(existsSync(outboxPath())).toBe(true);   // 原样留着，能改了重来
  });
});

/**
 * **「人看过没看过」不是 AI 能替他写的。**
 *
 * `reviewedAt` 是回顾那一屏那颗「看过了」盖的章，盖了之后那条卡住的项目
 * `REVIEWED_QUIET_DAYS` 天内不再出现在清单上。AI 要是写得进去，一条它从没
 * 让人看过的项目会**直接从回顾清单上消失**——而回顾正是 AI 自己在跑的那件事，
 * 等于让它有办法把自己该报的东西藏起来。跟 priority/order/estimateMinutes
 * 同一类，`stripForced` 摘掉。
 */
describe('AI 写不了 reviewedAt', () => {
  it('AI 填了 reviewedAt 也不算数，落回 null', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'r-1', reviewedAt: '2026-08-25T00:00:00.000Z' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].reviewedAt).toBeNull();
  });

  it('reviewedAt 写坏了也不拒收整个文件——一个反正不采信的字段不该让整份文件退回', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 'r-2', reviewedAt: '上周' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toHaveLength(1);
    expect(readTasks()[0].reviewedAt).toBeNull();
  });
});

/**
 * **怎么给自己的清单分段是他的组织习惯**，跟 `pinned`/`parentId` 同一类。
 * AI 拆出来的那几条本来就靠「按来源」聚在一起，再塞进某个分段是替他决定
 * 这份清单该怎么摆——而它连他现在有哪几段都不该假设。
 */
describe('AI 写不了 section', () => {
  it('AI 填了 section 也不算数，落回 null', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 's-1', section: '第一阶段' })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()[0].section).toBeNull();
  });

  it('section 写坏了也不拒收整个文件——一个反正不采信的字段不该让整份文件退回', () => {
    writeInbox([inboxItem()]);
    writeOutbox([{ inboxId: 'inbox-1', tasks: [rawTask({ id: 's-2', section: 42 })] }]);

    mergeOutbox(new Bus());

    expect(readTasks()).toHaveLength(1);
    expect(readTasks()[0].section).toBeNull();
  });
});
