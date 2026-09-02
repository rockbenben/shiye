import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrate, upgradeTask, SCHEMA_VERSION } from './migrate.js';
import { readAll, invalidate } from './entityStore.js';
import { deviceConfigPath, type Task } from './store.js';

// 只包一层 renameSync，其余原样透传——跟 entityStore.test.ts 同一条规矩。
// 「meta.json 也是原子写：跑完目录里不留 .tmp」那条断言只查「结果里没有
// .tmp 文件」，对「用了 tmp+rename」和「压根没走 tmp、直接写目标文件」两种
// 情况都成立，抓不住「整个退回非原子写」这种回归（复审者实测：把 tmp+rename
// 改回裸 writeFileSync，那条测试照样绿）。这里换成盯 renameSync 有没有真的
// 被调用、调用时源路径是不是 .tmp 结尾。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const renameMock = vi.mocked(renameSync);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mig-'));
  renameMock.mockClear();
  // 兜底指到临时目录——不设的话任何一条新加的、seed 了 settings.json 的测试
  // 只要忘了自己设 DEVICE_CONFIG，就会真的把东西搬进这台机器的
  // %APPDATA%\shiye\device.json（tmpdir() 和 %APPDATA% 常常同在一个盘，
  // rename 不会报错，会静默造出一份真实配置）。需要测「嵌套目录」形状的
  // 测试自己在测试体内覆盖成更深的路径。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.DEVICE_CONFIG; });

const v1Task = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: '写周报', notes: '备注', status: 'todo',
  due: '2026-08-20T10:00:00.000Z',
  remindAt: '2026-08-19T01:00:00.000Z', remindedAt: null,
  subtasks: [{ text: '第一步', done: true }],
  source: 'ai', aiComment: '原文说月底前',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  order: 3, ...over,
});

