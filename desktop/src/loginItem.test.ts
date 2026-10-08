import { describe, expect, it } from 'vitest';
import {
  HIDDEN_FLAG,
  loginItemReadOptions,
  loginItemWrite,
  shouldOpenHidden,
  supportsLoginItem,
} from './loginItem.js';

/**
 * 开机自启的判断表。这里测的全是「纯的」那四件事：能不能开、写出去什么形状、
 * 读回来要配什么参数、这一次启动算不算开机那一次。main.ts 里剩下的只是
 * 把这几件接到 Electron 的 API 上，那边由 main.test.ts 用假 app 盯。
 */
describe('supportsLoginItem：哪些形态能摆这颗勾', () => {
  it('打包的 Windows 和 macOS 都行——官方两条 API 就标了这两个平台', () => {
    expect(supportsLoginItem('win32', true)).toBe(true);
    expect(supportsLoginItem('darwin', true)).toBe(true);
  });

  it('Linux 不行：AppImage 那一份没有登录项可写，摆了就是颗点不动的勾', () => {
    expect(supportsLoginItem('linux', true)).toBe(false);
  });

  // 这条是「未打包」那一半门的唯一证人：少了它，dev 形态（`process.execPath`
  // 是 node_modules/electron/dist/electron.exe）勾一下就把 Electron 本体注册成
  // 登录项，而且界面上看不出来注册的是什么。
  it('未打包一律不行，哪怕平台是 Windows：那会把 Electron 本体注册成登录项', () => {
    expect(supportsLoginItem('win32', false)).toBe(false);
    expect(supportsLoginItem('darwin', false)).toBe(false);
  });
});

describe('loginItemWrite：写进系统的那份参数', () => {
  // 逐字钉：这个字面量是要进注册表 Run 键的，界面上看不见，漂了只能靠下次
  // 开机才发现「窗口又摊开了」。
  it('旗标就叫 --hidden', () => {
    expect(HIDDEN_FLAG).toBe('--hidden');
  });

  it('Windows 开：带上 --hidden，开机那一次才知道不要窗口', () => {
    expect(loginItemWrite(true, 'win32')).toEqual({ openAtLogin: true, args: ['--hidden'] });
  });

  it('Windows 关：args 给空数组，不能把 --hidden 一个人留在那儿', () => {
    expect(loginItemWrite(false, 'win32')).toEqual({ openAtLogin: false, args: [] });
  });

  // mac 的 `Settings.args` 官方标 @platform win32：写了不报错，是被忽略。
  // 忽略掉一份参数和「这份参数传不进去」是两回事——后者是事实，前者会让人
  // 以为 mac 也靠 argv 认开机那次。所以这边一个字都不多写。
  it('macOS：不带 args，那份参数在这边传不进去', () => {
    expect(loginItemWrite(true, 'darwin')).toEqual({ openAtLogin: true });
    expect(loginItemWrite(false, 'darwin')).toEqual({ openAtLogin: false });
  });
});

describe('loginItemReadOptions：读回来时得配同样的参数', () => {
  /**
   * **这条是整份文件里最容易被随手改坏的一处。** Windows 上 `openAtLogin`
   * 是拿注册表里的值和「execPath + 你传的 args」逐字比出来的：写的时候带
   * `--hidden`、读的时候不带，就永远读出 false——菜单上那颗勾自己弹回去，
   * 注册表里那条却还在，下次开机照样拉起应用。
   *
   * 所以钉的不是「读的时候带什么」，而是**两边必须一样**。改一头忘另一头，
   * 这条立刻红。
   */
  it('Windows 读写两边的 args 一模一样', () => {
    expect(loginItemReadOptions('win32').args).toEqual(loginItemWrite(true, 'win32').args);
  });

  it('非 Windows 什么都不传（那边写的时候也没传 args）', () => {
    expect(loginItemReadOptions('darwin')).toEqual({});
    expect(loginItemReadOptions('linux')).toEqual({});
  });
});

describe('shouldOpenHidden：这一次启动是不是开机那一次', () => {
  it('argv 里有 --hidden 就藏起来，混在协议参数里也算', () => {
    expect(shouldOpenHidden(['C:\\app.exe', '--hidden'], false)).toBe(true);
    expect(shouldOpenHidden(['C:\\app.exe', 'todo-desktop://complete?id=1', '--hidden'], false)).toBe(true);
  });

  it('没有 --hidden 就不藏（手动双击、从开始菜单启动都走这条）', () => {
    expect(shouldOpenHidden(['C:\\app.exe'], false)).toBe(false);
  });

  // 整词相等，不是子串。这条断言存在的理由和 main.test.ts 里 `?client=desktop`
  // 那条一样：`--hiddenish` / `x--hidden` 从子串匹配下面溜得过去，而它们不是
  // 开机那一次，窗口该露出来。
  it('长得像的不算：--hiddenish、x--hidden 都不碰', () => {
    expect(shouldOpenHidden(['C:\\app.exe', '--hiddenish'], false)).toBe(false);
    expect(shouldOpenHidden(['C:\\app.exe', 'x--hidden'], false)).toBe(false);
  });

  // macOS 的参数传不进去，那边靠 wasOpenedAtLogin 认；Windows 上这个字段按
  // 文档恒为 false，所以两个条件不会互相掩盖。
  it('macOS 那条路：wasOpenedAtLogin 为真也藏', () => {
    expect(shouldOpenHidden(['/Applications/办事师爷.app'], true)).toBe(true);
  });
});
