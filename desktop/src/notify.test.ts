import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { buildNotificationOptions, buildToastXml, SNOOZE_MINUTES, toNotification, type NotifyContent } from './notify.js';

const task = (over: Record<string, unknown> = {}) => ({ id: 't1', title: '交房租', ...over });

describe('toNotification：reminder 和 daily-summary 弹', () => {
  it('reminder → id + 标题 + 任务名', () => {
    expect(toNotification('reminder', task())).toEqual({ id: 't1', title: '该做了', body: '交房租' });
  });

  // 只用一个夹具的话，「body 永远写死成 '交房租'」这种实现也能通过上面那条——
  // 实测过，12 条全绿。第二个标题不同的夹具才分得清「读了这一条的标题」和
  // 「永远弹同一个任务名」。
  it('body 是这一条的标题，不是写死的', () => {
    expect(toNotification('reminder', task({ title: '写周报' }))).toEqual({ id: 't1', title: '该做了', body: '写周报' });
  });

  // id 同理：不能是写死的 't1'，第二个 id 不同的夹具才分得清「读了这一条
  // 的 id」和「永远返回同一个字面量」。
  it('id 是这一条的 id，不是写死的', () => {
    expect(toNotification('reminder', task({ id: 't2' }))).toEqual({ id: 't2', title: '该做了', body: '交房租' });
  });

  /**
   * **每日概览。** 这一档原来整个漏了：这个函数第一行写死
   * `if (event !== 'reminder') return null`，而服务端那侧的兜底是「桌面端
   * 在线就不另起 PowerShell 弹窗，它自己会弹」（`reminder.ts`
   * `fireDailySummary`）——两下一凑，**桌面端开着的时候每日概览谁也收不到**。
   *
   * 上面那条 `it.each` 当时列的是「data-changed / agent-status / ping /
   * 未来某个新事件」，`daily-summary` 一次都没出现过——**漏掉的东西不会
   * 自己出现在反例名单里**，这也是为什么下面那条改成了从一份事件全表里
   * 减，而不是自己手列几个。
   */
  it('daily-summary → 没有任务 id，标题和正文是服务端拼好的那两句', () => {
    expect(toNotification('daily-summary', { title: '今天 3 件事', body: '· 交房租；· 写周报' }))
      .toEqual({ id: null, title: '今天 3 件事', body: '· 交房租；· 写周报' });
  });

  it('概览的正文可以是空的——一件事都没有时服务端本来就不发，但形状上不该炸', () => {
    expect(toNotification('daily-summary', { title: '今天 1 件事' }))
      .toEqual({ id: null, title: '今天 1 件事', body: '' });
  });

  it('概览没有标题不弹——一条没有标题的通知等于一条空白横条', () => {
    expect(toNotification('daily-summary', { body: '· 交房租' })).toBeNull();
    expect(toNotification('daily-summary', { title: '   ', body: '· 交房租' })).toBeNull();
  });

  // 上限方向：只有正向断言的话，「什么事件都弹」照样能过上面那几条。
  it.each(['data-changed', 'agent-status', 'ping', '未来某个新事件'])('%s 不弹', (e) => {
    expect(toNotification(e, task())).toBeNull();
  });
});

/**
 * **服务端每加一种总线事件，这儿必须表态一次。**
 *
 * 上面那条 `it.each` 当时列的是「data-changed / agent-status / ping /
 * 未来某个新事件」——`daily-summary` 一次都没出现过，而它正是漏掉的那一档。
 * **漏掉的东西不会自己出现在反例名单里**：手列的名单只覆盖想得起来的事件，
 * 想不起来的那个恰恰就是会出问题的那个。
 *
 * 所以名单改成从服务端源码里扫出来的，桌面端这边给每一种一句明确的处置。
 * 服务端以后再 `emit` 一种新事件，这条当场变红，逼着人回答「桌面端要不要弹」
 * ——而不是等到某天发现某个通知谁也没收到。
 */
