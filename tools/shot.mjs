// 无头 Chrome + CDP 截图夹具。零依赖（Node 22+ 自带 WebSocket），CDP 那半边
// 跟 tools/measure-ui.mjs 同源——那个量尺寸，这个出图，共用一套连接和等待逻辑。
//
// 用法：
//   CDP_PORT=9333 node tools/shot.mjs <baseUrl> <outDir> <宽x高> <hash1> <hash2> ...
// 例：
//   node tools/shot.mjs http://localhost:30035 /tmp/shots 1280x900 today upcoming calendar
//
// 为什么要有它：「界面难看」这种反馈没法靠读代码处理，得先看见。
import { writeFileSync, mkdirSync } from 'node:fs';

const [, , baseUrl, outDir, size, ...hashes] = process.argv;
if (!baseUrl || !outDir || !size || !hashes.length) {
  console.error('用法: node tools/shot.mjs <baseUrl> <outDir> <宽x高> <hash...>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const [W, H] = size.split('x').map(Number);
const PORT = Number(process.env.CDP_PORT || 9333);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    // 判据是「/json/list 答得出话」，**不是「里面已经有 target」**。这两个夹具都自己
    // 开 tab，跑完又把自己那个关掉——「浏览器活着、但一个 tab 都不剩」是每次跑完的
    // 常态。以前这儿要求 t.length 非零，于是下一次跑进来直接抛「CDP 在 9333 上没起来」，
    // 指着一个好好活着、端口也正常答话的浏览器。那句话把人引去重启浏览器，而浏览器
    // 没毛病；实测被它坑掉过一整轮量测。
    try { return await targets(); } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP 在 ${PORT} 上没起来`);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method} 超时`)); }, 30000);
    });
  }
  close() { this.ws.close(); }
}

const list = await waitReady();
// 一个 tab 都没有时自己开一个，而不是在 undefined 上取 webSocketDebuggerUrl 崩掉。
// measure-ui.mjs 跑完会把它自己开的那个关掉，浏览器空着是常态。
const page = list.find((t) => t.type === 'page') || list[0]
  || (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()));
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});

const evalJs = (expression) =>
  cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

for (const hash of hashes) {
  const url = `${baseUrl}/#/${hash}`;
  await cdp.send('Page.navigate', { url });
  // 先等 load，再等界面自己稳下来。这个应用启动时要拉 tasks/inbox/lists…
  // 若干个接口再渲染，navigate 完成 ≠ 画完了。
  await new Promise((r) => setTimeout(r, 1200));
  // hash 路由：同一个文档内换 hash 不触发导航，显式派发一次。
  await evalJs(`location.hash = ${JSON.stringify('#/' + hash)}; dispatchEvent(new HashChangeEvent('hashchange'));`);
  await new Promise((r) => setTimeout(r, 900));

  const title = await evalJs(`document.querySelector('.ink-view-title')?.textContent ?? '(无标题)'`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${outDir}/${hash.replace(/[^\w-]/g, '_')}.png`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`${file}  ← ${title.result.value}`);
}

cdp.close();
process.exit(0);
