import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { ALLOWED_ORIGINS, API_VERSION, createApp } from './app.js';
import { Bus } from './events.js';
import * as store from './store.js';
import { DEFAULT_SETTINGS, ensureDataFiles, newTask, nowIso, paths, readInbox, readInsights, readProposals, readTasks, readTrash, writeInbox, writeLists, writeTrash, writeInsights, writeProposals, writeSettings, writeTasks, type Repeat, type Settings, type Task, type InboxItem, type Proposal } from './store.js';
import { listConflicts } from './entityStore.js';
import type { PushResponse } from './push.js';
import type { Spawner } from './expand.js';
import { MAX_ATTACHMENT_BYTES, listAttachments, resolveAttachment } from './attachments.js';

// POST /api/desktop/notify-failed 会经 reminder.ts 的 toastRaw() 走
// execFile('powershell', ...)——测试环境里没有 PowerShell 可执行。mock 掉，
// 跟 reminder.test.ts 是同一套做法（importOriginal 透传，别的测试用不到
// child_process 的别的导出，但保留总比整个替换掉安全）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)),
  };
});

let dir: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-app-'));
  process.env.DATA_DIR = dir;
  // 设置现在存在设备本地，不指到临时目录的话 PUT /api/settings 会落到这台
  // 机器真实的平台惯例位置（比如 %APPDATA%\shiye\device.json）。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
  ensureDataFiles();
  app = createApp();
});

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.DEVICE_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);
const del = (path: string) => app.request(path, { method: 'DELETE' });
const upload = (path: string, filename: string, bytes: Uint8Array<ArrayBuffer> | string, type = 'text/plain') => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  return app.request(path, { method: 'POST', body: form });
};

describe('health', () => {
  it('回 ok:true —— 端口占用检查靠它认出「占着的是我自己」', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: API_VERSION });
  });
});

