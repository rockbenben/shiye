import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAll, syncAll } from './entityStore.js';
import { migrate } from './migrate.js';

// 模型层（类型/常量/默认值）切到了 `model.ts`：网页那边也要用它们，而这个
// 文件碰 node 内置，被打进网页包就是一次白屏。理由整段在 model.ts 顶上。
// **再导出**，所以服务端那几十处 `from './store.js'` 原样有效。
export * from './model.js';
import type { InboxItem, Insight, List, Folder, Countdown, Proposal, Settings, Task, TrashItem, OutboxEntry, OutboxUpdateEntry, OutboxInsightEntry } from './model.js';
import { DEFAULT_SETTINGS } from './model.js';


const here = dirname(fileURLToPath(import.meta.url));

/**
 * 数据目录。**每次调用现读环境变量**，不缓存成模块级常量——
 * 那样测试就必须抢在 import 之前设 DATA_DIR，而 import 是被提升的，抢不到。
 *
 * 默认值往上两级：src/ 和 dist/ 都在 server/ 下一层，所以开发和构建后指向同一处。
 */
export const dataDir = (): string => process.env.DATA_DIR ?? join(here, '..', '..', 'data');

/**
 * AI 那边的工作目录：默认是仓库根，Electron 打包后由 `AGENT_CWD` 显式指过来。
 *
 * 两条路都用它：CLI 那条拿它当子进程的 cwd（`AGENTS.md` 里全是
 * `data/inbox.json` 这样的相对路径），API 那条拿它去读 `AGENTS.md` 和
 * `workflows/*.md` 的原文当提示词。**曾经 expand.ts 里另有一份一模一样的
 * 定义**，收在这儿一份——两份的话，哪天打包路径变了只会有一边跟上。
 */
export const agentCwd = (): string => process.env.AGENT_CWD ?? join(here, '..', '..');

/** AI 看到的数据目录 = 它的 cwd 加上 `data/`。 */
export const agentDataDir = (): string => join(agentCwd(), 'data');

/**
 * 服务和它 spawn 出来的 AI，看的是不是同一个目录。
 *
 * **判据从「是不是仓库自带的那个 data/」换成了「两边相不相等」。** 换的原因是
 * 打包和同步：Electron 打包之后数据目录必然在 userData 或同步盘里，接上 WebDAV
 * 更是如此——老判据会把这两种正常情况全部当成事故，AI 拆解整个用不了。
 *
 * 守卫要防的那件事一个字没变，那是一次真实事故：做界面审查时另起一个
 * `DATA_DIR=<临时目录>` 的实例，它看见夹具收件箱里有待拆解条目、按时排了一次
 * 自动拆解，spawn 出去的 AI 却对着**真实**的收件箱跑了一遍。那次它判断「没什么
 * 要拆的」、一个字节没写，纯属运气好。
 *
 * 新判据照样拦得住那次事故（临时目录 ≠ 仓库 data/），而且能放行「两边一起搬到
 * 别处」这种本来就安全的情况。
 */
export const aiSeesSameData = (): boolean => resolve(dataDir()) === resolve(agentDataDir());

/**
 * 七个「一目录一张表」的目录路径。**不包含 settings**——它是扁平文件，
 * 而且不在 `data/` 里：装的是跟这台机器绑定的东西（webhook 地址、系统
 * 通知开关……），放进 `data/` 会跟着同步盘跑到别的设备上互相覆盖，见
 * `deviceConfigPath` 的注释。混在同一个返回值里，七个是目录、一个是文件，
 * 容易被当成目录误用。`readSettings`/`writeSettings` 直接拼自己的路径，
 * 见下面。**也不包含 `meta.json`**——那是 `migrate.ts` 自己的状态（记
 * schemaVersion），只有它一处会读写，这里加一个没有第二个调用点的键只是
 * 多一份「同一个路径两处拼」的风险（`OUTBOX_RE` 那条注释说的「不能各写一份、
 * 迟早飘」），`migrate.ts` 直接拼自己的 `join(dir, 'meta.json')` 更干净；
 * 而且它接收的 `dir` 参数不保证等于这里的 `dataDir()`（测试会直接传别的
 * 目录），从这里拼反而可能拼错。
 */
