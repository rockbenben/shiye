// @vitest-environment jsdom
// 按扩展名这个文件本该落进 vitest.config.ts 的 'node' 档（裸 node 没有
// window/document/getComputedStyle）——绝大多数断言是纯文本正则匹配，
// 用不上 DOM。唯一的例外是下面「真级联层」那条测试：要验证一条 CSS
// 声明真的赢了级联，光读文本不够，得让一个真的 CSS 引擎去算。用文件顶部
// 这行 pragma 单独切到 jsdom——跟 density.test.ts/keymap.test.ts 同一个
// 理由，不为了一条测试新开一个文件。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// theme.css 是手写的全局样式表，没有构建期能跑的单测——跟 lib/types.sync.test.ts
// 同一个套路：抠出规则块的文本，断言里面该有的声明确实在。布局本身（真实像素、
// 真实换行）jsdom 算不出来，这里只测「规则写没写对」，不是测真实渲染结果。
//
// **约定，新加断言照着写，别抄错的那份**：`bare.match(...)` 先单独存成 `m`，
// 紧接着 `expect(m).not.toBeNull()`，再用 `m![1]`/`m![0]` 取内容。
// 不要写 `bare.match(...)?.[0] ?? ''` 再配一条纯否定断言（`not.toMatch`）——
// 规则被整条删掉时 `?? ''` 会把它悄悄换成空字符串，空字符串对任何
// `not.toMatch` 都是真空通过，等于测试从来没有真的盯着这条规则存不存在。
// 这个坑真的踩过一次：`.ink-nav-tag` 的 `min-height: 24px`（一个点击目标够不
// 够 24px 的真实回归）和整条 `.ink-nav-tag` 规则，删掉其中任何一个，改之前
// 那版「分类色只上背景」describe 块下面的测试都是全绿的。
//
// **切片用的正则要锚定规则本身（比如 `\.ink-nav \{`，选择器+空格+花括号），
// 不能锚定「这个类名第一次出现在文件里的位置」。** 这个坑也真的踩过一次：
// `.ink-rail-col` 那段注释里提前提了一句 `.ink-nav-composer`，这个词本身
// 满足 `/\.ink-nav[\s\S]*.../`（没有花括号锚定），于是匹配起点从真正的
// `.ink-nav {` 规则前移到了那句注释，惰性匹配到下一个 `/* ── */` 分节标题
// 就停——抠出来的整段里全是注释，一条真的 `.ink-nav-*` 规则都没有，断言
// 照样全绿。类名当字符串搜、不认花括号，天然认不出「这是选择器」还是
// 「这只是注释里提了一嘴同名类」，下一批往这个文件加规则、加注释时同样
// 会踩上。
//
// **对着 `css`（带注释的原文）匹配永远不安全，哪怕正则本身已经锚定了规则
// 本身。** 一句顶格复述规则的注释诱饵能骗过任何没剥注释的匹配——连最窄的
// `/\.ink-note-text\s*\{([^}]*)\}/` 都实测中过招（诱饵注释 + 真规则投毒，
// 33/33 全绿）。**`bare`（剥掉全部注释的 css）因此提到这里、模块顶层只声明
// 一次，全文所有 `.match` 一律对着它匹配，不再对着 `css` 匹配**——以前每个
// describe 块各自声明一份局部 `const bare`（一度重复了 6 处），拆开维护、
// 漏掉一处就是一个没剥注释的漏网之鱼，这正是 `.ink-nav` 那条断言（这个文件
// 曾经的 109 行）踩过的坑：单独留在 `css.match`、没跟着搬进 `bare`。
const css = readFileSync('web/src/theme.css', 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * ## 三个共用的小工具
 *
 * 这三样原来在文件里散着好几份手抄的副本（`@media` 剥离两份、规则体抽取两份），
 * 而且 `wide` 这个名字一度有三种互不相同的含义——「某个 @media 的下标」「bare
 * 减掉所有 @media」「只有某个 @media 里面的内容」，其中两个还是相邻 describe 里的
 * **互补集合**。在那种局面下把一条断言从一个 describe 复制到另一个，会得到一条
 * 对着结构上不可能命中的干草堆做的空转断言。收成一份，名字说清楚是哪一种。
 */

/** 剥掉所有 `@media` 块，只留基线那部分声明。 */
function outsideAnyMedia(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('@media', i)) {
      let depth = 1;
      i = source.indexOf('{', i) + 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      continue;
    }
    out += source[i]; i++;
  }
  return out;
}

/**
 * 把所有匹配某个媒体查询的块的**内容**拼起来。
 *
 * `lastIndex` 要推到整块之后：不推的话正则会回头再扫块的内部，嵌套的 `@media`
 * 会被数两遍（实测 `@media(a){ .x{} @media(a){ .y{} } }` 会把 `.y` 推两次）。
 */
function insideMedia(source: string, query: string): string {
  // 用 `indexOf` 找字面量，不拼正则：拼的话 `@media (` 里的括号和 `{` 都是元字符，
  // 要在模板字符串里写双反斜杠——这个仓库已经在这上面栽过（写成单个反斜杠时
  // `\(` 被模板字符串吃成 `(`，正则当成分组，模式永远匹配不上，而且是静默的）。
  // 字面量匹配没有这一层，也更快。
  const open = '@media (' + query + ') {';
  const out: string[] = [];
  let at = source.indexOf(open);
  while (at >= 0) {
    let depth = 1;
    let i = at + open.length;
    const from = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    out.push(source.slice(from, i - 1));
    // 从整块之后接着找：不推的话嵌套的同名 @media 会被数两遍。
    at = source.indexOf(open, i);
  }
  return out.join(String.fromCharCode(10));
}

/**
 * 某个选择器那条规则的声明体。**同一个选择器有多条规则时全拼起来**（层叠是后写的
 * 赢，所以读「最后一条」的人要拿到全部）。
 *
 * **一条都没有时抛，不回空串。** 这个文件顶上那条规矩说得很直白：`?? ''` 配一条
 * 否定断言等于测试从来没有真的盯着那条规则存不存在。选择器改了名、规则被整条删掉，
 * 都该当场红在这一句上，而不是变成一片安静的绿。
 *
 * 只在 `it` 体里调——describe 体里抛会把整个文件的收集带走，这个文件刚为此栽过一次。
 */
function declarationsFor(source: string, sel: string): string {
  const rules = [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(',').some((x) => x.trim() === sel));
  if (rules.length === 0) throw new Error(`没找到 ${sel} 的规则——选择器改名了？这条守卫再往下走就是空转`);
  return rules.map((m) => m[2]).join(';');
}

