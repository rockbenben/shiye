/**
 * 桌面自动更新的状态机。依赖全部从外面递进来（autoUpdater / 托盘气泡 /
 * 定时器 / 偏好），这个文件本体不 import electron——main.ts 负责造真的，
 * 测试负责造假的。
 *
 * 两条纪律（spec §2，整块设计的承重墙）：
 * - **下载自动、安装绝不自作**：`update-downloaded` 之后只亮菜单、打气，
 *   `quitAndInstall` 唯一的调用入口是用户点「重启以完成更新」。main.ts 里
 *   还会显式设 `autoInstallOnAppQuit = false`，堵掉 electron-updater 默认
 *   「用户正常退出时顺手装」的那条后门。
 * - 失败分级：定时路静默留痕、下轮自愈；手动路必须出声。
 */
export type UpdaterState = 'idle' | 'checking' | 'downloading' | 'ready';

export interface UpdaterApi {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, cb: (arg?: unknown) => void): void;
}

export interface UpdaterHooks {
  log(msg: string): void;
  balloon(title: string, body: string): void;
  showError(msg: string): void;
  setTimer(cb: () => void, ms: number): void;
  readAutoCheck(): boolean;
  writeAutoCheck(v: boolean): void;
  onChange(): void;
}

const FIRST_DELAY_MS = 60_000;
const EVERY_MS = 24 * 60 * 60 * 1000;

// main.ts 存的那一个实例的类型：不导出它，那边就得写 ReturnType<typeof
// createUpdater> 或者退到 any。
export type Updater = ReturnType<typeof createUpdater>;

export function createUpdater(api: UpdaterApi, hooks: UpdaterHooks) {
  let state: UpdaterState = 'idle';
  let versionReady: string | null = null;
  let lastTrigger: 'auto' | 'manual' = 'auto';
  let autoArmed = false;
  // 本轮检查发起时是不是 ready——error / update-not-available 靠它决定退回哪。
  // 没有它，「下好了没点重启 → 又查了一轮 → 那轮失败」会把已下好的更新从
  // 托盘菜单里凭空藏掉（冒烟清单排演的正是被忽略的气泡那条路）。
  let readyBeforeCheck = false;
  const setState = (s: UpdaterState) => { state = s; hooks.onChange(); };

  const check = (via: 'auto' | 'manual') => {
    if (state === 'checking' || state === 'downloading') return; // 不叠第二轮
    lastTrigger = via;
    readyBeforeCheck = state === 'ready';
    setState('checking');
    api.checkForUpdates().catch(() => { /* 失败以 error 事件为准分型，这条 promise 只是引信 */ });
  };

  api.on('update-available', (info) => {
    const version = (info as { version?: string })?.version ?? '';
    hooks.log(`发现新版本 ${version}，开始后台下载`);
    setState('downloading');
  });
  api.on('update-not-available', () => {
    // 只有这一轮真在跑时才归位（和 error 同一条纪律）：从 ready 出发的查了个
    // 「无更新」退回 ready，磁盘上那份还在；无活动轮次时的自发事件不动状态。
    if (state === 'checking' || state === 'downloading') setState(readyBeforeCheck ? 'ready' : 'idle');
    if (lastTrigger === 'manual') hooks.showError('已是最新版本');
  });
  api.on('update-downloaded', (info) => {
    versionReady = (info as { version?: string })?.version ?? '新版本';
    setState('ready');
    // 「不会自己重启」这句要出现在用户刚看到消息的那一刻，不是等他出事再来猜。
    hooks.balloon('办事师爷有新版本了', `v${versionReady} 已下载好，托盘点「重启以完成更新」生效。不会自己重启。`);
  });
  api.on('error', (err) => {
    const msg = (err as { message?: string })?.message ?? '未知错误';
    // 只有「正有一轮检查/下载在跑」时才归位，且回到这轮发起前的状态：从
    // ready 出发的轮次查失败要退回 ready（磁盘上那份还在），不能让托盘菜单
    // 里「重启以完成更新」凭空消失。idle/ready 状态下的迟到 error 不动 state。
    if (state === 'checking' || state === 'downloading') setState(readyBeforeCheck ? 'ready' : 'idle');
    if (lastTrigger === 'auto') hooks.log(`自动检查更新没成功（下一轮自愈）：${msg}`);
    else hooks.showError(`检查更新没成功：${msg}`);
  });

  const tick = () => {
    // 每一轮到点先重读偏好：中途关掉，当前这条排着的队到点就自己哑掉。
    if (hooks.readAutoCheck()) check('auto');
    hooks.setTimer(tick, EVERY_MS);
  };

  // 「只上一道锁」这件事有两条路要走（启动时的 scheduleAuto、网页上刚打开开关），
  // 共用这一个函数，两条路的「已上锁」判据才不会写岔。
  const armOnce = () => {
    if (!autoArmed) { autoArmed = true; hooks.setTimer(tick, FIRST_DELAY_MS); }
  };

  return {
    state: () => state,
    versionReady: () => versionReady,
    checkManual: () => check('manual'),
    scheduleAuto: () => {
      if (!hooks.readAutoCheck()) return;
      armOnce();
    },
    setAutoCheck: (v: boolean) => {
      hooks.writeAutoCheck(v);
      if (v) armOnce();
      hooks.onChange();
    },
    restartToInstall: () => {
      if (state !== 'ready') { hooks.showError('还没有下载好的更新——下好了这里会亮起来'); return; }
      api.quitAndInstall(); // 走现有 before-quit：quitting 置位 → child.stop()，不留文件占用
    },
  };
}
