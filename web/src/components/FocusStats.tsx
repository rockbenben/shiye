import { useState } from 'react';
import { App as AntApp, Button, ConfigProvider, DatePicker, InputNumber } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { Task, WeekStart } from '../types.js';
import {
  addSessionPatch, busiestHour, focusByDay, focusByGroup, focusByHour, focusByTask, focusTotals,
  formatMinutes, recentSessions, removeSessionPatch, type FocusGroupBy, type FocusTotal,
} from '../lib/focusStats.js';
import { formatWhen } from '../lib/taskView.js';
import { Heatmap } from './Heatmap.js';
import { HEATMAP_DAYS } from '../lib/heatmap.js';
import { boardLocalTheme } from '../theme.js';
import { DATETIME_FORMAT, TIME_FORMAT } from './TaskFields.js';

/** 趋势图看最近多少天。两周：一屏摆得下、又够看出「哪几天没干活」这种规律。 */
const TREND_DAYS = 14;
/** 排行榜列几条。再多就不是「时间花在哪几件事上」，是一份完整清单了。 */
const TOP_N = 10;
/** 「专注记录」那张列表摆几条。它存在的目的是「刚补记的那条填错了能删掉」，
 *  不是一份完整流水账——最近十条足够覆盖那个场景。 */
const RECENT_N = 10;

interface Props {
  tasks: Task[];
  /** 一周从周几开始（`Settings.weekStart`）。「本周专注了多久」那个数字和下面
   *  热力图的行对齐都靠它——两处必须是同一个数，见 `lib/calendar.ts` 的
   *  `weekStartOf`。不给按周一。 */
  weekStart?: WeekStart;
  /** 「按清单」那一档要拿 id 换名字。不给就只剩「按标签」那一档可选——
   *  一份全是裸 uuid 的分布不如不显示。 */
  lists?: Array<{ id: string; name: string }>;
  now: Date;
  /**
   * 补记 / 删记录要发的写。不给就整块「补记」不渲染——一个点了没反应的表单
   * 比没有更糟，跟 TaskCard 的 `onDuplicate` 同一条。
   */
  onPatch?: (id: string, patch: Partial<Task>) => void;
  /**
   * 点某条任务的名字：跳回那条任务。跟习惯页 `HabitStats` 的 `onOpen`、
   * 「回顾」里点关联任务是同一个动作，调用方接的也该是同一个处理。
   *
   * 补的是一处「看得见、够不着」：这一屏告诉你「这三小时花在『写周报』上」，
   * 而那条任务在这儿点不开——得自己记住标题，切到别的视图再找一遍。
   *
   * **只有认得出是哪条任务的那两张表能点**（按任务的排行、最近的记录）；
   * 按清单/标签分的那张不能——一个标签没有「那条任务」可跳。
   */
  onOpen?: (taskId: string) => void;
}

/** 名字那一格：接了 `onOpen` 就是一颗跳回那条任务的按钮，没接还是一行字。
 *  两种共用同一个类，外观差别只有一条下划线，见 theme.css 那段注释。 */
const RankName = ({ id, title, onOpen }: { id: string; title: string; onOpen?: (taskId: string) => void }) => (
  onOpen
    ? <button type="button" className="ink-fstat-rank-name" style={{ textDecoration: 'underline' }} onClick={() => onOpen(id)}>{title}</button>
    : <span className="ink-fstat-rank-name">{title}</span>
);

const Cell = ({ label, total }: { label: string; total: FocusTotal }) => (
  <div className="ink-fstat-cell">
    <div className="ink-fstat-cell-label">{label}</div>
    <div className="ink-fstat-cell-value">{formatMinutes(total.minutes)}</div>
    <div className="ink-fstat-cell-sub">{total.count} 次</div>
  </div>
);

/**
 * 专注统计——仿滴答清单的「专注数据统计」。
 *
 * 存在的理由不是「多一个页面」：番茄钟跑完记下的那条 `focusSessions` 在这个
 * 界面上**一处都没有被读过**，每一次专注都被记下来又立刻消失。判据在
 * `lib/focusStats.ts`，这里只管怎么摆。
 *
 * **柱状图用的是 div 高度，不引图表库。** 十四根柱子、一个最大值、一句
 * `height: N%`——为这个装一个几十 KB 的图表库，是这个仓库「能一行就一行」
 * 那条规矩的反面。
 */
