import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from './expand.js';
import {
  agentCwd, nowIso, readInbox, readInsights, readLists, readProposals, readTasks, writeOutboxFile,
} from './store.js';

/**
 * 「这次只回顾某一份清单」。一个项目一份清单，所以这就是「只看这个项目」。
 *
 * 为什么值得有：回顾默认扫全部任务，而 `aiMode: 'api'` 那条路是把**任务全文塞进
 * 提示词**的（见 `aiApi.ts` 的 `buildMessages`）——任务攒到几百条之后，每问一次
 * 「035 这摊怎么样了」都要为另外几百条不相干的任务付一次 token。筛一道，快也便宜。
 */
export interface ReviewScope {
  listId: string;
  /** 清单名。只用来把话说清楚（提示词里、界面上），判据一律用 `listId`。 */
  listName: string;
}

/**
 * 范围那句话**只写这一份**，CLI 和 API 两条路共用。
 *
 * 两边各写一句的话，措辞迟早分叉：一边说「只看」一边说「优先看」，而模型对这两个
 * 词的服从度差得远——那种分叉在界面上没有任何地方看得出来，只会表现成「有时候
 * 它还是提了别的清单的建议」。
 *
 * ## 这句话的约束力，两条路上不一样
 *
 * **调接口那条是硬的**：下面 `buildMessages` 真的按 `listId` 把任务筛掉了，模型
 * 压根看不见别的清单，连它们的 id 都不知道，想提也提不出来。
 *
 * **CLI 那条是软的**：AI 是另一个进程，自己去读 `data/tasks/`，服务端筛不了它。
 * 这句话就是全部的约束——模型不听话时，一次「只回顾这份清单」照样可能带回别的
 * 项目的建议。
 *
 * **没有在合并那一步补一道硬拦截，是权衡过的。** `mergeOutbox` 只校验形状、字段
 * 白名单、任务存不存在，没有任何范围概念；要让它知道范围，就得把范围从 runner
 * 传到合并那条路上，而那条路是**故意跟 runner 解耦的**（`outbox.ts` 已经 import
 * 了 `expand.ts` 的 `emitAgentStatus`，反向 import 是真的运行时循环，`expand.ts`
 * 里 `startApi` 那段注释专门讲过为什么不直接调 `mergeOutbox`）。而越界的后果只是
 * 「一条提在别的项目任务上的建议，他自己点不点」——不改数据、可以忽略。
 * 代价和后果不匹配，所以先不做；真开始碍事了，从这里往合并那条路传范围。
 */
export function scopeLine(scope: ReviewScope): string {
  return `这次只回顾清单「${scope.listName}」（listId 为 ${scope.listId}）里的任务，`
    + '别的清单和不属于任何清单的这次一概不看，也不要对它们提建议或观察。';
}

/**
 * 「不装 Claude Code 也能用 AI」的那条路：调一次 OpenAI 兼容的对话接口。
 *
 * ## 为什么一个客户端就够，不用 subtitle-translator 那种 provider 注册表
 *
 * 那边 2124 行的注册表是因为它还要接 DeepL、Azure Translate、Yandex 这些
 * **各说各话的机翻协议**。这边要的全是 LLM，而现在但凡是个 LLM 服务都提供
 * OpenAI 兼容端点——**Google AI Studio / Gemini 也有**
 * （`generativelanguage.googleapis.com/v1beta/openai/`），DeepSeek、通义、
 * 智谱、OpenRouter、硅基流动、以及本机的 Ollama / LM Studio 同理。所以这里
 * 只写一份 `fetch`，「支持哪几家」退化成界面上几个预置地址，而地址框本来就
 * 能自己填，填什么都行。
 *
 * ## 跟 `expand.ts` 那条 CLI 路的分工
 *
 * CLI 那条起的是一个 **agent**：它自己读 `AGENTS.md`、自己读 `data/inbox/`、
 * 自己写 `data/outbox-*.json`。纯对话接口读不了文件也写不了文件，所以这条路
 * 把两头的活儿接过来——**服务读盘、服务写盘，模型只负责中间那一步想**。
 * `workflows/expand.md` 的三步里，Step 1 和 Step 3 本来就是机械的，能接。
 *
 * 接过来之后，outbox 的校验、合并、SSE 状态、单飞锁、超时**一个字都不用改**：
 * 这条路写出来的文件跟 AI 自己写的长得一模一样，走的是同一个文件监听器。
 *
 * ## 规则不在这个文件里
 *
 * 提示词是**当场读 `AGENTS.md` 和 `workflows/*.md` 原文**拼的，不在这里抄一份
 * 精简版。抄一份的话，两条路（CLI / API）就会因为「有一边改了另一边忘了改」
 * 慢慢给出不同的拆解结果，而界面上没有任何地方会提示这种分叉。
 */