describe('CORS：只放行手机 WebView 的两个 origin', () => {
  it('白名单固定是 capacitor://localhost 和 http://localhost，不是别的、不是 *', () => {
    expect(ALLOWED_ORIGINS).toEqual(['capacitor://localhost', 'http://localhost']);
  });

  it('桌面同源请求（没有 Origin 头）——上限断言：一个 CORS 头都不该多出来', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    // body 也照旧，不是只有头没变——CORS 中间件完全没有参与这次请求。
    expect(await res.json()).toEqual({ ok: true, version: API_VERSION });
  });

  for (const origin of ALLOWED_ORIGINS) {
    it(`白名单 origin ${origin}：回 Access-Control-Allow-Origin 精确等于它`, async () => {
      const res = await app.request('/api/health', { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('vary')).toBe('Origin');
    });
  }

  it('不在白名单里的 origin（第三方网页）——不给 Access-Control-Allow-Origin，不是宽松放行', async () => {
    const res = await app.request('/api/health', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // 没命中白名单的请求整个绕开 cors() 中间件，连 Vary 都不该多出来。
    expect(res.headers.get('vary')).toBeNull();
  });

  it('桌面写请求带同源 Origin（浏览器对非 GET 一定会带）——照样一个 CORS 头都不多（I4，final-review.md）', async () => {
    // 只有同源 GET/HEAD 不带 Origin 头，之前那条「桌面同源请求」测试用的是 GET，
    // 只覆盖了「不带 Origin」这一种情况。这条钉住「PORT=80 时桌面同源 origin 恰好
    // 撞上白名单里没带端口的 http://localhost」这个已知边界不会扩大：写请求带着
    // 同源 Origin，也不该多出任何 CORS 头。
    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { origin: 'http://localhost:30035', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });

  it('手机预检（OPTIONS）命中白名单 origin：204，带上允许的方法', async () => {
    const res = await app.request('/api/tasks', {
      method: 'OPTIONS',
      headers: {
        origin: 'capacitor://localhost',
        'Access-Control-Request-Method': 'PATCH',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
  });
});

// 桌面端「在线」（SSE 连接活着）不等于它自己的 Electron 通知真的弹出来了——
// 这条路由是它弹失败时的上报口，服务端就地补发一条 PowerShell。这条不依赖
// bus，用不到 createApp(bus)，走的是顶层 beforeEach 建的那个 app。
describe('POST /api/desktop/notify-failed', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear();
  });

  it('title/body 齐全 → 起一次 PowerShell，标题/正文原样传给 toast.ps1', async () => {
    const res = await post('/api/desktop/notify-failed', { title: '交房租', body: '该做这件事了' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args as string[]).toContain('交房租');
    expect(args as string[]).toContain('该做这件事了');
  });

  it('title 缺失或全是空白 → 400，不起 PowerShell', async () => {
    const res = await post('/api/desktop/notify-failed', { title: '   ', body: 'x' });

    expect(res.status).toBe(400);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('body 缺失也能起（用空字符串兜底，toastRaw 不会因为缺 body 就拒收）', async () => {
    const res = await post('/api/desktop/notify-failed', { title: '交房租' });

    expect(res.status).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

describe('收件箱', () => {
  it('POST 落盘，GET 读回来', async () => {
    const res = await post('/api/inbox', { text: '  下周要交季度总结  ' });
    expect(res.status).toBe(201);
    const item = (await res.json()) as InboxItem;
    expect(item.text).toBe('下周要交季度总结');   // 首尾空白去掉
    expect(item.processed).toBe(false);
    expect(item.taskIds).toEqual([]);

    const all = (await (await app.request('/api/inbox')).json()) as InboxItem[];
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(item.id);
  });

  it('空文本拒掉 —— 回车误触不该在收件箱里留一条空记录', async () => {
    expect((await post('/api/inbox', { text: '   ' })).status).toBe(400);
    expect((await post('/api/inbox', {})).status).toBe(400);
    expect((await app.request('/api/inbox')).status).toBe(200);
    expect((await (await app.request('/api/inbox')).json()) as InboxItem[]).toHaveLength(0);
  });

  it('PATCH 标已处理并回填 taskIds', async () => {
    const item = (await (await post('/api/inbox', { text: 'x' })).json()) as InboxItem;
    const res = await patch(`/api/inbox/${item.id}`, { processed: true, taskIds: ['t1', 't2'] });
    expect(res.status).toBe(200);
    const after = (await res.json()) as InboxItem;
    expect(after.processed).toBe(true);
    expect(after.taskIds).toEqual(['t1', 't2']);
  });

  it('PATCH 把 processed 从 true 改回 false，taskIds 原样保留 —— 「重新拆解」按钮走这条', async () => {
    const item = (await (await post('/api/inbox', { text: 'x' })).json()) as InboxItem;
    await patch(`/api/inbox/${item.id}`, { processed: true, taskIds: ['t1'] });
    const after = (await (await patch(`/api/inbox/${item.id}`, { processed: false })).json()) as InboxItem;
    expect(after.processed).toBe(false);
    expect(after.taskIds).toEqual(['t1']);
  });

  it('DELETE 删掉；删不存在的回 404', async () => {
    const item = (await (await post('/api/inbox', { text: 'x' })).json()) as InboxItem;
    expect((await app.request(`/api/inbox/${item.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await (await app.request('/api/inbox')).json()) as InboxItem[]).toHaveLength(0);
    expect((await app.request('/api/inbox/不存在', { method: 'DELETE' })).status).toBe(404);
  });

  it('PATCH text：未处理的条目能改，同一套判据（非空、首尾去空白）', async () => {
    const item = (await (await post('/api/inbox', { text: '原文' })).json()) as InboxItem;
    const res = await patch(`/api/inbox/${item.id}`, { text: '  改过的文字  ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as InboxItem).text).toBe('改过的文字');
    expect(readInbox()[0].text).toBe('改过的文字');
  });

  it('PATCH text：空文本（或纯空白）拒掉，跟 POST 一样', async () => {
    const item = (await (await post('/api/inbox', { text: '原文' })).json()) as InboxItem;
    const res = await patch(`/api/inbox/${item.id}`, { text: '   ' });
    expect(res.status).toBe(400);
    expect(readInbox()[0].text).toBe('原文');   // 没有被改动
  });

  it('PATCH text：已处理的条目改文字被拒——判据只在服务端这一处，不是前端挡出来的', async () => {
    const item = (await (await post('/api/inbox', { text: '原文' })).json()) as InboxItem;
    await patch(`/api/inbox/${item.id}`, { processed: true, taskIds: ['t1'] });

    const res = await patch(`/api/inbox/${item.id}`, { text: '想改但改不了' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/重新拆解/);
    expect(readInbox()[0].text).toBe('原文');   // 没有被改动
  });
});

describe('任务', () => {
  it('POST 建任务，默认 source 是 user', async () => {
    const res = await post('/api/tasks', { title: '写周报' });
    expect(res.status).toBe(201);
    const t = (await res.json()) as Task;
    expect(t.title).toBe('写周报');
    expect(t.status).toBe('todo');
    expect(t.source).toBe('user');
    expect(readTasks()).toHaveLength(1);
  });

  it('标题为空拒掉', async () => {
    expect((await post('/api/tasks', { title: '  ' })).status).toBe(400);
  });

  // 这条专门打在 checkTaskPatch 之后、newTask 之前那道单独的必填检查上——
  // 跟上面「标题为空拒掉」不是同一道防线：{title:'  '} 会在 checkTaskPatch
  // 自己的 title 形状校验（trim 后是空串）那一步就被拦下，根本走不到这道单独
  // 检查。这里发的请求体压根不带 title 这个键，checkTaskPatch 只校验「给出的
  // 字段」，对没给的字段不管，会 ok:true 放过，必须靠这道单独的必填检查才能拦住。
  it('完全不给 title 键（不是空字符串）—— 照样被挡在「新建任务必须有标题」这道单独检查上', async () => {
    const res1 = await post('/api/tasks', {});
    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as { error: string; field?: string };
    expect(body1.error).toBe('标题不能为空');
    expect(body1.field).toBe('title');

    const res2 = await post('/api/tasks', { notes: '只带了 notes，没带 title' });
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: string; field?: string };
    expect(body2.error).toBe('标题不能为空');
    expect(body2.field).toBe('title');

    expect(readTasks()).toHaveLength(0);   // 两次都没有任务落地
  });

  it('POST 字段形状不对（不是标题缺失）时 400 也说得出是哪个字段——两处 400 都要接上原因，不是只有 PATCH 那一处', async () => {
    const res = await post('/api/tasks', { title: '写周报', status: 'pending' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toContain('status');
    expect(body.field).toBe('status');
    expect(readTasks()).toHaveLength(0);
  });

  it('PATCH 改状态，updatedAt 跟着走', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { status: 'doing' });
    const after = (await res.json()) as Task;
    expect(after.status).toBe('doing');
    expect(after.createdAt).toBe(t.createdAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(t.updatedAt));
  });

  it('非法状态拒掉，不写进文件', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    expect((await patch(`/api/tasks/${t.id}`, { status: '随便什么' })).status).toBe(400);
    expect(readTasks()[0].status).toBe('todo');
  });

  it('PATCH 字段不合法时 400 说得出是哪个字段、为什么', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { status: 'pending' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toContain('status');
    expect(body.field).toBe('status');   // 结构化的那一份，给调用方用，不用从 error 里抠字符串
    // I3：这条走的是 checkTaskPatch 共用的文案，四个值对人经网页发起的
    // PATCH 都合法（包括 later），跟 outbox.ts 里专门给 AI 看的版本不是
    // 同一句——见 outbox.test.ts「status 校验失败的横幅不把 later 列成选项」。
    expect(body.error).toContain('later');
  });

  it('合法的 PATCH 照常 200——这次改动不能让本来能通过的请求开始 400', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { status: 'doing' });
    expect(res.status).toBe(200);
  });

  it("新任务默认 order 是 null（排在「今天」视图末尾，直到被手动排过序）", async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    expect(t.order).toBeNull();
  });

  it("PATCH 能把 status 改成 'later'（搁置）——这条只对人经网页发起的请求开放，AI 走 outbox 那条路会被挡，见 outbox.test.ts", async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { status: 'later' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).status).toBe('later');
  });

  it('PATCH 能设置 order——通用能力，改一个数字；「今天」的手动排序走批量的 PATCH /api/tasks/reorder，见下面那个 describe', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { order: 3 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).order).toBe(3);

    const cleared = await patch(`/api/tasks/${t.id}`, { order: null });
    expect(((await cleared.json()) as Task).order).toBeNull();
  });

  it('order 传非数字、非 null 的值拒掉，不写进文件', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    expect((await patch(`/api/tasks/${t.id}`, { order: '第一' })).status).toBe(400);
    expect(readTasks()[0].order).toBeNull();
  });

  it('id / createdAt 改不动 —— 客户端传了也不采纳', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    const after = (await (await patch(`/api/tasks/${t.id}`, { id: '篡改', createdAt: '2000-01-01T00:00:00.000Z' })).json()) as Task;
    expect(after.id).toBe(t.id);
    expect(after.createdAt).toBe(t.createdAt);
  });

  it('改了提醒时间就清掉「已提醒」的章 —— 否则改期之后永远不会再提醒', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: '2026-08-01T00:00:05.000Z' }],
    })]);
    const id = readTasks()[0].id;
    // 网页发上来的永远是整个数组，firedAt 客户端总写 null——服务端要自己
    // 按时刻（这里换了个新时刻）判断该不该沿用旧的章。
    const after = (await (await patch(`/api/tasks/${id}`, {
      reminders: [{ at: '2026-09-01T00:00:00.000Z', firedAt: null }],
    })).json()) as Task;
    expect(after.reminders[0].firedAt).toBeNull();
  });

  it('提醒时刻没变时「已提醒」的章要留着', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: '2026-08-01T00:00:05.000Z' }],
    })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, {
      reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: null }],
    })).json()) as Task;
    expect(after.reminders[0].firedAt).toBe('2026-08-01T00:00:05.000Z');
  });

  it('没动 reminders 时原样保留（含已提醒的章）', async () => {
    writeTasks([newTask({ title: 'x', reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: '2026-08-01T00:00:05.000Z' }] })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, { status: 'doing' })).json()) as Task;
    expect(after.reminders[0].firedAt).toBe('2026-08-01T00:00:05.000Z');
  });

  it('从「搁置」恢复待办（status: later -> todo）清掉 order——不然带着一个几天前排过的老位置回到「今天」，会跟当前占着那个位置的卡撞车，見 taskView.ts applyMove 的注释', async () => {
    writeTasks([newTask({ title: '搁置的', status: 'later', order: 3 })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, { status: 'todo' })).json()) as Task;
    expect(after.order).toBeNull();
  });

  it('从「已完成」重开（status: done -> todo）同样清掉 order', async () => {
    writeTasks([newTask({ title: '做完的', status: 'done', order: 0 })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, { status: 'todo' })).json()) as Task;
    expect(after.order).toBeNull();
  });

  it('恢复待办这一次 PATCH 如果同时显式给了 order，尊重调用方给的值，不覆盖', async () => {
    writeTasks([newTask({ title: '搁置的', status: 'later', order: 3 })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, { status: 'todo', order: 5 })).json()) as Task;
    expect(after.order).toBe(5);
  });

  it('doing -> todo（退回）不是从「今天」之外恢复的，不清 order——这两个状态本来就都在「今天」里', async () => {
    writeTasks([newTask({ title: '退回的', status: 'doing', order: 2 })]);
    const id = readTasks()[0].id;
    const after = (await (await patch(`/api/tasks/${id}`, { status: 'todo' })).json()) as Task;
    expect(after.order).toBe(2);
  });

  it('DELETE 删掉；删不存在的回 404', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    expect((await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(readTasks()).toHaveLength(0);
    expect((await app.request('/api/tasks/不存在', { method: 'DELETE' })).status).toBe(404);
  });

  it('DELETE 清掉所有收件箱条目里指向它的 taskIds，别的引用不受影响', async () => {
    const t1 = (await (await post('/api/tasks', { title: 'a' })).json()) as Task;
    const t2 = (await (await post('/api/tasks', { title: 'b' })).json()) as Task;
    writeInbox([
      { id: 'i1', text: 'x', createdAt: nowIso(), processed: true, taskIds: [t1.id, t2.id] },
      { id: 'i2', text: 'y', createdAt: nowIso(), processed: true, taskIds: [t2.id] },
    ]);

    expect((await app.request(`/api/tasks/${t1.id}`, { method: 'DELETE' })).status).toBe(200);

    const inbox = readInbox();
    expect(inbox.find((x) => x.id === 'i1')?.taskIds).toEqual([t2.id]);   // 删掉的那个不见了
    expect(inbox.find((x) => x.id === 'i2')?.taskIds).toEqual([t2.id]);   // 没引用过它的条目原样不动
  });

  it('完成一条重复任务会多出下一条；再 PATCH 一次不会再多', async () => {
    // nextInstance 的「跳过已过期周期」循环拿的是真实系统时钟（路由里
    // `new Date()`）——born.due 是不是 2026-08-17 取决于测试跑的那天离
    // 2026-08-10 这个基准 due 有没有超过一个周（7 天）。钉住系统时间，
    // 这条断言才不会在 2026-08-17 之后自己变红。跟下面「自动拆解调度」
    // 那个 describe 同一套写法：try/finally 保证 useRealTimers 一定收尾。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
    try {
      const created = await (await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })).json();
      await patch(`/api/tasks/${created.id}`, { repeat: { every: 'week', interval: 1 } });

      await patch(`/api/tasks/${created.id}`, { status: 'done' });
      const after = await (await get('/api/tasks')).json();
      expect(after).toHaveLength(2);
      const born = after.find((t: { id: string }) => t.id !== created.id)!;
      expect(born.status).toBe('todo');
      expect(born.due).toBe('2026-08-17T09:00:00.000Z');

      // done → done（改个不相关的字段）不再生成。这一条是「上限方向」的
      // 守卫：只有正向断言的话，「每次 PATCH 都生成一条」这种实现照样能
      // 过上面那几句。
      await patch(`/api/tasks/${created.id}`, { notes: '补一句' });
      expect(await (await get('/api/tasks')).json()).toHaveLength(2);

      // 真正把「done → done」这句话测到：显式再 PATCH 一次 status:'done'。
      // 上面那句 notes 的 patch 不带 status，两种实现（判断 all[i].status
      // !== 'done'，或者错判成 patch.status === 'done'）在那句上结果一样，
      // 分不出对错；这句 patch.status 是 'done'，只有真的按「跃迁」判断
      // 的实现才会正确地不再生成。
      await patch(`/api/tasks/${created.id}`, { status: 'done' });
      expect(await (await get('/api/tasks')).json()).toHaveLength(2);

      // ……但上面那句其实**测不到跃迁守卫**：守卫写错的话确实会算出一个候选，
      // 而下面那道查重（同标题同 due 且未完成就不生成）会把它挡掉，两种实现
      // 结果一样。要分开这两道保险，得先把生成出来的那条挪走——删掉它，
      // 它就进了垃圾箱，查重在 data/tasks/ 里再也找不到同款。这时候只有
      // 真正按「跃迁」判断的实现才会克制住不再生成。
      await del(`/api/tasks/${born.id}`);
      expect(await (await get('/api/tasks')).json()).toHaveLength(1);

      await patch(`/api/tasks/${created.id}`, { status: 'done' });
      expect(await (await get('/api/tasks')).json()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeat.interval 大到让日历计算溢出 Date 范围（比如手滑写了 99999999）——完成任务不该 500，也不该卡在 todo 上永远完不成', async () => {
    const created = await (await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })).json();
    await patch(`/api/tasks/${created.id}`, { repeat: { every: 'day', interval: 99999999 } });

    const res = await patch(`/api/tasks/${created.id}`, { status: 'done' });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Task;
    expect(after.status).toBe('done');
    expect(await (await get('/api/tasks')).json()).toHaveLength(1);   // 没有多出一条溢出的「下一条」
  });

  it('取消完成再完成一次（done → todo → done）不会多生成一条重复实例——用户只完成过一次', async () => {
    const created = await (await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })).json();
    await patch(`/api/tasks/${created.id}`, { repeat: { every: 'week', interval: 1 } });

    await patch(`/api/tasks/${created.id}`, { status: 'done' });
    expect(await (await get('/api/tasks')).json()).toHaveLength(2);   // 生成了下一条

    // 点错了，撤销一下，再完成一次——这是个正常路径，不是刻意刁难。
    await patch(`/api/tasks/${created.id}`, { status: 'todo' });
    await patch(`/api/tasks/${created.id}`, { status: 'done' });
    expect(await (await get('/api/tasks')).json()).toHaveLength(2);   // 还是 2，不是 3
  });

  it('正常的连续两个周期（完成一条 → 完成它新生成的那条）仍然各自生成下一条——查重不会把正常路径也堵了', async () => {
    const created = await (await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })).json();
    await patch(`/api/tasks/${created.id}`, { repeat: { every: 'week', interval: 1 } });

    await patch(`/api/tasks/${created.id}`, { status: 'done' });
    const afterFirst = await (await get('/api/tasks')).json();
    expect(afterFirst).toHaveLength(2);
    const bornFirst = afterFirst.find((t: { id: string }) => t.id !== created.id)!;

    await patch(`/api/tasks/${bornFirst.id}`, { status: 'done' });
    expect(await (await get('/api/tasks')).json()).toHaveLength(3);   // 第三条：不同的 due，查重不该拦住它
  });

  it('DELETE 没有任何收件箱条目引用它时不重写 inbox —— 避免空转触发目录监听器', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    writeInbox([{ id: 'i1', text: 'y', createdAt: nowIso(), processed: false, taskIds: [] }]);

    // inbox 现在是 entityStore 管的一目录一张表，写入不再产生 .bak（历史版本
    // 交给同步服务，见 entityStore.ts 的注释）。「有没有写」的信号换成直接
    // 数 writeInbox 被调用几次——比 .bak 的存在与否更直接，不用管存储细节。
    const writeInboxSpy = vi.spyOn(store, 'writeInbox');
    writeInboxSpy.mockClear();

    await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' });

    // 没有引用要清，writeInbox 就不该被调用。
    expect(writeInboxSpy).not.toHaveBeenCalled();
    writeInboxSpy.mockRestore();
  });

  it('DELETE 没有任何建议指向它时不重写 proposals —— 避免空转触发目录监听器', async () => {
    const t = (await (await post('/api/tasks', { title: 'x' })).json()) as Task;
    // 建议指向的是别的任务，不是这条要删的——detachDeletedTasks 该判定
    // 「没有引用要清」，跟上面 inbox 那条同一个道理。
    writeProposals([{ id: 'p1', taskId: '不是它', patch: { notes: 'y' }, reason: '理由', createdAt: nowIso() }]);

    const writeProposalsSpy = vi.spyOn(store, 'writeProposals');
    writeProposalsSpy.mockClear();

    await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' });

    // 没有引用要清，writeProposals 就不该被调用。
    expect(writeProposalsSpy).not.toHaveBeenCalled();
    writeProposalsSpy.mockRestore();
  });
});

describe('PATCH /api/tasks/reorder：「今天」手动排序的批量写入口', () => {
  const reorder = (ids: string[]) =>
    app.request('/api/tasks/reorder', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });

  const seed = (over: Array<Partial<Task> & { title: string }> ) => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const tasks = over.map((p) => newTask({ order: null, ...p, createdAt: stamp, updatedAt: stamp }));
    writeTasks(tasks);
    return tasks;
  };

  it('一次写完，只有一次落盘——不是每张卡一次 PATCH，是一次 writeTasks(整份新顺序)', async () => {
    // 用 seed() 的返回值构造重排顺序，不经过 readTasks() 中转——tasks 现在是
    // entityStore.readAll 按文件名（uuid）排序读出来的，跟写入顺序无关，
    // 拿它当「原始顺序」不可靠。
    const [a, b, c] = seed([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

    // tasks 现在是一目录一张表，写入不再产生 .bak（历史版本交给同步服务，
    // 见 entityStore.ts 的注释）。「一次写完不是 N 次读-改-写」这件事换成
    // 直接数 writeTasks 被调用几次——比 .bak 里存的是哪个中间态更直接。
    const writeTasksSpy = vi.spyOn(store, 'writeTasks');
    writeTasksSpy.mockClear();

    const ids = [c.id, b.id, a.id];
    const res = await reorder(ids);
    expect(res.status).toBe(200);

    expect(writeTasksSpy).toHaveBeenCalledTimes(1);
    writeTasksSpy.mockRestore();

    const after = readTasks();
    expect(ids.map((id) => after.find((t) => t.id === id)?.order)).toEqual([0, 1, 2]);
  });

  it('只有 order 真的变了的任务才盖 updatedAt——重排邻居不算「碰过」它', async () => {
    const [a, b, c] = seed([{ title: 'a', order: 0 }, { title: 'b', order: 1 }, { title: 'c', order: 2 }]);
    // 只把 a、b 换位置，c 的 order（2）本来就跟它在新列表里的位置一致，没有变化。
    const res = await reorder([b.id, a.id, c.id]);
    expect(res.status).toBe(200);

    const after = readTasks();
    const byId = (id: string) => after.find((t) => t.id === id)!;
    expect(byId(a.id).order).toBe(1);
    expect(byId(b.id).order).toBe(0);
    expect(byId(a.id).updatedAt).not.toBe(a.updatedAt);
    expect(byId(b.id).updatedAt).not.toBe(b.updatedAt);
    // c 的 order 没变（还是 2），updatedAt 必须原样不动。
    expect(byId(c.id).order).toBe(2);
    expect(byId(c.id).updatedAt).toBe(c.updatedAt);
  });

  it('列表里所有 order 都跟目标一致（没有任何变化）时，整个不写文件', async () => {
    // 同上：用 seed() 的返回值，不经过 readTasks() 中转（读出来的顺序现在
    // 是按 uuid 排的，不是按 order），不然「原样重新提交一次」这个前提本身
    // 就可能不成立。
    const [a, b] = seed([{ title: 'a', order: 0 }, { title: 'b', order: 1 }]);

    const writeTasksSpy = vi.spyOn(store, 'writeTasks');
    writeTasksSpy.mockClear();

    await reorder([a.id, b.id]);

    // 没有变化就不该调 writeTasks——调了的话，即便 entityStore 的 syncAll 会
    // 精确跳过内容没变的实体、不产生真正的磁盘写，也还是白白触发一轮目录
    // 监听器，见 store.ts 和别的路由同款测试。
    expect(writeTasksSpy).not.toHaveBeenCalled();
    writeTasksSpy.mockRestore();
  });

  it('ids 里有已经不存在的任务（比如中途被删了）——那一个跳过，其余照常写，不报错', async () => {
    const [a, b] = seed([{ title: 'a', order: 0 }, { title: 'b', order: 1 }]);
    const res = await reorder(['不存在的id', b.id, a.id]);
    expect(res.status).toBe(200);

    const after = readTasks();
    expect(after.find((t) => t.id === a.id)?.order).toBe(2);
    expect(after.find((t) => t.id === b.id)?.order).toBe(1);
  });

  it('存在的任务但没出现在 ids 里——原样不动，order 和 updatedAt 都不碰', async () => {
    const [a, b, c] = seed([{ title: 'a', order: 5 }, { title: 'b', order: 0 }, { title: 'c', order: 1 }]);
    // 只重排 b、c，a 不在这次可见列表里（比如筛选/视图不同步的边界情况）。
    const res = await reorder([c.id, b.id]);
    expect(res.status).toBe(200);

    const after = readTasks();
    expect(after.find((t) => t.id === a.id)).toEqual(a);   // 整条原样，包括 order:5 这个跟当前列表长度对不上的值
    expect(after.find((t) => t.id === b.id)?.order).toBe(1);
    expect(after.find((t) => t.id === c.id)?.order).toBe(0);
  });

  it('ids 不是字符串数组就拒掉，不写文件', async () => {
    seed([{ title: 'a' }]);
    expect((await reorder(['ok', 1 as unknown as string])).status).toBe(400);
    expect((await app.request('/api/tasks/reorder', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: 'not-an-array' }) })).status).toBe(400);
  });

  it("不会被 PATCH /api/tasks/:id 的 :id 吞掉——请求真的落到了这条专用路由，不是被当成 id='reorder' 去查任务", async () => {
    seed([{ title: 'a' }]);
    const res = await reorder(readTasks().map((t) => t.id));
    const body = await res.json();
    // 落进 :id 那条会因为找不到 id 为 'reorder' 的任务回 404、body 是 {error: '没有这个任务'}。
    expect(res.status).not.toBe(404);
    expect(body).not.toMatchObject({ error: '没有这个任务' });
  });
});

describe('PATCH /api/tasks 与 DELETE /api/tasks：多选之后一起改/删，不发 N 条', () => {
  const J = async (r: Response) => r.json();
  const bulkPatch = (ids: string[], patch: unknown) =>
    app.request('/api/tasks', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, patch }) });
  const bulkDelete = (ids: string[]) =>
    app.request('/api/tasks', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });

  it('批量改状态：三条一起改，返回 updated: 3', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;
    const t3 = await J(await post('/api/tasks', { title: 'c' })) as Task;

    const res = await bulkPatch([t1.id, t2.id, t3.id], { status: 'doing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
    expect(readTasks().every((t) => t.status === 'doing')).toBe(true);
  });

  it('ids 里有找不到的：跳过、不算失败，updated 只数真改到的', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;

    const res = await bulkPatch([t1.id, '不存在的id'], { status: 'doing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });
    expect(readTasks()[0].status).toBe('doing');
  });

  it('patch 不合法时 400，而且说得出是哪个字段——跟单条那条一样精确', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;

    const res = await bulkPatch([t1.id], { status: 'pending' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.field).toBe('status');
    expect(body.error).toContain('status');
    expect(readTasks()[0].status).toBe('todo');   // 没有被改动，校验失败不写盘
  });

  it('ids 不是字符串数组 → 400', async () => {
    expect((await bulkPatch(['ok', 1 as unknown as string], { status: 'doing' })).status).toBe(400);
    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: 'not-an-array', patch: { status: 'doing' } }),
    });
    expect(res.status).toBe(400);
  });

  it('ids 是空数组 → updated: 0，不是 400（上限：不该因为「没选任何东西」就报错）', async () => {
    const res = await bulkPatch([], { status: 'doing' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });
  });

  it('批量改状态只写一次盘——不是每条各一次 writeTasks', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;
    const t3 = await J(await post('/api/tasks', { title: 'c' })) as Task;

    const writeTasksSpy = vi.spyOn(store, 'writeTasks');
    writeTasksSpy.mockClear();

    await bulkPatch([t1.id, t2.id, t3.id], { status: 'doing' });

    expect(writeTasksSpy).toHaveBeenCalledTimes(1);
    writeTasksSpy.mockRestore();
  });

  // C1（final-review.md）：批量「改状态 → 已完成」以前漏了单条 PATCH
  // /api/tasks/:id 那一整段「完成一条重复任务顺手生成下一条」——三条能触发
  // 完成的路径（卡片按钮、看板拖拽、批量条）里，唯一会让重复链条静默断掉的
  // 就是批量这条。修法是把那段判断抽成 maybeSpawnNextInstance，两条路由
  // 共用；这两条测试守住这份共用，不是各自重新验证一遍 nextInstance 本身
  // 的算法（那部分 repeat.test.ts 已经测了）。
  it('批量标完成会生成下一条重复任务——跟单条 PATCH 同一个行为（C1）', async () => {
    // 用真实系统时钟会让这条断言在 2026-08-17 之后自己变红，见上面
    // 「完成一条重复任务会多出下一条」那条测试同样的注释和写法。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
    try {
      const created = await J(await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })) as Task;
      await patch(`/api/tasks/${created.id}`, { repeat: { every: 'week', interval: 1 } });

      const res = await bulkPatch([created.id], { status: 'done' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ updated: 1 });

      const after = readTasks();
      expect(after).toHaveLength(2);   // 生成了下一条，不是只有原来那一条
      const born = after.find((t) => t.id !== created.id)!;
      expect(born.status).toBe('todo');
      expect(born.due).toBe('2026-08-17T09:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一批里两条同标题同 due 的重复任务一起标完成——只生成一条下一条，不是两条（查重要把本轮已经生成的候选也算进去）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
    try {
      const t1 = await J(await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })) as Task;
      await patch(`/api/tasks/${t1.id}`, { repeat: { every: 'week', interval: 1 } });
      const t2 = await J(await post('/api/tasks', { title: '写周报', due: '2026-08-10T09:00:00.000Z' })) as Task;
      await patch(`/api/tasks/${t2.id}`, { repeat: { every: 'week', interval: 1 } });

      const res = await bulkPatch([t1.id, t2.id], { status: 'done' });
      expect(await res.json()).toEqual({ updated: 2 });

      const after = readTasks();
      expect(after).toHaveLength(3);   // t1 + t2（都完成了）+ 一条下一条，不是两条
      expect(after.filter((t) => t.status === 'todo')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // I2（final-review.md）：批量 PATCH「走同一份 applyTaskPatch」这句路由顶部
  // 注释里的承诺，以前一条测试都没守——把 applyTaskPatch(t, patch) 换成裸展开
  // { ...t, ...patch, updatedAt: nowIso() } 照样 99 passed。这三条各自守一条
  // 只有 applyTaskPatch 才会做、裸展开做不到的规则，都各自照抄单条 PATCH
  // 那几条同名测试（224 行前后）的写法。
  it('批量 PATCH 恢复待办（later -> todo）会清掉 order——跟单条 PATCH 同一条规矩（I2）', async () => {
    writeTasks([newTask({ title: '搁置的', status: 'later', order: 3 })]);
    const id = readTasks()[0].id;

    await bulkPatch([id], { status: 'todo' });

    expect(readTasks()[0].order).toBeNull();
  });

  it('批量 PATCH 改提醒时刻会清掉「已提醒」的章，时刻没变时原样留着——跟单条 PATCH 同一条规矩（I2）', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: '2026-08-01T00:00:05.000Z' }],
    })]);
    const id = readTasks()[0].id;

    // 时刻没变：章要留着
    await bulkPatch([id], { reminders: [{ at: '2026-08-01T00:00:00.000Z', firedAt: null }] });
    expect(readTasks()[0].reminders[0].firedAt).toBe('2026-08-01T00:00:05.000Z');

    // 时刻变了：章要清掉
    await bulkPatch([id], { reminders: [{ at: '2026-09-01T00:00:00.000Z', firedAt: null }] });
    expect(readTasks()[0].reminders[0].firedAt).toBeNull();
  });

  it('批量 PATCH 标完成会盖 completedAt——客户端传不了这个字段（不在白名单里），只有 applyTaskPatch 会盖（I2）', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    expect(t1.completedAt).toBeNull();

    await bulkPatch([t1.id], { status: 'done' });

    expect(readTasks()[0].completedAt).not.toBeNull();
  });

  it('批量删除进垃圾箱，能还原', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;

    const res = await bulkDelete([t1.id, t2.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(readTasks()).toHaveLength(0);

    const trash = await J(await get('/api/trash')) as Array<{ id: string }>;
    expect(trash).toHaveLength(2);

    await post(`/api/trash/${t1.id}/restore`, {});
    expect(readTasks().map((t) => t.id)).toEqual([t1.id]);
  });

  it('批量删除跳过找不到的 id，deleted 只数真删掉的', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;

    const res = await bulkDelete([t1.id, '不存在的id']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
  });

  it('批量删除只写一次盘——不是 N 次', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;
    const t3 = await J(await post('/api/tasks', { title: 'c' })) as Task;

    const writeTasksSpy = vi.spyOn(store, 'writeTasks');
    const writeTrashSpy = vi.spyOn(store, 'writeTrash');
    writeTasksSpy.mockClear();
    writeTrashSpy.mockClear();

    await bulkDelete([t1.id, t2.id, t3.id]);

    expect(writeTasksSpy).toHaveBeenCalledTimes(1);
    expect(writeTrashSpy).toHaveBeenCalledTimes(1);
    writeTasksSpy.mockRestore();
    writeTrashSpy.mockRestore();
  });

  // I1（final-review.md）：批量删除的 inbox.taskIds 清理和 proposals 清理，
  // 生产代码是对的（跟单条 DELETE /api/tasks/:id 同一条规矩，见那条路由的
  // 注释），但以前一条测试都没守——整段换成 `void inbox; void proposals;`
  // 照样 99 passed。这两条各自照抄单条 DELETE 那两条同名测试（301/304 行
  // 前后）的写法。
  it('批量删除清掉命中任务在收件箱 taskIds 里的痕迹，没被删的任务的引用不受影响（I1）', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;
    const t3 = await J(await post('/api/tasks', { title: 'c' })) as Task;
    writeInbox([
      { id: 'i1', text: 'x', createdAt: nowIso(), processed: true, taskIds: [t1.id, t2.id] },
      { id: 'i2', text: 'y', createdAt: nowIso(), processed: true, taskIds: [t3.id] },
    ]);

    await bulkDelete([t1.id, t2.id]);

    const inbox = readInbox();
    expect(inbox.find((x) => x.id === 'i1')?.taskIds).toEqual([]);
    expect(inbox.find((x) => x.id === 'i2')?.taskIds).toEqual([t3.id]);   // 没被删的那条不受影响
  });

  it('批量删除清掉命中任务名下的建议，别的任务的建议不受影响（I1）', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    const t2 = await J(await post('/api/tasks', { title: 'b' })) as Task;
    const proposal = (over: Partial<Proposal>): Proposal =>
      ({ id: over.id!, taskId: over.taskId!, patch: { notes: 'x' }, reason: '理由', createdAt: nowIso(), ...over });
    writeProposals([proposal({ id: 'p1', taskId: t1.id }), proposal({ id: 'p2', taskId: t2.id })]);

    await bulkDelete([t1.id]);

    expect(readProposals().map((p) => p.id)).toEqual(['p2']);
  });

  it('批量删除没有任何收件箱条目引用它时不重写 inbox —— 避免空转触发目录监听器', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    writeInbox([{ id: 'i1', text: 'y', createdAt: nowIso(), processed: false, taskIds: [] }]);

    const writeInboxSpy = vi.spyOn(store, 'writeInbox');
    writeInboxSpy.mockClear();

    await bulkDelete([t1.id]);

    // 没有引用要清，writeInbox 就不该被调用。
    expect(writeInboxSpy).not.toHaveBeenCalled();
    writeInboxSpy.mockRestore();
  });

  it('批量删除没有任何建议指向它时不重写 proposals —— 避免空转触发目录监听器', async () => {
    const t1 = await J(await post('/api/tasks', { title: 'a' })) as Task;
    // 建议指向的是别的任务，不是这条要删的——detachDeletedTasks 该判定
    // 「没有引用要清」，跟上面 inbox 那条同一个道理。
    writeProposals([{ id: 'p1', taskId: '不是它', patch: { notes: 'y' }, reason: '理由', createdAt: nowIso() }]);

    const writeProposalsSpy = vi.spyOn(store, 'writeProposals');
    writeProposalsSpy.mockClear();

    await bulkDelete([t1.id]);

    // 没有引用要清，writeProposals 就不该被调用。
    expect(writeProposalsSpy).not.toHaveBeenCalled();
    writeProposalsSpy.mockRestore();
  });

  // 上限方向：注册顺序不能把单条那两个端点吃掉。新端点的路径是 /api/tasks，
  // 挪错位置会把 /api/tasks/:id 和 /api/tasks/reorder 一起吞掉——而那两个
  // 是今天全部功能在用的路径。
  it('PATCH /api/tasks/:id 还照常工作——批量端点没有把它吃掉', async () => {
    const t = await J(await post('/api/tasks', { title: 'x' })) as Task;
    const res = await patch(`/api/tasks/${t.id}`, { status: 'doing' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).status).toBe('doing');
  });

  it('DELETE /api/tasks/:id 还照常工作——批量端点没有把它吃掉', async () => {
    const t = await J(await post('/api/tasks', { title: 'x' })) as Task;
    const res = await del(`/api/tasks/${t.id}`);
    expect(res.status).toBe(200);
    expect(readTasks()).toHaveLength(0);
  });
});

describe('设置', () => {
  it('PUT 存下来，GET 读回来', async () => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookUrl: 'https://example.com/hook', toastEnabled: false, autoExpand: false,
        autoExpandDelaySec: 120, focusMinutes: 45, breakMinutes: 5, dailySummaryAt: null, dailySummaryOn: null, defaultListId: 'L1', defaultPriority: 3,
      }),
    });
    expect(res.status).toBe(200);
    expect(await (await app.request('/api/settings')).json())
      .toEqual({
        webhookUrl: 'https://example.com/hook', toastEnabled: false, autoExpand: false,
        autoExpandDelaySec: 120, focusMinutes: 45, breakMinutes: 5, dailySummaryAt: null, dailySummaryOn: null, defaultListId: 'L1', defaultPriority: 3,
        // 请求体里没给的那几个落默认值——「任务默认值」那几个默认不预填，
        // 识别那四个开关默认开，合起来就是它们存在之前的行为。
        defaultDue: 'none', defaultRemindMinutes: null, defaultTags: [], weekStart: 1,
        smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true,
        // 农历和「休 / 班」同样默认开——这是个中文日历。
        showLunar: true, showHolidays: true,
        // AI 默认还是走本机 `claude`；地址/模型/密钥没有「多数人都对」的默认值，
        // 一律留空。密钥这一格回的永远是打码后的形状，空串打码还是空串。
        aiMode: 'cli', aiBaseUrl: '', aiKey: '', aiModel: '',
      });
  });

  /**
   * `weekStart` **三档白名单**（周日 / 周一 / 周六，仿滴答清单）。
   *
   * 校验原来写的是 `body.weekStart === 0 ? 0 : 1`——「不是 0 就当 1」。那句话在
   * 只有两档时是对的，加进周六那一档的当天就变成了**静默吃掉一个合法值**：
   * 界面上选了周六，存进去是周一，而且没有任何报错。这一族把三档和一档非法值
   * 都钉住。
   */
  it.each([[0, 0], [1, 1], [6, 6], [3, 1], ['6', 1], [null, 1]] as const)(
    'weekStart 传 %s → 存 %s', async (send, want) => {
      await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weekStart: send }),
      });
      const got = await (await app.request('/api/settings')).json() as { weekStart: unknown };
      expect(got.weekStart).toBe(want);
    });

  it('只认白名单里那几个字段，别的丢掉；没给的落默认值', async () => {
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://x', toastEnabled: true, 别的: 1 }),
    });
    expect(await (await app.request('/api/settings')).json())
      .toEqual({ ...DEFAULT_SETTINGS, webhookUrl: 'https://x', toastEnabled: true });
  });

  it('defaultListId 不校验存不存在（清单随时能删，这里没法回头改），但空串归 null', async () => {
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultListId: '', defaultPriority: 9 }),
    });
    const got = await (await app.request('/api/settings')).json() as { defaultListId: unknown; defaultPriority: unknown };
    expect(got.defaultListId).toBeNull();
    // 越界的优先级归 0（不预填），不是拒收整份设置——跟 autoExpandDelaySec
    // 夹范围同一条道理：设置这条路上宁可落回一个安全值。
    expect(got.defaultPriority).toBe(0);
  });

  // device.json 不在 data/ 里，events.ts 的文件监听器看不到这次写入——
  // data-changed{file:'settings'} 只能靠这条路由自己发。autoExpand.ts 靠它
  // 重算已经排上的那次倒计时：关掉自动拆解要立刻生效，不能等到下一次收件箱
  // 变化才重新评估，见 app.ts PUT /api/settings 里的注释。这条走真实的
  // PUT 路由（不是像 autoExpand.test.ts 那样直接 bus.emit 绕过发送方），
  // 锁住的是「谁负责发」这件事本身。
  it('PUT 之后广播 data-changed{file:"settings"}——这是这个事件唯一的来源', async () => {
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'data-changed') seen.push(d); });
    const withBus = createApp(bus);

    const res = await withBus.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://x' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toContainEqual({ file: 'settings' });
  });

  describe('autoExpandDelaySec 校验：夹在 [10, 3600]，不是拒绝', () => {
    const putDelay = (v: unknown) => app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoExpandDelaySec: v }),
    });

    it.each([
      // [写入的值, 期望落盘的值]
      [10, 10],       // 下边界，原样接受
      [3600, 3600],   // 上边界，原样接受
      [9, 10],        // 低于下边界，夹到 10——零或负数会让去抖形同虚设，必须挡
      [0, 10],
      [-5, 10],
      [3601, 3600],   // 高于上边界，夹到 3600
      [999999, 3600],
    ])('%d -> %d', async (input, expected) => {
      const res = await putDelay(input);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { autoExpandDelaySec: number }).autoExpandDelaySec).toBe(expected);
    });

    it('非数字（字符串/NaN/缺失）落回默认值 60，不是 400', async () => {
      expect(((await (await putDelay('六十')).json()) as { autoExpandDelaySec: number }).autoExpandDelaySec).toBe(60);
      expect(((await (await putDelay(Number.NaN)).json()) as { autoExpandDelaySec: number }).autoExpandDelaySec).toBe(60);
      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(((await res.json()) as { autoExpandDelaySec: number }).autoExpandDelaySec).toBe(60);
    });
  });

  describe('focusMinutes 校验：夹在 [1, 180]，不是拒绝——番茄钟的 Settings.autoExpandDelaySec 同款', () => {
    const putFocus = (v: unknown) => app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focusMinutes: v }),
    });

    it.each([
      // [写入的值, 期望落盘的值]
      [1, 1],         // 下边界，原样接受
      [180, 180],     // 上边界，原样接受
      [0, 1],         // 0 或负数会让番茄钟形同虚设，必须挡
      [-5, 1],
      [181, 180],     // 高于上边界，夹到 180
      [999999, 180],
    ])('%d -> %d', async (input, expected) => {
      const res = await putFocus(input);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { focusMinutes: number }).focusMinutes).toBe(expected);
    });

    it('非数字（字符串/NaN/缺失）落回默认值 25，不是 400', async () => {
      expect(((await (await putFocus('二十五')).json()) as { focusMinutes: number }).focusMinutes).toBe(25);
      expect(((await (await putFocus(Number.NaN)).json()) as { focusMinutes: number }).focusMinutes).toBe(25);
      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(((await res.json()) as { focusMinutes: number }).focusMinutes).toBe(25);
    });
  });
});

// 「清单」「文件夹」两个 describe 一共接了四处路由（清单 POST/PATCH、文件夹
// POST/PATCH）。**这四处每一处都必须有一条独立的成功路径断言**（200 + 读回来
// 确实按预期改了），不能只测「不合法时 400」——`if (!r.ok)` 被写成 `if (true)`
// 那种「校验器永远失败、端点变成永远 400」的坏改动，只有成功路径的断言能抓到，
// 「不合法时说得出字段」那条本来就期待 400，糊弄不了它。
//
// 这个形状在这批改动里已经栽了四次：第 65/66 号假绿（新接口接了 N 处、测试
// 只覆盖第一处）、Task 2 里 `POST /api/push` 收件箱那一半的那条、这里最早漏掉的 `PATCH
// /api/lists/:id` 和 `POST /api/folders`（后来补上了）、最后连 `PATCH
// /api/folders/:id` 也漏了一轮才补齐——`POST /api/lists` 反而是被一条早前
// 就有的「建一个读回来」测试意外兜住的，不是谁特意守的。**往这个文件加第五处
// 路由时，先加一条这种形状的断言，不要等审查揪出来。**
//
// 第七次：POST /api/lists 的 name/color 必填、POST /api/folders 的 name
// 必填，这三行也是「checkPatch 之后、构造实体之前」的单独必填检查，
// 跟上面说的成功路径断言不是同一道防线——**成功路径断言守的是 `if (!r.ok)`
// 被压成恒真；必填检查是另一道独立的 `if (!r.value.name) return 400`，
// 发一个完全不带该键的请求体（不是空字符串）才能真正打到它**，见下面
// 「完全不给 name/color 键」那几条。
describe('清单', () => {
  it('建一个读回来', async () => {
    const r = await app.request('/api/lists', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '工作', color: '#8B5E34' }),
    });
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(list.name).toBe('工作');
    expect(list.filter).toBeNull();
    expect((await (await app.request('/api/lists')).json())).toHaveLength(1);
  });

  it('名字为空拒收', async () => {
    const r = await app.request('/api/lists', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ', color: '#000' }),
    });
    expect(r.status).toBe(400);
  });

  // 上面那条打的是 checkListPatch 自己的 name 形状校验（trim 后是空串）。
  // 这条完全不给 name 键——checkListPatch 只校验「给出的字段」，对没给的字段
  // 一律放过（{} → ok:true），必须靠 app.ts 里 `POST /api/lists` 那道单独的必填检查才能拦住。
  // 这一批把 `patch.name` 重写成了 `r.value.name`，却没有任何测试打到过
  // 这一行——POST /api/lists {} 之前会 200，落盘一条没有 name/color 键的清单。
  it('完全不给 name 键（不是空字符串）—— 照样被挡在「清单要有名字」这道单独检查上', async () => {
    const res = await post('/api/lists', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe('清单要有名字');
    expect(body.field).toBe('name');
    expect((await (await app.request('/api/lists')).json())).toHaveLength(0);   // 没有记录落盘
  });

  // 同一道必填检查的第二处：name 给了，color 完全不给。checkListPatch 同样会
  // 放过（'color' in b 为 false），必须靠 app.ts 里 `POST /api/lists` 的必填检查单独拦。
  it('给了 name 但完全不给 color 键 —— 照样被挡在「颜色要是 #RRGGBB」这道单独检查上', async () => {
    const res = await post('/api/lists', { name: '工作' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.field).toBe('color');
    expect((await (await app.request('/api/lists')).json())).toHaveLength(0);
  });

  it('群青不能当清单色——那是 AI 的记号', async () => {
    const r = await app.request('/api/lists', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '工作', color: '#2E3ED4' }),
    });
    expect(r.status).toBe(400);
  });

  // 这一批要修的就是这句谎：13 种失败里只有 1 种跟颜色有关，POST /api/lists
  // 以前不管哪种失败都甩同一句「颜色要是 #RRGGBB」。这条打在跟颜色完全无关
  // 的失败（白名单外的键）上，确认它不再被那句话糊弄。
  it('POST /api/lists 字段不合法时说得出是哪个字段——不是统一甩「颜色要是 #RRGGBB」', async () => {
    const res = await post('/api/lists', { name: '工作', color: '#8B5E34', 别的字段: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.field).toBe('别的字段');
    expect(body.error).not.toMatch(/颜色要是/);
  });

  it('PATCH /api/lists/:id 字段不合法时说得出是哪个字段', async () => {
    const list = await (await post('/api/lists', { name: '工作', color: '#8B5E34' })).json();
    const res = await patch(`/api/lists/${list.id}`, { archived: '不是布尔值' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.field).toBe('archived');
    expect(body.error).not.toMatch(/颜色要是/);
  });

  // 合法的 PATCH 照常 200——跟 checkTaskPatch 那条同款测试同一个理由：这次改动
  // 不能让本来能通过的请求开始 400。没有这条的话，把 400 分支写成恒真也能
  // 骗过上面那条「不合法时说得出字段」的测试（它本来就期待 400）。
  it('合法的 PATCH /api/lists/:id 照常 200，改动生效', async () => {
    const list = await (await post('/api/lists', { name: '工作', color: '#8B5E34' })).json();
    const res = await patch(`/api/lists/${list.id}`, { name: '生活', archived: true });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { name: string; archived: boolean };
    expect(after.name).toBe('生活');
    expect(after.archived).toBe(true);
  });

  it('删清单不删里面的任务，只把 listId 置空', async () => {
    const list = await (await app.request('/api/lists', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '工作', color: '#8B5E34' }),
    })).json();
    writeTasks([newTask({ title: '归在工作里', listId: list.id })]);

    await app.request(`/api/lists/${list.id}`, { method: 'DELETE' });

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].listId).toBeNull();
  });
});

describe('文件夹', () => {
  it('建一个读回来', async () => {
    const res = await post('/api/folders', { name: '项目' });
    expect(res.status).toBe(200);
    const folder = (await res.json()) as { id: string; name: string; order: number };
    expect(folder.name).toBe('项目');
    expect((await (await app.request('/api/folders')).json())).toHaveLength(1);
  });

  // 同 describe('清单') 里两条「完全不给键」测试——checkFolderPatch 对没给的
  // 字段一律放过，必须靠 app.ts 里 `PATCH /api/tasks/reorder` 那道单独的必填检查拦住。
  it('完全不给 name 键（不是空字符串）—— 照样被挡在「文件夹要有名字」这道单独检查上', async () => {
    const res = await post('/api/folders', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field?: string };
    expect(body.error).toBe('文件夹要有名字');
    expect(body.field).toBe('name');
    expect((await (await app.request('/api/folders')).json())).toHaveLength(0);
  });

  it('POST /api/folders 字段不合法时说得出是哪个字段——不是统一甩「颜色要是 #RRGGBB」（文件夹压根没有颜色字段）', async () => {
    const res = await post('/api/folders', { name: '项目', 别的字段: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.field).toBe('别的字段');
    expect(body.error).not.toMatch(/颜色要是/);
  });

  it('PATCH /api/folders/:id 字段不合法时说得出是哪个字段', async () => {
    const f = await (await post('/api/folders', { name: '项目' })).json();
    // 坏值用字符串 '3'，不用 Number.NaN：`JSON.stringify({order: NaN})` 产出的是
    // `{"order":null}`，服务端收到的根本不是 NaN，命中的是 `typeof !== 'number'`
    // 那一半，测试名和实际打的分支对不上。`Number.isFinite` 那一半过不了 HTTP，
    // 守它的是 list.test.ts 里直接调函数的两条（NaN 和 Infinity 各一条）。
    const res = await patch(`/api/folders/${f.id}`, { order: '3' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.field).toBe('order');
    expect(body.error).not.toMatch(/颜色要是/);
  });

  // 四处路由里第四处的成功路径断言，见上面 describe('清单') 前的注释——
  // 之前只测了「不合法时 400」，`if (!r.ok)` 被压成 `if (true)`（校验器永远
  // 失败）照样能骗过那条测试，只有这条能抓到。
  it('合法的 PATCH /api/folders/:id 照常 200，改动生效', async () => {
    const f = await (await post('/api/folders', { name: '项目' })).json();
    const res = await patch(`/api/folders/${f.id}`, { name: '归档项目', order: 5 });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { name: string; order: number };
    expect(after.name).toBe('归档项目');
    expect(after.order).toBe(5);
  });

  it('删文件夹不删里面的清单，只把 folderId 置空', async () => {
    const f = await (await app.request('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '项目' }),
    })).json();
    const l = await (await app.request('/api/lists', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '项目 A', color: '#8B5E34', folderId: f.id }),
    })).json();

    await app.request(`/api/folders/${f.id}`, { method: 'DELETE' });

    expect((await (await app.request('/api/lists')).json())[0].folderId).toBeNull();
    expect(l.folderId).toBe(f.id);
  });
});

describe('观察', () => {
  it('GET /api/insights 不返回已经「知道了」的', async () => {
    writeInsights([
      { id: 'a', kind: 'note', text: '看得见', taskIds: [], createdAt: nowIso(), dismissedAt: null },
      { id: 'b', kind: 'note', text: '已经知道了', taskIds: [], createdAt: nowIso(), dismissedAt: nowIso() },
    ]);
    const all = await (await app.request('/api/insights')).json();
    expect(all.map((i: { id: string }) => i.id)).toEqual(['a']);
  });

  it('「知道了」是打墓碑不是删除——删了下一轮 AI 会原样再提一遍', async () => {
    writeInsights([{ id: 'a', kind: 'note', text: 'x', taskIds: [], createdAt: nowIso(), dismissedAt: null }]);
    await app.request('/api/insights/a/dismiss', { method: 'PATCH' });
    expect(readInsights()).toHaveLength(1);
    expect(readInsights()[0].dismissedAt).not.toBeNull();
  });
});

describe('POST /api/expand', () => {
  const fakeProc = (): ChildProcess => (new EventEmitter() as unknown as ChildProcess);

  it('单飞：跑着的时候第二次请求回 409 带中文说明；不跑了之后能再触发', async () => {
    const proc = Object.assign(fakeProc(), { kill: vi.fn() });
    const spawnFn: Spawner = vi.fn(() => proc);
    const withRunner = createApp(undefined, spawnFn);

    const first = await withRunner.request('/api/expand', { method: 'POST' });
    expect(first.status).toBe(200);

    const second = await withRunner.request('/api/expand', { method: 'POST' });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/还在跑/);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0);
    const third = await withRunner.request('/api/expand', { method: 'POST' });
    expect(third.status).toBe(200);
  });

  it('spawn 同步抛异常时回 409 并带上原因，不会把整个请求炸成 500', async () => {
    const spawnFn: Spawner = () => {
      throw new Error('坏掉了');
    };
    const withRunner = createApp(undefined, spawnFn);

    const res = await withRunner.request('/api/expand', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/坏掉了/);
  });
});

/**
 * 回顾跟拆解是同一个 runner 的两个提示词。这一族盯两件事，两件都是改错了
 * 不会有任何地方发出声音的：
 *
 *   1. **跑的是哪一份提示词**。两条路由的返回值一模一样（`{ ok: true }`），
 *      `/api/review` 要是漏传了 kind，默认值会让它安安静静地去拆一遍收件箱：
 *      接口 200、按钮转圈、最后一条建议都没有——跟「真回顾了但没什么好说的」
 *      在界面上长得一模一样。
 *   2. **两者共用同一把单飞锁**。各锁各的同样一路绿，代价是两个 claude 对着
 *      同一个 `data/` 写 outbox，撞车时才看得到。
 */
describe('POST /api/review', () => {
  const fakeProc = (): ChildProcess => (new EventEmitter() as unknown as ChildProcess);
  /** spawn 进去的提示词：`claude -p <提示词> ...`，也就是 `-p` 后面那一个。 */
  const promptOf = (spawnFn: unknown, nth = 0): string => {
    const args = (spawnFn as { mock: { calls: [string, string[], unknown][] } }).mock.calls[nth][1];
    return args[args.indexOf('-p') + 1];
  };

  it('跑的是回顾那份提示词，不是拆解那份', async () => {
    const spawnFn: Spawner = vi.fn(() => Object.assign(fakeProc(), { kill: vi.fn() }));
    const withRunner = createApp(undefined, spawnFn);

    expect((await withRunner.request('/api/review', { method: 'POST' })).status).toBe(200);
    const prompt = promptOf(spawnFn);
    expect(prompt).toContain('workflows/review.md');
    // 两面都要钉：只断言「包含 review.md」的话，一份把两个工作流都写进去的
    // 提示词也能蒙混过去，而那样 AI 会把收件箱也一并拆了。
    expect(prompt).not.toContain('expand.md');
  });

  /**
   * 「只回顾这一份清单」。CLI 那条路上 AI 是自己去读 `data/tasks/` 的——服务端
   * 筛不了它，范围只能靠提示词那句话说。所以这一族钉的是「那句话确实发出去了」
   * 和「一个认不出来的 id 不会静默变成全量扫描」。
   */
  describe('带 listId', () => {
    const post = (body: unknown) => ({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    it('范围那句话进了提示词，带着 id 和名字', async () => {
      writeLists([{ id: 'l1', name: '035 办事师爷', color: '', folderId: null, order: 0, archived: false, filter: null }]);
      const spawnFn: Spawner = vi.fn(() => Object.assign(fakeProc(), { kill: vi.fn() }));
      const withRunner = createApp(undefined, spawnFn);

      expect((await withRunner.request('/api/review', post({ listId: 'l1' }))).status).toBe(200);
      const prompt = promptOf(spawnFn);
      // 正本那句还在——范围是**追加**上去的，不是替换（`PROMPT` 被 AGENTS.md
      // 逐字抄了一份，改它会让 agentsMd.guard.test.ts 红）。
      expect(prompt).toContain('workflows/review.md');
      expect(prompt).toContain('l1');
      expect(prompt).toContain('035 办事师爷');
    });

    /**
     * **认不出来的 id 必须明确拒绝，不能退回全量。** 回顾是真花钱的（调接口那条
     * 按 token 计，CLI 那条烧订阅额度），一个打错的 id 静默变成扫全部任务，
     * 用户看到的是一份看不出错在哪的账单加一堆不相干的建议。
     */
    it('清单不存在：400，而且一个 claude 都没起', async () => {
      writeLists([]);
      const spawnFn: Spawner = vi.fn(() => Object.assign(fakeProc(), { kill: vi.fn() }));
      const withRunner = createApp(undefined, spawnFn);

      const res = await withRunner.request('/api/review', post({ listId: '不存在' }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('不存在');
      expect(spawnFn).not.toHaveBeenCalled();
    });

    // 这个路由一直允许空 body 调用（回顾那一屏那颗按钮就是这么调的），加了参数
    // 之后别把它变成一个 JSON 解析错误。
    it('不带 body 还是老行为：200，提示词里不提范围', async () => {
      const spawnFn: Spawner = vi.fn(() => Object.assign(fakeProc(), { kill: vi.fn() }));
      const withRunner = createApp(undefined, spawnFn);

      expect((await withRunner.request('/api/review', { method: 'POST' })).status).toBe(200);
      expect(promptOf(spawnFn)).not.toContain('这次只回顾清单');
    });
  });

  it('拆解正在跑的时候点回顾：409，而且说清楚在跑的是拆解', async () => {
    const proc = Object.assign(fakeProc(), { kill: vi.fn() });
    const spawnFn: Spawner = vi.fn(() => proc);
    const withRunner = createApp(undefined, spawnFn);

    expect((await withRunner.request('/api/expand', { method: 'POST' })).status).toBe(200);
    const res = await withRunner.request('/api/review', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('上一次拆解还在跑');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('反过来也一样：回顾在跑时点拆解被拦，说的是「上一次回顾还在跑」', async () => {
    const proc = Object.assign(fakeProc(), { kill: vi.fn() });
    const spawnFn: Spawner = vi.fn(() => proc);
    const withRunner = createApp(undefined, spawnFn);

    expect((await withRunner.request('/api/review', { method: 'POST' })).status).toBe(200);
    const res = await withRunner.request('/api/expand', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('上一次回顾还在跑');

    // 跑完了锁就开了，下一次拆解能起——否则一次回顾就把自动拆解永久卡死了。
    proc.emit('exit', 0);
    expect((await withRunner.request('/api/expand', { method: 'POST' })).status).toBe(200);
    expect(promptOf(spawnFn, 1)).toContain('workflows/expand.md');
  });
});

describe('自动拆解调度跟路由的接线', () => {
  const fakeAutoProc = (): ChildProcess & { emitExit: (code: number) => void } => {
    const e = new EventEmitter() as unknown as ChildProcess & { emitExit: (code: number) => void };
    e.kill = vi.fn() as unknown as ChildProcess['kill'];
    e.emitExit = (code: number) => e.emit('exit', code);
    return e;
  };
  // watchData 在这些测试里没有真的跑起来（DATA_DIR 是临时目录，没有接文件监听器），
  // 所以「inbox.json 变了」这件事要手动 emit 一次 data-changed 模拟——跟
  // events.test.ts 里验证 SSE 转发时的手法一样。
  const inboxChanged = (bus: Bus) => bus.emit('data-changed', { file: 'inbox' });

  it('POST /api/expand/skip 只取消排期，不启动任何进程', async () => {
    const bus = new Bus();
    const spawnFn: Spawner = vi.fn(() => fakeAutoProc());
    const withBus = createApp(bus, spawnFn);

    const res = await withBus.request('/api/expand/skip', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('自动尝试失败后被记录尝试过、不会自动重试；手动 POST /api/expand 清空记录，之后又能自动排期', async () => {
    vi.useFakeTimers();
    try {
      const bus = new Bus();
      const procs: Array<ReturnType<typeof fakeAutoProc>> = [];
      const spawnFn: Spawner = vi.fn(() => {
        const p = fakeAutoProc();
        procs.push(p);
        return p;
      });
      const withBus = createApp(bus, spawnFn);

      await withBus.request('/api/inbox', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '随手记的' }),
      });
      inboxChanged(bus);

      vi.advanceTimersByTime(60_000);   // 默认延迟 60 秒，自动触发
      expect(spawnFn).toHaveBeenCalledTimes(1);
      procs[0].emitExit(1);   // 这次没能处理掉，条目还是 unprocessed

      inboxChanged(bus);
      vi.advanceTimersByTime(120_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);   // 尝试记录挡住了第二次自动触发

      const manual = await withBus.request('/api/expand', { method: 'POST' });
      expect(manual.status).toBe(200);
      expect(spawnFn).toHaveBeenCalledTimes(2);   // 手动触发自己也会 spawn 一次
      procs[1].emitExit(1);

      inboxChanged(bus);
      vi.advanceTimersByTime(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(3);   // 手动触发清空了记录，自动触发又能排上了
    } finally {
      vi.useRealTimers();
    }
  });

  it('PATCH /api/inbox/:id 把 processed 改回 false 时，把这条从自动拆解的尝试记录里摘掉', async () => {
    vi.useFakeTimers();
    try {
      const bus = new Bus();
      const procs: Array<ReturnType<typeof fakeAutoProc>> = [];
      const spawnFn: Spawner = vi.fn(() => {
        const p = fakeAutoProc();
        procs.push(p);
        return p;
      });
      const withBus = createApp(bus, spawnFn);

      const item = (await (await withBus.request('/api/inbox', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '随手记的' }),
      })).json()) as InboxItem;
      inboxChanged(bus);

      vi.advanceTimersByTime(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      procs[0].emitExit(1);   // 没能处理掉

      inboxChanged(bus);
      vi.advanceTimersByTime(120_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);   // 还在尝试记录里，不会自动重试

      // 「重新拆解」按钮走的正是这条 PATCH。
      await withBus.request(`/api/inbox/${item.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ processed: false }),
      });
      inboxChanged(bus);
      vi.advanceTimersByTime(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(2);   // forget 之后又能自动排期了
    } finally {
      vi.useRealTimers();
    }
  });

  it('PATCH /api/inbox/:id 改 text 时，把这条从自动拆解的尝试记录里摘掉——改文字等于「按新的再试一次」', async () => {
    vi.useFakeTimers();
    try {
      const bus = new Bus();
      const procs: Array<ReturnType<typeof fakeAutoProc>> = [];
      const spawnFn: Spawner = vi.fn(() => {
        const p = fakeAutoProc();
        procs.push(p);
        return p;
      });
      const withBus = createApp(bus, spawnFn);

      const item = (await (await withBus.request('/api/inbox', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '随手记的' }),
      })).json()) as InboxItem;
      inboxChanged(bus);

      vi.advanceTimersByTime(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      procs[0].emitExit(1);   // 没能处理掉

      inboxChanged(bus);
      vi.advanceTimersByTime(120_000);
      expect(spawnFn).toHaveBeenCalledTimes(1);   // 还在尝试记录里，不会自动重试

      // 改文字：跟「重新拆解」按钮同一个语义。
      await withBus.request(`/api/inbox/${item.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '改过的文字' }),
      });
      inboxChanged(bus);
      vi.advanceTimersByTime(60_000);
      expect(spawnFn).toHaveBeenCalledTimes(2);   // forget 之后又能自动排期了
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('软删除与垃圾箱', () => {
  const J = async (r: Response) => r.json();

  it('删除把任务搬进垃圾箱，不是抹掉', async () => {
    const t = await J(await post('/api/tasks', { title: '要删的' }));
    await del(`/api/tasks/${t.id}`);

    expect(await J(await get('/api/tasks'))).toHaveLength(0);
    const trash = await J(await get('/api/trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0].id).toBe(t.id);
    expect(trash[0].title).toBe('要删的');
    expect(typeof trash[0].deletedAt).toBe('string');
  });

  it('还原把它放回任务里，并从垃圾箱移走', async () => {
    const t = await J(await post('/api/tasks', { title: '还原我' }));
    await del(`/api/tasks/${t.id}`);
    await post(`/api/trash/${t.id}/restore`, {});

    const tasks = await J(await get('/api/tasks'));
    expect(tasks.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(await J(await get('/api/trash'))).toHaveLength(0);
    // 还原回来的不该带着 deletedAt
    expect('deletedAt' in tasks[0]).toBe(false);
  });

  it('还原一条已完成的任务，状态和完成时间都留着', async () => {
    const t = await J(await post('/api/tasks', { title: '做完了的' }));
    await patch(`/api/tasks/${t.id}`, { status: 'done' });
    await del(`/api/tasks/${t.id}`);
    await post(`/api/trash/${t.id}/restore`, {});

    const back = (await J(await get('/api/tasks')))[0];
    expect(back.status).toBe('done');
    expect(back.completedAt).not.toBeNull();   // Task 1 盖的章要活过一次来回
  });

  it('彻底删除才是真的没了', async () => {
    const t = await J(await post('/api/tasks', { title: '永别' }));
    await del(`/api/tasks/${t.id}`);
    await del(`/api/trash/${t.id}`);

    expect(await J(await get('/api/trash'))).toHaveLength(0);
    expect(await J(await get('/api/tasks'))).toHaveLength(0);
  });

  it('还原时清掉 order——躺在垃圾箱里的这段时间，那个位置早被别的卡占了', async () => {
    const t = await J(await post('/api/tasks', { title: '排过序的' }));
    await patch(`/api/tasks/${t.id}`, { order: 3 });
    expect((await J(await get('/api/tasks')))[0].order).toBe(3);   // 先确认真的排上了

    await del(`/api/tasks/${t.id}`);
    const back = await J(await post(`/api/trash/${t.id}/restore`, {}));
    expect(back.order).toBeNull();                                  // 响应里
    expect((await J(await get('/api/tasks')))[0].order).toBeNull(); // 落盘的也是
  });

  it('垃圾箱里没有的 id：还原和彻底删除都回 404，而且是「没有这一条」不是「没有这个接口」', async () => {
    // 只断言 status 是假绿：没注册的 /api/* 由 app.ts 末尾的兜底也回 404
    //（实测过——把这两条路由整个改名，只断言 status 的版本照样绿）。
    // 连错误体一起断言才分得清「路由存在但 id 找不到」和「路由压根不存在」。
    const r1 = await post('/api/trash/nope/restore', {});
    expect(r1.status).toBe(404);
    expect(await r1.json()).toEqual({ error: '垃圾箱里没有这一条' });

    const r2 = await del('/api/trash/nope');
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ error: '垃圾箱里没有这一条' });
  });

  it('删除仍然清掉收件箱里指向它的 taskIds', async () => {
    // 这条既有行为不能因为改成软删就丢了
    const item = await J(await post('/api/inbox', { text: '随手记' }));
    const t = await J(await post('/api/tasks', { title: '拆出来的' }));
    await patch(`/api/inbox/${item.id}`, { taskIds: [t.id] });
    await del(`/api/tasks/${t.id}`);

    expect((await J(await get('/api/inbox')))[0].taskIds).toEqual([]);
  });
});

describe('附件', () => {
  const J = async (r: Response) => r.json();
  const mkTask = async (title = '带附件的任务') => (await J(await post('/api/tasks', { title }))) as Task;

  it('上传成功：201，返回更新后的任务，attachments 里有落盘的文件名，磁盘上真的有这个文件', async () => {
    const t = await mkTask();
    const res = await upload(`/api/tasks/${t.id}/attachments`, '报告.pdf', '一些内容');
    expect(res.status).toBe(201);
    const next = (await J(res)) as Task;
    expect(next.attachments).toEqual(['报告.pdf']);
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual(['报告.pdf']);
    expect(resolveAttachment(t.id, '报告.pdf')).not.toBeNull();
  });

  it('上传到不存在的任务：404，不落盘', async () => {
    const res = await upload('/api/tasks/不存在的任务id/attachments', 'x.txt', 'x');
    expect(res.status).toBe(404);
    expect(listAttachments('不存在的任务id')).toEqual([]);
  });

  it('缺 file 字段：400', async () => {
    const t = await mkTask();
    const form = new FormData();
    form.append('note', '没有 file 字段');
    const res = await app.request(`/api/tasks/${t.id}/attachments`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual([]);
  });

  it('重名加序号：Task.attachments 用真正落盘的名字（不是原名），第一个文件内容不被覆盖', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', '一');
    const res2 = await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', '二');
    expect(((await J(res2)) as Task).attachments).toEqual(['a.txt', 'a (2).txt']);

    expect(await (await get(`/api/tasks/${t.id}/attachments/${encodeURIComponent('a.txt')}`)).text()).toBe('一');
    expect(await (await get(`/api/tasks/${t.id}/attachments/${encodeURIComponent('a (2).txt')}`)).text()).toBe('二');
  });

  it('超过 MAX_ATTACHMENT_BYTES：413，错误信息说清楚上限是多少；不落盘、不写进 attachments', async () => {
    const t = await mkTask();
    const over = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const res = await upload(`/api/tasks/${t.id}/attachments`, '太大了.bin', over, 'application/octet-stream');
    expect(res.status).toBe(413);
    expect(((await J(res)) as { error: string }).error).toMatch(/25MB/);
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual([]);
    expect(listAttachments(t.id)).toEqual([]);
  });

  it('刚好等于上限：不该被 413 误伤——多退的粗筛留了 multipart 开销的余量', async () => {
    const t = await mkTask();
    const exact = new Uint8Array(MAX_ATTACHMENT_BYTES);
    const res = await upload(`/api/tasks/${t.id}/attachments`, '刚好.bin', exact, 'application/octet-stream');
    expect(res.status).toBe(201);
  });

  it('GET 下载：内容匹配，Content-Disposition 带中文文件名的 filename* 和一个不含中文的 ASCII 回退', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, '八月报告 (1).pdf', 'hello pdf');
    const res = await get(`/api/tasks/${t.id}/attachments/${encodeURIComponent('八月报告 (1).pdf')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello pdf');
    const cd = res.headers.get('content-disposition') ?? '';
    // filename* 精确编码，包括括号——dedupeName 重名去重就是往文件名里插 ` (2)`
    // 这种带括号的后缀，RFC 5987 的 ext-value 语法把 () 当保留字符，普通
    // encodeURIComponent 不转义它们。
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('八月报告 (1).pdf').replace(/[()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    const asciiMatch = cd.match(/filename="([^"]*)"/);
    expect(asciiMatch).not.toBeNull();
    expect(asciiMatch![1]).not.toMatch(/[^\x20-\x7e]/);   // 回退里没有中文
  });

  it('GET 找不到的附件：404', async () => {
    const t = await mkTask();
    const res = await get(`/api/tasks/${t.id}/attachments/没有这个.txt`);
    expect(res.status).toBe(404);
  });

  // m7（final-review.md）：Content-Disposition 的 filename 要用磁盘上真实的
  // basename，不是请求里的别名——`./plain.txt` 和 `plain.txt` 被
  // resolveAttachment 解析到同一个文件，但下载弹窗不该显示一个带着 `./`
  // 前缀、磁盘上其实不存在的文件名。
  it('m7：用别名（./ 前缀）GET 下载，Content-Disposition 里的文件名是真实的 basename', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'plain.txt', 'x');

    const res = await get(`/api/tasks/${t.id}/attachments/${encodeURIComponent('./plain.txt')}`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('filename="plain.txt"');
    expect(cd).not.toContain('./plain.txt');
  });

  it('GET 路径穿越：诱饵文件放在 attachments/ 上一级，编码过的 ../ 读不到它', async () => {
    // 不能靠「/etc/passwd 这台机器上不存在」这种判据（Task 1 在这上面栽过一次，
    // 见 task-1-report.md「疑虑」第 2 条）——放一个真实存在的诱饵文件，哪台
    // 机器上守卫失效都能被抓住。诱饵放在 data/attachments/（taskId 目录的
    // 上一级），`..%2F` 解码后正好指向它。
    const t = await mkTask();
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    const decoy = join(dir, 'attachments', 'secret.txt');
    writeFileSync(decoy, '不该被读到', 'utf8');

    const res = await app.request(`/api/tasks/${t.id}/attachments/..%2Fsecret.txt`);
    expect(res.status).toBe(404);
  });

  it('DELETE 路径穿越：编码过的 ../ 既读不到诱饵文件也删不掉它', async () => {
    const t = await mkTask();
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    const decoy = join(dir, 'attachments', 'secret2.txt');
    writeFileSync(decoy, '不该被删', 'utf8');

    const res = await app.request(`/api/tasks/${t.id}/attachments/..%2Fsecret2.txt`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(existsSync(decoy)).toBe(true);
  });

  it('DELETE 附件：200，磁盘和 Task.attachments 都清掉，不影响同一任务下的其它附件', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');
    await upload(`/api/tasks/${t.id}/attachments`, 'b.txt', 'B');

    const res = await del(`/api/tasks/${t.id}/attachments/a.txt`);
    expect(res.status).toBe(200);
    expect(await J(res)).toEqual({ ok: true });

    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual(['b.txt']);
    expect(resolveAttachment(t.id, 'a.txt')).toBeNull();
    expect(resolveAttachment(t.id, 'b.txt')).not.toBeNull();   // 上限：没有连带删掉
  });

  // m6（final-review.md）：`./plain.txt` 和 `plain.txt` 被 resolveAttachment
  // 解析到同一个文件，但摘 Task.attachments 数组如果用的是请求里的原始 name
  // （`./plain.txt`），数组里那条 `plain.txt` 摘不中——文件已经从磁盘删了，
  // 数组里却留下一条永久删不掉的死条目（再请求一次会 404，因为磁盘上真的
  // 没有 `./plain.txt` 这个文件）。
  it('m6：用别名（./ 前缀）DELETE 也能摘中数组里真正的条目，不留死条目', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'plain.txt', 'x');

    const res = await del(`/api/tasks/${t.id}/attachments/${encodeURIComponent('./plain.txt')}`);
    expect(res.status).toBe(200);
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual([]);
  });

  it('DELETE 不存在的附件：404，任务和已有附件都不受影响', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');
    const res = await del(`/api/tasks/${t.id}/attachments/没有这个.txt`);
    expect(res.status).toBe(404);
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual(['a.txt']);
  });

  it('DELETE 到不存在的任务：404', async () => {
    const res = await del('/api/tasks/不存在的任务id/attachments/a.txt');
    expect(res.status).toBe(404);
  });

  it('软删除（进垃圾箱）不清附件——还原之后附件还在，还能下载', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');

    await del(`/api/tasks/${t.id}`);   // 软删除，不是彻底删除
    // 上限断言：这条任务已经不在 readTasks() 里了，附件目录照样在——
    // design ⑤「软删除保留附件」，磁盘是唯一事实来源。
    expect(resolveAttachment(t.id, 'a.txt')).not.toBeNull();
    expect((await get(`/api/tasks/${t.id}/attachments/a.txt`)).status).toBe(200);

    await post(`/api/trash/${t.id}/restore`, {});
    expect(readTasks().find((x) => x.id === t.id)?.attachments).toEqual(['a.txt']);
    expect((await get(`/api/tasks/${t.id}/attachments/a.txt`)).status).toBe(200);
  });

  it('彻底删除才清目录：删对了这个任务的，没删到别的任务的（唯一的破坏性操作）', async () => {
    const a = await mkTask('要彻底删的');
    const b = await mkTask('留着的');
    await upload(`/api/tasks/${a.id}/attachments`, 'x.txt', 'X');
    await upload(`/api/tasks/${b.id}/attachments`, 'y.txt', 'Y');

    await del(`/api/tasks/${a.id}`);          // 软删除
    await del(`/api/trash/${a.id}`);          // 彻底删除

    expect(resolveAttachment(a.id, 'x.txt')).toBeNull();
    expect(listAttachments(a.id)).toEqual([]);
    // 上限断言：另一个任务的附件毫发无伤
    expect(resolveAttachment(b.id, 'y.txt')).not.toBeNull();
    expect((await get(`/api/tasks/${b.id}/attachments/y.txt`)).status).toBe(200);
  });

  it('注册顺序上限：这三条更长的附件路由挂上之后，/api/tasks/:id 的 PATCH 和 DELETE 还照常工作', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');

    const p = await patch(`/api/tasks/${t.id}`, { title: '改过的标题' });
    expect(p.status).toBe(200);
    expect(((await J(p)) as Task).title).toBe('改过的标题');

    const d = await del(`/api/tasks/${t.id}`);
    expect(d.status).toBe(200);
    expect(readTasks().find((x) => x.id === t.id)).toBeUndefined();
  });

  // C1（final-review.md）：上传路由曾经在两次长 await（parseBody/arrayBuffer）
  // **之前**就抓了任务快照，写回时原样用那份旧快照——上传期间别处新建的任务
  // 会被这次写回当成「磁盘上有、快照里没有」删掉，而且是真删除，不进垃圾箱。
  // vitest 里 FormData/Blob 走的是内存路径，没有真的网络耗时，插不进一次真正
  // 精确交错的并发（见 final-review.md 原文「我是怎么确认的」那段）——这里用
  // spy 在第一次 readTasks()（存在性预检）之后同步模拟「另一个请求已经落盘
  // 了一条新任务」，钉住写回真的是基于**重新读**的那份，不是最上面那份旧快照：
  // 用旧快照的话，下面这条新任务会在写回那一刻被抹掉。
  it('C1：写回基于两次 await 之后重新读的快照——上传期间新建的任务不会被覆盖掉', async () => {
    const t = await mkTask();
    // 捕获真正的实现——下面的 spy 只是想数「readTasks 被调了几次、第几次
    // 该注入并发写」，每次仍然要老老实实读磁盘，不是伪造返回值。
    const realReadTasks = store.readTasks;
    let calls = 0;
    const spy = vi.spyOn(store, 'readTasks').mockImplementation(() => {
      calls++;
      const snapshot = realReadTasks();
      if (calls === 1) writeTasks([...snapshot, newTask({ title: '并发新建的' })]);
      return snapshot;
    });

    const res = await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'x');
    spy.mockRestore();

    expect(res.status).toBe(201);
    expect(calls).toBe(2); // 存在性预检 + 写回前重新读，不是只读一次
    const after = readTasks();
    expect(after.some((x) => x.title === '并发新建的')).toBe(true);
    expect(after.find((x) => x.id === t.id)?.attachments).toEqual(['a.txt']);
  });

  // I1（final-review.md）：`Task.attachments` 数组跟磁盘不一致时（同步冲突、
  // 手工删文件），GET /api/tasks 要以磁盘为准把数组修正过来，不能让界面显示
  // 一个点开是 404 的幽灵条目。
  it('I1：GET /api/tasks 跟磁盘对账——手工删掉磁盘上的文件后，列表不再报幽灵条目', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'ghost.txt', 'x');

    // 手工从磁盘删掉，不经过 DELETE 接口——Task.attachments 里那条记录
    // 还在，磁盘上已经没有了（同步冲突/手滑删文件的模拟）。
    rmSync(join(dir, 'attachments', t.id, 'ghost.txt'));

    const listed = (await J(await get('/api/tasks'))) as Task[];
    expect(listed.find((x) => x.id === t.id)?.attachments).toEqual([]);
  });

  it('I1：没有附件的任务不会触发任何一次额外的 readdirSync（只扫 attachments 非空的）', async () => {
    await mkTask('没有附件');
    const t = await mkTask('有附件的');
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'x');

    const listed = (await J(await get('/api/tasks'))) as Task[];
    expect(listed.find((x) => x.title === '没有附件')?.attachments).toEqual([]);
    expect(listed.find((x) => x.id === t.id)?.attachments).toEqual(['a.txt']);
  });

  // I4（final-review.md）：saveAttachment 自己判定的「请求不合法」（400，带
  // 具体原因）要跟真正的 fs 异常（磁盘满、无权限……）分开——后者不能把 errno
  // 文本和服务器绝对路径原样回给客户端。用「attachmentsDir(taskId) 那个位置
  // 已经被一个同名的普通文件占住」制造一次真正的 fs 异常（mkdirSync 会抛，
  // 不是 saveAttachment 自己的校验路径）。
  it('I4：真正的 fs 异常回 500，不回原始 errno/服务器路径', async () => {
    const t = await mkTask();
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', t.id), '占住这个位置，逼 mkdirSync 抛真正的 fs 异常');

    const res = await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'x');
    expect(res.status).toBe(500);
    const body = (await J(res)) as { error: string };
    expect(body.error).not.toMatch(/ENOENT|ENOTDIR|EEXIST|EACCES/);
    expect(body.error).not.toMatch(/[/\\]/); // 不含路径分隔符——没有把服务器路径带出来
  });

  // m2（final-review.md）：resolve 那道守卫挡不住「路径恰好等于目录本身」
  // 这类请求（同步客户端常在附件目录下留一个 `.sync` 子目录）——唯一挡住
  // 它的是 resolveAttachment 里的 isFile() 那道，之前零覆盖，实测去掉之后
  // 会直接读到目录本身，statSync/readFileSync 抛出未捕获异常变成 500。
  it('m2：目录被当成文件名请求：404，不是 500', async () => {
    const t = await mkTask();
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');
    mkdirSync(join(dir, 'attachments', t.id, 'sub'), { recursive: true });

    const res = await get(`/api/tasks/${t.id}/attachments/sub`);
    expect(res.status).toBe(404);
  });
});

describe('未知的 /api 路径', () => {
  it('回 JSON 404，不是别的', async () => {
    const res = await app.request('/api/根本没有这个');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/json/);
  });
});

describe('意外抛错', () => {
  it('回 JSON 500 带上错误信息，不是 Hono 默认的 text/plain —— 前端 api.ts 的 res.json() 靠它才能读到真正的报错', async () => {
    // 服务跑着的时候文件被手改坏了是真实场景。换成 device.json 而不是
    // tasks.json——tasks 现在是一实体一文件，单条读坏了 entityStore.readAll
    // 会跳过、warn，不再抛错（有意的设计，见 entityStore.ts）；device.json
    // （设置搬去的地方，Task 5）还是老的整份文件读写，读坏了照样抛错。测的
    // 是同一件事：Hono 的全局错误处理器把抛出的异常包成 JSON，不是默认的
    // text/plain。
    writeFileSync(join(dir, 'device.json'), '{ 这不是合法 JSON', 'utf8');
    const res = await app.request('/api/settings');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/device\.json/);
  });
});

describe('冲突副本', () => {
  it('GET /api/conflicts 列出来', async () => {
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'tasks', '甲 (冲突副本 2026-08-15).json'), '{}', 'utf8');
    const r = await get('/api/conflicts');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ kind: 'tasks', file: '甲 (冲突副本 2026-08-15).json' }]);
  });

  it('没有冲突时是空数组，不是 404', async () => {
    const r = await get('/api/conflicts');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

/**
 * 手机把离线期间的改动推回来。**判定矩阵 ×（任务 / 收件箱）两类实体，一格一条。**
 * 判定这一半的单元测试在 `push.test.ts`（`decidePush` 的判定表）——这里测的是
 * 「判定接到文件上」那一半：哪些文件真的被改了、垃圾箱里有没有、副本写没写、
 * 引用清没清。全程用 `beforeEach` 建的临时 `DATA_DIR`。
 */
describe('POST /api/push', () => {
  const push = (body: unknown) => post('/api/push', body);
  const up = (id: string, base: unknown, value: unknown) => ({ id, op: 'upsert', base, value });
  const rm = (id: string, base: unknown) => ({ id, op: 'delete', base, value: null });
  const empty = { tasks: [], inbox: [] };
  const daily: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };
  const inboxItem = (p: Partial<InboxItem> = {}): InboxItem =>
    ({ id: 'i1', text: '原文', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...p });
  const resBody = async (res: Response) => (await res.json()) as PushResponse;
  const copies = (kind: 'tasks' | 'inbox') => listConflicts(paths()[kind]);
  const readCopy = (kind: 'tasks' | 'inbox', name: string) =>
    JSON.parse(readFileSync(join(paths()[kind], name), 'utf8')) as Record<string, unknown>;

  // ── 任务：改过的 ──

  it('改过的、服务端没动 → 推上去，服务端那份变成手机那份', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    const mine = { ...t, title: '手机改的', updatedAt: '2026-08-22T01:00:00.000Z' };
    const res = await push({ ...empty, tasks: [up(t.id, t, mine)] });
    expect(res.status).toBe(200);
    expect((await resBody(res)).tasks).toEqual({ pushed: [t.id], cleared: [], conflicted: [] });
    expect(readTasks()).toEqual([mine]);
    expect(copies('tasks')).toEqual([]);
  });

  it('改过的、服务端也改过 → 服务端那份纹丝不动，手机那份进冲突副本', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([{ ...t, title: '桌面改的' }]);
    const res = await push({ ...empty, tasks: [up(t.id, t, { ...t, title: '手机改的' })] });
    expect((await resBody(res)).tasks).toEqual({ pushed: [], cleared: [], conflicted: [t.id] });
    expect(readTasks()[0].title).toBe('桌面改的');
    const names = copies('tasks');
    expect(names).toHaveLength(1);
    expect(readCopy('tasks', names[0]).title).toBe('手机改的');
  });

  it('改过的、两边已经一样 → cleared，不写副本（上一次推成功、回执丢了）', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([{ ...t, title: '手机改的' }]);
    const res = await push({ ...empty, tasks: [up(t.id, t, { ...t, title: '手机改的' })] });
    expect((await resBody(res)).tasks).toEqual({ pushed: [], cleared: [t.id], conflicted: [] });
    expect(copies('tasks')).toEqual([]);
  });

  it('新建的 → 服务端多一条，**id 就是手机那个**（不是服务端另发一个）', async () => {
    const mine = { ...newTask({ title: '离线新记的' }), id: 'phone-uuid-1' };
    const res = await push({ ...empty, tasks: [up('phone-uuid-1', null, mine)] });
    expect((await resBody(res)).tasks.pushed).toEqual(['phone-uuid-1']);
    expect(readTasks().map((x) => x.id)).toEqual(['phone-uuid-1']);
  });

  it('改过的、服务端已经把它删了 → 不复活，写冲突副本', async () => {
    const t = newTask({ title: '原文' });
    const res = await push({ ...empty, tasks: [up(t.id, t, { ...t, title: '手机改的' })] });
    expect((await resBody(res)).tasks.conflicted).toEqual([t.id]);
    expect(readTasks()).toEqual([]);
    expect(copies('tasks')).toHaveLength(1);
  });

  // ── 任务：删掉的 ──

  it('删掉的、服务端没动 → 真删，而且是软删除（进垃圾箱，不是抹掉）', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    const res = await push({ ...empty, tasks: [rm(t.id, t)] });
    expect((await resBody(res)).tasks.pushed).toEqual([t.id]);
    expect(readTasks()).toEqual([]);
    expect(readTrash().map((x) => x.id)).toEqual([t.id]);
    expect(copies('tasks')).toEqual([]);
  });

  /**
   * **手机重建的 id 要从服务端垃圾箱里摘掉。** 离线删 → 推（服务端搬进垃圾箱）→
   * 又离线、从手机垃圾箱还原 → 再推：这条以 `base: null` 的 upsert 到达，判「直接
   * 创建」。原来只写 `tasks`、不碰 `trash`，一条任务同时活在两边——直到他点
   * 「清空垃圾箱」，`removeAllAttachments` 按垃圾箱里的 id 删附件目录，**把一条活着
   * 的任务的附件删光**。下面走完整个链路，最后一步断言的就是那个附件还在。
   */
  it('推回来一条服务端垃圾箱里的 id：从垃圾箱摘掉，清空垃圾箱不会误删它的附件', async () => {
    const t = (await (await post('/api/tasks', { title: '有附件的' })).json()) as Task;
    await upload(`/api/tasks/${t.id}/attachments`, 'a.txt', 'A');
    // 离线删了、推回去：服务端进垃圾箱
    await push({ ...empty, tasks: [rm(t.id, readTasks()[0])] });
    expect(readTrash().map((x) => x.id)).toEqual([t.id]);
    // 手机上又还原了、再推回来：base null = 「服务端现在没有这条」
    const revived = { ...t, attachments: ['a.txt'], order: null };
    const res = await push({ ...empty, tasks: [up(t.id, null, revived)] });
    expect((await resBody(res)).tasks.pushed).toEqual([t.id]);

    expect(readTasks().map((x) => x.id)).toEqual([t.id]);
    expect(readTrash(), '不能同时活在两边').toEqual([]);
    await del('/api/trash');                  // 清空垃圾箱
    expect(resolveAttachment(t.id, 'a.txt'), '活着的任务的附件不能被清空垃圾箱删掉').not.toBeNull();
  });

  /**
   * **三方比较拿「GET 给出去的样子」当服务端那份。** 附件盘上按上传顺序存、GET
   * 按排序给；手机存的基准是排过序的那份。原来 `decidePush` 拿盘上那份比：跟基准
   * 的数组顺序不同 → 每一次离线编辑都判 conflict，改动推不回去、写副本，而盘上
   * 那份永远不会被纠正——每次联网再撞一次。「合」排在「报」前面，所以下面这两个
   * 文件名的上传顺序和排序结果正好相反。
   */
  it('附件顺序盘上和 GET 不一样时，拿 GET 那份当基准的离线编辑照样推得回去', async () => {
    const t = (await (await post('/api/tasks', { title: '有两个附件' })).json()) as Task;
    await upload(`/api/tasks/${t.id}/attachments`, '报告.pdf', 'A');
    await upload(`/api/tasks/${t.id}/attachments`, '合同.pdf', 'B');
    // 前提：盘上是上传顺序，GET 是排序——两份真的不一样，不然这条在守空气
    expect(readTasks()[0].attachments).toEqual(['报告.pdf', '合同.pdf']);
    const served = ((await (await get('/api/tasks')).json()) as Task[])[0];
    expect(served.attachments).toEqual(['合同.pdf', '报告.pdf']);

    // 手机拿 GET 那份当基准，离线改了标题
    const res = await push({ ...empty, tasks: [up(t.id, served, { ...served, title: '离线改的标题' })] });
    const body = await resBody(res);
    expect(body.tasks.conflicted, '这不是撞车，是同一份数据的两种顺序').toEqual([]);
    expect(body.tasks.pushed).toEqual([t.id]);
    expect(readTasks()[0].title).toBe('离线改的标题');
    expect(copies('tasks')).toEqual([]);
  });

  /**
   * **只差大小写的 id 判成撞车，不当新建。** 盘上有 `foo`，推上来一个 `Foo`（base
   * null = 「离线新建」）：`byId.has('Foo')` 是 false，原来一路判「直接创建」——
   * Windows 上那就是把 `foo.json` 的内容换掉。存储层现在会拒（抛错），但抛到这儿
   * 会让整批 500；路由把它判成撞车、写副本，`foo` 不动，同一批别的照推。
   */
  it('推上来一个只差大小写的 id：撞车、写副本，原件不动，同批别的照推', async () => {
    const foo = { ...newTask({ title: '原件' }), id: 'foo' };
    writeTasks([foo]);
    const other = newTask({ title: '同批正常的一条' });
    const res = await push({ ...empty, tasks: [
      up('Foo', null, { ...foo, id: 'Foo', title: '冒名的' }),
      up(other.id, null, other),
    ] });
    const body = await resBody(res);
    expect(body.tasks.conflicted).toEqual(['Foo']);
    expect(body.tasks.pushed).toEqual([other.id]);
    expect(readTasks().map((t) => [t.id, t.title]).sort()).toEqual([['foo', '原件'], [other.id, '同批正常的一条']].sort());
    expect(copies('tasks')).toHaveLength(1);
  });

  it('删掉的、服务端在这期间改过 → **不删**，写冲突副本，副本里带 deletedAt 说明是被删的', async () => {
    // 「服务端此刻」由这条测试控制住：`deletedAt` 是路由现盖的章，不冻时钟就只
    // 断言得了「非空」，断言不了「盖的是不是这一刻」。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-22T03:00:00.000Z'));
    try {
      const t = newTask({ title: '原文' });
      writeTasks([{ ...t, title: '桌面刚编辑过' }]);
      const res = await push({ ...empty, tasks: [rm(t.id, t)] });
      expect((await resBody(res)).tasks.conflicted).toEqual([t.id]);
      expect(readTasks()[0].title).toBe('桌面刚编辑过');
      expect(readTrash()).toEqual([]);
      const copy = readCopy('tasks', copies('tasks')[0]);
      expect(copy.id).toBe(t.id);
      expect(copy.title).toBe('原文');          // 副本里是**基准**，不是服务端那份
      expect(copy.deletedAt).toBe('2026-08-22T03:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('删掉的、没有基准（旧格式迁移来的）→ 不删也不写副本，只清记号', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    const res = await push({ ...empty, tasks: [rm(t.id, null)] });
    expect((await resBody(res)).tasks.cleared).toEqual([t.id]);
    expect(readTasks()).toHaveLength(1);
    expect(copies('tasks')).toEqual([]);
  });

  it('真删的时候顺手清掉收件箱里指向它的 taskIds', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    writeInbox([inboxItem({ text: '买菜', processed: true, taskIds: [t.id] })]);
    await push({ ...empty, tasks: [rm(t.id, t)] });
    expect(readInbox()[0].taskIds).toEqual([]);
  });

  it('真删的时候顺手清掉这条任务名下的提议（跟 DELETE /api/tasks 同一份清理）', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    writeProposals([{ id: 'p1', taskId: t.id, patch: { title: '改个名' }, reason: '因为', createdAt: '2026-08-01T00:00:00.000Z' }]);
    await push({ ...empty, tasks: [rm(t.id, t)] });
    expect(readProposals()).toEqual([]);
  });

  // ── 收件箱 ──

  it('收件箱：新建的推上去，改过的按同一套三方比较', async () => {
    const server = inboxItem();
    writeInbox([server]);
    const res = await push({
      tasks: [],
      inbox: [
        up('i1', server, { ...server, text: '手机改的' }),
        up('i2', null, inboxItem({ id: 'i2', text: '离线随手记', createdAt: '2026-08-22T00:00:00.000Z' })),
      ],
    });
    expect((await resBody(res)).inbox.pushed.slice().sort()).toEqual(['i1', 'i2']);
    expect(readInbox().map((x) => x.text).sort()).toEqual(['手机改的', '离线随手记'].sort());
  });

  it('收件箱：删掉的、服务端在这期间改过 → 不删，副本写进 inbox 目录（不是 tasks 目录）', async () => {
    const server = inboxItem();
    writeInbox([{ ...server, text: '桌面改过的' }]);
    const res = await push({ tasks: [], inbox: [rm('i1', server)] });
    expect((await resBody(res)).inbox.conflicted).toEqual(['i1']);
    expect(readInbox()[0].text).toBe('桌面改过的');
    expect(copies('tasks')).toEqual([]);
    expect(copies('inbox')).toHaveLength(1);
    expect(readCopy('inbox', copies('inbox')[0]).text).toBe('原文');
  });

  it('收件箱：删掉的、服务端没动 → 真删（收件箱没有垃圾箱这回事，就是删掉）', async () => {
    const server = inboxItem();
    writeInbox([server]);
    const res = await push({ tasks: [], inbox: [rm('i1', server)] });
    expect((await resBody(res)).inbox.pushed).toEqual(['i1']);
    expect(readInbox()).toEqual([]);
  });

  // 下面三条补的是 inbox 那半原来零覆盖的三格。**两半是刻意分开的两份代码**（不合并成
  // 泛型，见 applyInboxPush 顶部），所以 tasks 那边的绿一点都保不了 inbox：实测把
  // applyInboxPush 的整个 clear 分支删掉、或者让它撞车只报 conflicted 不写副本，
  // 原来那 174 条全绿。

  it('收件箱：改过的、两边已经一样 → cleared，不写盘也不写副本', async () => {
    // clear 桶丢了的后果：手机那个记号永远清不掉，每次重连都再推一遍，无限循环。
    const server = inboxItem();
    writeInbox([server]);
    const res = await push({ tasks: [], inbox: [up('i1', inboxItem({ text: '更早那版' }), server)] });
    expect((await resBody(res)).inbox).toEqual({ pushed: [], cleared: ['i1'], conflicted: [] });
    expect(readInbox()).toEqual([server]);
    expect(copies('inbox')).toEqual([]);
  });

  it('收件箱：删掉的、服务端也已经没有了 / 没有基准 → cleared，一条都不删', async () => {
    writeInbox([inboxItem({ id: 'i3', text: '还在服务端上' })]);
    const res = await push({ tasks: [], inbox: [rm('i1', inboxItem()), rm('i3', null)] });
    expect((await resBody(res)).inbox.cleared.slice().sort()).toEqual(['i1', 'i3']);
    expect(readInbox().map((x) => x.id)).toEqual(['i3']);
    expect(copies('inbox')).toEqual([]);
  });

  it('收件箱：改过的、服务端也改过 → 服务端那份纹丝不动，手机那份进冲突副本', async () => {
    // 副本没写的后果最坏：手机那次编辑在服务端没有、在副本里也没有，而回执说
    // conflicted、记号照清——两边都没了，还没有信号。
    const base = inboxItem();
    writeInbox([{ ...base, text: '桌面改的' }]);
    const res = await push({ tasks: [], inbox: [up('i1', base, { ...base, text: '手机改的' })] });
    expect((await resBody(res)).inbox).toEqual({ pushed: [], cleared: [], conflicted: ['i1'] });
    expect(readInbox()[0].text).toBe('桌面改的');
    const names = copies('inbox');
    expect(names).toHaveLength(1);
    expect(readCopy('inbox', names[0]).text).toBe('手机改的');
  });

  it('**收件箱先于任务**：这次刚推上去的收件箱条目，taskIds 里的死链接照样清得掉', async () => {
    // 顺序反过来的话，清引用那一步读到的是**这次推送之前**的收件箱，i2 还不存在，
    // 于是它带着一个指向已删任务的 taskIds 落盘——一条点不开的死链接。
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    const mine = inboxItem({ id: 'i2', text: '离线记的', processed: true, taskIds: [t.id] });
    const res = await push({ tasks: [rm(t.id, t)], inbox: [up('i2', null, mine)] });
    expect((await resBody(res)).inbox.pushed).toEqual(['i2']);
    expect(readInbox()[0].taskIds).toEqual([]);
  });

  // ── 重复任务：两道守卫 ──

  it('**重复任务不会被推成两条**：手机离线完成生成的下一条推上去，服务端不再自己生成一条', async () => {
    // 守卫一：这条路由整条不跑生成语义（不调 applyTaskPatch、不调
    // maybeSpawnNextInstance）。手机离线时已经用同一份 mutate.ts 算过一遍了，
    // 服务端再算一遍就是算第二遍——两条同标题同 due 的卡，而用户只完成过一次。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-22T09:30:00.000Z'));
    try {
      const t = newTask({ title: '倒垃圾', due: '2026-08-22T09:00:00.000Z', repeat: daily });
      writeTasks([t]);
      const done = { ...t, status: 'done' as const, completedAt: '2026-08-22T09:30:00.000Z', updatedAt: '2026-08-22T09:30:00.000Z' };
      const born = { ...t, id: 'phone-born', due: '2026-08-23T09:00:00.000Z', status: 'todo' as const };
      const res = await push({ ...empty, tasks: [up(t.id, t, done), up('phone-born', null, born)] });
      expect((await resBody(res)).tasks.pushed.slice().sort()).toEqual([t.id, 'phone-born'].sort());
      expect(readTasks()).toHaveLength(2);
      expect(readTasks().filter((x) => x.status !== 'done')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('**守卫一自己也守得住**：只推完成掉的那条（born 没跟着推），服务端照样不生成下一条', async () => {
    // 上面那条测试有守卫二兜着（born 在同一批里，撞得上）。这条把守卫二拿掉：
    // 只推「完成」，不推 born——旧版本手机不本地生成下一条、born 的记号丢了、
    // born 上一轮已经推成功清了记号，三条都是真实走法。这时 `next` 里没有 born
    // 可撞，**守卫一（这条路由压根不跑生成语义）是唯一挡着的那一道**。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-22T09:30:00.000Z'));
    try {
      const t = newTask({ title: '倒垃圾', due: '2026-08-22T09:00:00.000Z', repeat: daily });
      writeTasks([t]);
      const done = { ...t, status: 'done' as const, completedAt: '2026-08-22T09:30:00.000Z', updatedAt: '2026-08-22T09:30:00.000Z' };
      const res = await push({ ...empty, tasks: [up(t.id, t, done)] });
      expect((await resBody(res)).tasks.pushed).toEqual([t.id]);
      expect(readTasks()).toHaveLength(1);
      expect(readTasks()[0].status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('**桌面也完成过同一条**：手机那条新实例不再创建第三条，判成 conflicted 并写副本', async () => {
    // 守卫二：hasTwinInstance（跟 maybeSpawnNextInstance 内部共用同一份查重判据）。
    // **判成同款走 conflict、不走 clear**：clear 会让手机清掉记号、本地那条随下一次
    // 回填消失，服务端又从来没有过它——判错的话这条实体就不存在了，而且没有信号。
    // 同一份判据在 mutate.ts 那层判错只是「少生成一次」，代价完全不同，两层刻意不一致。
    const t = newTask({ title: '倒垃圾', due: '2026-08-22T09:00:00.000Z', repeat: daily });
    const deskBorn = { ...t, id: 'desk-born', due: '2026-08-23T09:00:00.000Z', status: 'todo' as const };
    writeTasks([{ ...t, status: 'done' as const }, deskBorn]);
    const born = { ...t, id: 'phone-born', due: '2026-08-23T09:00:00.000Z', status: 'todo' as const };
    const res = await push({ ...empty, tasks: [up('phone-born', null, born)] });
    expect((await resBody(res)).tasks).toEqual({ pushed: [], cleared: [], conflicted: ['phone-born'] });
    expect(readTasks().filter((x) => x.status !== 'done').map((x) => x.id)).toEqual(['desk-born']);
    // 手机那份没丢，在副本里——人看得见、删得掉。
    const names = copies('tasks');
    expect(names).toHaveLength(1);
    expect(readCopy('tasks', names[0]).id).toBe('phone-born');
  });

  it('查重只管重复任务：离线新建的**普通**任务撞上一条同标题同 due 的重复任务，照样创建', async () => {
    // 上限方向的守卫：那份判据只看服务端那一行有没有 repeat，不看候选者有没有。
    // 少了 `repeat 非空` 这个条件，手机上真的新建的一条普通任务会被判成撞车、
    // 白写一份副本，而它本该直接建出来。
    const t = newTask({ title: '倒垃圾', due: '2026-08-23T09:00:00.000Z', repeat: daily });
    writeTasks([t]);
    const mine = { ...newTask({ title: '倒垃圾', due: '2026-08-23T09:00:00.000Z' }), id: 'phone-plain' };
    const res = await push({ ...empty, tasks: [up('phone-plain', null, mine)] });
    expect((await resBody(res)).tasks.pushed).toEqual(['phone-plain']);
    expect(readTasks()).toHaveLength(2);
    expect(copies('tasks')).toEqual([]);
  });

  // ── 整批拒绝：形状 / id ──

  it('形状不对 → 整批 400，一个文件都不碰（不是「跳过那一条」），而且说得出是哪一条', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    // 坏的那条排在**第二位**，前面那条是好的——「说得出是哪条」要真的定位，不是
    // 每次都报第一条。id 特意起得一眼认得出（141）：叫 'x' 的话「报对了」和
    // 「随便报了个什么」在断言里长得差不多。
    const res = await push({ tasks: [up(t.id, t, { ...t, title: '手机改的' }), { id: '坏掉的那条-9527', op: 'merge' }], inbox: [] });
    expect(res.status).toBe(400);
    expect(readTasks()[0].title).toBe('原文');
    expect(copies('tasks')).toEqual([]);

    // 不说是哪条的话，用户所有离线改动都推不回去而他不知道该去动哪条——这个状态
    // 不可自愈。位置和「怎么修」也要在：光有 id 他还得自己猜是任务还是收件箱。
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain('坏掉的那条-9527');
    expect(err).toContain('第 2 条');
    expect(err).toContain('任务');
    expect(err).toContain('重新编辑');
  });

  it('坏的那条连 id 都没有 → 400 报得出位置（不能因为读不到 id 就说不出话）', async () => {
    const res = await push({ ...empty, tasks: [{ op: 'upsert', base: null, value: null }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('第 1 条');
  });

  it('坏的那条在收件箱那一半 → 报的是收件箱，不是任务（两半各报各的）', async () => {
    const res = await push({ tasks: [], inbox: [{ id: '收件箱里坏掉的-8642', op: 'merge' }] });
    expect(res.status).toBe(400);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain('收件箱里坏掉的-8642');
    expect(err).toContain('收件箱');
    expect(err).not.toContain('任务里的');
  });

  it('请求体根本不是 { tasks, inbox } → 400', async () => {
    expect((await push({})).status).toBe(400);
    expect((await push(null)).status).toBe(400);
    expect((await push({ tasks: [], inbox: {} })).status).toBe(400);
  });

  it('value 明显不是一条任务 → 整批 400，不会被原样落盘成 data/tasks/<id>.json', async () => {
    // 这是这个服务上唯一一条接收另一台设备数据的路由；其余每条写路由都过一份
    // 字段白名单。零校验的话下面这个对象会变成看板上一张什么都没有的卡。
    const res = await push({ ...empty, tasks: [up('乱来的', null, { id: '乱来的', 随便: [1, 2, 3] })] });
    expect(res.status).toBe(400);
    expect(readTasks()).toEqual([]);
    expect(existsSync(join(paths().tasks, '乱来的.json'))).toBe(false);
  });

  it('value 明显不是一条收件箱条目 → 整批 400（两个桶各量各的尺子）', async () => {
    const res = await push({ tasks: [], inbox: [up('x', null, { ...newTask({ title: '这是任务不是收件箱' }), id: 'x' })] });
    expect(res.status).toBe(400);
    expect(readInbox()).toEqual([]);
  });

  it('多一个不认识的字段的任务（更新版本的手机）→ 照样 200 推得上去，不是 400', async () => {
    // 判太严的后果不对称：用户离线期间的改动会永远推不回去。
    const mine = { ...newTask({ title: '离线新记的' }), id: 'phone-uuid-2', 未来才有的字段: 1 };
    const res = await push({ ...empty, tasks: [up('phone-uuid-2', null, mine)] });
    expect(res.status).toBe(200);
    expect((await resBody(res)).tasks.pushed).toEqual(['phone-uuid-2']);
  });

  it('id 不安全（路径穿越）→ 400，不写任何文件，而且说得出是哪个 id', async () => {
    const res = await push({ ...empty, tasks: [up('../跑出去', null, { ...newTask({ title: 'x' }), id: '../跑出去' })] });
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, '跑出去.json'))).toBe(false);
    // 跟形状那条同一个理由：不报出来的话整批永远推不回去而他不知道是哪条。
    // **这一支不给「怎么修」的建议**——id 本身不能用，重新编辑甚至删掉它带的还是
    // 同一个 id，编一句修不好的建议比不给更糟。
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toContain('../跑出去');
    expect(err).not.toContain('重新编辑');
  });

  it('id 长得像冲突副本 → 400。写进去的话 writeOne 成功、readAll 永远读不到，而且零报错', async () => {
    const id = 'a (冲突副本 x)';
    const res = await push({ ...empty, tasks: [up(id, null, { ...newTask({ title: '手机的' }), id })] });
    expect(res.status).toBe(400);
    expect(readTasks()).toEqual([]);
    expect(copies('tasks')).toEqual([]);
  });

  it('空推送 → 200，三个桶都是空的，什么都不写', async () => {
    const res = await push(empty);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tasks: { pushed: [], cleared: [], conflicted: [] },
      inbox: { pushed: [], cleared: [], conflicted: [] },
    });
  });
});

/**
 * 批量 PATCH 的第二种请求体：`{ patches: [{id, patch}] }`——**每条各改各的**。
 * 批量改期、「推迟一小时」都是这种：「原计划整个往后挪一小时」逐条算出来的
 * 时刻互不相同，`{ids, patch}` 那份共享 patch 表达不了。
 */
describe('PATCH /api/tasks：每条各改各的（patches）', () => {
  const app = createApp();

  it('两条各改各的，一次请求都落盘', async () => {
    const a = await (await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '甲' }),
    })).json() as Task;
    const b = await (await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '乙' }),
    })).json() as Task;

    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patches: [
        { id: a.id, patch: { due: '2026-09-01T10:00:00.000Z' } },
        { id: b.id, patch: { due: '2026-09-02T10:00:00.000Z' } },
      ] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });

    const rows = await (await app.request('/api/tasks')).json() as Task[];
    expect(rows.find((t) => t.id === a.id)!.due).toBe('2026-09-01T10:00:00.000Z');
    expect(rows.find((t) => t.id === b.id)!.due).toBe('2026-09-02T10:00:00.000Z');
  });

  it('一条 patch 校验不过就整批退回——半批生效的批量操作没法解释', async () => {
    const a = await (await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '甲' }),
    })).json() as Task;

    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patches: [
        { id: a.id, patch: { due: '2026-09-01T10:00:00.000Z' } },
        { id: a.id, patch: { status: '随便写的' } },
      ] }),
    });
    expect(res.status).toBe(400);
    const rows = await (await app.request('/api/tasks')).json() as Task[];
    expect(rows.find((t) => t.id === a.id)!.due).toBeNull();
  });

  it('两种请求体走同一段代码：{ids, patch} 仍然照旧', async () => {
    const a = await (await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '甲' }),
    })).json() as Task;
    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], patch: { priority: 3 } }),
    });
    expect(await res.json()).toEqual({ updated: 1 });
    const rows = await (await app.request('/api/tasks')).json() as Task[];
    expect(rows.find((t) => t.id === a.id)!.priority).toBe(3);
  });

  it('两个键都不给：400，不当成「什么都不用改」悄悄成功', async () => {
    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { priority: 3 } }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * 倒数纪念日的 CRUD（仿滴答清单的倒数日模块）。
 */
describe('/api/countdowns', () => {
  const app = createApp();
  const post = (body: unknown) => app.request('/api/countdowns', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('建 → 读回来', async () => {
    const res = await post({ title: '期末考', date: '2026-12-20', yearly: false });
    expect(res.status).toBe(200);
    const row = await res.json() as { id: string; title: string; date: string; yearly: boolean };
    expect(row).toMatchObject({ title: '期末考', date: '2026-12-20', yearly: false });
    expect(await (await app.request('/api/countdowns')).json()).toHaveLength(1);
  });

  it('yearly 不给就落 false', async () => {
    const row = await (await post({ title: '生日', date: '2026-03-10' })).json() as { yearly: boolean };
    expect(row.yearly).toBe(false);
  });

  it('没名字 / 没日期：400，点名是哪个字段', async () => {
    expect((await post({ date: '2026-12-20' })).status).toBe(400);
    expect((await post({ title: '期末考' })).status).toBe(400);
  });

  it('日期不存在（2026-02-30）：400，不是悄悄存一个会溢出的日子', async () => {
    const res = await post({ title: 'x', date: '2026-02-30' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('date');
  });

  it('改一个字段，别的原样，updatedAt 跟着盖章', async () => {
    const row = await (await post({ title: '期末考', date: '2026-12-20' })).json() as { id: string; updatedAt: string };
    const res = await app.request(`/api/countdowns/${row.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yearly: true }),
    });
    const next = await res.json() as { title: string; date: string; yearly: boolean; updatedAt: string };
    expect(next).toMatchObject({ title: '期末考', date: '2026-12-20', yearly: true });
    expect(Date.parse(next.updatedAt)).toBeGreaterThanOrEqual(Date.parse(row.updatedAt));
  });

  it('改一个不存在的：404', async () => {
    const res = await app.request('/api/countdowns/没有这个', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yearly: true }),
    });
    expect(res.status).toBe(404);
  });

  it('删掉——**不进垃圾箱**，垃圾箱是给任务的，纪念日重建成本约等于零', async () => {
    const row = await (await post({ title: '期末考', date: '2026-12-20' })).json() as { id: string };
    expect((await app.request(`/api/countdowns/${row.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await (await app.request('/api/countdowns')).json()).toEqual([]);
    expect(await (await app.request('/api/trash')).json()).toEqual([]);
  });

  it('删一个不存在的：404', async () => {
    expect((await app.request('/api/countdowns/没有这个', { method: 'DELETE' })).status).toBe(404);
  });
});

/**
 * 完成父任务连带完成子任务（仿滴答清单）。判据和边界在
 * `mutate.test.ts` 的 `cascadeChildrenDone`——这里只测**两条写路由都接上了**：
 * 单条 PATCH 和批量 PATCH 各写一遍最容易静默分叉，跟生成重复实例同一条教训。
 */
describe('完成父任务 → 子任务一起完成：两条 PATCH 路由都接上', () => {
  const app = createApp();

  const family = () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', createdAt: stamp, updatedAt: stamp });
    const k1 = newTask({ title: '刷墙', parentId: p.id, createdAt: stamp, updatedAt: stamp });
    const k2 = newTask({ title: '装灯', parentId: p.id, status: 'later', createdAt: stamp, updatedAt: stamp });
    writeTasks([p, k1, k2]);
    return { p, k1, k2 };
  };

  const statusOf = (rows: Task[], id: string) => rows.find((t) => t.id === id)!.status;

  it('单条 PATCH 把父任务标完成，「刷墙」跟着完成，搁置的「装灯」不动', async () => {
    const { p, k1, k2 } = family();

    const res = await app.request(`/api/tasks/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(200);

    const rows = readTasks();
    expect(statusOf(rows, k1.id)).toBe('done');
    expect(rows.find((t) => t.id === k1.id)!.completedAt).not.toBeNull();
    expect(statusOf(rows, k2.id)).toBe('later');
  });

  it('批量 PATCH 走同一条——批量那边漏接的话，多选完成会静默留下一堆开着的子任务', async () => {
    const { p, k1 } = family();

    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [p.id], patch: { status: 'done' } }),
    });
    expect(res.status).toBe(200);

    expect(statusOf(readTasks(), k1.id)).toBe('done');
  });

  it('连带完成的重复子任务**不生成下一条**——凭空造一件挂在已完成父亲下面、没人要求做的事', async () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', createdAt: stamp, updatedAt: stamp });
    const kid = newTask({
      title: '每天验收', parentId: p.id, due: '2026-08-20T01:00:00.000Z',
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
      createdAt: stamp, updatedAt: stamp,
    });
    writeTasks([p, kid]);

    await app.request(`/api/tasks/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });

    expect(readTasks().filter((t) => t.title === '每天验收')).toHaveLength(1);
  });
});

/**
 * `POST /api/tasks` 建的时候就带 `parentId` / `status: 'done'`——「检查事项转为
 * 子任务」走的就是这条路，两条守卫都是那次补上的。
 */
describe('POST /api/tasks：建的时候就挂父亲 / 就是已完成', () => {
  const app = createApp();

  const post = (body: Record<string, unknown>) =>
    app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  /**
   * **这条整个反过来了**：只做一层那时候「挂到一条已经是子任务的任务下面」
   * 是 400（不建出孙子来），五层下它是正常操作。
   *
   * 这个口子本身仍然要守——POST 那条路由必须过 `checkParentLink`，否则能绕开
   * 深度和环两条判据。所以下面第二条改成测真正的上限：第五层下面再挂就是 400。
   */
  it('挂到一条已经是子任务的任务下面 → 建得出来，那只是第三层', async () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', createdAt: stamp, updatedAt: stamp });
    const kid = newTask({ title: '刷墙', parentId: p.id, createdAt: stamp, updatedAt: stamp });
    writeTasks([p, kid]);

    const res = await post({ title: '打磨', parentId: kid.id });
    expect(res.status).toBe(201);
    expect(readTasks().some((t) => t.title === '打磨')).toBe(true);
  });

  it('第五层下面再挂 → 400，POST 那条路由真的过了 checkParentLink', async () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const chain = Array.from({ length: 5 }, (_, i) => newTask({
      title: `第${i + 1}层`, createdAt: stamp, updatedAt: stamp,
    })).map((t, i, arr) => (i === 0 ? t : { ...t, parentId: arr[i - 1]!.id }));
    writeTasks(chain);

    const res = await post({ title: '第六层', parentId: chain[4]!.id });
    expect(res.status).toBe(400);
    expect(readTasks().some((t) => t.title === '第六层')).toBe(false);
  });

  it('父亲不存在也 400——静默改成 null 会让人看见「点了没反应」', async () => {
    writeTasks([]);
    expect((await post({ title: '打磨', parentId: 'nope' })).status).toBe(400);
  });

  it('正常挂得上', async () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', createdAt: stamp, updatedAt: stamp });
    writeTasks([p]);
    const res = await post({ title: '刷墙', parentId: p.id });
    expect(res.status).toBe(201);
    expect((await res.json() as Task).parentId).toBe(p.id);
  });

  it('**建出来就是已完成的，完成时刻当场盖上**——`status: done` 配 `completedAt: null` 会让「已完成」和习惯历史都当这条不存在', async () => {
    writeTasks([]);
    const t = await (await post({ title: '刷墙', status: 'done' })).json() as Task;
    expect(t.status).toBe('done');
    expect(t.completedAt).toBe(t.createdAt);
  });

  it('建出来是待办的不盖章', async () => {
    writeTasks([]);
    expect((await (await post({ title: '刷墙' })).json() as Task).completedAt).toBeNull();
  });
});

/**
 * 每日概览那两个设置字段。`dailySummaryOn` 是**服务端盖的章**，跟
 * `Reminder.firedAt` 同一类——客户端写不了，也不能被一次保存冲掉。
 */
describe('PUT /api/settings：每日概览', () => {
  const app = createApp();

  const put = (body: Record<string, unknown>) =>
    app.request('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('HH:MM 存得下', async () => {
    const s = await (await put({ dailySummaryAt: '08:30' })).json() as Settings;
    expect(s.dailySummaryAt).toBe('08:30');
  });

  it('**写坏的时刻当没设，不猜一个最接近的**——猜了会让人以为设成功了，而通知在别的时候响', async () => {
    for (const bad of ['8:30', '24:00', '早上八点', 830]) {
      expect((await (await put({ dailySummaryAt: bad })).json() as Settings).dailySummaryAt, String(bad)).toBeNull();
    }
  });

  it('留空 = 不推', async () => {
    expect((await (await put({ dailySummaryAt: '' })).json() as Settings).dailySummaryAt).toBeNull();
  });

  it('**保存设置不会冲掉「今天发过了」那个章**——冲掉的话在设置页随手按一次保存，当天的概览就会再推一遍', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, dailySummaryAt: '08:00', dailySummaryOn: '2026-08-19' });
    const s = await (await put({ dailySummaryAt: '09:00' })).json() as Settings;
    expect(s.dailySummaryOn).toBe('2026-08-19');
  });

  it('客户端**写不了**那个章——请求体里带上也不采信', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, dailySummaryOn: null });
    const s = await (await put({ dailySummaryAt: '09:00', dailySummaryOn: '1999-01-01' })).json() as Settings;
    expect(s.dailySummaryOn).toBeNull();
  });
});

/**
 * `GET /api/broken`。补的是一个一直空着的承诺：`entityStore.readAll` 跳过读不
 * 出来的文件时，注释写着「界面上由上层负责把坏文件列出来」，而上层从来没做过
 * ——于是一条同步坏掉的任务就这么从界面上无声消失，谁都不知道少了东西。
 */
describe('GET /api/broken：读不出来的文件报得出来', () => {
  const app = createApp();

  it('一切正常时是空的——一条干净的数据目录不该常驻一条横幅', async () => {
    writeTasks([newTask({ title: '写周报' })]);
    await app.request('/api/tasks');
    expect(await (await app.request('/api/broken')).json()).toEqual([]);
  });

  it('坏掉一条：别的照常读得出来，而这一条报得出来，带着是哪一类', async () => {
    writeTasks([newTask({ title: '好的' })]);
    writeFileSync(join(paths().tasks, 'broken.json'), '{ 这不是 JSON', 'utf8');

    // 先读一遍——判据挂在真的读盘那一趟上，不另外扫一次整个 data/。
    const rows = await (await app.request('/api/tasks')).json() as Task[];
    expect(rows.map((t) => t.title)).toEqual(['好的']);

    const broken = await (await app.request('/api/broken')).json() as Array<{ kind: string; file: string }>;
    expect(broken).toContainEqual({ kind: 'tasks', file: 'broken.json' });
  });
});

/**
 * `DELETE /api/trash`（清空垃圾箱，仿滴答清单）。补的是一个只能一条条点的
 * 坑：垃圾箱**从来不会自己清**，删得越多它越长，清掉两百条要点四百下。
 */
describe('DELETE /api/trash：清空', () => {
  const app = createApp();

  const trashTwo = async () => {
    writeTasks([newTask({ title: '甲' }), newTask({ title: '乙' })]);
    for (const t of readTasks()) await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' });
    expect(readTrash()).toHaveLength(2);
  };

  it('全清掉，回执报清了几条', async () => {
    await trashTwo();
    const res = await app.request('/api/trash', { method: 'DELETE' });
    expect(await res.json()).toEqual({ purged: 2 });
    expect(readTrash()).toEqual([]);
  });

  it('本来就空：回 0，不报错', async () => {
    writeTrash([]);
    expect(await (await app.request('/api/trash', { method: 'DELETE' })).json()).toEqual({ purged: 0 });
  });

  it('**没在垃圾箱里的任务不受影响**——清的是垃圾箱，不是任务表', async () => {
    await trashTwo();
    writeTasks([newTask({ title: '还活着' })]);

    await app.request('/api/trash', { method: 'DELETE' });

    expect(readTasks().map((t) => t.title)).toEqual(['还活着']);
  });

  it('附件跟着删——软删除不清附件目录，它们活到彻底删除这一步才真的没了', async () => {
    writeTasks([newTask({ title: '带附件的' })]);
    const [t] = readTasks();
    // 经真正的上传路由建目录，不自己拼路径：附件目录的位置是 attachments.ts
    // 的实现细节，测试里另拼一份等于把它抄成第二处。
    const body = new FormData();
    body.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }));
    await app.request(`/api/tasks/${t.id}/attachments`, { method: 'POST', body });
    expect(listAttachments(t.id)).toEqual(['a.txt']);

    await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' });
    await app.request('/api/trash', { method: 'DELETE' });

    expect(listAttachments(t.id)).toEqual([]);
  });
});

/**
 * 最后一个子任务做完 → 父任务自动完成。判据在 `mutate.test.ts` 的
 * `rollUpParentDone`；这里只测**两条写路由都接上了**——跟另外两条连带
 * （生成重复实例、完成父任务连带子任务）同一条教训，批量那边最容易漏。
 */
describe('完成最后一个子任务 → 父任务自动完成：两条 PATCH 路由都接上', () => {
  const app = createApp();

  const family = () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', createdAt: stamp, updatedAt: stamp });
    const k1 = newTask({ title: '刷墙', parentId: p.id, createdAt: stamp, updatedAt: stamp });
    const k2 = newTask({ title: '装灯', parentId: p.id, createdAt: stamp, updatedAt: stamp });
    writeTasks([p, k1, k2]);
    return { p, k1, k2 };
  };
  const statusOf = (id: string) => readTasks().find((t) => t.id === id)!.status;
  const done = (id: string) => app.request(`/api/tasks/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  });

  it('单条 PATCH：做完第一个父亲还开着，做完第二个父亲跟着完成', async () => {
    const { p, k1, k2 } = family();

    await done(k1.id);
    expect(statusOf(p.id)).toBe('todo');

    await done(k2.id);
    expect(statusOf(p.id)).toBe('done');
    expect(readTasks().find((t) => t.id === p.id)!.completedAt).not.toBeNull();
  });

  it('批量 PATCH 走同一条——一次把两个子任务都标完成，父亲照样跟着完成', async () => {
    const { p, k1, k2 } = family();

    const res = await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [k1.id, k2.id], patch: { status: 'done' } }),
    });
    expect(res.status).toBe(200);

    expect(statusOf(p.id)).toBe('done');
  });

  it('**自动完成的父亲不生成重复的下一条**——那不是「他做完了那条重复任务」，是一次连带', async () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({
      title: '每周大扫除', due: '2026-08-20T01:00:00.000Z',
      repeat: { every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
      createdAt: stamp, updatedAt: stamp,
    });
    const k = newTask({ title: '擦窗', parentId: p.id, createdAt: stamp, updatedAt: stamp });
    writeTasks([p, k]);

    await done(k.id);

    expect(statusOf(p.id)).toBe('done');
    expect(readTasks().filter((t) => t.title === '每周大扫除')).toHaveLength(1);
  });
});

/**
 * 父任务换清单 → 子任务跟着走。判据在 `mutate.test.ts`；这里测两条写路由
 * 都接上了，跟另外三条连带同一条教训。
 */
describe('父任务换清单：两条 PATCH 路由都接上', () => {
  const app = createApp();

  const family = () => {
    const stamp = '2026-08-01T00:00:00.000Z';
    const p = newTask({ title: '装修', listId: 'A', createdAt: stamp, updatedAt: stamp });
    const follows = newTask({ title: '刷墙', parentId: p.id, listId: 'A', createdAt: stamp, updatedAt: stamp });
    const apart = newTask({ title: '买料', parentId: p.id, listId: 'C', createdAt: stamp, updatedAt: stamp });
    writeTasks([p, follows, apart]);
    return { p, follows, apart };
  };
  const listOf = (id: string) => readTasks().find((t) => t.id === id)!.listId;

  it('单条 PATCH：跟着的那个跟过去，特意另放的那个不动', async () => {
    const { p, follows, apart } = family();

    await app.request(`/api/tasks/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listId: 'B' }),
    });

    expect(listOf(follows.id)).toBe('B');
    expect(listOf(apart.id)).toBe('C');
  });

  it('批量 PATCH 走同一条——批量改清单最容易漏接', async () => {
    const { p, follows } = family();

    await app.request('/api/tasks', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [p.id], patch: { listId: 'B' } }),
    });

    expect(listOf(follows.id)).toBe('B');
  });
});

/**
 * `POST /api/tasks/:id/skip`。**存在的理由就是那个推迟计数**：`applyTaskPatch`
 * 的判断是字段级的（「due 往后挪了就 +1」），而跳过恰好也把 due 往后挪——
 * 走普通 PATCH 的话每跳过一次就记一次拖延，攒几次这条任务开始出现在
 * 「一拖再拖」的推荐里，AI 回顾也会把它当成长期拖延的典型。
 */
describe('POST /api/tasks/:id/skip', () => {
  const app = createApp();
  const DAILY = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };

  const repeating = (over: Partial<Task> = {}) => {
    const t = newTask({
      title: '每天跑步', due: new Date(2026, 7, 20, 7).toISOString(), repeat: DAILY,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...over,
    });
    writeTasks([t]);
    return t;
  };
  const skip = (id: string) => app.request(`/api/tasks/${id}/skip`, { method: 'POST' });

  it('往前走一格：due 挪到下一次', async () => {
    const t = repeating();
    const res = await skip(t.id);
    expect(res.status).toBe(200);
    expect(readTasks()[0].due).not.toBe(t.due);
  });

  it('**不算一次拖延**——这是这条路由存在的全部理由', async () => {
    const t = repeating({ postponeCount: 2 });
    await skip(t.id);
    expect(readTasks()[0].postponeCount).toBe(2);
  });

  it('对照：同一条任务走普通 PATCH 改 due，那是真的拖延，照算', async () => {
    const t = repeating({ postponeCount: 2 });
    await app.request(`/api/tasks/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ due: new Date(2026, 7, 25, 7).toISOString() }),
    });
    expect(readTasks()[0].postponeCount).toBe(3);
  });

  it('**不产生新记录、不盖完成章**——跳过什么都没发生过', async () => {
    const t = repeating();
    await skip(t.id);
    expect(readTasks()).toHaveLength(1);
    expect(readTasks()[0].completedAt).toBeNull();
    expect(readTasks()[0].status).toBe('todo');
  });

  it('跳不动的回 400，说得出为什么，而且一个字节都不写', async () => {
    const t = repeating({ repeat: null });
    const res = await skip(t.id);
    expect(res.status).toBe(400);
    expect(readTasks()[0].due).toBe(t.due);
  });

  it('没有这个任务回 404', async () => {
    writeTasks([]);
    expect((await skip('nope')).status).toBe(404);
  });
});