describe('总线事件全表：每一种桌面端都表过态', () => {
  // `emit('ping')` 不存在——心跳是 SSE 那一层自己写的（app.ts 的
  // `stream.writeSSE({ event: 'ping' })`），扫不到，手工补进来。
  const EXTRA = ['ping'];
  const HANDLED = ['reminder', 'daily-summary'];        // 弹原生通知
  const IGNORED = ['data-changed', 'agent-status', 'ping']; // 明确不弹，理由见 notify.ts 顶部

  function busEvents(dir = 'server/src', out = new Set(EXTRA)): Set<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = `${dir}/${e.name}`;
      if (e.isDirectory()) busEvents(f, out);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        for (const m of readFileSync(f, 'utf8').matchAll(/emit\(\s*'([a-z-]+)'/g)) out.add(m[1]);
      }
    }
    return out;
  }

  it('扫得到东西——不是路径写错了在扫空目录', () => {
    expect(busEvents().size).toBeGreaterThan(3);
  });

  it('服务端发的每一种事件，要么弹要么明确不弹，没有第三种下场', () => {
    const known = new Set([...HANDLED, ...IGNORED]);
    const unanswered = [...busEvents()].filter((e) => !known.has(e));
    expect(unanswered, '服务端新加了总线事件——桌面端要不要弹它？弹就进 toNotification，不弹就写进 IGNORED')
      .toEqual([]);
  });

  it('说要弹的真的弹得出来，说不弹的真的不弹', () => {
    for (const e of IGNORED) expect(toNotification(e, task()), e).toBeNull();
    expect(toNotification('reminder', task())).not.toBeNull();
    expect(toNotification('daily-summary', { title: '今天 1 件事' })).not.toBeNull();
  });
});

describe('toNotification：坏数据不炸', () => {
  it.each([
    ['null', null],
    ['字符串', '交房租'],
    ['数组', [{ title: '交房租' }]],
    ['没有 id', { title: '交房租' }],
    ['id 不是字符串', { id: 42, title: '交房租' }],
    ['id 是空字符串', { id: '', title: '交房租' }],
    ['id 全是空白', { id: '   ', title: '交房租' }],
    ['没有 title', { id: 't1' }],
    ['title 不是字符串', { id: 't1', title: 42 }],
    ['title 是空字符串', { id: 't1', title: '' }],
    ['title 全是空白', { id: 't1', title: '   ' }],
  ])('%s → null，不抛', (_n, data) => {
    expect(() => toNotification('reminder', data)).not.toThrow();
    expect(toNotification('reminder', data)).toBeNull();
  });
});

