import { useState } from 'react';
import { App as AntApp, Button, ConfigProvider, Input } from 'antd';
import type { Countdown } from '../types.js';
import { countdownState, sortCountdowns } from '../lib/countdown.js';
import { boardLocalTheme } from '../theme.js';

interface Props {
  rows: Countdown[];
  now: Date;
  onAdd: (title: string, date: string, yearly: boolean, lunar: boolean) => void;
  onDelete: (id: string) => void;
  /**
   * 改名字/改日期。**这两样以前改不了**：`onToggleYearly` 一直在（同一条
   * `PATCH /api/countdowns/:id`），只有标题和日期没有入口——打错一个字、
   * 日子记差一天，只能删了重填。
   */
  onEdit?: (id: string, patch: { title?: string; date?: string }) => void;
  onToggleYearly: (id: string, yearly: boolean) => void;
  /** 切「农历」。跟 `onToggleYearly` 同一条路（就地发一个只改一个字段的写）。 */
  onToggleLunar: (id: string, lunar: boolean) => void;
}

/** 本地今天的 `YYYY-MM-DD`——给 `<input type="date">` 当默认值。 */
function todayString(now: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

/**
 * 倒数纪念日——仿滴答清单的倒数日模块。
 *
 * **它不是任务**：没有「做完」这一步、不进「今天」、不提醒。所以是一份单独的
 * 数据（`data/countdowns/`），不复用任务那一整套，见 `model.ts` 里 `Countdown`
 * 的注释。
 *
 * 日期用**原生 `<input type="date">`，不用 antd 的 DatePicker**：这里要的就是
 * 一个 `YYYY-MM-DD`，而 DatePicker 给的是 dayjs 对象、还得回头转一次（转的
 * 时候正是这个仓库反复踩 `toISOString().slice(0,10)` 的地方）。原生控件的值
 * 本来就是这个格式，少一次转换就少一处能出错的地方。
 */
export function CountdownView({ rows, now, onAdd, onDelete, onToggleYearly, onToggleLunar, onEdit }: Props) {
  const { modal } = AntApp.useApp();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(() => todayString(now));
  const [yearly, setYearly] = useState(false);
  const [lunar, setLunar] = useState(false);
  // 哪一条正在改（存 id，一次只开一个），和两个草稿。纯本地的一次性交互
  // 状态，跟侧栏那个就地改名同一个套路。
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDate, setDraftDate] = useState('');

  /** 存下就地改的那两样。**空名字/空日期不发**——服务端会拒（`checkCountdownPatch`
   *  要求非空标题和 `YYYY-MM-DD`），而他很可能只是想按回车取消。
   *  没改动的也不发：一次什么都不改的写只会白白触发一轮刷新。 */
  const saveEdit = (id: string) => {
    const row = rows.find((r) => r.id === id);
    const name = draftTitle.trim();
    if (!row || !name || !draftDate) { setEditing(null); return; }
    const patch: { title?: string; date?: string } = {};
    if (name !== row.title) patch.title = name;
    if (draftDate !== row.date) patch.date = draftDate;
    if (patch.title || patch.date) onEdit?.(id, patch);
    setEditing(null);
  };

  const submit = () => {
    const name = title.trim();
    if (!name || !date) return;
    // 没勾「每年」时农历那一格不起作用，发 false——存一个不起作用的 true
    // 只会让「为什么勾了没反应」变成一个要查的问题。
    onAdd(name, date, yearly, yearly && lunar);
    // 只清标题：接着记第二个纪念日时，日期和「每年」多半还想沿用上一次的
    // 设定（一次录一批生日是最典型的用法）。
    setTitle('');
  };

  return (
    <div className="ink-cd-root">
      <ConfigProvider theme={boardLocalTheme}>
        <div className="ink-cd-form">
          <Input
            className="ink-cd-title"
            aria-label="纪念日名字"
            placeholder="纪念日名字"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={submit}
          />
          <input
            className="ink-cd-date"
            type="date"
            aria-label="日期"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <label className="ink-cd-yearly">
            <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
            每年
          </label>
          {/* **只在勾了「每年」之后才出现**（仿滴答清单的「公历/农历」，
              《添加倒数纪念日》）：不重复的日子是一个固定的
              公历点，「距离那天多少天」跟农历没有关系——摆一个勾了没反应的
              勾选框比没有更糟，跟提醒预设里「结束时」只在有时间段时出现
              是同一条。判据写在 `types.ts` 的 `Countdown.lunar` 上。 */}
          {yearly && (
            <label className="ink-cd-yearly">
              <input type="checkbox" checked={lunar} onChange={(e) => setLunar(e.target.checked)} />
              农历
            </label>
          )}
          <Button size="small" color="default" variant="solid" disabled={!title.trim() || !date} onClick={submit}>
            添加
          </Button>
        </div>
      </ConfigProvider>

      {rows.length === 0 ? (
        <p className="ink-empty-note">还没有纪念日。上面填一个日期就行——考试、生日、纪念日这种「不是任务、但想知道还有几天」的事。</p>
      ) : (
        <ul className="ink-cd-list">
          {sortCountdowns(rows, now).map((c) => {
            const st = countdownState(c, now);
            return (
              <li className="ink-cd-row" key={c.id}>
                {/* 改名字/改日期：就地把这两样换成输入框，不另开弹窗——
                    「每年」那个勾选框本来就是就地改的，同一条 PATCH，
                    没有理由另外两个字段要换一种交互。 */}
                {editing === c.id ? (
                  <>
                    <Input
                      className="ink-cd-title"
                      autoFocus
                      aria-label={`「${c.title}」的新名字`}
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onPressEnter={() => saveEdit(c.id)}
                    />
                    <input
                      className="ink-cd-date"
                      type="date"
                      aria-label={`「${c.title}」的新日期`}
                      value={draftDate}
                      onChange={(e) => setDraftDate(e.target.value)}
                    />
                    <Button size="small" color="default" variant="solid" onClick={() => saveEdit(c.id)}>存下</Button>
                  </>
                ) : (
                  <span className="ink-cd-name">{c.title}</span>
                )}
                {/* 日期坏掉（手改文件写了别的）时说出来，不显示「NaN 天」。 */}
                {!st ? <span className="ink-cd-bad">日期坏了：{c.date}</span> : (
                  <>
                    <span className={`ink-cd-days ink-cd-days-${st.kind}`}>
                      {st.kind === 'today' ? '就是今天' : st.kind === 'down' ? `还有 ${st.days} 天` : `已经 ${st.days} 天`}
                    </span>
                    <span className="ink-cd-at">{st.at.getFullYear()}-{String(st.at.getMonth() + 1).padStart(2, '0')}-{String(st.at.getDate()).padStart(2, '0')}</span>
                  </>
                )}
                <label className="ink-cd-yearly">
                  <input
                    type="checkbox"
                    aria-label={`「${c.title}」每年重复`}
                    checked={c.yearly}
                    onChange={(e) => onToggleYearly(c.id, e.target.checked)}
                  />
                  每年
                </label>
                {c.yearly && (
                  <label className="ink-cd-yearly">
                    <input
                      type="checkbox"
                      aria-label={`「${c.title}」按农历算`}
                      checked={c.lunar}
                      onChange={(e) => onToggleLunar(c.id, e.target.checked)}
                    />
                    农历
                  </label>
                )}
                {/* 删除先问一句。纪念日不进垃圾箱（重建成本约等于零，见服务端
                    那条路由的注释），所以这一下就是真的没了——没有退路的动作
                    必须先确认，跟卡片上删任务同一条规矩。 */}
                {onEdit && editing !== c.id && (
                  <Button
                    size="small"
                    type="text"
                    aria-label={`改「${c.title}」`}
                    onClick={() => { setEditing(c.id); setDraftTitle(c.title); setDraftDate(c.date); }}
                  >✎</Button>
                )}
                <Button
                  size="small"
                  type="text"
                  danger
                  aria-label={`删掉「${c.title}」`}
                  onClick={() => modal.confirm({
                    title: `删掉「${c.title}」？`,
                    content: '纪念日不进垃圾箱，删了就是真的没了——重新填一个也很快。',
                    okText: '删除',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => onDelete(c.id),
                  })}
                >×</Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
