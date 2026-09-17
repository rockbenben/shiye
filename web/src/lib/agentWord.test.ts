import { describe, it, expect } from 'vitest';
import { agentWord } from './agentWord.js';
import type { AgentStatus } from '../api.js';

/**
 * AI 那四件事在界面上叫什么。
 *
 * 这一族守的是**四件事各自叫对了名字**——而这件事原来没有任何东西盯着：
 * `App.tsx` 里那处标题是一串嵌套三元表达式，`expand` 恰好是缺省分支，
 * 所以漏掉它最不容易发现；而同一个文件里还有一句写死的「AI 拆解中……」，
 * 回顾跑着也写着「拆解」。
 *
 * 名字写错不会报错、不会让别的测试变红——只会让屏幕上出现一个错名字，
 * 而那正是这个文件存在的理由。
 */
describe('agentWord：四件事各自的名字', () => {
  it('四种 kind 都在，而且互不相同', () => {
    const kinds = ['expand', 'review', 'board', 'breakdown'] as const;
    const names = kinds.map((k) => agentWord(k).name);
    expect(names).toEqual(['拆解', '回顾', '总览', '拆细']);
    expect(new Set(names).size, '两个 kind 共用一个名字，界面上就分不出是哪件事').toBe(4);
  });

  /**
   * **`kind` 缺省时按拆解回退。** 缺省的两种情形（`autoExpand` 的排期信号、
   * 服务启动时补合并历史坏文件的那条状态）都是拆解那条路上的东西——回退到
   * 拆解是对的，不是随便挑一个。
   */
  it('kind 不给时按拆解回退', () => {
    expect(agentWord(undefined)).toEqual(agentWord('expand'));
  });

  it('每一档的四个字段都不空——空字符串会渲染成一条没有标题的横幅', () => {
    for (const k of ['expand', 'review', 'board', 'breakdown'] as const) {
      const w = agentWord(k);
      for (const [field, v] of Object.entries(w)) {
        expect(v, `${k}.${field} 是空的`).toBeTruthy();
      }
    }
  });

  /**
   * **`running` 跟 `name` 是两回事。** `AI 总览失败` 读得通，`AI 总览中……`
   * 读起来像半句话——那件事在跑的时候该说的是「在汇总」。这条钉的是
   * 「两栏没有偷懒共用一个值」。
   */
  it('board 的进行时是「汇总中」，不是「总览中」', () => {
    expect(agentWord('board').running).toBe('汇总中');
    expect(agentWord('board').running).not.toBe(agentWord('board').name);
  });

  /**
   * **`ok` 单独一栏是因为 board 不一样**：它的「产物」就是那段汇报文本本身
   * （`agent.message`），标题再写「AI 总览完成」是同一句话说两遍。别的三件
   * 产出的东西都在别处（新卡片、卡片上的建议），标题必须说「结束了、去看吧」。
   */
  it('只有 board 的 ok 不带「完成」——它的产物就是那段文本本身', () => {
    expect(agentWord('board').ok).toBe('AI 总览');
    for (const k of ['expand', 'review', 'breakdown'] as const) {
      expect(agentWord(k).ok, `${k} 的 ok 得说清「结束了」`).toMatch(/完成$/);
    }
  });

  /**
   * **`none` 那一档是「跑完了但没产出」，四件事各自该说的实话不一样。**
   * 尤其是 `breakdown`：他点「拆细」是因为觉得这条太粗，而 AI 看完认为它
   * 已经够具体了——**那是好消息，不是坏消息**，说成「没有新增任务」会让他
   * 以为自己点错了按钮。
   */
  it('breakdown 那一档说的是拆细，不是「没有新增任务」', () => {
    expect(agentWord('breakdown').none).toContain('拆细');
    expect(agentWord('breakdown').none).not.toBe(agentWord('expand').none);
  });

  /** 类型对得上 `AgentStatus.kind`——将来加第五种时这一行会红，
   *  提醒去把四个字段补齐（`Record<...>` 本身也会拦，这里钉的是那个联合类型
   *  确实被当成键用了，而不是某天被放宽成 `string`）。 */
  it('键集合跟 AgentStatus.kind 的四种取值一一对应', () => {
    const kinds: Array<NonNullable<AgentStatus['kind']>> = ['expand', 'review', 'board', 'breakdown'];
    expect(kinds.map((k) => agentWord(k).name)).toHaveLength(4);
  });

  /**
   * **认不出来的 `kind` 不许抛。**
   *
   * 类型说它只会是那四种，但它是**从服务端那条 SSE 载荷来的**，运行时不受
   * 类型约束：手机那个壳把前端打包进了 APK，一个装了很久没更新的 APK 对着一个
   * 新服务，收到的就是它这一版不认识的第五种。而四个调用点全都紧跟着
   * `.name` / `.ok` / `.none`——查表查出 `undefined` 就是当场抛，整棵 App 白屏。
   *
   * **为一句横幅文案白屏不值得**，而且这恰恰是改这个文件之前那串嵌套三元的
   * 老行为（最后那个 else 是 '拆解'）：认不出来就按拆解说。
   *
   * 用 `as` 硬塞一个不在联合里的值，是这条测试唯一能构造出那种输入的办法。
   */
  it('认不出来的 kind 按拆解回退，不抛', () => {
    const alien = 'summarize' as unknown as NonNullable<AgentStatus['kind']>;
    expect(() => agentWord(alien)).not.toThrow();
    expect(agentWord(alien)).toEqual(agentWord('expand'));
  });
});
