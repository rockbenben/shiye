import type { Task } from '../types.js';
import { endOfDay } from './agenda.js';
import { isInTodayView, isSettled } from './taskView.js';
import { notStartedDeep } from './hierarchy.js';

/**
 * 「推荐任务」——今天该做什么，从**不在今天**的那些里挑几条值得看一眼的。
 *
 * 仿滴答清单「今天」右上角那颗灯泡。它那边的四组和判据（帮助文档原话）：
 * 最近添加（刚刚/今天/昨天加的、还没排时间）、多次修改时间（改过 2/3/5 次
 * 以上）、长时间未完成（建了 7/14/30 天还没做完）、即将到来（明天、后天到期）。
 * 这里的判据照抄，只是把它那三档阈值收成一档——一屏之内摆三个「超过 N 次」的
 * 子档，比直接给出「这几条拖得最久」多两次点击、少零点信息。
 *
 * **候选范围也照抄：无重复、非今天的未完成任务。** 重复任务排除是因为它天生
 * 会「一直存在」，`postponeCount`/`createdAt` 在它身上说明不了拖延；已经在
 * 「今天」里的排除是因为这个面板存在的意义就是「今天列表之外还有什么」。
 *
 * **纯函数**：不读时钟、不发请求。「加到今天」怎么改由调用方决定
 * （`reschedulePatch(t, 'today', now)`），这里只负责挑。
 */
export interface SuggestGroup {
  key: string;
  title: string;
  /** 一句话说清这一组为什么值得看——不写的话四个标题看着差不多。 */
  hint: string;
  tasks: Task[];
}

/**
 * 改过几次期算「一拖再拖」。滴答清单最低那档就是 2。
 *
 * **导出**是因为卡片上那个记号问的是同一个问题：这一条被推了几次、
 * 值不值得说一句。两处各写一个 2，将来调这个门槛只会改到一处，于是
 * 「建议面板里算一拖再拖、卡片上却不出声」——同一个判断两个答案。
 */
export const POSTPONE_MIN = 2;
/** 建了多久还没做完算「躺很久了」。滴答清单最低那档是 7 天。 */
const STALE_DAYS = 7;
/** 「最近添加」往回看几天。滴答清单是「刚刚 / 今天 / 昨天」，也就是两个日历日。 */
const RECENT_DAYS = 1;

const parseOr = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
};

/** 这条任务进不进候选池。`all` 是**完整的那一份**（`notStartedDeep` 要在
 *  里面找祖先）——这个面板拿到的一直是 App 的全量 tasks。 */
function isCandidate(t: Task, now: Date, all: Task[]): boolean {
  if (isSettled(t)) return false;
  // 重复任务天生「一直在」，拿创建时间和改期次数衡量它没有意义。
  if (t.repeat) return false;
  // **还没到开始时间的不推荐。** 这个面板的四组全都在说「这条你是不是忘了」
  // ——而一条设了开始时间的任务恰恰相反：他**记得**，而且明确说了「那天之前
  // 别管它」。把它捞出来问「要不要加到今天」，是在替他推翻自己刚做的决定，
  // 跟这个函数上面那条「已经了结的不进候选」是同一个道理。
  //
  // **判据是 `notStartedDeep` 不是 `notStarted`：父亲还没开始的，孩子现在也
  // 做不了。** 上面那段话对子任务同样成立——他给「装修」写了「9 月 1 日才
  // 开始」，就是在说底下那些活儿那天之前都别管。出处在 `hierarchy.ts` 的
  // `blockingAncestor`。
  if (notStartedDeep(t, now, all)) return false;
  // **在等别人的不推荐。** 跟上面那条同一个道理，只是理由更硬：一条写着
  // 「在等 张律师」的任务，他不但记得，而且**现在根本推不动**——下一步在别人
  // 手里。这四组问的是「这条你是不是忘了」，对它答案永远是「没忘」。
  //
  // Things 把这件事说得最直白（《How to Deal with Waiting To-Dos》）：
  //
  // > schedule the to-do for a future date… **This step is crucial because it
  // > gets these to-dos out of Today** (there's nothing you can do about them
  // > right now anyway)
  //
  // **只在这一屏排除，不动「今天」和四象限**——那两屏答的是「我盘子里有什么」，
  // 一条今天到期、在等人的任务确实在盘子里，把它藏掉是替他做决定。这一屏不同：
  // 它是主动捞东西出来问他，捞错了是纯粹的噪音。
  //
  // 顺带说清跟 Things 的差别：**它自己并不自动排除**，而是让人给这条任务设一个
  // 跟进日期，靠日期把它挤出 Today。那条路这里也走得通（`startAt` + 上面那条
  // `notStartedDeep`），这一条是额外加的一道——理由是上一段那个不对称。
  if (t.waitingFor) return false;
  return !isInTodayView(t, now);
}

