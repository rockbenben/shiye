import { useState, type ReactNode } from 'react';
import { Button, ConfigProvider, DatePicker, Input, InputNumber, Space } from 'antd';
import dayjs from 'dayjs';
import type { List, Reminder, Repeat, TaskContext } from '../types.js';
import { CONTEXT_LABEL, CONTEXTS } from '../lib/taskView.js';
import { canBeHabit } from '../lib/habit.js';
import { describeRepeat, RepeatFields } from './RepeatFields.js';
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
 * **它不是「比低还低的一档」**，是「这条还没被排过」——所以排在最后，不在 3/2/1
 * 的顺序里插队。那一档说全了叫 `PRI_FULL_LABEL[0]`（「没定优先级」，住在
 * `lib/taskView.ts`，组头和四象限那一格读它）；**这儿故意用短的那个字**：这是
 * 四选一里的一个选项，跟 高/中/低 并排，要的是宽度一致，不是一句说明。
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
  /**
   * 「按现在这句话建出来会长什么样」。**只用来显示行上那个值**，编辑器一律还是
   * `value`。为什么：识别是「只认，不改」（见 TaskComposer 上面那段），草稿里
   * 那个字段真的还是空的；可屏幕上因此同时站着两个日期，而按「添加」生效的是
   * 没写出来的那一个。现在行显示合并后的那份并挂一颗「识别」，点开编辑器看见
   * 的是空——两边都是真话，各说各的那一半。
   */
  smartPreview?: TaskDraft;
  /** 新建表单一展开就把光标放进标题框；卡片编辑态不要——那会把页面滚到那张卡。 */
  autoFocusTitle?: boolean;
  /** 归到哪个清单的候选项。必填不是疏忽——四条接线（TaskCard 的编辑态、
   * TaskComposer、以及它们各自的容器）漏掉任何一条都该在编译期报错，不能
   * 悄悄传个空数组把下拉框变成只剩「清单 无」一项。 */
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
   * **这条任务已经响过的提醒**（`Task.reminders` 那份带 `firedAt` 的）。
   *
   * ## 为什么单独传，而不在草稿里带
   *
   * `TaskDraft.reminders` 是 `string[]`——只有时刻，**没有 `firedAt`**。这不是
   * 漏了，是对的：草稿是「正在写的东西」，而 `firedAt` 是**服务端盖的章**（发完
   * 提醒之后写上去的，`reminder.ts` 里盖章排在发送之前，失败也盖，为了不让它
   * 三十秒重播）。让一份草稿去携带别人的章，等于允许编辑过程中改掉它。
   *
   * 所以显示用、编辑不用，两份分开走：草稿照样是 `string[]`，这一份**只读**。
   *
   * ## 不给就不画
   *
   * 新建任务时（`TaskComposer`）压根没有响过的东西，传不传都是空；可选而不是必填，
   * 就是为了让那一条不用凭空造一份。
   *
   * ## 为什么值得单做这一处
   *
   * 在这之前 `firedAt` **全仓库零处渲染**——只存在于类型定义和构造 patch 的地方。
   * 于是关掉提醒横幅之后（那个 × 只摘横幅、一字节不改数据），**没有任何地方能
   * 回答「这条到底响过没有」**，而「响过没有」正是他决定改期、还是干脆删掉这个提醒
   * 的唯一依据。滴答那边有提醒历史。
   */
  fired?: Reminder[];
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

/**
 * 折叠区里那九个「可选属性」的名单、值判据和芯片文案。
 *
 * **一份名单，三个读者**：折叠行上的芯片、芯片上那句值、以及「默认开不开折叠区」。
 * 以前 summary 那行手抄八个名字，加字段时漏过三次（`waitingFor`、`estimateMinutes`、
 * `context` 各一次，见它上面那段注释）——从这份名单派生就飘不了。
 */
export type DraftAttr =
  | 'repeat' | 'waitingFor' | 'estimate' | 'priority' | 'context' | 'list' | 'section' | 'tags' | 'parent';

export const ATTR_NAME: Record<DraftAttr, string> = {
  repeat: '重复',
  waitingFor: '在等谁',
  estimate: '预计时长',
  priority: '优先级',
  context: '情境',
  list: '清单',
  section: '分段',
  tags: '标签',
  parent: '上级任务',
};

/**
 * 「＋ 加一项」菜单的分法，也是属性行的默认摆法（`ATTR_ORDER` 由它摊平）。
 *
 * 分三组，按**这一维回答的是哪个问题**，不按控件长得像不像：
 * - 节奏：这件事多久一次、要花多久——都是「时间上的形状」。
 * - 归属：它放在哪儿——清单、清单里的分段、挂在哪条任务下面。这三个是同一
 *   件事的三层容器，原来散在菜单两头，人在「清单」那儿分完段还得回头找。
 * - 标记：多重要、什么条件下干得了、在等谁、贴什么标签——都不挪动它的位置，
 *   只是给它挂上说法。
 *
 * 原来这九颗是一条不分段的横排（`Space wrap`），读起来是一堆同级的词，
 * 而其中「清单 / 分段 / 上级任务」明显是一伙的——分组的代价是零（不加东西，
 * 只加三个小标题），换来的是找某一维的时候先看的是类别而不是逐个字。
 */
