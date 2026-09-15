import { PROVIDER_CATALOG } from '../vendor/providerCatalog.generated.js';

/**
 * 「调接口」那栏的快捷预置：点一下把地址（和模型名）填进框里。
 *
 * 厂商事实（地址、默认模型、hidden 标记）来自 web-tools 同步下来的
 * providerCatalog.generated.ts —— 那份整份重写，别手改，改了下次同步会分叉。
 * 服务端只讲 OpenAI Chat Completions（server/src/aiApi.ts 请求体固定
 * `{model, messages, stream:false}`），所以目录里 claude / gemini / yandex /
 * azure-openai 的**原生协议**条目一律不可用，这里按 protocol 过滤。
 *
 * 保留在本地、不从目录派生的只有两类：
 *   · Google —— 用的是 Gemini 的 OpenAI 兼容端点（/v1beta/openai/），目录里
 *     gemini 那条是原生 :generateContent，协议形状不同
 *   · Ollama / LM Studio —— 本机运行时，地址不属于任何厂商，模型名只有用户
 *     自己知道，预置里 model 必须留空（点一下只换地址，不冲掉已填模型名）
 */
export interface AiPreset {
  label: string;
  /** 完整 chat/completions 地址（预置只是起点，地址框照样能自己写） */
  url: string;
  /** 点预置时顺带填的模型名；空串 = 不动当前模型名（本机运行时） */
  model: string;
  /**
   * 默认在预置行里隐藏（订阅套餐：火山方舟 Coding Plan、阿里百炼 Token Plan；
   * 两家官方文档均写明，在非 AI 编程工具 / 允许范围之外使用套餐 Base URL / Key
   * 可能被判滥用而封停账号 / 订阅）。高级开关放出；当前地址恰好落在隐藏预置上时
   * 也照常高亮，不能把用户已选的藏没。
   */
  hidden?: boolean;
}

/** 收录哪几家 + 中文显示名。目录 label 一律英文。顺序由目录顺序决定。 */
const PICKED_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  siliconflow: '硅基流动',
  openrouter: 'OpenRouter',
  volcengine: '字节方舟 Coding Plan',
  alibaba: '阿里百炼 Token Plan',
};

/** 目录派生的云厂商预置（openai 协议 + 在收录清单内）。 */
const catalogPresets: AiPreset[] = PROVIDER_CATALOG
  .filter((p) => p.protocol === 'openai' && p.key in PICKED_LABELS)
  .map((p) => {
    const url = p.endpoints[0]?.url;
    if (!url) throw new Error(`providerCatalog 的 ${p.key} 没有端点，无法作为 AI 预置`);
    return {
      label: PICKED_LABELS[p.key]!,
      url,
      model: p.defaultModel ?? '',
      ...(p.hidden ? { hidden: true as const } : {}),
    };
  });

// Google 走 Gemini 的 OpenAI 兼容层 —— 与目录 gemini 的原生协议不是一回事，
// 是本地特殊项。这个地址实测过（2026-08-30，见设置弹层旧注释）：空 body 回
// 400 model is not specified，说明路径存在且就是那个 chat 端点。
const GOOGLE_PRESET: AiPreset = {
  label: 'Google AI Studio',
  url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  model: 'gemini-3.7-flash',
};

/** 本机运行时：model 留空，点击只换地址（SettingsModal 里那条空串不覆盖的逻辑）。 */
const LOCAL_RUNTIME_PRESETS: AiPreset[] = [
  { label: 'Ollama（本机）', url: 'http://127.0.0.1:11434/v1/chat/completions', model: '' },
  { label: 'LM Studio（本机）', url: 'http://127.0.0.1:1234/v1/chat/completions', model: '' },
];

/**
 * 预置行顺序：Google 打头（沿用既有顺序，最低门槛的免费入口），
 * 其后按目录顺序的云厂商，本机两条收尾。
 */
export const AI_PRESETS: readonly AiPreset[] = [
  GOOGLE_PRESET,
  ...catalogPresets,
  ...LOCAL_RUNTIME_PRESETS,
];

/**
 * 预置行实际可见的条目：hidden 的默认藏掉，开关打开后全放；当前地址正好等于
 * 某条隐藏预置时把它留住（已选配置不能被藏没，标签的 checked 高亮还要靠它）。
 */
export function visibleAiPresets(showHidden: boolean, currentUrl?: string): readonly AiPreset[] {
  if (showHidden) return AI_PRESETS;
  return AI_PRESETS.filter((p) => !p.hidden || (currentUrl !== undefined && p.url === currentUrl));
}
