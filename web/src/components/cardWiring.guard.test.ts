import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * **`cardWiring` 里的每一个字段都得真的走到 TaskCard 手上——每一处 TaskCard。**
 *
 * `App.tsx` 的 `cardWiring` 按定义就是「一张 `TaskCard` 要的那一整套接线」。
 * 它有几个去处：详情面板直接 `{...cardWiring}` 摊到 `TaskCard` 上（一步到位，
 * 不会漏）；`gridWiring = { ...cardWiring, ... }` 经 `TaskGrid` 再转一手；而
 * 「今天」「按来源」两个视图**手写** props——`App.tsx` 手写一份传给视图、视图
 * 再手写一份传给 `TaskCard`。**漏就漏在转手的地方。**
 *
 * `TypeScript 对 JSX spread 不做多余属性检查`：`{...gridWiring}` 里有而
 * `GridWiring` 没声明的字段，编译期一个字都不会说，运行期直接丢。可选字段
 * 同理：视图声明了 `onSkip?` 而上一手没传，也没人说。于是同一张卡在详情面板里
 * 是一个样、在看板上是另一个样，两边都不报错。
 *
 * **这已经是第三批了**，前两批写在 `TaskGrid.tsx` 的 `GridWiring` 注释里
 * （`selection`/`onSelectionChange`/`editRequestId`/`onEditRequestHandled` 四个，
 * 然后是 `focusMinutes`）。第三批是 `onSkip`/`onPromoteSubtask`/`breakMinutes`：
 *
 * - `onSkip` 没转发时 TaskCard 的「跳过」退回发一条普通 patch，服务端字段级的
 *   推迟计数把它记成一次拖延——而「跳过不是拖延」正是那条专用路由的全部理由。
 *   攒够几次，卡片上挂出「推迟过 N 次」。
 * - `breakMinutes` 没转发时番茄钟走 TaskCard 的默认值 0 = 不休息，他在设置里
 *   定的休息时长在所有格子视图里静默失效。
 * - `onPromoteSubtask` 没转发时「转子任务」那颗按钮整个不出现。
 *
 * **这条守卫第一版只扫了 `TaskGrid` 那一手。** 它上线的同一轮，评审就抓到
 * 「今天」「按来源」两个视图一样没传 `onSkip`——守的范围比漏的范围窄，等于
 * 没守。所以现在扫 `web/src/components` 里**每一处** `<TaskCard`，再扫 `App.tsx`
 * 里每一处手写 props 的视图；用 spread 的算全转发。
 */
const read = (p: string): string => readFileSync(p, 'utf8');

/** 从 `const X = {` 到同缩进的 `};` 之间，取顶层的 `key,` / `key:` 那些行。 */
function objectKeys(src: string, decl: string): string[] {
  const from = src.indexOf(decl);
  if (from === -1) throw new Error(`没找到 ${decl}——改名了就把这条守卫的锚点一起改`);
  const body = src.slice(from + decl.length);
  const end = body.indexOf('\n  };');
  if (end === -1) throw new Error(`${decl} 的收尾找不到——缩进变了？`);
  return [...body.slice(0, end).matchAll(/^    ([a-zA-Z][a-zA-Z0-9]*)[,:]/gm)].map((m) => m[1]);
}

/**
 * 一段源码里每一处 `<Tag ...>` 的属性名。含 `{...x}` 的那处返回 `null`
 * （spread = 全转发，比不了也不用比）。只认 `name=`，不认注释里的字——
 * 属性在 JSX 里一定紧跟 `=`。
 */
