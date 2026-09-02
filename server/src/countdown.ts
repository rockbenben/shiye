import type { Countdown } from './store.js';
import { bad, type SanitizeResult } from './task.js';

/**
 * 倒数纪念日的白名单校验，跟 `checkListPatch`/`checkFolderPatch` 同一个套路：
 * **未知键整条拒收**，不是悄悄过滤掉。
 */
export type CountdownPatch = Partial<Pick<Countdown, 'title' | 'date' | 'yearly' | 'lunar'>>;

const KEYS = ['title', 'date', 'yearly', 'lunar'] as const;

/**
 * `date` 必须是 `YYYY-MM-DD`，而且真的存在这一天。
 *
 * **两道都要**：只判格式的话 `2026-02-30` 能过——`new Date(2026, 1, 30)` 会
 * 溢出成 3 月 2 日，界面上会显示一个用户没输入过的日期，而且「差几天」算出来
 * 也是错的。构造回去比一遍月份是唯一挡得住这种的办法，跟 `smartInput.ts` 里
 * 认「2月30日」时同一条判据。
 */
export function isDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

export function checkCountdownPatch(body: unknown): SanitizeResult<CountdownPatch> {
  if (typeof body !== 'object' || body === null) return bad('body', '要是一个对象（整个请求体）');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !(KEYS as readonly string[]).includes(k))) {
    return bad('body', `只认 ${KEYS.join(' / ')} 这几个键`);
  }
  const out: CountdownPatch = {};
  if ('title' in b) {
    if (typeof b.title !== 'string' || !b.title.trim()) return bad('title', '要是非空字符串');
    out.title = b.title.trim();
  }
  if ('date' in b) {
    if (!isDateString(b.date)) return bad('date', '要是 YYYY-MM-DD 形式的日期，而且真的存在这一天（2026-02-30 不算）');
    out.date = b.date;
  }
  if ('yearly' in b) {
    if (typeof b.yearly !== 'boolean') return bad('yearly', '要是布尔值');
    out.yearly = b.yearly;
  }
  // **不校验「lunar 为真时 yearly 也得为真」**：那是一句自相矛盾但无害的话
  // （不重复的日子按农历算跟按公历算是同一天），而 PATCH 只带一个字段时校验器
  // 看不见另一个——跟 `habit` 跟 `repeat` 那条的处境一样，但结论相反：那边配错
  // 了会让一条任务在习惯页上消失，这边最坏只是存了一个不起作用的布尔值。
  // 算下一次的那一步（`countdown.ts` 的 `nextYearly`）自己会忽略它。
  if ('lunar' in b) {
    if (typeof b.lunar !== 'boolean') return bad('lunar', '要是布尔值');
    out.lunar = b.lunar;
  }
  return { ok: true, value: out };
}
