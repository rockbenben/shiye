import { Modal } from 'antd';

/**
 * 快捷键一览。仿滴答清单——它那边也是按 `?` 弹出来。
 *
 * **这张表是手写的，不是从 `keymap.ts` 自动生成的。** 生成得出来的只有
 * 「哪个键翻成哪个 action.kind」，而人要看的是「按了会发生什么」——那一半在
 * `App.tsx` 的 switch 里，形状是一段段带条件的代码（`E` 要选中恰好一张才有
 * 反应、`1..9` 只够得到导航前九项），没法从 `kind` 推出来。生成一份只写着
 * 「E → edit」的表，等于把没解释清楚的东西换个地方摆一遍。
 *
 * 代价是它会飘：加了新快捷键忘了写进来，这里就少一行。`keymap.test.ts` 有一条
 * 测试盯着「`KeyAction` 的每一种 kind 在这张表里都有对应的一行」，飘了会红。
 */
export interface ShortcutRow {
  keys: string;
  what: string;
  /** 对应 `KeyAction['kind']` 或 `FormKey`——只给那两条同步测试用，界面不显示。 */
  kind: string;
  /**
   * 这个键在哪儿管用。
   *
   * - `'page'`：整页范围内（`keymap.ts` 的 `keyAction`）。**输入框里一律不生效**，
   *   见表格下面那句说明。
   * - `'form'`：**恰恰相反，只在输入框里生效**（`keymap.ts` 的 `formKey`）。
   *   两族的判据方向是反的，摆在同一张表里不分开说，等于让人以为
   *   「Esc 在哪儿都是取消选中」。
   * - `'card'`：**焦点落在某张卡/某一行里**才生效。它不经过 `keymap.ts`——
   *   处理器挂在卡片自己身上（`TaskCard.tsx`/`TaskRow.tsx` 的 `onKeyDown`），
   *   靠冒泡接住焦点所在的那张卡。所以上面两条同步测试扫不到它，这一族
   *   目前只有一个键。
   */
  scope: 'page' | 'form' | 'card';
}

export const SHORTCUTS: ShortcutRow[] = [
  { scope: 'page', kind: 'new', keys: 'N', what: '随手记一条进收件箱' },
  // 建任务的**两条路各有一条**。原来只有随手记那条有键：`N` 通向的是「丢进
  // 收件箱等 AI 拆」（默认 60 秒），而「已经知道自己要做什么」该走的那条
  // 一直只能用鼠标点视图标题栏那颗按钮——键盘上快的那一个通向慢的那条路。
  { scope: 'page', kind: 'compose', keys: 'C', what: '新任务表单（标题里能直接写时间/标签）' },
  { scope: 'page', kind: 'search', keys: '/', what: '跳到搜索框' },
  { scope: 'page', kind: 'palette', keys: 'Ctrl + K', what: '命令面板（Mac 是 ⌘ + K）' },
  { scope: 'page', kind: 'view', keys: '1 – 9', what: '切到导航上第 1～9 个去处' },
  { scope: 'page', kind: 'edit', keys: 'E', what: '编辑选中的那一条（只选中一条时）' },
  { scope: 'page', kind: 'done', keys: 'D', what: '把选中的几条标成已完成' },
  { scope: 'page', kind: 'due', keys: 'T / M / W', what: '把选中的几条改到今天 / 明天 / 下周' },
  { scope: 'page', kind: 'delete', keys: 'Delete', what: '删除选中的几条（会先问一句）' },
  { scope: 'page', kind: 'escape', keys: 'Esc', what: '清空搜索 / 取消选中' },
  { scope: 'page', kind: 'help', keys: '?', what: '就是这张表' },
  // 焦点在卡片上时的那一个。**它是整层键盘操作的入口**：`E`/`D`/`T`/`M`/`W`
  // 全都作用在选中集合上，而在这之前进入选中态的唯一办法是 Ctrl/Shift 点卡片
  // ——一个鼠标动作。
  { scope: 'card', kind: 'select', keys: 'X', what: '选中 / 取消选中焦点所在的那一条（Shift + X 连选）' },
  // 表单里的三个。**加了新快捷键就得写进这张表**——这个文件顶上那句「它会飘」
  // 说的就是这件事，而这三个键落地那一轮确实忘了写（`keymap.test.ts` 当时只
  // 盯着 `KeyAction`，`FormKey` 不在它的扫描范围里，什么都没红）。现在两族
  // 各有一条同步测试。
  { scope: 'form', kind: 'submit', keys: '回车', what: '标题框里：保存 / 添加' },
  { scope: 'form', kind: 'submit', keys: 'Ctrl + 回车', what: '备注框里：保存（Mac 是 ⌘ + 回车）' },
  { scope: 'form', kind: 'cancel', keys: 'Esc', what: '取消编辑 / 关掉表单' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ShortcutHelp({ open, onClose }: Props) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="快捷键" width={420}>
      <table className="ink-shortcut-table">
        <tbody>
          {SHORTCUTS.filter((s) => s.scope === 'page').map((s) => (
            <tr key={s.kind}>
              <th scope="row"><kbd>{s.keys}</kbd></th>
              <td>{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 输入框里按 `?` 是在打字，不是在求助——这条守卫在 keymap.ts 里
          （`inField` 一律返回 null），但用户按了没反应时会以为坏了，说一句。 */}
      <p className="ink-shortcut-note">在输入框里打字时这些键不生效，都是原样输入。</p>
      {/* 表单那几个单独一段。**不能混进上面那张表**：上面整段的前提是
          「输入框里不生效」，而这三个恰恰只在输入框里生效——摆在一起会让
          紧挨着的那句说明自相矛盾。 */}
      {/* 焦点在卡片上时的那一族。同样不能混进上面那张表：上面那些不看焦点
          在哪儿（只要不在输入框里），而这一个恰恰只在焦点落进某张卡时才有
          对象——摆在一起说不清「那一条」指的是哪一条。 */}
      <h2 className="ink-shortcut-sub">焦点在某张卡上时</h2>
      <table className="ink-shortcut-table">
        <tbody>
          {SHORTCUTS.filter((s) => s.scope === 'card').map((s) => (
            <tr key={s.keys}>
              <th scope="row"><kbd>{s.keys}</kbd></th>
              <td>{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="ink-shortcut-sub">编辑表单里</h2>
      <table className="ink-shortcut-table">
        <tbody>
          {SHORTCUTS.filter((s) => s.scope === 'form').map((s) => (
            <tr key={s.keys}>
              <th scope="row"><kbd>{s.keys}</kbd></th>
              <td>{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
