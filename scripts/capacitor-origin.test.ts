import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// C1（final-review.md）：capacitor.config.ts 的 server.androidScheme 决定手机
// WebView 的 origin 是 http://localhost 还是（不设就落回 Capacitor 8 默认的）
// https://localhost；server/src/app.ts 的 ALLOWED_ORIGINS 是另一份手写的白名单。
// 两处各写一份——这个仓库为这个形状栽过很多次（CalendarView 第五个字段是最近
// 一次）。上一轮这两处就是没对齐：capacitor.config.ts 没设 androidScheme，白名单
// 里却只有 capacitor://localhost（iOS）和 http://localhost，真机 origin 是
// https://localhost，两边都对不上，手机连不上桌面服务，而 `expect(ALLOWED_ORIGINS)
// .toEqual([...])` 那条老测试全程是绿的——它只断言「白名单恰好是这两个」，证明不了
// 「这两个是对的那两个」。
//
// 这条测试从 capacitor.config.ts 实际配的 scheme 出发（不是假设它一定是 'http'），
// 反过来要求 ALLOWED_ORIGINS 里有对应的 `${scheme}://localhost`——任何一处改了、
// 另一处没跟着改，这里会红。用文本正则读两个文件，不做跨 workspace 的模块 import：
// capacitor.config.ts 在根目录、不属于 server/web 任何一个 tsconfig 项目，照 npm test
// 现有的 scripts/*.test.ts（keystore-not-tracked.test.ts、launchers.test.ts）走的
// 都是这条路，不是这里另开的先例。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('CORS 白名单跟 capacitor.config.ts 配的 androidScheme 一致', () => {
  it('capacitor.config.ts 显式设置了 server.androidScheme', () => {
    const config = readFileSync(join(repoRoot, 'capacitor.config.ts'), 'utf8');
    const m = config.match(/androidScheme:\s*'([^']+)'/);
    expect(
      m,
      'capacitor.config.ts 必须显式设置 server.androidScheme —— 不设的话 Capacitor 8 ' +
      'Android 端默认 https，WebView 的 origin 会变成不在白名单里的 https://localhost，' +
      '而且是安全上下文，fetch 局域网明文地址会被当成主动混合内容拦掉（final-review.md C1）',
    ).not.toBeNull();
  });

  it('androidScheme 是 http —— https 会撞上安全上下文的混合内容拦截', () => {
    const config = readFileSync(join(repoRoot, 'capacitor.config.ts'), 'utf8');
    const scheme = config.match(/androidScheme:\s*'([^']+)'/)![1];
    // 混合内容检查只对「restricting mixed content」的 scheme 生效（只有 https 和
    // wss），http 页面整个不适用——这是让手机在不打开 allowMixedContent 这个更宽
    // 的全局开关的前提下，还能直接 fetch 局域网明文地址的唯一办法。
    expect(scheme).toBe('http');
  });

  it('ALLOWED_ORIGINS 里有一条跟 capacitor.config.ts 配的 scheme 对应的 origin', () => {
    const config = readFileSync(join(repoRoot, 'capacitor.config.ts'), 'utf8');
    const scheme = config.match(/androidScheme:\s*'([^']+)'/)![1];

    const app = readFileSync(join(repoRoot, 'server', 'src', 'app.ts'), 'utf8');
    const originsMatch = app.match(/ALLOWED_ORIGINS = \[([^\]]+)\]/);
    expect(originsMatch, 'server/src/app.ts 里没找到 ALLOWED_ORIGINS 的定义').not.toBeNull();

    expect(originsMatch![1]).toContain(`'${scheme}://localhost'`);
  });
});
