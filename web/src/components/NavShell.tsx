import { type ReactNode } from 'react';
import { Col, Drawer } from 'antd';
import { ColGrip, clampWidth } from './ColGrip.js';

/** 侧栏宽度的上下限。下限是「清单名 + 计数 + ⋯ 三样还排得下」，上限是别把看板挤没。 */
export const NAV_MIN = 200;
export const NAV_MAX = 460;
/** 没拖过时的宽度。跟抽屉那边 296 = 280 + 16 内边距是同一个数。 */
export const NAV_DEFAULT = 280;

/** 这一栏的上下限焊死在这儿——调用方（App.tsx 从 localStorage 读回来那次）不用自己记两个数。 */
export const clampNavWidth = (w: number): number => clampWidth(w, NAV_MIN, NAV_MAX);

interface Props {
  /** 窄屏（`lib/narrow.ts` 的断点）。 */
  narrow: boolean;
  /** 窄屏下抽屉开着没有。宽屏忽略。 */
  open: boolean;
  onClose: () => void;
  /** 宽屏下这一列多宽。窄屏忽略（抽屉是固定宽度）。 */
  width?: number;
  /** 给了才出现那条可拖的界线。不给就是原来那样，钉死在 `width`。 */
  onResize?: (w: number) => void;
  children: ReactNode;
}

/**
 * 清单侧栏的外壳：宽屏是并排的一列，窄屏是划出来的抽屉。
 *
 * **为什么窄屏不能就摆在那儿。** 竖栏在手机上躺平成顶上一条，紧接着就是这条
 * 侧栏（导航 + 清单 + 标签 + 随手记）——实测 390×844 上它占掉七百多像素，
 * 于是**打开应用，第一屏一条任务都看不见**。而这个应用打开就是为了看今天
 * 要做什么。滴答清单在手机上的答案在它帮助文档里写着：侧边栏是划出来的，
 * 不占列表那一屏（「在清单详情页，向右滑动即可快速打开侧边栏」）。
 *
 * 用 antd `Drawer` 不自己写手势：焦点陷阱、Esc 关闭、遮罩点击都是现成的。
 * （这儿原来还写着「而且设置抽屉本来就是它，手机上两个抽屉长一个样是对的」
 * ——设置早就从抽屉换成了分区弹层（`SettingsModal`），那句话现在两头都不成立：
 * 它不是抽屉，屏幕上也不存在「两个抽屉」。这是这条侧栏抽屉**唯一**的一个，
 * 拿别处的一致性替它辩护已经没有对象了；留着 `Drawer` 的理由只剩上面那半句
 * ——现成的焦点陷阱和 Esc，本来也够了。）
 *
 * **只换外壳，不换里面那棵树。** 侧栏本身（`Sidebar`）一个字都不用知道自己
 * 现在待在哪儿——把「宽屏一列 / 窄屏抽屉」这件事写进 `Sidebar` 会让那个已经
 * 六百行的组件再多一条跟它的职责无关的分支。
 *
 * 右缘那条可拖的界线在 `ColGrip`（任务详情那一栏也用它）——为什么自己写、
 * 不用 antd `Splitter`，写在那个文件顶上。
 */
export function NavShell({ narrow, open, onClose, width = NAV_DEFAULT, onResize, children }: Props) {

  if (!narrow) {
    // `xs={24}` 去掉了：窄屏这条列压根不渲染，留着那一档只会让人以为它还在
    // 那个宽度下摊成整行。
    // `0 1`，不是 `0 0`：**shrink 留成 1**。侧栏和详情都拖到最宽时总宽会超过窗口，
    // shrink 是 0 的话谁都不肯让，最后全压在看板那一栏上（实测 1280 上看板只剩
    // 88px、内容横向溢出）。留成 1 之后空间不够时是这两栏各让一点，而看板有自己的
    // 下限守着，见 theme.css 里 .ink-cols 那段。
    return (
      <Col md={{ flex: `0 1 ${width}px` }} className="ink-rail-col">
        {children}
        {/* 界线贴在这一列的**右**缘：往右拖 = 侧栏变宽。 */}
        {onResize && (
          <ColGrip width={width} min={NAV_MIN} max={NAV_MAX} side="right" label="拖动改变清单侧栏的宽度" onResize={onResize} />
        )}
      </Col>
    );
  }
  return (
    <Drawer
      placement="left"
      // 280 是侧栏在宽屏下的默认宽度，加 16 是抽屉自己的内边距——里面那棵树的
      // 可用宽度跟宽屏一致，清单名不会在手机上莫名其妙地多断一行。
      // **这儿不跟着拖出来的宽度走**：手机上那条界线不渲染，宽度是抽屉自己的事。
      width={296}
      open={open}
      onClose={onClose}
      className="ink-nav-drawer"
      // 标题栏整条不要：里面第一段自己就写着「任务」，再顶一条标题是同一句话
      // 说两遍。关闭走遮罩/Esc/点任意一个去处，不摆那颗 ×——跟 SearchModal
      // 的 closable={false} 同一条理由。
      closable={false}
      title={null}
    >
      {children}
    </Drawer>
  );
}
