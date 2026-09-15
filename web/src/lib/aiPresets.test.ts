import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../vendor/providerCatalog.generated.js';
import type { CatalogProvider } from '../vendor/providerCatalog.generated.js';
import { AI_PRESETS, modelSuggestionsFor, visibleAiPresets } from './aiPresets.js';

/**
 * 预置那行现在是整份从 provider 目录派出来的，所以这里盯的就是「派得对不对」，
 * 而不是「有哪几家」——钉死一份厂商名单，上游同步加一家就红了，那正是想避免的。
 */

/** 目录按「一条端点就是独立产品才各自成一家」派出来的端点数。 */
const presetCountFor = (p: CatalogProvider) =>
  p.endpoints.length > 1 && p.endpoints.every((e) => e.docs) ? p.endpoints.length : 1;

/** 端点是不是「一个端点就是一个独立产品」（目录顶注里 `docs` 字段的用法）。 */
const isOwnProductEach = (p: CatalogProvider) =>
  p.endpoints.length > 1 && p.endpoints.every((e) => e.docs);

describe('aiPresets：预置行从 provider 目录派生', () => {
  it('目录里每一家 OpenAI 协议、有端点的厂商都派出自己的预置', () => {
    const openai = PROVIDER_CATALOG.filter((p) => p.protocol === 'openai' && p.endpoints.length > 0);
    expect(openai.length).toBeGreaterThan(0);
    expect(AI_PRESETS.length).toBe(openai.reduce((n, p) => n + presetCountFor(p), 0));

    for (const p of openai) {
      if (isOwnProductEach(p)) {
        for (const e of p.endpoints) {
          expect(AI_PRESETS.some((x) => x.url === e.url), `${p.key} 的 ${e.label} 没派出来`).toBe(true);
        }
      } else {
        expect(AI_PRESETS.some((x) => x.url === p.endpoints[0]!.url), `${p.key} 没派出来`).toBe(true);
      }
    }
  });

  it('同一家的地域 / 计费变体只留第一个，端点行不会撑成一坨', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.protocol !== 'openai' || p.endpoints.length <= 1 || isOwnProductEach(p)) continue;
      const urls = AI_PRESETS.filter((x) => p.endpoints.some((e) => e.url === x.url)).map((x) => x.url);
      expect(urls).toEqual([p.endpoints[0]!.url]);
    }
  });

  it('原生协议、或者只有模型清单没有端点的厂商，一条预置都不派', () => {
    // 服务端只讲 OpenAI Chat Completions：claude / gemini / yandex / azure-openai 的
    // 原生端点填进去就是 400 / 404；azure-openai 连端点都没有，派出来是个假地址。
    const skipped = PROVIDER_CATALOG.filter((p) => p.protocol !== 'openai' || p.endpoints.length === 0);
    expect(skipped.length).toBeGreaterThan(0);
    const labels = new Set(skipped.map((p) => p.label));
    const urls = new Set(skipped.flatMap((p) => p.endpoints.map((e) => e.url)));
    expect(urls.size).toBeGreaterThan(0);
    for (const x of AI_PRESETS) {
      expect(labels.has(x.label), x.label).toBe(false);
      expect(urls.has(x.url), x.label).toBe(false);
    }
  });

  it('`models` 是空的（llm 那一组）只换地址，模型名留空串不动', () => {
    const llm = PROVIDER_CATALOG.find((p) => p.key === 'llm');
    expect(llm, '目录里应有 llm 这一组').toBeTruthy();
    for (const e of llm!.endpoints) {
      const preset = AI_PRESETS.find((x) => x.url === e.url);
      expect(preset, `llm 的 ${e.label} 没派出来`).toBeTruthy();
      expect(preset!.model).toBe('');
    }
    // 本机那几个带个「（本机）」，一眼看出不用密钥。
    expect(AI_PRESETS.some((x) => x.label === 'Ollama（本机）' && x.model === '')).toBe(true);
    expect(AI_PRESETS.some((x) => x.label === 'LM Studio（本机）')).toBe(true);
    // 同一组里也有外部的（Together / Fireworks），那几个不该被加上「（本机）」。
    expect(AI_PRESETS.find((x) => x.label === 'Together AI')!.label).not.toContain('（本机）');
  });

  it('`hidden` 标记跟着目录走，默认藏掉、当前地址正落在上面时留住', () => {
    const hiddenProviders = PROVIDER_CATALOG.filter((p) => p.hidden);
    expect(hiddenProviders.length).toBeGreaterThan(0);
    for (const p of hiddenProviders) {
      const preset = AI_PRESETS.find((x) => x.url === p.endpoints[0]!.url);
      expect(preset, `${p.key} 没派出来`).toBeTruthy();
      expect(preset!.hidden).toBe(true);
    }

    const visible = visibleAiPresets(false, undefined);
    expect(visible.some((x) => x.hidden)).toBe(false);
    expect(visible.length).toBe(AI_PRESETS.length - hiddenProviders.length);
    expect(visibleAiPresets(true).length).toBe(AI_PRESETS.length);

    const one = AI_PRESETS.find((x) => x.hidden)!;
    expect(visibleAiPresets(false, one.url)).toContain(one);
    expect(visibleAiPresets(false, undefined)).not.toContain(one);
  });

  it('点任何一条预置填进去的模型名，都在那个地址自己那份候选清单里', () => {
    for (const p of AI_PRESETS) {
      if (!p.model) continue;
      expect(
        modelSuggestionsFor(p.url).some((o) => o.value === p.model),
        `${p.label} 填的是 ${p.model}，候选清单里没有它`,
      ).toBe(true);
    }
  });
});

