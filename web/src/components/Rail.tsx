import { NavIcon } from './NavIcon.js';

export interface RailItem {
  key: string;
  label: string;
  /**
   * 这一颗是不是「当前」。**不给就按 `current === key` 判**——够用，除了
   * 「任务」那一颗：它对应的是一整段（收件箱/今天/全部/清单/标签……），站在
   * 「全部」上时 `current` 是 `all`、跟它的 key 对不上，可人明明就在任务模块里。
   */
  active?: boolean;
  /**
   * 归哪一段（`lib/views.tsx` 的 `NavGroup`）。**只用来画分隔**：段一换就在
   * 上面加一道横线。不传的话整条栏就是一列，也对。
   */
  group?: string;
  /** 角上那个数字。0 或 undefined 不画，跟侧栏同一条规矩。 */
  count?: number;
}

interface Props {
  items: RailItem[];
  /** 当前在哪个去处。不在这条栏上时一个都不高亮，那是正常的（多数时间人在任务列表里）。 */
  current: string;
  onSelect: (key: string) => void;
  /**
   * 打开搜索弹层。**搜索是个动作，不是去处**——它不进上面那份 items（不占
   * 数字键、不进命令面板的视图那一批），跟「设置」一样单独摆一颗。
   */
  onSearch: () => void;
  onOpenSettings: () => void;}

/**
 * 最左边那条竖图标栏（仿滴答清单）。
 *
 * **它跟旁边那条清单侧栏是两层，不是一层的两段。** 侧栏回答「看哪一批任务」
 * （今天、这个清单、这个标签）；这条栏回答「用哪个模块」——习惯、专注统计、
 * 纪念日、回顾跟那列清单一点关系都没有，站在「习惯」上看着一列清单，那列
 * 清单什么也解释不了。
 *
 * 这几项原来挂在顶栏上横着排（`.ink-modules`）。换成竖栏有两个实在的理由：
 * ① 顶栏那一排跟侧栏那一列在视觉上是并列的，看不出「上一层」的关系；
 * ② 顶栏那一排每加一项就吃掉一截标题的宽度，而竖栏是往下长的，那个方向的
 *    空间这一屏一直空着。
 *
 * **只有记号，没有文字。** 四项、各自一个形状分明的记号，鼠标停下有 `title`，
 * 读屏读 `aria-label`——两者都直接取注册表里那个名字，不另起一个短名：同一
 * 个东西有两个名字，是这个仓库反复记账的那类坑（见 `lib/statusLabel.guard.test.ts`）。
 */
export function Rail({ items, current, onSelect, onSearch, onOpenSettings }: Props) {
  return (
    <div className="ink-modrail">
      {/* 应用自己的记号（brand/mark.svg 那个「圈点」：三根竖条 + 一个群青的圈）。
          不是按钮，点不动——一个只会把你带回首页的 logo，在一个没有首页的应用
          里没有意义。

          **这是给 26px 重画的一版，不是把原图缩小**：原图那个圈是 256 的画布上
          6 的描边，缩到 26px 只剩 0.6px，等于没画——而那个圈正是这个记号的全部
          意思。这里画布改成 24、笔画按这个尺寸重定，三根竖条也跟着加粗。 */}
      <svg
        className="ink-modrail-mark"
        viewBox="0 0 24 24"
        width="26"
        height="26"
        aria-hidden="true"
        focusable="false"
      >
        <g fill="currentColor">
          <rect x="3" y="5" width="2.6" height="9" rx="1.3" />
          <rect x="7.7" y="5" width="2.6" height="13" rx="1.3" />
          <rect x="18.4" y="5" width="2.6" height="16" rx="1.3" />
        </g>
        <circle cx="14.6" cy="9.6" r="3.1" fill="none" stroke="var(--ink-ai)" strokeWidth="1.8" />
      </svg>

      {/* 只有这一段是导航地标。**下面那颗「设置」在外面**：它开的是一个抽屉，
          不是一个去处，躺在 nav 里会被读屏当成第五个导航项报出来。 */}
      <nav aria-label="模块">
      <ul className="ink-modrail-list">
        {items.map((it, i) => (
          // 段与段之间一道横线。判据是「跟上一项不同段」，不是写死第几个
          // ——某一段被逐项关光了（设置里的「导航显示」），线不该还留着。
          <li key={it.key} className={i > 0 && it.group !== items[i - 1]!.group ? 'ink-modrail-sep' : undefined}>
            <button
              type="button"
              className="ink-modrail-btn"
              // 只有记号的按钮必须自报名字，不然读屏读出来是一个空按钮。
              aria-label={it.label}
              title={it.label}
              {...((it.active ?? current === it.key) ? { 'aria-current': 'page' as const } : {})}
              onClick={() => onSelect(it.key)}
            >
              <NavIcon name={it.key} />
              {/* 数字挪到记号右上角——竖栏里没有横向空间摆它。0 不画。 */}
              {it.count ? <span className="ink-modrail-count">{it.count}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      </nav>

      {/* 搜索。**摆在模块下面、设置上面**：滴答那条竖栏上它就在这个位置。
          点开是一个浮在整屏之上的框，不换右边那一栏——理由在 SearchModal.tsx。 */}
      <button
        type="button"
        className="ink-modrail-btn ink-modrail-search"
        aria-label="搜索"
        title="搜索"
        onClick={onSearch}
      >
        <NavIcon name="search" />
      </button>
      {/* 设置沉到底（仿滴答清单：它那条栏底下是同步/通知/帮助）。它不是一个
          「去处」，是一个抽屉，所以不进上面那份 items、也不参与 aria-current。 */}
      <button
        type="button"
        className="ink-modrail-btn ink-modrail-foot"
        aria-label="设置"
        title="设置"
        onClick={onOpenSettings}
      >
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {/* 三根推子，不是齿轮。**齿轮那种「圆 + 一圈辐条」在 15px 下读出来
              是一个太阳**——实测截图里就是。推子（几条横线各挂一个滑块）在
              这个尺寸下还认得出，而且「调一调」正是设置在做的事。 */}
          <path d="M2 4h5M9.5 4h4.5M2 8h9M13 8h1M2 12h2.5M7 12h7" />
          <circle cx="8.2" cy="4" r="1.5" />
          <circle cx="12" cy="8" r="1.5" />
          <circle cx="5.7" cy="12" r="1.5" />
        </svg>
      </button>
    </div>
  );
}
