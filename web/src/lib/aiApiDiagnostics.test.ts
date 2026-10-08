import { describe, it, expect } from 'vitest';
import { diagnoseApiError } from './aiApiDiagnostics.js';

describe('aiApiDiagnostics: 智能排查错误分析', () => {
  it('空错误或无错误返回 null', () => {
    expect(diagnoseApiError(null)).toBeNull();
    expect(diagnoseApiError('')).toBeNull();
    expect(diagnoseApiError('   ')).toBeNull();
  });

  it('识别 401 和密钥相关错误', () => {
    const r1 = diagnoseApiError('接口回了 401：Incorrect API key');
    expect(r1).not.toBeNull();
    expect(r1?.category).toBe('密钥异常');
    expect(r1?.suggestion).toContain('API Key');

    const r2 = diagnoseApiError('Unauthorized: invalid_api_key provided');
    expect(r2?.category).toBe('密钥异常');
  });

  it('识别 404 和端点地址问题', () => {
    const r = diagnoseApiError('404 Not Found: Cannot POST /chat/completions');
    expect(r?.category).toBe('接口地址不存在');
    expect(r?.suggestion).toContain('/v1');
  });

  it('识别 429 和额度/频次限制', () => {
    const r = diagnoseApiError('429 Rate limit exceeded / Insufficient quota');
    expect(r?.category).toBe('调用频次或配额超限');
    expect(r?.suggestion).toContain('配额');
  });

  it('识别模型不存在错误', () => {
    const r = diagnoseApiError('The model `gpt-99` does not exist');
    expect(r?.category).toBe('模型名不存在');
    expect(r?.suggestion).toContain('模型');
  });

  it('识别超时错误', () => {
    const r = diagnoseApiError('连 https://api.openai.com 超时了');
    expect(r?.category).toBe('连接超时');
  });

  it('识别本地服务连不上 (如 Ollama)', () => {
    const r = diagnoseApiError('连不上 http://127.0.0.1:11434/v1/chat/completions（fetch failed）');
    expect(r?.category).toBe('本地服务连接失败');
    expect(r?.suggestion).toContain('Ollama');
  });

  it('识别非法字符 (ByteString/中文)', () => {
    const r = diagnoseApiError('密钥里有中文、空格或者换行（粘贴的时候多半会带进来）');
    expect(r?.category).toBe('输入包含非法字符');
  });
});