describe('buildToastXml：转义', () => {
  // 这是这个 Task 的验收核心：标题里带危险字符，生成的 XML 仍然良构、
  // 内容原样呈现（转义之后再解码等于原文）。用一个真的 XML 解析器（DOMParser
  // 在这个沙盒里没有，改用正则从生成的字符串里把 <text> 节点内容抠出来，
  // 反过来解码 XML 实体，跟原始输入比较）——比单纯 `toContain('&lt;')`
  // 更贴近「良构」这个要求本身：转义字符和标签结构必须能配对回原文，
  // 不是随便替换了几个符号就算数。
  const unescape = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

  // 抠出两个 <text> 节点的内容（第一个是 title，第二个是 body）。
  const texts = (xml: string) => [...xml.matchAll(/<text>(.*?)<\/text>/g)].map((m) => m[1]);

  // 逐个字符单独测，每条只放一个危险字符——`>` 单独实测过：从 escapeXml
  // 里删掉 `.replace(/>/g, '&gt;')` 那一步，上面「组合危险字符 + 良构性」
  // 那组断言全绿不报——因为裸 `>` 本身在 XML 文本节点里不算不良构（只有
  // `<`/`&` 是强制要转义的，`>` 是防御性的惯例，真正会出事的场景是文本里
  // 出现 `]]>` 这个 CDATA 结束序列，测试夹具没有覆盖到那种组合），组合测试
  // 的「良构性」判据天然测不出「少转义了一个本来就不强制的字符」这种坏法。
  // 这里换一种判据：直接断言转义之后的字符串等于「把那个字符换成对应实体」
  // 的结果——不看良不良构，只看「这条 replace 规则是不是真的把输入换成了
  // 输出」，五条规则各自独立，删掉任何一条，只有它自己名下这一条会变红，
  // 不依赖别的规则或组合结构侥幸兜住。
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&apos;'],
  ])('body 里裸的 %s 被转义成 %s，不是原样透传', (ch, entity) => {
    const xml = buildToastXml({ id: 't1', title: '该做了', body: `甲${ch}乙` }, 'file:///C:/icon.png');
    const [, bodyText] = texts(xml);
    expect(bodyText).toBe(`甲${entity}乙`);
  });

  it.each([
    ['& 和 <script>', '写周报 <script>alert(1)</script> & 交房租'],
    ['已经转义过一次的 &amp;', '甲 &amp; 乙'],
    ['引号', '标题里有"引号"和\'单引号\''],
  ])('body 带 %s：XML 仍然良构，内容原样呈现', (_n, dangerousTitle) => {
    const n = { id: 't1', title: '该做了', body: dangerousTitle };
    const xml = buildToastXml(n, 'file:///C:/icon.png');

    // 良构性的一个直接可测信号：生成的字符串里不该出现裸的 `<`/`&`——
    // 真正的标签边界只会是我们自己拼的那几个固定字面量（<toast>、<text> 之
    // 类），危险输入里的同名字符必须已经被转义掉，不会跟固定标签混在一起
    // 被误判成「良构」。用「拿掉我们自己拼的那些固定标签之后，剩下的文本里
    // 不该再有 `<`」来判断，比直接数 `<` 总数更准——后者会把标签本身也数
    // 进去，凑巧数量对上不代表位置对。
    const withoutOurTags = xml.replace(/<\/?(toast|visual|binding|image|actions|action)\b[^>]*\/?>/g, '');
    const withoutTextTags = withoutOurTags.replace(/<\/?text>/g, '');
    expect(withoutTextTags).not.toContain('<');
    // 同一条良构性检查，专门盯 `&`：一个不是实体开头的裸 `&`（后面不跟
    // `amp;`/`lt;`/`gt;`/`quot;`/`apos;`）在 XML 里同样是不良构——上面那条
    // 「不含 `<`」的检查测不出「`&` 转义规则被删掉了」这种坏法（实测过：
    // 只删 `&` 那条 replace，上面那条断言照样绿，因为裸 `&` 原样透传、跟
    // 原文比对反而对得上，见报告里记的这条真的踩过的坑）。
    expect(withoutTextTags).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    // 内容原样呈现：把 <text> 节点内容解码回来，第二个就是 body，要跟原文
    // 一字不差。
    const [, decodedBody] = texts(xml).map(unescape);
    expect(decodedBody).toBe(dangerousTitle);
  });

  it('icon 路径里的字符也要转义（& 出现在文件名里的边界情况）', () => {
    const n = { id: 't1', title: '该做了', body: '交房租' };
    const xml = buildToastXml(n, 'file:///C:/A%20&%20B/icon.png');
    expect(xml).toContain('src="file:///C:/A%20&amp;%20B/icon.png"');
  });
});

