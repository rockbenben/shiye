import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { btnIn, NoMotion } from './test-utils.js';

/**
 * **离线写入之后界面真的会更新**——整分支审查 C1 的守卫。
 *
 * 为什么不写进 `App.test.tsx`：那个文件顶部 `vi.mock('./api.js', ...)` 把整个
 * `api` 换成了一组 `vi.fn()`，离线那几组测试只 stub 探测用的 `fetch`，**永远
 * 走不到 `api.ts` → `route()` → `localApi` → `localStore` 这条真链**。C1 那个
 * bug 恰好长在这条链的终点（数据落盘了，但没有任何东西把界面叫起来重画），
 * 在那个文件里再怎么加断言都够不着——`vi.mock` 是文件级的，只能另起一个文件。
 *
 * 所以这个文件**不 mock `./api.js`**：`App` 用的是真的 `api`，真的 `route()`，
 * 真的 `localApi`，真的 `dirtyTasks/dirtyInbox.mark`。唯一被换掉的是**存储
 * 后端**（`@capacitor/preferences` → 一个 `Map`，跟 `localStore.test.ts`/
 * `dataSource.test.ts` 同一份写法）和**网络**（`fetch` 桩，让
 * `isOnline()` 判定「连不上」）——这两样本来就是这个测试要模拟的外部世界，
 * 不是被测的那条链。
 *
 * 断言的都是**屏幕上看得见的东西**（`android/冒烟清单.md` 第 7 步逐字承诺的
 * 「界面上立刻看得到改动」），不是 `api.*` 被调用过几次：调用次数证明的是
 * 「请求发出去了」，而 C1 里请求本来就发出去了、数据也真的落盘了，坏的正是
 * 后面那一段。
 */

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.has(key) ? store.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
  },
}));

/**
 * 唯一的另一个替身：插件那一侧的入口（本地通知那一批）。它下游全是 jsdom 里
 * 根本不存在的东西（原生桥、AlarmManager），跟上面的 `Preferences`/`fetch`
 * 一样属于「要模拟的外部世界」，不是被测的那条链——被测的那条链是
 * **离线写入 → `onLocalWrite` → `reload()` → `tasks` → 重排**，替身切在它的
 * 下游终点，整条链一寸没被切掉（144）。
 * 默认值跟真实现在 jsdom 里的返回值一致（不是原生壳），这个文件另外几条测试
 * 的前提一个字没变。
 */
vi.mock('./lib/notifyNative.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/notifyNative.js')>()),
  rescheduleLocalNotifications: vi.fn(async () => 'not-native' as const),
}));

/**
 * 第三个、也是最后一个替身：**Capacitor 那个自写分享插件**（share-target 那一批）。
 * 跟上面两个同一条理由——它下游是 Android 的 intent 和原生桥，jsdom 里根本不存在，
 * 属于「要模拟的外部世界」。
 *
 * 被测的那条链是 **原生事件 → `shareToInboxText`（判断）→ `subscribeShare`（编排）
 * → `App.tsx` 的 effect（接线）→ `api.addInbox` → `route()` → `localApi` →
 * `localStore` → `onLocalWrite` → `reload()` → 界面**，替身切在它的**上游第一环**，
 * 中间一寸没被切掉（144）。`App.test.tsx` 里那一族只验得到「`addInbox` 被喂了
 * 什么」为止（那个文件把 `./api.js` 整个换成了 `vi.fn()`），**「收件箱里真的多了
 * 一条」只有在这个文件里才验得出来**——上一批正是栽在这个形状上。
 *
 * `available` 直接钉 `true`：这个文件模拟的就是那台安卓手机。真实现在 jsdom 里
 * 恒 `false`（`isPluginAvailable` 那条判据，有专测在 `lib/shareNative.test.ts`），
 * 不钉的话这条链的第一环压根不会接上。
 */
