import { useEffect, useRef, useState } from 'react';
import { Button, Input } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { Markdown } from './Markdown.js';
import { formKey } from '../lib/keymap.js';
import { applySnippet, matchSnippets, slashQuery, type Snippet } from '../lib/slashMenu.js';

/**
 * 备注编辑器：一个纯文本框 + 「/」菜单 +（可选的）「预览」开关。
 *
 * **它从 `TaskFields` 里整块搬出来的，不是新写的第二份。** 搬的理由是详情
 * 面板（`TaskDetail`，仿滴答清单第三栏）要就地编辑备注——点一下正文就开始
 * 写、离焦就渲染回 markdown。那一处要的正是这里的全部行为（斜杠菜单、
 * Ctrl+Enter 保存、Esc 取消、输入法守卫），在面板里另写一个 textarea 等于
 * 把「/」菜单变成「编辑态才有、详情面板里没有」——同一个字段两套写法，
 * 正是这个仓库最贵的那类缺陷（`statusLabel.guard.test.ts` 记着两次账）。
 *
 * 契约是一根字符串（`value`/`onChange`），不是 `TaskDraft`：这个组件不认识
 * 「任务」，只认识「一段 markdown」。调用方各自决定这段文字存哪儿——表单
 * 写进草稿，面板直接发 patch。
 */
interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Ctrl/Cmd+Enter。不给就只是没有这个快捷键。 */
  onSubmit?: () => void;
  /** Esc。菜单开着时 Esc 先关菜单，不会走到这里，见 `onNotesKeyDown`。 */
  onCancel?: () => void;
  /**
   * 「预览」开关要不要摆。**详情面板那种就地编辑不摆**：那里离焦本来就渲染
   * 成 markdown，再多一颗「预览」是同一件事的第二个入口，而且点它会把焦点
   * 从正在写的框里带走。默认摆着——那是编辑表单一直以来的样子。
   */
  hidePreview?: boolean;
  /** 一进来就把光标放进去。就地编辑要（人刚点了正文）；表单里不要（会滚动页面）。 */
  autoFocus?: boolean;
  /** 离焦。就地编辑靠它落盘 + 切回渲染态；表单不给，编辑态是整张卡一起保存的。 */
  onBlur?: () => void;
  placeholder?: string;
  /** 最多长到几行就自己滚。面板比卡片高得多，给得起更多行。 */
  maxRows?: number;
}

