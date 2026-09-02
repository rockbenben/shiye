import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * node 档（`*.test.ts`），跟 apiBase.test.ts/localStore.test.ts 同一条理由：
 * `@capacitor/preferences` 的 web 回退在这个环境里直接读 `window` 会炸，
 * 这里整个 mock 掉，用一个 `Map` 当假的持久化后端。
 */
const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.has(key) ? store.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
  },
}));

import { dirtyInbox, dirtyTasks, localTasks, localInbox, localInsights, localLists, localProposals, onLocalWrite } from './localStore.js';
import {
  backfillInbox, backfillInsights, backfillLists, backfillProposals, backfillTasks,
  isOnline, localApi, offlineUnsupported, OfflineUnsupportedError, resetOnlineCache, route, setOnlineForTest,
} from './dataSource.js';
import { setApiBase } from './apiBase.js';
import type { InboxItem, Insight, List, Proposal, Task } from '../types.js';

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '交房租', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

const inboxItem = (p: Partial<InboxItem> = {}): InboxItem =>
  ({ id: 'i1', text: '买菜', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...p });

const okHealth = () => new Response(JSON.stringify({ ok: true, version: 1 }), { status: 200 });

beforeEach(() => {
  store.clear();
  setApiBase('');
  resetOnlineCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setOnlineForTest(null);
});

