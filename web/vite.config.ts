import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 开发时前端在 5173，API 和 SSE 都在 30035。/api 全转过去，
  // SSE 也走这条——所以不能只代理具体几个路径。
  server: { proxy: { '/api': 'http://localhost:30035' } },
  build: {
    /**
     * **第三方按库分包。**
     *
     * 在这之前只有一个 1758 kB 的大包，改一行应用代码整包的哈希就变，那 1.5 MB
     * 第三方代码跟着一起失效、重新下载重新解析。分开之后改应用代码只动 271 kB
     * 那一块。
     *
     * 分组是量出来的，不是拍的（`npm run build` 会把每一块的大小打出来）：
     *
     * | 块 | 大小 | 什么 |
     * |---|---|---|
     * | `v-antd` | **992 kB** | antd + rc-* + @ant-design/icons + **react/react-dom/scheduler** |
     * | `v-calendar` | 263 kB | FullCalendar 五个包（只有日历那一屏用） |
     * | `v-md` | 154 kB | react-markdown + remark/micromark 那一串 |
     * | `v-dnd` | 44 kB | @dnd-kit |
     * | `v-cn` | 23 kB | chinese-days（农历/节假日） |
     * | `index` | 271 kB | 这个应用自己的代码 |
     *
     * **React 也在 `v-antd` 里，不在主包**——这一条是量出来的，不是猜的：
     * `grep -c 'react.dev/errors'` 和 `unstable_scheduleCallback` 只在 `v-antd`
     * 里命中，`index` 和 `v-calendar` 都是 0。这段以前写着「其余
     * （react/react-dom/dayjs）留在主包里」，那是错的，于是「992 kB 全是 antd」
     * 这个判断也跟着错了约 190 kB。
     *
     * **试过用 `manualChunks` 把 react/react-dom/scheduler 单独切出来，切不动**
     * ——Vite 8 走的是 rolldown，加了那条判断之后清掉 `dist` 和 `node_modules/.vite`
     * 重打，产物哈希一个字节都没变。下一个人别再试同一条路；真要拆得换
     * rolldown 自己那套分块选项。
     *
     * **`v-antd` 那 992 kB 拆不动**，也不打算拆：用到 24 个组件、64 处引用，
     * 它就是这个界面本身。图标那部分量过，tree-shaking 是生效的——只打进
     * 2.1 kB（用到 5 个），不是漏网的大头。
     *
     * **没有把日历和 markdown 做成懒加载**（那能把首屏那一块再砍掉 417 kB）：
     * 那要新开一个模块、加两层 Suspense 和加载态，还要改一批测试；而这个应用
     * 跑在 localhost / Electron / 打进 APK，首包是本地读的，省下的解析时间在
     * 桌面上接近于零。真要为安卓那一侧再压，那时候再做，这条注释就是起点。
     */
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@fullcalendar')) return 'v-calendar';
          if (id.includes('@ant-design') || id.includes('/antd/') || id.includes('rc-')) return 'v-antd';
          if (/react-markdown|remark|micromark|mdast|unist|hast|vfile|decode-named|character-entities|property-information|space-separated|comma-separated|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|trim-lines|html-url-attributes|bail|is-plain-obj|trough|devlop|estree/.test(id)) return 'v-md';
          if (id.includes('chinese-days')) return 'v-cn';
          if (id.includes('@dnd-kit')) return 'v-dnd';
          return undefined;   // 其余（dayjs 等）留在主包里
        },
      },
    },
    /**
     * 默认 500 kB。**调到 1000 不是把警告关掉，是把它调到还能报事的位置**：
     * 唯一超过 500 的是 `v-antd`（990），而它是一个不打算拆的既定选择；把线
     * **从 1000 抬到 1100。** 1000 那会儿看着合适，实际只比 `v-antd` 当时的
     * 991.72 kB 高出 8 kB——antd 或者 React 下一次补丁级更新就会把它顶过线，
     * 而那种时候响的不是「有人塞了个大库进来」，是「依赖长了几 kB」，读的人
     * 会去翻 antd 的体积，翻到的什么也不是。1100 留出约 110 kB，塞进一个新的
     * 大库照样会响，日常补丁不会。
     * 直接关掉（设成 0/很大）就等于以后谁往包里塞进一个大库都没人知道。
     */
    chunkSizeWarningLimit: 1100,
  },
});
