/**
 * URL hash ←→ 去处（view）的互转。用 `location.hash` 不用 History API：
 * 这个应用是 file://-adjacent 的本地页面 + Electron WebView，`pushState`
 * 的路径在两种载体里行为不一致；hash 到哪都一样。见 task-1-brief.md。
 */

// list:/tag: 这类动态 key，写出去时只能编码值部分——标签名是任意用户文本
// （中文、#、/ 都可能出现）。整串 encodeURIComponent 会连前缀里的 `:` 也
// 一起编码掉（变成 %3A），viewFromHash 靠字面 `:` 匹配前缀，匹配不上就
// 会退回「原样当成 view」那条分支，往返就断了。decodeURIComponent 只处理
// %XX 序列、不碰字面字符，整串解不会伤到前缀，但沿用「只动值部分」的写法
// 让编解码对称、少一条要记的例外。
const PREFIXES = ['list:', 'tag:'];

/** hash → 去处的 key。空/无效一律 'today'。 */
export function viewFromHash(hash: string): string {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return 'today';
  for (const p of PREFIXES) {
    if (raw.startsWith(p)) {
      try {
        return p + decodeURIComponent(raw.slice(p.length));
      } catch {
        // 解不开的百分号编码（截断的 %E4%B8 之类）不抛，原样当成 view——
        // 跟下面「认不出的 hash 原样当成 view」同一个态度。
        return raw;
      }
    }
  }
  // 认不出的 hash（固定去处、或者压根不认识的 key）原样当成 view，不强行
  // 改回 'today'：`App.tsx` 的 `!findSpec(view)` 兜底会显示「没有这个去处」，
  // 那对一个指向已删清单的旧书签正是对的反馈。
  return raw;
}

/** 去处的 key → hash（含 # 号）。 */
export function hashFromView(view: string): string {
  for (const p of PREFIXES) {
    if (view.startsWith(p)) return `#/${p}${encodeURIComponent(view.slice(p.length))}`;
  }
  return `#/${view}`;
}
