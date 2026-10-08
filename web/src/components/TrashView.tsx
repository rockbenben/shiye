import { useEffect, useRef, type ReactNode } from 'react';
import { App as AntApp } from 'antd';
import type { TrashItem } from '../types.js';
import { whenText } from '../lib/dueChip.js';

interface Props {
  items: TrashItem[];
  /** 「删于……」要拿它比。跟别处一样由调用方注入，不在组件里读时钟。 */
  now: Date;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  /** 清空整个垃圾箱（仿滴答清单）。不给就不显示那颗按钮——它是不可逆的，
   *  一个点了没反应的入口在这里比别处更糟。 */
  onPurgeAll?: () => void;
}

export function TrashView({ items, now, onRestore, onPurge, onPurgeAll }: Props): ReactNode {
  // modal.confirm 而不是 Popconfirm：跟 TaskCard 的删除走同一套，测试可以直接
  // 复用 test-utils 的 confirmDialog()，不用为一个视图新造一套辅助。
  const { modal } = AntApp.useApp();

  // 最近删的排最前——刚误删的那条应该在手边，不是翻到底下去找。
  const sorted = [...items].sort((a, b) => (Date.parse(b.deletedAt) || 0) - (Date.parse(a.deletedAt) || 0));

  /**
   * **行消失之后把焦点接住。** 点「还原」/「彻底删除」/「清空」都会让焦点所在
   * 那一行整条从文档里掉出去，实测浏览器里 `activeElement` 因此落回 `<body>`
   * （键盘用户下一次 Tab 从页面顶重来，读屏丢了位置）。
   *
   * 记的是**下标不是 id**：被移走之后「它的位置」就是它下面那一行升上来的位置，
   * 人要接着操作的正是那一行。等 `items` 真的少了一行才动（API 是异步的，点下去
   * 那一刻列表还没变），动一次就把记号清掉——不点东西的时候这个 effect 什么都不
   * 做，不然每次重渲染都会抢焦点。
   */
  const listRef = useRef<HTMLUListElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const goneAt = useRef<number | null>(null);
  // 依赖只有 `items.length`：点下去那一刻列表还没变（API 是异步的），这一族
  // 本来就不会跑；真少了一行它才跑一次。所以这里不需要再自己记一份「上次几条」
  // ——那是一道永远不成立的闸。
  useEffect(() => {
    const at = goneAt.current;
    if (at === null) return;
    goneAt.current = null;
    const rows = [...(listRef.current?.querySelectorAll('.ink-trash-item') ?? [])];
    // 越过末尾就退到最后一条；一行都不剩时交给这块区域本身（`tabIndex={-1}`
    // 进得了 `.focus()`、不进 Tab 顺序），读屏于是重新落在「垃圾箱是空的……」
    // 那一句上，而不是掉回整页顶部。判据照 `TaskDetail.tsx` 那处。
    const btn = rows[Math.min(at, rows.length - 1)]?.querySelector('button');
    (btn ?? regionRef.current)?.focus();
  }, [items.length]);
  const claim = (i: number) => { goneAt.current = i; };

  return (
    // `tabIndex={-1}`：能被 `.focus()` 收进来，但不进 Tab 顺序——它是一块区域，
    // 不是一个控件。不新造类名：这一层没有任何样式要定义，而 `.ink-` 前缀的类
    // 名在这个仓库里意味着「样式表里有这条规则、测试里有它的一条断言」。
    <div ref={regionRef} tabIndex={-1}>
      {/* 空的时候第一句说的是「这里放什么、东西会不会自己没了」，不是那句还原的
          边界。原来那句说明排在最上面，于是垃圾箱空着时最先读到的是一段「还原
          找不回什么」——此刻没有任何东西可还原，警告在替一件不存在的事先付代价。
          留存期这里说清楚：这个应用不做「N 天后自动清理」——那是在一个定时器上
          悄悄删他的数据，所以它一直留着，直到他还原或者彻底删除。不写这一句，
          整屏没说清东西会不会自己消失，而人默认都会以为有个 30 天。 */}
      {sorted.length === 0 && (
        <p className="ink-empty-note">
          垃圾箱是空的——删掉的任务会留在这儿，直到你把它还原或者彻底删除，它不会自己过期。
        </p>
      )}
      {/* 服务端还原时只把任务本身放回来：收件箱那条指向它的关联、这条任务名下
          的 AI 建议，删除那一刻就被服务端硬清掉了，还原找不回来；order 也会被
          清成 null（跟从搁置/已完成恢复同一条规矩，防止带着老数字回来撞车盖过
          用户排在第一的卡）。「还原」这个词很容易被理解成完整撤销，这句说明
          必须在——不管垃圾箱当下是空是满，都是下次误删之前唯一能看到它的地方。
          **空的时候它排在上面那句之后**：先回答「这一屏是什么」，再讲边界。 */}
      <p className="ink-trash-note">
        还原只找回任务本身：收件箱的关联和 AI 建议不会回来，手动排的位置也会重置。
      </p>
      {/* 清空。**空的时候不摆这颗按钮**——一个「清空 0 条」除了占位置什么都
          没说。确认框里报数：这是这个应用里最不可逆的一步（连垃圾箱都没有
          垃圾箱了），说清一共几条，比一句笼统的「确定吗」更有用。 */}
      {onPurgeAll && sorted.length > 0 && (
        <button
          type="button"
          className="ink-trash-btn ink-trash-purge ink-trash-purge-all"
          onClick={() => modal.confirm({
            title: `清空垃圾箱？这 ${sorted.length} 条都找不回来了`,
            content: '里面的附件也会一起删掉。想留下某几条的话，先一条条「还原」。',
            okText: '清空',
            cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: () => { claim(0); onPurgeAll(); },
          })}
        >清空垃圾箱（{sorted.length}）</button>
      )}
      {sorted.length > 0 && (
        <ul className="ink-trash-list" role="list" ref={listRef}>
          {sorted.map((t, i) => (
            <li className="ink-trash-item" key={t.id}>
              <div className="ink-trash-main">
                <span className="ink-trash-title">{t.title}</span>
                {/* 「删于 今天 15:00」。原来是「2026-08-22 15:00 删除」——两个
                    毛病：末尾那个光秃秃的「删除」跟它右边那两颗按钮长得像同一
                    类东西（有人真会去点），而绝对时刻回答不了这里唯一想问的
                    那件事：**它在这儿躺多久了、还来不来得及捞**。 */}
                <span className="ink-trash-when ink-mono">删于 {whenText(t.deletedAt, now)}</span>
              </div>
              <div className="ink-trash-actions">
                <button type="button" className="ink-trash-btn" onClick={() => { claim(i); onRestore(t.id); }}>还原</button>
                <button
                  type="button"
                  className="ink-trash-btn ink-trash-purge"
                  onClick={() => modal.confirm({
                    title: '彻底删除？这条就找不回来了',
                    content: '还想留着的话，用「还原」。',
                    okText: '彻底删除',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => { claim(i); onPurge(t.id); },
                  })}
                >彻底删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
