import { parseSmartInput } from './smartInput.js';
import type { List, Repeat, TaskContext } from '../types.js';
import type { SmartOptions } from './smartInput.js';

/**
 * 「新任务」表单打开时预填什么。
 *
 * 三层，后面的盖前面的：
 * ① 设置里的「任务默认值」（`defaultListId`/`defaultPriority`）——长期偏好；
 * ② **当前这个去处**：站在清单「工作」里按「新任务」，那条任务就该落进工作。
 *    在这之前它按设置里的默认清单走（多半是「不属于任何清单」），于是建完
 *    之后那一屏一点变化都没有——跟建失败长得一模一样，而那正是
 *    `TaskComposer` 里 `report()` 存在的理由。标签那个去处同理。
 * ③ 日历上「在这天新建」带过来的那一天。
 *
 * **智能清单和已归档的清单不预填**：智能清单是一份存下来的查询、不是容器，
 * 把 `listId` 指过去那条任务不会因此出现在里面，反而在导航里哪儿都找不到；
 * 归档的意思就是别再往里放东西。两条跟 `fileableLists` 挡掉它们是同一份判据
 * ——那边是「能不能移过去」，这边是「要不要默认落在这儿」，问的是同一件事。
 *
 * 纯函数：判断挪出组件才测得动，`App.tsx` 里那一版是个内联的 IIFE，
 * 只能靠整棵应用树的端到端测试去碰，而那份测试贵到会超时。
 */
export interface ComposeDefaults {
  listId: string | null;
  priority: 0 | 1 | 2 | 3;
  due: string | null;
  tags: string[];
  /** 情境（GTD）。`null` = 不预填——只有站在某个情境的那一屏里建才会非空。 */
  context: TaskContext | null;
  /** 提前多久提醒，分钟。`null` = 不预设。**只在真的有 `due` 时才有意义**
   *  ——没有截止时间就没有「提前」的参照物，见下面填它的地方。 */
  remindMinutes: number | null;
  /**
   * 智能识别的四个开关，原样转给 `parseSmartInput`。
   *
   * **搭这趟车而不是另开一个 prop**：加任务那一行和新任务表单本来就都收
   * `defaults`，「这条新任务该长什么样」这件事全在这一个对象里；分两处传的话
   * 下一个入口（比如日历上「在这天新建」）又要记得两处都接。
   */
  smart: SmartOptions;
}

/** 设置里那几个「任务默认值」。收一个窄接口而不是整个 `Settings`：这个函数
 *  只看得到自己要的那几个字段，`Settings` 加字段不会让它的测试夹具跟着长。 */
export interface DefaultsFromSettings {
  defaultListId: string | null;
  defaultPriority: 0 | 1 | 2 | 3;
  defaultDue: 'none' | 'today' | 'tomorrow';
  defaultRemindMinutes: number | null;
  defaultTags: string[];
  smartDate: boolean;
  smartStripDate: boolean;
  smartTag: boolean;
  smartStripTag: boolean;
}

/** 设置里的「默认日期」落成哪一刻。落 23:59 不是零点，跟下面「今天」那一支
 *  和日历的「在这天新建」同一条：零点会被 `isOverdue` 当成一个真实时刻，
 *  那天 00:01 就标成过期、红一整天。 */
function dueFromSetting(kind: 'none' | 'today' | 'tomorrow', now: Date): string | null {
  if (kind === 'none') return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (kind === 'tomorrow' ? 1 : 0), 23, 59);
  return d.toISOString();
}

