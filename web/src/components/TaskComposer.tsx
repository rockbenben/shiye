import { useMemo, useState } from 'react';
import { App as AntApp, Button, Card, ConfigProvider, Space } from 'antd';
import type { List, Task } from '../types.js';
import type { StatusFilter } from '../lib/taskView.js';
import { createdNote } from '../lib/createdNote.js';
import { parseSmartInput } from '../lib/smartInput.js';
import { mergePicked, type ComposeDefaults } from '../lib/composeDefaults.js';
import { presetToRemindAt } from '../lib/remindPreset.js';
import { boardLocalTheme } from '../theme.js';
import { TaskFields, emptyDraft, type TaskDraft } from './TaskFields.js';

interface Props {
  /** 创建成功后返回服务端落盘的那条任务——用它判断新卡会落在哪个视图里。 */
  onCreate: (draft: TaskDraft) => Promise<Task>;
  onClose: () => void;
  /** 当前在哪个视图。只影响一件事：新卡如果不会出现在你正看着的这个视图里，
   * 要说一声，见下面 report() 的注释。
   * 类型是 string 不是字面量联合——注册表现在还有「收件箱」、以后还会有
   * 清单/标签这些去处，「新任务」这颗按钮不限定只在「今天」「按来源」里
   * 才能点，report() 对没特殊处理的视图有兜底分支，不靠这里的类型把它们
   * 挡在外面。 */
  view: string;
  /** 「按来源」当前的状态筛选。新任务一律是 todo，筛选停在别的档上会把它藏起来。 */
  boardFilter: StatusFilter;
  now: Date;
  /** 归到哪个清单的候选项，原样转交给 TaskFields。 */
  lists: List[];
  /**
   * 任务默认值（仿滴答清单「设置 → 更多设置 → 任务默认值」）：新表单打开时
   * 预填的清单和优先级。整份缺省（读不到设置、离线）就什么都不预填——
   * 不是编一份出来，跟 `SettingsModal` 收 `Settings | null` 同一条道理。
   */
  /**
   * 表单打开时预填什么。每个字段的意思写在 `ComposeDefaults` 上，这里不抄第二遍。
   *
   * **从 `ComposeDefaults` 派生，不再手抄一份形状。** 上一版这里是一个内联的
   * 对象类型，字段名和 `ComposeDefaults` 一个一个对着写——`context` 加进
   * `ComposeDefaults` 时这份没跟上，而**结构类型允许多传**，于是 `App.tsx` 递过来
   * 的那个字段在类型这一层就被静默吃掉了，一个错都不报。派生之后形状飘不了。
   *
   * `listId`/`priority` 必填、其余可选：调用方只有 `App.tsx` 一个会传全份，而
   * 这个组件的测试大多只关心其中一两个（`{ listId, priority }`），全要求填等于
   * 让每条用例都去编一份它不关心的缺省值。
   *
   * 形状对了不等于用上了：**「每个字段真的有人读」由 `composeDefaults.guard.test.ts`
   * 盯着**——那正是 `context` 漏掉的那一半，类型系统管不了。
   */
  defaults?: Pick<ComposeDefaults, 'listId' | 'priority'> & Partial<ComposeDefaults>;
  /** 能挂到哪条任务下面（多级任务），原样转交给 TaskFields。 */
  parentOptions?: Array<{ id: string; title: string }>;
  /** 现有的分段名，给那个自由输入框当候选。判据在 `grouping.ts` 的 `sectionNames`。 */
  sectionOptions?: string[];
}

/**
 * 手工建一条任务。
 *
 * 收件箱那条路（丢一段文本 → 等自动拆解 → AI 给你一张卡）是给「想到什么先记
 * 下来、还没想清楚是几件事」用的。已经知道自己要做什么的时候不该走那条路：
 * 等六十秒，就为了让 AI 把「买牛奶」变成一张写着「买牛奶」的卡。
 *
 * 服务端一直有 `POST /api/tasks`，`newTask()` 也一直把 source 填成 'user'，
 * 「按来源」看板里那个「单独记的」分组就是为这种任务准备的——缺的只是一个入口。
 */
