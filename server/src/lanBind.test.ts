import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAN_WARNING, logLanWarningIfNeeded, resolveBindHost } from './lanBind.js';

describe('resolveBindHost', () => {
  it('不设 LAN 就是 127.0.0.1 —— 上限断言：默认不变', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('LAN=1 才是 0.0.0.0', () => {
    expect(resolveBindHost({ LAN: '1' })).toBe('0.0.0.0');
  });

  it('只认字面量 "1"，别的值（哪怕看起来像开）都不算', () => {
    expect(resolveBindHost({ LAN: 'true' })).toBe('127.0.0.1');
    expect(resolveBindHost({ LAN: 'yes' })).toBe('127.0.0.1');
    expect(resolveBindHost({ LAN: '0' })).toBe('127.0.0.1');
    expect(resolveBindHost({ LAN: '' })).toBe('127.0.0.1');
  });
});

describe('logLanWarningIfNeeded', () => {
  it('绑了 0.0.0.0 就打印醒目提示', () => {
    const log = vi.fn();
    logLanWarningIfNeeded('0.0.0.0', log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(LAN_WARNING);
  });

  it('还是 127.0.0.1 就什么都不打印', () => {
    const log = vi.fn();
    logLanWarningIfNeeded('127.0.0.1', log);
    expect(log).not.toHaveBeenCalled();
  });

  it('提示原文说清三件事：同一个 Wi-Fi 下任何设备都能读写、没有认证、别在公共 Wi-Fi 上开', () => {
    expect(LAN_WARNING).toMatch(/Wi-Fi/);
    expect(LAN_WARNING).toMatch(/读写/);
    expect(LAN_WARNING).toMatch(/没有任何认证/);
    expect(LAN_WARNING).toMatch(/公共 Wi-Fi/);
  });

  it('提示原文还说清另外两件事：能烧订阅额度、webhook 改掉之后关 LAN 也收不回来（final-review.md I1/I2）', () => {
    expect(LAN_WARNING).toMatch(/订阅额度/);
    expect(LAN_WARNING).toMatch(/webhook/);
    expect(LAN_WARNING).toMatch(/不会自己恢复/);
  });

  /**
   * **AI 接口地址是第二条「改了就一直漏」的字段**，跟 webhook 同一个形状，而且
   * 漏得更多：webhook 每次只发一条任务的原文，接口地址一改，**每次拆解都会把
   * 整个收件箱原文加全部任务**当提示词发过去（`aiApi.ts` 的 buildMessages）。
   *
   * 密钥那一格反过来是安全的——`GET /api/settings` 只回打码后的形状，读不走；
   * 但**写**得进去，而写进去的人真正想改的多半是地址那一格。
   */
  it('提示原文说清 AI 接口地址被改掉的后果（这一格是后加的，漏了等于新开了一条外泄路径）', () => {
    expect(LAN_WARNING).toMatch(/AI 接口地址/);
    expect(LAN_WARNING).toMatch(/收件箱原文和全部任务/);
  });

  /**
   * **`android/冒烟清单.md` 把这句话逐字抄了一遍，两边必须一字不差。**
   *
   * 那份清单第 0 步写着「**看到这条提示才算真的开了局域网模式**」——它是让人拿着
   * 屏幕上的字去对的。对不上的时候，照着做的人不知道是自己 `.env` 写错了、还是
   * 文档过期了，而这一步的结论直接决定「要不要往下走」。
   *
   * 已经飘过一次：`LAN_WARNING` 里加上「和回顾」（回顾也会烧订阅额度，那一批把它
   * 从一条终端命令改成了按钮）之后，清单那份没跟上。
   *
   * 引用是 markdown 折行的（四行 `> `），所以先把 `> ` 去掉、按行拼回去再比：
   * 中文折行不补空格，直接接起来就是原文。
   */
  it('冒烟清单里抄的那份跟 LAN_WARNING 一字不差', () => {
    const md = readFileSync('android/冒烟清单.md', 'utf8');
    const quotes: string[] = [];
    let cur: string[] = [];
    for (const line of md.split(String.fromCharCode(10)).map((l) => l.replace(String.fromCharCode(13), ''))) {
      if (line.startsWith('> ')) cur.push(line.slice(2));
      else { if (cur.length) quotes.push(cur.join('')); cur = []; }
    }
    if (cur.length) quotes.push(cur.join(''));
    expect(quotes.length, '清单里一段引用都没扫到——排版改了就把这条守卫的抠法一起改').toBeGreaterThan(0);
    expect(
      quotes,
      '冒烟清单第 0 步抄的那句提示跟 LAN_WARNING 对不上了。那一步让人拿屏幕上的字逐字对，两边必须同步改。',
    ).toContain(LAN_WARNING);
  });
});
