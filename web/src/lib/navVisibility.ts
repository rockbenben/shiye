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

/** key → 显示方式。**没记的一律走「这台机器的默认」**（见下面 initialNavModes）。 */
export type NavModes = Record<string, NavMode>;

const KEY = 'navModes';

/**
 * 读回来。**「显示」这一档也留着。**
 *
 * 原来 `'show'` 不落盘，理由写在这里：「它是默认值，记下来只让这张表越长越大」。
 * 那条理由在**收窄默认**（`FRESH_NAV_MODES`）进来之后就不成立了——现在
 * 「显示」是**唯一能把收窄默认盖回去**的那一档：他在设置里把「垃圾箱」挑成
 * 「显示」，这一句必须存下来，否则下一次打开页面它又自己缩回去了
 * （「没记 = 显示」那条老规矩只对「**没人挑过**的键」成立，而挑过的那一档
 * 现在恰恰是「显示」）。
 *
 * 老的存法里本来就没有 `'show'`（写的时候就把它丢了），所以改成留着
 * **不会动到任何一台已经在用的机器**：谁在用这个版本，谁的 `navModes` 里
 * 就没有 `'show'` 这一档。
 *
 * 读不到、坏了、值不认识，都当没设过。
 */
export function getNavModes(): NavModes {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return {};
    const out: NavModes = {};
    for (const [k, mode] of Object.entries(v)) {
      if (mode === 'show' || mode === 'hide' || mode === 'auto') out[k] = mode;
      // 三档都留着：'show' 现在是「他明确挑过显示」的意思，不能当成默认值丢掉。
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 存下来。**三档都存**（理由见上面 `getNavModes` 那一段）。
 *
 * 这一份是「**他挑过的**」，`navDefaultsV1` 那一份是「**这台机器的默认**」——
 * 两件事分开放：改默认值不该把他挑过的那一档抹掉，反过来也一样。
 */
export function setNavModes(v: NavModes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
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
 * 「这台机器上默认是哪一套」存下来的那份。
 *
 * ## 为什么需要它
 *
 * `setNavModes` 只存他挑过的那几条，而「显示」也是其中一档（见上面
 * `getNavModes`）——所以**「一个都没改过」和「每个都选过显示」在 localStorage
 * 里长得一模一样**。没有这个记号的话，一改默认就让**所有已经在用的人**
 * 开机第一眼看到的东西变了，而那个变化跟他们做过什么选择无关。
 *
 * ## 它记的是什么
 *
 * **这台机器采用过的那套默认本身**（一份 key → 档位的小表），不是「见过没有」
 * 这么一句。记一句「见过了」是不够的——那句话只说得清「这机器见过哪一版」，
 * 说不清「它现在用的是哪一套」，于是**下一次打开就回到全显示**：收窄默认
 * 只在**第一次打开**那一次生效，第二天打开导航里又凭空多出「已完成」和
 * 「垃圾箱」两个永远空的入口，而**他什么都没动过**。应用自己改了自己的
 * 样子——这是这个仓库最恨的那一类（「界面说的跟实际不符」）。
 *
 * ## 三种形状
 *
 * - **键不存在**：这台机器还没见过任何一版默认 → 采用 `FRESH_NAV_MODES`，
 *   并**把它记下来**（`initialNavModes` 里那一步）。
 * - **`'1'`（旧格式）**：这台机器跑过老版本，那一版记下的就是这么一个记号。
 *   老版本的语义是「见过新默认之后按老默认来」= **全部显示**，所以这里当成
 *   `{}`——已经在用的人看到的那个样子一个字都不改。
 * - **一个对象**：这台机器采用过的那套默认。
 */
const DEFAULTS_KEY = 'navDefaultsV1';

/** 读出来。`null` = 这台机器还没见过任何一版默认。 */
function readAdoptedDefaults(): NavModes | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DEFAULTS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw === '1') return {};                 // 旧格式：老默认 = 全显示
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return {};
    const out: NavModes = {};
    for (const [k, mode] of Object.entries(v)) {
      if (mode === 'show' || mode === 'hide' || mode === 'auto') out[k] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 缓存一份，免得每帧都去 `JSON.parse` 同一个三键的小表。
 *
 * **缓存认的是原始字符串**：原始串变了就重新解析，所以 `localStorage.clear()`
 * 之后读到的仍然是「键不在」——测试里清完盘直接问下一句的场景不会拿到过期值。
 */
let adoptedCache: { raw: string | null; parsed: NavModes | null } | null = null;

function adoptedDefaults(): NavModes | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DEFAULTS_KEY);
  } catch {
    raw = null;
  }
  if (adoptedCache && adoptedCache.raw === raw) return adoptedCache.parsed;
  const parsed = readAdoptedDefaults();
  adoptedCache = { raw, parsed };
  return parsed;
}

