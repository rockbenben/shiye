import { DEFAULT_SETTINGS, type Settings } from './store.js';
import { aiKeyFrom } from './aiApi.js';
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
  // 先算出要落盘的地址：下面判「密钥字段缺失要不要沿用」得拿它跟存着的比。
  const aiBaseUrl = typeof body.aiBaseUrl === 'string' ? body.aiBaseUrl.trim() : DEFAULT_SETTINGS.aiBaseUrl;
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
    aiBaseUrl,
    aiModel: typeof body.aiModel === 'string' ? body.aiModel.trim() : DEFAULT_SETTINGS.aiModel,
    // 密钥三种走法，缺一不可：
    //   - 请求体里压根没这个字段（别的客户端只想改别的设置）→ 原样留着，
    //     **但只在地址没变时**——地址换了、密钥又没给，密钥不跟着搬过去。
    //     不然这就是一条把密钥送给任意地址的路，理由见 aiKeyFrom 的注释
    //   - 收到的正是 GET 回去的那串打码 → 原样留着。界面读回来的就是打码，
    //     不认它的话，用户在设置页改一下番茄钟时长再保存，密钥就被那串
    //     `••••abcd` 覆盖了，而下一次拆解才会以 401 的形式暴露出来
    //   - 别的字符串（含空串）→ 照收。空串就是「清掉」，得留这条路
    aiKey: aiKeyFrom(body.aiKey, stored.aiKey, { incoming: aiBaseUrl, stored: stored.aiBaseUrl }),
  };
  return next;
}
