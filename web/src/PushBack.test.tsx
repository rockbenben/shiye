import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { btnIn, deleteCard, NoMotion } from './test-utils.js';

/**
 * **「手机改动 → HTTP → 桌面文件」这条链真的走一遍**——这一批唯一一道端到端。
 *
 * 为什么这个文件必须存在：**144**（已归档的 `docs/superpowers/specs/2026-08-15-parked-all.md`
 * 第十九节）。上一批 2026 条测试全绿、四轮任务审查全过，而招牌功能在真机上根本
 * 不工作——根因是 `App.test.tsx` 顶部把 `./api.js` **整个 mock 掉**：mock 上游有
 * 「离线横幅会出现」的测试（真的、绿的），下游有「写进本地存储」的测试（真的、
 * 绿的），**而被测的那条链整个跑在 mock 的那一刀上，从来没有一个用例穿过去过**。
 *
 * 这一批的「推回去」是一条更长的同类链：
 * `App.tsx` → `api.ts` → `route()` → `pushBack.ts`（组装/清记号）→ HTTP →
 * `POST /api/push` → `decidePush` → `entityStore` 落盘。
 * **一层替身都不许切在这条链上。** 换掉的只有两样外部世界，两样都在被测特性的
 * **下游**：
 * - `@capacitor/preferences` → 一个 `Map`（手机的持久化后端，`localStore.ts` 底下）；
 * - `globalThis.fetch` → 转发给真的 `createApp()`（网络传输）。
 *
 * 于是断言的两头都是**真东西**：一头是**服务端临时 `DATA_DIR` 里真的文件**
 * （`readTasks()`/`readInbox()`/`readTrash()`/`listConflicts()` 都是直接读盘的），
 * 一头是**屏幕上真的看得见的东西**（toast / 冲突横幅 / 看板上那张卡）。
 * 「`api.pushBack` 被调用过一次」这种断言这个文件里一条都没有——144 那次的
 * 请求本来就发出去了，坏的正是后面那一段。
 *
 * `data/` 一个字节都不碰：`DATA_DIR` 指到 `mkdtempSync` 出来的临时目录，
 * `afterEach` 删掉。
 */

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.has(key) ? store.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
  },
}));

import { App } from './App.js';
import { apiBaseReady, setApiBase } from './lib/apiBase.js';
import { resetOnlineCache } from './lib/dataSource.js';
import { dirtyInbox, dirtyTasks, localInbox, localTasks } from './lib/localStore.js';
import { resetPushInflightForTest } from './lib/pushBack.js';
import { createApp } from '../../server/src/app.js';
import { invalidateAll, listConflicts } from '../../server/src/entityStore.js';
import {
  ensureDataFiles, newTask, paths, readInbox, readTasks, readTrash, writeInbox, writeTasks,
  type InboxItem,
} from '../../server/src/store.js';

const BASE = 'http://desktop.test';

let dir: string;
let server: ReturnType<typeof createApp>;
/** 桌面服务这会儿够不够得着——飞行模式把它翻成 false，所有请求当场连不上。 */
let reachable = true;

beforeEach(async () => {
  store.clear();
  // **防御性的，代价为零——不是在防一个真发生过的崩溃。** 复审删掉这一行连跑
  // 4 遍全绿，结构上也够不着：`apiBase.ts` 模块求值时那句 `void ensureLoaded()`
  // 读的是上面那个立即 resolve 的 mock，微任务在模块图求值到这里之间必然排空过。
  // 留着只因为它幂等、瞬时；真要是哪天那趟读不再立即完成，`cache` 被冲回空串会
  // 让 `new Request('/api/health')` 直接抛（相对地址造不出 Request），那种红一眼
  // 看不出跟 base 有关。
  await apiBaseReady();
  setApiBase(BASE);
  resetOnlineCache();
  resetPushInflightForTest();

  dir = mkdtempSync(join(tmpdir(), 'todo-push-'));
  process.env.DATA_DIR = dir;
  // 设置存在设备本地，不指到临时目录的话会落到这台机器真实的
  // %APPDATA%\shiye\device.json（跟 app.test.ts 同一个理由）。
  process.env.DEVICE_CONFIG = join(dir, 'device.json');
  // 上一条测试的临时目录还留在 entityStore 的内存索引里，不许漏过来。
  invalidateAll();
  ensureDataFiles();
  server = createApp();
  reachable = true;

  // **唯一被换掉的是传输层。** 请求真的进 Hono、真的落到临时 DATA_DIR 的文件里，
  // 中间那段（api.ts → route() → pushBack.ts → 路由 → decidePush → entityStore）
  // 一层都没被替身切开——144 那条教训要的就是这个。
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (reachable
    ? server.request(new Request(typeof input === 'string' ? input : String(input), init))
    : Promise.reject(new Error('connection refused')))));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiBase('');
  resetOnlineCache();
  resetPushInflightForTest();
  delete process.env.DATA_DIR;
  delete process.env.DEVICE_CONFIG;
  rmSync(dir, { recursive: true, force: true });
  window.location.hash = '';
  localStorage.removeItem('density');
});

