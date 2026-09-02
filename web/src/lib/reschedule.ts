import type { Reminder, Task } from '../types.js';
import { asArray, hasTimeBlock } from './taskView.js';
// 「这条任务落在日历上的哪一刻」全仓库只有一份判据，在 `calendar.ts`。
// 不成环：`calendar.ts` 和它引的那几个模块都不引这个文件。
import { calendarAnchor } from './calendar.js';

/**
 * **一条任务在日历上的位置整个平移 `shift` 毫秒。**
 *
 * 时间段（`startAt`+`endAt`）和 `due` 一起挪、间隔保持不变；哪个字段不存在
 * 就不写哪个。三个调用方共用这一份：「改期到今天/明天」（`reschedulePatch`）、
 * 「推迟一小时」（`postponePatch`）、月格拖到另一天（`CalendarView` 的
 * `onDropOnDay`）。
 *
 * 在它之前那三处各自只认 `due`，于是一场「九点到十二点开会」——表单里三个
 * 日期选择器互相独立，不填截止时间是最自然的输入——在这三条路上分别是：
 * 被**编出一个 23:59 的截止时间**而时间段原地不动、被**静默跳过**、
 * **拖不动**。挪时间段而不是补一个 `due`，跟四象限横轴「拖了不改期」是同一条
 * 约定：不替他决定一个他没说过的时刻。
 *
 * **不碰提醒**：三个调用方对提醒的态度本来就不同（前两个跟着平移，拖拽那条
 * 有意不动，理由在 `onDropOnDay` 上面那段），各自处理。
 */
export function shiftTimesPatch(t: Task, shift: number): Partial<Task> {
  const patch: Partial<Task> = {};
  // `hasTimeBlock` 已经保证这两个都解得出来，所以这里不再判一遍 NaN。
  if (hasTimeBlock(t)) {
    patch.startAt = new Date(Date.parse(t.startAt as string) + shift).toISOString();
    patch.endAt = new Date(Date.parse(t.endAt as string) + shift).toISOString();
  }
  const due = t.due ? Date.parse(t.due) : NaN;
  if (!Number.isNaN(due)) patch.due = new Date(due + shift).toISOString();
  return patch;
}

/**
 * 「改期」的四个去处。仿滴答清单：右键任务 →「日期」→ 今天 / 明天 / 下周 /
 * 自定义。**没有「自定义」这一档**——那是编辑表单里的 DatePicker，已经有了，
 * 菜单里再放一个入口只是把同一个控件包两层。
 */
export type RescheduleTo = 'today' | 'tomorrow' | 'nextWeek' | 'clear';

/**
 * 菜单里那几档的顺序。**「去掉截止时间」排在最后**——它是这四个里唯一不可逆
 * 的一步（原来那个日期没别处记着），不该混在三个去处中间。
 *
 * 放在这儿而不是某个组件里：卡片 ⋯ 的「改期」组和命令面板的批量改期都要用
 * 同一份顺序和文案，各写一份的话两处迟早列出不一样的档。
 */
export const RESCHEDULE_KEYS: RescheduleTo[] = ['today', 'tomorrow', 'nextWeek', 'clear'];

export const RESCHEDULE_LABEL: Record<RescheduleTo, string> = {
  today: '今天', tomorrow: '明天', nextWeek: '下周', clear: '去掉截止时间',
};

const DAYS: Record<Exclude<RescheduleTo, 'clear'>, number> = { today: 0, tomorrow: 1, nextWeek: 7 };

