// @vitest-environment jsdom
// toKeyLike 那组用例要 document.createElement 造真实 DOM 节点——这个文件按扩展名
// 落进 vitest.config.ts 的 'node' 档，用这行 pragma 单独把它切到 jsdom，不用为了
// 三个用例把整个纯函数测试搬进 .tsx 那一档（那一档是留给「渲染出的东西变没变」的）。
import { describe, expect, it } from 'vitest';
import { formKey, isInteractiveTarget, keyAction, toKeyLike, type KeyLike } from './keymap.js';

const k = (over: Partial<KeyLike> & { key: string }): KeyLike => ({ ...over });

describe('keyAction：该触发的', () => {
  it.each([
    ['n', { kind: 'new' }],
    ['N', { kind: 'new' }], // 大小写都收
    ['/', { kind: 'search' }],
    ['1', { kind: 'view', index: 0 }],
    ['9', { kind: 'view', index: 8 }],
    ['Escape', { kind: 'escape' }],
    ['e', { kind: 'edit' }],
    ['E', { kind: 'edit' }], // 大小写都收，跟 n/N 同一条规矩
    ['Delete', { kind: 'delete' }],
  ] as const)('%s → %o', (key, want) => expect(keyAction(k({ key }))).toEqual(want));

  it.each([
    ['Ctrl+K', { key: 'k', ctrlKey: true }],
    ['Cmd+K', { key: 'k', metaKey: true }],
    ['Ctrl+Shift+K 也收（大写 K）', { key: 'K', ctrlKey: true, shiftKey: true }],
  ] as const)('%s → palette', (_n, e) => expect(keyAction(k(e))).toEqual({ kind: 'palette' }));
});

describe('keyAction：不该触发的（上限方向，一条都别省）', () => {
  it.each([
    ['输入框里打 n', { key: 'n', inField: true }],
    ['输入框里打 1', { key: '1', inField: true }],
    ['输入框里打 /', { key: '/', inField: true }],
    ['组字中打 n', { key: 'n', isComposing: true }],
    ['组字中打 1', { key: '1', isComposing: true }],
    ['keyCode 229（输入法在吃这个键），即使 key 报的是真字符', { key: 'n', keyCode: 229 }],
    ['Ctrl+N（浏览器新窗口）', { key: 'n', ctrlKey: true }],
    ['Alt+1', { key: '1', altKey: true }],
    ['0（导航没有第 0 项）', { key: '0' }],
    ['a（没绑）', { key: 'a' }],
    ['Enter', { key: 'Enter' }],
    ['输入框里按 e', { key: 'e', inField: true }],
    ['输入框里按 Delete——防的是编辑标题时选中一段文字按 Delete 被当成批量删除', { key: 'Delete', inField: true }],
    ['组字中按 e', { key: 'e', isComposing: true }],
    // brief 原话：「只收 Delete，不收 Backspace——它在浏览器里有历史包袱」。
    ['Backspace 不算 delete 动作', { key: 'Backspace' }],
  ] as const)('%s → null', (_n, e) => expect(keyAction(k(e))).toBeNull());

  // Esc 和 Ctrl/Cmd+K 是输入框里的两个例外
  it('输入框里的 Escape 照样触发——那是「从输入框退出来」', () =>
    expect(keyAction(k({ key: 'Escape', inField: true }))).toEqual({ kind: 'escape' }));
  it('输入框里的 Ctrl+K 照样触发', () =>
    expect(keyAction(k({ key: 'k', ctrlKey: true, inField: true }))).toEqual({ kind: 'palette' }));
  // 组字中连 Esc 都不该触发：那一下是取消组字，不是关面板
  it('组字中的 Escape 不触发', () =>
    expect(keyAction(k({ key: 'Escape', isComposing: true }))).toBeNull());
});

describe('toKeyLike：inField 怎么判', () => {
  it.each([
    ['input', () => document.createElement('input'), true],
    ['textarea', () => document.createElement('textarea'), true],
    ['div', () => document.createElement('div'), false],
  ] as const)('%s → inField %s', (_n, make, want) => {
    const el = make();
    expect(toKeyLike({ key: 'n', target: el } as unknown as KeyboardEvent).inField).toBe(want);
  });

  it('contenteditable 的 div 也算输入框', () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    expect(toKeyLike({ key: 'n', target: el } as unknown as KeyboardEvent).inField).toBe(true);
  });

  // keyCode 229 兜底要用到——toKeyLike 得原样把它带出来，keyAction 才拦得住。
  it('原样带出 keyCode', () => {
    const el = document.createElement('div');
    expect(toKeyLike({ key: 'n', keyCode: 229, target: el } as unknown as KeyboardEvent).keyCode).toBe(229);
  });
});

