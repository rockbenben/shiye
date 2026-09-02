import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { PROPOSABLE } from './task.js';
import { HABIT_EVERY } from './store.js';
import { PROMPT } from './expand.js';
import type { Task } from './store.js';

/**
 * **`AGENTS.md` 是给 AI 的契约，而在这条守卫之前没有任何东西盯着它跟代码对账。**
 *
 * 它已经飘过一次，而且是往最糟的方向飘的：`startAt` 加进 `PROPOSABLE` 之后，
 * 「提修改建议」那节的字段名单没跟上（那句话当时还写死着「这十个字段」）——
 * **文档在把一个实际允许的字段说成禁的**。AI 照着文档办，那个字段就永远提不出来，
 * 而这件事不会有任何地方报错：outbox 校验只拦「多写了不该写的」，拦不住「该写的
 * 没写」。
 *
 * 反方向更响：名单里多出一个 `PROPOSABLE` 里没有的字段，AI 照着写，**整个 outbox
 * 文件校验不过**，那一轮回顾的全部产出一起退回去。
 *
 * ## 为什么锚在这句话上，不是「文件里出现过哪些反引号词」
 *
 * 整份 `AGENTS.md` 里 `` `title` `` 这样的词有几十处（字段表、举例、别的小节）。
 * 扫全文等于把一堆无关的词也算成名单，那条断言会恒绿——这个仓库为「锚定规则本身、
 * 不是任意出现的字符串」这条栽过两次（见 `theme.css.test.ts` 顶部）。所以这里从
 * 那一句话的**开头到句号**之间取，取不到就直接报错，不静默放行。
 */

/** 「提修改建议」那节里点名 `patch` 能出现哪些字段的那一句。 */
const HEAD = '`patch` 里只能出现这几个字段：';

/** 「习惯只能配哪些重复档」那一句的开头。 */
const HABIT_HEAD = '`habit: true` 必须配 ';

/** 「这些字段你写了也不算数」那一句的开头。 */
const FORCED_HEAD = '**`order`、';

/**
 * 读 `AGENTS.md`，**把换行符统一成 LF 之后再交给下面的断言**。
 *
 * 少了这一步会出一种最难查的假绿：`.gitattributes` 是 `* text=auto`，仓库里存 LF、
 * **检出时按平台还原**——Windows 上全新克隆拿到的是 CRLF。而下面几处是按「换行 +
 * 锚点 + 换行」去定位的，写死了 LF：本机的工作副本恰好是 LF 所以过，全新克隆和
 * CI 上就抛「AGENTS.md 里找不到这句话」。
 *
 * 实测过：同一个提交，本机 `npm test` 5100 全绿；克隆到别处再跑，`sampleKeys()`
 * 那两条当场红。发布前那次全新克隆冒烟正是这么抓到的。
 *
 * 归一在读取处做一次，不是让每个断言各自去容忍两种行尾——那种要求迟早有人漏，
 * 而漏了的表现是「只在别人机器上红」。
 *
 * 用 `String.fromCharCode` 拼行尾、不写转义字面量：这个文件里那串转义被工具改写时
 * 已经真的变成过一个裸字节，把这段注释和下面的正则一起劈断（`sourceBytes.guard`
 * 当场报了「孤立 CR」）。
 */
const CRLF = String.fromCharCode(13, 10);
const readAgentsMd = (): string => readFileSync('AGENTS.md', 'utf8').split(CRLF).join(String.fromCharCode(10));

