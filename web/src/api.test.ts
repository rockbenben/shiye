import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * `api.ts` 现在经 `lib/dataSource.ts` 引到 `lib/localStore.ts`，那边落盘在
 * `@capacitor/preferences` 上——跟 apiBase.test.ts 同一条理由（这个文件跑在
 * vitest 的 node 档，`Preferences` 的 web 回退读裸的 `window.localStorage`
 * 在这个环境里会拒绝掉那个 promise）。这里同样整个 mock 掉，用一个 `Map`
 * 当假的持久化后端——这个文件大多数用例走的是「在线」分支根本碰不到它，
 * 只有下面「本地存储选路」那组离线用例会真的读写这个 Map。
 */
const prefsStore = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: prefsStore.has(key) ? prefsStore.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { prefsStore.set(key, value); }),
  },
}));

import { api, subscribe } from './api.js';
import { getApiBase, setApiBase } from './lib/apiBase.js';
import { localApi, resetOnlineCache, setOnlineForTest } from './lib/dataSource.js';
import { localTasks } from './lib/localStore.js';
import type { Task } from './types.js';

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '交房租', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

/**
 * 这个文件里绝大多数既有用例的前提本来就是「桌面、连得上」——它们测的是
 * `req()` 怎么拼 URL/body，不是选路本身。task-2-brief 加的这层选路（见
 * `lib/dataSource.ts` 的 `route()`）要求每次调用先问一次 `isOnline()`，
 * 不该因此逼着每条既有用例的 fetch mock 都学会额外答一次 `/api/health`
 * ——那样会让这一批的改动波及一整份跟路由无关的既有断言。`setOnlineForTest`
 * 就是为这个开的口子：全局钉死「在线」，既有用例的行为跟这一批之前逐字节
 * 一样。真正测选路本身的用例在最下面「本地存储选路」那组，各自显式控制
 * 这个开关。
 */
beforeEach(() => {
  resetOnlineCache();
  setOnlineForTest(true);
});
afterEach(() => {
  setOnlineForTest(null);
});