let emitShared: ((p: SharePayload) => void) | null = null;
vi.mock('./lib/shareNative.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/shareNative.js')>()),
  nativeSharePort: {
    available: () => true,
    onShared: (cb: (p: SharePayload) => void) => { emitShared = cb; return () => {}; },
  },
}));

import { App } from './App.js';
import { setApiBase } from './lib/apiBase.js';
import { rescheduleLocalNotifications } from './lib/notifyNative.js';
import { resetOnlineCache } from './lib/dataSource.js';
import { localInbox, localTasks } from './lib/localStore.js';
import { ACTION_SEND, type SharePayload } from './lib/sharePlan.js';
import type { InboxItem, Task } from './types.js';

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

beforeEach(() => {
  store.clear();
  vi.mocked(rescheduleLocalNotifications).mockClear();
  emitShared = null;
  resetOnlineCache();
  // 配过服务地址——这里模拟的是「配过、但这会儿连不上」，也就是飞行模式下
  // 的那台手机。**「从没配过地址」那台**（base 是空串）在文件最下面单独一组，
  // 它自己把 base 清回空串。
  setApiBase('http://192.168.1.5:30035');
  // 连不上：`isOnline()` 判 false，`api.ts` 的每个方法都路由到 `localApi`。
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = '';
  setApiBase('');
  resetOnlineCache();
  localStorage.removeItem('density');
});

/** 渲染并等到离线记号真的出现——之后发生的写入才确定走的是离线那条分支。 */
const renderOffline = async () => {
  const r = render(<NoMotion><AntApp><App /></AntApp></NoMotion>);
  await screen.findByRole('status', { name: '离线' });
  return r;
};

const navButton = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: '视图' })).getByRole('button', { name });

const inboxPanel = () => document.querySelector('.ink-view-panel-inbox') as HTMLElement;