export function composeDefaults(
  view: string,
  lists: List[],
  settings: DefaultsFromSettings | null,
  due: string | null,
  now: Date,
): ComposeDefaults {
  const base: ComposeDefaults = {
    listId: settings?.defaultListId ?? null,
    priority: settings?.defaultPriority ?? 0,
    // 日历带过来的那一天优先于设置里的「默认日期」：那是他刚点出来的一个
    // 具体日子，比一条长期偏好明确得多。
    due: due ?? dueFromSetting(settings?.defaultDue ?? 'none', now),
    // 设置里的「默认标签」是底子；下面「站在某个标签里」那一支会盖掉它——
    // 那个上下文更具体。
    tags: settings?.defaultTags ?? [],
    // 情境没有「默认值」这回事，设置里也不给一个：它答的是「这件事得在什么
    // 条件下干」，跟任务本身绑死，不是一条能预设的偏好。只有下面「站在某个
    // 情境的那一屏里建」那一支会把它填上。
    context: null,
    remindMinutes: settings?.defaultRemindMinutes ?? null,
    // 读不到设置（离线）时四个全开——那是这组开关存在之前的行为。
    smart: {
      date: settings?.smartDate ?? true,
      stripDate: settings?.smartStripDate ?? true,
      tag: settings?.smartTag ?? true,
      stripTag: settings?.smartStripTag ?? true,
    },
  };

  // 「今天」那个去处：预填**今天**。跟清单/标签同一条理由，只是更明显——
  // 那个去处的成员资格就是「今天要做」，在那儿建一条不带时间的任务，卡片
  // 会落进「按来源」，你盯着的这一屏一点变化都没有（`TaskComposer` 的
  // `report()` 第一支说的就是这件事，它存在本身就是这个默认不对的证据）。
  //
  // 落 23:59，跟自然语言识别「只说了哪天」同一条：零点会被 `isOverdue` 当成
  // 一个真实时刻，那天 00:01 就标成过期、红一整天。
  //
  // **日历带过来的那一天优先**：那是他刚点出来的一个具体日子，比「你正站在
  // 今天」这个上下文明确得多。
  if (view === 'today' && !due) {
    return { ...base, due: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).toISOString() };
  }

  if (view.startsWith('list:')) {
    const id = view.slice('list:'.length);
    const hit = lists.find((l) => l.id === id);
    return hit && !hit.archived && hit.filter === null ? { ...base, listId: id } : base;
  }
  // 标签名可以是任何字符串，不用（也没法）对着一张表校验——它不像清单那样
  // 是一条会被删掉的记录，打上一个当前没人用过的标签本来就合法。
  // 站在某个标签里建，就落那个标签——**盖掉设置里的默认标签**，不是叠加：
  // 「我现在在 #家务 这一屏」是一句比「我一般都打 #工作」明确得多的话。
  if (view.startsWith('tag:')) return { ...base, tags: [view.slice('tag:'.length)] };
  // 站在某个情境里建，就落那个情境——跟标签同一条理由。不对着枚举校验：
  // 这个 key 只能从侧栏那几行点出来，而那几行本来就是从 `CONTEXTS` 渲染的；
  // 真有人手敏一个不存在的 hash 进来，服务端校验会拦住（task.ts 的 CONTEXT_OK）。
  if (view.startsWith('context:')) return { ...base, context: view.slice('context:'.length) as TaskContext };
  return base;
}


/**
 * 提交时一个**单值字段**听谁的：控件里那个、标题里认出来的、还是预填的那个。
 *
 * 三条，从强到弱：
 * ① **他自己在控件里挑过的最强**——那是最明确的一次表达。判据是「跟预填的
 *    不一样了」，也就是他动过那个控件。
 * ② **标题里写出来的次之**：`明天下午两点`、`@外出` 都是他主动打出来的字。
 * ③ **预填最弱**：站在「今天」里打开表单，due 一上来就是今天——那只是一个
 *    上下文猜测，不该压过他打出来的字。这一条是这个函数存在的理由：原来
 *    合并规则是「控件里有值就用控件的」，而预填一来控件就有值了，于是在
 *    「今天」里写「明天开会」会建出一条今天到期的任务。
 *
 * 三个都没有就是 `null`。
 *
 * **泛型，不是只管截止时间**（上一版叫 `mergeDue`）：情境加进智能识别之后
 * 撞上的是同一件事——站在「外出」那一屏里打 `@电脑前`，预填的「外出」不该压过
 * 他刚打出来的字，跟上面 ③ 那个 bug 一字不差。规矩只写一遍，不给每个字段各抄
 * 一份 if。
 */
export function mergePicked<T extends string>(
  picked: T | null, prefilled: T | null | undefined, typed: T | null,
): T | null {
  if (picked && picked !== (prefilled ?? null)) return picked;   // ①
  return typed ?? picked;                                        // ② → ③
}

