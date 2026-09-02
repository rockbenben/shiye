// @vitest-environment jsdom
// 按扩展名这个文件本该落进 vitest.config.ts 的 'node' 档（裸 node 没有
// localStorage），用这行 pragma 单独切到 jsdom——跟 density.test.ts 同一个理由。
import { describe, it, expect, beforeEach } from 'vitest';
import { getListMode, setListMode } from './listMode.js';

// 跟 density.test.ts 同一个套路：显式清，别让上一条用例的写入漏给下一条。
beforeEach(() => localStorage.clear());

describe('listMode', () => {
  it('没存过是「列表」——默认档跟改之前一样', () => {
    expect(getListMode()).toBe('list');
  });

  it('存了「看板」读得回来', () => {
    setListMode('board');
    expect(getListMode()).toBe('board');
  });

  it('存回「列表」也读得回来——不是单向门', () => {
    setListMode('board');
    setListMode('list');
    expect(getListMode()).toBe('list');
  });

  it('**存的是垃圾值就回默认档**，不把它当成一个第三种模式往下传', () => {
    localStorage.setItem('listMode', 'kanban');
    expect(getListMode()).toBe('list');
  });
});
