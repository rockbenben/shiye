import type { List, SmartFilter } from '../types.js';
import { asArray } from './taskView.js';
import { normalizeFilter } from './smartFilter.js';

/**
 * 一份筛选条件 → 一句人话。什么都没筛返回 `null`（调用方整段不渲染）。
 *
 * 两个地方要它，而两处缺的是同一样东西：
 *
 * - **筛选栏**：七个下拉加两个开关，拼起来到底筛的是什么，只能靠一个个看回去。
 *   跟重复规则那一排下面那句预览是同一件事（`RepeatFields` 的
 *   `.ink-repeat-preview`）。
 * - **侧栏里的智能清单**：它只有一个名字。一份存下来的查询叫「紧急」，那到底
 *   是「高优先级」还是「三天内到期」还是两者都要？不打开编辑器就不知道，而
 *   打开编辑器要点两下、还得记住原样退出。
 *
 * **不重造一遍那几张文案表**：状态、优先级的字面都从既有出处传进来（调用方
 * 给 `labels`），清单名从 `lists` 现查。这个模块只管怎么把它们连成一句话。
 *
 * 纯函数，不读时钟、不认识 React。
 */

export interface FilterLabels {
  /** 状态值 → 中文。`STATUS_LABEL`（TaskCard）那一份。 */
  status: Record<string, string>;
  /** 优先级 0-3 → 中文。`PRI_LABEL`（TaskFields）那一份加上「无」。 */
  priority: Record<number, string>;
  /** 情境 → 中文。`CONTEXT_LABEL`（lib/taskView.ts）那一份。 */
  context: Record<string, string>;
}

/** 组与组之间用「，或者」连——跟筛选栏上那颗「+ 或者…」按钮说的是同一个词。 */
const OR_JOIN = '，或者';
/** 一组之内各维度用「·」连：它们是「且」，而中文里没有一个短到能反复出现的
 *  「且」字连接符，点号是列表类界面的通用做法。 */
const AND_JOIN = ' · ';

function describeGroup(f: SmartFilter, lists: List[], labels: FilterLabels): string {
  const parts: string[] = [];
  const status = asArray<string>(f.status);
  if (status.length > 0) parts.push(status.map((s) => labels.status[s] ?? s).join('/'));

  // 清单：名字查得到就用名字，查不到（删掉了、或者手改文件写了个不存在的 id）
  // 就说「某个清单」——不印一个裸 uuid 出来，那对人没有任何意义。
  const listNames = asArray<string>(f.listIds).map((id) => lists.find((l) => l.id === id)?.name ?? '某个清单');
  if (f.noList) listNames.push('不属于任何清单');
  if (listNames.length > 0) parts.push(listNames.join('/'));

  const tags = asArray<string>(f.tags).map((t) => `#${t}`);
  if (f.noTag) tags.push('没有标签');
  if (tags.length > 0) {
    // 「都要有」只在真的选了不止一个标签时才说——一个标签时「任一」和「全部」
    // 是同一件事，多这三个字只会让人以为自己漏看了什么。跟筛选栏里那个开关
    // 只在 tags.length > 1 时才出现是同一条判据。
    parts.push(tags.join('/') + (f.tagsAll && asArray<string>(f.tags).length > 1 ? '（都要有）' : ''));
  }

  const pri = asArray<number>(f.priority);
  if (pri.length > 0) parts.push(pri.map((p) => labels.priority[p] ?? String(p)).join('/'));

  // 情境。查不到中文名就印原值——跟状态那一维同一条：一份手改进来的、
  // 或者旧版本存下的值，宁可露出它本来的样子，也别悄悄从这句话里消失。
  const ctx = asArray<string>(f.contexts);
  if (ctx.length > 0) parts.push(ctx.map((c) => labels.context[c] ?? c).join('/'));

  // 「没有时间」，不是「没有日期」——「接下来」的第六组、看板按时间分列时那一列
  // 都叫这个，而 `due` 在编辑表单里的名字就是「截止时间」。同一个东西在三处
  // 不能有两个名字。
  if (f.noDue) parts.push('没有时间');
  if (typeof f.dueWithinDays === 'number') parts.push(`${f.dueWithinDays} 天内`);
  if (f.hasWaitingFor) parts.push('在等别人');
  if (f.isRepeating) parts.push('重复的');
  if (f.notStarted) parts.push('还没开始');
  // 「预计 ≤ 20 分钟」而不是「20 分钟内」——后者跟上面那句「7 天内」摆在一起
  // 会被读成两个时间窗口，而这一维说的是工作量不是日期。
  if (typeof f.estimateWithinMinutes === 'number') parts.push(`预计 ≤ ${f.estimateWithinMinutes} 分钟`);
  const text = (f.text ?? '').trim();
  if (text) parts.push(`含「${text}」`);
  return parts.join(AND_JOIN);
}

export function describeFilter(raw: SmartFilter, lists: List[], labels: FilterLabels): string | null {
  // 跟 applyFilter/isFilterEmpty 同一条：存下来的筛选可能缺字段，缺了就是白屏。
  // 判据和理由都在 smartFilter.ts 的 normalizeFilter。
  const f = normalizeFilter(raw);
  const groups = [f, ...asArray<SmartFilter>(f.or)]
    .map((g) => describeGroup(g, lists, labels))
    .filter((s) => s !== '');
  // 「排除」组也要说出来。**不说的后果是屏幕上少了一批任务、而顶上那句话
  // 一个字都没提为什么**——这一整句存在的理由就是「现在到底在筛什么」有个
  // 地方看得见，漏掉减法那一半等于只说了一半。
  const excluded = asArray<SmartFilter>(f.not)
    .map((g) => describeGroup(g, lists, labels))
    .filter((s) => s !== '');
  const head = groups.length === 0 ? null : groups.join(OR_JOIN);
  if (excluded.length === 0) return head;
  const tail = `不要：${excluded.join(OR_JOIN)}`;
  // 一份只有排除组的筛选（「全部，但不要 #工作」）——前半句是「全部」，
  // 而它确实在筛，不能返回 null（那是「什么都没筛」的信号，筛选栏会收起来）。
  return head === null ? `全部，${tail}` : `${head}，${tail}`;
}
