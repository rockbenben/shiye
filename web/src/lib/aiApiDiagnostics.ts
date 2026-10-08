/**
 * AI 接口调用与测试结果诊断助手。
 *
 * 根据服务端返回的错误信息（HTTP 状态码、报错正文或异常类型），
 * 提炼出针对性、清晰可操作的排查建议，帮助用户迅速定位是地址、密钥、模型名还是网络/服务配置问题。
 */

export interface DiagnosticResult {
  /** 简明分类标签，如 "密钥无效"、"端点不存在"、"网络连接失败" */
  category: string;
  /** 具体可执行的排查建议 */
  suggestion: string;
}

export function diagnoseApiError(errorMsg?: string | null): DiagnosticResult | null {
  if (!errorMsg || typeof errorMsg !== 'string') return null;
  const msg = errorMsg.trim().toLowerCase();

  // 1. 认证/密钥问题 (401, 403, Unauthorized, Invalid Key)
  if (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('incorrect api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid key') ||
    msg.includes('authentication') ||
    msg.includes('permission_denied') ||
    msg.includes('403') ||
    msg.includes('forbidden')
  ) {
    return {
      category: '密钥异常',
      suggestion: 'API Key 可能填写错误、已失效或欠费。请在服务商控制台核对 Key 并重新复制填入。',
    };
  }

  // 2. 404 端点未找到 (Not Found, /v1)
  if (msg.includes('404') || msg.includes('not found') || msg.includes('cannot post') || msg.includes('不是 json')) {
    return {
      category: '接口地址不存在',
      suggestion: '目标地址未找到对应接口。请确认 Base URL 是否缺少了版本前缀（通常需包含 /v1 或 /v1/chat/completions）。',
    };
  }

  // 3. 额度/频次限制 (429, Rate limit, Quota)
  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('insufficient_quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('额度') ||
    msg.includes('频次')
  ) {
    return {
      category: '调用频次或配额超限',
      suggestion: '账户余额或配额耗尽，或超出每分钟调用频次限制（TPM/RPM）。请检查服务商控制台中的账单与额度。',
    };
  }

  // 4. 模型名称问题 (Model not found, 400)
  if (
    msg.includes('model_not_found') ||
    msg.includes('does not exist') ||
    msg.includes('invalid model') ||
    msg.includes('unknown model') ||
    (msg.includes('model') && msg.includes('not found')) ||
    (msg.includes('模型') && msg.includes('不存在'))
  ) {
    return {
      category: '模型名不存在',
      suggestion: '服务商未找到所填写的模型名称。请核对模型 ID 拼写，或确认该 API Key 是否有权限调用该模型。',
    };
  }

  // 5. 编码与特殊字符问题 (ByteString, 中文, 换行)
  if (msg.includes('bytestring') || msg.includes('中文') || msg.includes('换行') || msg.includes('空格')) {
    return {
      category: '输入包含非法字符',
      suggestion: '密钥中混入了中文标点、全角空格或换行符。请在纯文本编辑器中清理后再粘贴。',
    };
  }

  // 6. 网络超时 (Timeout, Abort)
  if (msg.includes('timeout') || msg.includes('abort') || msg.includes('超时')) {
    return {
      category: '连接超时',
      suggestion: '接口调用超过 20 秒未响应。请检查网络通畅度、代理/VPN 工具或确认服务提供商状态。',
    };
  }

  // 7. 连接拒绝与网络错误 (ECONNREFUSED, fetch failed, 连不上)
  if (msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('连不上') || msg.includes('network error')) {
    if (msg.includes('127.0.0.1') || msg.includes('localhost') || msg.includes('11434') || msg.includes('1234')) {
      return {
        category: '本地服务连接失败',
        suggestion: '无法连接本机服务。请确认本地模型服务（如 Ollama / LM Studio）已启动，且已配置跨域支持（如 OLLAMA_ORIGINS="*"）。',
      };
    }
    return {
      category: '网络连接失败',
      suggestion: '无法建立网络连接。请确认目标地址和端口是否正确，以及设备网络连接是否正常。',
    };
  }

  return null;
}