describe('POST /api/inbox/:id/redo：拆得不对，带一句要求再来一轮', () => {
  const fakeProc = (): ChildProcess => Object.assign(new EventEmitter() as unknown as ChildProcess, { kill: vi.fn() });
  /** 这条路由末尾会真的触发一次拆解，不注入假 spawner 就会去起真的 `claude`。 */
  const withRunner = (spawnFn: Spawner = vi.fn(() => fakeProc())) => createApp(undefined, spawnFn);

  /** 一条已拆解的收件箱记录 + 它拆出来的两条任务。 */
  const seed = (text = '原话') => {
    const t1 = newTask({ title: '第一条' });
    const t2 = newTask({ title: '第二条' });
    writeTasks([t1, t2]);
    writeInbox([{ id: 'i1', text, createdAt: nowIso(), processed: true, taskIds: [t1.id, t2.id] }]);
    return [t1.id, t2.id];
  };

  it('上一轮拆出来的任务搬进垃圾箱——不是抹掉，捞得回来', async () => {
    const ids = seed();
    const res = await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '拆得太粗' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json() as { trashed: number }).trashed).toBe(2);
    expect(readTasks()).toEqual([]);
    expect(readTrash().map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  it('那句要求追加到原文后面，条目翻回未处理、taskIds 清空', async () => {
    seed('买猫粮');
    await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '按周分开' }),
    });

    const [item] = readInbox();
    expect(item.text).toBe('买猫粮\n\n补充要求（第 2 轮）：按周分开');
    expect(item.processed).toBe(false);
    expect(item.taskIds).toEqual([]);
  });

  /** 一轮一行，轮次自己数文本里已有的几行，不信任任何传进来的数字。 */
  it('再来一轮就是第 3 轮', async () => {
    seed('买猫粮\n\n补充要求（第 2 轮）：按周分开');
    await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '还是太粗' }),
    });
    expect(readInbox()[0].text).toMatch(/补充要求（第 3 轮）：还是太粗$/);
  });

  it('不写要求就是原样重拆一遍——原文一个字不动', async () => {
    seed('买猫粮');
    await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const [item] = readInbox();
    expect(item.text).toBe('买猫粮');
    expect(item.processed).toBe(false);
  });

  it('顺手把这条重新拆一次，不用再点一下「立即拆解」', async () => {
    seed();
    const spawnFn: Spawner = vi.fn(() => fakeProc());
    const res = await withRunner(spawnFn).request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect((await res.json() as { started: boolean }).started).toBe(true);
  });

  /**
   * 单飞锁挡住第四步**不影响前三步**：搬垃圾箱和改原文都已经落盘了，回 409
   * 会让界面以为整件事没发生。`started: false` 是这条路上唯一说得清的话。
   */
  it('正有一次拆解在跑：前三件事照样做完，started 回 false，不回 409', async () => {
    seed();
    const app2 = withRunner();
    await app2.request('/api/expand', { method: 'POST' });   // 先占住单飞锁

    const res = await app2.request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '再拆细点' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { started: boolean }).started).toBe(false);
    expect(readInbox()[0].processed).toBe(false);
    expect(readInbox()[0].text).toMatch(/再拆细点$/);
    expect(readTrash()).toHaveLength(2);
  });

  /** `taskIds` 里可能有他自己早就删掉的，不过滤的话 softDeleteTasks 会拿到找不到的 id。 */
  it('taskIds 指着已经被删掉的任务时不报错，trashed 只数真的搬走的', async () => {
    const t1 = newTask({ title: '还在的' });
    writeTasks([t1]);
    writeInbox([{ id: 'i1', text: '原话', createdAt: nowIso(), processed: true, taskIds: [t1.id, '早没了'] }]);

    const res = await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { trashed: number }).trashed).toBe(1);
  });

  it('这条任务名下的建议一起摘掉，不留成看不见的孤儿', async () => {
    const ids = seed();
    writeProposals([{
      id: 'p1', taskId: ids[0], patch: { title: '改个名' }, reason: '', createdAt: nowIso(), dismissed: false,
    } as unknown as Proposal]);

    await withRunner().request('/api/inbox/i1/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(readProposals()).toEqual([]);
  });

  it('没有这一条时回 404', async () => {
    const res = await withRunner().request('/api/inbox/没有这条/redo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe('设置里的 AI 密钥不原样回给浏览器', () => {
  const put = (body: unknown) =>
    app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('GET 回的是打码后的形状，不是真值', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    const s = (await (await get('/api/settings')).json()) as Settings;
    expect(s.aiKey).toBe('••••ijkl');
  });

  /**
   * 界面读回来的就是打码串。用户不碰它、只改了番茄钟时长再保存，请求体里带回来的
   * 也是那串打码——不认它的话密钥会被 `••••ijkl` 覆盖，而这次覆盖悄无声息，
   * 要等下一次拆解报 401 才现形。
   */
  it('把打码串原样 PUT 回来：存着的真值不动', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    await put({ ...DEFAULT_SETTINGS, aiKey: '••••ijkl', focusMinutes: 40 });

    expect(store.readSettings().aiKey).toBe('sk-abcdefghijkl');
    expect(store.readSettings().focusMinutes).toBe(40);
  });

  it('PUT 一把新的就换掉，空串就是真的清掉', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    await put({ ...DEFAULT_SETTINGS, aiKey: 'sk-新的一把钥匙' });
    expect(store.readSettings().aiKey).toBe('sk-新的一把钥匙');

    await put({ ...DEFAULT_SETTINGS, aiKey: '' });
    expect(store.readSettings().aiKey).toBe('');
  });

  /**
   * **不带 `aiKey`、却换了 `aiBaseUrl` 的 PUT，密钥不跟着搬过去。**
   *
   * 原来 `aiKeyFrom` 对「字段缺失」无条件沿用存着的密钥。于是一个第三方网页发一份
   * `{ aiMode: 'api', aiBaseUrl: 'https://攻击者', aiModel: 'x' }`（`text/plain` 的
   * 简单请求，没有预检；CORS 只拦读响应，而它不需要读），密钥原样留着、地址换成
   * 了他的——**之后不需要受害者做任何事**：自动拆解自己会跑，带着真密钥去请求
   * 他的地址。持久，无人触发。
   *
   * 真实客户端永远带 `aiKey`（没动过就是打码串），所以收紧对界面零影响。
   */
  it('不带 aiKey、换了 aiBaseUrl：密钥不沿用，不能被搬去陌生地址', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl', aiBaseUrl: 'https://x.test/v1' });
    await put({ aiMode: 'api', aiBaseUrl: 'https://攻击者.test/v1', aiModel: 'x' });

    const s = store.readSettings();
    expect(s.aiBaseUrl).toBe('https://攻击者.test/v1');
    expect(s.aiKey).toBe('');
  });

  /** 上面那条的反面：只改别的、地址没动、字段也没给——「别的客户端只想改别的设置」那条走法还在。 */
  it('不带 aiKey、地址没变：密钥原样留着', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl', aiBaseUrl: 'https://x.test/v1' });
    await put({ ...DEFAULT_SETTINGS, aiBaseUrl: 'https://x.test/v1', aiKey: undefined, focusMinutes: 40 });

    expect(store.readSettings().aiKey).toBe('sk-abcdefghijkl');
  });

  /** 「改了地址、没动密钥」——界面最常见的走法，打码那一支照样认，不受收紧影响。 */
  it('打码串 + 换了地址：照样沿用，这是界面的正常走法', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl', aiBaseUrl: 'https://x.test/v1' });
    await put({ ...DEFAULT_SETTINGS, aiBaseUrl: 'https://代理.test/v1', aiKey: '••••ijkl' });

    expect(store.readSettings().aiKey).toBe('sk-abcdefghijkl');
    expect(store.readSettings().aiBaseUrl).toBe('https://代理.test/v1');
  });

  it('PUT 的响应里也是打码的——它跟 GET 是同一份东西，不能从这儿漏出去', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    const s = (await (await put({ ...DEFAULT_SETTINGS, aiKey: '••••ijkl' })).json()) as Settings;
    expect(s.aiKey).toBe('••••ijkl');
  });

  it('地址和模型去首尾空白，模式认不出就落回 cli', async () => {
    await put({ ...DEFAULT_SETTINGS, aiMode: '瞎写的', aiBaseUrl: '  https://x.test/v1  ', aiModel: '  m  ' });
    const s = store.readSettings();
    expect(s.aiMode).toBe('cli');
    expect(s.aiBaseUrl).toBe('https://x.test/v1');
    expect(s.aiModel).toBe('m');
  });
});