function jsxAttrs(src: string, tag: string): Array<Set<string> | null> {
  const out: Array<Set<string> | null> = [];
  // 标签名后面得是空白、`/` 或 `>`，否则 `<TaskCard` 也会命中 `<TaskCardX`。
  // 不用正则写这个字符类：这个仓库用脚本改源文件时反斜杠会被吃掉一层
  // （见 sourceBytes.guard.test.ts 的来历），字符码比较没有这个坑。
  const isTagEnd = (c: string | undefined): boolean => c === undefined || c === ' ' || c === '/' || c === '>' || c.charCodeAt(0) < 32;
  const needle = '<' + tag;
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    if (!isTagEnd(src[i + needle.length])) continue;
    // 开标签的收尾是**花括号深度为 0 的那个 `>`**——prop 值里的箭头函数
    // `=>`、比较运算符都在 `{}` 里，按第一个 `>` 截会把后面的属性全丢掉。
    let depth = 0;
    let end = i + needle.length;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const body = src.slice(i + needle.length, end);
    // 注释里提一句 `<TodayView>` 这种紧跟 `>` 的空标签不算渲染点。
    if (body.trim() === '') continue;
    out.push(body.includes('{...') ? null : new Set([...body.matchAll(/([a-zA-Z][a-zA-Z0-9]*)=/g)].map((x) => x[1])));
  }
  return out;
}

describe('cardWiring 的每个字段都走得到 TaskCard', () => {
  const app = read('web/src/App.tsx');
  const grid = read('web/src/components/TaskGrid.tsx');
  const keys = objectKeys(app, 'const cardWiring = {');

  it('前提：抠得出字段来——不是锚点写错了在比两个空数组', () => {
    expect(keys.length).toBeGreaterThan(8);
    expect(keys).toContain('onPatch');
  });

  it('每个字段 GridWiring 都声明了——没声明的，TypeScript 不会说，运行期直接丢', () => {
    const iface = grid.slice(grid.indexOf('export interface GridWiring {'));
    const declared = new Set([...iface.slice(0, iface.indexOf('\n}')).matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]));
    expect(keys.filter((k) => !declared.has(k)), '给 GridWiring 补上声明').toEqual([]);
  });

  const sites = readdirSync('web/src/components')
    .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
    .map((f) => `web/src/components/${f}`)
    .flatMap((f) => jsxAttrs(read(f), 'TaskCard').map((attrs, i) => ({ f, i, attrs })));

  it('前提：扫得到 TaskCard 的渲染点，而且不止 TaskGrid 一处', () => {
    expect(sites.map((s) => s.f)).toEqual(expect.arrayContaining([
      'web/src/components/TaskGrid.tsx', 'web/src/components/TodayView.tsx', 'web/src/components/TaskBoard.tsx',
    ]));
  });

  it('每一处 <TaskCard> 都把 cardWiring 的字段传下去了（spread 的算全传）', () => {
    const missing = sites
      .filter((s) => s.attrs !== null)
      .flatMap((s) => keys.filter((k) => !s.attrs!.has(k)).map((k) => `${s.f}#${s.i + 1} 漏了 ${k}`));
    expect(missing, '在那一处 <TaskCard> 上把它传下去').toEqual([]);
  });

  /**
   * 手写 props 的视图还有**上一手**：`App.tsx` 把字段传给视图。视图声明了
   * `onSkip?` 而 App 没传，TypeScript 也不会说（可选字段）。所以 App 里每一处
   * `<TodayView`/`<TaskBoard` 也要把 cardWiring 的字段传齐——除了视图自己
   * 就拿着、不用上一手给的那几个（列在下面，每个带理由）。
   */
  const VIEW_HAS_ITS_OWN = new Set([
    'allTasks', // 两个视图本来就收着 `tasks` 全表（TaskBoard 自己按来源分组），往下传的是那一份
  ]);
  it.each(['TodayView', 'TaskBoard'])('App 里每一处 <%s> 都把 cardWiring 的字段传齐了', (view) => {
    const at = jsxAttrs(app, view);
    expect(at.length, `App.tsx 里没找到 <${view}`).toBeGreaterThan(0);
    const missing = at.flatMap((attrs, i) =>
      attrs === null ? [] : keys.filter((k) => !VIEW_HAS_ITS_OWN.has(k) && !attrs.has(k)).map((k) => `<${view}>#${i + 1} 漏了 ${k}`));
    expect(missing, `在 App.tsx 的 <${view}> 上把它传下去`).toEqual([]);
  });
});
