import { Capacitor, type PermissionState } from '@capacitor/core';
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications';
import type { Task } from '../types.js';
import { planNotifications, toNotificationSchema } from './notifyPlan.js';

/**
 * 「只在原生壳里排」的判据。两个条件缺一不可，都是从装好的 @capacitor/core
 * 源码核出来的（node_modules/@capacitor/core/dist/index.js 48–58 行）：
 *
 * - isNativePlatform()：`getPlatform() !== 'web'`，platform 来自 window 上有没有
 *   原生桥（androidBridge），不是 UA 嗅探。少了它：这个插件带 web 实现
 *   （dist/esm/index.js 的 `registerPlugin('LocalNotifications', { web: ... })`，
 *   底下是 Web Notification API），`isPluginAvailable` 那一半在浏览器/Electron 里
 *   恒真——桌面会用浏览器通知再排一份，而桌面的提醒路已经存在（fireReminders →
 *   Electron/PowerShell），那是同一台机器响两次。
 * - isPluginAvailable('LocalNotifications')：web 平台看 JS 实现注册没注册，
 *   android 平台看原生 PluginHeaders。少了它：壳里插件没接进原生工程时
 *   （本仓库出现过——修这批之前 capacitor.plugins.json 是 `[]`）每次调用
 *   都异步抛 "not implemented on android"，通知静默全灭。
 *
 * 装依赖时当场核实的两条（设计正本第十一节标的待核实风险；出处一律是
 * node_modules/@capacitor/local-notifications@8.3.1，原生实现是 Kotlin 不是 Java）：
 *
 * - **精确闹钟**：插件自己的 android/src/main/AndroidManifest.xml 第 26–29 行声明了
 *   `SCHEDULE_EXACT_ALARM`（**不是** `USE_EXACT_ALARM`）、`POST_NOTIFICATIONS`、
 *   `RECEIVE_BOOT_COMPLETED`、`WAKE_LOCK` 四条，**所以 android/app/src/main/
 *   AndroidManifest.xml 这次一个字没改**——这一步靠的是 manifest-merger 把库
 *   manifest 的权限并进应用。
 *   ⚠️ **「合并会发生」这句在这个仓库里没有被证实过**：写它时引的那份
 *   manifest-merger-blame 报告是**插件接线之前**的旧构建产物（复审核出来的，
 *   行号也对不上），证明不了这次。它是 Android 构建的标准行为、不是猜，但
 *   **本仓库这次没跑过构建**。**验它的办法是装出 APK 之后在系统里看应用权限
 *   列表——进冒烟清单，别当已知事实。**（这一批「理由写得比事实硬」已经出现
 *   六次，这条是第七次的苗头：结论八成对，而当时手里那条佐证是假的。）
 *   排程走 LocalNotificationManager.kt `setExactIfPossible()`（350–378 行）：
 *   `useExact = isExactNotification && canScheduleExactAlarms()`，
 *   `canScheduleExactAlarms()` 在 API < 31 恒真、31+ 问系统。给了就
 *   `setExactAndAllowWhileIdle`/`setExact`，**没给就退化成 `setAndAllowWhileIdle`/
 *   `set`（不精确）并打一行 warn 日志**——也就是设计正本担心的「晚几分钟」，
 *   而且它不报错。`isExactNotification` 默认 true（definitions.d.ts 881–896 行）。
 *   要用户去开的话插件有现成的两个方法：`checkExactNotificationSetting()` 读
 *   `{ exact_alarm: PermissionState }`、`changeExactNotificationSetting()` 跳系统
 *   「闹钟和提醒」设置页；另外 API 31+ 上 `schedule()` 自己也会在没权限时先跳一次
 *   那个设置页（LocalNotificationsPlugin.kt 126–133 行），降级排成功时结果里带
 *   `warning`（ScheduleResult.warning，definitions.d.ts 265–290 行）。
 *   **「默认给不给」只能真机验**——源码里问的是系统当场的答案，不是常量。
 * - **开机重排**：真有这条路。插件 manifest 第 6–15 行注册了
 *   `LocalNotificationRestoreReceiver`（directBootAware，收 BOOT_COMPLETED /
 *   LOCKED_BOOT_COMPLETED / QUICKBOOT_POWERON），权限 `RECEIVE_BOOT_COMPLETED`
 *   也是它自己声明的。receiver 的 onReceive（LocalNotificationRestoreReceiver.kt
 *   12–62 行）把 NotificationStorage 里存过的通知全读出来重新
 *   `LocalNotificationManager.schedule()`；关机期间错过的那些改排到「现在 +15 秒」
 *   补一声；已经响过的一次性通知跳过（不会每次重启重响）。
 *   **这只证明「代码里有这条路」，重启后真的重排要真机验**，见
 *   android/冒烟清单.md 第 9 步。
 */
