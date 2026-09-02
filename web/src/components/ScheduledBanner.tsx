import { useEffect, useState } from 'react';
import { Alert, Button, Space } from 'antd';

interface Props {
  /** 排定的绝对触发时间，ISO 字符串——server/src/autoExpand.ts 算好的，这里不重算。 */
  at: string;
  onRunNow: () => void;
  onSkip: () => void;
}

/**
 * 「下次自动拆解：14:32（约 45 秒后）」+ 两个动作。
 *
 * 自己管一个 1 秒的定时器，不借用 App.tsx 里给「任务过期」判断用的那个 60 秒
 * tick——两者更新频率天差地别，硬凑一起要么倒计时卡成整分钟跳一下，要么让
 * 全页面（包括跟倒计时毫不相干的看板）跟着每秒重渲染。组件卸载（状态变成
 * scheduled 以外的任何值）时这个定时器自然跟着卸载，不需要额外清理逻辑。
 */
export function ScheduledBanner({ at, onRunNow, onSkip }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const target = Date.parse(at);
  const remainingSec = Number.isNaN(target) ? 0 : Math.max(0, Math.round((target - now) / 1000));
  // hour12: false 是必须的——不给的话某些 ICU 构建会渲染成「下午02:32」而不是
  // 设计里写的「14:32」，看着不像同一个东西。
  const clock = Number.isNaN(target) ? '' : new Date(target).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <Alert
      type="info"
      showIcon
      message={`下次自动拆解：${clock}（约 ${remainingSec} 秒后）`}
      action={
        <Space>
          {/* 跟侧栏那颗按钮同名——两处调的是同一个 api.expand()，而且这条横幅
              出现的时候侧栏那颗就在旁边，同屏两个名字指同一件事。
              见 2026-08-12-ux-audit.md「一个动作在整个流程里必须用同一个词」。 */}
          <Button size="small" onClick={onRunNow}>立即拆解</Button>
          <Button size="small" onClick={onSkip}>这次不拆</Button>
        </Space>
      }
    />
  );
}
