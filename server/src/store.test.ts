import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_SETTINGS, dataDir, deleteOutboxFile, deviceConfigPath, ensureDataFiles, newTask, outboxFiles,
  paths, readOutboxFile, readSettings, readTasks, writeSettings, writeTasks,
} from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-store-'));
  process.env.DATA_DIR = dir;
  // 默认指到临时目录里——不设的话 deviceConfigPath() 会落回平台惯例位置
  // （比如这台机器真实的 %APPDATA%\shiye\device.json），测试会读写到
  // 开发者自己机器上的真实配置。「不设置 DEVICE_CONFIG 时会怎样」单独有
  // 一条测试覆盖（见下面「设置存在设备本地」describe），那条会自己删掉它。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
});

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.DEVICE_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('数据目录', () => {
  it('认 DATA_DIR 环境变量', () => {
    expect(dataDir()).toBe(dir);
  });

  it('ensureDataFiles 铺出空目录，不覆盖已有内容', () => {
    ensureDataFiles();
    expect(readTasks()).toEqual([]);
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);

    writeTasks([newTask({ title: '已经有的任务' })]);
    ensureDataFiles();
    expect(readTasks()).toHaveLength(1);
  });

  it('ensureDataFiles 真的迁移了 v1 数据时打一行日志，说清楚搬了多少条——真实那次数据搬家控制台不能一个字都不说', () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: 't1', title: 'x' }]), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ensureDataFiles();
    expect(log.mock.calls.some((c) => String(c[0]).includes('[迁移]') && String(c[0]).includes('tasks 1 条'))).toBe(true);
    log.mockRestore();
  });

  it('没有旧文件、不算迁移过时，不打这行日志——正常启动不该每次都刷一句没意义的东西', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ensureDataFiles();
    expect(log.mock.calls.some((c) => String(c[0]).includes('[迁移]'))).toBe(false);
    log.mockRestore();
  });
});

describe('原子写', () => {
  it('写完不留 .tmp 残骸，内容能原样读回', () => {
    const t = newTask({ title: '写一份计划', notes: '备注' });
    writeTasks([t]);
    // tasks 现在是一目录一张表——.tmp 残骸要看的是这个子目录，不是 DATA_DIR 根。
    expect(readdirSync(paths().tasks).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readTasks()).toEqual([t]);
  });

  it('落盘的是带缩进的 JSON —— 这个文件是给 AI 和人读的，不是紧凑格式', () => {
    const t = newTask({ title: 'x' });
    writeTasks([t]);
    expect(readFileSync(join(paths().tasks, `${t.id}.json`), 'utf8')).toContain('\n  ');
  });
});

// tasks/inbox/proposals 现在走 entityStore.syncAll，不再产生 .bak——历史版本
// 交给同步服务（见 entityStore.ts 的注释）。.bak 机制本身没有消失，只是只剩
// device.json 还在用（Task 5 把它从 data/settings.json 搬到了设备本地）：
// 这三条测的是 writeAtomic 这个机制本身，换成还在用它的文件继续测，断言的
// 内容（备份时机、覆盖、不轮转）一个字都没变。
describe('.bak 备份', () => {
  it('目标文件已存在时，写之前把旧内容备份成 <file>.bak', () => {
    const before = { ...DEFAULT_SETTINGS, webhookUrl: 'https://old' };
    const after = { ...DEFAULT_SETTINGS, webhookUrl: 'https://new' };
    const deviceFile = deviceConfigPath();
    writeSettings(before);
    writeSettings(after);

    expect(existsSync(`${deviceFile}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${deviceFile}.bak`, 'utf8'))).toEqual(before);
    // 正本已经是新内容——.bak 是「上一版」，不是「当前版本又拷了一份」。
    expect(readSettings()).toEqual(after);
  });

  it('目标文件第一次写（还不存在）不产生 .bak——没有「上一版」可备份', () => {
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: '第一次写' });
    expect(existsSync(`${deviceConfigPath()}.bak`)).toBe(false);
  });

  it('只留最近一份，不轮转——连写三次，.bak 里是第二次的内容，不是第一次的', () => {
    const v2 = { ...DEFAULT_SETTINGS, webhookUrl: 'v2' };
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'v1' });
    writeSettings(v2);
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'v3' });
    expect(JSON.parse(readFileSync(`${deviceConfigPath()}.bak`, 'utf8'))).toEqual(v2);
  });
});