export const paths = () => ({
  inbox: join(dataDir(), 'inbox'),
  tasks: join(dataDir(), 'tasks'),
  proposals: join(dataDir(), 'proposals'),
  lists: join(dataDir(), 'lists'),
  folders: join(dataDir(), 'folders'),
  insights: join(dataDir(), 'insights'),
  countdowns: join(dataDir(), 'countdowns'),
  trash: join(dataDir(), 'trash'),
});

export const nowIso = (): string => new Date().toISOString();

/**
 * 原子写：先写同目录的 .tmp，再 rename 覆盖。写之前把当前内容备份成 `<file>.bak`。
 *
 * 原子写只保证「不会读到半截」，保证不了「新内容其实是错的」——写坏一次之后原来
 * 那份就永远没了。留一份 `.bak` 是唯一的退路：出问题手动把它改名换回来就行。
 * 只留最近一份，不是轮转历史：这不是版本控制，是「万一这次写错了」的兜底，
 * 一份够用，多份是自己给自己加负担。
 *
 * 这不是洁癖——AI 和网页会在任意时刻读这些文件，直接往目标文件上写的话，
 * 读到半个 JSON 的窗口是真实存在的。同目录 rename 在 POSIX 上原子，
 * Windows 上 Node 走的是 MoveFileEx + MOVEFILE_REPLACE_EXISTING，也会原子替换。
 *
 * 缩进 2 空格是有意的：这是接口文件，AI 要读、人要看 diff（现在唯一的调用方
 * 是 `writeSettings`，但格式约定不因为调用方只剩一个就该放松）。
 */
function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // 绝不静默回落到 fallback：那等于把用户唯一的一份数据当成空的，
    // 下一次写入就把它彻底盖掉了。宁可起不来。
    throw new Error(`${file} 不是合法的 JSON，先修好它（文件没有被改动）：${(e as Error).message}`);
  }
}

/**
 * 这些函数的**签名一个字都没变**，变的只是背后从「一个大数组文件」换成了
 * 「一目录一张表」。保留签名是有意的：`app.ts` 和 `outbox.ts` 到处在用
 * `readTasks()` / `writeTasks(all)` 这种「给我整份数组」的写法，改签名意味着
 * 同时重写这两个最复杂的文件，而它们装着 outbox 合并协议那一整套硬换来的
 * 规矩。换存储和重写协议是两件事，不该搅在一次改动里。
 *
 * `writeXxx(整份数组)` 落到磁盘上是增量的：`syncAll` 只写内容真变了的那几条，
 * 删掉不在新数组里的。所以「整份写」的调用方式没有变成「整份 IO」。
 */
export const readInbox = (): InboxItem[] => readAll<InboxItem>(paths().inbox);
export const writeInbox = (v: InboxItem[]): void => syncAll(paths().inbox, v);
/**
 * 磁盘上读回来的一条任务，**把「缺了会当场抛异常」的那几个字段补齐**。
 *
 * 只补集合类字段（数组），不做值的校验、不填业务默认值——那是
 * `migrate.ts` 的 `upgradeTask` 干的事（v1→v2 的完整升级），这里只挡
 * 「`undefined.length` / `undefined.some`」这一类当场崩。
 *
 * **数组里形状不对的元素也丢掉**（`tags`/`attachments` 是字符串数组，丢不是
 * 字符串的；另外三个是对象数组，丢不是对象的）。
 * 一条 `reminders: [null]` 就是同一类当场崩，只是位置深了一层：
 * `POST /api/push` 只认四个必填字段（有意宽松，理由在 push.ts），这样一条
 * 200 落盘之后，`ics.ts`、`reminder.ts`、`repeat.ts`、`mutate.ts` 五处解引用
 * `r.at` 一个都没设防——`toIcs` 抛了，`.ics` 从此冻在最后一版；`dueTasks` 抛了，
 * **所有任务的提醒**每 30 秒都在这一条上停下。推送侧那句「畸形数据看板上
 * 看得见、删得掉」在这儿不成立：卡片上什么都看不出来。修在读盘这一处，
 * 五个消费方一次全护住，比各处补一个 `r?.at` 强。
 *
 * 不用 `upgradeTask` 是因为 `migrate.ts` 已经 import 了这个文件，反向 import
 * 是真的运行时循环。
 */
