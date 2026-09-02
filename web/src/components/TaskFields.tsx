import { useState } from 'react';
import { Button, ConfigProvider, DatePicker, Input, InputNumber, Space } from 'antd';
import dayjs from 'dayjs';
import type { List, Repeat, TaskContext } from '../types.js';
import { CONTEXT_LABEL, CONTEXTS } from '../lib/taskView.js';
import { canBeHabit } from '../lib/habit.js';
import { RepeatFields } from './RepeatFields.js';
import { NotesEditor } from './NotesEditor.js';
import { activePresets, choiceKey, choiceToRemindAt, REMIND_CHOICES, setNthReminder, togglePreset } from '../lib/remindPreset.js';
import { fileableLists } from '../lib/listIcon.js';
import { formKey } from '../lib/keymap.js';
import { boardLocalTheme } from '../theme.js';

/**
 * 一张任务卡可以手填的八个字段（标题/备注/截止/提醒/优先级/标签/清单/重复规则）。
 * 两处共用同一份：卡片的编辑态（改已有任务）和 TaskComposer（手工建新任务）——
 * 填的是同样八样东西，没有第二份表单，也就不会出现「编辑态能清空提醒、新建时
 * 不能」这种两边慢慢长歪的事。
 *
 * **加字段时留意：App.tsx 的 `onCreate` 是手挑字段拼请求体的，不会自动带上
 * `TaskDraft` 新增的这个字段**——tags/priority 就在这一行被静默丢过一次
 * （见 api.ts 里 `addTask` 的注释），现在有 `Object.keys(emptyDraft())` 的
 * 结构性守卫兜底（App.test.tsx），但这里先提一句更省事。
 *
 * 这里刻意**不含** status / order / subtasks：
 * - status 由卡片上的状态流转按钮走（开始/完成/搁置……），新建的任务一律是
 *   服务端 `newTask()` 给的 'todo'
 * - order 是「今天」视图里拖出来的，不是填出来的
 * - subtasks **由卡片上那一块直接改**（增删改一律直接发 patch），不进这份
 *   草稿：那个勾选框在编辑态里也点得动，草稿里再存一份的话，编辑期间勾的
 *   那一下会在保存时被盖回去。见 TaskCard 里 `putSubs` 上面那段。
 */
export interface TaskDraft {
  title: string;
  notes: string;
  due: string | null;
  /**
   * 什么时候**开始**能做（OmniFocus 的 Defer Date，出处见 `types.ts` 的
   * 同名字段）。`null` = 随时可以做。
   *
   * 跟 `due` 摆在一起编辑：一个说「什么时候之前要做完」，一个说「在这之前
   * 别烦我」。判据和为什么要有它写在 `types.ts` 的 `Task.startAt` 上。
   */
  startAt: string | null;
  /** 响过一次还没处理就一直响（仿滴答清单的「持续提醒」）。判据和「什么叫
   *  处理」在 `types.ts` 的同名字段上。 */
  persistentReminder: boolean;
  /** 这件事什么时候结束（跟 `startAt` 一起构成滴答清单的「时间段」）。
   *  `null` = 没定结束时刻。判据和它跟 `startAt` 的关系在 `types.ts`。 */
  endAt: string | null;
  /**
   * 提醒时刻，**可以有多个**——数据模型（`Task.reminders`）一直是数组，
   * 服务端逐条判、逐条发，`.ics` 也逐条导出，只有这个表单一直卡在一个：
   * 它以前是 `remindAt: string | null`，第二条及以后编辑不到，保存时靠
   * `t.reminders.slice(1)` 原样接回去才没被抹掉（TaskCard 里那段注释）。
   */
  reminders: string[];
  /**
   * 当成习惯（打卡）。**只有「每天」「每周」重复的任务才谈得上**——「习惯」
   * 那个去处和它的连续周期、月度打卡表都按 `isHabit` 认（判据在
   * `lib/habit.ts`，名单在 `server/src/model.ts` 的 `HABIT_EVERY`），
   * 别的重复档标了也不会出现在那儿。
   */
  habit: boolean;
  /**
   * 在等谁/等什么。`null` = 没在等。
   *
   * 这个字段**服务端和 AI 一直都写得进**（AGENTS.md：「等张老师回邮件」是
   * 原文里的事实，AI 拆解时就能填），筛选栏也一直有「只看等待中的」这一档
   * ——只有人自己没有任何地方能填它、也没有任何地方能清掉它。于是 AI 标上
   * 「在等回邮件」之后，邮件回了，那条任务永远留在那个筛选里。
   */
  waitingFor: string | null;
  /**
   * 什么条件下才干得了这件事（GTD 的「情境」）。`null` = 没分。
   *
   * 判据和为什么值得占一个字段，写在 `types.ts` 的 `Task.context` 上。这里
   * 只说它为什么该出现在这张表单里：它跟 `waitingFor` 一样，**AI 填得进、
   * 筛选栏筛得到，人却没地方填** —— 那种字段最后一定会变成「AI 标了就永远
   * 是那样」，这个仓库已经为 `waitingFor` 认过一次。
   */
  context: TaskContext | null;
  /** 打算花多久，分钟。`null` = 没估过。 */
  estimateMinutes: number | null;
  priority: 0 | 1 | 2 | 3;
  tags: string[];
  listId: string | null;
  /** 在这份清单里属于哪一段（仿滴答清单的「分组」/ Things 的 Headings）。
   *  `null` = 不在任何分段里。判据和「为什么存名字不建表」在 `types.ts`。 */
  section: string | null;
  repeat: Repeat | null;
  /** 挂在哪条任务下面（多级任务，仿滴答清单「关联主任务」）。只做一层，
   *  候选表由调用方算好传进来，见 `parentOptions`。 */
  parentId: string | null;
}

