import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

// main.ts 引 `electron`——`require('electron')`/`import 'electron'` 在纯
// Node 环境下（不是真的 Electron 运行时）拿到的是可执行文件路径字符串，
// 不是 API 对象，main.ts 顶层就有副作用代码（app.setAppUserModelId(...)、
// app.requestSingleInstanceLock()、app.whenReady().then(bootstrap)），一直
// 以来这个文件被认为「进不了 vitest」，只能靠读源文本、正则猜测行为。
//
// 修复轮 3（code review）：那条认定是不准的。`vi.mock('electron', factory)`
// 是模块解析阶段的替换，不需要真实模块提供可用的导出——`electron` 包本身
// 只要能被 Node 解析到（这个仓库里它是装了的，只是不提供真的 GUI 运行时），
// `vi.mock` 就能在 import 之前把它换成一个假的、被 mock 的实现。下半份文件
// 「main.ts 真行为测试」就是这样跑起来的：真的 import main.ts，真的调用它
// 注册在 electron 假对象上的回调，断言真的副作用（fetch 被调用的参数、
// 窗口有没有被显示）——不再靠源文本正则去猜。
//
// 这条测试存在的理由：`server/src/app.ts` 的 `/api/events` 路由靠
// `?client=desktop` 这个查询参数分辨桌面端和网页（events.ts 的
// Bus#isDesktopOnline），唯一的生产发送方就是这里。这行没写、或者哪天被
// 改回 `${URL}/api/events`，服务端会永远认为桌面端不在线——PowerShell
// 兜底照旧起，拥有者最初的抱怨（提醒弹两次）原样复现，而且是静默的：
// 不会有任何测试红、任何日志报错，只有实际用起来才会发现。这一条和下面
// 两条（'failed' 上报、notify-failed 路由）是 Task 1 留下的，没有被这一轮
// 的复审点名，沿用源文本断言，没有跟着改成真行为测试——不是漏改，是没有
// 理由动一段没出过问题的代码。
const mainSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

