import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GroupSortBar } from './GroupSortBar.js';
import { DEFAULT_GROUP_SORT, type GroupSort } from '../lib/grouping.js';

// antd 会给「恰好两个汉字、非 text/link 变体」的按钮插空格，按中文找先去空白。
// **queryAllByRole 不是 getAllByRole**：默认档下这一条上一颗按钮都没有
// （倒序和恢复默认都藏起来了），get* 在零个匹配时会抛，而「一颗都没有」
// 正是有两条用例要断言的东西。
const byText = (text: string) => screen.queryAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

function show(value: GroupSort = DEFAULT_GROUP_SORT, view = 'all') {
  const onChange = vi.fn();
  render(<GroupSortBar view={view} value={value} onChange={onChange} />);
  return { onChange };
}

describe('GroupSortBar', () => {
  it('两个下拉都在，默认停在「不分组 / 默认顺序」', () => {
    show();
    expect((screen.getByLabelText('分组') as HTMLSelectElement).value).toBe('none');
    expect((screen.getByLabelText('排序') as HTMLSelectElement).value).toBe('default');
  });

  it('换分组把新值报上去，别的字段原样带着', () => {
    const { onChange } = show({ groupBy: 'none', sortBy: 'due', desc: true });
    fireEvent.change(screen.getByLabelText('分组'), { target: { value: 'priority' } });
    expect(onChange).toHaveBeenCalledWith({ groupBy: 'priority', sortBy: 'due', desc: true });
  });

  it('「默认顺序」档下不给倒序按钮——那一档就是「别动这个视图排好的顺序」，正反没有意义', () => {
    show();
    expect(byText('正序')).toBeUndefined();
    expect(byText('倒序')).toBeUndefined();
  });

  it('选了具体排序之后倒序按钮才出现，点一下翻过去', () => {
    const { onChange } = show({ ...DEFAULT_GROUP_SORT, sortBy: 'created' });
    fireEvent.click(byText('正序')!);
    expect(onChange).toHaveBeenCalledWith({ groupBy: 'none', sortBy: 'created', desc: true });
  });

  it('默认档下没有「恢复默认」——没东西可恢复，摆着是一颗点不出效果的按钮', () => {
    show();
    expect(byText('恢复默认')).toBeUndefined();
  });

  it('改过之后「恢复默认」出现，点了整份回默认档', () => {
    const { onChange } = show({ groupBy: 'tag', sortBy: 'due', desc: true });
    fireEvent.click(byText('恢复默认')!);
    expect(onChange).toHaveBeenCalledWith(DEFAULT_GROUP_SORT);
  });

  /**
   * **「默认」是按去处算的。** 「已完成」自己的默认是按完成时间分组
   * （`lib/grouping.ts` 的 `VIEW_DEFAULT`）。这两条盯的是同一个缺陷的两半：
   * 拿全局默认去比它，一进这一屏「恢复默认」就白亮着（他什么都没改），
   * 而点下去还会把分组改成「不分组」——那不是恢复，是把他带离这一屏的默认，
   * 并且会被 `setGroupSort` 当成一条明确偏好存下来。空实例上截图确认过。
   */
  it('站在「已完成」它自己的默认档上，没有「恢复默认」——那一屏的默认是按完成时间', () => {
    show({ groupBy: 'completed', sortBy: 'default', desc: false }, 'done');
    expect(byText('恢复默认')).toBeUndefined();
  });

  it('在「已完成」里点「恢复默认」，回的是它自己那一档，不是全局那一档', () => {
    const { onChange } = show({ groupBy: 'tag', sortBy: 'due', desc: true }, 'done');
    fireEvent.click(byText('恢复默认')!);
    expect(onChange).toHaveBeenCalledWith({ groupBy: 'completed', sortBy: 'default', desc: false });
  });

  it('反过来：在「已完成」里停在全局默认档，那是「改过了」，「恢复默认」得在', () => {
    show(DEFAULT_GROUP_SORT, 'done');
    expect(byText('恢复默认')).toBeTruthy();
  });
});
