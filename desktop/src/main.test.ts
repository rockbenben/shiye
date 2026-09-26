import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
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
// 假 electron-updater 的 autoUpdater：属性写经 setter 记录——「没接线时连一次
// 赋值都不该收到」这条只能这么抓（普通属性读不出「有没有被写过」）。事件单槽
// 登记（后一次 import 的 main.ts 覆盖前一次的注册），fire 只会打到最新实例。
const state = vi.hoisted(() => {
  const auWrites: string[] = [];
  const auOn: string[] = [];
  const auHandlers: Record<string, (arg?: unknown) => void> = {};
  let autoDownload = false;
  let autoInstallOnAppQuit = false;
  const au = {
    get autoDownload() { return autoDownload; },
    set autoDownload(v: boolean) { auWrites.push(`autoDownload=${v}`); autoDownload = v; },
    get autoInstallOnAppQuit() { return autoInstallOnAppQuit; },
    set autoInstallOnAppQuit(v: boolean) { auWrites.push(`autoInstallOnAppQuit=${v}`); autoInstallOnAppQuit = v; },
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on(ev: string, cb: (arg?: unknown) => void) { auOn.push(ev); auHandlers[ev] = cb; },
  };
  return {
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
    /** 假 `app.isPackaged` 由它供值：main.ts 的接线路由是 async 的，取值时刻
     *  晚于用例里翻标志的那一刻，所以必须是 getter（见下面 electron mock）。 */
    isPackaged: false,
    /** `Menu.buildFromTemplate` 每次收到的模板都攒在这儿，托盘菜单长什么样
     *  就靠它断言（假 Tray 的 setContextMenu 只负责「被调过」）。 */
    menuTemplates: [] as Array<Array<Record<string, unknown>>>,
    au,
    auWrites,
    auOn,
    auHandlers,
  };
});

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
    // getter 而不是快照：bootstrap 里读它的时刻晚于用例翻 state.isPackaged
    // 的时刻（whenReady 之后才跑），快照会拿到 import 那一刻的旧值。
    get isPackaged() {
      return state.isPackaged;
    },
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
    // 真 Tray 上这个方法只有 win32 有（运行时），类型里是全平台的；main.ts 的
    // balloon 钩子会调它，假对象缺了会在 fire update-downloaded 时当场炸。
    displayBalloon = vi.fn();
    on = vi.fn();
  }

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn((template: Array<Record<string, unknown>>) => {
        state.menuTemplates.push(template);
        return {};
      }),
    },
    Notification: FakeNotification,
    Tray: FakeTray,
    dialog: { showErrorBox: vi.fn() },
    shell: { openExternal: vi.fn(async (u: string) => { state.opened.push(u); }) },
  };
});

// main.ts 顶层 import 它（不管接没接线都会被解析），所以 mock 无条件装上；
// 「接没接线」的判据全落在 state.au 那三个登记器上（赋值/事件/调用）。
vi.mock('electron-updater', () => ({
  default: { autoUpdater: state.au },
}));

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
    // 没用 actions 字段。理由不是「它在 Windows 上无效」（那是旧版事实，2026-09
    // 已核对：现在 Windows 也支持），是它的回调只送给正在跑的实例、丢掉冷启动那一半。
    // 完整理由在 notify.ts 的 buildToastXml 注释里。
    expect(n.options.actions).toBeUndefined();

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

