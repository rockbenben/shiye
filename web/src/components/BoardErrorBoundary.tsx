import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button } from 'antd';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 只包 TaskBoard，不包整个 App。
 *
 * `data/tasks/` 和 `data/inbox/` 下的文件是手改的（**一个实体一个文件**，
 * 不是早年那两份 `data/tasks.json` / `data/inbox.json`——那个形状早就搬走了，
 * 见 store.ts 的 `paths()`）。一个类型错的字段（比如 taskIds 漏了方括号）
 * 能在渲染期间直接炸出一个 TypeError——这个仓库没有
 * 全局错误边界，React 会把这个错误一路冒泡到根，整个应用卸载成白屏，
 * 连设置弹层、收件箱都点不到，用户连「这是哪个文件坏了」都无从查起。
 *
 * 只在 TaskBoard 外面包一层：React 的错误边界只吞它包住的子树里的渲染错误，
 * 不会往上冒泡到没被包住的兄弟节点——顶栏、设置按钮、收件箱侧栏都在这层
 * 边界之外，board 崩了它们照样能用。提示写清楚**去哪个目录里找**、下一步做什么，
 * 报不出具体是哪一个文件（React 拿到的只是一个 TypeError，不知道它来自哪条数据），
 * 但至少不能把人指到一个不存在的路径上——那比不提示更糟。
 * 不是只吞掉报错换一句空话——规格里「报出来，不能悄无声息地整个坏掉」
 * 这条哲学不该只用在数据层，界面层同一条命也得保。
 */
export class BoardErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[任务看板] 渲染出错：', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert
        type="error"
        showIcon
        message="任务看板加载失败"
        description={
          <>
            <p style={{ margin: '0 0 6px' }}>
              多半是 <code>data/tasks/</code> 或 <code>data/inbox/</code>{' '}
              下某个文件里的字段类型不对——比如手改时把数组写成了字符串。这两个目录是一个条目一个 <code>.json</code>，按最近改过的那几个先看；改好之后点右边「重试」，或者刷新页面。
            </p>
            <p className="ink-mono" style={{ margin: 0, fontSize: 11, opacity: 0.75 }}>{error.message}</p>
          </>
        }
        action={
          <Button size="small" onClick={() => this.setState({ error: null })}>重试</Button>
        }
      />
    );
  }
}