export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LocalNotifications');
}

/**
 * 插件那层的接口。测试替身切在这里（144：这是外部系统的边界）；分支逻辑
 * 一条都不许下沉到实现里——nativePort 的每个方法一行、零分支。
 */
export interface NotifyPort {
  available(): boolean;
  checkPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  /**
   * 精确闹钟给了没有。**问这一下不弹任何东西**——核过的（出处
   * node_modules/@capacitor/local-notifications@8.3.1 的
   * android/.../LocalNotificationsPlugin.kt）：`checkExactNotificationSetting()`
   * （497–502 行）只是 `JSObject().put("exact_alarm", …)` 然后 `call.resolve()`，
   * 没有 Intent、没有 startActivityForResult；跳系统设置页的是另一个方法
   * `changeExactNotificationSetting()`（484–495 行），这一批不用它。
   * `getExactAlarmPermissionText()`（517–523 行）只吐 'granted'/'denied' 两种、
   * 不会吐 'prompt'，**API < 31 恒 'granted'**——跟排程那条路自己用的
   * `canScheduleExactAlarms()`（190–196 行）是同一个判据，老设备上这条判断
   * 恒为「给了」。
   */
  exactPermission(): Promise<PermissionState>;
  pendingIds(): Promise<number[]>;
  cancel(ids: number[]): Promise<void>;
  schedule(notifications: LocalNotificationSchema[]): Promise<void>;
}

/**
 * 薄壳：真的调插件。一行一个方法、零分支——逻辑全在
 * `rescheduleLocalNotifications` 和 `notifyPlan.ts`，这里不可测（jsdom 没有
 * 原生桥），行为在 android/冒烟清单.md 第 9 步真机验。
 *
 * `pendingIds`/`cancel` 里那两个 `map` 是**形状适配**（插件说 `{ id }[]`、
 * port 说 `number[]`），零决策零分支；`schedule` 末尾的 `.then(() => undefined)`
 * 同理，把 `ScheduleResult` 抹成 `void`——**丢掉里面的 `warning` 是有意的**，
 * 理由见下面 `rescheduleLocalNotifications` 里精确闹钟那段。
 *
 * `LocalNotifications` 在这个文件被 import 也是刻意的：注册它的 web 实现，让
 * 上面 `isNativeShell` 里 `isPluginAvailable` 那半在「web 平台 + 单用它」的
 * 坏改法下真的翻 true、被那条测试打红。
 */
export const nativePort: NotifyPort = {
  available: () => isNativeShell(),
  checkPermission: async () => (await LocalNotifications.checkPermissions()).display,
  requestPermission: async () => (await LocalNotifications.requestPermissions()).display,
  exactPermission: async () => (await LocalNotifications.checkExactNotificationSetting()).exact_alarm,
  pendingIds: async () => (await LocalNotifications.getPending()).notifications.map((n) => n.id),
  cancel: (ids) => LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }),
  schedule: (notifications) => LocalNotifications.schedule({ notifications }).then(() => undefined),
};