const mount = () => render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

const navButton = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: '视图' })).getByRole('button', { name });

const sourcePanel = () => document.querySelector('.ink-view-panel-source') as HTMLElement;
const inboxPanel = () => document.querySelector('.ink-view-panel-inbox') as HTMLElement;

const conflictCopies = () => listConflicts(paths().tasks);

const note = (p: Partial<InboxItem> = {}): InboxItem =>
  ({ id: 'i1', text: '买菜', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...p });

/**
 * **飞行模式下挂载**：所有请求连不上，`isOnline()` 判 false，每个写操作都走
 * `localApi` → `localStore` → 打脏记号。返回的函数把网线插回去（下一拍 60 秒
 * 心跳会探到在线、把脏集推回桌面）——「离线改 → 回到在线」这半程也是真的走的，
 * 不是手搓一份脏集。
 *
 * 心跳那一拍直接抠 `setInterval` 的回调来叫：这个环境里 `EventSource` 是个空壳
 * （`test-setup.ts`），`onOpen` 永远不响，跟 `OfflineWrite.test.tsx`/`App.test.tsx`
 * 是同一个套路。
 */
const mountOffline = async (): Promise<() => void> => {
  reachable = false;
  resetOnlineCache();
  const intervalSpy = vi.spyOn(window, 'setInterval');
  mount();
  await screen.findByRole('status', { name: '离线' });
  const heartbeat = intervalSpy.mock.calls.find((c) => c[1] === 60_000)![0] as () => void;
  return () => {
    reachable = true;
    resetOnlineCache();
    act(() => { heartbeat(); });
  };
};

