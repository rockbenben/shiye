import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bus } from './events.js';
import { readSettings, readTasks, writeSettings, writeTasks, type Reminder, type Task } from './store.js';
import { localDay, shouldSendSummary, summaryTasks, summaryText } from './dailySummary.js';
import { isSettled } from './task.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 到期判定。**只有这一处**——前端不许再写一份。
 *
 * 一条任务上可能有多个提醒同时到期——那只该通知一次，但两条都要盖章，
 * 见下面 `fireReminders` 里的说明。
 *
 * `later`（搁置）跟 `done` 一样不提醒：搁置的意图就是「暂时不想看见它」
 * （见 2026-08-12-today-view.md），三路通知（网页横幅、Windows 通知、webhook）
 * 到点照样炸出来是直接反着来——用户刚把一张卡从「今天」挪走图个清净，
 * 下一秒就被同一张卡的提醒烦到，比放着不搁置还糟。
 */
export function dueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((t) => {
    if (isSettled(t.status)) return false;
    return t.reminders.some((r) => isDue(r, now) || isDueAgain(t, r, now));
  });
}

/**
 * **隔多久再响一次**（持续提醒那一档）。
 *
 * 10 分钟，跟横幅上那颗「稍后 10 分钟」是同一个节奏——但**它们是两个概念，
 * 只是碰巧同值**：那个是「把这条提醒往后推多久」，这个是「还没处理就隔多久
 * 再喊一声」。所以不共用一个常量，也别在改其中一个时顺手改另一个。
 * （那颗按钮那个数在 `web/src/App.tsx` 和 `desktop/src/notify.ts` 各有一份，
 * 两处注释互相指着，说的是「两个壳里推的量该一样」。）
 *
 * ## 这个节奏跟滴答**不一样**，是故意的
 *
 * 滴答的持续提醒是**几分钟内的一次爆发**，不是无限期低频重复：Android
 * 「响 30 秒、停 30 秒的节奏循环播放，**持续 5 分钟**」，iOS 旧版「1min 内
 * 2 次提醒」（《持续提醒》）。
 *
 * 那个节奏是给手机的：人揣着手机，五分钟内轮番震动几乎一定被感知到。
 * 这边响的是**桌面**——网页横幅要那一刻网页开着，系统通知会堆进通知中心。
 * 五分钟内爆发几次跟响一次的结果差不多（人不在电脑前就是不在），而**十分钟
 * 一次、直到处理为止**才真的能接住「离开工位二十分钟回来」这一类。
 *
 * 换句话说：跟滴答一致的是那句「直到你进行处理」，不是它的节奏参数。
 */
export const PERSIST_EVERY_MS = 10 * 60_000;

/**
 * **这条提醒已经响过，但任务还没被处理，而且离上次响够久了。**
 *
 * 只对开了 `persistentReminder` 的任务成立。`firedAt` 在这一档下的含义因此
 * 从「响过了」变成「**上次**响的时刻」——这是有意的：不盖章的话每 30 秒
 * 重判一次会变成每 30 秒响一次，而且手机那边 `notifyPlan` 的 `missed` 会
 * 一直挂着它。
 *
 * 「处理」的定义在 `Task.persistentReminder` 上：完成/搁置/放弃（上面
 * `dueTasks` 第一行就挡掉了）、按「稍后」（改时刻 + 清章，回到普通那条路）、
 * 或者删掉提醒。**只关掉横幅不算**——那正是滴答那句「直到你进行处理」要挡的。
 */
const isDueAgain = (t: Task, r: Reminder, now: Date): boolean => {
  if (t.persistentReminder !== true || !r.firedAt) return false;
  const last = Date.parse(r.firedAt);
  return !Number.isNaN(last) && now.getTime() - last >= PERSIST_EVERY_MS;
};

/** 到点、还没发过、时间解析得出来。解析不了显式跳过（多半是手改文件时写了「下周三」）。
 * 靠 NaN 比较恒为 false 来兜底是不行的：哪天有人把条件写成 `!(at > now)`，
 * 所有坏格式会在同一秒里一起炸成提醒。 */
const isDue = (r: Reminder, now: Date): boolean => {
  if (r.firedAt) return false;
  const at = Date.parse(r.at);
  return !Number.isNaN(at) && at <= now.getTime();
};

