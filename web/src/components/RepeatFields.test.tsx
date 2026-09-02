import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { RepeatFields, describeRepeat } from './RepeatFields.js';
import { NoMotion } from '../test-utils.js';
import type { Repeat } from '../types.js';

const R = (o: Partial<Repeat> = {}): Repeat =>
  ({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...o });

const show = (value: Repeat | null) => {
  const onChange = vi.fn();
  render(<NoMotion><AntApp><RepeatFields value={value} onChange={onChange} /></AntApp></NoMotion>);
  return { onChange };
};

describe('RepeatFields', () => {
  it('默认「不重复」，选它写回 null', () => {
    const { onChange } = show(R({ every: 'week' }));
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('从「不重复」选到「每周」，给一份合法的默认值', () => {
    const { onChange } = show(null);
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'week' } });
    expect(onChange).toHaveBeenCalledWith({ every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null });
  });

  it('星期几只在「每周」时出现', () => {
    show(R({ every: 'week' }));
    expect(screen.getByRole('button', { name: '周一' })).toBeTruthy();
  });

  it('「每天」时没有星期几——那组按钮对它没有意义', () => {
    show(R({ every: 'day' }));
    expect(screen.queryByRole('button', { name: '周一' })).toBeNull();
  });

  it('星期几能选能取消，各按各的', () => {
    const { onChange } = show(R({ every: 'week', weekdays: [1] }));
    fireEvent.click(screen.getByRole('button', { name: '周三' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ weekdays: [1, 3] }));

    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '周一' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ weekdays: [] }));
  });

  it('间隔最小 1：填 0 或负数都夹回 1', () => {
    const { onChange } = show(R({ interval: 3 }));
    fireEvent.change(screen.getByLabelText('每几个'), { target: { value: '0' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interval: 1 }));
  });

  it('间隔最大 999——服务端没有上界，超大值会让日期算术溢出', () => {
    const { onChange } = show(R({ interval: 3 }));
    fireEvent.change(screen.getByLabelText('每几个'), { target: { value: '100000000' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interval: 999 }));
  });

  // 审查补的：真浏览器里清空数字框（或打非数字，type=number 会把它 sanitize
  // 成空字符串）触发 change，`parseInt('')` 是 NaN。`Number.isFinite` 这道守卫
  // 一直都在（不是这次新加的代码），但之前没有测试单独盯着它——去掉它的话
  // NaN 会一路写进 onChange，序列化成 JSON 变成 null，服务端判
  // `typeof null !== 'number'` 退回整个 PATCH，保存直接 400。
  it('清空间隔框夹回 1，不写出 NaN', () => {
    const { onChange } = show(R({ interval: 3 }));
    fireEvent.change(screen.getByLabelText('每几个'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interval: 1 }));
  });
});

/**
 * `until`——「重复到什么时候为止」，brief 里「规矩」一节明确要求（跟 every/
 * interval/weekdays 并列的四条之一），跟给的 Step 1 完整测试代码不是同一批——
 * 这两条是补的。用日期而不是日期时间（没有 showTime）：DatePicker 只认
 * `YYYY-MM-DD` 格式的文本 + 回车才会提交，跟星期几按钮那种 fireEvent.click
 * 是两套驱动方式。
 */
describe('RepeatFields：until——重复截止日', () => {
  it('填一个日期，写回的是那一天的**结束**（23:59:59.999），不是起点——用起点的话，那天晚一点的 due 会被判成已经过了 until，反而生成不出当天这一次', () => {
    const { onChange } = show(R());
    const input = screen.getByPlaceholderText('重复截止（不填就一直重复）');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: '2026-12-31' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    const call = onChange.mock.calls[0][0] as Repeat;
    expect(call.until).not.toBeNull();
    const picked = new Date(call.until!);
    expect(picked.getFullYear()).toBe(2026);
    expect(picked.getMonth()).toBe(11);
    expect(picked.getDate()).toBe(31);
    expect(picked.getHours()).toBe(23);
    expect(picked.getMinutes()).toBe(59);
  });

  it('点清空按钮，写回 until: null', () => {
    const { onChange } = show(R({ until: '2026-12-31T15:59:59.999Z' }));
    const clearBtn = document.querySelector('.ant-picker-clear');
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ until: null }));
  });
});

