// 把 `theme.css` 里每一条写着 24px 的 `min-height` / `min-width` 抽成一份清单，
// 交给打磨稿去逐条验「它到底咬不咬人」。（24 这个数在样式表里管两件事：点击目标
// 的下限，和「别把这一行挤成一条缝」的行高 —— 这一张表分不清，分清是稿子的活。）
//
//   node tools/preview-floors.mjs            # 打印统计
//   node tools/preview-floors.mjs --json     # 写到 tools/design-preview/floors.json
//
// 为什么要这么一份东西：`min-height: 24px` 是「这条下限有人守着」的意思，可它只有
// 在**没写它的时候元素会变矮**才算在守。上一轮 batch2 拿左右两栏比出一条
// `.ink-dt-date{min-height:24px}` 抵掉之后逐字相同——也就是说那条从来没守过任何
// 东西，而它旁边的注释还写着「实测高 22px」。全站这样的下限一处挨一处数下来比
// 想的多，一条一条开 A/B 格要把浏览器开同样多次；这个脚本把它们抽成清单，一次
// 跑完逐条量。
//
// 抽的时候丢掉三类，丢掉的理由也是量的时候没法量的理由：
// - **`@media` 里面的**：要不要生效取决于视口，稿子里每个格视口不一样，混在一张
//   清单里会分不清「这条不咬」和「这一格根本不在那个断点里」。丢了几条由下面那行
//   统计打印出来——悄悄丢掉等于清单少了一截而没人知道。
// - **伪元素（`::before` / `::after`）**：`querySelectorAll` 拿不到，长出来的判定区
//   也量不到盒子。那一族由 `probe.js` 的 `elementFromPoint` 管。
// - **状态类选择器（`:hover` / `:focus` / `::selection` 之类）**：得先把元素弄进那个
//   状态才量，稿子里不做（做了就是另一套仪器）。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(ROOT, 'web', 'src', 'theme.css');
const OUT = join(ROOT, 'tools', 'design-preview', 'floors.json');

const css = readFileSync(CSS, 'utf8');

// 先剥注释：注释里有 `min-height: 24px` 这种复述（上一轮就是被它骗过一次——
// 拿带注释的原文匹配，一句顶格复述规则的注释能冒充规则本身）。
const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

// 找每个选择器后面那一串 `{ ... }`（不含嵌套花括号——这个文件里规则块都是叶子，
// 媒体查询里包的规则也算叶子，外面那层由 `inMedia` 判）。
const DECL = /\.?[A-Za-z_][^{};]*?\{([^{}]*)\}/g;
const mediaRanges = [];
{
  const re = /@(?:media|supports)[^{]*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(bare))) mediaRanges.push([m.index, m.index + m[0].length]);
}
const inMedia = (idx) => mediaRanges.some(([a, b]) => idx >= a && idx < b);

const entries = [];
const PSEUDO = /::?(before|after|selection|placeholder)/;
const STATE = /:(hover|focus|active|focus-visible|focus-within|disabled|checked)/;
let m2;
while ((m2 = DECL.exec(bare))) {
  const sel = bare.slice(m2.index, bare.indexOf('{', m2.index)).trim();
  const body = m2[1];
  if (!sel || sel.startsWith('@') || PSEUDO.test(sel) || STATE.test(sel)) continue;
  for (const prop of ['min-height', 'min-width']) {
    const d = new RegExp(`${prop}:\\s*24px`).test(body);
    if (!d) continue;
    entries.push({ sel, prop, media: inMedia(m2.index) });
  }
}

const picked = entries.filter((e) => !e.media);

// 两个数都打：只打「进清单几条」的话，@media 里那几条是悄悄消失的，而「清单比
// 想的小」跟「这条不咬人」是两种完全不同的结论。
console.log(`theme.css 里 24px 下限 ${entries.length} 处，进清单 ${picked.length} 处，@media 里丢掉 ${entries.length - picked.length} 处`);
for (const e of picked) console.log(`  ${e.sel} { ${e.prop}: 24px }`);

if (process.argv.includes('--json')) {
  writeFileSync(OUT, JSON.stringify(picked.map(({ sel, prop }) => ({ sel, prop })), null, 2));
  console.log(`→ ${OUT}`);
}
