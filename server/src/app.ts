import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DEFAULT_SETTINGS, newTask, nowIso, paths,
  readCountdowns, readFolders, readInbox, readInsights, readLists, readProposals, readSettings, readTasks, readTrash,
  writeCountdowns, writeFolders, writeInbox, writeInsights, writeLists, writeProposals, writeSettings, writeTasks, writeTrash,
  type Countdown, type Folder, type InboxItem, type List, type Settings, type Task,
} from './store.js';
import type { Bus } from './events.js';
import { isSafeId, writeConflictCopy } from './entityStore.js';
import { checkPushEntries, decidePush, type PushEntry, type PushKind, type PushKindResult } from './push.js';
import { listAllConflicts, listAllBroken } from './conflicts.js';
import { toastRaw } from './reminder.js';
import { createAutoExpand } from './autoExpand.js';
import { createAgentRunner, type Spawner } from './expand.js';
import { aiKeyFrom, maskKey, testAi, type Fetcher } from './aiApi.js';
import { parseHhmm } from './dailySummary.js';
import { skipPatch } from './repeat.js';
import { checkTaskPatch, sanitizeProposalPatch } from './task.js';
import { INK_AI, checkFolderPatch, checkListPatch } from './list.js';
import { checkCountdownPatch } from './countdown.js';
import {
  appendExpandNote, applyReorder, applyTaskPatch as applyTaskPatchPure, checkParentLink, detachDeletedTasks, hasTwinInstance,
  cascadeAll, maybeSpawnNextInstance, patchMany, restoreFromTrash,
  softDeleteTasks,
} from './mutate.js';
import {
  AttachmentValidationError, MAX_ATTACHMENT_BYTES, listAttachments,
  removeAllAttachments, removeAttachment, resolveAttachment, saveAttachment,
} from './attachments.js';

const MIN_AUTO_EXPAND_DELAY_SEC = 10;
const MAX_AUTO_EXPAND_DELAY_SEC = 3600;
const MIN_FOCUS_MINUTES = 1;
const MAX_FOCUS_MINUTES = 180;
const MAX_BREAK_MINUTES = 60;

/**
 * `/api/health` 里带的接口版本号——手机上 Capacitor 打包的那份 `web/` 是装 APK
 * 那一刻的快照，桌面这边的服务可能在那之后升级过（反过来也一样：先升级手机
 * 上的壳，桌面服务还没跟上）。只在真的出现不兼容改动时才手动加一（不是每次
 * 提交都加，也不跟着 `package.json` 的 `version` 走——那个号是给人看的发布号，
 * 这个号是给客户端判「能不能对话」用的，两者升级节奏不同）。
 *
 * `web/src/components/ServerSetup.tsx` 的 `CLIENT_API_VERSION` 手动保持一致，
 * 跟根 `CLAUDE.md` 里 `web/src/types.ts` 手动同步 `model.ts` 那批类型是同一个
 * 套路——一个整数常量的同步负担远小于一整个 interface，先不为它搭一份专门的
 * 跨包同步测试。
 */
export const API_VERSION = 1;

/**
 * CORS 只放行手机 WebView 的两个 origin：`http://localhost`——**现在唯一真的会发生
 * 的那个**，`capacitor.config.ts` 把 `server.androidScheme` 显式设成了 `'http'`
 * （不设的话 Capacitor 8 Android 端默认 `'https'`，WebView 的 origin 会变成
 * `https://localhost`，不在这份白名单里，而且是安全上下文，fetch 局域网明文地址会被
 * Blink 当成主动混合内容拦掉——见 `final-review.md` C1，这一批真的漏过一次）；和
 * `capacitor://localhost`——**iOS** 的默认 scheme，这个项目还没有 iOS 工程，留着
 * 是给以后用，Android 从来不会发这个 origin。
 *
 * `scripts/capacitor-origin.test.ts` 把这两处按字面串起来：`capacitor.config.ts`
 * 写的 `androidScheme` 是哪个，就要求这里有对应的 `${scheme}://localhost`——两处
 * 各写一份、其中一处忘了改，那条测试会红，不用等真机才发现连不上。
 *
 * 局域网地址是用户运行时填的，构建期不知道是哪一个，也没有第三个允许的 origin
 * ——**不是 `*`**：这台服务上跑着全部任务，没有认证，`*` 等于把它们对任何能构造出
 * 跨源请求的网页开放（但即使配成白名单，CORS 挡的也只是「读回响应」，不是认证边界，
 * 见下面 `corsForAllowedOrigins` 那段注释）。
 */
export const ALLOWED_ORIGINS = ['capacitor://localhost', 'http://localhost'];

const corsForMobile = cors({ origin: ALLOWED_ORIGINS });

/**
 * **桌面同源的行为必须一个字节不变**（上限断言）——`hono/cors` 的中间件即使
 * origin 没命中白名单，只要 `opts.origin !== '*'` 就会在响应上无条件加一条
 * `Vary: Origin`（见它自己的源码：`await next(); if (opts.origin !== '*')
 * c.header('Vary', 'Origin', ...)`，这一步跟当次请求的 origin 匹不匹配无关）。
 * 桌面（`启动.cmd`/Electron 打开的都是同源请求）今天完全没有任何 CORS 头，直接
 * `app.use('*', cors(...))` 会让桌面响应也悄悄多出这一个头——达不到「逐字节不变」。
 *
 * 这里在 `cors()` 外面再包一层：只有请求的 `Origin` 命中这两个白名单之一，才把
 * 这次请求交给 `cors()` 中间件处理；其余（桌面没有 `Origin` 头，或者任何第三方
 * 网页的 origin）直接 `next()`，`cors()` 整个不参与，响应上不会多出任何字节。
 *
 * **这不是认证边界，只是「浏览器能不能把响应读回去」的边界**（final-review.md
 * I3/I1）。它只管跨源 `fetch`/`XHR` 读不读得到响应体：
 * - 非浏览器的调用方（curl、脚本、别的 App）完全不经过这层——请求照样打得进来，
 *   只是发起方本来就不需要“读回响应”这件事，CORS 从头到尾没有机会参与。
 * - 浏览器发的**简单请求**（GET，以及 `POST` + 简单 `Content-Type`）不触发预检，
 *   照样打得进来，只是发起页面读不到响应——副作用（写库、触发 AI 拆解）照做不误。
 * `LAN=1` 时真正兜底的是 `LAN_WARNING` 那句提示，不是这层白名单——见
 * `lanBind.ts`、`docs`/`冒烟清单.md` 里对 `/api/expand`、`/api/review` 和 `webhookUrl` 的说明。
 */
function corsForAllowedOrigins(c: Context, next: () => Promise<void>) {
  const origin = c.req.header('origin');
  return origin && ALLOWED_ORIGINS.includes(origin) ? corsForMobile(c, next) : next();
}

/**
 * `autoExpandDelaySec` 校验：越界就夹回 [10, 3600]，不是拒掉整个请求。
 *
 * 跟这条路由里别的字段（`webhookUrl`/`toastEnabled`）是同一种脾气——类型不对
 * 就落回默认值，不 400。零或负数会让去抖形同虚设（design 文档原话），必须挡；
 * 但挡的方式选夹紧不选拒绝：这是本地单人小工具的设置页，用户在数字输入框里
 * 手滑打出 5 或者 99999，体验应该是「自动帮你收回到能用的范围」，不是弹一个
 * 400 让他猜错在哪、还要重填一遍其它字段。真正需要硬拒绝的是「不可信来源写坏
 * 数据」，而这条路由本来就只有本机用户自己在用（服务钉死 127.0.0.1，见
 * index.ts C1 的注释）。
 */
function clampAutoExpandDelaySec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.autoExpandDelaySec;
  return Math.min(MAX_AUTO_EXPAND_DELAY_SEC, Math.max(MIN_AUTO_EXPAND_DELAY_SEC, v));
}

/**
 * `focusMinutes` 校验：同一个脾气——夹到 [1, 180]，不是拒掉整个请求。
 * 零或负数会让番茄钟形同虚设（倒计时立刻结束，或者根本没有时长可言），跟
 * `autoExpandDelaySec` 那条注释是同一个道理，必须挡；上限 180 分钟（3 小时）
 * 单纯是个宽松的兜底，不让手滑打出的天文数字进设置页。
 */
function clampFocusMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.focusMinutes;
  return Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, v));
}

/**
 * `breakMinutes` 校验：同一个脾气，夹到 [0, 60]。**下限是 0 不是 1**——
 * 0 有明确含义「不休息」，是加这个字段之前的行为，得留得住；上限 60 分钟，
 * 歇得比专注还久就不是休息了，是换了件事做。
 */
function clampBreakMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.breakMinutes;
  return Math.min(MAX_BREAK_MINUTES, Math.max(0, v));
}

/** 请求体解析失败一律当 null，由各路由自己决定回 400 还是用默认值。 */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * RFC 5987 `filename*` 的百分号编码。`encodeURIComponent` 不转义 `'()*`——这几个
 * 字符在 `ext-value` 语法里是保留字符，而且附件文件名经常真的带括号：
 * `dedupeName`（attachments.ts）重名去重就是往文件名后面插 ` (2)` 这种后缀，
 * 不额外转义括号的话生成的 header 值本身就是歧义的。
 */
