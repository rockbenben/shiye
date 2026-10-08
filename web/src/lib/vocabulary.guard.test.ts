import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRI_FULL_LABEL } from './taskView.js';
import { dateRangeText } from './calendar.js';

/**
 * **两条「一个东西只有一个写法」的源码扫描**，形状照 `statusLabel.guard.test.ts`：
 * 读源码，不靠运行时反射——反射看不见「有人又手抄了一份常量」。
 *
 * 为什么要第二条守卫：状态那五个字前后被手抄过五份、账记在 `statusLabel.guard.test.ts`
 * 里；优先级这一轮又长出同样的形状（`lib/grouping.ts` 和 `lib/cells.ts` 各一份表，
 * 0 档两份名字差一个字），日期区间也是（`lib/calendar.ts` 一份、
 * `components/CalendarGrid.tsx` 自己拼一份、专注统计又拼一份）。**每一次都是
 * 「抄一份更快」，每一次代价都是相邻两屏两个说法**，而没有任何东西拦着下一次。
 */
const SRC = 'web/src';
const PRI_HOME = join('web', 'src', 'lib', 'taskView.ts');
const RANGE_HOME = join('web', 'src', 'lib', 'calendar.ts');
const SELF = join('web', 'src', 'lib', 'vocabulary.guard.test.ts');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    // 测试文件不进扫描：它们里的「8月10日–16日」「没定优先级」是**断言的期望值**，
    // 不是第二份实现。把它们算成抄，等于要求测试不许钉住文案——而钉住正是这个
    // 仓库防文案漂移的另一半手段（`statusLabel.guard.test.ts` 那两条之所以不用
    // 排除，是因为没有测试会去写「状态键 + 冒号 + 那个状态的中文名」这种映射字面量）。
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe('优先级词汇：单一出处', () => {
  it('除了 lib/taskView.ts，源码里没有第二份「档位 → 中文」的映射字面量', () => {
    // `0: '没定优先级'` 这样的一对。命中任意一档就算抄了一份表——
    // 抄的人不会只抄半张。用 `includes` 不拼正则，同 statusLabel 那条的教训。
    const pairs = ([3, 2, 1, 0] as const).map((n) => `${n}: '${PRI_FULL_LABEL[n]}'`);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === PRI_HOME || file === SELF) continue;
      if (pairs.some((pair) => readFileSync(file, 'utf8').includes(pair))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('出处那份还在——上面那条要是连出处一起删了才绿，等于什么都没守住', () => {
    const src = readFileSync(PRI_HOME, 'utf8');
    for (const n of [3, 2, 1, 0] as const) expect(src).toContain(`${n}: '${PRI_FULL_LABEL[n]}'`);
  });
});

describe('日期区间写法：单一出处', () => {
  /**
   * `dateRangeText` 产出的形状是「…日–…日」（en dash 两侧不空格）。别处再拼出
   * 这个形状，就是又抄了一份格式——而这一条本轮刚兑现过一次：日历周标题写
   * `8月10日 - 8月16日`（ASCII 连字符加空格），专注统计写 `9月28日–10月4日`，
   * 同一种信息在相邻两屏两种排法。
   *
   * 判据取「源码里出现 `日–`」这个字面形状：它只可能来自手拼（`dateRangeText`
   * 自己那一行除外），因为组件现在拿到的是函数返回值、不是模板字符串。
   */
  it('除了 lib/calendar.ts，没有第二处手拼「日–日」', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === RANGE_HOME || file === SELF) continue;
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      if (src.includes('日–')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **行为正控制，不是「函数还在」。** 第一版这条写的是去扫源码里有没有
   * `dateRangeText` 和两行分支——实测把出处那行的 `–` 直接改掉，上面那条否定
   * 断言和这条一起绿（`return \`x\`` 也算「函数还在」），也就是说出处坏了没人在场。
   * 现在钉的是四条产出：同月省月名、跨月两边都写、跨年补年份、同一天不写成区间。
   */
  it('出处那份真的产出那个形状——上面那条否定断言靠它才有意义', () => {
    const d = (y: number, m: number, dd: number) => new Date(y, m - 1, dd);
    expect(dateRangeText(d(2026, 8, 10), d(2026, 8, 16))).toBe('8月10日–16日');
    expect(dateRangeText(d(2026, 8, 31), d(2026, 9, 6))).toBe('8月31日–9月6日');
    expect(dateRangeText(d(2025, 12, 28), d(2026, 1, 2))).toBe('2025年12月28日–1月2日');
    expect(dateRangeText(d(2026, 8, 19), d(2026, 8, 19))).toBe('8月19日');
  });
});

/**
 * **两个词不许再长回来**（batch8 H-4 / H-9）。
 *
 * 「回收站」是 Windows 那个东西的名字，而这个应用删掉的任务进的是自己的
 * `data/trash/`——界面上写「回收站」不只是不统一，是一句会让人去错地方的话。
 * 「……」（两个 … 字符）跟全站其余 20 多处占位/进行中提示用的「…」是两种省略号，
 * 混用只会被读者注意到、不会被作者记住。
 *
 * 扫之前剥注释：这两条管的是**界面字符串**，代码注释里怎么说是自由的（第一版
 * 没剥，9 条注释全被当成抄了一份「其它」报出去——那批不是界面，改它们只是抖动）。
 */
describe('界面词汇：两个不该再出现的写法', () => {
  const banned = ['回收站', '……'];

  it('界面字符串里没有「回收站」，也没有「……」', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === SELF) continue;
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      for (const word of banned) if (src.includes(word)) offenders.push(`${file} :: ${word}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **终端笔记不上界面**（batch8 H-8）。`系统 PATH` / `支持环境变量` / `已支持主流`
   * 这三样原来写在设置里那六行 CLI 说明上：环境变量是不打开设置也能用的逃生口，
   * 只该出现在 README；「主流」是空话，用户要的是名单，名单就在下面那六家。
   * 判据是扫界面源码——写进 README 不算违规，那个文件不在 `web/src` 里。
   */
  it('设置里不写环境变量、PATH，也不写「主流」', () => {
    const jargon = ['系统 PATH', '支持环境变量', '已支持主流'];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === SELF) continue;
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      for (const word of jargon) if (src.includes(word)) offenders.push(`${file} :: ${word}`);
    }
    expect(offenders).toEqual([]);
  });

  /** 正控制：判据真能认出这些词——不然上面两条绿得毫无意义。 */
  it('判据自己会咬：拿一段含「回收站」的文本喂进去要命中', () => {
    const sample = '不含已经删掉的——那些进了回收站，这里数不到。';
    expect(banned.some((w) => sample.includes(w))).toBe(true);
    expect(banned.some((w) => 'AI 正在拆解，一般要一两分钟…'.includes(w))).toBe(false);
    const jargon = ['系统 PATH', '支持环境变量', '已支持主流'];
    const uiSample = '留空默认使用系统 PATH 中的 claude 命令（支持环境变量 CLAUDE_CLI）。';
    expect(jargon.filter((w) => uiSample.includes(w)).length).toBe(2);
  });
});
