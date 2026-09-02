import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { SHARE_EVENT, SHARE_PLUGIN_NAME, shareToInboxText, type SharePayload } from './sharePlan.js';

/**
 * 自写插件的 JS 那一端。**一个 web 实现都不带**——`registerPlugin` 只传插件名、
 * 不传第二个参数，这是有意的，下面 `available` 那条判据整个建立在它上面。
 */
interface ShareTargetPlugin {
  addListener(
    eventName: typeof SHARE_EVENT,
    listenerFunc: (payload: SharePayload) => void,
  ): Promise<PluginListenerHandle>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>(SHARE_PLUGIN_NAME);

/**
 * 插件那层的接口。**测试替身切在这里**——Capacitor 插件是外部系统，这是它的边界
 * （parked-all 第 144 条：替身要切在被测特性的**下游**）。
 * ⚠️ 别在 App.test.tsx 里 mock 掉 `subscribeShare`：那就正好切在被测特性所在的
 * 那条链上，零覆盖。
 */
export interface SharePort {
  available(): boolean;
  /** 订阅，返回退订函数。 */
  onShared(cb: (payload: SharePayload) => void): () => void;
}

/**
 * 薄壳：真的调插件。两个方法各一行、零分支。
 *
 * **判据只有 `isPluginAvailable` 一条，不抄 notifyNative.ts 的 `isNativeShell()`
 * （那边是 `isNativePlatform() && isPluginAvailable()` 两条与在一起）。**
 * 出处 node_modules/@capacitor/core/dist/index.js，行号是核过的：
 * - `:49-59` `isPluginAvailable(name)` = 「`registeredPlugins` 里那份的 `platforms`
 *   含当前 platform」**或**「原生 `PluginHeaders` 里有」；
 * - `:178` `platforms` = `new Set([...Object.keys(jsImplementations),
 *   ...(pluginHeader ? [platform] : [])])`。
 * - ⇒ **ShareTarget 没有 web 实现，`jsImplementations` 是空的，所以
 *   `isPluginAvailable('ShareTarget')` 为真 ⟺ 原生 PluginHeaders 里有它**，
 *   在 web / Electron / jsdom 上恒 false。
 * - 上一批**必须**再加 `isNativePlatform()`，是因为 `LocalNotifications`
 *   **带 web 实现**（Web Notification API），它那半在浏览器里恒真、拦不住
 *   「桌面也排一份」。**那条理由在这个插件上根本不存在**：加上去是一个恒等于
 *   true 的冗余合取，jsdom 里两种写法还都是 false、测不出差别——不是多一道保险，
 *   是一行没有任何行为的代码加一条读起来像有理由的注释。
 *   （更要命的是它会**把下面那条测试的牙拔掉**：`shareNative.test.ts` 最后那条
 *   靠「补了 web 实现 ⇒ `isPluginAvailable` 翻 true ⇒ 红」吃饭，多一条
 *   `isNativePlatform()` 会替它兜住，那条测试就废了。）
 * - 反过来**单用 `isNativePlatform()` 是错的**：原生壳里插件没注册进去时它照样为真，
 *   而那正是这一批最想守住的失败（scripts/share-target-wired.test.ts）。
 *
 * **`onShared` 里没有任何错误处理，这是查过源码之后的结论、不是漏了。**
 * 走得到这里的只有原生那条路（`available()` 已经挡住 web），而原生那条路上
 * `addListener` 是 dist/index.js `:141-156` 的 `addListenerNative`：它返回的
 * handle 在 `:150` 是 `new Promise((resolve) => call.then(() => resolve({ remove })))`
 * ——**只有 resolve 那一支，没有 reject**。注册失败时这个 promise 永远不 settle，
 * 下面那个 `.then` 根本不会跑，这一层既收不到错、也不会漏出 unhandled rejection。
 * 加 `.catch` 就是一句永远不执行的代码。
 *
 * `onShared` 里那个 `.then(...)` 是**形状适配**（插件说 `Promise<PluginListenerHandle>`、
 * port 说同步的退订函数），零决策零分支。
 *
 * **只能真机验的是「订阅之后真的收得到原生事件」那半**（jsdom 里没有原生桥），
 * 见 android/冒烟清单.md 第 10 步；`available()` 那半在 jsdom 里验得了，
 * 有测试（shareNative.test.ts 最后一个 describe）。
 */
export const nativeSharePort: SharePort = {
  available: () => Capacitor.isPluginAvailable(SHARE_PLUGIN_NAME),
  onShared: (cb) => {
    const handle = ShareTarget.addListener(SHARE_EVENT, cb);
    return () => void handle.then((h) => h.remove());
  },
};

/**
 * 编排：订阅原生事件，把每一份 payload 过一遍纯逻辑，有文字才往下走。
 * 返回退订函数（直接给 React 的 effect 当 cleanup 用）。
 *
 * **`port` 是必填参数、没有默认值**——这样 App.tsx 是显式 import `nativeSharePort`
 * 传进来的，App.test.tsx 只替掉那一个 export 就能让这个函数和 `shareToInboxText`
 * 都跑真的。给默认值的话，ESM 下模块内部那个绑定不走 mock，替身会失效。
 *
 * **不在原生壳里就什么都不做**——桌面/浏览器上没有分享菜单这回事，这一格是三种
 * 「什么都没发生」的第三种（parked-all 第 155 条，另外两种在 `shareToInboxText`）。
 *
 * ## 订阅时机：这一层只保证「调进来的那一刻就订上」，冷启动那条分享丢不了
 *
 * 原生那半发事件时带的是 `retainUntilConsumed = true`，所以**事件比监听者早到
 * 不会丢**（出处 node_modules/@capacitor/android/.../com/getcapacitor/Plugin.java，
 * 行号自己数过）：`:661-683` 的 `notifyListeners` 在没人听时（`:664`）把这份
 * `JSObject` 存进 `retainedEventArguments`（`:666-675`）；`:627-640` 的
 * `addEventListener` 在**第一个**监听者注册那一刻调 `:636`
 * `sendRetainedArgumentsForEvent`；那个方法 `:712-724` **先 `:719` remove、
 * 再 `:721-723` 补发** ⇒ **只消费一次**。冷启动分享（intent 在 WebView 起来之前
 * 就到了）走的就是这条路。
 *
 * ⇒ 「订阅要多早」这个问题在这一层**没有下限压力**，但有两条硬要求，而且都在
 * 这个函数里兑现了：
 * ① **同步订上**：`port.onShared` 就在函数体里直接调，中间没有 `await`、没有
 *    先去问权限/等数据。判据 `available()` 也是同步纯读——**不许把它改成异步**，
 *    那会把「订阅」推迟到不确定的将来。（真正到达原生的那一步隔着一个微任务，
 *    dist/index.js `:114` 的 `loadPluginImplementation().then(...)`，这一层管不着，
 *    也不需要管——留存机制兜的就是它。）
 * ② **一次调用只订一次**：多订一次，同一条分享就进两条收件箱。
 *
 * **给调用方（Task 4 的 effect）的约束**：别把订阅挂在「数据加载完」「拿到权限」
 * 之类的条件后面——留存能兜住晚到，但兜不住**压根不订**。反过来，effect 依赖数组
 * 里放会变的东西导致反复退订重订，**不会丢事件**（退订到重订之间那条会被留存、
 * 下次注册时补发），只是白绕一圈。
 *
 * ## 退订：这一层不留任何状态，谁订谁退
 *
 * 这个函数**没有模块级的监听者集合**，退订函数是当场造出来还给调用方的
 * ——模块级集合会跨测试串（这个仓库栽过），而且「谁负责退」会立刻变成一个
 * 没人说得清的问题。返回值直接就是 React effect 的 cleanup，卸载即退订。
 *
 * 不在原生壳里那一格返回的是**空函数、不是 undefined**：调用方不该为了「有没有
 * 订上」再长一条分支出来，而 React 的 cleanup 位置本来就必须给个能调的东西。
 *
 * **不去重、不缓存**：连发两条一模一样的分享就是两条（决定六，有测）。
 */
export function subscribeShare(port: SharePort, onText: (text: string) => void): () => void {
  if (!port.available()) return () => {};
  return port.onShared((payload) => {
    const text = shareToInboxText(payload);
    if (text !== null) onText(text);
  });
}
