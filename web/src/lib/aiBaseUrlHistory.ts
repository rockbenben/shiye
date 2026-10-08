/**
 * 「接口地址」那格的最近用过清单。**存 `localStorage`，不进 `Settings`**——
 * 理由跟 `showCodingPlans` 同一套：这是这台设备上的界面便利，不参与任何请求。
 * 而地址这一条还有一个 `showCodingPlans` 没有的理由：`Settings` 是要被导出/
 * 导入搬家的（见 `App.tsx` 导出那节，换机是主场景），把一串用过的内网地址跟着
 * 搬走，等于把你的局域网拓扑写进一份会发给别的机器的文件里。
 *
 * 存在的意义是**自建/局域网端点没有预置可点**：provider 目录里那七枚本机芯片
 * （Ollama、LM Studio、LiteLLM…）钉的全是 `127.0.0.1` 加各家的默认端口，一台
 * 局域网机器换的是 IP 不是端口，于是那一行 Tag 永远帮不上忙，每次都得重敲。
 */
const KEY = 'aiBaseUrlHistory';
const MAX = 5;

/** 用于去重的形状：去首尾空白、去尾斜杠、整个小写。存进去的仍是用户敲的那份。 */
const dedupeKey = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

export function getAiBaseUrlHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // 存坏过（别的版本写的、手改过 DevTools）就当没有，不拿它抛错砸掉整个设置屏。
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, MAX);
  } catch {
    return [];
  }
}

/** 记下这次保存用的地址，回新的清单（调用方拿去刷 state，组件不重新挂载就读不到）。 */
export function pushAiBaseUrl(url: string): string[] {
  const v = url.trim();
  if (!v) return getAiBaseUrlHistory();
  const key = dedupeKey(v);
  const next = [v, ...getAiBaseUrlHistory().filter((u) => dedupeKey(u) !== key)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不进去只影响下次打开还在不在，这一屏的候选照常出。
  }
  return next;
}
