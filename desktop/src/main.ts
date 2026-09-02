import { app, BrowserWindow, Menu, Notification, Tray, dialog, shell } from 'electron';
import type { NotificationConstructorOptions } from 'electron';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { iconPath, resolvePaths } from './paths.js';
import { ensureAgentFiles } from './agentFiles.js';
import { startServer, waitUntilHealthy, type ChildHandle } from './serverChild.js';
import { buildNotificationOptions, toNotification, PROTOCOL, type NotifyContent } from './notify.js';
import { parseProtocolUri, patchForAction, routeSecondInstance, type ReminderLike } from './protocol.js';
import { decideLink } from './links.js';
import { subscribeSse } from './sse.js';

// 跟 server/src/index.ts 里 `port` 的默认值对齐——子进程用这个端口起服务，这里才
// 知道往哪个地址 loadURL、探活、订阅 SSE。不读 process.env.PORT：Electron 主
// 进程不 load 仓库根的 .env（见 desktop/冒烟清单.md 和报告里记的那条已知缺口），
// 这里加一层假的可配置性只会制造「设了却没用」的错觉。
const PORT = 30035;
const URL = `http://localhost:${PORT}`;

// desktop/dist/main.js 往上两级是 desktop/ 本身（跟 server/src/index.ts 顶上那段
// 同一个先例：dist -> 包目录 -> 仓库根，这里少一层是因为 desktop/ 直接就是
// 仓库的子目录，不需要再往上到 repoRoot 才能拿到 desktop 自己）。
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// build/icon.png 跟 dist/ 是 desktop/ 下的兄弟目录，electron-builder.yml 的
// files 把它们一起打进了 app 目录（asar 内部结构原样保留 desktop/ 的相对布局）。
//
// **从 `here`（这个文件所在的 dist/）往上一层取，不要用 `app.getAppPath()`。**
// 原来这里用的是后者，注释还写着「开发模式和打包后指向同一层」——那句是错的，
// 实测：
//   开发模式（electron desktop/dist/main.js） getAppPath() = …/desktop/dist
//   打包后                                    getAppPath() = …/app.asar（根）
// 两者差一层，于是开发模式下拼出 …/desktop/dist/build/icon.png，那儿没有文件，
// `new Tray(ICON_PATH)` 直接抛「Failed to load image」，整个应用起不来——而打包
// 版正常，所以这条一直没被发现（开发模式在这个仓库的约束里一直是禁止跑的）。
//
// `here` 在两种形态下都是「dist 那一层」，往上一级就都是 desktop/ 的布局根，
// 一个表达式覆盖两种，也不用判断 isPackaged。
const ICON_PATH = iconPath(here);

// toastXml 里的 <image src="…"> 要用 file:/// 绝对路径，普通文件系统路径
// Windows 认不出来。pathToFileURL 顺带把空格、中文这些字符正确 percent-encode
// 掉——打包后这条路径长这样：`…\resources\app.asar.unpacked\build\icon.png`，
// 而 NSIS 默认装在 `…\Programs\<productName>\`，productName 是中文。
//
// **这一份 URL 是给操作系统读的，不是给 Electron 读的**，所以 `build/icon.png`
// 必须在 asar 外面（electron-builder.yml 的 `asarUnpack`，那里有完整说明）：
// toast 的 XML 交给 Windows.UI.Notifications 渲染，它不认 asar；同一个
// ICON_PATH 喂给 Tray/BrowserWindow 却一直好使，因为那条路走 Electron 自己
// 的 nativeImage + asar 垫片。两个消费者、两套读取路径，只有这一个会被 asar 打死，
// 而且死得没声音（图没了、不报错、不落日志）。
//
// （这一段先后写错过两版：先是说 ICON_PATH 落在 `<userData>\办事师爷\app\build\`
// ——跟 userData 毫无关系；改完又说它「落在安装目录里」、把 pathToFileURL 的理由
// 记在中文安装路径上——方向对但避开了真正的危险，那时它其实还在 asar 里面。）
const ICON_FILE_URL = pathToFileURL(ICON_PATH).href;