describe('离线改的东西回到局域网真的推得回去（不 mock 中间层）', () => {
  it('离线改过的标题：服务端文件里真的变成手机那份，界面上报了数，脏集清空', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([t]);
    // 手机上那份被改过，脏集里记的是「改之前服务端长什么样」。
    await localTasks.write([{ ...t, title: '手机改的' }]);
    await dirtyTasks.mark([[t.id, t]]);

    mount();

    // 磁盘：`data/tasks/<id>.json` 真的被这次推送改写了。
    await waitFor(() => expect(readTasks().map((x) => x.title)).toEqual(['手机改的']));
    // 屏幕：报了数。
    expect(await screen.findByText(/已把 1 条离线改动推回桌面/)).toBeTruthy();
    // 下次不会重推。
    expect(await dirtyTasks.ids()).toEqual(new Set());
    // 屏幕：看板上那张卡也是新标题。**这一句分不出它来自服务端还是本地**——
    // 本地那份也叫「手机改的」，两边这会儿长得一样。这一格承重的是上面那条磁盘
    // 断言（M4a 挖掉 `writeTasks` 时红的正是它）；「推完那次 reload 拉回来的是
    // 服务端那份」由第 4、5 格的「桌面另一条」钉着，那两格服务端独有一条手机上
    // 没有的，冒出来才说明这一屏真的刷新过。
    fireEvent.click(navButton(/按来源/));
    await waitFor(() => expect(within(sourcePanel()).getByText('手机改的')).toBeTruthy());
  });

  it('撞车：服务端保留桌面那份，手机那份变成冲突副本文件，顶上那条横幅出得来', async () => {
    const t = newTask({ title: '原文' });
    // 桌面在这段时间里也改过同一条——三方比较的第三方。
    writeTasks([{ ...t, title: '桌面改的' }]);
    await localTasks.write([{ ...t, title: '手机改的' }]);
    await dirtyTasks.mark([[t.id, t]]);

    mount();

    // 屏幕：常驻横幅（数字来自 `GET /api/conflicts`，也就是真的扫了 `paths()` 那几个目录）。
    const banner = await screen.findByRole('alert', { name: '同步冲突' });
    expect(banner.textContent).toContain('同步冲突：1 个文件');
    expect(await screen.findByText(/1 条撞车、已另存成冲突副本/)).toBeTruthy();

    // 磁盘：正本一个字节没动，手机那份躺在副本文件里。
    expect(readTasks().map((x) => x.title)).toEqual(['桌面改的']);
    expect(conflictCopies()).toHaveLength(1);
    const copy = JSON.parse(readFileSync(join(paths().tasks, conflictCopies()[0]), 'utf8')) as { id: string; title: string };
    expect(copy).toMatchObject({ id: t.id, title: '手机改的' });
    expect(await dirtyTasks.ids()).toEqual(new Set());
  });

  it('回执半路丢了、同一条再推一次：副本还是一份（名字按内容算哈希），不是两份', async () => {
    const t = newTask({ title: '原文' });
    writeTasks([{ ...t, title: '桌面改的' }]);
    await localTasks.write([{ ...t, title: '手机改的' }]);
    await dirtyTasks.mark([[t.id, t]]);

    const first = mount();
    await screen.findByRole('alert', { name: '同步冲突' });
    await waitFor(async () => expect(await dirtyTasks.ids()).toEqual(new Set()));
    expect(conflictCopies()).toHaveLength(1);
    first.unmount();

    // 「回执没收到」的样子：记号原样还在，下次重连原样再推一遍。这正是当初选
    // 内容哈希、不选时间戳要防的那个场景（entityStore.writeConflictCopy）。
    await dirtyTasks.mark([[t.id, t]]);
    resetPushInflightForTest();
    mount();

    // 脏集重新被清空 = 第二次推送真的发生过（不是「什么都没做所以数字没变」）。
    await waitFor(async () => expect(await dirtyTasks.ids()).toEqual(new Set()));
    expect(conflictCopies()).toHaveLength(1);
    expect(readTasks().map((x) => x.title)).toEqual(['桌面改的']);
  });

  it('离线删掉的任务：服务端真的删了（进垃圾箱），收件箱里指向它的 taskIds 也清了', async () => {
    const gone = newTask({ title: '交房租' });
    // 服务端另有一条手机上没有的——推完那次 reload 之后它会出现在屏幕上，
    // 用来证明这一屏真的是刷新过的服务端数据；被删那条没跟着回来才有意义。
    const kept = newTask({ title: '桌面另一条' });
    writeTasks([gone, kept]);
    writeInbox([note({ text: '房租那条', processed: true, taskIds: [gone.id] })]);
    await localTasks.write([gone]);

    const backOnline = await mountOffline();
    fireEvent.click(navButton(/按来源/));
    await waitFor(() => expect(within(sourcePanel()).getByText('交房租')).toBeTruthy());
    // 真的走一次离线删除（经 guard 的写入点）：localApi.deleteTask → 软删除进
    // 本地垃圾箱 → 打脏记号（基准是删之前那份）。
    await deleteCard({ scope: sourcePanel() });
    await waitFor(() => expect(within(sourcePanel()).queryByText('交房租')).toBeNull());

    backOnline();

    // 磁盘：tasks 里没了、trash 里有、收件箱那条死链接清干净了。
    await waitFor(() => expect(readTasks().map((x) => x.title)).toEqual(['桌面另一条']));
    expect(readTrash().map((x) => x.title)).toEqual(['交房租']);
    expect(readInbox()[0].taskIds).toEqual([]);
    expect(await dirtyTasks.ids()).toEqual(new Set());
    // 屏幕：服务端那条冒出来了（这一屏是刷新过的），删掉的那条没有跟着回来。
    await waitFor(() => expect(within(sourcePanel()).getByText('桌面另一条')).toBeTruthy());
    expect(within(sourcePanel()).queryByText('交房租')).toBeNull();
  });

  it('离线删掉的收件箱条目：服务端的收件箱里真的没了（Task 7 复审 M1 那一格）', async () => {
    const gone = note({ id: 'i1', text: '买菜' });
    const kept = note({ id: 'i2', text: '桌面另一条' });
    writeInbox([gone, kept]);
    await localInbox.write([gone]);

    const backOnline = await mountOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('买菜')).toBeTruthy());
    // btnIn 而不是 getByRole：antd 会往「恰好两个汉字、没有图标」的按钮里插一个
    // 空格（应用本体在 main.tsx 关掉了，测试不经那层 ConfigProvider）。
    fireEvent.click(btnIn(inboxPanel(), '删除'));
    const confirm = await waitFor(() => {
      const box = document.querySelector<HTMLElement>('.ant-popover');
      if (!box) throw new Error('确认气泡还没出现');
      return box;
    });
    fireEvent.click(btnIn(confirm, '删除'));
    await waitFor(() => expect(within(inboxPanel()).queryByText('买菜')).toBeNull());

    backOnline();

    await waitFor(() => expect(readInbox().map((x) => x.text)).toEqual(['桌面另一条']));
    expect(await dirtyInbox.ids()).toEqual(new Set());
    await waitFor(() => expect(within(inboxPanel()).getByText('桌面另一条')).toBeTruthy());
    expect(within(inboxPanel()).queryByText('买菜')).toBeNull();
  });

  it('推不回去（服务端 500）：脏集原样留着，屏幕上说得出这件事', async () => {
    const t = newTask({ title: '原文' });
    await localTasks.write([{ ...t, title: '手机改的' }]);
    await dirtyTasks.mark([[t.id, t]]);
    // **真的把服务端弄坏**，不是把 fetch 拦下来编一个 500 出来：任务那张表的
    // 目录位置摆一个文件，`readAll` 的 `readdirSync` 撞上 ENOTDIR → app.onError
    // → 500。整条路由一个文件都没写成。
    rmSync(paths().tasks, { recursive: true, force: true });
    writeFileSync(paths().tasks, '这不是一个目录', 'utf8');

    mount();

    const toast = await screen.findByText(/把离线改动推回桌面时出错/);
    // **这一句才钉得住「红的是服务端回的 500」**：上面那个前缀对任何异常都成立
    // （离线时的 `OfflineUnsupportedError` 走的是同一句文案），光凭它这一格换成
    // 「压根没连上」也照样绿。`ENOTDIR` 是服务端 `app.onError` 把真实的文件系统
    // 错误原样吐回来才有的东西，客户端这一侧编不出来。
    expect(toast.textContent).toContain('ENOTDIR');
    // 记号一个都没清——下次连上原样再推一遍。
    expect(await dirtyTasks.ids()).toEqual(new Set([t.id]));
    // 上限断言：没有任何一条在说「推成功了」。
    expect(screen.queryByText(/已把 \d+ 条离线改动推回桌面/)).toBeNull();
  });

  it('离线完成一条重复任务：服务端恰好两条（完成的那条 + 下一条实例），不是三条也不是一条加一份副本', async () => {
    // 时钟钉死，只 fake `Date`（整套 fake timers 会饿死 waitFor 的轮询，这个
    // 仓库踩过）。`due` 用本地墙钟构造，不是 UTC 字面量。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 21, 9, 0, 0));
    const t = newTask({
      title: '交房租',
      // `doing` 而不是 `todo`：卡片上那颗按钮的文案跟着状态走（`TaskCard`
      // 的 `NEXT`——待办给的是「开始」/「搁置」，只有进行中才给「完成」）。
      status: 'doing',
      due: new Date(2026, 7, 21, 20, 0, 0).toISOString(),
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
    });
    writeTasks([t]);
    await localTasks.write([t]);

    const backOnline = await mountOffline();
    fireEvent.click(navButton(/按来源/));
    await waitFor(() => expect(within(sourcePanel()).getByText('交房租')).toBeTruthy());
    // 离线点「完成」：`localApi.patchTask` 用跟服务端同一份 `mutate.ts` 生成
    // 下一条实例，两条都进脏集（改的那条带基准、生出来的那条没有基准）。
    fireEvent.click(btnIn(sourcePanel(), '完成'));
    await waitFor(async () => expect(await localTasks.read()).toHaveLength(2));

    backOnline();

    await waitFor(() => expect(readTasks()).toHaveLength(2));
    const rows = readTasks();
    expect(rows.map((x) => x.title)).toEqual(['交房租', '交房租']);
    expect(rows.filter((x) => x.status === 'done')).toHaveLength(1);
    expect(rows.filter((x) => x.status === 'todo')).toHaveLength(1);
    // 上限断言：路由那道重复任务查重没把手机生出来的这条误判成「同款」——
    // 判太紧的症状正是「服务端只有一条 + 一份没人要的副本」。
    expect(conflictCopies()).toEqual([]);
    expect(await dirtyTasks.ids()).toEqual(new Set());
    expect(await screen.findByText(/已把 2 条离线改动推回桌面/)).toBeTruthy();
  });
});
