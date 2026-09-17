import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';

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
//
// **6 是照这台 20 核机器调出来的一个绝对值，换台小机器它就重新变成「铺满」。**
// 第一次推上 GitHub Actions 就撞了：标准 windows runner 只有 4 核，6 个 fork
// 出来的 jsdom worker 挤在上面，跑了 430 秒之后一个 worker 直接被干掉——
// `[vitest-pool]: Worker forks emitted error / Worker exited unexpectedly`，
// **一条测试都没红**（168/169 个文件通过、5208/5226 条通过），只是有一个文件
// 没跑完，整个 job 退 1。跟上面那次「铺满就随机红」是同一件事的另一副面孔。
//
// 所以改成跟着机器走：`min(6, 核数 - 1)`。这台机器上仍然是 6（跟调出这个数字
// 时一模一样，上面那些实测数据继续成立），4 核的 runner 上是 3，留一个核给
// 主进程和系统。下限 2 是防 1 核机器上算出 0。
const MAX_WORKERS = Math.min(6, Math.max(2, availableParallelism() - 1));

/**
 * **整套测试跑在哪个时区。**
 *
 * 这个应用的日期语义是「本地墙钟」（`dayKey`、`isAllDay`、四象限的「今天」全
 * 按本地取值），测试里大量夹具是 `new Date(2026, 7, 11, 18)` 这种本地构造 +
 * `toISOString()` 存进任务里，再跟另一个本地构造的期望值比——**只有整个进程
 * 在同一个时区里，两边才对得上**。
 *
 * 原来的做法是在三个文件里 `beforeEach(() => vi.stubEnv('TZ', 'Asia/Shanghai'))`。
 * 那是**假的钉死**，第一次推上 CI 就红了 6 条：`vi.stubEnv` 要等 `beforeEach`
 * 才生效，而 `describe` 体里那些 `const t = task({ due: new Date(…) })` 是
 * **收集阶段**就求值的——夹具按宿主时区算，断言按钉死的 +08 算。开发机宿主
 * 本来就是 +08，两边碰巧一致，于是这个洞在本机永远看不见；GitHub runner 是
 * UTC，`reschedulePatch` 收到的 `prev` 当场差 8 小时（实测：期望
 * `2026-08-13T10:00:00.000Z`，拿到 `2026-08-12T18:00:00.000Z`，正好是把
 * 「本地 18:00」当成「本地 02:00」）。
 *
 * 写在这里，worker 一起来就是这个时区，收集阶段和断言阶段同一个语境，跟宿主
 * 机在哪儿无关。那三个文件里的 `vi.stubEnv('TZ', …)` 就成了同值的空操作，
 * 留着无害（它们各自的注释还解释着那条守卫为什么要钉时区）。
 *
 * ponytail: **这等于宣布「这套测试只在东八区语境下验过」**。天花板很明确——
 * 别的时区上的真 bug 这套测试看不见（比如负时区把只有日期的字符串按 UTC 解析
 * 退回前一天，`calendarMarks.ts` 那条注释担心的正是它）。要真覆盖多时区，
 * 得把时区变成用例的一个维度跑两遍，那是另一件事；现在先让「本机绿 = CI 绿」
 * 成立，而不是让 CI 去发现开发机被宿主时区掩盖掉的洞。
 */
