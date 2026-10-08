import { describe, expect, it } from 'vitest';
import { rangeBetween, clickToSelection, moveSelection, selectAllIn, type SelState } from './selection.js';

const O = ['a', 'b', 'c', 'd', 'e'];

describe('rangeBetween', () => {
  it('正向', () => expect(rangeBetween(O, 'b', 'd')).toEqual(['b', 'c', 'd']));
  it('反向——锚点在后面也要给出同一段', () =>
    expect(rangeBetween(O, 'd', 'b')).toEqual(['b', 'c', 'd']));
  it('同一个', () => expect(rangeBetween(O, 'c', 'c')).toEqual(['c']));
  it('一端不在列表里（被别的客户端删了）→ 空数组，不抛', () =>
    expect(rangeBetween(O, 'zzz', 'c')).toEqual([]));

  // O 恰好是有序的字母表——不能证明实现真的按「给定顺序」而不是「字母序」在切。
  // 换一个乱序的夹具，断言给出的是列表里的那一段，不是重新排过序的字母段。
  it('乱序夹具：给出的是列表顺序里的那一段，不是字母序', () => {
    const unordered = ['e', 'a', 'd', 'b', 'c'];
    expect(rangeBetween(unordered, 'a', 'b')).toEqual(['a', 'd', 'b']);
  });
});

describe('clickToSelection', () => {
  const empty = (): SelState => ({ ids: new Set(), anchor: null });

  it('平常点：什么都不选——今天的行为不变', () => {
    const r = clickToSelection(empty(), O, 'b', { shift: false, ctrlOrMeta: false });
    expect([...r.ids]).toEqual([]);
  });
  it('Ctrl 点：加进去，并成为新锚点', () => {
    const r = clickToSelection(empty(), O, 'b', { shift: false, ctrlOrMeta: true });
    expect([...r.ids]).toEqual(['b']);
    expect(r.anchor).toBe('b');
  });
  it('Ctrl 点已选中的：取消它', () => {
    const s: SelState = { ids: new Set(['b']), anchor: 'b' };
    expect([...clickToSelection(s, O, 'b', { shift: false, ctrlOrMeta: true }).ids]).toEqual([]);
  });
  it('Shift 点：从锚点连选，锚点不动', () => {
    const s: SelState = { ids: new Set(['b']), anchor: 'b' };
    const r = clickToSelection(s, O, 'd', { shift: true, ctrlOrMeta: false });
    expect([...r.ids].sort()).toEqual(['b', 'c', 'd']);
    expect(r.anchor).toBe('b'); // 连选不移动锚点，才能反复调整范围
  });
  it('没有锚点时 Shift 点：等同 Ctrl 点', () => {
    const r = clickToSelection(empty(), O, 'c', { shift: true, ctrlOrMeta: false });
    expect([...r.ids]).toEqual(['c']);
  });
  // 上限方向：Shift 连选是「并入」还是「替换」？定成替换上一次的范围，
  // 否则反复调整范围会越选越多，永远减不下来
  it('Shift 连选替换上一次的范围，不是累加', () => {
    const s: SelState = { ids: new Set(['b', 'c', 'd']), anchor: 'b' };
    const r = clickToSelection(s, O, 'c', { shift: true, ctrlOrMeta: false });
    expect([...r.ids].sort()).toEqual(['b', 'c']); // d 被去掉了
  });
  it('Ctrl 点之后原有的选中保留', () => {
    const s: SelState = { ids: new Set(['a']), anchor: 'a' };
    expect([...clickToSelection(s, O, 'd', { shift: false, ctrlOrMeta: true }).ids].sort())
      .toEqual(['a', 'd']);
  });

  // 设计判断（brief 没覆盖）：Ctrl 点单独加的项，在之后的 Shift 连选里保不保留？
  // 定成不保留——Shift 点是标准语义下的「整体替换选中集合」，不是「只替换上一次
  // 连选的那一段」。后者需要额外记住「上一次连选到哪」，SelState 现在只有
  // ids/anchor 两个字段，不为这个加字段。这里的 `a` 就是那个「Ctrl 点单独加的
  // 项」，锚点在 'b' 上（假设是更早一次 Ctrl 点或连选留下的）：
  it('Ctrl 点单独加的项在之后的 Shift 连选里不保留——Shift 替换的是整个选中集合', () => {
    const s: SelState = { ids: new Set(['a']), anchor: 'b' };
    const r = clickToSelection(s, O, 'd', { shift: true, ctrlOrMeta: false });
    expect([...r.ids].sort()).toEqual(['b', 'c', 'd']); // a 没有被保留下来
  });
});

