import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setBaseTitle, holdTitle, releaseTitle, currentBaseTitle } from './pageTitle.js';

/**
 * **文件名是 `.test.tsx` 不是 `.test.ts`，这一点是承重的。**
 *
 * `vitest.config.ts` 按后缀分档：`web/src/**\/*.test.ts` 进 node 档（没有
 * `document`），`web/src/**\/*.test.tsx` 才进 jsdom 档。上一版是 `.test.ts`，
 * 于是 `typeof document !== 'undefined'` 那一层永远是假的——**这个模块唯一的
 * 副作用一行都没被执行过**，五条断言全在读 `currentBaseTitle()` 这个只给测试
 * 用的 getter。把 `document.title = ...` 两行整个删掉，那一版照样全绿。
 */
describe('标签页标题：一个写入口', () => {
  beforeEach(() => { releaseTitle(); setBaseTitle(''); });

  it('视图名拼在应用名前面，并且真的写进了 document.title', () => {
    setBaseTitle('今天');
    expect(currentBaseTitle()).toBe('今天 · 办事师爷');
    expect(document.title).toBe('今天 · 办事师爷');
  });

  it('空的视图名只剩应用名——不留一条「 · 办事师爷」的孤儿分隔线', () => {
    setBaseTitle('   ');
    expect(document.title).toBe('办事师爷');
  });

  it('两边的空白吃掉', () => {
    setBaseTitle('  四象限 ');
    expect(document.title).toBe('四象限 · 办事师爷');
  });

  /**
   * 番茄钟跑着的时候切视图——**这是第一版漏掉的那个方向**。那时两边各写各的
   * `document.title`，切视图那一下直接把秒数盖掉，要等下一次跳秒才抢回来；
   * 而标签页在后台时那个计时器被浏览器节流到约一分钟一次，「切走之后看一眼
   * 还剩多久」偏偏就是番茄钟存在的理由。
   */
  it('有人占着标题时，切视图不抢屏幕上那一行，但底跟着换', () => {
    setBaseTitle('今天');
    holdTitle('24:59 · 写周报');
    expect(document.title).toBe('24:59 · 写周报');

    setBaseTitle('日历');                       // 番茄钟跑着，人切到了日历
    expect(document.title, '切视图把番茄钟的秒数盖掉了').toBe('24:59 · 写周报');
    expect(currentBaseTitle(), '底应该已经跟上新视图').toBe('日历 · 办事师爷');
  });

  /** 反方向：交还时拿的是**当下**的底，不是开始占用那一刻拍的快照。 */
  it('中途换了视图，交还后回到新的那个，不是开始时那张快照', () => {
    setBaseTitle('今天');
    holdTitle('24:59 · 写周报');
    setBaseTitle('日历');
    releaseTitle();
    expect(document.title).toBe('日历 · 办事师爷');
  });

  it('占用可以连着写（每秒一次），交还一次就干净', () => {
    setBaseTitle('今天');
    for (const t of ['25:00 · 专注', '24:59 · 专注', '04:59 · 休息']) holdTitle(t);
    expect(document.title).toBe('04:59 · 休息');
    releaseTitle();
    expect(document.title).toBe('今天 · 办事师爷');
  });

  /**
   * 应用名是从 `index.html` 那一份现读的，不是这儿写死的第二份字面量。
   *
   * **要连 globalThis 上那份缓存一起清掉。** 模块把第一次算出来的应用名存在
   * `Symbol.for('shiye.appTitle')` 上，为的是扛住 Vite 热更新——热更新会重新
   * 执行这个模块，而那一刻 `document.title` 已经是「今天 · 办事师爷」了，不缓存
   * 的话应用名会变成那一整串，再切一次视图就写出「日历 · 今天 · 办事师爷」，
   * 每热更一次多接一截。`vi.resetModules()` 清的是模块注册表，清不掉 globalThis，
   * 所以这条得自己动手删——删这一下本身也顺带说明了那份缓存确实在起作用。
   */
  it('应用名来自 index.html 的 <title>，不是模块里写死的', async () => {
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('shiye.appTitle')];
    document.title = '别的名字';
    vi.resetModules();
    const m = await import('./pageTitle.js');
    m.setBaseTitle('今天');
    expect(document.title).toBe('今天 · 别的名字');
  });

  it('第二次执行这个模块不会把应用名接成一长串（热更新那个坑）', async () => {
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('shiye.appTitle')];
    document.title = '办事师爷';
    vi.resetModules();
    const first = await import('./pageTitle.js');
    first.setBaseTitle('今天');
    expect(document.title).toBe('今天 · 办事师爷');
    // 热更新：模块重新执行，而此刻 document.title 已经带着视图名了
    vi.resetModules();
    const again = await import('./pageTitle.js');
    again.setBaseTitle('日历');
    expect(document.title, '应用名被接成了一长串').toBe('日历 · 办事师爷');
  });
});