describe('POST /api/ai/test：设置页那颗「测试连接」', () => {
  const replying = (content: string): typeof fetch => vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
  const testWith = (f: typeof fetch) => createApp(undefined, undefined, f);
  const post2 = (a: ReturnType<typeof createApp>, b: unknown) =>
    a.request('/api/ai/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  it('通了回 { ok: true }', async () => {
    const res = await post2(testWith(replying('好')), { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'sk-abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  /**
   * **连不通也是 200**：那是这条接口要报告的结果，不是它自己失败了。回 4xx 的话
   * 前端得把「请求失败」和「测出来不通」分开处理两遍。
   */
  it('连不通也回 200，把原因放在 error 里', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    const res = await post2(testWith(f), { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'sk-bad' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Incorrect API key/);
  });

  /**
   * **不带 `apiKey`、带着陌生 `baseUrl` 的请求，拿不到存着的密钥。**
   *
   * 原来 `aiKeyFrom` 对「字段缺失」无条件沿用存着的密钥，于是这条请求会拿真密钥去
   * 请求调用方指定的任意地址——`Authorization: Bearer <真密钥>` 落在对方的访问日志
   * 里。第三方网页发得出这种请求（理由见 PUT /api/settings 那组测试）。
   *
   * 断言的是**发出去的请求头里没有那把密钥**，不是响应——密钥是从出站请求里漏的。
   */
  it('不带 apiKey + 陌生 baseUrl：出站请求里没有存着的密钥', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl', aiBaseUrl: 'https://x.test/v1' });
    const f = replying('好');
    await post2(testWith(f), { baseUrl: 'https://攻击者.test/v1', model: 'm' });

    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('攻击者.test');
    expect(JSON.stringify(init.headers ?? {})).not.toContain('sk-abcdefghijkl');
  });

  /** 验的是他此刻框里那份——拿存着的旧值去验等于答非所问。 */
  it('用的是请求体里那三格，不是存着的那份', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiBaseUrl: 'https://存着的.test/v1', aiModel: '存着的模型' });
    const f = replying('好');
    await post2(testWith(f), { baseUrl: 'https://刚填的.test/v1', model: '刚填的模型', apiKey: '' });

    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('刚填的.test');
    expect(JSON.parse(init.body as string).model).toBe('刚填的模型');
  });

  /**
   * 界面读回来的密钥是打码串。「改了地址、没动密钥」是最常见的一种试法——不认那串
   * 打码的话，会拿着 `••••abcd` 去认证，然后报一个跟真实原因毫无关系的 401。
   */
  it('密钥收到的是打码串时，用存着的真值去试', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, aiKey: 'sk-abcdefghijkl' });
    const f = replying('好');
    await post2(testWith(f), { baseUrl: 'https://x.test/v1', model: 'm', apiKey: '••••ijkl' });

    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-abcdefghijkl');
  });

  it('三格没填全时压根不发请求', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const res = await post2(testWith(f), { baseUrl: '', model: '', apiKey: '' });
    expect((await res.json() as { error: string }).error).toMatch(/接口地址还没填/);
    expect(f).not.toHaveBeenCalled();
  });
});

