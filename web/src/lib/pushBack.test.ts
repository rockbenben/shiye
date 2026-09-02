import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * node 档（`*.test.ts`），跟 dataSource.test.ts/localStore.test.ts 同一条理由：
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

import { Preferences } from '@capacitor/preferences';
import { api } from '../api.js';
import { decidePush, type PushKindResult, type PushResponse } from '../../../server/src/push.js';
import type { InboxItem, Task } from '../types.js';
import { setApiBase } from './apiBase.js';
import { resetOnlineCache, setOnlineForTest } from './dataSource.js';
import { dirtyInbox, dirtyTasks, localInbox, localTasks } from './localStore.js';
import { pushBackIfDirty, resetPushInflightForTest } from './pushBack.js';

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

const bucket = (pushed: string[] = [], cleared: string[] = [], conflicted: string[] = []): PushKindResult =>
  ({ pushed, cleared, conflicted });
const empty = (): PushKindResult => bucket();

/** 任务那半有内容、收件箱那半三个空数组。 */
const okResponse = (pushed: string[], cleared: string[], conflicted: string[]): PushResponse =>
  ({ tasks: bucket(pushed, cleared, conflicted), inbox: empty() });
/** 反过来：收件箱那半有内容。 */
const okInboxResponse = (pushed: string[], cleared: string[], conflicted: string[]): PushResponse =>
  ({ tasks: empty(), inbox: bucket(pushed, cleared, conflicted) });

beforeEach(() => {
  store.clear();
  setApiBase('');
  resetOnlineCache();
  // 一条测试留下的飞行中 promise 会让下一条的并发去重误判。
  resetPushInflightForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setOnlineForTest(null);
  resetPushInflightForTest();
});