describe('describeRepeat：说人话，不是渲染 JSON', () => {
  it.each([
    [R({ every: 'day' }), '每天'],
    // 完成重复和「还剩几次」都要写在卡片上：同一句「每 3 天」，从截止日算和
    // 从完成那天算差好几天，而剩余次数是人真正想知道的那个数。
    [R({ every: 'day', interval: 3, from: 'done' }), '每 3 天（做完那天再算）'],
    [R({ every: 'day', count: 3 }), '每天（还剩 3 次）'],
    [R({ every: 'day', count: 0 }), '每天（最后一次）'],
    [R({ every: 'day', from: 'done', count: 2 }), '每天（做完那天再算，还剩 2 次）'],
    [R({ every: 'day', interval: 3 }), '每 3 天'],
    [R({ every: 'week' }), '每周'],
    [R({ every: 'week', weekdays: [1] }), '每周一'],
    [R({ every: 'week', weekdays: [1, 3, 5] }), '每周一、三、五'],
    [R({ every: 'week', interval: 2, weekdays: [5] }), '每 2 周的周五'],
    [R({ every: 'month' }), '每月'],
    [R({ every: 'year' }), '每年'],
    // 下面三条是审查补的——brief 给的八条都没能拦住三种退化实现（去掉
    // `every !== 'week'` 守卫 / 去掉 sort / 去掉去重），而 `sanitizeRepeat`
    // （server/src/task.ts）不做 every↔weekdays 交叉校验、也不排序不去重，
    // 这三种脏数据 AI 写 outbox 或 PATCH 都能落盘，不是纸面上的假设。
    [R({ every: 'day', weekdays: [1] }), '每天'],
    [R({ every: 'week', weekdays: [5, 1] }), '每周一、五'],
    [R({ every: 'week', weekdays: [1, 1] }), '每周一'],
    // 「重复截止」原来一个字都不显示，而它跟「还剩 N 次」是一对（README：
    // 「谁先到算谁的」）——一个显示一个不显示说不通，而不说的后果是那条
    // 任务某天就是不再回来了，卡片上从头到尾没提过它会停。
    // 本地年月日：用 `new Date(y, m-1, d)` 造，不写 'Z' 字符串——那样断言
    // 会跟着跑测试的机器时区飘。
    [R({ every: 'day', until: new Date(2026, 11, 1).toISOString() }), '每天（到 2026-12-01 为止）'],
    [R({ every: 'week', weekdays: [1], until: new Date(2026, 11, 1).toISOString() }), '每周一（到 2026-12-01 为止）'],
    [
      R({ every: 'day', count: 2, until: new Date(2026, 11, 1).toISOString() }),
      '每天（还剩 2 次，到 2026-12-01 为止）',
    ],
    // 手改文件写坏了：整段不显示，不印一个「Invalid Date」出来。
    [R({ every: 'day', until: '下个月' }), '每天'],
    // monthDay：加这个字段之前，「每月 15 号交房租」和「每月交房租」在卡片上
    // 长得一模一样，而两者下一次落在哪天完全不同。
    [R({ every: 'month', monthDay: 15 }), '每月（15 号）'],
    [R({ every: 'month', monthDay: 1 }), '每月（1 号）'],
    // 29/30/31 多说半句：短的月份没有那一天，服务端是收到月末，而「31 号」
    // 这三个字在二月是句假话。
    [R({ every: 'month', monthDay: 31 }), '每月（31 号，短月落在月末）'],
    [R({ every: 'month', monthDay: 29 }), '每月（29 号，短月落在月末）'],
    [R({ every: 'month', monthDay: 28 }), '每月（28 号）'],
    // 别的档位不显示它——服务端校验不拦跨档位的脏数据，跟 weekdays 同一条。
    [R({ every: 'day', monthDay: 15 }), '每天'],
    [R({ every: 'week', weekdays: [1], monthDay: 15 }), '每周一'],
    // 跟别的括号内容并排时用顿号隔开，不各占一对括号。
    [R({ every: 'month', monthDay: 15, count: 2 }), '每月（15 号，还剩 2 次）'],
  ])('%o → %s', (rule, text) => {
    expect(describeRepeat(rule as Repeat)).toBe(text);
  });

  // 审查补的 Minor：`every` 是手改 JSON 写出来的非法值（GET /api/tasks 不校验
  // 文件写入的数据）时不该炸整页——interval/weekdays 都已经用 `?? 1`/`?? []`
  // 兜了底，`every` 之前是唯一漏的一处非空断言。
  it('every 是非法值时不抛异常，兜底成第一档（每天）', () => {
    const bad = { every: 'fortnight', interval: 1, weekdays: [], until: null } as unknown as Repeat;
    expect(() => describeRepeat(bad)).not.toThrow();
    expect(describeRepeat(bad)).toBe('每天');
  });
});

