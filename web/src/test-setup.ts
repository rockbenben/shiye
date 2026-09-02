// jsdom 里缺的那几个浏览器 API。只补 antd / React 挂载时真的会碰到的，
// 缺一个就整棵树渲染不出来，跟被测行为无关。
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { resetDrafts } from './lib/draftStash.js';

// findBy* 的默认超时是 1000ms，跟 vitest 的 testTimeout 是两码事。
configure({ asyncUtilTimeout: 5_000 });

// 「编辑到一半被卸载的草稿」那份暂存（lib/draftStash.ts）是**模块级**的：
// 在浏览器里它的寿命就是这一次页面会话，正是要的语义；但在测试里一个文件
// 内的所有用例共用同一份模块注册表，而夹具的任务 id 往往都叫 't1'——上一条
// 用例里进过编辑态的卡卸载时把草稿存下，下一条用例的同名卡片一挂载就自己
// 进了编辑态。表现是几十条毫不相干的用例一起红（实测 88 条）。
//
// **注册顺序不能反**：`afterEach` 是后进先出，所以这一句必须写在下面
// `cleanup` **前面**，才能在它后面跑——反过来的话 `resetDrafts` 先清空、
// 紧接着 `cleanup` 卸载组件又把草稿存了回去，等于没清（实测还剩 53 条红）。
afterEach(resetDrafts);

// 不卸载的话下一个用例会同时看到上一次的 DOM，「断言某段文字不出现」会莫名其妙地红。
afterEach(cleanup);

// antd 的响应式栅格 / 抽屉靠它。jsdom 没有实现。
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// antd 的 Collapse / Tooltip 等用它量尺寸
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// App.tsx 挂载时会开 SSE 连接。jsdom 没有 EventSource，
// 不补的话组件测试一律在 useEffect 里炸。这里给一个什么都不做的壳。
if (!globalThis.EventSource) {
  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

// CalendarHours 挂载时会调用 scrollIntoView 滚到默认小时——jsdom 没有实现
// 这个方法（不是「行为不对」，是压根不存在），不补的话每个渲染它的用例都会
// 在 useEffect 里炸（TypeError: ... is not a function），不限于真正想测滚动
// 那几条。默认给一个什么都不做的壳；CalendarHours.test.tsx 自己的滚动断言
// 会在用例内部把这个方法换成 vi.fn() 再测完还原，不依赖这里的实现细节。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
