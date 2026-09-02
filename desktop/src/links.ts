/**
 * 「这次导航该留在窗口里，还是交给系统浏览器？」——纯函数，不引 electron。
 *
 * ## 为什么需要
 *
 * 任务备注按 Markdown 渲染，里面的外链带着 `target="_blank"`（网页那边加的，
 * 见 `web/src/components/Markdown.tsx`）。在浏览器里那是新开一个标签页；
 * **在 Electron 里，默认行为是新开一个 `BrowserWindow`**——一个没有地址栏、
 * 没有前进后退、而且这个应用把菜单栏整个去掉了（`Menu.setApplicationMenu(null)`）
 * 的窗口，里面装着一个外部网站。点一下备注里的链接，就多出一个退不出去、
 * 看着还像是「办事师爷的一部分」的浏览器窗口。
 *
 * 同一件事的另一半是 `will-navigate`：没有 `target` 的链接（附件那两个「打开」
 * 就是）会**在当前窗口里跳走**——那更糟，应用本身没了，只能关掉重开。
 *
 * ## 判据
 *
 * - **只有应用自己那一页留在窗口里**：同源、而且路径就是 `/`。这个应用是
 *   hash 路由（`#/today`），它自己永远不会导航到别的路径；同源但路径不是 `/`
 *   的只有一种——`/api/tasks/:id/attachments/:name`，那是附件，交给系统打开
 *   （用系统的看图/PDF 程序）正是想要的。
 * - **http / https / mailto 交给系统**。
 * - **别的 scheme 一律不管**（`javascript:`、`data:`、`file:`……）：备注是
 *   自由文本，AI 也能往里写；把一个 `javascript:` 或本地文件路径原样递给
 *   `shell.openExternal` 是在替一段不受信任的文本执行动作。什么都不做最安全，
 *   而这几种在正经备注里也没有出现的理由。
 */
const HANDOFF = new Set(['http:', 'https:', 'mailto:']);

export type LinkDecision =
  /** 留在窗口里，什么都不用做。 */
  | { kind: 'stay' }
  /** 拦下来，把这个地址交给系统。 */
  | { kind: 'external'; url: string }
  /** 拦下来，什么都不做。 */
  | { kind: 'block' };

export function decideLink(raw: string, appOrigin: string): LinkDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 解析不出来的（相对路径、空串）不是一次真正的跨页导航，放行。
    return { kind: 'stay' };
  }
  if (url.origin === appOrigin) return url.pathname === '/' ? { kind: 'stay' } : { kind: 'external', url: raw };
  return HANDOFF.has(url.protocol) ? { kind: 'external', url: raw } : { kind: 'block' };
}