const ARRAY_FIELDS = [
  'reminders', 'subtasks', 'tags', 'attachments', 'focusSessions',
] as const;

// 元素类型照 `model.ts` 的 `Task`：`tags`/`attachments` 是 `string[]`，其余是对象数组。
// 第一版把 `attachments` 也当成对象数组，读盘时把每个文件名都丢了——app.test.ts
// 里七条附件测试当场红。加字段时来这儿表个态。
const STRING_ARRAYS: ReadonlySet<string> = new Set(['tags', 'attachments']);
const wellFormed = (k: (typeof ARRAY_FIELDS)[number], x: unknown): boolean =>
  STRING_ARRAYS.has(k) ? typeof x === 'string' : typeof x === 'object' && x !== null;

function fillTaskShape(t: Task): Task {
  let out: Task | null = null;
  for (const k of ARRAY_FIELDS) {
    const v: unknown = t[k];
    if (Array.isArray(v) && v.every((x) => wellFormed(k, x))) continue;
    // 只有真缺了/真坏了才复制一份——绝大多数任务是完好的，不该每次读盘都造新对象。
    out ??= { ...t };
    (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? v.filter((x) => wellFormed(k, x)) : [];
  }
  return out ?? t;
}
/**
 * **读盘时把每条任务补成完整形状**（`upgradeTask`，幂等的纯函数）。
 *
 * 磁盘上的任务不全是这个服务自己写的：`POST /api/push` 从另一台设备收来的、
 * AI 写进 outbox 的、以及人手改的文件，都会落进 `data/tasks/`。而 `readAll`
 * 是一次裸 `JSON.parse`，缺字段就是 `undefined`。
 *
 * 实测复现过一条真实的拒绝服务：`POST /api/push` 只要求 `title`/`status`/
 * `createdAt`/`updatedAt` 四个字符串（`push.ts` 的 `looksLikeEntity`，它是**有意**
 * 宽松的），推一条没有 `attachments` 的进来 → 回执 200 说推成功 → 从此
 * `GET /api/tasks` 对**所有客户端**回 500（`app.ts` 那句 `t.attachments.length`），
 * 而且 `dueTasks` 的 `t.reminders.some` 一起抛，**每条任务的提醒全部停摆**。
 * 除非有人去手改文件，否则出不来。
 *
 * 补在读盘这一层，不是在每个调用点各加一次判空——那种要求漏一处就复发，
 * 而这个仓库已经有两处漏了（`app.ts` 的 attachments、`reminder.ts` 的 reminders；
 * `dailySummary.ts` 那两处倒是判了，那种不对称正说明它是漏的不是设计）。
 * 补的只有集合类字段，见上面 `fillTaskShape`——值的校验和 v1→v2 的完整升级
 * 仍然归 `migrate.ts` 的 `upgradeTask`，两者不重叠。
 */
export const readTasks = (): Task[] => readAll<Task>(paths().tasks).map(fillTaskShape);
export const writeTasks = (v: Task[]): void => syncAll(paths().tasks, v);
export const readProposals = (): Proposal[] => readAll<Proposal>(paths().proposals);
export const writeProposals = (v: Proposal[]): void => syncAll(paths().proposals, v);
export const readLists = (): List[] => readAll<List>(paths().lists);
export const writeLists = (v: List[]): void => syncAll(paths().lists, v);
export const readFolders = (): Folder[] => readAll<Folder>(paths().folders);
export const writeFolders = (v: Folder[]): void => syncAll(paths().folders, v);
export const readInsights = (): Insight[] => readAll<Insight>(paths().insights);
export const writeInsights = (v: Insight[]): void => syncAll(paths().insights, v);
export const readCountdowns = (): Countdown[] => readAll<Countdown>(paths().countdowns);
export const writeCountdowns = (v: Countdown[]): void => syncAll(paths().countdowns, v);
export const readTrash = (): TrashItem[] => readAll<TrashItem>(paths().trash);
export const writeTrash = (v: TrashItem[]): void => syncAll(paths().trash, v);

/**
 * 设备设置存在哪。**刻意不在 `data/` 里面。**
 *
 * 装的是 webhook 地址、系统通知开关、开机自启这类**跟这台机器有关**的东西。
 * 放进 `data/` 就会跟着同步盘跑到别的设备上互相覆盖——手机上关掉系统通知，
 * 电脑上的通知也跟着没了，而且没有任何提示。
 *
 * 顺序：环境变量 > 平台惯例位置。
 *
 * ⚠️ 这里原先写着「Electron 那边会用 `app.getPath('userData')` 显式传进来」，
 * **是假的**：`desktop/src/serverChild.ts` 给子进程的 env 是 `...process.env` 再
 * 补上 `PORT` / `DATA_DIR` / `AGENT_CWD` / `NO_OPEN` / `ELECTRON_RUN_AS_NODE`，
 * `DEVICE_CONFIG` 全仓除了这里和测试之外没有第二处写入。所以桌面版和 `启动.cmd`
 * 那条路**共用同一份设置**——这是对的（设置是「这台机器的」，不该按启动方式
 * 分家），只是跟原来那句话说的不是一回事。任务数据倒确实是分开的两份
 * （README「桌面版」一节）。
 *
 * **那个 `...process.env` 是承重的，别当成顺手写的。** 桌面版能读到跟 `启动.cmd`
 * 同一份设置，靠的就是它把 `APPDATA` 带给了子进程；换成只列那五个变量的「最小
 * env」，Windows 上 `process.env.APPDATA` 在子进程里就没了，下面这行会一路落到
 * `join(homedir(), '.config', 'shiye', 'device.json')`——桌面版从此读写另一个文件，
 * 不报错、不红，只是设置对不上了。反过来，用户系统环境里真有一个 `DEVICE_CONFIG`
 * 的话也会被继承进来并优先生效，这同样是那个 spread 带来的。
 *
 * 用 `||` 不用 `??`：环境变量读出来是空字符串（`.env` 里写一行
 * `DEVICE_CONFIG=` 就会这样，`APPDATA=`/`XDG_CONFIG_HOME=` 同理）也要落回
 * 默认值，`??` 只挡 `null`/`undefined`，挡不住空字符串——XDG 规范原文也是
 * 「未设**或为空**时用 `$HOME/.config`」。
 *
 * ⚠️ **下面那个 `'shiye'` 是写死的字面量，改它必须同时做两件事，否则就是事故。**
 * 它是 `device.json` 的家（Windows 上 `%APPDATA%\shiye\device.json`），里面躺着
 * 真实的用户设置。只改字符串的话，`readSettings()` 会去一个空目录读，静默落回
 * `DEFAULT_SETTINGS`：webhook 地址、系统通知开关这些当场失联，旧文件还在原地
 * 没人读，**全程不报一句错**。所以要改就得**配一次迁移**（读旧路径、搬过去）。
 *
 * 第二件事：**`desktop/src/main.ts` 里有一句 `app.setPath('userData', …)` 用的是
 * 同一个名字**。Electron 的 userData 默认按 `productName`（办事师爷）算，那句就是
 * 为了把它拉到这里来——让 `%APPDATA%` 下只出现一个文件夹，而不是「办事师爷」和
 * 「shiye」并排躺着、看着像两个应用。两处飘了不会报错，只会悄悄变回两个目录。
 * `scripts/identity-literals.test.ts` 守着这一对。
 *
 * 而且那半的代价比这半大得多：打包版的 `dataDir` 是从 `userData` 推出来的
 * （`desktop/src/paths.ts` 的 `resolvePaths()`），所以跟着改的不只是设置，是**整份
 * 任务数据**。`main.ts` 里的 `migrateLegacyUserData()` 就是为此补的一次搬家。
 *
 * 名字的来历：先是 `'035-todo'`（照抄仓库目录名），「待办 → 办事师爷」那次跟着
 * 改成 `'035-shiye'`，然后拿掉了 `035-` 这个序号前缀——那是 365 计划的编号，
 * 属于开发侧的事，没道理出现在用户的漫游配置目录里。
 *
 * ⚠️ **这两次都没有随代码发出去的迁移**：`migrate.ts` 里唯一跟设置有关的
 * `moveSettings()` 搬的是 `data/settings.json` → `deviceConfigPath()`，从来不认识
 * 旧的配置**目录名**；两次 commit 说的「配置已迁移」都是作者在自己机器上手搬的。
 * 当时的前提是「还没发布、装过旧版的只有一台机器」。以后再动这个字面量，前提
 * 大概率不成立了——那就得真在 `migrate.ts` 里加一条（读旧路径、目标已存在就不碰，
 * 照着 `moveSettings()` 的形状写），别再靠手搬。
 * `store.test.ts` 有一条断言钉着这个形状。
 */
export const deviceConfigPath = (): string =>
  process.env.DEVICE_CONFIG
  || join(process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'shiye', 'device.json');

/**
 * 还是走 `writeAtomic`/`readJson` 那一套（`.bak` 备份、坏 JSON 就抛，不静默
 * 回落默认值）——这条规矩没有因为搬了家而失效：`device.json` 现在是这个项目里
 * 少数几个「单个文件承载全部内容」的地方之一，正是这条规矩为它定的。
 */
export const readSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(deviceConfigPath(), {}) });
export const writeSettings = (v: Settings): void => writeAtomic(deviceConfigPath(), v);

