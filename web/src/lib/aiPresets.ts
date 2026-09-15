import { PROVIDER_CATALOG, findProvider } from '../vendor/providerCatalog.generated.js';
import type { CatalogProvider } from '../vendor/providerCatalog.generated.js';

/**
 * 「调接口」那栏的快捷预置，加上「模型」那格的候选清单。
 *
 * 厂商事实（地址、默认模型、模型清单、hidden 标记）一律来自 web-tools 同步下来的
 * providerCatalog.generated.ts —— 那份整份重写，别手改，改了下次同步就会分叉。
 * 这里只做「怎么把目录派成界面上的预置行」这一件事，所以**目录加一家，预置行就自动
 * 多一家，不用回来改代码**：
 *   · `protocol` 不是 `openai` 的一律不入 —— 服务端只讲 OpenAI Chat Completions
 *     （server/src/aiApi.ts 的请求体固定 `{model, messages, stream:false}`，全文件
 *     只有一条 fetch、没有协议切换），目录里 claude / gemini / yandex / azure-openai
 *     的**原生协议**端点填进去就是 400 / 404；
 *   · 一家有多个端点时，端点自己带 `docs` 的才各自成一家 —— 上游用这个字段标
 *     「一个端点就是一个独立产品」（目录顶上那条注释），整份目录里只有 `llm` 那一组
 *     这么标。其余的多端点是同一家的地域 / 计费变体（qwen 三地、mimo 四个区域），
 *     只取 `[0]`，不然同一家的三个区域端点会把这行预置撑成一坨；
 *   · 目录里 `models` 是空的（`llm` 那组）预置 model 留空 —— 装了什么模型只有
 *     他自己知道，点一下只换地址，不能拿空串把他已经填好的模型名冲掉。
 *
 * Google 预置也来自目录：`gemini-openai` 行是 Google 官方的 OpenAI 兼容面
 * （/v1beta/openai/chat/completions），由上游同步脚本从原生 `gemini` 行合成 ——
 * 原生那条是 `:generateContent` 协议，在这里被上面的 protocol 过滤掉，兼容面这条
 * 才能用。地址、模型清单都在上游那份里，本文件没有厂商事实的特例。
 */
export interface AiPreset {
  label: string;
  /** 完整 chat/completions 地址（预置只是起点，地址框照样能自己写） */
  url: string;
  /** 点预置时顺带填的模型名；空串 = 不动当前模型名（llm 那组，装了什么只有他自己知道） */
  model: string;
  /**
   * 默认在预置行里隐藏（订阅套餐：火山方舟 Coding Plan、阿里百炼 Token Plan；
   * 两家官方文档均写明，在非 AI 编程工具 / 允许范围之外使用套餐 Base URL / Key
   * 可能被判滥用而封停账号 / 订阅）。高级开关放出；当前地址恰好落在隐藏预置上时
   * 也照常高亮，不能把用户已选的藏没。
   */
  hidden?: boolean;
}

/** 目录的 label 一律是英文；这几家界面上一向叫中文。没列的落回目录 label。 */
const DISPLAY_NAME: Record<string, string> = {
  siliconflow: '硅基流动',
  volcengine: '字节方舟 Coding Plan',
  alibaba: '阿里百炼 Token Plan',
};

/** 127.0.0.1 / localhost 的加个「（本机）」，一眼看出不用密钥、也不用注册。 */
const isLocalHost = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url);

const toPreset = (label: string, url: string, provider: CatalogProvider): AiPreset => ({
  label: isLocalHost(url) ? `${label}（本机）` : label,
  url,
  model: provider.models.length === 0 ? '' : (provider.defaultModel ?? ''),
  ...(provider.hidden ? { hidden: true as const } : {}),
});

