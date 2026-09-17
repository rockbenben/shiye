import type { AgentStatus } from '../api.js';

/**
 * AI 那四件事，各自在界面上叫什么。**一份，不散在四处。**
 *
 * ## 它取代的是一串嵌套三元表达式
 *
 * 加「拆细」（`breakdown`）这一种时，`App.tsx` 里那处标题映射是
 * `agent.kind === 'review' ? … : agent.kind === 'board' ? … : '拆解'` 三处嵌套，
 * 而**同一个文件里还有一句写死的「AI 拆解中……」**——两处各写各的，加一种
 * 就得记得改两处。
 *
 * 漏改的后果不是报错，是**给一件事安上另一件事的名字**：回顾跑完顶着
 * 「AI 拆解完成」，拆细跑着写着「AI 拆解中」。而 `expand` 恰好是那个缺省
 * 分支，所以最不容易发现的就是它。
 *
 * ## 为什么 `ok` 单独给一句
 *
 * `board` 不一样：它的「产物」就是那段汇报文本本身（`agent.message`），标题
 * 再写「AI 总览完成」是同一句话说两遍。别的三件产出的东西都在别处（新卡片、
 * 卡片上的建议），标题必须说「结束了、去看吧」。
 *
 * `name` 和 `running` 分开也是这个原因：`AI 总览失败` 读得通，`AI 总览中……`
 * 读起来像半句话——那件事在跑的时候该说的是「在汇总」。
 *
 * ## `kind` 缺省时按拆解回退
 *
 * `scheduled`/`idle` 是 `autoExpand` 的排期信号、不挂 kind；服务启动时补合并
 * 历史坏文件的那条状态也没有 kind（那时候没有「这一次运行」）。两种都是拆解
 * 那条路上的东西，回退到拆解是对的，不是随便挑一个。
 */
export interface AgentWord {
  /** 名词。「AI {name}失败」。 */
  name: string;
  /** 进行时。「AI {running}……」。 */
  running: string;
  /** `skipped` 那一档：没出错，但也没有产出，得说清为什么。 */
  none: string;
  /** `ok` 那一档的横幅标题。 */
  ok: string;
}

const WORDS: Record<NonNullable<AgentStatus['kind']>, AgentWord> = {
  expand: { name: '拆解', running: '拆解中', none: '没有新增任务', ok: 'AI 拆解完成' },
  review: { name: '回顾', running: '回顾中', none: '没有新的建议', ok: 'AI 回顾完成' },
  board: { name: '总览', running: '汇总中', none: '没有产出汇报', ok: 'AI 总览' },
  breakdown: { name: '拆细', running: '拆细中', none: '没有拆细建议', ok: 'AI 拆细完成' },
};

export function agentWord(kind: AgentStatus['kind']): AgentWord {
  // **`kind` 是从服务端来的，运行时不保证落在上面那张表里。** 类型说它只会是
  // 那四种，但那条 SSE 载荷是别的东西发过来的——手机那个壳把前端打包进了 APK，
  // 一个装了很久没更新的 APK 对着一个新服务，收到的 `kind` 就是它这一版不认识的
  // 第五种。不加这一道的话 `WORDS[kind]` 是 `undefined`，而上面四个调用点全都
  // 紧跟着 `.name` / `.ok` / `.none`——当场抛，整棵 App 白屏。
  //
  // **为一句横幅文案白屏不值得**，而且这正是改这个文件之前那串嵌套三元的
  // 老行为（最后那个 else 是 '拆解'）：认不出来就按拆解说。
  const w = kind === undefined ? undefined : (WORDS as Record<string, AgentWord | undefined>)[kind];
  return w ?? WORDS.expand;
}
