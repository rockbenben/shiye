import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type AiEndpoint } from './store.js';
import { mergeEndpoint, sanitizeSettings } from './settings.js';
import { legacyEndpointId, withLegacyAi } from './aiEndpoints.js';

// 密钥特意取超过 8 个字符：`maskKey` 对短到看不出后四位的密钥会整个打成 `••••`
// （见 aiApi.ts），短的样例会绕开「打码串原样带回」这条真实路径。
const recA: AiEndpoint = { baseUrl: 'https://a.test/v1', key: 'sk-real-key-4321', model: 'm-a' };
const stored = { ...DEFAULT_SETTINGS, aiEndpointId: 'a', aiEndpoints: { a: recA } };
const maskedA = `••••${recA.key.slice(-4)}`;

describe('mergeEndpoint：一条记录该落成什么', () => {
  it('打码回显 = 没动密钥，沿用这条记录自己的', () => {
    expect(mergeEndpoint({ baseUrl: recA.baseUrl, key: maskedA, model: 'm-a' }, recA)?.key).toBe(recA.key);
  });

  it('没带 key 字段也沿用——别的客户端只想改番茄钟，不该顺手清掉密钥', () => {
    expect(mergeEndpoint({ baseUrl: recA.baseUrl, model: 'm-a' }, recA)?.key).toBe(recA.key);
  });

  it('重打一把 → 照收；空串 = 真的清掉（不留这条路就没法删密钥）', () => {
    expect(mergeEndpoint({ baseUrl: recA.baseUrl, key: 'sk-新的一把' }, recA)?.key).toBe('sk-新的一把');
    expect(mergeEndpoint({ baseUrl: recA.baseUrl, key: '' }, recA)?.key).toBe('');
  });

  /**
   * 这一条是这次改动真正的新判据。旧版全应用只有一把 `aiKey`，「点了另一家的芯片、
   * 没碰密钥格」会拿着上一家的真密钥去请求新地址，接口回 `Invalid API key`，
   * 而报错文案让人去查模型名和地址——那个 401 跟真实原因毫无关系。
   * 第三方网页也发得出这种请求（`text/plain` 的简单请求没有预检，CORS 只拦读响应）。
   */
  it('同一条记录里把主机换了 → 旧密钥不跟着走（打码回显也一样）', () => {
    expect(mergeEndpoint({ baseUrl: 'https://攻击者.test/v1', key: maskedA }, recA)?.key).toBe('');
    expect(mergeEndpoint({ baseUrl: 'https://攻击者.test/v1' }, recA)?.key).toBe('');
  });

  it('换了主机、但重新打了一把密钥 → 照收（换机器是正常动作，不该拦）', () => {
    expect(mergeEndpoint({ baseUrl: 'https://b.test/v1', key: 'sk-b' }, recA)?.key).toBe('sk-b');
  });

  /** 只有**换主机**才要重填：同一家改路径（`/v1` → `/v2`）密钥还是那把。 */
  it('同一个主机只改路径 → 密钥跟着走', () => {
    expect(mergeEndpoint({ baseUrl: 'https://a.test/v2' }, recA)?.key).toBe(recA.key);
  });

  /**
   * 「地址没了、key 还在」是 web-tools 拿测试钉住的一类 bug：留下密钥，下一条
   * 配上地址的记录就可能拿走它。照抄过来。
   */
  it('地址空着 → 整条不要了，连带它配过的密钥一起丢', () => {
    expect(mergeEndpoint({ baseUrl: '  ', key: recA.key }, recA)).toBeNull();
  });

  it('不是对象 / 字段写成别的东西 → 不牵连其他键，坏的那个当没给', () => {
    expect(mergeEndpoint('一把密钥', recA)).toBeNull();
    expect(mergeEndpoint({ baseUrl: 42, key: recA.key }, recA)).toBeNull();
    expect(mergeEndpoint({ baseUrl: 'https://a.test/v1', key: recA.key, model: 7 }, recA)?.model).toBe('');
  });

  /**
   * **这一条也改过判据**（2026-10-21）。原来写的是「明文照收，打码串也照收
   * （服务端分不清，界面上没有来源）」。
   *
   * **旧理由**：这条记录在本机压根不存在，来的是什么就是什么，服务端没有可比对的
   * 真值。
   *
   * **为什么现在不成立**：打码**永远以 `••••` 打头**（`maskKey`），真钥匙不会有这个
   * 打头——「长得像打码」是能用的线索。而照收的代价是：落盘一把 `••••ijkl` 这种
   * 假钥匙，第一次调接口就 401，报错还说「密钥无效」，人只会反复重填。哪台机器
   * 会遇到：换机之后导入一份别处导出的备份（导出的是打码串）。
   */
  it('本来没有这条记录（新建一家）→ 明文照收；来的是打码串 → 当成没给密钥', () => {
    expect(mergeEndpoint({ baseUrl: 'https://n.test/v1', key: 'sk-n' }, undefined)?.key).toBe('sk-n');
    expect(mergeEndpoint({ baseUrl: 'https://n.test/v1', key: '••••ijkl' }, undefined)?.key).toBe('');
  });
});

