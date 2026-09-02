import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 这个文件跑在 vitest 的 node 档（见根 vitest.config.ts：`*.test.ts` 归
 * node，`*.test.tsx` 才归 jsdom）——node 没有 `window`，`@capacitor/preferences`
 * 的 web 回退直接读 `window.localStorage` 会炸，见 apiBase.test.ts 顶部
 * 同一条注释。这里同样把整个包 mock 掉，用一个 `Map` 当假的持久化后端。
 */
const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.has(key) ? store.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
  },
}));

import { dirtyInbox, dirtyTasks, localInbox, localTasks, localTrash, onLocalWrite } from './localStore.js';
import type { Task } from '../types.js';

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '交房租', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...p,
});

beforeEach(() => {
  store.clear();
});

describe('localTasks / localInbox / localTrash：空表兜底', () => {
  it('从没写过时，读到的是空数组，不是 undefined 或抛错', async () => {
    expect(await localTasks.read()).toEqual([]);
    expect(await localInbox.read()).toEqual([]);
    expect(await localTrash.read()).toEqual([]);
  });

  // 修复轮 2 m10（复审指出）：这两条原来直接硬编码 'local:tasks' 这个字符串
  // 去污染 store——localStore.ts 的 KEY.tasks 是私有常量，不导出，这里的
  // 字符串是跟它各写各的一份「同一个字面量」。真把 KEY.tasks 改个名字，
  // localTasks.write/.read() 会一起改去用新 key，而这两条测试还在往旧的
  // 'local:tasks' 里塞坏数据——那个位置从此再也没人读，localTasks.read()
  // 找不到值直接落回「没写过」的空数组分支，跟「JSON.parse 失败被 catch
  // 住」是完全不同的两条代码路径，但断言看起来一样通过，是一条空转的假绿。
  // 改法：先经真实的 write() 路径写一次，从 store 里现读出这次真正用的是
  // 哪个 key，再照着这个 key 去写坏数据——不管 KEY.tasks 叫什么，这里永远
  // 打在对的位置上。
  it('存的值不是合法 JSON 时，读到空数组而不是抛错——不该让整个离线层因为一条坏数据炸掉', async () => {
    await localTasks.write([]);
    const [key] = store.keys();
    store.set(key!, '不是 JSON');
    expect(await localTasks.read()).toEqual([]);
  });

  it('存的值是合法 JSON 但不是数组时，读到空数组', async () => {
    await localTasks.write([]);
    const [key] = store.keys();
    store.set(key!, JSON.stringify({ oops: true }));
    expect(await localTasks.read()).toEqual([]);
  });
});

describe('localTasks：写完读回来', () => {
  it('write 之后 read 拿到原样的数组', async () => {
    const t = task();
    await localTasks.write([t]);
    expect(await localTasks.read()).toEqual([t]);
  });

  it('tasks/inbox/trash 三个各用各的 key，互不干扰', async () => {
    await localTasks.write([task({ id: 'a' })]);
    await localInbox.write([{ id: 'b', text: 'x', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }]);
    await localTrash.write([{ ...task({ id: 'c' }), deletedAt: '2026-08-01T00:00:00.000Z' }]);

    expect((await localTasks.read()).map((t) => t.id)).toEqual(['a']);
    expect((await localInbox.read()).map((x) => x.id)).toEqual(['b']);
    expect((await localTrash.read()).map((x) => x.id)).toEqual(['c']);
  });
});