// ============================================================================
// 更新接线（计划 Task 4）：只在「打包的 Windows」上点亮
// ============================================================================
//
// 四条意图：① 接线时 autoDownload 开、autoInstallOnAppQuit 显式关（spec 的
// 「没点不装」全靠这一句显式赋值——electron-updater 默认 true，正常退出会
// 顺手装）；② 托盘菜单长出「检查更新 / 自动检查更新（checkbox，默认关）」，
// update-downloaded 之后 rebuild 出「重启以完成更新 vX」；③ quitAndInstall
// 只有点那一项才会发生，ready 之前菜单里根本没有那一项；④ 未打包形态下
// 假 autoUpdater 一次属性写、一次事件注册都没收到，托盘还是原来的两项。
//
// 「win32」这个前提在需要它的场景里都手动钉死（process.platform 是可重定义
// 的值属性，defineProperty 换掉、afterAll 还原），另有一条反向场景把平台这
// 半边单独钉住——不钉的话在 mac 上跑「未打包」那条会因为平台门先挡住而假
// 绿，isPackaged 那半扇门等于没测；反过来只测 win32+未打包，删掉平台判断也
// 全绿，所以门的后半截由最后那条「打包的非 Windows」钉。
function useWin32(): () => void {
  const prev = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: prev, configurable: true });
}

/**
 * 「打包的 Windows」这一形态要把两件事一起钉死，缺一不可：
 * - `process.platform`（接线门控的前半）；
 * - `process.resourcesPath`——`app.isPackaged` 一真，bootstrap 传给
 *   `resolvePaths()` 的就是它（paths.ts 里 `resolvePaths()` 算 `base` 那行），纯 Node 的 vitest 环境里这个键
 *   压根不存在，于是 `join(undefined, …)` 当场 TypeError，异常被 bootstrap 的
 *   catch 吞成一次 `dialog.showErrorBox`，窗口永远不出现（踩过：接线场景
 *   卡在 `waitFor(lastWindow)` 上，看不出任何原因）。真 Electron 里它总是字符串。
 * 顺带把它指进测试自己的临时目录，不在仓库里留垃圾。
 */
function usePackagedWindows(): () => void {
  const restorePlatform = useWin32();
  const prevResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    value: join(tmpdir(), 'shiye-main-test-resources'),
    configurable: true,
    writable: true,
  });
  return () => {
    restorePlatform();
    if (prevResources) Object.defineProperty(process, 'resourcesPath', prevResources);
    else delete (process as { resourcesPath?: unknown }).resourcesPath;
  };
}

/** 最近一次 buildFromTemplate 收到的 label 序列——菜单形状全靠它断言。 */
const lastMenuLabels = (): unknown[] => state.menuTemplates.at(-1)!.map((i) => i.label);

