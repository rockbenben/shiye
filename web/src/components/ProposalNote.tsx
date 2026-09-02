import { useState } from 'react';
import { App as AntApp, Button } from 'antd';
import type { List, Proposal, Repeat, Task } from '../types.js';
import { formatWhen } from '../lib/taskView.js';
import { PRI_LABEL_ALL } from './TaskFields.js';
import { describeRepeat } from './RepeatFields.js';

/**
 * 提议要穿过两个视图（今天／按来源）才到得了任务卡，打成一个 prop 传，
 * 不是三个各传各的——两个视图各多三个参数，加起来六处签名，改一处漏一处。
 *
 * `byTask` 是调用方（App）预先分好组的 Map：每张卡各自 `filter` 一遍全量数组
 * 是 O(卡数 × 提议数)，虽然这个体量下无所谓，但分组本来就该只做一次。
 */
export interface ProposalWiring {
  byTask: Map<string, Proposal[]>;
  onAccept: (id: string) => Promise<unknown>;
  onDismiss: (id: string) => Promise<unknown>;
}

export function groupProposals(ps: Proposal[]): Map<string, Proposal[]> {
  const out = new Map<string, Proposal[]>();
  for (const p of ps) out.set(p.taskId, [...(out.get(p.taskId) ?? []), p]);
  return out;
}

/**
 * 这条任务是不是还挂着至少一条未处理的 AI 建议——`TaskRow.hasProposal`
 * 那颗待决建议记号（`.ink-trow-proposal`）的判据。`TaskGrid.tsx` 和
 * `TodayView.tsx` 的行档都要算这件事，提成这一个共用函数：以前
 * `TodayView.tsx` 自己复制了一份一模一样的表达式，没有任何测试跟过去
 * （整分支审查 B1），现在只有这一份实现，只需要守这一份。
 */
export function hasPendingProposal(proposals: ProposalWiring | undefined, taskId: string): boolean {
  return (proposals?.byTask.get(taskId)?.length ?? 0) > 0;
}

/** patch 里的字段名 → 界面上叫什么。跟卡片上、编辑表单里用的是同一批词——
 * `PROPOSABLE`（server/src/task.ts）十个字段这里全都要有一条，漏一个就会有
 * 一条提议卡片上冒出裸英文字段名。 */
// **这份表必须盖住服务端 `PROPOSABLE` 的每一个字段**：漏一个，AI 提了那个
// 字段的建议时，卡片上就冒出一个裸英文键名。两边在不同的包里、只能手工对齐，
// 靠 ProposalNote.test.tsx 里那条测试盯着不飘。
const FIELD_LABEL: Record<string, string> = {
  title: '标题', notes: '备注', due: '截止', startAt: '开始', reminders: '提醒', subtasks: '子任务',
  priority: '优先级', tags: '标签', listId: '清单', repeat: '重复', waitingFor: '在等', context: '情境',
};

/**
 * 一个字段值渲染成一行字。时间走 `formatWhen`（跟卡片上同一个格式），
 * 子任务只报条数——把五条子任务的全文塞进提议块里，人看的是「改了什么」，
 * 不是在这儿逐条读新内容。
 */
/**
 * 一段文字在等宽字体里占多宽，单位是「一个西文字符」。汉字（含全角标点）
 * 算 2，其余算 1——按 `length` 算的话，两个 16 字符的时间戳（32）会跟一段
 * 16 个汉字的备注（也是 32，实际占 64）判成一样长，时间戳会被莫名其妙地
 * 摞成三行。这个判据只用来决定排版形态，不追求跟真实像素严丝合缝。
 */
const width = (s: string): number =>
  [...s].reduce((n, ch) => n + (/[⺀-鿿豈-﫿＀-｠　-〿]/.test(ch) ? 2 : 1), 0);

/**
 * 一个字段值渲染成一行字。
 *
 * `clip` 只对**旧值**开：旧值是给你对照用的，而且它本来就在上面那张卡片上
 * 原样摆着，截断不丢信息。**新值一律完整显示**——点「接受」应用的是完整内容，
 * 让你批准一段自己看不全的文字是不能接受的（AI 提的备注很容易超过一行，
 * 实测第一个真实例子就撞上了）。
 */