/**
 * jsdom 没有真的 EventSource，test-setup.ts 补的壳所有方法都是空的、
 * 也不记监听器——够让组件测试挂载时不炸，但没法拿来验证「连上时触发了 onOpen」
 * 这种真实行为。这里现造一个记监听器、能手动 emit 的假的。
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, detail?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(detail);
  }
}

describe('subscribe', () => {
  afterEach(() => {
    FakeEventSource.instances.length = 0;
  });

  it('每次连上（含首次）都调用 onOpen —— 断线重连期间落地的变化靠这个补回来，EventSource 自己不会重发', () => {
    const real = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    try {
      const onOpen = vi.fn();
      const off = subscribe({ onChange: () => {}, onReminder: () => {}, onAgentStatus: () => {}, onOpen });

      FakeEventSource.instances[0].emit('open');
      expect(onOpen).toHaveBeenCalledTimes(1);

      off();
    } finally {
      globalThis.EventSource = real;
    }
  });

  it('agent-status 事件解析出 state/message 转给 onAgentStatus', () => {
    const real = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    try {
      const onAgentStatus = vi.fn();
      const off = subscribe({ onChange: () => {}, onReminder: () => {}, onAgentStatus, onOpen: () => {} });

      FakeEventSource.instances[0].emit('agent-status', { data: JSON.stringify({ state: 'failed', message: 'AI 命令行工具没找到' }) });
      expect(onAgentStatus).toHaveBeenCalledWith({ state: 'failed', message: 'AI 命令行工具没找到' });

      off();
    } finally {
      globalThis.EventSource = real;
    }
  });
});

// task-4-brief：批量操作两个端点的客户端封装。核心断言是「一次 fetch，不是
// N 次」——这两个函数存在的唯一理由就是避开 N 条并发 PATCH/DELETE 打穿目录
// 监听器的去抖，见 api.ts 里 patchTasks/deleteTasks 上面的注释。用真的
// vi.fn() 顶替 global.fetch，数它被调用了几次，比在 App.test.tsx 里数
// mock 的 api.patchTasks 被调用几次更直接——这里测的是 api.ts 自己的实现
// 有没有偷偷循环调用 fetch，不是「App 有没有调对函数」。
describe('patchTasks / deleteTasks：批量端点的封装', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('patchTasks(ids, patch)：不管 ids 有几个，只发一次 fetch，方法是 PATCH /api/tasks，body 里 ids 和 patch 都原样带上', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ updated: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.patchTasks(['a', 'b', 'c'], { status: 'done' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b', 'c'], patch: { status: 'done' } });
    expect(result).toEqual({ updated: 3 });
  });

  it('deleteTasks(ids)：只发一次 fetch，方法是 DELETE /api/tasks，body 里带着 ids', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ deleted: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.deleteTasks(['a', 'b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b'] });
    expect(result).toEqual({ deleted: 2 });
  });
});

// task-3-brief：附件三个客户端封装，见 server/src/app.ts 那三条路由。
describe('uploadAttachment / attachmentUrl / deleteAttachment：附件的客户端封装', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploadAttachment(taskId, file)：POST /api/tasks/:id/attachments，body 是 FormData 里的 file 字段，且没有被 req() 强加 content-type', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 't1', attachments: ['a.txt'] }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    const result = await api.uploadAttachment('t1', file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks/t1/attachments');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
    // 上限：req() 只有字符串 body 才补 'content-type: application/json'——
    // FormData 必须让浏览器自己生成带 boundary 的 Content-Type，这里没传
    // headers，就该是 undefined，不是被 req() 硬塞进去的 json 头（那样服务端
    // parseBody() 会按错误的类型解析，见 api.ts 里 req() 的注释）。
    expect(init.headers).toBeUndefined();
    expect(result).toEqual({ id: 't1', attachments: ['a.txt'] });
  });

  it('uploadAttachment：413 时抛出的 Error message 是服务端给的具体原因，不是笼统的「上传失败」', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: '附件不能超过 25MB' }), { status: 413 }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['x'], 'big.bin');
    await expect(api.uploadAttachment('t1', file)).rejects.toThrow('附件不能超过 25MB');
  });

  it('attachmentUrl(taskId, name)：taskId 和 name 都做了 URL 编码——name 常常带空格/括号/中文', () => {
    expect(api.attachmentUrl('t 1', '报告 (2).pdf')).toBe(
      `/api/tasks/${encodeURIComponent('t 1')}/attachments/${encodeURIComponent('报告 (2).pdf')}`,
    );
  });

  it('deleteAttachment(taskId, name)：DELETE /api/tasks/:id/attachments/:name，name 里的特殊字符被编码', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.deleteAttachment('t1', '报告 (2).pdf');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/tasks/t1/attachments/${encodeURIComponent('报告 (2).pdf')}`);
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({ ok: true });
  });
});

// task-1-brief（Android 外壳）：base 前缀有三个接线点——req()、subscribe() 的
// EventSource、attachmentUrl，漏了任何一个都不会在别的测试里报错，只会在手机上
// 表现为「连不上/附件打不开」。三处各要一条桌面（base 空）+ 一条手机（base 有值）
// 的断言，桌面那条断言的是「逐字节不变」，不是「大致差不多」。
describe('base 前缀（task-1-brief：Android 外壳第一批）', () => {
  // apiBase.ts 的存储后端在 task-3 换成了 @capacitor/preferences（见那个
  // 文件顶部的注释）：getApiBase()/setApiBase() 的签名和「同步、桌面默认空
  // 字符串」这条契约没变，但 setApiBase() 现在无条件把值写进模块内存里的
  // 一份缓存，不再像原来的 localStorage 实现那样靠「stub/unstub 一个全局
  // 对象」当天然的重置开关——不显式清空的话，这里「手机模式」那几条测试
  // setApiBase() 过的值会经这份内存缓存漏到后面的「桌面模式」测试里。
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBase('');
  });

  describe('req()', () => {
    it('桌面模式（没配过 base）：fetch 收到的第一个参数跟改动前逐字节相同', async () => {
      expect(getApiBase()).toBe('');
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await api.tasks();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/tasks');
    });

    /**
     * **磁盘上那份没人校验过**：`GET /api/tasks` 是 `readAll` 的直通车，
     * JSON.parse 之后直接当 `Task` 交出去。手改文件时漏一个 `"tags": []`，
     * 类型上它还是 `Task`，而卡片、行、`search.ts`、`suggest.ts`、批量加标签
     * 五处都是裸的 `t.tags.length` / `...t.tags`——一条坏数据白掉整页。
     * 补在这个入口，不是补在每个消费点。
     */
    it('服务端给回来的任务缺数组字段时，这一层补齐再交出去', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify([{ id: 'a', title: '手改过的', status: 'todo' }]), { status: 200 },
      )));

      const [t] = await api.tasks();

      expect(t.tags).toEqual([]);
      expect(t.reminders).toEqual([]);
      expect(t.subtasks).toEqual([]);
      expect(t.attachments).toEqual([]);
      expect(t.focusSessions).toEqual([]);
    });

    it('不是数组的（手滑写成一个裸字符串）也当空——`?? []` 挡不住这种', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify([{ id: 'a', title: 'x', tags: '紧急' }]), { status: 200 },
      )));

      expect((await api.tasks())[0].tags).toEqual([]);
    });

    it('本来就好的原样不动，别把好数据也洗一遍', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify([{ id: 'a', title: 'x', tags: ['紧急'], priority: 3 }]), { status: 200 },
      )));

      const [t] = await api.tasks();
      expect(t.tags).toEqual(['紧急']);
      expect(t.priority).toBe(3);
    });

    it('手机模式（配了 base）：fetch 收到的第一个参数带 base 前缀', async () => {
      setApiBase('http://192.168.1.5:30035');
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await api.tasks();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://192.168.1.5:30035/api/tasks');
    });
  });

  describe('subscribe() 的 EventSource', () => {
    class FakeEventSourceForBase {
      static instances: FakeEventSourceForBase[] = [];
      constructor(public url: string) {
        FakeEventSourceForBase.instances.push(this);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }

    afterEach(() => {
      FakeEventSourceForBase.instances.length = 0;
    });

    it('桌面模式（没配过 base）：EventSource 的 url 跟改动前逐字节相同', () => {
      expect(getApiBase()).toBe('');
      vi.stubGlobal('EventSource', FakeEventSourceForBase);

      const off = subscribe({ onChange: () => {}, onReminder: () => {}, onAgentStatus: () => {}, onOpen: () => {} });

      expect(FakeEventSourceForBase.instances[0].url).toBe('/api/events');
      off();
    });

    it('手机模式（配了 base）：EventSource 的 url 带 base 前缀', () => {
      setApiBase('http://192.168.1.5:30035');
      vi.stubGlobal('EventSource', FakeEventSourceForBase);

      const off = subscribe({ onChange: () => {}, onReminder: () => {}, onAgentStatus: () => {}, onOpen: () => {} });

      expect(FakeEventSourceForBase.instances[0].url).toBe('http://192.168.1.5:30035/api/events');
      off();
    });
  });

  describe('attachmentUrl()', () => {
    it('手机模式（配了 base）：attachmentUrl 带 base 前缀', () => {
      setApiBase('http://192.168.1.5:30035');

      expect(api.attachmentUrl('t1', 'a.txt')).toBe('http://192.168.1.5:30035/api/tasks/t1/attachments/a.txt');
    });
  });

  it('base 末尾的斜杠在存入时就被归一化——手机模式下 req() 不会拼出双斜杠', async () => {
    setApiBase('http://192.168.1.5:30035/');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.tasks();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.5:30035/api/tasks');
  });
});

