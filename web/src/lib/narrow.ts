import { useSyncExternalStore } from 'react';

/**
 * 窄屏断点。**跟 theme.css 里那一批 `@media (max-width: 767px)` 和 antd 栅格的
 * `md` 是同一个数**——三处对不上的话，CSS 已经躺平成一列了而 JS 还以为是宽屏，
 * 或者反过来，两种都是没人看得懂的半吊子布局。
 */
export const NARROW_QUERY = '(max-width: 767px)';

/**
 * **三栏放不下的那一档。**
 *
 * 侧栏、任务列表、详情各有自己的下限（200 / 380 / 300，见 `ColGrip` 那几个常量和
 * theme.css 里 `.ink-cols` 那段），三个加起来再加外壳大约要 972px。低于这个数就没有
 * 「挤一挤都放得下」这回事了——只能让详情退回它在手机上那种整屏浮层。
 *
 * 取 999 是留一点余量，也是个整数。**跟 theme.css 里那一批
 * `@media (max-width: 999px)` / `(min-width: 1000px)` 是同一个数**——对不上的话
 * CSS 已经把详情画成浮层了而 JS 还在给它画那条可拖的界线（一条骑在浮层边上、
 * 拖了什么都不会发生的线）。
 */
export const TIGHT_QUERY = '(max-width: 999px)';

// 每个订阅者自己一个 MediaQueryList，不在模块级缓存一个共用的。共用那版写过
// 一稿——省下的是「同一个查询注册了两次」这种不存在的开销（实际调用点只有
// 一个），换来的是一个存到模块卸载为止的全局变量：它一旦在某个 matchMedia
// 实现上建好就再也不重建，测试里换一份假 matchMedia 之后 flip 谁都不通知。
// 生产上不会发生，但为一个假想的开销留一个真的坑不划算。
const subscribeTo = (query: string) => (cb: () => void): (() => void) => {
  const mql = window.matchMedia(query);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};

const snapshotOf = (query: string) => (): boolean => window.matchMedia(query).matches;

const subscribe = subscribeTo(NARROW_QUERY);
const snapshot = snapshotOf(NARROW_QUERY);

/**
 * 现在是不是窄屏——**给用不了 hook 的地方**（`useState` 的初值函数、模块级
 * 常量之类）。跟 `useIsNarrow()` 问的是同一句话、同一个断点，只是不订阅变化。
 *
 * 不订阅是对的：调用方要的是「这一次初始化时该给什么默认值」，那是一锤子的
 * 决定；屏宽后来变了不该把他挑过的东西改掉。
 */
export const isNarrowNow = snapshot;

/**
 * 现在是不是窄屏。
 *
 * 存在的理由：**清单侧栏在手机上不能待在文档流里。** 竖栏躺平成顶上一条之后，
 * 紧接着是整条侧栏（导航 + 清单 + 标签 + 随手记），实测在 390×844 上要占掉
 * 七百多像素——第一屏一条任务都看不见，得先把整个侧栏划过去。滴答清单在手机上
 * 的答案在它帮助文档里写着：侧边栏是划出来/点出来的，不占列表那一屏
 * （「在清单详情页，向右滑动即可快速打开侧边栏」）。要照这个做就必须在 JS 这侧
 * 知道「现在算不算窄」，光靠 CSS 只能藏、不能换一种渲染方式。
 *
 * `useSyncExternalStore` 而不是 `useState` + `useEffect`：后者首帧一定先渲染
 * 一个错的值再纠正，手机上那一下是「侧栏闪一下再消失」。
 *
 * jsdom 里 `matchMedia` 是 test-setup.ts 补的壳，`matches` 恒为 false——测试
 * 因此一律走宽屏那条路，跟加这个模块之前一字不差。
 */
export function useIsNarrow(): boolean {
  // 第三个参数是服务端/首次快照的兜底。这个应用没有 SSR，但 `matchMedia` 在
  // 极老的载体里可能缺，兜底成「不是窄屏」= 现有布局。
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

const subscribeTight = subscribeTo(TIGHT_QUERY);
const snapshotTight = snapshotOf(TIGHT_QUERY);

/**
 * 现在窄到**放不下三栏**没有。跟 `useIsNarrow()` 是两个断点、两个问题：
 *
 * - `useIsNarrow()`（767）问的是「侧栏要不要收进抽屉」；
 * - 这个（999）问的是「详情要不要退成浮层」。
 *
 * 800 到 999 之间两者答案不同：侧栏还是并排的一列，而详情已经是浮层了。
 * 合成一个断点试过一版——那样要么侧栏在 900px 上莫名其妙变成抽屉，要么详情在
 * 800px 上被挤到 200 出头，两种都比多一个断点难解释。
 */
export function useIsTight(): boolean {
  return useSyncExternalStore(subscribeTight, snapshotTight, () => false);
}
