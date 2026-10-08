import type { LoginItemSettingsOptions, Settings } from 'electron';

/**
 * 开机自启的全部判断，纯函数——main.ts 只做接线（读一次系统状态、写一次、
 * 决定窗口开局露不露），跟 protocol.ts / updatePrefs.ts 同一个切法：
 * 「哪个平台能开」「开的时候往命令行里塞什么」「这次启动是不是开机那一次」
 * 全是能在 vitest 里跑真断言的事，不需要假的 Electron 运行时。
 */

/**
 * 「这次是开机拉起的那一次，别把窗口摊开」的旗标。
 *
 * **为什么靠参数而不是问系统「我是被登录项拉起来的吗」**：Electron 的
 * `getLoginItemSettings().wasOpenedAtLogin` 官方标的是 `@platform darwin`
 * （`node_modules/electron/electron.d.ts` 那个字段上面就写着），Windows 的
 * 登录项是注册表 `HKCU\...\Run` 里的一条「路径 + 参数」，系统启动时照原样
 * 执行，进程自己没有任何「我是登录项」的痕迹可读。所以 Windows 这边只能自己
 * 留话——参数就是那句话。
 *
 * 代价是这条旗标写进了注册表：**读的时候必须带上同一份参数**，否则
 * `openAtLogin` 会算成 false（见下面 readOptions 的注释）。这个成对关系由
 * `loginItem.test.ts` 钉着。
 */
export const HIDDEN_FLAG = '--hidden';

/**
 * 这一台机器上「开机自启」能不能做。两个条件各挡一类真事故：
 *
 * - **平台**：`setLoginItemSettings` / `getLoginItemSettings` 官方都只标
 *   `@platform darwin,win32`，Linux 那份 AppImage 没有这条路（要的是
 *   `.desktop`  autostart 那一套，Electron 不代劳）。宁可不给这一项，
 *   也不摆一个点了没反应的勾。
 * - **未打包形态**：没打包时 `process.execPath` 是
 *   `node_modules/electron/dist/electron.exe`，勾一下就把** Electron 本体**
 *   注册成登录项——开机拉起一个没有主程序的 Electron，而且没人知道是怎么来的。
 *   这一仓库的桌面版本来就禁止开发模式跑，但守卫不该依赖「没人会那么干」。
 */
export function supportsLoginItem(platform: NodeJS.Platform, isPackaged: boolean): boolean {
  return isPackaged && (platform === 'win32' || platform === 'darwin');
}

/**
 * 写登录项时给 `setLoginItemSettings` 的那份参数。
 *
 * **只在 Windows 上带 `args`**：那份实现在注册表里存的就是「可执行文件 +
 * 命令行参数」，传得进去；macOS 走 `SMAppService`，注册的是 App 本身，
 * `Settings.args` 官方标 `@platform win32`，在 mac 上写了也是被忽略——
 * 写进一份传不进去的参数，比不写更坏（读的人以为 mac 也靠它）。
 * mac 那边「这次是开机拉起的」靠 `wasOpenedAtLogin`，见 HIDDEN_FLAG 上面那段。
 *
 * 关掉时 `args` 给空数组：`openAtLogin: false` 会把那条注册表项整个删掉，
 * 参数这时候没有读者，给空数组是为了「关」这一份写出去的形状和读回来的一致。
 */
export function loginItemWrite(enabled: boolean, platform: NodeJS.Platform): Settings {
  if (platform !== 'win32') return { openAtLogin: enabled };
  return { openAtLogin: enabled, args: enabled ? [HIDDEN_FLAG] : [] };
}

/**
 * 读登录项时给 `getLoginItemSettings` 的那份参数。
 *
 * Electron 文档在 `getLoginItemSettings` 顶上写死了这条契约：「If you provided
 * `path` and `args` options to `app.setLoginItemSettings`, then you need to pass
 * the same arguments here for `openAtLogin` to be set correctly.」——Windows
 * 那边 `openAtLogin` 是拿注册表里存的值和「execPath + 你传的 args」**逐字比**
 * 出来的。漏了这一步不报错，表现是勾上之后菜单重开一次就自己弹回未勾，
 * 而注册表里那条明明还在、下次开机照样拉起。
 *
 * 所以这份参数和 loginItemWrite 里那份必须一模一样。`loginItem.test.ts` 有一条
 * 专门比对两边，改一边忘另一边会红。
 */
export function loginItemReadOptions(platform: NodeJS.Platform): LoginItemSettingsOptions {
  return platform === 'win32' ? { args: [HIDDEN_FLAG] } : {};
}

/**
 * 这一次启动要不要开局就不露面。
 *
 * `argv` 用**整词相等**判断，不是子串：`--hiddenish`、`x--hidden` 都不算。
 * 传进来了 `wasOpenedAtLogin` 这一半是为了 mac（那边参数传不进去），
 * Windows 上它按文档恒为 false，两个条件不会互相掩盖。
 *
 * 只在「开局」用一次：窗口之后从托盘点出来走 openWindow()，不看这里。
 */
export function shouldOpenHidden(argv: readonly string[], wasOpenedAtLogin: boolean): boolean {
  return argv.includes(HIDDEN_FLAG) || wasOpenedAtLogin;
}
