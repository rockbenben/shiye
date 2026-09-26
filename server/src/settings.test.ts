import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from './store.js';
import { sanitizeSettings } from './settings.js';

// aiKey 特意取超过 8 个字符：maskKey 对短到看不出后四位的密钥会整个打成
// `••••`（见 aiApi.ts），短的样例会绕开「打码串原样带回」这条真实路径。
const stored = { ...DEFAULT_SETTINGS, aiKey: 'sk-real-key-4321', aiBaseUrl: 'https://a' };

describe('sanitizeSettings', () => {
  it('请求体没给的字段回默认，不采信残缺对象里的 undefined', () => {
    const s = sanitizeSettings({ focusMinutes: 30 }, stored);
    expect(s.focusMinutes).toBe(30);
    expect(s.webhookUrl).toBe(DEFAULT_SETTINGS.webhookUrl);
  });
  it('aiKey 传回的正是 GET 打码串时沿用存着的（用户随手保存不吞密钥）', () => {
    const masked = `••••${stored.aiKey.slice(-4)}`;
    const s = sanitizeSettings({ aiBaseUrl: 'https://a', aiKey: masked }, stored);
    expect(s.aiKey).toBe('sk-real-key-4321');
  });
  it('dailySummaryOn 是服务端盖的章，请求体里的一概不采信', () => {
    const s = sanitizeSettings({ dailySummaryOn: '2020-01-01' }, stored);
    expect(s.dailySummaryOn).toBe(stored.dailySummaryOn);
  });
});
