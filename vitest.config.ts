import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 两套环境：node 跑服务端和纯函数，dom 跑组件渲染。
// dom 那一档只测一件事：某个字段的取值必须改变用户看到的东西。
// 不测样式布局、不追覆盖率——改版会大面积假红。
// 有 projects 时顶层 testTimeout 不会往下传，必须写在每档里。
const TIMEOUT = 15_000;

// 并发上限。不设的话 vitest 按核数铺满（这台机器 20 核），实测**全量会随机红**：
// 红的永远是超时（`OfflineWrite` / `TaskBoard` / `events` 那几条压 15s 线的），
// 每次红的用例还不一样，而那些文件单独跑都是几秒全绿。做过对照：把改动换回
// HEAD 原样跑，基线也红同一条——**不是某次改动引进的，是铺满之后 jsdom 环境
// 互相抢资源**。压到 6 之后全量 345s → 约 110s，交替各两轮零失败。
//
// 为什么不是放宽 `TIMEOUT`：那是把「机器忙的时候跑红、闲了跑绿」这种不确定性
// 藏起来，而这个仓库为「深夜跑红、过一小时跑绿」那类问题栽过。少铺几个 worker
// 反而更快，也就没有取舍。
const MAX_WORKERS = 6;

export default defineConfig({
  test: {
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        test: {
          name: 'node',
          include: ['server/src/**/*.test.ts', 'web/src/**/*.test.ts', 'desktop/src/**/*.test.ts', 'scripts/**/*.test.ts'],
          environment: 'node',
          // 兜住「忘了设 DATA_DIR / DEVICE_CONFIG」的测试，别让它们写这台机器上
          // 真实的设置和 data/。理由和那次真事故记在这个文件里。
          setupFiles: ['./scripts/test-setup-node.ts'],
          testTimeout: TIMEOUT,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          include: ['web/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./web/src/test-setup.ts'],
          testTimeout: TIMEOUT,
        },
      },
    ],
  },
});