function fieldsInAgentsMd(): string[] {
  const md = readAgentsMd();
  const from = md.indexOf(HEAD);
  if (from === -1) {
    throw new Error(`AGENTS.md 里找不到「${HEAD}」这句话——是被改写了还是删了？改写了就把这条守卫的锚点一起改。`);
  }
  // 到句号为止。中间可以换行（这份文档是折行排版的）。
  const rest = md.slice(from + HEAD.length);
  const end = rest.indexOf('。');
  if (end === -1) throw new Error('AGENTS.md 那句话没有句号，取不到边界');
  return [...rest.slice(0, end).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * 「任务对象的字段」那块 json 样例的**顶层**键。嵌套对象（`reminders` 里那个
 * `{ at, firedAt }`）不算——只取缩进两格的那一层。
 */
function sampleKeys(): string[] {
  const md = readAgentsMd();
  const at = md.indexOf('\n任务对象的字段：\n');
  if (at === -1) throw new Error('AGENTS.md 里找不到「任务对象的字段：」这句——锚点没了就把这条守卫的锚点一起改');
  const fence = md.indexOf('```', at);
  const close = md.indexOf('```', fence + 3);
  if (fence === -1 || close === -1) throw new Error('那句话后面没有围栏代码块');
  return [...md.slice(fence, close).matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]);
}

/**
 * `README.md` 那句「AI 能建议改的就这几样」里的中文名。
 *
 * **写成 `Record<PROPOSABLE 的联合类型, string>`，而不是一个数组**：`PROPOSABLE`
 * 加了字段而这里没跟上，**编译就不过**（少一个键）——不靠运行时的长度断言。
 *
 * 不直接用 `ProposalNote.tsx` 那份 `FIELD_LABEL`：那份是提议卡上的**短名**
 * （「截止」「开始」「提醒」），跟正文里该写的长名（「截止时间」）不是一回事，
 * 而且它在另一个包里、也没导出。
 */
const README_LABEL: Record<(typeof PROPOSABLE)[number], string> = {
  title: '标题', notes: '备注', due: '截止时间', startAt: '开始时间',
  reminders: '提醒时间', subtasks: '子任务', tags: '标签', listId: '清单',
  repeat: '重复规则', priority: '优先级', waitingFor: '在等谁', context: '情境',
};

/** README 里那句话的开头。同样锤句子、不扫全文——理由跟上面那段一字不差。 */
const README_HEAD = 'AI 能建议改的就这几样：';

function readmeSentence(): string {
  const md = readFileSync('README.md', 'utf8');
  const from = md.indexOf(README_HEAD);
  if (from === -1) {
    throw new Error(`README.md 里找不到「${README_HEAD}」这句话——被改写了就把这条守卫的锚点一起改。`);
  }
  // 到句号为止。中间可以换行（这份文档是折行排版的）。
  const rest = md.slice(from + README_HEAD.length);
  const end = rest.indexOf('。');
  if (end === -1) throw new Error('README.md 那句话没有句号，取不到边界');
  return rest.slice(0, end);
}

/**
 * **AGENTS.md 开头逐字引了服务发给 AI 的那两句提示词，两边必须对得上。**
 *
 * 那一段说「服务会用两份固定提示词叫起你（正本在 `server/src/expand.ts` 的
 * `PROMPT`）」，然后把两句原话抄了出来。抄的这份是 **AI 自己要读的东西**——它
 * 靠这两句认出「我这次是被叫来拆解还是回顾」。飘了之后，AI 收到的那句和文件里
 * 写的那句对不上，而它没有任何办法知道该信哪个。
 *
 * 这跟 `android/冒烟清单.md` 抄 `LAN_WARNING` 是同一个形状（那处真的飘过一次，
 * 见 `lanBind.test.ts` 末尾那条）。加提示词的时候最容易漏——`review` 那句就是
 * 后加的。
 *
 * **比的时候摘掉句末的句号**：`PROMPT` 里那两句各自带一个「。」，而 AGENTS.md
 * 把它们放在「」引号里、后面接着破折号，句号在那儿是多余的。摘掉之后比的是
 * 句子本身，不会为一个标点假红。
 */
const flat = (s: string) => s.replace(/\s+/g, '');
/** 这句话是提示词的开头，也是「这儿抄了一句提示词」的路标。 */
const MARK = flat('读 AGENTS.md 和 workflows/');

/** 仓库里跟着走的 markdown（跳过依赖、构建产物）。 */
function docs(dir = '.', out: string[] = []): string[] {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'coverage']);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) docs(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('凡是抄了那两句提示词的文档，都得跟 PROMPT 对得上', () => {
  const bare = Object.values(PROMPT).map((p) => flat(p.replace(/。$/, '')));

  /**
   * **按「谁抄了」找，不维护一份文件名单。** 那两句现在被抄在三个地方
   * （`AGENTS.md` 开头、`CLAUDE.md` 讲自动拆解和定时回顾那两段、
   * `workflows/expand.md` 最后一条规则），而名单本身就是下一个会飘的东西——
   * 新写一份文档抄了它、忘了加进名单，守卫就静默漏掉。
   *
   * 路标是提示词的开头那半句。抄了它的地方，从路标往后必须**一字不差**地接上
   * 某一句完整的提示词。
   */
  it('每一处引用都完整、且跟正本一致', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of docs()) {
      const s = flat(readFileSync(f, 'utf8'));
      for (let i = s.indexOf(MARK); i !== -1; i = s.indexOf(MARK, i + 1)) {
        seen++;
        if (!bare.some((p) => s.startsWith(p, i))) bad.push(`${f} 第 ${seen} 处`);
      }
    }
    expect(seen, '一处引用都没扫到——路标改了就把这条守卫的路标一起改').toBeGreaterThanOrEqual(3);
    expect(
      bad,
      '这些地方抄的提示词跟 server/src/expand.ts 的 PROMPT 对不上了。'
        + 'AI 靠这两句认「我这次被叫来干什么」，抄错等于给它两个互相矛盾的说法。',
    ).toEqual([]);
  });

  it('两句都抠到了——不是拿空字符串在比', () => {
    expect(Object.keys(PROMPT).length).toBeGreaterThanOrEqual(2);
    for (const p of Object.values(PROMPT)) expect(p.length).toBeGreaterThan(10);
  });
});

