import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiReadiness, commandExists } from './aiStatus.js';
import { DEFAULT_SETTINGS, type Settings } from './model.js';

const base = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('AI 可用性检查：只读，不启动 CLI', () => {
  it('能认出绝对路径上的可执行文件，也能认出不存在的那一个', () => {
    expect(commandExists(process.execPath)).toBe(true);
    expect(commandExists('definitely-not-installed-shiye-cli')).toBe(false);
  });

  it('Windows 上 .cmd/.bat 和目录不算 ready——spawn 不带 shell 根本起不来，检查不能撒谎', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shiye-cli-check-'));
    try {
      const cmd = join(dir, 'fake-cli.cmd');
      writeFileSync(cmd, '@echo off\r\n', 'utf8');
      expect(commandExists(cmd, { platform: 'win32' })).toBe(false);
      // 只靠 PATH 找到的裸命令也不会被 libuv 解析成 .cmd。
      expect(commandExists('fake-cli', { platform: 'win32', env: { PATH: dir } })).toBe(false);
      const folder = join(dir, 'fake-dir');
      mkdirSync(folder);
      expect(commandExists(folder, { platform: 'win32' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('本机命令行：自定义路径指向真实文件时 ready', () => {
    const out = aiReadiness(base({
      aiMode: 'cli',
      aiCli: 'custom',
      aiCliPath: process.execPath,
    }));
    expect(out).toMatchObject({ mode: 'cli', ready: true });
  });

  it('本机命令行：路径不存在时给出原因，不抛异常', () => {
    const out = aiReadiness(base({
      aiMode: 'cli',
      aiCli: 'custom',
      aiCliPath: 'C:/definitely/not/here/shiye-cli',
    }));
    expect(out.ready).toBe(false);
    expect(out.reason).toContain('没找到');
  });

  it('调接口：缺地址或模型就不算 ready，原因跟真正发请求那一侧同一句', () => {
    const missingModel = aiReadiness(base({
      aiMode: 'api',
      aiEndpointId: 'x',
      aiEndpoints: { x: { baseUrl: 'https://example.test/v1', model: '', key: 'sk-test' } },
    }));
    expect(missingModel.ready).toBe(false);
    expect(missingModel.reason).toContain('模型名还没填');

    const notSelected = aiReadiness(base({ aiMode: 'api', aiEndpointId: 'none', aiEndpoints: {} }));
    expect(notSelected.ready).toBe(false);
    expect(notSelected.reason).toContain('接口地址还没填');
  });

  it('调接口：不要钥匙的本机服务也算 ready——密钥不是必填', () => {
    const out = aiReadiness(base({
      aiMode: 'api',
      aiEndpointId: 'local',
      aiEndpoints: { local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', key: '' } },
    }));
    expect(out).toMatchObject({ mode: 'api', ready: true });
  });

  it('调接口：密钥里带中文/空格照样不算 ready——HTTP 头会直接抛', () => {
    const out = aiReadiness(base({
      aiMode: 'api',
      aiEndpointId: 'x',
      aiEndpoints: { x: { baseUrl: 'https://example.test/v1', model: 'm', key: 'sk 测试' } },
    }));
    expect(out.ready).toBe(false);
    expect(out.reason).toContain('密钥里');
  });
});
