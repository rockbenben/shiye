import { DEFAULT_SETTINGS, type AiEndpoint, type Settings } from './store.js';
import { aiKeyFrom, maskKey } from './aiApi.js';
import { originOf, withLegacyAi } from './aiEndpoints.js';
import { parseHhmm } from './dailySummary.js';

const MIN_AUTO_EXPAND_DELAY_SEC = 10;
const MAX_AUTO_EXPAND_DELAY_SEC = 3600;
const MIN_FOCUS_MINUTES = 1;
const MAX_FOCUS_MINUTES = 180;
const MAX_BREAK_MINUTES = 60;

/**
 * `autoExpandDelaySec` 校验：越界就夹回 [10, 3600]，不是拒掉整个请求。
 *
 * 跟这条路由里别的字段（`webhookUrl`/`toastEnabled`）是同一种脾气——类型不对
 * 就落回默认值，不 400。零或负数会让去抖形同虚设（design 文档原话），必须挡；
 * 但挡的方式选夹紧不选拒绝：这是本地单人小工具的设置页，用户在数字输入框里
 * 手滑打出 5 或者 99999，体验应该是「自动帮你收回到能用的范围」，不是弹一个
 * 400 让他猜错在哪、还要重填一遍其它字段。真正需要硬拒绝的是「不可信来源写坏
 * 数据」，而这条路由本来就只有本机用户自己在用（服务钉死 127.0.0.1，见
 * index.ts C1 的注释）。
 */
function clampAutoExpandDelaySec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.autoExpandDelaySec;
  return Math.min(MAX_AUTO_EXPAND_DELAY_SEC, Math.max(MIN_AUTO_EXPAND_DELAY_SEC, v));
}

/**
 * `focusMinutes` 校验：同一个脾气——夹到 [1, 180]，不是拒掉整个请求。
 * 零或负数会让番茄钟形同虚设（倒计时立刻结束，或者根本没有时长可言），跟
 * `autoExpandDelaySec` 那条注释是同一个道理，必须挡；上限 180 分钟（3 小时）
 * 单纯是个宽松的兜底，不让手滑打出的天文数字进设置页。
 */
function clampFocusMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.focusMinutes;
  return Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, v));
}

/**
 * `breakMinutes` 校验：同一个脾气，夹到 [0, 60]。**下限是 0 不是 1**——
 * 0 有明确含义「不休息」，是加这个字段之前的行为，得留得住；上限 60 分钟，
 * 歇得比专注还久就不是休息了，是换了件事做。
 */
function clampBreakMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.breakMinutes;
  return Math.min(MAX_BREAK_MINUTES, Math.max(0, v));
}

/**
 * 一条记录该落成什么。回 `null` = 这条不该存在（地址是空的），**连带它配过的密钥
 * 一起丢**。
 *
 * 「地址没了、key 还在」是 web-tools 那边拿测试钉住的一类 bug：留下密钥，下一条
 * 配上地址的记录就可能拿走它——等于把「密钥属于哪个端点」这件事从数据结构层
 * 又退回成一条要靠运行时小心的约定。这条判据照抄过来。
 *
 * ## 来源换了就不许沿用旧密钥
 *
 * 同一条记录里把 `https://a.test` 改成 `https://攻击者.test`，请求体里没带 key、
 * 或者带的正是这条记录自己的打码回显 → **清空**。理由跟上一版 `aiKeyFrom` 那个
 * 第三参数一模一样：第三方网页发得出 `PUT /api/settings`（`c.req.json()` 不看
 * Content-Type，`text/plain` 的简单请求没有预检；CORS 拦的是读响应，可它不需要读
 * 响应——密钥是送到它自己服务器上的），不能让它把存着的真密钥搬到别的主机；
 * 搬过去之后自动拆解会自己带着它出门，持久、无人触发。
 *
 * 用户自己**重打一遍**密钥再换地址，照收。换主机就要重填一次是这条判据的代价，
 * 界面那边把代价说给他听（`AiSettingsSection` 里那句「换了地址，密钥要重填一次」）。
 */
export function mergeEndpoint(raw: unknown, stored: AiEndpoint | undefined): AiEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const prev = stored?.key ?? '';
  const incoming = typeof r.key === 'string' ? r.key.trim() : undefined;
  // 没给 key，或者给的正是这条记录自己的打码回显 = 「没动密钥」
  const untouched = incoming === undefined || (!!prev && incoming === maskKey(prev));
  const hostMoved = originOf(stored?.baseUrl ?? '') !== originOf(baseUrl);
  return { baseUrl, model, key: untouched && hostMoved ? '' : aiKeyFrom(r.key, prev) };
}