describe('设置存在设备本地，不在 data/ 里', () => {
  it('deviceConfigPath 不在 dataDir 下面——它要跟着同步就会互相覆盖', () => {
    // 这条要测的是「没有 DEVICE_CONFIG 时的默认值」，不是 beforeEach 为其它
    // 测试准备的临时路径——删掉它才能验到真正的平台惯例位置。
    delete process.env.DEVICE_CONFIG;
    process.env.DATA_DIR = dir;
    expect(deviceConfigPath().startsWith(resolve(dir))).toBe(false);
    // 只测「不在 dataDir 下面」太松——随便返回哪个 dataDir 之外的路径都能过。
    // 加固到具体形状：平台惯例位置下的 shiye/device.json。
    // **前面那个 `[\\/]` 是必须的**：不带它的话 `shiye` 只是个后缀匹配，旧名字
    // `…\035-shiye\device.json` 照样通过——这条断言号称「加固到具体形状」，少了
    // 这一段它对「字面量被改回去/被合并回去」一句话都说不上，而 identity-literals
    // 那条只比 store.ts 和 main.ts 两侧相不相等，两侧一起回退它也是绿的。
    expect(deviceConfigPath()).toMatch(/[\\/]shiye[\\/]device\.json$/);
  });

  it('DEVICE_CONFIG 环境变量能指定位置', () => {
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'https://例子' });
    expect(readSettings().webhookUrl).toBe('https://例子');
    expect(existsSync(join(dir, 'device.json'))).toBe(true);
  });
});

describe('outboxFiles', () => {
  it('目录还没铺出来时返回空数组，不报错', () => {
    expect(outboxFiles()).toEqual([]);
  });

  it('读写删单个 outbox 文件；不存在的目标什么都不做', () => {
    ensureDataFiles();
    const file = join(dataDir(), 'outbox-x.json');
    writeFileSync(file, JSON.stringify([{ inboxId: 'i1', tasks: [] }]), 'utf8');
    expect(readOutboxFile(file)).toEqual([{ inboxId: 'i1', tasks: [] }]);
    expect(outboxFiles()).toEqual([file]);

    deleteOutboxFile(file);
    expect(existsSync(file)).toBe(false);
    expect(() => deleteOutboxFile(file)).not.toThrow();
  });
});

// tasks 现在是一目录一张表：单条实体读坏了，entityStore.readAll 会跳过、
// warn，不会让整表读不出来——这是 Task 1 的有意设计（见 entityStore.ts 的
// 注释：「一千条里坏一条，不该让另外 999 条也打不开」），readTasks() 不再
// throw。这条断言测的是 readJson 的通用契约（坏 JSON 要报错、指出文件、
// 不能吞掉），device.json 还在走这条路径，换个文件继续测同一件事。
describe('坏文件', () => {
  it('JSON 损坏时报错并指出是哪个文件，不静默清空', () => {
    const deviceFile = deviceConfigPath();
    writeFileSync(deviceFile, '{ 这不是 JSON', 'utf8');
    expect(() => readSettings()).toThrow(/device\.json/);
    // 报错之后原文件必须还在
    expect(readFileSync(deviceFile, 'utf8')).toContain('这不是 JSON');
  });
});

