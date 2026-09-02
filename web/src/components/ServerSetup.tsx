import { useState } from 'react';
import { Alert, Button, ConfigProvider, Input, Space } from 'antd';
import { getApiBase, setApiBase } from '../lib/apiBase.js';
import { boardLocalTheme } from '../theme.js';

/**
 * 客户端认的接口版本号。跟 `server/src/app.ts` 的 `API_VERSION` 手动保持一致
 * ——见那边的注释。装进 Android APK 里的 `web/` 是打包那一刻的快照，跟桌面
 * 服务不一定同一次提交，「测试连接」要能分清「连上了但不是办事师爷」和
 * 「连上了、是办事师爷、但版本对不上」，就得有这一份，不然永远只有二选一。
 */
export const CLIENT_API_VERSION = 1;

/**
 * 一次连接测试的结果。四选一，不是一个布尔值——`server/src/index.ts` 的
 * `alreadyOurs()` 探 `/api/health` 判断占用端口的是不是自己，判据的思路是
 * 「fetch 加超时、异常当连不上、`json.ok !== true` 当不是这个服务」，这里
 * 复用同一个思路，只是把它的二选一（是/不是）拆成用户能看懂原因的三种失败：
 * 连不上、连上了但不是办事师爷、连上了是办事师爷但版本对不上。
 */
export type ConnectionCheck =
  | { kind: 'ok' }
  | { kind: 'version-mismatch'; serverVersion: unknown }
  | { kind: 'not-ours' }
  | { kind: 'unreachable' };

/**
 * 探一次 `base + /api/health`。超时时长（1500ms）照抄 `alreadyOurs()`——同一件
 * 事没必要另挑一个数。
 */
export async function testConnection(base: string): Promise<ConnectionCheck> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return { kind: 'unreachable' };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; version?: unknown } | null;
  if (!res.ok || body?.ok !== true) return { kind: 'not-ours' };
  if (body.version !== CLIENT_API_VERSION) return { kind: 'version-mismatch', serverVersion: body.version };
  return { kind: 'ok' };
}

/** 人话版失败原因，「测试连接」按钮下面显示的就是这个。 */
export function describeConnectionCheck(r: ConnectionCheck): string {
  switch (r.kind) {
    case 'ok':
      return '连接成功。';
    case 'unreachable':
      return '连不上——检查地址和端口有没有填对，两台设备是不是在同一个局域网。';
    case 'not-ours':
      return '连上了，但这不像「办事师爷」的服务——检查端口有没有被别的程序占用了。';
    case 'version-mismatch':
      return `连上了、是「办事师爷」，但版本对不上（这台服务是 ${String(r.serverVersion)}，这个 App 认的是 ${CLIENT_API_VERSION}）——把两边都升级到同一个版本。`;
  }
}

/**
 * `dataSource.ts` 的 `probeOnline()` 判断「连不连得上桌面服务」时用——这是
 * `isOnline()`/离线横幅唯一的判据来源。这里的「连得上」按这份检查的定义走：
 * 连上了、确实是「办事师爷」（`kind === 'ok'`），或者连上了是「办事师爷」只是版本
 * 对不上（`kind === 'version-mismatch'`）——后者也算「连得上」：桌面服务跟
 * 这份 `web/` 出自同一次构建，版本理应永远一致，真出现不一致多半是本机
 * 构建产物损坏之类的边缘情况，不该因此判成离线、扣一条离线横幅在头上，那对
 * 用户没有任何帮助。只有真正连不上、或者连上了压根不是这个服务，才算离线。
 */
export function looksLikeOwnServer(r: ConnectionCheck): boolean {
  return r.kind === 'ok' || r.kind === 'version-mismatch';
}

interface Props {
  /**
   * 保存成功之后调用。默认整页刷新——`api.ts` 的每次请求会读到刚存的新
   * base（`getApiBase()` 是同步的，见 apiBase.ts），但 `subscribe()` 开的
   * `EventSource` 把 base 焊死在了构造那一刻的 URL 上，光改 base 不会让它
   * 断线重连到新地址；App.tsx 挂载时那次 `reload()` 也只跑一次，地址填错
   * 的情况下已经失败过、不会自己重试。整页刷新是最简单、最不容易漏掉这些
   * 副作用的做法——测试传一个空函数进来，不然 jsdom 会在控制台打一条
   * 「Not implemented: navigation」（无害，但吵）。
   */
  onSaved?: () => void;
}

/**
 * 服务地址表单：输入框 + 「测试连接」+「保存」。**现在只有一处调用**——
 * `SettingsModal` 里常驻一份，供随时重填（填错了、服务换了地址，都在
 * 这里改，见 task-3-brief）。以前 App.tsx 首次启动时还会整页展示它（没
 * 配过地址、又探不到本机服务的手机会先看到这个界面挡住本地功能），那面
 * 墙已经删掉——没配地址也能直接用本地功能，见 App.tsx 里 `offline` state
 * 定义处的注释。
 *
 * antd 的 Input/Button 选中/主色都直接读全局 `colorPrimary`（群青，见
 * theme.ts 顶部注释），这里是用户自己打字/点按钮，不是 AI 产出的东西，套
 * `boardLocalTheme` 压回你的墨——包在组件内部而不是指望每个调用方记得包，
 * 这样不会有调用方忘了套这一层。
 */
export function ServerSetup({ onSaved = () => window.location.reload() }: Props) {
  const [value, setValue] = useState(() => getApiBase());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionCheck | null>(null);

  const normalized = () => value.trim().replace(/\/+$/, '');

  const runTest = async () => {
    setTesting(true);
    const r = await testConnection(normalized());
    setTesting(false);
    setResult(r);
  };

  const save = () => {
    setApiBase(value);
    onSaved();
  };

  return (
    <ConfigProvider theme={boardLocalTheme}>
      <div className="ink-server-setup">
        <Input
          aria-label="服务地址"
          placeholder="http://192.168.1.5:30035"
          value={value}
          onChange={(e) => { setValue(e.target.value); setResult(null); }}
        />
        <Space style={{ marginTop: 8 }}>
          <Button loading={testing} onClick={() => void runTest()}>测试连接</Button>
          {/* color="default" variant="solid"：这是用户自己按的确认动作，不走
              type="primary"——那会拿群青，见 theme.ts 里 Button 那段注释、
              SettingsModal「保存」按钮同一条规矩。 */}
          <Button color="default" variant="solid" onClick={save}>保存</Button>
        </Space>
        {result && (
          <Alert
            style={{ marginTop: 8 }}
            type={result.kind === 'ok' ? 'success' : 'error'}
            showIcon
            message={describeConnectionCheck(result)}
          />
        )}
      </div>
    </ConfigProvider>
  );
}
