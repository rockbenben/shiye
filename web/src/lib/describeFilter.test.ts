import { describe, it, expect } from 'vitest';
import { describeFilter, type FilterLabels } from './describeFilter.js';
import { emptyFilter } from './smartFilter.js';
import { STATUS_LABEL } from './taskView.js';
import type { List, SmartFilter } from '../types.js';

/** 状态那半份用真的那一张（`taskView.ts`），不在这儿手抄一遍：抄一份就是
 *  第 N 份，而这个仓库已经为那件事付过两次账了（见 `statusLabel.guard.test.ts`）。
 *  优先级那半份留着手写——这条测试要证明的正是「文案由调用方注入」，两份都
 *  用真表的话就看不出这件事了。 */
const LABELS: FilterLabels = {
  status: STATUS_LABEL,
  priority: { 0: '无', 1: '低', 2: '中', 3: '高' },
  context: { computer: '电脑前', out: '外出' },
};
const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#000', folderId: null, order: 0, archived: false, filter: null },
  { id: 'L2', name: '生活', color: '#000', folderId: null, order: 1, archived: false, filter: null },
];
const F = (o: Partial<SmartFilter> = {}): SmartFilter => ({ ...emptyFilter(), ...o });
const say = (o: Partial<SmartFilter>) => describeFilter(F(o), LISTS, LABELS);

describe('describeFilter', () => {
  it('什么都没筛就是 null——调用方据此整段不渲染，不摆一句空话', () => {
    expect(describeFilter(emptyFilter(), LISTS, LABELS)).toBeNull();
  });

  it('每一维各自说得出来', () => {
    expect(say({ status: ['todo', 'doing'] })).toBe('待办/进行中');
    expect(say({ listIds: ['L1'] })).toBe('工作');
    expect(say({ tags: ['工作'] })).toBe('#工作');
    expect(say({ priority: [3, 2] })).toBe('高/中');
    expect(say({ dueWithinDays: 7 })).toBe('7 天内');
    expect(say({ hasWaitingFor: true })).toBe('在等别人');
    expect(say({ text: ' 报告 ' })).toBe('含「报告」');
  });

  it('一组之内用「·」连——它们之间是「且」', () => {
    expect(say({ status: ['todo'], tags: ['工作'], dueWithinDays: 3 }))
      .toBe('待办 · #工作 · 3 天内');
  });

  it('「或」组之间说「或者」，跟筛选栏上那颗按钮同一个词', () => {
    expect(say({ tags: ['工作'], or: [F({ priority: [3] })] })).toBe('#工作，或者高');
  });

  it('空的「或」组不占位——它在 applyFilter 里也不参与', () => {
    expect(say({ tags: ['工作'], or: [F()] })).toBe('#工作');
  });

  it('「没有清单」「没有标签」跟同维度选中的那几个并排列出来——它们之间是「或」', () => {
    expect(say({ listIds: ['L1'], noList: true })).toBe('工作/不属于任何清单');
    expect(say({ tags: ['工作'], noTag: true })).toBe('#工作/没有标签');
  });

  it('「没有时间」也说出来——它跟「N 天内」是同一维的两档，措辞跟「接下来」那一组、看板那一列一致', () => {
    expect(say({ noDue: true })).toBe('没有时间');
  });

  it('**「都要有」只在真的选了不止一个标签时才说**——一个标签时「任一」和「全部」是同一件事', () => {
    expect(say({ tags: ['工作', '紧急'], tagsAll: true })).toBe('#工作/#紧急（都要有）');
    expect(say({ tags: ['工作'], tagsAll: true })).toBe('#工作');
  });

  it('**清单查不到名字时说「某个清单」，不印裸 uuid**——那对人没有任何意义', () => {
    expect(say({ listIds: ['删掉了'] })).toBe('某个清单');
  });

  it('情境也进这句话——筛选栏上选了却读不出来的维度，等于这句话在擒谎', () => {
    expect(say({ contexts: ['computer'] })).toBe('电脑前');
    expect(say({ contexts: ['computer', 'out'] })).toBe('电脑前/外出');
    // 跟别的维度一起时用「·」连，位置在优先级后面——跟筛选栏上那一排
    // 控件的先后一致，两处顺序不一样的话，这句预览就让人对不上号。
    expect(say({ priority: [3], contexts: ['out'] })).toBe('高 · 外出');
    // 认不得的值印原值，不静静从这句话里消失。
    expect(say({ contexts: ['home'] })).toBe('home');
  });

  it('状态/优先级的字面从调用方传进来，这个模块不自己攒一份文案表', () => {
    const other: FilterLabels = { status: { todo: 'TODO' }, priority: { 3: 'P1' }, context: { computer: '@PC' } };
    expect(describeFilter(F({ status: ['todo'], priority: [3] }), LISTS, other)).toBe('TODO · P1');
  });

  it('缺字段的老数据（加 or/noList 之前存下来的智能清单）不炸', () => {
    const legacy = { status: ['todo'], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '' } as unknown as SmartFilter;
    expect(describeFilter(legacy, LISTS, LABELS)).toBe('待办');
  });
});
