import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **全角标点前面不许有空格。**
 *
 * 跟 `cjkWrap.guard.test.ts` 是同一族（中文排版里凭空多一个空格），但判据完全
 * 不同，所以分成两个文件：
 *
 * - 那条查的是**渲染态**：在 JSX 里把一句中文折行，JSX 把换行折成一个空格。
 * - 这条查的是**源码里本来就写进去的空格**：字符串字面量里 `?` 和 `，` 中间有
 *   一个空格，编译、类型、单测全绿，屏幕上就是「按 ? ，那里列着…」。
 *
 * 两条不重叠：`FIRST_RUN_HINT` 那句是在一行源码里写死的，`cjkWrap` 那条按
 * 「上一行结尾 + 下一行开头」找，压根看不见它；反过来，一条真的在 JSX 里折了行
 * 的句子，在这条的判据下是绿的（源码里就是两行，中间没有空格）。
 *
 * ## 判据为什么是「全角标点前面有空格」，而不是「两个标点挨太近」
 *
 * 中文排版里全角标点自带左右留白（`，` 的左边本来就有半个字的空隙），前面再加
 * 一个空格等于叠了两份，视觉上像漏了个空格、又像有意留的间距，读者分不清。
 * **合法的情况一个都没有**——没有任何一种中文写法需要在 `，。、；：？！）」』》…`
 * `——` 前面留一个空格。
 *
 * 中英混排的空格（「跑完 30 分钟」「按 ?」）不算：那些空格的右边是**半角**标点，
 * 而全角标点自己已经把左边让开了，所以空格只出现在「汉字 + 半角」那个边上。
 * 判据只抓「空白右边紧跟全角标点」，两边都不放宽。
 */

/**
 * **`stripComments` 跟 `cjkWrap.guard.test.ts` 里那份是同一份东西，写了两遍。**
 *
 * 本来想抽成 `sourceScan.ts` 共用，被 `webBundle.guard.test.ts` 挡下来了：**那条
 * 守卫不许 `web/src` 下任何非测试文件导入 node 内置模块**，理由是这类文件可能
 * 被谁一把拽进网页包里（真出过一次构建体积事故）。而 `walk`/`stripComments` 要读
 * 磁盘，非用 `node:fs` 不可——所以这个「只给测试用」的公共件在 `web/src/lib`
 * 里根本放不下。
 *
 * 别的目录不受那条约束，但为一个测试专用的夹具单开一个包更不划算。**于是就写两
 * 遍**，并且把两个非显然的坑在两份里都写上原因：哪天那份抽走了，坑跟着一起搬，
 * 不会有人只搬走代码。
 */

/** 不扫这些目录。 */
const SKIP = new Set(['node_modules', 'dist', 'build']);

/**
 * 走遍一棵源码树，返回要扫的文件。
 *
 * **`.test.` 的一律跳过**：测试文件里的字符串大半是「造一个假的坏句子」的夹具
 * ——守卫自己的判据样本就长这样——扫它们等于每次都要给自己开豁免。
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * 把注释挖掉，**换行留着**（替换成等长的空格，不是空串）。
 *
 * ## 三个坑，每个都踩过
 *
 * 1. **挖掉注释要把换行留下**：直接替换成空串会把多行注释压没，后面每一行的行号
 *    全部左移，报出来的位置指向别处——第一版就是这样，报的 11 处 line 号全是错的，
 *    照着去看只会看到不相干的代码。
 * 2. **`//` 的匹配要带 `(^|[^:])`**：不加的话 `http://192.168.1.5` 里的 `//` 会被
 *    当成注释，把那一行后半截连同中文一起挖掉（设置里那句服务地址说明就是）。
 *    `cjkWrap` 那条里抄的就是同一份，`scripts/identity-literals.test.ts` 更早踩过。
 * 3. **`{/* … *\/}` 也要挖**：JSX 里的块注释顶格写的是 `{/*`，**不是** `/*`。
 *    只按「trim 之后以 `/*` 开头」排行的话，JSX 注释整块都漏掉——而本仓库的 JSX
 *    注释里大量用反引号包着代码片段（比如 `` `count ? … : null` ``），里面的 `…`
 *    是货真价实的省略号，会被当成人话里的全角标点报出来。**这条守卫第一版就是
 *    这么红的**，报的还正是两处无辜的注释。
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

/**
 * 全角标点：`　-〿`（CJK 标点）、`＀-￯`（全角 ASCII）、引号 `‘’“”`、
 * 破折号 `—`、省略号 `…`。
 *
 * **不含 `·`（U+00B7，中点）**：分隔符那一族是 `' · '` 这种**故意**两边留空的
 * 连接串（列表之间、分段之间），它是分隔用的记号、不是句子的一部分，把它算进来
 * 会把全应用几十处正确的写法全部报成错。下面有一条用例钉着这一点。
 */