const TIMEOUT_HTML = `<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.6">
<h1>办事师爷服务没能在 10 秒内应答</h1>
<p>后台服务可能还在启动，或者出了问题。托盘图标还在的话再等一会儿，左键点一下重新打开看看；
一直这样的话，用仓库里的「启动.cmd」手动起一次，从它弹出的终端窗口里看具体报错。</p>
</body>`;

// Windows 的 toast 通知认的是 AppUserModelID（AUMID），装了 NSIS 版之后
// electron-builder 的模板会在开始菜单快捷方式上用 WinShell::SetLnkAUMI 写好
// 这个 appId（见 electron-builder.yml 的 appId: com.rockbenben.shiye），但那只
// 覆盖「从快捷方式启动」这一条路——从安装目录直接双击 exe、或者开发模式，
// Electron 进程自己的 AUMID 是空的，toast 会被系统直接吞掉、没有任何报错。
// 显式设一遍兜底，字面量跟 electron-builder.yml 的 appId 保持一致。
app.setAppUserModelId('com.rockbenben.shiye');

// userData 默认是 `<appData>/<productName>`，也就是 `%APPDATA%\办事师爷\`。显式
// 改成 `shiye`，为的是 `%APPDATA%` 下**只出现一个文件夹**：设置（device.json，
// 见 server/src/store.ts 的 deviceConfigPath）走的是它自己那条平台惯例路径，
// 跟 Electron 的 userData 是两套算法——不对齐的话同一台机器上会并排躺着
// 「办事师爷」和「shiye」两个目录，看着像装了两个应用。
//
// ⚠️ **这一句搬的不只是文件夹名字，是打包版的整份任务数据。** `paths.ts` 的
// `resolvePaths()` 打包时算的是 `agentCwd = join(userData, 'agent')`、
// `dataDir = join(agentCwd, 'data')`（`bootstrap()` 把 `app.getPath('userData')`
// 传进去），Chromium 自己那份 profile（localStorage：服务地址、行/卡密度）也在
// 这底下。所以改这个字面量 = 把打包版的数据目录整个换一个地方，界面上表现为
// **一个空看板**，旧文件原地没人读、全程不报一句错。**没有自动搬家**，理由见
// 下面那段长注释——旧版数据要自己搬，README 和 desktop/冒烟清单.md 如实这么写。
//
// **必须在任何 app.getPath('userData') 之前调用**（bootstrap 里那次在
// whenReady 之后，顶层这句跑在它前面）。改成 setName() 也能达到同样效果，
// 但那会连带改掉 app.getName()——托盘提示、崩溃对话框标题这些拿它当显示名的
// 地方会一起变成 "shiye"，而显示名就该是「办事师爷」。setPath 只动路径。
//
// 字面量跟 store.ts 里那个配置目录名对齐，scripts/identity-literals.test.ts 守着。
const USER_DATA_DIR = join(app.getPath('appData'), 'shiye');

// Electron 的文档写死了这条契约：「If the path specifies a directory that does
// not exist, an `Error` is thrown. In that case, the directory should be created
// with `fs.mkdirSync` or similar.」（node_modules/electron/electron.d.ts）。
// `%APPDATA%\shiye` 是服务端第一次 writeSettings() 才顺手建出来的——只装了桌面版、
// 从没跑过 `启动.cmd` 的全新机器上它不存在，那这一句会在**模块顶层**抛出，比
// `whenReady` 还早，bootstrap 里那几个 dialog.showErrorBox 一个都轮不到，用户看到
// 的是 Electron 自己那个「A JavaScript error occurred in the main process」。
mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath('userData', USER_DATA_DIR);