/**
 * 整张表 + 选中哪一条。
 *
 * **请求体里没有 `aiEndpoints`（或者不是个对象）时，原表原样留着。** 这是对
 * 「`PUT` 是整份覆盖、没给的字段一律落默认值」那份契约的一处**有意例外**，跟
 * `dailySummaryOn` 同一类——这一格装的是密钥：还停在旧版界面的客户端（手机上那页
 * 开着没刷新）发的是老形状 `{aiBaseUrl, aiKey, aiModel}`，照契约把三格当「没给」
 * 清成空表，他一保存就把各家密钥静默清空，而响应照样 200。
 *
 * 老形状的**导入**文件走的是同一扇门：没有 `aiEndpoints` 时先按旧三格派生一条
 * （`withLegacyAi`），派生不出来才算真的没给。
 */
function sanitizeAi(body: Record<string, unknown>, stored: Settings): Pick<Settings, 'aiEndpointId' | 'aiEndpoints'> {
  const gave = body.aiEndpoints && typeof body.aiEndpoints === 'object';
  const legacy = withLegacyAi({ ...DEFAULT_SETTINGS, ...body } as Settings, body);
  const incoming: Record<string, unknown> | null = gave
    ? body.aiEndpoints as Record<string, unknown>
    : Object.keys(legacy.aiEndpoints).length > 0 ? legacy.aiEndpoints : null;
  if (!incoming) return { aiEndpointId: stored.aiEndpointId, aiEndpoints: stored.aiEndpoints };

  const table: Record<string, AiEndpoint> = {};
  for (const [id, raw] of Object.entries(incoming)) {
    // 键直接来自请求体。这三个名字之一能把 `table[id] = …` 变成改原型，
    // 而不是多一条记录——id 是客户端挑的（目录 key / `custom:<地址>`），
    // 正常取值不可能长成这样，挡掉不亏。
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    const merged = mergeEndpoint(raw, stored.aiEndpoints[id]);
    if (merged) table[id] = merged;
  }
  // 选中的那条必须真的在表里：指到一条被丢掉/不存在的记录，等于「没选」，
  // 而 `configProblem` 会报「接口地址还没填」——那就落回**没选**这个诚实的状态，
  // 别让一个悬空 id 在界面上画成「已经选了某家」。
  //
  // ⚠️ **但「空串」跟「悬空」是两件事，别一起处理**（2026-10-16 修的真 bug）：
  // **旧版界面**（手机上那页开着没刷新）那颗「自定义」按钮只是「取消选中」，发出来的
  // 是 `aiEndpointId: ''`，**而表里那条记录和那把密钥都还在**。照旧把它当合法状态存进
  // device.json，下次打开 `activeEndpoint(draft)` 就返回 undefined，接口地址/模型/密钥
  // **三格同时全空**，三颗 AI 按钮一起变灰——数据一条没少，丢的只是「选中哪一条」。
  //
  // （**现在的新界面不走这条路了**：它建的是一条真记录、哨兵 id `custom:`，
  // 见 `web/src/components/AiSettingsSection.tsx` 的 `pickCustom`。但服务端这份兜底
  // 还得留着——**旧客户端还会发空串上来**，而且它发的那份整份设置是旧形状，没有表。）
  //
  // 所以给空串单独一条兜底：**那条记录还在表里，就继续选中它**。判据用
  // `Object.hasOwn(table, stored.aiEndpointId)` 而不是「表非空」——用户用
  // 「忘掉这一家」把记录从表里删掉之后，那条兜底自然不成立，仍然老实落 `''`。
  const picked = typeof body.aiEndpointId === 'string' && Object.hasOwn(table, body.aiEndpointId)
    ? body.aiEndpointId
    : Object.keys(legacy.aiEndpoints).length > 0 && Object.hasOwn(table, legacy.aiEndpointId)
      ? legacy.aiEndpointId
      // 只给**空串**兜底：悬空的非空 id（上面那条测试钉着的）继续落 `''`，
      // 因为那确实是真的「指着一张表里没有的记录」。
      : (body.aiEndpointId === '' && Object.hasOwn(table, stored.aiEndpointId))
        ? stored.aiEndpointId : '';
  return { aiEndpointId: picked, aiEndpoints: table };
}

/**
 * **这是 PUT，不是 PATCH：请求体就是完整的新设置，没给的字段一律回默认值。**
 *
 * 调用方有两个：`PUT /api/settings`（网页设置页保存，经 `api.saveSettings(s: Settings)`
 * 发设置页那份完整对象——`api.ts` 那段注释里说的也是「整份 PUT 回服务端」）和
 * `POST /api/import`（导入「导出数据」里的 settings 键）。所以「没给就回默认」
 * 不是漏合并，是这两个调用方共用的契约。
 *
 * 写下来是因为它看起来很像一个 bug：随手加一个字段、忘了在设置页表单里带上，
 * 保存一次就把它清成默认值，而且不报错。**加字段时必须两头一起加。**
 * `dailySummaryOn` 是唯一的例外，理由在它自己那行——它是事实不是偏好。
 */
