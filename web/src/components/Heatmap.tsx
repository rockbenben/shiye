import { HEATMAP_LEVELS, heatLevel, heatmapWeeks, monthLabels } from '../lib/heatmap.js';

interface Props {
  /** `YYYY-MM-DD` → 那天的数值。没有的键当 0。 */
  values: Map<string, number>;
  now: Date;
  /** 一格的悬停文案。`value` 是 0 时也会被调到——「这天什么都没做」也是信息。 */
  label: (key: string, value: number) => string;
  /** 整张图的可访问名。一堆方格对读屏软件是一片沉默，必须有一句总结。 */
  ariaLabel: string;
  /** 一周从周几开始（`Settings.weekStart`）——决定每一行代表星期几。
   *  不给按周一，跟那个设置的默认档一致。 */
  weekStart?: import('../types.js').WeekStart;
}

/**
 * 年度热力图——仿滴答清单的「年度热力图」。一周一列、色块深浅代表当天的量。
 *
 * **布局在 `lib/heatmap.ts`，这里只管画**。专注统计和习惯概览共用这一个组件。
 *
 * 用 div 网格，不引图表库——365 个方格、一个最大值、一句 `data-level`。
 */
export function Heatmap({ values, now, label, ariaLabel, weekStart }: Props) {
  const cols = heatmapWeeks(now, weekStart);
  const months = monthLabels(cols);
  // 档位按这一年里最高的那天算，不按写死的阈值——理由见 lib/heatmap.ts 的
  // `heatLevel`。
  let max = 0;
  for (const v of values.values()) if (v > max) max = v;

  return (
    <div className="ink-heat" role="img" aria-label={ariaLabel}>
      <div className="ink-heat-months">
        {months.map((m, i) => <span className="ink-heat-month" key={cols[i][0].key}>{m ?? ''}</span>)}
      </div>
      <div className="ink-heat-grid">
        {cols.map((col) => (
          <div className="ink-heat-col" key={col[0].key}>
            {col.map((cell) => (
              cell.pad
                // 窗口之外：占位，不是「值为 0」——一个还没开始统计的日子跟
                // 一个真的什么都没做的日子在图上不该长得一样。
                ? <span className="ink-heat-cell ink-heat-pad" key={cell.key} />
                : (
                  <span
                    className="ink-heat-cell"
                    key={cell.key}
                    data-level={heatLevel(values.get(cell.key) ?? 0, max)}
                    title={label(cell.key, values.get(cell.key) ?? 0)}
                  />
                )
            ))}
          </div>
        ))}
      </div>
      <div className="ink-heat-legend">
        <span>少</span>
        {Array.from({ length: HEATMAP_LEVELS + 1 }, (_, lv) => (
          <span className="ink-heat-cell" key={lv} data-level={lv} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
