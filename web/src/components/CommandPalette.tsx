import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from 'antd';

export interface Command {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

/**
 * Ctrl/Cmd+K 打开的命令面板。antd `Modal` 自带焦点陷阱和 Esc 关闭
 * （`keyboard` 默认 `true`，rc-dialog 的全局 window keydown 监听器接的，
 * 跟这个组件自己的 `onKeyDown` 完全独立——后者只拦 ArrowUp/ArrowDown/Enter，
 * 从不碰 Escape，两边不会抢同一个键）。不自己再写一套焦点陷阱/Esc 处理。
 *
 * 过滤：`label.toLowerCase().includes(query.toLowerCase())`。`toLowerCase()`
 * 对中文是无操作，但 `includes` 本身是纯子串匹配，对中文子串天然成立——
 * 不需要额外分支。
 */
export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开都是一次新的检索：上次的残留查询字/高亮位置不该带进来。
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const filtered = useMemo(
    () => commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
    [commands, query],
  );

  const runAt = (i: number) => {
    const cmd = filtered[i];
    // 没匹配上任何命令时 filtered 是空数组，filtered[i] 是 undefined——
    // 什么都不做，不能落到 filtered[0] 或者别的兜底上。
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length > 0) setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length > 0) setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(activeIndex);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      title={null}
      width={480}
      // 打字过滤会重新渲染整个列表，输入框那个 DOM 节点在打开期间从不重新
      // 挂载——autoFocus 只在节点第一次挂载时生效，antd Modal 默认关闭时
      // 不销毁内容（`destroyOnHidden` 默认 false），第二次打开不会重新挂载
      // 这个节点，autoFocus 不会重新触发。afterOpenChange 是 antd 官方给的
      // 「打开动画结束后」回调，每次打开都会重新调用，不依赖挂载时机。
      afterOpenChange={(nowOpen) => {
        if (nowOpen) inputRef.current?.focus();
      }}
    >
      <input
        ref={inputRef}
        className="ink-cmd-input"
        type="text"
        role="combobox"
        aria-label="命令面板"
        aria-expanded={filtered.length > 0}
        aria-controls="ink-cmd-listbox"
        aria-autocomplete="list"
        // 高亮那一条没有匹配（过滤成空列表）时不指向任何一个 option——
        // 指向一个不存在的 id 比「没有 aria-activedescendant」更容易让读屏
        // 软件念错。见下面 ink-cmd-empty 分支：这时列表本身也不渲染。
        aria-activedescendant={filtered.length > 0 ? `ink-cmd-opt-${activeIndex}` : undefined}
        placeholder="输入命令…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // 过滤之后高亮必须落回第一条——不然过滤剩两条、高亮却停在第 5 位，
          // 按 Enter 会跑一条屏幕上根本看不见的命令。
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {filtered.length === 0 ? (
        <p className="ink-cmd-empty">没有匹配的命令</p>
      ) : (
        <ul id="ink-cmd-listbox" className="ink-cmd-list" role="listbox" aria-label="命令列表">
          {filtered.map((c, i) => (
            <li
              key={c.key}
              id={`ink-cmd-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'ink-cmd-item ink-cmd-item-active' : 'ink-cmd-item'}
              onClick={() => runAt(i)}
            >
              <span>{c.label}</span>
              {c.hint && <span className="ink-cmd-key">{c.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
