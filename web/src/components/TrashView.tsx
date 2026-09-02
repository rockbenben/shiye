import type { ReactNode } from 'react';
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

  return (
    <>
      {/* 服务端还原时只把任务本身放回来：收件箱那条指向它的关联、这条任务名下
          的 AI 建议，删除那一刻就被服务端硬清掉了，还原找不回来；order 也会被
          清成 null（跟从搁置/已完成恢复同一条规矩，防止带着老数字回来撞车盖过
          用户排在第一的卡）。「还原」这个词很容易被理解成完整撤销，这句说明
          必须在——不管垃圾箱当下是空是满，都是下次误删之前唯一能看到它的地方。 */}
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
            onOk: onPurgeAll,
          })}
        >清空垃圾箱（{sorted.length}）</button>
      )}
      {sorted.length === 0 ? (
        <p className="ink-empty-note">垃圾箱是空的</p>
      ) : (
        <ul className="ink-trash-list" role="list">
          {sorted.map((t) => (
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
                <button type="button" className="ink-trash-btn" onClick={() => onRestore(t.id)}>还原</button>
                <button
                  type="button"
                  className="ink-trash-btn ink-trash-purge"
                  onClick={() => modal.confirm({
                    title: '彻底删除？这条就找不回来了',
                    content: '还想留着的话，用「还原」。',
                    okText: '彻底删除',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => onPurge(t.id),
                  })}
                >彻底删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
