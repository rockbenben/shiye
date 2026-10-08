import { describe, it, expect } from 'vitest';
import type { AiEndpoint, Settings } from '../types.js';
import { aiBlockedReason } from './aiReady.js';

/** 只填 AI 那几项，别的键用 `as` 抹掉——本函数只读 AI 那几项。 */
const cfg = (o: Partial<Settings>): Settings => o as Settings;

describe('aiBlockedReason', () => {
  it('命令行模式一律放行——CLI 在不在 PATH 上浏览器这一侧判不了', () => {
    // 服务端起子进程才知道它装没装。在这里按「可能没装」灰掉按钮，是拿一条
    // 不确定的判据去挡一条确定能试的路。
    expect(aiBlockedReason(cfg({ aiMode: 'cli', aiCli: 'claude' }), false)).toBeNull();
    expect(aiBlockedReason(cfg({ aiMode: 'cli', aiCli: 'custom', aiCliPath: '' }), false)).toBeNull();
  });

  /** 一家配齐了的记录，`api()` 拿它做底再改个别字段。 */
  const full: AiEndpoint = { baseUrl: 'https://x/v1', key: 'sk-1', model: 'm' };
  const api = (over?: Partial<AiEndpoint>) =>
    cfg({ aiMode: 'api', aiEndpointId: 'x', aiEndpoints: { x: { ...full, ...over } } });

  it('接口模式三样配齐了才放行', () => {
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
