import type { ViewCountSource, ViewDef } from './views.js';

/**
 * 导航上每个去处的显示方式——仿滴答清单的「智能清单」设置（它给的三档就是
 * 显示 / 隐藏 / 有内容时显示）。
 *
 * 这个应用的导航现在有十一项，而多数人天天用的只有其中三四个：「四象限」
 * 「时间线」这种是为特定工作方式准备的，用不上的人每一屏都要从它们中间
 * 找过去。滴答清单的答案就是让人自己关掉，这里照抄。
 *
 * 存 `localStorage` 不进 `Settings`：跟 `density`/`groupSort` 同一类——
 * 「这台机器上我想看到哪几个入口」，不是数据。
 */
export type NavMode = 'show' | 'hide' | 'auto';

export const NAV_MODE_LABEL: Record<NavMode, string> = {
  show: '显示', hide: '隐藏', auto: '有内容时显示',
};

/** key → 显示方式。没记的一律 `'show'`——**默认全显示，今天的行为不变**。 */
export type NavModes = Record<string, NavMode>;

const KEY = 'navModes';

/** 读不到、坏了、值不认识，都当没设过。 */
export function getNavModes(): NavModes {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return {};
    const out: NavModes = {};
    for (const [k, mode] of Object.entries(v)) {
      if (mode === 'hide' || mode === 'auto') out[k] = mode;
      // `'show'` 不存：它是默认值，记下来只是让这份表越长越大，
      // 而「没记 = 显示」这条规矩本身就够表达它。
    }
    return out;
  } catch {
    return {};
  }
}

export function setNavModes(v: NavModes): void {
  try {
    // 只留非默认的那几条，理由同上。
    const lean = Object.fromEntries(Object.entries(v).filter(([, m]) => m !== 'show'));
    localStorage.setItem(KEY, JSON.stringify(lean));
  } catch { /* 存不进去就只在这个会话里有效，跟 density.ts 同一条 */ }
}

/**
 * 一个去处**能不能**选「有内容时显示」。
 *
 * **判据从「有没有 count」改成「有没有 content 判据」**——`count`（画不画一个
 * 数字）和 `hasContent`（空不空）在这几个去处上是两个相反的决定：「已完成」
 * 和「垃圾箱」都故意不给数字，理由是「那个数只会一直涨、不是待办」，而那个
 * 判断**恰恰让它们没法选 auto**——于是收窄默认之后，这两个永远空的入口会变成
 * 新的噪音源，而「所有空的就该藏起来」这个收窄的本意正好被它们抵消。
 *
 * `hasContent` 补上之后，这条判据问的是「你知道怎么判断它空不空吗」，而不是
 * 「你碰巧会不会画一个数字」。
 */
export const canAuto = (v: Pick<ViewDef, 'count' | 'hasContent'>): boolean =>
  v.hasContent !== undefined || v.count !== undefined;

/** 这个去处有没有东西。**给了 `hasContent` 就以它为准，没给退回数字判据**——
 *  「inbox」这种两样都有的，以 `hasContent` 为准是故意的：它是显式写的答案，
 *  比从 count > 0 倒推更准。 */
export function hasContentOf(v: Pick<ViewDef, 'count' | 'hasContent'>, src: ViewCountSource): boolean {
  if (v.hasContent) return v.hasContent(src);
  return (v.count?.(src) ?? 0) > 0;
}

/**
 * **全新机器上的默认显示方式。**
 *
 * ## 为什么只给这三项
 *
 * 判据只有一条：**「空着的时候，它算不算噪音」。**
 *
 * - `trash` 垃圾箱是空的 —— 一屏导航里杵着一个永远空的入口，是噪音。
 * - `done` 已完成一条都没有 —— 同上，而且是新手最先看不懂的一项（它列的东西
 *   在别处已经「不见了」，空着的时候更费解）。
 * - `nolist` 未归类一条都没有 —— 同上。
 *
 * 其余一律 `show`，两条理由：
 *
 * ① **`today` / `all` / `inbox` 是骨架**，空着也必须在——「今天没有要做的」是
 *    一句有意义的话，而「今天」这个入口凭空消失不是。
 * ② **日历 / 四象限 / 习惯 / 专注统计 / 纪念日 这些是模块，不是清单。** 一个空的
 *    清单藏起来是减负；一个空的模块藏起来是**入口消失**，而它恰恰是新手去找
 *    「这个应用还能干什么」的地方。滴答那边这些也是常驻的功能模块。
 *
 * `upcoming` 也没给 auto：它走的是 `agendaSections`，装的是**全部没了结的**
 * 任务（按截止分桶），不是「今天之外的」——所以它跟 `all` 几乎同时空，同时空
 * 又同时非空，auto 在它身上什么也没省。
 */
export const FRESH_NAV_MODES: Record<string, NavMode> = {
  trash: 'auto',
  done: 'auto',
  nolist: 'auto',
};