const ATTR_GROUPS: Array<{ cap: string; keys: DraftAttr[] }> = [
  { cap: '节奏', keys: ['repeat', 'estimate'] },
  { cap: '归属', keys: ['list', 'section', 'parent'] },
  { cap: '标记', keys: ['priority', 'context', 'waitingFor', 'tags'] },
];

const ATTR_ORDER: DraftAttr[] = ATTR_GROUPS.flatMap((g) => g.keys);

/** 哪些属性**此刻有值**。芯片带和「默认开不开折叠区」共用这一份。 */
export const filledAttrs = (v: TaskDraft): Set<DraftAttr> => {
  const out = new Set<DraftAttr>();
  if (v.repeat) out.add('repeat');
  if (v.waitingFor) out.add('waitingFor');
  if (typeof v.estimateMinutes === 'number') out.add('estimate');
  if (v.priority > 0) out.add('priority');
  if (v.context) out.add('context');
  if (v.listId) out.add('list');
  if (v.section) out.add('section');
  if (v.tags.length > 0) out.add('tags');
  if (v.parentId) out.add('parent');
  return out;
};

/** 芯片上那句值。**只读展示**，不是第八个控件——点它只会展开折叠区，编辑还在
 *  原来的控件上。名字交给 `ATTR_NAME`，这里只出值。 */
const attrValue = (
  v: TaskDraft,
  k: DraftAttr,
  lists: List[],
  parentOptions: Array<{ id: string; title: string }>,
): string => {
  switch (k) {
    case 'repeat': return v.repeat ? describeRepeat(v.repeat) : '';
    case 'waitingFor': return v.waitingFor ?? '';
    case 'estimate': return `${v.estimateMinutes} 分钟`;
    case 'priority': return PRIORITIES.find((x) => x.v === v.priority)?.label ?? '';
    case 'context': return v.context ? CONTEXT_LABEL[v.context] : '';
    case 'list': return lists.find((l) => l.id === v.listId)?.name ?? '';
    case 'section': return v.section ?? '';
    case 'tags': return v.tags.map((t) => `#${t}`).join(' ');
    case 'parent': return parentOptions.find((o) => o.id === v.parentId)?.title ?? '';
  }
};

/**
 * 一行属性：`名字 ── 当前值 ›`，点一下就地展开那一维的编辑器。
 *
 * 这是参照三家共同的那条形状（滴答「点击详情页上方的『清单』」、Todoist 图标条
 * 上每颗图标开一个小弹层、Things 的 inspector bar），取代原来那种「每个字段各画
 * 一个框、宽度还各不相同」的摆法——一屏 21 颗按钮 12 个输入框 5 个下拉 4 个日期
 * 框，读起来是一堆控件，不是一张表。
 *
 * **名字左边那一列图标没了**（batch9 I-3）。原来十行里五行的图标是彩色 emoji
 * （📅  📍  🏷），五行是单色字形（⚑ ▤ ↳ ⏱ ）——一列里两种记号语言，
 * 而彩色 emoji 是从系统字体借来的，换台机器就换一张脸，跟这一身墨不是一回事。
 * 更糟的是同一件事在三个地方两个记号：「重复」卡片上画 ↻、行档和这里画 🔁。
 * 每行本来就写着名字，图标是装饰——去掉它，两种语言的问题一次没有，左边线也
 * 只剩一条（原来名字缩进 26px、输入框缩进 0，看着像两栏没对齐）。
 * 剩下「＋ 加一项」那一行，那个 ＋ 是**动作**不是记号，跟着名字走（写在名字里）。
 *
 * **编辑器内容用 `hidden` 收，不是不渲染。** 跟这个文件里那个 `<details>` 一样：
 * jsdom 不实现「关闭的 details 隐藏子节点」，所以按 label 查控件的测试不管开没开
 * 都找得到（见 TaskFields.test.tsx 里那段说明）。这里跟着同一条约定，不另造一套
 * 「测试要先点开才能查」的仪式。
 */