export function FocusStats({ tasks, lists, now, onPatch, onOpen, weekStart }: Props) {
  // 「时间花在哪一类事情上」按什么分。**纯本地的一次性选择，不存**：跟密度、
  // 分组排序那几个不一样，这不是「我一直想这么看」，是看统计时来回切两下。
  const [groupBy, setGroupBy] = useState<FocusGroupBy>(lists?.length ? 'list' : 'tag');
  const { message } = AntApp.useApp();
  // 补记表单的三个值。**默认时刻是「现在」，默认时长留空**——时长必须由人
  // 填：给它一个默认的 25 会让「点错了直接回车」记下一条看起来很正常、实际
  // 没发生过的专注。
  const [atTaskId, setAtTaskId] = useState('');
  const [at, setAt] = useState<Dayjs | null>(() => dayjs(now));
  const [mins, setMins] = useState<number | null>(null);

  const submitBackfill = () => {
    const t = tasks.find((x) => x.id === atTaskId);
    if (!t || !at || !mins || mins <= 0) return;
    onPatch?.(t.id, addSessionPatch(t, at.toDate(), mins));
    // 只清时长，任务和时刻留着——连着补记同一件事的好几段（上午一段、下午
    // 一段）是最常见的用法，每次都重选一遍任务是白费。
    setMins(null);
    void message.success('补记好了');
  };

  const totals = focusTotals(tasks, now, weekStart);
  const days = focusByDay(tasks, now, TREND_DAYS);
  const top = focusByTask(tasks);
  // 「按情境」那一档出不出现——判据跟「按清单」那一档同一个形状，见下面那个 select。
  const hasContext = tasks.some((t) => t.context !== null && t.context !== undefined);

  const recent = recentSessions(tasks, RECENT_N);

  /**
   * 补记那一块。**空状态下也要渲染它**——一次都没专注过时如果连补记入口都
   * 藏起来，想把昨天忘了计时的那两小时记上来就无处可去，而那正是这个功能
   * 最典型的用法。
   */
  const backfill = onPatch && (
    // 局部 ConfigProvider 压 colorPrimary：DatePicker/InputNumber/Button 都
    // 直接读全局 colorPrimary（群青），而群青是配给制、只标 AI 产出。跟
    // TaskComposer/FilterBar 的既有解法一致，见 theme.ts 顶部的注释。
    <ConfigProvider theme={boardLocalTheme}>
      <div className="ink-fstat-backfill">
        <select
          className="ink-list-select"
          aria-label="补记到哪条任务"
          value={atTaskId}
          onChange={(e) => setAtTaskId(e.target.value)}
        >
          <option value="">选一条任务…</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {/* 到分不到秒，跟任务表单那两个框同一份格式常量——补记一条专注记录
            时那个 `:00` 一样是噪音。 */}
        <DatePicker
          showTime={{ format: TIME_FORMAT }}
          format={DATETIME_FORMAT}
          aria-label="专注开始时间"
          value={at}
          onChange={setAt}
        />
        {/* **关掉加减那两颗小箭头**（`controls={false}`）。实测两个理由，都不是审美：
          一是它们在这套主题下量出来是 **1×15px**，外层 `ant-input-number-actions`
          宽 0、`opacity: 0`，要悬停才展开——鼠标基本够不着，触屏更别提；
          二是它们的 `aria-label` 是**写死的英文**（`Increase Value` / `Decrease Value`，
          在 `@rc-component/input-number` 的 StepHandler 里，**antd 的 locale 覆盖不到**），
          在一个全中文界面里读屏会突然念两句英文。
          这一格本来就是打字最快（分钟数、秒数），少这两颗不损失任何操作。 */}
        <InputNumber
          controls={false}
          aria-label="专注了多少分钟"
          min={1}
          max={24 * 60}
          placeholder="分钟"
          value={mins}
          onChange={setMins}
        />
        <Button
          size="small"
          color="default"
          variant="solid"
          disabled={!atTaskId || !at || !mins}
          onClick={submitBackfill}
        >补记</Button>
      </div>
    </ConfigProvider>
  );

  // 一次都没专注过：不画三张空图表，说一句话。空的柱状图和空的排行榜看着
  // 像坏了，而这个状态在新装的机器上是常态。补记入口照样给，见上面。
  if (totals.all.count === 0) {
    return (
      <div className="ink-fstat-root">
        <p className="ink-empty-note">
          还没有专注记录。卡片上有个「开始专注」，跑完一轮就会记在这里；忘了计时的那几段可以在下面补记。
        </p>
        {backfill}
      </div>
    );
  }

  // 热力图那一年的数据：复用 `focusByDay`，只是窗口从两周换成一年——
  // 「哪天是多少」这件事只该有一处算法。
  const yearDays = focusByDay(tasks, now, HEATMAP_DAYS);
  const yearValues = new Map(yearDays.map((d) => [d.key, d.total.minutes]));
  const yearMinutes = yearDays.reduce((n, d) => n + d.total.minutes, 0);

  // 柱子的高度按这两周里最高的那天算，不按一个写死的上限——一天专注 25 分钟
  // 的人和一天 4 小时的人，看到的都该是有起伏的图。
  const peak = Math.max(...days.map((d) => d.total.minutes), 1);

  const hours = focusByHour(tasks);
  const best = busiestHour(hours);
  const hourPeak = Math.max(...hours.map((h) => h.total.minutes), 1);
  const groups = focusByGroup(tasks, groupBy, lists ?? []);

  return (
    <div className="ink-fstat-root">
      <div className="ink-fstat-cells">
        <Cell label="今天" total={totals.today} />
        <Cell label="本周" total={totals.week} />
        <Cell label="本月" total={totals.month} />
        <Cell label="至今" total={totals.all} />
      </div>

      <h2 className="ink-fstat-title">最近两周</h2>
      {/* role=group + 名字：这几张图/表用的是同一套柱子和行样式（有意的，
          它们是同一种东西的不同切法），所以每一份都得报出自己是谁——不然
          读屏里是一大堆没有归属的 role=img，测试里也没法只看其中一份。 */}
      <div className="ink-fstat-trend" role="group" aria-label="最近两周的趋势">
        {days.map((d) => (
          <div className="ink-fstat-bar-slot" key={d.key}>
            {/* 每根柱子自己带 title：十四根柱子挤在一行，轴标签只标得下日号，
                具体多少分钟靠悬停。`aria-label` 单独给一份——`title` 在有内容
                的元素上不会成为可访问名（accname 规范），同一条教训见
                TaskCard.tsx 里 DragHandleProps.title 那段。 */}
            <div
              className="ink-fstat-bar"
              style={{ height: `${Math.round((d.total.minutes / peak) * 100)}%` }}
              title={`${d.key} ${formatMinutes(d.total.minutes)}`}
              aria-label={`${d.key} ${formatMinutes(d.total.minutes)}`}
              role="img"
            />
            <div className="ink-fstat-bar-label">{d.date.getDate()}</div>
          </div>
        ))}
      </div>

      {/* 年度热力图（仿滴答清单）。跟上面那张两周柱状图回答的不是同一个问题：
          柱状图是「最近怎么样」，热力图是「这一年的形状」——哪几个月密、
          哪一段整个空着。同一批 `focusByDay` 数据，换一个尺度。 */}
      <h2 className="ink-fstat-title">这一年</h2>
      <Heatmap
        values={yearValues}
        now={now}
        weekStart={weekStart}
        label={(key, v) => `${key} ${v > 0 ? formatMinutes(v) : '没有专注'}`}
        ariaLabel={`这一年的专注热力图，共 ${formatMinutes(yearMinutes)}`}
      />

      {/* 什么时候专注（仿滴答清单的「专注时间分布」）。跟上面两张图问的又不
          一样：那两张是「多少」和「这一年的形状」，这张是「一天里的什么时候」
          ——那正是能拿来安排明天的那个答案。复用同一套柱子标记。 */}
      <h2 className="ink-fstat-title">什么时候专注</h2>
      {best && (
        // 说「记录最多的是」，不说「你最擅长在」——数据说得出前者，说不出后者。
        <p className="ink-fstat-more">记录最多的是 {String(best.hour).padStart(2, '0')}:00–{String(best.hour + 1).padStart(2, '0')}:00。</p>
      )}
      <div className="ink-fstat-trend" role="group" aria-label="一天里的分布">
        {hours.map((h) => (
          <div className="ink-fstat-bar-slot" key={h.hour}>
            <div
              className="ink-fstat-bar"
              style={{ height: `${Math.round((h.total.minutes / hourPeak) * 100)}%` }}
              title={`${String(h.hour).padStart(2, '0')} 点 ${formatMinutes(h.total.minutes)}`}
              aria-label={`${String(h.hour).padStart(2, '0')} 点 ${formatMinutes(h.total.minutes)}`}
              role="img"
            />
            {/* 24 根柱子，标签只写偶数点——每根都写在窄屏上会糊成一片。 */}
            <div className="ink-fstat-bar-label">{h.hour % 2 === 0 ? h.hour : ''}</div>
          </div>
        ))}
      </div>

      {/* 时间花在哪一类事情上（仿滴答清单的「专注时长分布」）。跟下面那份
          「按任务」不重复：那份回答「哪几件事」，这份回答「哪一类事」。 */}
      <h2 className="ink-fstat-title">花在哪一类上</h2>
      <ConfigProvider theme={boardLocalTheme}>
        <select
          className="ink-list-select"
          aria-label="分布按什么分"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as FocusGroupBy)}
        >
          {lists?.length ? <option value="list">按清单</option> : null}
          <option value="tag">按标签</option>
          {/* 跟「按清单」同一条规矩：**一条都没分过情境时不给这一档**。那时候选了只会
              得到孤零零一行「没分情境」，跟不选一样，却多一次点击。 */}
          {hasContext ? <option value="context">按情境</option> : null}
        </select>
      </ConfigProvider>
      <ul className="ink-fstat-rank" aria-label="按类别的分布">
        {groups.map((g) => (
          <li className="ink-fstat-rank-row" key={g.key ?? '__none__'}>
            <span className="ink-fstat-rank-name">{g.label}</span>
            <span className="ink-fstat-rank-value">{formatMinutes(g.total.minutes)}</span>
            <span className="ink-fstat-rank-sub">{g.total.count} 次</span>
          </li>
        ))}
      </ul>
      {/* 标签那一档会超过总数，必须说出来——一份各项加起来比总数还多的分布，
          不解释就是在让人怀疑数据错了。 */}
      {/* 情境那一档不需要这句声明：一条任务只有一个情境，各组加起来就是总时长。 */}
      {groupBy === 'tag' && (
        <p className="ink-fstat-more">
          一条任务打了几个标签，这段时间就在每个标签下各算一次——所以各项加起来会比总时长多。
        </p>
      )}

      <h2 className="ink-fstat-title">时间花在哪儿</h2>
      <ul className="ink-fstat-rank" aria-label="按任务的排行">
        {top.slice(0, TOP_N).map((r) => (
          <li className="ink-fstat-rank-row" key={r.id}>
            <RankName id={r.id} title={r.title} onOpen={onOpen} />
            <span className="ink-fstat-rank-value">{formatMinutes(r.total.minutes)}</span>
            <span className="ink-fstat-rank-sub">{r.total.count} 次</span>
          </li>
        ))}
      </ul>
      {/* 截断了要说出来——一份看起来是全部、其实只有前十的排行榜，会让人以为
          自己的时间只花在这十件事上。 */}
      {top.length > TOP_N && (
        <p className="ink-fstat-more">另外还有 {top.length - TOP_N} 条有专注记录的任务没列出来。</p>
      )}

      {/* 专注记录（仿滴答清单的「专注记录」列表 + 「补记」「删除记录」）。
          **补记必须配一张看得见、删得掉的列表**：填错一条（点错任务、多打
          一个 0）如果没地方看、没地方删，这个入口就是一扇单向门。 */}
      <h2 className="ink-fstat-title">专注记录</h2>
      <ul className="ink-fstat-rank" aria-label="最近的专注记录">
        {recent.map((r) => (
          <li className="ink-fstat-rank-row" key={`${r.taskId}:${r.startedAt}`}>
            <RankName id={r.taskId} title={r.title} onOpen={onOpen} />
            <span className="ink-fstat-rank-sub">{formatWhen(r.startedAt)}</span>
            <span className="ink-fstat-rank-value">{formatMinutes(r.minutes)}</span>
            {onPatch && (
              <Button
                size="small"
                type="text"
                aria-label={`删掉「${r.title}」${formatWhen(r.startedAt)} 那条专注记录`}
                onClick={() => {
                  const t = tasks.find((x) => x.id === r.taskId);
                  const patch = t && removeSessionPatch(t, r.startedAt);
                  if (patch) onPatch(r.taskId, patch);
                }}
              >×</Button>
            )}
          </li>
        ))}
      </ul>

      <h2 className="ink-fstat-title">补记一条</h2>
      {backfill}
    </div>
  );
}
