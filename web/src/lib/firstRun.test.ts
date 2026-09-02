import { describe, it, expect } from 'vitest';
import { FIRST_RUN_HINT, isFirstRun } from './firstRun.js';

describe('isFirstRun', () => {
  it('一条都没有才算', () => {
    expect(isFirstRun([])).toBe(true);
    expect(isFirstRun([{}])).toBe(false);
  });

  it('**那句话要说清楚从哪儿开始**——空状态在这个应用里的标准就是这个，「今天没有要做的」在一台刚装好的机器上是误导', () => {
    // 钉的是「有出口」，不是某个具体措辞：两条入口各提一次。
    expect(FIRST_RUN_HINT).toContain('随手记');
    expect(FIRST_RUN_HINT).toContain('添加任务');
  });

  it('**只点名屏幕上真有的东西。** 这句话曾经写着「点右上角『新任务』」——而那颗按钮早就删了（加任务只剩列表顶上那一行，照滴答清单文档改的），空状态却还在指挥人去点一个不存在的东西', () => {
    expect(FIRST_RUN_HINT).not.toContain('新任务');
  });
});