function FieldRow({ name, value, smart, open, onToggle, children }: {
  name: string;
  /** 当前值；空串表示没设——那时显示一句「点这里能设什么」。 */
  value: string;
  /**
   * 这一行显示的是**从标题里认出来的**值，不是草稿里已经填上的值。
   *
   * 为什么要有这颗标：屏幕上不能同时有两个值而只有一个有记号。原来日期那一行
   * 写着「截止 10月5日 23:59」（设置里的预填），下面提示条写着「识别到 明天
   * 下午三点」，而按「添加」之后真的落的是后者——行上那个值从头到尾没动过，
   * 因为它动的是**草稿**，识别只动**提交那一刻合并出来的东西**（「只认，不改」，
   * 见 TaskComposer 上面那段）。现在行显示合并后的那份，加这颗标说明它还不是
   * 你挑的：点开编辑器，里面仍是空的。
   */
  smart?: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ink-frow-wrap">
      <button
        type="button"
        className="ink-frow"
        aria-expanded={open}
        // 没设的时候别念「未设置」——那是一句只有坏消息的话，人不知道点开有什么。
        // 认出来的那种情况连「未设置」都不说：那一行有值，只是那值是标题里来的。
        aria-label={
          smart ? `${name}：${value}（从标题里认出来的）`
            : value ? `${name}：${value}` : `${name}（未设置，点开可选）`
        }
        onClick={onToggle}
      >
        <span className="ink-frow-nm">{name}</span>
        <span className={value ? 'ink-frow-val' : 'ink-frow-val ink-frow-val-none'}>
          {value || '未设置'}
        </span>
        {smart && <span className="ink-frow-smart" aria-hidden="true">识别</span>}
        <span className="ink-frow-chev" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {/* 收起来靠 class，不用 `hidden` 属性：jsdom 不跑样式表但认 `hidden`，
          用了它 `getByRole` 会把整块编辑器当不可达跳过——跟这个文件里那个
          `<details>` 是同一条约定（关闭的 details 在 jsdom 里照样查得到）。 */}
      <div className={`ink-frow-editor${open ? '' : ' ink-frow-editor-closed'}`}>{children}</div>
    </div>
  );
}

/** 那一行右边写的当前值。**跟卡片查看态同一套词**（「截止 今天 11:00」），
 *  所以填的时候和看的时候是同一种读法。没设的段不写，不写「无」。 */
const dateSummary = (v: TaskDraft): string => {
  const f = (iso: string) => dayjs(iso).format('M月D日 HH:mm');
  const parts: string[] = [];
  if (v.startAt) parts.push(`${f(v.startAt)} 开始`);
  if (v.endAt) parts.push(`→ ${f(v.endAt)}`);
  if (v.due) parts.push(`截止 ${f(v.due)}`);
  if (v.reminders.length > 0) parts.push(`提醒 ${v.reminders.length} 次`);
  return parts.join(' · ');
};

/**
 * 一颗 chip 上那句截止。**跟上面那套词同源，只是短一档**：chip 只有几个字的
 * 宽度，「截止」是多余的（那颗 chip 本来就写着日期），而 `00:00` 必须省——
 * 这个应用表达「全天」的方式就是本地零点（见 `calendar.ts` 的 `isAllDay`），
 * 把它印成「明天 00:00」看着像一条填错了的时刻，不像一个整天。
 */
export const dueChipText = (iso: string, now: Date): string => {
  const d = dayjs(iso);
  const time = d.hour() === 0 && d.minute() === 0 ? '' : ` ${d.format('HH:mm')}`;
  const sameYear = d.year() === now.getFullYear();
  return `${sameYear ? '' : d.format('YYYY年')}${d.format('M月D日')}${time}`;
};

/**
 * 日期那一行里的快捷档。**只说哪天，不发明时刻**：点了之后时分照原来那条
 * 保留，原来没有时间就落「全天」（本地零点——这个应用没有独立的 allDay 字段，
 * 「时分秒毫秒全为 0」就是它表达全天的方式，见 `calendar.ts` 的 `isAllDay`）。
 * 原来只有原生日历，选「明天」要点开日历再点格子，而这是这一栏最高频的动作。
 */
/** 那条截止时间是不是落在快捷档说的哪一天（按本地日号比，不比时刻）。 */
const isSameLocalDay = (iso: string | null, d: Date): boolean => {
  if (!iso) return false;
  const x = new Date(iso);
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
};

/**
 * 那三颗快捷档。**「添加任务」那一行上的日期 chip 也读这一份**（`QuickAdd`），
 * 两处各列一套「今天/明天/本周五」的话，改一处另一处不会有人想起来。
 */
export const quickDayChips = (now: Date): Array<{ label: string; date: Date }> => {
  const at = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return d;
  };
  // 「本周五」= 今天起最近的周五（今天就是周五就用今天），跟「接下来」那一屏
  // 说「这周五」的口径一致。
  const fri = at((5 - now.getDay() + 7) % 7);
  return [
    { label: '今天', date: at(0) },
    { label: '明天', date: at(1) },
    { label: '本周五', date: fri },
  ];
};

