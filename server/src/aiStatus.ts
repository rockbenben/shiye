import { accessSync, constants, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { configProblem } from './aiApi.js';
import { resolveCliInvocation } from './expand.js';
import { agentCwd } from './store.js';
import type { Settings } from './model.js';

/**
 * AI 能不能开工——**只做只读检查，不启动 CLI**。
 *
 * “调接口”走跟真正发请求同一份 `configProblem`（地址、模型必填，密钥可选——
 * 本机模型不要钥匙）；“本机命令行”看解析后的命令在不在 PATH/给定路径上。
 * 这里故意不试运行 `--version`：那会启动一个外部进程，有些 CLI 在没登录时会
 * 弹交互或写配置，状态检查不该有副作用。
 */
export type AiReadiness = {
  mode: 'cli' | 'api';
  ready: boolean;
  /** CLI 模式下实际要找的命令名（显示给用户看，不含参数）。 */
  cli?: string;
  /** 没准备好的原因；ready 为真时不返回。 */
  reason?: string;
};

type CommandLookupOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
};

/** 在 PATH（或显式路径）里找可执行文件；不执行它。
 *
 * **只认真正 spawn 得起来的文件。** Windows 上 `spawn(cmd, args, {shell:false})`
 * 不能直接跑 `.cmd` / `.bat`：实测显式路径抛 `EINVAL`，只靠 PATH 找到的裸命令
 * 回 `ENOENT`。以前这里把 `PATHEXT` 里的 `.CMD`/`.BAT` 也算上，于是检查说
 * 「已接上」、点下去却起不来。这里跟 `spawn` 对齐，只认 `.exe` / `.com`；
 * 目录也用 `isFile()` 排除（Windows 上 `X_OK` 对目录同样会通过）。
 */
export function commandExists(command: string, opts: CommandLookupOptions = {}): boolean {
  const raw = command.trim();
  if (!raw) return false;

  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const pathSep = platform === 'win32' ? ';' : ':';
  const pathValue = env.PATH ?? env.Path ?? '';
  const exts = platform === 'win32' ? ['.EXE', '.COM'] : [''];
  const hasExt = extname(raw) !== '';
  if (platform === 'win32' && hasExt && !/\.(exe|com)$/i.test(raw)) return false;
  const suffixes = hasExt ? [''] : exts;
  const hasPath = isAbsolute(raw) || raw.includes('/') || raw.includes('\\');
  const check = (candidate: string) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  if (hasPath) {
    const base = isAbsolute(raw) ? raw : resolve(opts.cwd ?? agentCwd(), raw);
    // 无扩展名的显式路径也试一次：Windows 允许可执行文件不带 `.exe`。
    const candidates = hasExt ? [base] : [base, ...suffixes.map((ext) => `${base}${ext}`)];
    return candidates.some(check);
  }

  const dirs = pathValue.split(pathSep).filter(Boolean);
  return dirs.some((dir) => suffixes.some((ext) => check(join(dir, `${raw}${ext}`))));
}

export function aiReadiness(settings: Settings): AiReadiness {
  if (settings.aiMode === 'api') {
    // 判据跟真正发请求那一侧共用 `configProblem`，不在这儿再抄一份：
    // **密钥可以为空**（本机 Ollama / LM Studio 不要钥匙），而「接口地址、
    // 模型名、密钥三项齐全」那种写法会把它们判成没接好。
    const rec = settings.aiEndpoints[settings.aiEndpointId] ?? { baseUrl: '', key: '', model: '' };
    const problem = configProblem({ baseUrl: rec.baseUrl, apiKey: rec.key, model: rec.model });
    if (problem) return { mode: 'api', ready: false, reason: problem };
    return { mode: 'api', ready: true };
  }

  const invocation = resolveCliInvocation(settings, '');
  if (commandExists(invocation.command)) {
    return { mode: 'cli', ready: true, cli: invocation.displayName };
  }
  return {
    mode: 'cli',
    ready: false,
    cli: invocation.displayName,
    reason: `没找到 ${invocation.displayName}`,
  };
}
