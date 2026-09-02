import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { theme as antdTheme } from 'antd';
import { boardLocalTheme, ink, theme } from './theme.js';

const { getDesignToken } = antdTheme;

// WCAG 2 相对亮度 / 对比度公式，跟规格文档「3.96 / 4.30 过不了 AA」引用的
// 是同一套算法。只在这个测试文件里用，不是给产品代码用的运行时依赖。
function srgbToLin(c: number): number {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

interface RGBA { r: number; g: number; b: number; a: number }

/** antd 的 colorText 系 token 不是纯 hex，是带透明度的 `rgba(r,g,b,a)`
 * （比如 `colorText` 实测是 `rgba(28,30,34,0.88)`）——DatePicker 的选中格
 * 文字实际读的就是这个 token，透明度会让它跟底色发生真实的 alpha 混合，
 * 直接拿纯色公式算会得出偏高的假对比度。这里两种格式都认，rgba 的先跟
 * 背景色混合出真正渲染出来的颜色，再算对比度。 */
function parseColor(input: string): RGBA {
  const m = input.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const h = input.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}

function luminance({ r, g, b }: RGBA): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

function contrastRatio(fg: string, bg: string): number {
  const fgColor = parseColor(fg);
  const bgColor = parseColor(bg);
  const composited: RGBA = {
    r: fgColor.a * fgColor.r + (1 - fgColor.a) * bgColor.r,
    g: fgColor.a * fgColor.g + (1 - fgColor.a) * bgColor.g,
    b: fgColor.a * fgColor.b + (1 - fgColor.a) * bgColor.b,
    a: 1,
  };
  const l1 = luminance(composited);
  const l2 = luminance(bgColor);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * **`theme.ts` 的 `ink` 和 `theme.css` 的 CSS 变量是同一批颜色的两份手写副本**
 * （`theme.ts` 顶上那段：「CSS 没法 import 一个 .ts 里的常量，改颜色时两处
 * 一起改」）。这条把「一起改」从一句口头约定变成机械检查。
 *
 * 它是补上来的，因为这个坑真的踩了：把 `--dim` 从 #6D655A 调深到 #635B50 时
 * 只改了 CSS 那一份，`theme.ts` 里还是旧值——**而整套测试是绿的**，下面那条
 * `expect(ink.dim).toBe(...)` 盯的是 ts 那一份，它没变所以没红；CSS 那份没有
 * 任何测试盯着值本身。于是同一个颜色在两个文件里各是一个值，而 antd 的主题
 * 读 ts、界面读 CSS——两套 UI 会慢慢漂成两个色。
 */
describe('调色板：theme.ts 和 theme.css 是同一批值', () => {
  const css = readFileSync('web/src/theme.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const PAIRS: Array<[keyof typeof ink, string]> = [
    ['paper', 'paper'], ['sheet', 'sheet'], ['you', 'ink-you'],
    ['ai', 'ink-ai'], ['overdue', 'overdue'], ['rule', 'rule'], ['dim', 'dim'],
  ];

  it('七个颜色 token 两边一字不差', () => {
    for (const [key, cssVar] of PAIRS) {
      // 模板字符串里必须写 `\\s`——`\s` 会退化成裸的 `s`，正则变成
      // `--dim:s*(#…)` 永远匹配不上，而报出来的是「theme.css 里没有 --dim」。
      const m = css.match(new RegExp(`--${cssVar}:\\s*(#[0-9A-Fa-f]{6})`));
      expect(m, `theme.css 里没有 --${cssVar}`).not.toBeNull();
      expect(m![1].toLowerCase(), `ink.${key} 是 ${ink[key]}，而 --${cssVar} 是 ${m![1]}——改颜色要两处一起改`)
        .toBe(String(ink[key]).toLowerCase());
    }
  });

  it('清点：这张表覆盖了 ink 里的每一个颜色——新加一个颜色而忘了在 CSS 里加，这儿会红', () => {
    const colors = Object.entries(ink).filter(([, v]) => /^#[0-9A-Fa-f]{6}$/.test(String(v))).map(([k]) => k);
    expect(PAIRS.map(([k]) => k).sort()).toEqual(colors.sort());
  });
});

/**
 * **antd 派生出来的「次要文字」也得过 AA。**
 *
 * 这个仓库对次要文字有一份量过的颜色（ink.dim），但那条规矩只管手写 CSS——
 * antd 的 `Typography type="secondary"` 读的是它自己派生的 colorTextSecondary，
 * 默认是 45% 的 colorTextBase，完全绕开 ink.dim。实测：设置弹层里那几行分节
 * 标题（12px）只有 2.77:1。
 *
 * 上一轮修 ink.dim 时漏掉了这一整条通道，因为那次量的是默认态的几屏，而这
 * 7 处 type="secondary" 全在设置弹层里——一个要点开才看得见的瞬时态。
 *
 * 走 getDesignToken 真实派生一遍，测的是 antd 实际会用来渲染的那个值，不是
 * 我们以为自己设了什么。
 */
describe('antd 的次要文字色：派生出来的那个值也过 AA', () => {
  const derived = getDesignToken({ token: theme.token });

  /**
   * **`Typography type="secondary"` 读的是 `colorTextDescription`，不是
   * `colorTextSecondary`。** 这是 antd 里名字最容易骗人的一处——查过
   * `node_modules/antd/es/typography/style/index.js`：`-secondary` 那条规则写的是
   * `color: token.colorTextDescription`。
   *
   * 两个默认值也不一样：secondary 是 65% 墨（≈4.6，勉强过），description 是
   * 45%（2.71，不过）。所以只压 `colorTextSecondary` 是治不了那 7 处的——
   * 这条注释存在的意义就是别让下一个人白改一遍。
   */
  it('colorTextDescription 过 4.5——Typography type="secondary" 真正读的是它', () => {
    expect(contrastRatio(derived.colorTextDescription, ink.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(derived.colorTextDescription, ink.sheet)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * **整条通道一起验，不是挑那几个报过错的。**
   *
   * 上一版这个 describe 只盯 `colorTextDescription` 和 `colorTextSecondary`
   * ——那是按「哪几处报了 2.77」倒推出来的名单，而 antd 派生表里同一档
   * （45% / 25% 墨）还有三个：`colorTextTertiary`、`colorIcon`、
   * `colorTextPlaceholder`。名单是倒推的，所以它只覆盖了当时恰好被看见的那两个。
   *
   * 门槛按用途分两档：图标是控件走 WCAG 1.4.11 的 3:1，文字走 4.5。
   *
   * `colorTextDisabled` **故意不在名单里**：WCAG 明确豁免 disabled 控件，
   * 界面审查那套探针也跳过它（`theme.css.test.ts` 里那条注释）。**但豁免对比度
   * 不等于豁免「看得出禁用」**——那一半由下面单独一条守，理由见它自己的注释。
   */
  it('派生表里所有 colorText* / colorIcon* 都达标——遍历，不手抄名单', () => {
    // **判据是遍历，不是名单。** 这条前后写死过两份名单，两次都漏：第一版只有
    // 当初报过 2.77 的那两个，第二版补到五个、仍然漏了 `colorTextQuaternary`
    // （1.67，而且 placeholder 默认就是从它派生的）。名单是倒推出来的，倒推
    // 就只会覆盖「当时恰好被看见的」。改成扫全表，加不加新 token 都不会漏。
    const 豁免 = new Map([
      // WCAG 明确豁免 disabled 控件；界面审查那套探针也跳过它。
      ['colorTextDisabled', '禁用态，WCAG 豁免'],
      // 它是「摆在实色底上的字」（主按钮里的白字），不在纸/页上量。
      ['colorTextLightSolid', '实色底上的字，不在纸面上出现'],
    ]);
    const 漏网: string[] = [];
    for (const [k, v] of Object.entries(derived)) {
      if (!/^colorText|^colorIcon/.test(k) || typeof v !== 'string') continue;
      if (豁免.has(k)) continue;
      // 图标是控件，走 WCAG 1.4.11 的 3:1；其余是文字，走 4.5。
      const 门槛 = k.startsWith('colorIcon') ? 3 : 4.5;
      for (const [面, bg] of [['纸', ink.paper], ['页', ink.sheet]] as const) {
        const r = contrastRatio(v, bg);
        if (r < 门槛) 漏网.push(`${k} 在${面}上 ${r.toFixed(2)}:1（要 ${门槛}）`);
      }
    }
    expect(漏网, `这几个 token 没达标：\n${漏网.join('\n')}`).toEqual([]);
  });

  /**
   * **禁用态不许跟普通次要文字撞成同一个色。**
   *
   * 这条不是对比度问题（WCAG 明确豁免 disabled），是「这颗按钮点不了」这个信息
   * 还在不在。上面那条遍历用例把 `colorTextDisabled` 放进了豁免表，所以它**永远
   * 逮不到**这件事——而它恰恰发生过：压 `colorTextQuaternary` 那一下把禁用态
   * 一起带走了，因为 antd 是从 quaternary 派生 disabled 的，而且在合并覆盖之后。
   * 那时候禁用和不禁用的按钮，文字颜色一个字节都不差。
   */
  it('禁用态跟次要文字不是同一个色——豁免了对比度，不等于豁免了「看得出禁用」', () => {
    expect(derived.colorTextDisabled).not.toBe(derived.colorTextSecondary);
    // 而且要明显更淡：跟次要文字比，对比度至少差一半以上
    const 禁用 = contrastRatio(derived.colorTextDisabled, ink.paper);
    const 次要 = contrastRatio(derived.colorTextSecondary, ink.paper);
    expect(禁用, `禁用 ${禁用.toFixed(2)}:1 vs 次要 ${次要.toFixed(2)}:1——分不出来`).toBeLessThan(次要 / 2);
  });

  /**
   * secondary 那个 token 别处（Menu 的次要项、Descriptions 的 label 等）还在读。
   * 它的默认值 65% 墨本来就压线过（≈4.6），这条守的是「别有人把它调浅」。
   */
  it('colorTextSecondary 也过 4.5', () => {
    expect(contrastRatio(derived.colorTextSecondary, ink.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(derived.colorTextSecondary, ink.sheet)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('#6：--dim / --overdue 必须是规格里改过的那两个值，不能被调浅回去', () => {
  it('ink.dim 是 #635B50，只能更深不能更浅', () => {
    // 沿革：初稿 #6E737C（过不了 AA）→ 换暖纸那轮转色相并压深 1% 得到
    // #6D655A → **这一轮又压深到 #635B50**。
    //
    // 最后这一次是量出来的：#6D655A 只在纸（paper）和页（sheet）上验过——
    // 也就是下面那两条断言覆盖的两种面——而界面上还有第三种，侧栏那层
    // `rgb(227,225,220)`。同一个色在那儿只有 4.39:1，导航的计数徽标、标签
    // 前的 `#`、日历里农历那一行全压在线下。**下面那两条不是错的，是不全的**，
    // 三种面一起验的那条在 `theme.css.test.ts`（它读 CSS 那一份）。
    expect(ink.dim).toBe('#635B50');
  });

  it('ink.overdue 是 #A8380A，不是初稿里过不了 AA 的 #C2410C', () => {
    expect(ink.overdue).toBe('#A8380A');
  });

  // **底色用 `ink.paper`/`ink.sheet`，不写字面量**：原来这四条把 #E9EAEC /
  // #F7F7F8 硬编在测试里，纸面一换就变成「拿旧底色去验新前景」——过了也
  // 不说明任何事。这一轮真的换了纸，两处字面量当场成了假的。
  it('ink.dim 在纸（--paper）和页（--sheet）两种底色上，小字对比度都过 AA 的 4.5', () => {
    expect(contrastRatio(ink.dim, ink.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink.dim, ink.sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it('ink.overdue 在纸和页两种底色上，小字对比度都过 AA 的 4.5', () => {
    expect(contrastRatio(ink.overdue, ink.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink.overdue, ink.sheet)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('#3：局部 ConfigProvider 压 colorPrimary 不能连带把 DatePicker 选中格的背景压成中灰', () => {
  it('TaskBoard/SettingsModal 实际用的局部主题覆盖，算出来的 controlItemBgActive 跟 colorText 对比度过 AA 的 4.5', () => {
    // TaskBoard.tsx 和 SettingsModal.tsx 里 `<ConfigProvider theme={boardLocalTheme}>`
    // 用的是同一份具名导出（不是两个文件各自 inline 一份、改一处漏一处）——
    // 这里直接引它，走一遍 antd 真实的 getDesignToken 派生，测的是产品代码
    // 实际会用来渲染的那条链路，不是另起一套自己猜的颜色比对。
    const merged = getDesignToken({ token: { ...theme.token, ...boardLocalTheme.token } });
    const ratio = contrastRatio(merged.colorText, merged.controlItemBgActive);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