describe('组装：脏集 → 条目', () => {
  it('脏集空：一次网络都不发，返回 null', async () => {
    const spy = vi.spyOn(api, 'pushBack');
    expect(await pushBackIfDirty()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('改过的：带上基准和现在那份，op 是 upsert', async () => {
    await localTasks.write([task({ id: 't1', title: '手机改的' })]);
    await dirtyTasks.mark([['t1', task({ id: 't1', title: '原文' })]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['t1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0].tasks).toEqual([
      { id: 't1', op: 'upsert', base: task({ id: 't1', title: '原文' }), value: task({ id: 't1', title: '手机改的' }) },
    ]);
  });

  it('脏集里有、本地任务表里没有 → op 是 delete，value 是 null（不读 localTrash）', async () => {
    await localTasks.write([]);
    await dirtyTasks.mark([['t1', task({ id: 't1' })]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['t1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0].tasks[0]).toEqual({ id: 't1', op: 'delete', base: task({ id: 't1' }), value: null });
  });

  /**
   * 离线删掉、又在离线时还原回来的那条。**这是「还原」这个动作在同步上的
   * 全部代价——零**：`op` 只看「脏集里的这个 id 在本地任务表里还在不在」，
   * 还原把它放回了 `localTasks`，判断自动从 delete 翻成 upsert。
   * 这条测试钉的正是那个自动性：哪天有人改成读 `localTrash` 来判，
   * 「离线删了又还原」就会被当成删除推上去，任务在桌面上真的没了。
   */
  it('离线删了又还原回来 → op 翻回 upsert，不会把它在桌面上删掉', async () => {
    const t = task({ id: 't1' });
    await localTasks.write([t]);            // 还原之后它回到了本地表里
    await dirtyTasks.mark([['t1', t]]);     // 记号是删除那一下留下的，还原不清它
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['t1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0].tasks[0]).toMatchObject({ id: 't1', op: 'upsert' });
  });

  it('收件箱改过的：同样带基准和现在那份，op 是 upsert', async () => {
    await localInbox.write([inboxItem({ id: 'i1', text: '手机改的随手记' })]);
    await dirtyInbox.mark([['i1', inboxItem({ id: 'i1', text: '原文' })]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okInboxResponse(['i1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0].inbox).toEqual([
      { id: 'i1', op: 'upsert', base: inboxItem({ id: 'i1', text: '原文' }), value: inboxItem({ id: 'i1', text: '手机改的随手记' }) },
    ]);
  });

  it('收件箱脏集里有、本地收件箱里没有 → op 是 delete，value 是 null', async () => {
    await localInbox.write([]);
    await dirtyInbox.mark([['i1', inboxItem({ id: 'i1' })]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okInboxResponse(['i1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0].inbox[0]).toEqual({ id: 'i1', op: 'delete', base: inboxItem({ id: 'i1' }), value: null });
  });

  it('只有任务脏时 inbox 键仍然在（空数组合法，两个键都必填）', async () => {
    await localTasks.write([task({ id: 't1' })]);
    await dirtyTasks.mark([['t1', null]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['t1'], [], []));

    await pushBackIfDirty();

    expect(spy.mock.calls[0]![0]).toEqual({
      tasks: [{ id: 't1', op: 'upsert', base: null, value: task({ id: 't1' }) }],
      inbox: [],
    });
  });

  it('两类同时脏：一次请求带上两边的条目，各归各的键', async () => {
    await localTasks.write([task({ id: 't1', title: '手机改的' })]);
    await localInbox.write([inboxItem({ id: 'i1', text: '手机改的随手记' })]);
    await dirtyTasks.mark([['t1', task({ id: 't1', title: '原文' })]]);
    await dirtyInbox.mark([['i1', inboxItem({ id: 'i1', text: '原文' })]]);
    const spy = vi.spyOn(api, 'pushBack')
      .mockResolvedValue({ tasks: bucket(['t1']), inbox: bucket(['i1']) });

    await pushBackIfDirty();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].tasks.map((e) => e.id)).toEqual(['t1']);
    expect(spy.mock.calls[0]![0].inbox.map((e) => e.id)).toEqual(['i1']);
  });
});

describe('清记号：三个桶都清，其余保留', () => {
  it('pushed / cleared / conflicted 三个桶的记号都清掉——只清 pushed 的话每次重连都再撞一次', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);
    await dirtyTasks.mark([['a', null], ['b', null], ['c', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], ['b'], ['c']));

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set());
  });

  it('收件箱那半一样：三个桶的记号都清掉', async () => {
    await localInbox.write([inboxItem({ id: 'a' }), inboxItem({ id: 'b' }), inboxItem({ id: 'c' })]);
    await dirtyInbox.mark([['a', null], ['b', null], ['c', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okInboxResponse(['a'], ['b'], ['c']));

    await pushBackIfDirty();

    expect(await dirtyInbox.ids()).toEqual(new Set());
  });

  it('没出现在回执里的 id 保留记号——服务端只处理了一部分', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' })]);
    await dirtyTasks.mark([['a', null], ['b', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], [], []));

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set(['b']));
  });

  it('收件箱那半一样：没出现在回执里的 id 保留记号', async () => {
    await localInbox.write([inboxItem({ id: 'a' }), inboxItem({ id: 'b' })]);
    await dirtyInbox.mark([['a', null], ['b', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okInboxResponse(['a'], [], []));

    await pushBackIfDirty();

    expect(await dirtyInbox.ids()).toEqual(new Set(['b']));
  });

  it('两类的回执各清各的：任务那半结清了，收件箱里同名的 id 不会被顺手清掉', async () => {
    await localTasks.write([task({ id: 'x' })]);
    await localInbox.write([inboxItem({ id: 'x' })]);
    await dirtyTasks.mark([['x', null]]);
    await dirtyInbox.mark([['x', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['x'], [], []));

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set());
    expect(await dirtyInbox.ids()).toEqual(new Set(['x']));
  });
});

describe('推送在飞的时候本地又改了：那条的记号不清', () => {
  it('改过的那条：推送途中又改了 → 记号留着（清了这次改动就再也推不回去）', async () => {
    await localTasks.write([task({ id: 'a', title: '推出去的那份' })]);
    await dirtyTasks.mark([['a', null]]);
    vi.spyOn(api, 'pushBack').mockImplementation(async () => {
      await localTasks.write([task({ id: 'a', title: '推送途中又改的' })]);
      return okResponse(['a'], [], []);
    });

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set(['a']));
  });

  it('收件箱那半一样：推送途中又改了 → 记号留着', async () => {
    await localInbox.write([inboxItem({ id: 'a', text: '推出去的那份' })]);
    await dirtyInbox.mark([['a', null]]);
    vi.spyOn(api, 'pushBack').mockImplementation(async () => {
      await localInbox.write([inboxItem({ id: 'a', text: '推送途中又改的' })]);
      return okInboxResponse(['a'], [], []);
    });

    await pushBackIfDirty();

    expect(await dirtyInbox.ids()).toEqual(new Set(['a']));
  });

  it('删除那条：发出去的是 delete，回执回来时它又被本地建出来了 → 记号留着，基准换成「服务端没有这条」', async () => {
    await localTasks.write([]);
    await dirtyTasks.mark([['a', task({ id: 'a', title: '删掉的那份' })]]);
    vi.spyOn(api, 'pushBack').mockImplementation(async () => {
      await localTasks.write([task({ id: 'a', title: '又建回来的' })]);
      return okResponse(['a'], [], []);
    });

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set(['a']));
    // 删除推成功了，服务端此刻**真的没有这条**——新基准只能是 `null`（`decidePush`
    // 里「没有基准」就是这个意思）。留着老基准「删掉的那份」的话，下一拍拿它去跟
    // 「服务端没有」比，会判成「服务端曾经有、现在没了」→ conflict，把本地刚建回来
    // 的那份写成副本、不创建。基准换成 null 之后走的是「离线新建 → 直接创建」。
    expect((await dirtyTasks.all()).a).toBeNull();
  });

  it('回执里出现了这次根本没发过的 id：不清它的记号——那是推送途中才标脏的，从来没推过', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await dirtyTasks.mark([['a', null]]);
    vi.spyOn(api, 'pushBack').mockImplementation(async () => {
      await localTasks.write([task({ id: 'a' }), task({ id: 'b', title: '推送途中新建的' })]);
      await dirtyTasks.mark([['b', null]]);
      return okResponse(['a', 'b'], [], []);
    });

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set(['b']));
  });

  it('换基准的过程中记号一刻都没离开存储——写进脏集那个 key 的每一份内容里都有它', async () => {
    // 整分支审查 I-A：换基准要是写成「先 unmark 再 mark」，两次 IO 之间记号是真的
    // 不在存储里的。手机上进程随时会被杀，死在这中间那条离线改动就永远推不回去、
    // 零信号。断「最后还在」证明不了这件事——中间那一份没有它照样绿。所以这里断的是
    // **这次推送写进那个 key 的每一份内容**，一份都不许缺。
    await localTasks.write([task({ id: 'a', title: '推出去的那份' })]);
    await dirtyTasks.mark([['a', task({ id: 'a', title: '原文' })]]);
    vi.spyOn(api, 'pushBack').mockImplementation(async () => {
      await localTasks.write([task({ id: 'a', title: '推送途中又改的' })]);
      return okResponse(['a'], [], []);
    });
    const setSpy = vi.mocked(Preferences.set);
    const from = setSpy.mock.calls.length;

    await pushBackIfDirty();

    const dirtyWrites = setSpy.mock.calls.slice(from)
      .filter(([arg]) => arg.key === 'local:dirtyTaskIds')
      .map(([arg]) => JSON.parse(arg.value) as Record<string, unknown>);
    // 真的写过（一次都没写的话下面那句是空转的假绿）。
    expect(dirtyWrites.length).toBeGreaterThan(0);
    for (const w of dirtyWrites) expect('a' in w).toBe(true);
    // 而且基准真的换掉了（不是靠「一次都没写」蒙混过关）。
    expect((await dirtyTasks.all()).a).toEqual(task({ id: 'a', title: '推出去的那份' }));
  });

  it('**跑第二轮**：飞行中改的那条下一拍不该撞车——推成功之后基准换成服务端现在那份', async () => {
    // 记号留着只做对了一半（整分支审查 I2）。基准还停在 `B0`、而服务端此刻已经是
    // 这一轮推上去的 `V1`，下一拍三方比较得到「服务端 != 我现在这份、服务端 != 基准」
    // → **判成冲突**：没有第二台设备参与，用户自己接着改的第二次被写成冲突副本、
    // 屏幕上弹「1 条撞车」。上面那三条断完 `ids()` 就结束，全都跑不到第二轮。
    await localTasks.write([task({ id: 'a', title: 'V1 推出去的那份' })]);
    await dirtyTasks.mark([['a', task({ id: 'a', title: 'B0 服务端原来那份' })]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], [], []));
    spy.mockImplementationOnce(async () => {
      await localTasks.write([task({ id: 'a', title: 'V2 推送途中又改的' })]);
      return okResponse(['a'], [], []);
    });

    await pushBackIfDirty();
    await pushBackIfDirty();

    expect(spy).toHaveBeenCalledTimes(2);
    const second = spy.mock.calls[1]![0].tasks[0]!;
    expect(second).toEqual({
      id: 'a', op: 'upsert',
      base: task({ id: 'a', title: 'V1 推出去的那份' }),
      value: task({ id: 'a', title: 'V2 推送途中又改的' }),
    });
    // 判「该不该撞车」用的是服务端那一份判据本身（两边共用同一份），不在这儿另写一遍。
    // 服务端此刻就是第一轮推上去的 V1。
    expect(decidePush(second, task({ id: 'a', title: 'V1 推出去的那份' }))).toBe('push');
  });

  it('反过来：从发出去到回执之间本地一个字节都没动 → 记号照常清掉（上面那层守卫不是把所有记号都留着）', async () => {
    await localTasks.write([task({ id: 'a', title: '推出去的那份' })]);
    await dirtyTasks.mark([['a', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], [], []));

    await pushBackIfDirty();

    expect(await dirtyTasks.ids()).toEqual(new Set());
  });
});

describe('推送失败：一个记号都不清', () => {
  it('网络中途断了：异常原样抛给调用方，两类的记号一个都不清', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await localInbox.write([inboxItem({ id: 'b' })]);
    await dirtyTasks.mark([['a', null]]);
    await dirtyInbox.mark([['b', null]]);
    vi.spyOn(api, 'pushBack').mockRejectedValue(new Error('connection reset'));

    await expect(pushBackIfDirty()).rejects.toThrow('connection reset');

    expect(await dirtyTasks.ids()).toEqual(new Set(['a']));
    expect(await dirtyInbox.ids()).toEqual(new Set(['b']));
  });

  it('400（形状不合法/id 不安全）：服务端一个文件都没碰，这边也一个记号都不清', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await dirtyTasks.mark([['a', null]]);
    vi.spyOn(api, 'pushBack').mockRejectedValue(new Error('tasks 里的条目形状不对'));

    await expect(pushBackIfDirty()).rejects.toThrow('tasks 里的条目形状不对');

    expect(await dirtyTasks.ids()).toEqual(new Set(['a']));
  });
});

describe('并发去重和汇总数', () => {
  it('并发调用去重成一次请求——60 秒心跳和 SSE 重连可能同一拍都叫它', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await dirtyTasks.mark([['a', null]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], [], []));

    await Promise.all([pushBackIfDirty(), pushBackIfDirty()]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('上一次落定之后再叫：是新的一次请求，不是被去重掉', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await dirtyTasks.mark([['a', null]]);
    const spy = vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse([], [], []));

    await pushBackIfDirty();
    await pushBackIfDirty();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('汇总数只数 pushed 和 conflicted——cleared 是「本来就一样」，不该报给人看', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);
    await dirtyTasks.mark([['a', null], ['b', null], ['c', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse(['a'], ['b'], ['c']));

    expect(await pushBackIfDirty()).toEqual({ pushed: 1, conflicted: 1, revived: 0 });
  });

  it('汇总数是两类相加，不是只数任务那半', async () => {
    await localTasks.write([task({ id: 'a' }), task({ id: 'b' })]);
    await localInbox.write([inboxItem({ id: 'c' }), inboxItem({ id: 'd' })]);
    await dirtyTasks.mark([['a', null], ['b', null]]);
    await dirtyInbox.mark([['c', null], ['d', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue({ tasks: bucket(['a'], [], ['b']), inbox: bucket(['c'], [], ['d']) });

    expect(await pushBackIfDirty()).toEqual({ pushed: 2, conflicted: 2, revived: 0 });
  });

  it('汇总里数出「离线删掉的、但服务端没删」几条——只数没有基准那种，那几条任务会重新出现', async () => {
    // 旧格式脏记号迁移过来时没有基准，删除判不出服务端动没动过 → 不删、判 cleared
    // （计划⑥那张表最后一行）。这是唯一一种「界面自己变了，而 pushed/conflicted 都是
    // 0」的走法，不数出来的话任务默默回到看板上、零解释（整分支审查 M3）。
    // 三个条件各安排一条反例：`b` 有基准（那种 cleared 说明的是服务端本来就没有这条，
    // 什么都不会重新出现）、`c` 是 upsert（两边内容本来就一样，界面上什么都不变）。
    await localTasks.write([task({ id: 'c' })]);
    await dirtyTasks.mark([['a', null], ['b', task({ id: 'b' })], ['c', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue(okResponse([], ['a', 'b', 'c'], []));

    expect(await pushBackIfDirty()).toEqual({ pushed: 0, conflicted: 0, revived: 1 });
  });

  it('收件箱那半也数进 revived：两类相加，不是只数任务那半', async () => {
    await localTasks.write([]);
    await localInbox.write([]);
    await dirtyTasks.mark([['a', null]]);
    await dirtyInbox.mark([['b', null]]);
    vi.spyOn(api, 'pushBack').mockResolvedValue({ tasks: bucket([], ['a']), inbox: bucket([], ['b']) });

    expect(await pushBackIfDirty()).toEqual({ pushed: 0, conflicted: 0, revived: 2 });
  });
});

/**
 * 这一组**不 mock `api.ts`**（144：测试替身的位置要切在被测特性那条链之外）——
 * 组装 → `route()` → `fetch` → 回执 → 清记号真的整条走一遍。上面那些用例把
 * `api.pushBack` 换成了替身，证明不了「这一层跟真的 `api.pushBack` 接得上」。
 */
describe('接到真的 api.pushBack 上（不打替身）', () => {
  it('在线：真的发一次 POST /api/push，请求体是组装出来的条目，回执回来清记号', async () => {
    setOnlineForTest(true);
    await localTasks.write([task({ id: 't1', title: '手机改的' })]);
    await dirtyTasks.mark([['t1', task({ id: 't1', title: '原文' })]]);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okResponse(['t1'], [], [])), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await pushBackIfDirty()).toEqual({ pushed: 1, conflicted: 0, revived: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/push');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      tasks: [{ id: 't1', op: 'upsert', base: task({ id: 't1', title: '原文' }), value: task({ id: 't1', title: '手机改的' }) }],
      inbox: [],
    });
    expect(await dirtyTasks.ids()).toEqual(new Set());
  });

  it('服务端 500：错误原样抛出来，记号一个都不清', async () => {
    setOnlineForTest(true);
    await localTasks.write([task({ id: 't1' })]);
    await dirtyTasks.mark([['t1', null]]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '写盘失败' }), { status: 500 })));

    await expect(pushBackIfDirty()).rejects.toThrow('写盘失败');

    expect(await dirtyTasks.ids()).toEqual(new Set(['t1']));
  });

  it('离线：明确报错不装作推成功，一次 fetch 都不发，记号一个都不清', async () => {
    setOnlineForTest(false);
    await localTasks.write([task({ id: 't1' })]);
    await dirtyTasks.mark([['t1', null]]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(pushBackIfDirty()).rejects.toThrow('离线时无法把离线改动推回桌面，连接服务器之后再试');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1']));
  });
});