/**
 * **改对 AI 设置之后，积压的收件箱条目要能重新被自动拆解。**
 *
 * 补的是一条真实的死路（code review 抓到的）：api 模式模型名没填时，自动拆解把所有
 * 未处理条目标进 `attempted`、报「设置里的 AI 模型名还没填」。用户照着填上保存，
 * 却什么都不会发生——那些条目还在 `attempted` 里。横幅让他做的那件事恰恰不管用。
 */
describe('PUT /api/settings：AI 那几格改了就把「已经自动试过」清掉', () => {
  const put = (body: unknown) =>
    app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /** `createApp` 内部那个 autoExpand 拿不到，靠「改完设置之后还排不排得上」间接验。 */
  const scheduledAfter = async (change: Partial<Settings>) => {
    writeInbox([{ id: 'i1', text: '随手记的', createdAt: nowIso(), processed: false, taskIds: [] }]);
    const bus = new Bus();
    const seen: Array<{ state: string }> = [];
    bus.subscribe((e, d) => { if (e === 'agent-status') seen.push(d as { state: string }); });
    const withBus = createApp(bus, vi.fn(() => Object.assign(new EventEmitter() as unknown as ChildProcess, { kill: vi.fn() })));

    // 先让它自动试一次并「失败」——直接把条目标进 attempted 的最短路径是跑一次
    // 手动拆解？不行，那会 clearAll。改用真实那条：等自动排期跑完。
    writeSettings({ ...DEFAULT_SETTINGS, autoExpand: true, autoExpandDelaySec: 10, aiMode: 'api', aiBaseUrl: '', aiModel: '' });
    bus.emit('data-changed', { file: 'inbox' });
    await vi.advanceTimersByTimeAsync(11_000);
    const failed = seen.filter((s) => s.state === 'failed').length;
    expect(failed, '配置不全时该报一次失败').toBeGreaterThan(0);
    seen.length = 0;

    await withBus.request('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_SETTINGS, autoExpand: true, autoExpandDelaySec: 10, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: 'm', ...change }),
    });
    await vi.advanceTimersByTimeAsync(11_000);
    return seen;
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('把模型名填上保存之后，那条积压的能重新排上', async () => {
    const seen = await scheduledAfter({});
    expect(seen.some((s) => s.state === 'scheduled' || s.state === 'running'),
      '改对配置之后该重新排期——不然横幅让他去填的那件事等于没用').toBe(true);
  });

  it('只改番茄钟时长不清——那不该把因为别的原因失败过的条目全放回候选池', async () => {
    const seen = await scheduledAfter({ aiMode: 'api', aiBaseUrl: '', aiModel: '', focusMinutes: 40 });
    expect(seen.some((s) => s.state === 'scheduled'), 'AI 那几格没变，不该重新排期').toBe(false);
  });
});