/**
 * 改期要发的那份 patch。**纯函数**：不读系统时钟（`now` 由调用方传），
 * 也不发请求——算出改哪几个字段就交回去，跟 `applyMove`、`nextInstance`
 * 同一个形状。
 *
 * 两条规矩：
 *
 * **① 原来几点还是几点。** 一条「周五 18:00 交表」推到明天，该是明天 18:00，
 * 不是明天某个新编出来的时刻。原来没有截止时间（或者时间坏掉解析不了）的，
 * 落在那天的 **23:59** ——不是本地零点：零点在这个界面里有歧义，`dueChip`
 * 拿它当「整天、不显示时刻」，而 `isOverdue` 拿它当一个真实时刻，于是「推到
 * 明天」的任务到了明天 00:01 就被标成已过期，红一整天。跟 `smartInput.ts` 落
 * 日期时用的是同一个数、同一个理由。
 *
 * **② 提醒跟着平移同样的量。** 只改 `due` 不动提醒，等于把「截止前一小时
 * 提醒」变成「昨天就该响、现在补一炮」——`reminder.ts` 的 `isDue` 没有下界，
 * 过期没盖章的提醒下一个 tick 就炸出来。平移之后章会被服务端自己清掉
 * （`applyTaskPatch` 按时刻逐条比对，新时刻就是「还没提醒过」），所以这里
 * 不用管 `firedAt`，照原样带上就行。
 *
 * **原来没有 `due` 就不动提醒**：没有参照物，平移多少都是编的。
 *
 * **③ 「今天」那一档：算出来的时刻要是今天已经过去了，落 23:59。** 这一条只
 * 可能在「今天」上发生（明天/下周永远在未来）。一条「前天 09:00」的任务下午
 * 三点点「改到今天」，按 ① 会落在今天 09:00 —— **一个已经过去的时刻，任务当场
 * 又是过期的**，屏幕上一点变化都没有。而「已过期」那一组的组头上正挂着一颗
 * 「全部推到今天」，命令面板里也有一条「把 N 条过期的改到今天」：按完了那一组
 * 还是原样，这是这个仓库最怕的那类「写成功了、界面看上去什么也没发生」。
 *
 * 落 23:59 不算「编一个他没说过的时刻」：那个钟点已经被违反了，而「改到今天」
 * 这句话本身说的就是「今天之内做」。带日期不带钟点的任务本来就落在 23:59，
 * 这一支只是让它们走到同一个地方。提醒跟着这个新时刻平移，顺带也不会在下一个
 * tick 就炸出来。
 *
 * **④ 参照物是 `calendarAnchor`，不是 `due`；挪的是整条，不是补一个 `due`。**
 * 这里原来只认 `due`：一场「九点到十二点开会」（时间段在，截止时间空着——
 * 表单里三个日期选择器互相独立，这是最自然的输入）走到这儿 `prev === null`，
 * 于是**被编出一个明天 23:59 的截止时间，而那三个小时原地不动**。日历上它
 * 还在原来那天，卡片上却多了一句他没说过的话。现在按锚点算位移，
 * `shiftTimesPatch` 把时间段和 `due` 一起挪、间隔不变。
 *
 * **③ 那条 23:59 兜底对有时间段的不适用。** 「今天之内做」是截止时间的说法；
 * 一场会议没有「今天之内」，它就是九点到十二点。下午三点把一场今早的会「改到
 * 今天」，落在今天 09:00（一个已经过去的时刻）是**如实**的——那天的日历上它
 * 就在九点；改成 23:59-02:59 才是编。①「原来几点还是几点」在这一支里说了算。
 */