/**
 * 日期选择器显示到**分**，不显示秒。
 *
 * antd 的 `showTime` 默认吐 `YYYY-MM-DD HH:mm:ss`，于是这个应用里唯一带秒的
 * 时间显示就落在这几个框里——而任务的截止/提醒没有一处用得到秒（提醒按分钟
 * 排，卡片和行档都只显示到分）。多出来的 `:00` 是噪音，见
 * 2026-08-12-ux-audit.md「时间戳带秒」。
 *
 * 导出是给测试用的：断言里写死一遍格式就等于把同一件事说了两处。
 */
export const TIME_FORMAT = 'HH:mm';
export const DATETIME_FORMAT = `YYYY-MM-DD ${TIME_FORMAT}`;

export const emptyDraft = (): TaskDraft => ({ title: '', notes: '', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, estimateMinutes: null, habit: false, waitingFor: null, context: null, priority: 0, tags: [], listId: null, section: null, repeat: null, parentId: null });

/** 三档的名字——TaskCard 的旗标 aria-label 也读这份，不各写一份。两份名字
 * 反了没有任何断言拦得住（各自的测试只挑一个不动点档位验），单一份源头
 * 让「反过来」这种变异从写法上就不成立。 */
export const PRI_LABEL: Record<1 | 2 | 3, string> = { 3: '高', 2: '中', 1: '低' };
/**
 * 上面那三档加上「无」。**「无」原来在四个地方各写了一遍**（这份菜单、筛选栏
 * 的下拉、侧栏的智能清单说明、AI 建议里那句「优先级改成 X」），全是同一个字。
 * 一个字看着不值得收拢——直到你想把它改成「不设」为止：那时候要改四处，而漏
 * 掉的那一处不会有任何东西报错。跟状态那五个字符串是同一课，见
 * `lib/statusLabel.guard.test.ts` 里记的那两次账。
 *
 * **它不是「比低还低的一档」**，是「没有优先级」——所以排在最后，不在 3/2/1
 * 的顺序里插队。
 */
export const PRI_LABEL_ALL: Record<0 | 1 | 2 | 3, string> = { ...PRI_LABEL, 0: '无' };

// 三档 + 「无」。「无」不给按钮：再点一次当前档位就清回 0，比多摆一颗按钮省地方，
// 也少一个「无」和「低」看着差不多的判断。规格原话：优先级是**一面小旗的填充色**，
// 不是把标题染红——所以这里选的是三个填充色，不是三种字色。
const PRIORITIES: Array<{ v: 1 | 2 | 3; label: string }> = ([3, 2, 1] as const).map((v) => ({ v, label: PRI_LABEL[v] }));