/**
 * 表单里那句人话预览。**跟卡片上写的是同一句**（同一个 `describeRepeat`）——
 * 这一排最多七个控件，拼起来到底是一句什么话，在这之前要保存之后看卡片才知道。
 */
describe('RepeatFields：人话预览', () => {
  const show = (v: Repeat | null) => {
    const onChange = vi.fn();
    const { container } = render(<NoMotion><AntApp><RepeatFields value={v} onChange={onChange} /></AntApp></NoMotion>);
    return { onChange, preview: () => container.querySelector('.ink-repeat-preview')?.textContent ?? null };
  };

  it('跟 describeRepeat 一字不差，不另拼一套说法', () => {
    const v = R({ every: 'week', interval: 2, weekdays: [1, 5], count: 3 });
    expect(show(v).preview()).toBe(describeRepeat(v));
    expect(show(v).preview()).toBe('每 2 周的周一、五（还剩 3 次）');
  });

  it('**「每月 15 号」这种只有这儿说得出来**——monthDay 没有自己的控件，是识别出来的或者服务端补的', () => {
    expect(show(R({ every: 'month', monthDay: 15 })).preview()).toBe('每月（15 号）');
  });

  it('不重复时整段不渲染，不摆一句空话', () => {
    expect(show(null).preview()).toBeNull();
  });
});

/**
 * 农历 / 法定工作日 / 法定节假日那四档（仿滴答清单）。判据在
 * `server/src/repeat.ts`，这一族测的是表单这一层：选得出来、摘要说人话、
 * 以及**数据边界有没有说出口**。
 */
