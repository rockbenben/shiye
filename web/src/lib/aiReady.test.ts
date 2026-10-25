import { describe, it, expect } from 'vitest';
import type { AiEndpoint, Settings } from '../types.js';
import { aiBlockedReason, apiMissingFields } from './aiReady.js';

/** 只填 AI 那几项，别的键用 `as` 抹掉——本函数只读 AI 那几项。 */
const cfg = (o: Partial<Settings>): Settings => o as Settings;

describe('aiBlockedReason', () => {
  it('命令行模式一律放行——CLI 在不在 PATH 上浏览器这一侧判不了', () => {
    // 服务端起子进程才知道它装没装。在这里按「可能没装」灰掉按钮，是拿一条
    // 不确定的判据去挡一条确定能试的路。
    expect(aiBlockedReason(cfg({ aiMode: 'cli', aiCli: 'claude' }), false)).toBeNull();
    expect(aiBlockedReason(cfg({ aiMode: 'cli', aiCli: 'custom', aiCliPath: '' }), false)).toBeNull();
  });

  /** 一家配齐了的记录，`api()` 拿它做底再改个别字段。
   *  用 `deepseek`（目录里的已知厂商，不是 `keyOptional`）当默认值——拿一个
   *  认不出的 id 当夹具的话，「缺密钥」那条判据根本不会被走到。 */
  const full: AiEndpoint = { baseUrl: 'https://x/v1', key: 'sk-1', model: 'm' };
  const api = (over?: Partial<AiEndpoint>) =>
    cfg({ aiMode: 'api', aiEndpointId: 'deepseek', aiEndpoints: { deepseek: { ...full, ...over } } });

  it('接口模式：已知要密钥的厂商，三样配齐了才放行', () => {
    expect(aiBlockedReason(api(), false)).toBeNull();
  });

  it('**缺哪几项就说哪几项**——只说「没配好」，他还得自己回去猜是哪一格空着', () => {
    const r = aiBlockedReason(api({ baseUrl: '', key: '', model: '' }), false);
    expect(r).toContain('接口地址');
    expect(r).toContain('密钥');
    expect(r).toContain('模型名');
    expect(r).toContain('设置'); // 得告诉他去哪儿
  });

  /**
   * **不要钥匙的本机服务不能拿密钥拦。** 这是 README 里明写的一条（Ollama /
   * LM Studio「不要密钥，留空」），也是服务端 `configProblem` 的判据；客户端
   * 拦在这儿的话，用户只能随便编一个字符串糊弄过去。
   */
  it('目录里标了 keyOptional 的一家（本机模型）：密钥留空照样放行', () => {
    const r = aiBlockedReason(cfg({
      aiMode: 'api',
      aiEndpointId: 'llm',
      aiEndpoints: { llm: { baseUrl: 'http://127.0.0.1:11434/v1', key: '', model: 'qwen' } },
    }), false);
    expect(r).toBeNull();
  });

  it('自定义/认不出的端点：不按密钥拦——客户端分不清它是不是自建网关', () => {
    const r = aiBlockedReason(cfg({
      aiMode: 'api',
      aiEndpointId: 'custom:192.168.1.9:8080',
      aiEndpoints: { 'custom:192.168.1.9:8080': { baseUrl: 'http://192.168.1.9:8080/v1', key: '', model: 'local' } },
    }), false);
    expect(r).toBeNull();
  });

  it('已知要密钥的厂商（DeepSeek）：缺密钥照样拦下', () => {
    expect(aiBlockedReason(api({ key: '' }), false)).toContain('密钥');
  });

  it('apiMissingFields 跟按钮共用同一份缺失项：云厂商缺密钥、本机模型不要求密钥', () => {
    expect(apiMissingFields(api({ key: '' }))).toEqual(['密钥']);
    expect(apiMissingFields(cfg({
      aiMode: 'api',
      aiEndpointId: 'llm',
      aiEndpoints: { llm: { baseUrl: 'http://127.0.0.1:11434/v1', key: '', model: 'qwen' } },
    }))).toEqual([]);
  });

  /**
   * 「一家一把钥匙」的形状自己也得能报错：id 指着一条不存在的记录（删掉了、
   * 或者文件被手改过）等同于没选，不能因为「表里有别家配好了」就放行——
   * 发出去会拿那条不存在的配置撞一次失败。
   */
  it('选中的 id 在表里没有 = 没配', () => {
    const r = aiBlockedReason(cfg({ aiMode: 'api', aiEndpointId: '没有的这一家', aiEndpoints: { x: full } }), false);
    expect(r).toContain('接口地址');
  });

  it('表里一家都没配过 = 没配', () => {
    expect(aiBlockedReason(cfg({ aiMode: 'api', aiEndpointId: '', aiEndpoints: {} }), false)).toContain('接口地址');
  });

  it('**打码的密钥算「填过了」**——GET 回来的永远是 `••••` 加后四位，拿它判空是对的非空即真值存在', () => {
    // 这条是本函数最容易写错的一处：`key` 从来不是真值，非空即「服务端给这一家存着」。
    expect(aiBlockedReason(api({ key: '••••abcd' }), false)).toBeNull();
  });

  it('**空格不算填了**——一个空格过了 trim 就是空串，那一格等于没填', () => {
    const r = aiBlockedReason(api({ baseUrl: '   ', key: '  ', model: '\t' }), false);
    expect(r).toContain('接口地址');
  });

  it('设置还没读到时也给一句话，而不是当成「配好了」放行', () => {
    // tasks 有三档「读没读到」（firstRun.ts 那三句），AI 配置这里也有一档。
    // 把 null 当 ready 会让按钮在最该灰的那一小段时间里亮着。
    expect(aiBlockedReason(null, false)).toContain('设置');
  });

  it('**离线的因果更硬，排第一**——两条同时成立时先说这条，它的下一步跟设置无关', () => {
    const r = aiBlockedReason(null, true);
    expect(r).toContain('连不上');
    expect(r).not.toContain('设置');
  });
});