/**
 * 菜单里那一档档优先级：高 → 中 → 低 → 无。
 *
 * **0（无）放最后**，不在原来三档的顺序里插队——它是「取消优先级」这个动作，
 * 不是比「低」还低的一档。批量操作条和单张卡的 ⋯ 里各有一份这样的菜单，
 * 两处共用这一个表：顺序或者文案在一处改了，另一处不该还是老样子。
 * 上面那个 `PRIORITIES` 是编辑表单里的三颗小旗按钮（没有「无」，再点一次
 * 当前档就清回 0），两者形状不同，不合并。
 */
export const PRI_MENU: Array<{ v: 0 | 1 | 2 | 3; label: string }> =
  ([3, 2, 1, 0] as const).map((v) => ({ v: v as 0 | 1 | 2 | 3, label: PRI_LABEL_ALL[v] }));

interface Props {
  value: TaskDraft;
  onChange: (next: TaskDraft) => void;
  /** 新建表单一展开就把光标放进标题框；卡片编辑态不要——那会把页面滚到那张卡。 */
  autoFocusTitle?: boolean;
  /** 归到哪个清单的候选项。必填不是疏忽——四条接线（TaskCard 的编辑态、
   * TaskComposer、以及它们各自的容器）漏掉任何一条都该在编译期报错，不能
   * 悄悄传个空数组把下拉框变成只有「不属于任何清单」一项。 */
  lists: List[];
  /**
   * 能挂到哪条任务下面（多级任务）。**由调用方算好**——判据在
   * `lib/hierarchy.ts` 的 `parentCandidates`（排除自己、排除已经是别人子任务
   * 的、自己名下有子任务时一个都不给），这个表单不认识「全部任务」这个概念。
   * 不给（或者给空数组）时这一项整个不渲染：一条候选都没有的下拉框只会让人
   * 以为功能坏了。
   */
  parentOptions?: Array<{ id: string; title: string }>;
  /**
   * 这份清单里已经用过的分段名，给那个自由输入框当候选。不给就是没有候选
   * ——输入框照样能用（起一个新段名），只是要自己打全。
   *
   * **由调用方算好传进来**，跟 `parentOptions` 同一条：算它要看全表，而这个
   * 组件只拿得到一份草稿。
   */
  sectionOptions?: string[];
  /**
   * 键盘保存 / 键盘取消（仿滴答清单：标题框里回车就是「写好了」）。都可选——
   * 不给就是今天的行为，只能点按钮。
   *
   * **只挂在标题框和备注框这两个纯文本框上**，不挂在整个表单外壳上。截止时间、
   * 清单、重复截止这些是 antd 的弹层控件，Esc 在它们身上的意思是「关掉这个
   * 弹层」——事件冒到外壳上再被当成「取消编辑」，等于按一下 Esc 关个日期框，
   * 顺手把没保存的草稿全扔了。标签输入框的回车是「加上这个标签」，同理。
   *
   * 哪个键算什么在 `lib/keymap.ts` 的 `formKey`（含三道输入法守卫——中文输入法
   * 按回车是上屏候选词，不是「我写完了」）。
   */
  onSubmit?: () => void;
  onCancel?: () => void;
}

