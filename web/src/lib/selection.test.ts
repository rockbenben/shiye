import { describe, expect, it } from 'vitest';
import { rangeBetween, clickToSelection, type SelState } from './selection.js';

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
