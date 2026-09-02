// @vitest-environment jsdom
// 按扩展名这个文件本该落进 vitest.config.ts 的 'node' 档（裸 node 没有
// localStorage），用这行 pragma 切到 jsdom——跟 density.test.ts 同一个理由。
import { describe, it, expect, beforeEach } from 'vitest';
import { getFolded, setFolded, toggleFolded } from './folderFold.js';

/**
 * 侧栏文件夹的折叠状态。跟 `density.ts` 同一类的本机偏好，测法也照它：
 * 每条前面显式清一次 `localStorage`——这几个函数共用一个 key，不清的话
 * 上一条写进去的值会漏进下一条，而那种串味只在特定执行顺序下才现形。
 */
describe('folderFold', () => {
  beforeEach(() => { localStorage.clear(); });

  it('没存过就是一个都没收——默认全展开', () => {
    expect(getFolded().size).toBe(0);
  });

  it('存进去读得回来', () => {
    setFolded(new Set(['f1', 'f2']));
    expect([...getFolded()].sort()).toEqual(['f1', 'f2']);
  });

  /**
   * **默认全展开，存的是「收起来的那几个」。** 反过来存展开集的话，新建的
   * 文件夹、换一台机器、清掉浏览器数据，都会表现成「这个文件夹是空的」——
   * 而它并不空，里面的清单只是没渲染出来，侧栏上没有任何地方说得清为什么。
   */
  it('没记录过的文件夹算展开，不算收起', () => {
    setFolded(new Set(['f1']));
    const folded = getFolded();
    expect(folded.has('f1')).toBe(true);
    expect(folded.has('新建的')).toBe(false);
  });

  it('toggle：收了再放就没了', () => {
    const a = toggleFolded(new Set(), 'f1');
    expect([...a]).toEqual(['f1']);
    expect([...toggleFolded(a, 'f1')]).toEqual([]);
  });

  it('toggle 不改传进来的那份——调用方拿它进 React state', () => {
    const before = new Set(['f1']);
    toggleFolded(before, 'f2');
    expect([...before]).toEqual(['f1']);
  });

  // 手改过、别的版本写的、半份坏数据——都不该让侧栏炸，也不该让所有文件夹
  // 一起弹开。
  it('存的东西坏了当作一个都没收', () => {
    localStorage.setItem('folder-fold', '不是 JSON');
    expect(getFolded().size).toBe(0);
    localStorage.setItem('folder-fold', '{"a":1}');
    expect(getFolded().size).toBe(0);
  });

  it('数组里混进了非字符串：只丢那几项，别的照留', () => {
    localStorage.setItem('folder-fold', JSON.stringify(['f1', 3, null, 'f2']));
    expect([...getFolded()].sort()).toEqual(['f1', 'f2']);
  });
});
