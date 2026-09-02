export type Density = 'row' | 'card';

/**
 * 行/卡密度偏好。**存 `localStorage`，不进 `Settings`**——`Settings` 会同步到
 * 手机，而手机该用行；存在本机就不会被桌面那次选择拖过去。
 *
 * 照 `apiBase.ts` 的写法把读写收在这一个模块里（测试显式清，见 density.test.ts
 * 头部注释）。**不复用 `apiBase.ts` 那套「内存镜像 + 异步落盘」**——那一层是为了
 * 扛平台底层是 Capacitor `Preferences`（读写都是 Promise，哪怕 web 回退本身是
 * 同步的 `localStorage`）；密度只在浏览器/Electron/WebView 里读写，`localStorage`
 * 本身就是同步 API，不需要那层间接和它带来的启动竞态。
 */
const KEY = 'density';

/**
 * 存过什么就是什么；**没存过（或者读不到）用 `fallback`**。
 *
 * `fallback` 而不是写死 `'card'`：手机上默认该是行。390×844 上实测，一条任务
 * 卡片档高 134px、行档 33px——**首屏能看见的从 4 条变成 17 条**。「今天」这一屏
 * 的全部意义就是「一眼看完今天要做什么」，而默认档下一眼只看得见四分之一。
 *
 * **是默认值，不是强制。** `density.ts` 上一版的注释写的是「手机该恒用行」，
 * 那更狠一档——但行/卡那个开关在窄屏上是渲染出来的（视图标题栏里），
 * 强制等于让那颗开关点了没反应，而「一个点了没反应的入口比没有更糟」是这个
 * 仓库到处在说的话。何况这份偏好本来就存在本机，手机上他真挑了卡片档就该
 * 记住。
 *
 * 判断屏宽的事留给调用方（`App.tsx` 传 `isNarrowNow() ? 'row' : 'card'`）：
 * 这个模块只管存取，不去碰 `window.matchMedia`——那样测它就得先造一份假的。
 */
export function getDensity(fallback: Density = 'card'): Density {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'row' || v === 'card' ? v : fallback;
  } catch {
    // 隐私模式/存储配额满会抛——当没存过处理，回退默认档，不炸调用方。
    return fallback;
  }
}

export function setDensity(d: Density): void {
  try {
    localStorage.setItem(KEY, d);
  } catch {
    // 存不进去就算了：这次切换只在这个会话里有效，下次冷启动会回到上一次
    // 成功写入的值（或者从没成功过就是默认档）——不是这里要处理的事。
  }
}
