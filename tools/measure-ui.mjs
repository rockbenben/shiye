// 无头 Chrome + CDP 量测夹具。零依赖：Node 22+ 自带 WebSocket。
// 用法：node shot.mjs <url> <outDir> <w1xh1> <w2xh2> ...
import { writeFileSync, mkdirSync } from 'node:fs';

const [, , url, outDir, ...sizes] = process.argv;
mkdirSync(outDir, { recursive: true });

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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
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
      } else if (msg.method) c.events.push(msg);
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

await waitReady();

/**
 * **这次量测自己开一个 tab，量完关掉**，不复用浏览器里现成的那个。
 *
 * 复用同一个 tab 连着量几十屏会串味，实测过两种：上一屏留在 `localStorage`
 * 里的偏好（`density`/`listMode`）被下一屏读走；以及**跑到第四五个视图时
 * `Page.navigate` 直接超时**，整条命令挂掉——一个 tab 被反复 navigate 之后
 * 会攒下拆卸不干净的东西（挂在 body 末尾的 portal、没断开的 SSE）。
 *
 * 一屏一个干净 tab 比在这儿逐样清理可靠得多，代价是每次多几十毫秒。
 */
const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const page = created ?? (await targets()).find((t) => t.type === 'page');
if (!page) throw new Error('开不出 tab，也没有现成的可用');
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
const closeTab = async () => {
  if (created) await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`).catch(() => {});
};

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Console.enable').catch(() => {});
// **必须提到前台。** 后台 tab 里 `Page.captureScreenshot` 不报错，是一直挂着
// 不返回（合成器不给后台 tab 出帧），连着量几十屏时表现成「跑到一半卡死」。
await cdp.send('Page.bringToFront').catch(() => {});

const report = [];
// 出错时也要把 tab 关掉：不关的话连着跑十几个视图会攒下十几个 tab，
// 浏览器被拖垮，表现成「后面每一个视图的 Page.navigate 都超时」——
// 那时候看日志会以为是页面的问题，其实是夹具自己漏的。
try {
for (const size of sizes) {
  const [w, h] = size.split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: w < 600,
  });
  // 先回 about:blank 再进目标页。多尺寸连跑时，上一轮如果留下了打开的浮层
  // （Popconfirm、Drawer 这类挂在 body 末尾的 portal），直接 navigate 过去
  // 会让下一次 Runtime.evaluate 在无头 Chrome 里挂住不返回——实测稳定复现，
  // 单跑一个尺寸或者不点开浮层都不会。这是拆卸不干净，不是页面本身的问题。
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send('Page.navigate', { url });
  /**
   * **等「数据真的到了」，不是等 `readyState`。**
   *
   * 这个应用的任务是 fetch 回来之后才渲染的。`readyState === 'complete'` 那一刻
   * 渲染的是「还没有任何任务」那一屏——它本身也上千字符、也稳定，判成加载完成
   * 就会拍下一屏空的，而报告那半（溢出、过小文本、点击目标）**照样是绿的**，
   * 因为一屏空页面确实没有溢出。
   *
   * 判据：连着三拍 HTML 长度不变 **而且** 至少等满 2 秒。两条缺一不可——只看
   * 「稳定」会在空屏上立刻成立，只看「等满」会在慢的机器上仍然拍到半截。
   */
  let last = -1;
  let stable = 0;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML.length', returnByValue: true,
    });
    const len = result.value;
    stable = len === last ? stable + 1 : 0;
    last = len;
    if (stable >= 2 && Date.now() - t0 >= 2000) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // CLICK_TEXT=按来源 先点一下同名按钮再量——这个应用的大部分界面藏在状态里
  // （另一个视图、展开的表单、编辑态的卡片），只量默认那个等于漏掉一大半。
  // 用逗号分隔可以点一串：CLICK_TEXT=设置,导出数据。按可见文字找，不依赖内部
  // class；同名的多个按钮默认点第一个，用 `文字#2` 指定第几个。
  for (const step of (process.env.CLICK_TEXT || '').split(',').filter(Boolean)) {
    const [want, nth] = step.split('#');
    const { result } = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const want = ${JSON.stringify(want)};
        const nth = ${Number(nth) || 1};
        const norm = (s) => (s || '').replace(/\\s/g, '');
        const hits = [...document.querySelectorAll('button, [role=tab], a, summary')]
          .filter(e => norm(e.textContent) === norm(want) || norm(e.getAttribute('aria-label')) === norm(want));
        const el = hits[nth - 1];
        if (!el) return { ok: false, message: '  没找到「' + want + '」（同名候选 ' + hits.length + ' 个）' };
        el.click();
        return { ok: true, message: '  已点「' + want + '」' + (nth > 1 ? ' 第 ' + nth + ' 个' : '') };
      })()`,
    });
    console.log(result.value.message);
    // 找不到目标时不能只打个日志就照常往下量——量出来的是没点之前那个视图，
    // 报告看着照样是绿的，但量的根本不是要量的那个状态。非零退出让调用方
    // （CI、或者手工跑的人）看见的是失败，不是一份看起来正常但其实量错了
    // 东西的报告。
    //
    // 判据是浏览器那侧算出来的结构化 `ok`，不是在这一侧对 message 文案做字符串
    // 匹配——`.includes('没找到')` 曾经真的假失败过：CLICK_TEXT 指向一个名字
    // 本身就带「没找到」三个字的清单/标签（比如「没找到的东西」），点成功了，
    // message 变成「已点「没找到的东西」」，`.includes('没找到')` 照样命中，
    // 判成失败、退出码 1，见 2026-08-17-debt-sweep #15。哨兵值不看文案写的
    // 是什么，这一类目标名字撞见提示词的情况从写法上就不再成立。
    if (!result.value.ok) {
      console.error('CLICK_TEXT 里有目标没找到，上面这次量测量的不是预期状态，判失败。');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  // EVAL_JS='…' 在量测之前跑一段任意 JS。CLICK_TEXT 只够得着「有可见文字的
  // 按钮/链接」，而这个应用一大半界面藏在点不出来的状态里：批量操作条要
  // Shift/Ctrl 点选才出现，命令面板是 Ctrl+K，搜索结果要真的往输入框里打字，
  // 提醒横幅要等一条提醒到点。这一段就是为够着那些界面写的。
  //
  // **它们现在量过了**，够着的写法记在这儿，省得下一轮再推一遍：
  //
  //   详情栏      CLICK_TEXT=行 先切行档，再 EVAL_JS 点 `.ink-trow-open`
  //               （卡档下点标题是收起/编辑，不开详情）
  //   设置/搜索   CLICK_TEXT=设置 / 搜索——模块栏那几颗按钮的 aria-label
  //   新任务表单  CLICK_TEXT=新任务表单（加任务那一行右端那颗 ⌄）
  //   命令面板    EVAL_JS 派一个 Ctrl+K 的 keydown，document 和 window 各派一次
  //   快捷键表    同上，派 `?`
  //   批量操作条  EVAL_JS 对两行标题派 `new MouseEvent('click',{ctrlKey:true})`
  //   搜索结果    光改 input.value 不行（React 收不到）。要走原生 setter：
  //               `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
  //               'value').set.call(inp, '待办')` 再派一个 `input` 事件
  //   推荐面板    把那个 <details> 的 open 置真
  //   安排任务栏  CLICK_TEXT=安排任务（日历那一屏右上角）
  //
  // **注意密度会串味**：同一个 `--user-data-dir` 的 localStorage 是跨 tab 共享
  // 的，某一趟点过「行」之后，后面每一趟都是行档。要么每趟先点回「卡」，
  // 要么就当心量的不是你以为的那一档。
  //
  // 跟 CLICK_TEXT 同一条失败口径：这段 JS 抛异常、或者自己 return 一个
  // `{ ok: false, message }`，都判失败退出——量出来的要么是没进到目标状态的
  // 那一屏，要么根本是另一个界面，报告照样是绿的才最糟。返回别的值（含
  // undefined）当成成功。
  const evalJs = process.env.EVAL_JS;
  if (evalJs) {
    const res = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => { ${evalJs} })()`,
    }).catch((e) => ({ exceptionDetails: { text: '发不出去：' + String(e) } }));

    // **异常要从 exceptionDetails 里读，不能只看返回值。** `Runtime.evaluate`
    // 在脚本抛异常时**不会**让上面这个 send 拒绝——它照常 resolve，把异常放进
    // `exceptionDetails`，`result` 那半是个 subtype:'error' 的对象；再叠上
    // returnByValue，一个 Error 会被序列化成 `{}`（自有可枚举属性一个都没有）。
    // 于是 `v.ok === false` 是 false，脚本打印「已跑 EVAL_JS」，然后**照常去量
    // 那个根本没进去的状态**——EVAL_JS='document.querySelector(".不存在").click()'
    // 会产出一份干干净净的绿报告，量的却是另一个界面。上面那个 .catch 只兜得住
    // 传输层的错（连接断了），兜不住脚本自己抛的。
    const ex = res.exceptionDetails;
    if (ex) {
      console.error('EVAL_JS 抛异常：', ex.exception?.description ?? ex.text ?? JSON.stringify(ex));
      process.exit(1);
    }
    const v = res.result?.value;
    if (v && v.ok === false) {
      console.error('EVAL_JS 判失败：', v.message ?? '(没给 message)');
      process.exit(1);
    }
    console.log('  已跑 EVAL_JS' + (v && v.message ? '：' + v.message : ''));
    await new Promise((r) => setTimeout(r, 700));
  }

  const { result: metrics } = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const de = document.documentElement;
      const over = [...document.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).slice(0, 8).map(e => ({
        cls: (e.className && e.className.baseVal !== undefined ? e.className.baseVal : String(e.className || '')).slice(0, 60),
        tag: e.tagName, right: Math.round(e.getBoundingClientRect().right),
      }));
      const tinyEls = [...document.querySelectorAll('*')].filter(e => {
        if (!e.childNodes.length) return false;
        const hasText = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) return false;
        // 读屏专用的那种「1px 见方 + clip」的藏字元素不算——它的字号对着谁都不
        // 生效，人一个像素都看不到。之前这一类每屏报三四条，混在真的过小文本里，
        // 逼着每次都手工把它们挑出去。判据是渲染出来的盒子，不是类名：别处再写
        // 一个别的名字的藏字元素，同样不会被算进来。
        const box = e.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) return false;
        return parseFloat(getComputedStyle(e).fontSize) < 11;
      });
      const tiny = tinyEls.length;
      const tinySample = tinyEls.slice(0, 12).map(e => ({
        px: parseFloat(getComputedStyle(e).fontSize),
        txt: e.textContent.trim().slice(0, 18),
        cls: String(e.className || '').slice(0, 40),
      }));
      // 量的是「真正能点的那块矩形」，不是控件元素本身。两种常见的包法：
      //   1. <label> 包着 checkbox/radio——那个 <input> 通常被绝对定位成 16x16
      //      盖在方框上，但点 label 任何地方（包括文字）都生效
      //   2. 组件库给输入框套的外壳（antd 的 .ant-picker / .ant-input-number
      //      之类）——里面的 <input> 只有 22px 高，外壳 32px，点外壳一样生效
      // 照着 <input> 量会把这两类本来够大的目标全误报成过小的。
      //
      // 第二种不写死任何框架类名，靠一条通用判据往上爬：**只包着这一个表单
      // 控件、且高度不超过它两倍的祖先，就是它的外壳。**「只包着一个控件」
      // 这条是关键——一行里并排两个日期选择器的那个容器包着两个控件，会在
      // 这里停住，不会一路爬到整张卡片上去把真正过小的目标也蒙混过关。
      const CONTROLS = 'button, [role=button], a, input, textarea, select';
      // 「点得着」的判据只写一次，爬升和下面的筛选共用同一份。
      // **爬升那一步以前不看这个**，只数 querySelectorAll(CONTROLS).length，
      // 于是被 antd 的「清除」按钮坑了：ant-picker-input 里除了真正的那个
      // input，还挂着一颗 14×14、opacity 为 0 且 pointer-events 为 none 的清除
      // 按钮（悬停才显形）。控件数因此是 2 不是 1，爬升在第一层就停住，量到的
      // 是裸 input 的 22px 高——报出来是「截止时间/提醒时间两个过小点击目标」，
      // 而真正可点的 ant-picker 外壳有 32px，点它任何地方都会打开日期面板。
      // 这条误报会波及所有带 allowClear 的 antd 控件（DatePicker/Select/Input），
      // 不只是这两个。
      // （注意：这一整段是拼进 Runtime.evaluate 的模板字符串里的，**注释里不能
      // 出现反引号**，会把外面那个模板字符串提前闭合掉。）
      const hittable = (e) => {
        // 禁用的控件不是点击目标——点了什么都不会发生。踩到这条的是备注里
        // 渲染出来的 markdown 勾选框（「- [ ]」）：Markdown.tsx 有意给它们写死
        // disabled（那是文本，不是 subtasks 那个数据模型，点了没反应比没有
        // 更糟），而它们 22px 高，于是每一屏都报三五个改不掉的「过小点击
        // 目标」。跟下面那个隐藏 textarea 是同一类误报、同一个理由。
        if (e.disabled) return false;
        // **checkVisibility 而不是只读这一层的 computed style。** 只看自己那一层
        // 会被「祖先透明、自己不透明」骗过去：antd 的 InputNumber 把上下箭头装在一个
        // opacity:0 的 ant-input-number-actions 里（悬停才显形），箭头自己的
        // computed opacity 是 1——于是每一个 InputNumber 都会报出两个「1x15 的过小
        // 点击目标」，而屏幕上那两个东西平时根本不存在。opacity 不继承，读自己那层
        // 永远看不见祖先。checkVisibility 一路往上查（display/visibility/opacity/
        // content-visibility），Chrome 105+ 就有。
        if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
        return getComputedStyle(e).pointerEvents !== 'none';
      };
      const hitTarget = (e) => {
        if (e.tagName !== 'INPUT') return e;
        const label = e.closest('label');
        if (label) return label;
        let hit = e;
        const maxH = e.getBoundingClientRect().height * 2;
        for (let p = e.parentElement; p; p = p.parentElement) {
          // 「只包着这一个**点得着的**控件」——一行里并排两个日期选择器的那个
          // 容器包着两个真控件，照样会在这里停住，不会一路爬到整张卡片上去把
          // 真正过小的目标蒙混过关。
          if ([...p.querySelectorAll(CONTROLS)].filter(hittable).length !== 1) break;
          if (p.getBoundingClientRect().height > maxH) break;
          hit = p;
        }
        return hit;
      };
      const small = [...document.querySelectorAll(CONTROLS)]
        .map(e => {
          const hit = hitTarget(e);
          return { e, hit, r: hit.getBoundingClientRect() };
        })
        // 点不着的东西不算点击目标。antd 的 autosize TextArea 会额外渲染一个
        // 隐藏的 <textarea> 用来量高度，它照样有尺寸（约 200x10），照单全收
        // 就会年年报一个修不掉的「过小目标」。
        .filter(({ hit }) => hittable(hit))
        .filter(({ r }) => r.width > 0 && (r.height < 24 || r.width < 24));
      const smallSample = small.slice(0, 10).map(({ e, hit, r }) => ({
        txt: (hit.textContent || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().slice(0, 16),
        tag: e.tagName + (e.type ? '[' + e.type + ']' : ''),
        cls: String(hit.className || '').slice(0, 44),
        w: Math.round(r.width), h: Math.round(r.height),
      }));
      return {
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        hOverflow: de.scrollWidth > de.clientWidth,
        // smallCount 是真实总数；smallTargets 只是前 10 个样本。这两个数以前是
        // 同一个（先 slice 再数），于是不管页面上有多少过小目标，报告永远是 10。
        offenders: over, tinyText: tiny, tinySample,
        smallCount: small.length, smallTargets: smallSample,
        h1h3: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => h.tagName + ':' + h.textContent.trim().slice(0, 18)),
      };
    })()`,
  });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: true });
  const file = `${outDir}/${w}x${h}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  report.push({ size, file, ...metrics.value });
  console.log(`${size}  溢出=${metrics.value.hOverflow ? '有 ***' : '无'}  scrollW=${metrics.value.scrollW}/${metrics.value.clientW}  小于11px的文本节点=${metrics.value.tinyText}  过小点击目标=${metrics.value.smallCount}`);
}

} finally {
  await closeTab();
}

writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log('\n写入', `${outDir}/report.json`);
cdp.close();
