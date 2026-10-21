import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { createApp } from './app.js';
import { Bus, watchData } from './events.js';
import { renameIntoPlace } from './entityStore.js';
import { toIcs } from './ics.js';
import { logLanWarningIfNeeded, resolveBindHost } from './lanBind.js';
import { mergeOutbox } from './outbox.js';
import { fireDailySummary, fireReminders } from './reminder.js';
import { dataDir, ensureDataFiles, readCountdowns, readInbox, readProposals, readSettings, readTasks } from './store.js';

/**
 * 办事师爷.ics：只读日历导出，落在 `dataDir()` 根下，**不是**实体目录之一——
 * `readAll`、`GET /api/conflicts`（扫的是 `paths()` 里那几个）都看不到它，
 * 不会被误判成同步冲突副本。
 *
 * ⚠️ **这个文件名是一条对外的路径，以后别再动它。** 它现在叫这个，是因为应用从
 * 「待办」改名成「办事师爷」时**这个项目还没发布、确定没有人订阅过旧名字**，才跟着
 * 一起改掉、把旧的 `待办.ics` 删了。这个前提只成立那一次：一旦有人拿日历 App 订上
 * 了，再改名的表现是——服务开始写新名字的那一份，旧文件成为 `data/` 里的孤儿，
 * 而订阅方还指着孤儿，那份日历静悄悄停在改名那一刻的内容上，**不报错、也没人会
 * 发现**。真要再改，得先想清楚已有订阅怎么迁移。
 *
 * 另外：**没有任何测试守着这个文件名**（`办事师爷.ics` 这个名字在测试里一次都没
 * 出现过），
 * 改错了不会红，只会让订阅方悄悄读到一个不存在的路径。
 *
 * 原子写：先写 `.ics.tmp` 再 rename，跟 `entityStore.writeOne` 同一套——
 * 同步客户端随时可能在读这个文件，不能让它读到写一半的内容。
 *
 * **内容没变就不写**：`toIcs` 现在是纯函数（`DTSTAMP` 也是从任务算出来的，
 * 不读时钟），同一份任务集合两次调用产出完全相同的字节。读一次现有文件比对，
 * 省掉的是每次任务变更之后同步客户端的一次上传——`.ics` 没变就不该有新版本。
 *
 * 写失败只记日志、不往外抛：日历导出失败不该拖垮整个应用。
 *
 * 这个函数（连同下面接线它的三处调用：启动时写一份、`bus.subscribe` 回调、
 * 30 秒心跳那次）没有测试——`server/src` 里没有同名测试文件的模块有四个
 * （`index.ts`、`model.ts`、`aiEndpoints.ts`、`chineseDays.ts`），历史如此。
 * 这批复盘的三条盲点（冲突副本堆积/单条坏数据拖垮全表/监听器挂了整个冻结）
 * 全落在这段没人看守的代码里，标出来但不为
 * 它硬造测试：起服务、绑端口、抢 EADDRINUSE 这些集成行为不值得为了覆盖率
 * 单独铺一套夹具。
 */
