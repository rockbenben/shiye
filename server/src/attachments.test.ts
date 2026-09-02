import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES, safeName, saveAttachment, listAttachments,
  resolveAttachment, removeAttachment, removeAllAttachments, AttachmentValidationError,
} from './attachments.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-attachments-'));
  process.env.DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** 测试用的字节内容。 */
const b = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 直接读磁盘，绕开 resolveAttachment——校验落盘内容不依赖被测的第二道守卫。 */
const read = (taskId: string, name: string): string =>
  readFileSync(join(dir, 'attachments', taskId, name), 'utf8');

describe('MAX_ATTACHMENT_BYTES', () => {
  it('是 25MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('safeName：路径穿越', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['a/b/c.txt', 'c.txt'],
    ['a\\b\\c.txt', 'c.txt'],
    ['./x.txt', 'x.txt'],
  ])('%s → %s', (raw, want) => expect(safeName(raw)).toBe(want));

  it.each([['..'], ['.'], [''], ['   '], ['\0'], ['']])('%j → null', (raw) =>
    expect(safeName(raw)).toBeNull());
});

describe('safeName：Windows 保留名', () => {
  it.each([['CON'], ['con'], ['CON.txt'], ['NUL'], ['COM1'], ['lpt9.pdf']])(
    '%s 要被挡或改名', (raw) => {
      const got = safeName(raw);
      expect(got === null || !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(got)).toBe(true);
    });
});

describe('safeName：中文和常见文件名要能用', () => {
  it.each([['八月报告.pdf'], ['会议纪要 2026-08.md'], ['a-b_c.1.txt'], ['照片 (1).jpg']])(
    '%s 原样保留', (raw) => expect(safeName(raw)).toBe(raw));
});

describe('safeName：超长名字截断', () => {
  it('截到 120 字节以内，扩展名保留', () => {
    const raw = `${'a'.repeat(300)}.txt`;
    const got = safeName(raw);
    expect(got).not.toBeNull();
    expect(Buffer.byteLength(got as string, 'utf8')).toBeLessThanOrEqual(120);
    expect((got as string).endsWith('.txt')).toBe(true);
  });

  it('多字节字符按字节截断，不切碎成乱码', () => {
    const raw = `${'测'.repeat(100)}.pdf`;
    const got = safeName(raw);
    expect(got).not.toBeNull();
    expect(Buffer.byteLength(got as string, 'utf8')).toBeLessThanOrEqual(120);
    expect((got as string).endsWith('.pdf')).toBe(true);
    expect(got as string).not.toMatch(/�/);
  });

  // m4（final-review.md）：扩展名本身超过 120 字节时，旧实现的 stemBudget 归 0，
  // 直接把 ext 原样拼回去——120 字节的承诺完全失效。
  it('扩展名本身超过 120 字节：总长度还是被兜住，不再失控', () => {
    const raw = `a.${'b'.repeat(300)}`;
    const got = safeName(raw);
    expect(got).not.toBeNull();
    expect(Buffer.byteLength(got as string, 'utf8')).toBeLessThanOrEqual(120);
  });
});

// m5（final-review.md）：Windows 非法字符不净化的话不会报错，而是悄悄写进
// NTFS 交替数据流（`a:b.txt` 实际落盘成 `a`）——数组和磁盘从落盘那一刻就对
// 不上。这里只断言「不再包含非法字符/不再以点或空格收尾」，不断言具体替换
// 成什么字符——那是实现细节。
describe('safeName：Windows 非法字符不落进交替数据流', () => {
  it.each([['a:b.txt'], ['a.txt:$DATA'], ['a<b>.txt'], ['a"b|c?.txt'], ['a*.txt']])(
    '%s 不再含 <>:"|?*', (raw) => {
      const got = safeName(raw);
      expect(got).not.toBeNull();
      expect(got as string).not.toMatch(/[<>:"|?*]/);
    });

  it.each([['a.'], ['a  ']])('%j 不再以点或空格收尾', (raw) => {
    const got = safeName(raw);
    expect(got).not.toBeNull();
    expect((got as string).endsWith('.')).toBe(false);
    expect((got as string).endsWith(' ')).toBe(false);
  });
});

describe('saveAttachment', () => {
  it('落到 data/attachments/<taskId>/ 下', () => {
    const finalName = saveAttachment('t1', 'a.txt', b('内容'));
    expect(finalName).toBe('a.txt');
    const full = join(dir, 'attachments', 't1', 'a.txt');
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full, 'utf8')).toBe('内容');
  });

  it('重名加序号，不覆盖', () => {
    saveAttachment('t1', 'a.txt', b('一'));
    expect(saveAttachment('t1', 'a.txt', b('二'))).toBe('a (2).txt');
    // 上限：第一个文件的内容没被动过
    expect(read('t1', 'a.txt')).toBe('一');
    expect(read('t1', 'a (2).txt')).toBe('二');
  });

  it('taskId 不安全时抛/拒，不落盘', () => {
    expect(() => saveAttachment('../evil', 'a.txt', b('x'))).toThrow();
    expect(() => saveAttachment('a/b', 'a.txt', b('x'))).toThrow();
    expect(existsSync(join(dir, 'attachments'))).toBe(false);
  });

  // I4（final-review.md）：调用方（app.ts）靠 instanceof 把「请求本身不合法」
  // 跟「落盘时的 fs 异常」分开处理，前者 400 带原因，后者 500 不回原始 errno/
  // 服务器路径。这里钉住 saveAttachment 自己判定的两种拒收路径都抛的是这个
  // 类型，不是普通 Error——不然 app.ts 的 instanceof 判断形同虚设。
  it('taskId/文件名不安全时抛的是 AttachmentValidationError', () => {
    expect(() => saveAttachment('../evil', 'a.txt', b('x'))).toThrow(AttachmentValidationError);
    expect(() => saveAttachment('t1', '..', b('x'))).toThrow(AttachmentValidationError);
  });
});

