import type { Task } from '../types.js';

/**
 * 「最近这一阵的进出」——完成的、新进来的，和两者的差。
 *
 * ## 它补的是这个应用唯一没覆盖的那个维度
 *
 * 这个应用**极擅长报债**：卡片上红着「过期 3 天」、头上那行写
 * 「12 条（9 条已过期） · 预计 4 小时 30 分」（`workload.ts`）、回顾那一屏列
 * 「这一周该过一遍的」、卡住的项目、搁了 97 天的……到处都是「你还欠多少」。
 *
 * **但它从来不报还债。** 没有任何地方回答过「我是在追上，还是在落后」——
 * 而那恰恰是唯一一个决定「我还要不要继续用这个东西」的问题。
 *
 * 素材一直都在：`completedAt` 是服务端盖的章（`mutate.ts` 的状态迁移里），
 * `createdAt` 从第一条任务起就有。只是从来没有人把这两个数放在一起过。
 *
 * 为什么这条尤其该有：`ReviewView` 自己写着一句「**一份劝不动你的清单，久了
 * 就整份不再被当真**，而这一屏存在的全部意义就是被当真」。只报债不报还债
 * 正是那件事的另一个版本——所以这一节跟「卡住的项目」是同一类东西：
 * **从任务本身现算出来的结构性事实，不是 AI 产出的观察**（所以一个群青都
 * 不上、不花一次 AI 额度、不用等「让 AI 回顾一遍」）。
 *
 * ## 为什么是「最近 7 天」而不是「本周」
 *
 * 日历周在周一早上只有一个小时的样本：那时报「这周完成 0 条，新进来 3 条」，
 * 数字是对的、意思是错的——它看起来像「你什么都没干」，而其实只是这一周
 * 刚开始。滚动 7 天**永远是一整周的样本**，什么时候打开都是同一个口径。
 * （跟专注统计那三档（今天/本周/本月）不冲突：那边量的是「花了多久」，看的是
 * 一个自然的日历边界；这边量的是「进出平衡」，要的是一个稳定的窗口。）
 *
 * ## 口径：两个数都不含已经删掉的
 *
 * 删除是**软删除**，任务进了 `data/trash/`，不在 `data/tasks/` 里了
 * （见 `AGENTS.md` 的文件表）——所以「这周新进来」不包含「建了又删掉」的那些，
 * `net` 因此**偏向乐观**。这一条不修（读 `trash/` 能把数补准，但那份数据在
 * 前端是按需拉的、可能滞后，拿一个可能滞后的数去修一个精确的数，得到的还是
 * 一个会飘的数），改成在界面上把那句口径说出来：**宁可让人知道这个数不含什么，
 * 也不要让它看起来比实际准**。
 *
 * 同理，「完成」数的是**现在这个任务集里还盖着章的那些**：一条做完之后又被
 * 重新打开的，`completedAt` 会被服务端清掉（`mutate.ts` 同一条状态迁移），
 * 于是它从这一周里消失。这不是事件日志，是**当前数据的投影**——够回答
 * 「我在追上还是在落后」，但别拿它当账本。
 *
 * 纯函数，不读时钟（`now` 由调用方传）。
 */
export interface Throughput {
  /** 最近这一阵里完成的条数。 */
  done: number;
  /** 最近这一阵里新进来的条数。 */
  added: number;
  /** `done - added`。正数 = 债在少，负数 = 债在多。 */
  net: number;
}

/**
 * 窗口长度，天。
 *
 * 七天：`REVIEWED_QUIET_DAYS` 那一套（7 天）和「每周回顾」这个节奏都落在这个
 * 数上，而它同时是一整周的样本——再短会让人一天一个心情，再长则迟钝到看不出
 * 变化。**跟 `REVIEWED_QUIET_DAYS` 是两个概念**（那个量的是「他上次亲自看过
 * 这条任务是什么时候」），只是碰巧同值，别顺手合成一个常量。
 */
export const THROUGHPUT_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

/** 解析 ISO 时刻；解析不了返回 null（`data/tasks/` 是手改得到的文件）。 */
function parseOr(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
}

export function throughput(tasks: Task[], now: Date): Throughput {
  const from = now.getTime() - THROUGHPUT_DAYS * DAY;
  const to = now.getTime();

  let done = 0;
  let added = 0;
  for (const t of tasks) {
    // **只认落在窗口里的那些**，将来时刻不算：手改文件能造出 `completedAt`
    // 在明天的条目，把它算进「最近 7 天」会让这一节报一个未来的功劳。
    const c = parseOr(t.completedAt);
    if (c !== null && c >= from && c <= to) done += 1;
    const b = parseOr(t.createdAt);
    if (b !== null && b >= from && b <= to) added += 1;
  }

  return { done, added, net: done - added };
}

/**
 * 这一节那句话。`net` 带符号——**符号本身是这一节要说的那件事**，
 * 不写成「净 8 条」然后靠颜色区分：颜色是扫一眼才知道的，正负号是读出来的。
 *
 * 两个数都是 0 时返回空串（这一节整段不渲染）：一份「完成 0 条、新进来 0 条」
 * 的报告对一个这周没碰过这个应用的人来说是每天都要看的一句废话，跟
 * `workload.ts` 里「一条都没估过时整句不出」是同一条规矩。
 */
export function throughputLabel(t: Throughput): string {
  if (t.done === 0 && t.added === 0) return '';
  // 0 不带符号：`+0` / `−0` 都是句怪话，而「净 0 条」本身就是它要说的事
  // （进出刚好持平）。
  const net = t.net === 0 ? '净 0 条' : `净 ${t.net > 0 ? '+' : '−'}${Math.abs(t.net)} 条`;
  return `完成 ${t.done} 条 · 新进来 ${t.added} 条 · ${net}`;
}