/** 一次调用要的三样。`apiKey` 空串 = 不带 Authorization 头（本机 Ollama 那类不要钥匙）。 */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 测试用换掉真的 `fetch`。 */
export type Fetcher = typeof fetch;

const CHAT_PATH = '/chat/completions';

/**
 * 把用户填的地址补成能 POST 的那个。
 *
 * 三种填法都得认：完整地址（`…/v1/chat/completions`）、base（`…/v1`）、
 * 光一个域名。**光域名时补的是 `/v1/chat/completions` 而不是
 * `/chat/completions`**——`https://api.openai.com` 是最常见的一种手滑，补错了
 * 会 404，而 404 的报错里看不出少的是哪一段。
 */
export function chatUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '');
  if (u.endsWith(CHAT_PATH)) return u;
  // 有没有路径：`https://host` / `https://host/` 之外都算有。
  const path = u.replace(/^https?:\/\/[^/]+/i, '');
  return path === '' ? `${u}/v1${CHAT_PATH}` : u + CHAT_PATH;
}

/**
 * 从回复正文里抠出那段 JSON。
 *
 * **不用 `response_format: json_object`**：一来不是每家都支持（本机跑的
 * llama.cpp、部分中转都不认，报的还是 400 而不是忽略），二来 outbox 的形状是
 * 一个**数组**，而 `json_object` 模式按规范只能回对象——为了迁就它得让模型包
 * 一层 `{"entries": […]}`，那就在 `AGENTS.md` 说的形状和实际要的形状之间多了
 * 一层只有这个文件知道的翻译。宁可在这儿多写十行容错。
 *
 * 容三件事：三反引号围栏、JSON 前后多说的两句话、以及包了一层单键对象
 * （模型即使没被要求也爱包 `{"entries": …}` / `{"tasks": …}`）。
 */