describe('main.ts 真行为：打包的 Windows 上接线', () => {
  let restorePlatform: () => void;

  beforeAll(async () => {
    restorePlatform = usePackagedWindows();
    state.isPackaged = true;
    vi.resetModules();
    state.handlers = {};
    state.lastWindow = null;
    state.menuTemplates.length = 0;
    state.auWrites.length = 0;
    state.auOn.length = 0;
    state.au.checkForUpdates.mockClear();
    state.au.quitAndInstall.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await import('./main.js');
    await vi.waitFor(() => expect(state.lastWindow).not.toBeNull());
  });

  afterAll(() => {
    restorePlatform();
    state.isPackaged = false;
  });

  it('接线把 autoDownload 设 true、autoInstallOnAppQuit 显式设 false', () => {
    expect(state.auWrites).toContain('autoDownload=true');
    expect(state.auWrites).toContain('autoInstallOnAppQuit=false');
  });

  it('托盘菜单有「检查更新」和「自动检查更新」（checkbox，默认关）；ready 之前没有「重启」项', () => {
    // checkbox 的默认关读的是 Preferences 里那份 update-prefs.json——假
    // app.getPath('appData') 指着临时目录，那儿没有这个文件，loadAutoCheck
    // 落默认值 false（这正是 D1 拍板的「文件不存在=关」在接线层的投影）。
    expect(lastMenuLabels()).toEqual(['打开', '检查更新', '自动检查更新', '退出']);
    const checkbox = state.menuTemplates.at(-1)!.find((i) => i.type === 'checkbox');
    expect(checkbox, '「自动检查更新」不是 checkbox').toBeDefined();
    expect(checkbox!.checked).toBe(false);
    expect(lastMenuLabels().some((l) => String(l).startsWith('重启'))).toBe(false);
  });

  it('fire update-downloaded → 菜单 rebuild 出「重启以完成更新 v0.2.0」；点它才 quitAndInstall', () => {
    // 事件从假 autoUpdater 的登记表打进去（on 是 main.ts 接线时注册的），
    // updater 状态进 ready → onChange → refreshTrayMenu → 又一次
    // buildFromTemplate。点之前 quitAndInstall 一次都没被调——「下载自动、
    // 安装绝不自作」里后半句在接线层的样子。
    expect(state.au.quitAndInstall).not.toHaveBeenCalled();
    state.auHandlers['update-downloaded']?.({ version: '0.2.0' });
    const restart = state.menuTemplates.at(-1)!.find((i) => String(i.label ?? '').startsWith('重启以完成更新'));
    expect(restart, 'ready 之后菜单里没有「重启以完成更新 vX」').toBeDefined();
    expect(restart!.label).toBe('重启以完成更新 v0.2.0');
    (restart!.click as () => void)();
    expect(state.au.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('main.ts 真行为：未打包形态（dev / 别的平台同理）', () => {
  let restorePlatform: () => void;

  // 平台**照旧钉成 win32**：挡住这条的必须恰好是 isPackaged 那半扇门，
  // 而不是「在 mac 上跑所以平台门先拦了」——那样 isPackaged 等于没测。
  beforeAll(async () => {
    restorePlatform = useWin32();
    state.isPackaged = false;
    vi.resetModules();
    state.handlers = {};
    state.lastWindow = null;
    state.menuTemplates.length = 0;
    state.auWrites.length = 0;
    state.auOn.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await import('./main.js');
    await vi.waitFor(() => expect(state.lastWindow).not.toBeNull());
  });

  afterAll(() => {
    restorePlatform();
  });

  it('electron-updater 一行都不接：没有属性写、没有事件注册', () => {
    expect(state.auWrites).toEqual([]);
    expect(state.auOn).toEqual([]);
  });

  it('托盘还是原来的「打开/退出」两项', () => {
    expect(lastMenuLabels()).toEqual(['打开', '退出']);
  });
});

// 上面「未打包」那条把平台钉成 win32，只测 isPackaged 那半扇门；这一条反向
// 补上平台那半：isPackaged 为真但平台不是 win32，门照样要挡住。没有这条的
// 话，删掉 `process.platform === 'win32'` 判断，全量测试照样绿——复审点名的
// 正是这个没钉住的半边。resourcesPath 照样要打桩：bootstrap 顶上的
// resolvePaths 在 isPackaged 为真时无条件读它（paths.ts），跟接不接线无关，
// 纯 Node 环境里缺了它 bootstrap 会 TypeError、窗口永远不出现。
describe('main.ts 真行为：打包的非 Windows（平台门那半边单独钉住）', () => {
  let restore: () => void;

  beforeAll(async () => {
    const prevPlatform = process.platform;
    const prevResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'resourcesPath', {
      value: join(tmpdir(), 'shiye-main-test-resources'),
      configurable: true,
      writable: true,
    });
    restore = () => {
      Object.defineProperty(process, 'platform', { value: prevPlatform, configurable: true });
      if (prevResources) Object.defineProperty(process, 'resourcesPath', prevResources);
      else delete (process as { resourcesPath?: unknown }).resourcesPath;
    };
    state.isPackaged = true;
    vi.resetModules();
    state.handlers = {};
    state.lastWindow = null;
    state.menuTemplates.length = 0;
    state.auWrites.length = 0;
    state.auOn.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await import('./main.js');
    await vi.waitFor(() => expect(state.lastWindow).not.toBeNull());
  });

  afterAll(() => {
    restore();
    state.isPackaged = false;
  });

  it('darwin + 已打包：门照样挡住，electron-updater 一行不接，菜单还是两项', () => {
    expect(state.auWrites).toEqual([]);
    expect(state.auOn).toEqual([]);
    expect(lastMenuLabels()).toEqual(['打开', '退出']);
  });
});