describe('isOnline()：判据的唯一实现', () => {
  it('健康检查 fetch 成功且 body.ok===true → true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okHealth()));
    expect(await isOnline()).toBe(true);
  });

  it('fetch 直接抛异常（网络错误/超时）→ false，不往上抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network fail'); }));
    expect(await isOnline()).toBe(false);
  });

  it('fetch 成功但 res.ok 是 false（4xx/5xx）→ false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await isOnline()).toBe(false);
  });

  it('fetch 成功、状态码 200，但 body.ok 不是 true（连上了但不是这个服务）→ false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 })));
    expect(await isOnline()).toBe(false);
  });

  it('探测结果在 TTL 内缓存——短时间内连续调用只发一次健康检查请求', async () => {
    const fetchMock = vi.fn(async () => okHealth());
    vi.stubGlobal('fetch', fetchMock);

    await isOnline();
    await isOnline();
    await isOnline();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 复审 M1：上面那条测的是「依次调用」（每次都 await 到底再调下一次），
  // `cache` 早就写好了，TTL 挡得住。这里测的是「并发调用」——`cache` 只在
  // `await probeOnline()` 之后才写入，两个调用几乎同一拍发起时，都会读到
  // `cache === null`，TTL 挡不住这种「还没来得及写缓存」的窗口。挂载时
  // `App.tsx` 的 `reload()`（第一步 `api.inbox()` 就会走 `route()` →
  // `isOnline()`）和 `refreshOffline()` 正是这种并排触发，改之前实测过
  // `Promise.all([isOnline(), isOnline()])` 真的打两次 fetch——`pending`
  // 这个飞行中的 promise 就是为了堵这个洞。
  it('并发调用去重——Promise.all([isOnline(), isOnline()]) 只发一次健康检查请求', async () => {
    const fetchMock = vi.fn(async () => okHealth());
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([isOnline(), isOnline()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('resetOnlineCache() 之后重新探测——不是永久缓存', async () => {
    const fetchMock = vi.fn(async () => okHealth());
    vi.stubGlobal('fetch', fetchMock);

    await isOnline();
    resetOnlineCache();
    await isOnline();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('探测打的是 getApiBase() + /api/health，手机模式下带上 base 前缀', async () => {
    setApiBase('http://192.168.1.5:30035');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okHealth());
    vi.stubGlobal('fetch', fetchMock);

    await isOnline();

    expect(fetchMock.mock.calls[0]![0]).toBe('http://192.168.1.5:30035/api/health');
  });
});

describe('route()：路由判据的唯一落点——「答案从哪来」两个分支互斥', () => {
  it('在线时只调用 http，local 一次都不会被调用', async () => {
    setOnlineForTest(true);
    const http = vi.fn(async () => 'http-result');
    const local = vi.fn(async () => 'local-result');

    const result = await route(http, local);

    expect(result).toBe('http-result');
    expect(http).toHaveBeenCalledTimes(1);
    expect(local).not.toHaveBeenCalled();
  });

  it('离线时只调用 local，http 一次都不会被调用', async () => {
    setOnlineForTest(false);
    const http = vi.fn(async () => 'http-result');
    const local = vi.fn(async () => 'local-result');

    const result = await route(http, local);

    expect(result).toBe('local-result');
    expect(local).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });

  it('上限：在线时返回的是 http() 的值，不是 backfill 之前本地缓存里躺着的旧值——修复轮 1 之前这里读窄过一次，见 lib/dataSource.ts 模块注释', async () => {
    setOnlineForTest(true);
    const http = vi.fn(async () => 'fresh-from-http');
    const local = vi.fn(async () => 'stale-in-cache');
    const backfill = vi.fn(async () => {});

    const result = await route(http, local, backfill);

    expect(result).toBe('fresh-from-http');
    expect(local).not.toHaveBeenCalled();
  });

  it('在线时 http() 成功之后，backfill 被调用且传入 http() 的返回值——回填是「答案已经拿到之后」的旁路动作', async () => {
    setOnlineForTest(true);
    const http = vi.fn(async () => 'fresh');
    const local = vi.fn(async () => 'stale');
    const backfill = vi.fn(async (_v: string) => {});

    await route(http, local, backfill);

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith('fresh');
  });

  it('离线时不调用 backfill——没有 http() 的新数据可回填，也不该去动本地存储', async () => {
    setOnlineForTest(false);
    const http = vi.fn(async () => 'fresh');
    const local = vi.fn(async () => 'stale');
    const backfill = vi.fn(async () => {});

    await route(http, local, backfill);

    expect(backfill).not.toHaveBeenCalled();
  });

  it('不传 backfill 时（写方法的调用方式）行为不变——第三参数是可选的，不强制所有调用点都传', async () => {
    setOnlineForTest(true);
    const result = await route(async () => 'ok', async () => 'unused');
    expect(result).toBe('ok');
  });

  it('回填失败不该带崩在线主路径——backfill 抛异常，route() 仍然正常返回 http() 的结果，不往上抛', async () => {
    setOnlineForTest(true);
    const http = vi.fn(async () => 'fresh');
    const local = vi.fn(async () => 'stale');
    const backfill = vi.fn(async () => { throw new Error('quota exceeded'); });

    const result = await route(http, local, backfill);

    expect(result).toBe('fresh');
  });
});

describe('backfillTasks / backfillInbox：回填不会覆盖「还没同步」的本地改动', () => {
  it('没有脏 id 时，整份覆盖成 http() 拿到的新数据', async () => {
    await localTasks.write([task({ id: 'old', title: '旧的' })]);
    await backfillTasks([task({ id: 'new', title: '服务端最新的' })]);

    const all = await localTasks.read();
    expect(all.map((t) => t.id)).toEqual(['new']);
  });

  it('脏 id（还没同步的本地改动）不会被服务端的旧版本覆盖，其余条目照常刷新成服务端版本', async () => {
    // 本地缓存里 t1 是「离线时改过的标题」，还没同步；t2 是普通的、没改过的缓存
    await localTasks.write([
      task({ id: 't1', title: '离线时改过的标题' }),
      task({ id: 't2', title: '旧缓存里的 t2' }),
    ]);
    await dirtyTasks.mark([['t1', null]]);

    // 服务端这次返回的 t1 还是没改之前的版本（还没同步过去），t2 是刷新过的版本
    const httpResult = [
      task({ id: 't1', title: '服务端原文（还没同步过去）' }),
      task({ id: 't2', title: '服务端刷新过的 t2' }),
    ];
    await backfillTasks(httpResult);

    const all = await localTasks.read();
    expect(all.find((t) => t.id === 't1')?.title).toBe('离线时改过的标题');
    expect(all.find((t) => t.id === 't2')?.title).toBe('服务端刷新过的 t2');
  });

  it('脏 id 对应的任务不在这次 http() 结果里（服务端还不知道这条离线新建的任务）时，回填之后它依然留在本地', async () => {
    const offlineCreated = task({ id: 'local-only', title: '离线新建，服务端还没有' });
    await localTasks.write([offlineCreated]);
    await dirtyTasks.mark([['local-only', null]]);

    await backfillTasks([task({ id: 'server-task', title: '服务端已有的任务' })]);

    const all = await localTasks.read();
    expect(all.map((t) => t.id).sort()).toEqual(['local-only', 'server-task']);
  });

  it('inbox 同一份逻辑：脏 id 保留本地版本', async () => {
    await localInbox.write([inboxItem({ id: 'i1', text: '离线改过的文字' })]);
    await dirtyInbox.mark([['i1', null]]);

    await backfillInbox([inboxItem({ id: 'i1', text: '服务端原文' })]);

    const all = await localInbox.read();
    expect(all.find((x) => x.id === 'i1')?.text).toBe('离线改过的文字');
  });
});

describe('backfillLists / backfillInsights / backfillProposals：没有离线写，整份覆盖', () => {
  it('三个都是直接把 http() 的结果整份写进对应的本地缓存', async () => {
    const list: List = { id: 'l1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null };
    const insight: Insight = { id: 'ins1', kind: 'note', text: '一条观察', taskIds: [], createdAt: '2026-08-01T00:00:00.000Z', dismissedAt: null };
    const proposal: Proposal = { id: 'p1', taskId: 't1', patch: { title: '改个标题' }, reason: '理由', createdAt: '2026-08-01T00:00:00.000Z' };

    await backfillLists([list]);
    await backfillInsights([insight]);
    await backfillProposals([proposal]);

    expect(await localLists.read()).toEqual([list]);
    expect(await localInsights.read()).toEqual([insight]);
    expect(await localProposals.read()).toEqual([proposal]);
  });

  // 整分支审查 C1 的另一半：`onLocalWrite` 那一声只在**离线写入**时响。回填
  // 是在线读成功之后的旁路写入（写数据但不打脏记号），要是它也叫一声，
  // `reload()` → 在线读 → 回填 → 又一次 `reload()` 就打起转来了。
  it('回填不叫 onLocalWrite 那一声——它写的是缓存不是本地改动，叫了会让在线 reload 打转', async () => {
    const seen = vi.fn();
    const off = onLocalWrite(seen);
    try {
      await backfillTasks([task({ id: 'x' })]);
      await backfillInbox([inboxItem({ id: 'y' })]);
      await backfillLists([]);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe('offlineUnsupported()：没做本地实现的操作，离线时明确报错，不装作成功', () => {
  it('返回的函数被调用时抛出一个说清楚原因的 Error，而不是静默返回点什么', async () => {
    const fn = offlineUnsupported('上传附件');
    await expect(Promise.resolve().then(fn)).rejects.toThrow('离线时无法上传附件，连接服务器之后再试');
  });

  // 整分支审查 I1「门二」：`App.tsx` 的 reload() 靠这个类型分辨「离线时的预期
  // 失败」（不弹提示）和「在线时 /api/settings 真的出事了」（必须弹）。抛裸
  // Error 的话那处只能比对错误文案，又是同一个字面量写两份。
  it('抛的是 OfflineUnsupportedError 这个具体类型，不是裸 Error——调用方要能 instanceof 分辨出它', async () => {
    await expect(Promise.resolve().then(offlineUnsupported('读取设置'))).rejects.toBeInstanceOf(OfflineUnsupportedError);
  });
});

describe('localApi：离线读 / 离线写 / 写完读回来', () => {
  it('离线读：从没写过时，tasks()/inbox() 返回空数组，不抛错', async () => {
    expect(await localApi.tasks()).toEqual([]);
    expect(await localApi.inbox()).toEqual([]);
  });

  it('离线写：addInbox 落盘，且标了「还没同步」', async () => {
    const item = await localApi.addInbox('买菜');
    expect(item.text).toBe('买菜');
    expect(item.processed).toBe(false);
    expect(await dirtyInbox.ids()).toContain(item.id);
  });

  it('addInbox 文本去空白后为空时报错，不写入空文本', async () => {
    await expect(localApi.addInbox('   ')).rejects.toThrow('文本不能为空');
    expect(await localInbox.read()).toEqual([]);
  });

  it('写完读回来：addTask 之后 tasks() 里能看到这条', async () => {
    const created = await localApi.addTask({ title: '写周报' });
    const all = await localApi.tasks();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(created.id);
    expect(all[0]!.title).toBe('写周报');
    // newTask() 该有的默认值：status 是 todo，source 是 user（离线创建的任务，
    // 不是 AI 拆的），不是 undefined 或者漏字段。
    expect(all[0]!.status).toBe('todo');
    expect(all[0]!.source).toBe('user');
  });

  it('addTask 标题为空时报错，不写入', async () => {
    await expect(localApi.addTask({ title: '' })).rejects.toThrow('标题不能为空');
    expect(await localTasks.read()).toEqual([]);
  });

  it('写完读回来：patchTask 之后再 tasks() 能看到新值，且标了「还没同步」', async () => {
    await localTasks.write([task()]);
    const patched = await localApi.patchTask('t1', { title: '交房租（这个月）' });
    expect(patched.title).toBe('交房租（这个月）');
    const all = await localApi.tasks();
    expect(all[0]!.title).toBe('交房租（这个月）');
    expect(await dirtyTasks.ids()).toContain('t1');
  });

  it('patchTask 改 reminders：新时刻的 firedAt 从 null 起算，沿用的旧时刻保留原来的章——跟服务端 applyTaskPatch 同一份语义', async () => {
    await localTasks.write([task({ reminders: [{ at: '2026-08-15T09:00:00.000Z', firedAt: '2026-08-15T09:00:01.000Z' }] })]);
    const patched = await localApi.patchTask('t1', {
      reminders: [
        { at: '2026-08-15T09:00:00.000Z', firedAt: null }, // 客户端总是整份提交，firedAt 会被重算，不看这里传的值
        { at: '2026-08-20T09:00:00.000Z', firedAt: null },
      ],
    });
    expect(patched.reminders).toEqual([
      { at: '2026-08-15T09:00:00.000Z', firedAt: '2026-08-15T09:00:01.000Z' },
      { at: '2026-08-20T09:00:00.000Z', firedAt: null },
    ]);
  });

  it('patchTask 完成一条重复任务：顺手生成下一条，且新任务也标了「还没同步」', async () => {
    await localTasks.write([task({
      due: '2026-08-10T09:00:00.000Z',
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })]);

    const patched = await localApi.patchTask('t1', { status: 'done' });
    expect(patched.status).toBe('done');

    const all = await localApi.tasks();
    expect(all).toHaveLength(2);
    const born = all.find((t) => t.id !== 't1');
    expect(born).toBeDefined();
    expect(born!.status).toBe('todo');
    expect(born!.repeat).toEqual({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null });

    const dirty = await dirtyTasks.ids();
    expect(dirty.has('t1')).toBe(true);
    expect(dirty.has(born!.id)).toBe(true);
  });

  it('patchTask 找不到这个 id 时报错——本地没有这条任务的副本，不是假装改成功', async () => {
    await expect(localApi.patchTask('no-such-id', { title: 'x' })).rejects.toThrow('没有这个任务');
  });

  it('写完读回来：deleteTask 之后任务从 tasks() 消失，出现在 trash() 里——软删除，不是硬删', async () => {
    await localTasks.write([task()]);
    const result = await localApi.deleteTask('t1');
    expect(result).toEqual({ ok: true });

    expect(await localApi.tasks()).toEqual([]);
    const trash = await localApi.trash();
    expect(trash).toHaveLength(1);
    expect(trash[0]!.id).toBe('t1');
    expect(trash[0]!.deletedAt).toBeTruthy();
  });

  it('deleteTask 找不到这个 id 时报错', async () => {
    await expect(localApi.deleteTask('no-such-id')).rejects.toThrow('没有这个任务');
  });

  /**
   * 离线还原。**补的是一扇单向门**：删得掉、却永远还不了，而垃圾箱存在的
   * 全部意义就是让删除不是单向的。判据（deletedAt 不跟回去、order 清成 null）
   * 跟服务端共用 `restoreFromTrash`，在 `server/src/mutate.test.ts` 测过，
   * 这里测的是本地这两张表有没有对上。
   */
  it('restoreTrash 之后任务回到 tasks()、从 trash() 里消失', async () => {
    await localTasks.write([task()]);
    await localApi.deleteTask('t1');

    const back = await localApi.restoreTrash('t1');

    expect(back.id).toBe('t1');
    expect((await localApi.tasks()).map((t) => t.id)).toEqual(['t1']);
    expect(await localApi.trash()).toEqual([]);
  });

  it('还原回来的那条 order 是 null、没有 deletedAt', async () => {
    await localTasks.write([task({ order: 3 })]);
    await localApi.deleteTask('t1');

    const back = await localApi.restoreTrash('t1');

    expect(back.order).toBeNull();
    expect('deletedAt' in back).toBe(false);
  });

  it('记号还在时不清它——pushBack 会因为它回到本地表里自动把「删」翻成「改」', async () => {
    await localTasks.write([task()]);
    await localApi.deleteTask('t1');
    await localApi.restoreTrash('t1');

    expect(await dirtyTasks.ids()).toContain('t1');
  });

  /**
   * **删除已经推回去过，还原还是得自己打记号。** 上面那条一直是绿的，因为
   * 它测的是「删除还没推」那半边——记号是 `deleteTask` 打的，还原什么都不做
   * 也照样在。而记号是会走的：
   *
   * 离线删 → 连上一下把这条删除推回去（`unmarkSettled` 清掉记号，活儿干完了）
   * → 又离线。`localTrash` **从来不修剪**，垃圾箱里照样列着它、照样点得动还原。
   *
   * 那一下不打记号的话，下一次联网 `backfillTasks` 拿服务端那份整个盖掉本地
   * （服务端早没有它了），而还原已经把它从垃圾箱摘掉——**看板和垃圾箱两个
   * 地方都没有了**，零提示。下面第二个断言就是把那一次联网走完。
   */
  it('删除推回去过（记号已清）之后再还原：照样打记号，不会在下一次联网里蒸发', async () => {
    await localTasks.write([task()]);
    await localApi.deleteTask('t1');
    await dirtyTasks.unmark(['t1']);          // 推成功了，unmarkSettled 干的事

    await localApi.restoreTrash('t1');

    // 基准是 null = 「服务端现在没有这条」，decidePush 据此走「直接创建」。
    // 给成删之前那份会判 conflict，替他自己的一次还原写一份撞车副本。
    expect(await dirtyTasks.all()).toEqual({ t1: null });

    // 联网那一拍：服务端确实没有这条，回填不许把它冲掉。
    await backfillTasks([]);
    expect((await localApi.tasks()).map((t) => t.id)).toEqual(['t1']);
  });

  it('一起删进去的子任务是一起捞回来的，记号也得一条不少', async () => {
    await localTasks.write([task(), task({ id: 't2', parentId: 't1' })]);
    await localApi.deleteTask('t1');
    await dirtyTasks.unmark(['t1', 't2']);

    await localApi.restoreTrash('t1');

    expect(Object.keys(await dirtyTasks.all()).sort()).toEqual(['t1', 't2']);
    await backfillTasks([]);
    expect((await localApi.tasks()).map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  // 提示语说「已还原」而列表不动，是因为 onLocalWrite 只在 addToDirty 里叫
  // （localStore.ts）——记号补上之后这一声顺带就有了。
  it('还原会叫 onLocalWrite，屏幕自己刷新', async () => {
    await localTasks.write([task()]);
    await localApi.deleteTask('t1');
    let calls = 0;
    const off = onLocalWrite(() => { calls++; });
    await localApi.restoreTrash('t1');
    off();

    expect(calls).toBeGreaterThan(0);
  });

  it('垃圾箱里没有这一条时报错，不假装还原成功', async () => {
    await expect(localApi.restoreTrash('no-such-id')).rejects.toThrow('垃圾箱里没有这一条');
  });

  it('reorderTasks：按 ids 顺序重写 order，只标记真的变了的那些', async () => {
    await localTasks.write([task({ id: 'a', order: 0 }), task({ id: 'b', order: 1 })]);
    await localApi.reorderTasks(['b', 'a']);

    const all = await localApi.tasks();
    expect(all.find((t) => t.id === 'a')!.order).toBe(1);
    expect(all.find((t) => t.id === 'b')!.order).toBe(0);
    expect(await dirtyTasks.ids()).toEqual(new Set(['a', 'b']));
  });

  it('reorderTasks：顺序没变时不标记、不重写 updatedAt', async () => {
    await localTasks.write([task({ id: 'a', order: 0, updatedAt: '2020-01-01T00:00:00.000Z' })]);
    await localApi.reorderTasks(['a']);

    const all = await localApi.tasks();
    expect(all[0]!.updatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(await dirtyTasks.ids()).toEqual(new Set());
  });

  it('patchTasks：批量改，updated 只数真的命中的，未命中的 id 不影响计数也不标记', async () => {
    await localTasks.write([task({ id: 'a', status: 'todo' }), task({ id: 'b', status: 'todo' })]);
    const result = await localApi.patchTasks(['a', 'no-such-id'], { status: 'doing' });

    expect(result).toEqual({ updated: 1 });
    const all = await localApi.tasks();
    expect(all.find((t) => t.id === 'a')!.status).toBe('doing');
    expect(all.find((t) => t.id === 'b')!.status).toBe('todo');
    expect(await dirtyTasks.ids()).toEqual(new Set(['a']));
  });

  it('deleteTasks：批量软删除，deleted 只数真的命中的', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' })]);
    const result = await localApi.deleteTasks(['a', 'no-such-id']);

    expect(result).toEqual({ deleted: 1 });
    const all = await localApi.tasks();
    expect(all.map((t) => t.id)).toEqual(['b']);
    const trash = await localApi.trash();
    expect(trash.map((t) => t.id)).toEqual(['a']);
  });

  it('没有离线写实现的实体（proposals/lists/insights/conflicts）：读到空数组，不抛错也不假装有数据', async () => {
    expect(await localApi.proposals()).toEqual([]);
    expect(await localApi.lists()).toEqual([]);
    expect(await localApi.insights()).toEqual([]);
    expect(await localApi.conflicts()).toEqual([]);
  });

  /**
   * 整分支审查 I2：单条 `patchTask` 完成重复任务会生成下一条实例，上面那条
   * 测试守着；**批量的这一份之前零覆盖**——把 `patchTasks` 里
   * `maybeSpawnNextInstance(...)` 的结果换成 `null`，
   * `dataSource.test.ts + api.test.ts + localStore.test.ts` 77 条全绿。
   * 这正是 已归档的 docs/superpowers/specs/2026-08-15-parked-all.md 第十一节 96 条
   * 记过的那起原始事故（批量完成静默断掉重复链），只是换到了离线这一侧。
   */
  it('patchTasks 批量完成重复任务：跟单条 patchTask 同一份语义，顺手生成下一条实例，普通任务不生成', async () => {
    await localTasks.write([
      task({ id: 'r1', title: '倒垃圾', due: '2026-08-10T09:00:00.000Z', repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null } }),
      task({ id: 'plain', title: '写周报' }),
    ]);

    const result = await localApi.patchTasks(['r1', 'plain'], { status: 'done' });
    expect(result).toEqual({ updated: 2 });

    const all = await localApi.tasks();
    // 原来两条 + 重复任务生成的那一条 = 三条；普通任务不该也生出一条。
    expect(all).toHaveLength(3);
    const born = all.find((t) => t.id !== 'r1' && t.id !== 'plain');
    expect(born, '批量完成重复任务没有生成下一条实例——离线批量完成会静默断掉重复链').toBeDefined();
    expect(born!.title).toBe('倒垃圾');
    expect(born!.status).toBe('todo');
    expect(born!.repeat).toEqual({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null });
    // 新生成的这条也是「还没同步」的本地改动，跟单条那条路径一致。
    expect(await dirtyTasks.ids()).toContain(born!.id);
  });

  /**
   * 整分支审查 I3：`patchInbox`/`deleteInbox`/`deleteTask`/`deleteTasks` 四处
   * 的 `dirty*.mark` 之前零覆盖——四行一起删掉，67 条全绿。
   * （`addTask`/`patchTask`/`addInbox`/`reorderTasks`/`patchTasks` 五处上面
   * 已经有断言。）
   *
   * 这四条断言的不是「`mark` 被调用了」，是**少这行的真实后果**：脏记号唯一
   * 的用处就是「下次在线回填时别让服务端的旧版本盖掉这条本地改动」（见
   * `backfillTasks`/`backfillInbox`），所以每条都走完「离线改 → 回填 →
   * 本地还是我改的那份」这条完整的路。少打记号的话回填会把它冲回服务端原文，
   * **连本地都留不住**。
   */
  it('patchInbox 打记号：离线改过的收件箱文字，在线回填时不会被服务端原文冲掉', async () => {
    await localInbox.write([inboxItem({ id: 'i1', text: '服务端原文' })]);
    await localApi.patchInbox('i1', { text: '离线改过的文字' });

    await backfillInbox([inboxItem({ id: 'i1', text: '服务端原文' })]);

    expect((await localApi.inbox()).find((x) => x.id === 'i1')?.text).toBe('离线改过的文字');
  });

  it('deleteInbox 打记号：离线删掉的收件箱条目，在线回填时不会被服务端那份带回来', async () => {
    await localInbox.write([inboxItem({ id: 'i1' }), inboxItem({ id: 'i2' })]);
    await localApi.deleteInbox('i1');

    await backfillInbox([inboxItem({ id: 'i1' }), inboxItem({ id: 'i2' })]);

    expect((await localApi.inbox()).map((x) => x.id)).toEqual(['i2']);
  });

  it('deleteTask 打记号：离线删掉的任务，在线回填时不会被服务端那份带回来', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' })]);
    await localApi.deleteTask('a');

    await backfillTasks([task({ id: 'a' }), task({ id: 'b' })]);

    expect((await localApi.tasks()).map((t) => t.id)).toEqual(['b']);
  });

  it('deleteTasks 打记号：离线批量删掉的任务，在线回填时不会被服务端那几份带回来', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);
    await localApi.deleteTasks(['a', 'b']);

    await backfillTasks([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);

    expect((await localApi.tasks()).map((t) => t.id)).toEqual(['c']);
  });

  // 修复轮 2（C2）：settings 不在 localApi 里——伪造一份 DEFAULT_SETTINGS
  // 当「读到了」的答案比不支持离线更糟（调用方分辨不出真假，见
  // dataSource.ts 模块顶部注释），这里改成断言它压根不存在这个方法，
  // 不是断言它返回什么值。
  it('settings 不是 localApi 的一部分——离线时走 api.ts 的 offlineUnsupported，不伪造一份默认设置', () => {
    expect('settings' in localApi).toBe(false);
  });
});

/**
 * 九个离线写方法各自记下的**基准**——「本地改它之前那份长什么样」。推回服务端
 * 时的三方比较（本地 / 基准 / 服务端）全靠它：没有基准就分不出「只有我改了」
 * 和「两边都改了」。
 *
 * **为什么这一组必须逐条存在**：基准全填 `null` 恰好等于「这个特性关着」，而上面
 * 那些既有用例全是在这个隐含状态下写的（它们只问 `.ids()`，从不问基准是什么）
 * ——漏掉九处里的任何一处，编译器也帮不上忙（`null` 一直是合法值），那一处会
 * **静默地永远推不回去**。假绿总账第 141 条。所以每处都单独一条，且每条只碰
 * 一个写方法：某一处的基准被改坏，红的必须恰好是它自己那条。
 *
 * **夹具值特意避开默认值**（同样是 141 的破法）：基准里的 `priority`/`order`/
 * `processed`/`taskIds` 都不是 `newLocalTask`/`inboxItem` 的默认值，也都不等于
 * 改完之后那份——不然「真存了改前那份」和「随手存了个默认值/存成了改后那份」
 * 两种实现都能绿。**存成改后那份**是这里最容易犯的错（把读挪到写之后就会），
 * 症状还特别隐蔽：基准 == 本地那份，推回去时会被判成「没改过」，静默不推。
 */
describe('离线写打的记号带着基准：「改之前那份」，不是改完那份', () => {
  it('addInbox：离线新建的条目基准是 null——服务端从来没有过这个 id，没有基准可言', async () => {
    setOnlineForTest(false);
    const item = await localApi.addInbox('买菜');

    const all = await dirtyInbox.all();
    expect(Object.keys(all)).toEqual([item.id]);
    expect(all[item.id]).toBeNull();
  });

  it('patchInbox：基准是改之前那份收件箱条目', async () => {
    setOnlineForTest(false);
    await localInbox.write([inboxItem({ id: 'i1', text: '服务端原文', processed: true, taskIds: ['t9'] })]);
    await localApi.patchInbox('i1', { text: '离线改过的文字' });

    const base = (await dirtyInbox.all()).i1;
    expect(base!.text).toBe('服务端原文');
    expect(base!.processed).toBe(true);
    expect(base!.taskIds).toEqual(['t9']);
  });

  it('deleteInbox：基准是删之前那份——本地已经没有这条了，基准是它仅存的样子', async () => {
    setOnlineForTest(false);
    await localInbox.write([
      inboxItem({ id: 'i1', text: '删之前的文字', processed: true, taskIds: ['t9'] }),
      inboxItem({ id: 'i2', text: '留着的' }),
    ]);
    await localApi.deleteInbox('i1');

    const base = (await dirtyInbox.all()).i1;
    expect(base!.text).toBe('删之前的文字');
    expect(base!.processed).toBe(true);
    expect(base!.taskIds).toEqual(['t9']);
  });

  it('addTask：离线新建的任务基准是 null', async () => {
    setOnlineForTest(false);
    const created = await localApi.addTask({ title: '写周报', priority: 3 });

    const all = await dirtyTasks.all();
    expect(Object.keys(all)).toEqual([created.id]);
    expect(all[created.id]).toBeNull();
  });

  it('patchTask 记下的基准是「改之前那份」，不是改完那份', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 't1', title: '旧标题', priority: 2 })]);
    await localApi.patchTask('t1', { title: '新标题' });

    const base = (await dirtyTasks.all()).t1;
    expect(base!.title).toBe('旧标题');
    expect(base!.priority).toBe(2);
  });

  it('patchTask 完成一条重复任务：生出来的下一条基准是 null（服务端还没有它）', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({
      id: 't1', title: '倒垃圾', due: '2026-08-10T09:00:00.000Z',
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })]);
    await localApi.patchTask('t1', { status: 'done' });

    const all = await dirtyTasks.all();
    const bornId = Object.keys(all).find((id) => id !== 't1')!;
    expect(all[bornId]).toBeNull();
  });

  it('deleteTask：基准是删之前那份，不是垃圾箱里那份（垃圾箱那份多一个 deletedAt）', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 't1', title: '删之前的标题', priority: 2, status: 'doing' })]);
    await localApi.deleteTask('t1');

    const base = (await dirtyTasks.all()).t1;
    expect(base!.title).toBe('删之前的标题');
    expect(base!.priority).toBe(2);
    expect(base!.status).toBe('doing');
    expect('deletedAt' in base!).toBe(false);
  });

  it('reorderTasks：每条真的挪过的都带着改之前那份，order 是老值不是新下标', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 'a', title: 'A', order: 5 }), task({ id: 'b', title: 'B', order: 9 })]);
    await localApi.reorderTasks(['b', 'a']);

    const all = await dirtyTasks.all();
    expect(all.a!.order).toBe(5);
    expect(all.b!.order).toBe(9);
  });

  it('patchTasks：每条命中的都带着改之前那份', async () => {
    setOnlineForTest(false);
    await localTasks.write([
      task({ id: 'a', title: 'A 的旧标题', priority: 2 }),
      task({ id: 'b', title: 'B 的旧标题', priority: 3 }),
    ]);
    await localApi.patchTasks(['a', 'b'], { status: 'doing' });

    const all = await dirtyTasks.all();
    expect(all.a!.status).toBe('todo');
    expect(all.a!.priority).toBe(2);
    expect(all.b!.status).toBe('todo');
    expect(all.b!.priority).toBe(3);
  });

  it('patchTasks 批量完成重复任务：生出来的那条基准是 null——跟单条 patchTask 同一份语义', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({
      id: 'r1', title: '倒垃圾', due: '2026-08-10T09:00:00.000Z',
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
    })]);
    await localApi.patchTasks(['r1'], { status: 'done' });

    const all = await dirtyTasks.all();
    const bornId = Object.keys(all).find((id) => id !== 'r1')!;
    expect(all[bornId]).toBeNull();
  });

  it('deleteTasks：每条删掉的都带着删之前那份，没删的那条压根没有记号', async () => {
    setOnlineForTest(false);
    await localTasks.write([
      task({ id: 'a', title: 'A 删之前', priority: 2 }),
      task({ id: 'b', title: 'B 删之前', priority: 3 }),
      task({ id: 'c', title: 'C 留着' }),
    ]);
    await localApi.deleteTasks(['a', 'b']);

    const all = await dirtyTasks.all();
    expect(all.a!.title).toBe('A 删之前');
    expect(all.a!.priority).toBe(2);
    expect(all.b!.title).toBe('B 删之前');
    expect(all.b!.priority).toBe(3);
    expect('c' in all).toBe(false);
  });

  // 「连着离线改两次，基准还是第一次改之前那份」不在这一组里——那是 `mark()`
  // 自己的语义（`localStore.ts` 的 `addToDirty`「先到的基准不许被后到的覆盖」），
  // `localStore.test.ts` 已经在 `mark()` 这一层守着了。在这里再写一条，会让
  // 「patchTask 的基准被改坏」同时红两条，上面那条「每条只碰一个写方法」的
  // 隔离就不成立了。
});