describe('sanitizeSettings 里的接口表', () => {
  /**
   * 这是对「PUT 是整份覆盖」那份契约的一处有意例外，代价算过：旧版界面的客户端
   * （手机上那页开着没刷新）发的是老形状 `{aiBaseUrl, aiKey, aiModel}`，没有表这个键。
   * 按契约把它清成空表，他一保存就把各家密钥静默清空，响应照样 200。
   */
  it('请求体里没有 aiEndpoints：原表原样留着', () => {
    const s = sanitizeSettings({ focusMinutes: 40 }, stored);
    expect(s.aiEndpoints).toEqual(stored.aiEndpoints);
    expect(s.aiEndpointId).toBe('a');
    expect(s.focusMinutes).toBe(40);
  });

  it('给了空表 = 真的要清空（新界面删掉最后一家）', () => {
    const s = sanitizeSettings({ aiEndpoints: {}, aiEndpointId: 'a' }, stored);
    expect(s.aiEndpoints).toEqual({});
    // 表都空了，id 不能还指着一条不存在的记录——那在界面上画成「已经选了某家」
    expect(s.aiEndpointId).toBe('');
  });

  it('两家的密钥各归各：a 沿用打码回显，b 用自己那把', () => {
    const s = sanitizeSettings({
      aiEndpointId: 'b',
      aiEndpoints: {
        a: { baseUrl: recA.baseUrl, key: maskedA, model: 'm-a' },
        b: { baseUrl: 'https://b.test/v1', key: 'sk-b', model: 'm-b' },
      },
    }, stored);
    expect(s.aiEndpoints.a?.key).toBe(recA.key);
    expect(s.aiEndpoints.b?.key).toBe('sk-b');
  });

  it('aiEndpointId 指着一条不存在或被丢掉的记录 → 落回「没选」', () => {
    const s = sanitizeSettings({ aiEndpointId: 'ghost', aiEndpoints: { a: recA } }, stored);
    expect(s.aiEndpointId).toBe('');
  });

  /**
   * 键直接来自请求体。`table['__proto__'] = …` 不是多一条记录，而是改这张表的
   * 原型——后面的 `settings.aiEndpoints[id]` 全都会被那个原型上的东西影响。
   * 挡掉这三个名字。
   */
  it('__proto__ 当键也改不动表的原型', () => {
    const body = JSON.parse('{"aiEndpoints":{"__proto__":{"baseUrl":"https://x.test","key":"sk-leak"}}}');
    const s = sanitizeSettings(body, stored);
    expect(Object.getPrototypeOf(s.aiEndpoints)).toBe(Object.prototype);
    expect((s.aiEndpoints as Record<string, unknown>).baseUrl).toBeUndefined();
  });

  /**
   * **「空选中」跟「id 悬空」是两件事，这里守的是前者。**
   *
   * **旧版界面**（手机上那页开着没刷新）那颗「自定义」按钮只是「取消选中」，它发出来的
   * 是 `aiEndpointId: ''`，而**表里那条记录和那把密钥都还在**。服务端照单全收、把空串
   * 原样存进 `device.json`，下次打开设置页 `activeEndpoint(draft)` 返回 undefined，
   * 接口地址 / 模型 / 密钥**三格同时全空**，三颗 AI 按钮一起变灰——
   * 而数据一条没少，丢的只是「选中哪一条」这个指针。
   *
   * （新界面已经不走这条路了：它建的是一条真记录、哨兵 id `custom:`。但这份兜底
   * 还得留着——**旧客户端还在发空串上来**。）
   *
   * 跟上面那条「id 悬空 → 落回没选」不是一回事：**那个 id 指向的记录真的不在
   * 表里**，落 `''` 是诚实的；这里记录明明还在，只是客户端说「暂时不选」，
   * 那不该被持久化成「这台机器没有默认那一家」。
   *
   * 修法是给空串单独一条兜底（**只给空串**，悬空的 id 继续落 `''`）：
   * 空选中降级成「这次没生效」，而存着的那条还在表里就继续选中它。
   */
  it('客户端发来空 id、而表里那条记录还在 → 继续选中它，不是「没选」', () => {
    const s = sanitizeSettings({ aiEndpointId: '', aiEndpoints: { a: { ...recA, key: maskedA } } }, stored);
    expect(s.aiEndpointId).toBe('a');
  });

  /** 兜底的前提是「那条记录确实还在表里」。用户用「忘掉这一家」把它删了，就该真的没选。 */
  it('空 id、但存着的那条已经从表里删掉了 → 仍然落回「没选」', () => {
    const s = sanitizeSettings({ aiEndpointId: '', aiEndpoints: {} }, stored);
    expect(s.aiEndpointId).toBe('');
  });

  it('dailySummaryOn 是服务端盖的章，请求体里的一概不采信', () => {
    const s = sanitizeSettings({ dailySummaryOn: '2020-01-01' }, stored);
    expect(s.dailySummaryOn).toBe(stored.dailySummaryOn);
  });
});