export function TaskComposer({ onCreate, onClose, view, boardFilter, now, lists, defaults, parentOptions, sectionOptions }: Props) {
  const { message } = AntApp.useApp();
  // 起草时套一次任务默认值。**只在挂载那一刻算**（useState 的惰性初值），
  // 不是每次渲染都对着 settings 重算——那样用户把预填的清单改成「不属于任何
  // 清单」，下一次渲染又会被推回去。
  //
  // `defaultListId` 指向一个已经删掉的清单时当成没设：留着它会让下拉框显示
  // 「不属于任何清单」而 draft.listId 却指着一个死 id，存下去之后这条任务在
  // 导航里哪儿都找不到。服务端不校验这个 id（清单随时能删，它没法回头改这个
  // 字段），这一层是唯一守得住的地方。
  const [draft, setDraft] = useState<TaskDraft>(() => {
    const base = emptyDraft();
    if (!defaults) return base;
    const listId = defaults.listId && lists.some((l) => l.id === defaults.listId && !l.archived && l.filter === null)
      ? defaults.listId
      : null;
    // `due` 不做上面那种「指向不存在的东西就当没设」的校验——它是一个日期，
    // 不指向任何会被删掉的记录。
    const due = defaults.due ?? base.due;
    return {
      ...base,
      listId,
      priority: defaults.priority,
      due,
      tags: defaults.tags ?? base.tags,
      // 跟 `tags` 同一条：站在「外出」那一屏里按「新任务」，那条就该是外出的。
      context: defaults.context ?? base.context,
      // 设置里的「默认提前多久提醒」。**只在真的有 due 时才落**——没有截止
      // 时间就没有「提前」的参照物（`presetToRemindAt` 收到 null 也正是返回
      // null）。表单里那排「准时/提前 5 分钟……」会因此自动点亮对应的一颗，
      // 不用另外同步一份状态：那排按钮本来就是从 due+reminders 现算的
      // （`activePresets`）。
      reminders: typeof defaults.remindMinutes === 'number'
        ? [presetToRemindAt(due, defaults.remindMinutes)].filter((x): x is string => x !== null)
        : base.reminders,
    };
  });
  const [busy, setBusy] = useState(false);
  // 「取消识别」按过之后这一趟就不再识别了。**不做成「再打字又回来」**——
  // 那等于他明确说过的「别认」被一个字的输入撤销掉。表单建完就关（下面
  // submit 的 onClose），所以这个开关的寿命就是这一条任务，不用另外重置。
  const [smartOff, setSmartOff] = useState(false);

  /**
   * 智能识别（仿滴答清单）：标题里写「明天下午两点交周报 #工作」，那几段
   * 直接变成截止/提醒/标签，不用再点开三个控件。
   *
   * **只认，不改**——识别结果不写回 `draft`，只画在下面那条提示里，`submit`
   * 那一刻才合并。写回去的话每敲一个字都会把光标位置和已经填好的控件搅乱，
   * 而且「取消识别」就得反向撤销一遍，撤不干净。
   *
   * `now` 每分钟走一次表，跟着重算是对的：「9点」在十点和二十二点说的不是
   * 同一天，停在打开表单那一刻的时间反而会算错。这函数很便宜，重算无所谓。
   */
  const smart = useMemo(() => parseSmartInput(draft.title, now, defaults?.smart), [draft.title, now, defaults?.smart]);
  const smartOn = !smartOff && smart.hits.length > 0;

  /**
   * 合并：**已经手填过的字段不动**。他在 DatePicker 里挑了日期、又在标题里
   * 写了「明天」，该听哪个说不清——听已经落到控件上的那个，那是他更明确的
   * 一次表达。标签是可以并存的，合起来去重。
   */
  const merged = (d: TaskDraft): TaskDraft => (!smartOn ? d : {
    ...d,
    title: smart.title,
    // 控件 > 标题 > 预填，判据在 lib/composeDefaults.ts 的 `mergePicked`。
    due: mergePicked(d.due, defaults?.due, smart.due),
    // 自然语言最多解析出一个提醒时刻；表单里已经手填了提醒就不再塞它那个。
    // （`smart.remindAt` 保持单个是对的——「明天下午三点提醒我」说不出第二个。）
    reminders: d.reminders.length > 0 ? d.reminders : (smart.remindAt ? [smart.remindAt] : []),
    repeat: d.repeat ?? smart.repeat,
    tags: [...d.tags, ...smart.tags.filter((t) => !d.tags.includes(t))],
    // 情境跟 `due` 同一条三段判据，不是 `??`：站在「外出」那一屏打开表单，
    // 下拉一上来就是「外出」（预填），这时候标题里写的 `@电脑前` 得压过它。
    context: mergePicked(d.context, defaults?.context, smart.context),
  });

  /**
   * 建好之后说清楚它去哪了——判断在 `lib/createdNote.ts`，那里有整段理由。
   *
   * `?? '已添加'`：那个函数回 `null` 的意思是「它就在你眼前」。这个表单**建完
   * 会整个关掉**，那是一次明确的状态变化，回一句确认是对的；`QuickAdd` 那一行
   * 留在原地，同一档它就什么都不说。
   */
  const report = (task: Task) => {
    void message.success(createdNote(view, task, now, boardFilter) ?? '已添加');
  };

  const submit = async () => {
    const next = merged(draft);
    const title = next.title.trim();
    if (!title) return;
    setBusy(true);
    try {
      const task = await onCreate({ ...next, title });
      report(task);
      // 关掉整个表单，不是清空留在原地——手工建任务是「偶尔来一条」，
      // 不像收件箱那样连着记好几条。要再建一条重新点开就是了。
      onClose();
    } catch (e) {
      // 失败时表单原样留着，草稿不清——跟 TaskCard 的 save()、InboxComposer 的
      // submit() 同一条教训：清空等于把用户刚打的字连同这次失败一起弄丢。
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="small" className="ink-task-card ink-task-composer">
      <Space direction="vertical" size={6} style={{ display: 'flex' }}>
        {/* 局部 ConfigProvider 压 colorPrimary：这个表单从来没被任何一层
            boardLocalTheme 盖住过（TaskCard.tsx 编辑态同样的坑，见那边
            TaskFields 外层这层 ConfigProvider 的注释）——不套的话「新任务」
            表单里的截止/提醒 DatePicker 是群青，跟这个应用「群青是配给制」
            的规矩冲突，见 final-review.md I3。 */}
        <ConfigProvider theme={boardLocalTheme}>
          <TaskFields
            value={draft}
            onChange={setDraft}
            autoFocusTitle
            lists={lists}
            parentOptions={parentOptions}
            sectionOptions={sectionOptions}
            // 打完标题直接回车就建好，不用把手挪到「添加」上——这个表单本来就
            // 一展开就把光标放在标题框里（autoFocusTitle），键盘那条路只差这
            // 最后一下。取消 = onClose，跟右边那颗「取消」同一个动作。
            onSubmit={() => void submit()}
            onCancel={onClose}
          />
        </ConfigProvider>
        {/* 识别到什么、标题会变成什么，都摆出来再让他按「添加」——**认走的那几个
            字会从标题里消失**，这是最需要提前说清楚的一件事，事后才发现标题少了
            半句跟建错了没区别。「取消识别」就在旁边，一步能退回原样。
            不用群青：这是本机的一条规则算出来的，不是 AI 产出，群青是配给制。 */}
        {smartOn && (
          <div className="ink-smart-hint" role="status">
            <span>识别到 {smart.hits.join(' · ')}，标题会变成「{smart.title}」</span>
            <Button size="small" type="text" onClick={() => setSmartOff(true)}>取消识别</Button>
          </div>
        )}
        <Space size={6} wrap>
          {/* color="default" variant="solid"：全站约定，你自己按的按钮不拿群青
              （那是 AI 的颜色）；这是这个表单里唯一的确认动作，用 solid。 */}
          <Button
            size="small"
            color="default"
            variant="solid"
            loading={busy}
            disabled={!draft.title.trim() || busy}
            onClick={() => void submit()}
          >
            添加
          </Button>
          <Button size="small" type="text" disabled={busy} onClick={onClose}>取消</Button>
        </Space>
      </Space>
    </Card>
  );
}
