import { Button } from 'antd';
import {
  GROUP_LABEL, SORT_LABEL, isDefaultGroupSort, viewDefaultGroupSort,
  type GroupBy, type GroupSort, type SortBy,
} from '../lib/grouping.js';

const GROUPS = Object.keys(GROUP_LABEL) as GroupBy[];
const SORTS = Object.keys(SORT_LABEL) as SortBy[];

interface Props {
  /**
   * 当前在哪个去处。**「默认」是按去处算的**：「已完成」的默认是按完成时间分组
   * （`VIEW_DEFAULT`），跟全局默认不是一回事。少了这个参数就只能比全局默认，
   * 于是一进「已完成」「恢复默认」就亮着（他什么都没改），点下去还会把他带离
   * 这一屏的默认——那条判据的整段说明在 `lib/grouping.ts` 的 `isDefaultGroupSort`。
   */
  view: string;
  value: GroupSort;
  onChange: (next: GroupSort) => void;
}

/**
 * 分组 + 排序那一条。仿滴答清单每份清单右上角「···」-「分组排序」。
 *
 * **两个原生 `<select>`，不是 antd 的 Select**——这里不需要搜索/多选/远程
 * 加载，原生的可访问性判定更简单，测试用 `fireEvent.change` 直接可驱动。
 * 跟 `TaskFields` 的清单下拉、`BatchBar` 的批量改清单同一条既有约定。
 *
 * **没有「收起」**，跟 `FilterBar` 不一样：那一条摊开是七个控件、平时全空，
 * 收起来有意义；这里就两个下拉加一颗小按钮，收起省不下什么，反而多一次点击
 * 才知道「原来还能分组」——这个功能最大的问题本来就是没人知道它存在。
 *
 * 「倒序」和「恢复默认」都只在真的改过之后才出现：默认档下它们一个是空操作、
 * 一个没东西可恢复，摆着只是两颗永远点不出效果的按钮。
 */
export function GroupSortBar({ view, value, onChange }: Props) {
  const dirty = !isDefaultGroupSort(view, value);
  return (
    <div className="ink-groupsort-bar" role="group" aria-label="分组和排序">
      <select
        className="ink-groupsort-select"
        aria-label="分组"
        value={value.groupBy}
        onChange={(e) => onChange({ ...value, groupBy: e.target.value as GroupBy })}
      >
        {GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
      </select>
      <select
        className="ink-groupsort-select"
        aria-label="排序"
        value={value.sortBy}
        onChange={(e) => onChange({ ...value, sortBy: e.target.value as SortBy })}
      >
        {SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
      </select>
      {/* 「默认顺序」没有正反可言——那一档就是「别动这个视图自己排好的顺序」，
          给它一颗倒序按钮等于承诺一件做不到的事。 */}
      {value.sortBy !== 'default' && (
        <Button
          size="small"
          aria-pressed={value.desc}
          onClick={() => onChange({ ...value, desc: !value.desc })}
        >{value.desc ? '倒序' : '正序'}</Button>
      )}
      {dirty && (
        <Button size="small" type="text" onClick={() => onChange(viewDefaultGroupSort(view))}>恢复默认</Button>
      )}
    </div>
  );
}
