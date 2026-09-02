import type { List } from '../types.js';
import { listLabel } from '../lib/listIcon.js';

interface Props {
  lists: List[];
  tags: string[];
  /** 点了之后去哪——调用方给 `list:<id>` / `tag:<名字>` 这种去处 key。 */
  onOpen: (viewKey: string) => void;
}

/**
 * 搜索结果里「匹配到的清单和标签」那一排。仿滴答清单搜索页的「清单」「标签」
 * 两个类型——**摆成一排胶囊，不是两个标签页**，理由见 `lib/search.ts` 里
 * `searchLists` 的注释。
 *
 * 一个都没匹配到时整个不渲染：一条常驻的空横条比没有更糟，而任务那半自己
 * 有「没有匹配的任务」的空态。
 */
export function SearchJumps({ lists, tags, onOpen }: Props) {
  if (lists.length === 0 && tags.length === 0) return null;
  return (
    <div className="ink-search-jumps" role="group" aria-label="匹配到的清单和标签">
      <span className="ink-search-jumps-label">跳转到</span>
      {lists.map((l) => (
        <button
          key={`list:${l.id}`}
          type="button"
          className="ink-search-jump"
          onClick={() => onOpen(`list:${l.id}`)}
        >
          {/* 跟卡片上、侧栏里用的是同一套：名字前面的 emoji 当图标，没有就画
              那颗分类色圆点（分类色只出现在填充上，不上字，规格「第三条通道」）。 */}
          {listLabel(l.name).icon
            ? <span className="ink-list-emoji">{listLabel(l.name).icon}</span>
            : <span className="ink-list-dot" style={{ backgroundColor: l.color }} aria-hidden="true" />}
          {listLabel(l.name).text}
        </button>
      ))}
      {tags.map((t) => (
        <button
          key={`tag:${t}`}
          type="button"
          className="ink-search-jump"
          onClick={() => onOpen(`tag:${t}`)}
        >#{t}</button>
      ))}
    </div>
  );
}