// Task 3（卡片选中）复用的是这同一个判据，只是多传一个 extra 参数——
// 不重开第二份 input/textarea/contenteditable 选择器，见函数上面的注释。
describe('isInteractiveTarget：extra 参数追加要排除的选择器，不重开第二份基础选择器', () => {
  it('不传 extra 时跟 toKeyLike 的 inField 判断一样：div 不算', () => {
    expect(isInteractiveTarget(document.createElement('div'))).toBe(false);
  });
  it('不传 extra 时 button/a 不被排除——这两个是卡片选中专用的追加项，基础判据不该管', () => {
    expect(isInteractiveTarget(document.createElement('button'))).toBe(false);
    expect(isInteractiveTarget(document.createElement('a'))).toBe(false);
  });
  it('传 extra: "button, a" 之后 button/a 也算——卡片选中要用的那个扩展', () => {
    expect(isInteractiveTarget(document.createElement('button'), 'button, a')).toBe(true);
    expect(isInteractiveTarget(document.createElement('a'), 'button, a')).toBe(true);
  });
  it('extra 不影响基础判据仍然生效：传了 extra，input 照样算', () => {
    expect(isInteractiveTarget(document.createElement('input'), 'button, a')).toBe(true);
  });
  /**
   * **原生下拉框也算在打字。** 它展开时按字母是首字母定位，那个按键同时冒到
   * window 上——漏了它，批量条里选清单的下拉里按 `d` 定位到「读书」，`d` 同时
   * 把选中的三条任务全标成已完成。实测过：`{ isActive: true, inField: false,
   * patchTasks 调用 1 次 }`。
   */
  it('select 也算——展开的下拉框里按字母不该触发全局快捷键', () => {
    expect(isInteractiveTarget(document.createElement('select'))).toBe(true);
    const opt = document.createElement('option');
    document.createElement('select').appendChild(opt);
    expect(isInteractiveTarget(opt)).toBe(true);   // 事件目标可能是 option
  });
});

/**
 * `?` 弹快捷键一览（仿滴答清单）。
 */
describe('keyAction：? 是快捷键一览', () => {
  it('按 ? 翻出 help', () => {
    expect(keyAction(k({ key: '?' }))).toEqual({ kind: 'help' });
  });

  it('认的是 `?` 这个字符本身，不是「shift + /」——别的键盘布局按出 ? 用的不是 Shift+/', () => {
    // 美式键盘上按 ? 时 shiftKey 是真的，这一支不该因此被上面那道
    // 「不认任何修饰键」的守卫挡掉（那道只挡 ctrl/meta/alt）。
    expect(keyAction(k({ key: '?', shiftKey: true }))).toEqual({ kind: 'help' });
    // 而 shift + / 报上来的 key 就是 '?'，不会是 '/'——所以 '/' 那一支
    // 不会被这个改动抢走。
    expect(keyAction(k({ key: '/' }))).toEqual({ kind: 'search' });
  });

  it('输入框里打 ? 是在打字，不弹', () => {
    expect(keyAction(k({ key: '?', inField: true }))).toBeNull();
  });
});

/**
 * 快捷键一览那张表是**手写的**（理由见 ShortcutHelp.tsx 顶部：能自动生成的
 * 只有「哪个键翻成哪个 kind」，而人要看的「按了会发生什么」在 App.tsx 的
 * switch 里）。手写就会飘——加了新快捷键忘了写进去，界面上就少一行、而且
 * 没有任何东西会红。这条测试盯着它：`KeyAction` 每一种 kind 都得有对应的一行。
 *
 * 从源码扫 `{ kind: 'xxx' }` 而不是维护第二份名单——那份名单本身会是第三个
 * 要保持同步的东西，跟 CONTRIBUTING.md 里 types.sync.test.ts 那条同一个思路。
 */
describe('ShortcutHelp 的表跟 KeyAction 不许飘', () => {
  it('每一种 KeyAction 的 kind 在表里都有一行', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('web/src/lib/keymap.ts', 'utf8');
    // 抠到最后一支的 `};` 为止。**不能用 `;` 加换行当结束标记**：这个联合
    // 每一支后面都跟着一句行尾注释（`// Esc`），分号和换行之间隔着它，那样
    // 写整条正则失配、`kinds` 是空数组，下面那条 `toBeGreaterThan(5)` 就是
    // 为了让「失配」这种失败方式先红出来，而不是变成一条恒绿的假测试。
    const decl = src.match(/export type KeyAction =[\s\S]*?\};/)?.[0] ?? '';
    const kinds = [...decl.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(5);   // 扫岔了（正则失配）时先红在这儿
    const { SHORTCUTS } = await import('../components/ShortcutHelp.js');
    const page = SHORTCUTS.filter((r) => r.scope === 'page').map((r) => r.kind);
    expect([...kinds].sort()).toEqual([...page].sort());
  });

  /**
   * `FormKey` 那一族同理。**这条是补的**：`formKey`（回车保存 / Esc 取消）落地
   * 那一轮，快捷键表里一行都没加——而上面那条只盯 `KeyAction`，`FormKey` 不在
   * 它的扫描范围里，所以什么都没红。这个文件顶上写着「加了新快捷键忘了写
   * 进来就少一行」，那一次正是它说的那种飘。
   *
   * 比的是**集合**不是数组：`submit` 有两行（标题框的回车、备注框的 Ctrl+回车），
   * 那是同一个判定的两种按法，不是两种判定。
   */
  it('每一种 FormKey 在表里都有一行', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('web/src/lib/keymap.ts', 'utf8');
    const decl = src.match(/export type FormKey = [^;]+;/)?.[0] ?? '';
    const kinds = [...decl.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(1);   // 扫岝了先红在这儿
    const { SHORTCUTS } = await import('../components/ShortcutHelp.js');
    const form = SHORTCUTS.filter((r) => r.scope === 'form').map((r) => r.kind);
    expect([...new Set(kinds)].sort()).toEqual([...new Set(form)].sort());
  });
});