describe('upgradeTask：逐字段升级', () => {
  it('remindAt + remindedAt 合成 reminders 一条', () => {
    const t = upgradeTask(v1Task());
    expect(t.reminders).toEqual([{ at: '2026-08-19T01:00:00.000Z', firedAt: null }]);
  });

  it('remindedAt 有值时搬进 firedAt，不丢「已经提醒过」这个事实', () => {
    const t = upgradeTask(v1Task({ remindedAt: '2026-08-19T01:00:05.000Z' }));
    expect(t.reminders[0].firedAt).toBe('2026-08-19T01:00:05.000Z');
  });

  it('remindAt 是 null 时 reminders 是空数组，不是 [{at: null}]', () => {
    expect(upgradeTask(v1Task({ remindAt: null })).reminders).toEqual([]);
  });

  it('remindAt 为 null 但 remindedAt 有值（脏数据）也当没有提醒', () => {
    expect(upgradeTask(v1Task({ remindAt: null, remindedAt: '2026-01-01T00:00:00.000Z' })).reminders).toEqual([]);
  });

  it('原有字段一个都不能变', () => {
    const t = upgradeTask(v1Task());
    expect(t.id).toBe('t1');
    expect(t.title).toBe('写周报');
    expect(t.notes).toBe('备注');
    expect(t.status).toBe('todo');
    expect(t.due).toBe('2026-08-20T10:00:00.000Z');
    expect(t.subtasks).toEqual([{ text: '第一步', done: true }]);
    expect(t.source).toBe('ai');
    expect(t.aiComment).toBe('原文说月底前');
    expect(t.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(t.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(t.order).toBe(3);
  });

  it('新字段填默认值', () => {
    const t = upgradeTask(v1Task());
    expect(t.listId).toBeNull();
    expect(t.tags).toEqual([]);
    expect(t.priority).toBe(0);
    expect(t.repeat).toBeNull();
    expect(t.postponeCount).toBe(0);
    expect(t.waitingFor).toBeNull();
    expect(t.attachments).toEqual([]);
    expect(t.focusSessions).toEqual([]);
    expect(t.habit).toBe(false);
  });

  it('已完成的任务用 updatedAt 近似出 completedAt——这是能拿到的最好结果', () => {
    const t = upgradeTask(v1Task({ status: 'done', updatedAt: '2026-08-05T09:00:00.000Z' }));
    expect(t.completedAt).toBe('2026-08-05T09:00:00.000Z');
  });

  it('没完成的任务 completedAt 是 null', () => {
    expect(upgradeTask(v1Task({ status: 'doing' })).completedAt).toBeNull();
  });

  it('缺字段的脏数据不抛，落回默认值', () => {
    const t = upgradeTask({ id: 'x', title: '只有标题' });
    expect(t.notes).toBe('');
    expect(t.status).toBe('todo');
    expect(t.subtasks).toEqual([]);
    expect(t.reminders).toEqual([]);
    expect(t.order).toBeNull();
  });

  it('已经是 v2 的对象再升一次不变（幂等）', () => {
    const once = upgradeTask(v1Task());
    expect(upgradeTask(once as unknown as Record<string, unknown>)).toEqual(once);
  });

  it('幂等测试要覆盖全部非默认字段，不能只测「默认值过两遍还是默认值」', () => {
    // 新字段全部给非默认值，逐条跟自己比对——如果 upgradeTask 里有任何一处
    // 忘了透传（比如把 priority/repeat 硬编码成默认值），这条测试要能抓到。
    const full: Record<string, unknown> = {
      id: 'full-1', title: '标题', notes: '备注', status: 'doing',
      due: '2026-09-01T00:00:00.000Z', startAt: '2026-08-31T01:00:00.000Z', endAt: '2026-08-31T04:00:00.000Z',
      reminders: [{ at: '2026-08-31T00:00:00.000Z', firedAt: '2026-08-31T00:00:05.000Z' }],
      subtasks: [{ text: '步骤', done: true }],
      source: 'ai', aiComment: '注释',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
      order: 5,
      listId: 'list-1', tags: ['紧急', '工作'], priority: 3,
      repeat: { every: 'week', interval: 2, weekdays: [1, 3], until: '2026-12-01T00:00:00.000Z' },
      completedAt: '2026-08-03T00:00:00.000Z', postponeCount: 4,
      waitingFor: '等对方回复',
      attachments: ['file1.png'], focusSessions: [{ startedAt: '2026-08-01T09:00:00.000Z', minutes: 25 }],
      habit: true,
      // 这一批新加的两个：置顶和多级任务。这条用例的意思是「非默认值过一遍
      // 升级不变」，所以两个都给非默认值——`pinned: false` 过不了这条测试
      // 想拦的那种变异（漏读字段时它照样是 false）。
      pinned: true,
      parentId: 'parent-1',
      // 「打算花多久」。同样给非默认值——`null` 过不了这条用例想拦的变异。
      estimateMinutes: 90,
      // 情境（GTD）。给一个真档位，不是 null：`null` 是默认值，漏读这个字段时
      // 它照样是 null，那条变异就溜过去了。
      context: 'computer',
      section: '第一阶段',
      persistentReminder: true,
      // 回顾里那颗「看过了」盖的章。同理给非默认值——null 是默认值，
      // 漏读这个字段时它照样是 null，那条变异就溜过去了。
      reviewedAt: '2026-08-20T00:00:00.000Z',
    };
    expect(upgradeTask(full)).toEqual(full);
  });

  it('id 缺失或者形状不对时现造一个新的，不会因为都落成同一个文件名而互相覆盖', () => {
    const t1 = upgradeTask({ title: 'A' }); // 缺 id
    const t2 = upgradeTask({ title: 'B' }); // 缺 id
    const t3 = upgradeTask({ id: '../../evil', title: 'C' }); // 试图穿目录
    const ids = [t1.id, t2.id, t3.id];
    expect(new Set(ids).size).toBe(3); // 三个都不一样
    expect(ids.every((id) => id.length > 0 && !id.includes('..') && !/[\\/]/.test(id))).toBe(true);
  });

  it('postponeCount 是 NaN 时落回默认值 0，不落盘成 null（JSON.stringify(NaN) === "null"）', () => {
    expect(upgradeTask(v1Task({ postponeCount: NaN })).postponeCount).toBe(0);
  });
});

describe('migrate：整目录搬家', () => {
  const seed = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');

  it('把三个大数组拆成一实体一文件', () => {
    seed('tasks.json', [v1Task(), v1Task({ id: 't2', title: '洗牙' })]);
    seed('inbox.json', [{ id: 'i1', text: '随手记', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['t1'] }]);
    seed('proposals.json', [{ id: 'p1', taskId: 't1', patch: { due: null }, reason: '过期了', createdAt: '2026-08-03T00:00:00.000Z' }]);

    const r = migrate(dir);

    expect(r.migrated).toBe(true);
    expect(r.counts).toEqual({ tasks: 2, inbox: 1, proposals: 1 });
    expect(readAll<Task>(join(dir, 'tasks')).map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(readAll<{ id: string }>(join(dir, 'inbox')).map((e) => e.id)).toEqual(['i1']);
    expect(readAll<{ id: string }>(join(dir, 'proposals')).map((e) => e.id)).toEqual(['p1']);
  });

  /**
   * **id 被换掉时，引用它的地方要跟着换。**
   *
   * `safeId` 在 id 不安全时现造一个 uuid（不让整次迁移失败，见它的注释），但
   * `InboxItem.taskIds` 和 `Proposal.taskId` 里存的还是旧那个。不回填的话搬完
   * 这两处引用全指向空气：收件箱那条点不开它拆出来的任务，AI 建议挂在一个不
   * 存在的 id 上（界面上就是「建议列表里有一条，哪张卡片上都找不到」）。
   *
   * 实测复现过：`../../evil` 的任务被换成 uuid，而 `taskIds` 仍是 `["../../evil"]`。
   */
  it('换掉不安全的任务 id 时，taskIds 和 proposal.taskId 跟着回填', () => {
    seed('tasks.json', [v1Task({ id: '../../evil' }), v1Task({ id: 'ok-1' })]);
    seed('inbox.json', [{ id: 'i1', text: '随手记', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['../../evil', 'ok-1'] }]);
    seed('proposals.json', [{ id: 'p1', taskId: '../../evil', patch: { due: null }, reason: '过期了', createdAt: '2026-08-03T00:00:00.000Z' }]);

    migrate(dir);

    const ids = new Set(readAll<Task>(join(dir, 'tasks')).map((t) => t.id));
    const inbox = readAll<{ id: string; taskIds: string[] }>(join(dir, 'inbox'))[0];
    const prop = readAll<{ id: string; taskId: string }>(join(dir, 'proposals'))[0];

    expect(ids.has('../../evil'), '不安全的 id 不该原样落地').toBe(false);
    for (const id of inbox.taskIds) expect(ids.has(id), `taskIds 里的 ${id} 指向空气`).toBe(true);
    expect(ids.has(prop.taskId), 'proposal.taskId 指向空气').toBe(true);
    expect(inbox.taskIds, '没被换的那条要保持原样').toContain('ok-1');
  });
  it('旧文件改名保留，绝不删除——迁移出错时这是唯一的退路', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    expect(existsSync(join(dir, 'tasks.json'))).toBe(false);
    expect(existsSync(join(dir, 'tasks.json.v1'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'tasks.json.v1'), 'utf8'))[0].remindAt).toBe('2026-08-19T01:00:00.000Z');
  });

  it('写 meta.json 记下版本号', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual({ schemaVersion: SCHEMA_VERSION });
  });

  it('已经是 v2 的目录不重复迁移', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    seed('tasks.json', [v1Task({ id: '不该被搬进去' })]);
    expect(migrate(dir).migrated).toBe(false);
    invalidate(join(dir, 'tasks'));
    expect(readAll<Task>(join(dir, 'tasks')).map((t) => t.id)).toEqual(['t1']);
  });

  it('全新的空目录：直接标成 v2，不算迁移过', () => {
    const r = migrate(dir);
    expect(r.migrated).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('旧文件是坏 JSON 时抛错，且一个字节都不动', () => {
    writeFileSync(join(dir, 'tasks.json'), '{ 坏掉的', 'utf8');
    expect(() => migrate(dir)).toThrow(/tasks\.json/);
    expect(existsSync(join(dir, 'tasks.json'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    expect(existsSync(join(dir, 'tasks'))).toBe(false);
  });

  it('tasks.json 合法但 inbox.json 是坏 JSON 时，也整体不写——不能因为 tasks.json 先读到就先写', () => {
    // 唯一的坏 JSON 测试如果只弄坏第一个被读的文件（tasks.json），不管读写
    // 顺序对不对、是不是「读完再写」都会在第一次写之前抛，抓不住「边读边写」
    // 这种改法。这条把第二个被读的文件（inbox.json）弄坏，tasks.json 合法。
    seed('tasks.json', [v1Task()]);
    writeFileSync(join(dir, 'inbox.json'), '{ 坏掉的', 'utf8');
    expect(() => migrate(dir)).toThrow(/inbox\.json/);
    // tasks.json 先被成功读完解析，但只要 inbox.json 读失败，tasks/ 目录
    // 就不该被创建——「全部读完再写」意味着「写」这一步压根没开始。
    expect(existsSync(join(dir, 'tasks'))).toBe(false);
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    expect(existsSync(join(dir, 'tasks.json'))).toBe(true);
    expect(existsSync(join(dir, 'inbox.json'))).toBe(true);
  });

  it('.v1 备份已经存在时拒绝覆盖——meta.json 丢失也不能拿这次的内容顶掉上一次真正的原始备份', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    const originalV1 = readFileSync(join(dir, 'tasks.json.v1'), 'utf8');

    // 模拟 meta.json 因为同步冲突之类的原因丢失，服务重启时 ensureDataFiles()
    // 把 tasks.json 重新铺出来（内容不同，代表「这次不是同一份数据」）。
    rmSync(join(dir, 'meta.json'));
    seed('tasks.json', [v1Task({ id: '不该被写' })]);

    expect(() => migrate(dir)).toThrow(/tasks\.json\.v1/);
    // 真正的原始备份必须原封不动，不能被这次重跑的内容顶掉。
    expect(readFileSync(join(dir, 'tasks.json.v1'), 'utf8')).toBe(originalV1);
    // 这一步在任何写入之前就抛了，tasks/ 目录不该多出「不该被写」这条。
    invalidate(join(dir, 'tasks'));
    expect(readAll<Task>(join(dir, 'tasks')).map((t) => t.id)).toEqual(['t1']);
  });

  it('meta.json 的 schemaVersion 比这份代码认识的更新时拒绝启动，不悄悄降级', () => {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }), 'utf8');
    seed('tasks.json', [v1Task()]);
    expect(() => migrate(dir)).toThrow(/schemaVersion/);
    // 不许因为这次调用把 meta.json 悄悄改写回当前版本。
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).schemaVersion).toBe(SCHEMA_VERSION + 1);
  });

  it('meta.json 也是原子写：跑完目录里不留 .tmp', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    expect(existsSync(join(dir, 'meta.json.tmp'))).toBe(false);
  });

  it('meta.json 写入真的走了 tmp+rename，不是省一次系统调用直接写目标文件', () => {
    seed('tasks.json', [v1Task()]);
    migrate(dir);
    // renameSync 在这次 migrate() 里会被调用不止一次：entityStore.writeOne
    // 给每条实体（t1.json.tmp → t1.json）走一次、旧文件改名成 .v1 一次、
    // meta.json 的原子写一次。按目标路径精确挑出 meta.json 那一次，不能只用
    // 「源路径以 .tmp 结尾」这种宽松条件——entityStore 自己写的那些 .tmp
    // 一样满足，会把断言指错对象。
    const metaRename = renameMock.mock.calls.find(([, dest]) => dest === join(dir, 'meta.json'));
    expect(metaRename).toBeDefined();
    const [src, dest] = metaRename!;
    expect(String(src)).toBe(join(dir, 'meta.json.tmp'));
    expect(dest).toBe(join(dir, 'meta.json'));
  });

  it('inbox/proposals 的 id 缺失时也现造一个新的，不会互相覆盖', () => {
    seed('tasks.json', []);
    seed('inbox.json', [{ text: 'A', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: [] }, { text: 'B', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: [] }]);
    migrate(dir);
    expect(readAll<{ id: string }>(join(dir, 'inbox')).length).toBe(2);
  });

  // 这是 Task 3 那条「settings.json 不动」的有意反转：Task 5 把设置搬出了
  // data/，migrate() 现在要把已有的 settings.json 一并搬去设备本地。
  it('settings.json 搬去设备配置——搬走**不是复制**，data/ 里的那份不会留着', () => {
    process.env.DEVICE_CONFIG = join(dir, '_device', 'device.json');
    const deviceFile = deviceConfigPath();
    const settings = { webhookUrl: 'x', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60 };
    seed('settings.json', settings);
    seed('tasks.json', []);
    migrate(dir);
    // 不是复制：源文件必须真的消失，不能是「多了一份、原来那份也还在」。
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(existsSync(deviceFile)).toBe(true);
    expect(JSON.parse(readFileSync(deviceFile, 'utf8'))).toEqual(settings);
  });

  it('device.json 已经存在时不覆盖它，也不动 data/ 里的 settings.json——不知道该信哪一份，宁可都不碰', () => {
    process.env.DEVICE_CONFIG = join(dir, '_device', 'device.json');
    const deviceFile = deviceConfigPath();
    const existing = { webhookUrl: '这台机器已经配过', toastEnabled: false, autoExpand: false, autoExpandDelaySec: 30 };
    mkdirSync(dirname(deviceFile), { recursive: true });
    writeFileSync(deviceFile, JSON.stringify(existing), 'utf8');
    seed('settings.json', { webhookUrl: 'data/ 里的旧值', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60 });
    seed('tasks.json', []);
    migrate(dir);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(JSON.parse(readFileSync(deviceFile, 'utf8'))).toEqual(existing);
  });

  // 复现审查者在真实机器上踩到的 Critical：data/ 和设备配置目录不在同一个卷
  // 时（这台审查机器是 data/ 在 D:、%APPDATA% 在 C:），renameSync 会抛
  // EXDEV。真实场景下 rename 崩在「.v1 已经改名」和「meta.json 还没写」之间，
  // 会让服务每次启动都死在同一行，永远起不来——这条测试只让「目标是设备
  // 配置路径」的那一次 rename 抛 EXDEV（模拟跨卷），别的 rename（这里用不到，
  // 因为没 seed tasks/inbox/proposals，.v1 那段循环整段跳过；meta.json 的
  // 原子写在 dir 内部，同卷）照常走真实实现，这样失败只可能来自「settings
  // 搬家还在用 renameSync」这一件事，不会被别的地方的失败混淆。
  it('data/ 和设备配置目录不在同一个卷时（renameSync 会 EXDEV），settings 搬家不受影响——用的是拷贝+删除', async () => {
    process.env.DEVICE_CONFIG = join(dir, '_device', 'device.json');
    const deviceFile = deviceConfigPath();
    const settings = { webhookUrl: 'x', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60 };
    seed('settings.json', settings);

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    renameMock.mockImplementation((src, dest) => {
      if (String(dest) === deviceFile) {
        const e = new Error('EXDEV: cross-device link not permitted, rename') as NodeJS.ErrnoException;
        e.code = 'EXDEV';
        throw e;
      }
      return actualFs.renameSync(src as never, dest as never);
    });

    try {
      migrate(dir);
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      expect(existsSync(deviceFile)).toBe(true);
      expect(JSON.parse(readFileSync(deviceFile, 'utf8'))).toEqual(settings);
    } finally {
      // 不还原的话这个 mock 会带着「目标是 deviceFile 就抛 EXDEV」的行为
      // 泄漏进这个文件里后面的测试——它们各自 seed 的路径当然不会撞上
      // 这次的 deviceFile，但显式还原更清楚，不留隐患。
      renameMock.mockImplementation(actualFs.renameSync);
    }
  });

  // 复现 Important 1：核心数据（tasks/inbox/proposals）早就迁移过、meta.json
  // 已经是当前 schemaVersion，但 settings.json 是升级到这份代码之前留下的，
  // 还没搬走。旧实现把搬家那段放在「已是当前版本就提前返回」之后，这种机器
  // 会永远补不上这次搬家——代码从此只读 device.json，data/settings.json 会
  // 一直骗人躺在那儿，而且用户特意关掉的 autoExpand/webhook/通知会静默回落
  // 成 DEFAULT_SETTINGS（因为 device.json 从来没被写出来过）。
  it('meta.json 已经是当前版本、但 settings.json 还没搬走时，这次 migrate() 也要把它补搬走——不能因为「核心数据已经迁移过」就放弃', () => {
    process.env.DEVICE_CONFIG = join(dir, '_device', 'device.json');
    const deviceFile = deviceConfigPath();
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION }), 'utf8');
    const settings = { webhookUrl: 'y', toastEnabled: false, autoExpand: false, autoExpandDelaySec: 30 };
    seed('settings.json', settings);

    const result = migrate(dir);

    // 核心数据的迁移语义不变：没有 tasks/inbox/proposals 要搬，`migrated`
    // 照样是 false——这次补搬 settings 是个旁路副作用，不该假装成一次
    // 「真的迁移」。
    expect(result.migrated).toBe(false);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(existsSync(deviceFile)).toBe(true);
    expect(JSON.parse(readFileSync(deviceFile, 'utf8'))).toEqual(settings);
  });
});

/**
 * 「开始时间」是后加的字段：老数据里没有。升级要把它补成 `null`
 * （= 随时可以做，也正是加这个字段之前的行为），不能留 undefined ——
 * 那会让下游每一处都得自己兜底一次。
 */
describe('upgradeTask：startAt', () => {
  it('老数据没这个字段 → null', () => {
    const t = upgradeTask({ id: 'a', title: '旧任务' });
    expect(t.startAt).toBeNull();
  });

  it('已经有了就原样带过来（幂等）', () => {
    const t = upgradeTask({ id: 'a', title: 'x', startAt: '2026-09-01T00:00:00.000Z' });
    expect(t.startAt).toBe('2026-09-01T00:00:00.000Z');
    expect(upgradeTask(t as unknown as Record<string, unknown>).startAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('手改文件里写个不是字符串的东西 → null，不原样传下去', () => {
    expect(upgradeTask({ id: 'a', title: 'x', startAt: 123 }).startAt).toBeNull();
    expect(upgradeTask({ id: 'a', title: 'x', startAt: {} }).startAt).toBeNull();
  });
});
