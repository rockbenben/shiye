// 把 brand/ 下的 HTML/SVG 渲成 PNG。**用仓库已经装着的 Electron**，不引新依赖
// （这台机器上没有 sharp/resvg/puppeteer，而为了几张图加一个几十兆的依赖不划算）。
//
// 顺带一个真实好处：Electron 用的是本机字体，宋体（Songti SC/SimSun）真的在，
// 社交卡上那句大字才是它该有的样子——换成 Linux 上的无字体环境只会退成默认衬线。
//
// 跑法：npx electron brand/render.mjs
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, '.tmp');

/**
 * 一张一张来：同时开几个窗口在无头环境下容易抢不到 GPU。
 *
 * **走临时文件 + `loadFile`，不用 `data:` URL**：第一版是 data URL，第一张
 * 拍得出来、第二张起一律 `ERR_FAILED (-2)`。文件路径没有这个毛病，顺带也让
 * 拍出问题时能直接拿浏览器打开那个 .html 看一眼。
 */
let seq = 0;
let win = null;
async function shoot(html, width, height, out) {
  const page = join(tmp, `page-${seq++}.html`);
  writeFileSync(page, html, 'utf8');
  // **复用同一个窗口，只改尺寸**：offscreen 窗口反复新建/销毁时，从第二个起
  // `loadFile` 一律 `ERR_FAILED (-2)`（实测，data: URL 和 file: 都一样，
  // 所以那不是 URL 的问题）。一个窗口从头用到尾就没有这回事。
  if (!win) {
    win = new BrowserWindow({
      width, height, show: false, frame: false,
      webPreferences: { offscreen: true, deviceScaleFactor: 1 },
    });
  }
  win.setContentSize(width, height);
  await win.loadFile(page);
  // 字体加载和布局落定之后再拍——不等的话中文可能拍到 fallback 那一帧。
  await new Promise((r) => setTimeout(r, 600));
  // **拍完必须再缩回目标尺寸。** `capturePage()` 跟着显示器的 DPI 走，
  // `deviceScaleFactor: 1` 管不着它——这台机器是 150% 缩放，要 256 拍出来是
  // 386、要 1200×630 拍出来是 1802×947（OG 图直接不是标准尺寸了，而且换台
  // 机器还会变成别的数）。缩一道之后尺寸是准的，顺带还白捡一次超采样：
  // 矢量按 1.5 倍渲染再降下来，边缘比直接 1 倍渲染更干净。
  const shot = await win.webContents.capturePage();
  const img = shot.getSize().width === width
    ? shot
    : shot.resize({ width, height, quality: 'best' });
  writeFileSync(join(here, '..', out), img.toPNG());
  console.log('写出', out, `${width}×${height}`);
}

/** SVG 文件铺满一张 N×N 的画布——图标那几个尺寸走这条。 */
const svgPage = (svg, size) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;

app.whenReady().then(async () => {
  mkdirSync(tmp, { recursive: true });
  const mark = readFileSync(join(here, 'mark.svg'), 'utf8');
  // **512 不是 256**：electron-builder 从这一份生成 macOS 的 .icns，源图小于
  // 512×512 直接报错打不出包（Windows 的 .ico 256 就够，所以这条在只出 Windows
  // 的时候一直没暴露）。多出来的分辨率对 Windows 无害——.ico 里本来就要装多档，
  // 大的那档现在也有了。
  await shoot(svgPage(mark, 512), 512, 512, 'desktop/build/icon.png');
  await shoot(svgPage(mark, 512), 512, 512, 'brand/mark-512.png');
  await shoot(svgPage(mark, 64), 64, 64, 'brand/mark-64.png');
  await shoot(svgPage(mark, 32), 32, 32, 'brand/mark-32.png');

  // 横排组合。宽高比 560:128，按 2 倍出图。
  const logo = readFileSync(join(here, 'logo.svg'), 'utf8');
  await shoot(
    `<!doctype html><meta charset="utf-8">`
    + `<style>html,body{margin:0;width:896px;height:256px;background:transparent}`
    + `svg{display:block;width:896px;height:256px}</style>${logo}`,
    896, 256, 'brand/logo.png',
  );

  const cmp = join(here, '.compare.html');
  if (existsSync(cmp)) await shoot(readFileSync(cmp, 'utf8'), 1020, 450, 'brand/.compare.png');

  const card = readFileSync(join(here, 'social-card.html'), 'utf8');
  await shoot(card, 1200, 630, 'brand/social-card.png');

  /**
   * **网站真正服务的那两份也要一起刷新。**
   *
   * `web/public/` 下的东西被 Vite 原样搬到站点根目录，`og:image` 和标签页图标
   * 指的是那儿（`/social-card.png`、`/icon.svg`），不是 `brand/` 下这两份。
   * 而这个脚本原来只写 `brand/`：重新出一次图之后，README 顶上那张换了新的，
   * **网页上服务的还是旧的**，两边悄悄分叉，谁都不会收到提醒（实测过：两处
   * 现在字节相同，纯属还没人重新生成过）。
   *
   * 所以在这儿一起拷过去。`brand/README.md` 那张表里「`mark.svg` 的副本」
   * 说的就是 icon.svg 这一份——「副本」这件事本身没问题，问题是它得跟着源头
   * 一起更新，而不是靠人记得手动拷。
   */
  copyFileSync(join(here, 'social-card.png'), join(here, '..', 'web', 'public', 'social-card.png'));
  copyFileSync(join(here, 'mark.svg'), join(here, '..', 'web', 'public', 'icon.svg'));

  rmSync(tmp, { recursive: true, force: true });
  app.quit();
});