/**
 * 「完成」和「改期」这几个键。补的是键盘上一个说不通的空缺：编辑（E）和
 * 删除（Delete）都有，唯独这个应用里最高频的那一步（完成）要用鼠标点。
 */
describe('keyAction：完成 / 改期', () => {
  const press = (key: string, over: Partial<Parameters<typeof keyAction>[0]> = {}) =>
    keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, inField: false, ...over });

  it('**C 是「新任务」表单，跟 N 的随手记是两条路**——键盘上快的那一个原来通向慢的那条', () => {
    expect(press('c')).toEqual({ kind: 'compose' });
    expect(press('C')).toEqual({ kind: 'compose' });
    expect(press('n')).toEqual({ kind: 'new' });
  });

  it('输入框里打 c 不算——跟别的单键同一条', () => {
    expect(press('c', { inField: true })).toBeNull();
  });

  it('D 是完成，大小写都认', () => {
    expect(press('d')).toEqual({ kind: 'done' });
    expect(press('D')).toEqual({ kind: 'done' });
  });

  it('T / M / W 是今天 / 明天 / 下周', () => {
    expect(press('t')).toEqual({ kind: 'due', to: 'today' });
    expect(press('m')).toEqual({ kind: 'due', to: 'tomorrow' });
    expect(press('W')).toEqual({ kind: 'due', to: 'nextWeek' });
  });

  it('**没有「去掉截止时间」那一档**——它是这几个里唯一不可逆的一步，不该只隔着一个误触', () => {
    // 没有任何单键映射到 clear；四个键各自的去处上面已经钉死了。
    const outs = ['d', 't', 'm', 'w'].map((k) => press(k));
    expect(outs.some((a) => a && a.kind === 'due' && a.to === 'clear')).toBe(false);
  });

  it('输入框里一个都不认——那是在打字', () => {
    for (const k of ['d', 't', 'm', 'w']) expect(press(k, { inField: true }), k).toBeNull();
  });

  it('带修饰键的不认（Ctrl+T 是新标签页，抢不得）', () => {
    for (const k of ['d', 't', 'm', 'w']) {
      expect(press(k, { ctrlKey: true }), k).toBeNull();
      expect(press(k, { metaKey: true }), k).toBeNull();
    }
  });

  it('组字中一个都不认', () => {
    for (const k of ['d', 't', 'm', 'w']) expect(press(k, { isComposing: true }), k).toBeNull();
  });
});

describe('formKey：编辑表单里的回车和 Esc', () => {
  const k = (over: Partial<Parameters<typeof formKey>[0]>) => ({ key: 'Enter', ...over });

  it('单行标题框：光按回车就是保存', () => {
    expect(formKey(k({}), { plainEnter: true })).toBe('submit');
  });

  it('多行备注框：光按回车什么都不是——那是换行，是它最基本的行为', () => {
    expect(formKey(k({}))).toBeNull();
  });

  it('Ctrl / Cmd + 回车两个框里都是保存', () => {
    expect(formKey(k({ ctrlKey: true }))).toBe('submit');
    expect(formKey(k({ metaKey: true }))).toBe('submit');
  });

  it('Esc 是取消，跟在哪个框里无关', () => {
    expect(formKey({ key: 'Escape' })).toBe('cancel');
    expect(formKey({ key: 'Escape' }, { plainEnter: true })).toBe('cancel');
  });

  it('**输入法组字中一个都不认**——中文输入法按回车是上屏候选词，不是「我写完了」', () => {
    expect(formKey(k({ isComposing: true }), { plainEnter: true })).toBeNull();
    expect(formKey(k({ keyCode: 229 }), { plainEnter: true })).toBeNull();
    expect(formKey(k({ ctrlKey: true, isComposing: true }))).toBeNull();
    // 组字中连 Esc 都不放行：那一下是取消组字，跟 keyAction 同一条。
    expect(formKey({ key: 'Escape', isComposing: true })).toBeNull();
    expect(formKey({ key: 'Escape', keyCode: 229 })).toBeNull();
  });

  it('别的键一律不管', () => {
    for (const key of ['a', 'Tab', 'ArrowDown', ' ']) {
      expect(formKey({ key }, { plainEnter: true })).toBeNull();
    }
  });
});