export function TaskFields({ value, onChange, autoFocusTitle, lists, parentOptions, sectionOptions = [], onSubmit, onCancel }: Props) {
  // 哪几档预设是点亮的。**可能不止一颗**——一条任务可以有多个提醒。
  const lit = activePresets(value, value.reminders);
  /** 这条任务上真的算得出时刻的那几档——算不出的不摆按钮，见下面那段注释。 */
  const shownChoices = REMIND_CHOICES.filter((c) => choiceToRemindAt(value, c) !== null);

  const [tagDraft, setTagDraft] = useState('');
  // 重复/优先级/清单/标签四组收进一个 <details>：摊开是 12 个控件（选了「每周」
  // 之后 21 个），一个偶尔用一次的表单读起来吵（measure-ui.mjs 量出来的数字，
  // 见 2026-08-17-debt-sweep #6）。默认收起；但这条任务这四项已经有值时
  // （编辑已有任务）打开时就该看得见，不能把已经填的东西藏起来。
  //
  // 只在挂载那一刻算一次、存进 state，不是每次渲染都从 value 重算：`open`
  // 这种布尔属性不在 React「受控表单元素」那个特殊名单里（不像 input 的
  // value/checked），但如果每次渲染都传一个跟着 value 变的新布尔值，用户
  // 把某个字段改回默认值（比如优先级点两下清回 0）那一刻它会变化，React 就
  // 会把这次变化同步到 DOM——面板在你眼前收起来。冻结成挂载时的一次性判断
  // 就没有这个问题：之后完全交给浏览器原生的展开/收起，不再有「记忆」。
  const [moreOpen] = useState(() => value.priority > 0 || value.tags.length > 0 || value.listId !== null || value.repeat !== null || value.parentId !== null);
  return (
    <>
      <Input
        autoFocus={autoFocusTitle}
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.target.value })}
        onKeyDown={(e) => {
          // 单行框，回车不用来换行——`plainEnter` 只在这里开。
          const k = formKey(e, { plainEnter: true });
          if (k === 'submit' && onSubmit) { e.preventDefault(); onSubmit(); }
          if (k === 'cancel' && onCancel) { e.preventDefault(); onCancel(); }
        }}
        placeholder="标题"
      />
      {/* 备注。编辑器本体（textarea + 「/」菜单 + 预览开关）搬去了
          `NotesEditor`——详情面板的就地编辑用的是同一个，见那个文件顶部。 */}
      <NotesEditor
        value={value.notes}
        onChange={(notes) => onChange({ ...value, notes })}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
      {/* showTime + allowClear：两个时间都要能清空置 null，antd 默认就支持清空，
          这里不用另外写「清空」按钮。

          **`format` 写死到分钟，不带秒。** antd 的 showTime 默认吐
          `YYYY-MM-DD HH:mm:ss`，于是这个应用里唯一带秒的时间显示就在这两个
          框里——而任务的截止时间没有任何一处会用到秒（提醒按分钟排、卡片和
          行档都只显示到分）。多出来的 `:00` 是噪音，见
          2026-08-12-ux-audit.md「时间戳带秒」。`showTime` 里也要跟着写一遍：
          外层 `format` 管输入框显示，`showTime.format` 管下拉里那几列，
          只写一处的话面板里还是三列（连秒都能挑）。 */}
      <Space wrap>
        {/* **开始时间摆在截止时间前面**：先「什么时候能动手」再「什么时候之前
            得做完」，跟人排一件事的顺序一致。
            一个说「在这之前别烦我」，一个说「什么时候之前要做完」——两个都
            可选，都不填就是加这个字段之前的行为（随时可以做、也不催）。
            **不校验「开始晚于截止」**：那是一句自相矛盾的话，但它是用户的话，
            当场拒掉会让那一次编辑整个失败（两个控件，改哪个都可能短暂地不
            自洽）。理由整段在 server/src/task.ts 那处校验旁边。 */}
        <DatePicker
          showTime={{ format: TIME_FORMAT }}
          format={DATETIME_FORMAT}
          allowClear
          placeholder="开始时间"
          value={value.startAt ? dayjs(value.startAt) : null}
          onChange={(d) => onChange({ ...value, startAt: d ? d.toISOString() : null })}
        />
        {/* **结束时间只在填了开始时间之后才出现**（滴答清单的「时间段」）。
            一个没有起点的「结束时间」在这个应用里说不出任何意思——`endAt`
            单独存在时日历不认它（`calendarAnchor` 要两个都在），一个改了没
            任何效果的控件比不显示它糟。

            **不校验「结束早于开始」**，跟旁边「开始晚于截止」同一条既有约定：
            那是一句自相矛盾的话，但它是用户的话，两个控件改哪个都可能短暂地
            不自洽，当场拒掉会让那一次编辑整个失败。日历那边按「没有时间段」
            处理，不画一个负高度的块。 */}
        {value.startAt && (
          <DatePicker
            showTime={{ format: TIME_FORMAT }}
            format={DATETIME_FORMAT}
            allowClear
            placeholder="结束时间"
            value={value.endAt ? dayjs(value.endAt) : null}
            onChange={(d) => onChange({ ...value, endAt: d ? d.toISOString() : null })}
          />
        )}
        <DatePicker
          showTime={{ format: TIME_FORMAT }}
          format={DATETIME_FORMAT}
          allowClear
          placeholder="截止时间"
          value={value.due ? dayjs(value.due) : null}
          onChange={(d) => onChange({ ...value, due: d ? d.toISOString() : null })}
        />
        {/* **一条任务可以有多个提醒**：一个一个 DatePicker 摆出来，清空
            某一个就是删掉它（antd 的 allowClear 已经是这个手势，不另加
            一颗 ×），末尾永远留一个空的用来加下一个。
            不做「加一个提醒」按钮：那要多按一下才看得到输入框，而一个空的
            选择器本身就是那颗按钮，还顺带说明了要填的是什么。 */}
        {[...value.reminders, ''].map((at, i) => (
          <DatePicker
            key={`${i}-${at}`}
            showTime={{ format: TIME_FORMAT }}
            format={DATETIME_FORMAT}
            allowClear
            placeholder={i === 0 ? '提醒时间' : '再提醒一次'}
            value={at ? dayjs(at) : null}
            onChange={(d) => onChange({ ...value, reminders: setNthReminder(value.reminders, i, d ? d.toISOString() : null) })}
          />
        ))}
      </Space>
      {/* 「持续提醒」（仿滴答清单）：响过一次还没处理就一直响。

          **只在真的设了提醒时才出现**——一个没有提醒的任务，「一直响」没有
          任何可以持续的东西，摆一个勾了没反应的开关比没有更糟（跟下面那排
          「提前多久」在没有截止时间时整排不出现是同一条）。

          **默认关，而且只能一条条开**：`reminder.ts` 上写着一条方向相反的
          原则（搁置的任务不发提醒，「刚图个清净就被烦到比不搁置还糟」），
          持续提醒是反向的压力，所以它必须是他为某一条任务主动打开的东西。
          完整理由在 `types.ts` 的 `persistentReminder` 上。

          原生 <label>+<input>，不套 antd Checkbox：那个的选中态直接读全局
          colorPrimary（群青），而群青是配给制、只标 AI 产出。 */}
      {value.reminders.length > 0 && (
        <label className="ink-cal-pref">
          <input
            type="checkbox"
            checked={value.persistentReminder}
            onChange={(e) => onChange({ ...value, persistentReminder: e.target.checked })}
          />
          没处理就一直提醒
        </label>
      )}
      {/* 「提前多久」预设（仿滴答清单）。**算不出锚点的那一颗就不出现**：
          「提前」没有参照物，摆一颗点了算不出时刻的按钮比没有更糟。所以这排
          按钮的个数跟着任务变——没有时间段时没有「结束时」，什么时间都没设时
          整排都不出现（`REMIND_CHOICES` 里每一档各自问 `choiceToRemindAt`）。

          **锚点不再写死 `due`**：有时间段的锚在起点（判据是 `calendarAnchor`，
          跟日历落格同一份），所以一场只有时间段、没有截止时间的会现在也点得出
          「提前 30 分钟」——在这之前它一档都点不出来。

          点亮哪一颗由 `activePresets` 现算，不另存一个「他选的是哪一档」——
          存了就要操心它跟 remindAt 对不上的时候听谁的。**改了时间之后
          提醒不会自己跟着挪**：那一刻这排按钮全部熄灭（偏移对不上了），
          等于当场说出「它已经不是提前半小时了」，再点一下就好。想让它跟着
          挪的话，改这一处（照 lib/reschedule.ts 那样按 delta 平移），
          但那会让「我特意挑的那个绝对时刻」也被动过。
          局部 ConfigProvider 压 colorPrimary：antd 的按钮直接读全局
          colorPrimary（群青），而群青是配给制、只标 AI 产出——「选一档提醒」
          是人的动作。跟 FocusStats 补记那排同一个解法。 */}
      {shownChoices.length > 0 && (
        <ConfigProvider theme={boardLocalTheme}>
          <Space wrap size={4}>
            {shownChoices.map((c) => {
              const on = lit.has(choiceKey(c));
              return (
                <Button
                  key={choiceKey(c)}
                  size="small"
                  color="default"
                  variant={on ? 'solid' : 'outlined'}
                  aria-pressed={on}
                  // 再点一次点亮的那颗就把**那一个**提醒删掉，跟优先级按钮同
                  // 一个手势：它是开关，不是单选钮里拔不出来的一格。
                  // **加是加一个，不是换掉现有的**——多个提醒本来就该并存
                  // （「提前一天」加「提前半小时」是最常见的一对）。
                  onClick={() => onChange({ ...value, reminders: togglePreset(value, value.reminders, c) })}
                >{c.label}</Button>
              );
            })}
          </Space>
        </ConfigProvider>
      )}
      {/* 重复规则回答的也是「什么时候」（多久一次），紧跟在日期字段后面，
          不隔着下面这排优先级按钮——自然顺序是「做什么 → 什么时候 → 多重要
          → 归哪儿 → 打什么标签」。见 TaskFields.test.tsx 里那条盯着 DOM
          顺序的断言，别再把新字段动手往末尾一塞。这四组现在包在 <details>
          里，但 DOM 顺序没变，那条断言不用跟着改。 */}
      <details className="ink-more-fields" open={moreOpen}>
        {/* **这一行要跟里面装的东西对得上。** 它写的是「收起来的时候你看不见的
            是哪几样」——列漏了的那几个字段等于在说「这儿没有」，而人会因此去别处
            找，或者以为这个应用没有这个功能。
            已经漏过三个：`waitingFor`、`estimateMinutes` 是加字段时没跟上，
            `context`（情境）是后来加的、同样没跟上。顺序照 DOM 顺序写，加字段
            的时候一眼看得出该插在哪儿。「上级任务」只在真有候选父任务时才渲染
            （`parentOptions` 非空），列着是对的——那是「这一栏里可能有什么」。 */}
        <summary className="ink-more-summary">重复 / 在等谁 / 预计时长 / 优先级 / 情境 / 清单 / 标签 / 上级任务</summary>
        {/* 重复改成「每天」「每周」以外的任何一档（含「不重复」）时，**把「当成
            习惯」一并取消**。（原来只留「每天」——放宽到每周之后这两档都留。）

            不取消的话会卡死：下面那个勾选框只在「每天」时才渲染（理由写在它自己
            那段里），而 `habit` 还是 `true`——这条任务就成了一个**哪儿都不显示、
            又在界面上取消不掉的习惯**（「习惯」那个去处、连续天数、打卡表、日历上
            那个记号全都按 `habit && 每天重复` 认）。唯一的出路是先改回「每天」、
            取消勾选、再改成想要的那一档——没人猜得到。

            静静清掉不会丢任何东西：离开「每天」那一刻，这个标记已经不产生任何
            可观察的效果了。 */}
        <RepeatFields
          value={value.repeat}
          onChange={(r) => onChange({
            ...value,
            repeat: r,
            habit: canBeHabit(r) ? value.habit : false,
          })}
        />
        {/* 在等谁/等什么。空着就是没在等——清空这个框正是「等到了」那一下，
            而在这之前**界面上没有任何地方能清它**。 */}
        <Input
          aria-label="在等谁或等什么"
          placeholder="在等…（比如「张老师回邮件」）"
          value={value.waitingFor ?? ''}
          onChange={(e) => onChange({ ...value, waitingFor: e.target.value.trim() ? e.target.value : null })}
        />

        {/* 当成习惯。**只在「每天」重复时才出现**：习惯那个去处按
            `habit && 每天重复` 认，别的重复档上标了也不会出现在那儿——
            一个勾了没反应的勾选框比没有更糟。勾选框紧跟在重复那一组后面，
            因为它的前提就是那一组刚选出来的东西。
            这个字段以前**界面上根本没有入口**：习惯那个去处、连续天数、月度
            打卡表、日历上的打卡记号整套都在，而唯一能标出一个习惯的办法是手改
            `data/tasks/` 下的 JSON——那一页的空状态还写着「把一条任务标记成
            习惯」，指着一个不存在的开关。 */}
        {canBeHabit(value.repeat) && (
          <label className="ink-habit-toggle">
            <input
              type="checkbox"
              checked={value.habit}
              onChange={(e) => onChange({ ...value, habit: e.target.checked })}
            />
            当成习惯（在「习惯」里看连续天数和打卡表）
          </label>
        )}

        {/* 打算花多久（仿滴答清单的「预计番茄/预计时长」，这里只做后一种——
            一轮的时长本来就可配，用番茄数就得跟着那个设置换算，换一次设置
            历史上所有的估计都跟着变意思。判据和完整理由在 `types.ts` 的
            `estimateMinutes` 上）。收在 <details> 里跟重复/优先级一档：
            多数任务不需要估。 */}
        {/* **叫「预计时长」，跟别处一个名字。** 这一个字段原来在屏幕上有三个
            名字：这儿的 placeholder 是「预计分钟」、aria-label 是「打算花多久
            （分钟）」，而筛选栏那一维、分组档（「按预计时长」）、上面那行
            <summary> 里都叫「预计时长」。同一样东西换个地方换个叫法，人得先认
            出它们是一回事才用得上——而这正是这个应用最不缺的那种成本。
            单位不写进 placeholder：右边 `addonAfter` 已经写着「分钟」了。
            aria-label 保留单位，因为读屏未必会把 addon 跟输入框念在一起。 */}
        <InputNumber
          aria-label="预计时长（分钟）"
          min={1}
          max={24 * 60}
          step={15}
          placeholder="预计时长"
          value={value.estimateMinutes}
          onChange={(v) => onChange({ ...value, estimateMinutes: v ?? null })}
          addonAfter="分钟"
        />
        <Space wrap size={4}>
          {PRIORITIES.map((p) => (
            <button
              key={p.v}
              type="button"
              className={`ink-pri-btn ink-pri-${p.v}`}
              aria-pressed={value.priority === p.v}
              // 再点一次当前档位就清回 0
              onClick={() => onChange({ ...value, priority: value.priority === p.v ? 0 : p.v })}
            >
              <span className="ink-pri-flag-glyph" aria-hidden="true">⚑</span>
              {p.label}
            </button>
          ))}
        </Space>
        {/* 情境（GTD）。摆在优先级和清单之间：一条任务的自然顺序是「做什么 →
            什么时候 → 多重要 → **什么条件下干得了** → 归哪儿 → 打什么标签 →
            是谁的一步」。它跟优先级答的是两个不同的问题，正因如此才挨着摆：
            「最重要的那条」和「我现在能干的那条」经常不是同一条，这是这个
            字段存在的全部理由。
            跟清单那个下拉同一种控件（原生 <select>）——同一排里两个长得不一样
            的下拉，人会以为它们的行为也不一样。 */}
        <select
          className="ink-list-select"
          aria-label="什么条件下能做"
          value={value.context ?? ''}
          onChange={(e) => onChange({ ...value, context: (e.target.value || null) as TaskContext | null })}
        >
          <option value="">不分情境</option>
          {CONTEXTS.map((c) => <option key={c} value={c}>{CONTEXT_LABEL[c]}</option>)}
        </select>
        {/* 原生 <select>，不用 antd 的 Select——这里不需要搜索/多选/远程加载，
            原生的可访问性判定更简单，测试用 fireEvent.change 直接可驱动。
            一条清单都没有时也不藏起来：只留「不属于任何清单」一项，藏掉的话
            用户永远不知道有清单这回事。空字符串是「不属于任何清单」，写回
            null——服务端和 AI 契约里这个字段的「没有」一律是 null，不是 ''。 */}
        <select
          className="ink-list-select"
          aria-label="归到哪个清单"
          value={value.listId ?? ''}
          onChange={(e) => onChange({ ...value, listId: e.target.value || null })}
        >
          <option value="">不属于任何清单</option>
          {/* 归档的清单不进候选——除非这条任务当下就归在它名下：不留这个例外，
              打开一条挂在已归档清单上的任务，下拉框会显示「不属于任何清单」，
              跟旁边卡片上照样画着的竖条/清单名自相矛盾（卡片端 TaskCard 的
              lists.find() 不看 archived）。不动这个下拉就保存，draft.listId
              原样是那个归档清单的 id，数据不丢，只是界面在说谎——这里补上。

              智能清单（filter 非 null）不进候选，没有这个例外：它是一份存下来
              的查询，不是容器，把 listId 指到它上面没有意义——那条任务不会
              因此出现在这份智能清单里（按 applyFilter 取任务，不看 listId，见
              scoped.ts 顶部注释），反而会在导航里哪儿都找不到，见
              task-4-brief 要点③。跟 BatchBar.tsx「改清单」下拉、FilterBar.tsx
              「清单」那一维同一条规矩。 */}
          {fileableLists(lists, value.listId).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        {/* 分段。**紧跟在清单下拉后面**：段名只在它所属的那份清单里有意义，
            两个控件是同一个坐标的两半，隔开摆会让人以为分段是全局的。

            **一个带候选的自由输入框，不是下拉**：这个应用里分段没有实体
            （见 `types.ts` 的 `section`），已有的段名是从任务上现算出来的，
            所以「选一个已有的」和「起一个新的」是同一个动作——`<datalist>`
            正好表达这件事，而下拉表达不了后者。跟标签那一栏同一个道理。

            清空 = 不在任何分段里。服务端把空串归 null（`task.ts`），不然会
            冒出一个名字为空的分段。 */}
        <input
          className="ink-list-select"
          aria-label="分段"
          placeholder="分段（选填）"
          list="ink-section-options"
          value={value.section ?? ''}
          onChange={(e) => onChange({ ...value, section: e.target.value || null })}
        />
        <datalist id="ink-section-options">
          {sectionOptions.map((s) => <option key={s} value={s} />)}
        </datalist>
        {/* 上级任务（多级任务，仿滴答清单「关联主任务」）。摆在标签后面：
            自然顺序是「做什么 → 什么时候 → 多重要 → 归哪儿 → 打什么标签 →
            是谁的一步」，层级是最外层的归属，放最后。
            当前值指向的那条不在候选里（它已完成、或者候选表是按别的任务算的）
            时也要能显示出来，不然打开一条已经挂好的子任务会看到「不属于任何
            任务」，跟卡片上画着的「↳ 属于……」自相矛盾——跟清单下拉那条
            「归档的清单不进候选，除非这条任务当下就归在它名下」同一个例外。 */}
        {parentOptions && parentOptions.length > 0 && (
          <select
            className="ink-list-select"
            aria-label="上级任务"
            value={value.parentId ?? ''}
            onChange={(e) => onChange({ ...value, parentId: e.target.value || null })}
          >
            <option value="">不是谁的子任务</option>
            {parentOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        )}
        <div className="ink-tag-row">
          {value.tags.map((t) => (
            <span className="ink-tag-chip" key={t}>
              {t}
              <button
                type="button"
                className="ink-tag-x"
                aria-label={`删掉标签 ${t}`}
                onClick={() => onChange({ ...value, tags: value.tags.filter((x) => x !== t) })}
              >×</button>
            </span>
          ))}
          <input
            className="ink-tag-input"
            aria-label="加标签"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const name = tagDraft.trim();
              // 空的不加、重复的不加。服务端现在也会做同一套清洗（去首尾空白、
              // 丢空串、去重，见 server/src/task.ts 的 sanitizeTaskPatch）——
              // 这一层没有因此变得多余：挡在 onChange 之前，用户不会先看到一个
              // 空标签胶囊在界面上闪一下，保存那一刻才被服务端悄悄清掉。
              if (!name || value.tags.includes(name)) { setTagDraft(''); return; }
              onChange({ ...value, tags: [...value.tags, name] });
              setTagDraft('');
            }}
          />
        </div>
      </details>
    </>
  );
}
