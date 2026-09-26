import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { writeImportBackup, ensureDataFiles, newTask, readTasks, readSettings, writeInbox, writeLists, writeSettings, writeTasks } from './store.js';
import { IMPORT_KEYS, checkKeysAndIds, checkShapes, applyImport } from './import.js';
import type { DataTableKey } from './import.js';
import type { Settings } from './model.js';
import { DEFAULT_SETTINGS } from './model.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'todo-import-')); process.env.DATA_DIR = dir; ensureDataFiles(); });
afterEach(() => { delete process.env.DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

describe('writeImportBackup', () => {
  it('落到 data/imports/ 下，文件名 import-backup-<YYYYMMDD-HHmmss>.json，内容原样', () => {
    const name = writeImportBackup('{"tasks":[]}');
    expect(name).toMatch(/^import-backup-\d{8}-\d{6}\.json$/);
    const p = join(dir, 'imports', name);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('{"tasks":[]}');
  });
  it('目录不存在也能写（自己 recursive mkdir）', () => {
    expect(existsSync(join(dir, 'imports'))).toBe(false);
    writeImportBackup('{}');
    expect(existsSync(join(dir, 'imports'))).toBe(true);
  });
});

const goodTask = (id: string) => ({ id }); // 九键阶段不看形状，Task 5 才看
const payloadOf = (over: Record<string, unknown> = {}) => ({
  inbox: [], tasks: [], settings: {}, proposals: [], lists: [],
  folders: [], countdowns: [], insights: [], trash: [], ...over,
});

describe('checkKeysAndIds', () => {
  it('九个键齐全通过，counts 报八张表的条数', () => {
    const r = checkKeysAndIds(payloadOf({ tasks: [goodTask('a')] }));
    expect(r.ok && r.counts.tasks).toBe(1);
    expect(IMPORT_KEYS.length).toBe(8);
  });
  it('缺一个键：点名是哪个，拒', () => {
    const p = payloadOf() as Record<string, unknown>; delete p.countdowns;
    const r = checkKeysAndIds(p);
    expect(!r.ok && r.error).toContain('countdowns');
  });
  it('settings 不是对象 / 八张表里有一张不是数组：都拒', () => {
    expect(checkKeysAndIds(payloadOf({ settings: [] })).ok).toBe(false);
    expect(checkKeysAndIds(payloadOf({ lists: {} })).ok).toBe(false);
  });
  it('表内 id 重复拒；`..`/斜杠 id 拒；只差大小写的两个 id 拒', () => {
    expect(checkKeysAndIds(payloadOf({ tasks: [goodTask('a'), goodTask('a')] })).ok).toBe(false);
    expect(checkKeysAndIds(payloadOf({ tasks: [goodTask('a/b')] })).ok).toBe(false);
    expect(checkKeysAndIds(payloadOf({ tasks: [goodTask('a..b')] })).ok).toBe(false);
    const r = checkKeysAndIds(payloadOf({ tasks: [goodTask('foo'), goodTask('Foo')] }));
    expect(!r.ok && r.error).toContain('大小写');
  });
  it('顶层不是对象（数组、null、字符串）拒，不抛', () => {
    expect(checkKeysAndIds(null).ok).toBe(false);
    expect(checkKeysAndIds([]).ok).toBe(false);
    expect(checkKeysAndIds('x').ok).toBe(false);
  });
});

const ISO = '2026-08-01T00:00:00.000Z';
// 31 个字段全给——就是 model.ts 里 Task interface 的整张字段表，一行不少。
// 导入是「原样恢复用户自己的数据」，形状校验必须认下盘上真实存在的每一格。
const fullTask = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: 'x', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: ISO, updatedAt: ISO, order: null, listId: null, section: null, tags: [],
  priority: 0, repeat: null, completedAt: null, postponeCount: 0, waitingFor: null,
  context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false,
  pinned: false, reviewedAt: null, parentId: null, ...over,
});
const wrap = (tasks: unknown[]) => ({
  inbox: [], tasks, settings: {}, proposals: [], lists: [], folders: [],
  countdowns: [], insights: [], trash: [],
});