function show(field: string, v: unknown, lists: List[], clip = false): string {
  if (v === null || v === undefined || v === '') return '空';
  if (field === 'due') return formatWhen(String(v));
  // **全部列出来，不是只显示第一条。** 这段原来只取 `v[0]`——那时候表单只
  // 编辑得了一个提醒，「第一条」等于「全部」。现在一条任务可以有好几个提醒了
  // （见 TaskFields 那串选择器），只显示第一条就等于让人批准一份自己看不全的
  // 改动，而这个函数上面那段注释立的规矩正是「新值一律完整显示」。
  if (field === 'reminders') {
    const times = (Array.isArray(v) ? v : [])
      .map((r) => (r as { at?: unknown })?.at)
      .filter((at): at is string => typeof at === 'string')
      .map((at) => formatWhen(at));
    return times.length > 0 ? times.join('、') : '空';
  }
  // 下面三个是这一批（可编辑字段）新加的——用的是跟卡片/编辑表单同一套
  // helper（PRI_LABEL、describeRepeat），不是重新发明一套渲染规则。
  if (field === 'priority') return PRI_LABEL_ALL[v as 0 | 1 | 2 | 3] ?? PRI_LABEL_ALL[0];
  if (field === 'repeat') return describeRepeat(v as Repeat);
  if (field === 'listId') return lists.find((l) => l.id === v)?.name ?? '（清单已删）';
  const s = String(v);
  return clip && s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 子任务列表渲染成一行一条，勾过的前面带 ✓。
 *
 * **不能只报条数。** 原来这里是 `${v.length} 条`，于是「AI 把三步重新拆成
 * 另外三步」渲染出来是 `子任务 3 条 → 3 条`——看上去什么都没变，而点下「接受」
 * 会把整个数组换掉：你已经勾掉的那两步连同它们的文字一起消失，没有撤销
 * （提议行被删了，tasks.json.bak 是唯一的副本）。AGENTS.md 让 AI 写
 * `done: false`，所以「勾选状态被清空」是这条路径上的常态，不是边缘情况。
 * 一条建议必须让人看清自己批准的是什么。
 */
function subtaskLines(v: unknown): string[] {
  if (!Array.isArray(v)) return [String(v)];
  if (v.length === 0) return ['空'];
  return v.map((s) => {
    const o = (typeof s === 'object' && s !== null ? s : {}) as { text?: unknown; done?: unknown };
    return `${o.done ? '✓ ' : '☐ '}${String(o.text ?? '')}`;
  });
}

/**
 * AI 对一条任务提的修改建议，渲染在它对应的那张卡里。
 *
 * 用**边注那一套视觉语言**（群青、衬线、左边一条虚线）：它跟 `aiComment` 是
 * 同一类东西——另一个人写的话。不新造第三套记号。
 *
 * 接受之后卡片上那个字段就是你的墨了，不留「这是 AI 建议的」的痕迹——你点了，
 * 它就是你的决定。见 2026-08-12-ai-proposals.md。
 */
export function ProposalNote({ p, task, lists, onAccept, onDismiss }: {
  p: Proposal;
  /** 拿来显示「从什么变成什么」的旧值。 */
  task: Task;
  /** 解 `listId` 用——找不到（清单被删了）就说「（清单已删）」，不显示裸 uuid。
   * TaskCard 自己已经有这份候选表，直接往下传，不重新拉数据。 */
  lists: List[];
  onAccept: (id: string) => Promise<unknown>;
  onDismiss: (id: string) => Promise<unknown>;
}) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);

  const run = async (kind: 'accept' | 'dismiss', fn: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      // 成功之后也要复位。正常情况下这条提议会因为 proposals.json 变化
      // → watcher → SSE → refetch 从列表里消失、组件跟着卸载，复位与否看不出
      // 区别；但 events.ts 明说监听器可能中断（「数据目录监听中断，网页不会再
      // 自动刷新」）而服务照常提供服务。那种状态下不复位的话，两颗按钮会永远
      // 停在禁用+转圈上，提议还挂在一张其实已经改完的卡上面——跟卡死一模一样，
      // 既退不出也重试不了。同一批加进来的 TaskCard、TaskComposer 都用的
      // finally，只有这里当时特意不用，那个判断是错的。
      setBusy(null);
    }
  };

  const fields = Object.keys(p.patch);

  return (
    <div className="ink-proposal">
      <span className="ink-margin-who">AI 的建议</span>
      {/* 「从什么变成什么」都要写出来——只写新值等于要你自己回想旧值是什么。
          时间、条数这类短值一行摆得下，行内写「旧 → 新」最好读；标题和备注
          是整段文字，挤在一行里会连着删除线一起折行、跟新值绞成一团（实测
          就是这样），那种就上下摞开。判据看渲染出来的长度，不看字段名——
          一条只有五个字的备注没必要占三行。 */}
      <ul className="ink-proposal-diff">
        {fields.map((f) => {
          const oldV = (task as unknown as Record<string, unknown>)[f];
          const newV = (p.patch as unknown as Record<string, unknown>)[f];

          // 子任务单独走多行渲染，见 subtaskLines 的注释。
          if (f === 'subtasks') {
            return (
              <li key={f} className="ink-proposal-stacked">
                <span className="ink-proposal-field">{FIELD_LABEL[f]}</span>
                <span className="ink-proposal-was">
                  {subtaskLines(oldV).map((t, i) => <span key={i} className="ink-proposal-sub">{t}</span>)}
                </span>
                <span className="ink-proposal-arrow">↓</span>
                <span className="ink-proposal-now">
                  {subtaskLines(newV).map((t, i) => <span key={i} className="ink-proposal-sub">{t}</span>)}
                </span>
              </li>
            );
          }

          const was = show(f, oldV, lists, true);
          const now = show(f, newV, lists);
          // 52 个西文字符宽：卡片正文宽 38em、这一行 11px 等宽字，一行大约
          // 装得下 90 个，减去字段名和箭头，留 52 给两个值有余量。两个时间戳
          // 加起来 32，稳稳留在一行；一段中文备注一超就摞开。
          const stacked = width(was) + width(now) > 52;
          return (
            <li key={f} className={stacked ? 'ink-proposal-stacked' : undefined}>
              <span className="ink-proposal-field">{FIELD_LABEL[f] ?? f}</span>
              <span className="ink-proposal-was">{was}</span>
              <span className="ink-proposal-arrow">{stacked ? '↓' : '→'}</span>
              <span className="ink-proposal-now">{now}</span>
            </li>
          );
        })}
      </ul>
      <p className="ink-proposal-reason">{p.reason}</p>
      <div className="ink-proposal-actions">
        <Button size="small" loading={busy === 'accept'} disabled={busy !== null} onClick={() => void run('accept', () => onAccept(p.id))}>
          接受
        </Button>
        <Button size="small" type="text" loading={busy === 'dismiss'} disabled={busy !== null} onClick={() => void run('dismiss', () => onDismiss(p.id))}>
          忽略
        </Button>
      </div>
    </div>
  );
}
