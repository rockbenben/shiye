import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rockbenben.shiye',
  appName: '办事师爷',
  webDir: 'web/dist',
  // Capacitor 8 Android 端默认 androidScheme 是 'https'（CapConfig.java），不覆盖的话
  // WebView 的 origin 就是 https://localhost——既不在 server/src/app.ts 的
  // ALLOWED_ORIGINS 白名单里，又是安全上下文，fetch 局域网明文地址会被 Blink 当成
  // 主动混合内容直接拦掉，在 CORS 之前就死了（final-review.md C1）。改成 'http'
  // 让 origin 变成 http://localhost（已经在白名单里），混合内容检查对 http 页面
  // 整个不适用，也就不需要打开 allowMixedContent 这个更宽的开关。
  server: { androidScheme: 'http' }
};

export default config;