// **这里刻意没有「把旧目录的数据搬过来」那一步。** 写过一版，实测之后整段撤掉，
// 理由记在这儿免得下次又有人凭直觉把它加回来：
//
// 1) **它找不到任何真实存在的旧目录。** 那一版用 `app.getName()` 去拼
//    `<appData>/<名字>/agent`，取到的是**现在**的 productName「办事师爷」。而
//    `git log -p desktop/package.json` 显示 productName 是 待办 → 办事师爷，
//    `desktop/release/` 里躺着的、唯一真的打过包的东西叫 `待办 0.1.0.exe`、
//    `win-unpacked/待办.exe`。真装过旧版的人，数据在 `%APPDATA%\待办\agent`，
//    `办事师爷` 那个目录从来没有任何安装包创建过。
// 2) **就算把名字改对，也得是冻结的字面量**（`['待办']` 这种），不能是活的
//    `app.getName()`——一次性迁移读当前名字，等于下次改名它又悄悄把自己重新指向
//    另一个地方。
// 3) **不能用 `renameSync`。** `server/src/migrate.ts` 的 `moveSettings()` 上面有
//    一整段注释写着这条教训（真栽过：`data/` 在 D:、`%APPDATA%` 在 C:，跨卷抛
//    EXDEV），那边刻意改成了 copyFileSync + unlinkSync。Windows 上还有第二种失败：
//    目录里有文件被占用、或者它是某个进程的 cwd 时 rename 抛 EPERM/EBUSY——而
//    `server/src/expand.ts` 正是拿 `<agent>` 当 cwd spawn `claude` 的。
// 4) **失败之后没有「下次再试」。** `bootstrap()` 会调 `ensureAgentFiles()`，
//    那里是 `cpSync(..., { recursive: true })`（agentFiles.ts），会把目标的父目录
//    一并造出来——所以第一次搬家失败被吞掉之后，几秒内目标目录就存在了，此后每次
//    启动都在「目标已存在就不碰」那道守卫上直接返回，永远搬不成。
//
// 合起来：那是一段**看起来在工作、实际找错目录**的迁移，而 README 和
// `desktop/冒烟清单.md` 会照着它宣称「第一次启动会自动搬过来」。宁可明确没有迁移
// （文档如实写「旧版数据要自己搬」），也不要一段会让人放心的假搬家。
// 真要补的话：冻结字面量 + copy/unlink + 搬完在界面上说一声，别再默默进行。

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let child: ChildHandle | null = null;
// close 事件靠它分清「隐藏到托盘」还是「真退出」——只有 app 自己要退出时才置 true。
let quitting = false;

// 见 bootstrap() 末尾：macOS 的协议激活（'open-url'）可能在服务起来之前就到，
// 早到的攒在这里，服务健康之后一起补发。Windows/Linux 走 argv，不经过这两个。
let serverReady = false;
const pendingUris: string[] = [];

// 原生通知失败（比如 AUMID 没注册好、系统通知被关）之前完全静默——弹不出来
// 时没有任何痕迹。接上 'failed' 至少落一行日志，别让它无声消失。
function showNotification(options: NotificationConstructorOptions): Notification {
  const notification = new Notification(options);
  notification.on('failed', (_e, error) => console.error('原生通知发送失败：', error));
  notification.show();
  return notification;
}

function openWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 点通知本体（不是点「完成/推迟」按钮）：打开窗口，再往页面派发一个自定义
// DOM 事件带上任务 id——web/src/App.tsx 接住 'desktop-open-task'，切到装得下
// 这条任务的去处，用已有的 editRequest/autoEdit 机制（'E' 键同一条路）把
// 它的编辑表单打开，等于「定位到那条任务」，不是笼统地打开窗口就完事。
// 不用 loadURL 换页：mainWindow 一直加载着同一份页面（哪怕隐藏在托盘里），
// executeJavaScript 直接在已经跑着的那棵 React 树上派发事件，不重新加载、
// 不丢已有状态（编辑到一半的草稿之类）。
function openTask(id: string): void {
  openWindow();
  mainWindow?.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent('desktop-open-task', { detail: ${JSON.stringify(id)} }))`)
    .catch((e) => console.error('往窗口派发 desktop-open-task 失败：', e));
}

// toast 上「完成」「推迟 N 分钟」两个按钮点击之后，Windows 把它们的
// arguments 当协议链接启动，落进下面 second-instance/冷启动两处共用的
// routeSecondInstance() 判成 `{ kind: 'protocol', uri }`——这里是两条路
// 共用的「拿到 URI 之后做什么」：解析出 kind/id、算出对应的 patch（两步
// 都是纯逻辑，见 protocol.ts 的 parseProtocolUri()/patchForAction()，
// 已经有真实执行的单元测试），PATCH 服务端，不开窗口——quick action 的
// 意义就是不用打开应用。解析失败（parseProtocolUri 返回 null，理论上不该
// 发生）什么都不做。
//
// **这条路径没法在这个沙盒里实测**（起不了真的 Electron GUI，也没有真的
// Windows toast 会被点）——没法验证的只剩「Windows 点了 toast 按钮之后
// 真的会走到这里」这件事本身，见 desktop/冒烟清单.md，只能靠拥有者在真机
// 上点一次确认。
async function applyProtocolAction(uri: string): Promise<void> {
  const parsed = parseProtocolUri(uri);
  if (!parsed) return;
  // 「推迟」要先把这条任务取回来：不取的话只能整个替换掉 reminders 数组，
  // 这条任务上别的提醒会被一起吃掉（见 protocol.ts 里 patchForAction 那段）。
  // 「完成」不用取，它跟别的字段无关。取失败就传 null，那边退回老路——多一次
  // 本机往返换的是「不删他的数据」，而取不到时宁可少留几条也不能不响。
  const existing = parsed.kind === 'snooze' ? await fetchReminders(parsed.id) : null;
  return patchTask(parsed.id, patchForAction(parsed.kind, new Date(), existing));
}

/**
 * 取这条任务当下的提醒数组。取不到（服务没起来、这条任务已经被删了、字段
 * 形状不对）一律返回 null——跟 patchTask 同一个「背景动作，失败就算了」的态度。
 *
 * **拉的是整份 `/api/tasks` 再自己找**：服务端没有 `GET /api/tasks/:id`
 * 这条路由（只有 PATCH 和 DELETE 挂在这个路径上）。为一次背景 PATCH 去开一条
 * 新的公开路由，不如在本机上多传几百 KB——这条路一次点击只走一遍。
 */
async function fetchReminders(id: string): Promise<ReminderLike[] | null> {
  try {
    const res = await fetch(`${URL}/api/tasks`);
    if (!res.ok) return null;
    const all = await res.json() as Array<{ id?: unknown; reminders?: unknown }>;
    const t = Array.isArray(all) ? all.find((x) => x.id === id) : undefined;
    return t && Array.isArray(t.reminders) ? t.reminders as ReminderLike[] : null;
  } catch {
    return null;
  }
}

// 「完成」「推迟 10 分钟」都不开窗口、失败也静默吞掉——这本来就是背景动作，
// 没有窗口开着，没有地方弹一条错误提示给谁看；跟 reportNotificationFailed()
// 同一个「发不出去就算了，不比完全不发更差」的态度。
function patchTask(id: string, patch: Record<string, unknown>): Promise<void> {
  return fetch(`${URL}/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(() => undefined, () => undefined);
}