const FULLWIDTH_PUNCT = '\\u3000-\\u303f\\uff00-\\uffef\\u2018\\u2019\\u201c\\u201d\\u2014\\u2026';

/** 「非空白 + 一个或多个空白 + 全角标点」。中间那串空白就是那个多出来的洞。 */
const SPACE_BEFORE_PUNCT = new RegExp('[^\\s]\\s+([' + FULLWIDTH_PUNCT + '])');

/**
 * 同一个判据的两份：遍历要 `g`（`matchAll` 硬要求），`.test()` 要**不带** `g` 的。
 *
 * 带 `g` 的正则有 `lastIndex`，拿它 `.test()` 连着两次的结果会一次真一次假——
 * 而这个文件里判据既当遍历器又当断言用，两种用法混在同一个常量上就会出这种
 * 「跑一次绿、跑两次红」的假象。
 */
const SPACE_BEFORE_PUNCT_G = new RegExp(SPACE_BEFORE_PUNCT.source, 'g');

/**
 * 「半角 `?` + 一个中文标点」。**右括号要在判据里挖掉**，否则连修好的版本都会被
 * 自己逮住：`按「?」，那里…` 里 `?` 后面紧跟 `」`，而 `」`（U+300D）就在
 * `FULLWIDTH_PUNCT` 那个类里。`?」` 是**没有歧义**的——`?` 在引号里，`」` 只是在
 * 把引号关上，读者读到这儿知道那句话还没结束。
 *
 * 真正有歧义的是 `?` 后面跟**收尾标点**（`。`，、；：…——`）：那才是句子/分句结束，
 * 而半个问号刚落在结束的位置上，读者只会把它读成问句。
 *
 * 所以这里是**负向断言**而不是把收尾标点一个个列出来：新增一种全角标点时默认
 * 就算「收尾」，只有右括号这种「把已经开着的括号关上」的才被挖掉。
 */
const CLOSING_BRACKET = '\\u300d\\u300f\\u3011\\u3015\\u300b\\u2019\\u201d';
const QUESTION_MARK_THEN_PUNCT = new RegExp(
  '\\?(?![' + CLOSING_BRACKET + '])([' + FULLWIDTH_PUNCT + '])',
);

const QUESTION_MARK_THEN_PUNCT_G = new RegExp(QUESTION_MARK_THEN_PUNCT.source, 'g');

/**
 * **半角 `?` 后面不许紧跟中文标点——这一条是被指出来才发现的。**
 *
 * 上面那条守卫（空格）修掉 `按 ? ，那里` 之后，本以为完事了。用户盯着改完的句子
 * 问了一句「**为什么问号后面还有逗号**」——去掉空格之后是 `按 ?，那里`，而半角
 * `?` 紧挨全角 `，`，读者会把它读成**问号**：「不知道从哪儿下手？，那里列着…」。
 * 本意是「按这个键」，句意整个拧了。
 *
 * **所以「标点前面不许有空格」不等于「这一处就修干净了」**：那一条只管空隙，不管
 * 这个符号**是什么**。全角标点自带留白、前面不该有空格，可同一个位置还叠着另一
 * 个问题——`?` 是个**会被读成标点的键名**。
 *
 * ## 判据为什么只认 `?`，不认 `/`
 *
 * 半角 `?` 在这个仓库里只有一个身份：键名（`ShortcutHelp.tsx` 那张表的 `keys` 列、
 * 命令面板的 `?` 那一行）。真问句一律写全角 `？`——所以半角 `?` 后面跟中文标点，
 * **没有一种合法情形**。
 *
 * `/` 就不同了：它既是键（搜索那一条 `keys: '/'`），也天天出现在网址里，而
 * `https://…` 这种**占位符**的省略号正是全角 `…`——`/` 紧跟全角标点是合法的，
 * 把它算进来会报出设置页那两处服务地址。第一版把 `[?!/]` 放在一起，跑出来正是
 * 这两处假阳性。
 */

