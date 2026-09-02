import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider, Input } from 'antd';
import { Preferences } from '@capacitor/preferences';
import {
  ServerSetup, testConnection, describeConnectionCheck, looksLikeOwnServer, CLIENT_API_VERSION,
  type ConnectionCheck,
} from './ServerSetup.js';
import { getApiBase, setApiBase } from '../lib/apiBase.js';
import { ink, theme as appTheme } from '../theme.js';
import { btnIn } from '../test-utils.js';

const health = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 这个文件跑在 dom 档（.test.tsx，见根 vitest.config.ts）——jsdom 有真的
// window/localStorage，@capacitor/preferences 的 web 回退（backed by
// window.localStorage）在这里能真的跑，不用像 apiBase.test.ts 那样 mock 掉。
// 每条测试之间清空，不让上一条测试存的地址漏到下一条。
beforeEach(() => {
  setApiBase('');
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('testConnection：三种失败原因 + 成功，判据的思路照抄 server/src/index.ts 的 alreadyOurs()（fetch 加超时、异常当连不上、json.ok!==true 当不是这个服务），只是拆成用户看得懂的四种结果', () => {
  it('unreachable：fetch 直接抛异常（网络错误/超时）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network fail'); }));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'unreachable' });
  });

  it('not-ours：连上了，但响应体不是 { ok: true, ... } 形状', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => health({ hello: 'world' })));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'not-ours' });
  });

  it('not-ours：连上了，body 是 ok:true，但 HTTP 状态码不是 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => health({ ok: true, version: CLIENT_API_VERSION }, 500)));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'not-ours' });
  });

  it('not-ours：响应体不是合法 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('不是 JSON', { status: 200 })));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'not-ours' });
  });

  it('version-mismatch：ok:true，但 version 跟这个 App 认的（CLIENT_API_VERSION）不一样', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => health({ ok: true, version: 999 })));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'version-mismatch', serverVersion: 999 });
  });

  it('ok：ok:true 且 version 匹配', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => health({ ok: true, version: CLIENT_API_VERSION })));
    expect(await testConnection('http://192.168.1.5:30035')).toEqual({ kind: 'ok' });
  });

  it('探的是 base + /api/health，不是别的路径', async () => {
    // vi.fn 不带参数类型标注会推出 0 元函数，.mock.calls[0] 是长度 0 的元组，
    // 取不到第 0 个元素——desktop/src/serverChild.test.ts 的 spawn() 也踩过
    // 同一个坑，同样用一个 rest 参数让 vi.fn 推出「不限参数个数」的签名。
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(health({ ok: true, version: CLIENT_API_VERSION })));
    vi.stubGlobal('fetch', fetchMock);
    await testConnection('http://192.168.1.5:30035');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://192.168.1.5:30035/api/health');
  });
});

describe('looksLikeOwnServer：dataSource.ts 的 probeOnline() 判断「连不连得上」用它', () => {
  it('ok 和 version-mismatch 都算「像自己的服务」——版本不对不代表这不是本机的办事师爷服务', () => {
    expect(looksLikeOwnServer({ kind: 'ok' })).toBe(true);
    expect(looksLikeOwnServer({ kind: 'version-mismatch', serverVersion: 2 })).toBe(true);
  });

  it('unreachable 和 not-ours 都不算', () => {
    expect(looksLikeOwnServer({ kind: 'unreachable' })).toBe(false);
    expect(looksLikeOwnServer({ kind: 'not-ours' })).toBe(false);
  });
});

describe('describeConnectionCheck：四种结果各自的文案不一样，不是同一句话套四个 kind', () => {
  const cases: ConnectionCheck[] = [
    { kind: 'ok' },
    { kind: 'unreachable' },
    { kind: 'not-ours' },
    { kind: 'version-mismatch', serverVersion: 2 },
  ];
  it('四种文案两两不同', () => {
    const texts = cases.map(describeConnectionCheck);
    expect(new Set(texts).size).toBe(cases.length);
  });
  it('version-mismatch 的文案里带着两边的版本号，不是一句笼统的话', () => {
    expect(describeConnectionCheck({ kind: 'version-mismatch', serverVersion: 7 })).toContain('7');
    expect(describeConnectionCheck({ kind: 'version-mismatch', serverVersion: 7 })).toContain(String(CLIENT_API_VERSION));
  });
});