/**
 * 「错过多久之内还补响」。
 *
 * `isDue` **没有下界**——服务停着的那段时间里到点的提醒，一律攒着，等下一次
 * 启动后的第一轮扫描一起发。停一晚上再开机，就是十几条系统通知同时炸出来
 * （每条还各起一个 PowerShell 进程、各发一条 webhook）。**那时候「现在响」
 * 已经不是提醒，是打扰**：那几件事早就过去了，而它们并没有丢——
 *
 * - 「今天」视图收它们（`isReminderOverdue`：提醒在更早一天已经触发过、任务
 *   还没做完），卡片上红着「过期 N 天」，头上那行还报「其中 N 条已过期」；
 * - 每日概览到点会把过期的和今天到期的一起推一条。
 *
 * 所以超过这个窗口的**只盖章、不响**：盖章那一步不能省，不盖的话每 30 秒
 * 重新判一次、手机那边 `notifyPlan` 的 `missed` 也会一直挂着它们。
 *
 * 一小时：服务重启、笔记本合盖一会儿、打个盹这类「刚错过」的还响得到；
 * 隔夜、隔周的不响。
 */
export const CATCH_UP_MS = 60 * 60_000;

/** 这条任务身上「刚到点」的提醒——有一条在窗口内就算刚到点。 */
const isFresh = (t: Task, now: Date): boolean =>
  t.reminders.some((r) => (isDue(r, now) && Date.parse(r.at) >= now.getTime() - CATCH_UP_MS)
    // **持续提醒的重响永远算「刚到点」**，不受 `CATCH_UP_MS` 那道窗口约束。
    // 那道窗口挡的是「服务停一晚上，早就过去的事一起炸出来」；而持续提醒是
    // 他明确要求的「没处理就一直喊」——那件事**此刻仍然没处理**，不是过去式。
    // 用 `r.at` 去卡它等于开了一小时就自动失效，那这一档就不存在了。
    || isDueAgain(t, r, now));

/** due 显示成本地格式；解析不了就原样吐回去，别弹一条「截止 Invalid Date」出来。 */
function formatDue(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString('zh-CN');
}

/**
 * AppleScript 字符串字面量。标题/正文是用户或 AI 写的原文，**必须转义**——
 * 一个裸的 `"` 就能把 `display notification "…"` 这句话截断，后面的内容会被
 * osascript 当成 AppleScript 代码去解释。这跟 Windows 那条不一样：那边走
 * `execFile` 的参数数组交给 PowerShell 脚本的具名参数，没有拼串这一步。
 *
 * 顺序有讲究：**反斜杠必须先转**，不然下一步为 `"` 插进去的那个反斜杠会被
 * 再转一次，变成一个字面反斜杠加一个没转义的引号。
 * 真换行也要吃掉：AppleScript 的字符串字面量里不能出现裸换行。
 */