/**
 * 上一轮还没跑完的那条链。**整体重排是对「这台手机」这一份共享状态的读-改-写，
 * 两轮叠着跑就是数据竞争**：`ids` 在 `pendingIds()` 那一句读进来，`cancel(ids)`
 * 隔着两个 await 才用掉，而 SSE 一次数据变更常连发几个 `data-changed`，每次
 * `reload()` 都 `setTasks` 一份新数组、每份都触发一轮重排。
 *
 * **编号策略把伤害放大到最大**：notifyPlan.ts 的 id 是每轮 `1..N` 重发的，所以
 * 落后那一轮手里那份「过期」id 列表，**恰好精确等于新那一轮刚排上的那批**——它的
 * `cancel` 一旦排在新那轮的 `schedule` 之后，手机就归零了，要等下一次数据变化
 * 才恢复。
 *
 * **选串行、不选「effect cleanup 置失效标记」**：失效标记要么把 `AbortSignal`
 * 那类东西穿进这个函数、在每两个 await 之间补一次检查（薄壳之上再长出分支，而
 * 这正是这一批一直在压的东西），要么就压不住——检查通过之后 `schedule()` 那一句
 * 照样可能落在新那轮后面，只是把「归零」换成「留着旧数据」，仍然是错的。串行是
 * 这里唯一能一句话说清的正确：**后到的那轮最后落地，它的数据就是最终状态**，
 * 而每一轮本来就是幂等的（全取消再排一遍），多跑几轮没有代价。
 *
 * ponytail: 一轮卡死（原生桥不 resolve）会挡住后面所有轮。不加超时是因为
 * 「桥卡住」时手机上是什么状态本来就不知道，超时之后抢着再排一轮只会让两轮
 * 同时在飞——正是这条链要消灭的东西。真撞上了，下一步是给桥调用加超时并把
 * 这一轮判死，不是把链拆掉。
 */
let inFlight: Promise<unknown> = Promise.resolve();

/**
 * 整体重排：把这个应用排过的全部取消，再按当前这份数据排前 32 条。不做增量
 * ——增量是「N 个地方各自维护一份状态，漏一处静默失灵」，整体重排在个人量级
 * 的代价（几十条取消+重排）可以忽略（设计正本第十一节）。
 *
 * 手机独立排，不拿服务端 firedAt 当「桌面替我响过」的抑制信号——桌面和手机
 * 都响是对的（应用不知道人此刻在哪，日历应用都这么做）。
 *
 * 返回值给界面用：'denied' 要挂常驻横幅（没拿到权限就是一条都不会响，必须
 * 说出来，不许变成静默的空操作）；'not-native'/'ok' 都不用说话。
 *
 * 「现在几点」一律从 `now` 参数进来，这个文件里没有无参数 `new Date()`。
 *
 * **多轮之间严格串行**（上面那条 `inFlight` 链），理由见它上面的注释。
 */
export function rescheduleLocalNotifications(
  tasks: Task[],
  now: Date,
  port: NotifyPort = nativePort,
): Promise<'not-native' | 'denied' | 'ok'> {
  const run = inFlight.then(() => reschedule(tasks, now, port));
  // 链上挂的是**吞掉异常**的那一份：这一轮抛了不该让后面每一轮都跟着 reject
  // （`schedule()` reject 是真会发生的，见 App.tsx 那条 `.catch`）。调用方拿到的
  // 仍是 `run` 本身，该抛照抛。
  inFlight = run.catch(() => undefined);
  return run;
}

