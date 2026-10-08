import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, ConfigProvider, Space } from 'antd';
import type { List, Task } from '../types.js';
import type { StatusFilter } from '../lib/taskView.js';
import { createdNote } from '../lib/createdNote.js';
import { clearDraft, stashDraft, takeDraft } from '../lib/draftStash.js';
import { parseIgnoring } from '../lib/smartInput.js';
import { mergePicked, type ComposeDefaults } from '../lib/composeDefaults.js';
import { presetToRemindAt } from '../lib/remindPreset.js';
import { boardLocalTheme } from '../theme.js';
import { TaskFields, emptyDraft, type TaskDraft } from './TaskFields.js';
import { SmartHint } from './SmartHint.js';

interface Props {
  /** 创建成功后返回服务端落盘的那条任务——用它判断新卡会落在哪个视图里。 */
  onCreate: (draft: TaskDraft) => Promise<Task>;
  onClose: () => void;
  /**
   * 这一次打开是**点了日历上某一天**开的话，那一天在这儿（ISO 串），否则 `null`。
   *
   * 只为恢复草稿那一件事存在：`defaults.due` 分不出「日历上刚点的那一天」和
   * 「设置里的默认截止」，而这两件事在恢复一份旧草稿时答案相反——前者是这一刻
   * 说的新话，该盖过旧草稿的日期；后者只是给空白表单的预填，不该盖。
   * 判据顺序（控件 > 标题 > 预填）在 `lib/composeDefaults.ts` 的 `mergePicked` 上。
   */
  pinnedDue?: string | null;
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
  /** 下面那片东西铺满整列（卡档、「按来源」的瀑布流），这张表单也跟着铺满。
   *  **跟 `QuickAdd` 的同名 prop 是同一件事**：调用方给两者的表达式一模一样，
   *  不然加任务行铺满、它展开出来的表单却收着，右边界差一大截。 */
  wide?: boolean;
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
/**
 * 新建表单那份草稿在 `draftStash` 里的键。它**不是一个任务 id**——这条任务还不
 * 存在；挑这个形状是为了撞不上任何 uuid，而那份暂存的键只需要唯一。
 */
const NEW_TASK_DRAFT = 'new-task';

export function TaskComposer({ onCreate, onClose, pinnedDue, view, boardFilter, now, lists, defaults, parentOptions, sectionOptions, wide }: Props) {
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
    /**
     * 上一次没建完的那份。**切去处的时候表单会被关掉**（App 那条 `[view, query,
     * filter, boardFilter]` 的清理，跟「选中」「就地编辑请求」同一件事），而这一张
     * 表单的草稿活在组件自己的 `useState` 里——不接住的话，切一下侧栏就把刚打的
     * 标题整个吃掉，一声不吭。`lib/draftStash.ts` 存在的理由就是这一句，
     * 那边管卡片编辑态（键是任务 id），这儿用一个是新建任务不存在、也不会跟
     * 任何 id 撞上的键。
     */
    const stashed = takeDraft(NEW_TASK_DRAFT);
    const blank = (): TaskDraft => {
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
    };
    if (!stashed) return blank();
    /**
     * 有草稿：**内容全还回去**（标题、备注、子任务、标签、他挑过的清单和
     * 优先级），只有两种情况让这一次的意图盖上去：
     * - `pinnedDue`——他是点了日历上某一天才开的表单。「那天」是**这一刻**说的
     *   话，比一份不知道什么时候留下的旧日期新。
     * - 站在某份清单里时预填的那个 `listId`——同一条道理，那是他此刻站着的位置。
     *
     * 反过来不成立：设置里的「默认清单/优先级」不盖草稿。那两个是给空白表单
     * 用的预填，而 `mergePicked` 早就立过这条顺序——**控件 > 标题 > 预填**，
     * 草稿是他动过手的东西，排在预填前面。
     */
    return {
      ...stashed,
      due: pinnedDue ?? stashed.due,
      listId: defaults?.listId ?? stashed.listId,
    };
  });
  /** 卸载时**只有「他动过手」才存**：建好了和主动取消都不存（那两份下一次凭空
   *  冒出来是坏事），**一字未改也不存**——这一条是被浏览器抓出来的：挂载时那份
   *  初值带着设置里的默认截止/默认清单，如果原样存了再原样恢复，第二次打开就
   *  是「恢复出来的一份」，把这一次该套的预填顶掉了（实测：日期那一格从
   *  「截止 10月3日 23:59」变成「未设置」）。没动过手就没有值得留的东西，
   *  让它走空白那条路，预填才是对的。
   *
   *  判据用「跟挂载那一刻那份是不是同一个对象」：`setDraft` 每次都产新对象
   *  （`{ ...value, 某键 }`），所以引用不同就是动过。React 的清理函数抓不到
   *  最新的 state，所以另存一份 ref，每次渲染跟一遍。 */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const initialRef = useRef(draft);
  const dismissed = useRef(false);
  useEffect(() => () => {
    if (!dismissed.current && draftRef.current !== initialRef.current) {
      stashDraft(NEW_TASK_DRAFT, draftRef.current);
    }
  }, []);
  /** 这张表单**办完了**：建好了或者他按了取消。清掉暂存再关——下一次凭空恢复出
   *  一份旧草稿是比丢掉更怪的事（`draftStash` 顶部那条既有的规矩，那边保存成功
   *  和主动取消也都 `clear`）。失败不走这儿：那时候草稿必须留着。 */
  const dismiss = () => {
    dismissed.current = true;
    clearDraft(NEW_TASK_DRAFT);
    onClose();
  };
  const [busy, setBusy] = useState(false);
  // 「取消识别」按过之后这一趟就不再识别了。**不做成「再打字又回来」**——
  // 那等于他明确说过的「别认」被一个字的输入撤销掉。表单建完就关（下面
  // submit 的 onClose），所以这个开关的寿命就是这一条任务，不用另外重置。
  const [smartOff, setSmartOff] = useState(false);
  /** 被逐词点掉的那几段（键见 `smartSpanKey`）。**不跟着草稿暂存走**：表单被
   *  切去处关掉再开，标题还在那儿而「别认」这份没了——那几段会重新被认出来。
   *  这不算撒谎：提示条上那颗 chip 又出现了，看得见要撤第二次。反过来把它存进
   *  `draftStash` 才是坏事——一份不知道什么时候留下的「别认」，管着他刚改过的
   *  那句新话。 */
  const [ignored, setIgnored] = useState<string[]>([]);

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
  const smart = useMemo(() => parseIgnoring(draft.title, now, defaults?.smart, ignored), [draft.title, now, defaults?.smart, ignored]);
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
      // 走 `dismiss()` 不是 `onClose()`：建完了，那份草稿到此为止，下一次
      // 开表单不该恢复出刚才已经变成任务的那份字。
      dismiss();
    } catch (e) {
      // 失败时表单原样留着，草稿不清——跟 TaskCard 的 save()、InboxComposer 的
      // submit() 同一条教训：清空等于把用户刚打的字连同这次失败一起弄丢。
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      size="small"
      className={`ink-task-card ink-task-composer${wide ? ' ink-task-composer-wide' : ''}`}
      // Esc 关这张表单——**从表单里任何一处**。标题框和备注框早就各自接了
      // （`formKey` 把 Escape 判成 cancel，并且 `preventDefault`），缺的是焦点在
      // 别处的时候：光标在「添加」那颗按钮上、在某一行的开关上、在清单下拉里，
      // 按 Esc 屏幕上什么都不发生，只能挪鼠标去点「取消」。回车能提交、Esc 不能
      // 退出，这一对键盘路不对称是这张表单上最容易撞见的一处。
      //
      // 两道让路：
      // - `defaultPrevented`：上面那两个框自己处理过了，别再来一次；
      // - 弹层控件里的 Esc 意思是「把这个弹层收起来」，不是「把整张表单作废」——
      //   日期面板开着时按 Esc，只该关面板。
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('.ant-picker, .ant-select, .ant-dropdown, .ant-input-number')) return;
        dismiss();
      }}
    >
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
            // 认出来的东西**显示在行上**（挂一颗「识别」），草稿本身一个字不改：
            // 屏幕上原来同时站着预填的「截止 10月5日 23:59」和提示条里那句
            // 「明天下午三点」，而按添加真的落后者——那个日期从头到尾没有落点。
            smartPreview={smartOn ? merged(draft) : undefined}
            autoFocusTitle
            lists={lists}
            parentOptions={parentOptions}
            sectionOptions={sectionOptions}
            // 打完标题直接回车就建好，不用把手挪到「添加」上——这个表单本来就
            // 一展开就把光标放在标题框里（autoFocusTitle），键盘那条路只差这
            // 最后一下。取消 = onClose，跟右边那颗「取消」同一个动作。
            onSubmit={() => void submit()}
            onCancel={dismiss}
          />
        </ConfigProvider>
        {/* 识别到什么、原话里哪几个字被读走了，都摆出来再让他按「添加」——**认走的
            那几个字会从标题里消失**，这是最需要提前说清楚的一件事，事后才发现标题
            少了半句跟建错了没区别。「取消识别」就在旁边，一步能退回原样。 */}
        {smartOn && (
          <SmartHint
            raw={draft.title}
            smart={smart}
            onOff={() => setSmartOff(true)}
            onIgnore={(key) => setIgnored((prev) => (prev.includes(key) ? prev : [...prev, key]))}
          />
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
          <Button size="small" type="text" disabled={busy} onClick={dismiss}>取消</Button>
        </Space>
      </Space>
    </Card>
  );
}