function createWindow(healthy: boolean): void {
  // 不要菜单栏。Electron 默认给每个窗口挂一套 File/Edit/View/Window/Help——
  // 那是「开箱即用的框架观感」，跟这个产品刻意收着的调子不是一回事（同一条
  // 理由见 theme.css 顶部为什么不用 antd 自带的 Empty 插画）。这里整个去掉，
  // 窗口只剩内容；真正要用的两个动作（打开 / 退出）在托盘菜单里。
  //
  // **剪贴板**：老版本 Electron 里 setApplicationMenu(null) 会连带干掉
  // Ctrl+C/V/X/A 的默认加速键（那些绑在 editMenu 的 role 上），而「随手记」
  // 最主要的捕获路径就是粘贴。Electron 44 的 Chromium 在可编辑区域是原生
  // 处理这几个键的、不依赖菜单 role——**但这条只能实测**，所以它是
  // desktop/冒烟清单.md 里单独一条，不是靠版本号推出来就算数的。
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({ width: 1200, height: 800, icon: ICON_PATH });

  // **备注里的链接不许把这个窗口变成浏览器。** 任务备注按 Markdown 渲染，
  // 外链带着 `target="_blank"`——在浏览器里那是新开一个标签页，在 Electron 里
  // 默认是新开一个 `BrowserWindow`：没有地址栏、没有前进后退，而且这个应用把
  // 菜单栏整个去掉了（下面 `Menu.setApplicationMenu(null)`），点一下备注里的
  // 链接就多出一个退不出去、看着还像是「办事师爷的一部分」的窗口。
  //
  // 另一半是 `will-navigate`：没有 `target` 的链接（附件那两个「打开」就是）
  // 会**在当前窗口里跳走**——那更糟，应用本身没了，只能关掉重开。
  //
  // 判据（哪些留在窗口里、哪些交给系统、哪些一概不理）在 `links.ts`，纯函数、
  // 单独测得动；这里只管接线。
  const handOff = (raw: string): void => {
    const d = decideLink(raw, URL);
    if (d.kind === 'external') void shell.openExternal(d.url).catch(() => undefined);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    handOff(url);
    // 一律 deny：该开的已经交给系统了，这个应用自己不开第二个窗口。
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (decideLink(url, URL).kind === 'stay') return;
    e.preventDefault();
    handOff(url);
  });

  if (healthy) {
    void mainWindow.loadURL(URL);
  } else {
    // 探了 10 秒还是不通：与其白屏或者一个 Chromium 自己的 ERR_CONNECTION_REFUSED
    // 错误页，不如给一句人话，剩下的交给拥有者自己去开着的终端里看服务卡在哪儿。
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TIMEOUT_HTML)}`);
  }

  // 4. 关窗口 = 隐藏到托盘，不是退出。这条是这一整批「Electron 接线」的全部意义：
  // 一个只在你记得启动它的时候才提醒你的提醒工具，逻辑上是个圈——常驻后台、
  // 关了窗口也继续跑，到点了原生通知才弹得出来。真正的退出走托盘菜单「退出」
  // 或者 app.quit()，那条路会先把 quitting 置 true（见下面 before-quit）。
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });
}

function createTray(): void {
  tray = new Tray(ICON_PATH);
  tray.setToolTip('办事师爷');
  // 5. 托盘右键菜单：打开 / 退出。「随手记」小窗不在这一批（brief 明确排除）。
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开', click: openWindow },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', openWindow); // 左键点图标 = 打开窗口
}

// 桌面端「在线」（SSE 连接活着）不等于这条 Electron 通知真的弹出来了——用户在
// 系统设置里把「办事师爷」的通知关掉了、或者 AUMID 没注册好，`Notification.show()`
// 会静默失败，只有 showNotification() 里已经接的那个 'failed' 事件知道。服务端
// 因为「桌面端在线」已经把 PowerShell 兜底关了（server/src/events.ts 的
// Bus#isDesktopOnline），这时候不报一声的话两条 OS 通知路径同时哑掉。上报失败，
// 服务端就地补发一条 PowerShell——发不出去（服务正在重启之类）也无所谓，
// 静默失败不会比"完全不上报"更差。
//
// ⚠️ 已知覆盖不到的情况：用户手动把「办事师爷」的系统通知整体关掉时，Electron 不一定
// 会触发 'failed'（这条本身就没法在这个沙盒里实测，起不了真的 Electron GUI）——
// 那种情况下这里也收不到任何信号，见 desktop/冒烟清单.md 里补的那条，只能靠人
// 在真机上验证。
function reportNotificationFailed(n: NotifyContent): void {
  fetch(`${URL}/api/desktop/notify-failed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(n),
  }).catch(() => {});
}