/**
 * Google 在预置行打头（最低门槛的免费入口），其后一律按目录顺序 —— 顺序也交给
 * 上游决定，目录里调整顺序不会跟这里打架。
 *
 * 用的是 `gemini-openai`（OpenAI 兼容面）不是 `gemini`（原生 `:generateContent`）。
 * 这一行在同步时缺失或变了协议 = 上游同步出问题，模块加载时直接喊出来，别让预置行
 * 静悄悄地少掉第一项。
 */
const GOOGLE_KEY = 'gemini-openai';

const googleProvider = findProvider(GOOGLE_KEY);
if (!googleProvider || googleProvider.protocol !== 'openai' || googleProvider.endpoints.length === 0) {
  throw new Error(`providerCatalog 里没有可用的 ${GOOGLE_KEY} 行 —— 上游同步出问题了？`);
}
const googlePreset = toPreset(googleProvider.label, googleProvider.endpoints[0]!.url, googleProvider);

const catalogPresets: AiPreset[] = PROVIDER_CATALOG.flatMap((p) => {
  if (p.key === GOOGLE_KEY) return []; // 已经提到行首
  // endpoints 为空的不派（目录里 azure-openai 只有模型清单、没有端点；它本身也是
  // 原生协议，已经先被 protocol 那条过滤掉了）。
  if (p.protocol !== 'openai' || p.endpoints.length === 0) return [];
  // 独立产品各自成一家；同一家的变体只留第一个。
  if (p.endpoints.length > 1 && p.endpoints.every((e) => e.docs)) {
    return p.endpoints.map((e) => toPreset(e.label, e.url, p));
  }
  return [toPreset(DISPLAY_NAME[p.key] ?? p.label, p.endpoints[0]!.url, p)];
});

export const AI_PRESETS: readonly AiPreset[] = [googlePreset, ...catalogPresets];

/**
 * 预置行实际可见的条目：hidden 的默认藏掉，开关打开后全放；当前地址正好等于
 * 某条隐藏预置时把它留住（已选配置不能被藏没，标签的 checked 高亮还要靠它）。
 */
export function visibleAiPresets(showHidden: boolean, currentUrl?: string): readonly AiPreset[] {
  if (showHidden) return AI_PRESETS;
  return AI_PRESETS.filter((p) => !p.hidden || (currentUrl !== undefined && p.url === currentUrl));
}

/** 「模型」那格的一项候选：`value` 原样发给接口，`label` 给人读。 */
export interface AiModelOption {
  value: string;
  label: string;
}

/** 把地址归一成不带结尾斜杠的形式，好让几种写法对上同一份候选。 */
const normUrl = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * 地址 → 模型清单的反查表。建**全**目录（不只 openai 那几家），因为服务端虽然只讲
 * OpenAI 协议，用户手填的地址完全可能是目录里某个端点 —— 能对上就给他候选，对不上
 * 就返回空、框照旧能自由填（预置是起点不是白名单，候选也一样）。
 */
const MODEL_SUGGESTIONS: Map<string, readonly AiModelOption[]> = (() => {
  const map = new Map<string, readonly AiModelOption[]>();
  const register = (urls: string[], provider: CatalogProvider) => {
    const options = provider.models.map((m) => ({ value: m.id, label: m.name }));
    if (options.length === 0) return;
    for (const u of urls) {
      const key = normUrl(u);
      if (!key) continue;
      // 完整地址、只写到 base、base + 动作路径 —— 这三种写法都是同一家，都该出候选。
      if (!map.has(key)) map.set(key, options);
      if (!key.endsWith('/chat/completions')) {
        const withAction = `${key}/chat/completions`;
        if (!map.has(withAction)) map.set(withAction, options);
      }
    }
  };
  for (const p of PROVIDER_CATALOG) {
    for (const e of p.endpoints) register([e.url, e.baseUrl], p);
  }
  return map;
})();

/**
 * 按地址给模型候选。空数组 = 这个地址不在目录里，「模型」那格退化成纯手填，
 * 不拦任何输入。
 */
export function modelSuggestionsFor(url: string): readonly AiModelOption[] {
  return MODEL_SUGGESTIONS.get(normUrl(url)) ?? [];
}