describe('ServerSetup 组件', () => {
  it('初始值读的是 getApiBase()，不是空的（设置弹层重新打开这个组件要看到上次存的地址）', () => {
    setApiBase('http://192.168.1.7:30035');
    render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('http://192.168.1.7:30035');
  });

  it('打字会更新输入框（受控）', () => {
    render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    const input = screen.getByLabelText('服务地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://192.168.1.8:30035' } });
    expect(input.value).toBe('http://192.168.1.8:30035');
  });

  it('点「测试连接」：连不上时显示对应的失败文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fail'); }));
    render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://192.168.1.5:30035' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText(describeConnectionCheck({ kind: 'unreachable' }))).toBeDefined();
  });

  it('点「测试连接」：连上了、版本对，显示成功文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => health({ ok: true, version: CLIENT_API_VERSION })));
    render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://192.168.1.5:30035' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('连接成功。')).toBeDefined();
  });

  it('测试连接发的地址是输入框里的当前值（归一化过末尾斜杠），不是 getApiBase() 已经存的那个旧值', async () => {
    setApiBase('http://old:30035');
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(health({ ok: true, version: CLIENT_API_VERSION })));
    vi.stubGlobal('fetch', fetchMock);
    render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://new:30035/' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('http://new:30035/api/health');
  });

  it('点「保存」：调用 setApiBase 存下归一化过的地址，并且调用 onSaved', () => {
    const onSaved = vi.fn();
    const { container } = render(<AntApp><ServerSetup onSaved={onSaved} /></AntApp>);
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://192.168.1.5:30035/' } });
    // 没经过 main.tsx 的 ConfigProvider（关了 autoInsertSpace），「保存」会被
    // antd 插成「保 存」——按 test-utils.tsx 的 btnIn 去空白之后按文字找。
    fireEvent.click(btnIn(container, '保存'));
    expect(getApiBase()).toBe('http://192.168.1.5:30035');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

// 群青那件事：Input 的聚焦边框直接读全局 colorPrimary（theme.ts 顶部注释点名
// Input 没有组件级 token 能覆盖），theme.css 的前缀扫描守不到这个——照
// TaskCard.test.tsx/FilterBar.test.tsx 那套写法，渲染出来读实际的
// --ant-color-primary 自定义属性（antd 6 的 css-var 模式），先做对照组
// 证明这份夹具本身确实会读到群青，再证明 ServerSetup 内部套的
// boardLocalTheme 把它压回了 ink.you。
describe('ServerSetup：Input 的选中色不是群青', () => {
  it('对照：这份夹具本身确实会让裸 Input 读到群青——不是随手挑的主题恰好不是群青', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          <Input className="ink-server-probe" aria-label="探针" />
        </AntApp>
      </ConfigProvider>,
    );
    const el = container.querySelector('.ant-input') as HTMLElement;
    const primary = getComputedStyle(el).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.ai.toLowerCase());
  });

  it('ServerSetup 里的 Input 读到的 --ant-color-primary 是你的墨（ink.you），不是群青（ink.ai）', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp><ServerSetup onSaved={() => {}} /></AntApp>
      </ConfigProvider>,
    );
    const el = container.querySelector('.ant-input') as HTMLElement;
    expect(el).not.toBeNull();
    const primary = getComputedStyle(el).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.you.toLowerCase());
    expect(primary).not.toBe(ink.ai.toLowerCase());
  });
});

// 「mock 掉之后『真的存进去了』这件事就没人测了，得想别的办法」（task-3-brief
// 坑①）——apiBase.test.ts 跑在 node 档，把 @capacitor/preferences 整个 mock
// 掉了（node 没有 window，插件的 web 回退过不去）。这里是 dom 档，有真的
// window.localStorage，@capacitor/preferences 的 web 回退能真的跑：这两条
// 测试不 mock 它，走真实的插件代码路径，证明「存」和「读」两头都真的接上了
// 真实存储，不是只更新了 apiBase.ts 自己的内存缓存。
describe('ServerSetup：真的接到 @capacitor/preferences（不 mock，jsdom 有真的 window.localStorage）', () => {
  it('点「保存」之后，真的能从 Preferences.get() 读回来（证明写的是真实存储，不是只更新内存缓存）', async () => {
    const { container } = render(<AntApp><ServerSetup onSaved={() => {}} /></AntApp>);
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://192.168.1.5:30035' } });
    fireEvent.click(btnIn(container, '保存'));

    // apiBase.ts 的 setApiBase() 是 fire-and-forget（不等 Preferences.set()
    // 落盘），这里用 waitFor 等真正的插件调用链（含它内部第一次动态 import
    // web 实现那一趟）跑完。
    await waitFor(async () => {
      const r = await Preferences.get({ key: 'apiBase' });
      expect(r.value).toBe('http://192.168.1.5:30035');
    });
  });

  it('冷启动：localStorage 里已经有上次持久化过的值，重新加载 apiBase.ts 模块之后 getApiBase() 能读到它——证明「读」这一头接的也是真实存储，不是巧合读到内存缓存的初值', async () => {
    // 直接调真实的 Preferences.set()（不经过 setApiBase()，模拟「上一次会话
    // 已经存过、这是一次新的冷启动」），再用 vi.resetModules() + 动态
    // import() 换一份全新的 apiBase.ts 模块实例——只重新加载这一个纯函数
    // 模块（不掺 React/antd），不会有「新旧 React 实例混在一起」那类风险，
    // 跟 apiBase.test.ts 里同一条测试用的是同一个手法。
    await Preferences.set({ key: 'apiBase', value: 'http://192.168.1.9:30035' });
    vi.resetModules();
    const fresh = await import('../lib/apiBase.js');
    await fresh.apiBaseReady();
    expect(fresh.getApiBase()).toBe('http://192.168.1.9:30035');
  });
});