function subscribeReminders(): void {
  // 6. 订阅 SSE，每条事件过 toNotification，非 null 就弹原生通知（toastXml
  // 自己拼，带图标和「完成/推迟 10 分钟」两个按钮，见 notify.ts
  // buildToastXml() 顶部注释）；点通知本体 = 打开窗口并定位到那条任务
  // （openTask，不是笼统 openWindow）；弹失败就上报（见 reportNotificationFailed）。
  // subscribeSse 自己会在断线时重连，这里不用管重试——见 sse.ts 顶部注释，
  // 手写而不是用 EventSource 是因为 Node 的 EventSource 还锁在实验性标志后面，
  // 这个沙盒起不了真的 Electron GUI，没法实测那条路在打包后的主进程里到底通不通。
  // `?client=desktop`：让服务端知道桌面端在线（server/src/events.ts 的
  // Bus#isDesktopOnline），这样它到点提醒时不会再另起一个 PowerShell 弹窗——
  // 那条路是没有桌面端时的兜底，桌面端在线时这里的 Electron Notification 才是主路径。
  void subscribeSse(`${URL}/api/events?client=desktop`, (event, data) => {
    const n = toNotification(event, data);
    if (!n) return;
    showNotification(buildNotificationOptions(n, { fileUrl: ICON_FILE_URL, path: ICON_PATH }))
      // 概览（`n.id === null`）没有可定位的那一条，开主窗口就是它该做的事。
      .on('click', () => { if (n.id === null) openWindow(); else openTask(n.id); })
      .on('failed', () => reportNotificationFailed(n));
  });
}

async function bootstrap(): Promise<void> {
  // 2. 起服务，先算路径。resolvePaths 抛错说明这台机器的配置注定跑不起来
  // （比如 DATA_DIR 指错了名字，见 paths.ts 顶部注释），不能让它变成一次
  // 静默的白屏启动——弹一个说清楚原因的对话框，然后老实退出。
  let paths;
  try {
    paths = resolvePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'),
      repoRoot,
    });
  } catch (e) {
    dialog.showErrorBox('办事师爷启动失败', (e as Error).message);
    app.quit();
    return;
  }

  // 这一段往后（拷文件、起子进程、探活）都是真实 I/O，任何一步意外抛出去
  // 而没人接住，bootstrap() 这个 async 函数就会变成一个没人处理的 rejected
  // promise——表现出来就是「窗口一闪都没有，直接没反应」，跟 8 条里明确
  // 要避免的「窗口一闪就没了」是同一类事故，只是发生在更早的阶段。兜一层。
  try {
    // AI 拆解要读的 AGENTS.md/workflows 得先铺到它的工作目录（agentCwd），
    // 所以在 startServer 之前调——Task 2 的报告里明确交代了这条接线顺序。
    ensureAgentFiles({ from: app.isPackaged ? process.resourcesPath : repoRoot, to: paths.agentCwd });

    child = await startServer({ paths, port: PORT });
    // child === null：端口上已经有一个健康的我们自己（用户可能已经双击过
    // 启动.cmd）。窗口照样该开，这不是失败——startServer 的约定就是这样，
    // 见 serverChild.ts 顶部注释。这种情况下没有「我们自己的」子进程可监控，
    // 8 条里的崩溃通知也就无从谈起，跳过 onExit 完全正确。
    if (child) {
      child.onExit((code, killedByUs) => {
        // 8. 子进程崩了要说清楚，不能「窗口一闪就没了」——第一批那条暂缓项
        // 记下来的教训。killedByUs 为 true 时是我们自己在退出流程里主动
        // stop() 的，那种不用告诉用户。
        if (killedByUs) return;
        showNotification({
          title: '办事师爷的后台服务退出了',
          body: `进程退出码 ${code ?? '未知'}。重新打开办事师爷试一次；一直这样的话用「启动.cmd」手动起，看终端里的报错。`,
        });
      });
    }

    // 3. 等服务真的能答复了再 loadURL，不然是白屏或者连接被拒。
    const healthy = await waitUntilHealthy(PORT);
    createWindow(healthy);
    createTray();
    subscribeReminders();

    // I1（code review 修复）：`second-instance` 只覆盖「应用已经在跑」这一种
    // 情况——托盘退出过、或者机器重启过之后，通知中心里留着的旧 toast 被点
    // 「完成/推迟」时，协议激活拉起的是一个全新的进程，直接走这条
    // bootstrap()，根本碰不到 second-instance；协议 URI 混在 process.argv
    // 里却从没被读过——按钮点了任务没变化，窗口却因为正常启动流程意外弹了
    // 出来，比「点了没反应」更糟。deep-link 官方 recipe 的另一半：冷启动这
    // 条路也要用同一个 routeSecondInstance() 扫一遍 process.argv（跟
    // second-instance 那边共用同一份判断，不是各写一份），放在
    // waitUntilHealthy 之后——PATCH 需要服务已经起来才能成功。
    const coldStartRoute = routeSecondInstance(process.argv);
    if (coldStartRoute.kind === 'protocol') void applyProtocolAction(coldStartRoute.uri);

    // macOS 的 'open-url' 走的是事件不是 argv，而且**可能在这之前就到**（冷启动
    // 时点通知按钮：系统先拉起进程、再把 URL 发过来，不等我们的服务起好）。
    // 早到的先攒在 pendingUris 里，到这儿服务已经健康了，一起补发——直接在
    // 事件里 PATCH 的话那一次点击会静默失败，正是 I1 那条修的同一种坏法。
    serverReady = true;
    for (const uri of pendingUris.splice(0)) void applyProtocolAction(uri);
  } catch (e) {
    dialog.showErrorBox('办事师爷启动失败', (e as Error).message);
    app.quit();
  }
}

