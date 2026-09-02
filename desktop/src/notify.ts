// 单条提醒：title 固定是「该做了」，body 是任务标题；id 是那条任务的 id——
// 点通知/点「完成」「推迟」按钮都要靠它找到具体是哪条任务，见 main.ts
// openTask()/applyProtocolAction()（协议 URI 本身怎么解析出 id 在 protocol.ts
// 的 parseProtocolUri()）。
//
// **`id` 是 `null` 就是「这条通知不指向某一条任务」**——每日概览说的是一整天，
// 没有哪一条可以「完成」或者「推迟」。那种通知不带按钮，点它开主窗口。
export interface NotifyContent { id: string | null; title: string; body: string }

/**
 * 服务端总线上有五种事件（server/src/events.ts）：`reminder`（载荷是整个
 * `Task`）、**`daily-summary`**（每日概览，载荷是 `{ title, body }`）、
 * `data-changed`（每次改动都发，弹通知等于刷屏）、`agent-status`（拆解进度，
 * 网页上已经有）、`ping`（心跳）。前两种该弹原生通知。
 *
 * **`daily-summary` 是后加的，这儿漏了整整一档。** 这一行原来写死
 * `if (event !== 'reminder') return null`，而服务端那侧的兜底是
 * 「桌面端在线就不另起 PowerShell 弹窗，它自己会弹」（reminder.ts
 * `fireDailySummary`）——两下一凑，**桌面端开着的时候每日概览谁也收不到**：
 * 桌面端丢掉它，服务端以为桌面端弹了。而「桌面端开着」正是这个应用的常态。
 * webhook 那一路照发，所以配了 webhook 的人看不出问题。
 *
 * `data/tasks/*.json` 是用户/AI 都能手改的文件，`GET /api/tasks` 不校验里面
 * 的数据（TaskCard.tsx 同款注释）——载荷不是预期形状（不是对象、没有 id、
 * id 不是字符串或是空串、没有 title、title 不是字符串、trim 后是空串）
 * 一律返回 null，不抛，不然一条坏数据能把通知这条路整个炸掉。
 */
export function toNotification(event: string, data: unknown): NotifyContent | null {
  if (event !== 'reminder' && event !== 'daily-summary') return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  // 概览：标题和正文都是服务端拼好的（`dailySummary.ts` 的 `summaryText`），
  // 这儿只做跟单条提醒同一套的形状校验，不重新拼一遍文案。
  if (event === 'daily-summary') {
    const t = (data as { title?: unknown }).title;
    const b = (data as { body?: unknown }).body;
    if (typeof t !== 'string' || t.trim() === '') return null;
    return { id: null, title: t.trim(), body: typeof b === 'string' ? b : '' };
  }

  const id = (data as { id?: unknown }).id;
  if (typeof id !== 'string' || id.trim() === '') return null;

  const title = (data as { title?: unknown }).title;
  if (typeof title !== 'string') return null;

  const body = title.trim();
  if (!body) return null;

  return { id, title: '该做了', body };
}

// Windows 协议激活用的 URI scheme。main.ts 用它注册协议处理器
// （app.setAsDefaultProtocolClient）、解析 second-instance 收到的 argv；
// buildToastXml() 用它拼两个按钮的 arguments——两边共用同一个字面量，
// 不重复写两份、以后要改一起改。
export const PROTOCOL = 'todo-desktop';

// 「推迟」按钮的偏移分钟数。**按钮文案（下面 buildToastXml 的
// `推迟 ${SNOOZE_MINUTES} 分钟`）和实际改的提醒时间（protocol.ts
// patchForAction() 的 `SNOOZE_MINUTES * 60_000`）必须读同一个常量**——
// code review 抓到过这两处原来是两个互不相关的字面量（文案写死「10 分钟」，
// 偏移写死 `10 * 60_000`），把偏移改成 `10 * 1_000`（1 分钟）不会让任何
// 测试变红，因为没有一条测试把「文案说的数字」和「真正生效的偏移」绑在
// 一起比较。改成从这一个常量派生，两边就不可能再各自漂移。
//
// **跟网页上那颗「推迟」不是同一个数，也不该是**（`web/src/lib/reschedule.ts`
// 的 `POSTPONE_MINUTES = 60`，仿滴答清单那颗一小时的按钮）。那一颗是「这条任务
// 今天晚点再说」，人正在整理清单；这一颗是通知弹到脸上时的贴条，人正在被打断。
// 两边的按钮都把数字写在脸上（「推迟 1 小时」/「推迟 10 分钟」），不会有人被
// 误导——别看见两个数就去「统一」它们。
//
// **跟网页横幅上那颗「稍后」倒是必须一致**（`SNOOZE_CHOICES[0]`，也是 10）：
// 那是同一个动作的两个入口，推的量不一样就是坏数据。网页那颗旁边多一个小箭头
// 能选 30 分钟和 1 小时（仿 Things 的 10/30/60），**这儿只有一档**：Windows 的
// toast 是一条转瞬即逝的横条，四颗按钮挤上去比没有更糟，而且每多一档就要在
// 协议里多一个 action（`protocol.ts` 的 `ProtocolAction`）。那是超集，不是分叉
// ——两边点下去的默认结果一模一样。
export const SNOOZE_MINUTES = 10;

// XML 转义。标题/备注是用户或 AI 写的原文，可能带 `&`/`<`/`>`/`"`——不转义
// 的话拼出来的 toastXml 不良构（比如标题里一个裸 `<` 会被 Windows 的 XML
// 解析器当成标签开始），Windows 直接拒收整条通知，不会报错给 Electron，
// 只是通知悄悄不出现。顺序有讲究：`&` 必须先替换，不然后面几条替换插入的
// `&lt;`/`&gt;` 里的 `&` 会被第一条规则再吃一遍。
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 按钮 `arguments` 用的协议 URI，例如 `todo-desktop://complete?id=abc`。 */
function actionUri(kind: 'complete' | 'snooze', id: string): string {
  return `${PROTOCOL}://${kind}?id=${encodeURIComponent(id)}`;
}