function writeIcsFile(): void {
  try {
    const file = join(dataDir(), '办事师爷.ics');
    const next = toIcs(readTasks(), readCountdowns());
    if (existsSync(file) && readFileSync(file, 'utf8') === next) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    // **改名带重试**（`entityStore.ts` 的 `renameIntoPlace`）：Windows 上
    // `renameSync` 会偶发 EPERM（目标文件刚写完、句柄还没完全释放）。这一份
    // 每 30 秒重写一次，是**订阅端拿到的日历**——抖一下就是手机上的日历停在
    // 上一版，而上面那个 catch 只打一行警告，不会有第二个人知道。
    renameIntoPlace(tmp, file);
  } catch (e) {
    console.warn('[ics] 导出 .ics 失败：', (e as Error).message);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const webDist = join(repoRoot, 'web', 'dist');

// 钉死到仓库根：`npm run dev -w server` 的 cwd 是 server/，让 env-file 自己按
// cwd 找，根目录的 .env 就被静默略过了——「开发时改端口不生效」查起来很冤。
// 生产（cwd=根）和开发（cwd=server/）读的是同一份。已存在的环境变量不覆盖，
// 跟 dotenv 同一条语义（实测 process.loadEnvFile 也是「先到先得」）。
// 文件缺席要当正常：.env 是可选的（模板在 .env.example），而 loadEnvFile 对
// 不存在的路径会抛 ENOENT——dotenv 是静默跳过。
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

ensureDataFiles();

// 设置（device.json，不在 data/ 里，见 store.ts 的 deviceConfigPath）仍然是
// 扁平文件、仍然「坏了就抛」（store.ts 的 readJson）——这里读一遍是让它在
// **启动这一刻**报出来（报错带着文件名），不是等第一个 API 请求换来一个
// 含糊的 500。AGENTS.md 向 AI 承诺过这一条，这句对 readSettings() 依然成立。
//
// tasks/inbox/proposals 三个不再是这句承诺的一部分：一目录一张表之后，单条
// 实体读坏了是 entityStore 跳过 + console.warn（「一千条里坏一条，不该让
// 另外 999 条也打不开」），这里调用它们读不出任何异常，也不代表数据是完整
// 的——**那一类坏文件现在界面上看得到了**：`readAll` 跳过它们的同时会记下来，
// `GET /api/broken` 报出去，网页顶上常驻一条「有 N 个文件打不开」的横幅
// （见 entityStore.ts 的 `listBroken`）。这几个调用还留着，是因为整个目录
// 本身不可读（比如被别的东西顶替成了一个文件）仍然会在这一步抛出来，
// 那是那条横幅兜不住的一种——它靠的正是「目录读得开、只有个别文件坏」。
readInbox();
readTasks();
readSettings();
readProposals();

const bus = new Bus();
const app = createApp(bus);

/**
 * **打磨稿只在夹具服务里端出去。** `tools/design-preview/` 是那三张表
 * （`batch1.html` / `batch2.html` / `floors.html`）加共用的 `drive.js` 和探针
 * `probe.js`——仓库里的内部审计稿，不是产品的一部分，所以它住在 `tools/` 而不是
 * `web/public/`：后者会被 Vite 原样拷进 `web/dist`，而 `web/dist` 整个进安装包
 * （electron-builder 的 extraResources），等于每个装好的应用都带着这套稿子、
 * `/design-preview/batch1.html` 对最终用户敞开。搬进 `tools/` 之后下面这块是唯一
 * 还认它的地方，而要它生效得显式带 `DESIGN_PREVIEW=1`（跑法见 CONTRIBUTING
 * 「加了界面就拍一眼」）。
 *
 * 顺序是承重的：这两条必须注册在下面 `/*` 那条 webDist 静态**之前**。反过来
 * 的话 `web/dist` 里只要还留着上一版构建的旧稿子，旧的那一份就会赢——而它坏的
 * 样子是「屏幕上跑的是旧机器、报错却长得像读数不对」，这个仓库在这上面白跑过
 * 一轮（见下面那条 no-store 的来历）。
 *
 * **这一层不许被缓存。** 这些文件不带哈希（不像 `/assets/*`），一轮取证里能改
 * 十几遍；浏览器按 `Last-Modified` 猜着缓存，于是「页面在跑旧的机器」——上一轮
 * 就是被这一条骗了一次：`drive.js` 里点开详情的重试逻辑已经改好，屏上报的还是
 * 老那句「首帧没等到」，白花一轮排查。只有这一层放弃缓存，资源那半边照旧
 * （带哈希，缓存越久越好）。
 */
const designPreviewRoot = join(repoRoot, 'tools', 'design-preview');
if (process.env.DESIGN_PREVIEW && existsSync(designPreviewRoot)) {
  app.use('/design-preview/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use(
    '/design-preview/*',
    serveStatic({
      root: designPreviewRoot,
      // 挂载点前缀和目录名都叫 design-preview，但 URL 不能直接当目录用：不剥掉
      // 前缀就会去找 tools/design-preview/design-preview/。
      rewriteRequestPath: (path) => path.replace(/^\/design-preview\//, ''),
    }),
  );
}

/**
 * **这一条 404 不看开关、永远注册**，为的是让「忘了带 `DESIGN_PREVIEW=1`」响得
 * 起来。没有它，这个请求会落到下面的 SPA fallback，拿到 200 + 一份 `index.html`，
 * 而 `drive.js` 把那个地址当 `<script>` 加载——满屏只报 `Unexpected token '<'`，
 * 跟「稿子没挂上」完全对不上号（那条绝对路径旁边写的就是这个教训）。
 * 注册在上面那块之后：稿子真在时轮不到它，只有「没挂上」或「这个文件真的不
 * 存在」才走到这儿。
 */
app.get(
  '/design-preview/*',
  (c) => c.text('打磨稿没有端出来：这一层只由带 DESIGN_PREVIEW=1 的夹具服务挂（跑法见 CONTRIBUTING「加了界面就拍一眼」）。', 404),
);

if (existsSync(webDist)) {
  // SPA 外壳绝不能被缓存：它里面写死了带哈希的资源文件名，浏览器缓存了旧的一份之后，
  // 重新构建拿到的仍是旧 HTML → 指向已经不存在的资源。资源本身带哈希，缓存多久都无所谓。
  const shell = (c: Context) =>
    c.html(readFileSync(join(webDist, 'index.html'), 'utf8'), 200, {
      'Cache-Control': 'no-store, must-revalidate',
    });

  // `/` 必须抢在 serveStatic 前面：静态中间件会把目录请求直接映射到 index.html
  // 并原样返回，那条路径上加不了响应头——最常用的入口恰恰会是唯一被缓存的那个。
  app.get('/', shell);
  app.use('/*', serveStatic({ root: webDist }));
  // SPA fallback：/word/x 这类深链接直接输网址也要能打开。/api/* 到不了这儿——
  // createApp() 末尾那条 `app.all('/api/*')` 注册在前，未知的 API 路径在那里就回了 JSON 404。
  app.get('*', shell);
}

/**
 * 端口 30035。选高位是因为 3000 上下太热闹（Node 默认 3000、Vite 5173、脚手架 3001/8080）；
 * 别落进 Windows 临时端口范围（49152 起）和浏览器的 ERR_UNSAFE_PORT 黑名单。
 * 30035 顺带对上了目录名 365/035-shiye。
 */
const port = Number(process.env.PORT) || 30035;
const url = `http://localhost:${port}`;

async function alreadyOurs(): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && ((await r.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

// serve() 是异步 listen，EADDRINUSE 以 'error' 事件到达、不会同步抛出——
// 包 try/catch 抓不到，进程会以未捕获异常收场。必须挂在返回的 server 上。
//
// hostname 默认钉死 127.0.0.1：不传的话 Node 会绑 `::`（所有网卡），同一个 Wi-Fi 上
// 任何人访问 `http://<这台机器的局域网 IP>:30035` 都能读到收件箱原文、删任务、
// 把 webhookUrl 改成他自己的地址（此后每条提醒都会把任务原文 POST 给他）。
// 这里没有登录也没有 host 校验，默认的防线就是不监听局域网。
//
// LAN=1 显式打开这条口子——手机要连桌面的服务就得走局域网，这是这个项目第一次
// 让 data/ 暴露到本机之外。`resolveBindHost`/`logLanWarningIfNeeded` 抽进
// lanBind.ts：这里（index.ts）历来没有测试文件（起真实端口监听没法在 vitest 里
// 断言「绑的是哪个 host」），判断逻辑和提示文案抽出去之后至少那一半是能测的；
// 起监听这个动作本身留在这儿手工验证（见 android/冒烟清单.md、README）。
const hostname = resolveBindHost(process.env);
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`办事师爷 ${url}`);
  console.log('这个窗口开着，网页才能用；用完关掉它就是停止，也可以按 Ctrl+C');
  console.log(`数据在 ${dataDir()}，AI 只写 outbox-*.json，服务负责合并进 tasks/inbox 并刷新网页`);
  logLanWarningIfNeeded(hostname);

  watchData(bus, dataDir());

  // 补一次启动时的合并：outbox-*.json 完全可能是上次服务没开着的时候 AI 留下的——
  // 文件监听器只对「之后」的变化起反应，看不到它启动前就已经在那儿的文件。
  // 没有匹配的文件（正常情况）时 mergeOutbox 内部扫到空列表，直接返回，无副作用。
  // 这一次扫描也顺带重试了上次因为校验失败而留在磁盘上的坏文件。
  mergeOutbox(bus);

  // 办事师爷.ics：启动时先按当前任务写一份（上面这次补合并如果真的合并了新任务，
  // 这里已经能看到最新状态），之后任务变了就重写——挂在已经在发的
  // data-changed{file:'tasks'} 上，不用另开一条文件监听路径。
  writeIcsFile();
  bus.subscribe((event, data) => {
    // 纪念日也进 .ics 了（见 ics.ts 里那段），所以它变了也得重写一次——
    // 只盯 tasks 的话，改一个生日日期，订阅方要等到下一次有任务变动才跟上。
    if (event === 'data-changed' && ['tasks', 'countdowns'].includes(String((data as { file?: string } | null)?.file)))
      writeIcsFile();
  });

  // 每 30 秒扫一遍到期任务。间隔可调是为了手工验证提醒时不用干等。
  //
  // 顺带在同一个心跳上补一次 writeIcsFile()：文件监听器只对 data-changed{tasks}
  // 起反应，而监听器本身会挂（events.ts 的 watcher.on('error')，WebDAV/网络挂载盘
  // 上常见）——挂了之后 `.ics` 会冻结在挂掉那一刻，手机上看到的是过时的日历，
  // 而且没有任何信号。这里是兜底，不是主路径：内容没变（见 writeIcsFile 的比较）
  // 就是一次内存里的 toIcs + 一次字符串比较，零额外写盘。
  const everyMs = Number(process.env.REMIND_INTERVAL_MS) || 30_000;
  setInterval(() => {
    void fireReminders(bus).catch((e: Error) => console.warn('[提醒] 这一轮出错：', e.message));
    // 每日概览搭同一趟 tick，不另起一个定时器：它要的判断（到点没有、今天
    // 发过没有）三十秒一次的精度绰绰有余，而多一个 setInterval 就多一处
    // 要在关服务时收拾的东西。
    void fireDailySummary(bus).catch((e: Error) => console.warn('[每日概览] 这一轮出错：', e.message));
    writeIcsFile();
  }, everyMs);

  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} ${url}`, () => {});   // 开不起来无所谓，网址已经打印出来了
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // 最常见的占用者就是上次没关掉的同一个应用。那种情况下正确的反应不是换端口，
  // 是告诉你「已经在跑了」——而不是甩一段 EADDRINUSE 栈追踪。
  void alreadyOurs().then((ours) => {
    console.log(ours
      ? `已经有一个「办事师爷」在 ${url} 上跑着了，网页直接打开 ${url} 就行，这个窗口可以关掉。`
      : `端口 ${port} 上有东西占着，但它没应答 /api/health，多半不是「办事师爷」自己。\n`
        + `在这个文件夹里建一个名叫 .env 的文本文件（旁边的 .env.example 就是样板，`
        + `复制一份改名也行），写一行 PORT=30045，再启动一次。`);
    process.exit(ours ? 0 : 1);
  });
});
