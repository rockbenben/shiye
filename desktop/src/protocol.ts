import { PROTOCOL, SNOOZE_MINUTES } from './notify.js';

/**
 * `main.ts` 引 `electron`，进不了 vitest（`electron` 在纯 Node 环境下
 * `require` 出来的是可执行文件路径字符串，不是 API 对象——main.test.ts
 * 顶部注释里记着）。这个文件不 import 一行 `electron`：toast 按钮那条
 * 协议激活链路里，真正有分支、有逻辑、值得测的三件事（URI 怎么解析、
 * 「完成/推迟」各自要发什么 patch、argv 该走哪条路）都不需要 Electron，
 * 抽到这里之后是真的能跑、能测到底的代码，不用再靠 main.ts 里的源文本
 * 正则去猜它的行为——那类猜测被两种真实的改坏绕过去过（换个名字做同一件
 * 事、用一行诱饵注释顶替正则的第一次命中，见 task-2-report.md 修复轮 2），
 * 根因是「猜」这件事本身不可靠，不是正则不够聪明。
 */

export type ProtocolAction = 'complete' | 'snooze';

export interface ParsedProtocolUri {
  kind: ProtocolAction;
  id: string;
}

/**
 * 解析 toast 按钮的协议 URI（`todo-desktop://complete?id=…` /
 * `todo-desktop://snooze?id=…`）。不是合法 URL、不是这个协议、
 * `hostname` 不认识、没有 `id`、`id` 是空串——一律返回 `null`，不抛：
 * 这条路上的输入理论上都该是我们自己拼的（见 notify.ts buildToastXml()），
 * 但协议激活这条链路完全没法在这个沙盒里实测，防的是「万一」。
 */
export function parseProtocolUri(uri: string): ParsedProtocolUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;
  if (url.hostname !== 'complete' && url.hostname !== 'snooze') return null;
  const id = url.searchParams.get('id');
  if (!id) return null;
  return { kind: url.hostname, id };
}

/** 任务上一条提醒的形状。只取这两个字段——这个模块不需要认识整个 `Task`。 */
export interface ReminderLike {
  at: string;
  firedAt: string | null;
}

/**
 * 「完成」/「推迟」两个按钮各自要发给 `PATCH /api/tasks/:id` 的 body。
 * **`now` 是参数，不是内部读时钟**——调用方（真代码传 `new Date()`，
 * 测试传固定时间）自己决定，这样测试能钉死 `at` 的具体值，不用容忍时间
 * 误差、也不用 mock 全局时钟。
 *
 * ## 推迟：挪刚响过的那一条，别的原样留着
 *
 * 这里原来是「整个替换掉 reminders 数组」，注释写着「多提醒同时挂在一条任务上
 * 是少见场景……等真的有人反馈『推迟之后别的提醒也被吃了』再补」。**现在补了**
 * ——不是因为有人反馈，是因为网页那半边这一轮改成了「挪刚响的那条」
 * （`web/src/lib/reschedule.ts` 的 `snoozePatch`）：同一颗写着「推迟 10 分钟」
 * 的按钮，在网页上只动一条、在系统通知上把这条任务的提醒全清成一条，**同一个
 * 名字下面两种行为，而且其中一种在删数据**。
 *
 * 判据跟那边一字不差：`firedAt` 最新的那条就是刚把这条通知推出来的那条；
 * 同一轮扫描盖了两条章就取 `at` 靠后的；一条盖过章的都没有就追加。
 * **没有 import 过来共用一份**：desktop 这个包是 `tsc` 直接编译到 `dist/`，
 * 跨包引 `web/src` 会顶到 `rootDir` 上；跟 `SNOOZE_MINUTES` 那个常量不共用是
 * 同一类取舍，代价也一样——漂了的后果是两个壳各自自洽地推了不同的东西。
 *
 * `existing` 不给（`null`/`undefined`，取任务失败时）就退回原来那条老路：
 * 发一条、覆盖掉。取不到就宁可少留几条提醒，也不能不响——那颗按钮点了必须有事
 * 发生。
 */
export function patchForAction(
  action: ProtocolAction, now: Date, existing?: ReminderLike[] | null,
): Record<string, unknown> {
  if (action === 'complete') return { status: 'done' };
  const at = new Date(now.getTime() + SNOOZE_MINUTES * 60_000).toISOString();
  if (!Array.isArray(existing)) return { reminders: [{ at, firedAt: null }] };

  let best = -1;
  for (let i = 0; i < existing.length; i++) {
    const f = existing[i].firedAt ? Date.parse(existing[i].firedAt as string) : NaN;
    if (Number.isNaN(f)) continue;
    if (best < 0) { best = i; continue; }
    const bf = Date.parse(existing[best].firedAt as string);
    if (f > bf || (f === bf && Date.parse(existing[i].at) > Date.parse(existing[best].at))) best = i;
  }

  if (best < 0) return { reminders: [...existing, { at, firedAt: null }] };
  return { reminders: existing.map((r, i) => (i === best ? { at, firedAt: null } : r)) };
}

export type SecondInstanceRoute = { kind: 'protocol'; uri: string } | { kind: 'open' };

/**
 * `app.on('second-instance', …)` 收到的 argv、冷启动的 `process.argv`，
 * 形状都是字符串数组——用同一个函数判断「这次启动是协议激活，还是普通
 * 重复启动/双击」，两条路因此天然一致，不用靠注释保证「两处判断得一样」。
 * 多个协议 URI 时取 `Array#find` 天然给的第一个，不特殊处理；空数组落
 * `{ kind: 'open' }`。
 */
export function routeSecondInstance(argv: string[]): SecondInstanceRoute {
  const uri = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  return uri ? { kind: 'protocol', uri } : { kind: 'open' };
}