export function sanitizeSettings(body: Record<string, unknown>, stored: Settings): Settings {
  const ai = sanitizeAi(body, stored);
  const next: Settings = {
    webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : DEFAULT_SETTINGS.webhookUrl,
    toastEnabled: typeof body.toastEnabled === 'boolean' ? body.toastEnabled : DEFAULT_SETTINGS.toastEnabled,
    autoExpand: typeof body.autoExpand === 'boolean' ? body.autoExpand : DEFAULT_SETTINGS.autoExpand,
    autoExpandDelaySec: clampAutoExpandDelaySec(body.autoExpandDelaySec),
    focusMinutes: clampFocusMinutes(body.focusMinutes),
    breakMinutes: clampBreakMinutes(body.breakMinutes),
    // 每日概览的时刻：`HH:MM` 或 null。**不夹、不猜**，跟上面那几个数字
    // 不一样——一个写坏的时刻没有「最近的合法值」可退，猜一个会让他以为
    // 设成功了，而通知在别的时候响。
    dailySummaryAt: parseHhmm(body.dailySummaryAt) ? String(body.dailySummaryAt).trim() : null,
    // **服务端盖的章，请求体里的一概不采信**：它记的是「今天这条推过了没有」，
    // 是事实不是偏好（跟 Reminder.firedAt 同一类）。不把存着的那份原样带过来
    // 的话，用户在设置页随手按一次保存，当天的概览就会再推一遍。
    dailySummaryOn: stored.dailySummaryOn,
    // 任务默认值。**不校验这个 id 是不是真的存在**——清单可以在任何时候被
    // 删掉，那之后这个字段就指着一个不存在的东西，而这里没法回头去改它。
    // 界面那边（TaskComposer 的 defaultDraft）在用之前先对一遍 lists，
    // 对不上就当没设，这是唯一守得住的地方。
    defaultListId: typeof body.defaultListId === 'string' && body.defaultListId ? body.defaultListId : null,
    defaultPriority: [0, 1, 2, 3].includes(body.defaultPriority as number) ? body.defaultPriority as 0 | 1 | 2 | 3 : 0,
    // 认不出的档一律回默认档，不拒绝整份——跟上面那几个 clamp 同一个态度：
    // 一个写坏的字段不该让另外十几个正确的字段一起存不进去。
    defaultDue: (['none', 'today', 'tomorrow'] as const).includes(body.defaultDue as 'none')
      ? body.defaultDue as Settings['defaultDue'] : DEFAULT_SETTINGS.defaultDue,
    // 提前多久：非负整数分钟，或者 null（不预设）。负数没有意义（「提醒时间
    // 在截止之后」是另一件事，这个应用不提供），一律当没设。
    defaultRemindMinutes: typeof body.defaultRemindMinutes === 'number'
      && Number.isFinite(body.defaultRemindMinutes) && body.defaultRemindMinutes >= 0
      ? Math.round(body.defaultRemindMinutes) : null,
    // 标签：只收字符串、去空白、去重、丢掉空串。手改文件写进来的数字/对象
    // 会一路流到任务的 tags 上，那边全是按字符串处理的。
    defaultTags: Array.isArray(body.defaultTags)
      ? [...new Set(body.defaultTags.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
      : [],
    // 三档白名单（见 model.ts 的 `WeekStart`）。认不出的落回默认档 1，
    // 不是「不是 0 就当 1」——那种写法在加第三档时会把 6 静默吃成 1。
    weekStart: body.weekStart === 0 || body.weekStart === 6 ? body.weekStart : 1,
    // 这四个**默认开**，所以判据是「明确存了 false 才关」，不是「=== true
    // 才开」——照抄 toastEnabled 那种写法会让它们变成默认关，等于把智能识别
    // 整个悄悄关掉。
    smartDate: body.smartDate !== false,
    smartStripDate: body.smartStripDate !== false,
    smartTag: body.smartTag !== false,
    smartStripTag: body.smartStripTag !== false,
    // 农历和「休/班」同样默认开，同样是「存了 false 才关」。
    showLunar: body.showLunar !== false,
    showHolidays: body.showHolidays !== false,
    // 认不出的模式落回 'cli'，跟上面那几个白名单同一个态度。
    aiMode: body.aiMode === 'api' ? 'api' : 'cli',
    aiCli: (['claude', 'agy', 'codex', 'gemini', 'aider', 'custom'] as const).includes(body.aiCli as 'claude')
      ? body.aiCli as Settings['aiCli'] : DEFAULT_SETTINGS.aiCli,
    aiCliPath: typeof body.aiCliPath === 'string' ? body.aiCliPath.trim() : DEFAULT_SETTINGS.aiCliPath,
    aiCliCustomArgs: typeof body.aiCliCustomArgs === 'string' ? body.aiCliCustomArgs.trim() : DEFAULT_SETTINGS.aiCliCustomArgs,
    // 接口配置：地址、密钥、模型名绑成**一条记录**，逐条合并，选中哪一条单独一格。
    // 为什么不再是平铺三格、以及「没给表就保留原表」那份例外，都写在
    // `sanitizeAi()` 和 `mergeEndpoint()` 顶上。
    ...ai,
  };
  return next;
}
