import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './theme.css';
import { theme } from './theme.js';
import { App as TodoApp } from './App.js';

// antd 的 <App> 不是可选的装饰：App.tsx 里用 AntApp.useApp() 取 message，
// 而那个 hook 必须有这个 provider 在上面。直接 import 静态的 message 也能弹，
// 但它拿不到 ConfigProvider 的主题和 locale，antd 会在控制台告警。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* button={{ autoInsertSpace: false }}：antd 默认给「恰好两个汉字、没有图标、
        非 text/link 变体」的按钮插一个空格（比如「开始」渲染成「开 始」），但
        text/link 变体不插——「编辑」「删除」用 type="text" 逃过一劫，「开始」
        「搁置」用默认变体的两字按钮就中招，同一张卡上的按钮，字距长得不一样。
        全局关掉这条老规则，两字按钮到处都是「开始」，不是「开 始」——见
        已归档的 docs/superpowers/specs/2026-08-12-ux-audit.md「两字按钮的空格不一致」。
        组件测试里用 `.textContent?.replace(/\s/g, '')` 按中文找按钮的写法
        仍然成立（这些测试本来就是防两种写法都能命中，不用因为这里关了就去改）。 */}
    <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
      {/* message.top：把提示浮层压到页眉下面。默认是 top: 8，浮层正好盖住整条
          页眉——而页眉上挂着「收件箱 N 条待拆解」「AI 建议 N 条待确认」这两个
          实时计数，提示要报告的往往就是它们的变化（接受一条建议、存下一条笔记），
          在变的那一刻把它遮住是反的。手机宽度下页眉更矮但浮层会折成两行，
          遮挡更严重，实测 390px 下整条页眉连「设置」一起看不见。
          76px = 页眉高度 + 一点余量。 */}
      <AntApp message={{ top: 76 }}>
        <TodoApp />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