// 1. 单实例锁：拿不到说明另一个实例已经在跑，这一个直接让路。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 注册协议处理器：toast 上「完成」「推迟 10 分钟」两个按钮点击之后，
  // Windows 会把它们的 arguments（todo-desktop://complete?id=… 之类）当
  // 协议链接启动——这一步是那条路能走通的前提，见 notify.ts buildToastXml()
  // 和下面 applyProtocolAction() 的注释。开发模式（这个仓库明确禁止跑）下
  // Electron 官方文档建议额外传 process.execPath/argv 才能注册对路径，这里
  // 没做：打包后是固定的单文件 exe，不需要那份复杂度。
  if (!app.setAsDefaultProtocolClient(PROTOCOL)) {
    console.error(`注册协议 ${PROTOCOL}:// 失败——通知上「完成」「推迟 10 分钟」两个按钮点了不会有反应`);
  }

  app.on('second-instance', (_event, argv) => {
    // 新实例的命令行参数里如果有一条是我们的协议 URI，说明这次「第二个实例」
    // 其实是 toast 按钮触发的协议激活，不是真的有人又双击了一次 exe——
    // routeSecondInstance() 判断走哪条路（纯逻辑，跟冷启动那边共用同一个
    // 函数，见 bootstrap() 末尾和 protocol.ts）。找不到协议 URI 才是普通
    // 重复启动，照旧只是把窗口打开，跟这一批改动之前的行为一致。
    const route = routeSecondInstance(argv);
    if (route.kind === 'protocol') {
      void applyProtocolAction(route.uri);
    } else {
      openWindow();
    }
  });

  // macOS 上协议激活**不经过命令行参数**：系统把 URL 直接交给已经在跑的那个
  // 实例，发的是 'open-url'。Windows 那条是「新起一个进程、URI 在 argv 里，
  // 被单实例锁挡回来转成 second-instance」——同一件事，两套机制，最后落到同一个
  // applyProtocolAction()。Linux 走的是 Windows 那套（`.desktop` 里的
  // MimeType + argv），所以这个事件只有 mac 会发，挂着对另外两个平台无害。
  //
  // **必须挂在 whenReady() 之前**：冷启动那一次（应用没开着，点通知按钮把它
  // 拉起来）系统可能在 ready 之前就把事件发过来，挂晚了那一次点击就丢了。
  // `preventDefault()` 是 Electron 文档要求的，表示这条 URL 我们接了。
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (serverReady) void applyProtocolAction(url);
    else pendingUris.push(url);
  });

  // macOS：窗口是 hide 掉的（'close' 里 preventDefault），点 Dock 图标得能把它
  // 叫回来，不然只剩菜单栏图标一条路。这个事件另外两个平台不发。
  app.on('activate', () => openWindow());

  // 7. 退出：先置 quitting，'close' 处理器（见 createWindow）看到这个标志
  // 才会放行真正关闭窗口；再让子进程真的停下来，不留一个孤儿 node 进程。
  app.on('before-quit', () => {
    quitting = true;
    child?.stop();
  });

  void app.whenReady().then(bootstrap);
}
