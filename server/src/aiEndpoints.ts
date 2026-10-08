import type { AiEndpoint, Settings } from './model.js';
import type { AiConfig } from './aiApi.js';

/**
 * 「一条接口配置」的解析与派生。放在独立一个文件，是因为它有三个互不相干的
 * 调用方都要用同一份规矩：`store.ts` 读盘（旧形状要在读的时候当场升上来）、
 * `expand.ts` 起 API 模式（要拿到当前那条记录去发请求）、`app.ts` 的
 * `/api/ai/test`（要按同一条记录取密钥）。各写一份就是三份迟早不一样的判断。
 */

/**
 * 把地址归一成能当键用的样子：去首尾空白、去尾斜杠、去结尾的
 * `/chat/completions`、整个小写。
 *
 * **它合并的是「同一个完整端点的几种写法」，不是「同一家服务商」**：
 * `https://x.test/v1`、`https://x.test/v1/`、`https://x.test/v1/chat/completions`
 * 落到同一个键，而 `https://x.test` 和 `https://x.test/v1` 是两个键——对自建网关
 * 来说这两条真可能是两套东西（同主机不同路径挂不同上游），不敢替用户合并。
 *
 * 这只影响**旧数据派生出来的那条记录叫什么**；「同一家不要把密钥存两份」由界面
 * 那边拿 `baseUrl` 比对来保证（`web/src/lib/aiPresets.ts` 的 `findEndpointByBase`），
 * 它比的是地址值本身，跟这里的键长什么样无关。
 */
const normEndpoint = (url: string): string =>
  url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').toLowerCase();

/**
 * 旧数据派生出来的那条记录用这个键。加 `custom:` 前缀是为了**永不跟 provider 目录
 * 里某个 `key` 撞上**（目录里 `custom` 这种短名字是会被用掉的）。
 *
 * 服务端不知道目录长什么样（它在 `web/src/vendor/`），所以迁移期这条只能叫这个名字；
 * 界面那边点服务商芯片时是**拿 `baseUrl` 比对**来找已有记录的（见
 * `web/src/lib/aiPresets.ts` 的 `findEndpointByBase`），不比 id，因此这条 id 叫
 * 什么都不影响「同一家的密钥只有一份」。用户保存一次之后，落盘的就是目录 id 了。
 */
export const legacyEndpointId = (baseUrl: string): string => `custom:${normEndpoint(baseUrl)}`;

/**
 * 地址的「来源」：`scheme://host:port`，整个小写。够不着或者不成形就回空串。
 *
 * 只用来判**这台机器换成那台机器了没有**（`mergeEndpoint` 拿它决定密钥要不要跟着走），
 * 不比路径——`https://a.test/v1` 和 `https://a.test/v2` 是同一个来源，密钥该跟着。
 */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return '';
  }
};

/** 旧版平铺在那儿的三格（v0.1.6 及之前写进 `device.json` 的形状）。 */
interface LegacyAiFields {
  aiBaseUrl?: unknown;
  aiKey?: unknown;
  aiModel?: unknown;
}
/**
 * 读到旧形状时，把 `aiBaseUrl` / `aiKey` / `aiModel` 三格派生成**一条记录**。
 *
 * 为什么在**读**的时候派生、而不是写一次迁移落盘：`readSettings()` 是
 * `{ ...DEFAULT_SETTINGS, ...readJson(...) }` 一行展开，新键读不到就静默落回默认值
 * ——旧的密钥和地址还在 `device.json` 里躺着，却没有任何一处会去读它，**全程不报
 * 一句错**（这个仓库在 `settings` 搬家那次就付过这笔账）。读时派生是幂等的：不写盘、
 * 不要 schemaVersion、旧文件被别的客户端动过也不会派生出第二份；用户哪天打开设置页
 * 存一次，落盘自然就是新形状，旧键跟着消失。
 *
 * 已经有 `aiEndpoints` 的一概不动——两样都带着时**以表为准**，不然一次手工编辑能把
 * 用户已经分开的几家密钥又糊回一把。
 *
 * `raw` 收 `unknown`：调用方手上是 `Partial<Settings>`（读盘那份）或者一份来路不明
 * 的请求体，两者的共同点都只是「也许还带着那三个旧键」。
 */
export function withLegacyAi(settings: Settings, raw: unknown): Settings {
  const legacy = (raw ?? {}) as LegacyAiFields;
  if (Object.keys(settings.aiEndpoints).length > 0) return settings;
  const baseUrl = typeof legacy.aiBaseUrl === 'string' ? legacy.aiBaseUrl.trim() : '';
  if (!baseUrl) return settings;
  const id = legacyEndpointId(baseUrl);
  const record: AiEndpoint = {
    baseUrl,
    key: typeof legacy.aiKey === 'string' ? legacy.aiKey.trim() : '',
    model: typeof legacy.aiModel === 'string' ? legacy.aiModel.trim() : '',
  };
  return { ...settings, aiEndpointId: id, aiEndpoints: { [id]: record } };
}

/**
 * 当前选中的那条记录解析成一次调用要的三样。没选中、或者 id 对不上表里任何一条
 * （记录被删了、文件被手改过）都回全空——交给 `configProblem()` 说「接口地址还没填」，
 * 而不是拿一条空配置去撞一个注定失败的请求。
 *
 * 这一条是「一家一把钥匙」的落点：三格从**同一条记录**里出来，代码上没有任何路径
 * 能把 A 记录的 `key` 和 B 记录的 `baseUrl` 拼在一起。
 */
export function activeAi(settings: Settings): AiConfig {
  const rec = settings.aiEndpoints[settings.aiEndpointId];
  return { baseUrl: rec?.baseUrl ?? '', apiKey: rec?.key ?? '', model: rec?.model ?? '' };
}
