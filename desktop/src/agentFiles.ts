import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AgentFilesResult {
  copied: string[];
  skipped: string[];
}

/**
 * AI 子进程实际会读的只有这两样：固定提示词（server/src/expand.ts 的 `PROMPT`，
 * 「读 AGENTS.md 和 workflows/expand.md……」）加上 AGENTS.md 内部对
 * workflows/ 别的文件的交叉引用。没有第三样，CLAUDE.md 是排期/改代码的
 * 规矩，跟拆解无关，不拷。
 */
const ITEMS = ['AGENTS.md', 'workflows'] as const;

/**
 * 把 AI 要读的那两样东西铺到它的工作目录（agentCwd）里。**两个都每次覆盖**：
 * `workflows/` 是应用逻辑，升级就该跟着变；`AGENTS.md` 看着像是「拥有者可能
 * 调过」，但它恰恰是跟服务端 outbox 校验耦合最紧的契约——只在不存在时才拷，
 * 会让升级后本地那份还是旧契约，AI 照旧契约写、被整批拒收，用户看到红横幅
 * 却查不出原因。一条规矩（两个都覆盖）比两条（一个覆盖一个不覆盖）少一半
 * 代码，也少一个失效模式。
 *
 * `from === to` 时整个跳过，连 fs 调用都不发起：开发模式下两者都是仓库根，
 * 不判等的话 `cpSync(x, x, { recursive: true })` 对目录会直接抛 EINVAL
 * （把自己拷进自己）——这不是「多做一次无谓的事」那么轻，是会在开发模式
 * 直接炸的 bug。**判等用 `resolve()` 先归一化，不能裸字符串比较**：开发模式下
 * 显式设了 `DATA_DIR=<repoRoot>/data` 时，`agentCwd` 算的是
 * `dirname(explicit)`，字面量可能跟 `host.repoRoot` 只差一个尾部分隔符——
 * 裸字符串比较认不出这是同一个目录，会绕过这道守卫、然后被 `cpSync` 拒绝。
 */
export function ensureAgentFiles(opts: { from: string; to: string }): AgentFilesResult {
  const { from, to } = opts;
  if (resolve(from) === resolve(to)) {
    return { copied: [], skipped: [...ITEMS] };
  }

  const copied: string[] = [];
  for (const item of ITEMS) {
    cpSync(join(from, item), join(to, item), { recursive: true, force: true });
    copied.push(item);
  }
  return { copied, skipped: [] };
}