/**
 * 四组，顺序照滴答清单帮助文档里的排法。
 *
 * **一条任务只进第一个符合的组。** 它那边四组是四个页面，重复出现没关系；
 * 这里四组摆在同一个面板里，同一张卡出现两次会让「加到今天」按两次——第二次
 * 是空操作，但看着像没生效。跟 `grouping.ts` 按标签分组不复制同一条理由。
 */
export function suggestGroups(tasks: Task[], now: Date): SuggestGroup[] {
  const pool = tasks.filter((t) => isCandidate(t, now, tasks));

  const recentFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - RECENT_DAYS).getTime();
  const staleBefore = new Date(now.getFullYear(), now.getMonth(), now.getDate() - STALE_DAYS).getTime();
  const dayAfterEnd = endOfDay(now, 2);
  const todayEnd = endOfDay(now, 0);

  const used = new Set<string>();
  const take = (pred: (t: Task) => boolean): Task[] => {
    const hit = pool.filter((t) => !used.has(t.id) && pred(t));
    for (const t of hit) used.add(t.id);
    return hit;
  };

  // 刚加进来、还没排时间的——「怕忘了那些随手记下但没安排的」。
  const recent = take((t) => {
    if (t.due || t.reminders.length > 0) return false;
    const born = parseOr(t.createdAt);
    return born !== null && born >= recentFrom;
  }).sort((a, b) => (parseOr(b.createdAt) ?? 0) - (parseOr(a.createdAt) ?? 0));

  // 一拖再拖的。次数多的排前面——这一组的信息量全在那个数字上。
  const postponed = take((t) => t.postponeCount >= POSTPONE_MIN)
    .sort((a, b) => b.postponeCount - a.postponeCount);

  // 明天、后天到期的——今天的活干完了还有余力时提前处理掉。
  // 下界用今天的末尾而不是 `now`：已经过期的不在这一组（那种不是「即将」，
  // 而且它们本来就已经在「今天」里，压根进不了候选池）。
  const upcoming = take((t) => {
    const due = parseOr(t.due);
    return due !== null && due > todayEnd && due <= dayAfterEnd;
  }).sort((a, b) => (parseOr(a.due) ?? 0) - (parseOr(b.due) ?? 0));

  // 建了很久还没做完的。老的排前面。**认领顺序排在「即将到来」之后**（跟
  // 下面 return 的展示顺序不一样，那个照滴答清单文档的排法）：一条三周前
  // 建的、明天到期的任务，两组都符合，但「明天到期」是此刻更有用的说法——
  // 说它「躺很久了」等于把一个具体的截止日期换成一句抱怨。
  const stale = take((t) => {
    const born = parseOr(t.createdAt);
    return born !== null && born < staleBefore;
  }).sort((a, b) => (parseOr(a.createdAt) ?? 0) - (parseOr(b.createdAt) ?? 0));

  return [
    { key: 'recent', title: '最近添加', hint: '刚记下来、还没排时间的', tasks: recent },
    { key: 'postponed', title: '一拖再拖', hint: `改过 ${POSTPONE_MIN} 次以上期的`, tasks: postponed },
    { key: 'stale', title: '躺很久了', hint: `建了 ${STALE_DAYS} 天以上还没做完的`, tasks: stale },
    { key: 'upcoming', title: '即将到来', hint: '明天、后天到期的', tasks: upcoming },
  ].filter((g) => g.tasks.length > 0);
}