/**
 * 「这台机器上默认是哪一套」存过的记号。
 *
 * ## 为什么需要它
 *
 * `setNavModes` 只存非默认的那些，而 `show` 就是默认值——所以**「一个都没改过」
 * 和「每个都选过显示」在 localStorage 里长得一模一样**。没有这个记号的话，
 * 一改默认就让**所有已经在用的人**开机第一眼看到的东西变了，而那个变化跟他们
 * 做过什么选择无关。
 *
 * 有了它：**记号不存在 = 这台机器还没见过新的默认**，用 `FRESH_NAV_MODES` 补
 * 齐；`App.tsx` 启动时调一次 `ensureNavDefaults()` 把记号落上，之后就永远按
 * 他自己的选择走。老用户第一次跑这版代码时记号还不存在——所以它**只**在这里
 * 生效一次，目的正是让老用户继续看到老样子。
 */
const DEFAULTS_KEY = 'navDefaultsV1';

const freshDefaultsUsed = (): boolean => {
  try {
    return localStorage.getItem(DEFAULTS_KEY) !== null;
  } catch {
    return true;
  }
};

/**
 * 把「见过新的默认」这个记号落上。**只在 `App` 启动时调一次**。
 *
 * 读的时候顺手写是不干净的（一个 getter 有副作用），所以拆成显式的一步。
 * 存不进去就当它已经见过——那一台机器下次还是新的默认，而「新默认」本身是
 * 一个安全的方向（少几个空入口），不至于因为存不进而出错。
 */
export function ensureNavDefaults(): void {
  try {
    if (localStorage.getItem(DEFAULTS_KEY) === null) localStorage.setItem(DEFAULTS_KEY, '1');
  } catch { /* 跟 density.ts 同一条：存不进去就在这次会话里生效 */ }
}

/**
 * 启动时读的那一份导航显示方式。**`App.tsx` 启动只调这一个**，不再单独调
 * `ensureNavDefaults`。
 *
 * ## 它修的是什么
 *
 * 记号（`DEFAULTS_KEY`）的整套设计是「**读的时候它还不存在**，这一次用
 * `FRESH_NAV_MODES` 收窄默认；读完把它落上，从此按他自己的选择走」。
 *
 * **原来的代码把记号落在了读的前面**，于是这个收窄默认**一次都没真正生效过**：
 * ① `getNavModes()` 只解析 `navModes` 那一个键，**根本不碰 `FRESH_NAV_MODES`**；
 * ② 真正读 `FRESH_NAV_MODES` 的是渲染时的 `effectiveDefault`，而那时记号已经在了。
 * 结果是空的垃圾箱 / 已完成 / 未归类照样杵在导航里，而那正是 `FRESH_NAV_MODES`
 * 注释里论证过要收掉的三个噪音源。
 *
 * ## 为什么只把 `App.tsx` 那两行对调过来还不够
 *
 * `ensureNavDefaults()` 写在组件体里，而 `visibleViews` 是在**同一次渲染的后半段**
 * 才被调用的——记号在它之前就落上了，`freshDefaultsUsed()` 照样返回 true。
 * 所以新默认必须在这里**物化进返回的那一份**。
 *
 * ## 合并顺序
 *
 * `{ ...FRESH_NAV_MODES, ...stored }`：**用户存过的盖过新默认**（他显式选过的
 * 优先）。`getNavModes` 只存非 `'show'` 的那几条，所以「他明确选的就是显示」
 * 这一档在盘上是空的、会被新默认接管——这正是 `DEFAULTS_KEY` 那段注释里明说的
 * 取舍（「一个都没改过」和「每个都选过显示」在 localStorage 里长得一模一样）。
 *
 * 返回的对象直接当 `navModes` state 用，`effectiveDefault` 之后就不再被问到；
 * **不需要把这批物化值写回 localStorage**——那会让「默认」变成「他自己选的」。
 */
export function initialNavModes(): NavModes {
  const stored = getNavModes();
  // 记号还不存在 = 这一台机器还没见过新的默认
  const fresh = !freshDefaultsUsed();
  ensureNavDefaults();
  return fresh ? { ...FRESH_NAV_MODES, ...stored } : stored;
}

/**
 * 按显示方式筛一遍导航项。
 *
 * **当前正看着的那个永远留下**，不管设成什么：把它藏掉会让导航上没有任何一项
 * 是 `aria-current`，而屏幕上明明就是它——那看着像是导航坏了。人是从设置里
 * 把它关掉的，下次切走之后自然就不见了。
 */
export function visibleViews(defs: ViewDef[], modes: NavModes, current: string, src: ViewCountSource): ViewDef[] {
  return defs.filter((v) => {
    if (v.key === current) return true;
    const mode = modes[v.key] ?? effectiveDefault(v.key);
    if (mode === 'hide') return false;
    if (mode === 'auto') return hasContentOf(v, src);
    return true;
  });
}

/** 没被显式设过的那一项，这一台机器上默认是什么。 */
function effectiveDefault(key: string): NavMode {
  return freshDefaultsUsed() ? 'show' : (FRESH_NAV_MODES[key] ?? 'show');
}
