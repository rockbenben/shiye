import { basename, dirname, join } from 'node:path';

export interface HostInfo {
  isPackaged: boolean;
  resourcesPath: string;
  userData: string;
  repoRoot: string;
}

export interface ResolvedPaths {
  serverEntry: string;
  dataDir: string;
  agentCwd: string;
}

/**
 * 打包成 asar 之后路径全变，这里把两种情形算齐。做成纯函数、`app` 只作为参数
 * 传进来，是为了它能被完整测试——Electron 的 `app` 在测试环境里拿不到。
 *
 * **`agentCwd` 必须是 `dataDir` 的父目录**，否则服务端 `aiSeesSameData()`
 * （`server/src/store.ts` 的 `aiSeesSameData()`，比的是 `resolve(DATA_DIR) === resolve(AGENT_CWD + '/data')`）
 * 不成立，`expand.ts` 里 `!aiSeesSameData()` 那道闸会拒绝 spawn AI——它会经 `emitAgentStatus` 推一条
 * `state: 'failed'` 的消息（SSE 推成红横幅：「服务在读 X，而 AI 会去读 Y」），
 * **不是「静默拒绝」**；只是这条消息对着两个路径念一遍，普通用户未必看得懂该
 * 往哪改，不代表这一层还需要另外补一层诊断。
 *
 * **打包后 `agentCwd` 用的是 `<userData>/agent`，不是 `userData` 本身**：`userData`
 * 是 Electron 自己的 Chromium 配置目录（`Cache/`、`Local Storage/`、
 * `Preferences`、`Cookies`……），AI 带着 `--permission-mode acceptEdits` 的
 * Write/Edit/Bash 不该在那种目录里跑。`<userData>/agent/` 下将来会放
 * `data/`、`AGENTS.md`、`workflows/`，名副其实——`AGENTS.md`/`workflows/`
 * 虽然按 extraResources 落在 `resourcesPath`，但 AI 实际工作目录是
 * `<userData>/agent`：**需要在启动时把它们拷贝/同步进去**，这是 Electron
 * 主进程那部分（Task 2）的事，这个函数只管算路径。
 *
 * **DATA_DIR 显式指到同步盘时，那个目录必须字面叫 "data"（大小写敏感）**：
 * `agentDataDir()` 算的是 `join(AGENT_CWD, 'data')`，末尾永远拼字面量
 * `'data'`——同步盘文件夹叫别的名字（哪怕只是大小写不同），不变量数学上就
 * 不可能成立，这是服务端现有实现摆在这里的硬约束，desktop 这边绕不过去，
 * 所以在这里直接拒绝，别把一份注定被拒的配置传下去。
 */
export function resolvePaths(host: HostInfo, env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  // server 走 extraResources、不进 asar：子进程要用 node 去跑这个文件，
  // asar 里的路径 Node 自己打不开。这一步用 resourcesPath 没问题——
  // 服务的代码本身是只读可执行的，不需要写权限。
  const base = host.isPackaged ? host.resourcesPath : host.repoRoot;
  const serverEntry = join(base, 'server', 'dist', 'index.js');

  // 显式 DATA_DIR 优先——WebDAV 那一批靠它把数据指到同步盘。
  // 空字符串不算「设了」：`DATA_DIR=` 是没填，落回默认比落到根目录安全。
  const explicit = env.DATA_DIR?.trim();
  if (explicit) {
    // basename 必须字面叫 'data'：agentDataDir()（server/src/store.ts）算的是
    // join(AGENT_CWD, 'data')，末尾永远拼字面量 'data'——叫别的名字（大小写
    // 不同也算），aiSeesSameData() 的不变量数学上不可能成立，与其把这份注定
    // 被拒的配置传下去（Task 2 才会在服务启动后间接发现），不如现在就拒绝。
    if (basename(explicit) !== 'data') {
      throw new Error(
        `DATA_DIR 的最后一段必须字面叫 "data"（大小写敏感），现在是 "${basename(explicit)}"：` +
          `服务端 agentDataDir()（server/src/store.ts）把 AI 的工作目录算成 join(AGENT_CWD, 'data')，` +
          `叫别的名字 aiSeesSameData() 永远不成立，AI 拆解会被拒绝。把同步文件夹改名成 "data" 再试。`,
      );
    }
    // 数据目录被指到别处时，AI 的工作目录也要跟着挪到它的父目录，否则
    // aiSeesSameData() 不成立。用 dirname 而不是 join(explicit, '..')：两者
    // 字符串结果相同，但含义更准——不留 '..' 这种要靠 resolve() 才能归一化
    // 的记号，也避开一个真实的语义差别：OS 的 chdir 解析 '..' 是物理的
    // （穿过符号链接），resolve() 是词法的；若 explicit 是符号链接，两者可能
    // 落到不同目录，而守卫词法比较照样放行——守卫过了、AI 却在另一个目录里，
    // 正是这个守卫要防的那种事故。
    return { serverEntry, dataDir: explicit, agentCwd: dirname(explicit) };
  }

  // 打包后 agentCwd 用 <userData>/agent，不是 userData 本身：userData 是
  // Electron 自己的 Chromium 配置目录，AI 不该在那里跑 Write/Edit/Bash。
  const agentCwd = host.isPackaged ? join(host.userData, 'agent') : host.repoRoot;
  return { serverEntry, dataDir: join(agentCwd, 'data'), agentCwd };
}

/**
 * 托盘/窗口图标的路径。**从 `dist` 那一层往上一级取，不要用 `app.getAppPath()`。**
 *
 * 原来 `main.ts` 用的是 `join(app.getAppPath(), 'build', 'icon.png')`，注释还写着
 * 「开发模式和打包后指向同一层」——那句是错的，实测：
 *
 * ```
 *   开发模式（electron desktop/dist/main.js）  getAppPath() = …/desktop/dist
 *   打包后                                    getAppPath() = …/app.asar（根）
 * ```
 *
 * 两者差一层，于是开发模式下拼出 `…/desktop/dist/build/icon.png`，那儿没有文件，
 * `new Tray()` 抛「Failed to load image」，整个应用起不来——**而打包版正常**，
 * 所以这条一直没被发现：开发模式在这个仓库的约束里一直是禁止跑的，直到拥有者
 * 自己去开才炸出来。
 *
 * `distDir` 在两种形态下都是「dist 那一层」（`dirname(fileURLToPath(import.meta.url))`），
 * 往上一级就都是 desktop/ 的布局根，一个表达式覆盖两种，也不用判断 isPackaged。
 */
export function iconPath(distDir: string): string {
  return join(distDir, '..', 'build', 'icon.png');
}