/** 一行代码里的字符串字面量。带反斜杠转义的片段不收，免得把 `\"` 当成引号收尾。 */
const LITERALS = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g;

describe('中文排版：全角标点前面不许多一个空格', () => {
  it('所有非测试 .ts/.tsx 的字符串字面量里，没有「空白 + 全角标点」', () => {
    const bad: string[] = [];
    for (const file of walk('web/src')) {
      stripComments(readFileSync(file, 'utf8')).split(/\r?\n/).forEach((ln, i) => {
        for (const m of ln.matchAll(LITERALS)) {
          const s = m[1] ?? m[2] ?? m[3];
          if (!s) continue;
          for (const hit of s.matchAll(SPACE_BEFORE_PUNCT_G)) {
            const at = hit.index ?? 0;
            bad.push(`${file}:${i + 1}  「…${s.slice(Math.max(0, at - 14), at + 6)}…」`);
          }
        }
      });
    }
    expect(bad, `这几处渲染出来会在全角标点前面多一个空格：\n${bad.join('\n')}`).toEqual([]);
  });

  it('半角 `?` 后面不许多一个中文标点——它会被读成问句', () => {
    const bad: string[] = [];
    for (const file of walk('web/src')) {
      stripComments(readFileSync(file, 'utf8')).split(/\r?\n/).forEach((ln, i) => {
        for (const m of ln.matchAll(LITERALS)) {
          const s = m[1] ?? m[2] ?? m[3];
          if (!s) continue;
          for (const hit of s.matchAll(QUESTION_MARK_THEN_PUNCT_G)) {
            const at = hit.index ?? 0;
            bad.push(`${file}:${i + 1}  「…${s.slice(Math.max(0, at - 16), at + 8)}…」`);
          }
        }
      });
    }
    expect(bad, `半角问号紧跟中文标点，读者会读成一句问话：\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * 钉住判据本身，别让它悄悄退化成「什么都不报」。
   *
   * 这条守卫的价值全在「能报出真的」，而报不报得出来取决于判据宽不宽——
   * 宽了会放过真问题（实测 `?` 不在标点类里就放过 `按 ? ，`），窄了会把
   * 中点、破折号这些合法的写法全报成错。窄了立刻满屏红、放宽了立刻全绿，
   * 两种都看得见；**只有「判据整段没跑」这件事是看不见的**，所以这里造一条
   * 确实该被抓住的字符串，断言判据会抓住它。
   */
  it('判据认得「? 后面的全角逗号」——FIRST_RUN_HINT 那句就是被它逮到的', () => {
    const broken = '不知道从哪儿下手就按 ? ，那里列着所有快捷键。';
    expect(SPACE_BEFORE_PUNCT.test(broken), '判据放过了它，这条守卫就等于没有').toBe(true);
    expect(QUESTION_MARK_THEN_PUNCT.test(broken.replace('? ', '?')),
      '判据放过了它，这条守卫就等于没有').toBe(true);
    // 修好之后那半句必须不再命中。
    const fixed = '不知道从哪儿下手就按「?」，那里列着所有快捷键。';
    expect(SPACE_BEFORE_PUNCT.test(fixed)).toBe(false);
    expect(QUESTION_MARK_THEN_PUNCT.test(fixed)).toBe(false);
  });

  /** 中点分隔符是**故意**两边留空的，不能被当成错——`join(' · ')` 全应用都是。 */
  it('中点分隔符不算', () => {
    expect(SPACE_BEFORE_PUNCT.test("['一', '二'].join(' · ')")).toBe(false);
  });

  /** 网址占位符里 `/` 紧跟全角省略号是合法的——把它算进来会报出设置页那两处地址。 */
  it('网址里的「/」不算', () => {
    expect(QUESTION_MARK_THEN_PUNCT.test('https://…/v1/chat')).toBe(false);
  });
});
