import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiKeyFrom, buildMessages, chat, chatUrl, configProblem, extractJson, maskKey, runBoardViaApi, runViaApi, scopeLine, testAi, type AiConfig } from './aiApi.js';
import { outboxFiles, writeInbox, writeLists, writeProposals, writeTasks } from './store.js';
import type { Task } from './model.js';

/** 一条任务的最小形状。只有 listId 这一格在这个文件里有意义，别的填满是为了过类型。 */
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
    reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
    completedAt: null, postponeCount: 0, waitingFor: null, context: null,
    attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...over,
  };
}


let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiapi-'));
  process.env.DATA_DIR = join(dir, 'data');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const cfg: AiConfig = { baseUrl: 'https://x.test/v1/chat/completions', apiKey: 'k', model: 'm' };

/** 假 fetch：回一个「模型说了这段话」的 OpenAI 兼容响应。 */
const replying = (content: string): typeof fetch => vi.fn(async () => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;

describe('chatUrl：三种填法都得认', () => {
  it('已经是完整地址就原样用', () => {
    expect(chatUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('尾部斜杠不影响判断——不去掉的话会拼出 //chat/completions', () => {
    expect(chatUrl('https://api.openai.com/v1/chat/completions/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('填到 base（有路径）就补 /chat/completions', () => {
    expect(chatUrl('https://generativelanguage.googleapis.com/v1beta/openai'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  /**
   * 光一个域名是最常见的一种手滑。补 `/chat/completions` 的话会 404，而 404 的
   * 报错里看不出少的是 `/v1` 那一段——所以这条补的是 `/v1/chat/completions`。
   */
  it('光一个域名，补的是 /v1/chat/completions，不是 /chat/completions', () => {
    expect(chatUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('首尾空白不算路径', () => {
    expect(chatUrl('  https://api.deepseek.com  ')).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('extractJson：模型不会老老实实只回 JSON', () => {
  it('干净的数组直接过', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('三反引号围栏剥掉', () => {
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it('JSON 前后多说的两句话截掉', () => {
    expect(extractJson('好的，我拆好了：\n[{"a":1}]\n以上。')).toEqual([{ a: 1 }]);
  });

  it('包了一层单键对象也认——模型即使没被要求也爱包一层', () => {
    expect(extractJson('{"entries":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(extractJson('{"tasks":[]}')).toEqual([]);
  });

  /** 多个键说不清该拆哪个，宁可报错也别猜——猜错了会把一份好数据丢掉一半。 */
  it('两个键的对象不猜，直接报错', () => {
    expect(() => extractJson('{"entries":[1],"note":"..."}')).toThrow(/不是数组/);
  });

  it('压根没有 JSON 时报得明白', () => {
    expect(() => extractJson('我已经写好 outbox-20260830.json 了')).toThrow(/没有 JSON/);
  });
});

describe('maskKey / aiKeyFrom：密钥不原样回给浏览器', () => {
  it('留后四位，能认出存着的是哪一把', () => {
    expect(maskKey('sk-abcdefghijkl')).toBe('••••ijkl');
  });

  it('短到看不出后四位就全打码——8 位以下露 4 位等于露一半', () => {
    expect(maskKey('sk-12345')).toBe('••••');
    expect(maskKey('')).toBe('');
  });

  /**
   * 这一条是整件事的关键：界面读回来的是打码串，用户不碰它、只改了别的设置再
   * 保存，请求体里带回来的就是那串打码。不认它的话密钥会被 `••••abcd` 覆盖，
   * 而这次覆盖悄无声息，要等下一次拆解报 401 才现形。
   */
  const same = { incoming: 'https://x.test/v1', stored: 'https://x.test/v1' };
  const moved = { incoming: 'https://攻击者.test/v1', stored: 'https://x.test/v1' };

  it('收到的正是自己打码回去的那串 → 保持原样', () => {
    expect(aiKeyFrom('••••ijkl', 'sk-abcdefghijkl', same)).toBe('sk-abcdefghijkl');
  });

  /** 「改了地址、没动密钥」：最常见的试法，打码那一支照样认。 */
  it('打码串 + 换了地址 → 仍然沿用——这是界面的正常走法', () => {
    expect(aiKeyFrom('••••ijkl', 'sk-abcdefghijkl', moved)).toBe('sk-abcdefghijkl');
  });

  it('请求体里压根没这个字段、地址没变 → 保持原样', () => {
    expect(aiKeyFrom(undefined, 'sk-abcdefghijkl', same)).toBe('sk-abcdefghijkl');
  });

  /**
   * **没这个字段、地址却换了 → 不沿用。** 原来这一支无条件返回存着的密钥，
   * 那是一条把密钥送给任意地址的路（第三方网页发得出这种请求，理由见
   * `aiKeyFrom` 的注释）。真实客户端从不省略这个字段，收紧对界面零影响。
   */
  it('没这个字段、地址换了 → 空——密钥不跟着搬去陌生地址', () => {
    expect(aiKeyFrom(undefined, 'sk-abcdefghijkl', moved)).toBe('');
  });

  it('换了一把新的 → 照收', () => {
    expect(aiKeyFrom('sk-new', 'sk-old', same)).toBe('sk-new');
  });

  it('空串 = 真的清掉——不留这条路就没法删密钥', () => {
    expect(aiKeyFrom('', 'sk-abcdefghijkl', same)).toBe('');
  });

  /** 本来就没存 → 那串打码只是一段普通文字，照收（也就是存了个假的，他自己看得见）。 */
  it('本来没存密钥时，打码串不再有特殊含义', () => {
    expect(aiKeyFrom('••••ijkl', '', same)).toBe('••••ijkl');
  });
});

describe('buildMessages：规则读原文，数据当场读盘', () => {
  it('system 里是 AGENTS.md 和对应 workflow 的原文，不是这个文件里抄的精简版', () => {
    const [sys] = buildMessages('expand');
    const agents = readFileSync('AGENTS.md', 'utf8');
    // 抄一份的话两条路会慢慢飘——所以这里比的是「原文的一大段真的在里面」。
    expect(sys.content).toContain(agents.slice(0, 400));
    expect(sys.content).toContain(readFileSync('workflows/expand.md', 'utf8').slice(0, 200));
  });

  it('拆解带的是未处理的收件箱条目和清单，已处理的不进提示词', () => {
    writeInbox([
      { id: 'a', text: '要拆的', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
      { id: 'b', text: '拆过了', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['t1'] },
    ]);
    writeLists([{ id: 'l1', name: '工作', color: '', folderId: null, order: 0, archived: false, filter: null }]);

    const [, user] = buildMessages('expand');
    expect(user.content).toContain('要拆的');
    expect(user.content).not.toContain('拆过了');
    expect(user.content).toContain('工作');
  });

  /** CLI 那条路的 AI 从环境里知道今天几号，这条不注入就只能瞎猜 `due`。 */
  it('user 里写着现在几点', () => {
    const [, user] = buildMessages('expand');
    expect(user.content).toMatch(/^现在是 \d{4}-\d{2}-\d{2}T/);
  });

  it('回顾读的是另一份 workflow，带的是任务/建议/观察', () => {
    const [sys, user] = buildMessages('review');
    expect(sys.content).toContain(readFileSync('workflows/review.md', 'utf8').slice(0, 200));
    expect(user.content).toContain('data/tasks/');
    expect(user.content).toContain('data/proposals/');
    expect(user.content).toContain('data/insights/');
  });

  /**
   * 「只回顾这一份清单」。**筛和说是一件事的两半，缺哪半都是坏的**：只说不筛，
   * 那几百条不相干的任务照样进提示词、照样付 token（省钱那一半就没了）；只筛不
   * 说，模型拿到的是一份自称「data/tasks/」的残缺数据，会据它下「你手上统共
   * 就三件事」这种全局判断。所以两半各钉一条。
   */
  describe('回顾带范围', () => {
    const two = (): void => {
      writeLists([
        { id: 'l1', name: '035 办事师爷', color: '', folderId: null, order: 0, archived: false, filter: null },
        { id: 'l2', name: '别的项目', color: '', folderId: null, order: 1, archived: false, filter: null },
      ]);
      writeTasks([
        task({ id: 'a', title: '范围内的', listId: 'l1' }),
        task({ id: 'b', title: '别的清单的', listId: 'l2' }),
        task({ id: 'c', title: '没归属的', listId: null }),
      ]);
    };

    it('筛：别的清单和没归属的都不进提示词', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      expect(user.content).toContain('范围内的');
      expect(user.content).not.toContain('别的清单的');
      expect(user.content).not.toContain('没归属的');
    });

    it('说：范围那句话在里面，还写明筛掉了多少', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      expect(user.content).toContain(scopeLine({ listId: 'l1', listName: '035 办事师爷' }));
      expect(user.content).toContain('全部 3 条里的 1 条');
    });

    // 不带范围就是老行为。这条钉的是「新参数没有偷偷改掉默认」——它是可选的，
    // 而所有老调用点（回顾那一屏那颗按钮、定时任务）都不会传。
    it('不带范围时三条都在，也不提范围', () => {
      two();
      const [, user] = buildMessages('review');
      expect(user.content).toContain('范围内的');
      expect(user.content).toContain('别的清单的');
      expect(user.content).toContain('没归属的');
      expect(user.content).not.toContain('这次只回顾清单');
    });

    // 判据只认 listId：清单名会改、也可能撞，它在提示词里只是让话读得懂。
    it('筛的判据是 listId 不是名字', () => {
      writeLists([{ id: 'l1', name: '重名', color: '', folderId: null, order: 0, archived: false, filter: null }]);
      writeTasks([task({ id: 'a', title: '要的', listId: 'l1' }), task({ id: 'b', title: '不要的', listId: 'l9' })]);
      const [, user] = buildMessages('review', { listId: 'l1', listName: '重名' });
      expect(user.content).toContain('要的');
      expect(user.content).not.toContain('不要的');
    });

    /**
     * **别的清单的任务连 id 都不该出现在提示词里。** 上面几条断言的是标题，而
     * `scopeLine` 那段注释里有一句更强的话——「模型压根看不见别的清单，连它们的
     * id 都不知道，想提也提不出来」，那句话是这条路**唯一的硬约束**（CLI 那条只有
     * 提示词里的一句请求）。id 漏出去就不成立了：`updates` 只要给对 id 就能提到
     * 范围外的任务身上，而 `mergeOutbox` 不认识范围、拦不住。
     *
     * 标题可以只是没被引用，id 泄漏却是实打实的能力——所以单独钉一条。
     */
    it('范围外任务的 id 一个都不出现在提示词里', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      // 范围内那条的 id 在（不然下面两条是废话）。
      expect(user.content).toContain('"a"');
      expect(user.content).not.toContain('"b"');
      expect(user.content).not.toContain('"c"');
    });
  });

  /**
   * 上面两份规则原文里明确写着「你自己写 data/outbox-<unique>.json」。不改口的话
   * 模型会回一句「我已经写好了」然后什么都没有——而那种失败在界面上跟
   * 「AI 判断没什么好拆的」长得一模一样。
   */
  it('最后改口说清楚文件由服务写，只要回 JSON', () => {
    const [sys] = buildMessages('expand');
    expect(sys.content).toContain('没有文件系统');
    expect(sys.content).toContain('把那个 JSON 数组作为回复正文直接发回来');
  });

  /**
   * 总览是第三种 buildMessages：读的是 board.md，数据只要 tasks + 未处理收件箱
   * （建议/观察跟「现在什么情况」无关），handoff 要把「别写文件」说死——
   * board.md 正文默认让命令行路写 `data/.board-report.md`，接口路模型也读得到
   * 那一段，不压住它就可能照着写，而这边没人读那个文件。
   */
  describe('总览（board）', () => {
    it('system 里是 board.md 原文，不是 expand/review', () => {
      const [sys] = buildMessages('board');
      expect(sys.content).toContain(readFileSync('workflows/board.md', 'utf8').slice(0, 200));
      expect(sys.content).not.toContain(readFileSync('workflows/expand.md', 'utf8').slice(0, 80));
      expect(sys.content).not.toContain(readFileSync('workflows/review.md', 'utf8').slice(0, 80));
    });

    it('带任务和未处理收件箱，但不带建议/观察——总览不需要那两份', () => {
      writeTasks([task({ id: 'a', title: '看板上的任务' })]);
      writeInbox([
        { id: 'i1', text: '还没拆的', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
        { id: 'i2', text: '拆过的', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['a'] },
      ]);
      const [, user] = buildMessages('board');
      expect(user.content).toContain('看板上的任务');
      expect(user.content).toContain('还没拆的');
      expect(user.content).not.toContain('拆过的');
      expect(user.content).not.toContain('data/proposals/');
      expect(user.content).not.toContain('data/insights/');
    });

    it('handoff 明确压住 board.md 的写文件约定：直接回文本，尤其别写 .board-report.md', () => {
      const [sys] = buildMessages('board');
      expect(sys.content).toContain('没有文件系统');
      expect(sys.content).toContain('.board-report.md');
      expect(sys.content).toContain('直接作为消息内容返回');
    });
  });
});

describe('chat：请求怎么发、报错怎么说', () => {
  it('带密钥时发 Bearer 头，模型名原样进 body', async () => {
    const f = replying('[]');
    await chat(cfg, buildMessages('expand'), f, new AbortController().signal);

    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string).model).toBe('m');
  });

  /** 本机跑的 Ollama / LM Studio 不要钥匙，硬塞一个空 Bearer 头有的会 401。 */
  it('没密钥时不带 Authorization 头', async () => {
    const f = replying('[]');
    await chat({ ...cfg, apiKey: '' }, buildMessages('expand'), f, new AbortController().signal);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  /**
   * 只报状态码的话，用户在界面上看到「AI 失败：401」，既不知道是钥匙错还是没
   * 充值，也不知道该改设置里哪一格。响应正文里那句话才是唯一有用的信息。
   */
  it('4xx 时把响应正文一起报出来，不只报状态码', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal))
      .rejects.toThrow(/401.*Incorrect API key/);
  });

  it('200 但内容是空的也算失败——不能当成「没什么可拆的」', async () => {
    const f = replying('   ');
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal)).rejects.toThrow(/空的/);
  });

  it('回的不是 JSON（中转返了一页 HTML）时说清楚', async () => {
    const f = vi.fn(async () => new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal)).rejects.toThrow(/不是 JSON/);
  });
});

describe('runViaApi：结果落成 outbox 文件', () => {
  it('写出来的文件名和形状跟 AI 自己写的一样——后面的合并分辨不出来源', async () => {
    const entry = { inboxId: 'a', tasks: [{ title: '买猫粮' }] };
    const wrote = await runViaApi('expand', cfg, replying(JSON.stringify([entry])), new AbortController().signal);

    expect(wrote).toBe(true);
    const files = outboxFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/outbox-.+\.json$/);
    expect(JSON.parse(readFileSync(files[0], 'utf8'))).toEqual([entry]);
  });

  /** 空数组 = 模型明确说「没什么可产出」，等价于 CLI 那条路「跑完了什么都没写」。 */
  it('模型回空数组：不写文件，回 false', async () => {
    expect(await runViaApi('expand', cfg, replying('[]'), new AbortController().signal)).toBe(false);
    expect(outboxFiles()).toEqual([]);
  });

  it('原子写：不留 .tmp 在 data/ 里', async () => {
    await runViaApi('expand', cfg, replying('[{"inboxId":"a","tasks":[]}]'), new AbortController().signal);
    expect(outboxFiles().some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('runBoardViaApi：汇报走回调，不落任何文件', () => {
  it('模型回的文本 trim 后交给回调；不产生 outbox 文件', async () => {
    const seen: string[] = [];
    const ret = await runBoardViaApi(cfg, replying('  待办 3 张\n过期 2 条  '), new AbortController().signal, (m) => seen.push(m));
    expect(ret).toBe(true);
    expect(seen).toEqual(['待办 3 张\n过期 2 条']);
    expect(outboxFiles()).toEqual([]);
  });

  it('模型回空白：按 chat 的统一契约抛错（由 runner 发 failed），不发空汇报', async () => {
    const seen: string[] = [];
    await expect(
      runBoardViaApi(cfg, replying('   \n  '), new AbortController().signal, (m) => seen.push(m)),
    ).rejects.toThrow(/空的/);
    expect(seen).toEqual([]);
  });
});

describe('configProblem：能不能跑，说人话', () => {
  const ok: AiConfig = { baseUrl: 'https://x.test/v1', apiKey: 'sk-abc', model: 'm' };

  it('三格都对就没问题', () => {
    expect(configProblem(ok)).toBeNull();
  });

  it('本机那类不要密钥，空串照样能跑', () => {
    expect(configProblem({ ...ok, apiKey: '' })).toBeNull();
  });

  it('缺哪格说哪格，不说「配置不完整」', () => {
    expect(configProblem({ ...ok, baseUrl: '  ' })).toMatch(/接口地址还没填/);
    expect(configProblem({ ...ok, model: '' })).toMatch(/模型名还没填/);
  });

  /**
   * 这一条是端到端跑出来的，不是想出来的：密钥要拼进 `Authorization` 头，而 HTTP
   * 头是 ByteString——一个中文字符就让 `fetch` 抛
   * `Cannot convert argument to a ByteString because the character at index 10 has
   * a value of 27979`。用户看到这句只能干瞪眼：它没说是哪一格，更没说「你粘贴密钥
   * 的时候带进了中文字符」。
   *
   * 五个样本各代表一种真实的粘贴事故：中文、中间夹空格、末尾换行、全角字母、
   * 全角空格（最阴的一个——它在输入框里看着就是个空格）。
   */
  it('密钥里混进中文/空格/换行/全角字符时，在发请求之前就拦下并说清楚', () => {
    const bads = ['sk-测试用的', 'sk-abc def', 'sk-abc' + String.fromCharCode(10), 'sk-ａbc', 'sk-abc' + String.fromCharCode(0x3000)];
    for (const bad of bads) {
      expect(configProblem({ ...ok, apiKey: bad }), `${JSON.stringify(bad)} 该被拦下`)
        .toMatch(/粘贴的时候多半会带进来/);
    }
  });

  it('正常密钥里的符号一个都不误伤', () => {
    for (const good of ['sk-proj_ABC123', 'sk-a.b~c', 'AIzaSy-_09azAZ', 'hf_xxx==']) {
      expect(configProblem({ ...ok, apiKey: good }), `${good} 不该被拦`).toBeNull();
    }
  });
});

describe('testAi：一次最便宜的调用，验那三格填对没有', () => {
  const ok: AiConfig = { baseUrl: 'https://x.test/v1', apiKey: 'sk-abc', model: 'm' };
  const sig = () => new AbortController().signal;

  it('通了回 null', async () => {
    expect(await testAi(ok, replying('好'), sig())).toBeNull();
  });

  /**
   * **提示词只有一句话，不走 `buildMessages`**：那份要贴进 AGENTS.md 全文加整个
   * 收件箱（实测 18KB 的 system），拿它「试一下通不通」是荒唐的。这条断言就是
   * 钉住这件事——哪天有人图省事把 `buildMessages` 接过来，这里会红。
   */
  it('发出去的提示词很小，不是那份贴了 AGENTS.md 全文的', async () => {
    const f = replying('好');
    await testAi(ok, f, sig());
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(sent.messages).toHaveLength(1);
    expect((init.body as string).length).toBeLessThan(500);
  });

  it('三格没填全时压根不发请求，直接回那句人话', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await testAi({ ...ok, model: '' }, f, sig())).toMatch(/模型名还没填/);
    expect(await testAi({ ...ok, apiKey: 'sk-测试' }, f, sig())).toMatch(/粘贴的时候多半会带进来/);
    expect(f).not.toHaveBeenCalled();
  });

  /** 接口回的那段话原样往上抛——「401」三个字没告诉他是钥匙错还是没充值。 */
  it('接口报错时回的是接口自己那句话，不是一个状态码', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    expect(await testAi(ok, f, sig())).toMatch(/401.*Incorrect API key/);
  });

  it('回的内容是空的也算没通', async () => {
    expect(await testAi(ok, replying('  '), sig())).toMatch(/空的/);
  });
});

describe('chat：连不上的时候说人话，不是 undici 那句 fetch failed', () => {
  const sig = () => new AbortController().signal;

  /**
   * 端到端跑出来的：地址填错时这条路原来回的是 `fetch failed`——那是运行时的内部
   * 措辞，对着一个填错的地址等于什么都没说。跟密钥里混进中文那条同一类。
   */
  it('网络层失败：带上地址和该去检查什么', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await testAi({ baseUrl: 'http://127.0.0.1:31999/v1', apiKey: '', model: 'm' }, f, sig());
    expect(err).toMatch(/连不上/);
    expect(err, '地址要原样报出来——他得能一眼看出是不是少了 /v1').toContain('http://127.0.0.1:31999/v1/chat/completions');
    expect(err).toMatch(/本机跑的模型确认它已经启动/);
  });

  it('超时单独说——那跟「地址写错了」是两回事', async () => {
    const f = vi.fn(async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;
    expect(await testAi({ baseUrl: 'https://x.test/v1', apiKey: '', model: 'm' }, f, sig())).toMatch(/超时了/);
  });
});

/**
 * 「让 AI 拆细这一条」。**这一支的全部意义就是「只发这一条」**——拆细问的是
 * 「这件事的第一步是什么」，答案只取决于这一条任务的标题、备注和现有的子任务。
 * 所以这一族钉的是一对反向的断言：**要的在，不要的不在**。
 *
 * 三样东西必须进提示词：这一条任务本身、它的直接子任务（「下一步」可能已经
 * 以子任务的形式躺在下面了）、它上面挂着的待决建议（AGENTS.md 说「已经挂着
 * 待决建议的任务直接跳过」）。一样不能少、一样不能多。
 */
describe('拆细带范围', () => {
  const t = (over: Partial<Task>): Task => task(over);

  const setup = (): void => {
    writeLists([{ id: 'l1', name: '工作', color: '', folderId: null, order: 0, archived: false, filter: null }]);
    writeTasks([
      t({ id: 'me', title: '装修', notes: '想把客厅和厨房一起弄' }),
      // 直接子任务——要带上，不然模型会提一条已经躺在下面的步骤。
      t({ id: 'kid', title: '量尺寸', parentId: 'me' }),
      // 孙子——**不带**。拆细看的是「下一步」，不是整棵子树。
      t({ id: 'grandkid', title: '买卷尺', parentId: 'kid' }),
      // 不相干的另一条任务——绝不能进。
      t({ id: 'other', title: '写周报' }),
    ]);
  };

  it('带的是拆细那份 workflow，不是回顾那份', () => {
    setup();
    const [sys] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(sys.content).toContain(readFileSync('workflows/breakdown.md', 'utf8').slice(0, 200));
    expect(sys.content).not.toContain(readFileSync('workflows/review.md', 'utf8').slice(0, 200));
  });

  it('这一条和它的直接子任务都在', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).toContain('装修');
    expect(user.content).toContain('量尺寸');
  });

  /**
   * **别的不相干的任务一条都不进。** 跟回顾那条同一个理由：`updates` 只要给对
   * id 就能提到任何一条任务身上，而 `mergeOutbox` 不认识范围、拦不住——所以
   * id 泄漏出去就不只是「模型多看了几眼」，是实打实的能力。
   */
  it('范围外的任务连 id 都不出现', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).toContain('"me"');
    expect(user.content).not.toContain('"other"');
    expect(user.content).not.toContain('写周报');
  });

  /** 孙子不带：拆细要的是「下一步」，把整棵子树塞进来是拿一份用不上的东西
   *  换 token，而且会让模型去拆一个不属于这一条的任务。 */
  it('孙子不进——只看这一条和它的直接子任务', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).not.toContain('买卷尺');
    expect(user.content).not.toContain('"grandkid"');
  });

  /** 范围那句话要说出来（CLI 那条路只有它，API 这条路它和硬筛各是一半）。 */
  it('范围那句话在里面', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).toContain(scopeLine({ taskId: 'me', taskTitle: '装修' }));
  });

  /**
   * **`insights` 不发。** 拆细不产观察（见 `workflows/breakdown.md`），模型
   * 不需要为了「别重复说过的话」去读一份它这一轮既不会写、也用不上的东西——
   * 而全量 insights 攒起来是这几段里最贵的一份。
   */
  it('不发 insights——拆细不产观察，读了也用不上', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).not.toContain('data/insights/');
  });

  /** 清单要发：AGENTS.md 说 `listId` 是 AI 写得了的字段之一，对不上就写 null。 */
  it('清单照发——写不写是一回事，得让它看得见有哪些', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).toContain('data/lists/');
  });

  /**
   * **这条任务上挂着的待决建议要发**（AGENTS.md 那条规矩：「已经挂着待决建议
   * 的任务直接跳过」）——拆细这一条尤其要紧：同一张卡上摆两条「加子任务」的建议，
   * 他得先分辨哪条是哪条。
   */
  it('这条任务上待决的建议发，别条任务上的不发', () => {
    setup();
    writeProposals([
      { id: 'p1', taskId: 'me', patch: { subtasks: [{ text: '旧的建议', done: false }] }, reason: '上一轮提的', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'p2', taskId: 'other', patch: { due: null }, reason: '别条任务上的', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).toContain('上一轮提的');
    expect(user.content).not.toContain('别条任务上的');
  });

  /** 他**忽略过**的建议不发——那是在否掉那个意见，读进来只会让模型以为它还挂着。 */
  it('他忽略过的建议不发', () => {
    setup();
    writeProposals([
      { id: 'p1', taskId: 'me', patch: { subtasks: [{ text: '他不要的那条', done: false }] }, reason: '被忽略的', createdAt: '2026-08-01T00:00:00.000Z', dismissed: true },
    ]);
    const [, user] = buildMessages('breakdown', { taskId: 'me', taskTitle: '装修' });
    expect(user.content).not.toContain('被忽略的');
  });

  /** 找不到那一条时**不会**把全部任务发出去——`mine` 落成空数组，不是退回全量。
   *  （路由那一层会先拦掉不存在的 id，这里是第二道。） */
  it('id 对不上时不会退回全量', () => {
    setup();
    const [, user] = buildMessages('breakdown', { taskId: '不存在', taskTitle: '？' });
    expect(user.content).not.toContain('写周报');
    expect(user.content).not.toContain('"me"');
  });

  /**
   * **压根没带范围时，一样不发全量。** 唯一的合法调用方是 `POST /api/breakdown`，
   * 它保证 `taskId` 一定在；这一条钉的是「有人绕开路由直接调 `buildMessages`」
   * 那种情况下也不会把几百条任务递出去——`updates` 里带着 id，模型挑错了建议
   * 就真提在别的任务上，而这一趟还白花一次全额上下文。
   *
   * 跟上面那条是**两个不同的入口**（`{taskId:'不存在'}` vs 完全不给 scope），
   * 上面那条绿着不代表这条绿。
   */
  it('完全不给 scope 时也不退回全量', () => {
    setup();
    const [, user] = buildMessages('breakdown');
    expect(user.content).not.toContain('写周报');
    expect(user.content).not.toContain('"me"');
    expect(user.content).not.toContain('量尺寸');
  });
});

/**
 * `scopeLine` 那两半。**它是范围那句话的唯一正本**，两条路（CLI / API）共用，
 * 而判据是 `'taskId' in scope`——两个形状的必填键互不相交。
 *
 * 这条测试钉的是那个判据本身：给 `ReviewScope` 加一个 `taskId` 字段，判据会
 * 静默反过来，清单范围被说成单条任务的范围，而**没有任何东西会报错**——
 * 模型只是收到一句错的范围说明。两半各钉一条，加字段那天至少这一条会红。
 */
describe('scopeLine：清单范围和单条任务范围各说各的', () => {
  it('清单范围：说的是清单，不是任务', () => {
    const s = scopeLine({ listId: 'l1', listName: '035 办事师爷' });
    expect(s).toContain('清单「035 办事师爷」');
    expect(s).toContain('listId 为 l1');
    expect(s).not.toContain('任务「');
  });

  it('单条任务范围：说的是任务，不是清单', () => {
    const s = scopeLine({ taskId: 't1', taskTitle: '装修' });
    expect(s).toContain('任务「装修」');
    expect(s).toContain('id 为 t1');
    expect(s).not.toContain('清单「');
  });

  /** 两句话都带着「别的……一概不看」那半句——那是这段的全部用处。 */
  it('两句话都说清了「别的都不看」', () => {
    for (const s of [scopeLine({ listId: 'l1', listName: 'x' }), scopeLine({ taskId: 't1', taskTitle: 'y' })]) {
      expect(s).toContain('别的');
      expect(s).toContain('一概不看');
    }
  });
});
