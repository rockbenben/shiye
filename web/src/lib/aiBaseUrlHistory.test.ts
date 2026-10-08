// @vitest-environment jsdom
// 跟 density.test.ts / navVisibility.test.ts 同一个理由：这个模块直接摸
// localStorage，用 pragma 把这一份文件切到 jsdom（`web/src/**/*.test.ts`
// 默认落在 node 那一档，那里压根没有 localStorage）。
import { describe, it, expect, beforeEach } from 'vitest';
import { getAiBaseUrlHistory, pushAiBaseUrl } from './aiBaseUrlHistory.js';

const KEY = 'aiBaseUrlHistory';

describe('aiBaseUrlHistory', () => {
  beforeEach(() => localStorage.clear());

  it('没存过是空清单，不是 undefined、也不是抛', () => {
    expect(getAiBaseUrlHistory()).toEqual([]);
  });

  it('记一条，读回来就是那一条', () => {
    expect(pushAiBaseUrl('http://192.168.2.127:8317')).toEqual(['http://192.168.2.127:8317']);
    expect(getAiBaseUrlHistory()).toEqual(['http://192.168.2.127:8317']);
  });

  /** 地址框里敲错一次不该在清单里留一条脏的。 */
  it('空白不记', () => {
    expect(pushAiBaseUrl('   ')).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /**
   * 「换了尾斜杠」在同一次会话里就会发生两次（粘过来带斜杠、手敲不带），
   * 排成两条等于让人在两个长得一样的东西里挑。
   */
  it('尾斜杠和大小写算同一条：只留最新那次，新的排最前', () => {
    pushAiBaseUrl('http://192.168.2.127:8317/v1');
    const next = pushAiBaseUrl('http://192.168.2.127:8317/v1/');
    expect(next).toEqual(['http://192.168.2.127:8317/v1/']);
    expect(pushAiBaseUrl('https://API.x.test/v1')).toHaveLength(2);
    expect(getAiBaseUrlHistory()[1]).toBe('http://192.168.2.127:8317/v1/');
  });

  it('只留最近 5 条，第 6 条把最旧的挤掉', () => {
    let list: string[] = [];
    for (let i = 1; i <= 6; i += 1) list = pushAiBaseUrl(`http://192.168.2.1${i}:8317`);
    expect(list).toHaveLength(5);
    expect(list[0]).toBe('http://192.168.2.16:8317');
    expect(list).not.toContain('http://192.168.2.11:8317');
  });

  /**
   * 存坏过（别的版本写的、DevTools 里手改过的）就当没有。这一屏还有别的格要读，
   * 一次 JSON 抛会把整页设置砸了。
   */
  it('存的是坏东西就当没有，不抛', () => {
    for (const bad of ['not json', '{"a":1}', '["ok", 42, "  ", ""]', 'null']) {
      localStorage.setItem(KEY, bad);
      expect(() => getAiBaseUrlHistory()).not.toThrow();
    }
    localStorage.setItem(KEY, '["ok", 42, "  ", ""]');
    expect(getAiBaseUrlHistory()).toEqual(['ok']);
    // 坏清单被记一次之后自动修形成干净数组，脏值不会一直留在盘上。
    expect(pushAiBaseUrl('http://x')).toEqual(['http://x', 'ok']);
  });
});
