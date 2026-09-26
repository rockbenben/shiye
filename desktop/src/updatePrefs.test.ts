import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAutoCheck, saveAutoCheck } from './updatePrefs.js';

let dir: string; const file = () => join(dir, 'update-prefs.json');
const logs: string[] = []; const log = (m: string) => { logs.push(m); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shiye-prefs-')); logs.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('updatePrefs', () => {
  it('文件不存在 = 默认关（D1 拍板：不联网是默认，开是选择）', () => {
    expect(loadAutoCheck(file(), log)).toBe(false);
    expect(existsSync(file())).toBe(false); // 读不该顺手造文件
    expect(logs).toHaveLength(0); // ENOENT 是常态，不该 log
  });
  it('存 true 读回 true；再存 false 读回 false', () => {
    saveAutoCheck(file(), true, log);
    expect(loadAutoCheck(file(), log)).toBe(true);
    saveAutoCheck(file(), false, log);
    expect(loadAutoCheck(file(), log)).toBe(false);
  });
  it('文件坏了（不是 JSON / 形状不对）：落默认值、留下一句话，不抛', () => {
    writeFileSync(file(), '{不是json');
    expect(loadAutoCheck(file(), log)).toBe(false);
    expect(logs.join('\n')).toMatch(/update-prefs/);
    writeFileSync(file(), JSON.stringify({ autoCheck: 'yes' }));
    expect(loadAutoCheck(file(), log)).toBe(false);
  });
  it('写失败不抛（磁盘故障不该让托盘勾选炸掉应用）', () => {
    // 计划原文这里写的是「不存在的目录」——但实现里的 mkdirSync(recursive)
    // 本来就会把缺的目录建出来，那条路根本失败不了。要造一次真失败，让一个
    // **文件**挡在父路径上：对它建子目录必失败（errno 随平台而变，Windows
    // 实测 EEXIST、POSIX 一般 ENOTDIR——都不是 writeFileSync 那步的事），
    // save 整体走 catch 留话。这条验的是「失败只 log 不抛」，不押具体 errno。
    const blocker = join(dir, '挡路文件');
    writeFileSync(blocker, '我是一个文件，不是目录');
    saveAutoCheck(join(blocker, 'x.json'), true, log);
    expect(logs.join('\n')).toMatch(/update-prefs/);
  });
});