async function reschedule(
  tasks: Task[],
  now: Date,
  port: NotifyPort,
): Promise<'not-native' | 'denied' | 'ok'> {
  if (!port.available()) return 'not-native';
  const st = await port.checkPermission();
  // denied 不再 request：安卓拒过之后 requestPermissions 只会静默返回 denied，
  // 弹不出对话框，白问；prompt / prompt-with-rationale 才值得问一次。
  const perm = st === 'granted' || st === 'denied' ? st : await port.requestPermission();
  if (perm !== 'granted') return 'denied';
  const ids = await port.pendingIds();
  // 精确闹钟给了没有——**这一句必须问在 cancel 之前，别顺手挪回 schedule 旁边**。
  // 它会抛（`getExactAlarmPermissionText()` 517–523 行用的是非空强转
  // `as AlarmManager`，而排程那条路的 `canScheduleExactAlarms()` 190–196 行把
  // null 当「给了」——两边对同一种情况的处理不一致）。排在 cancel 之后的话，
  // 失败态不是「报了个错」，是**「旧的全取消了、新的一条没排」**：界面弹一条
  // 错误，而手机上此刻零条提醒，要等下一次 reload() 才恢复。问在前面，抛的
  // 时候旧通知原封不动还在，那个放大效应就没了。
  // 代价只有「零条可排」那轮白问一次——它是只读的，不弹任何东西（出处见上面
  // NotifyPort.exactPermission 的注释），白问没有任何副作用。
  const exact = await port.exactPermission();
  // 零条可排也照取消：上一轮排的那些还躺在系统里，而它们可能已经不该响了
  // （昨天排的提醒、今天那条任务做完了）。所以取消在 planNotifications 之前，
  // 不看这次有没有东西可排。
  if (ids.length > 0) await port.cancel(ids);
  // 排序稳定性的风险源在**调用方**，不在 planNotifications：那个纯函数内部
  // 是确定的（V8 稳定排序 + 全程原序遍历），但两条提醒时刻**完全相同**时，
  // 「谁排在前、谁被 32 的窗口切掉」完全由传进来的 tasks 顺序决定。而这一层
  // 拿到的顺序真的不稳（不是理论风险，是读出来的）：在线走 GET /api/tasks，
  // server/src/entityStore.ts 的 readAll 按文件名 `<id>.json` 排序，稳；离线
  // 走 web/src/lib/dataSource.ts 的本地缓存，那边 backfillTasks（238–243 行）
  // 有脏条目时写回的是「干净的 + 脏的」——顺序随「哪些还没推回桌面」变，
  // localApi.addTask 往数组尾部追加，applyReorder 直接重排整张表。同一台手机
  // 在线一轮、离线一轮拿到的顺序不一样，真机上的表现就是「有时候提醒得到
  // 有时候提醒不到」，而这种问题单元测试基本抓不着。
  // 定序键选 id 不选 createdAt：id 是**唯一**的（AGENTS.md 写死，服务端合并
  // 时撞 id 的那条直接丢弃），唯一才排得出全序、才真的确定；createdAt 一批
  // AI 拆出来的任务常常是同一毫秒，还是平局。选 id 还顺带让这一句在线时是
  // 空操作（跟 readAll 的文件名序一致），只把离线那条路拉回同一个顺序。
  // 不用 localeCompare：它按运行时 locale 变，同一份数据两台机器可能不同序。
  const ordered = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { planned } = planNotifications(ordered, now);
  if (planned.length > 0) {
    // 上面问来的 exact 在这里用掉：给了就排精确，没给就显式排不精确。
    // **不是省一次调用，是躲开一个死循环**：`isExactNotification` 默认 true
    // （definitions.d.ts 880–896 行），而插件的 `doSchedule()`（126–133 行）
    // 在 API 31+ 且没拿到精确闹钟权限时，会**把用户送进系统「闹钟和提醒」
    // 设置页**再排——它没有「只问一次」的记忆，配上「每次数据变化整体重排」
    // 就是「他每改一条任务就被弹进一次设置页」。显式写 false 让那个分支根本
    // 走不到。降级只在他确实拒绝时发生，他哪天去系统里开了，下一次重排自动
    // 恢复精确——**不需要我们记任何状态**，那个状态本来就在系统里。
    // 顺带：`ScheduleResult.warning`（降级信号）这一层不往上传。① 它不是静默
    // 失败——插件在降级前已经把用户送进过那个设置页；② 排不精确是我们此刻
    // 显式点的头，本来就知情；③ 结构上它也不会再出现了：warning 只在
    // 「这批里有 isExactNotification 为 true 的、而权限没给」时才置位
    // （LocalNotificationsPlugin.kt 180–182 行），而那正是我们刚关掉的组合。
    await port.schedule(planned.map((p) => ({
      ...toNotificationSchema(p),
      isExactNotification: exact === 'granted',
    })));
  }
  return 'ok';
}
