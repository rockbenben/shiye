import type { ReactNode } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import type { Repeat } from '../types.js';
import { WEEKDAY_SHORT } from '../lib/weekday.js';
import { holidayDataLastYear } from '../../../server/src/chineseDays.js';

const EVERY: Array<{ v: Repeat['every']; label: string; unit: string }> = [
  { v: 'day', label: '每天', unit: '天' },
  { v: 'week', label: '每周', unit: '周' },
  { v: 'month', label: '每月', unit: '月' },
  { v: 'year', label: '每年', unit: '年' },
  // 艾宾浩斯（仿滴答清单）：间隔不固定，所以没有「每几个」这个单位——下面
  // 那个数字输入框在这一档下整个不渲染，unit 给空串只是让这张表形状一致。
  { v: 'ebbinghaus', label: '艾宾浩斯记忆法', unit: '' },
  // 农历（仿滴答清单）：春节、中秋、家人的农历生日、初一十五——这些用公历
  // 重复表达不了，每年会漂十几天。
  { v: 'lunar-year', label: '农历每年', unit: '农历年' },
  { v: 'lunar-month', label: '农历每月', unit: '农历月' },
  // 法定工作日/节假日（仿滴答清单）。**跟下面那两个 weekdays 预设不是一回事**：
  // 「每周工作日」是周一到周五，这两档跟着当年的放假通知走——避开假期、
  // 但补班那几天算上班。
  { v: 'workday', label: '每个法定工作日', unit: '个工作日' },
  { v: 'holiday', label: '每个法定节假日', unit: '个节假日' },
];

/** 星期几的快捷预设（仿滴答清单的「每周工作日」「每周末」）。**不是新的重复
 *  档位**，只是往 `weekdays` 里填一组现成的值——一个一个点五下周一到周五是
 *  这个表单最常见的动作。
 *
 *  这段以前还写着「法定工作日/法定节假日那两档没做：这个应用离线跑、没有那个
 *  数据源」——**那句话当时就不成立**：`chinese-days` 早就在仓库里了
 *  （日历格子上那半行「休 / 班」就是它画的），表随包更新、离线可用。现在那两档
 *  在上面 `EVERY` 里，而「明年悄悄算错」这个真实的风险由年份闸门挡着
 *  （`server/src/chineseDays.ts`）：表到哪年为止就排到哪年，之后这条重复结束，
 *  不会把假期当成上班日。 */
const WEEKDAY_PRESETS: Array<{ label: string; days: number[] }> = [
  { label: '工作日', days: [1, 2, 3, 4, 5] },
  { label: '周末', days: [0, 6] },
];


/** 上界 999：服务端 `sanitizeRepeat` 没有上界，`interval: 1e8` 会让 `setDate` 溢出成
 *  Invalid Date（服务端那条已经用「算出 Invalid Date 就不生成」兜住了，任务还能标完成，
 *  但界面不该让人填得出一个注定不会生成下一条的值）。 */
const MAX_INTERVAL = 999;

/** 「还重复几次」的上界。跟 MAX_INTERVAL 同一个理由：界面不该让人填出一个
 *  没有意义的值。999 次「每天」是三年，够任何真实用途。 */
const MAX_COUNT = 999;