/**
 * 把「这台机器采用哪套默认」记下来。**`initialNavModes` 里调一次。**
 *
 * 存不进去就当它已经见过——那一台机器下次还是新默认，而「新默认」本身是
 * 一个安全的方向（少几个空入口），不至于因为存不进而出错。
 */
export function ensureNavDefaults(adopted: NavModes = FRESH_NAV_MODES): void {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(adopted));
  } catch { /* 跟 density.ts 同一条：存不进去就在这次会话里生效 */ }
  adoptedCache = null;                        // 缓存认原始串，这里主动作废
}

/**
 * 启动时读的那一份导航显示方式。**`App.tsx` 启动只调这一个**，不再单独调
 * `ensureNavDefaults`。
 *
 * ## 它修的是什么
 *
 * ① 记号（`DEFAULTS_KEY`）的整套设计是「**读的时候它还不存在**，这一次用
 * `FRESH_NAV_MODES` 收窄默认；读完把它落上，从此按他自己的选择走」。
 *
 * **原来的代码把记号落在了读的前面**，于是这个收窄默认**一次都没真正生效过**：
 * ① `getNavModes()` 只解析 `navModes` 那一个键，**根本不碰 `FRESH_NAV_MODES`**；
 * ② 真正读 `FRESH_NAV_MODES` 的是渲染时的 `effectiveDefault`，而那时记号已经在了。
 * 结果是空的垃圾箱 / 已完成 / 未归类照样杵在导航里，而那正是 `FRESH_NAV_MODES`
 * 注释里论证过要收掉的三个噪音源。
 *
 * ② **只把 `App.tsx` 那两行对调过来还不够**：`ensureNavDefaults()` 写在组件体里，
 * 而 `visibleViews` 是在**同一次渲染的后半段**才被调用的——记号在它之前就落上了，
 * `freshDefaultsUsed()` 照样返回 true。所以新默认必须在这里**物化进返回的那一份**。
 *
 * ③ **物化出来的那一份必须记住**（这一条是后来补的）。只物化不记的话，
 * 收窄默认**只在第一次打开那一次是真的**：记号一落，下一次打开
 * `freshDefaultsUsed()` 就是 true，这份东西回到 `stored`（空的）→ 全显示。
 * 于是同一台机器上，第一次打开是六项导航、第二次打开是八项——**他什么都没
 * 动过**，导航却自己长出了两个永远空的入口（「已完成」和「垃圾箱」）。
 *
 * **怎么记住**：把采用的那一套本身写进 `DEFAULTS_KEY`（见上面那份注释的
 * 「三种形状」）。于是「这台机器用的是哪一套」和「他挑过什么」各存各的，
 * 打开多少次都是同一套——而老机器（`'1'` 那个旧格式）仍然是全显示，
 * 他们在用的人看到的样子一个字不变。
 *
 * ## 合并顺序
 *
 * `{ ...adopted, ...stored }`：**他挑过的盖过默认**（他显式选过的优先）。
 * `stored` 现在连 `'show'` 一起存（见上面 `getNavModes`），所以「他明确选过
 * 显示」这一档不会再被默认接管回去。
 *
 * 返回的对象直接当 `navModes` state 用。
 */
export function initialNavModes(): NavModes {
  const stored = getNavModes();
  const adopted = adoptedDefaults();
  if (adopted === null) {
    // 这台机器还没见过任何一版默认 → 采用收窄默认，**并把它记下来**
    // （下一次打开还是这一套，见上面 ③）。
    const fresh = { ...FRESH_NAV_MODES, ...stored };
    ensureNavDefaults(fresh);
    return fresh;
  }
  return { ...adopted, ...stored };
}

/**
 * 按显示方式筛一遍导航项。
 *
 * **当前正看着的那个永远留下**，不管设成什么：把它藏掉会让导航上没有任何一项
 * 是 `aria-current`，而屏幕上明明就是它——那看着像是导航坏了。人是从设置里
 * 把它关掉的，下次切走之后自然就不见了。
 */
export function visibleViews(defs: ViewDef[], modes: NavModes, current: string, src: ViewCountSource): ViewDef[] {
  // 这台机器采用的那套默认。**读一次**（不是每个 key 读一次）。
  //
  // 键不在 `modes` 里就退到它——`modes` 在应用里是 `initialNavModes()` 那一份
  // （默认 + 他挑过的），已经含了采用的那套；这里再兜一层是给**直接调
  // `visibleViews` 的地方**（单测、以及任何绕开 `initialNavModes` 的调用）：
  // 那些地方传的 `modes` 是空的，于是「这台机器的默认」得从这里问出来。
  const adopted = adoptedDefaults() ?? FRESH_NAV_MODES;
  return defs.filter((v) => {
    if (v.key === current) return true;
    const mode = modes[v.key] ?? adopted[v.key] ?? 'show';
    if (mode === 'hide') return false;
    if (mode === 'auto') return hasContentOf(v, src);
    return true;
  });
}