describe('withLegacyAi：旧版平铺三格当场升成一条记录', () => {
  it('旧形状 → 一条记录，而且它就是当前选中的那条', () => {
    const s = withLegacyAi({ ...DEFAULT_SETTINGS }, { aiBaseUrl: 'https://c.test/v1', aiKey: 'sk-c', aiModel: 'm-c' });
    expect(Object.values(s.aiEndpoints)).toEqual([{ baseUrl: 'https://c.test/v1', key: 'sk-c', model: 'm-c' }]);
    expect(s.aiEndpointId).toBe(legacyEndpointId('https://c.test/v1'));
  });

  /**
   * 键合并的是「同一个完整端点的几种写法」，不是「同一家」：`https://c.test` 和
   * `https://c.test/v1` **是**两个键（自建网关同主机不同路径真可能是两套东西）。
   * 「同一家别存两份密钥」不在这里保证，在界面那边比 `baseUrl` 值。
   */
  it('同一个端点的几种写法派生成同一个 id，而少一段路径的不算', () => {
    const same = ['https://c.test/v1', 'https://c.test/v1/', 'https://C.test/v1/chat/completions']
      .map((u) => legacyEndpointId(u));
    expect(new Set(same).size).toBe(1);
    expect(legacyEndpointId('https://c.test')).not.toBe(legacyEndpointId('https://c.test/v1'));
  });

  it('已经有 aiEndpoints 时不糊回去——两样都带着以表为准', () => {
    const s = withLegacyAi(stored, { aiBaseUrl: 'https://旧.test/v1', aiKey: 'sk-旧的' });
    expect(s).toBe(stored);
  });

  it('旧地址本来就是空的 → 不凭空造一家', () => {
    expect(withLegacyAi({ ...DEFAULT_SETTINGS }, { aiBaseUrl: '  ', aiKey: 'sk-x' }).aiEndpoints).toEqual({});
  });

  it('通过 sanitizeSettings 走老形状的导入文件：三格落成一条记录', () => {
    const s = sanitizeSettings({ aiBaseUrl: 'https://c.test/v1', aiKey: 'sk-c', aiModel: 'm-c' }, DEFAULT_SETTINGS);
    expect(s.aiEndpoints[legacyEndpointId('https://c.test/v1')]).toEqual({
      baseUrl: 'https://c.test/v1', key: 'sk-c', model: 'm-c',
    });
    expect(s.aiEndpointId).toBe(legacyEndpointId('https://c.test/v1'));
  });
});
