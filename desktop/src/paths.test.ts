import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconPath, resolvePaths, type HostInfo } from './paths.js';

const dev: HostInfo = {
  isPackaged: false,
  resourcesPath: '/never-used-in-dev',
  userData: '/home/u/.config/todo',
  repoRoot: '/repo',
};
const packed: HostInfo = {
  isPackaged: true,
  resourcesPath: '/app/resources',
  userData: '/home/u/.config/todo',
  repoRoot: '/never-used-when-packed',
};

describe('resolvePaths：开发时跟启动.cmd 起出来的一样', () => {
  it('服务入口在仓库里', () => {
    expect(resolvePaths(dev, {}).serverEntry).toBe(join('/repo', 'server', 'dist', 'index.js'));
  });
  it('数据目录是仓库的 data/', () => {
    expect(resolvePaths(dev, {}).dataDir).toBe(join('/repo', 'data'));
  });
  it('AI 的工作目录是仓库根', () => {
    expect(resolvePaths(dev, {}).agentCwd).toBe('/repo');
  });
});

describe('resolvePaths：打包后', () => {
  it('服务入口在 extraResources 里，不在 asar 里——子进程要能 node 它', () => {
    const p = resolvePaths(packed, {}).serverEntry;
    expect(p).toBe(join('/app/resources', 'server', 'dist', 'index.js'));
    expect(p).not.toContain('asar');
  });
  it('数据目录在 <userData>/agent/data 下，不在安装目录里——安装目录可能没有写权限，升级还会被覆盖', () => {
    expect(resolvePaths(packed, {}).dataDir).toBe(join('/home/u/.config/todo', 'agent', 'data'));
  });
  // agentCwd 是 <userData>/agent，不是 userData 本身，也不是 resourcesPath：
  // userData 是 Electron 自己的 Chromium 配置目录（Cache/、Local Storage/、
  // Preferences、Cookies……），AI 带着 --permission-mode acceptEdits 的
  // Write/Edit/Bash 不该在那种目录里跑，所以隔出一个 agent/ 子目录。同时
  // dataDir 必须可写（不能是 resourcesPath），而 aiSeesSameData() 的不变量
  // 又要求 agentCwd 是 dataDir 的直接父目录——三条放一起，agentCwd 只能是
  // <userData>/agent。AGENTS.md/workflows/ 需要在启动时拷贝/同步进去
  // （Task 2 的事，见下面「不变量」那组测试）。
  it('AI 的工作目录是 <userData>/agent，不是 userData 本身——跟 Electron 的 Chromium 配置目录隔开', () => {
    expect(resolvePaths(packed, {}).agentCwd).toBe(join('/home/u/.config/todo', 'agent'));
  });
});

// 同步盘文件夹必须字面叫 "data"：server/src/store.ts 的 agentDataDir() 算的是
// join(AGENT_CWD, 'data')，末尾永远拼字面量 'data'。desktop 这边不管 agentCwd
// 算成什么，join(agentCwd, 'data') 的 basename 永远是 'data'——如果 DATA_DIR
// 指向一个叫别的名字的文件夹（比如 '/sync/todo-data'），resolve(dataDir) ===
// resolve(join(agentCwd, 'data')) 数学上就不可能成立，跟 desktop 这边怎么实现
// 无关。这是服务端现有实现摆在这里的硬约束（server/ 不许改），所以这里用
// '/sync/data'，不是随便挑的名字。
describe('resolvePaths：DATA_DIR 环境变量优先（WebDAV 那一批要靠它指到同步盘，文件夹必须字面叫 "data"）', () => {
  it('开发时也认', () => {
    const { dataDir, agentCwd } = resolvePaths(dev, { DATA_DIR: '/sync/data' });
    expect(dataDir).toBe('/sync/data');
    // agentCwd 得是 dataDir 的直接父目录本身，不能是别的什么也能让不变量
    // 测试碰巧过的值（比如 dataDir 自己）——单独钉一条，不然 '/sync/data/..'、
    // '/sync'、'/sync/x/..' 这几种产出在只看不变量的情况下是分不出来的。
    expect(agentCwd).toBe('/sync');
  });
  it('打包后也认', () => {
    const { dataDir, agentCwd } = resolvePaths(packed, { DATA_DIR: '/sync/data' });
    expect(dataDir).toBe('/sync/data');
    expect(agentCwd).toBe('/sync');
  });
  it('空字符串不算「设了」——`DATA_DIR=` 是没填，不是「用根目录」', () => {
    expect(resolvePaths(dev, { DATA_DIR: '' }).dataDir).toBe(join('/repo', 'data'));
  });
});