describe('newTask', () => {
  it('填齐默认值，标题必须给', () => {
    const t = newTask({ title: '买菜' });
    expect(t).toMatchObject({
      title: '买菜', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
      reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
      // Task 2 新加的 11 个字段——分类相关的、回顾的地基、番茄钟与习惯打卡。
      listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
      postponeCount: 0, waitingFor: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.createdAt).toBe(t.updatedAt);
  });

  it('给了的字段照用', () => {
    const t = newTask({ title: 'x', status: 'doing', source: 'ai', aiComment: '拆自收件箱第 3 条' });
    expect(t.status).toBe('doing');
    expect(t.source).toBe('ai');
    expect(t.aiComment).toBe('拆自收件箱第 3 条');
  });
});

/**
 * **磁盘上的任务不全是这个服务自己写的**：`POST /api/push` 从另一台设备收来的、
 * AI 写进 outbox 的、人手改的文件，都会落进 `data/tasks/`，而 `readAll` 是一次
 * 裸 `JSON.parse`。
 *
 * 实测复现过一条真实的拒绝服务：push 只要求四个字符串字段（`push.ts` 的
 * `looksLikeEntity`，有意宽松），推一条没有 `attachments` 的进来，回执 200 说
 * 推成功，然后 `GET /api/tasks` 对**所有客户端**回 500（`t.attachments.length`），
 * `dueTasks` 的 `t.reminders.some` 一起抛——**每条任务的提醒全部停摆**，除非有人
 * 去手改文件否则出不来。
 */
describe('readTasks：把缺了会当场炸的字段补齐', () => {
  beforeEach(() => ensureDataFiles());

  const bare = {
    id: 'evil-1', title: '手机推上来的', status: 'todo',
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
  };

  it('缺 attachments / reminders 等集合字段：补成空数组，不抛', () => {
    writeFileSync(join(paths().tasks, `${bare.id}.json`), JSON.stringify(bare), 'utf8');
    const [t] = readTasks();
    for (const k of ['reminders', 'subtasks', 'tags', 'attachments', 'focusSessions'] as const) {
      expect(Array.isArray(t[k]), `${k} 没补上——调用方一 .length/.some 就抛`).toBe(true);
    }
  });

  // 这两句就是当初炸掉的那两处的形状，直接钉住。
  it('补完之后，那两处裸访问不再抛', () => {
    writeFileSync(join(paths().tasks, `${bare.id}.json`), JSON.stringify(bare), 'utf8');
    const [t] = readTasks();
    expect(() => t.attachments.length).not.toThrow();   // app.ts 的 GET /api/tasks
    expect(() => t.reminders.some(() => true)).not.toThrow(); // reminder.ts 的 dueTasks
  });

  it('完好的任务原样返回，不白造新对象', () => {
    const full = { ...bare, reminders: [], subtasks: [], tags: [], attachments: [], focusSessions: [] };
    writeFileSync(join(paths().tasks, `${full.id}.json`), JSON.stringify(full), 'utf8');
    expect(readTasks()[0].id).toBe('evil-1');
  });

  /**
   * **数组里混进不是对象的元素，同一类当场崩，只是深一层。** 实测 `POST /api/push`
   * 一条 `reminders: [null]` 200 落盘之后：`toIcs` 抛「Cannot read properties of
   * null (reading 'at')」，`.ics` 冻在最后一版；`dueTasks` 抛「reading 'firedAt'」，
   * **所有任务的提醒**每 30 秒都在这一条上停下。五处解引用 `r.at` 只有
   * `dailySummary.ts` 设了防——修在读盘这一处，一次全护住。
   */
  it('reminders / subtasks 里的 null、数字丢掉，别的元素留着', () => {
    const dirty = { ...bare, reminders: [null, { at: '2026-09-05T09:00:00.000Z', firedAt: null }, 7], subtasks: ['不是对象', { text: '一', done: false }] };
    writeFileSync(join(paths().tasks, `${bare.id}.json`), JSON.stringify(dirty), 'utf8');
    const [t] = readTasks();
    expect(t.reminders).toEqual([{ at: '2026-09-05T09:00:00.000Z', firedAt: null }]);
    expect(t.subtasks).toEqual([{ text: '一', done: false }]);
  });

  it('tags / attachments 反过来：只留字符串——附件是文件名，不是对象', () => {
    writeFileSync(join(paths().tasks, `${bare.id}.json`), JSON.stringify({ ...bare, tags: ['紧急', 3, null, { a: 1 }], attachments: ['报告.pdf', null, 5] }), 'utf8');
    const [t] = readTasks();
    expect(t.tags).toEqual(['紧急']);
    expect(t.attachments).toEqual(['报告.pdf']);
  });
});