/**
 * **一行原话 → 一份任务草稿。** 智能识别（日期/标签/重复）+ 设置里的「任务
 * 默认值」按同一套规矩合并。
 *
 * 两个调用方：
 *   - 列表顶上那条「添加任务」（`QuickAdd`）——它一直是这么组装的，这份代码
 *     就是从那儿整块搬出来的；
 *   - 收件箱里「变成任务」——把随手记的那句原话直接变成一条任务，不劳烦 AI。
 *
 * **搬出来是因为第二个调用方**：两处各写一份的话，「标题里认出来的提醒优先于
 * 设置里的默认提前量」「没有 due 就不落默认提醒」这些判断迟早只在一处被改到，
 * 而分叉的表现是「同一句话从两个入口进来，建出两条不一样的任务」——没有任何
 * 测试会因此变红。
 *
 * `smartOff`：人在那一行里把智能识别按掉了（`QuickAdd` 有那颗开关）。收件箱
 * 那条路没有开关，传 false。
 */
/**
 * 一段随手记 → 一条任务的「标题 + 备注」。
 *
 * 随手记是个多行框，提示语就写着「想到什么写什么，不用整理」——一段五行的
 * 脑内倾倒是它邀请的结果，不是意外。而任务的标题是一行：整段塞进 `title`，卡片上
 * 就是一条被压成一行、长到读不下去的标题，而备注是空的。
 *
 * **纯函数，放在这里不在 `App.tsx`。** 跟 `smartDraft` 当初从 `QuickAdd` 搬出来同一条
 * 理由：要验它就得渲染整个 App，而那一次渲染实测会把用例压到 15s 超时线上
 * （见 vitest.config.ts 里为什么不放宽 TIMEOUT 那段）。
 *
 * `/\r?\n/`：粘进来的 CRLF 不该在备注每行末尾留一个 `\r`。
 * 首行是空行就往下找第一个非空行——整段都是空白时退回整段（调用方自己有
 * 一句 `if (!title) return` 兑底）。
 */
export function splitCapture(text: string): { head: string; body: string } {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i === -1) return { head: text.trim(), body: '' };
  return { head: lines[i].trim(), body: lines.slice(i + 1).join('\n').trim() };
}

export function smartDraft(
  raw: string,
  defaults: ComposeDefaults,
  now: Date,
  opts: { smartOff?: boolean; presetToRemindAt: (due: string | null, minutes: number) => string | null } ,
): { title: string; due: string | null; reminders: string[]; repeat: Repeat | null; tags: string[]; listId: string | null; priority: 0 | 1 | 2 | 3; context: TaskContext | null } {
  const smart = parseSmartInput(raw, now, defaults.smart);
  const on = !opts.smartOff && smart.hits.length > 0;
  const title = (on ? smart.title : raw).trim();
  // 第一个参数传 `defaults.due` 不是笔误：`mergeDue` 的第一条判据是「他在控件
  // 里动过没有」，而这两条路**都没有日期控件**，所以永远是「没动过」——于是
  // 它退到「标题里写出来的 > 预填的」，正是这里要的。
  const due = mergePicked(defaults.due, defaults.due, on ? smart.due : null);
  return {
    title,
    due,
    listId: defaults.listId,
    priority: defaults.priority,
    // 提醒：标题里认出来的最优先（他刚刚亲口说了几点），其次才是设置里的
    // 「默认提前多久」。**没有 due 就不落默认提醒**——没有截止时间就没有
    // 「提前」的参照物，硬落一个等于凭空定一个跟任何事都无关的闹钟。
    reminders: on && smart.remindAt
      ? [smart.remindAt]
      : ((): string[] => {
        const at = typeof defaults.remindMinutes === 'number'
          ? opts.presetToRemindAt(due, defaults.remindMinutes)
          : null;
        return at ? [at] : [];
      })(),
    repeat: on ? smart.repeat : null,
    tags: on ? [...defaults.tags, ...smart.tags.filter((t) => !defaults.tags.includes(t))] : defaults.tags,
    // 情境：标题里写出来的（`@外出`）优先，其次才是「站在哪一屏」。这一行没有
    // 控件那一档——「添加任务」那一行就一个输入框，所以不走 `mergePicked`，
    // 两档直接比。
    context: (on ? smart.context : null) ?? defaults.context,
  };
}