describe('AGENTS.md 跟代码对账', () => {
  it('「patch 里只能出现这几个字段」那份名单，跟 PROPOSABLE 一字不差', () => {
    // 排序后比：文档里的顺序是给人读的（大致按「改什么」的常见程度），
    // 跟 `PROPOSABLE` 数组的顺序没有必须一致的理由，这里只管集合相同。
    expect([...fieldsInAgentsMd()].sort()).toEqual([...PROPOSABLE].sort());
  });

  /**
   * **契约里不许再出现「N 个字段」这种写死的数目。**
   *
   * 上面那条守着字段名单本身，但守不住别处顺口写下的一个数字。实际发生过：
   * 「你说、他决定」那节收尾写着「只能改那**十个**字段」，而 `PROPOSABLE` 已经
   * 是十二个——名单那句是对的，这句偷偷少报了两个。跟这个文件顶上记的那次是
   * 同一种飘法（**文档把实际允许的字段说成禁的**，AI 照着办就永远不提它，
   * 而 outbox 校验只拦「多写了不该写的」，拦不住「该写的没写」）。
   *
   * 判据是「一个数字都不许写」，不是「数字必须等于 12」：写对了的数字明天
   * 照样会因为加一个字段而变错，而这类句子从来没人回来改。正确的写法是指向
   * 名单那一节，让正本只有一处。
   */
  it('AGENTS.md 里不写死字段数目——数字会腐烂，要指向名单那一节', () => {
    const md = readAgentsMd();
    // 中文数字和阿拉伯数字都拦；「几个字段」「这几个字段」不算数目，放行。
    const hits = [...md.matchAll(/(?:[0-9]+|[一二三四五六七八九十]+)\s*个字段/g)].map((m) => m[0]);
    expect(hits, `AGENTS.md 里写死了字段数目：${hits.join(' / ')}——改成指向「提修改建议」那节的名单`).toEqual([]);
  });

  /**
   * **样例是 AI 对「一条任务长什么样」的全部认知。** `Task` 加了字段而这儿没跟上，
   * 后果不是报错，是**AI 永远不会写那个字段**——而校验只拦「多写了不该写的」，
   * 拦不住「该写的没写」。`context` 差一点就是这么隐形的。
   *
   * 样例里列的是 **`Task` 的全部字段**，不是「AI 写得进的那几个」：那是一份形状
   * 参考，哪几个写了也不算数（`order`/`priority`/…）由后面那几条说明交代。
   */
  it('任务对象那块 json 样例的顶层键，跟 `Task` 的字段一个不多一个不少', () => {
    // 从 model.ts 源码里扫，不手抄一份名单——手抄的名单自己就是下一个会飘的东西，
    // 跟 `types.sync.test.ts` 里 `NAMES` 那条同一条教训。
    const src = readFileSync('server/src/model.ts', 'utf8');
    const body = /export interface Task \{([\s\S]*?)\n\}/.exec(src);
    if (!body) throw new Error('model.ts 里没扫到 export interface Task');
    const fields = [...body[1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as keyof Task);
    expect([...sampleKeys()].sort()).toEqual([...fields].sort());
  });

  /**
   * **README 那句话上一版写的是「只能改这五样」，少报了七个字段。**
   * 跟 `AGENTS.md` 那次飘是同一个形状，只是这份是给人看的：他读完之后
   * 不会去指望 AI 提「把这条归到工作清单」或者「这条得到电脑前才能干」，
   * 而那两件它都提得了。
   */
  it('README 那句「AI 能建议改的就这几样」，PROPOSABLE 里每一个都在里面', () => {
    const said = readmeSentence();
    for (const f of PROPOSABLE) {
      expect(said, `README 那句话里没有「${README_LABEL[f]}」（字段 ${f}）`).toContain(README_LABEL[f]);
    }
  });

  it('README 那句话里也没有多出来的——列了一个实际提不了的字段，同样是在说假话', () => {
    // 顶层顶格分隔的项数（去掉加粗星号和换行）应该恰好等于 PROPOSABLE 的个数。
    const items = readmeSentence().replace(/[*\s]/g, '').split('、').filter(Boolean);
    expect(items.sort()).toEqual(PROPOSABLE.map((f) => README_LABEL[f]).sort());
  });

  /**
   * **这句话已经飘过一次。** 习惯从「只有每天」放宽到「每天或每周」时，
   * 校验器（`task.ts`）跟上了，AGENTS.md 这一句没跟——而它是 AI 对这条规矩的
   * 全部认知。后果分两头，两头都不报错：AI 照着写就**永远不会提每周的习惯**
   * （文档把一个合法的组合说成禁的），而它要是照着别处的例子写了每周，
   * 文档又会让它以为自己写错了。
   *
   * 「校验失败会怎样」那节里还抄了一遍同一件事，所以这条按**全文出现的每一处**
   * 数——只钉第一处的话，另一处照样能单独飘。
   */
  it('「habit 必须配哪些重复档」那句话，跟 HABIT_EVERY 一字不差', () => {
    const md = readAgentsMd();
    const from = md.indexOf(HABIT_HEAD);
    if (from === -1) throw new Error(`AGENTS.md 里找不到「${HABIT_HEAD}」这句话——改写了就把这条守卫的锚点一起改`);
    const rest = md.slice(from + HABIT_HEAD.length);
    const end = rest.indexOf('。');
    if (end === -1) throw new Error('那句话没有句号，取不到边界');
    const said = [...rest.slice(0, end).matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(said.sort(), 'AGENTS.md 里说的重复档跟 HABIT_EVERY 对不上').toEqual([...HABIT_EVERY].sort());
  });

  /**
   * 「校验失败会怎样」那节里**又说了一遍**同一件事。只钉上面那一句的话，
   * 这一处能单独飘——而它才是 AI 在收到拒收之后回头读的那一段。
   *
   * 两处句式不一样（一处「必须配」、一处「对不上」），所以各锚各的，
   * 不合成一个模糊的扫描：这个文件顶上那段写着为什么不扫全文。
   */
  it('「校验失败会怎样」那节里同一条规矩，也得说全「每天」「每周」', () => {
    const md = flat(readAgentsMd());
    const HEAD2 = flat('`habit: true` 但 `repeat` 对不上');
    const from = md.indexOf(HEAD2);
    if (from === -1) throw new Error(`AGENTS.md 里找不到「${HEAD2}」——改写了就把这条守卫的锚点一起改`);
    const said = md.slice(from + HEAD2.length, from + HEAD2.length + 20);
    for (const label of ['每天', '每周']) {
      expect(said, `那句话里没说「${label}」，AI 会以为那一档是错的`).toContain(label);
    }
  });

  /**
   * **「这些字段你写了也不算数」那份名单，跟 `stripForced` 对账。**
   *
   * 它已经飘得很远了：这句话上一版写着「这**九个**字段」，后面只列了八个，
   * 而 `stripForced` 当时实际摘掉的是十二个——`estimateMinutes`、`reviewedAt`、
   * `section`、`persistentReminder` 四个是后来陆续加的，一次都没跟上。
   *
   * 飘的后果跟 `PROPOSABLE` 那次一样，只是方向相反：**AI 会认真去填一个填了
   * 也不算数的字段**（「这件事大概要 30 分钟」），而它永远不会知道自己白写了
   * ——那几个字段是在校验**之前**被摘掉的，不报错、不退回，日志里也没有。
   * 反过来，这份名单每多一个 `stripForced` 里没有的字段，AI 就会跳过一个
   * 它本来该写的。
   */
  it('「写了也不算数」那份名单，跟 stripForced 摘掉的字段一致', () => {
    const src = readFileSync('server/src/outbox.ts', 'utf8');
    const body = /function stripForced[\s\S]*?\.\.\.rest\s*} = raw as/.exec(src);
    if (!body) throw new Error('outbox.ts 里没扫到 stripForced 的解构块——改写了就把这条守卫的锚点一起改');
    // `name: _name,` 那种形式。注释行里不会出现这个形状（那儿写的是反引号包着的字段名）。
    // 一行里可能写了不止一个（`order: _order, priority: _priority,`），所以不锚行首行尾。
    const stripped = [...body[0].matchAll(/(\w+): _\w+/g)].map((m) => m[1]);
    // `stuckNote` 是**已经删掉的字段**，接住只为了兼容老 AI 写来的键——
    // 它不在 `Task` 上，文档里也不该提它（提了等于告诉 AI 有这么个字段）。
    const want = stripped.filter((f) => f !== 'stuckNote');

    const md = readAgentsMd();
    const from = md.indexOf(FORCED_HEAD);
    if (from === -1) throw new Error(`AGENTS.md 里找不到「${FORCED_HEAD}」——改写了就把这条守卫的锚点一起改`);
    // 名单到「这些字段不在这条规则里」为止——后面那半句在讲落成什么值，
    // 会把同一批字段名再念一遍，扫进来不影响集合，但边界写清楚了才不用靠运气。
    const TAIL = ' 这些字段不在这条规则里';
    const to = md.indexOf(TAIL, from);
    if (to === -1) throw new Error(`AGENTS.md 那句话里找不到「${TAIL.trim()}」，取不到边界`);
    const listed = [...md.slice(from, to).matchAll(/`(\w+)`/g)].map((m) => m[1]);

    expect([...new Set(listed)].sort(), 'AGENTS.md 这份名单跟 stripForced 对不上').toEqual([...new Set(want)].sort());
  });

  it('锚点真的取到了东西——不是取了个空数组然后跟空数组比', () => {
    // 上面那条断言在「锚点挪走了、正则一个都没匹配上」时会红（PROPOSABLE 非空），
    // 但如果哪天 PROPOSABLE 也空了，两个空数组会相等。这条把下限单独钉死。
    expect(fieldsInAgentsMd().length).toBeGreaterThan(5);
    expect(sampleKeys().length).toBeGreaterThan(20);
  });
});

/**
 * **工作流文档不许教 AI 往 `updates` 里写白名单外的字段。**
 *
 * `AGENTS.md`「提修改建议」那节说得很清楚：`status`/`order`/`source`……不在
 * `PROPOSABLE` 里，出现一次**整个 outbox 文件校验不过**。而 `workflows/review.md`
 * 「卡住的项目」那条原来写着「提一条『把某一条捡回待办』（`updates` 改那条
 * 子任务的 `status`）」——两份文档打架，AI 照后者办一次，整轮回顾（一两分钟、
 * 一次额度）全丢，别的建议和观察一条都落不下来。上面那组守卫只盯 `AGENTS.md`，
 * `workflows/` 一直在外面。
 *
 * 判据是**启发式的**，只认出过事的那个形状：同一行里同时出现 `` `updates` ``
 * 和一个反引号包着的、`Task` 上有但 `PROPOSABLE` 里没有的字段名，而且那一行
 * 没有否定词（别 / 不要 / 不能 / 不许 / 不在）。「别用 `updates` 改 `status`」
 * 这种禁止句放行。误报的话，把那句改成先说「别」再说字段，比放宽这条便宜。
 */
describe('workflows/*.md 不教 AI 提白名单外的字段', () => {
  const FORBIDDEN = ['status', 'order', 'source', 'aiComment', 'completedAt', 'postponeCount', 'focusSessions', 'habit', 'attachments']
    .filter((f) => !(PROPOSABLE as readonly string[]).includes(f));
  const NEGATION = /别|不要|不能|不许|不在/;

  const offenders = readdirSync('workflows')
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => readFileSync(`workflows/${f}`, 'utf8').split(/\r?\n/).flatMap((line, i) => {
      if (!line.includes('`updates`') || NEGATION.test(line)) return [];
      const hit = FORBIDDEN.filter((k) => line.includes('`' + k + '`'));
      return hit.length ? [`workflows/${f}:${i + 1} 提到 ${hit.join('/')}`] : [];
    }));

  it('前提：FORBIDDEN 确实都在白名单之外——不然这条在守空气', () => {
    expect(FORBIDDEN).toContain('status');
  });

  it('没有哪一行在教 AI 用 updates 改那几个字段', () => {
    expect(offenders, '那个字段不在 PROPOSABLE 里，写进 updates 会让整个 outbox 文件被拒；改成写 insights，或者先说「别」').toEqual([]);
  });
});
