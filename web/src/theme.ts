import type { ThemeConfig } from 'antd';

/**
 * 两种墨水的调色板——唯一定义这几个色值的地方。`theme.css` 里 `:root` 的
 * CSS 变量是它的手写 CSS 副本（CSS 没法 import 一个 .ts 里的常量），改颜色
 * 时两处一起改，就近各自留一句指向对方的注释，不用真的共享一份运行时状态。
 *
 * 群青（ai）是有配额的颜色：只标记「这是 AI 写的/推断的」。这份主题里唯一的
 * 例外是键盘焦点环——那是规格明确批准的无障碍底线，不算「乱用」。
 *
 * `overdue`/`dim` 是规格文档改过的值（已归档的 `docs/superpowers/specs/2026-08-11-ink-redesign.md`
 * 的 Token 表）：初稿的 `#C2410C`/`#6E737C` 在纸/页两种底色上实测只有
 * 3.96～4.30，过不了小字 AA 的 4.5，规格明确说了「别把它们调浅回去」——
 * 这两个颜色专用在时间戳、「已过期」这类最小号的字上。
 */
export const ink = {
  paper: '#EFEDE8',
  sheet: '#FAF8F5',
  you: '#211F1D',
  ai: '#2E3ED4',
  overdue: '#A8380A',
  rule: '#D4CEC3',
  /**
   * **改过一次，是量出来的。** 上一版 `#6D655A` 只在纸（`paper`）和页（`sheet`）
   * 这两种底色上验过——而这个界面还有第三种面：侧栏那层 `rgb(227,225,220)`。
   * 同一个色在那儿只有 4.39:1，导航上的计数徽标、标签前的 `#`、日历里农历那
   * 一行全压在 AA 的线下。现在这个值三种面都过（页 5.71 / 侧栏 5.11 / 卡 6.30）。
   *
   * **一个颜色 token 的对比度不是它自己的属性，是它跟每一个会用到它的面之间
   * 的关系**——下面 `theme.test.ts` 那两条只验了两种面，正是那个盲区放过了它。
   */
  dim: '#635B50',
} as const;

export const FONT_CJK = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
export const FONT_SERIF = '"Songti SC","SimSun","Noto Serif SC",Constantia,Cambria,serif';
export const FONT_MONO = 'Consolas,"Cascadia Code",ui-monospace,monospace';