describe('aiPresets：模型候选反查', () => {
  it('完整地址、只写到 base、base 加动作路径，三种写法出同一份清单', () => {
    const full = 'https://api.deepseek.com/chat/completions';
    const base = full.slice(0, -'/chat/completions'.length);
    const options = modelSuggestionsFor(full);
    expect(options.length).toBeGreaterThan(0);
    expect(modelSuggestionsFor(base)).toEqual(options);
    expect(modelSuggestionsFor(`${base}/`)).toEqual(options);
  });

  it('地址不在目录里时返回空数组——那格退化成纯手填，不拦输入', () => {
    expect(modelSuggestionsFor('http://192.168.1.9:8080/v1')).toEqual([]);
    expect(modelSuggestionsFor('http://127.0.0.1:11434/v1/chat/completions')).toEqual([]);
    expect(modelSuggestionsFor('')).toEqual([]);
  });

  it('候选项的 `value` 是原样发给接口的模型 id', () => {
    const deepseek = PROVIDER_CATALOG.find((p) => p.key === 'deepseek')!;
    const ids = modelSuggestionsFor(deepseek.endpoints[0]!.url).map((o) => o.value);
    expect(ids).toEqual(deepseek.models.map((m) => m.id));
  });

  it('目录里每一家带模型清单、又有端点的厂商，自己的端点都能反查出那份清单', () => {
    for (const p of PROVIDER_CATALOG) {
      // azure-openai 只有模型清单、没有端点：反查表的键是地址，没有地址就无从查起。
      if (p.models.length === 0 || p.endpoints.length === 0) continue;
      expect(
        p.endpoints.some((e) => modelSuggestionsFor(e.url).map((o) => o.value).includes(p.models[0]!.id)),
        `${p.key} 的端点都反查不出 ${p.models[0]!.id}`,
      ).toBe(true);
    }
  });

  it('Google 预置来自目录的 gemini-openai 兼容面行，不手留地址，且排在行首', () => {
    const row = PROVIDER_CATALOG.find((p) => p.key === 'gemini-openai');
    expect(row, '目录应有 gemini-openai 行（同步脚本合成的 OpenAI 兼容面）').toBeTruthy();
    expect(row!.protocol).toBe('openai');
    const google = AI_PRESETS[0]!;
    expect(google.label).toBe('Google AI Studio');
    expect(google.url).toBe(row!.endpoints[0]!.url);
    expect(google.model).toBe(row!.defaultModel);
    // 地址同样进了反查表：完整地址与只写到 base 两种写法都能出它家模型清单。
    expect(modelSuggestionsFor(google.url).some((o) => o.value === google.model)).toBe(true);
    expect(modelSuggestionsFor(row!.endpoints[0]!.baseUrl).some((o) => o.value === google.model)).toBe(true);
  });
});