const TZ = 'Asia/Shanghai';

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
          // 跟 testTimeout 同一条理由：有 projects 时顶层不往下传，每档各写一遍。
          env: { TZ },
          // ──────────────────────────────────────────────────────────────
          // ⚠️ **这一档原来钉着一个常驻 worker，现在没钉了。别照着下面那段
          // 历史去找 `poolOptions`——它在 Vitest 4 上是空转的，已经删掉了。**
          // ──────────────────────────────────────────────────────────────
          //
          // 【历史：为什么当初钉过】CI 连红四次，红的都不是断言：
          // `[vitest-pool]: Worker exited unexpectedly`，168/169 个文件通过、
          // 零失败用例、日志里没有退出码也没有 OOM 字样。对着逐文件用例数比出来
          // 是 `events.test.ts`（本机 28 条、CI 只跑到第 9 条），而第 10 条是
          // 「建 Bus、emit、睡 80ms、订阅、断言」这种连 native 崩溃的材料都没有的
          // 用例——**所以崩的不是那条测试，是承载它的那个子进程**。
          // fork 池默认会在文件之间回收并重建子进程，钉成一个常驻 worker 之后
          // 从头到尾不再有进程创建/销毁。当时的实测：本机全量 159s → 149s
          // （node 档 116 个文件基本是纯函数和小文件读写，单个文件的耗时远小于
          // fork 一个新进程的开销，串行省下的正是这一笔），dom 档不受影响。
          //
          // 【为什么现在没有】v4 把 `poolOptions` **整个移除**、改成顶层选项
          // （官方迁移指南："`poolOptions` is removed. All previous `poolOptions`
          // are now top-level options"）。旧写法**不报错、只是被静默忽略**——
          // 唯一的声音是每次跑测试开头那句
          // `DEPRECATED test.poolOptions was removed in Vitest 4`。也就是说上面
          // 那段结论**空转了一段时间**：这一档不再单独钉 1 个 worker，而是跟 dom 档
          // 共用顶层那 6 个。**注意不是「按核数铺满」**——`maxWorkers: 6` 那条修复
          // 写在顶层，一直生效，它管的是另一件事（见下）。
          //
          // ⚠️ **这个文件里有两段独立的并发修复，症状不一样，别混起来。**
          //
          //   - 顶层 `maxWorkers: MAX_WORKERS`（文件开头那段长注释）：针对
          //     「不设就按核数铺满，全量随机红，**红的永远是超时**——`TaskBoard` /
          //     `OfflineWrite` / `events` 那几条压 15s 线的」。**它一直生效。**
          //   - 这一档原来的 `singleFork`：针对 CI 上 `Worker exited unexpectedly`
          //     ——**进程崩溃**，一条测试都没红，只是有文件没跑完。
          //     **它空转了。**
          //
          // 所以判据是：**见到超时先怀疑负载**（尤其是你自己在同时改文件、跑别的
          // 命令、或跑 `npm test` 那三道 tsc），**见到崩溃才想到这一段**。
          // 把超时归到 `singleFork` 空转上是错的——我这么错过一次，写在这里免得
          // 下一个人跟着错。
          //
          // 【试过补回来，代价是慢一倍】按官方映射（`singleFork` →
          // `maxWorkers: 1`）在这一档加回 `maxWorkers: 1`，实测全量
          // **378s**；不加是 **约 190s**。慢的不是这一档本身，是 v4 的调度模型：
          // `groupSpecs` 按 `sequence.groupOrder` 分桶，**两个 project 的
          // maxWorkers 不一样就必须分到不同的桶，而桶与桶之间严格串行**
          // （`executeTests` 里 `for (const group of taskGroups)` + `await`）。
          // 于是 node 档串行的时候 dom 档在旁边闲着，两个档不再重叠。
          // `isolate: false`、`sequence.groupOrder` 几条路都试过，结论一样：
          // **v4 里「node 档钉 1 个 worker、dom 档并行、两者同时跑」写不出来。**
          //
          // 【所以选择不钉】当初钉它是为了躲 fork 池回收子进程那条竞争，而 v4 的
          // 池子是**整个重写过的**（官方原话："Vitest 4 completely removed
          // tinypool, rewrote the pool"），那条竞争不一定还在；而慢一倍是每跑
          // 一次都要付的确定代价。
          //
          // ponytail: 这是**没验过的判断**——本机没有 CI 那种 4 核环境，验不了
          // 「不钉会不会又 `Worker exited unexpectedly`」。真要再钉，就是在这一档
          // 加一行 `maxWorkers: 1`，代价是上面那个 378s。哪天 CI 上真见到那个报错，
          // 先回来看这一段，别重新发明 `poolOptions`。
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
          env: { TZ },
        },
      },
    ],
  },
});