export function TaskFields({ value, onChange, smartPreview, autoFocusTitle, lists, parentOptions, sectionOptions = [], fired, onSubmit, onCancel }: Props) {
  /** 行上显示的那份值看的是合并后的草稿（没传就是 `value` 本身）。 */
  const shownDraft = smartPreview ?? value;
  /** 这一维显示的东西跟草稿不一样 = 它是从标题里认出来的。 */
  const fromSmart = (k: keyof TaskDraft): boolean =>
    !!smartPreview && smartPreview[k] !== value[k];
  // 哪几档预设是点亮的。**可能不止一颗**——一条任务可以有多个提醒。
  const lit = activePresets(value, value.reminders);
  /** 这条任务上真的算得出时刻的那几档——算不出的不摆按钮，见下面那段注释。 */
  const shownChoices = REMIND_CHOICES.filter((c) => choiceToRemindAt(value, c) !== null);

  const [tagDraft, setTagDraft] = useState('');
  /**
   * 哪些属性**上过屏**：挂载时这条任务本来带着的那些，加上后来从「＋ 加一项」里
   * 请出来的。一格一行（`FieldRow`），没上屏的不渲染——原来一个 `<details>` 展开
   * 就把九个字段全倒出来，摊开是 12 个控件（选了「每周」之后 21 个），而多数任务
   * 用不到其中六个（measure-ui.mjs 量出来的数字，见 2026-08-17-debt-sweep #6）。
   *
   * **只增不减**：清空一个字段的值不该让那一格当场消失。人正在改它，控件从手指
   * 底下被抽走是最恶心的一种反馈——实测过：把预填的清单改回「无」，那一格整个没
   * 了，第二次想改回来已经找不到入口。
   *
   * 也**只在挂载那一刻算一次**，不是每次渲染都从 `value` 重算。原来那个
   * `<details open>` 就为这件事栽过：`open` 不在 React「受控表单元素」那个特殊
   * 名单里（不像 input 的 value/checked），每次渲染都传一个跟着 value 变的新布尔
   * 值，用户把某个字段改回默认值（优先级点两下清回 0）那一刻它就会变化，面板在
   * 人眼前收起来。这里同一份道理。
   *
   * 判据从 `filledAttrs` 派生，不手抄条件：原来那行写了五个条件
   * （priority/tags/list/repeat/parent），漏了 `waitingFor`、`estimateMinutes`、
   * `context`、`section`——打开一条只在「在等谁」上写了话的任务，那栏是藏着的，
   * 屏幕上没有任何地方说得出「这条任务在等张老师」。
   */
  const [added, setAdded] = useState<DraftAttr[]>(() => [...filledAttrs(value)]);
  const shown = new Set<DraftAttr>(added);
  const missing = ATTR_ORDER.filter((k) => !shown.has(k));
  /** 哪一格正开着编辑器。**手风琴**：开一格关别的，屏幕上不会同时摞出两堆控件。 */
  const [openRow, setOpenRow] = useState<DraftAttr | 'date' | null>(null);
  /** 「＋ 加一项」那个菜单开没开。跟 `openRow` 分开：它不是一条属性。 */
  const [addingOpen, setAddingOpen] = useState(false);
  const toggleRow = (k: DraftAttr | 'date') => {
    setAddingOpen(false);
    setOpenRow((prev) => (prev === k ? null : k));
  };
  return (
    <>
      <Input
        className="ink-field-bare"
        // 这个框的名字。占位符「标题」在它空着的时候写在脸上，但那是「提示你写
        // 什么」不是「你是谁」——一落笔就没了，而读屏每次焦点进来都要念得出这是
        // 哪一格。跟随手记那个框同一条修法（见 design-preview 探针的 `accName`）。
        aria-label="标题"
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
      <FieldRow
        name="日期"
        value={dateSummary(shownDraft)}
        smart={fromSmart('due') || fromSmart('startAt') || fromSmart('endAt') || fromSmart('reminders')}
        open={openRow === 'date'}
        onToggle={() => toggleRow('date')}
      >
        <Space wrap size={4} style={{ marginBottom: 6 }}>
          {quickDayChips(new Date()).map((c) => (
            <Button
              key={c.label}
              size="small"
              color="default"
              variant={isSameLocalDay(value.due, c.date) ? 'solid' : 'outlined'}
              aria-pressed={isSameLocalDay(value.due, c.date)}
              // 保留已经填好的时分；原来没有时间就落「全天」（本地零点）。
              onClick={() => {
                const cur = value.due ? dayjs(value.due) : null;
                const d = new Date(c.date.getFullYear(), c.date.getMonth(), c.date.getDate(),
                  cur ? cur.hour() : 0, cur ? cur.minute() : 0);
                onChange({ ...value, due: d.toISOString() });
              }}
            >{c.label}</Button>
          ))}
        </Space>
      <Space direction="vertical" size={6} style={{ display: 'flex' }}>
        {/* **开始时间摆在截止时间前面**：先「什么时候能动手」再「什么时候之前
            得做完」，跟人排一件事的顺序一致。
            一个说「在这之前别烦我」，一个说「什么时候之前要做完」——两个都
            可选，都不填就是加这个字段之前的行为（随时可以做、也不催）。
            **不校验「开始晚于截止」**：那是一句自相矛盾的话，但它是用户的话，
            当场拒掉会让那一次编辑整个失败（两个控件，改哪个都可能短暂地不
            自洽）。理由整段在 server/src/task.ts 那处校验旁边。
            每根时间框左边一颗常驻小标签（11px 等宽，跟查看态「截止 9月30日」
            同一套词）。placeholder 不能当唯一的标签：一填值它就没了，三根
            一模一样的框并排站着，谁也说不清哪根是截止哪根是提醒。包一层
            <label> 顺带把标签和输入框绑上（点标签聚焦框、读屏念出名字），
            placeholder 留着——空框时它比标签多一句「填什么形状的话」。 */}
        <label className="ink-field-row">
          <span className="ink-field-cap">开始</span>
          <DatePicker
            showTime={{ format: TIME_FORMAT }}
            format={DATETIME_FORMAT}
            allowClear
            aria-label="开始时间"
            placeholder="开始时间"
            value={value.startAt ? dayjs(value.startAt) : null}
            onChange={(d) => onChange({ ...value, startAt: d ? d.toISOString() : null })}
          />
        </label>
        {/* **结束时间只在填了开始时间之后才出现**（滴答清单的「时间段」）。
            一个没有起点的「结束时间」在这个应用里说不出任何意思——`endAt`
            单独存在时日历不认它（`calendarAnchor` 要两个都在），一个改了没
            任何效果的控件比不显示它糟。

            **不校验「结束早于开始」**，跟旁边「开始晚于截止」同一条既有约定：
            那是一句自相矛盾的话，但它是用户的话，两个控件改哪个都可能短暂地
            不自洽，当场拒掉会让那一次编辑整个失败。日历那边按「没有时间段」
            处理，不画一个负高度的块。 */}
        {value.startAt && (
          <label className="ink-field-row">
            <span className="ink-field-cap">结束</span>
            <DatePicker
              showTime={{ format: TIME_FORMAT }}
              format={DATETIME_FORMAT}
              allowClear
              aria-label="结束时间"
              placeholder="结束时间"
              value={value.endAt ? dayjs(value.endAt) : null}
              onChange={(d) => onChange({ ...value, endAt: d ? d.toISOString() : null })}
            />
          </label>
        )}
        <label className="ink-field-row">
          <span className="ink-field-cap">截止</span>
          <DatePicker
            showTime={{ format: TIME_FORMAT }}
            format={DATETIME_FORMAT}
            allowClear
            aria-label="截止时间"
            placeholder="截止时间"
            value={value.due ? dayjs(value.due) : null}
            onChange={(d) => onChange({ ...value, due: d ? d.toISOString() : null })}
          />
        </label>
        {/* **一条任务可以有多个提醒**：一个一个 DatePicker 摆出来，清空
            某一个就是删掉它（antd 的 allowClear 已经是这个手势，不另加
            一颗 ×），末尾永远留一个空的用来加下一个。
            不做「加一个提醒」按钮：那要多按一下才看得到输入框，而一个空的
            选择器本身就是那颗按钮，还顺带说明了要填的是什么。 */}
        {[...value.reminders, ''].map((at, i) => {
          // 这个时刻响过没有。**只在还认得出那条 `Reminder` 时才算**——草稿里的
          // 时刻被改过就匹配不上（那是另一条提醒了，或者根本没响过），匹配不上
          // 就安静地不画，不报「状态异常」。
          const firedAt = at ? fired?.find((r) => r?.at === at)?.firedAt : null;
          return (
          <label className="ink-field-row" key={`${i}-${at}`}>
            <span className="ink-field-cap">提醒</span>
            <DatePicker
              showTime={{ format: TIME_FORMAT }}
              format={DATETIME_FORMAT}
              allowClear
              aria-label={i === 0 ? '提醒时间' : `第 ${i + 1} 个提醒时间`}
              placeholder={i === 0 ? '提醒时间' : '再提醒一次'}
              value={at ? dayjs(at) : null}
              onChange={(d) => onChange({ ...value, reminders: setNthReminder(value.reminders, i, d ? d.toISOString() : null) })}
            />
            {/* **响过了就说出来。** 只说事实不说时间——时刻就在左边那个框里，
                再说一遍是重复；「响过没有」是这里唯一缺的那半个信息。
                用 quiet 这一档：它是一条已经发生的事，不是待办，也不是警告。 */}
            {firedAt && <span className="ink-field-note">已提醒</span>}
          </label>
          );
        })}
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
          {shownChoices.length > 0 ? (
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
          ) : (
            /* 算不出锚点时整排消失 —— **但不能就这么没了**。
             *
             * 原来这里是 `{shownChoices.length > 0 && …}`：什么时间都没填时，「提前
             * 多久」那六颗连同「结束时」一起从界面上消失，一个字都不留。而这一排
             * 恰恰是滴答那边整个提醒界面的主体（那边整排就是预设，绝对时间反而是
             * 次要入口）。于是在一条只有提醒、没有截止时间的任务上打开编辑表单，
             * 看到的是「提醒时间」框 + 下面什么都没有——**跟「提醒坏了」长得一模
             * 一样**。
             *
             * **不编一个兜底锚点**：提前多久是「相对某个时刻往前推」，没有那个
             * 时刻这句话就没有主语，编一个（拿创建时间？拿今天？）是在替人选一个他
             * 没选过的参照物。跟 `aiReady.ts` 里 cli 模式一律放行同一条原则：拿不
             * 确定的判据去编一个确定的动作，比老实说「这个现在没有参照物」更坏。
             *
             * 所以这一档**说清楚为什么没有**，并指出补上哪一格就行。 */
            <p className="ink-field-note">「提前多久」要有参照物才点得出来——先在上面填一个截止时间或时间段。</p>
          )}
      </FieldRow>
      {/* 剩下的属性一格一行，**只渲染已经上过屏的**（这条任务本来带着的，加上
          这一次从「＋ 加一项」里请出来的）。原来这里是 `<details>` 一展开就把
          九个字段全倒出来——空表单里也有 49 个可交互控件，而多数任务用不到其中
          六个。参照滴答/Todoist/Things：默认露出的字段不超过 5 个，没填的不占地方。
          顺序照 DOM 走：什么时候 → 多重要 → 什么条件下干得了 → 归哪儿 → 打什么
          标签 → 是谁的一步。TaskFields.test.tsx 里有一条盯着这个顺序的断言。 */}
      {shown.has('repeat') && (
        <FieldRow
          name={ATTR_NAME.repeat}
          value={attrValue(shownDraft, 'repeat', lists, parentOptions ?? [])}
          smart={fromSmart('repeat')}
          open={openRow === 'repeat'}
          onToggle={() => toggleRow('repeat')}
        >
          {/* 重复改成「每天」「每周」以外的任何一档（含「不重复」）时，**把「当成
              习惯」一并取消**。不取消的话会卡死：下面那个勾选框只在「每天/每周」时
              才渲染，而 `habit` 还是 `true`——这条任务就成了一个**哪儿都不显示、
              又在界面上取消不掉的习惯**。唯一的出路是先改回「每天」、取消勾选、
              再改成想要的那一档——没人猜得到。静静清掉不会丢任何东西。 */}
          <RepeatFields
            value={value.repeat}
            onChange={(r) => onChange({
              ...value,
              repeat: r,
              habit: canBeHabit(r) ? value.habit : false,
            })}
          />
          {/* 当成习惯。**只在「每天」「每周」时才出现**（习惯那个去处按
              `habit && 会重复` 认，别的重复档上标了也不会出现在那儿——一个勾了
              没反应的勾选框比没有更糟）。**它住在「重复」这一格里**：前提就是
              这一格刚选出来的东西，拆开摆会让人找不到它为什么在/为什么不在。
              这个字段以前**界面上根本没有入口**：习惯那个去处、连续天数、月度
              打卡表、日历上的打卡记号整套都在，而唯一能标出一个习惯的办法是手改
              `data/tasks/` 下的 JSON。 */}
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
        </FieldRow>
      )}
      {shown.has('waitingFor') && (
        <FieldRow
          name={ATTR_NAME.waitingFor}
          value={attrValue(value, 'waitingFor', lists, parentOptions ?? [])}
          open={openRow === 'waitingFor'}
          onToggle={() => toggleRow('waitingFor')}
        >
          {/* 在等谁/等什么。空着就是没在等——清空这个框正是「等到了」那一下，
              而在这之前**界面上没有任何地方能清它**。 */}
          <Input
            aria-label="在等谁或等什么"
            placeholder="在等…（比如「张老师回邮件」）"
            value={value.waitingFor ?? ''}
            onChange={(e) => onChange({ ...value, waitingFor: e.target.value.trim() ? e.target.value : null })}
          />
        </FieldRow>
      )}
      {shown.has('estimate') && (
        <FieldRow
          name={ATTR_NAME.estimate}
          value={attrValue(value, 'estimate', lists, parentOptions ?? [])}
          open={openRow === 'estimate'}
          onToggle={() => toggleRow('estimate')}
        >
          {/* 打算花多久（仿滴答清单的「预计番茄/预计时长」，这里只做后一种——
              一轮的时长本来就可配，用番茄数就得跟着那个设置换算，换一次设置
              历史上所有的估计都跟着变意思。判据和完整理由在 `types.ts` 的
              `estimateMinutes` 上）。
              **叫「预计时长」，跟别处一个名字。** 这一个字段原来在屏幕上有三个
              名字：placeholder 是「预计分钟」、aria-label 是「打算花多久（分钟）」，
              而筛选栏那一维、分组档（「按预计时长」）都叫「预计时长」。同一样东西
              换个地方换个叫法，人得先认出它们是一回事才用得上。
              单位不写进 placeholder：右边 `addonAfter` 已经写着「分钟」了。
              aria-label 保留单位，因为读屏未必会把 addon 跟输入框念在一起。 */}
          <InputNumber
            // 加减那两颗箭头：这套主题下量出来是 **1×15px**（外层宽 0、`opacity: 0`，
            // 悬停才展开），鼠标基本够不着；它们的 `aria-label` 还是写死的英文
            // （`Increase Value` / `Decrease Value`，antd 的 locale 覆盖不到）。
            // 这一格填一个分钟数，打字本来就最快，少了不损失任何操作。
            controls={false}
            aria-label="预计时长（分钟）"
            min={1}
            max={24 * 60}
            step={15}
            placeholder="预计时长"
            value={value.estimateMinutes}
            onChange={(v) => onChange({ ...value, estimateMinutes: v ?? null })}
            addonAfter="分钟"
          />
        </FieldRow>
      )}
      {shown.has('priority') && (
        <FieldRow
          name={ATTR_NAME.priority}
          value={attrValue(value, 'priority', lists, parentOptions ?? [])}
          open={openRow === 'priority'}
          onToggle={() => toggleRow('priority')}
        >
          <Space wrap size={4}>
            {PRIORITIES.map((pr) => (
              <button
                key={pr.v}
                type="button"
                className={`ink-pri-btn ink-pri-${pr.v}`}
                aria-pressed={value.priority === pr.v}
                // 再点一次当前档位就清回 0
                onClick={() => onChange({ ...value, priority: value.priority === pr.v ? 0 : pr.v })}
              >
                <span className="ink-pri-flag-glyph" aria-hidden="true">⚑</span>
                {pr.label}
              </button>
            ))}
          </Space>
        </FieldRow>
      )}
      {shown.has('context') && (
        <FieldRow
          name={ATTR_NAME.context}
          value={attrValue(shownDraft, 'context', lists, parentOptions ?? [])}
          smart={fromSmart('context')}
          open={openRow === 'context'}
          onToggle={() => toggleRow('context')}
        >
          {/* 情境（GTD）。它跟优先级答的是两个不同的问题：「最重要的那条」和
              「我现在能干的那条」经常不是同一条，这是这个字段存在的全部理由。
              原生 <select>，跟清单那一格同一种控件。 */}
          <select
            className="ink-list-select"
            aria-label="什么条件下能做"
            value={value.context ?? ''}
            onChange={(e) => onChange({ ...value, context: (e.target.value || null) as TaskContext | null })}
          >
            <option value="">不限</option>
            {CONTEXTS.map((c) => <option key={c} value={c}>{CONTEXT_LABEL[c]}</option>)}
          </select>
        </FieldRow>
      )}
      {shown.has('list') && (
        <FieldRow
          name={ATTR_NAME.list}
          value={attrValue(shownDraft, 'list', lists, parentOptions ?? [])}
          smart={fromSmart('listId')}
          open={openRow === 'list'}
          onToggle={() => toggleRow('list')}
        >
          {/* 原生 <select>，不用 antd 的 Select——这里不需要搜索/多选/远程加载，
              原生的可访问性判定更简单，测试用 fireEvent.change 直接可驱动。
              一条清单都没有时也不藏起来：只留「无」那一项（这一格左边写着
              「清单」，空值可以短到一个字），藏掉的话用户永远不知道有清单这回事。
              空字符串写回 null——服务端和 AI 契约里这个字段的「没有」一律是 null。 */}
          <select
            className="ink-list-select"
            aria-label="归到哪个清单"
            value={value.listId ?? ''}
            onChange={(e) => onChange({ ...value, listId: e.target.value || null })}
          >
            <option value="">无</option>
            {/* 归档的清单不进候选——除非这条任务当下就归在它名下：不留这个例外，
                打开一条挂在已归档清单上的任务，下拉框会显示「无」，跟旁边卡片上
                照样画着的竖条/清单名自相矛盾。智能清单（filter 非 null）不进候选，
                没有这个例外——见 task-4-brief 要点③。 */}
            {fileableLists(lists, value.listId).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </FieldRow>
      )}
      {shown.has('section') && (
        <FieldRow
          name={ATTR_NAME.section}
          value={attrValue(value, 'section', lists, parentOptions ?? [])}
          open={openRow === 'section'}
          onToggle={() => toggleRow('section')}
        >
          {/* **一个带候选的自由输入框，不是下拉**：这个应用里分段没有实体（见
              `types.ts` 的 `section`），已有的段名是从任务上现算出来的，所以
              「选一个已有的」和「起一个新的」是同一个动作——`<datalist>` 正好
              表达这件事，而下拉表达不了后者。清空 = 不在任何分段里；服务端把
              空串归 null（`task.ts`），不然会冒出一个名字为空的分段。 */}
          <input
            className="ink-list-select"
            aria-label="分段（选填）"
            placeholder="选填"
            list="ink-section-options"
            value={value.section ?? ''}
            onChange={(e) => onChange({ ...value, section: e.target.value || null })}
          />
          <datalist id="ink-section-options">
            {sectionOptions.map((x) => <option key={x} value={x} />)}
          </datalist>
        </FieldRow>
      )}
      {parentOptions && parentOptions.length > 0 && shown.has('parent') && (
        <FieldRow
          name={ATTR_NAME.parent}
          value={attrValue(value, 'parent', lists, parentOptions)}
          open={openRow === 'parent'}
          onToggle={() => toggleRow('parent')}
        >
          {/* 层级是最外层的归属，放最后。当前值指向的那条不在候选里（它已完成、
              或者候选表是按别的任务算的）时也要能显示出来，不然打开一条已经挂好
              的子任务会看到「无」，跟卡片上画着的「↳ 属于……」自相矛盾——跟清单
              那一格「归档的清单不进候选，除非这条任务当下就归在它名下」同一个例外。 */}
          <select
            className="ink-list-select"
            aria-label="上级任务"
            value={value.parentId ?? ''}
            onChange={(e) => onChange({ ...value, parentId: e.target.value || null })}
          >
            <option value="">无</option>
            {parentOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        </FieldRow>
      )}
      {shown.has('tags') && (
        <FieldRow
          name={ATTR_NAME.tags}
          value={attrValue(shownDraft, 'tags', lists, parentOptions ?? [])}
          smart={fromSmart('tags')}
          open={openRow === 'tags'}
          onToggle={() => toggleRow('tags')}
        >
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
        </FieldRow>
      )}
      {missing.length > 0 && (
        <div className="ink-frow-wrap">
          {/* 「＋ 加一项」：只列**还没上屏**的那些。设过的已经在上面了，再列一遍
              是让人重复加一个已经存在的栏。点一个就把它请出来并当场展开。 */}
          <button
            type="button"
            className="ink-frow ink-frow-add"
            aria-expanded={addingOpen}
            aria-label="加一项属性"
            onClick={() => setAddingOpen(!addingOpen)}
          >
            <span className="ink-frow-nm">＋ 加一项</span>
            {/* 点名剩下那些，但**不当值使**：这一行没有值，它是入口。所以字号比
                真值小一档、并且**永不折行**——390px 上实测那串点名把行高顶到
                50px（别的行 32px），一行一个字段这个形状就破了。截断不丢信息：
                点开的菜单里全名一个不少，那才是它们该在的地方。 */}
            <span className="ink-frow-hint">
              {missing.map((k) => ATTR_NAME[k]).join(' · ')}
            </span>
            <span className="ink-frow-chev" aria-hidden="true">{addingOpen ? '⌄' : '›'}</span>
          </button>
          <div className={`ink-frow-editor${addingOpen ? '' : ' ink-frow-editor-closed'}`}>
            {/* 按「节奏 / 归属 / 标记」三段摆，每段一个小标题。只列**还没上屏**
                的那些：设过的已经在上面了，再列一遍是让人重复加一个已经存在的栏。 */}
            {ATTR_GROUPS.map((g) => {
              const keys = g.keys.filter((k) => missing.includes(k));
              if (keys.length === 0) return null;
              return (
                <div className="ink-fadd-group" key={g.cap}>
                  <span className="ink-fadd-cap">{g.cap}</span>
                  <Space wrap size={4}>
                    {keys.map((k) => (
                      <Button
                        key={k}
                        size="small"
                        color="default"
                        variant="outlined"
                        aria-label={`加一项：${ATTR_NAME[k]}`}
                        onClick={() => {
                          setAdded((prev) => (prev.includes(k) ? prev : [...prev, k]));
                          setAddingOpen(false);
                          setOpenRow(k);
                        }}
                      >{ATTR_NAME[k]}</Button>
                    ))}
                  </Space>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