describe('RepeatFields：这一轮补的四档', () => {
  it.each([
    ['lunar-year', '农历每年'],
    ['lunar-month', '农历每月'],
    ['workday', '每个法定工作日'],
    ['holiday', '每个法定节假日'],
  ] as const)('%s 在下拉里选得到，名字是「%s」', (every, label) => {
    show(R({ every }));
    expect((screen.getByLabelText('重复') as HTMLSelectElement).value).toBe(every);
    expect(screen.getByRole('option', { name: label })).toBeTruthy();
  });

  /**
   * **边界要说出口。** 放假通知是发布出来的数据，表到哪年为止就排到哪年——
   * 之后这条重复自己结束（`nextOccurrence` 返回 null）。「它某天会停」是人
   * 有权提前知道的事，而不是等到那天发现下一条没生成。
   */
  it.each([['workday'], ['holiday']] as const)('%s 把数据覆盖到哪一年说出来', (every) => {
    show(R({ every }));
    const hint = document.querySelector('.ink-hint');
    expect(hint?.textContent).toContain('放假通知');
    // 年份是读出来的、不是写死在文案里的。
    expect(hint?.textContent).toMatch(/20\d\d 年为止/);
  });

  it.each([['lunar-year'], ['week'], ['day']] as const)('%s 不显示那句提示——农历和公历都是算出来的，没有这个边界', (every) => {
    show(R({ every }));
    expect(document.querySelector('.ink-hint')).toBeNull();
  });

  it('摘要：农历那两档说「农历」，锚点也标明是农历的号数', () => {
    expect(describeRepeat(R({ every: 'lunar-year', monthDay: 15 }))).toContain('农历每年');
    expect(describeRepeat(R({ every: 'lunar-year', monthDay: 15 }))).toContain('农历 15 号');
    // 公历月重复不加「农历」前缀——两种历里的「15 号」不是同一天。
    expect(describeRepeat(R({ every: 'month', monthDay: 15 }))).not.toContain('农历');
  });

  it('摘要：法定工作日/节假日，间隔大于 1 时单位说得出来', () => {
    expect(describeRepeat(R({ every: 'workday' }))).toContain('每个法定工作日');
    expect(describeRepeat(R({ every: 'workday', interval: 3 }))).toContain('3 个工作日');
    expect(describeRepeat(R({ every: 'holiday', interval: 2 }))).toContain('2 个节假日');
  });
});

/**
 * **表用完之后：不让选，而不是选了之后一条都不生成。**
 *
 * 这是「拒绝创建」放在唯一合适的位置——创建那一刻。没有放进服务端的形状
 * 校验器：那份对每一次 PATCH 都跑，而这张表会随依赖升级而变，写进去等于让
 * 一条今天存得下的任务明年改一个字都保存不回去。理由写在 `holidayDataUsable`
 * 上面。
 */
describe('RepeatFields：放假通知的表用完之后', () => {
  const inYear = (y: number, fn: () => void) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(y, 5, 1));
      fn();
    } finally {
      vi.useRealTimers();
    }
  };
  const optionOf = (label: string) => screen.getByRole('option', { name: new RegExp(label) }) as HTMLOptionElement;

  it('今年在覆盖范围内：那两档选得了', () => {
    inYear(2026, () => {
      show(null);
      expect(optionOf('每个法定工作日').disabled).toBe(false);
      expect(optionOf('每个法定节假日').disabled).toBe(false);
    });
  });

  it('今年已经超出覆盖范围：那两档置灰，名字里说明为什么', () => {
    inYear(2035, () => {
      show(null);
      expect(optionOf('每个法定工作日').disabled).toBe(true);
      expect(optionOf('每个法定节假日').disabled).toBe(true);
      expect(optionOf('每个法定工作日').textContent).toContain('数据已过期');
    });
  });

  it('别的档位不受影响——置灰的只是那两个', () => {
    inYear(2035, () => {
      show(null);
      expect(optionOf('农历每年').disabled).toBe(false);
      expect(optionOf('每周').disabled).toBe(false);
    });
  });

  /**
   * **已经选着那一档的存量任务不置灰。** 置灰的 `<option>` 在被选中时浏览器
   * 会把 select 显示成空白——人连自己现在是什么规则都看不到了，而那条任务
   * 是他早就存下的，不是他此刻在创建的。
   */
  it('存量任务已经在用那一档：不置灰，看得见自己是什么规则', () => {
    inYear(2035, () => {
      show(R({ every: 'workday' }));
      expect(optionOf('每个法定工作日').disabled).toBe(false);
      expect((screen.getByLabelText('重复') as HTMLSelectElement).value).toBe('workday');
    });
  });

  it('提示那句话跟着换：从「之后会自己结束」变成「今年已经排不出来了」', () => {
    inYear(2035, () => {
      show(R({ every: 'workday' }));
      expect(document.querySelector('.ink-hint')?.textContent).toContain('已经排不出来了');
    });
  });
});