export function reschedulePatch(t: Task, to: RescheduleTo, now: Date): Partial<Task> {
  // 「去掉截止时间」不连提醒一起清：这个应用里 due 和 reminders 各管各的
  // （AGENTS.md 那一节），他要的是「不再标红」，不是「别再提醒我」——后者
  // 是编辑表单里清空提醒时间那一步，或者干脆「搁置」。
  // **也不碰时间段**：清掉的是「什么时候之前要做完」这句话，不是那场会。
  if (to === 'clear') return { due: null };

  const block = hasTimeBlock(t);
  const prev = calendarAnchor(t);
  const hasClock = prev !== null && (prev.getHours() !== 0 || prev.getMinutes() !== 0);

  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DAYS[to]);
  const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59);
  const kept = new Date(
    target.getFullYear(), target.getMonth(), target.getDate(),
    hasClock ? prev.getHours() : 23,
    hasClock ? prev.getMinutes() : 59,
  );
  // ③ 见上面。`<=` 不是 `<`：正好等于此刻的那个时刻，下一秒就是过去。
  // 有时间段的不走这一支，理由见上面 ③ 末尾那段。
  const at = !block && kept.getTime() <= now.getTime() ? dayEnd : kept;

  // 锚点算不出来（没有时间段、`due` 也空着或坏着）：没有可平移的东西，
  // 「改到明天」就是给它一个明天的截止时间——跟改动前一字不差。
  if (prev === null) return { due: at.toISOString() };

  const delta = at.getTime() - prev.getTime();
  const moved = shiftTimesPatch(t, delta);
  const reminders: Reminder[] = asArray<Reminder>(t.reminders).map((r) => {
    const parsed = Date.parse(r.at);
    // 解析不了的原样留着——平移一个 NaN 会写出 Invalid Date，比一条本来就
    // 不会触发的坏提醒糟得多（那条至少还看得出是手改坏的）。
    return Number.isNaN(parsed) ? r : { at: new Date(parsed + delta).toISOString(), firedAt: r.firedAt };
  });
  return reminders.length > 0 ? { ...moved, reminders } : moved;
}

/**
 * 「推迟」一次挪多久。滴答清单那颗按钮就是一小时。
 *
 * **放在这儿而不是某个组件里**：批量操作条和单张卡的 ⋯ 里各有一个「推迟
 * 1 小时」，两处各写一个 60 的话，改一头另一头就悄悄变成了另一件事——
 * 按钮上写着同一句话、做的事不一样，是最难发现的那种分叉。
 *
 * **跟桌面通知上那颗「推迟」不是同一个数，也不该是**（`desktop/src/notify.ts`
 * 的 `SNOOZE_MINUTES = 10`）。那是两件事：这一颗是「这条任务今天晚点再说」，
 * 他正在整理清单；那一颗是通知弹到脸上时的贴条，他正在被打断，十分钟后再响
 * 才是他要的。两边的按钮**都把数字写在脸上**（「推迟 1 小时」/「推迟 10 分钟」），
 * 所以不会有人被误导——别看见两个数就去「统一」它们。
 */
export const POSTPONE_MINUTES = 60;

/**
 * 「推迟一小时」（仿滴答清单：批量选中之后一键把时间往后挪一小时，应付临时
 * 会议、堵车、插进来的新安排）。
 *
 * **从这条任务自己的时间往后挪，不是从现在**——「推迟」的意思是「原计划整个
 * 往后挪一段」，不是「重新排到一小时后」。所以这是一条**逐条不同**的改动，
 * 没法用一份共享的 patch 表达，见 `api.patchTasksEach`。
 *
 * **时间段、`due` 和提醒一起挪同样的量**，三个都没有的返回 `null`——一条没有
 * 任何时间的任务「推迟一小时」是没有意义的，调用方据此跳过它，不发一个什么
 * 都不改的写。
 *
 * 时间段是后补进来的：在那之前这里只认 `due` 和提醒，于是一场「九点到十二点
 * 开会」（没填截止时间）在批量「推迟一小时」里返回 `null`，**被静默跳过**——
 * 选中的 N 条里它一动不动，而界面上没有任何地方说过这件事。它偏偏正是最该
 * 推迟的那一种：临时会议、堵车，推的就是这场会本身。
 */
export function postponePatch(t: Task, minutes: number): Partial<Task> | null {
  const shift = minutes * 60_000;
  const rs = asArray<Reminder>(t.reminders);
  const moved = shiftTimesPatch(t, shift);
  // 时刻解析不了的提醒不算「有时间」——挪一个 NaN 会写出 Invalid Date，
  // 跟 reschedulePatch 里那条同一个兜底。
  const hasReminder = rs.some((r) => !Number.isNaN(Date.parse(r.at)));
  if (Object.keys(moved).length === 0 && !hasReminder) return null;

  const patch: Partial<Task> = moved;
  if (rs.length > 0) {
    patch.reminders = rs.map((r) => {
      const at = Date.parse(r.at);
      return Number.isNaN(at) ? r : { at: new Date(at + shift).toISOString(), firedAt: r.firedAt };
    });
  }
  return patch;
}