describe('checkShapes', () => {
  it('完整任务通过；整表恢复不挑状态（doing/later/abandoned/done 都合法）', () => {
    expect(checkShapes(wrap([fullTask()])).ok).toBe(true);
    for (const s of ['doing', 'later', 'abandoned', 'done']) {
      expect(checkShapes(wrap([fullTask({ status: s })])).ok).toBe(true);
    }
  });
  it('坏 status（中文）/ 坏 createdAt（"下周三"）/ reminders 缺 at：都拒', () => {
    expect(checkShapes(wrap([fullTask({ status: '进行中' })])).ok).toBe(false);
    expect(checkShapes(wrap([fullTask({ createdAt: '下周三' })])).ok).toBe(false);
    expect(checkShapes(wrap([fullTask({ reminders: [{ firedAt: null }] })])).ok).toBe(false);
  });
  it('导入不归零强字段：order/priority/pinned/completedAt 原样给就原样过', () => {
    const r = checkShapes(wrap([fullTask({ order: 3, priority: 2, pinned: true, completedAt: ISO, status: 'done' })]));
    expect(r.ok).toBe(true);
  });
  it('inbox 的 processed 非布尔拒；insights 的 kind 不认识拒；countdowns 缺 updatedAt 拒', () => {
    const inbox = [{ id: 'i1', text: 'x', createdAt: ISO, processed: 'yes', taskIds: [] }];
    expect(checkShapes({ ...wrap([]), inbox }).ok).toBe(false);
    const insights = [{ id: 'n1', kind: 'vibes', text: 'x', taskIds: [], createdAt: ISO, dismissedAt: null }];
    expect(checkShapes({ ...wrap([]), insights }).ok).toBe(false);
    const countdowns = [{ id: 'c1', title: 'x', date: '2026-12-31', yearly: false, lunar: false, createdAt: ISO }];
    expect(checkShapes({ ...wrap([]), countdowns }).ok).toBe(false);
  });
  it('trash：带 deletedAt 的完整任务通过，缺 deletedAt 拒', () => {
    expect(checkShapes({ ...wrap([]), trash: [fullTask({ deletedAt: ISO })] }).ok).toBe(true);
    expect(checkShapes({ ...wrap([]), trash: [fullTask()] }).ok).toBe(false);
  });
  it('位置点名：第二条任务坏，error 里带 tasks[1]', () => {
    const r = checkShapes(wrap([fullTask(), fullTask({ id: 't2', status: '进行中' })]));
    expect(!r.ok && r.error).toContain('tasks[1]');
  });
});

type Row = { id: string };
const mkDeps = (init: Partial<Record<DataTableKey, Row[]>> = {}) => {
  const tables: Record<DataTableKey, Row[]> = {
    inbox: [], tasks: [], proposals: [], lists: [], folders: [], countdowns: [], insights: [], trash: [],
  };
  for (const [k, v] of Object.entries(init)) tables[k as DataTableKey] = v as Row[];
  const backups: string[] = [];
  const failOn = new Set<DataTableKey>();
  return {
    deps: {
      readTable: (k: DataTableKey) => tables[k],
      writeTable: (k: DataTableKey, rows: unknown[]) => {
        if (failOn.has(k)) throw new Error(`模拟落盘失败：${k}`);
        tables[k] = rows as Row[];
      },
      readSettings: () => ({ ...DEFAULT_SETTINGS }),
      writeSettings: (_s: Settings) => {},
      writeBackup: (json: string) => { backups.push(json); return 'import-backup-test.json'; },
    },
    tables, backups, failOn,
  };
};
const nineKeys = (over: Partial<Record<DataTableKey, unknown[]>> = {}) => ({
  settings: {}, ...Object.fromEntries(IMPORT_KEYS.map((k) => [k, []])), ...over,
});

