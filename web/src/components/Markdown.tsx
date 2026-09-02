import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 备注按 markdown 渲染。`notes` 是 AI 也会写的字段（AGENTS.md「补充说明，
 * 支持 markdown」），走「解析成 HTML 串 → dangerouslySetInnerHTML」那条路
 * 得再配一个消毒库，而且那是这类应用里 XSS 最常见的长法——react-markdown
 * 直接构造 React 元素，根本不经过 HTML 字符串，少一个依赖也少一个出错的地方。
 *
 * **千万别加 `rehype-raw`。** 不装它就是这个组件唯一的安全边界：mdast 里的
 * `raw`（原始 HTML）节点默认被转成纯文本节点（见 react-markdown 源码的
 * `transform`），`<script>`/`<b>` 这类标签不会变成真的 DOM 元素，只会原样
 * 显示成一串看得见的字符。Markdown.test.tsx「原始 HTML 不被渲染成元素」
 * 那条断言钉的就是这一点——加了 `rehype-raw` 它就会红。
 *
 * **这只封死了脚本执行面，没封死网络面。** `img`/`a` 走的是 react-markdown
 * 默认的 `urlTransform`（白名单 `http(s)/ircs?/mailto/xmpp`），`http(s)`
 * 图片是放行的——`![x](http://evil.example.com/beacon.gif)` 会真的发一次
 * 外网请求，notes 是 AI 也会写的字段，等于能在这里埋一个追踪像素。对一个
 * 钉死本机的单人工具来说后果有限（泄露的是「这台机器什么时候渲染了这张
 * 卡」+ IP/UA，没有 CSP 兜底），没有现在就收口——真要收口，给 `img` 也配
 * 一个 component 把 `src` 换成一句文字，或者给 `index.html` 加一条
 * `img-src 'self' data:` 的 CSP，见 final-review.md m5。
 *
 * remark-gfm 加勾选框语法（`- [x]`）。它渲染出来的 `<input>` 上游
 * （mdast-util-to-hast 的 list-item handler）已经写死 `disabled: true`，
 * 这里的 `input` 组件再显式强制一次，不赌上游哪天不改这个默认值——
 * markdown 里的勾选框是文本，不是 `subtasks` 那个数据模型，点了没反应
 * 比没有更糟。
 */
/**
 * `inherit`：字号/字色跟着外面走，不用这个组件自己那一套（14px + `--dim`，
 * 那是任务卡上「补充说明」该有的分量）。随手记那条原话是收件箱那一栏的主角，
 * 压暗会让「待拆解」几条看起来像已经处理过的。
 *
 * **做成一个类名而不是在外面写 `.ink-note-text .ink-notes-md`**：祖先打头的
 * 选择器会从 theme.css.test.ts 那条 `.ink-notes-md` 前缀扫描里整条隐形（那条
 * 守卫存在的理由就是它），跟 `.ink-cal-daynum-today` 当初为什么不写成
 * `.fc-day-today .ink-cal-daynum` 是同一条规矩。
 */
/**
 * `inline`：**只渲染行内格式，不另起段落。** 用在检查事项那一行上——一条
 * 「跑 `npm run report`」现在会把反引号原样显示出来，而这个应用里别的地方
 * （备注）早就按 markdown 渲染了，同一段文字换个字段就变成一串符号。
 *
 * 做法是把 `p` 换成一个 Fragment：mdast 一定会把顶层文字包进段落，那个
 * `<p>` 是块级的，塞进勾选框的标签里会把文字挤到下一行。外壳也跟着换成
 * `<span>`，理由一样。
 *
 * **不禁用块级语法**（标题、表格、列表照样能解析出来）：一条检查事项里写
 * `# 标题` 本来就没有意义，为它加一层白名单是为想象中的输入写代码；而真
 * 写了的话渲染成一个小标题也不会把界面搞坏。
 */
/**
 * **单个换行就是换行**，全局如此。
 *
 * markdown 的规矩是「软换行 = 一个空格」，要真换行得敲两个空格或者空一行。那是
 * 写 markdown 的人的约定，**而这个应用里这些文字大半不是写 markdown 的人打的。**
 *
 * 这一条上一版是个 `breaks` 开关，只给随手记用，理由写的是「任务的 `notes` 是
 * AI 按 markdown 写的，那边标准语义才是对的」。那句话只覆盖了 `notes` 的**三个
 * 来源里的一个**：
 *
 * - AI 写的（AGENTS.md 那节）——是 markdown，但它是往 JSON 字符串里写，
 *   `\n` 只在真要换行的地方出现，没有「排版折行」这回事；
 * - **「变成任务」原样搬过来的随手记原文**（`splitCapture`：第一行当标题，
 *   剩下的整段进 `notes`）——那正是随手记那个框里「想到什么写什么」的字；
 * - **备注编辑器里手打的**——那是个光秃秃的 `<textarea>`，敲 Enter 就换行。
 *
 * 第三条最难受：**同一个框里，编辑时看到三行，存下之后预览成了一行。**
 *
 * 于是四个调用点没有一个想要「合并换行」，那个开关是个恒定值。删掉它，
 * 规则直接挂在 `.ink-notes-md p` 上。
 *
 * **不加 `remark-breaks`**：一条 CSS 就够了。软换行在 mdast 里本来就是段落内一个
 * 带换行符的文本节点，`white-space: pre-wrap` 把它画出来而已。只给 `p`，不给
 * `pre`/表格——它们自己的白空规则是对的。
 */
export function Markdown({ source, inherit, inline }: { source: string; inherit?: boolean; inline?: boolean }) {
  if (!source) return null;
  const cls = [
    'ink-notes-md',
    inherit ? 'ink-notes-md-inherit' : '',
    inline ? 'ink-notes-md-inline' : '',
  ].filter(Boolean).join(' ');
  const Wrap = inline ? 'span' : 'div';
  return (
    <Wrap className={cls}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // target=_blank 得配 rel="noopener noreferrer"：新开的页能拿
          // window.opener 反过来操纵这一页（tabnabbing），react-markdown
          // 默认不加这两样。**只对真的会跳出这个应用的链接加**——锚点/相对
          // 链接（`[去今天](#today)`、空 destination 的 `[go]()`）不加：这个
          // 应用的路由本身就是 hash（App.tsx 的 viewFromHash），href 以 `#`
          // 开头或为空时强行 target=_blank 会新开一个标签页跑出第二个应用
          // 实例，而不是像正常锚点那样跳到当前页的某处——见
          // final-review.md m4。
          a: ({ node: _node, href, ...props }) => (
            !href || href.startsWith('#')
              ? <a href={href} {...props} />
              : <a href={href} {...props} target="_blank" rel="noopener noreferrer" />
          ),
          input: ({ node: _node, ...props }) => <input {...props} disabled />,
          // 表格外面套一层自己滚的容器：一张宽表不该把整张卡（进而整页）
          // 顶出横向滚动条——那是这个仓库的量测夹具一直在盯的缺陷。
          table: ({ node: _node, ...props }) => (
            <div className="ink-notes-md-table"><table {...props} /></div>
          ),
          // 行内模式下段落那层壳去掉，只留里面的内容，见上面 `inline` 的注释。
          ...(inline ? { p: ({ node: _node, children }) => <>{children}</> } : {}),
        }}
      >
        {source}
      </ReactMarkdown>
    </Wrap>
  );
}