/**
 * 离线跳过。跟服务端那条路由一字不差的一点：**不算一次拖延**。
 */
/**
 * **离线改任务要跑三条连带，跟服务端同一份 `cascadeAll`。**
 *
 * 原来这儿只有 `applyTaskPatch`，漏掉的东西当场就看得见：勾掉一个父任务，
 * 界面弹「连带做完了 N 条子任务」——那句提示是界面自己按服务端的规矩算出来的
 * （`lib/undoDone.ts`，跟在线离线无关地弹），而屏幕上那 N 条一条没动。
 *
 * 判据本身在 `server/src/mutate.test.ts` 测过，这里测的是**离线这条路有没有
 * 接上它**，以及**被连带改到的那几条有没有打记号**——不打的话改动只活到下一次
 * 联网，`backfillTasks` 会把它们换回服务端那份，子任务原地弹回未完成。
 */
describe('离线改任务：三条连带跟服务端一样跑，被带到的那几条也打记号', () => {
  const parent = (p: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...p });
  const kid = (id: string, p: Partial<Task> = {}) => task({ id, parentId: 'p', title: id, ...p });

  it('完成父任务 → 底下的子任务跟着完成（cascadeChildrenDone）', async () => {
    setOnlineForTest(false);
    await localTasks.write([parent(), kid('k1'), kid('k2')]);

    await localApi.patchTask('p', { status: 'done' });

    const byId = new Map((await localApi.tasks()).map((t) => [t.id, t]));
    expect(byId.get('k1')!.status).toBe('done');
    expect(byId.get('k2')!.status).toBe('done');
  });

  it('连带改到的子任务各自带基准（改之前那份），下一次联网不会被回填抹掉', async () => {
    setOnlineForTest(false);
    await localTasks.write([parent(), kid('k1')]);

    await localApi.patchTask('p', { status: 'done' });

    const marks = await dirtyTasks.all();
    expect(Object.keys(marks).sort()).toEqual(['k1', 'p']);
    expect(marks.k1!.status).toBe('todo');           // 基准是改之前那份，不是改完那份

    // 联网那一拍：服务端还是旧的那份，脏记号护住本地这次连带。
    await backfillTasks([parent(), kid('k1')]);
    const back = new Map((await localApi.tasks()).map((t) => [t.id, t]));
    expect(back.get('k1')!.status).toBe('done');
  });

  it('最后一个子任务做完 → 父任务跟着完成（rollUpParentDone），父任务也打记号', async () => {
    setOnlineForTest(false);
    await localTasks.write([parent(), kid('k1', { status: 'done' }), kid('k2')]);

    await localApi.patchTask('k2', { status: 'done' });

    const byId = new Map((await localApi.tasks()).map((t) => [t.id, t]));
    expect(byId.get('p')!.status).toBe('done');
    expect(Object.keys(await dirtyTasks.all()).sort()).toEqual(['k2', 'p']);
  });

  it('父任务换清单 → 原来跟它在一起的子任务跟着走（cascadeListToChildren）', async () => {
    setOnlineForTest(false);
    await localTasks.write([
      parent({ listId: 'A' }), kid('k1', { listId: 'A' }), kid('k2', { listId: '别处' }),
    ]);

    await localApi.patchTask('p', { listId: 'B' });

    const byId = new Map((await localApi.tasks()).map((t) => [t.id, t]));
    expect(byId.get('k1')!.listId).toBe('B');
    expect(byId.get('k2')!.listId).toBe('别处');      // 特意另归过类的那条不动
  });

  it('批量改也走同一条：patchTasksEach 的连带和记号一样不少', async () => {
    setOnlineForTest(false);
    await localTasks.write([parent(), kid('k1'), task({ id: '别的', title: '不相干' })]);

    await localApi.patchTasksEach([{ id: 'p', patch: { status: 'done' } }]);

    const byId = new Map((await localApi.tasks()).map((t) => [t.id, t]));
    expect(byId.get('k1')!.status).toBe('done');
    expect(Object.keys(await dirtyTasks.all()).sort()).toEqual(['k1', 'p']);
  });

  // 没触发任何连带时不该多打记号——没变的那几条推回去是白推，而且会把
  // 「服务端那份」当基准存下来，多一次假撞车的机会。
  it('没连带发生时只标改的那一条', async () => {
    setOnlineForTest(false);
    await localTasks.write([parent(), kid('k1')]);

    await localApi.patchTask('p', { title: '改个标题' });

    expect(Object.keys(await dirtyTasks.all())).toEqual(['p']);
  });
});