/**
 * 「稍后 N 分钟」——**把刚响过的那一条挪到 N 分钟后，不是再追加一条**。
 *
 * 原来这里是追加，理由写着「原来那条已经盖过 `firedAt`，把它的 `at` 往后挪
 * 不会让它再响一次（`isDue` 第一句就是 `if (r.firedAt) return false`）」。
 * **那个前提是错的**：`applyTaskPatch`（server/src/mutate.ts）按**时刻**逐条
 * 比对来沿用旧章——`at` 一变就配不上任何一条旧的，章从「还没提醒过」重新算起。
 * 也就是说挪它照样响得起来，而追加的代价是实打实的：连着按五次「稍后」，这条
 * 任务上就攒了六条提醒、五条是死的，编辑表单里并排六个日期选择器。
 *
 * **挪哪一条**：`firedAt` 最新的那条——那就是刚刚把横幅推出来的那一条。同一
 * 时刻盖了两条章（同一轮扫描里两个提醒一起到点）就取 `at` 靠后的那个。
 *
 * 一条盖过章的都没有（横幅正常不会出现在这种任务上，手改文件能造出来）就退回
 * 追加：什么都不做的话，那颗按钮点了没反应。
 *
 * 纯函数：`now` 由调用方传。
 */
/**
 * 横幅上那颗「稍后」能推多久。**第一档是主按钮，其余收在旁边的小箭头里**——
 * 十分钟是绝大多数情况要的那一下（「马上就去，别现在烦我」），三档并排会让
 * 一个正在被打断的人多做一次选择。
 *
 * 三档的出处是 Things：
 *
 * > Can I snooze a reminder?
 * > Yes. You can snooze a reminder for 10, 30, or 60 minutes at a time.
 * >
 * > —— 《Setting a Reminder》
 *
 * 滴答那边这个时长是在设置里配的（《持续提醒》：「点击『稍后
 * 提醒』，可前往应用设置稍后提醒时长」）。**这儿不做成设置项**：那是一个
 * 只有一个读者的偏好，而三档摆出来比藏进设置里改一个数快得多。
 *
 * **第一档必须跟桌面通知上那颗一致**（`desktop/src/notify.ts` 的
 * `SNOOZE_MINUTES`）：同一个动作在两个壳里推的量不一样是坏数据。后两档只有
 * 网页有——Windows 的 toast 是一条转瞬即逝的横条，四颗按钮挤在上面比没有更糟，
 * 而且每一档都要在协议里多一个 action。那是**超集，不是分叉**。
 *
 * 跟 `POSTPONE_MINUTES` 仍然是两件事，见它上面那段。
 */
export const SNOOZE_CHOICES = [10, 30, 60] as const;

/** 按钮上怎么写。六十分钟写「1 小时」——「稍后 60 分钟」没人这么说话。 */
export const snoozeLabel = (minutes: number): string =>
  (minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`);

export function snoozePatch(t: Task, minutes: number, now: Date): { reminders: Reminder[] } {
  const rs = asArray<Reminder>(t.reminders);
  const at = new Date(now.getTime() + minutes * 60_000).toISOString();

  let best = -1;
  for (let i = 0; i < rs.length; i++) {
    const f = rs[i].firedAt ? Date.parse(rs[i].firedAt as string) : NaN;
    if (Number.isNaN(f)) continue;
    if (best < 0) { best = i; continue; }
    const bf = Date.parse(rs[best].firedAt as string);
    if (f > bf || (f === bf && Date.parse(rs[i].at) > Date.parse(rs[best].at))) best = i;
  }

  if (best < 0) return { reminders: [...rs, { at, firedAt: null }] };
  return { reminders: rs.map((r, i) => (i === best ? { at, firedAt: null } : r)) };
}