/**
 * antd 6 的 ThemeConfig。视觉全部走 token——不在组件上写行内样式覆盖。
 *
 * 组件级 override 只列了 Button 和 Tag，不是漏了别的：Card / Alert / Input /
 * DatePicker / Drawer / List / Collapse / Empty 的背景、边框、圆角、字体全部
 * 从下面这几个全局 token 派生（colorBgContainer / colorBorder / borderRadius /
 * fontFamily），组件默认值本身就是引用它们，照抄一份内容相同的 override 只是
 * 噪音。真正需要压一压的只有两处：
 *
 * 1. Button 的 hover/active 边框颜色默认引用 colorPrimaryHover/Active——
 *    普通按钮（编辑/删除/开始……）hover 起来会被染成群青，这跟“群青只标记
 *    AI 产出”冲突，这里压回你的墨。
 * 2. Tag 的无色（默认）变体要落在纸面调色板里，不是 antd 默认的浅灰。
 *
 * Switch（以及后来发现同样情况的 Checkbox）的选中态颜色是例外：两者的样式
 * 生成函数都直接读合并后的 `token.colorPrimary`（`antd token Switch`/
 * `antd token Checkbox` 都不列出一个能覆盖这个颜色的组件级 token——Checkbox
 * 干脆一个组件 token 都没有），不经过 `theme.components.Xxx` 这层能覆盖的口子。
 * 这份全局主题没法治它们：真正的修法是在用到它们的地方（SettingsModal 的
 * 两个 Switch、TaskBoard 的子任务 Checkbox）套一层局部
 * `<ConfigProvider theme={{ token: { colorPrimary: ink.you } }}>`——嵌套
 * ConfigProvider 会重新算一份合并 token 传给子树，Switch/Checkbox 内部读到的
 * 就是这份局部值，不是全局的群青。这是 antd 官方支持的嵌套主题机制，不是行内
 * 样式或 CSS hack，分别见 SettingsModal.tsx 和 TaskBoard.tsx。
 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: ink.ai,
    colorBgLayout: ink.paper,
    colorBgContainer: ink.sheet,
    colorBgElevated: ink.sheet,
    colorTextBase: ink.you,
    /**
     * **次要文字也走 `ink.dim`，不留 antd 那份 45% 墨。**
     *
     * 这个仓库对「次要文字」有一份量过的颜色（`--dim`，三种底色上都过 AA），
     * 但那条规矩只管手写 CSS——**antd 的 `Typography type="secondary"` 读的是
     * `colorTextDescription`（默认 45% 墨），不是名字更像的 `colorTextSecondary`
     * （默认 65%，≈4.6，本来就过得了）**，完全绕开了 `--dim`。查过
     * `node_modules/antd/es/typography/style/index.js`：`-secondary` 那条规则写的
     * 就是 `color: token.colorTextDescription`。实测：设置弹层里那几行分节标题
     * （「换种看法」等，12px）只有 2.77:1，而门槛是 4.5——2.77 正是 45% 那一档
     * 算出来的数，65% 那一档根本算不出这个值。
     *
     * 这是上一轮修 `--dim` 时漏掉的一整条通道：那次量的是默认态的几屏，而这
     * 7 处 `type="secondary"` 全在设置弹层里——一个要点开才看得见的瞬时态。
     *
     * `colorTextSecondary` 一并压：antd 的 Menu 次要项、`Descriptions` 的 label
     * 那几处读的是它。它默认压线过（≈4.6），压下来是防着谁把它再调浅。
     */
    /**
     * **同一条通道上还有三个 token 也读 45%/25% 的墨，一并压。**
     *
     * 上一轮只压了 secondary/description 两个，是按「哪几处报了 2.77」倒推的，
     * 而派生表里同一档还有：
     *
     * | token | 原值 | 纸 / 页 | 门槛 |
     * |---|---|---|---|
     * | `colorTextTertiary` | 45% 墨 | 2.71 / 2.77 | 4.5（正文） |
     * | `colorIcon` | 45% 墨 | 2.71 / 2.77 | 3（WCAG 1.4.11，图标是控件） |
     * | `colorTextPlaceholder` | 25% 墨 | 1.67 / 1.68 | 4.5（占位符是文字） |
     *
     * `colorIcon` 是 antd Modal 关闭那颗 `×` 读的（`modal/style` 里
     * `modalCloseIconColor: token.colorIcon`）——**正是「设置」抽屉右上角那颗**，
     * 也就是上一轮拿 2.77 当缺陷举例的那一屏。
     *
     * **占位符不豁免。** WCAG 只豁免 disabled 控件，`colorTextDisabled` 因此
     * 留在 25%（1.67）不动。而这个应用的占位符在好几处是那个输入框**唯一**的
     * 说明——随手记那条「想到什么写什么，不用整理」、行内那条「添加任务」
     * ——1.67:1 等于没写。
     *
     * 压到 `ink.dim` 而不是压到刚够门槛：`--dim` 在纸/页/侧栏三种面上是
     * 5.71 / 6.30 / 5.11，三处都够，而「刚够 4.5」的那一档（#6E6A64）在侧栏底
     * 上只有 4.11——随手记那个输入框恰恰就在侧栏里。占位符跟已填的值仍然分得
     * 开：值读 `colorText`（10:1 的近黑），比它深得多。
     */
    colorTextSecondary: ink.dim,
    colorTextTertiary: ink.dim,
    colorTextQuaternary: ink.dim,
    colorTextDisabled: 'rgba(33,31,29,0.25)',
    /**
     * **禁用态必须显式钉回去。**
     *
     * antd 的 `colorTextDisabled` 是**从 `colorTextQuaternary` 派生的**，而且那一步
     * 发生在合并覆盖之**后**（`antd/es/theme/util/alias.js`：
     * `colorTextDisabled: mergedToken.colorTextQuaternary`）。所以上面那行一压，
     * 禁用态跟着变成 `#635B50`——**跟普通次要文字一模一样**，实测过。
     * 那时候「这颗按钮点不了」就只剩 4% 的底色一个线索了：另一张卡占着番茄钟锁时
     * 的「开始专注」、纪念日那颗禁用的「保存」、收件箱的「立即拆解」全中招。
     *
     * 上一版这儿写着「`colorTextDisabled` 因此留在 25%（1.67）不动」——那句话在
     * 写下的同一刻就已经是假的，因为紧挨着的 quaternary 把它带走了。
     */

    /**
     * **`colorTextQuaternary` 也要压，而且它是 placeholder 的上游。**
     *
     * 上一轮压了 secondary/description/tertiary/icon/placeholder 五个就收手了
     * ——名单还是倒推的（「哪几个报过错」），于是又漏了这一个：它仍是 25% 墨、
     * 1.67:1。而 antd 的 `colorTextPlaceholder` **默认就是从 quaternary 派生的**，
     * 只覆盖派生结果、不动源头，等于别的消费者（Select 的后缀箭头、allowClear
     * 那颗清除图标、Empty 的描述）照旧读着 1.67。
     *
     * 下面那条守卫已经改成**遍历** `getDesignToken()` 里所有 `colorText*` /
     * `colorIcon*`，不再手抄名单——手抄第三次还是会漏第三个。
     */


    colorBorder: ink.rule,
    colorBorderSecondary: ink.rule,
    colorError: ink.overdue,
    // Alert 的 info/warning/success 三种底色直接读 colorXxx（图标）/colorXxxBg/
    // colorXxxBorder 这几个全局 token（查过 node_modules/antd/es/alert/style/
    // index.js：`genAlertTypeStyle(colorXxxBg, colorXxx, ...)`，图标颜色是种子
    // token 本身，不是派生的 Text token）——不设的话这三种横幅就是 antd 默认的
    // 黄/蓝/绿，跟纸面调色板完全不搭。真正的报错（AI 拆解失败）已经靠 colorError
    // 落在过期橙上，这里再报一次色就重复了；一致地把三个种子都压成你的墨、
    // 底色压成页色、描边压成线色，警示只留给「真出错」那一档过期橙，
    // 其余横幅安静，用图标形状和文案区分，不用颜色区分。
    colorSuccess: ink.you,
    colorSuccessBg: ink.sheet,
    colorSuccessBorder: ink.rule,
    colorWarning: ink.you,
    colorWarningBg: ink.sheet,
    colorWarningBorder: ink.rule,
    colorInfo: ink.you,
    colorInfoBg: ink.sheet,
    colorInfoBorder: ink.rule,
    borderRadius: 0,
    fontFamily: FONT_CJK,
    fontFamilyCode: FONT_MONO,
    wireframe: false,
  },
  components: {
    Button: {
      fontWeight: 400,
      defaultHoverColor: ink.you,
      defaultHoverBorderColor: ink.you,
      defaultActiveColor: ink.you,
      defaultActiveBorderColor: ink.you,
      // v4 遗留的按钮投影：纸面是切边的，不是立体的，去掉。
      defaultShadow: 'none',
      primaryShadow: 'none',
      dangerShadow: 'none',
      // color="default" variant="solid" 用这两个当底色/字色——「保存」这类确认
      // 本地编辑的按钮走这条，不走 type="primary"：primary 会拿 colorPrimary
      // 也就是群青，那是 AI 的颜色，不该出现在你自己点的按钮上。
      solidTextColor: ink.sheet,
    },
    Tag: {
      defaultBg: ink.sheet,
      defaultColor: ink.you,
    },
    Switch: {
      // antd 默认 44×22，差 2px 够不到 24px 这条点击目标下限（量测夹具在设置
      // 抽屉里逮到设置页的两个开关，见 2026-08-12-ux-audit.md）。走尺寸 token
      // 不走 CSS min-height——直接掰高轨道会让里面的圆滑块留在原来的尺寸，
      // 上下多出两条空隙，token 会把轨道和滑块一起等比放大。
      trackHeight: 24,
      handleSize: 20,
    },
  },
};