describe('dirtyTasks / dirtyInbox：「还没同步」的记号', () => {
  it('没标记过时，ids() 是空集合', async () => {
    expect(await dirtyTasks.ids()).toEqual(new Set());
    expect(await dirtyInbox.ids()).toEqual(new Set());
  });

  it('mark 之后 ids() 里能读到——这就是「还没同步」的全部内容，不是一个新类型', async () => {
    await dirtyTasks.mark([['t1', null], ['t2', null]]);
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1', 't2']));
  });

  it('mark 是并集：分两次标记，两次的 id 都在，不会互相覆盖', async () => {
    await dirtyTasks.mark([['t1', null]]);
    await dirtyTasks.mark([['t2', null]]);
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1', 't2']));
  });

  it('重复 mark 同一个 id 不会重复——集合语义', async () => {
    await dirtyTasks.mark([['t1', null]]);
    await dirtyTasks.mark([['t1', null]]);
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1']));
  });

  it('dirtyTasks 和 dirtyInbox 各用各的 key，互不干扰', async () => {
    await dirtyTasks.mark([['t1', null]]);
    await dirtyInbox.mark([['i1', null]]);
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1']));
    expect(await dirtyInbox.ids()).toEqual(new Set(['i1']));
  });

  it('mark 记下基准：id → 本地改它之前那份', async () => {
    await dirtyTasks.mark([['t1', task({ title: '服务端那份' })]]);
    expect((await dirtyTasks.all()).t1).toEqual(task({ title: '服务端那份' }));
  });

  it('离线新建的没有基准：值是 null，但键真的在（跟「没打过记号」分得开）', async () => {
    await dirtyTasks.mark([['t9', null]]);
    const all = await dirtyTasks.all();
    expect('t9' in all).toBe(true);
    expect(all.t9).toBeNull();
  });

  it('连着离线改两次：基准还是第一次改之前那份，不被第二次覆盖', async () => {
    await dirtyTasks.mark([['t1', task({ title: '服务端那份' })]]);
    await dirtyTasks.mark([['t1', task({ title: '第一次改完的' })]]);
    expect((await dirtyTasks.all()).t1!.title).toBe('服务端那份');
  });

  it('setBase 覆盖已有记号的基准——跟 mark 刻意相反，不是其中一个写错了', async () => {
    // mark 记的是「本地改它之前服务端那份」，所以后到的不许覆盖（上一条）；setBase
    // 记的是另一件事：记号还留着，可服务端那份被这次推送改掉了，基准必须跟着换。
    await dirtyTasks.mark([['t1', task({ title: '服务端原来那份' })]]);
    await dirtyTasks.setBase([['t1', task({ title: '刚推上去那份' })]]);
    expect((await dirtyTasks.all()).t1!.title).toBe('刚推上去那份');
    expect(await dirtyTasks.ids()).toEqual(new Set(['t1']));
  });

  it('setBase 不给没打过记号的 id 新建记号，也不为此凭空写一次盘', async () => {
    // 不在表里说明它已经结清了。凭空建一个记号会让一条已经推回去的东西下次再推一遍。
    await dirtyInbox.mark([['i1', null]]);
    await dirtyTasks.setBase([['t404', task()]]);
    expect(await dirtyTasks.ids()).toEqual(new Set());
    expect(await dirtyInbox.ids()).toEqual(new Set(['i1']));
    expect(store.has('local:dirtyTaskIds')).toBe(false);
  });

  it('unmark 清掉指定的记号，别的不动', async () => {
    await dirtyTasks.mark([['t1', null], ['t2', task()]]);
    await dirtyTasks.unmark(['t1']);
    expect(await dirtyTasks.ids()).toEqual(new Set(['t2']));
  });

  // 上面那条走的是「要清的 id 真的在」，这条走的是**另一条分支**（一个都没命中，
  // 直接返回、连盘都不写）。推送流程每一轮回执都会调一次 unmark，「这一轮什么都
  // 没结清」是常态，那一轮不该凭空往存储里写一次。`store.has` 是唯一看得见这件事
  // 的地方——内容比对看不出来（写回去的字节跟原来一模一样）。
  it('unmark 一个没打过记号的 id：别的记号不动，也不为此凭空写一次盘', async () => {
    await dirtyInbox.mark([['i1', null]]);
    await dirtyTasks.unmark(['t404']);
    expect(await dirtyInbox.ids()).toEqual(new Set(['i1']));
    expect(store.has('local:dirtyTaskIds')).toBe(false);
  });

  it('unmark 不触发 onLocalWrite——清记号不改任何用户看得见的数据', async () => {
    await dirtyTasks.mark([['t1', null]]);
    const seen = vi.fn();
    const off = onLocalWrite(seen);
    try {
      await dirtyTasks.unmark(['t1']);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('旧格式（一个光秃秃的 id 数组）读得出来，迁成「有记号、没有基准」，不抛', async () => {
    store.set('local:dirtyTaskIds', JSON.stringify(['a', 'b']));
    expect(await dirtyTasks.all()).toEqual({ a: null, b: null });
    expect(await dirtyTasks.ids()).toEqual(new Set(['a', 'b']));
  });

  // readDirty 的两条坏数据分支。跟 readArr 那两条（本文件最上面）形状一样但**不是
  // 同一段代码**——脏集读的是对象不是数组，走的是自己的一份 JSON.parse + 类型判断。
  //
  // 「当空」这个选择在这里**比在 readArr 里贵得多**：丢掉的不是一份重新联网就能拉
  // 回来的缓存，而是「这几条本地改过、还没推回去」这个事实——记号没了，那些改动
  // 此后**永远推不回服务端**。所以这两条测试各断言两件事：读到的是空表（不抛），
  // **以及真的叫了一声 console.error**。第二个断言才是重点：假绿总账 139/145 那个
  // 形状就是「把失败路径悄悄填成成功路径」，这里差一点又栽同一个坑——先前这段注释
  // 写的理由「抛了整个离线层连读都读不了」是**错的**（复审核出来的）：localTasks/
  // localInbox/localTrash 走 readArr、另一批 key，readDirty 抛不到它们头上。真正
  // 不能抛的理由是 backfillTasks/backfillInbox 每次在线读成功都调 ids()，抛会把
  // 在线主路径一起拖下水。理由换了，选择不变，但代价必须留个信号。
  it('脏集存的值不是合法 JSON 时：读到空表不抛，但要叫一声 console.error——记号丢了不能悄没声', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      store.set('local:dirtyTaskIds', '不是 JSON');
      expect(await dirtyTasks.all()).toEqual({});
      expect(await dirtyTasks.ids()).toEqual(new Set());
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0]![0])).toContain('local:dirtyTaskIds');
    } finally {
      err.mockRestore();
    }
  });

  it('脏集存的值是合法 JSON 但既不是数组也不是对象时：同样读到空表 + 同样叫一声', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      store.set('local:dirtyTaskIds', JSON.stringify(42));
      expect(await dirtyTasks.all()).toEqual({});
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  // 反面：**好数据一声都不许叫**。没有这条，上面两条的 `toHaveBeenCalled()` 在
  // 「readDirty 无脑每次都 console.error」的实现下也是绿的（141 那个形状：断言只
  // 认「叫过」，不认「只在该叫的时候叫」）。
  it('正常读写一声都不叫 console.error——空表、新格式、旧格式迁移都不算坏数据', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await dirtyTasks.ids();                       // 从没写过
      await dirtyTasks.mark([['t1', task()]]);      // 新格式写读
      await dirtyTasks.all();
      store.set('local:dirtyInboxIds', JSON.stringify(['a', 'b'])); // 旧格式迁移
      await dirtyInbox.all();
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

/**
 * 整分支审查 C1：离线时没有 watcher → SSE 这条链，本地写完得自己叫一声，
 * 不然「数据落盘了、界面纹丝不动」。界面那一端由 `web/src/OfflineWrite.test.tsx`
 * 端到端守着（那个文件不 mock `./api.js`），这里守的是这个机制自己的三条
 * 性质，尤其**最后一条**——它是「`reload()` 读一次又触发一次 `reload()`」
 * 这种打转的唯一屏障。
 */
describe('onLocalWrite：本地写完叫一声（离线时替代 watcher → SSE）', () => {
  it('打记号（也就是发生了一次离线写入）之后，订阅方被叫到', async () => {
    const seen = vi.fn();
    const off = onLocalWrite(seen);
    try {
      await dirtyTasks.mark([['t1', null]]);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('退订之后不再被叫——App 卸载时要能干净摘掉', async () => {
    const seen = vi.fn();
    onLocalWrite(seen)();
    await dirtyInbox.mark([['i1', null]]);
    expect(seen).not.toHaveBeenCalled();
  });

  it('只读不叫：read()/ids()/all() 都不触发——不然 reload() 一读就再叫一次 reload()，打转', async () => {
    const seen = vi.fn();
    const off = onLocalWrite(seen);
    try {
      await localTasks.read();
      await localInbox.read();
      await dirtyTasks.ids();
      await dirtyTasks.all();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});