describe('离线写入之后界面立刻更新（不 mock api.js，真穿 route → localStore → 界面）', () => {
  it('随手记：Ctrl+Enter 存下之后，这条立刻出现在收件箱列表里——不用等重连、不用手动刷新', async () => {
    await renderOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('没有待拆解的')).toBeTruthy());

    // 随手记框在侧栏里，任何视图下都在（App.tsx 的 focusQuickCapture 用的是
    // 同一个选择器）。@testing-library/user-event 没装，用 fireEvent。
    const box = document.querySelector('.ink-nav-composer textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '买酱油' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    expect(await within(inboxPanel()).findByText('买酱油')).toBeTruthy();
  });

  it('改收件箱里那条的文字（不经 guard 的写入点）：保存之后列表上就是新文字', async () => {
    await localInbox.write([inboxItem({ text: '买菜' })]);
    await renderOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('买菜')).toBeTruthy());

    fireEvent.click(within(inboxPanel()).getByRole('button', { name: /编辑/ }));
    const box = within(inboxPanel()).getByRole('textbox');
    fireEvent.change(box, { target: { value: '买菜和酱油' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    expect(await within(inboxPanel()).findByText('买菜和酱油')).toBeTruthy();
    expect(within(inboxPanel()).queryByText('买菜')).toBeNull();
  });

  it('删掉收件箱里那条（经 guard 的写入点）：确认之后这一行从列表上消失', async () => {
    await localInbox.write([inboxItem({ text: '买菜' })]);
    await renderOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('买菜')).toBeTruthy());

    // btnIn 而不是 getByRole：antd 会往「恰好两个汉字、没有图标」的按钮里插
    // 一个空格（应用本体在 main.tsx 关掉了这个行为，测试不经那层
    // ConfigProvider），见 test-utils.tsx 里 btnIn 的注释。
    fireEvent.click(btnIn(inboxPanel(), '删除'));
    const confirm = await waitFor(() => {
      const box = document.querySelector<HTMLElement>('.ant-popover');
      if (!box) throw new Error('确认气泡还没出现');
      return box;
    });
    fireEvent.click(btnIn(confirm, '删除'));

    await waitFor(() => expect(within(inboxPanel()).queryByText('买菜')).toBeNull());
  });

  it('点任务卡上的「完成」：状态角标当场从「进行中」变成「已完成」——冒烟清单第 7 步那句话', async () => {
    await localTasks.write([task({ status: 'doing', title: '写周报' })]);
    await renderOffline();
    fireEvent.click(navButton(/按来源/));
    const panel = () => document.querySelector('.ink-view-panel-source') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('写周报')).toBeTruthy());
    expect(within(panel()).getByText('进行中')).toBeTruthy();

    fireEvent.click(btnIn(panel(), '完成'));

    expect(await within(panel()).findByText('已完成')).toBeTruthy();
    expect(within(panel()).queryByText('进行中')).toBeNull();
  });

  /**
   * **`onLocalWrite` 那条触发路真的通到重排**（本地通知那一批）。
   *
   * App.tsx 把重排挂在 `tasks` state 一处，理由是「两个触发点最后都汇到
   * `setTasks`」——那句话在 `App.test.tsx` 里只证得了在线那半（手动调
   * `handlers.onChange`）。离线这半的链是：写入 → `localStore` 落盘 →
   * `onLocalWrite` → `reload()` → `setTasks` → effect。`App.test.tsx` 顶上
   * 那句 `vi.mock('./api.js')` 把这条链从第一环就切断了，在那边写多少断言都
   * 够不着（144）。「N 个接线点只覆盖一部分」是这个仓库栽过 28 次的形状，
   * 「一处覆盖两条」这个说法本身就得两条各验一次才算数。
   */
  it('点「完成」之后本地通知跟着重排——落盘 → onLocalWrite → reload → 拿着改完的那份排', async () => {
    await localTasks.write([task({ status: 'doing', title: '写周报' })]);
    await renderOffline();
    fireEvent.click(navButton(/按来源/));
    const panel = () => document.querySelector('.ink-view-panel-source') as HTMLElement;
    await waitFor(() => expect(within(panel()).getByText('写周报')).toBeTruthy());
    // 挂载那一轮排过一次，先等它落定，下面断的才是「写入之后又排了一次」。
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalledWith(
      [expect.objectContaining({ title: '写周报', status: 'doing' })], expect.any(Date),
    ));

    fireEvent.click(btnIn(panel(), '完成'));

    // 断的是**内容**：重排拿到的那份里这条已经是 done（做完的任务不该再提醒，
    // 靠的就是这一次重排把它取消掉）。只数调用次数的话，「又拿着写入之前那份
    // 旧数据排了一遍」同样是绿的——而接线接错正好长那个样子。
    await waitFor(() => expect(vi.mocked(rescheduleLocalNotifications)).toHaveBeenCalledWith(
      [expect.objectContaining({ title: '写周报', status: 'done' })], expect.any(Date),
    ));
  });
});

/**
 * **脏集存坏了这件事，人得看得见**（task-8-brief 交给 Task 8 的第一条积压信号）。
 *
 * `localStore.ts` 的 `readDirty` 读到坏数据时当空表处理，只留了一句 `console.error`。
 * 丢掉的不是缓存，是「这几条本地改过、还没推回去」这个事实——记号没了，`pushBack`
 * 就再也看不见它们，那些改动**此后永远推不回服务端**，而屏幕上一个字都没有。
 * Task 1 当时明确记着这条挂在 Task 8 的结果提示上才是对的地方。
 *
 * **为什么写在这个文件而不是 `App.test.tsx`**：144。这条信号的整条链是
 * `Preferences` → `readDirty` → 模块级的那句话 → `takeDirtyReadFailure()` →
 * `refreshOffline()` → toast。`App.test.tsx` 里唯一能造出「读到坏数据」的办法是把
 * `./lib/localStore.js` 也 mock 掉——那个替身正好切在被测特性所在的那条链上，剩下
 * 能验的只有「App 会把 localStore 返回的字符串弹出来」，链的起点（存储里真的是坏
 * 数据）一次都没被穿过。这里只换存储后端（`Preferences` → 一个 `Map`）和网络，
 * 两样都在被测链路的下游。
 *
 * 顺带钉住一件接线上的事：这条 toast 挂在 `online` 判断的**外面**。离线时每一次
 * 写入都会读一遍脏集（`mark()`），坏数据在那时候就被发现了；挂在里面的话，整场
 * 飞行模式下他什么都看不到，等回到 Wi-Fi 才说——而那时候东西早就丢了。
 */
