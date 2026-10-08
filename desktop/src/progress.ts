/**
 * 任务栏进度条——「今天做完几件」。
 *
 * **为什么是任务栏而不是托盘**：托盘那颗图标旁边放不了字，而「今天还剩几件」
 * 是这个应用最该随时能看见的一个数。Windows 的任务栏按钮自带一条进度条，
 * 不用点开窗口就知道今天清得怎么样了——对一个「关掉窗口不等于关掉服务」的
 * 常驻工具来说，这正好补上「窗口不在眼前时它还在替我记着」这件事。
 *
 * **数从服务端来**（`GET /api/summary`），不在这儿自己数一遍：判据是
 * `dailySummary.ts` 的 `belongsToToday`，跟每日概览那条推送、跟网页「今天」
 * 那一屏是同一份口径（网页那边由 `todayParity.guard.test.ts` 逐条对账）。
 * **在主进程里再抄一份日期逻辑，就是同一个数有了两个说法**——那正是这个
 * 仓库反复栽的地方。
 *
 * 纯逻辑（比例怎么算、取了没有）都在这个文件里，主进程那边只负责把结果
 * 交给 Electron 的 `win.setProgressBar`。
 */

/** 服务端 `/api/summary` 给的那三个数。 */
export interface TodaySummary {
  /** 今天一共几件（**含已经做完的**——进度条的分母）。 */
  total: number;
  /** 其中真的做完了的（搁置和放弃不算做完）。 */
  done: number;
  /** 还剩几件。 */
  remaining: number;
}

/**
 * 任务栏那条进度条该画成什么样。
 *
 * - `null` = **不画**（今天没有安排）。Electron 那边用 `-1` 表示「撤掉」。
 * - 别的 = 0~1 的比例，**今天已经做完的占多少**——跟常见的进度条一个读法
 *   （越接近满越接近清空）。
 *
 * **纯函数**：这个比例算错了，任务栏上就会出现一条骗人的绿条。
 */
export function progressFraction(s: TodaySummary): number | null {
  if (!Number.isFinite(s.total) || s.total <= 0) return null;
  const f = s.done / s.total;
  if (!Number.isFinite(f)) return null;
  return Math.min(1, Math.max(0, f));
}

/**
 * 取那三个数。取不到（服务没起来、返回的形状不对、超时）一律 `null`——
 * **不猜**：猜出来的进度条比没有进度条更坏（它说的是一句假话）。
 *
 * 超时 3 秒：这个请求是「锦上添花」，服务端忙起来的时候等它不值得——
 * 上一次取到的数继续用着就行（主进程那边只在拿到新数时才改）。
 */
export async function fetchSummary(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<TodaySummary | null> {
  try {
    const r = await fetchFn(`${baseUrl}/api/summary`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const body = (await r.json()) as Partial<TodaySummary>;
    if (typeof body.total !== 'number' || typeof body.done !== 'number') return null;
    return {
      total: body.total,
      done: body.done,
      remaining: typeof body.remaining === 'number' ? body.remaining : 0,
    };
  } catch {
    return null;
  }
}