/**
 * 匹配 `data/outbox-<unique>.json` 的文件名——不是固定的一个名字，是一类。
 * 两个 AI 进程（网页点的那次、终端里 `/expand` 的那次）同时写，原来的固定文件名
 * `outbox.json` 会互相覆盖；各写各的、文件名各不相同，谁都不会丢。
 *
 * 显式排除而不是靠「不在白名单里」的隐式排除：`.tmp`（半写的中间态，AI 也要按
 * 「写临时名再 rename」的规矩写它）和 `.bak`（change 4 引入的备份）都不该被当成
 * 待合并的输入——正则本身只认以 `.json` 结尾，这两类天然就不匹配。
 *
 * 导出给 `events.ts` 复用：目录监听器要认出「这次变化是不是 outbox 文件」，
 * 跟这里「列出所有 outbox 文件」用的是同一条规则，不能各写一份、迟早飘。
 */
export const OUTBOX_RE = /^outbox-.+\.json$/;

/**
 * 列出所有待合并的 outbox 文件，按文件名排序——合并顺序要稳定、可预测，不能
 * 随文件系统返回的顺序变。目录还没铺出来（全新 clone、服务还没起过一次）时
 * 直接当「没有」处理，不报错。
 */
export function outboxFiles(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => OUTBOX_RE.test(f)).sort().map((f) => join(dir, f));
}