export function extractJson(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 前后有闲话：从第一个方括号/花括号截到最后一个。
    const from = body.search(/[[{]/);
    const to = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    if (from < 0 || to <= from) throw new Error('AI 的回复里没有 JSON');
    parsed = JSON.parse(body.slice(from, to + 1));
  }

  if (Array.isArray(parsed)) return parsed;
  // 包了一层：只认「有且仅有一个键，值是数组」，多个键说不清该拆哪个。
  if (parsed && typeof parsed === 'object') {
    const vals = Object.values(parsed as Record<string, unknown>);
    if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
  }
  throw new Error('AI 回的 JSON 不是数组');
}

/** 读一份规则原文。缺文件时回空串而不是抛——少一份规则该由模型的产出去暴露，不该让整次调用死在读盘上。 */
const rules = (file: string): string => {
  const p = join(agentCwd(), file);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

/**
 * 这条路专属的收尾指令：把 `workflows/*.md` 里「你自己写 outbox 文件」那步改口。
 *
 * 上面两份规则是**原文照贴**的，里面明确写着让 AI 自己写
 * `data/outbox-<unique>.json`。这次它没有文件系统，所以必须在最后显式说清楚
 * 谁来写——不说的话模型会回一句「我已经写好了 outbox-20260830.json」然后什么
 * 都没有，而这种失败在界面上跟「AI 判断没什么好拆的」长得一模一样。
 */
const HANDOFF = `
---

# 这次调用的特殊之处（覆盖上面关于写文件的部分）

你这次**没有文件系统**，也没有任何工具可用。上面规则里说的「读 \`data/…\`」，
需要的内容已经原样贴在下面的用户消息里了；说的「写 \`data/outbox-<unique>.json\`」
这一步由服务代劳。

所以你要做的只有一件事：**把那个 JSON 数组作为回复正文直接发回来。**

- 只回 JSON，不要有任何开场白、解释、总结
- 不要用三反引号围栏包起来
- 数组本身的形状、每个对象的字段规则，完全照上面的规则来，一个字都不要改
- 没有任何东西可产出时回空数组 \`[]\`，不要凭空造
`;

/** 现在几点。API 这条路没有环境可推断，不注入的话 `due` 只能靠模型瞎猜。 */
const clockLine = (): string => {
  const d = new Date();
  const week = '日一二三四五六'[d.getDay()];
  return `现在是 ${nowIso()}（本地时间 ${d.toLocaleString('zh-CN')}，周${week}）。所有相对日期以此为准。`;
};

/**
 * 拼这次要发的两条消息。
 *
 * **贴进去的数据跟 CLI 那条路读到的是同一份、同样全**——不做「只发未完成的任务」
 * 这类省钱裁剪。裁了的话同一颗按钮在两种模式下会给出不同的建议，而界面上没有
 * 任何地方会说「这次 AI 少看了一半数据」。
 * ponytail: 任务上千条时这个提示词会很长（很贵）。真碰上了再按时间窗裁，
 * 并且要在界面上说清楚裁了什么。
 */
export function buildMessages(kind: AgentKind, scope?: ReviewScope): Array<{ role: 'system' | 'user'; content: string }> {
  const workflow = kind === 'expand' ? 'workflows/expand.md' : 'workflows/review.md';
  const system = `${rules('AGENTS.md')}\n\n---\n\n${rules(workflow)}\n${HANDOFF}`;

  const j = (label: string, v: unknown): string => `## ${label}\n\n${JSON.stringify(v, null, 2)}`;
  const parts = [clockLine(), ''];

  if (kind === 'expand') {
    parts.push(j('data/inbox/ 里 processed: false 的条目', readInbox().filter((x) => !x.processed)));
    parts.push('', j('data/lists/（填 listId 用，对不上就写 null）', readLists()));
  } else {
    // **范围既要说、也要真的筛掉。** 只说不筛，那几百条不相干的任务照样进提示词，
    // 省钱那一半就没了；只筛不说，模型看到的是一份「全部任务」，会拿一份残缺的
    // 数据去下「你手上只有三件事」这种跨任务判断。
    const tasks = readTasks();
    const mine = scope ? tasks.filter((t) => t.listId === scope.listId) : tasks;
    if (scope) parts.push(scopeLine(scope), '', `（下面这份 data/tasks/ 已经按这个范围筛过了，全部 ${tasks.length} 条里的 ${mine.length} 条。）`, '');
    parts.push(j('data/tasks/', mine));
    parts.push('', j('data/lists/', readLists()));
    parts.push('', j('data/proposals/（你以前提过、他还没处理的建议）', readProposals()));
    parts.push('', j('data/insights/（你以前提过的跨任务观察）', readInsights()));
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ];
}

/** 接口回来的形状，只取用得上的两处。 */
interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

/**
 * 调一次接口，回模型说的那段文本。
 *
 * 报错**带上响应正文的前 300 字**：OpenAI 兼容的各家在钥匙错、模型名错、余额
 * 不足时回的都是 4xx + 一段各不相同的 JSON，只报状态码的话用户在界面上看到
 * 「AI 失败：401」，既不知道是钥匙错还是没充值，也不知道该改哪一格。
 */
export async function chat(cfg: AiConfig, messages: ReturnType<typeof buildMessages>, fetchFn: Fetcher, signal: AbortSignal): Promise<string> {
  const url = chatUrl(cfg.baseUrl);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
      signal,
    });
  } catch (e) {
    // **连不上时 undici 只说一句 `fetch failed`**，这句话对着一个填错的地址等于
    // 什么都没说。跟上面 ByteString 那条同一类：不翻译的话，用户拿到的是运行时
    // 的内部措辞，而不是「我该改哪一格」。地址原样报出来——他能一眼看出是不是
    // 少了 `/v1`、端口写错了，或者本机那个模型压根没起。
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`连 ${url} 超时了`);
    throw new Error(`连不上 ${url}（${(e as Error).message}）——检查地址有没有写错；本机跑的模型确认它已经启动`);
  }

  const raw = await res.text();
  if (!res.ok) throw new Error(`接口回了 ${res.status}：${raw.slice(0, 300)}`);

  let data: ChatResponse;
  try {
    data = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new Error(`接口回的不是 JSON：${raw.slice(0, 300)}`);
  }
  if (typeof data.error?.message === 'string') throw new Error(data.error.message);

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('接口回的内容是空的');
  return content;
}