describe('#4：收件箱里一整段不带空格的长文本（比如一个 URL）不能撑破布局', () => {
  it('.ink-note-text 允许在任意字符处折行——不是 break-word，是 anywhere', () => {
    // overflow-wrap: break-word 不参与 min-content 尺寸计算（历史遗留行为，
    // 各浏览器不完全一致），撑破布局这条具体的 bug 需要的是 anywhere：
    // 它明确参与 min-content 计算，min-content 会跟着「允许折行」一起缩小。
    const m = bare.match(/\.ink-note-text\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

/**
 * 曾经这里守的是「边注轨道」：卡片一列 + 250px 页边一列。那套布局在改成卡片
 * 网格之后整体退役了——`--measure` 那条约束当时防的是「卡片收窄之后，页边里的
 * 东西被推到轨道尽头」，现在没有页边，边注挪进了卡片里。
 *
 * 旧断言不能一删了之：它守的那类问题（两处宽度约束不同步）换个形式仍然存在。
 * 下面这组守的是新布局的同类不变量。
 */
describe('卡片网格：两个视图共用一套，宽度约束不许分叉', () => {
  it('只有一条网格规则——「今天」和「按来源」共用 .ink-card-grid，不许各写一套', () => {
    // **数的是「卡片网格」那一条，不是全文件所有的 auto-fill**：这条守的
    // 是「今天」和「按来源」不许各写一套卡片布局，不是「这份样式表里只许
    // 存在一个自适应网格」——年视图那十二个小月历（`.ink-year`）也是
    // auto-fill，跟卡片网格毫无关系，按旧写法它一加进来这条就红。
    const cardGrids = bare.match(/\n\.ink-card-grid\s*\{[^}]*\}/g) ?? [];
    const autoFill = cardGrids.join('').match(/grid-template-columns:\s*repeat\(auto-fill/g) ?? [];
    expect(autoFill.length, '.ink-card-grid 里的自适应网格定义不止一处').toBe(1);
    // **这儿原来断言的是 `minmax(var(--card-min)`——而 `--card-min` 这个 CSS
    // 变量根本不存在**（grep 全文零命中），于是那条断言恒真，从写下那天起
    // 就没有守过任何东西。它想守的那件事是真的：卡片最窄多少这个数在两个
    // 地方各写了一份——`useColumns.ts` 的 `CARD_MIN` 和这条规则里的 `340px`
    // ——改一处漏一处，界面算列数和 CSS 铺网格就会按两个不同的宽度走。
    // 换成真的对账：两个数必须相等。
    const cssMin = bare.match(/\.ink-card-grid\s*\{[^}]*minmax\(\s*min\(100%,\s*(\d+)px/);
    expect(cssMin, '.ink-card-grid 里读不到卡片最小宽度').not.toBeNull();
    const tsMin = readFileSync('web/src/lib/useColumns.ts', 'utf8').match(/CARD_MIN\s*=\s*(\d+)/);
    expect(tsMin, 'useColumns.ts 里读不到 CARD_MIN').not.toBeNull();
    expect(cssMin![1], `CSS 里是 ${cssMin![1]}px，而 useColumns.ts 的 CARD_MIN 是 ${tsMin![1]}——两处得是同一个数`)
      .toBe(tsMin![1]);

    const m = bare.match(/\.ink-card-grid\s*\{([^}]*)\}/);
    expect(m, '.ink-card-grid 这条规则不见了').not.toBeNull();
    // auto-fill 而不是 auto-fit：auto-fit 会把空列塌掉，最后一行的一两张卡
    // 被拉成整行宽，正文行长直接失控。
    // 下限写成 `min(100%, Npx)`：不包这一层的话，容器比 N 窄时格子会撑出去
    // （320px 屏上量到过）。这条只认 auto-fill，下限那半交给专门那条守卫。
    expect(m![1]).toMatch(/repeat\(auto-fill,\s*minmax\(/);
    expect(m![1], 'auto-fit 会把空列塌掉').not.toMatch(/auto-fit/);
  });

  it('列可以比卡片宽，但卡片自己仍然收在 --measure 内——列宽不该决定行长', () => {
    const card = bare.match(/\.ink-task-card\s*\{([^}]*)\}/);
    expect(card).not.toBeNull();
    expect(card![1]).toMatch(/max-width:\s*var\(--measure\)/);
  });

  it('横向滑动的裁切边界跟卡片同宽——两处都要用 --measure，只靠网格轨道不够', () => {
    // 真实发生过：.ink-swipe 只靠轨道裁切，而「单独记的」那组轨道有 936px、
    // 卡片只有 532px，裁切边界离卡片边缘还有四百像素，等于没裁。
    const m = bare.match(/\.ink-swipe\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/overflow:\s*hidden/);
    expect(m![1]).toMatch(/max-width:\s*var\(--measure\)/);
  });

  it('边注挪进卡片之后，那条虚线在上边而不是左边——它现在说的是「下面这段是别人写的」', () => {
    const m = bare.match(/\.ink-margin-note\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/border-top:\s*1px dotted var\(--ink-ai\)/);
    expect(m![1]).not.toMatch(/border-left/);
  });
});

/**
 * task-3-brief 要点②「行档改单列」：`.ink-row-list` 跟 `.ink-card-grid`
 * 互斥（TaskGrid.tsx/TodayView.tsx 按 density 二选一渲染其中一个容器），
 * 不用 grid、单列封顶 `--measure`。
 */
describe('行档列表容器：单列、封顶 --measure，跟卡片网格的两列互斥', () => {
  it('.ink-row-list 存在，是 flex 纵向堆叠（不是 grid），封顶 --measure', () => {
    // 修复轮 1 · M-1：锚点改成仓库标准写法 `\s*(?=[,{])[^{}/]*\{`（跟上面
    // for 循环、下面 .ink-cells 那条同一套），不再用没有 `[^{}/]*` 的裸
    // `\{`——那个写法挡不住「选择器后面紧跟一句顶格注释再换行才到 `{`」这类
    // 攻击（文件顶部「切片正则要锚定规则本身」那段血泪注释描述的同一类
    // 风险）。`\r?\n` 不是 `\n`：这个仓库工作副本行尾是混的（theme.css 本身
    // 是 CRLF，但同一批改动里别的 .tsx 文件在这台机器上可能是 LF），`\n`
    // 锚点在 CRLF 内容上其实仍能匹配到（`\n` 只吃 LF 那一个字节，`\r` 不
    // 挡它），但 `\r?\n` 更稳，不用去赌这份工作副本此刻具体是哪种。
    const m = bare.match(/\r?\n\.ink-row-list\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-row-list 规则不见了').not.toBeNull();
    const body = m![1];
    // 变异验证锚点 a：改成 `display: grid` 或者加一条 `grid-template-columns`
    // ——上面「只有一条网格规则」那条会先红（.ink-card-grid 之外又出现了
    // 一处 auto-fill/grid 定义），这里再单独钉一次「这条规则本身不该是
    // grid」，两层防线不是同一处断言。
    expect(body).not.toMatch(/grid-template-columns/);
    // 变异验证锚点 b（修复轮 1 · M-1）：只断言「不是 grid」挡不住写成
    // `display: block`/`display: grid; grid-auto-flow: row` 这类同样不是
    // grid、但也不是「flex 纵向堆叠」的写法——那样每条 .ink-trow 之间不会
    // 按 flex 的规则纵向排列（虽然 block 元素本来就纵向堆叠，效果可能凑巧
    // 一样，但这条规则的设计就是 flex column，正面断言钉住这一点，不是靠
    // 「反正不是 grid 就行」这种宽松判据蒙混过关）。
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    // **封顶用 --row-measure，不是正文那个 --measure。** 一行任务不是一段
    // 正文：标题短、右边一串元数据右对齐，38em 那个「一行三十来个汉字」的
    // 舒适区套在行上只会把整份列表压成左边一条窄带——1920 下内容区有 1520px
    // 而列表只占 532px，2560 下右边空着 1830px。60em 是照着滴答清单自己量的，
    // 来历写在 :root 那个 token 上。
    expect(body).toMatch(/max-width:\s*var\(--row-measure\)/);
  });

  it('加任务那一行跟任务行**同一个** token——右边界对不齐，它看上去就不属于这一列了', () => {
    const m = bare.match(/\n\.ink-quickadd-wrap\s*\{([^}]*)\}/);
    expect(m, '.ink-quickadd-wrap 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/max-width:\s*var\(--row-measure\)/);
  });

  // 上面那条只管住了行档。卡档下面的 `.ink-card-grid` 铺满整列、不封顶，
  // 这一行还封在 --row-measure 上就比它下面的卡片短一大截——实测 1280 下
  // 差 46px、1920 下差 686px。`QuickAdd` 的 `wide` 挂上这个类，类得真的有用：
  // 只加 class 不写规则是一次静悄悄的空操作，那边的测试照样绿。
  it('卡档那一档把封顶去掉——`.ink-quickadd-wrap-wide` 不是一个只挂着好看的类名', () => {
    const m = bare.match(/\n\.ink-quickadd-wrap-wide\s*\{([^}]*)\}/);
    expect(m, '.ink-quickadd-wrap-wide 规则不见了——QuickAdd 那边还在挂这个 class').not.toBeNull();
    expect(m![1]).toMatch(/max-width:\s*none/);
  });

  it('--row-measure 这个 token 真的定义了，而且比正文那个宽', () => {
    const root = bare.match(/:root\s*\{([\s\S]*?)\n\}/);
    expect(root, ':root 不见了').not.toBeNull();
    const row = root![1].match(/--row-measure:\s*(\d+(?:\.\d+)?)em/);
    const text = root![1].match(/--measure:\s*(\d+(?:\.\d+)?)em/);
    expect(row, '--row-measure 没定义').not.toBeNull();
    expect(text, '--measure 没定义').not.toBeNull();
    expect(Number(row![1])).toBeGreaterThan(Number(text![1]));
  });
});

describe('分类色只上背景，永不上字', () => {
  it('.ink-nav-dot 用 background 不用 color', () => {
    const m = bare.match(/\.ink-nav-dot\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/background/);
    // 分类色和「群青只标 AI」共存靠的就是这条：分类色只出现在记号上（圆点、
    // 竖条、浅底胶囊），字本身永远是石墨黑。破了这条，一个彩色的清单名会
    // 跟群青抢「这段字是谁写的」这个通道。
    expect(m![1]).not.toMatch(/(^|[^-])color\s*:/m);
  });

  it('.ink-nav-tag 同理，而且点击目标够 24px', () => {
    const m = bare.match(/\.ink-nav-tag\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/(^|[^-])color\s*:/m);
    // 12px 字号 + 1px 竖内边距只够 21px 高，够不到全站 24px 点击目标下限——
    // 上一个 Task 自己实测抓出来的缺陷，见 .ink-nav-tag 规则上面的注释。
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });

  it('群青不出现在导航的记号里——那是 AI 的颜色', () => {
    // 锚点必须是规则本身（`.ink-nav {`，注意空格+花括号），不能是「第一次
    // 出现 .ink-nav 这个字符串」——.ink-rail-col 那段注释里提过一次
    // `.ink-nav-composer`，之前的写法 `/\.ink-nav[\s\S]*?.../` 会先撞上那句
    // 注释，惰性匹配到下一个 `/* ── */` 就停，抠出来的整段里一条真的
    // `.ink-nav-*` 规则都没有——这条假绿真的发生过一次，见这个文件顶部
    // 「切片正则要锚定规则本身」那条约定。
    const m = bare.match(/\n\.ink-nav \{[\s\S]*?(?=\n\/\* ──|\n\.ink-view-bar)/);
    expect(m).not.toBeNull();
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
  });

  it('导航项的字色用的是你的墨，不是别的', () => {
    const m = bare.match(/\.ink-nav-item\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/var\(--ink-you\)/);
  });
});

/**
 * 名字长的清单/标签，整行会被推出侧栏——连「⋯」一起，那是它唯一的改名/删除入口。
 * 实测（1280 宽，侧栏 267px）：行宽 520px，右缘落在侧栏外 253px 处。
 *
 * 两条声明缺一不可，所以这里分两句断言，坏哪一条就红哪一句：
 * - `.ink-nav-tag-row` 是 `inline-flex`（按内容收边），没有 `max-width` 就没有上限；
 * - `.ink-nav-item` 是 flex 子项，默认 `min-width: auto` 不肯缩到内容宽度以下，
 *   只封顶外面那行的话它照旧撑开、把「⋯」顶到行外（实测「⋯」右缘 350 vs 侧栏 339）。
 */
/**
 * 详情栏那个大标题：`<h2 class="ink-dt-h">` 是 `.ink-card-titlerow`（flex）的
 * 子项，不给 `flex: 1` 它按内容收边，而里面那颗按钮的 `width: 100%` 会按这个
 * 收边宽度铺满——加上按钮自己的 `margin-left: -6px`，内容盒比文字窄 6px，
 * 短标题当场被折断。实测「晨跑」：46px 宽、62px 高（两个字竖着码成两行）；
 * `flex: 1` 之后 347px 宽、35px 高。
 */
/**
 * 「跳到任务列表」那颗（WCAG 2.4.1）。**藏它的方式决定它有没有用**：
 * `display: none` / `visibility: hidden` 会连焦点一起摘掉，Tab 永远走不到它，
 * 那颗按钮就成了摆设——而它存在的全部意义就是能被 Tab 到。所以只能靠挪出屏幕。
 */
describe('跳过重复区块那颗按钮：藏得住，也聚焦得到', () => {
  it('.ink-skip 不用 display:none / visibility:hidden 藏——那两个连焦点一起摘掉', () => {
    const d = declarationsFor(bare, '.ink-skip');
    expect(d).not.toMatch(/display:\s*none/);
    expect(d).not.toMatch(/visibility:\s*hidden/);
    // 挪出屏幕这一档：位置固定 + 一个负的横坐标。
    expect(d).toMatch(/position:\s*fixed/);
    expect(d).toMatch(/left:\s*-\d+px/);
  });

  it('聚焦时得真的落回屏幕里——只藏不显形等于没有', () => {
    const on = bare.match(/\.ink-skip:focus-visible\s*\{([^}]*)\}/);
    expect(on, '没有让它显形的那条规则').not.toBeNull();
    expect(on![1]).toMatch(/left:\s*\d+px/);
  });
});

describe('详情栏的大标题：短标题不许被竖着码成一列', () => {
  it('.ink-dt-h 是 flex 子项，得 flex: 1 铺满整行，不能按内容收边', () => {
    expect(declarationsFor(bare, '.ink-dt-h')).toMatch(/flex:\s*1\b/);
  });

  it('.ink-dt-h 同时解除 min-width: auto——标题上有 overflow-wrap: anywhere，它把 min-content 压到一个字', () => {
    expect(declarationsFor(bare, '.ink-dt-h')).toMatch(/min-width:\s*0/);
    // 前提：那条 anywhere 还在。它没了的话这半条守卫说的话就不成立了。
    expect(declarationsFor(bare, '.ink-dt-title')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

/**
 * 设置弹层在手机上：`flex: 0 0 132px` 的分区栏是按桌面写的。实测 320 宽时
 * 弹层 256px，分区栏 132px **比正文栏（124px）还宽**，分区说明只剩 104px、
 * 约九个字一行码成五行。摊成顶上一条横向滚动的带子之后正文拿到整幅宽度。
 */
describe('设置弹层：窄屏把分区栏摊成顶上一条，别让导航比正文还宽', () => {
  const narrowSet = () => {
    const m = bare.match(/@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/g)?.find((b) => b.includes('.ink-set'));
    if (!m) throw new Error('没有那条把设置弹层摊平的窄屏规则——断点改了？');
    return m;
  };

  it('窄屏下 .ink-set 竖着堆，分区栏横着排', () => {
    const block = narrowSet();
    expect(block).toMatch(/\.ink-set\s*\{[^}]*flex-direction:\s*column/);
    expect(block).toMatch(/\.ink-set-nav\s*\{[^}]*flex-direction:\s*row/);
  });

  it('横着排就得跟模块栏一样藏滚动条 + 右缘渐隐——不然最右那一项被切一半，跟上一轮修掉的是同一个缺陷', () => {
    const nav = narrowSet().match(/\.ink-set-nav\s*\{([^}]*)\}/);
    expect(nav, '窄屏那条 .ink-set-nav 不见了').not.toBeNull();
    expect(nav![1]).toMatch(/overflow-x:\s*auto/);
    expect(nav![1]).toMatch(/scrollbar-width:\s*none/);
    expect(nav![1], '藏了滚动条却没给渐隐：唯一的线索又变成半个字').toMatch(/mask-image:\s*linear-gradient/);
  });
});

describe('侧栏：名字再长也得留在框里，「⋯」不许被推出去', () => {
  it('.ink-nav-tag-row 封顶在容器宽度——inline-flex 自己不封顶', () => {
    expect(declarationsFor(bare, '.ink-nav-tag-row')).toMatch(/max-width:\s*100%/);
  });

  it('.ink-nav-item 解除 flex 子项默认的 min-width: auto，不然封了顶也缩不下去', () => {
    expect(declarationsFor(bare, '.ink-nav-item')).toMatch(/min-width:\s*0/);
  });
});

describe('.ink-view-title：antd 的 reset 会把 margin 归零但不归 font-size，不写这条规则就会变成 UA 默认的大号粗体标题', () => {
  it('.ink-view-title 规则块存在，且 font-size 是一个具体的 px 值', () => {
    const m = bare.match(/\.ink-view-title\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/font-size:\s*\d+(\.\d+)?px/);
  });
});

describe('界面元件（路牌/统计/回顾的按钮）不用群青——群青只标 AI 产出的内容', () => {
  // 剥注释再匹配（模块顶层的 bare，见文件顶部）——这里原来用的是没剥注释的
  // `css.match`，会被一句顶格复述规则的注释诱饵骗（见下面 `sel` 循环里的
  // 例子），是本仓库第 8、22 次假绿的同一个形状。

  // 两条规则分开各自匹配、各自断言，不是一次性抠出「从 heading 到 count」中间
  // 那一整段：`[\s\S]*?` 连规则之间的内容也会纳入断言范围，将来谁在两条中间插
  // 一条带群青的新规则，红的位置会是这条无关的旧断言，不是新规则本身。
  // `.toUpperCase()` 不能少——CSS 里小写 16 进制是完全合法的写法，
  // `.ink-nav` 那条同类断言（这个文件 111 行）已经这么写了，这是第三条
  // 该照抄的约定，不是这条测试自己发明的。
  //
  // `[^{]*` 而不是字面的一个空格：`.ink-review-link`/`.ink-review-dismiss`
  // 在 theme.css 里是逗号并列共用一条规则块（`.ink-review-link,\n
  // .ink-review-dismiss { ... }`），选择器后面紧跟的不是空格+`{`，是
  // `,\n下一个选择器 {`——原来那条只认「选择器+一个空格+花括号」的正则会在
  // 这两个类名上直接判「规则不见了」（`m` 是 null），不是漏测，是根本跑不起来。
  // `[^{}/]*` 把「选择器到花括号之间」的内容（逗号、换行、下一个选择器）放行，
  // 两种写法（独占一行的单选择器 / 逗号并列的多选择器）都能匹配到同一条规则块。
  //
  // **`/` 必须排除在外，这不是洁癖。** 只写 `[^{]*` 的话，一句顶格提到这个类名的
  // 注释就能把锚点抢走：
  //
  //     /*
  //     .ink-review-kind 的配色说明见文末
  //     */
  //     .ink-empty-note { … }        ← 抠出来的是这一条，干净，测试绿
  //     …
  //     .ink-review-kind { color: var(--ink-ai); }   ← 真规则，从没被看过
  //
  // 实测过：这么放一句注释、同时给真规则偷加群青，16 条全绿。`css.match` 不带
  // `/g`，取的是第一个匹配，注释在前就赢。排除 `/` 之后跨不过 `*/`，攻击失效
  // （同样实测过：改完那条变异立刻红）。这就是文件顶部第二条硬规矩说的
  //「锚定规则本身，不是任意出现的类名字符串」——本仓库的第 8 次和第 22 次
  // 假绿都是这个形状，而且两次都是「专门为消灭假绿而写的提交」自己造的。
  for (const sel of [
    'ink-grid-heading', 'ink-grid-count', 'ink-grid-action', 'ink-grid-fold', 'ink-grid-caret', 'ink-review-kind', 'ink-review-link', 'ink-review-dismiss',
    // 卡住的项目那一段：**从任务本身现算的结构性事实，不是 AI 产出**，
    // 所以一个群青都不该有。它挨着 .ink-review-kind（那一条是 AI 的观察、
    // 群青是它合法的用法）摆着，正是最容易被顺手写成同一个颜色的地方。
    'ink-review-stalled', 'ink-review-stalled-h', 'ink-review-stalled-why', 'ink-review-stalled-list',
    // 「这一周该过一遍的」那一段：跟上面那族同一类东西（现算的结构性事实），
    // 同样一个群青都不该有。
    'ink-review-todo', 'ink-review-todo-list', 'ink-review-todo-flat',
    // .ink-cells 是 .ink-cells-2x2 的前缀——前缀兄弟选择器这个仓库栽过一次
    // （.ink-repeat-day vs .ink-repeat-days，见这条循环上面 178 行那段注释），
    // `\s*(?=[,{])` 这条锚点已经是专门挡这个的写法，两个类名一起塞进同一条
    // for 循环复用它，不新写一份规则。
    // .ink-grid-section-over：拖拽悬停的格子高亮，是这一批唯一容易被顺手
    // 写成群青的新记号（「操作反馈」很容易被误认成焦点环那类批准过的例外，
    // 见 .ink-row-dragging 上面那条真的犯过两次的教训）。
    'ink-cells', 'ink-cells-2x2', 'ink-grid-section-over',
    // task-4-brief 修复轮 1 · B：四象限上方那句说明（原来的 `.ink-quadrant-hint`）
    // 挪进了 `.ink-cells-2x2` 的原生 `title`，规则本身删掉了，从这张名单里
    // 摘掉——不是漏测，是它已经不存在了。
    // task-3-brief 修复轮 1 · I-1：这批新加的 `.ink-row-list` 之前不在这张
    // 手写名单里——新规则不会自动进这个循环，`color: var(--ink-ai)` 偷加
    // 进去 79/79 照样全绿。`.ink-cells > .ink-grid-section` 加不进这个循环
    // （锚点 `\s*(?=[,{])` 故意拒绝后代/子代组合器，见上面注释），那条规则的
    // 群青断言另外补在它自己那条测试里（见「列宽收窄」那条）。
    'ink-row-list',
    // 整分支审查 B3：`.ink-view-actions`（task-2 加，密度开关+「新任务」的
    // 外层容器）不属于任何 `.ink-trow-*`/`.ink-density-*` 这类前缀族，这份
    // 手写名单里也一直没有它——`color: var(--ink-ai)` 偷加进去，
    // theme.css.test.ts 全绿，密度开关那两颗按钮 + 「新任务」按钮的文字会
    // 一起被继承成群青（`.ink-density-btn` 自己写了 `color: var(--dim)`
    // 挡得住，但「新任务」那颗 antd Button 没有）。核对过这一批（task-1～5）
    // 新加的全部 28 条 theme.css 规则，只有这一条漏在这张名单外，其余都在
    // 前缀扫描/独立断言的射程内。
    'ink-view-actions',
  ]) {
    it(`.${sel} 规则块本身不含群青`, () => {
      // 锚点用 `\s*(?=[,{])`，不是 (?![\w-])。词边界 (?![\w-]) 只挡得住「sel
      // 后面紧跟字母/数字/连字符」这一种变体（比如 sel 是另一个更长类名的
      // 前缀，见 Task 4 审查揪出的 .ink-repeat-day / .ink-repeat-days）——挡
      // 不住「sel 后面是复合选择器/后代选择器/伪类」这一种：`.a input {}`、
      // `.a.b {}`、`.a:hover {}` 紧跟的都不是字母数字连字符，(?![\w-]) 照样
      // 放行，`[^{}/]*` 会一路吃到那条不相关规则的 `{`，抠出来的是别人的
      // 规则块，断言在错的规则上打转。`\s*(?=[,{])` 直接要求 sel 后面（跳过
      // 空白）必须是「逗号并列的下一个选择器」或者「规则体开始」，两种真正
      // 合法的收尾之外一律拒绝——`.ink-review-link,\n.ink-review-dismiss {}`
      // 这种逗号并列写法仍然放行（下面 review-link/review-dismiss 两条测试
      // 就是靠这个），复合/后代/伪类选择器全部挡住。
      const m = bare.match(new RegExp(`\\n\\.${sel}\\s*(?=[,{])[^{}/]*\\{[^}]*\\}`));
      expect(m, `${sel} 规则不见了`).not.toBeNull();
      expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
      expect(m![0]).not.toContain('--ink-ai');
    });
  }
});

// final-review.md m1：.ink-grid-section 的 margin-bottom: 22px 是给竖着摞的
// 布局定的，并排的格子布局（看板 .ink-cells、四象限 .ink-cells-2x2）已经用
// gap: 22px 控制间距，两个 22px 叠加会让四象限两行之间变成 44px、看板整个
// 容器凭空高出一截。
it('.ink-cells > .ink-grid-section 把 margin-bottom 归零——不跟 .ink-cells 的 gap 叠加', () => {
  const m = bare.match(/\n\.ink-cells\s*>\s*\.ink-grid-section\s*\{([^}]*)\}/);
  expect(m, '.ink-cells > .ink-grid-section 规则不见了').not.toBeNull();
  expect(m![1]).toMatch(/margin-bottom:\s*0\s*;?/);
});

/**
 * task-3-brief 要点①：看板/四象限的列宽收窄（340px → 200px，四列才能同屏
 * 看见），列要有容器感（淡背景 + 描边）。实测（1280×900，17 条夹具任务）
 * 确认过：`min-width: 0` 不删的话，行内到期 chip/标签这些 `white-space:
 * nowrap` 的元数据会顶开 200px 的 flex-basis，四列又摆不下退回横向滚动——
 * 跟这条规则本来要解决的问题一样，见 task-3-report.md「四列没有同屏」那节
 * 排查记录。**这条断言只钉住「声明本身还在」，不是「布局真的没重新挤爆」**
 * ——jsdom 不算布局，真正会把四列重新挤爆的下一次改动（比如往 `.ink-trow`
 * 里再塞一个 `flex: 0 0 auto` 的 nowrap 元数据）它一句话都说不上，那类回归
 * 只能靠在真浏览器里 1280×900 打开看板肉眼核对，不是这条测试的职责
 * （修复轮 1 · M-2，这条正是 C-2 实际发生过的机制）。原先这里指的是
 * `docs/superpowers/shots/` 那棵截图树，它已经整个删掉了——**这类回归现在没有
 * 任何留痕的验收出口**，谁重新建一套截图基线的话记得把这句指路接回去。
 */
it('.ink-cells > .ink-grid-section：列宽收窄到 200px 且能真的收窄（min-width: 0），列有容器感（背景+描边），不含群青', () => {
  const m = bare.match(/\r?\n\.ink-cells\s*>\s*\.ink-grid-section\s*\{([^}]*)\}/);
  expect(m, '.ink-cells > .ink-grid-section 规则不见了').not.toBeNull();
  const body = m![1];
  // 变异验证锚点 a：flex-basis 改回 340px（或任何 ≥ 300 的值）——四列在
  // 1280px 视口下摆不下，退回横向滚动，第四列「搁置」又被挤出视口。
  expect(body).toMatch(/flex:\s*1\s+0\s+200px/);
  // 变异验证锚点 b：删掉这一行——四列不会真的收窄到 200px 附近（浏览器会
  // 用内容的 min-content 宽度当地板），行内的到期 chip/标签会把列撑宽，
  // 四列又摆不下，退回横向滚动，实测过（见上面小节注释）。
  expect(body).toMatch(/min-width:\s*0\s*;?/);
  // 变异验证锚点 c：删掉 background/border 任意一行——列退回「只是一个
  // 标题 + 松散排开的行，跟旁边那列只靠空隙分开」，没有容器感。
  expect(body).toMatch(/background:\s*var\(--sheet\)/);
  expect(body).toMatch(/border:\s*1px solid var\(--rule\)/);
  // 修复轮 1 · I-1：这条规则用后代组合器（`.ink-cells > .ink-grid-section`）
  // 写选择器，进不了上面那个 `for (const sel of [...])` 循环（那个循环的
  // 锚点 `\s*(?=[,{])` 故意拒绝复合/后代选择器）——单独在这里补断言，不然
  // 偷加 `color: var(--ink-ai)` 进这条规则会一路继承进列头、计数、列里每
  // 一条行的标题，看板/四象限满屏群青都测不出来。
  expect(body.toUpperCase()).not.toContain('#2E3ED4');
  expect(body).not.toContain('--ink-ai');
});

it('回顾的正文用群青——AI 产出的新信息，这是配额该花的地方', () => {
  const m = bare.match(/\n\.ink-review-text \{[^}]*\}/);
  expect(m).not.toBeNull();
  expect(m![0]).toContain('--ink-ai');
});

describe('优先级：填色区分档位，不跟清单调色盘/群青撞', () => {
  // 剥注释再匹配（模块顶层的 bare）：不剥的话一段复述 token 的注释就能把
  // 锚点抢走——真的实测过一次：在 :root 上方放一段复述三个 token 的注释、
  // 同时把真的 --pri-3 改成 LIST_COLORS 里的色号，不剥注释的写法 18 条全绿。
  //
  // 三个 token 各自独立匹配（不是一次性抠出「从 --pri-3 到 --pri-1」的整段），
  // 原因跟这个文件 161 行那个 for 循环同款：一次性抠一整段的话，将来谁在
  // 三个 token 中间插一条注释或者一个 --pri-0，红的位置会是这条无关的旧断言，
  // 不是新插入内容本身；独立匹配各管各的一行，谁坏了谁红。

  for (const tok of ['--pri-3', '--pri-2', '--pri-1']) {
    it(`${tok} 不跟清单调色盘撞，也不是群青`, () => {
      const m = bare.match(new RegExp(`\\n\\s*${tok}:[^;]*;`));
      expect(m, `${tok} 这一行不见了`).not.toBeNull();
      const upper = m![0].toUpperCase();
      expect(upper).not.toContain('#2E3ED4');
      // LIST_COLORS（App.tsx 顶部那盘）一个都不许重用——重用了就分不清
      // 「这是它的优先级」还是「这是它属于哪个清单」
      for (const c of ['#C2410C', '#15803D', '#7E22CE', '#B45309', '#0E7490', '#BE123C']) {
        expect(upper).not.toContain(c);
      }
    });
  }

  it('优先级按钮的文字是石墨黑——只有旗的字形带颜色，且点击目标够 24px', () => {
    const m = bare.match(/\n\.ink-pri-btn \{[^}]*\}/);
    expect(m).not.toBeNull();
    // 不能用 toContain('--ink-you') 判定「文字是石墨黑」——border 那行
    // （color-mix(in srgb, var(--ink-you) 15%, transparent)）本身就含
    // --ink-you，这条正向断言恒真，删掉 color 那行整条测试照样绿。
    // 照 .ink-nav-dot（这个文件 90 行）的写法：`(^|[^-])color:` 只认
    // 「color:」本身，排除 border-color / background-color。
    expect(m![0]).toMatch(/(^|[^-])color:\s*var\(--ink-you\)/m);
    expect(m![0]).not.toContain('--pri-');
    // 12px 字号点击目标够不到 24px 下限——跟 .ink-nav-tag（99 行）同一条教训，
    // 高度正好卡在边界，没有富余，之前没有断言锁住。
    expect(m![0]).toMatch(/min-height:\s*24px/);
  });

  it('.ink-pri-flag 本身（旗这个字形）不含群青——这批四个记号族（清单/标签/重复/优先级）里唯一没守住的那个', () => {
    // 不能套上面几组 for 循环的写法（`bare.match` 不带 /g，只取第一个匹配）：
    // 带颜色的是 .ink-pri-flag.ink-pri-3/2/1 三条复合选择器，
    // 而 `.ink-pri-flag { margin-right… }`（无色）排在它们前面——只取第一个
    // 匹配抠到的正是那条无色的，又是一条真空绿（实测：把 .ink-pri-flag.ink-pri-3
    // 染成 #2E3ED4，31/31 全绿）。用 /g 扫出所有「选择器以 .ink-pri-flag 开头」
    // 的规则块，四条一个不漏地逐个断言。
    //
    // 负向前瞻用的是 (?![\w-])，不是这个文件其它地方（改造后）的 \s*(?=[,{])——
    // 那种写法会拒掉 .ink-pri-flag.ink-pri-3 这种复合选择器（下一个字符是
    // `.` 不是 `,`/`{`），这里恰恰需要放行复合选择器，两条断言各自的匹配
    // 策略不一样，不能公用同一个正则。
    const rules = bare.match(/\n\.ink-pri-flag(?![\w-])[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-pri-flag 规则块一条都没扫到').not.toBeNull();
    expect(rules!.length, '应该有 4 条：裸类名 + .ink-pri-3/.ink-pri-2/.ink-pri-1 三个复合选择器').toBe(4);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
  });
});

describe('标签：浅底小胶囊，名字是石墨黑', () => {
  // 剥注释再匹配（模块顶层的 bare）——紧挨着这条规则上面的那段说明文字
  // （「标签是浅底小胶囊……名字本身是石墨黑」）复述了同样的措辞，不剥注释的话
  // 没法保证锚点抢的是真规则还是那句话。

  it('.ink-tag-chip：底色走 background，名字是石墨黑，不跟群青或分类色撞', () => {
    const m = bare.match(/\n\.ink-tag-chip \{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('background-color');
    expect(m![0]).toMatch(/(^|[^-])color:\s*var\(--ink-you\)/m);
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
  });

  it('.ink-tag-x：删标签的「×」点击目标够 24px——11px 字号本身够不到，跟 .ink-nav-tag/.ink-pri-btn 同一条教训', () => {
    const m = bare.match(/\n\.ink-tag-x \{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/min-height:\s*24px/);
    expect(m![0]).toMatch(/min-width:\s*24px/);
  });

  it('.ink-tag-row 不自己叠 margin-top——它活在 Space size={6} 里，Space 的 gap 已经在管这段间距；叠了会在这个 Space 里变成全站唯一的 11px（6 + 5），别处一律 6px', () => {
    // `\s*(?=[,{])`，见文件顶部「界面元件」那组 for 循环上面的注释——同一条约定。
    const m = bare.match(/\n\.ink-tag-row\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-tag-row 规则不见了').not.toBeNull();
    expect(m![0]).not.toMatch(/margin-top/);
  });
});

describe('清单归属：分类色只上背景，清单名本身是石墨黑', () => {
  // 剥注释再匹配（模块顶层的 bare）——这条规则块正上方那段注释复述了「清单色
  // 只出现在 background」「清单名本身是石墨黑」这两句话本身，不剥注释的话
  // 锚点会被这段说明文字抢走。

  it('清单色只上 background：竖条和圆点都不许出现 color', () => {
    for (const sel of ['ink-list-bar', 'ink-list-dot']) {
      // `\s*(?=[,{])`，见「界面元件」那组 for 循环上面的注释——同一条约定。
      const m = bare.match(new RegExp(`\\n\\.${sel}\\s*(?=[,{])[^{}/]*\\{[^}]*\\}`));
      expect(m, `${sel} 规则不见了`).not.toBeNull();
      // 这两条规则里不许有裸 color（背景色是 JSX 里 style 传进去的）
      expect(m![0]).not.toMatch(/[^-]color:/);
    }
  });

  it('清单名本身是石墨黑', () => {
    const m = bare.match(/\n\.ink-list-name\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('var(--ink-you)');
  });

  it('归到哪个清单的下拉框点击目标够 24px——它是 <select> 不是 <button>，量测夹具只对 INPUT 爬祖先', () => {
    const m = bare.match(/\n\.ink-list-select\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/min-height:\s*24px/);
  });
});

describe('重复规则：不是 AI 产出，一处群青都不许有；星期几按钮是 <button>，得自己够 24px 点击目标', () => {
  // 剥注释再匹配（模块顶层的 bare）——同一条约定。

  for (const sel of ['ink-repeat-row', 'ink-repeat-select', 'ink-repeat-interval', 'ink-repeat-day', 'ink-repeat-mark', 'ink-repeat-preview']) {
    it(`.${sel} 规则块不含群青`, () => {
      // `\s*(?=[,{])`：`.ink-repeat-day` 是 `.ink-repeat-days`（theme.css 里
      // 排在它前面）的前缀，锚点后面紧跟的 's' 既不是空白也不是 `,`/`{`，
      // 这条前瞻直接拒绝，不会误吃到 `.ink-repeat-days` 那条一行式规则——
      // 跟老写法 (?![\w-]) 挡的是同一件事（审查实测：.ink-repeat-day 的
      // color 改成群青，老写法下 31/31 全绿）。这个锚点同时还挡住了老写法
      // 挡不住的一类变体——见本文件「界面元件」那组 for 循环上面的注释。
      const m = bare.match(new RegExp(`\\n\\.${sel}\\s*(?=[,{])[^{}/]*\\{[^}]*\\}`));
      expect(m, `${sel} 规则不见了`).not.toBeNull();
      expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
      expect(m![0]).not.toContain('--ink-ai');
    });
  }

  it('.ink-repeat-day：<button> 不像 <input> 那样被量测夹具自动爬祖先算点击区域，min-height/min-width 都得自己写够 24px', () => {
    const m = bare.match(/\n\.ink-repeat-day \{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/min-height:\s*24px/);
    expect(m![0]).toMatch(/min-width:\s*24px/);
  });
});

// 这三条声明是**一组**，缺任何一条都会坏一件不同的事，而且三件事互相看不见：
// 少了 display 是「两条短子任务并排挤成一条」，少了 width 是「卡片右边那片空白
// 变成开关，点一下就把子任务勾掉并 PATCH 出去」，少了 min-height 是够不到 24px
// 点击目标下限。前两条一个 jsdom 断言都守不住（不算布局），只能在这里钉声明本身。
it('.ink-subtask.ant-checkbox-wrapper：块级（一行一条）+ 按内容收宽（点击目标不铺满整行）+ 够 24px', () => {
  const m = bare.match(/\n\.ink-subtask\.ant-checkbox-wrapper\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
  expect(m, '.ink-subtask.ant-checkbox-wrapper 规则不见了').not.toBeNull();
  expect(m![1]).toMatch(/display:\s*flex/);
  expect(m![1]).toMatch(/width:\s*fit-content/);
  expect(m![1]).toMatch(/min-height:\s*24px/);
});

// 「今天」那颗按钮把这一行从「390px 刚好够」推过了界（六颗控件 + 一个
// min-width: 6em 的标题）。不换行的话 flex 会把按钮压到 min-content 以下，
// 中文按钮名当场竖着劈成两三行——jsdom 看不见，只能钉声明。
it('.ink-cal-nav：允许换行，窄屏上按钮整颗换行而不是被压得竖着劈开', () => {
  const m = bare.match(/\n\.ink-cal-nav\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
  expect(m, '.ink-cal-nav 规则不见了').not.toBeNull();
  expect(m![1]).toMatch(/flex-wrap:\s*wrap/);
});

describe('日历：固定 7 列网格，格子有最小高度 + 裁切，三种状态各一个类且不上群青', () => {
  // 剥注释再匹配（模块顶层的 bare）——同一条约定。

  // task-7：`.ink-cal-day`/`.ink-cal-day-today`/`.ink-cal-day-outside`/
  // `.ink-cal-tasks`/`.ink-cal-tasktitle`/`.ink-cal-more`（月格自己的正文，
  // Task 5 换成 FullCalendar 之后再没有元素渲染这几个类）连同 `.ink-cal-grid`
  // （曾经跟 `.ink-cal-weekdays` 逗号并列共用一条规则块）一起退役——grep 过
  // web/src 全部 .tsx/.ts，零渲染。`.ink-cal-day-selected`/`.ink-cal-daynum`
  // （CalendarFull.tsx 还在用）、`.ink-cal-nav`/`.ink-cal-heading`/
  // `.ink-cal-weekdays`/`.ink-cal-weekday`（CalendarGrid.tsx 还在画导航行和
  // 月视图星期表头）留着，各自的规则和断言都还在下面。

  it('.ink-cal-weekdays 是 7 列等宽网格——`.ink-cal-grid`（月格自己的网格）随 Task 5 换成 FullCalendar 一起死了，task-7 从这条共用规则里摘掉，留下这半，星期表头还在用它对齐 7 列', () => {
    const m = bare.match(/\n\.ink-cal-weekdays\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-weekdays 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  });

  // final-review.md I4：以前这里是手抄的 8 个类名，漏掉了 7 条规则块（包括
  // `.ink-cal-daynum` 日期数字、`.ink-cal-weekday` 星期几表头——后者是
  // `.ink-repeat-day` 那起事故的字面孪生，七颗星期几按钮全染群青、31/31
  // 全绿）。照 `.ink-pri-flag`（这个文件 264 行）的写法改成前缀扫描 + 条数
  // 断言，不再手抄清单：以后新增一条 `.ink-cal-*` 忘了守，条数会跟着变，
  // 直接红。`[\w-]*` 贪心吃掉整个连字符类名，这里扫的是「所有以 .ink-cal-
  // 开头的规则」，不用像 `.ink-repeat-day` 那条一样另加 `(?![\w-])` 负向
  // 前瞻挡某个更长的兄弟名。
  //
  // task-4-brief：15 条变 14 条——`.ink-cal-hint`（日历上方常驻的拖拽说明）
  // 挪进了 CalendarGrid.tsx 里 .ink-cal-grid 的原生 `title`，规则本身删掉了。
  // task-6：14 条变 15 条——`.ink-cal-timegrid`（周/日视图外层的固定高度
  // 滚动容器）新增，纯布局（`height`/`overflow`），零携色属性，进这个
  // 前缀族的计数纯粹是因为类名前缀凑巧一样，不是它真的有群青风险要守。
  // task-7：15 条变 9 条——退役 `.ink-cal-day`/`.ink-cal-day-today`/
  // `.ink-cal-day-outside`/`.ink-cal-tasks`/`.ink-cal-tasktitle`/
  // `.ink-cal-more` 六条整块规则，另外把 `.ink-cal-grid` 从跟
  // `.ink-cal-weekdays` 共用的那条规则块里摘掉（规则块本身还在，只是少了
  // 一个选择器）——15 - 6 = 9，不是 15 - 7：删掉的计数单位是「规则块」，
  // `.ink-cal-grid` 那次不单独占一块。
  // 「日历显示设置」那一批：9 条变 11 条——`.ink-cal-prefs`（那一排的容器）
  // 和 `.ink-cal-pref`（一个勾选框 + 文字）两条新增，都是纯布局
  // （flex/gap/font-size/cursor），零携色属性。推演出来的「未来重复周期」
  // 那条规则**不在这一族里**：它叫 `.ink-ghost-event`、选择器从 `.fc-`
  // 打头，归 `.fc-*` 那一族管，理由写在 theme.css 里那条规则上面。
  // 「在这天新建」那一批：11 条变 13 条——`.ink-cal-compose` 和它的 :hover
  // 各一条，都是行内文字按钮的既有那套（display/margin/padding/font-size/
  // min-height + 一个 color-mix 的石墨灰），没有群青。
  // 照滴答清单改日历那一批：22 条变 26 条——`.ink-cal-pager button`（‹ › 两颗
  // 单字符按钮实测只有 22px 宽，min-width 兜到 24px）、`.ink-cal-daynum-today`
  // （今天那颗实心圆；**类名挂在 span 自己身上而不是写成
  // `.fc-day-today .ink-cal-daynum`**，祖先打头会从这条前缀扫描里整条隐形，
  // 正是下面那条交叉核对要抓的东西）、`.ink-cal-chip` 和 `.ink-cal-chiptime`
  // （月格里一条事件 = 标题 + 右端灰色时刻，照滴答排）四条新增。
  // 月历铺满窗口那一改：26 条变 27 条——`.ink-cal-monthgrid`（月视图那层
  // 高度壳，跟 `.ink-cal-timegrid` 同一个高度值、但**不滚**）新增。
  // 农历那一批：27 条变 32 条——`.ink-cal-sub`（日号底下那半行的容器）、
  // `.ink-cal-lunar`（农历/节气那几个字）、`.ink-cal-mark` + `-off` + `-on`
  // （「休 / 班」那颗小方块，实心/描边两档）。
  // 「从日历拖回安排任务栏」那一批：32 条变 35 条——`.ink-cal-sched-drop`
  // （正在拖，虚线边 = 这儿可以放）、`.ink-cal-sched-over`（就悬在这儿，实线
  // + 浅底 = 松手就落这儿）、`.ink-cal-dropnote`（拖着时才出现的那一句）。
  // 窄屏月格只画时刻那一改：35 条变 38 条——`.ink-cal-chip-narrow`（窄屏
  // 的事件块，时刻居中）、`.ink-cal-chiptime-narrow`（把宽屏那条把时刻推到
  // 右端的 margin-left: auto 归零）、`.ink-cal-chipdot`（没有时刻的那些画一个
  // 点，颜色跟时刻同一档的石墨灰）。判据和为什么这么改在 CalendarFull.tsx 的
  // eventContent 那段注释：390px 下月格约 50px 宽，标题被裁掉 98%，屏幕上只
  // 剩标题的第一个字。
  // 「安排任务折行」那一批：38 条变 41 条——`@container` 里的
  // `.ink-cal-timegrid`/`.ink-cal-monthgrid`/`.ink-cal-sched` 各一条覆盖。
  // **锚点跟着从 `\n\.` 放宽成 `\n[ \t]*\.`**：那三条缩进在 `@container` 里，
  // 按老锚点整块隐形——而「隐形」正是下面那条全文件计数交叉核对要抓的东西，
  // 不放宽的话这次改动会让它红（它也确实红了，这里是照着它的指认改的，不是
  // 绕开它）。放宽只放行「缩进 + 顶格类名」，祖先选择器打头的照旧抓不到、
  // 照旧被那条交叉核对兜住。
  it('剩下的 41 条 .ink-cal-* 规则块一个群青都不许有', () => {
    const rules = bare.match(/\n[ \t]*\.ink-cal-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-cal-* 规则块一条都没扫到').not.toBeNull();
    expect(rules!.length, '应该有 41 条：.ink-cal-compose / :hover / .ink-cal-shell / .ink-cal-main / .ink-cal-sched / .ink-cal-prefs / .ink-cal-pref / .ink-cal-nav / .ink-cal-nav button / .ink-cal-nav button[aria-pressed] / .ink-cal-tools / .ink-cal-mode / .ink-cal-modesel / .ink-cal-pager / .ink-cal-pager button + button / .ink-cal-pager button / .ink-cal-heading / .ink-cal-wk / .ink-cal-weekdays / .ink-cal-weekday / .ink-cal-day-selected / .ink-cal-daynum / .ink-cal-daynum-today / .ink-cal-timegrid / .ink-cal-monthgrid / .ink-cal-chip / .ink-cal-chiptime / .ink-cal-sub / .ink-cal-lunar / .ink-cal-mark / .ink-cal-mark-off / .ink-cal-mark-on / .ink-cal-sched-drop / .ink-cal-sched-over / .ink-cal-dropnote / .ink-cal-chip-narrow / .ink-cal-chiptime-narrow / .ink-cal-chipdot / @container 里的 .ink-cal-timegrid / .ink-cal-monthgrid / .ink-cal-sched').toBe(41);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    // 修复轮 1 · M-1：这条全文件计数交叉核对——`\n\.ink-cal-` 这个锚点只认
    // 「顶格、紧跟在换行后面」的选择器，一条祖先选择器打头的规则（比如
    // `.ink-view-panel-calendar .ink-cal-nav button[aria-pressed='true']`）
    // 整条从前缀扫描里隐形，条数断言照样能全绿、群青照样能塞进去。全文件里
    // `.ink-cal-` 出现的次数，必须等于前缀扫描抓到的这 11 条规则块里
    // `.ink-cal-` 出现的次数——两个数不相等就说明有 `.ink-cal-` 出现在了
    // 前缀扫描够不到的地方。
    expect(
      (bare.match(/\.ink-cal-/g) ?? []).length,
      '有 .ink-cal- 出现在前缀扫描够不到的地方（祖先选择器打头；缩进本身不再隐形，@container 那三条是照这条的指认才被收进扫描的）',
    ).toBe((rules!.join('').match(/\.ink-cal-/g) ?? []).length);
  });

  /**
   * 「日历视图不管窗口多高，滚栏始终都在」那条 bug 的守卫。
   *
   * 病根：两条日历高度是 `100vh - 常数`——日历自己就吃满一整屏，所以只要
   * `.ink-cal-shell` 换了行、「安排任务」整条落到日历下面，`.ink-board-col`
   * 就必定溢出，**而且溢出量跟窗口多高完全无关**（窗口高一像素，日历也高
   * 一像素）。实测：壳宽 746px 时视口 800 / 1100 / 1500 三档的溢出量都是
   * 587px，一个数；壳宽 846px（不换行）三档都是 0。
   *
   * **钉的是算术关系，不是三个孤立的数字。** 折行档的两条常数必须正好比
   * 常驻档大「安排栏的 `max-height` + 壳的 `gap`」——谁把安排栏改宽、把 gap
   * 改大而忘了这两个常数，这条就红。那正是原来那个 bug 的形状：一处的高度
   * 算式没跟上另一处的存在。
   */
  it('.ink-cal-* 折行档：两条高度常数各比常驻档大（安排栏 max-height + gap），否则中间那栏又会永远溢出', () => {
    const num = (src: string, re: RegExp, what: string) => {
      const m = src.match(re);
      expect(m, `${what} 没匹配到`).not.toBeNull();
      return Number(m![1]);
    };

    // 顶层那两条（常驻档）。锚点带 `\n\.`，只认顶格——`@container` 里那两条是
    // 缩进的，抓不到它们，正好把两档分开。
    const gap = num(bare, /\n\.ink-cal-shell[^{}]*\{[^}]*\bgap:\s*(\d+)px/, '.ink-cal-shell 的 gap');
    const baseTime = num(bare, /\n\.ink-cal-timegrid[^{}]*\{[^}]*100vh\s*-\s*(\d+)px/, '常驻档 .ink-cal-timegrid');
    const baseMonth = num(bare, /\n\.ink-cal-monthgrid[^{}]*\{[^}]*100vh\s*-\s*(\d+)px/, '常驻档 .ink-cal-monthgrid');

    const cm = bare.match(/@container\s*\(max-width:\s*799\.98px\)\s*\{([\s\S]*?)\n\}/);
    expect(cm, '折行档那个 @container (max-width: 799.98px) 不见了').not.toBeNull();
    const wrap = cm![1];
    const sched = num(wrap, /\.ink-cal-sched\s*\{[^}]*max-height:\s*(\d+)px/, '折行档 .ink-cal-sched 的 max-height');

    expect(
      num(wrap, /\.ink-cal-timegrid\s*\{[^}]*100vh\s*-\s*(\d+)px/, '折行档 .ink-cal-timegrid') - baseTime,
      '周/日：折行档比常驻档该多让出「安排栏 + gap」那么高',
    ).toBe(sched + gap);
    expect(
      num(wrap, /\.ink-cal-monthgrid\s*\{[^}]*100vh\s*-\s*(\d+)px/, '折行档 .ink-cal-monthgrid') - baseMonth,
      '月视图：同上',
    ).toBe(sched + gap);

    // 被压到 260 之后里面那份 `.ink-sched`（flex: 1; min-height: 0）会缩，但
    // 内容不会自己滚——少了这一句，压下去的部分直接溢出来，等于没修。
    expect(wrap, '折行档 .ink-cal-sched 少了 overflow-y: auto').toMatch(/\.ink-cal-sched\s*\{[^}]*overflow-y:\s*auto/);

    // 查询容器：没人给 @container 当容器的话，整块静默失效（不报错、不红）。
    expect(bare, '.ink-cal-shell 少了 container-type: inline-size，@container 整块会静默失效')
      .toMatch(/\n\.ink-cal-shell[^{}]*\{[^}]*container-type:\s*inline-size/);

    // `@container` 不加特异度，跟顶层那两条一样重，谁写在后面谁赢——挪到文件
    // 前面去这一整块就静默失效了（`.ink-main` 那条媒体查询栽过同一个跟头）。
    expect(bare.indexOf('@container'), '@container 那一块必须写在两条顶层高度后面，否则被它们盖掉')
      .toBeGreaterThan(bare.indexOf('\n.ink-cal-monthgrid'));
  });

  // 「安排任务」栏要**撑满整条**，不是只有内容那么高。这三条锁的是那件事的
  // 三个环节，缺哪一个都会退回原样。实测过原样长什么样：栏高 233px、容器
  // 876px，剩下 643px 是空纸——而空纸不接拖拽，「把日历上的任务拖回这一栏」
  // 能落的地方只有顶上一小块，看起来像功能坏了。
  // 看板那条 `.ink-cells` 早就是 `align-items: stretch`，注释里写的是同一个
  // 理由（四列不等高会让空列看着像「装不下」）——日历这条是漏网的那个。
  it('.ink-cal-shell 不许写 align-items: flex-start——那正是「安排任务」栏只有内容高的原因', () => {
    const m = bare.match(/\n\.ink-cal-shell\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-shell 规则不见了').not.toBeNull();
    expect(m![1]).not.toMatch(/align-items:\s*flex-start/);
  });

  it('.ink-cal-sched 自己是 flex 列——拖拽提示在上、面板占掉剩下的全部高度', () => {
    const m = bare.match(/\n\.ink-cal-sched\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-sched 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/display:\s*flex/);
    expect(m![1]).toMatch(/flex-direction:\s*column/);
  });

  it('.ink-sched 占满外面那一栏（flex: 1）——它左边那条 border-left 是日历和这一栏的分隔线，该跟日历一样高，不是跟「恰好写了几行字」一样高', () => {
    const m = bare.match(/\n\.ink-sched\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-sched 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/flex:\s*1/);
    expect(m![1]).toMatch(/border-left/);
  });

  // final-review.md M4：13px 字号本身够不到 24px 下限，跟 .ink-nav-tag/
  // .ink-pri-btn/.ink-tag-x 同一条教训——这四颗按钮（上一页/下一页/月/周）
  // 是同一族。CSS 里写对了（`min-height: 24px`），只是没有断言锁住。
  it('.ink-cal-nav button 点击目标够 24px', () => {
    const m = bare.match(/\n\.ink-cal-nav button\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-nav button 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });
});

// 月视图正文换成 FullCalendar（CalendarFull.tsx，task-5）：这个 Task 存在的
// 全部意义是把「第三方组件的样式怎么守」这件事解决掉——`.ink-*` 那套四件套
// 扫的是我们自己写的规则，FullCalendar 自己的样式表（几十条 .fc-* 规则）
// 完全在它的射程外，跟 antd 的 colorPrimary 是同一个盲区，已经漏过四轮。
// 做法：把 `--fc-*` 变量映射到这个仓库的 token，再给我们自己写的 `.fc-*`
// 规则照抄 `.ink-*` 各族的四件套（前缀扫描 + 条数断言 + 群青检查 + 全文件
// 计数交叉核对）。**这四件套只守得住「我们自己写的这几条规则」**——
// FullCalendar 自己的样式表里有没有硬编码颜色（不经过 --fc-* 变量），这里
// 一个字都看不出来，那半的验收标准是 CalendarFull.test.tsx 的渲染层断言
// （真的渲染一个 FullCalendar，读 getComputedStyle，见那个文件）。
describe('FullCalendar 月视图 + 周/日视图：.fc-* 前缀族 + --fc-* 变量映射，一个群青都不许有', () => {
  // 「显示未来重复周期」那一批：8 条变 9 条——`.fc-event.ink-ghost-event`
  // （推演出来的影子：半透明 + 虚线边框 + 默认光标）新增。它顶格从 `.fc-`
  // 打头就是为了落进这个前缀族，见 theme.css 里那条规则上面的说明。
  // 「日历上显示纪念日」那一批：9 条变 10 条——`.fc-event.ink-cd-event` 新增。
  // 「显示专注记录 / 显示打卡」那一批：10 条变 12 条——`.fc-event.ink-focus-event`
  // 和 `.fc-event.ink-checkin-event` 各一条。四种标记各一条规则，跟
  // CalendarFull.tsx 里 MARK_CLASS 那张表一一对应。
  // 照滴答清单量了一轮之后：12 条变 14 条——`.fc-timegrid-event
  // .fc-event-title`（半小时以内那些事件块的标题，FullCalendar 自己那条
  // 0-2-0 把全站 11px 下限压掉了）和 `.fc-timegrid-axis-cushion`（左上角
  // 那颗「35周」，22px 高，第十三次为 24px 兜底）。
  it('.fc-* 规则块（月视图 4 条 + task-6 周/日视图新增 4 条 + 四种标记各 1 条 + 量测补的 2 条）一个群青都不许有', () => {
    const rules = bare.match(/\n\.fc-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.fc-* 规则块一条都没扫到').not.toBeNull();
    expect(
      rules!.length,
      '应该有 12 条：.fc-event-title / .fc-daygrid-more-link / .fc-daygrid-day-number / .fc-event（月视图）+ .fc-col-header-cell / .fc-timegrid-slot / .fc-timegrid-more-link / .fc-timegrid-now-indicator-line::before（周/日视图，task-6）+ .fc-timegrid-event .fc-event-title / .fc-timegrid-axis-cushion（量测补的）+ 四种标记：.fc-event.ink-ghost-event（影子）/ .fc-event.ink-cd-event（纪念日）/ .fc-event.ink-pomo-event（专注记录）/ .fc-event.ink-checkin-event（打卡）',
    ).toBe(14);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    // 跟 .ink-cal-*/.ink-calh-* 同一条交叉核对：全文件 .fc- 出现的次数必须
    // 等于前缀扫描抓到的这 14 条规则块里 .fc- 出现的次数，两个数不相等就说明
    // 有 .fc- 藏在前缀扫描够不到的地方（祖先选择器打头 / @media 里）。
    expect(
      (bare.match(/\.fc-/g) ?? []).length,
      '有 .fc- 出现在前缀扫描够不到的地方',
    ).toBe((rules!.join('').match(/\.fc-/g) ?? []).length);
  });

  it('.fc-event-title：长标题截断（ellipsis），字号不低于全站 11px 下限——FullCalendar 默认只有 overflow:hidden，没有省略号', () => {
    const m = bare.match(/\n\.fc-event-title\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-event-title 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/overflow:\s*hidden/);
    expect(m![1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(m![1]).toMatch(/font-size:\s*11px/);
  });

  it('.fc-daygrid-more-link：够 24px 点击目标，字色是 --dim（这是这个仓库第八次为 24px 单独兜底：.ink-nav-tag/.ink-pri-btn/.ink-tag-x/.ink-repeat-day/.ink-cal-nav button/.ink-trow-handle/.ink-calh-more 之后的第八次）', () => {
    const m = bare.match(/\n\.fc-daygrid-more-link\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-daygrid-more-link 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/min-width:\s*24px/);
    // I2 修复：`--fc-more-link-text-color` 这个变量月视图下是死的（只有
    // @fullcalendar/timegrid 用它，见上面 :root 那段说明），字色改成直接写
    // 在我们自己这条规则里，才是真的生效的那条路——旧实现 .ink-cal-more
    // 同样用 --dim，这条延续的是真的在起作用的那个选择。
    expect(m![1]).toMatch(/(^|[^-])color:\s*var\(--dim\)/m);
    // 修复轮 2 复审②：这条规则声明了四个属性，之前只有 min-width/
    // min-height/color 三条各有断言，font-size 从 95a3266 落地那天起就
    // 没人守——不是这轮引入的缺口，但顺手补上，跟 .fc-event-title 同一条
    // 全站 11px 下限。
    expect(m![1]).toMatch(/font-size:\s*11px/);
    // 不再断言 display: inline-block——FullCalendar 自己的样式表给这个类
    // 挂了 float: left，真实浏览器里 float 会把 UA 计算出的 display 强制
    // 变成 block（CSS 2.1 §9.7），我们自己再声明一次 inline-block 是一条
    // 在真实浏览器里永远不会生效的死代码，已经删掉（复审 M4 指出的坑：
    // 那条真级联层测试断言的是一个只在「没有注入 FullCalendar 真实样式表」
    // 这个不真实的前提下才成立的值）。
  });

  it('.fc-daygrid-day-number：月格日期数字够 24px 点击目标（第十次单独兜底）——量测夹具在三个宽度下各数到 48 个过小目标，全是它', () => {
    const m = bare.match(/\n\.fc-daygrid-day-number\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-daygrid-day-number 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-width:\s*24px/);
    // 不断言 display: inline-block，跟 .fc-daygrid-more-link 同一条理由（上面
    // 那条测试末尾的复审 M4）。第一版这里写的是「FullCalendar 没给这个类挂
    // float，`<a>` 还是行内盒子」——那句只看了 float 这一条块化的路：这个 `<a>`
    // 的父节点 `.fc-daygrid-day-top` 是 `display:flex`（FullCalendar 自己的样式
    // 表），flex 项一样会被强制块化，min-width 本来就吃得到。断言一条无效声明
    // 的后果不是漏掉 bug，是把「删掉死代码」变成一次假红。
    // 不再是 `text-align: center`：照滴答清单，这个 `<a>` 里现在装着两个 span
    // ——日号在左、周数在右，靠 flex + space-between 把它们推开。居中会把两颗
    // 挤到中间糊成「27³¹周」（实测过的那个读法）。**这一条必须挂在这个 `<a>`
    // 上**，不能挪到外面的 `.fc-daygrid-day-top`：那个容器只看得见一个孩子，
    // 而且 FullCalendar 自己写的是 `.fc .fc-daygrid-day-top`（两个类），顶格
    // 一个类名压不过它。
    expect(m![1]).toMatch(/display:\s*flex/);
    expect(m![1]).toMatch(/justify-content:\s*space-between/);
    expect(m![1]).toMatch(/width:\s*100%/);
    // 农历那半行（`.ink-cal-sub`，`flex-basis: 100%`）是这一行的第三个 flex
    // 项，靠换行掉到日号下面自己占一行。删掉这一条它会挤在日号右边，实测
    // 长这样：「27³¹ 十四」。
    expect(m![1]).toMatch(/flex-wrap:\s*wrap/);
  });

  it('.ink-cal-monthgrid：月视图那层高度壳，calc(100vh - 228px)（比周/日那条多减一行自己画的星期表头），不封 960 上限，overflow 是 hidden 不是 auto——一格装不下走 +N，那是月视图自己的溢出机制，再叠一层滚动条是两套溢出打架', () => {
    const m = bare.match(/\n\.ink-cal-monthgrid\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-monthgrid 规则不见了').not.toBeNull();
    // 常数 228 跟周/日那条的 203 不一样：月视图多一行自己画的星期表头。
    expect(m![1]).toMatch(/height:\s*max\(320px,\s*calc\(100vh - 228px\)\)/);
    expect(m![1]).toMatch(/overflow:\s*hidden/);
  });

  it('.fc-timegrid-event .fc-event-title：周/日事件块标题钉回 11px + 不折行。**范围是所有时间块，不只 -short 那一档**——expandRows 之后一小时的块不再算「短」，只管 -short 会在 390 宽漏出六条截断', () => {
    const m = bare.match(/\n\.fc-timegrid-event .fc-event-title\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-timegrid-event .fc-event-title 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/font-size:\s*11px/);
    // 折行那半：`.fc-event-main-frame` 是 flex + overflow:hidden，21px 高的块
    // 里折成三行会被裁掉（390 宽实测六条 need 48 / got 21）。
    expect(m![1]).toMatch(/white-space:\s*nowrap/);
  });

  it('.fc-timegrid-axis-cushion：左上角那颗「35周」够 24px 点击目标（第十三次单独兜底）——实测 39×22，差 2px', () => {
    const m = bare.match(/\n\.fc-timegrid-axis-cushion\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-timegrid-axis-cushion 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });

  it('.fc-event：月格事件块够 24px 点击目标（第十一次单独兜底）——默认 21px，可点也可拖', () => {
    // `(?=[,{])` 前瞻是必须的：`.fc-event` 是 `.fc-event-title` 的前缀，
    // 没有它这条会先撞上 .fc-event-title 那块（前缀兄弟选择器，这个仓库
    // 在 .ink-cells/.ink-cells-2x2 上栽过一次）。
    const m = bare.match(/\n\.fc-event\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-event 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });

  it('.ink-cal-timegrid：周/日视图外层滚动容器，高度是 max(320px, min(calc(100vh - 203px), 960px))——960 那半还是 24 行 × 40px 的完整内容高度；60vh 换成 calc 是量出来的（1440×900 上底下空了 159px 白纸，而顶上那截 chrome 是固定像素高，vh 只能对一个高度）', () => {
    const m = bare.match(/\n\.ink-cal-timegrid\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-cal-timegrid 规则不见了').not.toBeNull();
    // **calc 而不是 vh**：顶上那截 chrome 是固定像素高、不随窗口缩放，
    // 「窗口高的百分之几」在任何一个高度上都只能对一次。
    expect(m![1]).toMatch(/height:\s*max\(320px,\s*min\(calc\(100vh - 203px\),\s*960px\)\)/);
    expect(m![1]).toMatch(/overflow:\s*hidden/);
  });

  // task-6：周/日视图（timeGridWeek/timeGridDay）新增的四条 .fc-* 规则。
  it('.fc-col-header-cell：周/日视图表头日期格——手型光标 + 24px 点击目标下限（第九次为 24px 单独兜底）', () => {
    const m = bare.match(/\n\.fc-col-header-cell\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-col-header-cell 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/cursor:\s*pointer/);
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });

  it('.fc-timegrid-slot：小时槽高度钉 40px，跟退役前 CalendarHours.tsx 的 ROW_HEIGHT 同一个视觉密度', () => {
    const m = bare.match(/\n\.fc-timegrid-slot\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-timegrid-slot 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/height:\s*40px/);
  });

  it('.fc-timegrid-more-link：时间轴那半的「还有 N 条」（跟 .fc-daygrid-more-link 是两个不同的类）——24px 点击目标 + 11px 字号 + --dim 字色，直接写在这条规则里', () => {
    const m = bare.match(/\n\.fc-timegrid-more-link\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-timegrid-more-link 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/min-width:\s*24px/);
    expect(m![1]).toMatch(/font-size:\s*11px/);
    expect(m![1]).toMatch(/(^|[^-])color:\s*var\(--dim\)/m);
  });

  it('.fc-timegrid-now-indicator-line::before：左端的圆点标记（避免整条线被读成删除线，跟退役前 .ink-calh-nowline::before 同一手法）——真的是个圆、石墨黑不是群青、8px 真的画出来', () => {
    const m = bare.match(/\n\.fc-timegrid-now-indicator-line::before\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.fc-timegrid-now-indicator-line::before 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/border-radius:\s*50%/);
    expect(m![1]).toMatch(/background:\s*var\(--ink-you\)/);
    expect(m![1]).toMatch(/width:\s*8px/);
    expect(m![1]).toMatch(/height:\s*8px/);
  });

  // 复审 M4 修复的第二半：**没有补一条「float 强制 display 变成 block」的
  // 真级联层测试**——实测过（临时探针）：jsdom 的 cssstyle 不实现 CSS 2.1
  // §9.7 那条「float 元素的 display 计算值被强制转换」的算法，注入
  // `float: left` 之后 `getComputedStyle(el).display` 在 jsdom 下仍然是
  // UA 默认的 'inline'，不会变成 'block'——这是 jsdom 这个假 CSS 引擎的
  // 能力边界（真实浏览器不存在这个限制，见上面文本层断言旁的说明），不是
  // 「不想写」。同一次探针还确认了 `min-height` 在 jsdom 下不区分 display
  // 类型（不管 display 是 inline 还是 block，min-height 的 computed 值都
  // 原样返回声明值）——jsdom 不做布局，没有「min-height 对行内元素不生效」
  // 这层语义，所以就算写一条「min-height 在 jsdom 里读到 24px」的断言，
  // 也测不出「real 浏览器里这条规则到底会不会生效」这件事，只是重复文本层
  // 已经断言过的「声明了 24px」——跟 `.ink-calh-sticky`/`.ink-calh-col`
  // 那两条真级联层测试的前提不一样：那两条测的是 jsdom 能正确处理的简单
  // 属性覆盖/继承，这里测的是 jsdom 压根不实现的布局阶段转换，两者不是
  // 同一类可验证的东西，不硬凑一条测不出真实结论的测试。

  it('--fc-* 变量映射（:root 里那 7 条）一个群青都不许有', () => {
    const m = bare.match(/\n\s*--fc-border-color:[^;]*;[\s\S]*?--fc-now-indicator-color:[^;]*;/);
    expect(m, '--fc-* 变量映射块不见了').not.toBeNull();
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
    expect(
      (bare.match(/--fc-/g) ?? []).length,
      '应该恰好 7 条 --fc-* 声明：border-color/page-bg-color/today-bg-color/event-bg-color/event-border-color/event-text-color（月视图，task-5）+ now-indicator-color（周/日视图，task-6，不包含 --fc-more-link-text-color——I2 修复：那个变量月视图下是死映射，已经删掉，字色直接写在 .fc-daygrid-more-link/.fc-timegrid-more-link 自己的规则里）',
    ).toBe(7);
  });

  /**
   * 复审 I1：渲染层扫描器（CalendarFull.test.tsx）在 jsdom 下看不见
   * `border: 1px solid var(...)` 这种简写——cssstyle 会把整条简写声明
   * 丢弃，不解析也不报错。`--fc-border-color`/`--fc-event-border-color`
   * 唯二的落点都是这种简写，渲染层测不出它们映射对不对，这两条正向断言
   * 是它们唯一的守卫（不是锦上添花，是唯一）。
   */
  it('--fc-border-color/--fc-event-border-color：正向断言，唯一的守卫——渲染层扫描器（jsdom 的 cssstyle）看不见简写 border，这两条只能靠文本层守住', () => {
    const cellBorder = bare.match(/\n\s*--fc-border-color:([^;]*);/);
    const eventBorder = bare.match(/\n\s*--fc-event-border-color:([^;]*);/);
    expect(cellBorder, '--fc-border-color 这一行不见了').not.toBeNull();
    expect(eventBorder, '--fc-event-border-color 这一行不见了').not.toBeNull();
    expect(cellBorder![1]).toContain('--rule');
    // --fc-event-border-color 是这三个事件变量里最要命的一个：FullCalendar
    // 的默认值正是 #3788d8，就是要压掉的那块蓝，而它唯一的落点（border
    // 简写）恰好是渲染层扫描器看不见的那一格——这条断言写错的话，渲染层
    // 断言不会红，只有这里会红。
    expect(eventBorder![1]).toContain('--rule');
    expect(eventBorder![1].toUpperCase()).not.toContain('#3788D8');
  });

  it('--fc-event-bg-color/--fc-event-text-color：正向断言，FullCalendar 默认的蓝底白字（#3788d8/#fff）被压成了这个仓库的中性调色板，不是随便换了个也不对的颜色', () => {
    const bg = bare.match(/\n\s*--fc-event-bg-color:([^;]*);/);
    const text = bare.match(/\n\s*--fc-event-text-color:([^;]*);/);
    expect(bg, '--fc-event-bg-color 这一行不见了').not.toBeNull();
    expect(text, '--fc-event-text-color 这一行不见了').not.toBeNull();
    expect(bg![1]).toContain('--sheet');
    expect(text![1]).toContain('--ink-you');
  });

  it('--fc-today-bg-color：跟旧实现 .ink-cal-day-today 同一条色值（8% 的你的墨），不是另起一套', () => {
    const m = bare.match(/\n\s*--fc-today-bg-color:([^;]*);/);
    expect(m, '--fc-today-bg-color 这一行不见了').not.toBeNull();
    expect(m![1]).toContain('color-mix(in srgb, var(--ink-you) 8%, transparent)');
  });

  /**
   * task-6：`--fc-now-indicator-color` 唯一的落点是 `border-color:
   * var(...)`——`border-color` 虽然只管颜色，但依然是会同时展开成四个方向
   * 的**简写**，跟 `--fc-border-color`/`--fc-event-border-color` 那两条
   * 是同一类盲区（探针实测过：jsdom 的 cssstyle 对这条声明不是整条丢弃，
   * 是悄悄按初始值算，`getComputedStyle` 读出来的颜色不管 `--x` 声明成
   * 什么都恒是 `rgb(0, 0, 0)`——渲染层扫描器天生看不出真实映射对不对，
   * 这条正向断言是唯一的守卫，见 CalendarFull.test.tsx 那边放弃对照组⑤
   * 时留的长注释）。
   */
  it('--fc-now-indicator-color：正向断言，唯一的守卫（跟 border-color/event-border-color 同一类盲区）——FullCalendar 默认是刺眼的 red，压成 --ink-you（时间算出来的状态，不借群青）', () => {
    const m = bare.match(/\n\s*--fc-now-indicator-color:([^;]*);/);
    expect(m, '--fc-now-indicator-color 这一行不见了').not.toBeNull();
    expect(m![1]).toContain('--ink-you');
    expect(m![1].toUpperCase()).not.toContain('RED');
  });

  // 这里只测「我们自己写的这几行变量声明」——真正要命的那半（FullCalendar
  // 自己的样式表会不会真的吃到这几个变量、算出来的最终颜色是不是群青）
  // 这个文件测不了：这里只注入了 theme.css 本身，没有注入 FullCalendar 的
  // 库内 CSS（`.fc-h-event { color: var(--fc-event-text-color) }` 那条规则
  // 根本不存在于这份 css 里），读 getComputedStyle 只会拿到 UA 默认值，
  // 断言写出来也是真空绿——那正是 antd colorPrimary 盲区漏过四轮的同一个
  // 形状（光扫、不渲染）。渲染层的真断言在 CalendarFull.test.tsx：那边真的
  // 用 @testing-library/react 渲染一个带任务事件的 FullCalendar，同时注入
  // FullCalendar 自己动态插入的 <style data-fullcalendar> 和这份 theme.css，
  // 读 getComputedStyle 在**它能算出计算值的那几个属性上**确认没有一处
  // 赢家是群青——border 简写那三个变量（--fc-border-color/--fc-event-
  // border-color/--fc-now-indicator-color，task-6 新增了第三个）不在这个
  // 射程内（见上面几条正向断言），见那个文件顶部的长注释和「对照组」那组
  // （先证明夹具真的能抓到偷加的群青，再证明当前代码没有）。
});

describe('同步冲突横幅：报警橙，不借群青', () => {
  // 剥注释再匹配（模块顶层的 bare）——同一条约定。

  it('冲突横幅用报警橙，不借群青——那是 AI 墨水的配额', () => {
    const m = bare.match(/\n\.ink-conflict-banner\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('--overdue');
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
  });
});

// task-3-brief：设置过服务地址、暂时连不上——不是「数据出岔子了」（那是上面
// 冲突横幅的场景，走报警橙），也不是 AI 产出的内容（不借群青），走 --ink-you
// 这一侧。单条规则，不是一族前缀，照 .ink-conflict-banner 的写法直接锚定。
describe('离线横幅：石墨色，不借群青、不借报警橙', () => {
  it('离线横幅走 --ink-you，不借群青、不借冲突横幅的报警橙', () => {
    const m = bare.match(/\n\.ink-offline-banner\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-offline-banner 规则不见了').not.toBeNull();
    expect(m![0]).toContain('--ink-you');
    expect(m![0]).not.toContain('--overdue');
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
    // 复审 I2：单条规则也会被祖先选择器打头的变体逃逸——`\n\.ink-offline-
    // banner…` 这个锚点只认「顶格、紧跟在换行后面」的选择器，`.ink-board
    // .ink-offline-banner { color: var(--ink-ai); }` 这种写法照样能塞群青
    // 进来，前几条断言全绿（它们抠出来的还是原来那条干净的规则块，压根没看
    // 见新加的这条）。全文件 `.ink-offline-banner` 出现的次数必须等于上面
    // 匹配到的规则块里出现的次数（恰好 1 次，就是选择器本身）——两个数不
    // 相等就说明有 `.ink-offline-banner` 藏在这条正则够不到的地方。
    expect(
      (bare.match(/\.ink-offline-banner/g) ?? []).length,
      '有 .ink-offline-banner 出现在前缀扫描够不到的地方（比如祖先选择器打头）',
    ).toBe((m![0].match(/\.ink-offline-banner/g) ?? []).length);
  });
});

// 本地通知那一批：手机没给通知权限时的常驻记号。它跟上面离线横幅**共用同一条
// 规则**（选择器里并排的两个类，见 theme.css 里那段注释）——共用不等于不用守：
// 上面那条断言抠出来的是同一个规则块，但只要有人另外给 .ink-notif-banner 补一
// 条覆盖规则（祖先选择器打头、或者塞进媒体查询），那条断言一个字都不会红。
// 所以照 .ink-offline-banner 的四件套原样再守一遍自己这个类名。
describe('通知权限记号：石墨色，不借群青、不借报警橙', () => {
  it('.ink-notif-banner 走 --ink-you，不借群青、不借冲突横幅的报警橙，字号在 11px 下限之上', () => {
    const m = bare.match(/\n\.ink-notif-banner\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-notif-banner 规则不见了').not.toBeNull();
    expect(m![0]).toContain('--ink-you');
    expect(m![0]).not.toContain('--overdue');
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
    // 全站 11px 字号下限——「权限没开、到点不会响」是这条记号唯一要说的话，
    // 压到看不清就等于没说。
    expect(m![0]).toMatch(/font-size:\s*12px/);
    // 跟上面同一条交叉核对（复审 I2 那条教训）：全文件出现次数必须等于上面
    // 抠出来那块里的次数，不等就说明有一条藏在这条正则够不到的地方。
    expect(
      (bare.match(/\.ink-notif-banner/g) ?? []).length,
      '有 .ink-notif-banner 出现在前缀扫描够不到的地方（比如祖先选择器打头）',
    ).toBe((m![0].match(/\.ink-notif-banner/g) ?? []).length);
  });
});

// 命令面板（Ctrl/Cmd+K）：面板的行、按键徽章、高亮态全都不该有群青——命令本身
// 是界面元件，不是 AI 写的话。照 .ink-pri-flag（这个文件 264 行）/.ink-cal-*
// （398 行）的写法用前缀扫描 + 条数断言，不手写一份类名清单——上一批（日历）
// 手写清单漏了 7 条规则块，其中 .ink-cal-weekday 是 .ink-repeat-day 那起事故
// （七颗按钮全染群青、31/31 全绿）的字面孪生。
//
// `.ink-cmd-` 这个前缀不是这一批第一次用：SettingsModal 的「回顾命令提示块」
// （.ink-cmd-hint/title/line/line code/body，这个文件更前面的位置，跟本文件的
// 「行/徽章/高亮态」描述的是完全不同的东西——那边说的是终端命令 `/review`）
// 已经占了 5 条。前缀扫描天然把新旧两批一起扫进来，条数因此是「这一批新增的
// 数量」加「已经存在的 5 条」，不是只数新加的——扫描器不知道、也不需要知道
// 一条规则是哪一批加的，它只认「选择器是不是以 .ink-cmd- 开头」。
it('.ink-cmd-* 规则块（命令面板 + 既有的回顾命令提示块）一个群青都不许有', () => {
  const rules = bare.match(/\n\.ink-cmd-[\w-]*[^{}]*\{[^}]*\}/g);
  expect(rules, '.ink-cmd-* 规则块一条都没扫到').not.toBeNull();
  expect(rules!.length, '应该有 11 条：既有的 5 条命令提示块 + 命令面板这一批新增的 6 条').toBe(11);
  for (const r of rules!) {
    expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
    expect(r, r).not.toContain('--ink-ai');
  }
  // 上面的前缀扫描要求选择器顶格、行首第一个字符就是 '.'——祖先选择器打头
  // （`.ant-modal .ink-cmd-item { … }`）和缩进在 @media 里的规则都扫不到，
  // 而这一批刚好把内容放进了 antd Modal，最顺手的压 antd 样式写法正是前者。
  // 全文 .ink-cmd- 出现次数应该跟「扫到的规则块里出现的次数」一样多——
  // 两处不等就说明有 .ink-cmd- 藏在前缀扫描够不到的地方，见 final-review.md I6。
  expect(
    (bare.match(/\.ink-cmd-/g) ?? []).length,
    '有 .ink-cmd- 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
  ).toBe((rules!.join('').match(/\.ink-cmd-/g) ?? []).length);
});

// 选中态、勾选框、批量操作条：Task 3（卡片选中 + 批量操作条）新加的记号，
// 全都是人这一侧的东西（选中是人自己点出来的，不是 AI 产出），一个群青都
// 不许有——焦点环是规格批准的唯一例外，这几个都不是。三件套照抄
// .ink-cmd-*（本文件上面那条）：前缀扫描 + 条数断言 + 全文件计数交叉核对，
// 不手写清单——上一批教训（.ink-cal-weekday 那起事故）。
describe('选中态 / 批量操作条：一个群青都不许有', () => {
  it('.ink-task-card-selected：选中标记本身，用 --rule 不用群青', () => {
    // 单条规则，不是一族前缀——跟 .ink-margin-note/.ink-row-dragging 那类
    // 直接锚定同一个写法，`\s*(?=[,{])` 是本文件的既定约定（见「界面元件」
    // 那组 for 循环上面的注释）。
    const m = bare.match(/\n\.ink-task-card-selected\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-task-card-selected 规则不见了').not.toBeNull();
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
    // 正向断言：确实用了 --rule，不是一条空规则/凑巧不含群青的无关样式。
    expect(m![0]).toContain('--rule');
  });

  it('.ink-sel-check：勾选框定位，不含群青', () => {
    // 只有这一条规则，不是一族前缀，不需要 .ink-batch-*/.ink-cmd-* 那种
    // 前缀扫描+交叉核对——`.ink-sel-check` 这个类名本身还被
    // `.ink-task-card:has(.ink-sel-check)` 那条不同的规则（钉住勾选框出现
    // 时正文的左内边距）引用了一次，交叉核对会把那处合法引用也算成
    // 「藏在扫描够不到的地方」，误报，所以这里跟 .ink-task-card-selected
    // 一样直接锚定单条规则。
    const m = bare.match(/\n\.ink-sel-check\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-sel-check 规则不见了').not.toBeNull();
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
  });

  it('.ink-batch-* 规则块（批量操作条）一个群青都不许有，且位置固定在底部', () => {
    // `\s*` 不能省：窄屏那条 .ink-batch-bar 缩进在 @media 里，顶格扫描看不见
    // 它，而下面那条全文件交叉核对会立刻发现「有一条藏在扫描够不到的地方」并
    // 判红——那正是它存在的意义，所以这里是把新规则**纳入**守卫，不是绕开它。
    const rules = bare.match(/\n\s*\.ink-batch-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-batch-* 规则块一条都没扫到').not.toBeNull();
    expect(rules!.length, '应该有 5 条：.ink-batch-bar/count/list-select/tag-input + @media 里的窄屏 .ink-batch-bar').toBe(5);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-batch-/g) ?? []).length,
      '有 .ink-batch- 出现在前缀扫描够不到的地方',
    ).toBe((rules!.join('').match(/\.ink-batch-/g) ?? []).length);

    // 「位置固定在底部」是 brief 的明文要求（task-3-brief 要点：批量操作条
    // 位置固定在底部，不遮住卡片）——.ink-batch-bar 单独再断言一次具体规则。
    const bar = bare.match(/\n\.ink-batch-bar\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(bar, '.ink-batch-bar 规则不见了').not.toBeNull();
    expect(bar![1]).toMatch(/position:\s*fixed/);
    expect(bar![1]).toMatch(/bottom:/);

    // 窄屏那条：贴左右边距的通栏底条，不是居中窄条。宽屏用的
    // `translateX(-50%)` 居中在 390px 下会让六个控件折成三行、浮在屏幕正中把
    // 卡片从中间盖掉（实测截图），所以这里必须把 transform 关掉并给出
    // left/right。
    const narrow = bare.match(/@media\s*\(max-width:\s*480px\)\s*\{\s*\.ink-batch-bar\s*\{([^}]*)\}/);
    expect(narrow, '窄屏 .ink-batch-bar 规则不见了').not.toBeNull();
    expect(narrow![1]).toMatch(/transform:\s*none/);
    expect(narrow![1]).toMatch(/left:/);
    expect(narrow![1]).toMatch(/right:/);
  });

  // 筛选栏（FilterBar 组件）：七维筛选，界面元件，不许有群青——CSS 这一层
  // 只管容器/间距，antd Select/Checkbox 的选中态是另一条防线（组件自己套
  // boardLocalTheme，theme.css.test.ts 这个文件的前缀扫描够不到那条，见
  // final-review.md「selection」批第 98 条：CSS 守卫和 antd token 是两种
  // 不同的机制，缺一不可，这里只守 CSS 这一半）。三件套照抄 .ink-batch-*：
  // 前缀扫描 + 条数断言 + 全文件计数交叉核对。
  it('.ink-filter-* 规则块（筛选栏）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-filter-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-filter-* 规则块一条都没扫到').not.toBeNull();
    // 6 条：task-4-brief 修复轮 1 · A 把 .ink-filter-bar-open 从
    // .ink-filter-bar 里拆出来（收起态不带边框/底色），5 条变 6 条。
    // 高级筛选那一批：6 条变 8 条——`.ink-filter-or`（「或」组独占一行、
    // 整体缩进）和 `.ink-filter-or-label`（那个「或者」小字）两条新增，
    // 纯布局 + 一个 --dim 字色，零群青。
    // 又多一条：`.ink-filter-summary`（人话预览，截断 + --dim 字色，零群青）。
    // 再多一条：`.ink-filter-not`（「排除」组，只把那条竖线换成虚线——跟
    // 「或」组共用全部布局，**没有自己的配色**，正是这条断言要的样子）。
    expect(rules!.length, '应该有 10 条：.ink-filter-bar/bar-open/select/text/summary/count/waiting/or/or-label/not').toBe(10);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-filter-/g) ?? []).length,
      '有 .ink-filter- 出现在前缀扫描够不到的地方',
    ).toBe((rules!.join('').match(/\.ink-filter-/g) ?? []).length);
  });

  // task-4-brief 修复轮 1 · A：「收起来的是按钮，不是那个框」——正面钉住
  // 拆分之后两条规则各自该有什么，不能只靠上面的条数断言（条数对不代表
  // 边框/底色真的挪对了地方，比如两条规则内容对调也能让条数照样是 6）。
  it('.ink-filter-bar 本身（收起态套用的基础规则）不含边框/底色/内边距——那些是 .ink-filter-bar-open 专属的', () => {
    const m = bare.match(/\n\.ink-filter-bar\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-filter-bar 规则不见了').not.toBeNull();
    expect(m![1]).not.toMatch(/border:/);
    expect(m![1]).not.toMatch(/background:/);
    expect(m![1]).not.toMatch(/padding:/);
  });

  it('.ink-filter-bar-open：展开态才有的边框/底色/内边距——上限，展开态还得有框', () => {
    const m = bare.match(/\n\.ink-filter-bar-open\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-filter-bar-open 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/border:\s*1px solid var\(--rule\)/);
    expect(m![1]).toMatch(/background:\s*var\(--sheet\)/);
    expect(m![1]).toMatch(/padding:\s*8px 16px/);
  });
});

// 打卡条（Task 3：习惯打卡）：只在「今天」出现，是人自己做的事，不许有群青——
// 三件套照抄 .ink-batch-*/.ink-filter-*（本文件上面两条）：前缀扫描 + 条数
// 断言 + 全文件计数交叉核对，不手写清单。
describe('打卡条：.ink-habit-* 一个群青都不许有', () => {
  it('.ink-habit-* 规则块（打卡条 + 待打卡提示 + 行档收窄 + 编辑表单那个勾选框）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-habit-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-habit-* 规则块一条都没扫到').not.toBeNull();
    // 第三条（.ink-habit-streak-compact）是 task-5 新加的（行档下收窄间距）。
    // 第四条（.ink-habit-toggle）是「当成习惯」那个勾选框——`habit` 这个字段
    // 以前界面上根本没有入口，整套习惯功能只能靠手改 JSON 才用得上。
    expect(rules!.length, '应该有 4 条：.ink-habit-streak/.ink-habit-pending/.ink-habit-streak-compact/.ink-habit-toggle').toBe(4);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-habit-/g) ?? []).length,
      '有 .ink-habit- 出现在前缀扫描够不到的地方',
    ).toBe((rules!.join('').match(/\.ink-habit-/g) ?? []).length);
  });

  it('.ink-habit-streak 是浅底胶囊——正向断言，不是一条空规则', () => {
    const m = bare.match(/\n\.ink-habit-streak\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-habit-streak 规则不见了').not.toBeNull();
    expect(m![1]).toContain('--paper');
    expect(m![1]).toMatch(/(^|[^-])color:\s*var\(--ink-you\)/m);
  });
});

// 备注 markdown 渲染（Markdown.tsx）：跟打卡条同一条理由不许有群青——链接/
// 标题/代码块都是排版本身，不是 AI 产出的新信息。final-review.md I4：这一族
// 一直没有守卫，把 .ink-notes-md a 的 color 从 inherit 改成 var(--ink-ai)，
// 51/51 照样全绿；对照组 .ink-habit-pending（上面那组）染群青立刻 1 failed，
// 证明前缀扫描这套写法本身是对的，只是没覆盖到 markdown 这一族。三件套照抄
// .ink-habit-*：前缀扫描 + 群青断言 + 全文件计数交叉核对。
describe('备注 markdown：.ink-notes-md 一个群青都不许有', () => {
  it('.ink-notes-md 规则块（这一批新加的九个 + I5 补的 img 一个）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-notes-md[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-notes-md 规则块一条都没扫到').not.toBeNull();
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-notes-md/g) ?? []).length,
      '有 .ink-notes-md 出现在前缀扫描够不到的地方',
    ).toBe((rules!.join('').match(/\.ink-notes-md/g) ?? []).length);
  });

  // 「解析了但没样式」这一批：markdown 一直是真的解析成 DOM 的，但表格没有
  // 边框、引用没有竖线、行内代码跟正文一个样——实测截图里那张表读出来是
  // 「项 口径 / 收入 财务」几个字挨着几个字，跟没解析没区别。下面四条是那次
  // 补的样式的正向断言。
  it('.ink-notes-md 表格有边框——没有的话渲染出来是几个字挨着几个字，读不出是张表', () => {
    const m = bare.match(/\n\.ink-notes-md th, \.ink-notes-md td\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md th/td 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/border:\s*1px solid var\(--rule\)/);
  });

  it('.ink-notes-md blockquote 有左边那条竖线——没有的话「> 引用」跟普通段落长得一模一样', () => {
    const m = bare.match(/\n\.ink-notes-md blockquote\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md blockquote 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/border-left:\s*2px solid var\(--rule\)/);
  });

  it('.ink-notes-md-table 自己横向滚——一张宽表不该把整张卡（进而整页）顶出横向滚动条，那是量测夹具一直在盯的缺陷', () => {
    const m = bare.match(/\n\.ink-notes-md-table\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md-table 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/overflow-x:\s*auto/);
  });

  it('GFM 任务列表不画圆点——勾选框本身就是记号，再加一个圆点是两个记号说同一件事', () => {
    const m = bare.match(/\n\.ink-notes-md \.task-list-item\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md .task-list-item 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/list-style:\s*none/);
  });

  it('.ink-notes-md a：链接色是石墨黑（inherit），不是群青——正向断言，不是一条空规则', () => {
    const m = bare.match(/\.ink-notes-md a\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md a 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/color:\s*inherit/);
  });

  // final-review.md I5：真 Chrome 实测长 URL / 大图会撑破卡片和视口（对照组
  // .ink-note-text 那条早年就踩过同一个坑，见那条注释）。这里补两条正向断言，
  // 不是等着变异测试逼出来——上面那份规则清单里如果这两行被删掉，第一条
  // 前缀扫描测不出来（删掉声明不等于染群青），得靠这两条单独钉住。
  it('.ink-notes-md：长 URL 不撑破卡片——overflow-wrap: anywhere，不是 break-word', () => {
    const m = bare.match(/\.ink-notes-md\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('.ink-notes-md img：不撑破卡片——max-width: 100%', () => {
    const m = bare.match(/\.ink-notes-md img\s*\{([^}]*)\}/);
    expect(m, '.ink-notes-md img 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/max-width:\s*100%/);
  });
});

// 附件（Task 3：拖放区 + 列表）：拖放高亮、附件列表都是人这一侧的东西
// （拖文件是人的动作，不是 AI 产出），一个群青都不许有——三件套照抄
// .ink-batch-*/.ink-filter-*：前缀扫描 + 条数断言 + 全文件计数交叉核对。
describe('附件：.ink-attach-* 一个群青都不许有', () => {
  it('.ink-attach-* 规则块（拖放区 + 列表）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-attach-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-attach-* 规则块一条都没扫到').not.toBeNull();
    // 10 条：box / box-over / zone / list / item / name / open+delete（共用
    // 点击目标那条规则块，逗号并列——见 .ink-cal-weekdays,.ink-cal-grid 那条
    // 先例，正则的 [^{}]* 跨得过逗号和换行，两个选择器算一次匹配）/ open 自己
    // 的下划线 / delete 自己的按钮重置 / offline（task-3-brief：离线时替掉
    // 「打开」链接的提示文字，9 条变 10 条）。
    // 图片缩略图那一批：10 条变 12 条——`.ink-attach-thumb`（外层链接，
    // 只管不参与 flex 伸缩）和 `.ink-attach-thumb img`（定高、object-fit、
    // 边框）各一条。两条都是纯尺寸/边框，零携色属性。
    expect(rules!.length, '应该有 12 条：.ink-attach-box/box-over/zone/list/item/name/open+delete/open/delete/offline/thumb/thumb img').toBe(12);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-attach-/g) ?? []).length,
      '有 .ink-attach- 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
    ).toBe((rules!.join('').match(/\.ink-attach-/g) ?? []).length);
  });

  it('拖放高亮用 --rule，不借群青——跟 .ink-grid-section-over（卡片拖拽悬停高亮）同一条规矩', () => {
    const m = bare.match(/\n\.ink-attach-box-over\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-attach-box-over 规则不见了').not.toBeNull();
    expect(m![1]).toContain('--rule');
  });

  it('「打开」「删除」点击目标够 24px——12px 字号本身够不到，跟 .ink-nav-tag/.ink-trash-btn 同一条教训', () => {
    const m = bare.match(/\n\.ink-attach-open,[\s\S]*?\{([^}]*)\}/);
    expect(m, '.ink-attach-open/.ink-attach-delete 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/min-width:\s*24px/);
  });

  it('文件名截断用 ellipsis，不撑破卡片', () => {
    const m = bare.match(/\n\.ink-attach-name\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-attach-name 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/overflow:\s*hidden/);
    expect(m![1]).toMatch(/text-overflow:\s*ellipsis/);
  });

  // task-3-brief：离线时替掉「打开」链接的提示——正向断言，不是一条空规则；
  // 顺带钉住它不是可点的样子（没有下划线），跟 .ink-attach-open 区分开。
  it('.ink-attach-offline：离线提示走 --dim，不是下划线链接的样子', () => {
    const m = bare.match(/\n\.ink-attach-offline\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-attach-offline 规则不见了').not.toBeNull();
    expect(m![1]).toContain('--dim');
    expect(m![1]).not.toMatch(/text-decoration/);
  });
});

// 任务行（Task 1：更密的那一档，`TaskRow.tsx`）：勾选圈、到期 chip、标签都是
// 人这一侧的东西——勾选是人自己点出来的完成状态，到期是时间算出来的，一个
// 群青都不许有。三件套照抄 .ink-attach-*/.ink-batch-*：前缀扫描 + 条数断言 +
// 全文件计数交叉核对，不手写清单（.ink-cal-weekday 那起事故的教训）。
describe('任务行：.ink-trow-* 一个群青都不许有（.ink-trow-proposal 是唯一允许的例外，见下面单独那条）', () => {
  it('.ink-trow-* 规则块（勾选圈/行体/标题/到期/标签/子项数/更多/选中/待决建议/抓手/菜单/菜单里的按钮/铃铛/图钉/层级/可拖拽留白/AI 到期级联修复）一个群青都不许有（除了 .ink-trow-proposal 和 .ink-trow-due.ink-time-ai）', () => {
    const rules = bare.match(/\n\.ink-trow-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-trow-* 规则块一条都没扫到').not.toBeNull();
    // 23 条：check / check-done / select / open / open-compact / title /
    // title-done / meta / meta .ink-pri-flag / due / due.ink-time-ai /
    // due-overdue / remind / tags / subcount / more / selected / proposal /
    // handle / handle-hidden / menu / menu .ink-move-btn / draggable——
    // select/selected/proposal 是 task-2 修复轮 1 新加的（批量选中框、
    // 选中态、待决建议记号），handle/menu 是 task-5 新加的（排序抓手、
    // 收进「更多」的上下移小面板），menu .ink-move-btn 是 task-5 修复轮 1 ·
    // I-1 补的（菜单里那两颗按钮的 24px 高度 + 视觉重置），open-compact 是
    // task-3-brief 修复轮 1 · C-2 新加的（看板紧凑排版：标题独占一行），
    // remind 是整分支审查 C1 新加的（行上的铃铛），draggable 是整分支审查
    // D2 新加的（28px 抓手位只在这一行可能有抓手时才留），due.ink-time-ai
    // 是整分支审查修复轮追加的（.ink-trow-due 和 .ink-time-ai 特异度相同、
    // 源码顺序更靠后的 .ink-trow-due 一直赢，AI 到期的群青从落地那天起
    // 没有真的画出来过——补一条特异度更高的复合选择器，见下面单独那条正向
    // 断言，以及 .ink-trow-due 规则块上方 theme.css 里的长注释），
    // handle-hidden 是 task-3-brief 复审修复轮 1 · I4 新加的（抓手常驻挂进
    // DOM 之后，没悬停/没聚焦时靠这条视觉藏起来，键盘 Tab 依然能停）。
    // pin / parent / kids 是这一轮新加的（行档补上卡片一直有的置顶图钉和两个
    // 层级记号——同一条任务换个密度不该少信息）：23 → 26。pin 单独一条而不是
    // 并进下面那条分组规则，是因为那条规则的注释写的是「三个记号」，再塞一个
    // 进去，解释就跟选择器对不上了。
    // **remind 那一条现在是三个选择器共用**（`.ink-trow-remind, .ink-trow-waiting,
    // .ink-trow-repeat`）——行上的沙漏（在等谁）和循环箭头（会重复）跟铃铛
    // 同一档字号、同一个 grayscale 处理，共用一条规则，所以条数还是 23、
    // 那一条照样被这个循环扫到（正则的 `[^{}]*` 跨得过逗号和换行）。
    // current 是详情面板那一轮新加的（列表里被打开的那一行标一道墨线，见
    // theme.css 里 .ink-trow-current 的注释）：26 → 27。它上的是 --ink-you
    // 不是群青，所以照样在下面那个「一个群青都不许有」的循环射程里。
    // start 是「还没到开始时间」那枚 chip：27 → 28。它声明跟 `.ink-trow-due`
    // 一模一样却没并进那条规则，理由写在 theme.css 那边（上面那条守卫按
    // `.ink-trow-due` 那条规则的起始位置逐字锚着它，加个逗号就把锚点弄没了）。
    // 同样上的是 --dim，照样在下面那个循环的射程里。
    // soon 是「快到期」那一档（仿 OmniFocus 的 Due Soon）：28 → 29。用
    // --overdue 兑淡的 color-mix，不新开色相、也不上群青，照样在下面那个
    // 循环的射程里。
    expect(rules!.length, '应该有 29 条').toBe(29);
    // .ink-trow-proposal 和 .ink-trow-due.ink-time-ai 是这一族里仅有的两条
    // 允许群青的规则（各自有单独的正向断言）——从「不许有」的循环里摘掉，
    // 不是整条规则松绑。
    //
    // 修复轮 1 · M-5：原来用 `r.startsWith('\n.ink-trow-proposal')`，前缀
    // 匹配挡不住 `.ink-trow-proposal-xxx` 这种以它为前缀的新选择器——那种
    // 规则会被误判成「就是 .ink-trow-proposal 本身」而被一起摘出白名单，
    // 哪怕它自己染了群青也测不出来。改成要求选择器在后面立刻是 `,`/`{`
    // （跳过空白），跟本文件其它地方 `\s*(?=[,{])` 那套精确匹配是同一条
    // 约定，不再是任意前缀都能蒙混过关——`.ink-trow-due.ink-time-ai` 同样
    // 照这个写法排除，不是简单的 `.startsWith`。
    const mustBeQuiet = rules!.filter((r) =>
      !/^\n\.ink-trow-proposal\s*[,{]/.test(r) && !/^\n\.ink-trow-due\.ink-time-ai\s*[,{]/.test(r));
    // 29 - 2 = 27（总数那条每加一档，这一条跟着加——排除的永远只有那两条）。
    expect(mustBeQuiet.length, '应该排除掉恰好 2 条（.ink-trow-proposal、.ink-trow-due.ink-time-ai）').toBe(27);
    for (const r of mustBeQuiet) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-trow-/g) ?? []).length,
      '有 .ink-trow- 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
    ).toBe((rules!.join('').match(/\.ink-trow-/g) ?? []).length);
  });

  it('.ink-trow-proposal：待决建议记号，走 --ink-ai——AI 产出内容正是它该标的东西（.ink-trow-* 里合法出现群青的两处之一，另一处是下面 .ink-trow-due.ink-time-ai）', () => {
    const m = bare.match(/\n\.ink-trow-proposal\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-proposal 规则不见了').not.toBeNull();
    expect(m![1]).toContain('--ink-ai');
  });

  /**
   * 整分支审查修复轮：AI 推断的到期时间要标群青（Task 1 修复轮的裁决），
   * 光靠「.ink-time-ai 这个 class 挂对了元素」这条断言测不出问题——
   * `.ink-trow-due { color: var(--dim) }` 和 `.ink-time-ai { color:
   * var(--ink-ai) }` 特异度都是 0,1,0，`.ink-trow-due` 定义在文件更靠后
   * 的位置，源码顺序赢，`--dim` 一直盖过群青。TaskRow.test.tsx 原有的三条
   * `.ink-time-ai` 断言只查 `classList.contains('ink-time-ai')`，jsdom 不
   * 做真实 CSS 层叠，测不出这层——三轮变异/复审都没抓住，是这个仓库总账里
   * 「断言查的层次比缺陷所在的层次浅了一层」那一类假绿。
   *
   * 下面两条断言分两层：① 文本层，正向确认新补的复合选择器规则本身存在、
   * 排在 .ink-trow-due 之后、群青确实写在这条规则里；② **真级联层**（这条
   * 才是这次修复真正的验收标准）——把 theme.css 原文注入 jsdom 的
   * `<style>`，渲染一个同时带 `ink-trow-due ink-time-ai` 两个 class 的元素，
   * 读 `getComputedStyle` 算出来的 `color`。jsdom 不解析 `var()`，但它会
   * 老实告诉你「哪条声明赢了」——这条测的不是「规则写没写」，是「规则
   * 有没有真的生效」，唯一能守住「以后有人在 .ink-trow-due.ink-time-ai
   * 后面又加一条同特异度规则」这类新变体的写法。这个文件按扩展名本该落进
   * vitest.config.ts 的 node 档（没有 window/document），用文件顶部的
   * `@vitest-environment jsdom` pragma 单独切到 jsdom——跟 density.test.ts/
   * keymap.test.ts 同一个理由，不新开一个文件。
   */
  it('.ink-trow-due.ink-time-ai：复合选择器规则本身存在，排在 .ink-trow-due 之后，写了 --ink-ai（文本层）', () => {
    const dueIdx = bare.indexOf('\n.ink-trow-due {');
    const aiDueIdx = bare.indexOf('\n.ink-trow-due.ink-time-ai');
    expect(dueIdx, '.ink-trow-due 规则不见了').toBeGreaterThanOrEqual(0);
    expect(aiDueIdx, '.ink-trow-due.ink-time-ai 规则不见了').toBeGreaterThanOrEqual(0);
    // 变异验证锚点：把这条复合规则挪到 .ink-trow-due 前面——特异度虽然还是
    // 更高、级联层那条测试依然会绿（特异度不看顺序），但这条文本层断言
    // 单独钉住「排在后面」这件事本身，双保险，不靠单一断言扛。
    expect(aiDueIdx, '.ink-trow-due.ink-time-ai 应该排在 .ink-trow-due 之后').toBeGreaterThan(dueIdx);
    const m = bare.match(/\n\.ink-trow-due\.ink-time-ai\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-due.ink-time-ai 规则块本身不见了').not.toBeNull();
    expect(m![1]).toContain('--ink-ai');
  });

  it('.ink-trow-due.ink-time-ai：真实级联算出来的赢家是 --ink-ai，不是 --dim（真级联层，这条是整条修复唯一的验收标准）', () => {
    const style = document.createElement('style');
    // 注入原文 css（带注释），不是 bare——真实浏览器/jsdom 的 CSS 解析器
    // 自己会跳过注释，这里不需要像正则匹配那样手动剥一遍。
    style.textContent = css;
    document.head.appendChild(style);
    const el = document.createElement('span');
    el.className = 'ink-trow-due ink-time-ai';
    document.body.appendChild(el);
    try {
      // 变异验证锚点（这次修复的唯一验收标准）：把 .ink-trow-due.ink-time-ai
      // 这条复合选择器规则删掉、退回今天这个坏状态（裸的 .ink-time-ai 单独
      // 一条规则）——jsdom 算出来的级联赢家会变回 var(--dim)，这条断言必须红。
      expect(getComputedStyle(el).color).toBe('var(--ink-ai)');
    } finally {
      document.head.removeChild(style);
      document.body.removeChild(el);
    }
  });

  it('.ink-trow-selected：批量选中态不借群青——跟 .ink-task-card-selected 同一条视觉语言（浅底 + --rule 描边）', () => {
    const m = bare.match(/\n\.ink-trow-selected\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-selected 规则不见了').not.toBeNull();
    expect(m![1]).not.toContain('--ink-ai');
    expect(m![1]).toContain('--rule');
  });

  it('.ink-trow-select：批量选中框（原生 checkbox）不借群青，点击目标可用', () => {
    const m = bare.match(/\n\.ink-trow-select\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-select 规则不见了').not.toBeNull();
    expect(m![1]).not.toContain('--ink-ai');
    expect(m![1]).toMatch(/cursor:\s*pointer/);
  });

  it('.ink-trow：行容器本身（没有连字符后缀，前缀扫描够不到）也不含群青', () => {
    const m = bare.match(/\n\.ink-trow\s*(?=[,{])[^{}/]*\{[^}]*\}/);
    expect(m, '.ink-trow 规则不见了').not.toBeNull();
    expect(m![0].toUpperCase()).not.toContain('#2E3ED4');
    expect(m![0]).not.toContain('--ink-ai');
  });

  // 修复轮 1 · M-1，整分支审查 D2 收窄：以前 .ink-trow 自己无条件带 28px
  // 左内边距，六个没有抓手的视图（全部/接下来/已完成/搜索/清单/标签）里
  // 这段留白恒空，分组标题顶格、下面每一行的圆圈却缩进 28px——图上那条
  // 错位很明显。现在 .ink-trow 自己只有普通的 4px，28px 收进
  // .ink-trow-draggable 这个只在「这一行可能有抓手」时才加的修饰类，见下面
  // 单独那条。
  it('.ink-trow：自己只有普通的 4px 内边距，不再无条件带 28px 抓手位', () => {
    const m = bare.match(/\n\.ink-trow\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow 规则不见了').not.toBeNull();
    // 变异验证锚点：把 28px 挪回 .ink-trow 本体——这条会红。
    expect(m![1]).not.toMatch(/28px/);
    expect(m![1]).toMatch(/padding:\s*4px\s*;/);
  });

  // 整分支审查 D2：28px 抓手位只在这一行可能有抓手时才留（`TaskRow.tsx`
  // 只有 `drag` prop 给了才加这个 class，`drag` 只在 `onDropTo` 或「今天」
  // 时才给）——上限断言在 TaskRow.test.tsx（有抓手的视图留着，没抓手的
  // 六个不留），这里只守 CSS 这一半：这条规则确实存在、确实是 28px。
  it('.ink-trow-draggable：只在这一行可能有抓手时才加的 28px 抓手位', () => {
    const m = bare.match(/\n\.ink-trow-draggable\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-draggable 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/padding-left:\s*28px/);
  });

  // 修复轮 1 · M-2：原来只给了 min-width，跟 .ink-trow-check/.ink-trow-more
  // （都是 24×24）不一致。
  it('.ink-trow-handle：点击目标够 24px（修复轮 1 · M-2）', () => {
    const m = bare.match(/\n\.ink-trow-handle\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-handle 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/min-width:\s*24px/);
  });

  // 修复轮 1 · I-1：.ink-move-btn 那条全局规则只给了 min-width（TaskCard.tsx
  // 上面注释写得清楚，那 28px 是给 antd size="small" 按钮补的，高度是 antd
  // 自己 24px 高带来的）。这两颗原生 <button> 需要自己补 24px 高度下限，
  // 还要去掉 UA 默认的灰色按钮外观（border/background），量测夹具够不到
  // 这个悬停+展开才存在的东西。
  it('.ink-trow-menu .ink-move-btn：24px 高度 + 去掉原生 UA 按钮外观（修复轮 1 · I-1）', () => {
    const m = bare.match(/\n\.ink-trow-menu \.ink-move-btn\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-menu .ink-move-btn 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/border:\s*0/);
    expect(m![1]).toMatch(/background:\s*none/);
  });

  it('.ink-trow-check：勾选圈点击目标够 24px', () => {
    const m = bare.match(/\n\.ink-trow-check\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-check 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
    expect(m![1]).toMatch(/min-width:\s*24px/);
  });

  it('.ink-trow-due-overdue：过期红用 --overdue，不借群青——跟 .ink-overdue-mark 同一条规矩', () => {
    const m = bare.match(/\n\.ink-trow-due-overdue\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-due-overdue 规则不见了').not.toBeNull();
    expect(m![1]).toContain('--overdue');
  });

  // 整分支审查 C1：铃铛不借群青——群青那份配额已经批给了 .ink-trow-proposal，
  // 铃铛不在名单里。
  //
  // ⚠️ **这条断言的标题以前写的是「铃铛走 --ink-you」，那半是假绿**：这个 span
  // 里只有一个 🔔（U+1F514，TaskRow.tsx），彩色 emoji 字形自带颜色，`color` 对它
  // 一个像素都改不动，后来加的 `filter: grayscale(1)` 更是把任何颜色一并抽成灰。
  // 所以 `--ink-you` 那条现在真正守住的只有「没写成群青」，守不住「铃铛是这个色」。
  // 保留它 + 一并把 grayscale 钉上：删掉 filter 的话铃铛会变回整个界面唯一一块
  // 饱和黄（「两种墨水」之外的第三种颜色），那才是这条规则实际在防的事。
  it('.ink-trow-remind：不借群青（--ink-you 这条只管这个），emoji 字形靠 grayscale 抽成墨色，字号不许压到 11px 以下', () => {
    const m = bare.match(/\n\.ink-trow-remind\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-remind 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/(^|[^-])color:\s*var\(--ink-you\)/m);
    expect(m![1]).toMatch(/filter:\s*grayscale\(1\)/);
    expect(m![1]).toMatch(/font-size:\s*11px/);
  });

  // 修复轮 1 · M-4：11px 是全站字号下限（.ink-hint/.ink-cal-tasktitle 那条
  // 教训），measure-ui.mjs 那道真浏览器防线够不到这个还没接进任何视图的
  // 组件，.ink-cal-tasktitle 那条专门断言这批也没照抄——补上，照抄同一个写法。
  it('.ink-trow-due：字号不许压到 11px 以下', () => {
    const m = bare.match(/\n\.ink-trow-due\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-due 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/font-size:\s*11px/);
  });

  it('.ink-trow-subcount：字号不许压到 11px 以下', () => {
    const m = bare.match(/\n\.ink-trow-subcount\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-subcount 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/font-size:\s*11px/);
  });

  // 修复轮 1 · M-7：.ink-pri-flag 自带的 margin-right: 5px 是给 TaskCard 里
  // inline 排布用的，在 .ink-trow-meta 这个 flex 容器（gap: 8px）里会叠加
  // 出第二种间距，这条规则把它归零。
  it('.ink-trow-meta .ink-pri-flag：归零卡片带来的 margin-right，不跟 flex 的 gap 叠加', () => {
    const m = bare.match(/\n\.ink-trow-meta \.ink-pri-flag\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-meta .ink-pri-flag 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/margin-right:\s*0/);
  });

  it('.ink-trow-title-done：已完成打删除线——正向断言，不是一条空规则', () => {
    const m = bare.match(/\n\.ink-trow-title-done\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-title-done 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/text-decoration:\s*line-through/);
  });

  it('.ink-trow-title：标题超长时截断——ellipsis + nowrap，跟 .ink-cal-tasktitle 同一套写法', () => {
    const m = bare.match(/\n\.ink-trow-title\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-trow-title 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/overflow:\s*hidden/);
    expect(m![1]).toMatch(/text-overflow:\s*ellipsis/);
    expect(m![1]).toMatch(/white-space:\s*nowrap/);
  });
});

// 密度开关（task-2）：人这一侧的控件，不许借群青——三件套照抄上面
// .ink-trow-* 那组：前缀扫描 + 条数断言 + 全文件计数交叉核对。
describe('密度开关：.ink-density-* 一个群青都不许有', () => {
  it('.ink-density-* 规则块（switch/btn/btn 分隔线/btn-active）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-density-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-density-* 规则块一条都没扫到').not.toBeNull();
    // 4 条：switch / btn / btn + btn（分隔线）/ btn-active。
    expect(rules!.length, '应该有 4 条').toBe(4);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-density-/g) ?? []).length,
      '有 .ink-density- 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
    ).toBe((rules!.join('').match(/\.ink-density-/g) ?? []).length);
  });

  it('.ink-density-btn-active：选中档用 --ink-you 填色，不是群青——跟 .ink-trow-check-done 同一条视觉语言', () => {
    const m = bare.match(/\n\.ink-density-btn-active\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-density-btn-active 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--ink-you\)/);
  });

  it('.ink-density-btn：点击目标够 24px', () => {
    const m = bare.match(/\n\.ink-density-btn\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-density-btn 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });
});

// 「开始专注」被锁住时外面那层 span（FocusTimer.tsx）。照抄上面各族的四件套：
// 前缀扫描 + 条数断言 + 群青检查 + 全文件计数交叉核对。
describe('.ink-focus-*：被别的卡占着锁时那句解释要够得着', () => {
  it('.ink-focus-* 规则块（休息标签 + span 自己 + 里面那颗按钮）一个群青都不许有', () => {
    const rules = bare.match(/\n\.ink-focus-[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-focus-* 规则块一条都没扫到').not.toBeNull();
    // 3 条：.ink-focus-tag（计时器前面那个小标签：「休息」/「正计时」）/ .ink-focus-blocked /
    // .ink-focus-blocked > .ant-btn。
    expect(rules!.length, '应该有 3 条：.ink-focus-tag、.ink-focus-blocked 和 .ink-focus-blocked > .ant-btn').toBe(3);
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    expect(
      (bare.match(/\.ink-focus-/g) ?? []).length,
      '有 .ink-focus- 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
    ).toBe((rules!.join('').match(/\.ink-focus-/g) ?? []).length);
  });

  it('里面那颗按钮的指针事件关掉——这是那句 title 能不能显示的唯一依据', () => {
    // 实测（CDP `elementFromPoint` 打在按钮正中）：不关的话命中的仍然是那颗
    // disabled 的按钮，tooltip 显不显示就回到「浏览器怎么对待禁用控件」那条
    // 靠不住的路上；关掉之后命中的是外层 span，一个普通元素，title 必然显示。
    // 这一条没了，FocusTimer 那边的 span 还在、title 还在、测试还绿，而那句话
    // 在真浏览器里重新变回一次都不出现——正是它要防的那种假绿。
    const m = bare.match(/\n\.ink-focus-blocked\s*>\s*\.ant-btn\s*\{([^}]*)\}/);
    expect(m, '.ink-focus-blocked > .ant-btn 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/pointer-events:\s*none/);
  });

  it('span 自己补回 not-allowed 光标——指针事件关掉之后 antd 给禁用按钮设的那个失效了', () => {
    const m = bare.match(/\n\.ink-focus-blocked\s*(?=[,{])[^{}/]*\{([^}]*)\}/);
    expect(m, '.ink-focus-blocked 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/cursor:\s*not-allowed/);
  });
});

/**
 * 窄屏下的清单侧栏。
 *
 * **这一段原来钉的是「视图导航在 767px 以下摊成三列」**，那条规则已经删了：
 * 它是为「侧栏占着手机的文档流」那个形状写的（竖着铺开吃掉 660px，第一张任务卡
 * 落在折叠线以下，摊成三列能省回 200px）。现在侧栏在窄屏整条收进抽屉
 * （`components/NavShell.tsx`），任务列表就是第一屏本身，那 200px 不用再从
 * 导航身上省；而抽屉只有 296px 宽，三列摊下来一列不到 90px，「收件箱 2」被
 * 截成「收件...」——省下来的空间没人要了，代价倒是照付。
 *
 * 换成钉现在这个形状：抽屉的样式在、进抽屉那颗按钮点得着、三列那条别偷偷回来。
 */
describe('窄屏侧栏：收进抽屉，不摊成三列', () => {
  it('抽屉 body 是竖排 flex——侧栏那棵树靠它撑满高度', () => {
    const m = bare.match(/\n\.ink-nav-drawer \.ant-drawer-body\s*\{([^}]*)\}/);
    expect(m, '.ink-nav-drawer .ant-drawer-body 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/flex-direction:\s*column/);
  });

  it('「打开清单侧栏」那颗有 24px 以上的点击目标——手机上它是进导航的唯一入口', () => {
    const m = bare.match(/\n\.ink-view-nav\s*\{([^}]*)\}/);
    expect(m, '.ink-view-nav 规则不见了').not.toBeNull();
    const w = m![1].match(/width:\s*(\d+)px/);
    const h = m![1].match(/height:\s*(\d+)px/);
    expect(Number(w?.[1]), '.ink-view-nav 没写死宽度').toBeGreaterThanOrEqual(24);
    expect(Number(h?.[1]), '.ink-view-nav 没写死高度').toBeGreaterThanOrEqual(24);
  });

  it('三列那条别回来——抽屉里一列不到 90px，导航项会被截成省略号', () => {
    expect(bare).not.toMatch(/\.ink-nav-views\s*\{[^}]*grid-template-columns/);
  });
  it('用的是修饰类，不是 :first-of-type 那种认位置的写法', () => {
    // `:first-of-type` 认的是标签名（<ul>），谁往 .ink-nav 里、视图列表前面插进
    // 任何一个 <ul>，三列就悄悄套到清单/标签那两份名字不可控的列表上——只在窄屏、
    // 只在视觉上塌，没有任何测试拦得住。这条钉住「别再退回那种写法」。
    expect(bare).not.toMatch(/\.ink-nav-list:first-of-type/);
  });
});

/**
 * 原生表单控件的选中色。
 *
 * 不写 `accent-color` 的话浏览器给的是系统强调色（Windows 上是一块亮蓝）——
 * 纪念日的「每年」、日历的五个显示开关都是裸的 `<input type=checkbox>`，
 * 勾上之后屏幕上凭空多出一块比群青还艳的蓝。这不只是不好看：**群青在这个
 * 界面里是配给制**，只标 AI 产出，而一块更抢眼的蓝会让那条约定失效。
 */
describe('body：原生控件的选中色落在石墨黑上', () => {
  it('body 上写死了 accent-color，不吃系统强调色', () => {
    const m = bare.match(/\nbody\s*\{([^}]*)\}/);
    expect(m, 'body 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/accent-color:\s*var\(--ink-you\)/);
  });

  it('**不是群青**——群青是配给给 AI 产出的，这些开关是人自己按的', () => {
    const m = bare.match(/\nbody\s*\{([^}]*)\}/);
    expect(m![1]).not.toMatch(/accent-color:\s*var\(--ink-ai\)/);
  });
});

/**
 * 「安排任务」栏（`SchedulePanel`，日历右边那一条）。
 *
 * 照 `.ink-cal-*`/`.ink-pri-flag` 那套写：**前缀扫描 + 条数断言 + 全文件交叉
 * 核对**，不手抄清单——以后新增一条 `.ink-sched-*` 忘了守，条数会跟着变，
 * 直接红。
 *
 * 这一族一个群青都不许有：这一栏列的是**他自己写下的、还没排上日期的任务**，
 * AI 一个字都没参与，栏本身也不是 AI 的产出。群青在这个界面里是配给制。
 */
describe('.ink-sched-*：安排任务栏，零群青', () => {
  it('这一族的规则块一个群青都不许有，而且都在顶格扫描够得到的地方', () => {
    const rules = bare.match(/\n\.ink-sched[\w-]*[^{}]*\{[^}]*\}/g);
    expect(rules, '.ink-sched* 规则块一条都没扫到').not.toBeNull();
    for (const r of rules!) {
      expect(r.toUpperCase(), r).not.toContain('#2E3ED4');
      expect(r, r).not.toContain('--ink-ai');
    }
    // 全文件交叉核对：`\n\.ink-sched` 只认顶格、紧跟换行的选择器，一条祖先
    // 选择器打头、或者缩进在 @media 里的规则会整条隐形，条数断言照样全绿、
    // 群青照样塞得进去。两个数不相等就说明有漏网的。
    expect(
      (bare.match(/\.ink-sched/g) ?? []).length,
      '有 .ink-sched 出现在前缀扫描够不到的地方（祖先选择器打头 / 缩进在 @media 里）',
    ).toBe((rules!.join('').match(/\.ink-sched/g) ?? []).length);
  });

  it('那一行任务看得出是能拿起来的——grab 光标，不是普通一行字', () => {
    const m = bare.match(/\n\.ink-sched-item\s*\{([^}]*)\}/);
    expect(m, '.ink-sched-item 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/cursor:\s*grab/);
  });

  it('页签选中态走 --ink-you 填色，跟密度开关同一条视觉语言——不借群青', () => {
    const m = bare.match(/\n\.ink-sched-tab-active\s*\{([^}]*)\}/);
    expect(m, '.ink-sched-tab-active 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--ink-you\)/);
  });

  it('↑/↓ 两颗兜住 24px 点击目标下限——它们是这一栏里最小的控件', () => {
    const m = bare.match(/\n\.ink-sched-move\s*\{([^}]*)\}/);
    expect(m, '.ink-sched-move 规则不见了').not.toBeNull();
    expect(m![1]).toMatch(/min-width:\s*24px/);
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });
});

// 「写在基础规则前面就不生效」这种事没法靠读代码发现——两条同特异度，
// 谁在后面谁赢。实测过：`.ink-notes-md-inherit` 一开始写在 `.ink-notes-md`
// 上面，收件箱那条原话照样是 --dim（截图和 getComputedStyle 都证实了）。
it('.ink-notes-md-inherit 必须排在 .ink-notes-md 后面——同特异度靠源码顺序决胜，写在前面等于这条规则不存在', () => {
  const base = bare.indexOf('\n.ink-notes-md {');
  const variant = bare.indexOf('\n.ink-notes-md-inherit {');
  expect(base, '.ink-notes-md 基础规则不见了').toBeGreaterThan(-1);
  expect(variant, '.ink-notes-md-inherit 不见了').toBeGreaterThan(-1);
  expect(variant, '-inherit 排到基础规则前面去了，它会被覆盖掉').toBeGreaterThan(base);
});

/**
 * 实测界面审查（80 屏 × 5 个分辨率）修掉的那几条，各钉一条断言。
 * 每一条都对应一个量出来的数字，不是凭感觉加的规则。
 */
/**
 * **调色板里那几个「次要文字」色的对比度。**
 *
 * 这一族是量出来的：起无头 Chrome、把 14 屏 × 宽窄两档全渲染一遍，逐个文本
 * 节点按 WCAG 算它对**自己实际背景**的比值（半透明的前景和背景都要先混合，
 * 不混的话浅灰会被算得比实际好看）。当时抓到 11 类不达标，最差 2.40:1。
 *
 * 成因值得记下来：`--dim` 当初是照**页面底**（#EFEDE8）调的，在那儿是 4.90、
 * 勉强过线；而侧栏那层底色更深（rgb(227,225,220)），同一个色在那儿只有 4.39。
 * **一个颜色 token 的对比度不是它自己的属性，是它跟每一个会用到它的面之间的
 * 关系**——只在一个面上量过就定下来，另一个面上就悄悄不合格了。
 *
 * 这里不重跑浏览器（那要几分钟），只钉住量完之后定下来的那几个值：改色的人
 * 会在这儿看到「这些数字是量出来的」，而不是随手调深调浅。真要重量，脚本在
 * scratchpad 的 `a11y.mjs`，判据和门槛都写在里面。
 */
describe('调色板：次要文字色的对比度是量过的', () => {
  /** WCAG 相对亮度 → 对比度。跟 `a11y.mjs` 里那份同一个算法。 */
  const ratio = (hex: string, bg: [number, number, number]): number => {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const [a, b2] = [lum(rgb), lum(bg)];
    return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
  };
  /** 这个应用里三种会承载次要文字的底色。 */
  const PAGE: [number, number, number] = [239, 237, 232];
  const CARD: [number, number, number] = [250, 248, 245];
  const RAIL: [number, number, number] = [227, 225, 220];

  const token = (name: string): string => {
    // 两个坑都踩过：
    // ① 模板字符串里要写 `\\s`——`\s` 在模板里退化成裸的 `s`，正则变成
    //    `--dim:s*(#…)` 永远匹配不上，而报出来的是「调色板里没有 --dim」。
    // ② **必须用 `bare`（剥掉注释的那份），不能用 `css`。** 上面那段注释里
    //    原样引着旧值（「`--pri-1: #8A9099` 只有 3.03:1」），拿 `css` 匹配会
    //    命中注释里那个**旧**色，于是守卫盯着的是一句历史记录，不是当前的值
    //    ——它当场报「--pri-1 只有 2.75:1」，而文件里真实的值早就改好了。
    const m = bare.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    expect(m, `调色板里没有 --${name}`).not.toBeNull();
    return m![1];
  };

  it('**`--dim` 在三个面上都过 4.5**——它当初只在页面底上量过，侧栏底上是 4.39，导航计数和农历那一行全压在线下', () => {
    const c = token('dim');
    for (const [name, bg] of [['页面', PAGE], ['卡片', CARD], ['侧栏', RAIL]] as const) {
      expect(ratio(c, bg), `--dim 在${name}底上只有 ${ratio(c, bg).toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * **滚动条滑块是个控件，门槛是 WCAG 1.4.11 的 3:1，不是正文那条 4.5。**
   *
   * 它原来用 `--rule`（画线的颜色）——纸上 1.34:1，几乎看不见。当时觉得没事，
   * 因为 `::-webkit-scrollbar-thumb:hover` 会换成 `--dim`；后来实测发现那一整块
   * webkit 伪元素在新 Chromium 上是死代码（`*` 上设了 `scrollbar-color` 就会
   * 让它整个被忽略），hover 那条根本不会执行，触摸屏更没有 hover。
   * 所以静止态那个颜色本身必须够——单开了 `--scrollbar`。
   *
   * 三种面一起验，跟 `--dim` 那条同一个理由：上一轮 `--dim` 就是只在纸和页上
   * 量过，侧栏底上 4.39 压线不过。
   */
  it('**`--scrollbar` 在三个面上都过 3:1**——它是控件不是文字，而且新浏览器上没有 hover 那条退路', () => {
    const c = token('scrollbar');
    for (const [name, bg] of [['页面', PAGE], ['卡片', CARD], ['侧栏', RAIL]] as const) {
      expect(ratio(c, bg), `--scrollbar 在${name}底上只有 ${ratio(c, bg).toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('**优先级三档在页面底和卡片底上都过 4.5**——12px 的字形按正文门槛算；三档只靠颜色区分，看不清等于这个字段白设了', () => {
    for (const n of ['pri-1', 'pri-2', 'pri-3']) {
      const c = token(n);
      for (const [name, bg] of [['页面', PAGE], ['卡片', CARD]] as const) {
        expect(ratio(c, bg), `--${n} 在${name}底上只有 ${ratio(c, bg).toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * **不许再往回写那种一次性的半透明墨色。** 那四处（导航的「＋」「⋯」、日历
   * 的周数和时刻）原来各写一遍 `color-mix(… 45%/35%, transparent)`，量出来
   * 2.40–3.26:1。它们要表达的「次要文字」这件事已经有一个 token 了。
   */
  it('这四处次要文字用的是 --dim，不是各写一份半透明墨色', () => {
    for (const sel of ['ink-nav-add', 'ink-nav-tag-act', 'ink-cal-wk', 'ink-cal-chiptime']) {
      const m = bare.match(new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`));
      expect(m, `没有 .${sel} 这条规则`).not.toBeNull();
      expect(m![1], `.${sel} 又写回半透明墨色了——它在自己那个底色上只有 2.40~3.26:1`)
        .toMatch(/color:\s*var\(--dim\)/);
    }
  });
});

describe('这一轮量出来的四条', () => {
  /**
   * **线描记号不许自己写死颜色。**
   *
   * `NavIcon` 画的是 `stroke="currentColor"` 的 svg——它读的是**这个 svg 自己的
   * `color`**。`.ink-nav-icon` 上一旦写死 `color`，外面那颗按钮的选中反白就传
   * 不进来。实测：竖栏选中项按钮底是墨色 rgb(33,31,29)、按钮 color 已正确反白
   * 成 rgb(250,248,245)，而图标 stroke 仍是 rgb(99,91,80) —— 1.6:1，看不见。
   *
   * 那条规则的注释当时就写着「颜色一律继承那一行的 color，自己不上色」，
   * 下一行却写了 `color: var(--dim)`。**注释和代码打架，代码赢了**，而没有
   * 任何测试盯着。这条把那句注释变成机械检查。
   */
  it('.ink-nav-icon 自己不写 color——写了外面按钮的选中反白就传不进来', () => {
    // `\n` 打头是为了只匹配顶格那条规则，不误命中 `.ink-nav-item .ink-nav-icon`。
    const m = bare.match(/\n\.ink-nav-icon\s*\{([^}]*)\}/);
    expect(m, '没有 .ink-nav-icon 这条规则').not.toBeNull();
    expect(m![1], '它必须继承那一行/那颗按钮的 color').not.toMatch(/(^|;)\s*color\s*:/);
  });

  it('侧栏那一行的记号才压 --dim（那一行的 color 恒是墨色，不压就跟名字一样重）', () => {
    expect(bare).toMatch(/\.ink-nav-item\s+\.ink-nav-icon\s*\{[^}]*color:\s*var\(--dim\)/);
    expect(bare).toMatch(/\.ink-nav-item\[aria-current='page'\]\s+\.ink-nav-icon\s*\{[^}]*color:\s*var\(--ink-you\)/);
  });

  /**
   * **两套语法不是并存的，新浏览器只认标准那套。**
   *
   * 这条上一版叫「两套语法都在」，还写着「同时写不冲突」——那是错的，实测
   * 推翻了：Chromium ≥121 只要在元素上看见非初始值的 `scrollbar-width`/
   * `scrollbar-color`，就整个忽略它身上的 `::-webkit-scrollbar*`。而 `*` 上
   * 两个都设了，所以在 Electron（Chromium 142）里，webkit 那一块连同它的
   * `:hover` 换深色**全是死代码**。
   *
   * 由此推出这条守卫真正要守的东西：**静止态那个颜色本身必须够对比**，因为
   * hover 那条在新浏览器上不会执行，触摸屏也没有 hover。`--rule` 只有
   * 1.34:1（滑块几乎看不见），所以单开了 `--scrollbar`。
   */
  it('滚动条滑块用 --scrollbar，不是画线的 --rule', () => {
    expect(bare, '标准属性那套没用 --scrollbar').toMatch(/scrollbar-color:\s*var\(--scrollbar\)/);
    expect(bare, 'webkit 那套（旧 WebView 才走）也得是同一个颜色')
      .toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--scrollbar\)/);
    expect(bare, '交角不处理的话 Chromium 会画一块浅灰方块').toMatch(/::-webkit-scrollbar-corner/);
    expect(bare, 'scrollbar-color 不该再指着 --rule').not.toMatch(/scrollbar-color:\s*var\(--rule\)/);
  });


  /**
   * **图表/列表那几屏不写死宽度上限。** 正文版心 `--measure`（38em）是有意的
   * 排版约束，任务卡用它是对的；而习惯统计、纪念日、专注统计画的是卡片、
   * 条目和数据格子，不是正文。它们原来各自写死 `max-width: 720px`，实测在
   * 1440px 的窗口下横向空掉 526~632px。
   */
  it('习惯/纪念日/专注三屏按可用宽度铺开，不写死 720px', () => {
    for (const sel of ['ink-hstat-root', 'ink-fstat-root', 'ink-cd-root']) {
      // 模板字符串里每一个反斜杠都要写两遍——`\n`/`\.`/`\s` 直接写会分别退化成
      // 真换行、裸的 `.`、裸的 `s`，正则就变成另一条永远匹配不上的东西。
      const m = bare.match(new RegExp(`\\n\\.${sel}\\s*\\{([^}]*)\\}`));
      expect(m, `没有 .${sel} 这条规则`).not.toBeNull();
      expect(m![1], `.${sel} 又写死像素宽度上限了`).not.toMatch(/max-width:\s*\d+px/);
    }
    // 习惯和纪念日改成了自动分列——不是简单地把上限删掉了事。
    expect(bare).toMatch(/\.ink-hstat-root\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill/);
    expect(bare).toMatch(/\.ink-cd-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill/);
  });
});

describe('界面审查：量出来的那几条别退回去', () => {
  /**
   * **窄屏那条横栏上的按钮不许被 flex 压扁。**
   *
   * 竖栏在 767px 以下躺平成一条横栏，上面 9 颗 36px 的按钮 + 记号 + 内边距 +
   * 间隙 ≈ 392px，在 375px 的屏上放不下。原来没拦着收缩，浏览器就把收缩量全
   * 摊给了外层那两个光杆按钮（「搜索」「设置」——另外七颗包在
   * `.ink-modrail-list` 这个有内容的嵌套 flex 里，压不动）。**实测**：
   *
   *   320px → 搜索/设置各 15px；375px → 各 18px；414px 及以上 → 36px
   *
   * 375px 是 iPhone SE / 12 mini 那一档，不是边角情况；而这两颗恰好是这条栏上
   * 最常按的。**它不表现为横向溢出**（`scrollWidth === clientWidth`，页面不
   * 横滚），所以只盯溢出的检查发现不了，是「点击目标够不够大」那一维量出来的。
   *
   * 三条缺一不可：`overflow-x` 让整条栏自己滚，`flex-shrink: 0` 让按钮保持
   * 原尺寸，记号也不许被压（它被压扁只是难看，但它一让位按钮就又开始挨压）。
   */
  it('窄屏横栏：按钮不许被压扁，整条栏自己横滚', () => {
    // 取那条媒体查询的整块。**不用正则跨行匹配到 `\n}`**：一个只在行首出现的
    // 右花括号很难用正则可靠地圈住，而且写错了会静默圈到别处去（这个文件顶上
    // 那段约定说的就是这类事）。用下标切，出错时下面的 `toBeNull` 会说话。
    const start = bare.indexOf('@media (max-width: 767px)');
    expect(start, '没有那条窄屏媒体查询').toBeGreaterThan(-1);
    const end = bare.indexOf('\n}', start);
    expect(end, '那条媒体查询没有收尾').toBeGreaterThan(start);
    const block = bare.slice(start, end);
    const rail = block.match(/\.ink-modrail\s*\{([^}]*)\}/);
    expect(rail, '窄屏里没有 .ink-modrail 规则').not.toBeNull();
    expect(rail![1], '栏不能横滚的话，放不下的按钮只能被压扁').toMatch(/overflow-x:\s*auto/);
    // **`flex-shrink: 0` 现在在媒体查询外面**：矮屏（横屏手机 812×375）上这条栏
    // 是竖着的，同一个 bug 换根轴照样发生——实测「搜索」「设置」各被压成 36×15。
    // 所以这里不再要求它出现在窄屏块里，只要求顶格那份有（下面单独一条守）。
    const btnTop = bare.slice(bare.indexOf('.ink-modrail-btn {'));
    expect(btnTop.slice(0, btnTop.indexOf('}')), '按钮没有 flex-shrink: 0，就会被摊掉宽度').toMatch(/flex-shrink:\s*0/);
    const mark = block.match(/\.ink-modrail-mark\s*\{([^}]*)\}/);
    expect(mark, '窄屏里没有 .ink-modrail-mark 规则').not.toBeNull();
    expect(mark![1]).toMatch(/flex-shrink:\s*0/);
  });

  it('按钮的基准尺寸还是 36×36——上面那条守的是「别被压小」，这条守的是「基准别被调小」', () => {
    const m = bare.match(/\.ink-modrail-btn\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/width:\s*36px/);
    expect(m![1]).toMatch(/height:\s*36px/);
  });

  /**
   * **认最后一条 `min-width`，不是「有没有出现过」。**
   *
   * 这条原来写的是 `toMatch(/min-width:\s*[\d.]+em/)`——只问这条规则里有没有
   * 出现过一个 em 的下限。而那条规则当时长这样：
   *
   * ```css
   * .ink-trow-title { min-width: 4.5em; flex: 1 1 auto; min-width: 0; … }
   * ```
   *
   * 同一条规则里声明两次，**后者胜出**，4.5em 从来没生效过。这条测试一直是
   * 绿的，它守的是一条死掉的声明。实测：一条标签很多的任务在 320px 下标题
   * 被挤到 38px（4.5em × 13px = 58.5px），三个字都放不下。
   *
   * 现在取**最后一条** `min-width` 来判——那才是级联真正用的那个值。
   */
  /**
   * **一条规则里同一个属性不许声明两次。**
   *
   * 这条是从上面那个 bug 推广出来的：`.ink-trow-title` 里写了两次 `min-width`
   * （`4.5em` 和 `0`），后者胜出，于是那条讲「4.5em 是最低限度」的整段注释、
   * 以及盯着它的那条测试，守的都是一条从未生效的声明——**而测试是绿的**。
   *
   * 重复声明本身不一定是错（有人拿它做降级兜底，比如先写一个老语法再写新的），
   * 但那种写法在这份手写样式表里一次都没有出现过。所以这里一刀切：出现即报，
   * 真有降级需求的那天再来放宽，那时也该在这儿留一句为什么。
   */
  it('整份样式表里，没有哪条规则把同一个属性声明两次——后者会悄悄盖掉前者', () => {
    const dupes: string[] = [];
    for (const m of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      // 选择器可能跨好几行（逗号分隔那种），取最后一行当报告用的名字就够。
      const lines = m[1].trim().split(/\r?\n/);
      const sel = lines[lines.length - 1].trim().slice(0, 60);
      const props = [...m[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((x) => x[1]);
      const seen = new Map<string, number>();
      for (const prop of props) seen.set(prop, (seen.get(prop) ?? 0) + 1);
      for (const [prop, n] of seen) if (n > 1) dupes.push(`${sel} 里 ${prop} 声明了 ${n} 次`);
    }
    expect(dupes, dupes.join(' ｜ ')).toEqual([]);
  });

  it('.ink-trow-title 生效的那条 min-width 是 em 下限——没有它，四象限在 390px 下标题宽度实测是 0（一个字都不显示）', () => {
    const m = bare.match(/\.ink-trow-title\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const all = [...m![1].matchAll(/min-width:\s*([^;]+);/g)].map((x) => x[1].trim());
    expect(all.length, '这条规则里一条 min-width 都没有').toBeGreaterThan(0);
    expect(all[all.length - 1], `生效的是最后一条 min-width（这里有 ${all.length} 条：${all.join(' / ')}），它得是 em 下限，不能是 0`)
      .toMatch(/^[\d.]+em$/);
  });

  it('.ink-trow-meta 可以被挤（flex 的收缩位不是 0），而且不许竖着码字', () => {
    const m = bare.match(/\.ink-trow-meta\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1], '元数据一寸不让的话，让位的就只能是标题').toMatch(/flex:\s*0\s+1\s+auto/);
    expect(m![1]).toMatch(/white-space:\s*nowrap/);
  });

  it('四象限窄屏拆成单列——2×2 在 390px 下每格只有 ~170px，任务行装不下', () => {
    // 锚死「@media 开花括号之后**紧接着**就是这条规则」——用 [^@]*? 惰性跨
    // 过去的话，它会一路咬到文件里那条顶格的 .ink-cells-2x2（媒体查询外面
    // 那份），断言就变成在检查一条根本没改的规则。
    const media = bare.match(/@media\s*\(max-width:\s*767px\)\s*\{\s*\.ink-cells-2x2\s*\{([^}]*)\}/);
    expect(media, '没有那条窄屏媒体查询').not.toBeNull();
    expect(media![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  /**
   * 「Ctrl+Enter 存下」在手机上是一条**做不到的指示**——那儿没有 Ctrl 键，而它
   * 旁边就是那颗按得到的按钮。
   *
   * 锚在 `.ink-kbd-hint` 上，不是 `.ink-hint`：后者是通用的小灰字，「AI 正在
   * 拆解……」也在用，整类藏掉会把一句真该看见的话一起藏了。
   */
  it('键盘提示在窄屏上藏掉——手机上没有 Ctrl 键', () => {
    const media = bare.match(/@media\s*\(max-width:\s*767px\)\s*\{\s*\.ink-kbd-hint\s*\{([^}]*)\}/);
    expect(media, '没有藏掉键盘提示的那条窄屏规则').not.toBeNull();
    expect(media![1]).toMatch(/display:\s*none/);
  });

  it('备注里的行内链接把可点区域撑到 24px（原来 19px）', () => {
    const m = bare.match(/\.ink-notes-md a\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/padding-block:\s*3px/);
    // 负外边距是配套的那一半：不写它，行高会跟着变，段落排版就动了
    expect(m![1], '撑了盒子却没抵掉它对行盒的影响').toMatch(/margin-block:\s*-3px/);
  });

  it('搜索框够 24px——它是弹层里唯一一个够不到线的（实测 23.x px）', () => {
    const m = bare.match(/\.ink-searchmodal-input\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/min-height:\s*24px/);
  });

  /**
   * 结果行和那句空提示的左内边距，得等于「盒子内边距 + 放大镜 + gap」——
   * 也就是让下面每一行的第一个字跟上面那句查询词落在同一条竖线上。
   * 实测（1280）：放大镜占 400~415，查询词从 425 起；原来结果标题在 400，
   * **比放大镜还靠左 5px**。
   *
   * 这条守的是那个**关系**，不是 41 这个数字：盒子的 16 或者 gap 的 10 谁被改了，
   * 这里当场红，而不是等下一轮实测再拿肉眼发现列又错开了。
   * （放大镜那 15px 是 antd 图标按字号渲染出来的，样式表里没有这个声明，
   * 只能作为常量写在这儿——实测值，改字号会失准，那时这条会红，正是要的。）
   */
  it('搜索弹层：结果标题和空提示的第一个字，跟查询词在同一条竖线上', () => {
    const box = declarationsFor(bare, '.ink-searchmodal-box');
    const padLeft = Number(box.match(/padding:\s*\d+(?:\.\d+)?px\s+(\d+)(?:\.\d+)?px/)?.[1]);
    const gap = Number(box.match(/gap:\s*(\d+)(?:\.\d+)?px/)?.[1]);
    expect(padLeft, '.ink-searchmodal-box 的左右内边距读不出来了').not.toBeNaN();
    expect(gap, '.ink-searchmodal-box 的 gap 读不出来了').not.toBeNaN();
    const ICON = 15; // 放大镜实测宽度（400~415）
    const want = padLeft + ICON + gap;
    for (const sel of ['.ink-searchmodal-hit', '.ink-searchmodal-empty']) {
      const got = Number(declarationsFor(bare, sel).match(/padding:[^;]*?\s(\d+)px\s*(?:;|$)/)?.[1]);
      expect(got, sel + ' 的左内边距读不出来了——四值 padding 的写法改了？').not.toBeNaN();
      expect(got, sel + ' 的第一个字跟查询词对不齐了：应该是 ' + want + '（' + padLeft + ' + 放大镜 ' + ICON + ' + gap ' + gap + '）').toBe(want);
    }
  });

  // `.ink-searchmodal-input:focus`（0,2,0）比全站那条 `:focus-visible`（0,1,0）
  // 更具体，一写 outline: none 就是把无障碍底线那条焦点环整个去掉。实测聚焦
  // 前后 outline / 下界线 / 阴影三项计算值一模一样——键盘走到这个框上没有任何
  // 提示。这份文件里另外三个同样写法的输入框都补了替代（quickadd/tag/nav-add），
  // 这条守的是「去掉了就得补上」，不是某一个具体颜色。
  it('搜索弹层把焦点环去掉了，就得自己补一条看得见的——盒子聚焦时下界线变色', () => {
    const off = bare.match(/\.ink-searchmodal-input:focus\s*\{([^}]*)\}/);
    expect(off, '.ink-searchmodal-input:focus 规则不见了——这条守卫的前提没了').not.toBeNull();
    // 前提还在：它确实把 outline 关掉了。关掉这一半没了的话，下面那半就不必要。
    expect(off![1]).toMatch(/outline:\s*none/);
    const on = bare.match(/\.ink-searchmodal-box:focus-within\s*\{([^}]*)\}/);
    expect(on, '把焦点环关掉了却没有任何替代——键盘落到搜索框上一点变化都没有').not.toBeNull();
    expect(on![1]).toMatch(/border-bottom-color:\s*var\(--ink-you\)/);
  });

  /**
   * **点击目标这一维，默认态扫不出来。**
   *
   * 上面那条链接的用例原来叫「全站扫下来它是唯一一类真的过小的点击目标」，
   * 那句话是错的——它只在**默认那一屏**成立。把批量选中打开、把推荐面板
   * 展开之后再扫，又冒出来两类：
   *
   * - `.ink-trow-select`：批量模式下每一行的勾选框，16×16，一屏 18 个
   * - `.ink-suggest-name`：推荐里的任务名按钮，横向 960px、纵向只有 19px
   *
   * 两处都是「点开才存在」的层。这两条守的不只是这两个数字，也是那句
   * 「要连点开之后的状态一起量」。
   */
  it('批量选中的勾选框跟同一行的完成圈一样大——两颗都是 24', () => {
    const box = (sel: string) => {
      const i = bare.indexOf('.' + sel + ' {');
      expect(i, sel + ' 这条规则不见了').toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf('}', i));
      const w = body.match(/(?:^|[;{\s])width:\s*(\d+)px/);
      const h = body.match(/(?:^|[;{\s])height:\s*(\d+)px/);
      expect(w, sel + ' 没写宽').not.toBeNull();
      expect(h, sel + ' 没写高').not.toBeNull();
      return [Number(w![1]), Number(h![1])];
    };
    // 从完成圈上现读，不写死 24：那颗要是哪天改了尺寸，这两颗还得一样大。
    const 完成圈 = box('ink-trow-check');
    const 勾选框 = box('ink-trow-select');
    expect(完成圈[0], '完成圈本身就掉到 24 以下了').toBeGreaterThanOrEqual(24);
    expect(勾选框, `同一行上两颗勾选控件不一样大：完成圈 ${完成圈}，勾选框 ${勾选框}`).toEqual(完成圈);
  });

  it('推荐里的任务名按钮纵向够 24——它横着有 960px，差的一直是高度', () => {
    const i = bare.indexOf('.ink-suggest-name {');
    expect(i, '.ink-suggest-name 这条规则不见了').toBeGreaterThan(-1);
    const body = bare.slice(i, bare.indexOf('}', i));
    const m = body.match(/min-height:\s*(\d+)px/);
    expect(m, '没有撑最小高度').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(24);
    // 撑的必须是 min-height 不是 padding：条目是 align-items:center 的一行，
    // 加内边距会把整条 .ink-suggest-item 顶高一截。
    expect(body, '用 padding 撑会连带把条目顶高').toMatch(/padding:\s*0/);
  });

  /**
   * **原生 `<select>` 的宽度是「最长那条选项」，而选项里装的是用户写的字。**
   *
   * 这两条下拉的选项分别是任务标题和清单名，长度都不受控，所以它们的固有
   * 宽度也没有上限。实测 375px 下：任务标题那条撑到 502px（外面 343px）、
   * 清单名那条撑到 409px，越出的部分被无声裁掉（`<select>` 的 UA 默认值就是
   * `overflow-x: clip`，不是这个仓库写的规则）——**页面
   * 不横滚**，只盯 `scrollWidth` 的检查一辈子发现不了。
   *
   * 只管这两条，不顺手把 `.ink-groupsort-select` / `.ink-cd-date` 一起加上：
   * 那两条的选项是固定字面量和一个日期，宽度本来就有界。
   */
  it('装用户文字的两条原生下拉都封了 max-width，长标题/长清单名撑不破外栏', () => {
    for (const sel of ['ink-list-select', 'ink-batch-list-select']) {
      const i = bare.indexOf('.' + sel + ' {');
      expect(i, sel + ' 这条规则不见了').toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf('}', i));
      expect(body, sel + ' 没封上限——一条长标题就能把它撑到比外栏还宽')
        .toMatch(/max-width:\s*100%/);
    }
  });

  /**
   * **`repeat(auto-fill, minmax(Npx, 1fr))` 里那个 N 必须包一层 `min(100%, N)`。**
   *
   * 不包的话，容器比 N 还窄时格子会直接撑出去——这不是理论，是 320px 屏上量到的：
   * `.ink-hstat-root` 用 `minmax(320px, 1fr)`，而那一屏的面板只有 288px，卡片右缘
   * 越出视口 16px。`.ink-year` 那条注释早就把这个配方写下来了（「不加的话一个
   * 230px 的 minmax 在比它还窄的容器里会溢出」），只是后来新加的三处没跟上。
   *
   * 宽容器上这一层是零成本：`min(100%, N)` 在容器够宽时就等于 N。
   */
  it('每一条 auto-fill 网格的下限都包了 min(100%, …)，窄容器上撑不出去', () => {
    // **对着 `bare` 匹配，不是 `css`。** 这个文件顶上那条规矩写得很死：带注释的
    // 原文里随手引一句反例（「auto-fill + minmax(340px, 1fr)」这种）就会把守卫
    // 弄红，而样式表本身是对的。上一版这儿写的是 `css`，只是碰巧没撞上——
    // theme.css 里那句反例恰好没带 `repeat(` 前缀。顺便：局部变量别再叫 `bare`，
    // 那会把模块级那份遮住。
    const bad = [...bare.matchAll(/repeat\(auto-fill,\s*minmax\(\s*(\d+)px/g)].map((m) => m[0]);
    expect(bad, `这几条没包 min(100%, …)：\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * **模块栏的按钮横竖两根轴都不许被压扁。**
   *
   * 窄屏那次（栏躺平成一条横的）已经发现过一次：九颗 36px 的按钮放不下时，
   * 浏览器把收缩量全摊给外层那两颗光杆按钮——「搜索」和「设置」，也就是这条
   * 栏上最常按的两颗。当时的修法是 `flex-shrink: 0` + 整条栏横滚，**但那两条
   * 被关在 `@media (max-width: 767px)` 里，只治了一根轴**。
   *
   * 竖着摆的时候同一个 bug 原样存在：横屏手机 812×375 实测，两颗各被压成
   * 36×15。所以 `flex-shrink: 0` 提到了媒体查询外面，整条栏也配了 `overflow-y`。
   */
  it('模块栏按钮的 flex-shrink: 0 在媒体查询外面——矮屏竖着摆时也不许压扁', () => {
    const eolChar = bare.includes('\r\n') ? '\r\n' : '\n';
    // **顶格**那份才算数：媒体查询里的规则是缩进的，只写在那儿的话另一根轴
    // 治不到。用「换行 + 不缩进」定位，跟这个文件里别处同一个办法——
    // 不能用「在第一个 @media 之前」，这份样式表里 @media 有好几处，
    // 顶格规则本来就会出现在某些 @media 后面（第一版就是这么误判的）。
    const i = bare.indexOf(eolChar + '.ink-modrail-btn {');
    expect(i, '顶格没有 .ink-modrail-btn 规则——它只活在媒体查询里的话，矮屏那根轴治不到').toBeGreaterThan(-1);
    const body = bare.slice(i, bare.indexOf('}', i));
    expect(body, '按钮会被压扁').toMatch(/flex-shrink:\s*0/);
    // **滚的必须是模块导航那一层，不能是整条栏。** 上一版在 `.ink-modrail`
    // 上写 `overflow-y: auto` + 藏滚动条，结果「搜索」和「设置」（它们是 nav 的
    // 兄弟）跟着卷出屏幕——812×375 实测设置齿轮落在 y=406、视口只有 375 高，
    // 而 `onOpenSettings` 全应用只有那一个入口。压扁但点得到 > 好看但够不到。
    const navAt = bare.indexOf('.ink-modrail > nav {');
    expect(navAt, '没有 .ink-modrail > nav 这条规则').toBeGreaterThan(-1);
    const nav = bare.slice(navAt, bare.indexOf('}', navAt));
    expect(nav, '模块导航那一层不滚的话，放不下时只能压扁按钮').toMatch(/overflow-y:\s*auto/);
    expect(nav, 'flex 子项不压 min-height: 0 就不会真的滚').toMatch(/min-height:\s*0/);
    // **必须关在宽屏媒体查询里。** 一个轴设了非 visible 的 overflow，另一个轴会
    // 跟着算成 auto——窄屏上这条栏是横着的，nav 会自己横向滚（实测 239px 宽、
    // scrollWidth > clientWidth），把本该由 .ink-modrail 承担的横滚抢走，而藏
    // 滚动条那两条只挂在栏上，于是一条只有一行高的栏里冒出一条横滚条。
    const wide = bare.lastIndexOf('@media (min-width: 768px)', navAt);
    expect(wide, '.ink-modrail > nav 没有关在宽屏媒体查询里').toBeGreaterThan(-1);
    expect(bare.indexOf('}', bare.indexOf('}', navAt) + 1), '媒体查询没有收尾').toBeGreaterThan(navAt);
    const rail = bare.slice(bare.indexOf('.ink-modrail {'), bare.indexOf('}', bare.indexOf('.ink-modrail {')));
    expect(rail, '整条栏一滚，钉在两头的搜索/设置会跟着卷出屏幕').not.toMatch(/overflow-y:\s*auto/);
  });

  it('窄屏日历那三条一个群青都没有——它们是人这一侧的记号，不是 AI 产出', () => {
    for (const sel of ['ink-cal-chip-narrow', 'ink-cal-chiptime-narrow', 'ink-cal-chipdot']) {
      // 不拼正则：这一段的反斜杠转义在几层工具之间来回被吃，切字符串更稳。
      const i = bare.indexOf('.' + sel + ' {');
      expect(i, sel + ' 这条规则不见了').toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf('}', i));
      expect(body.toUpperCase(), body).not.toContain('#2E3ED4');
      expect(body, body).not.toContain('--ink-ai');
    }
  });
});

/**
 * **界线所在的那一列不能裁掉它。**
 *
 * 这条是实测撞出来的，不是想出来的。可拖界线（`.ink-col-grip`）是绝对定位、
 * `left/right: -6px` 骑在列的边缘外侧上——伸出去的那 6px 只有在列
 * `overflow: visible` 时才存在。列一旦 `overflow-y: auto`（详情那列原来就是，
 * 为了内容能滚），伸出去的部分**被裁掉**：界线还画得出来、`getBoundingClientRect()`
 * 报的还是完整的 8px、ARIA 属性一个不少、单元测试里 `fireEvent` 也照样过——
 * 但真实浏览器里 `elementFromPoint` 打在它正中央命中的是隔壁那一列，
 * **看得见、点不着**。
 *
 * 侧栏那条一直好使，就是因为 `.ink-rail-col` 是 `overflow: visible`；两条界线的
 * 差别从头到尾只在这一个属性上。修法是把滚动挪进面板本体（`.ink-detail`）。
 *
 * 窄屏那份 `.ink-detail-col { position: fixed; …; overflow-y: auto }` 不在此列：
 * 那一屏这一列是铺满整屏的浮层，界线压根不渲染（`App.tsx` 里 `!isNarrow` 挡着）。
 */
describe('可拖界线：宿主列不能有裁剪型 overflow，否则界线看得见点不着', () => {
  /** 只看基线那部分声明——媒体查询里那份是浮层/窄屏，界线不渲染。 */
  const base = outsideAnyMedia(bare);

  it.each(['.ink-rail-col', '.ink-detail-col'])('%s 在宽屏下不设裁剪型 overflow', (sel) => {
    // 选择器整个不见时 declarationsFor 会抛，不会静静地回一个空串放行。
    const decls = declarationsFor(base, sel);
    const bad = /overflow(-x|-y)?\s*:\s*(auto|scroll|hidden|clip)/.exec(decls);
    expect(bad, `${sel} 上写了 ${bad?.[0]}——骑在它边缘的 .ink-col-grip 会被裁掉，界线看得见但点不着。滚动请挪进列里面那一层。`)
      .toBeNull();
  });

  /** 反面：滚动确实被挪进去了，不是干脆没人滚（那会让长备注把整页撑高）。 */
  it('详情内容自己滚——不是把滚动整个删掉了', () => {
    // 门槛这一批从 768 抬到了 1000（三栏放不下就让详情退成浮层，见下面那个 describe）。
    const m = bare.match(/@media \(min-width: 1000px\) \{\s*\.ink-detail \{([^}]*)\}/);
    expect(m, '宽屏下该有一条 .ink-detail 的规则接手滚动').not.toBeNull();
    expect(m![1]).toMatch(/overflow-y\s*:\s*auto/);
    expect(m![1], '没有确定高度的话 overflow-y: auto 不会产生滚动条').toMatch(/height\s*:\s*100%/);
  });
});

/**
 * **两栏都拖到最宽时，别把看板挤没。**
 *
 * 这条是实测撞出来的。侧栏和详情各自能拖到 460 / 640，两个都拉满就是 1100px，
 * 加上模块栏和内边距：
 *
 * - 1280 的屏幕上给看板只剩 **88px**，内容横向溢出；
 * - 1024 上更糟——Row 默认 `flex-wrap: wrap`，详情整个**换到第二行**，看板被顶出
 *   屏幕外（实测那两栏的 `top` 是 −728）。
 *
 * 靠三样东西一起兜住，缺一样都不成立，所以三样各有一条断言：
 * ① Row 在宽屏 `nowrap`——换行不是「挤了一点」，是「那一栏不见了」；
 * ② 看板一个 `min-width` 下限（量出来的：内容固有最小宽度 211px，取 320 是让
 *    一行任务还读得出来）；
 * ③ 那两栏的 flex **shrink 留成 1**（`0 1`，不是 `0 0`）——都是 0 的话谁都不肯让，
 *    空间不够时全压在看板上，②那个下限反而会把整行撑到溢出。
 *
 * 窄屏那一档不适用：`xs={24}` 的堆叠正是靠换行实现的，看板也不该有下限。
 */
describe('三栏布局：三栏各有下限，放不下就让详情退成浮层', () => {
  /**
   * **这一批把「挤不挤得下」这件事拆成了三件，缺一件都不成立：**
   *
   * ① 三栏在宽屏各自有下限（200 / 380 / 300）。不钉的话，把一栏拉满会把另一栏挤到
   *    它自己写着的下限以下——实测侧栏拉满、详情留默认，1000px 上详情只剩 258。
   * ② 加起来 880 再加外壳约 92 = 972，所以 999 以下没有「挤一挤都放得下」这回事，
   *    详情整个退成浮层（复用它在手机上本来就是的那套）。这个数在
   *    `lib/narrow.ts` 的 `TIGHT_QUERY` 和这里必须一致。
   * ③ 换行由 antd 的 `Row wrap` 关，不写 CSS 去盖它——理由见 App.tsx 那处注释
   *    （靠注入顺序赢的层叠，换个 StyleProvider 就悄悄回来了）。
   *
   * 看板那个 380 不是内容的固有最小宽度（实测 211），是四象限那个 2×2 网格
   * 每格要 ~170px 才画得出标题倒推的。
   */
  /** 只看 `@media (min-width: 1000px)` 里面那部分——三栏的下限全在那儿。 */
  const atWide = insideMedia(bare, 'min-width: 1000px');

  /** 取最后生效的那条 min-width。**不能取第一条**——这个文件为此栽过一次（见 .ink-trow-title）。 */
  const lastMinWidth = (sel: string): number | null => {
    const all = [...declarationsFor(atWide, sel).matchAll(/min-width:\s*(\d+)(?:px)?/g)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };

  it('宽屏那块本身还在——它是下面几条的前提，写法一变就全成空转', () => {
    expect(atWide.length, '一个 @media (min-width: 1000px) 都没抠到：多半是写法变了').toBeGreaterThan(0);
  });

  it('① 三栏各自的下限都在，而且是各自那个数', () => {
    expect(lastMinWidth('.ink-rail-col'), '侧栏该有下限（NavShell 的 NAV_MIN）').toBe(200);
    expect(lastMinWidth('.ink-detail-col'), '详情该有下限（App.tsx 的 DETAIL_MIN）').toBe(300);
    const board = lastMinWidth('.ink-board-col');
    expect(board, '任务列表该有下限').not.toBeNull();
    expect(board!, '内容的固有最小宽度实测 211，四象限每格还要 ~170——380 是后者倒推的').toBeGreaterThanOrEqual(380);
  });

  it('① 加起来放得下：三个下限之和 + 外壳，不该超过详情退成浮层的那个门槛', () => {
    const sum = lastMinWidth('.ink-rail-col')! + lastMinWidth('.ink-board-col')! + lastMinWidth('.ink-detail-col')!;
    // 外壳（模块栏 + .ink-main 内边距）实测占 92px，三档视口下都一样。
    expect(sum + 92, '三栏的下限加起来比门槛还宽的话，1000px 那一档必然溢出').toBeLessThanOrEqual(1000);
  });

  it('② 门槛两侧对得上：CSS 的 999/1000 跟 narrow.ts 的 TIGHT_QUERY 是同一个数', () => {
    const ts = readFileSync('web/src/lib/narrow.ts', 'utf8');
    const m = /TIGHT_QUERY = '\(max-width: (\d+)px\)'/.exec(ts);
    expect(m, 'narrow.ts 里该有 TIGHT_QUERY').not.toBeNull();
    expect(Number(m![1]), 'JS 那个断点跟 CSS 对不上的话，CSS 已经把详情画成浮层了而 JS 还在给它画界线').toBe(999);
    expect(bare, '详情浮层那块该挂在 max-width: 999px 上').toMatch(/@media \(max-width: 999px\) \{\s*\.ink-detail-col \{[^}]*position:\s*fixed/);
  });

  it('② 基线那条 min-width: 0 写在宽屏那块之前——两者特异度一样，谁在后面谁赢', () => {
    // 空白宽松：写死成单空格的话，跑一次 prettier/stylelint 就会红，而 CSS 其实没问题。
    const base = bare.search(/\n\.ink-rail-col,\s*\.ink-board-col,\s*\.ink-detail-col\s*\{\s*min-width:\s*0;?\s*\}/);
    const wideAt = bare.search(/@media \(min-width: 1000px\) \{[^@]*?\.ink-board-col \{[^}]*min-width/);
    expect(base, '基线那条三选择器的 min-width: 0 不见了').toBeGreaterThanOrEqual(0);
    expect(wideAt, '宽屏那块里设下限的规则不见了').toBeGreaterThanOrEqual(0);
    expect(wideAt, '基线那条排在后面的话它会赢，三个下限全变回 0').toBeGreaterThan(base);
  });

  /**
   * ③ 在 TSX 里，不在 CSS 里。**先剥注释再匹配**——这个文件顶上那条规矩对 TSX 一样
   * 成立，而且这几行正上方就写着复述 `0 1` / `wrap` 的注释。
   */
  it('③ 换行由 Row 自己关，两列的 flex shrink 是 1', () => {
    const strip = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, head: string) => head + ' '.repeat(m.length - head.length));

    const app = strip(readFileSync('web/src/App.tsx', 'utf8'));
    expect(app, 'Row 该自己关换行，不靠一条同特异度的 CSS 去盖 antd 的 row wrap')
      .toContain('wrap={isNarrow}');
    expect(bare, 'CSS 里不该再有那条 flex-wrap 的覆盖——它只靠注入顺序赢')
      .not.toMatch(/\.ink-cols \{[^}]*flex-wrap/);

    for (const [file, want, bad] of [
      ['web/src/components/NavShell.tsx', '`0 1 ${width}px`', '`0 0 ${width}px`'],
      ['web/src/App.tsx', '`0 1 ${detailWidth}px`', '`0 0 ${detailWidth}px`'],
    ] as const) {
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, `${file} 那一列的 flex 写成 0 0 的话，空间不够时它一步都不肯让`).toContain(want);
      expect(code, `${file} 里不该还留着 0 0 那种写法`).not.toContain(bad);
      // **也不该再有内联的 `minWidth`**：内联压过样式表，会把上面那三条下限整个废掉，
      // 而且是静默的——jsdom 不算布局，别的测试一条都不会红。这两处原来就有，
      // 这一批把它们搬进了 theme.css（宽屏要的不是 0，是各自那个数）。
      expect(code, `${file} 里还留着内联 minWidth，它会压过 theme.css 那三条下限`)
        .not.toMatch(/minWidth:\s*0/);
    }
  });

  it('详情内容自己滚——不是把滚动整个删掉了', () => {
    // 用上面那个 `wide`（所有宽屏块拼起来）+ `body()`，不指望 `.ink-detail`
    // 恰好是某个块里的第一条规则——那正是这个文件刚栽过的「依赖书写顺序」。
    const decls = declarationsFor(atWide, '.ink-detail');
    expect(decls, '宽屏下该有一条 .ink-detail 的规则接手滚动').not.toBe('');
    expect(decls).toMatch(/overflow-y\s*:\s*auto/);
    expect(decls, '没有确定高度的话 overflow-y: auto 不会产生滚动条').toMatch(/height\s*:\s*100%/);
  });
});

/**
 * **叠出来的间距**——这一类问题的共同形状是「没有人选过那个总数」。
 *
 * 实测撞出来的：从「今天」最后一条任务到底下那句路标之间有 74px 空白，由三个
 * 互不相干的声明加成——`.ink-today-list` 的 `padding-bottom: 32px`（没有注释）、
 * `.ink-review-nudge` 的 `margin-top: 28px` 和 `padding-top: 14px`。单看每一个都
 * 不离谱，加起来是一段读不出理由的空白。
 *
 * 守的不是某一个数，是**那个和**：谁往上加一点都会红，然后他得去看另外两个。
 */
describe('间距：相邻块叠出来的总空白有上限', () => {
  const px = (sel: string, prop: string): number => {
    // 模式里不写反斜杠：模板字符串会把 \s / \d 吃成 s / d，这个文件已经为此栽过两次。
    const m = new RegExp(prop + ':[ ]*([0-9]+)px').exec(declarationsFor(bare, sel));
    expect(m, `${sel} 的 ${prop} 不见了`).not.toBeNull();
    return Number(m![1]);
  };

  it('任务列表末尾 → 那句路标的文字之间不超过 48px', () => {
    const total = px('.ink-today-list', 'padding-bottom')
      + px('.ink-review-nudge', 'margin')          // margin: 20px 0 0 —— 取第一个数
      + px('.ink-review-nudge', 'padding-top');
    expect(total, '三处加起来就是屏幕上那道空白，原来是 32+28+14=74').toBeLessThanOrEqual(48);
  });

  /**
   * 回顾那一屏上下两块**各带一条横线、只隔二十来像素**。宽度对不上时屏幕上是
   * 一条 604px 的线紧挨着一条 1414px 的线，读起来像两套排版规则打架——实测过。
   */
  it('回顾屏那两条横线收在同一个 measure 里', () => {
    for (const sel of ['.ink-review-todo', '.ink-review-run']) {
      expect(declarationsFor(bare, sel), `${sel} 该收在 --measure 里，否则它那条横线跟隔壁不一样宽`)
        .toMatch(/max-width:\s*var\(--measure\)/);
    }
  });

  /**
   * 窄屏那条模块栏放不下 9 颗按钮时靠横滚（那是权衡过的，见 CSS 里那段），但滚动条
   * 是藏掉的——没有渐隐的话，唯一的线索是最右那颗图标被切一半，读起来像画坏了。
   * 390px（最常见的一档手机宽度）上被切的正好是「设置」。
   */
  it('窄屏模块栏有右缘渐隐——不然被切的图标看起来像坏了', () => {
    const narrow = insideMedia(bare, 'max-width: 767px');
    expect(declarationsFor(narrow, '.ink-modrail'), '横滚 + 藏滚动条 + 没有渐隐 = 图标像被切坏了')
      .toMatch(/mask-image:\s*linear-gradient\(to right/);
  });
});
