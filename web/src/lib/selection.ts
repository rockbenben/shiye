/**
 * 选中态的纯函数——批量操作用的多选/范围选择。见 task-2-brief.md。
 *
 * 只算「点了之后该是什么状态」，不摸 DOM、不挂监听——那是 Task 3 接线的事。
 */

export interface SelState {
  ids: Set<string>;
  anchor: string | null;
}

/** 渲染顺序里从 a 到 b 的一段（含两端）。任一端不在列表里就返回空。 */
export function rangeBetween(ordered: string[], a: string, b: string): string[] {
  const ia = ordered.indexOf(a);
  const ib = ordered.indexOf(b);
  if (ia === -1 || ib === -1) return [];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return ordered.slice(lo, hi + 1);
}

/** Ctrl/Cmd 点的切换：选中了就去掉，没选中就加上；点到的这个总是成为新锚点。 */
function toggle(prev: SelState, id: string): SelState {
  const ids = new Set(prev.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/** 一次点击之后的新选中态。`mods` 是这次点击带了哪些修饰键。 */
export function clickToSelection(
  prev: SelState,
  ordered: string[],
  id: string,
  mods: { shift: boolean; ctrlOrMeta: boolean },
): SelState {
  // 真实点击理论上可能同时按住 Ctrl 又按住 Shift；这里没有单独测过那个组合，
  // Shift 分支写在前面，是一个确定但不追求完备的选择，留给 Task 3 接线时判断
  // 真实键盘事件会不会产生这个组合、要不要单独处理。
  if (mods.shift) {
    // 没有锚点（第一次点，或者上一次是平常点、没建立锚点）时，Shift 退化成
    // Ctrl 点：选中/加上点到的这一个，同时把它立成新锚点，后面才有得连选。
    if (prev.anchor === null) return toggle(prev, id);
    // 锚点还在：算出从锚点到这次点的这一段，整体替换掉当前选中集合——不是
    // 并入。锚点本身不动，这样才能反复调整范围（选多了往回缩）。
    // ponytail: 这里是全量替换，不是「只替换上一次连选的那一段、其它 Ctrl
    // 点单独加的项保留」——后者得多记一个「上一次连选到哪」的字段，而 SelState
    // 现在只有 ids/anchor 两个字段（brief 定死的形状，不改）。全量替换是多数
    // 列表 UI（Gmail、GitHub 的 checkbox 列表）Shift 点的标准语义；想要「保留
    // 其它单独选中的项」得靠 Ctrl+Shift 一起按，那是另一种手势，这里不做，
    // 需要时再加。
    return { ids: new Set(rangeBetween(ordered, prev.anchor, id)), anchor: prev.anchor };
  }
  if (mods.ctrlOrMeta) return toggle(prev, id);
  // 平常点：什么都不做，选中态原样返回——今天「点一下卡片什么都不发生」的
  // 行为不能被这批改动碰到。
  return prev;
}

/**
 * 光标 = 选中集合里离锚点最远的那一个（没选中就退成锚点本身）。
 *
 * **为什么不是 `SelState` 上的第三个字段**：鼠标那条路（Shift 点）产出的永远是
 * 「锚点 → 点到的那一个」这一段连续区间，两头必有一头就是光标，现读得到。多养
 * 一个字段就是多一条「它俩不能对不上」的不变量，而它一旦跟 `ids` 分叉（漏改的
 * 那一处），屏幕上的表现是「按方向键从错的那一头长」——比现算更难查。
 *
 * **近似的那一半**：Ctrl 点攒出来的散选（`{a,c,e}`）没有区间可言，这时给出的是
 * 「离锚点最远的一个」。`clickToSelection` 本来就把 Shift 定成整体替换（见那儿的
 * ponytail 注释），散选之后再连选是第二种说法叠在第一种上，跟着一起替换。
 */
export function cursorOf(prev: SelState, ordered: string[]): string | null {
  const ai = prev.anchor === null ? -1 : ordered.indexOf(prev.anchor);
  if (ai === -1) return prev.anchor;
  let far = prev.anchor;
  let fd = -1;
  for (const id of prev.ids) {
    // 不在屏幕上的（这一轮被筛掉/改了状态）不参与：它的下标是 -1，算出来的
    // 距离是个假数，选中它等于把光标丢回一条看不见的任务上。
    const i = ordered.indexOf(id);
    if (i === -1) continue;
    const d = Math.abs(i - ai);
    if (d > fd) { fd = d; far = id; }
  }
  return far;
}

/**
 * ↑/↓ 在屏幕顺序里移动光标。光标走 `cursorOf`；**锚点只在扩选时当不动的那一头**，
 * 不扩选时跟着走——下一次 Shift 连选才有正确的起点。
 *
 * 不循环：走到头就停。列表 UI 里按到底再按一次跳回第一条，在长列表上是一次
 * 「我以为还在这几条上」的迷失，而省下的那一下按键不值这个。
 *
 * `ordered` 由调用方从**屏幕上现读**（折叠的、被筛掉的不在里面）——走位跟鼠标
 * 连选必须走同一份顺序，否则 Shift+↓ 连出来的段和 Shift+点 连的段不一样长。
 */
export function moveSelection(
  prev: SelState,
  ordered: string[],
  dir: 'up' | 'down',
  extend: boolean,
): SelState {
  if (ordered.length === 0) return prev;
  const c = cursorOf(prev, ordered);
  const at = c === null ? -1 : ordered.indexOf(c);
  if (at === -1) {
    // 没有光标，**或者光标那条刚被筛掉/改状态消失了**（`ordered` 里查不到它）。
    // 两种都从看得见的那一头重新起：往下走落第一条，往上走落最后一条。
    const id = dir === 'down' ? ordered[0] : ordered[ordered.length - 1];
    return { ids: new Set([id]), anchor: id };
  }
  const next = ordered[dir === 'down' ? Math.min(at + 1, ordered.length - 1) : Math.max(at - 1, 0)];
  if (!extend) return { ids: new Set([next]), anchor: next };
  // 扩选：锚点不动，选中换成「锚点到新光标」那一段。在头/尾上再按一次方向键，
  // 算出来还是同一段——贴着边界反复按不会把选中的缩掉。
  return { ids: new Set(rangeBetween(ordered, prev.anchor as string, next)), anchor: prev.anchor };
}


/**
 * Ctrl/Cmd+A。**`group` 是光标所在那一组的可见条目**，不是整屏——看不见的
 * 任务不该被一条快捷键整批改掉（跟「已过期」组头那颗「全部改到今天」同一条
 * 判据：推的是屏幕上那几条）。一屏只有一个组的时候（「今天」那一屏）两者
 * 本来就是一样的。
 *
 * 不做「再按一次取消全选」：全选按第二下在别的界面里还是全选，把它做成切换
 * 等于给一个破坏性动作加了一个看不见第二态。
 */
export function selectAllIn(prev: SelState, group: string[]): SelState {
  if (group.length === 0) return prev;
  // 光标留着，只要它还在这组里；不在就落到这组第一条——留着一条屏幕上的
  // 空锚点，下一次 Shift 点会连出一段看不见的区间。
  const anchor = prev.anchor !== null && group.includes(prev.anchor) ? prev.anchor : group[0];
  return { ids: new Set(group), anchor };
}