/** 卡片上显示的那句人话。渲染 JSON 对人没有意义。 */
export function describeRepeat(r: Repeat): string {
  // `?? EVERY[0]` 兜底：`every` 是手改 JSON 写出来的非法值（比如 'fortnight'）
  // 时不炸整页——`GET /api/tasks` 不校验文件写入的数据，interval/weekdays
  // 都已经用 `?? 1`/`?? []` 兜了底（见下面两行），这里之前是唯一漏的一处
  // `!` 非空断言。跟 TaskCard.tsx 里 subtasks/notes 缺失时兜底的教训同一条。
  const e = EVERY.find((x) => x.v === r.every) ?? EVERY[0];
  const n = Math.max(1, r.interval ?? 1);
  const head = r.every === 'ebbinghaus'
    // 步数是这一档唯一有信息量的东西：同一句「艾宾浩斯」，第一次复习和第六次
    // 复习下一次隔的天数差了一个量级。`step` 是 0-based，显示时 +1。
    ? `${e.label}（第 ${(r.step ?? 0) + 1} 次）`
    : n === 1 ? e.label : `每 ${n} ${e.unit}`;
  // 月重复锚在几号（`monthDay`）。**卡片上一直只写「每月」**，而这个字段一加，
  // 「每月 15 号交房租」和「每月交房租」在卡片上就长得一模一样了——两者下一次
  // 落在哪天完全不同，这一句是唯一能看出区别的地方。只有月重复读它，别的档位
  // 写了也不显示（服务端校验不拦，跟 `step` 同一条）。
  //
  // 29/30/31 要多说半句：短的月份没有那一天，服务端是**收到月末**（不是整月
  // 跳过），而「每月 31 号」这四个字在二月是句假话。只在真会撞上的那三档加，
  // 1-28 号不加——每张卡都挂一句解释是噪音。
  // 农历那两档也读 `monthDay`（那时它记的是农历号数，见 `model.ts`），所以
  // 一并显示——但要说清是农历的号，不然「30 号」在两种历里是两个日子。
  const lunarAnchor = r.every === 'lunar-month' || r.every === 'lunar-year';
  const anchor = (r.every === 'month' || lunarAnchor) && typeof r.monthDay === 'number' ? r.monthDay : null;
  // 完成重复要说出来：同一句「每 3 天」，从截止日算和从完成那天算是两回事，
  // 而这句话是卡片上唯一能看出区别的地方。到期重复是默认，不加缀——每张卡都
  // 挂一句「（从截止日算）」是噪音。缺这个字段的老数据走 `?? 'due'` 同一支。
  const parts: string[] = [];
  if (anchor !== null) parts.push(lunarAnchor ? `农历 ${anchor} 号` : `${anchor} 号`);
  // 分开一格，不写成「31 号（短月落在月末）」——那样括号里套括号，读起来是断的。
  if (anchor !== null && anchor >= 29) parts.push('短月落在月末');
  if (r.from === 'done') parts.push('做完那天再算');
  // 「还剩 N 次」——`count` 存的是剩余次数（见 model.ts 那份注释），卡片上
  // 直接把它显出来就是人想知道的那个数，不用再换算。0 也要显示：那是「这是
  // 最后一条」，恰恰是最该说出来的一格。
  if (typeof r.count === 'number') parts.push(r.count > 0 ? `还剩 ${r.count} 次` : '最后一次');
  // 「到 X 为止」——**`until` 原来一个字都不显示**，而它跟上面那个「还剩 N 次」
  // 是一对（README 原话「跟旁边的『重复截止』可以同时设，谁先到算谁的」）：
  // 一个显示、一个不显示，说不通。不说的后果是那条任务某天就是不再回来了，
  // 而卡片上从头到尾没有任何地方提过它会停。
  //
  // 本地年月日拼，不用 `toISOString().slice(0,10)`——那是 UTC 镜头，东八区
  // 晚上八点之后设的截止会显示成第二天。解析不出来的整段不显示，不印一个
  // 「Invalid Date」出来，跟这个函数里别的几处兜底同一条。
  const untilAt = r.until ? new Date(r.until) : null;
  if (untilAt && !Number.isNaN(untilAt.getTime())) {
    const p2 = (x: number) => String(x).padStart(2, '0');
    parts.push(`到 ${untilAt.getFullYear()}-${p2(untilAt.getMonth() + 1)}-${p2(untilAt.getDate())} 为止`);
  }
  const suffix = parts.length > 0 ? `（${parts.join('，')}）` : '';
  if (r.every !== 'week' || (r.weekdays ?? []).length === 0) return head + suffix;
  const days = [...new Set(r.weekdays)].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]);
  // 「每周一」而不是「每周的周一」；间隔大于 1 时说「每 2 周的周五」
  return (n === 1 ? `每周${days.join('、')}` : `${head}的周${days.join('、')}`) + suffix;
}

interface Props {
  value: Repeat | null;
  onChange: (next: Repeat | null) => void;
}

