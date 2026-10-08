import { useEffect, useState } from 'react';
import { Alert, Button, Space } from 'antd';

interface Props {
  /** 排定的绝对触发时间，ISO 字符串——server/src/autoExpand.ts 算好的，这里不重算。 */
  at: string;
  onRunNow: () => void;
  onSkip: () => void;
}

/**
 * 「还剩多久」说成人话。一分钟以内报秒——那正是这个组件自己养一个 1 秒定时器的
 * 意义，也是绝大多数情况（默认延迟 60 秒）。往上一档报分钟/小时：设置里那一档写
 * 的是「10～3600 秒」，把延迟调到半小时是界面自己允许的，而「约 1799 秒后」是
 * 一串要心算的数。
 *
 * 不跟 `lib/reschedule.ts` 的 `snoozeLabel` 共用：那个数的单位是分钟、说的是
 * 「他刚选了推多久」，这个数的单位是秒、每一秒都在变，说的是「还有多久」。
 * 两件事碰巧都叫时长（同一个道理见 `server/src/reminder.ts` 里
 * 「`PERSIST_EVERY_MS` 跟 `SNOOZE_MIN` 是同值不同概念」那段）。
 */
const after = (sec: number): string => {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分钟`;
  return `${Math.round(sec / 3600)} 小时`;
};

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
      message={`下次自动拆解：${clock}（约 ${after(remainingSec)}后）`}
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