/**
 * SettingsModal 的两个 Switch、TaskBoard 的子任务 Checkbox 和编辑态的
 * DatePicker 都套一层局部 `<ConfigProvider theme={boardLocalTheme}>`——两个
 * 文件用同一份具名导出，不是各自 inline 一份、改一处漏一处。
 *
 * 只压 `colorPrimary` 是不够的：`colorPrimary` 是 antd 派生一整套 alias token
 * 的种子，`controlItemBgActive`（默认等于 `colorPrimaryBg`，即种子色的浅色调）
 * 也在这条派生链上。种子从「亮而饱和」的群青换成「近黑」的 ink.you 之后，
 * antd `generate()` 那套按亮度分档混色的算法对近黑种子不成立——`getDesignToken`
 * 实测得到的不是一个浅色调，是 #5b5e61 这种中灰。DatePicker 编辑态里选中的
 * 时/分/秒格背景刚好就读这个 token，文字仍然是近黑的 colorText，对比度从
 * ~15:1 掉到 ~2.6:1，用户看不清当前选的是哪一格，可能存错提醒时间也不知道。
 *
 * 这里不重新种 colorPrimary 派生出的其它 alias token（那样又要挨个核一遍
 * 有没有牵连到别的控件），只单独把这一个被牵连的 token 覆盖回一个明确、
 * 独立于这次重新派生的浅色——复用 ink.rule（线框那个中性浅灰，本来就在
 * 调色板里，不是另起一个新颜色）。contrast(colorText, ink.rule) 实测
 * 10.16:1，过 AA 也过 AAA。
 *
 * `controlHeightSM: 24`（task-4-brief 修复轮 1 · m-4）：FilterBar 的
 * 「筛选/清空/存成智能清单/收起」四颗 `size="small"` 按钮都套在这层
 * ConfigProvider 下面，24px 点击目标现在**碰巧**等于 antd 这个 token 的
 * 默认值——不显式钉住的话，它是「白捡的」而不是「保证的」：这个仓库已经
 * 为 24px 点击目标单独兜过六次底（`.ink-nav-tag`/`.ink-pri-btn`/
 * `.ink-tag-x`/`.ink-repeat-day`/`.ink-cal-nav button`/`.ink-trow-handle`，
 * 都是显式 `min-height` + 断言），Switch 那行 `trackHeight: 24` 是同一条
 * 教训在 antd 组件 token 上的版本（默认 22，差 2px）——antd 的默认值不是
 * 承诺，说变就能变。显式写出来，配 FilterBar.test.tsx 里读
 * `--ant-control-height-sm` 自定义属性的断言（antd 6 css-var 模式，跟
 * 读 `--ant-color-primary` 同一套办法）。
 */
export const boardLocalTheme: ThemeConfig = {
  token: { colorPrimary: ink.you, controlItemBgActive: ink.rule, controlHeightSM: 24 },
};