/**
 * 放假通知那张表**已经用完了吗**——今年都不在覆盖范围里的话，「法定工作日 /
 * 法定节假日」这两档一条都排不出来。
 *
 * **排不出来就不让选**（下拉里置灰 + 说明），这是「拒绝创建」放在唯一合适的
 * 位置：创建那一刻。**没有放进服务端的形状校验器**，那是有意的——那份校验器
 * 对每一次 PATCH 都跑，而这张表会随依赖升级而变；写进去的后果是**一条今天存
 * 得下的任务，明年可能改一个字都保存不回去**，而且报的错跟他改的东西毫无关系。
 * 静默算错这个真正的风险已经堵在别处了：`nextOccurrence` 越过边界返回 `null`，
 * 这条重复就此结束，不会把假期当成上班日排下去。
 *
 * 读时钟不读 `now` prop：这个组件本来就没有 `now`，而这个判断的粒度是「年」，
 * 差一天不会改变答案。
 */
const holidayDataUsable = (): boolean => new Date().getFullYear() <= holidayDataLastYear();

export function RepeatFields({ value, onChange }: Props): ReactNode {
  const unit = EVERY.find((x) => x.v === value?.every)?.unit ?? '';
  const holidayOk = holidayDataUsable();
  const needsHolidayData = (v: Repeat['every']) => v === 'workday' || v === 'holiday';
  return (
    <div className="ink-repeat-row">
      <select
        className="ink-repeat-select"
        aria-label="重复"
        value={value?.every ?? ''}
        onChange={(e) => {
          const v = e.target.value as Repeat['every'] | '';
          // 从「不重复」切过去要给一份**完整合法**的默认值，不能只填 every——
          // 服务端 sanitizeRepeat 对缺字段有默认，但半个对象传来传去迟早出事。
          // `monthDay` 落 null：这里是「切成月重复」，还不知道锚在几号——
          // 那由服务端在第一次推进时用当时的 due 补上（model.ts 那段），表单里
          // 不为它多摆一个控件：截止日期本来就在上面，一件事不问两遍。
          onChange(v ? { every: v, interval: 1, weekdays: [], until: null, from: value?.from ?? 'due', count: value?.count ?? null, step: 0, monthDay: null } : null);
        }}
      >
        <option value="">不重复</option>
        {/* 表用完了就把那两档置灰——选不了，而不是选了之后一条都不生成。
            **已经选着的那一档不置灰**：那会让一条存量任务的下拉显示空白，
            人连自己现在是什么规则都看不到了。 */}
        {EVERY.map((e) => (
          <option
            key={e.v}
            value={e.v}
            disabled={needsHolidayData(e.v) && !holidayOk && value?.every !== e.v}
          >
            {e.label}{needsHolidayData(e.v) && !holidayOk ? '（数据已过期）' : ''}
          </option>
        ))}
      </select>

      {value && (
        <>
          {/* 艾宾浩斯这一档没有「每几个」——间隔由曲线决定。留着一个改了没
              任何效果的输入框，比不显示它糟。 */}
          {value.every !== 'ebbinghaus' && (
          <label className="ink-repeat-interval">
            每
            <input
              type="number"
              aria-label="每几个"
              min={1}
              max={MAX_INTERVAL}
              value={value.interval}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                const clamped = Number.isFinite(n) ? Math.min(MAX_INTERVAL, Math.max(1, n)) : 1;
                onChange({ ...value, interval: clamped });
              }}
            />
            {unit}
          </label>
          )}

          {/* **把数据的边界说出来。** 这两档跟别的不一样：农历是算出来的、往后
              几十年都成立，而放假通知是**发布出来的**——国务院办公厅每年下半年
              才发下一年的，在那之前世界上不存在这个数据。
              表到头之后这条重复会自己结束（`nextOccurrence` 返回 null），不会
              把假期当成上班日排下去；但「它某天会自己停」是人有权提前知道的事，
              而不是等到那天发现下一条没生成。年份读同一个函数，不写死。 */}
          {(value.every === 'workday' || value.every === 'holiday') && (
            <span className="ink-hint">
              {holidayOk
                ? `跟着国务院的放假通知走，含调休补班。本地这张表到 ${holidayDataLastYear()} 年为止，之后这条重复会自己结束。`
                : `本地这张放假通知的表只到 ${holidayDataLastYear()} 年，今年已经排不出来了——这条重复不会再生成下一条。升级依赖，或者换成「每周」+「工作日」那颗预设。`}
            </span>
          )}

          {value.every === 'week' && (
            <span className="ink-repeat-days">
              {/* 两颗预设摆在七个星期几前面：点一下等于点五下。再点一次不是
                  取消——那七颗自己就是取消入口，多一个「切换」语义只会让
                  「现在到底选中了什么」变得要猜。 */}
              {WEEKDAY_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="ink-repeat-preset"
                  onClick={() => onChange({ ...value, weekdays: [...p.days] })}
                >{p.label}</button>
              ))}
              {WEEKDAY_SHORT.map((short, d) => {
                const on = value.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className="ink-repeat-day"
                    aria-label={`周${short}`}
                    aria-pressed={on}
                    onClick={() => onChange({
                      ...value,
                      weekdays: on
                        ? value.weekdays.filter((x) => x !== d)
                        : [...value.weekdays, d].sort((a, b) => a - b),
                    })}
                  >{`周${short}`}</button>
                );
              })}
            </span>
          )}

          {/* 从哪儿算下一次。仿滴答清单的「到期重复 / 完成重复」：
              「每周一写周报」拖到周三写完，下一次还该是下周一（到期重复）；
              「每三天健身一次」周六才补上，下一次该是周二（完成重复）。
              两个选项摆在一起，不做成勾选框——「不勾是什么意思」得靠猜，而
              这两种都是正当的常见需求，没有哪个是「关掉」另一个。 */}
          <select
            className="ink-repeat-select"
            aria-label="从哪天算下一次"
            value={value.from ?? 'due'}
            onChange={(e) => onChange({ ...value, from: e.target.value === 'done' ? 'done' : 'due' })}
          >
            <option value="due">按截止日算</option>
            <option value="done">按做完那天算</option>
          </select>

          {/* 还重复几次（滴答清单的「按次数结束重复」）。**这个数是剩余次数，
              不是总次数**——标签里必须把「还」字写出来，不然填 3 的人以为
              「一共三次」，实际会再来三条。留空是一直重复。
              跟下面的「重复截止」可以同时设，谁先到算谁的。 */}
          <label className="ink-repeat-interval">
            还重复
            <input
              type="number"
              aria-label="还重复几次"
              min={0}
              max={MAX_COUNT}
              placeholder="不限"
              value={value.count ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) { onChange({ ...value, count: null }); return; }
                const n = Number.parseInt(raw, 10);
                // 认不出来（用户正在删字、或者粘了个非数字）不写 0——那会
                // 让这条重复任务当场停摆，而他只是打字打到一半。
                if (!Number.isFinite(n)) return;
                onChange({ ...value, count: Math.min(MAX_COUNT, Math.max(0, n)) });
              }}
            />
            次
          </label>

          {/* 重复到什么时候为止——不限于「每周」，四种频率都适用，跟星期几选择器
              不是同一个显隐条件。allowClear 直接给「可清空」，不用另写清空按钮。
              只取日期不取时间（没有 showTime）：`endOf('day')` 落在 onChange
              里——「重复到 12 月 31 日」应该包住那一整天，用一天的起点
              （00:00）当 until 的话，当天晚一点的 due 会被判定成「已经过期」，
              那一次反而生成不出来，跟人的直觉正好相反。 */}
          <DatePicker
            allowClear
            placeholder="重复截止（不填就一直重复）"
            value={value.until ? dayjs(value.until) : null}
            onChange={(d) => onChange({ ...value, until: d ? d.endOf('day').toISOString() : null })}
          />

          {/* 人话预览。**跟卡片上写的是同一句**（同一个 `describeRepeat`）——
              这一排最多七个控件（频率/间隔/星期几/从哪天算/还重复几次/重复截止），
              拼起来到底是一句什么话，要保存之后看卡片才知道。

              还有一件只有这里能说的事：`monthDay`（月重复锚在几号）**没有自己的
              控件**——它是“每月 15 号”这种话识别出来的、或者服务端第一次推进时
              用当时的截止日期补上的（见 model.ts）。不显示的话，表单里它既看不见、
              改完别的字段又会默默地跟着走，那才是真的令人困惑。

              不做成可交互的：它只是把上面那几个控件的结果读一遍，不是第八个控件。 */}
          <p className="ink-repeat-preview">{describeRepeat(value)}</p>
        </>
      )}
    </div>
  );
}