describe('resolveAttachment：第二道兜底', () => {
  it('正常名字给出目录内的绝对路径', () => {
    saveAttachment('t1', 'a.txt', b('x'));
    const full = resolveAttachment('t1', 'a.txt');
    expect(full).not.toBeNull();
    expect(resolve(full as string)).toBe(resolve(join(dir, 'attachments', 't1', 'a.txt')));
  });

  it.each([['../../../etc/passwd'], ['..\\..\\x'], ['/etc/passwd']])(
    '%s → null（就算 safeName 被绕过也不能读到外面）', (raw) => {
      // 直接调 resolveAttachment，不经过 safeName——这道是独立的兜底
      expect(resolveAttachment('t1', raw)).toBeNull();
    });

  it('不存在的文件 → null', () => {
    expect(resolveAttachment('t1', 'nope.txt')).toBeNull();
  });

  it('目录外真实存在的文件也不能读到——不依赖这台机器上恰好有没有 /etc/passwd', () => {
    saveAttachment('t1', 'a.txt', b('x'));
    // 在 attachments/ 下、taskId 目录之外放一个诱饵文件：跟 /etc/passwd 那组
    // 不同，这个文件在任何平台上都真实存在，守卫被去掉的话这里一定会读到它。
    writeFileSync(join(dir, 'attachments', 'secret.txt'), '不该被读到', 'utf8');
    expect(resolveAttachment('t1', '../secret.txt')).toBeNull();
  });

  it('空字符串文件名 → null', () => {
    expect(resolveAttachment('t1', '')).toBeNull();
  });

  // m2（final-review.md）：resolve 那道守卫挡不住「路径恰好等于目录本身」这类
  // 请求（同步客户端常在附件目录下留一个 `.sync` 子目录）——唯一挡住它的是
  // `isFile()` 这道，之前零覆盖，实测去掉之后会读到目录本身、statSync/readFileSync
  // 直接抛 500。这里钉住「目录当文件名请求」必须是 null，不是抛异常。
  it('目录当文件名请求 → null，不是抛异常（isFile 兜底，m2）', () => {
    saveAttachment('t1', 'a.txt', b('x'));
    mkdirSync(join(dir, 'attachments', 't1', 'sub'), { recursive: true });
    expect(resolveAttachment('t1', 'sub')).toBeNull();
  });
});

describe('listAttachments：以磁盘为准', () => {
  it('目录不存在 → []，不抛', () => {
    expect(listAttachments('no-such-task')).toEqual([]);
  });

  it('列出真实存在的文件', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    saveAttachment('t1', 'b.txt', b('2'));
    expect(listAttachments('t1').slice().sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('不列子目录', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    mkdirSync(join(dir, 'attachments', 't1', 'sub'), { recursive: true });
    expect(listAttachments('t1')).toEqual(['a.txt']);
  });
});

describe('removeAttachment', () => {
  it('删除存在的文件，返回磁盘上真正的 basename', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    expect(removeAttachment('t1', 'a.txt')).toBe('a.txt');
    expect(existsSync(join(dir, 'attachments', 't1', 'a.txt'))).toBe(false);
  });

  it('不存在的文件返回 null，不抛', () => {
    expect(removeAttachment('t1', 'nope.txt')).toBeNull();
  });

  // m6（final-review.md）：返回值必须是磁盘上真正的 basename，不是回声请求里
  // 的 name——两者「同一性」的定义不一样（resolveAttachment 会把 `./a.txt`
  // 解析到同一个文件，但摘 Task.attachments 数组得靠真正的 `a.txt` 才能摘中）。
  it('别名请求（./ 前缀）返回的是真正的 basename，不是请求里那个别名', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    expect(removeAttachment('t1', './a.txt')).toBe('a.txt');
  });
});

describe('removeAllAttachments', () => {
  it('删掉这个任务的整个目录', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    removeAllAttachments('t1');
    expect(existsSync(join(dir, 'attachments', 't1'))).toBe(false);
  });

  it('不碰别的任务的目录', () => {
    saveAttachment('t1', 'a.txt', b('1'));
    saveAttachment('t2', 'b.txt', b('2'));
    removeAllAttachments('t1');
    expect(existsSync(join(dir, 'attachments', 't1'))).toBe(false);
    expect(listAttachments('t2')).toEqual(['b.txt']);
  });

  it('目录不存在时不抛', () => {
    expect(() => removeAllAttachments('no-such-task')).not.toThrow();
  });

  // I2（final-review.md）：`isSafeId('.')` 是 true（只挡 `..` 和 `/`\`），而
  // `join(dataDir(), 'attachments', '.')` 被 path.join 规范化成 attachments/
  // 目录本身——不加 resolve+containment 这道，`removeAllAttachments('.')` 会把
  // 整棵 attachments/ 目录端掉，不止一个任务的。这是这一批唯一的破坏性操作，
  // 之前守卫零测试。
  it.each([['.'], ['..'], ['']])(
    '%j 不删任何东西——尤其 "." 不能把整个 attachments/ 端掉', (taskId) => {
      saveAttachment('t1', 'a.txt', b('1'));
      saveAttachment('t2', 'b.txt', b('2'));
      removeAllAttachments(taskId);
      expect(listAttachments('t1')).toEqual(['a.txt']);
      expect(listAttachments('t2')).toEqual(['b.txt']);
    });
});