/**
 * 长得像 outbox 文件、但踩不中 `OUTBOX_RE` 的文件名——最典型的是硬化之前的老
 * 名字 `outbox.json`（没有 `-<unique>`）。这类文件既不会被 `outboxFiles()` 列进
 * 待合并列表，也不会被 `events.ts` 的监听器认出来触发合并，会在 `data/` 里
 * 一直原样躺着，没有任何提示——调用方（`mergeOutbox`）负责把这个列表打成日志。
 *
 * 排掉 `.tmp`：AI 写 outbox 文件本来就要走「先写临时名再改名」的原子写，
 * 半写的中间态不该被当成一个写错了名字的文件报出来。
 */
export function strayOutboxFiles(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^outbox/i.test(f) && !OUTBOX_RE.test(f) && !f.endsWith('.tmp'));
}

/**
 * outbox 不在 `ensureDataFiles` 铺的那三个文件里——它不是常驻状态，是 AI
 * 拆解一次留下的临时产物，合并完就该消失。没有文件就是「没有待合并的东西」，
 * 这个空状态本身就合法，不需要预先铺一个空数组。
 */
export const readOutboxFile = (file: string): Array<OutboxEntry | OutboxUpdateEntry | OutboxInsightEntry> =>
  readJson<Array<OutboxEntry | OutboxUpdateEntry | OutboxInsightEntry>>(file, []);