describe('applyImport', () => {
  it('九张表整表换成 payload，返回计数与备份文件名', () => {
    const m = mkDeps({ tasks: [{ id: 'old' }] });
    const r = applyImport(nineKeys({ tasks: [{ id: 'new1' }, { id: 'new2' }] }) as never, m.deps);
    expect(r.backupFile).toBe('import-backup-test.json');
    expect(r.counts.tasks).toBe(2);
    expect(m.tables.tasks).toEqual([{ id: 'new1' }, { id: 'new2' }]);
  });
  it('备份文件在动手之前写好，且内容是「替换前」的九表快照', () => {
    const m = mkDeps({ tasks: [{ id: 'old' }] });
    applyImport(nineKeys({ tasks: [{ id: 'new' }] }) as never, m.deps);
    const snap = JSON.parse(m.backups[0]);
    expect(snap.tasks).toEqual([{ id: 'old' }]);
    expect(m.backups.length).toBe(1);
  });
  it('第 N 张表写失败：前面写过的表全部回滚到快照，错误照抛', () => {
    const m = mkDeps({ tasks: [{ id: 'oldT' }], lists: [{ id: 'oldL' }] });
    m.failOn.add('lists');
    expect(() => applyImport(nineKeys({ tasks: [{ id: 'newT' }], lists: [{ id: 'newL' }] }) as never, m.deps)).toThrow();
    expect(m.tables.tasks).toEqual([{ id: 'oldT' }]); // tasks 排在 lists 前且已换成新的——必须被回滚
    expect(m.tables.lists).toEqual([{ id: 'oldL' }]);
  });

  it('回滚备份写不下去：一张表都不碰，错误标成「数据未动」', () => {
    const m = mkDeps({ tasks: [{ id: 'old' }] });
    const deps = { ...m.deps, writeBackup: () => { throw new Error('磁盘满了'); } };
    let caught: (Error & { dataUntouched?: boolean }) | undefined;
    try {
      applyImport(nineKeys({ tasks: [{ id: 'new' }] }) as never, deps);
    } catch (e) {
      caught = e as Error & { dataUntouched?: boolean };
    }
    expect(caught?.message).toBe('磁盘满了');
    expect(caught?.dataUntouched).toBe(true); // 路由靠它选「导入没有开始」那句，不混「已回滚」
    expect(m.tables.tasks).toEqual([{ id: 'old' }]);
    expect(m.backups).toHaveLength(0);
  });
});