/**
 * 走一遍完整的一次：读盘拼提示词 → 调接口 → 把结果写成 outbox 文件。
 *
 * 回 `false` 表示模型明确说「没什么可产出」（空数组）——那是 `skipped`，不是
 * 失败，跟 CLI 那条路「跑完了但没写出任何文件」是同一件事，界面上不该标红。
 */
export async function runViaApi(kind: AgentKind, cfg: AiConfig, fetchFn: Fetcher, signal: AbortSignal, scope?: ReviewScope): Promise<boolean> {
  const entries = extractJson(await chat(cfg, buildMessages(kind, scope), fetchFn, signal));
  if (entries.length === 0) return false;
  writeOutboxFile(entries);
  return true;
}

/**
 * 设置里那三格能不能跑。回一句能直接贴进提示的话，不是一个字段名——
 * 「配置不完整」那种说法让人得挨个去猜是哪一格。
 *
 * ## 第三条是端到端跑出来的
 *
 * 密钥要拼进 `Authorization` 头，而 HTTP 头是 ByteString——**一个中文字符就会让
 * `fetch` 抛异常**，抛的还是一句
 * `Cannot convert argument to a ByteString because the character at index 10 has
 * a value of 27979`。用户看到这句只能干瞪眼：它没说是哪一格、更没说「你粘贴密钥
 * 的时候带进了中文标点」。而这恰恰是最容易发生的一种——从聊天软件或网页上复制
 * 密钥，很容易顺手带上一个全角空格或者中文引号。
 *
 * 判据是「可打印 ASCII 之外的一律拦」，不是「> 255 才拦」：控制字符（换行最典型，
 * 复制时带上的那个）同样会把请求头搞坏，而且带换行的头是响应拆分那一类问题的
 * 入口。空格也拦——`aiKeyFrom` 已经去过首尾空白，中间还有空格的多半是选多了。
 *
 * **不悄悄替用户清洗**：把非法字符抹掉再发出去，等于拿一把他没输入过的钥匙去认证，
 * 401 之后他会对着一格看起来没问题的密钥查半天。
 */
export function configProblem(cfg: AiConfig): string | null {
  if (!cfg.baseUrl.trim()) return '接口地址还没填';
  if (!cfg.model.trim()) return '模型名还没填';
  // 三条都是**半句**，不带收尾的动作——调用方会接一句「，改好再拆解 / 回顾」。
  if (/[^!-~]/.test(cfg.apiKey)) return '密钥里有中文、空格或者换行（粘贴的时候多半会带进来）';
  return null;
}

/**
 * 密钥回给浏览器时长什么样：`••••` 加后四位；短到看不出后四位就全打码。
 *
 * 不全打成一串 `••••`：界面上得能认出「存着的是哪一把」，否则换钥匙、
 * 对着两个账号排查的时候只能盲改。后四位不足以还原任何东西。
 */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

