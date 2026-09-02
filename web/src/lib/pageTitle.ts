/**
 * 标签页/窗口标题的唯一写入口。**这个文件之外没有别人写 `document.title`**
 * ——这句话是可验证的：`grep -rn "document.title" web/src` 应该只命中这儿。
 *
 * ## 为什么需要它
 *
 * 在这之前标题是一句写死在 `web/index.html` 里的「办事师爷」，每个视图全一样
 * ——切到哪一屏，标签页、任务栏、桌面版窗口标题上都看不出来。对读屏来说更
 * 明显：这是个 hash 路由的单页应用，切视图不发生真正的导航，而「标题变了」
 * 恰恰是读屏用来播报「到了新页面」的那个信号，没有它，切屏是无声的。
 *
 * ## 两个写它的人会打架，所以这里分「底」和「占用」两层
 *
 * - `App.tsx` 切视图时写**底**（`setBaseTitle('今天')` → 「今天 · 办事师爷」）
 * - `FocusTimer.tsx` 番茄钟跑起来时**临时占用**（`holdTitle('24:59 · 写周报')`）
 *
 * 第一版只有「底」这一层，两边各写各的 `document.title`，于是漏掉一个方向：
 * **番茄钟跑着的时候切视图，`setBaseTitle` 会把秒数直接盖掉**。计时器那个
 * effect 的依赖是 `[running, shownSec, phase, label]`，切视图一个都没变，所以
 * 它要等到下一次跳秒才把标题抢回来——而标签页切到后台时 Chromium 会把那个
 * 计时器节流到大约一分钟一次，「切走之后想看一眼还剩多久」这个正是番茄钟要
 * 回答的场景，偏偏就是它坏得最久。
 *
 * 现在两层分开：有人占着的时候，写底不会碰屏幕上那一行，只更新「他走了之后
 * 该显示什么」。这也顺带解决了反方向——`releaseTitle()` 拿的是**当下**的底，
 * 不是开始占用那一刻拍的快照，所以中途切过视图也还得回正确的那个。
 *
 * ## 应用名不写第二遍
 *
 * 模块加载的这一刻 `document.title` 还是 `index.html` 里那一个（谁都还没来得及
 * 改），直接拿它当基名。写一份 `const APP = '办事师爷'` 在这儿是第二份字面量，
 * 改名那天会漏掉一处——这个仓库刚经历过一次改名。下面那个 `?? '办事师爷'`
 * 只在压根没有 `document` 时兜底（服务端渲染、node 档测试），**不是**第二份
 * 事实来源：只要有 document，用的就是 index.html 那一份。
 */
/**
 * 应用名。**只算一次，之后从 globalThis 上取回来。**
 *
 * 直接写 `const APP = document.title` 有个只在开发时出现的坑：Vite 热更新会
 * 重新执行这个模块，而那一刻 `document.title` 已经是「今天 · 办事师爷」了
 * ——于是 APP 变成那一整串，下一次切视图就写出「日历 · 今天 · 办事师爷」，
 * 每热更一次多接一截。存在 globalThis 上，重新执行时拿回第一次那份。
 *
 * 用 `Symbol.for` 而不是普通字符串键：它在全局注册表里，跨模块实例（正是热更新
 * 会造出来的东西）取到的是同一个 symbol，而普通属性名有被别人撞上的可能。
 */
const APP_KEY = Symbol.for('shiye.appTitle');

const APP: string = (() => {
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  if (typeof g[APP_KEY] === 'string') return g[APP_KEY];
  const first = (typeof document !== 'undefined' && document.title.trim()) || '办事师爷';
  g[APP_KEY] = first;
  return first;
})();

/** 「没人占用时该显示什么」。视图变了就更新它。 */
let base = APP;
/** 有人临时占着标题时，屏幕上那一行。`null` = 没人占。 */
let held: string | null = null;

const paint = (): void => {
  if (typeof document !== 'undefined') document.title = held ?? base;
};

/**
 * 视图变了就叫一次。`viewLabel` 空串时只剩应用名。
 *
 * **对非字符串也不炸。** 这是个副作用里调的函数，而 `<App/>` 上面没有错误
 * 边界——这儿抛一下就是整页白屏。曾经真发生过：`viewTitle()` 用 `??` 兜
 * `CONTEXT_LABEL[c]`，`#/context:toString` 取到原型链上的函数，`??` 不触发，
 * 一个 function 就这么进了 `.trim()`。那个洞在 `viewTitle()` 里堵死了
 * （`Object.hasOwn`），这里再加一道：**这一层的职责是「无论上游给什么，标题
 * 都不该把应用干掉」**。
 */
export function setBaseTitle(viewLabel: string): void {
  const label = typeof viewLabel === 'string' ? viewLabel.trim() : '';
  base = label ? `${label} · ${APP}` : APP;
  paint();
}

/** 临时占用标题（番茄钟写秒数）。占用期间 `setBaseTitle` 不会覆盖屏幕上这一行。 */
export function holdTitle(text: string): void {
  held = text;
  paint();
}

/** 用完交还。回到**当下**的底，不是开始占用那一刻的快照。 */
export function releaseTitle(): void {
  held = null;
  paint();
}

/** 给测试看的：当前的底。产品代码不读它。 */
export const currentBaseTitle = (): string => base;