export function NotesEditor({ value, onChange, onSubmit, onCancel, hidePreview, autoFocus, onBlur, placeholder = '备注（打 / 插入格式）', maxRows = 6 }: Props) {
  // antd 的 TextArea ref 不是 DOM 节点，真正的 <textarea> 挂在
  // `resizableTextArea.textArea` 上——要拿 selectionStart / setSelectionRange
  // 只能穿到那一层。
  const notesRef = useRef<TextAreaRef | null>(null);
  /**
   * 「/」菜单的状态：`start` 是那个斜杠的下标，`items` 是筛出来的几条，
   * `active` 是键盘选中的第几条。`null` = 没在打命令。
   *
   * **算出来的 items 存下来，不是每次渲染现算**：渲染时现算的话，↑↓ 改
   * `active` 那一帧如果 items 恰好变了（比如同时又敲进一个字），选中的会跳到
   * 一个别的条目上。
   */
  const [slash, setSlash] = useState<{ start: number; items: Snippet[]; active: number } | null>(null);
  /** 备注是「写」还是「看」。**只是这一个编辑器里的一个显示态**，不存盘、
   *  不跟着任务走——下次打开还是从「写」开始，因为打开编辑器就是为了改。 */
  const [preview, setPreview] = useState(false);

  const refreshSlash = (text: string, caret: number) => {
    const hit = slashQuery(text, caret);
    if (!hit) return setSlash(null);
    const items = matchSnippets(hit.query);
    // 一条都筛不到就收起来，不摆一个空框——空框看起来像坏了。
    setSlash(items.length === 0 ? null : { start: hit.start, items, active: 0 });
  };

  const insert = (s: Snippet) => {
    const el = notesRef.current?.resizableTextArea?.textArea;
    if (!el || !slash) return;
    const r = applySnippet(el.value, el.selectionStart ?? el.value.length, slash.start, s);
    onChange(r.text);
    setSlash(null);
    // 下一帧再放光标：这一刻 textarea 里还是旧文本，setSelectionRange 会被
    // 随后的重渲染冲掉。
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  /** 菜单开着时接管上下键和回车；没开着时**只认 Ctrl/Cmd + 回车和 Esc**——
   *  备注框里光按回车永远是换行，这是它最基本的行为，不能因为多了个菜单、
   *  或者多了个保存快捷键就变得看情况。
   *
   *  顺序要紧：菜单开着时 Esc 是「关掉菜单」，不是「取消编辑」——那一下人想
   *  撤销的是刚打出来的 `/`，不是整次编辑。所以菜单那一支先判，判完就返回。 */
  const onNotesKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slash) {
      const k = formKey(e);
      if (k === 'submit' && onSubmit) { e.preventDefault(); onSubmit(); }
      if (k === 'cancel' && onCancel) { e.preventDefault(); onCancel(); }
      return;
    }
    const n = slash.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setSlash({ ...slash, active: (slash.active + d + n) % n });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(slash.items[slash.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSlash(null);
    }
  };

  /**
   * 上下键选到的那一条要滚进可视区。菜单 `max-height: 200px` 装得下八条，
   * 加了行内格式和表格之后是十三条——超出的部分要滚，而 `active` 只是个下标，
   * 光标本身留在 textarea 上（这个菜单的整个设计），浏览器不会替它滚。
   *
   * `?.()` 不是保守：jsdom 里 `scrollIntoView` 压根没实现，直接调会抛，
   * 而这个组件有一整片测试在 jsdom 下跑。
   */
  const menuRef = useRef<HTMLUListElement>(null);
  const active = slash?.active ?? -1;
  useEffect(() => {
    if (active < 0) return;
    const el = menuRef.current?.children[active]?.querySelector('button');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <>
      {/* 备注写的是 markdown（斜杠菜单插的就是 markdown），但**写的时候看不见
          它长什么样**——存了才知道。这颗开关补的是那一半：不做富文本编辑器，
          就是「写」和「看」两态切换，源码始终是那段纯文本。
          只在真的写了东西之后才出现：空备注上摆一颗「预览」是让人去预览一片
          空白。 */}
      {!hidePreview && value.trim() !== '' && (
        <div className="ink-md-toggle">
          <Button
            size="small"
            type="text"
            aria-pressed={preview}
            onClick={() => setPreview((p) => !p)}
          >{preview ? '继续写' : '预览'}</Button>
        </div>
      )}
      {preview ? (
        <div className="ink-md-preview">
          <Markdown source={value} />
        </div>
      ) : (
      // 备注 + 「/」菜单（仿滴答清单任务描述里的斜杠命令）。判据全在
      // lib/slashMenu.ts，这里只管把结果写回 textarea 和摆那个小列表。
      // `position: relative` 的外壳是菜单的定位参照。
      <div className="ink-slash-wrap">
        <Input.TextArea
          ref={notesRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            refreshSlash(e.target.value, e.target.selectionStart ?? 0);
          }}
          // 点一下、按方向键换了位置，光标可能离开那段 `/xxx`——不重算的话
          // 菜单会挂在那儿，回车插到一个跟它无关的地方。
          onSelect={(e) => {
            const el = e.target as HTMLTextAreaElement;
            refreshSlash(el.value, el.selectionStart ?? 0);
          }}
          onKeyDown={onNotesKeyDown}
          // 收菜单和「离焦落盘」是同一下：菜单项走的是 onMouseDown +
          // preventDefault（下面那条注释），焦点根本不会离开这个框，所以
          // 点菜单不会误触 onBlur。
          onBlur={() => { setSlash(null); onBlur?.(); }}
          placeholder={placeholder}
          autoSize={{ minRows: 1, maxRows }}
        />
        {slash && slash.items.length > 0 && (
          // role=listbox + aria-activedescendant：这是一个「在别处打字、
          // 在这里选」的控件，焦点始终留在 textarea 上，不能靠 tabIndex 把
          // 焦点挪过来——挪走就打不了字了。
          <ul className="ink-slash-menu" role="listbox" aria-label="插入" ref={menuRef}>
            {slash.items.map((s, i) => (
              <li key={s.label}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === slash.active}
                  className={`ink-slash-item${i === slash.active ? ' ink-slash-on' : ''}`}
                  // onMouseDown 不是 onClick：textarea 的 onBlur 会先把菜单
                  // 收起来，等到 click 时这颗按钮已经不在了。
                  onMouseDown={(e) => { e.preventDefault(); insert(s); }}
                >{s.label}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
    </>
  );
}