describe('desktop/src/main.ts 源文本', () => {
  it('订阅 /api/events 时带 ?client=desktop，服务端才知道桌面端在线', () => {
    // **不用 `toContain`，用真的 URL 解析。** `toContain('/api/events?client=desktop')`
    // 是子串匹配，**`?client=desktopx` 能从它下面溜过去**——而那是一个真 bug：
    // 服务端判的是 `c.req.query('client') === 'desktop'`，`'desktopx'` 判 false，
    // 桌面端被误判离线、双弹原样复现，测试却是绿的（复审实测过这条变异）。
    // 大小写那种（`?client=Desktop`）子串匹配挡得住，多参数（`&x=1`）挡不住
    // 但也不是 bug（`client` 的值仍然精确等于 `desktop`）——三种情况只有一种
    // 需要拦，而 `toContain` 恰好拦不住的就是那一种。
    //
    // 从源文本里把那个 URL 抠出来、按 URL 解析、比 `searchParams` 的值,
    // 三种情况一次分清。
    const m = mainSrc.match(/\$\{URL\}(\/api\/events[^`'"]*)/);
    expect(m, 'main.ts 里没找到订阅 /api/events 的那个 URL').not.toBeNull();
    const url = new URL(m![1], 'http://localhost');
    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.get('client')).toBe('desktop');
  });

  // I2：桌面端「在线」（SSE 连接活着）不等于 Electron 通知真的弹出来了——
  // 弹失败时要上报给服务端，服务端才能就地补发一条 PowerShell
  // （POST /api/desktop/notify-failed，见 server/src/app.ts）。server 端
  // `/api/desktop/notify-failed` 路由本身的行为在 app.test.ts 里有完整覆盖
  // （收到就补发、title 缺失就 400）。
  it('Notification 的 \'failed\' 事件接了上报，不是只落一行 console.error 就完事', () => {
    expect(mainSrc).toContain("on('failed', () => reportNotificationFailed(n))");
  });

  it('上报打的是 /api/desktop/notify-failed 这条路由', () => {
    expect(mainSrc).toContain('/api/desktop/notify-failed');
  });
});

// ============================================================================
// main.ts 真行为测试（修复轮 3）
// ============================================================================
//
// 背景：修复轮 2 把协议 URI 解析/patch 构造/argv 路由这三件「不需要
// electron」的事搬进了 protocol.ts，main.ts 收缩成只剩接线——但接线本身
// 仍然只能靠源文本 `toContain` 去查，复审用「拿一行注释顶掉真代码」的手法
// 测了 main.ts 剩下的 5 条接线断言，**5 条全部绿着溜过去**：删掉协议注册、
// 掏空 applyProtocolAction、删掉冷启动 argv 扫描……只要文件里还留着那个
// 子串（哪怕是在注释里），`toContain` 就认。
//
// 这一轮把 electron 真的 mock 起来（`vi.mock('electron', factory)`），把
// 能换成真行为测试的都换掉——`toContain` 时代测不出的那 5 条坏法，连同
// code review 说的 A 那种「换个名字多弹一次 openWindow()」的逃逸，现在
// 全部有真行为断言盯着（见下面「有协议 URI → PATCH 任务，不开窗口」那条：
// 不管 main.ts 里调用的是 openWindow() 还是随便什么别的名字，只要它最终
// 摸到了这个假窗口的 `.show()`，断言就会抓到）。
//
// **这一层 mock 换不来的，是 electron 这个模块的 API 形状之外的东西**：
// Windows 通知中心真的按 `activationType="protocol"` 拉起一个新进程、
// `app.on('second-instance', …)` 在两个真实操作系统进程之间真的收到转发
// 的 argv、`Notification.show()` 真的把 toastXml 渲染成看得见的系统通知——
// 这些是操作系统和真实 Electron 运行时之间的联动，`vi.mock` 只能替换掉
// Node 进程里 `import 'electron'` 解析到的那个对象，替换不了背后那整套
// 真实系统集成。这部分仍然只能靠 `desktop/冒烟清单.md` 里的人工验证兜底，
// 见那份清单第 4/5 条和「补两条」那一节。
const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  lastWindow: null as null | {
    show: ReturnType<typeof import('vitest')['vi']['fn']>;
    focus: ReturnType<typeof import('vitest')['vi']['fn']>;
    webContents: {
      executeJavaScript: ReturnType<typeof import('vitest')['vi']['fn']>;
      setWindowOpenHandler: ReturnType<typeof import('vitest')['vi']['fn']>;
      on: ReturnType<typeof import('vitest')['vi']['fn']>;
    };
  },
  /** 窗口上挂的 webContents 事件处理器（`will-navigate` 那条）。 */
  wcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  /** `setWindowOpenHandler` 收到的那个回调。 */
  windowOpenHandler: null as null | ((d: { url: string }) => unknown),
  /** `shell.openExternal` 被交出去的地址。 */
  opened: [] as string[],
  notifications: [] as Array<{ options: Record<string, unknown>; handlers: Record<string, (...a: unknown[]) => unknown> }>,
  sseCallback: null as null | ((event: string, data: unknown) => void),
}));

vi.mock('electron', () => {
  const app = {
    setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(() => true),
    on: vi.fn((event: string, cb: (...a: unknown[]) => unknown) => {
      state.handlers[event] = cb;
    }),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    isPackaged: false,
    // **必须是绝对路径、而且落在临时目录里。** main.ts 顶层会
    // `mkdirSync(join(getPath('appData'), 'shiye'))`（Electron 的 setPath 契约要求
    // 目录已存在，见那句上面的注释），返回相对路径的话这一句会在跑测试的当前目录
    // 底下真的造出一个 `fake-userdata/shiye/`，把垃圾留在仓库里。
    getPath: vi.fn(() => join(tmpdir(), 'shiye-main-test')),
    // productName。跟 desktop/package.json 一致——setName() 全仓没有第二处调用，
    // 真实运行时这里返回的就是它。main.ts 自己不读它（曾经有一版迁移代码拿它拼
    // 旧目录，因为取到的是「现在」的名字而不是真正发布过的那个，整段撤掉了，
    // 见 main.ts 里 setPath 下面那段），留着是因为 Electron 的 app 对象上本来
    // 就有，缺了将来谁加一处调用会 undefined。
    getName: vi.fn(() => '办事师爷'),
    // main.ts 顶层会 setPath('userData', …) 把 %APPDATA% 下的目录名钉成 shiye
    // （见那句上面的注释）。假 app 上没有这个方法的话，import main.ts 当场 throw。
    setPath: vi.fn(),
  };

  // 三个假构造函数只实现 main.ts 真的用到的那几个方法——够跑通接线，不是
  // 一份完整的 Electron API 仿真。
  class FakeBrowserWindow {
    show = vi.fn();
    focus = vi.fn();
    hide = vi.fn();
    isMinimized = vi.fn(() => false);
    on = vi.fn();
    loadURL = vi.fn();
    webContents = {
      executeJavaScript: vi.fn(() => Promise.resolve()),
      setWindowOpenHandler: vi.fn((cb: (d: { url: string }) => unknown) => { state.windowOpenHandler = cb; }),
      on: vi.fn((event: string, cb: (...a: unknown[]) => unknown) => { state.wcHandlers[event] = cb; }),
    };
    constructor() {
      state.lastWindow = this as never;
    }
  }

  class FakeNotification {
    options: Record<string, unknown>;
    handlers: Record<string, (...a: unknown[]) => unknown> = {};
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.notifications.push({ options, handlers: this.handlers });
    }
    on(ev: string, cb: (...a: unknown[]) => unknown) {
      this.handlers[ev] = cb;
      return this;
    }
    show = vi.fn();
  }

  class FakeTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  }

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
    Notification: FakeNotification,
    Tray: FakeTray,
    dialog: { showErrorBox: vi.fn() },
    shell: { openExternal: vi.fn(async (u: string) => { state.opened.push(u); }) },
  };
});

// bootstrap() 会真的调用这三个模块——不 mock 的话，测试会真的 spawn 子进程、
// 真的发起网络连接。resolvePaths（./paths.js）不 mock：它是纯函数（不做
// I/O，见 paths.test.ts），isPackaged=false 时只是拼字符串，让它跑真的更
// 简单，也顺带验证了 bootstrap() 传给它的参数不会在 mock 环境下报错。
vi.mock('./serverChild.js', () => ({
  startServer: vi.fn(async () => null), // null = 端口上已经有健康的自己，不用起子进程
  waitUntilHealthy: vi.fn(async () => true),
}));
vi.mock('./sse.js', () => ({
  subscribeSse: vi.fn((_url: string, cb: (event: string, data: unknown) => void) => {
    state.sseCallback = cb;
  }),
}));
vi.mock('./agentFiles.js', () => ({
  ensureAgentFiles: vi.fn(),
}));

describe('main.ts 真行为：应用已经在跑时收到的 second-instance', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await import('./main.js');
    // bootstrap() 是 app.whenReady().then(bootstrap) 触发的异步链，import
    // 完成不代表它跑完了——等窗口出现，标志 createWindow() 已经跑过。
    await vi.waitFor(() => expect(state.lastWindow).not.toBeNull());
  });

  /**
   * 备注里的链接不许把这个窗口变成浏览器。判据在 `links.test.ts`（纯函数），
   * 这里测接线：两个钩子真的挂上了、真的 deny、真的把地址交给了系统。
   *
   * 这条能测出来的是「接线在不在」——`target="_blank"` 在真 Electron 里到底
   * 走不走 `setWindowOpenHandler`，那是运行时行为，只能真机验。
   */
  it('挂了 setWindowOpenHandler：外链交给系统浏览器，一律不在应用里开第二个窗口', () => {
    expect(state.windowOpenHandler, 'main.ts 没有调用 setWindowOpenHandler').not.toBeNull();
    state.opened = [];
    expect(state.windowOpenHandler!({ url: 'https://example.com/a' })).toEqual({ action: 'deny' });
    expect(state.opened).toEqual(['https://example.com/a']);
  });

  it('**`javascript:` 一概不理**：照样 deny，但不递给系统——备注是自由文本，AI 也能往里写', () => {
    state.opened = [];
    expect(state.windowOpenHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(state.opened).toEqual([]);
  });

  it('挂了 will-navigate：附件那种同源链接拦下来交给系统，应用自己那一页放行', () => {
    const wn = state.wcHandlers['will-navigate'];
    expect(wn, 'main.ts 没有挂 will-navigate').toBeDefined();
    state.opened = [];

    const e1 = { preventDefault: vi.fn() };
    wn(e1, 'http://localhost:30035/api/tasks/abc/attachments/x.png');
    expect(e1.preventDefault).toHaveBeenCalled();
    expect(state.opened).toEqual(['http://localhost:30035/api/tasks/abc/attachments/x.png']);

    const e2 = { preventDefault: vi.fn() };
    wn(e2, 'http://localhost:30035/');
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it('注册了协议处理器 app.setAsDefaultProtocolClient(PROTOCOL)——按钮点击要靠它才能激活', () => {
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('todo-desktop');
  });

  it('second-instance 收到协议 URI（完成按钮）→ PATCH 任务，不开窗口——A 那种「多弹一次窗口」的坏法现在能测出来', async () => {
    const handler = state.handlers['second-instance'];
    expect(handler, '没找到注册的 second-instance 处理器').toBeTypeOf('function');
    vi.mocked(fetch).mockClear();
    state.lastWindow!.show.mockClear();

    handler({}, ['C:\\app.exe', 'todo-desktop://complete?id=abc']);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/api/tasks/abc');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).body).toBe(JSON.stringify({ status: 'done' }));
    // quick action 不该弹窗口——这条断言正是修复轮 2 那个「换个名字弹窗口」
    // 的 A 逃逸想躲开的那一条，mock 了真的 BrowserWindow 之后躲不掉了：
    // 不管 main.ts 里调用的是 openWindow() 还是随便什么别的名字，只要它
    // 最终摸到了这个假窗口的 .show()，这里就会抓到。
    expect(state.lastWindow!.show).not.toHaveBeenCalled();
  });

  it('second-instance 没有协议 URI（普通重复启动）→ 打开窗口，不 PATCH', () => {
    const handler = state.handlers['second-instance'];
    vi.mocked(fetch).mockClear();
    state.lastWindow!.show.mockClear();

    handler({}, ['C:\\app.exe']);

    expect(state.lastWindow!.show).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reminder 事件 → toastXml 通知（带图标、不带 actions 字段），点击 → 打开窗口并安全转义 id 派发事件', () => {
    expect(state.sseCallback, '没找到 subscribeSse 的回调').toBeTypeOf('function');
    state.notifications.length = 0;
    // id 里带一个单引号——main.ts 拼的模板字符串外层是 `detail: '${id}'`
    // 这种裸插值遇到单引号会被直接拆断（双引号在这个位置反而不算危险，
    // 单引号字符串里的字面双引号不需要转义，写夹具时踩过这个坑）。
    state.sseCallback!('reminder', { id: `t'1`, title: '交房租' });

    expect(state.notifications).toHaveLength(1);
    const n = state.notifications[0];
    const xml = n.options.toastXml as string;
    expect(xml).toContain('<text>该做了</text>');
    expect(xml).toContain('<text>交房租</text>');
    expect(xml).toMatch(/src="file:\/\/\//); // 图标是 file:// URL，不是裸路径
    expect(n.options.actions).toBeUndefined(); // 没用 actions 字段（macOS 专属）

    expect(n.handlers['click']).toBeTypeOf('function');
    state.lastWindow!.show.mockClear();
    n.handlers['click']();
    expect(state.lastWindow!.show).toHaveBeenCalled();
    const script = state.lastWindow!.webContents.executeJavaScript.mock.calls.at(-1)![0] as string;
    // 这段脚本必须是能被解析的合法 JS——裸插值遇到 id 里的单引号会拆断
    // 字符串边界，产出解析不出来的代码，new Function 在那种坏法下会直接抛。
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(JSON.stringify(`t'1`));
    // **事件名是一份跨包契约，而契约的两头以前各测各的。** 这里原来只断言
    // 「脚本能解析」和「id 转义对了」，从不查事件名；`web/src/App.tsx` 那头
    // 又是自己硬编码一个名字派发出去测监听器。整批审查实测：**改掉任一头，
    // 全量 1930 条全绿**，而真实后果是点提醒通知只把窗口带到前台、卡片不
    // 定位——正好退回 Task 2 要消灭的那个旧行为（见 desktop/冒烟清单.md
    // 第 5 条「如果看到的是旧行为，说明这条没接上」）。
    //
    // 跟这一批 Task 1 那条 `?client=desktop` 零覆盖是**同一个形状**：两侧
    // 契约、各自供给同一个字面量、谁都没断言那个字面量本身。改一头就断，
    // 而两头的测试都还绿着。
    expect(script).toContain("'desktop-open-task'");
  });
});

describe('main.ts 真行为：冷启动（应用没在跑，托盘退出过/机器重启过）', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  // I1 的核心场景：second-instance 只覆盖「应用已经在跑」，这条测的是
  // bootstrap() 自己也会扫一遍 process.argv——用 vi.resetModules() 强制
  // main.ts 重新执行一遍顶层代码（含 app.whenReady().then(bootstrap)），
  // 提前把协议 URI 放进 process.argv，验证不需要 second-instance 也能
  // PATCH 成功。
  it('process.argv 里有协议 URI → bootstrap() 完成后也会 PATCH', async () => {
    vi.resetModules();
    state.handlers = {};
    state.lastWindow = null;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    process.argv = ['C:\\app.exe', 'todo-desktop://snooze?id=cold'];

    await import('./main.js');
    // 「推迟」现在**先取一次任务**再 PATCH：不取的话只能整个替换掉 reminders
    // 数组，这条任务上别的提醒会被一起吃掉（见 protocol.ts 那段）。所以这里
    // 等的是那次 PATCH，不是「第一次 fetch」。
    await vi.waitFor(() => expect(
      vi.mocked(fetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'),
    ).toBe(true));
    const [url, init] = vi.mocked(fetch).mock.calls
      .find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(String(url)).toContain('/api/tasks/cold');
    expect((init as RequestInit).method).toBe('PATCH');
    // 取任务那一发走的是整份列表——服务端没有 GET /api/tasks/:id。
    expect(vi.mocked(fetch).mock.calls.some(([u, i]) =>
      String(u).endsWith('/api/tasks') && (i as RequestInit | undefined)?.method === undefined)).toBe(true);
  });
});
