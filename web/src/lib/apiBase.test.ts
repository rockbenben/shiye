import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 这个文件跑在 vitest 的 node 档（见根 vitest.config.ts：`*.test.ts` 归 node，
 * `*.test.tsx` 才归 jsdom）——node 没有 `window`，而 `@capacitor/preferences`
 * 的 web 回退（`PreferencesWeb`）内部直接读裸的 `window.localStorage`
 * （`node_modules/@capacitor/preferences/dist/esm/web.js`），在这个环境里调用
 * 会抛 `ReferenceError: window is not defined`。真机上不会遇到这个问题（原生
 * Android 有真的桥，桌面浏览器/Electron 有真的 window）——这纯粹是「node 测试
 * 环境本来就没有 DOM」这件事，不是 apiBase.ts 或 Preferences 插件的 bug。
 *
 * 所以这里把 `@capacitor/preferences` 整个 mock 掉，只测 apiBase.ts 自己那份
 * 逻辑（内存缓存的同步读写、末尾斜杠归一化、`apiBaseReady()` 等真正加载完）。
 * mock 掉之后「setApiBase 真的落盘了」这件事这个文件测不出来——**这就是
 * ServerSetup.test.tsx 那组「不 mock，用 jsdom 真的 window.localStorage」测试
 * 存在的理由**，两个文件分别覆盖「逻辑对不对」和「接线接没接上真的存储」。
 */

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.has(key) ? store.get(key)! : null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { store.set(key, value); }),
  },
}));

// apiBase.ts 模块加载时就发起一次 Preferences.get()（见它自己的注释），这个
// import 因此要放在上面 vi.mock 之后——vi.mock 是 hoisted 到文件顶部的，
// 顺序本身不影响正确性，这里按「先声明依赖的 mock，再 import 真正要测的东西」
// 的顺序写只是为了读起来顺。
import { getApiBase, setApiBase, apiBaseReady } from './apiBase.js';

describe('apiBase：没配过 base（store 是空的，等同第一次启动/桌面）', () => {
  beforeEach(async () => {
    // 模块只加载一次（ensureLoaded() 只发起一次真正的读取），每条测试开始前
    // 显式清空内存缓存回到「没配过」的状态——不这样做的话，前一条测试
    // setApiBase() 留下的值会经内存缓存漏到下一条测试里。
    setApiBase('');
    store.clear();
  });

  it('apiBaseReady() 落定之后，getApiBase() 是空字符串', async () => {
    await apiBaseReady();
    expect(getApiBase()).toBe('');
  });
});

describe('apiBase：setApiBase / getApiBase 的同步读写', () => {
  beforeEach(() => {
    setApiBase('');
    store.clear();
  });

  it('setApiBase 存入之后，getApiBase 立刻（不用 await）原样读回——api.ts 的 req/subscribe/attachmentUrl 全是同步调用', () => {
    setApiBase('http://192.168.1.5:30035');
    expect(getApiBase()).toBe('http://192.168.1.5:30035');
  });

  it('末尾单个斜杠被归一化掉——用户很可能填成 http://192.168.1.5:30035/', () => {
    setApiBase('http://192.168.1.5:30035/');
    expect(getApiBase()).toBe('http://192.168.1.5:30035');
  });

  it('末尾多个斜杠也被归一化掉，不是只处理一个', () => {
    setApiBase('http://192.168.1.5:30035///');
    expect(getApiBase()).toBe('http://192.168.1.5:30035');
  });

  it('前后空白被 trim 掉', () => {
    setApiBase('  http://192.168.1.5:30035  ');
    expect(getApiBase()).toBe('http://192.168.1.5:30035');
  });

  it('setApiBase("") 清空已经存过的 base，getApiBase 回到空字符串', () => {
    setApiBase('http://192.168.1.5:30035');
    expect(getApiBase()).toBe('http://192.168.1.5:30035');

    setApiBase('');
    expect(getApiBase()).toBe('');
  });

  it('setApiBase 真的调用了 Preferences.set（不是只更新内存缓存，落盘这一步真的发生了）', async () => {
    const { Preferences } = await import('@capacitor/preferences');
    setApiBase('http://192.168.1.5:30035');
    // Preferences.set() 是 fire-and-forget（见 apiBase.ts 的注释：调用方不需要
    // 等它），这里等一拍让那个微任务跑完，再断言 mock 真的被调用过、参数对。
    await vi.waitFor(() => expect(Preferences.set).toHaveBeenCalledWith({ key: 'apiBase', value: 'http://192.168.1.5:30035' }));
  });
});

describe('apiBase：冷启动——apiBaseReady() 等的是真正持久化过的值，不是内存缓存的初值', () => {
  afterEach(() => {
    store.clear();
  });

  it('store 里已经有「上次会话」存过的值时，重新加载模块之后 apiBaseReady() 落定，getApiBase() 能读到它', async () => {
    // 直接往 store 里塞值、不经过 setApiBase()——这里测的是「加载」这条路
    // （冷启动读到已经持久化过的东西），不是「刚写的马上能读到」那条路（上面
    // 「同步读写」那组测的是那个）。
    //
    // apiBase.ts 的 ensureLoaded() 只在模块加载时发起一次读取，这个文件顶部
    // 的 `import { getApiBase, ... } from './apiBase.js'` 早就跑过那一次了
    // （当时 store 还是空的）——要测「冷启动读到值」必须让模块重新加载一遍，
    // `vi.resetModules()` + 动态 `import()` 换一份全新的模块实例（新的内存
    // 缓存、新的 ensureLoaded() promise），这份新实例才会在 store 已经有值
    // 之后才第一次调用 Preferences.get()。
    store.set('apiBase', 'http://192.168.1.9:30035');
    vi.resetModules();
    const fresh = await import('./apiBase.js');

    await fresh.apiBaseReady();
    expect(fresh.getApiBase()).toBe('http://192.168.1.9:30035');
  });
});
