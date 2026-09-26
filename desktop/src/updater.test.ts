import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdater, type UpdaterApi, type UpdaterHooks } from './updater.js';

// 假 autoUpdater：事件表驱动 + 记录调用。
const makeApi = () => {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const api: UpdaterApi = {
    autoDownload: true, autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    on: (ev, cb) => { (handlers[ev] ??= []).push(cb); },
  };
  return { api, fire: (ev: string, arg?: unknown) => handlers[ev]?.forEach((h) => h(arg)), calls: api };
};
const makeHooks = () => {
  const timers: { cb: () => void; ms: number }[] = [];
  const calls: { balloon: unknown[]; errors: string[]; changes: string[] } = { balloon: [], errors: [], changes: [] };
  let autoCheck = false;
  const hooks: UpdaterHooks = {
    log: () => {},
    balloon: (t, b) => { calls.balloon.push([t, b]); },
    showError: (m) => { calls.errors.push(m); },
    setTimer: (cb, ms) => { timers.push({ cb, ms }); },
    readAutoCheck: () => autoCheck,
    writeAutoCheck: (v) => { autoCheck = v; },
    onChange: () => { calls.changes.push('change'); },
  };
  return { hooks, timers, calls, setAuto: (v: boolean) => { autoCheck = v; } };
};

describe('updater 状态机', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.advanceTimersByTime(0); });

  it('scheduleAuto：开了自动检查才有 60s 首查（D1 关着时定时路整个不跑）', () => {
    const off = makeHooks();
    createUpdater(makeApi().api, off.hooks).scheduleAuto();
    expect(off.timers).toHaveLength(0);
    const on = makeHooks(); on.setAuto(true);
    createUpdater(makeApi().api, on.hooks).scheduleAuto();
    expect(on.timers[0]?.ms).toBe(60_000);
  });

  it('定时首查触发 checkForUpdates，之后按 24h 续排', () => {
    const { api } = makeApi(); const { hooks, timers, setAuto } = makeHooks();
    setAuto(true);
    createUpdater(api, hooks).scheduleAuto();
    expect(timers).toHaveLength(1);
    timers[0].cb(); // 到点
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(2); // 自我续排
    expect(timers[1].ms).toBe(24 * 60 * 60 * 1000);
  });

  it('update-available 后自动下载（autoDownload 由 main 设 true，这里只走事件）；downloaded → ready + 气泡 + 版本进菜单，绝不自己 quitAndInstall', () => {
    const { api, fire } = makeApi(); const h = makeHooks();
    const u = createUpdater(api, h.hooks);
    fire('update-available', { version: '0.2.0' });
    expect(h.calls.changes.length).toBeGreaterThan(0);
    fire('update-downloaded', { version: '0.2.0' });
    expect(u.state()).toBe('ready');
    expect(u.versionReady()).toBe('0.2.0');
    expect(h.calls.balloon).toEqual([['办事师爷有新版本了', 'v0.2.0 已下载好，托盘点「重启以完成更新」生效。不会自己重启。']]);
    expect(api.quitAndInstall).not.toHaveBeenCalled();
  });

  it('重启更新只有用户点这条路；ready 之前点 = 一句人话，不碰安装', () => {
    const { api, fire } = makeApi(); const h = makeHooks();
    const u = createUpdater(api, h.hooks);
    u.restartToInstall();
    expect(api.quitAndInstall).not.toHaveBeenCalled();
    expect(h.calls.errors).toHaveLength(1);
    fire('update-downloaded', { version: '0.2.0' });
    u.restartToInstall();
    expect(api.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('定时检查失败静默（下轮自愈）；手动检查失败必须弹窗——点了没反应比报错更像坏了', () => {
    const { api, fire } = makeApi(); const h = makeHooks(); h.setAuto(true);
    const u = createUpdater(api, h.hooks);
    u.scheduleAuto();
    h.timers[0].cb(); // auto 一轮
    fire('error', { message: 'fetch 挂了' });
    expect(h.calls.errors).toHaveLength(0);
    u.checkManual();
    fire('error', { message: '连不上 GitHub' });
    expect(h.calls.errors).toEqual(['检查更新没成功：连不上 GitHub']);
  });

  it('checkManual 在 checking/downloading 中不叠第二次；无更新时手动报「已是最新」', () => {
    const { api, fire } = makeApi(); const h = makeHooks();
    const u = createUpdater(api, h.hooks);
    u.checkManual();
    u.checkManual();
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
    fire('update-not-available', {});
    expect(h.calls.errors).toEqual(['已是最新版本']);
    expect(u.state()).toBe('idle');
  });

  it('迟到的 error 不许把 ready 打回原形（下载好的更新不该被一句无关报错吞掉）', () => {
    const { api, fire } = makeApi(); const h = makeHooks();
    const u = createUpdater(api, h.hooks);
    fire('update-downloaded', { version: '0.2.0' });
    fire('error', { message: '后面的轮次连不上' });
    expect(u.state()).toBe('ready');
    expect(u.versionReady()).toBe('0.2.0');
    u.restartToInstall();
    expect(api.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // 终审 I7：ready 之后用户再点一次「检查更新」（或 24h 轮到）会先把状态推进
  // checking——这一轮不管 error 还是「无更新」，都必须退回 ready，而不是把
  // 已经躺在磁盘上的更新从菜单里藏掉。触发路径正是冒烟清单排演的：
  // 忽略气泡 → 演练 Release 删了 → 下轮检查报错。
  it('ready 挂着时再发起一轮检查：error 和「无更新」都不许弄丢下好的更新', () => {
    const { api, fire } = makeApi(); const h = makeHooks();
    const u = createUpdater(api, h.hooks);
    fire('update-downloaded', { version: '0.2.0' });
    u.checkManual(); // ready → checking
    fire('error', { message: '演练 Release 被删了' });
    expect(u.state()).toBe('ready');
    u.checkManual();
    fire('update-not-available', {});
    expect(u.state()).toBe('ready');
    expect(u.versionReady()).toBe('0.2.0');
    u.restartToInstall();
    expect(api.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('setAutoCheck：写偏好 + 关掉后当前这轮到点不再发起（读偏好那条路）', () => {
    const { api } = makeApi(); const h = makeHooks(); h.setAuto(true);
    const u = createUpdater(api, h.hooks);
    u.scheduleAuto();
    u.setAutoCheck(false);
    expect(h.timers[0] && true).toBe(true);
    h.timers[0].cb(); // 到点，但偏好已关——不该发 checkForUpdates
    expect(api.checkForUpdates).not.toHaveBeenCalled();
  });
});