function asAppleScriptString(s: string): string {
  return `"${s.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 兜底通知要跑的命令，按平台分档；这个平台没有就返回 null（静默跳过）。
 *
 * 纯函数、`platform` 当参数传，理由跟 desktop 那边 `buildNotificationOptions`
 * 一样：`process.platform` 在测试里改不动，而分支本身正是要测的东西。
 *
 * **这一层是「桌面端不在线」时的兜底**（桌面端在线时它自己弹，见下面
 * `fireReminders` 里那句）。原来只有 win32 一档、其余平台直接 return——
 * 于是 mac/Linux 上不装桌面版就完全收不到提醒，装了也收不到（桌面版那边
 * 的 `toastXml` 在非 Windows 上是空通知，见 desktop/src/notify.ts）。
 * 两层一起坏，而「到点提醒」是这个应用的第一句承诺。
 *
 * ponytail: **mac 走 `osascript`、Linux 走 `notify-send`，都不带按钮**，跟
 * Windows 那条 toast 上的「完成」「推迟 10 分钟」不对等。`osascript` 的
 * `display notification` 本来就没有按钮（要按钮得做成一个真的 .app 或者装
 * terminal-notifier）；`notify-send` 的 `--action` 要 GLib 事件循环等回调，
 * 一个发完就退出的短命进程接不住。天花板是「弹得出来、看得见」，够兜底用。
 * `notify-send` 没装（最小化的桌面环境）会 ENOENT，跟没装 PowerShell 一样
 * 落一行 warn 就算了，不影响另外两路。
 */
export function notifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  scriptPath: string,
): { cmd: string; args: string[] } | null {
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Title', title, '-Body', body],
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', `display notification ${asAppleScriptString(body)} with title ${asAppleScriptString(title)}`],
    };
  }
  if (platform === 'linux') {
    // `--` 收尾选项解析：标题以 `-` 开头的任务（「-1 号方案」之类）不会被
    // GLib 的参数解析当成选项。
    return { cmd: 'notify-send', args: ['--', title, body] };
  }
  return null;
}

/**
 * 系统原生通知，直接给 title/body。平台不支持就静默跳过（`notifyCommand` 返回 null）。
 *
 * 导出是因为 app.ts 的 `POST /api/desktop/notify-failed` 也要用它——桌面端「在线」
 * （SSE 连接活着）不等于它自己的 Electron 通知真的弹出来了（用户关了系统通知、
 * AUMID 没注册好，`Notification.show()` 会静默失败），desktop/src/main.ts 发现
 * 弹失败时把算好的 title/body 报回来，直接走这个函数补发一次，不重新从 Task
 * 推一遍文案（桌面端用的是 notify.ts 的 `toNotification`，服务端没必要另外
 * 维护一份同款推断规则）。下面 `toast(task)` 是 fireReminders 用的那个，
 * 文案从 Task 推——两处最终都落到这一个函数、同一个 execFile 调用。
 */
export async function toastRaw(title: string, body: string): Promise<void> {
  const script = join(here, '..', '..', 'scripts', 'toast.ps1');
  const c = notifyCommand(process.platform, title, body, script);
  if (!c) return;
  await new Promise<void>((resolve) => {
    execFile(c.cmd, c.args, (err) => {
      if (err) console.warn('[提醒] 系统通知没弹出来：', err.message);
      resolve();   // 弹不出来不影响另外两路
    });
  });
}

async function toast(task: Task): Promise<void> {
  const body = task.due ? `截止 ${formatDue(task.due)}` : task.notes || '该做这件事了';
  return toastRaw(task.title, body);
}

async function webhook(url: string, task: Task): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[提醒] webhook 发送失败：', (e as Error).message);
  }
}

/**
 * 扫一遍到期任务，先在到期的那几条 reminders 上盖上 firedAt 再三路发出去。
 *
 * **发失败也要盖章。** 不盖的话一个连不上的 webhook 会让同一条提醒每 30 秒重来一次，
 * 而网页横幅那一路本来是成功的——用户看到的是同一条提醒刷屏。
 *
 * **盖章必须在发送之前，不能在之后。** toast 要起一个 PowerShell 进程（几百毫秒到几秒），
 * webhook 最多等 5 秒——发送这几秒是个实打实的窗口，AI agent 可能正在往 tasks.json 里
 * 追加任务、用户可能正在网页上点掉一张卡。旧写法是发完了才用发送前读到的那份数组整个覆盖回去，
 * 这几秒里落地的任何别的写入都会被这次回写默默吞掉。改成先读、先盖章、先写盘，
 * 再发送、不再写第二次，这一路的读-写就跟其他所有路由一样收窄成同步的一对，
 * 不再有一个跨越发送耗时的窗口。副作用是 setInterval 万一叠着跑（上一轮还没发完，
 * 下一轮又到点），第二轮 readTasks() 时 firedAt 已经盖上了，dueTasks 会把它们
 * 排除掉——不需要额外的重入锁。
 *
 * 没有到期任务时一个字节都不写：这函数每 30 秒跑一次，
 * 无条件回写会让 watcher 和所有前端连着刷一整天。
 *
 * **盖章的范围和「响不响」的范围不一样**：到点没盖章的全部盖上（不盖的话每
 * 30 秒重判一次、手机那边的 `missed` 也一直挂着），但只有「刚到点」的那几条
 * 才真的发出去——服务停一晚上再开机不该是十几条通知同时炸，见 `CATCH_UP_MS`。
 * 返回值也只给发出去的那几条：调用方（`index.ts` 的定时器）只拿它记日志，
 * 报一个「发了 12 条」而实际上一条都没弹，比不报还糟。
 */
export async function fireReminders(bus: Bus, now = new Date()): Promise<Task[]> {
  const tasks = readTasks();
  const due = dueTasks(tasks, now);
  if (due.length === 0) return [];

  // **先把设置读出来，再盖章。** 盖章（`writeTasks` 写 `firedAt`）是不可逆的：
  // `isDue` 一看到 `firedAt` 非空就永远返回 false，那条提醒从此不会再响。而
  // `readSettings()` 是会抛的——`device.json` 被外部编辑器/同步盘写坏时
  // `readJson` 明确选择抛出（它自己的注释：「绝不静默回落到 fallback」）。
  //
  // 顺序反了的话：章盖上 → 读设置抛出 → `index.ts` 吞成一句 console.warn →
  // **这一批提醒被永久标成「已发」，而一条都没发出去**，除非有人去手改文件。
  // 实测复现过：把 device.json 写成 `{ 这不是 JSON`，`fireReminders` 抛异常，
  // 而那条提醒的 `firedAt` 已经落盘了。
  //
  // 同文件的 `fireDailySummary` 本来就是「先读设置、后写盘」，这里跟它对齐。
  const settings = readSettings();

  const stamp = now.toISOString();
  const fired = new Set(due.map((t) => t.id));
  // 同一条任务上两个提醒同时到期只通知一次（下面 due.map 只发一条 bus.emit），
  // 但两条都要盖章——只盖「这条任务上到期的那几个提醒」，没到期的和已经
  // 发过的原样保留。
  writeTasks(tasks.map((t) => (fired.has(t.id)
    ? { ...t, reminders: t.reminders.map((r) => (isDue(r, now) || isDueAgain(t, r, now) ? { ...r, firedAt: stamp } : r)) }
    : t)));

  // 只有「刚到点」的才真的发。攒了一夜的那些已经盖过章了，它们在「今天」里
  // 红着、每日概览也会报——见 `CATCH_UP_MS`。
  const fresh = due.filter((t) => isFresh(t, now));
  if (fresh.length === 0) return [];

  // 桌面端在线时它自己会走 Electron 原生通知（订阅同一个 bus 的 'reminder' 事件）——
  // PowerShell 只在桌面端不在线时当兜底，两条路同时开会让同一条提醒弹两次。
  const desktopOnline = bus.isDesktopOnline(now);
  for (const t of fresh) {
    bus.emit('reminder', t);
    if (settings.toastEnabled && !desktopOnline) await toast(t);
    await webhook(settings.webhookUrl, t);
  }
  return fresh;
}


/**
 * 每日概览：到点了就把今天要做的推一条出来。
 * 没到点 / 没开 / 今天已经推过，都返回 `null` 且一个字节都不写。
 *
 * **先盖章再发送**，跟 `fireReminders` 一模一样的顺序和理由：发送是个跨秒的
 * 窗口，先发后盖的话，这三十秒里 tick 又转一轮就会推第二条；而发失败也照样
 * 盖章——一个连不上的 webhook 不该让同一条概览每三十秒重来一次。
 *
 * **一件事都没有时不发**：一条「今天 0 件事」的通知每天准时出现，只会让人
 * 学会忽略这个通知。真的什么都没有，沉默就是最好的汇报。
 */
export async function fireDailySummary(bus: Bus, now = new Date()): Promise<{ title: string; body: string } | null> {
  const settings = readSettings();
  if (!shouldSendSummary(settings, now)) return null;

  const due = summaryTasks(readTasks(), now);
  // 空的也要盖章：不盖的话这一天剩下的每一轮 tick 都会重新算一遍、重新判一次，
  // 而且晚上真的多出一条任务时会突然推一条「今天 1 件事」——那时候说已经晚了。
  writeSettings({ ...settings, dailySummaryOn: localDay(now) });
  if (due.length === 0) return null;

  const text = summaryText(due, now);
  bus.emit('daily-summary', text);
  // 桌面端在线时它自己会弹（订阅同一个 bus），PowerShell 只在它不在线时兜底
  // ——两条路同时开会让同一条概览弹两次。跟 fireReminders 那行同一条。
  if (settings.toastEnabled && !bus.isDesktopOnline(now)) await toastRaw(text.title, text.body);
  await summaryWebhook(settings.webhookUrl, text);
  return text;
}

/** 概览那一路 webhook。**跟单条提醒的 body 分开**：那边发的是一整个 Task 对象，
 *  这边没有「某一条任务」可发，硬塞一个假的 Task 会让接收端的解析当场歪掉。 */
async function summaryWebhook(url: string, text: { title: string; body: string }): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daily-summary', ...text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[每日概览] webhook 发送失败：', (e as Error).message);
  }
}