/**
 * 请求里的密钥该落成什么。三种走法见 app.ts `PUT /api/settings` 那处调用点的注释；
 * `POST /api/ai/test` 也走这一份。
 *
 * 关键的是**中间那条**：界面读回来的是打码串，用户不碰它、只改了别的设置再保存，
 * 请求体里带回来的就是那串打码——不认它的话密钥会被 `••••abcd` 覆盖掉，
 * 而这次覆盖悄无声息，要等下一次拆解报 401 才现形。
 *
 * ## 「字段缺失 → 沿用存着的」只在地址没变时成立
 *
 * 原来这一支无条件返回 `stored`。**它是一条把密钥送给任意地址的路**：
 *
 * - `POST /api/ai/test` 带一个陌生 `baseUrl`、**不带** `apiKey` → 拿存着的真密钥
 *   去请求那个地址，`Authorization: Bearer <真密钥>` 落在对方的访问日志里。
 * - `PUT /api/settings` 带 `aiBaseUrl: 'https://攻击者'`、不带 `aiKey` → 密钥原样
 *   留着、地址换成了他的，**之后不需要受害者做任何事**：自动拆解自己会跑
 *   （收件箱有条目就 spawn），带着真密钥去请求他的地址。持久，无人触发。
 *
 * 而这两条路第三方网页都发得出去：`c.req.json()` 不看 Content-Type，`text/plain`
 * 的简单请求没有预检；CORS 拦的是「读响应」，可攻击者不需要读响应——密钥是送到
 * 他自己服务器上的。
 *
 * **真实客户端从不走这一支**：`api.testAi` 的类型里 `apiKey` 是必填，设置页保存发的
 * 是 `draft.aiKey`（没动过就是那串打码）。所以判据收紧成「地址没变才沿用」对界面
 * 零影响；「改了地址、没动密钥」那条最常见的试法走的是打码那一支，也不受影响。
 * 唯一变化：某个只想改别的设置、又省略了密钥字段的第三方客户端，如果同时把地址
 * 换了，密钥不会跟着搬过去——那正是要拦的事。
 *
 * **残余**：打码串含密钥末四位，知道它就仍能给新地址解锁存着的密钥。CORS 拦得住
 * 读它；DNS rebinding 绕得过 CORS。彻底关死要么要求换地址时重填完整密钥（砍掉那个
 * 便利），要么校验 `Host` 头——两条都不在这一笔里，有意留着。
 */
export function aiKeyFrom(
  incoming: unknown, stored: string, base: { incoming: string; stored: string },
): string {
  if (typeof incoming !== 'string') return base.incoming === base.stored ? stored : '';
  const v = incoming.trim();
  if (stored && v === maskKey(stored)) return stored;
  return v;
}

/**
 * 「测试连接」那颗按钮：拿一次**最便宜的调用**验那三格填对没有。
 *
 * 存在的理由是一个真实的缺口：服务地址那一格早就有「测试连接」，而 AI 这三格
 * 填完之后**唯一的验证方式是真跑一次拆解**——要等一两分钟、烧一次额度，而且
 * 失败是以看板顶上一条红横幅的形式出现的，离他刚填的那三个框十万八千里。
 *
 * 提示词故意只有一句话，不走 `buildMessages`：那份要贴进 `AGENTS.md` 全文加
 * 整个收件箱（现场量到 18KB 的 system），拿它来「试一下通不通」是荒唐的。
 * 这里只想知道四件事——地址对不对、密钥认不认、模型名存不存在、回的是不是
 * JSON——一句「回一个字」全都能验到。
 *
 * 回 `null` = 通了；回字符串 = 那句话直接显示给用户，已经是人话
 * （`configProblem` 的三句，或者接口自己回的那段，见 `chat` 里为什么带上正文）。
 */
export async function testAi(cfg: AiConfig, fetchFn: Fetcher, signal: AbortSignal): Promise<string | null> {
  const bad = configProblem(cfg);
  if (bad) return bad;
  try {
    await chat(cfg, [{ role: 'user', content: '回一个字：好' }], fetchFn, signal);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