describe('POST /api/import（真 app）', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-import-app-'));
    process.env.DATA_DIR = dir;
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
    app = createApp();
  });
  afterEach(() => { delete process.env.DATA_DIR; delete process.env.DEVICE_CONFIG; rmSync(dir, { recursive: true, force: true }); });
  const postImport = (payload: unknown) =>
    app.request('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  it('往返：造数据 → GET 拼导出 → 清空 → 导入 → 逐条相等（强字段原样）', async () => {
    const t = newTask({ title: '有主的任务', order: 3, priority: 2, pinned: true, status: 'done', completedAt: '2026-09-01T00:00:00.000Z', reviewedAt: '2026-09-02T00:00:00.000Z' });
    writeTasks([t]);
    writeLists([{ id: 'L1', name: '清单', color: '#000', folderId: null, order: 0, archived: false, filter: null }]);
    const nine: Record<string, unknown> = { settings: await (await app.request('/api/settings')).json() };
    for (const k of IMPORT_KEYS) nine[k] = (await (await app.request(`/api/${k}`)).json()) as unknown;
    // 先导空（把 tasks 清掉），再把整份九键导回来
    const cleared = await postImport({ ...nine, tasks: [] });
    expect(cleared.status).toBe(200);
    expect(readTasks()).toHaveLength(0);
    const back = await postImport(nine);
    expect(back.status).toBe(200);
    const got = readTasks();
    expect(got).toHaveLength(1);
    expect(got[0].order).toBe(3);
    expect(got[0].priority).toBe(2);
    expect(got[0].pinned).toBe(true);
    expect(got[0].completedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(got[0].reviewedAt).toBe('2026-09-02T00:00:00.000Z');
    expect((await (await app.request('/api/lists')).json())).toEqual([expect.objectContaining({ id: 'L1' })]);
  });

  it('校验不过：400 带表名序号，且 data/ 与 device.json 一字未动', async () => {
    writeInbox([{ id: 'i1', text: '原有', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }]);
    // 先经 PUT 落一份真 device.json，让「设置一字未动」可被字节比对
    await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ focusMinutes: 45 }) });
    const before = readFileSync(join(dir, 'inbox', 'i1.json'), 'utf8');
    const devBefore = readFileSync(join(dir, 'device.json'), 'utf8');
    const res = await postImport({
      inbox: [{ id: 'a..b', text: 'x', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }],
      tasks: [], settings: { focusMinutes: 99 }, proposals: [], lists: [], folders: [], countdowns: [], insights: [], trash: [],
    });
    expect(res.status).toBe(400);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain('inbox[0]');
    expect(err).toContain('当前数据未做任何改动'); // 承诺要跟着 400 一起上屏（spec §4）
    expect(readFileSync(join(dir, 'inbox', 'i1.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'device.json'), 'utf8')).toBe(devBefore);
    expect(existsSync(join(dir, 'imports'))).toBe(false); // 校验失败连回滚快照都不该产生
  });

  it('成功导入后 data/imports/ 里躺着可再导回去的快照', async () => {
    const empty = JSON.parse(JSON.stringify(Object.fromEntries([...IMPORT_KEYS.map((k) => [k, []]), ['settings', {}]])));
    const res = await postImport(empty);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backupFile: string };
    expect(body.ok).toBe(true);
    expect(existsSync(join(dir, 'imports', body.backupFile))).toBe(true);
    // 快照形状就是可导入的九键 payload
    const snap = JSON.parse(readFileSync(join(dir, 'imports', body.backupFile), 'utf8'));
    expect(checkKeysAndIds(snap).ok).toBe(true);
  });

  it('回滚备份写不下去（data/imports 被文件占着）：500 说「导入没有开始」，表一字未动', async () => {
    writeTasks([newTask({ title: '原任务' })]);
    writeFileSync(join(dir, 'imports'), '被占了'); // mkdirSync 会 EEXIST——比伪造磁盘满更真的路
    const empty = Object.fromEntries([...IMPORT_KEYS.map((k) => [k, []]), ['settings', {}]]);
    const res = await postImport(empty);
    expect(res.status).toBe(500);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain('导入没有开始');
    expect(err).not.toContain('已回滚'); // 什么都没动过，就不许说「回滚」
    expect(readTasks()).toHaveLength(1);
  });

  /**
   * 换机的主场景：备份里必须带得动 AI 密钥。走的是导出端点的明文形状——
   * 若拿普通 GET 的打码串，`aiKeyFrom` 在空机器上会把那串星号存成「真值」，
   * 新机器第一次拆解才以 401 现形（这正是 2026-09-26 拍板掀开明文的原因）。
   */
  it('换机往返：导出端点给明文密钥，导入到空机器后真密钥落地', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    const nine: Record<string, unknown> = { settings: await (await app.request('/api/settings/export')).json() };
    for (const k of IMPORT_KEYS) nine[k] = (await (await app.request(`/api/${k}`)).json()) as unknown;
    // 模拟新机器：设置从零开始
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: '' });
    const res = await postImport(nine);
    expect(res.status).toBe(200);
    expect(readSettings().aiKey).toBe('sk-abcdefghijkl');
  });
});