/**
 * **两个离线写同时在飞，第一个整个消失。** 每张表、每个记号集合都是「读整份 →
 * 改 → 写整份」，`Preferences.get/set` 异步：两个写都读到旧的那份，后写的把先写
 * 的盖掉。修之前实测：`a=todo b=done`、脏集里只有 `b`——第一张卡的完成和它的
 * 记号都没了。现在所有本地写过 `serialized` 那把锁（localStore.ts）。
 */
describe('本地写排队：并发的两次写一个都不丢', () => {
  it('连点两张卡的完成：两条改动、两条记号都在', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' })]);

    await Promise.all([localApi.patchTask('a', { status: 'done' }), localApi.patchTask('b', { status: 'done' })]);

    const rows = await localTasks.read();
    expect(rows.map((t) => [t.id, t.status])).toEqual([['a', 'done'], ['b', 'done']]);
    expect(Object.keys(await dirtyTasks.all()).sort()).toEqual(['a', 'b']);
  });

  it('连记两条随手记：两条都在', async () => {
    setOnlineForTest(false);
    const [x, y] = await Promise.all([localApi.addInbox('买菜'), localApi.addInbox('交房租')]);
    expect((await localApi.inbox()).map((i) => i.id).sort()).toEqual([x.id, y.id].sort());
    expect(Object.keys(await dirtyInbox.all()).sort()).toEqual([x.id, y.id].sort());
  });

  it('一次写失败不卡住后面的：下一次写照常', async () => {
    setOnlineForTest(false);
    await expect(localApi.patchTask('没有这个', { title: 'x' })).rejects.toThrow('没有这个任务');
    await localTasks.write([task({ id: 'a' })]);
    await localApi.patchTask('a', { title: '还能写' });
    expect((await localTasks.read())[0].title).toBe('还能写');
  });

  it('回填也排在写后面：正在飞的离线改动不会被回填盖掉', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 'a', title: '服务端原文' })]);
    // 不 await 前一个：回填紧跟着发出去
    const write = localApi.patchTask('a', { title: '离线改的' });
    const fill = backfillTasks([task({ id: 'a', title: '服务端原文' })]);
    await Promise.all([write, fill]);
    expect((await localTasks.read())[0].title, '回填读到的脏集里得有 a').toBe('离线改的');
  });
});

describe('localApi.skipTask', () => {
  const DAILY = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };
  const repeating = (over = {}) => task({
    due: new Date(2026, 7, 20, 7).toISOString(), repeat: DAILY, ...over,
  });

  it('往前走一格，离线也做得了——任务本来就是可离线写的那一类', async () => {
    await localTasks.write([repeating()]);
    const next = await localApi.skipTask('t1');
    expect(next.due).not.toBe(repeating().due);
    expect((await localApi.tasks())[0].due).toBe(next.due);
  });

  it('**不算一次拖延**', async () => {
    await localTasks.write([repeating({ postponeCount: 2 })]);
    expect((await localApi.skipTask('t1')).postponeCount).toBe(2);
  });

  it('跳不动时报错，不假装跳成功', async () => {
    await localTasks.write([task({ repeat: null })]);
    await expect(localApi.skipTask('t1')).rejects.toThrow(/跳不动/);
  });

  it('找不到这个 id 时报错', async () => {
    await expect(localApi.skipTask('no-such-id')).rejects.toThrow('没有这个任务');
  });
});