describe('buildToastXml：结构', () => {
  const n: NotifyContent = { id: 'task-1', title: '该做了', body: '交房租' };
  const xml = buildToastXml(n, 'file:///C:/icon.png');

  // 文案里的分钟数从 SNOOZE_MINUTES 这个常量读，不是写死的字面量「10」——
  // code review I3：实际改的偏移量（protocol.ts patchForAction() 的
  // `SNOOZE_MINUTES * 60_000`）跟这里的文案原来是两个互不相关的字面量，
  // 改一处不影响另一处也不会有任何测试变红。这里不写死 `'推迟 10 分钟'`，
  // 而是从同一个常量拼期望值——SNOOZE_MINUTES 以后改了，这条测试的期望值
  // 跟着改，真正钉住的是「文案是不是真的读了这个常量」，不是「文案恰好等于
  // 10」这个巧合。「实际偏移是不是也读了同一个常量」由 protocol.test.ts
  // 的真实行为测试另外守（patchForAction 的 snooze 用例）。
  it('两个按钮都在，文案是「完成」「推迟 N 分钟」（N 读的是 SNOOZE_MINUTES）', () => {
    expect(xml).toContain('content="完成"');
    expect(xml).toContain(`content="推迟 ${SNOOZE_MINUTES} 分钟"`);
  });

  // 上限方向：按钮不能走 actions 字段那条路（macOS 专属，Windows 上无效）——
  // 这里测的是 toastXml 字符串本身没有把 <action> 元素落成别的、Windows
  // 认不出的形状，两个按钮都必须是 activationType="protocol"，不能悄悄退回
  // 默认的 "foreground"（那样点了会打开应用但分不清点的是哪个按钮）。
  it('两个按钮都是 activationType="protocol"，不是默认的 foreground', () => {
    const actions = [...xml.matchAll(/<action\b[^>]*\/>/g)].map((m) => m[0]);
    expect(actions).toHaveLength(2);
    for (const a of actions) expect(a).toContain('activationType="protocol"');
  });

  it('两个按钮的 arguments 是 todo-desktop:// 协议 URI，各带正确的 kind 和 id', () => {
    expect(xml).toContain('arguments="todo-desktop://complete?id=task-1"');
    expect(xml).toContain('arguments="todo-desktop://snooze?id=task-1"');
  });

  // toast 根节点不设 activationType：点通知本体要继续走 Notification.on('click')
  // 那条已经验过的路径，不是协议激活——见 buildToastXml 定义处的注释。
  it('<toast> 根节点不带 activationType（点通知本体走 click 事件，不走协议）', () => {
    const rootTag = xml.match(/<toast[^>]*>/)![0];
    expect(rootTag).not.toContain('activationType');
  });

  it('图标用 file:/// 绝对路径，不是相对路径', () => {
    expect(xml).toContain('src="file:///C:/icon.png"');
  });
});

/**
 * 这一组守的是一条真 bug：main.ts 原来**无条件**走
 * `showNotification({ toastXml: … })`，而 `toastXml` 是 Windows 专属字段，
 * mac/Linux 上被整个忽略——那两个平台上到点弹出来的是一条空通知。
 * 「到点提醒你」是这个应用的第一句承诺，坏了还没有任何声音。
 *
 * **判据是「非 Windows 一定不能只有 toastXml」**，不是「darwin 恰好等于某个
 * 对象」——照后者写的话，谁把 title 改错成 body 照样绿。
 */
describe('buildNotificationOptions：三个平台各拿到能用的东西', () => {
  const n: NotifyContent = { id: 't1', title: '该做了', body: '交房租' };
  const icon = { fileUrl: 'file:///C:/app/icon.png', path: 'C:\app\icon.png' };

  it('win32 走 toastXml，内容跟 buildToastXml 一字不差（两个入口不许各拼一份）', () => {
    expect(buildNotificationOptions(n, icon, 'win32')).toEqual({ toastXml: buildToastXml(n, icon.fileUrl) });
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} **没有** toastXml——有的话等于回到那条空通知的老路`, () => {
      expect(buildNotificationOptions(n, icon, platform)).not.toHaveProperty('toastXml');
    });

    it(`${platform} 真的带着看得见的标题和正文，不是空壳`, () => {
      const o = buildNotificationOptions(n, icon, platform) as { title: string; body: string; icon: string };
      expect(o.title).toBe('该做了');
      expect(o.body).toBe('交房租');
      // 图标要的是文件系统路径，不是 file:// URL——传错不报错，只是图不显示。
      expect(o.icon).toBe(icon.path);
      expect(o.icon).not.toMatch(/^file:/);
    });
  }

  it('概览（id 为 null）在非 Windows 上照样有标题正文——它本来就没有按钮可丢', () => {
    const summary: NotifyContent = { id: null, title: '今天 3 件事', body: '交房租、买菜、写周报' };
    const o = buildNotificationOptions(summary, icon, 'darwin') as { title: string; body: string };
    expect(o.title).toBe('今天 3 件事');
    expect(o.body).toBe('交房租、买菜、写周报');
  });
});