describe('moveSelection（↑/↓ 走位）', () => {
  const empty = (): SelState => ({ ids: new Set(), anchor: null });
  const at = (id: string): SelState => ({ ids: new Set([id]), anchor: id });

  it('屏幕上什么都没有 → 原样返回，不抛', () => {
    expect(moveSelection(empty(), [], 'down', false)).toEqual(empty());
  });

  it('没有光标：往下落第一条、往上落最后一条，并且就选中那一条', () => {
    expect(moveSelection(empty(), O, 'down', false)).toEqual(at('a'));
    expect(moveSelection(empty(), O, 'up', false)).toEqual(at('e'));
  });

  it('有光标：走一步，选中集合收成那一条（不带着原来那几条一起走）', () => {
    const r = moveSelection(at('b'), O, 'down', false);
    expect([...r.ids]).toEqual(['c']);
    expect(r.anchor).toBe('c');
  });

  // 不循环是设计判断：长列表里按到底再跳回第一条，表现是「我以为还在这几条上」
  // 却已经跑到顶上，而省下的那一下按键不值这个。
  it('走到头停住，不循环回第一条', () => {
    expect(moveSelection(at('e'), O, 'down', false)).toEqual(at('e'));
    expect(moveSelection(at('a'), O, 'up', false)).toEqual(at('a'));
  });

  it('Shift 扩选：锚点不动，选中换成锚点到光标那一段', () => {
    const r = moveSelection(at('b'), O, 'down', true);
    expect([...r.ids].sort()).toEqual(['b', 'c']);
    expect(r.anchor).toBe('b');
  });

  it('Shift 连按两下 → 段跟着长；反方向按 → 段缩回去（锚点在后面）', () => {
    const one = moveSelection(at('b'), O, 'down', true);
    expect([...moveSelection(one, O, 'down', true).ids].sort()).toEqual(['b', 'c', 'd']);
    expect([...moveSelection(one, O, 'up', true).ids].sort()).toEqual(['b']);
  });

  it('Shift 贴着边界再按不会把选中的缩掉', () => {
    const wide = { ids: new Set(['d', 'e']), anchor: 'd' };
    expect([...moveSelection(wide, O, 'down', true).ids].sort()).toEqual(['d', 'e']);
  });

  it('光标那条已经不在屏幕上（改了状态/被筛掉）→ 从看得见的那一头重新起', () => {
    const gone: SelState = { ids: new Set(['zzz']), anchor: 'zzz' };
    expect(moveSelection(gone, O, 'down', false)).toEqual(at('a'));
    expect(moveSelection(gone, O, 'up', false)).toEqual(at('e'));
  });

  it('走的是列表顺序，不是字母序（乱序夹具）', () => {
    const unordered = ['e', 'a', 'd', 'b', 'c'];
    expect(moveSelection(at('e'), unordered, 'down', false).anchor).toBe('a');
  });
});

describe('selectAllIn（Ctrl/Cmd+A）', () => {
  const G = ['a', 'b', 'c'];

  it('这一组一条都没有 → 原样返回', () => {
    const prev: SelState = { ids: new Set(['x']), anchor: 'x' };
    expect(selectAllIn(prev, [])).toEqual(prev);
  });

  it('整组选中，光标还在组里就别动它', () => {
    const r = selectAllIn({ ids: new Set(['b']), anchor: 'b' }, G);
    expect([...r.ids].sort()).toEqual(G);
    expect(r.anchor).toBe('b');
  });

  it('光标在别的组（刚在那边全选过）→ 落到这一组第一条，不留一个屏幕上的空锚点', () => {
    const r = selectAllIn({ ids: new Set(['z']), anchor: 'z' }, G);
    expect(r.anchor).toBe('a');
  });

  it('换组全选是替换不是并入——全选的意思就是「就这一组」，不是「再加一组」', () => {
    const r = selectAllIn({ ids: new Set(['z']), anchor: 'z' }, G);
    expect([...r.ids].sort()).toEqual(G);
  });
});
