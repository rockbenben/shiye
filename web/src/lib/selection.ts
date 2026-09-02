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