/**
 * 服务自己写一个 outbox 文件——`aiApi.ts` 那条路专用（模型没有文件系统，
 * 这一步由服务代劳，见那边的 HANDOFF 注释）。
 *
 * **规矩跟 `workflows/expand.md` 要求 AI 遵守的完全一样**，一条都不能省：
 * 文件名带唯一后缀（同一时刻可能另有一个 `claude` 进程在写），先写 `.tmp`
 * 再改名（监听器有极小概率读到写到一半的半截 JSON），一次写完整个数组。
 * 两条路写出来的东西长得一模一样，后面的校验/合并/删除完全不用分辨来源。
 *
 * 不走 `writeAtomic`：那个会额外留一份 `.bak`，而 outbox 是合并完就该消失的
 * 临时产物——留下 `outbox-xxx.json.bak` 只会在 `data/` 里堆垃圾，
 * 还正好落在 `strayOutboxFiles()` 会当成「写错名字」报出来的形状里。
 */
export function writeOutboxFile(entries: unknown[]): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `outbox-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}
`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** 合并完（或者本来就是空数组）之后删掉它；本来就不存在就什么都不做。 */
export function deleteOutboxFile(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}

/**
 * 启动时把 `data/` 准备好。**先迁移再铺目录**：迁移要读旧的
 * `tasks.json`，铺目录不能抢在它前面把状态搅乱。
 *
 * 一实体一文件的形态下「铺空文件」这件事没有了——空目录就是空表，
 * 不需要预先写一个 `[]` 进去。这里只保证目录存在。
 *
 * outbox 不在这里边——它不是常驻状态，见 readOutboxFile 那处注释。settings
 * 也不在这里边：它现在是设备本地的 `device.json`，根本不在 `data/` 里，
 * `readSettings()` 本来就有默认值兜底，不存在不会报错，这里不用管它——
 * 已有的 `settings.json` 怎么搬去 `device.json`，是 `migrate()` 的事。
 */
export function ensureDataFiles(): void {
  mkdirSync(dataDir(), { recursive: true });
  const { migrated, counts } = migrate(dataDir());
  // 真实那次 v1→v2 会把 tasks.json/inbox.json/proposals.json 改名成 .v1、
  // 把里面的记录一条条搬进新目录——这是启动时唯一一次、不可逆的数据搬家，
  // 控制台不能一个字都不说。没有迁移发生（已经是 v2，或者全新 clone）时
  // 不打这行，避免每次正常启动都刷一句没意义的日志。
  if (migrated) {
    console.log(`[迁移] v1 → v2：tasks ${counts.tasks} 条，inbox ${counts.inbox} 条，proposals ${counts.proposals} 条，旧文件已改名成 .v1 保留`);
  }
  const p = paths();
  for (const d of [p.inbox, p.tasks, p.proposals, p.lists, p.folders, p.insights, p.countdowns, p.trash]) {
    mkdirSync(d, { recursive: true });
  }
}

export function newTask(partial: Partial<Task> & { title: string }): Task {
  const at = nowIso();
  return {
    id: randomUUID(),
    notes: '',
    status: 'todo',
    due: null,
    // 「开始时间」跟 due 同一类：新任务一律不设，也就是加这个字段之前的行为
    // （随时可以做）。
    startAt: null,
    endAt: null,
    reminders: [],
    persistentReminder: false,
    subtasks: [],
    source: 'user',
    aiComment: '',
    createdAt: at,
    updatedAt: at,
    // 顺序是人的判断，新任务一律从 null 开始（排在「今天」视图末尾），
    // 直到用户手动调过位置——见 2026-08-12-today-view.md。
    order: null,
    listId: null,
    section: null,
    tags: [],
    // 优先级是人的判断，跟 order 同一类：新任务一律从 0（无）开始。
    priority: 0,
    repeat: null,
    completedAt: null,
    postponeCount: 0,
    waitingFor: null,
    context: null,
    attachments: [],
    estimateMinutes: null,
    focusSessions: [],
    habit: false,
    // 置顶跟 order/priority 同一类，是人的判断：新任务一律不置顶。
    pinned: false,
    // 新任务没被回顾过。跟 completedAt 同一类：只有人真的做了那个动作才盖章。
    reviewedAt: null,
    parentId: null,
    ...partial,
  };
}