/**
 * 拼 Windows 自定义 toast 的完整 XML。**`toastXml` 一旦给了，
 * `NotificationConstructorOptions` 里的 `title`/`body`/`icon` 全部被忽略**
 * （Electron 类型定义里 `toastXml` 字段的原话：「superseding all properties
 * above」）——整条通知的内容都得在这里自己拼出来，不能指望别的字段补漏。
 *
 * 纯函数、不碰任何 Electron API——main.ts 引 electron 进不了 vitest（见
 * main.test.ts 顶部注释），这个函数是这个 Task 唯一能在这个沙盒里真正测到底
 * 的逻辑，特意抽出来单独测，不埋在 main.ts 里。
 *
 * 两个按钮（「完成」「推迟 10 分钟」）走 `activationType="protocol"` +
 * `arguments`，**不是 `NotificationConstructorOptions.actions` 字段**——
 * 那个字段是 macOS 专属，Windows 上无效，见 main.ts 顶部说明。点击后
 * Windows 把这个 URI 当协议链接启动，命中 main.ts 里
 * `app.setAsDefaultProtocolClient(PROTOCOL)` 注册过的处理器，因为单实例锁
 * 已经被原来那个实例占着，新进程的命令行参数（含这个 URI）会经
 * `app.on('second-instance', …)` 转发回来，那边解析出 kind/id 直接 PATCH
 * 服务端，不开窗口——quick action 的意义就是不用打开应用。
 *
 * 通知本体被点击（不是点某个按钮）不走这条协议路径：继续用 Electron 原生的
 * `Notification.on('click')`（main.ts 一直在用，冒烟清单第 5 条验过能弹出
 * 窗口）——这里不设 `<toast activationType=…>`，留系统默认的 "foreground"，
 * 跟没有 toastXml 时的点击行为一致，少一条这个沙盒没法验证的新路径。
 */
export function buildToastXml(n: NotifyContent, iconFileUrl: string): string {
  const icon = escapeXml(iconFileUrl);
  const title = escapeXml(n.title);
  const body = escapeXml(n.body);
  // **没有 id 就不出按钮**（每日概览）：两颗按钮的 arguments 里都要塞一个任务
  // id，而概览说的是一整天。硬塞一个空 id 的话，Windows 照样把按钮画出来，
  // 点下去走协议、服务端拿一个空 id 什么也找不到——一颗按下去没反应的按钮
  // 比没有这颗按钮糟得多。
  const actions = n.id === null ? '' :
    '<actions>' +
    `<action content="完成" arguments="${escapeXml(actionUri('complete', n.id))}" activationType="protocol"/>` +
    `<action content="推迟 ${SNOOZE_MINUTES} 分钟" arguments="${escapeXml(actionUri('snooze', n.id))}" activationType="protocol"/>` +
    '</actions>';
  return (
    '<toast>' +
    '<visual><binding template="ToastGeneric">' +
    `<text>${title}</text>` +
    `<text>${body}</text>` +
    `<image placement="appLogoOverride" hint-crop="circle" src="${icon}"/>` +
    '</binding></visual>' +
    actions +
    '</toast>'
  );
}

/**
 * 一条通知交给 Electron 的构造参数，按平台分档。
 *
 * **这个函数存在的理由是一条真 bug**：原来 main.ts 无条件走
 * `showNotification({ toastXml: buildToastXml(...) })`。`toastXml` 是
 * **Windows 专属**字段，mac/Linux 上被整个忽略——而这里从来没传过
 * `title`/`body`，所以那两个平台上到点弹出来的是一条**空通知**。
 * 「到点提醒你」是这个应用的第一句承诺，它在非 Windows 上是坏的，
 * 而且坏得没声音（`Notification.show()` 不报错、`'failed'` 也不触发）。
 *
 * 纯函数、`platform` 当参数传：`process.platform` 在测试里改不动（只读），
 * 而这三档的分支正是要测的东西。main.ts 不传，用真实平台。
 *
 * ponytail: **非 Windows 没有「完成」「推迟」两颗按钮**。Windows 的按钮走
 * toast XML 的 `activationType="protocol"`；mac 的对应物是
 * `NotificationConstructorOptions.actions`，但它要求通知是 alert 样式
 * （用户可在系统设置里改成横幅，那样按钮就不出现），Linux 则取决于桌面环境
 * 装的是哪个通知守护进程，两边都给不出 Windows 那种稳定行为。天花板是
 * 「点通知本体打开那条任务」，这条三平台都成立（`Notification.on('click')`）。
 * 真要补，先补 mac 的 `actions`，Linux 维持现状。
 */
export function buildNotificationOptions(
  n: NotifyContent,
  icon: { fileUrl: string; path: string },
  platform: NodeJS.Platform = process.platform,
): { toastXml: string } | { title: string; body: string; icon: string } {
  if (platform === 'win32') return { toastXml: buildToastXml(n, icon.fileUrl) };
  // 非 Windows 用普通字段。`icon` 这里要的是**文件系统路径**，不是 file:// URL
  // （那份是拼进 toast XML 给 Windows 自己读的）——传错的话 mac 上图标不显示，
  // 同样不报错。mac 其实会忽略它、一律用应用图标，Linux 认；传着无害。
  return { title: n.title, body: n.body, icon: icon.path };
}