// task-2-brief：本地存储 + 数据源选路。这组测的是真实的 api.ts（不是
// lib/dataSource.test.ts 那份直接测 route()/localApi 本身），确认「29 个
// 方法签名不变，底下多一层选路」这件事真的在 api.ts 这一层接上了，不是
// 只有 lib/dataSource.ts 自己的单测知道。
describe('本地存储选路（task-2-brief）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // restoreAllMocks 而不是指望每条用例自己在断言之后调用 mockRestore()——
    // 断言一旦失败会提前抛出，手动写在断言后面的 mockRestore() 永远不会跑，
    // spy 会带着污染漏到同一个文件后面的用例里（用变异测试验证过这个坑，
    // 见 task-2-report「变异清单」）。
    vi.restoreAllMocks();
    setOnlineForTest(null);
    prefsStore.clear();
  });

  it('离线读：连不上时 api.tasks()/api.inbox() 不抛错，返回本地存储的内容（没写过就是空数组）', async () => {
    setOnlineForTest(false);
    expect(await api.tasks()).toEqual([]);
    expect(await api.inbox()).toEqual([]);
  });

  it('离线写 + 写完读回来：连不上时 api.addInbox() 落到本地存储，随后 api.inbox() 能读到它', async () => {
    setOnlineForTest(false);
    const item = await api.addInbox('买菜');
    expect(item.text).toBe('买菜');

    const all = await api.inbox();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(item.id);
  });

  it('离线写 + 写完读回来：连不上时 api.addTask() + api.patchTask() 落到本地存储，随后 api.tasks() 能读到最新值', async () => {
    setOnlineForTest(false);
    const created = await api.addTask({ title: '写周报' });
    await api.patchTask(created.id, { status: 'done' });

    const all = await api.tasks();
    expect(all.find((t) => t.id === created.id)?.status).toBe('done');
  });

  it('连上之后本地改动还在：离线时写的任务，切回在线之后本地存储里原样保留（这一批不做同步，也不该被清掉）', async () => {
    setOnlineForTest(false);
    const created = await api.addTask({ title: '离线记的事' });

    // 切回在线——之后的 api.tasks() 会改走 HTTP（下面单独有用例断言这一点），
    // 但本地存储本身不该被这个切换动作清空或覆盖，见 lib/localStore.ts
    // 模块顶部「这一批不做同步」的说明。直接读本地层验证，不经过 api.tasks()
    // （那个函数一旦在线就不再读本地层，读不出「还在不在」这件事）。
    setOnlineForTest(true);
    const stillThere = await localApi.tasks();
    expect(stillThere.some((t) => t.id === created.id)).toBe(true);
  });

  // 标题范围收窄成「写方法」——回填之后「连得上时本地层不该被写」这句话
  // 对读方法不再成立（tasks/inbox 等在线读成功之后会把结果写进本地缓存，
  // 见「在线回填」那组），断言本身没变（这里测的一直是 patchTask，一个
  // 写方法，localApi.patchTask 在线时确实一次都不该被调用），只是旧标题
  // 泛泛地说「本地层」容易让人以为这条上限对所有方法都成立（复审 m9 指出）。
  it('上限：连得上服务端时，写方法不该走本地——patchTask 在线时只调用 HTTP 分支，localApi.patchTask 一次都不会被调用', async () => {
    setOnlineForTest(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...task(), id: 't1', status: 'done' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const localSpy = vi.spyOn(localApi, 'patchTask');

    await api.patchTask('t1', { status: 'done' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localSpy).not.toHaveBeenCalled();
  });

  it('上限：连不上服务端时，不该发 HTTP——patchTask 离线时一次 fetch 都不会发生（isOnline 已经钉死离线，连探测请求也不会再发）', async () => {
    setOnlineForTest(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await localTasks.write([task()]);

    await api.patchTask('t1', { status: 'done' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上限反向对照：同一条 patchTask 请求，在线时不落本地、离线时不发网络请求——同一个判据两个方向都生效，不是只测了一半', async () => {
    // 在线半场
    setOnlineForTest(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...task(), status: 'done' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const localSpy = vi.spyOn(localApi, 'patchTask');
    await api.patchTask('t1', { status: 'done' });
    expect(localSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    // 离线半场
    setOnlineForTest(false);
    const fetchMock2 = vi.fn();
    vi.stubGlobal('fetch', fetchMock2);
    await localTasks.write([task()]);
    await api.patchTask('t1', { status: 'doing' });
    expect(fetchMock2).not.toHaveBeenCalled();
  });

  it('没有本地实现的操作（比如 acceptProposal）离线时明确报错，不静默返回假成功', async () => {
    setOnlineForTest(false);
    await expect(api.acceptProposal('p1')).rejects.toThrow('离线时无法接受这条建议，连接服务器之后再试');
  });

  // 修复轮 2（C2，复审指出的 Critical）：settings 离线时曾经返回一份伪造的
  // DEFAULT_SETTINGS，调用方分辨不出真假——App.tsx 的 reload() 会把它当成
  // 「读到了」塞进 state，用户在这份假数据上点保存会把桌面真实的
  // webhookUrl 之类整份覆盖掉，是比不支持离线更糟的数据丢失。改成跟附件
  // 同一条路：明确报错，不装作读到了什么。
  it('settings 离线时明确报错，不返回伪造的默认值——这是 C2 的核心断言', async () => {
    setOnlineForTest(false);
    await expect(api.settings()).rejects.toThrow('离线时无法读取设置，连接服务器之后再试');
  });
});

// 修复轮 1：coordinator 指出 brief 的「上限：连得上时不许走本地」被读窄成了
// 「连得上时一个字节都不许写本地」，代价是回填整条被砍掉——从没离线过的
// 设备第一次断网，api.tasks() 读到的是空数组，而「apk 可以不连桌面」的第一
// 用途恰恰是「桌面没开，在手机上看一眼我有什么任务」。这组补上回填，重新
// 表述上限：在线时**返回值**必须来自 http()，但 http() 成功之后可以顺手把
// 结果写进本地缓存留着离线用（回填，不是同步）。
describe('在线回填（task-2-report 修复轮 1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setOnlineForTest(null);
    prefsStore.clear();
  });

  it('这个 Task 的核心意义：在线读一次之后断网，再读依然拿得到刚才那份数据', async () => {
    setOnlineForTest(true);
    const seenOnline = [task({ id: 'a', title: '在线时看到的任务' })];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(seenOnline), { status: 200 })));

    const online = await api.tasks();
    expect(online).toEqual(seenOnline);

    setOnlineForTest(false);
    const offline = await api.tasks();
    expect(offline).toEqual(seenOnline);
  });

  it('inbox 同一件事：在线读一次之后断网，随手记（收件箱）也还在', async () => {
    setOnlineForTest(true);
    const seenOnline = [{ id: 'i1', text: '买菜', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(seenOnline), { status: 200 })));

    await api.inbox();
    setOnlineForTest(false);
    expect(await api.inbox()).toEqual(seenOnline);
  });

  it('lists/insights/proposals 同一件事：在线读一次之后断网，依然读得到', async () => {
    setOnlineForTest(true);
    const list = { id: 'l1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null };
    const insight = { id: 'ins1', kind: 'note', text: '一条观察', taskIds: [], createdAt: '2026-08-01T00:00:00.000Z', dismissedAt: null };
    const proposal = { id: 'p1', taskId: 't1', patch: { title: 'x' }, reason: '理由', createdAt: '2026-08-01T00:00:00.000Z' };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/lists') return new Response(JSON.stringify([list]), { status: 200 });
      if (url === '/api/insights') return new Response(JSON.stringify([insight]), { status: 200 });
      return new Response(JSON.stringify([proposal]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.lists();
    await api.insights();
    await api.proposals();

    setOnlineForTest(false);
    expect(await api.lists()).toEqual([list]);
    expect(await api.insights()).toEqual([insight]);
    expect(await api.proposals()).toEqual([proposal]);
  });

  it('上限：在线时 tasks() 返回的是 http() 这次的值，不是本地缓存——localApi.tasks（本地读的分支）一次都不会被调用', async () => {
    // 修复轮 2（C1，复审指出）：只断言「返回值等于 fresh」是一条确认的假绿——
    // backfillTasks 会在 http() 成功之后把 fresh 写进本地缓存，等断言执行时
    // 「缓存」和「http 的值」已经是同一份，把 route() 改成「在线时改用
    // await local() 当返回值」这种真实违反上限的变异，这条测试照样绿
    // （`dataSource.test.ts` 里直接调 `route(http, local)` 那条能抓到，因为那里 backfill 是空 spy、缓存
    // 不会被回填覆盖成 http 的值——但那条测的是 route() 机制本身，不是
    // api.ts 真的接了这层选路，见变异 #9「机制对了不代表接上了」）。
    // 改成跟本文件「离线读」那条同一形状：直接断言 localApi.tasks 没被调用——
    // 这是「答案从哪来」的结构性断言，不会被回填的时序巧合掩盖。
    setOnlineForTest(true);
    await localTasks.write([task({ id: 'stale', title: '缓存里的旧数据' })]);
    const fresh = [task({ id: 'fresh', title: '服务端刚返回的' })];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 })));
    const localSpy = vi.spyOn(localApi, 'tasks');

    const result = await api.tasks();

    expect(result).toEqual(fresh);
    expect(localSpy).not.toHaveBeenCalled();
  });

  it('回填不该带崩在线主路径：本地存储写不进去（配额满/Preferences 抛异常之类）时，api.tasks() 依然正常返回 http() 的结果，不 reject', async () => {
    setOnlineForTest(true);
    const fresh = [task({ id: 'fresh' })];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 })));
    vi.spyOn(localTasks, 'write').mockRejectedValue(new Error('quota exceeded'));

    await expect(api.tasks()).resolves.toEqual(fresh);
  });

  it('回填不会覆盖离线时改过、还没同步的任务：在线刷新时脏 id 的本地版本优先，其余任务照常刷新成服务端版本', async () => {
    // 先离线改一条已有任务的标题（走真正的 localApi.patchTask，落地又标脏）
    await localTasks.write([task({ id: 't1', title: '服务端原文' })]);
    setOnlineForTest(false);
    await api.patchTask('t1', { title: '离线时改过的标题' });

    // 回到在线：服务端还是没同步过去之前的旧版本
    setOnlineForTest(true);
    const httpResult = [task({ id: 't1', title: '服务端原文（还没同步过去）' })];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(httpResult), { status: 200 })));

    const online = await api.tasks();
    // 上限依然成立：这次调用的返回值必须是 http() 的结果
    expect(online).toEqual(httpResult);

    // 但本地缓存里这条任务的离线改动没有被这次回填悄悄冲掉
    setOnlineForTest(false);
    const offlineAfter = await api.tasks();
    expect(offlineAfter.find((t) => t.id === 't1')?.title).toBe('离线时改过的标题');
  });
});