describe('resolvePaths：DATA_DIR 的 basename 必须字面叫 "data"（大小写敏感）', () => {
  // agentDataDir()（server/src/store.ts）写死了 join(AGENT_CWD, 'data')：叫别的
  // 名字，不管 desktop 这边怎么算 agentCwd，不变量都不可能成立——与其把这份
  // 注定被拒的配置传给 Task 2（服务启动后才会间接发现），不如在这里直接抛错。
  it('basename 不是 data 就抛错，抛之前不该返回一份注定被拒的配置', () => {
    expect(() => resolvePaths(dev, { DATA_DIR: '/sync/todo-data' })).toThrow(/data/);
  });
  it('大小写不同也不行——字符串比较区分大小写，"Data" ≠ "data"', () => {
    expect(() => resolvePaths(dev, { DATA_DIR: '/sync/Data' })).toThrow();
  });
  it('错误消息说清为什么，不是甩一句「不对」', () => {
    expect(() => resolvePaths(packed, { DATA_DIR: '/sync/todo-data' })).toThrow(/agentDataDir/);
  });
});

describe('resolvePaths：env 参数默认取 process.env——Task 2 大概率靠这个默认值接用户设的 DATA_DIR', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('不传 env 时读的是真的 process.env.DATA_DIR，不是空对象', () => {
    vi.stubEnv('DATA_DIR', '/sync/data');
    expect(resolvePaths(dev).dataDir).toBe('/sync/data');
  });
});

// —— 这一组是这个 Task 最要紧的：写错了 AI 拆解会被服务端的守卫拒掉 ——
describe('aiSeesSameData() 的不变量：agentCwd 必须是 dataDir 的父目录', () => {
  // server/src/store.ts 的 `aiSeesSameData()` 比的是 resolve(DATA_DIR) === resolve(AGENT_CWD + '/data')。
  // 对不上的话 expand.ts 里 `!aiSeesSameData()` 那道闸会拒绝 spawn AI，经 emitAgentStatus 推一条
  // state: 'failed' 的消息（SSE 推成红横幅）——不是「静默拒绝」，只是消息对着
  // 两个路径念一遍，普通用户未必看得懂该往哪改。
  it.each([
    ['开发', dev, {}],
    ['打包', packed, {}],
    ['开发 + DATA_DIR', dev, { DATA_DIR: '/sync/data' }],
    ['打包 + DATA_DIR', packed, { DATA_DIR: '/sync/data' }],
  ])('%s', (_name, host, env) => {
    const { dataDir, agentCwd } = resolvePaths(host as HostInfo, env);
    expect(resolve(dataDir)).toBe(resolve(join(agentCwd, 'data')));
  });
});

describe('iconPath：开发模式下也要指到真实存在的那个文件', () => {
  // 这条断言打在**真实仓库布局**上，不是在字符串上比来比去——原来那个 bug
  // （用 app.getAppPath() 拼，开发模式下多一层 dist/）正是「字符串看着对、
  // 文件不在那儿」。所以这里必须 existsSync 真去摸一下磁盘。
  it('desktop/dist 往上一级的 build/icon.png 真的在', () => {
    const distDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
    expect(existsSync(iconPath(distDir))).toBe(true);
  });

  // 上限方向：别写成「随便给什么都返回一个存在的路径」。
  it('给一个不相干的目录，算出来的路径不存在', () => {
    expect(existsSync(iconPath('/definitely/not/here/dist'))).toBe(false);
  });
});
