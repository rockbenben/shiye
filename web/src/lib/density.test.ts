// @vitest-environment jsdom
// 按扩展名这个文件本该落进 vitest.config.ts 的 'node' 档（裸 node 没有
// window/localStorage），用这行 pragma 单独切到 jsdom——跟 keymap.test.ts
// 同一个理由。density.ts 直接用同步的 `localStorage`（不是 apiBase.ts 那套
// Capacitor Preferences），这个文件不用像 apiBase.test.ts 那样 mock 掉存储层。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDensity, setDensity } from './density.js';

// localStorage 在 jsdom 里跨用例会串——CLAUDE.md 明写的那条规矩，这里每条
// 用例前后各清一次，不依赖用例执行顺序。
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('density：没存过（冷启动/清空过 localStorage）', () => {
  it('getDensity() 是 "card"——不传 fallback 时的默认档', () => {
    expect(getDensity()).toBe('card');
  });

  /**
   * **手机上默认该是行。** 390×844 实测：卡片档一条 134px、行档 33px，首屏能
   * 看见的从 4 条变成 17 条——而「今天」这一屏的全部意义就是一眼看完今天要做
   * 什么。`App.tsx` 传 `isNarrowNow() ? 'row' : 'card'`。
   */
  it('给了 fallback 就用它——窄屏那条路靠这个给「行」', () => {
    expect(getDensity('row')).toBe('row');
    expect(getDensity('card')).toBe('card');
  });
});

describe('density：存过的永远压过 fallback', () => {
  /**
   * **这一条是「默认」和「强制」的分界。** 手机上默认给行，但他真在手机上点了
   * 「卡」就该记住——行/卡那个开关在窄屏上是渲染出来的，压不住等于让那颗开关
   * 点了没反应。
   */
  it('他挑过卡片档，窄屏也照他的来', () => {
    setDensity('card');
    expect(getDensity('row')).toBe('card');
  });

  it('反过来一样：挑过行，宽屏也照他的来', () => {
    setDensity('row');
    expect(getDensity('card')).toBe('row');
  });

  it('存了个不认识的值就回退到 fallback，不是硬当成 card', () => {
    localStorage.setItem('density', '什么');
    expect(getDensity('row')).toBe('row');
  });
});

describe('density：setDensity / getDensity 的同步读写', () => {
  it('setDensity("row") 之后，getDensity() 立刻（不用 await）读回 "row"', () => {
    setDensity('row');
    expect(getDensity()).toBe('row');
  });

  it('setDensity("card") 能把已经存成 "row" 的值改回来', () => {
    setDensity('row');
    expect(getDensity()).toBe('row');
    setDensity('card');
    expect(getDensity()).toBe('card');
  });

  it('真的落了盘，不是只更新内存——直接读 localStorage 的值', () => {
    setDensity('row');
    expect(localStorage.getItem('density')).toBe('row');
  });

  it('冷启动读到上一次持久化过的值——不经过 setDensity()，直接往 localStorage 里塞', () => {
    // 模拟「上次会话已经存过」：这条不走 setDensity()，直接写 storage，
    // 跟 apiBase.test.ts「冷启动」那组测的是同一件事——读这条路不是巧合
    // 读到某个内存缓存的初值。density.ts 没有内存镜像，这里其实等价于
    // 上面「同步读写」那组，但单独留一条名字点明「这是冷启动场景」的用例，
    // 防的是以后真的加了一层内存缓存却忘了让它在模块重新加载时重新读盘。
    localStorage.setItem('density', 'row');
    expect(getDensity()).toBe('row');
  });

  it('存进去的值不是 "row" 时（读到垃圾值），当成没存过——回退默认档 "card"', () => {
    // 上限方向：不能是「只要 localStorage 里有值就信」，得精确认 'row'。
    // 手改浏览器 devtools、旧版本存过别的字符串，都不该让这条判断意外命中。
    localStorage.setItem('density', 'compact');
    expect(getDensity()).toBe('card');
  });

  it('localStorage.getItem 抛出时（隐私模式/配额满）也不炸，回退默认档', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(getDensity()).toBe('card');
    spy.mockRestore();
  });

  it('localStorage.setItem 抛出时不炸——本次切换只在内存/这次调用里有效', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => setDensity('row')).not.toThrow();
    spy.mockRestore();
  });
});
