/**
 * 「显示订阅套餐节点」高级开关（火山 Coding Plan / 阿里 Token Plan）。**存
 * `localStorage`，不进 `Settings`** ——它只是这台设备上「我要不要看见这两个
 * 预置」的界面偏好（同 density），不参与任何请求，也不该被 PUT 到服务端、
 * 同步到手机。
 *
 * 默认关：这两个是订阅套餐专属端点，两家官方文档均写明，仅限 AI 编程工具中
 * 交互式使用，在允许范围之外使用对应的 Base URL / Key 可能被识别为滥用，导致
 * 订阅停用或账号 / API Key 封禁。风险全文放在开关下方那行 help 里。
 */
const KEY = 'showCodingPlans';

export function getShowCodingPlans(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setShowCodingPlans(v: boolean): void {
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    // 存不进去只影响刷新后是否保留，本次会话内开关照常生效。
  }
}