function encodeFilenameStar(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 下载响应的 `Content-Disposition`：中文文件名走 `filename*=UTF-8''…`，同时给一个
 * ASCII 回退（`filename=`，给不认 `filename*` 的老客户端）。ASCII 回退只需要不跟
 * 引号/反斜杠打架（`filename="…"` 是 quoted-string），不需要真的可逆——真正的名字
 * 靠 `filename*` 那份精确版本。
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'attachment';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeFilenameStar(name)}`;
}

/**
 * 完成/删除/打补丁三件写入语义已经搬进 `mutate.ts`（平台无关的纯函数，
 * server 和 web 共用，见那个文件顶部的注释）。这里留一个同名的薄包装。
 *
 * 下面三个调用点（批量 PATCH、单条 PATCH、接受提议）**全部显式传第三个参数**
 * `nowIso()`——纯函数不读时钟这条性质一路延伸到路由层，不靠这里的默认参数兜底。
 * 默认参数留着**只是为了 `applyTaskPatch.test.ts`**：那份既有测试直接
 * `import { applyTaskPatch } from './app.js'`、按 2 个参数调用（断言落在
 * 「调用前」到「现在」区间），不许改，`now` 就得在这一层落回真实时钟。
 */
export function applyTaskPatch(prev: Task, patch: Partial<Task>, now: string = nowIso()): Task {
  return applyTaskPatchPure(prev, patch, now);
}

function emptyPushResult(): PushKindResult {
  return { pushed: [], cleared: [], conflicted: [] };
}

const PUSH_KIND_LABEL: Record<PushKind, string> = { tasks: '任务', inbox: '收件箱' };

/**
 * 整批 400 的时候说得出**是哪一条**（Task 8）。
 *
 * 为什么这件事值得多写一段：一条畸形条目会让手机上**所有**离线改动**永远**推不回去
 * （手机一个记号都不清，下次原样重推、原样 400），而这个状态**不可自愈**——用户看不到
 * 是哪条卡住的，就没有任何手段去修它。服务端本来就知道（它刚判完），把这个信息扔掉太可惜。
 *
 * **判据仍然只有 `checkPushEntries` 这一份**：这里不另抄一套「什么算合形状」，而是**拿它
 * 自己去逐条量**（`checkPushEntries([e], kind)`），第一条量不过的就是它。多跑一遍的代价只
 * 落在已经失败的那条路上，而且个人量级的条目数本来就很小。
 *
 * 反过来（把 `checkPushEntries` 的返回改成带「哪条坏了」的联合类型）也做得到，但那要重写
 * 它 24 条既有测试里的 15 条断言——每改一条都是一次把现有守卫改弱的机会，而换来的行为
 * 一模一样。
 *
 * **`i < 0` 那支不是防御性代码**：`checkPushEntries` 今天逐条独立判，整批不过就一定有某条
 * 单独也不过。以后要是加了跨条目的校验（比如「同一批里 id 不许重复」），逐条重量就会全都
 * 通过，这一支会**说实话说不出是哪条**，而不是编一个第 1 条出来。
 */
function whichEntryIsBad(v: unknown, kind: PushKind): string {
  const label = PUSH_KIND_LABEL[kind];
  if (!Array.isArray(v)) return `${label}那一半根本不是一个数组`;
  const i = v.findIndex((e) => checkPushEntries([e], kind) === null);
  if (i < 0) return `${label}那一半整批不合形状（逐条重量了一遍反倒都过了，说不出是哪条）`;
  const id = (v[i] as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== ''
    ? `${label}里的「${id}」（第 ${i + 1} 条）`
    : `${label}第 ${i + 1} 条（它连 id 都不是个非空字符串）`;
}

/**
 * 「只差大小写」的 id 判据，两条推送共用。盘上有 `foo` 时推上来一个 `Foo`：
 * `byId.has('Foo')` 是 false，会被当成新建——而 Windows 上那是同一个文件，`foo`
 * 那条会被静默换掉（理由和平台说明见 entityStore.ts 的 `assertNoCaseCollision`）。
 * 存储层有最后一道（拒绝写入、抛错），但抛到路由里会让**整批**推送 500、手机上
 * 所有离线改动一起卡住；这里把这种 id 判成撞车、写副本，别的照推。
 */
function caseClashIn(ids: string[]): (id: string) => boolean {
  const folded = new Map(ids.map((id) => [id.toLowerCase(), id]));
  return (id) => {
    const other = folded.get(id.toLowerCase());
    return other !== undefined && other !== id;
  };
}

/**
 * `POST /api/push` 的收件箱那一半。**这一半之内**先算完全部判定、再动文件（计划②）：
 * 一次读、至多一次写，不是每条一次——每次独立写都是一轮目录监听器 → SSE 广播 →
 * 所有页面 refetch，这正是这个仓库那三条批量端点存在的理由。
 *
 * **「先算完再动」的范围只到这一半为止，跨两半不成立**：这一半的文件在
 * `applyTasksPush` 开始判定之前就已经落盘了。代价是可接受的，不是漏了——任务那半抛错
 * 会 500，手机一个记号都不清、下次原样重推，而这一半已经落盘的那些条目重推时
 * 「服务端 == 我那份」→ 判 `clear`，不重复写、不写副本。幂等，无丢失。
 *
 * 跟下面 `applyTasksPush` **不合并成一个泛型函数**：任务那边多了软删除、引用清理、
 * 重复任务查重三件事，硬套一份泛型会写出一堆 `if (kind === 'tasks')`，比两份短函数难读。
 * 代价是**两半的绿互相保不了对方**：这一半每一格都要有自己的测试。
 */
function applyInboxPush(entries: PushEntry[], now: string): PushKindResult {
  const res = emptyPushResult();
  if (entries.length === 0) return res;
  const all = readInbox();
  const byId = new Map(all.map((x) => [x.id, x]));
  const upserts = new Map<string, InboxItem>();
  const removes = new Set<string>();
  // `deletedAt?` 只为删除撞车那一格：`Task`/`InboxItem` 都没有这个字段（只有垃圾箱里的
  // `TrashItem` 有），它是这一层现盖的一句注解，见 entityStore.writeConflictCopy 的注释。
  const copies: { id: string; deletedAt?: string }[] = [];
  const caseClash = caseClashIn(all.map((x) => x.id));
  for (const e of entries) {
    const verdict = caseClash(e.id) ? 'conflict' as const : decidePush(e, byId.get(e.id));
    if (verdict === 'clear') { res.cleared.push(e.id); continue; }
    if (verdict === 'conflict') {
      res.conflicted.push(e.id);
      // 删除撞车写的是**基准**（计划③）：手机那份长什么样对「删不删」没有影响，
      // 而基准正是它决定删它时看到的那一版；加上 `deletedAt` 之后这份文件自己就
      // 说清楚了「另一台设备把这个版本删了」。
      copies.push(e.op === 'delete'
        ? { ...(e.base as object), id: e.id, deletedAt: now }
        : (e.value as { id: string }));
      continue;
    }
    res.pushed.push(e.id);
    if (e.op === 'delete') removes.add(e.id);
    else upserts.set(e.id, e.value as InboxItem);
  }
  if (upserts.size > 0 || removes.size > 0) {
    const next = all.filter((x) => !removes.has(x.id)).map((x) => upserts.get(x.id) ?? x);
    for (const [id, v] of upserts) if (!byId.has(id)) next.push(v);
    writeInbox(next);
  }
  // **不 try/catch**：写副本抛了就整条路由 500，手机拿不到回执、记号原样留着、下次
  // 重推（重推是幂等的，副本名按内容算哈希）。吞成「部分成功」等于手机那份在服务端
  // 没有、在副本里也没有、记号还被清了——见 entityStore.writeConflictCopy 的注释。
  for (const copy of copies) writeConflictCopy(paths().inbox, copy);
  return res;
}

/**
 * `POST /api/push` 的任务那一半。比收件箱那半多三件事：软删除（进垃圾箱）、
 * 清掉指向被删任务的引用、重复任务的第二道查重。
 */
/**
 * 一条任务**给客户端看的样子**：`attachments` 以磁盘为准（`listAttachments`，
 * 排过序）。`GET /api/tasks` 一直是这么给的；**三方比较也必须拿这一份当
 * 「服务端那份」**——客户端手里的基准正是从 GET 来的。
 *
 * 不然就是一条永远好不了的假撞车：上传「报告.pdf」再上传「合同.pdf」，盘上的
 * JSON 按上传顺序存，GET 按排序给（「合」排在「报」前面），手机把排过序的那份
 * 存成基准；离线改一下标题推回来，`decidePush` 拿盘上那份比：跟 `value` 不同
 * （标题改了）、跟 `base` 也不同（数组顺序不同，`stableKey` 有意对数组顺序敏感）
 * → `conflict`。改动推不回去、写一份副本、而盘上那份永远不会被纠正——**每次
 * 联网都再撞一次**，直到他重新上传一遍附件。
 */
const asServed = (t: Task): Task =>
  t.attachments.length === 0 ? t : { ...t, attachments: listAttachments(t.id) };

function applyTasksPush(entries: PushEntry[], now: string): PushKindResult {
  const res = emptyPushResult();
  if (entries.length === 0) return res;
  const all = readTasks();
  // 比较用「给客户端看的样子」（理由见 asServed）；写回去的 `next` 仍从 `all` 起，
  // 没动的那几条不因为比较换了视角就被重写一遍。
  const byId = new Map(all.map((t) => [t.id, asServed(t)]));
  const upserts = new Map<string, Task>();
  const removes = new Set<string>();
  // `deletedAt?` 只为删除撞车那一格：`Task`/`InboxItem` 都没有这个字段（只有垃圾箱里的
  // `TrashItem` 有），它是这一层现盖的一句注解，见 entityStore.writeConflictCopy 的注释。
  const copies: { id: string; deletedAt?: string }[] = [];
  const caseClash = caseClashIn(all.map((t) => t.id));
  for (const e of entries) {
    let verdict = caseClash(e.id) ? 'conflict' as const : decidePush(e, byId.get(e.id));
    // **重复任务的第二道守卫**（第一道是这条路由压根不跑生成语义，见路由顶部）：
    // 手机离线完成一条重复任务时本地已经生成了下一条实例，它作为「离线新建」推上来；
    // 要是桌面上也完成过同一条、也生成了一条，两条会并存——同标题同 due 的两张卡，
    // 而用户只完成过一次。`hasTwinInstance` 是 `maybeSpawnNextInstance` 内部用的同一份
    // 查重判据（`mutate.ts`），不是这里另写的第二份。
    //
    // **判成同款之后走 `conflict`（写副本），不是 `clear`。同一份判据，两层的处理刻意
    // 不一样——不是哪边写漏了，别顺手「修」成一致。** 差别在判错的代价：
    // - 在 `mutate.ts` 那层判太紧，代价是「这一次没生成下一条」，用户再碰一下那条任务
    //   就有了；
    // - 在**推送这层**判太紧，代价是「**这条实体不存在了**」——`clear` 会让手机清掉记号，
    //   本地那条随下一次回填消失，服务端从来没有过它，notes/tags/priority 一起没，
    //   而且没有任何信号。
    // 而撞车是真实的，不是理论：全天任务的 `due` 是当天本地零点的 ISO 串，同一天同标题
    // 必然逐字节相同，「手机离线看不到桌面那条、于是重记了一条」正好落在这个判据上。
    // 走 `conflict` 的代价是机器生成的重复实例撞车时多一份冲突副本（噪音），但那是
    // **看得见、删得掉**的——这个仓库的信条是「看得见的错，好过看不见的丢」。
    //
    // 限定在 `repeat` 非空的条目上：那份判据只看服务端那一行有没有 repeat，不看候选者
    // 有没有——不加这个条件的话，手机上真的新建的一条普通任务只要撞上一条同标题同 due
    // 的重复任务，就会被判成撞车、白写一份副本。
    if (verdict === 'push' && e.op === 'upsert' && e.base === null
        && (e.value as Task).repeat && hasTwinInstance(all, e.value as Task)) {
      verdict = 'conflict';
    }
    if (verdict === 'clear') { res.cleared.push(e.id); continue; }
    if (verdict === 'conflict') {
      res.conflicted.push(e.id);
      copies.push(e.op === 'delete'
        ? { ...(e.base as object), id: e.id, deletedAt: now }
        : (e.value as { id: string }));
      continue;
    }
    res.pushed.push(e.id);
    if (e.op === 'delete') removes.add(e.id);
    else upserts.set(e.id, e.value as Task);
  }

  if (upserts.size > 0 || removes.size > 0) {
    let next = all.map((t) => upserts.get(t.id) ?? t);
    for (const [id, v] of upserts) if (!byId.has(id)) next.push(v);
    // **手机重建的 id 从垃圾箱里摘掉。** 离线删 → 连上推回去（服务端把它搬进
    // 垃圾箱）→ 又离线、从手机的垃圾箱还原 → 再推：这一条以 `base: null` 的
    // upsert 到达，`decidePush` 判「直接创建」，写进 `data/tasks/`——而
    // `data/trash/<id>.json` 还在。一条任务同时活在两边，界面上看不出来；直到
    // 他点「清空垃圾箱」，`removeAllAttachments` 按垃圾箱里的 id 逐个删附件目录，
    // **把一条活着的任务的附件删光**。
    let trash = readTrash();
    let trashDirty = false;
    if (trash.some((x) => upserts.has(x.id))) {
      trash = trash.filter((x) => !upserts.has(x.id));
      trashDirty = true;
    }
    if (removes.size > 0) {
      // 软删除：搬进垃圾箱，不是抹掉——跟 DELETE /api/tasks 共用 mutate.ts 那一份。
      const soft = softDeleteTasks(next, trash, removes, now);
      trash = soft.trash;
      trashDirty = true;
      next = soft.tasks;
      // 收件箱的 taskIds、这些任务名下的提议：为什么要清、为什么没东西清的时候一个字
      // 都不写，见 mutate.ts 的 detachDeletedTasks 注释。这里的 `readInbox()` 读到的
      // 已经是本次推送写过的收件箱——路由里收件箱先跑，就是为了这一步。
      const refs = detachDeletedTasks(readInbox(), readProposals(), removes);
      if (refs.inbox) writeInbox(refs.inbox);
      if (refs.proposals) writeProposals(refs.proposals);
    }
    if (trashDirty) writeTrash(trash);
    writeTasks(next);
  }
  for (const copy of copies) writeConflictCopy(paths().tasks, copy);
  return res;
}

/**
 * `fetchFn` 只为「调接口」那条路可测：叫 AI 和「测试连接」都从这一个口子出去，
 * 测试注入一个假的就能把两条都盖住，不用各自 mock 全局 `fetch`。
 */
export function createApp(bus?: Bus, spawnFn?: Spawner, fetchFn: Fetcher = fetch): Hono {
  const app = new Hono();
  app.use('*', corsForAllowedOrigins);
  const agentRunner = createAgentRunner(bus, spawnFn, undefined, fetchFn);
  const autoExpand = createAutoExpand(bus, agentRunner);

  // version：桌面本机探活（index.ts 的 alreadyOurs()、desktop/src/serverChild.ts
  // 的 isHealthy()）只看 ok，多出这个字段不影响它们——两处都只判断
  // `json.ok === true`，没有校验整个对象形状。加它是为了手机那条路：
  // ServerSetup.tsx 的「测试连接」要能分清「不是办事师爷」和「是办事师爷但版本对不上」，
  // 没有这个字段就永远只有二选一。
  app.get('/api/health', (c) => c.json({ ok: true, version: API_VERSION }));

  // 没传 bus 就不注册这条路由：API 单测里的 createApp() 不需要一个开着的长连接。
  if (bus) {
    app.get('/api/events', (c) => {
      // 桌面端（Electron）订阅时带 `?client=desktop`，跟网页订阅区分开——网页也是
      // 订阅者，但网页开着不代表有人能收到原生通知，不能拿「有没有 SSE 连接」当
      // 判据（events.ts 的 Bus#isDesktopOnline 顶部注释有完整理由）。
      const isDesktop = c.req.query('client') === 'desktop';
      return streamSSE(c, (stream) => {
        if (isDesktop) bus.connectDesktop();

        const off = bus.subscribe((event, data) => {
          void stream.writeSSE({ event, data: JSON.stringify(data) });
        });

        // 心跳：长时间一个字节不发的连接会被浏览器和中间层掐掉。桌面端连接顺带
        // 拿它刷新在线时间戳（isDesktopOnline 的 TTL 靠它续命）——unref 是为了
        // 它别把进程钉住，正常情况下 onAbort 会清掉它，但客户端消失得不干净时
        // （测试里就会）留一个 25 秒的定时器很烦人。
        const beat = setInterval(() => {
          void stream.writeSSE({ event: 'ping', data: '' });
          if (isDesktop) bus.markDesktopOnline();
        }, 25_000);
        beat.unref?.();

        // **这个 Promise 是必须的**：streamSSE 的回调一 resolve，Hono 就把流关掉了。
        // 用 `await sleep()` 循环也行，但那样断开之后还挂着一个没到期的定时器。
        return new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(beat);
            off();
            // 桌面端干净断开（应用退出/连接中止）立刻标记离线，不等心跳窗口
            // 过期——见 Bus#disconnectDesktop 的理由（引用计数，两条桌面端
            // 连接同时活着时，断开其中一条不会牵连另一条）。
            if (isDesktop) bus.disconnectDesktop();
            resolve();
          });
        });
      });
    });
  }

  // 桌面端「在线」（有 SSE 连接）不等于它自己的 Electron 通知真的弹出来了——
  // 用户在系统里把「办事师爷」的通知关掉了、或者 AUMID 没注册好，`Notification.show()`
  // 会静默失败，只有一个 'failed' 事件（desktop/src/main.ts 原来只把它落到控制台
  // 日志）。这种情况下 fireReminders 已经因为「桌面端在线」把 PowerShell 兜底关了，
  // 两条 OS 通知路径同时哑掉，只剩窗口内横幅（窗口默认隐藏在托盘）和 webhook。
  // 桌面端发现自己弹失败时上报到这里，服务端就地补发一条 PowerShell——不等下一轮
  // 30 秒扫描（那条提醒的 firedAt 已经盖过章，fireReminders 不会再管它，唯一能
  // 再弹一次的路径就是这里）。不依赖 bus，不用判断有没有连接。
  app.post('/api/desktop/notify-failed', async (c) => {
    const body = (await jsonBody(c)) as { title?: unknown; body?: unknown } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ ok: false }, 400);
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    await toastRaw(title, text);
    return c.json({ ok: true });
  });

  // ── 收件箱 ──

  app.get('/api/inbox', (c) => c.json(readInbox()));

  app.post('/api/inbox', async (c) => {
    const body = (await jsonBody(c)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: '文本不能为空' }, 400);
    const item: InboxItem = { id: randomUUID(), text, createdAt: nowIso(), processed: false, taskIds: [] };
    writeInbox([...readInbox(), item]);
    return c.json(item, 201);
  });

  app.patch('/api/inbox/:id', async (c) => {
    const body = (await jsonBody(c)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400);
    if ('processed' in body && typeof body.processed !== 'boolean') return c.json({ error: 'processed 必须是布尔值' }, 400);
    if ('taskIds' in body && !(Array.isArray(body.taskIds) && body.taskIds.every((x) => typeof x === 'string'))) {
      return c.json({ error: 'taskIds 必须是字符串数组' }, 400);
    }
    // 跟 POST /api/inbox 同一套判据：非空字符串，首尾去空白。这是信任边界——
    // 网页不是唯一的客户端，判据只在这一处实现，不在前端另外挡一遍。
    let text: string | undefined;
    if ('text' in body) {
      text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return c.json({ error: '文本不能为空' }, 400);
    }
    const all = readInbox();
    const i = all.findIndex((x) => x.id === c.req.param('id'));
    if (i < 0) return c.json({ error: '没有这一条' }, 404);

    // 只有未处理的条目能改文字：已拆解的条目任务已经生成了，改原文不会重拆，
    // 编辑了也没有意义。**想要一个不一样的拆法，走「重新拆解」那颗按钮**——
    // 那儿能直接写一句「哪儿不对」（见下面 /redo 那条路由），比回头改原话直接。
    if (text !== undefined && all[i].processed) {
      return c.json({ error: '已处理的条目不能改文字。想重拆就点「重新拆解」，在那儿写一句哪儿不合适' }, 400);
    }

    const next: InboxItem = {
      ...all[i],
      ...('processed' in body ? { processed: body.processed as boolean } : {}),
      ...('taskIds' in body ? { taskIds: body.taskIds as string[] } : {}),
      ...(text !== undefined ? { text } : {}),
    };
    writeInbox(all.map((x, k) => (k === i ? next : x)));

    // 把 processed 翻回 false 的调用（界面上那颗「重新拆解」现在走的是下面
    // 那条 `/redo`，这里留给别的客户端和手工调用）。不把它从自动拆解的尝试
    // 记录里摘掉的话，这条又会立刻符合「未处理」条件却永远进不了自动触发的
    // 候选池——翻回未处理在自动模式下等于摆设，翻了也没反应。
    if ('processed' in body && body.processed === false) autoExpand.forget(next.id);

    // 改文字等于「按新的再试一次」，跟「重新拆解」同一个语义：把它从已自动
    // 尝试记录里摘掉。不摘的话 AI 试过一次失败、用户改了文字，它却再也不会
    // 自动再试。去抖的重置不需要在这里另外调用 evaluate：writeInbox 触发的
    // 文件变化本来就会经 watcher → data-changed 让 autoExpand 重新评估排期
    // 起点，跟「重新拆解」走的是同一条路径，不在这里另开一个第二入口。
    if (text !== undefined) autoExpand.forget(next.id);

    return c.json(next);
  });

  /**
   * 「重新拆解」——**可以带一句「哪儿不合适」**，不满意就再来一轮，直到拆出
   * 想要的为止。这是这个应用里唯一一处「跟 AI 来回聊」的地方。
   *
   * 为什么不复用上面的 `PATCH`（把 `processed` 翻回 false 那条）：这一趟要一次
   * 做完四件互相有依赖的事，拆成几个请求的话，中间任何一步断了都会留下一个
   * 说不清的中间态（旧任务删了但条目没翻回未处理，等等）。
   *
   *   1. 上一轮拆出来的任务**搬进垃圾箱**（不是抹掉——万一新一轮拆得更差，
   *      旧的还捞得回来；垃圾箱本来就是干这个的）
   *   2. 他那句要求追加到原文后面（`appendExpandNote`，为什么不加字段见那边）
   *   3. 条目翻回未处理、`taskIds` 清空
   *   4. 立刻再拆一次
   *
   * 第 4 步失败（单飞锁把它挡了）**不影响前三步的成功**：搬垃圾箱和改原文都已经
   * 落盘了，回 409 会让界面以为整件事没发生。用 `started` 如实说这次有没有跑起来。
   */
  app.post('/api/inbox/:id/redo', async (c) => {
    const body = (await jsonBody(c)) as { note?: unknown } | null;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';

    // 四个文件全部读在第一次写之前，跟 DELETE /api/tasks/:id 同一个规矩。
    const inbox = readInbox();
    const i = inbox.findIndex((x) => x.id === c.req.param('id'));
    if (i < 0) return c.json({ error: '没有这一条' }, 404);
    const item = inbox[i];
    const tasks = readTasks();
    const proposals = readProposals();
    const trash = readTrash();

    // `taskIds` 里可能有他自己早就删掉的——过滤掉，不然 softDeleteTasks 会
    // 拿到一堆找不到的 id。
    const doomed = item.taskIds.filter((id) => tasks.some((t) => t.id === id));
    const soft = softDeleteTasks(tasks, trash, doomed, nowIso());
    const refs = detachDeletedTasks(inbox, proposals, new Set(doomed));

    // `refs.inbox` 已经把被删任务的 id 从各条目的 taskIds 里摘掉了，在它上面
    // 再改这一条——顺序反了的话 detach 的结果会被这次覆盖盖掉。
    const nextInbox = (refs.inbox ?? inbox).map((x) => (x.id === item.id
      ? { ...x, processed: false, taskIds: [], ...(note ? { text: appendExpandNote(x.text, note) } : {}) }
      : x));

    if (doomed.length > 0) {
      writeTrash(soft.trash);
      writeTasks(soft.tasks);
    }
    if (refs.proposals) writeProposals(refs.proposals);
    writeInbox(nextInbox);

    // 不摘的话这条又会符合「未处理」却永远进不了自动触发的候选池，
    // 跟上面 PATCH 里那处是同一个理由。
    autoExpand.forget(item.id);

    // 手动要求的重来不受自动拆解的重试限制，跟 POST /api/expand 一致。
    autoExpand.clearAll();
    const started = agentRunner.start().ok;

    return c.json({ item: nextInbox.find((x) => x.id === item.id), trashed: doomed.length, started });
  });

  app.delete('/api/inbox/:id', (c) => {
    const all = readInbox();
    const left = all.filter((x) => x.id !== c.req.param('id'));
    if (left.length === all.length) return c.json({ error: '没有这一条' }, 404);
    writeInbox(left);
    return c.json({ ok: true });
  });

  // ── 任务 ──

  /**
   * design ⑥：`Task.attachments` 数组跟磁盘不一致时（同步冲突、手工删文件），
   * 要以磁盘为准把数组修正过来，不能让界面显示一个点开是 404 的幽灵条目
   * （final-review.md I1）。**只对 `attachments` 非空的任务扫盘**：全量扫是
   * 跟任务数成正比的 `readdirSync`（这个仓库刚在「/api/conflicts 七次同步
   * readdirSync」上吃过亏），但代价可以做到接近零——`data/` 里现在零条任务
   * 有附件，将来现实上限也就几条，`readdirSync` 次数是「有附件的任务数」，
   * 不是任务总数。这里只改响应、不写盘，不会跟并发写打架。 */
  app.get('/api/tasks', (c) => c.json(readTasks().map(asServed)));

  app.post('/api/tasks', async (c) => {
    const r = checkTaskPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    // checkTaskPatch 只校验「给出的字段」，不检查必填——title 必填是这条路由自己
    // 加的规矩（新建任务总得有个标题），跟 PATCH 不一样，别把这条冲掉。
    if (!r.value.title) return c.json({ error: '标题不能为空', field: 'title' }, 400);
    const all = readTasks();

    // 建的时候就挂父亲（「检查事项转为子任务」走的就是这条路）——**这里以前
    // 不判**：两条 PATCH 路由都过 `checkParentLink`，POST 却没有，从这个口子
    // 能绕开深度和环两条判据——建出第六层，或者直接造一个环。
    // 新 id 还不在 `all` 里不影响判据：它判的是「父亲存不存在、父亲自己是不是
    // 子任务、这条名下有没有孩子」，最后一条对刚出生的 id 恒为否。
    const task = newTask({ ...r.value, title: r.value.title });
    if (task.parentId) {
      const why = checkParentLink(all, task.id, task.parentId);
      if (why) return c.json({ error: why, field: 'parentId' }, 400);
    }

    // 建出来就是已完成的（转过来的那一项本来就勾着）：完成时刻在这一刻盖。
    // `completedAt` 不在客户端可写的白名单里（它是服务端盖的章），不补的话
    // 会留下一条 `status: 'done'` 而 `completedAt` 为 null 的记录——「已完成」
    // 按它排序、习惯的打卡历史也从它推出来，两处都会当这条不存在。
    const born = task.status === 'done' && !task.completedAt
      ? { ...task, completedAt: task.createdAt }
      : task;

    writeTasks([...all, born]);
    return c.json(born, 201);
  });

  /**
   * 「今天」手动排序的批量写入口。**一次请求写整份可见列表的顺序，不是每挪动
   * 一格就对每张可见的卡各发一条 `PATCH /api/tasks/:id`。**
   *
   * 旧写法（网页发 N 条并发 PATCH，`Promise.all`）有三个真实故障，根子都是
   * 「一次移动 = N 次独立的读-改-写」：
   * - `writeAtomic` 每次都把当前文件整份拷进唯一一份 `.bak`，N 条并发 PATCH
   *   连着写 N 次，会把 `.bak` 冲成重排过程中的某个中间态，而不是重排前的
   *   真正快照——手动恢复的最后一道退路被自己烧了。
   * - N 次独立写各自都会把 `updatedAt` 刷成现在，连只是「排在被移动那张卡
   *   旁边、位置其实没变」的任务也被误标成「刚碰过」，`workflows/board.md`
   *   「在进行中躺很久的」那份汇报就是靠 `updatedAt` 认的，会被这么一次
   *   排序污染。
   * - `Promise.all` 里第一个失败就 reject，其余已经发出去的写还在飞，
   *   界面播报「移动失败」的同时文件其实正在被部分写入——用户看见列表
   *   在被告知失败之后自己动了。
   *
   * 这里把它们收成一次 `readTasks()` + 至多一次 `writeTasks()`：整份新顺序
   * 通过 `ids`（当前可见列表，从上到下）一次性提交，数组下标就是新的 `order`。
   *
   * ids 里有 tasks.json 里已经找不到的（多半是重排请求还在路上时被删了）——
   * 跳过那一个，其余正常写入，不报错、不回滚整个请求：这条端点存在的意义
   * 就是把「一次移动」收紧成一次写，如果因为一个过期 id 就拒掉整批，等于
   * 把「关闭并发写窗口」这件事本身又撕开一个新的窗口。
   *
   * 现有任务但没出现在 `ids` 里——原样不动，`order`/`updatedAt` 都不碰：这些
   * 任务当时不在客户端的可见列表里（不同筛选、不同视图，或者请求发出后
   * 又有新卡进了「今天」），没有理由替它们决定新顺序，更不能把它们的
   * `order` 悄悄清空或者拍扁成某个默认值。
   *
   * 只有 `order` 的值真的变了才盖 `updatedAt`：单纯因为排在移动目标附近而被
   * 波及、新旧 `order`其实一样的任务，不算「被碰过」。
   */
  app.patch('/api/tasks/reorder', async (c) => {
    const body = (await jsonBody(c)) as { ids?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      return c.json({ error: 'ids 必须是字符串数组' }, 400);
    }
    // 排序算法本身（下标就是新 order、跳过没变的、找不到的 id 忽略）提成了
    // 平台无关的 applyReorder（mutate.ts）——Task 2 的离线本地实现共用同一份，
    // 不在这里另写一遍会悄悄分叉的逻辑，见 mutate.ts 里 applyReorder 的注释。
    const { tasks: next, changedIds } = applyReorder(readTasks(), body.ids as string[], nowIso());
    // 没有任何一条的 order 真的变了（比如整份列表原样重新提交了一次）就不写——
    // 跟别的路由同一条规矩，见 DELETE /api/tasks/:id 那条同款测试的注释：
    // 空转的写会占掉唯一一份 .bak 名额、白白触发一轮目录监听器。
    if (changedIds.length > 0) writeTasks(next);
    return c.json({ ok: true });
  });

  /**
   * 批量改：网页多选之后一起改状态/清单/标签/优先级……走这一条，不是对每张
   * 选中的卡各发一条 `PATCH /api/tasks/:id`。理由跟上面 `reorder` 一模一样——
   * N 次独立写各自触发一次目录监听器 → SSE 广播 → 所有开着的页面 refetch，
   * 选 20 张就是 20 轮，去抖会被打穿。这里收成至多一次 `readTasks()` +
   * 至多一次 `writeTasks()`。
   *
   * `patch` 走跟 `PATCH /api/tasks/:id` 同一份 `checkTaskPatch`——校验失败照样
   * 说得出是哪个字段、为什么，不在批量这条路上退回一句笼统的「字段不合法」。
   *
   * `ids` 里找不到的（多半是另一个标签页/设备正好把它删了，或者用户勾选之后
   * 别处又删了一条）直接跳过，不算整批失败——跟 `reorder`「跳过找不到的」、
   * outbox 合并「id 找不到就丢弃并记日志」同一个口径。`updated` 只数真的改到
   * 的那些，不数请求里给了但没命中任何现存任务的 id。
   *
   * 命中的每条都走 `applyTaskPatch`（`PATCH /api/tasks/:id`、接受提议共用的
   * 那份），提醒时刻变了清「已提醒」的章、状态从 later/done 回到 todo 清 order
   * 这些规则批量改的时候要照样生效，不能因为走了另一条路由就漏掉。
   *
   * 命中的任务里如果有跃迁到 done 的重复任务，也跟单条 PATCH 一样顺手生成
   * 下一条——`maybeSpawnNextInstance` 那份判断两条路由共用，见它顶部的注释。
   * 同一批里可能有不止一条同时跃迁，查重要把本轮已经生成的候选也算进去，
   * 否则两条同标题同 due 的重复任务会各自生成一条。
   */
  app.patch('/api/tasks', async (c) => {
    const body = (await jsonBody(c)) as { ids?: unknown; patch?: unknown; patches?: unknown } | null;
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400);

    /**
     * 两种请求体，**内部归一成同一种**（`byId`：id → 这条自己的 patch）：
     *
     * - `{ ids, patch }`：一份共享的改动套给选中的每一条。改状态、改清单、
     *   加标签、改优先级都是这种。
     * - `{ patches: [{ id, patch }, …] }`：**每条各改各的**。批量改期、
     *   「推迟一小时」是这种——「原计划整个往后挪一小时」逐条算出来的时刻
     *   互不相同，一份共享 patch 表达不了。
     *
     * 加后一种而不是让前端发 N 条 `PATCH /api/tasks/:id`：那样 N 次独立写各自
     * 触发一轮目录监听器 → SSE 广播 → 所有开着的页面 refetch，选 20 张就是
     * 20 轮，跟 `reorderTasks`/批量删除避开的是同一件事（见那两条路由的注释）。
     */
    const raw: Array<{ id: unknown; patch: unknown }> = Array.isArray(body.patches)
      ? (body.patches as Array<{ id: unknown; patch: unknown }>)
      : (Array.isArray(body.ids) ? (body.ids as unknown[]).map((id) => ({ id, patch: body.patch })) : []);
    if (!Array.isArray(body.patches) && !Array.isArray(body.ids)) {
      return c.json({ error: 'ids 必须是字符串数组（或者给 patches: [{id, patch}]）' }, 400);
    }
    if (!raw.every((e) => e && typeof e === 'object' && typeof e.id === 'string')) {
      return c.json({ error: 'ids 必须是字符串数组（或者给 patches: [{id, patch}]）' }, 400);
    }

    // **一条校验不过就整批退回**，不是挑着改：半批生效的批量操作没法解释，
    // 回执说「改了三条」，另外两条为什么没改、现在是什么样，界面上一个字都
    // 说不出来。跟下面 parentId 那条同一个道理。
    const byId = new Map<string, Partial<Task>>();
    for (const e of raw) {
      const r = checkTaskPatch(e.patch);
      if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
      byId.set(e.id as string, r.value);
    }

    const all = readTasks();

    // 批量改 parentId：同样一条不合格就整批退回。这几条判据要看别的任务长
    // 什么样，校验器（只看得见一份 patch）判不了，判在这儿。
    for (const [id, patch] of byId) {
      if (!('parentId' in patch)) continue;
      const why = checkParentLink(all, id, patch.parentId ?? null);
      if (why) return c.json({ error: why, field: 'parentId' }, 400);
    }

    // 各自 patch → 三条连带（深的先）→ 生成下一条，全在 `patchMany` 里——离线
    // 批量改用的是同一份，两条「批量 ≠ 逐条」的 bug 的来龙去脉写在它顶上。
    const { rows, born, touched } = patchMany(all, byId, new Date());

    // 一条都没命中（比如空数组，或者给的全是已经不存在的 id）就不写——跟
    // reorder「没有任何变化就不写」同一条规矩，空转的写只会占掉唯一一份
    // .bak 名额、白白触发一轮目录监听器。
    if (touched.length > 0) writeTasks(born.length ? [...rows, ...born] : rows);
    return c.json({ updated: touched.length });
  });

  /**
   * 批量删：同样是「多选之后一起删」，不是对每张卡各发一条
   * `DELETE /api/tasks/:id`。**复用单条那条的软删除实现**——进垃圾箱、能还原，
   * 不是另写一份硬删除。
   *
   * 四类受影响的文件（tasks/trash/inbox/proposals）分别只写一次：所有命中的
   * 任务一次性搬进垃圾箱、一次性从 tasks 里摘掉；inbox 的 taskIds 清理和
   * proposals 的清理也各自收成一次写，不是对选中的每个 id 各写一次——这跟
   * 上面 PATCH 是同一个道理，也是这条端点存在的意义。
   *
   * ids 里找不到的跳过，`deleted` 只数真的删掉的那些，同上面 PATCH 一个口径。
   */
  app.delete('/api/tasks', async (c) => {
    const body = (await jsonBody(c)) as { ids?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      return c.json({ error: 'ids 必须是字符串数组' }, 400);
    }
    const ids = new Set(body.ids as string[]);

    const all = readTasks();
    const gone = all.filter((t) => ids.has(t.id));
    // 一条都没命中就不碰任何文件——跟上面 PATCH 同一条规矩。
    if (!gone.length) return c.json({ deleted: 0 });

    // 四个文件全部在第一次写之前读完——跟 DELETE /api/tasks/:id 同一条规矩，
    // 见那条路由的注释。
    const inbox = readInbox();
    const proposals = readProposals();
    const trash = readTrash();

    // 软删：搬进垃圾箱，不是抹掉——纯函数在 mutate.ts（跟单条 DELETE 共用
    // 同一份，见那边的注释）。
    const next = softDeleteTasks(all, trash, ids, nowIso());
    writeTrash(next.trash);
    writeTasks(next.tasks);

    // 收件箱的 taskIds、这些任务名下的提议——为什么要清、为什么没东西清的时候
    // 一个字都不写，见 mutate.ts 的 detachDeletedTasks 注释。跟单条 DELETE 共用
    // 同一份，别再在这儿手写第二份。
    const refs = detachDeletedTasks(inbox, proposals, ids);
    if (refs.inbox) writeInbox(refs.inbox);
    if (refs.proposals) writeProposals(refs.proposals);

    return c.json({ deleted: gone.length });
  });

  app.patch('/api/tasks/:id', async (c) => {
    const r = checkTaskPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    const patch = r.value;
    const all = readTasks();
    const i = all.findIndex((x) => x.id === c.req.param('id'));
    if (i < 0) return c.json({ error: '没有这个任务' }, 404);

    // 两条落盘规则（改了提醒时间要清对应的已提醒的章、从 later/done 回到
    // todo 要清 order）都在 applyTaskPatch 里，跟「接受提议」那条路共用同一份。
    // 多级任务的三条完整性判据（挂到自己身上、父任务不存在、超过一层）——
    // 要看别的任务长什么样，校验器（只看得见这一份 patch）判不了，判在这儿。
    // 400 而不是悄悄改成 null：静默丢掉一个用户明确点过的动作，界面上会表现成
    // 「点了没反应」，正是这个仓库反复栽的那种形状。
    if ('parentId' in patch) {
      const why = checkParentLink(all, all[i].id, patch.parentId ?? null);
      if (why) return c.json({ error: why, field: 'parentId' }, 400);
    }

    const next = applyTaskPatch(all[i], patch, nowIso());
    const patched = all.map((x, k) => (k === i ? next : x));

    // 三条连带（完成向下、完成向上、换清单带走子任务），判据、顺序和各自
    // 的边界全在 mutate.ts 的 cascadeAll 里——四个调用点共用那一份。
    const rows = cascadeAll(all[i], next, patched, nowIso());

    // 完成一条重复任务 → 顺手造出下一条。只在**跃迁**到 done 那一刻做一次；
    // done → done（改个备注）不再生成，否则每编辑一次就多一条。判断跟查重
    // 都在 maybeSpawnNextInstance 里（批量 PATCH 共用同一份，见它顶部注释）。
    const born = maybeSpawnNextInstance(all[i].status, next, rows, new Date());

    writeTasks(born ? [...rows, born] : rows);
    return c.json(next);
  });

  /**
   * 跳过重复任务的这一次（仿滴答清单的「跳过」）。
   *
   * **为什么不是一条普通的 PATCH**：`applyTaskPatch` 的推迟计数是字段级的
   * ——「本来有截止日期、被往后挪了」就 `postponeCount + 1`。而跳过恰好也是
   * 把 due 往后挪，于是每跳过一次那个计数就涨一格，攒几次之后这条任务开始
   * 出现在「一拖再拖」的推荐里（`web/src/lib/suggest.ts`），AI 回顾也会把它
   * 当成长期拖延的典型。
   *
   * 两件事根本不是一回事：**拖延是「同一次要做的事往后挪」，跳过是「这一次
   * 不做了，日程往前走一格」**。字段级的判断分不出来——两条路发上来的都是
   * 一个更晚的 due——所以这里给它一条自己的路，明说这一次不算。
   *
   * 别的一切照旧走 `applyTaskPatch`（提醒的章按时刻沿用、`updatedAt` 照盖），
   * 只把计数按回原值：那一处才是这条路唯一的不同。
   */
  app.post('/api/tasks/:id/skip', (c) => {
    const id = c.req.param('id');
    const all = readTasks();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return c.json({ error: '没有这个任务' }, 404);

    // 判据（下一次落在哪、哪些字段重置、什么时候跳不动）在 mutate/repeat 里，
    // 跟网页那边共用同一份，不在路由里再写一遍。
    const patch = skipPatch(all[i], new Date());
    if (!patch) return c.json({ error: '这条跳不动：不重复、没有截止时间，或者次数已经用完' }, 400);

    const next = { ...applyTaskPatch(all[i], patch, nowIso()), postponeCount: all[i].postponeCount };
    writeTasks(all.map((x, k) => (k === i ? next : x)));
    return c.json(next);
  });

  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    const all = readTasks();
    if (!all.some((x) => x.id === id)) return c.json({ error: '没有这个任务' }, 404);

    // 四个文件全部在**第一次写之前**读完——跟 mergeOneFile 同一个规矩。
    // 原来 readProposals() 在两次写之后才调用：proposals.json 要是写坏了，
    // 任务和收件箱都已经落盘、卡片也已经从界面上消失，接口却回 500，
    // 用户读到的是「删除失败」。读在前面的话，坏文件在动任何东西之前就把
    // 请求挡下来，而且这条任务名下的建议也不会变成看不见的孤儿。
    const inbox = readInbox();
    const proposals = readProposals();
    const trash = readTrash();          // 第四个文件，同样读在前面

    // 软删：搬进垃圾箱，不是抹掉——纯函数在 mutate.ts（跟批量 DELETE 共用
    // 同一份，见那边的注释）。
    const next = softDeleteTasks(all, trash, [id], nowIso());
    writeTrash(next.trash);
    writeTasks(next.tasks);

    // 收件箱的 taskIds、这条任务名下的提议——为什么要清、为什么没东西清的时候
    // 一个字都不写，见 mutate.ts 的 detachDeletedTasks 注释。跟批量 DELETE 共用
    // 同一份，别再在这儿手写第二份。
    const refs = detachDeletedTasks(inbox, proposals, new Set([id]));
    if (refs.inbox) writeInbox(refs.inbox);
    if (refs.proposals) writeProposals(refs.proposals);

    return c.json({ ok: true });
  });

  // ── 附件 ──
  //
  // 三条路由都比 `/api/tasks/:id` 多一段路径。Hono 按段数匹配（上一批实测过），
  // 段数不同不会互相抢注册顺序——但会不会「写错路径」（复制粘贴漏删一段、
  // 少写一个 `:id`）完全是另一回事，app.test.ts 里有专门的上限断言钉住
  // `/api/tasks/:id` 的 PATCH/DELETE 在这三条注册之后还照常工作。

  // multipart 的头/边界会给 Content-Length 加一点开销，这道粗筛留了 64KB 余量，
  // 免得卡在 25MB 附近的合法文件被这道开销误伤——精确的边界在下面按 `file.size`
  // 再判一次。粗筛存在的意义是**尽早**掐断真正夸张的体积（手滑拖进一个 2GB 的
  // 文件），不靠它也能拦住超限，但拦得晚：`parseBody()` 已经把整个请求体读进
  // 内存了。
  const MAX_UPLOAD_BODY_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;

  app.post(
    '/api/tasks/:id/attachments',
    bodyLimit({
      maxSize: MAX_UPLOAD_BODY_BYTES,
      // 默认的 onError 会 throw 一个 HTTPException，走到下面 app.onError 会被
      // 那道兜底一律改写成 500——这里必须自己回一个 Response，不能靠抛的。
      onError: (c) => c.json({ error: `附件不能超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB` }, 413),
    }),
    async (c) => {
      const id = c.req.param('id');
      // 只做存在性预检——不能拿这次读到的快照撑过下面两次长 await 之后原样
      // 写回，见下面「重新读」那一段的注释（C1，final-review.md）。
      if (!readTasks().some((t) => t.id === id)) return c.json({ error: '没有这个任务' }, 404);

      let body: Record<string, string | File>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: '上传内容不是合法的 multipart 表单' }, 400);
      }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: '缺少文件字段 file（multipart 表单）' }, 400);
      // 精确边界：上面的 bodyLimit 是粗筛（含 multipart 开销），这里按文件本身
      // 的字节数再判一次，跟「25MB」这个数字严格对应。
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: `附件不能超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB` }, 413);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      let finalName: string;
      try {
        finalName = saveAttachment(id, file.name, bytes);
      } catch (e) {
        // 只把 saveAttachment 自己判定的「这次保存不合法」当 400、带上具体
        // 原因；其余（磁盘满、无权限……真正的 fs 异常）当服务器自己的故障，
        // 回一句人话，不把 errno 文本和服务器绝对路径原样丢给客户端
        // （I4，final-review.md）。
        if (e instanceof AttachmentValidationError) return c.json({ error: e.message }, 400);
        return c.json({ error: '附件保存失败，请稍后重试' }, 500);
      }

      // 重新读：上面 parseBody()/file.arrayBuffer() 这两次长 await 期间，别的
      // 请求可能已经改过 data/tasks/——继续用最上面那份旧快照写回，会把这
      // 期间新建的任务、别处的改动全部覆盖掉，而且是真删除，不进垃圾箱
      // （C1，final-review.md）。这里的写回必须基于**最新**的一份。
      const fresh = readTasks();
      const j = fresh.findIndex((t) => t.id === id);
      if (j < 0) return c.json({ error: '没有这个任务' }, 404);
      // 用真正落盘的那个名字（重名加了序号的），不是浏览器给的原名——
      // `finalName` 是 saveAttachment 的返回值，不是 file.name。
      const next: Task = { ...fresh[j], attachments: [...fresh[j].attachments, finalName], updatedAt: nowIso() };
      writeTasks(fresh.map((t, k) => (k === j ? next : t)));
      return c.json(next, 201);
    },
  );

  /**
   * 下载。**不查 `data/tasks/`**——磁盘是附件唯一的事实来源（design ⑥），软删除
   * 的任务（进了垃圾箱但还没彻底删）附件目录原样留着，下载不该因为任务当前不在
   * `readTasks()` 里就跟着 404。路径安全完全交给 `resolveAttachment`（两道守卫
   * 的第二道，见 attachments.ts）——这里不自己拼路径。
   */
  app.get('/api/tasks/:id/attachments/:name', (c) => {
    const id = c.req.param('id');
    const name = c.req.param('name');
    const full = resolveAttachment(id, name);
    if (full === null) return c.json({ error: '没有这个附件' }, 404);
    const bytes = readFileSync(full);
    return c.body(bytes, 200, {
      'Content-Type': 'application/octet-stream',
      // 用磁盘上真实的 basename，不是请求里的 name——两者「同一性」的定义
      // 不一样（resolveAttachment 会把 `./a.txt`、`PLAIN.TXT` 这类别名都解析
      // 到同一个文件），回显请求里的原始 name 会让下载弹窗猜出一个跟磁盘不
      // 一致的文件名（m7，final-review.md）。
      'Content-Disposition': contentDisposition(basename(full)),
    });
  });

  app.delete('/api/tasks/:id/attachments/:name', (c) => {
    const id = c.req.param('id');
    const name = c.req.param('name');
    const all = readTasks();
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return c.json({ error: '没有这个任务' }, 404);

    const removed = removeAttachment(id, name);
    if (removed === null) return c.json({ error: '没有这个附件' }, 404);

    // 摘数组用 removeAttachment 返回的真正 basename，不是请求里的 name——
    // 两者「同一性」的定义不一样，用请求里的原始 name 摘数组会摘不中真正
    // 的条目，留下一条文件已经没了、却再也删不掉的死条目（m6，final-review.md）。
    const next: Task = { ...all[i], attachments: all[i].attachments.filter((a) => a !== removed), updatedAt: nowIso() };
    writeTasks(all.map((t, k) => (k === i ? next : t)));
    return c.json({ ok: true });
  });

  // ── 垃圾箱 ──

  app.get('/api/trash', (c) => c.json(readTrash()));

  app.post('/api/trash/:id/restore', (c) => {
    const id = c.req.param('id');
    // 判断和那两条「deletedAt 不跟回去、order 清成 null」的规矩都在
    // mutate.ts 的 restoreFromTrash——**离线那条路共用同一份**，不然「还原」
    // 在两条路上会慢慢变成两件事。
    const next = restoreFromTrash(readTasks(), readTrash(), id);
    if (!next) return c.json({ error: '垃圾箱里没有这一条' }, 404);
    writeTasks(next.tasks);
    writeTrash(next.trash);
    return c.json(next.restored);
  });

  /**
   * 清空垃圾箱（仿滴答清单的「清空垃圾箱」）。
   *
   * 补的是一个只能一条条点的坑：垃圾箱**从来不会自己清**（这个应用不做
   * 「30 天后自动清理」——那是在一个定时器上悄悄删他的数据，本地跑的工具
   * 没有存储压力去换那个风险），于是删得越多它越长，而清掉两百条要点四百下。
   *
   * **附件跟着删**，跟单条那条一样：软删除不清附件目录，它们要活到彻底删除
   * 这一步才真的没了。放在 `writeTrash` 之后——万一写盘抛错，一个附件文件
   * 都还没删。
   */
  app.delete('/api/trash', (c) => {
    const ids = readTrash().map((x) => x.id);
    if (ids.length === 0) return c.json({ purged: 0 });
    writeTrash([]);
    for (const id of ids) removeAllAttachments(id);
    return c.json({ purged: ids.length });
  });

  app.delete('/api/trash/:id', (c) => {
    const id = c.req.param('id');
    const trash = readTrash();
    if (!trash.some((x) => x.id === id)) return c.json({ error: '垃圾箱里没有这一条' }, 404);
    writeTrash(trash.filter((x) => x.id !== id));
    // 这是唯一的破坏性附件操作：`DELETE /api/tasks/:id`（软删除进垃圾箱）
    // 不清目录，附件要活到这一步才真的没了——跟垃圾箱里的任务本身同一条命。
    // 放在 writeTrash 之后：万一 writeTrash 抛错，磁盘上一个附件文件都还没删。
    removeAllAttachments(id);
    return c.json({ ok: true });
  });

  // ── AI 提议 ──

  // 只吐还没处理的。被忽略的行留在文件里给去重用（见下面的 dismiss 路由），
  // 但界面不该再看见它们。
  app.get('/api/proposals', (c) => c.json(readProposals().filter((p) => !p.dismissed)));

  /**
   * 接受一条提议：把 patch 应用到任务上，再删掉这条提议。
   *
   * **两步在这一个端点里做完**，不是让网页发两个请求——那样中间断了会留下一条
   * 已经生效却还挂着的提议。写入顺序是先 tasks.json 后 proposals.json：这中间
   * 崩了确实会留下那条提议，但**再点一次「接受」是无害的**，patch 里全是绝对值
   * （标题、时间），重复应用得到同一个结果，不是加减。反过来先删提议再写任务，
   * 中间崩了这条建议就永远消失了，而它其实没生效——那才是真的丢东西。
   */
  app.post('/api/proposals/:id/accept', (c) => {
    const id = c.req.param('id');
    const proposals = readProposals();
    const p = proposals.find((x) => x.id === id);
    if (!p) return c.json({ error: '没有这条建议' }, 404);

    const all = readTasks();
    const i = all.findIndex((x) => x.id === p.taskId);
    // 任务在他点「接受」之前被删了。提议连带清掉——留着也没有卡片能渲染它。
    if (i < 0) {
      writeProposals(proposals.filter((x) => x.id !== id));
      return c.json({ error: '这条建议对应的任务已经不在了' }, 404);
    }

    // 磁盘上那份 patch 也要过一遍白名单，不能因为「是我们自己写进去的」就当它
    // 可信：proposals.json 没有任何界面能编辑，想批量清掉过期建议只能手改，
    // 手改过的文件、或者别的版本的合并逻辑写出来的文件，都可能带上 `id` 或
    // `status`——`applyTaskPatch` 是个裸展开，`id` 一旦被换掉，这条任务跟收件箱
    // 的 taskIds 反向引用、跟别的建议就全断了。toTask 会重新校验 outbox 的输入，
    // PATCH /api/tasks/:id 会重新校验 HTTP 的输入，这条路没有理由例外。
    const patch = sanitizeProposalPatch(p.patch);
    if (!patch) {
      writeProposals(proposals.filter((x) => x.id !== id));
      return c.json({ error: '这条建议里的字段不合法，已经丢弃——重新跑一次回顾' }, 422);
    }

    const next = applyTaskPatch(all[i], patch, nowIso());

    // **接受一条建议之后要走的后续，跟 `PATCH /api/tasks/:id` 完全一样。**
    // 这里原来只有 `applyTaskPatch` 加一句写盘，三条连带和「生成下一次」一条都
    // 不走。两个场景实测复现过：
    //
    // - `listId` 在 `PROPOSABLE` 里：接受一条「把父任务移到清单 B」的建议之后，
    //   父任务到了 B、**子任务还留在 A**——而同一个动作走 PATCH 是会带上子任务的
    //   （`cascadeListToChildren` 存在的全部理由就是防这个）。
    // - `subtasks` 在 `PROPOSABLE` 里、`status` 不在：于是 `applyTaskPatch` 那条
    //   「检查事项全部勾完就自动完成」的守卫（`!('status' in patch)`）必然通过。
    //   接受一条「把子任务都勾上」的建议，一条**每周重复**的任务就地变成 done、
    //   盖了 completedAt，**而下一次没有生成**——这条重复链断在这儿，界面上没有
    //   任何提示，下周它不再出现，人只会以为「怎么没了」。
    //
    // 判据不在这儿抄一份：四个函数都在 `mutate.ts`，两条 PATCH 路由用的也是它们。
    const patched = all.map((x, k) => (k === i ? next : x));
    const rows = cascadeAll(all[i], next, patched, nowIso());
    const born = maybeSpawnNextInstance(all[i].status, next, rows, new Date());
    writeTasks(born ? [...rows, born] : rows);
    // 任务已经落盘了。这一步再失败也不该把整件事报成失败——变更是真的生效了，
    // 报错会让人以为没生效、去点第二次（幂等，无害，但他不知道）。降级成
    // 一句警告带回去，界面用 message.warning 说清「改动生效了，这条建议没清掉」。
    try {
      writeProposals(proposals.filter((x) => x.id !== id));
    } catch (e) {
      // 不提文件名：这是一句一闪而过的提示，人要知道的是「改动生效了」和
      // 「再点一次能清干净」，文件名只会占掉本来就不多的一行。真要排查，
      // 服务窗口的日志里有完整报错。
      console.warn('[proposals] 接受之后清理建议失败：', (e as Error).message);
      return c.json({ ...next, warning: '改动已经生效了，但这条建议没能清掉——再点一次「接受」就好。' });
    }
    return c.json(next);
  });

  /**
   * 忽略一条建议：**打墓碑，不是删行。**
   *
   * 删掉的话内容去重（outbox.ts 的 proposalKey）就认不出来了，下一轮回顾读到
   * 一份不再提这条任务的 proposals.json，重新得出同样的判断，写出一条一字不差
   * 的建议——它顺利通过去重，又出现在卡片上。「忽略」等于没点，每轮都得再点
   * 一次。留着这一行，去重才拦得住。
   *
   * 不怕永远压死：情况真变了（又拖了一个月），AI 算出来的是新日期、构成不同的
   * 内容，那是一条新建议，照样提得出来。
   */
  app.patch('/api/proposals/:id/dismiss', (c) => {
    const id = c.req.param('id');
    const all = readProposals();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return c.json({ error: '没有这条建议' }, 404);
    if (all[i].dismissed) return c.json({ ok: true });
    writeProposals(all.map((x, k) => (k === i ? { ...x, dismissed: true } : x)));
    return c.json({ ok: true });
  });

  // ── 设置 ──

  /**
   * **密钥不原样回给浏览器**：这个服务会绑到局域网上（`lanBind.ts`），同一个
   * Wi-Fi 里的任何设备都能 GET 这条路由。回打码后的形状（`••••` 加后四位）——
   * 全打成 `••••` 的话，界面上没法告诉他「存着的是哪一把」，换钥匙时只能盲改。
   */
  app.get('/api/settings', (c) => {
    const s = readSettings();
    return c.json({ ...s, aiKey: maskKey(s.aiKey) });
  });

  /**
   * **这是 PUT，不是 PATCH：请求体就是完整的新设置，没给的字段一律回默认值。**
   *
   * 唯一的调用方是 `api.saveSettings(s: Settings)`，它发的是设置页那份完整对象
   * （`api.ts` 那段注释里说的也是「整份 PUT 回服务端」）。所以「没给就回默认」
   * 不是漏合并，是这条路由的契约。
   *
   * 写下来是因为它看起来很像一个 bug：随手加一个字段、忘了在设置页表单里带上，
   * 保存一次就把它清成默认值，而且不报错。**加字段时必须两头一起加。**
   * `dailySummaryOn` 是唯一的例外，理由在它自己那行——它是事实不是偏好。
   */
  app.put('/api/settings', async (c) => {
    const body = (await jsonBody(c)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400);
    const stored = readSettings();
    // 先算出要落盘的地址：下面判「密钥字段缺失要不要沿用」得拿它跟存着的比。
    const aiBaseUrl = typeof body.aiBaseUrl === 'string' ? body.aiBaseUrl.trim() : DEFAULT_SETTINGS.aiBaseUrl;
    const next: Settings = {
      webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : DEFAULT_SETTINGS.webhookUrl,
      toastEnabled: typeof body.toastEnabled === 'boolean' ? body.toastEnabled : DEFAULT_SETTINGS.toastEnabled,
      autoExpand: typeof body.autoExpand === 'boolean' ? body.autoExpand : DEFAULT_SETTINGS.autoExpand,
      autoExpandDelaySec: clampAutoExpandDelaySec(body.autoExpandDelaySec),
      focusMinutes: clampFocusMinutes(body.focusMinutes),
      breakMinutes: clampBreakMinutes(body.breakMinutes),
      // 每日概览的时刻：`HH:MM` 或 null。**不夹、不猜**，跟上面那几个数字
      // 不一样——一个写坏的时刻没有「最近的合法值」可退，猜一个会让他以为
      // 设成功了，而通知在别的时候响。
      dailySummaryAt: parseHhmm(body.dailySummaryAt) ? String(body.dailySummaryAt).trim() : null,
      // **服务端盖的章，请求体里的一概不采信**：它记的是「今天这条推过了没有」，
      // 是事实不是偏好（跟 Reminder.firedAt 同一类）。不把存着的那份原样带过来
      // 的话，用户在设置页随手按一次保存，当天的概览就会再推一遍。
      dailySummaryOn: stored.dailySummaryOn,
      // 任务默认值。**不校验这个 id 是不是真的存在**——清单可以在任何时候被
      // 删掉，那之后这个字段就指着一个不存在的东西，而这里没法回头去改它。
      // 界面那边（TaskComposer 的 defaultDraft）在用之前先对一遍 lists，
      // 对不上就当没设，这是唯一守得住的地方。
      defaultListId: typeof body.defaultListId === 'string' && body.defaultListId ? body.defaultListId : null,
      defaultPriority: [0, 1, 2, 3].includes(body.defaultPriority as number) ? body.defaultPriority as 0 | 1 | 2 | 3 : 0,
      // 认不出的档一律回默认档，不拒绝整份——跟上面那几个 clamp 同一个态度：
      // 一个写坏的字段不该让另外十几个正确的字段一起存不进去。
      defaultDue: (['none', 'today', 'tomorrow'] as const).includes(body.defaultDue as 'none')
        ? body.defaultDue as Settings['defaultDue'] : DEFAULT_SETTINGS.defaultDue,
      // 提前多久：非负整数分钟，或者 null（不预设）。负数没有意义（「提醒时间
      // 在截止之后」是另一件事，这个应用不提供），一律当没设。
      defaultRemindMinutes: typeof body.defaultRemindMinutes === 'number'
        && Number.isFinite(body.defaultRemindMinutes) && body.defaultRemindMinutes >= 0
        ? Math.round(body.defaultRemindMinutes) : null,
      // 标签：只收字符串、去空白、去重、丢掉空串。手改文件写进来的数字/对象
      // 会一路流到任务的 tags 上，那边全是按字符串处理的。
      defaultTags: Array.isArray(body.defaultTags)
        ? [...new Set(body.defaultTags.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
        : [],
      // 三档白名单（见 model.ts 的 `WeekStart`）。认不出的落回默认档 1，
      // 不是「不是 0 就当 1」——那种写法在加第三档时会把 6 静默吃成 1。
      weekStart: body.weekStart === 0 || body.weekStart === 6 ? body.weekStart : 1,
      // 这四个**默认开**，所以判据是「明确存了 false 才关」，不是「=== true
      // 才开」——照抄 toastEnabled 那种写法会让它们变成默认关，等于把智能识别
      // 整个悄悄关掉。
      smartDate: body.smartDate !== false,
      smartStripDate: body.smartStripDate !== false,
      smartTag: body.smartTag !== false,
      smartStripTag: body.smartStripTag !== false,
      // 农历和「休/班」同样默认开，同样是「存了 false 才关」。
      showLunar: body.showLunar !== false,
      showHolidays: body.showHolidays !== false,
      // 认不出的模式落回 'cli'，跟上面那几个白名单同一个态度。
      aiMode: body.aiMode === 'api' ? 'api' : 'cli',
      aiBaseUrl,
      aiModel: typeof body.aiModel === 'string' ? body.aiModel.trim() : DEFAULT_SETTINGS.aiModel,
      // 密钥三种走法，缺一不可：
      //   - 请求体里压根没这个字段（别的客户端只想改别的设置）→ 原样留着，
      //     **但只在地址没变时**——地址换了、密钥又没给，密钥不跟着搬过去。
      //     不然这就是一条把密钥送给任意地址的路，理由见 aiKeyFrom 的注释
      //   - 收到的正是 GET 回去的那串打码 → 原样留着。界面读回来的就是打码，
      //     不认它的话，用户在设置页改一下番茄钟时长再保存，密钥就被那串
      //     `••••abcd` 覆盖了，而下一次拆解才会以 401 的形式暴露出来
      //   - 别的字符串（含空串）→ 照收。空串就是「清掉」，得留这条路
      aiKey: aiKeyFrom(body.aiKey, stored.aiKey, { incoming: aiBaseUrl, stored: stored.aiBaseUrl }),
    };
    writeSettings(next);

    /**
     * **AI 那几格一改，就把「已经自动试过」的记录清掉。**
     *
     * 补的是一条真实的死路：`aiMode: 'api'` 但模型名没填时，自动拆解会把收件箱里
     * 所有未处理的条目标进 `attempted`（那是对的，防重试风暴），然后红横幅说
     * 「设置里的 AI 模型名还没填」。用户照着做——打开设置、填上、保存——**然后
     * 什么都不会发生**：那些条目还在 `attempted` 里，`evaluate()` 筛出来是空的，
     * 自动拆解对这批积压永久失效，直到他手动点一次「立即拆解」、或者记一条新的、
     * 或者重启服务。横幅让他做的那件事恰恰不管用。
     *
     * 判据是「这几格变了没有」，不是「保存了没有」：改番茄钟时长不该顺带把一批
     * 因为别的原因失败过的条目全放回候选池。`autoExpand` 本来也一直不管这个——
     * 它自己只在收件箱变化时评估。
     */
    const aiChanged = (['aiMode', 'aiBaseUrl', 'aiKey', 'aiModel'] as const).some((k) => stored[k] !== next[k]);
    if (aiChanged) autoExpand.clearAll();

    // settings 存在设备本地的 device.json，不在 data/ 里（见 store.ts 的
    // deviceConfigPath），events.ts 的文件监听器看不到这次写入——这条路由是
    // 设置的唯一写入口，data-changed{file:'settings'} 只能由它自己发。
    // autoExpand.ts 靠这个事件重算已经排上的那次倒计时（关掉自动拆解要立刻
    // 生效，不能等到下一次收件箱变化才重新评估），App.tsx 靠它做多标签页
    // 设置同步。
    bus?.emit('data-changed', { file: 'settings' });
    // **这条响应跟 GET 打的是同一份码**：界面保存完会拿响应刷新自己那份 state，
    // 这儿漏出真值等于上面那道遮挡白设——密钥照样进了浏览器。
    return c.json({ ...next, aiKey: maskKey(next.aiKey) });
  });

  // ── 清单与文件夹 ──

  app.get('/api/lists', (c) => c.json(readLists()));

  app.post('/api/lists', async (c) => {
    const r = checkListPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    if (!r.value.name) return c.json({ error: '清单要有名字', field: 'name' }, 400);
    if (!r.value.color) return c.json({ error: `颜色要是 #RRGGBB，且不能是群青 ${INK_AI}——那是 AI 的记号`, field: 'color' }, 400);
    const all = readLists();
    // order/archived 不采信客户端传的值：新清单一律未归档、排在当前末尾，
    // 这两个是服务端自己算的，不是「建清单」这个动作里客户端能决定的事。
    const list: List = {
      id: randomUUID(),
      name: r.value.name,
      color: r.value.color,
      folderId: r.value.folderId ?? null,
      order: all.length,
      archived: false,
      filter: r.value.filter ?? null,
    };
    writeLists([...all, list]);
    return c.json(list);
  });

  app.patch('/api/lists/:id', async (c) => {
    const r = checkListPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    const all = readLists();
    const hit = all.find((l) => l.id === c.req.param('id'));
    if (!hit) return c.json({ error: '没有这个清单' }, 404);
    const next: List = { ...hit, ...r.value };
    writeLists(all.map((l) => (l.id === hit.id ? next : l)));
    return c.json(next);
  });

  app.delete('/api/lists/:id', (c) => {
    const id = c.req.param('id');
    const all = readLists();
    if (!all.some((l) => l.id === id)) return c.json({ error: '没有这个清单' }, 404);

    // **删清单不删里面的任务。** 不写死这一条就是一个静默丢数据的坑：
    // 人以为删的是一个分类，实际连着一批任务一起没了，而且没有任何提示。
    // 两边都读完再动手写，跟 outbox.ts「三个文件全部在第一次写之前读完」
    // 同一条规矩——第一次写之后才发现第二份读不出来，数据就半改完了。
    const tasks = readTasks();
    const touched = tasks.filter((t) => t.listId === id);
    writeLists(all.filter((l) => l.id !== id));
    if (touched.length) writeTasks(tasks.map((t) => (t.listId === id ? { ...t, listId: null, updatedAt: nowIso() } : t)));
    return c.json({ ok: true });
  });

  app.get('/api/folders', (c) => c.json(readFolders()));

  app.post('/api/folders', async (c) => {
    const r = checkFolderPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    if (!r.value.name) return c.json({ error: '文件夹要有名字', field: 'name' }, 400);
    const all = readFolders();
    const folder: Folder = { id: randomUUID(), name: r.value.name, order: all.length };
    writeFolders([...all, folder]);
    return c.json(folder);
  });

  app.patch('/api/folders/:id', async (c) => {
    const r = checkFolderPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    const all = readFolders();
    const hit = all.find((f) => f.id === c.req.param('id'));
    if (!hit) return c.json({ error: '没有这个文件夹' }, 404);
    const next: Folder = { ...hit, ...r.value };
    writeFolders(all.map((f) => (f.id === hit.id ? next : f)));
    return c.json(next);
  });

  app.delete('/api/folders/:id', (c) => {
    const id = c.req.param('id');
    const all = readFolders();
    if (!all.some((f) => f.id === id)) return c.json({ error: '没有这个文件夹' }, 404);
    // 同上：删文件夹不删里面的清单，它们回到顶层。两边先读完再写。
    const lists = readLists();
    const touched = lists.some((l) => l.folderId === id);
    writeFolders(all.filter((f) => f.id !== id));
    if (touched) writeLists(lists.map((l) => (l.folderId === id ? { ...l, folderId: null } : l)));
    return c.json({ ok: true });
  });

  // ── AI 的跨任务观察 ──

  /** 已经「知道了」的不返回。它们留在磁盘上是为了挡住下一轮 AI 原样再提一遍
   *  ——跟 proposals 的 dismissed 同一套，见下面 dismiss 那条路由。 */
  app.get('/api/insights', (c) => c.json(readInsights().filter((i) => !i.dismissedAt)));

  /**
   * 「知道了」是打墓碑不是删行。删掉的话内容去重（outbox.ts 的
   * insightKey）就认不出来了，下一轮回顾会把一模一样的观察原样再提一遍。
   */
  app.patch('/api/insights/:id/dismiss', (c) => {
    const id = c.req.param('id');
    const all = readInsights();
    if (!all.some((i) => i.id === id)) return c.json({ error: '没有这条观察' }, 404);
    writeInsights(all.map((i) => (i.id === id ? { ...i, dismissedAt: nowIso() } : i)));
    return c.json({ ok: true });
  });

  // ── 倒数纪念日 ──
  //
  // 一套最普通的 CRUD，形状照 folders 那组抄。它跟任务是**两类东西**：
  // 没有「做完」这一步、不进「今天」、不提醒——所以不复用 Task 的任何一条
  // 路由，见 model.ts 里 Countdown 的注释。

  app.get('/api/countdowns', (c) => c.json(readCountdowns()));

  app.post('/api/countdowns', async (c) => {
    const r = checkCountdownPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    // 建的时候这两个必填——`checkCountdownPatch` 只管「给了的那些合不合法」
    // （PATCH 要能只改一个字段），「必不必填」是各调用方自己的事，跟
    // `sanitizeTaskPatch` 和 POST /api/tasks 的分工一样。
    if (!r.value.title) return c.json({ error: '要有名字', field: 'title' }, 400);
    if (!r.value.date) return c.json({ error: '要有日期', field: 'date' }, 400);
    const at = nowIso();
    const row: Countdown = {
      id: randomUUID(),
      title: r.value.title,
      date: r.value.date,
      yearly: r.value.yearly ?? false,
      lunar: r.value.lunar ?? false,
      createdAt: at,
      updatedAt: at,
    };
    writeCountdowns([...readCountdowns(), row]);
    return c.json(row);
  });

  app.patch('/api/countdowns/:id', async (c) => {
    const r = checkCountdownPatch(await jsonBody(c));
    if (!r.ok) return c.json({ error: `${r.field} ${r.reason}`, field: r.field }, 400);
    const all = readCountdowns();
    const hit = all.find((x) => x.id === c.req.param('id'));
    if (!hit) return c.json({ error: '没有这个纪念日' }, 404);
    const next: Countdown = { ...hit, ...r.value, updatedAt: nowIso() };
    writeCountdowns(all.map((x) => (x.id === hit.id ? next : x)));
    return c.json(next);
  });

  app.delete('/api/countdowns/:id', (c) => {
    const id = c.req.param('id');
    const all = readCountdowns();
    if (!all.some((x) => x.id === id)) return c.json({ error: '没有这个纪念日' }, 404);
    // 不进垃圾箱：垃圾箱是给任务的（`TrashItem extends Task`），而纪念日
    // 就是一行标题加一个日期，重建的成本约等于零。多一类垃圾要处理，
    // 比偶尔手滑重打一遍贵。
    writeCountdowns(all.filter((x) => x.id !== id));
    return c.json({ ok: true });
  });

  // ── 同步冲突 ──

  // 不解决、不删、不改名，只是让人看见——见 conflicts.ts 顶部的注释。
  app.get('/api/conflicts', (c) => c.json(listAllConflicts()));

  /**
   * 读不出来的实体文件。**这条路由补的是一个一直空着的承诺**：
   * `entityStore.readAll` 跳过坏文件时的注释写着「界面上由上层负责把坏文件
   * 列出来」，而上层从来没有做过——于是一条同步坏掉的任务就这么从界面上无声
   * 消失，谁都不知道少了东西。
   *
   * 不在这儿扫盘，读的是 readAll 那一趟顺手记下的（见 conflicts.ts）。
   */
  app.get('/api/broken', (c) => c.json(listAllBroken()));

  /**
   * 手机把离线期间的改动推回来。**这是这个服务上唯一一条「接收另一台设备的数据」的
   * 路由**，规矩全写在 已归档的 docs/superpowers/specs/2026-08-13-full-rebuild-design.md 第十节
   * 「移动端第一步」那一小节里。放在冲突那一节，是因为它俩是同一件事的两半。
   *
   * **它不跑任何写入语义。** 不调 `applyTaskPatch`、不调 `maybeSpawnNextInstance`——
   * 手机在离线时就已经用**同一份 `mutate.ts`** 算好了 `completedAt`、`updatedAt`、
   * 重复任务的下一条实例，这里再算一遍就是算第二遍（后果是两条同标题同 due 的卡，
   * 而用户只完成过一次）。这条路由写的是**整条实体**，不是「把一个 patch 应用上去」。
   *
   * 每一半之内先算完全部判定再动文件（跨两半的边界见 `applyInboxPush` 顶部）；
   * **收件箱先于任务**，对调会同时坏两件事：
   * 1. 任务的软删除要清 `inbox.taskIds` 里的死链接，那一步读到的会是**这次推送之前**的
   *    收件箱——这次刚推上来的条目里那条死链接清不掉；
   * 2. 反过来，清完引用之后收件箱那半才跑，它会拿手机那份把刚清掉的 `taskIds`
   *    **原样写回去**——同一条死链接换个方向又活了。
   *
   * 响应体的三个桶手机**都清记号**，没出现在任何桶里的保留记号；形状/id 不合法是
   * 整批 400（响应里没有任何 id，手机一个记号都不清）。**没有第四个「失败」桶**——
   * 「悄悄不放进任何桶」会让一条永远畸形的条目变成无限重推，而且全程没有信号。
   */
  app.post('/api/push', async (c) => {
    const body = (await jsonBody(c)) as { tasks?: unknown; inbox?: unknown } | null;
    const taskEntries = checkPushEntries(body?.tasks, 'tasks');
    const inboxEntries = checkPushEntries(body?.inbox, 'inbox');
    // 整批拒的时候**说得出是哪一条**——见 `whichEntryIsBad` 上面那段：不说的话，用户所有
    // 的离线改动都推不回去，而他没有任何手段知道该去动哪条。
    if (!taskEntries || !inboxEntries) {
      const which = !taskEntries ? whichEntryIsBad(body?.tasks, 'tasks') : whichEntryIsBad(body?.inbox, 'inbox');
      return c.json({ error: `${which}不合形状，这一批整批没推。每条 upsert 的内容要像一条完整的任务/收件箱条目——在手机上把那条重新编辑一次（会带上一份新的内容），这一批就能推回去了` }, 400);
    }
    // 一条不安全就整批拒——这些 id 会被拼进文件名，`isSafeId` 是这个判据的唯一实现
    // （`entityStore.ts`），不在这里另写一遍。用 `find` 不是 `every`：要把那条报出来。
    // **这一支不给「怎么修」的建议**：不安全的 id 是 id 本身不能用，在手机上重新编辑
    // 甚至删掉它，带的还是同一个 id、还是推不上来。编一句修不好的建议比不给更糟。
    const unsafe = [...taskEntries, ...inboxEntries].find((e) => !isSafeId(e.id));
    if (unsafe) {
      return c.json({ error: `id 不安全，这一批整批没推：「${unsafe.id}」（可能是路径穿越，或者长得像一份冲突副本）` }, 400);
    }

    const now = nowIso();
    const inboxResult = applyInboxPush(inboxEntries, now);
    const tasksResult = applyTasksPush(taskEntries, now);
    return c.json({ tasks: tasksResult, inbox: inboxResult });
  });

  // ── AI 拆解 / 回顾 ──

  // 叫起 AI 就立刻回，不等它跑完（CLI 那条实测要 92 秒）。**两条路都一样**：
  // 起 `claude -p` 子进程，或者按设置调一个 OpenAI 兼容的接口，选哪条在
  // expand.ts 的 start() 里现读设置。真正把结果合并进 tasks/inbox 的是
  // outbox.ts 的 mergeOutbox，由文件监听器触发，这条路由不管那一步。
  // 单飞状态在 agentRunner 闭包里，跟这个 app 实例绑定。
  /**
   * 「测试连接」——设置页 AI 那三格旁边那颗按钮。
   *
   * **验的是他此刻框里填的那份，不是存着的那份**：这颗按钮的用途就是「我刚填完，
   * 对不对」，拿存着的旧值去验等于答非所问。所以三格都从请求体收。
   *
   * 密钥走 `aiKeyFrom`，跟 `PUT /api/settings` 同一条规矩：界面读回来的是打码串，
   * 他不碰那一格就会原样送回来——不认它的话，「改了地址、没动密钥」这种最常见的
   * 情形会拿着一串 `••••abcd` 去认证，然后报一个跟真实原因毫无关系的 401。
   *
   * 二十秒超时：冷启动的模型（本机 Ollama 第一次加载）确实要好几秒，而 `chat`
   * 自己不带超时，只认传进去的 signal。
   */
  app.post('/api/ai/test', async (c) => {
    const body = (await jsonBody(c)) as { baseUrl?: unknown; model?: unknown; apiKey?: unknown } | null;
    const stored = readSettings();
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : stored.aiBaseUrl;
    const error = await testAi({
      baseUrl,
      model: typeof body?.model === 'string' ? body.model.trim() : stored.aiModel,
      // 不带 apiKey 又带着陌生地址的请求拿不到存着的密钥——理由见 aiKeyFrom。
      apiKey: aiKeyFrom(body?.apiKey, stored.aiKey, { incoming: baseUrl, stored: stored.aiBaseUrl }),
    }, fetchFn, AbortSignal.timeout(20_000));
    // 一律 200：这条路由自己没出错，「连不上」是它要报告的结果，不是它的失败。
    // 回 4xx 的话前端得把「请求失败」和「测出来不通」分开处理两遍。
    return c.json(error ? { ok: false, error } : { ok: true });
  });

  app.post('/api/expand', (c) => {
    // 手动触发不受自动拆解的重试限制，而且不管这次 start() 成不成功（单飞锁
    // 可能把它 409 掉）都清空尝试记录——用户明确要求重来就是重来，这个「重来」
    // 的意图不该因为「凑巧正有一次在跑」就打折扣。
    autoExpand.clearAll();
    const result = agentRunner.start();
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  // 排上的那次还没到点，用户不想等这次——「这次不拆」按钮走这条。只取消
  // 排期，不运行、不碰尝试记录：下次收件箱或设置有相关变化，可能会重新排上，
  // 这不是「关掉自动拆解」（那是设置里的开关）。
  app.post('/api/expand/skip', (c) => {
    autoExpand.skip();
    return c.json({ ok: true });
  });

  // 「让 AI 回顾一遍」按钮走这条。跟拆解的区别只有提示词（见 expand.ts 的
  // PROMPT），单飞锁是同一把——回顾和拆解写的是同一批 outbox 文件。
  //
  // **不碰 autoExpand**：拆解那条路由要 clearAll()，是因为拆解本来就在自动排期，
  // 手动点一次意味着「这次重来」。回顾压根没有自动排期这回事（刻意的，见设置
  // 页那段说明），没有任何排期状态需要清。
  // body 可以带 `{ listId }`：只回顾那一份清单（一个项目一份清单，所以这就是
  // 「只看这个项目」）。不带就是老行为，扫全部任务。
  app.post('/api/review', async (c) => {
    // 没 body、body 不是 JSON 都算「不带范围」——这个路由本来就允许空 body 调用，
    // 一个 SyntaxError 不该把它变成 500。
    const body = await c.req.json().catch(() => ({})) as { listId?: unknown };
    let scope: { listId: string; listName: string } | undefined;

    if (body.listId != null) {
      if (typeof body.listId !== 'string') return c.json({ error: 'listId 得是字符串' }, 400);
      const list = readLists().find((l) => l.id === body.listId);
      // **认不出来就明确拒绝，不能悄悄退回「扫全部」。** 回顾是真花钱的（API 模式下
      // 按 token 计，CLI 模式下烧订阅额度），一个打错的 id 静默变成全量扫描，
      // 用户拿到的是一份看不出错在哪的账单和一堆不相干的建议。
      if (!list) return c.json({ error: `没有这份清单：${body.listId}` }, 400);
      scope = { listId: list.id, listName: list.name };
    }

    const result = agentRunner.start('review', scope);
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  // 未知的 /api/* 显式回 JSON 404。**必须注册在所有 API 路由之后**（Hono 按注册顺序
  // 匹配，先命中的先执行）。不写这条的话走 Hono 默认的 notFound——那是 text/plain，
  // 前端 api.ts 的 res.json() 会在报错路径上再抛一个解析错误，把真正的 404 盖掉；
  // 到了 index.ts 挂上 SPA fallback 之后更糟：手滑打错的 /api/xxx 会拿回一页 HTML。
  app.all('/api/*', (c) => c.json({ error: '没有这个接口' }, 404));

  // 服务跑着的时候文件被手改坏了、磁盘满了之类的意外，兜底成 JSON 而不是 Hono
  // 默认的 text/plain 500——不然 web/src/api.ts 的 res.json() 会在这条报错路径上
  // 再抛一个解析错误，把真正的错误信息盖掉，用户只看到「请求失败（500）」。
  // C1 把服务钉死在 127.0.0.1 之后，把 e.message 原样吐给前端不再是局域网风险。
  app.onError((e, c) => c.json({ error: e.message }, 500));

  return app;
}