describe('脏集存坏了：屏幕上说得出来，不是只有控制台知道（不 mock localStore，真的从存储里读坏数据）', () => {
  it('离线随手记一条 → 读脏集时撞上坏数据 → 下一拍心跳弹红字，说清那些改动推不回去了', async () => {
    // 上一版存进去的不是脏集，是别的东西（真实来源：手改、迁移写坏、存储被别的
    // 键串了）。**不是空串也不是合法 JSON**——两者都走不到那条坏数据分支。
    store.set('local:dirtyInboxIds', '{这不是 JSON');
    const intervalSpy = vi.spyOn(window, 'setInterval');
    await renderOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('没有待拆解的')).toBeTruthy());

    // 真的走一次离线写入：addInbox → localApi → dirtyInbox.mark → readDirty 撞上坏数据。
    const box = document.querySelector('.ink-nav-composer textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '买酱油' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await within(inboxPanel()).findByText('买酱油')).toBeTruthy();

    // 60 秒心跳（`refreshOffline` 的三个调用点之一，这个文件里的 EventSource 是个
    // 空壳、`onOpen` 永远不响，所以直接把 interval 的回调抠出来叫，跟 App.test.tsx
    // 那两条同一个套路）。
    const tickFn = intervalSpy.mock.calls.find((c) => c[1] === 60_000)![0] as () => void;
    act(() => { tickFn(); });

    const toast = await screen.findByText(/还没推回桌面/);
    expect(toast.textContent).toContain('推不回去');
    expect(document.querySelector('.ant-message-error')).toBeTruthy();
  });

  it('上限断言：脏集是好的（就是刚才那条离线写入自己留下的记号）——不弹这条红字', async () => {
    // 没有这条的话，「弹了」可能只是因为这条 toast 每拍都弹，跟坏数据没关系。
    const intervalSpy = vi.spyOn(window, 'setInterval');
    await renderOffline();
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('没有待拆解的')).toBeTruthy());

    const box = document.querySelector('.ink-nav-composer textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '买酱油' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await within(inboxPanel()).findByText('买酱油')).toBeTruthy();

    const tickFn = intervalSpy.mock.calls.find((c) => c[1] === 60_000)![0] as () => void;
    act(() => { tickFn(); });

    await waitFor(() => expect(JSON.parse(store.get('local:dirtyInboxIds')!)).toBeTruthy());
    expect(screen.queryByText(/还没推回桌面/)).toBeNull();
  });
});

/**
 * **拥有者那句话本身**：「服务地址连不到，也可以使用本地功能，不一定要
 * 服务器」——这里的前提比上面那组更狠一步：**`getApiBase()` 是空串，从没配过
 * 地址**，本机也探不到服务。这台手机以前会被 App.tsx 一面整页的
 * `.ink-server-onboarding` 挡住，什么都干不了；那面墙删掉之后，它该直接进
 * 主看板、走离线那条路。
 *
 * 跟这个文件其余部分同一个理由**不 mock `./api.js`**（见文件顶部）：这条链
 * 的每一环——`api.addInbox` → `route()` → `isOnline()` 判 false → `localApi`
 * → `localStore` → `onLocalWrite` → 界面重画——都是真的，只有存储后端和
 * `fetch` 是桩。144 那条教训要的就是这个：**替身的位置在被测特性的下游**。
 */
