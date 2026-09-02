// @vitest-environment jsdom
// 按扩展名本该落进 'node' 档（裸 node 没有 localStorage），用这行 pragma 切到
// jsdom——跟 density.test.ts / keymap.test.ts 同一个理由。quadrantRule.ts 直接用
// 同步的 `localStorage`，不用 mock 存储层。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getQuadrantRule, setQuadrantRule, DEFAULT_QUADRANT_RULE, QUADRANT_RULES, QUADRANT_RULE_LABEL,
} from './quadrantRule.js';

// localStorage 在 jsdom 里跨用例会串——CLAUDE.md 明写的那条规矩。
beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('没存过就是默认档', () => {
  /**
   * **默认必须是 `priority`，这一条是行为兼容性的锚。** 这个应用在有这个开关
   * 之前一直就是那套；默认换成 `time-priority` 等于替每个已经在用的人改一次
   * 界面——他打开四象限会发现任务全挪了位置，而他什么都没点过。
   */
  it('默认是 priority', () => {
    expect(getQuadrantRule()).toBe('priority');
    expect(DEFAULT_QUADRANT_RULE).toBe('priority');
  });
});

describe('存过的读得回来', () => {
  it.each(QUADRANT_RULES)('%s 存了再读还是它', (rule) => {
    setQuadrantRule(rule);
    expect(getQuadrantRule()).toBe(rule);
  });

  it('换一次就是换一次，不会两档叠在一起', () => {
    setQuadrantRule('time-priority');
    setQuadrantRule('priority');
    expect(getQuadrantRule()).toBe('priority');
  });
});

describe('读到不认识的东西一律回默认档', () => {
  /**
   * 这个键是 `localStorage` 里的一个裸字符串，别的标签页、旧版本、手改开发者
   * 工具都写得进去。写进一个不认识的值之后如果原样返回，`quadrantCells` 里
   * `rule === 'time-priority'` 会走 else 分支——结果凑巧也是 priority 那套，
   * 看起来没事。但 `QUADRANT_RULE_LABEL[rule]` 会取到 `undefined`，界面上那两个
   * 单选钮**一个都不选中**：一屏东西摆在那儿，没有任何一档看起来是生效的。
   */
  it.each([
    ['空字符串', ''],
    ['旧的/别处的值', 'eisenhower'],
    ['大小写不对', 'Priority'],
    ['一段 JSON', '{"rule":"priority"}'],
  ])('%s → 回默认档', (_n, raw) => {
    localStorage.setItem('quadrantRule', raw);
    expect(getQuadrantRule()).toBe(DEFAULT_QUADRANT_RULE);
  });

  it('localStorage 整个抛异常（隐私模式/被禁用）也回默认档，不让四象限打不开', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getQuadrantRule()).toBe(DEFAULT_QUADRANT_RULE);
  });

  it('写不进去也不抛——存不下是小事，为它炸掉一次点击不是', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => setQuadrantRule('time-priority')).not.toThrow();
  });
});

describe('给界面用的那两份常量', () => {
  /**
   * `QUADRANT_RULES` 是四象限那一屏 `.map()` 出单选钮的那份名单，
   * `QUADRANT_RULE_LABEL` 是名字。两边对不上的后果是**渲染出一个没有名字的
   * 单选钮**，而 TypeScript 拦不住（`Record<QuadrantRule, string>` 只保证键齐全，
   * 不保证 `QUADRANT_RULES` 里没有多余项——那份是 `as const` 的字面量数组）。
   */
  it('名单里每一档都有名字，且名字不为空', () => {
    for (const r of QUADRANT_RULES) {
      expect(QUADRANT_RULE_LABEL[r], `${r} 没有界面文案`).toBeTruthy();
    }
  });

  it('名单不重不漏，跟 QUADRANT_RULE_LABEL 的键一一对应', () => {
    expect([...QUADRANT_RULES].sort()).toEqual(Object.keys(QUADRANT_RULE_LABEL).sort());
  });

  it('默认档在名单里——否则那一屏上没有一个钮是选中的', () => {
    expect(QUADRANT_RULES).toContain(DEFAULT_QUADRANT_RULE);
  });
});