describe('从没配过服务地址的手机：打开就是主看板，随手记一条真的进得去（拥有者原话那条端到端）', () => {
  it('base 是空串、本机探不到服务：主看板在（不是那面墙），随手记的「买酱油」出现在收件箱列表里', async () => {
    setApiBase('');
    resetOnlineCache();
    render(<NoMotion><AntApp><App /></AntApp></NoMotion>);

    // 主看板在，墙不在。
    await screen.findByRole('navigation', { name: '视图' });
    expect(document.querySelector('.ink-server-onboarding')).toBeNull();
    await screen.findByRole('status', { name: '离线' });

    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('没有待拆解的')).toBeTruthy());
    const box = document.querySelector('.ink-nav-composer textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '买酱油' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    // 界面上看得见——不是「api 被调用过一次」。
    expect(await within(inboxPanel()).findByText('买酱油')).toBeTruthy();
    // 真落进本地存储了，不只是一次乐观渲染。
    expect((await localInbox.read()).map((x) => x.text)).toContain('买酱油');
  });
});

/**
 * **从别的 App 分享进来的那条，真的进得了收件箱**（share-target 那一批 Task 4）。
 *
 * 这是这一批唯一一条**从原生事件一路穿到「收件箱里多了一条」**的测试。
 * `App.test.tsx` 里那一族验的是接线的形状（喂给 `api.addInbox` 的是不是整份
 * 文字、成功失败两格屏幕上说什么），但那个文件顶上一句 `vi.mock('./api.js')`
 * 把写入那半整段换成了 `vi.fn()`——**「它真的存下来了」在那边是够不着的**
 * （parked-all 第 144 条）。这里不 mock `./api.js`：`api.addInbox` →
 * `route()` → `isOnline()` 判 false → `localApi` → `localStore` →
 * `onLocalWrite` → `reload()` → 界面重画，每一环都是真的。
 *
 * 顺带钉住这一批的设计正本写死的那一条：**分享走的是随手记同一条路**
 * （`api.addInbox`），所以上面那几条离线随手记的测试守住的东西——落盘、打脏
 * 记号、回到局域网自动推回桌面——分享这条路一件都不用另外接、也一件都不会漏。
 * 新开一条写入路径的话，这条测试会在「本地存储里没有」那一行红。
 */
describe('分享进来的一条真的进得了收件箱（不 mock api.js，真穿 sharePlan → subscribeShare → addInbox → route → localStore → 界面）', () => {
  it('浏览器分享一个带标题的链接：标题和链接一起出现在收件箱列表里，也真落进了本地存储', async () => {
    await renderOffline();
    // 订阅是挂载时同步建的（`subscribeShare` 里没有 await），等一下只是为了
    // 让首屏那轮 reload 落定。
    await waitFor(() => expect(emitShared).not.toBeNull());
    fireEvent.click(navButton(/收件箱/));
    await waitFor(() => expect(within(inboxPanel()).getByText('没有待拆解的')).toBeTruthy());

    // 原生那半原样塞进来的四个字段（Java 里零判断，见 ShareTargetPlugin.java）。
    act(() => {
      emitShared!({
        action: ACTION_SEND, type: 'text/plain',
        subject: '排期表', text: 'https://example.invalid/q3',
      });
    });

    // **界面上看得见**——收件箱列表里真的多了这一行，不是「addInbox 被调过一次」。
    const row = await within(inboxPanel()).findByText(/排期表/);
    // 断整份文字：标题在前、换行、正文在后（`sharePlan.ts` 的拼法，理由是这条
    // 要给 AI 拆解读，只留 URL 它读不出东西）。只断「有『排期表』三个字」的话，
    // 链接被丢掉照样绿。
    expect(row.textContent).toBe('排期表\nhttps://example.invalid/q3');
    // 真落进本地存储了，不只是一次乐观渲染——回到局域网时靠的就是这一份。
    expect((await localInbox.read()).map((x) => x.text)).toContain('排期表\nhttps://example.invalid/q3');
    // 存进去了这件事屏幕上也说了一句（这条路径上唯一的落地信号）。
    expect((await screen.findByText(/已存进收件箱/)).textContent).toContain('排期表');
  });
});
