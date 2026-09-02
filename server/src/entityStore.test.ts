import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readAll, readOne, writeOne, deleteOne, syncAll, invalidate, invalidateAll, isSafeId, CONFLICT_RE, listConflicts, writeConflictCopy, listBroken } from './entityStore.js';

// 只包一层 renameSync/readdirSync，其余原样透传——「写入是原子的」那条测试原来
// 只查「跑完之后目录里没留 .tmp」，抓不住「有人把 tmp+rename 换成直接
// writeFileSync」这种改法：那种改法跑完同样不留 .tmp，同样全绿。
// 这里换成盯 renameSync 有没有真的被调用、调用时源路径是不是 .tmp 结尾；
// readdirSync 包一层是给 listConflicts 的缓存测试数「真的读了几次盘」。
//
// 这个文件里「缓存返回的数组改不动缓存」这类断言，命中（cache hit）和未命中
// （读盘、顺手存入缓存）是两条独立的返回路径，各自都要单独 slice，也各自要有
// 一条测试真的走到那条路径——只写一条「push 之后再读一次」测不出来只有其中
// 一条路径漏了 slice：`readAll`/`listConflicts` 都出现过「测试碰巧只走了未命中
// 分支，命中分支那处漏掉的 slice 完全没人管」的情况。新加缓存相关断言时，
// 注释里点明它走的是命中还是未命中分支。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), readdirSync: vi.fn(actual.readdirSync) };
});
const renameMock = vi.mocked(renameSync);
const readdirMock = vi.mocked(readdirSync);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'es-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('entityStore', () => {
  it('写一个读回来，内容一致', () => {
    writeOne(dir, { id: 'a', title: '写周报' } as never);
    expect(readOne<{ id: string; title: string }>(dir, 'a')).toEqual({ id: 'a', title: '写周报' });
  });

  it('目录不存在时 readAll 返回空数组，不抛', () => {
    expect(readAll(join(dir, '还没建'))).toEqual([]);
  });

  it('写不同实体互不影响', () => {
    writeOne(dir, { id: 'a', n: 1 } as never);
    writeOne(dir, { id: 'b', n: 2 } as never);
    expect(readAll<{ id: string; n: number }>(dir).map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('坏文件被跳过，不让整表读不出来', () => {
    writeOne(dir, { id: 'good', n: 1 } as never);
    writeFileSync(join(dir, 'bad.json'), '{ 这不是 JSON', 'utf8');
    invalidate(dir);
    expect(readAll<{ id: string }>(dir).map((e) => e.id)).toEqual(['good']);
  });

  /**
   * 坏文件要**记下来**，不只是 console.warn 一句。这个函数原来的注释写着
   * 「界面上由上层负责把坏文件列出来」，而上层一直没做——于是一条同步坏掉的
   * 任务就这么从界面上无声消失，谁都不知道少了东西。
   */
  it('跳过的那个文件报得出来，带着目录和文件名', () => {
    writeOne(dir, { id: 'good', n: 1 } as never);
    writeFileSync(join(dir, 'bad.json'), '{ 这不是 JSON', 'utf8');
    invalidate(dir);
    readAll<{ id: string }>(dir);

    expect(listBroken()).toContainEqual({ dir, file: 'bad.json' });
  });

  // 一律带上 `dir` 比对：每个用例都是一个新建的临时目录，只比文件名会撞上
  // 别的用例留在这张表里的记录（它记的是「上一次扫某个目录看到的样子」，
  // 目录之间互不影响）。
  it('**修好之后就不再报**——横幅说的是「现在还坏着」，不是「曾经坏过」', () => {
    writeFileSync(join(dir, 'bad.json'), '{ 这不是 JSON', 'utf8');
    invalidate(dir);
    readAll(dir);
    expect(listBroken().some((b) => b.dir === dir && b.file === 'bad.json')).toBe(true);

    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }), 'utf8');
    invalidate(dir);
    readAll(dir);
    expect(listBroken().some((b) => b.dir === dir && b.file === 'bad.json')).toBe(false);
  });

  it('删掉之后也不再报', () => {
    writeFileSync(join(dir, 'bad.json'), '坏的', 'utf8');
    invalidate(dir);
    readAll(dir);
    rmSync(join(dir, 'bad.json'));
    invalidate(dir);
    readAll(dir);
    expect(listBroken().some((b) => b.dir === dir && b.file === 'bad.json')).toBe(false);
  });

  it('**整个目录没了也要清掉**——早退那条路上不清的话，横幅会永远挂着一个连目录都不存在的文件', () => {
    writeFileSync(join(dir, 'bad.json'), '坏的', 'utf8');
    invalidate(dir);
    readAll(dir);
    expect(listBroken().some((b) => b.dir === dir)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
    invalidate(dir);
    readAll(dir);
    expect(listBroken().some((b) => b.dir === dir)).toBe(false);
    mkdirSync(dir, { recursive: true });   // afterEach 还要删它
  });

  it('都是好文件时空的——一条干净的数据目录不该常驻一条横幅', () => {
    writeOne(dir, { id: 'a' } as never);
    invalidate(dir);
    readAll(dir);
    expect(listBroken().filter((b) => b.dir === dir)).toEqual([]);
  });

  it('syncAll 会删掉不在新列表里的实体', () => {
    writeOne(dir, { id: 'a' } as never);
    writeOne(dir, { id: 'b' } as never);
    syncAll(dir, [{ id: 'a' }]);
    expect(readAll<{ id: string }>(dir).map((e) => e.id)).toEqual(['a']);
  });

  it('syncAll 不重写内容没变的实体', () => {
    writeOne(dir, { id: 'a', n: 1 } as never);
    const file = join(dir, 'a.json');
    // 把 mtime 钉死在 0 再比对。直接比「syncAll 前后的 mtime」在 Windows 上不可靠：
    // 文件时间戳精度粗，两次写可能拿到同一个值，那条断言会假绿。
    utimesSync(file, new Date(0), new Date(0));
    syncAll(dir, [{ id: 'a', n: 1 } as never]);
    expect(statSync(file).mtimeMs).toBe(0);
  });

  it('syncAll 对键顺序不敏感：键换了顺序但内容一样，不重写', () => {
    writeOne(dir, { id: 'a', n: 1, m: 2 } as never);
    const file = join(dir, 'a.json');
    utimesSync(file, new Date(0), new Date(0));
    // 同样的键值对，顺序颠倒——JSON.stringify 直接比会判成「变了」，
    // stableKey 按键名排序之后比才应该判成「没变」。
    syncAll(dir, [{ m: 2, n: 1, id: 'a' } as never]);
    expect(statSync(file).mtimeMs).toBe(0);
  });

  it('isSafeId：非空、不含路径分隔符、不含 .. 才算安全', () => {
    expect(isSafeId('a1b2c3')).toBe(true);
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('../../evil')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
    expect(isSafeId('a\\b')).toBe(false);
    expect(isSafeId(123)).toBe(false);
  });

  /**
   * **Windows 会悄悄改写文件名的那几类。** 跟上面 CONFLICT_RE 那条是同一种失败：
   * 写得进去、`readOne` 读得回来、`readAll` 永远看不见，而且全程零报错。
   *
   * 都是在这个仓库的 Windows 机器上实测出来的，不是照抄一张字符表：
   * - `abc:evil.json` 写入成功，`readdirSync` 却只列出一个叫 `abc` 的零字节文件
   *   ——内容进了 NTFS 交替数据流。`attachments.ts` 早就为附件名挡过这一条，
   *   实体 id 这条路一直没享受到。
   * - `NUL.json`/`CON.json`/`COM1.json`/`aux.json` 全部写入成功。
   *
   * 这些 id 的来源是外部输入：outbox 里 AI 供的 id、`POST /api/push` 从另一台
   * 设备推上来的 id。域内自己生成的是 uuid，一条都撞不上。
   */
  it('isSafeId：Windows 上会被改写的文件名一律不安全', () => {
    expect(isSafeId('abc:evil'), '冒号 → NTFS 交替数据流，readAll 永远看不见').toBe(false);
    for (const bad of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(isSafeId(bad), `Windows 文件名不允许 ${bad}`).toBe(false);
    }
    for (const dev of ['NUL', 'nul', 'CON', 'PRN', 'AUX', 'COM1', 'lpt9']) {
      expect(isSafeId(dev), `${dev} 是 Windows 保留设备名`).toBe(false);
    }
    expect(isSafeId('trailing.'), '尾随的点会被 Windows 自动丢掉').toBe(false);
    expect(isSafeId('trailing '), '尾随的空格会被 Windows 自动丢掉').toBe(false);
    expect(isSafeId(`a${String.fromCharCode(0)}b`), 'NUL 会让文件名在不同层被截断成两个不同的东西').toBe(false);
    expect(isSafeId(`a${String.fromCharCode(9)}b`), '制表符同理').toBe(false);
    // 别误伤：uuid 和普通 id 照旧安全。
    expect(isSafeId('7f3a1c2e-9b4d-4a1f-8c22-0e5d6b7a1234')).toBe(true);
    expect(isSafeId('COM10'), '只有 COM1..COM9 是保留名，COM10 不是').toBe(true);
    expect(isSafeId('console'), '前缀撞上保留名但不是它本身，别误伤').toBe(true);
  });
  it('isSafeId：id 撞上 CONFLICT_RE 的也不安全——那种 id 写得进去、readAll 永远读不到', () => {
    // 三条形状各一条：括号中文、括号英文、Syncthing。
    expect(isSafeId('a (冲突副本 x)')).toBe(false);
    expect(isSafeId('a (conflicted copy 2026)')).toBe(false);
    expect(isSafeId('a.sync-conflict-20260813-142530-K3HJ2QL')).toBe(false);
    // 正常 uuid 撞不上，域内 id 一个都不该被这道关误伤。
    expect(isSafeId('0f7c2c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f')).toBe(true);
    // 只是带括号、不带那两个关键词的照样安全——这道关认的是那条正则，不是括号。
    expect(isSafeId('a (2)')).toBe(true);
  });

  it('writeOne 拒绝长得像冲突副本的 id：不然「写成功了但列表里没有」，而且零报错', () => {
    expect(() => writeOne(dir, { id: 'a (冲突副本 x)' } as never)).toThrow(/不安全的 id/);
    invalidate(dir);
    expect(readAll(dir)).toEqual([]);
    expect(listConflicts(dir)).toEqual([]);
  });

  it('writeOne 拒绝路径穿越的 id，不会把文件写到 dir 之外——I-1：AI 给的 id 原样透传拼文件名，没有这道关的话 "../../逃出去的任务" 能把文件写出 data/ 目录', () => {
    const escaped = resolve(dir, '..', '逃出去的任务.json');
    expect(() => writeOne(dir, { id: '../逃出去的任务' } as never)).toThrow(/不安全的 id/);
    expect(existsSync(escaped)).toBe(false);
  });

  it('writeOne 拒绝空 id / 带斜杠的 id', () => {
    expect(() => writeOne(dir, { id: '' } as never)).toThrow();
    expect(() => writeOne(dir, { id: 'a/b' } as never)).toThrow();
  });

  it('readOne/deleteOne 对不安全的 id 同样拒绝，不是只有 writeOne 才挡', () => {
    expect(() => readOne(dir, '../../evil')).toThrow(/不安全的 id/);
    expect(() => deleteOne(dir, '../../evil')).toThrow(/不安全的 id/);
  });

  it('删掉之后读不到', () => {
    writeOne(dir, { id: 'a' } as never);
    deleteOne(dir, 'a');
    expect(readOne(dir, 'a')).toBeNull();
  });

  it('写入是原子的：目录里不留 .tmp', () => {
    writeOne(dir, { id: 'a' } as never);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('写入真的走了 tmp+rename，不是省一次系统调用直接写目标文件', () => {
    renameMock.mockClear();
    writeOne(dir, { id: 'a' } as never);
    expect(renameMock).toHaveBeenCalledTimes(1);
    const [src, dest] = renameMock.mock.calls[0];
    expect(String(src)).toMatch(/\.tmp$/);
    expect(dest).toBe(join(dir, 'a.json'));
  });

  it('CONFLICT_RE 认得出各家同步客户端的冲突副本', () => {
    expect(CONFLICT_RE.test('abc (冲突副本 2026-08-13).json')).toBe(true);
    expect(CONFLICT_RE.test('abc (conflicted copy 2026-08-13).json')).toBe(true);
    expect(CONFLICT_RE.test('abc (Nextcloud 的冲突副本 2026-08-13).json')).toBe(true);
    expect(CONFLICT_RE.test('a.sync-conflict-20260813-142530-K3HJ2QL.json')).toBe(true);
    expect(CONFLICT_RE.test('abc.json')).toBe(false);
  });

  it('冲突副本不混进 readAll——它不是一条正常实体', () => {
    writeOne(dir, { id: 'a', n: 1 } as never);
    writeFileSync(join(dir, 'a (冲突副本 2026-08-13).json'), JSON.stringify({ id: 'a', n: 2 }), 'utf8');
    invalidate(dir);
    expect(readAll<{ id: string; n: number }>(dir)).toEqual([{ id: 'a', n: 1 }]);
  });

  it('readAll 未命中分支返回的数组改不动缓存——writeOne 刚 invalidate 过，这次是读盘顺手存入缓存', () => {
    writeOne(dir, { id: 'a' } as never); // invalidate(dir)，缓存是空的
    const a = readAll<{ id: string }>(dir); // 未命中：读盘，out 存进缓存，回值另外 slice 一份
    a.push({ id: 'x' });
    expect(readAll<{ id: string }>(dir)).toHaveLength(1); // 这次命中缓存，不受 a 被改动的影响
  });

  it('readAll 命中分支返回的数组同样改不动缓存——跟未命中是两条独立的返回路径，各自要单独验证', () => {
    writeOne(dir, { id: 'a' } as never);
    readAll<{ id: string }>(dir); // 第一次：未命中，焐热缓存（回值丢弃不用）
    const b = readAll<{ id: string }>(dir); // 第二次：命中缓存分支，取到的这份要单独 slice
    b.push({ id: 'x' });
    expect(readAll<{ id: string }>(dir)).toHaveLength(1); // 第三次仍命中，不受 b 被改动的影响
  });

  describe('listConflicts 缓存', () => {
    beforeEach(() => { readdirMock.mockClear(); });

    it('命中缓存时不再 readdirSync', () => {
      writeFileSync(join(dir, 'a (冲突副本 2026-08-16).json'), '{}', 'utf8');
      readdirMock.mockClear();
      listConflicts(dir);
      listConflicts(dir);
      listConflicts(dir);
      expect(readdirMock).toHaveBeenCalledTimes(1);
    });

    it('invalidate 之后重新读盘', () => {
      listConflicts(dir);
      invalidate(dir); // 用 readAll 同一套失效入口
      readdirMock.mockClear();
      listConflicts(dir);
      expect(readdirMock).toHaveBeenCalledTimes(1);
    });

    // 上限方向：缓存不能把「真的多了一个冲突副本」藏起来——只有正向断言的话，
    // 一个永不失效的实现照样能过上面两条。
    it('新出现的冲突副本在 invalidate 之后能读到', () => {
      expect(listConflicts(dir)).toHaveLength(0);
      writeFileSync(join(dir, 'x (冲突副本 2026-08-16).json'), '{}', 'utf8');
      invalidate(dir);
      expect(listConflicts(dir)).toHaveLength(1);
    });

    it('TTL 到期之后自己会重新读盘，不用等 invalidate——WebDAV 上文件监听器漏事件时的兜底', () => {
      vi.useFakeTimers();
      try {
        expect(listConflicts(dir)).toHaveLength(0); // 焐热缓存
        // 绕过 invalidate 直接改目录——模拟「监听器漏了这次事件，没人会调用 invalidate」。
        writeFileSync(join(dir, 'y (冲突副本 2026-08-16).json'), '{}', 'utf8');
        expect(listConflicts(dir)).toHaveLength(0); // 还在 TTL 窗口内，读到的仍是缓存里的旧列表
        vi.advanceTimersByTime(2100);
        expect(listConflicts(dir)).toHaveLength(1); // TTL 过期，自己重新读盘
      } finally {
        vi.useRealTimers();
      }
    });

    it('未命中分支返回的数组改不动缓存——跟 readAll 同一种错，listConflicts 也要各自 slice', () => {
      writeFileSync(join(dir, 'a (冲突副本 2026-08-16).json'), '{}', 'utf8');
      const a = listConflicts(dir); // 未命中：读盘，files 存进缓存，回值另外 slice 一份
      a.push('x (冲突副本 2026-08-16).json');
      expect(listConflicts(dir)).toHaveLength(1); // 命中缓存分支，不受 a 被改动的影响
    });

    it('命中分支返回的数组同样改不动缓存——跟未命中是两条独立的返回路径', () => {
      writeFileSync(join(dir, 'a (冲突副本 2026-08-16).json'), '{}', 'utf8');
      listConflicts(dir); // 第一次：未命中，焐热缓存（回值丢弃不用）
      const b = listConflicts(dir); // 第二次：命中缓存分支，取到的这份要单独 slice
      b.push('x (冲突副本 2026-08-16).json');
      expect(listConflicts(dir)).toHaveLength(1); // 第三次仍命中，不受 b 被改动的影响
    });
  });

  describe('writeConflictCopy：撞车时另存一份，且必须被 CONFLICT_RE 认出来', () => {
    it('写出来的名字能被 CONFLICT_RE 认出来——认不出来的后果是同一个 id 出现两次', () => {
      const name = writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      expect(CONFLICT_RE.test(name)).toBe(true);
      expect(name.startsWith('abc (')).toBe(true);
    });

    it('readAll 跳过它——正本还是正本，不会被副本盖掉', () => {
      writeOne(dir, { id: 'abc', title: '桌面那份' } as never);
      invalidate(dir);
      writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      invalidate(dir);
      const all = readAll<{ id: string; title: string }>(dir);
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe('桌面那份');
    });

    it('listConflicts 列得出来——现有那条「让人看见」的链直接接上', () => {
      const name = writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      invalidate(dir);
      expect(listConflicts(dir)).toContain(name);
    });

    it('同样的内容写两次是同一个文件——重推不会让副本越堆越多', () => {
      const a = writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      const b = writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      expect(b).toBe(a);
      invalidate(dir);
      expect(listConflicts(dir)).toHaveLength(1);
    });

    it('不同的内容是两个文件——第二次撞车不会盖掉第一次那份', () => {
      writeConflictCopy(dir, { id: 'abc', title: '第一次' } as never);
      writeConflictCopy(dir, { id: 'abc', title: '第二次' } as never);
      invalidate(dir);
      expect(listConflicts(dir)).toHaveLength(2);
    });

    it('内容一样、键顺序不同 → 还是同一个文件（哈希走 stableKey）', () => {
      const a = writeConflictCopy(dir, { id: 'abc', title: 'x', notes: 'y' } as never);
      const b = writeConflictCopy(dir, { notes: 'y', title: 'x', id: 'abc' } as never);
      expect(b).toBe(a);
    });

    // 匹配错误文本，不是光 `.toThrow()`：`writeConflictCopy` 这一层唯一该抛的
    // 是**这一条**。裸 `.toThrow()` 连「这个函数压根不存在」都算过（TypeError
    // 也是抛），这条测试就成了 139 那种自己永远绿的摆设。
    it('id 不安全（路径穿越）照样拒绝，跟 writeOne 同一道关', () => {
      expect(() => writeConflictCopy(dir, { id: '../跑出去' } as never)).toThrow(/不安全的 id/);
      // 再证一次「真的一个字节都没写出去」。目标目录挑 dir 的**子目录**，好让
      // 穿越出来的那份落在 dir 里面、afterEach 收得干净——拿 dir 本身当靶子的话
      // 逃出去的文件会留在系统临时目录里，谁也不会去删。
      const 里层 = join(dir, '里层');
      expect(() => writeConflictCopy(里层, { id: '../跑出去' } as never)).toThrow(/不安全的 id/);
      expect(readdirSync(dir).some((f) => f.startsWith('跑出去'))).toBe(false);
    });

    // 删除撞车那一格：副本的内容是 `{ ...基准, id, deletedAt: <服务端此刻> }`，
    // 由**调用方**拼好整份传进来（Task 6 的路由），这一层不看表——「服务端此刻」
    // 要是在这个函数里现取，测试就控制不住它，而且这一层根本没有第二个理由认识时间。
    // 断言读的是**磁盘上那份**，不是返回值：这个函数唯一的价值就是文件真的落地了。
    it('删除撞车那份：调用方传进来的 deletedAt 原样落盘，整份基准也一字不少', () => {
      const 基准 = { id: 'abc', title: '手机删它之前服务端那份', order: 7 };
      const name = writeConflictCopy(dir, { ...基准, deletedAt: '2026-08-22T09:41:07.000Z' } as never);
      expect(JSON.parse(readFileSync(join(dir, name), 'utf8'))).toEqual({
        id: 'abc',
        title: '手机删它之前服务端那份',
        order: 7,
        deletedAt: '2026-08-22T09:41:07.000Z',
      });
    });

    // 副本这条路要有**自己**的原子性断言：今天它靠跟 writeOne 共用 writeEntityFile
    // 才是原子的，去掉 tmp+rename 只会红 writeOne 那一条——一旦将来有人把两条路
    // 拆回各写一份，副本这边就再没有测试盯着了。而半截 JSON 的冲突副本比正本写歪
    // 还难查：同步客户端照样把它传出去，人打开看到的是一个解析不了的文件。
    it('副本也真的走了 tmp+rename——半截 JSON 的副本会被同步客户端原样传出去', () => {
      renameMock.mockClear();
      const name = writeConflictCopy(dir, { id: 'abc', title: '手机那份' } as never);
      expect(renameMock).toHaveBeenCalledTimes(1);
      const [src, dest] = renameMock.mock.calls[0];
      expect(String(src)).toMatch(/\.tmp$/);
      expect(dest).toBe(join(dir, name));
    });

    // 删除撞车这一格原来把「内容哈希不是时间戳」那条防护整个绕回去了：副本内容里
    // 有一个调用方现盖的 `deletedAt`，回执丢了手机重推同一条删除时服务端那份没动、
    // 还是判冲突，但 `now` 变了 → 哈希变了 → 又一份文件。而「回执丢了会重推」正是
    // 当初选哈希不选时间戳要防的那个场景。两条测试卡住两头：摘得不够（`deletedAt`
    // 还在哈希里）第一条红，摘过头（把真正的身份字段也摘了）第二条红。
    it('删除撞车重推：deletedAt 变了还是同一个文件——它是「写这一刻」，不是这次冲突的身份', () => {
      const 基准 = { id: 'abc', title: '手机删它之前服务端那份', order: 7 };
      const a = writeConflictCopy(dir, { ...基准, deletedAt: '2026-08-22T09:41:07.000Z' } as never);
      const b = writeConflictCopy(dir, { ...基准, deletedAt: '2026-08-22T10:55:31.000Z' } as never);
      expect(b).toBe(a);
      invalidate(dir);
      expect(listConflicts(dir)).toHaveLength(1);
      // 原地覆盖，留在文件里的是最后一次写的那个时刻——不是「已经有了就跳过不写」。
      expect(JSON.parse(readFileSync(join(dir, a), 'utf8')).deletedAt).toBe('2026-08-22T10:55:31.000Z');
    });

    it('基准不同的两条删除撞车仍然是两份——不进哈希的只有 deletedAt 这一个字段', () => {
      // 两次的 deletedAt 故意**相同**：这样唯一的差别就是身份字段，摘过头才会红。
      writeConflictCopy(dir, { id: 'abc', title: '删的是这一版', deletedAt: '2026-08-22T09:41:07.000Z' } as never);
      writeConflictCopy(dir, { id: 'abc', title: '删的是另一版', deletedAt: '2026-08-22T09:41:07.000Z' } as never);
      invalidate(dir);
      expect(listConflicts(dir)).toHaveLength(2);
    });

    // 落盘失败必须抛：调用方拿到返回值才把这条报成 `conflicted`，而手机收到
    // `conflicted` 就会清掉脏记号。吞掉异常返回一个名字 = 手机那份在服务端没有、
    // 在副本里也没有、在手机上记号还被清了——139 那条「把失败路径填成成功路径」
    // 在这一层的最坏版本。用「目录位置上摆着一个文件」制造真实的 EEXIST，不 mock fs。
    it('落盘失败就抛，不会返回一个名字假装写成功了', () => {
      const 不是目录 = join(dir, '这是个文件不是目录');
      writeFileSync(不是目录, '', 'utf8');
      // 匹配 errno 码，不是裸 `.toThrow()`：裸的连「函数不存在」都算过。
      expect(() => writeConflictCopy(不是目录, { id: 'abc', title: '手机那份' } as never))
        .toThrow(/EEXIST|ENOTDIR|ENOENT/);
    });
  });

  // 放在这个 describe 的最后一条：invalidateAll() 是一次性的单向开关（一旦打开
  // 就不再关回去，见函数上的注释），会影响这个文件里跑在它之后的其它测试的
  // 缓存行为（虽然不会影响它们的断言——旁路只是「总是读盘」，结果集不会变）。
  it('invalidateAll 之后缓存永久旁路——不用等谁调用 invalidate，readAll 直接读盘（events.ts 的监听器挂了之后就是这个场景）', () => {
    writeOne(dir, { id: 'a', n: 1 } as never);
    expect(readAll<{ id: string; n: number }>(dir)).toEqual([{ id: 'a', n: 1 }]);   // 焐热缓存
    invalidateAll();
    // 绕过 writeOne 直接改文件——不触发它内部的 invalidate，模拟「监听器已经
    // 挂了，没有人会再调用 invalidate」这个场景。
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', n: 2 }), 'utf8');
    expect(readAll<{ id: string; n: number }>(dir)).toEqual([{ id: 'a', n: 2 }]);

    // 第二轮，关键的那一步：只把 invalidateAll 实现成「清一次缓存」而不是
    // 「永久旁路」的话，上面那次 readAll 会把 n:2 重新缓存住——这一轮读到的
    // 就会是缓存里的 n:2（旧值），不是磁盘上真正的 n:3。只有真的永久旁路
    // （每次都不读写缓存）才能让这一轮也读到最新内容。一轮观测「清一次」和
    // 「永久旁路」看起来完全一样，两轮才能把两者区分开。
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', n: 3 }), 'utf8');
    expect(readAll<{ id: string; n: number }>(dir)).toEqual([{ id: 'a', n: 3 }]);
  });

  // 同样必须放在最后：invalidateAll() 已经在上一条测试里把 bypassCache 永久打开了，
  // 这里再调一次纯粹是让这条测试自己读起来完整、不依赖跑在它前面的另一条测试。
  //
  // 这条测试守的是报告里那句承诺：「监听器彻底挂掉时，listConflicts 也会每次都
  // 读盘，不会被 2 秒 TTL 卡住」——生产代码里 listConflicts 的两处 `!bypassCache`
  // 守卫接对了，但如果没有这条测试，把它们整个删掉也不会有任何测试变红。
  it('invalidateAll 之后 listConflicts 也永久旁路缓存——不用等 TTL 过期，每次都读盘', () => {
    writeFileSync(join(dir, 'a (冲突副本 2026-08-16).json'), '{}', 'utf8');
    expect(listConflicts(dir)).toHaveLength(1); // 焐热缓存
    invalidateAll();
    // 绕过 invalidate 直接改目录——模拟「监听器已经挂了，没有人会再调用 invalidate」。
    writeFileSync(join(dir, 'b (冲突副本 2026-08-16).json'), '{}', 'utf8');
    expect(listConflicts(dir)).toHaveLength(2); // 还在 2 秒 TTL 窗口内，bypassCache 照样让它读盘

    // 第二轮，关键的那一步：只把 bypassCache 应用一次（比如判断成立就把这次结果
    // 重新缓存住）而不是「只要 bypassCache 是 true 就永远不读写缓存」的话，上面
    // 那次 listConflicts 会把 2 份的列表缓存住，这一轮就读不到第三份——两轮才能
    // 把「查一次就不再管」和「每次都不碰缓存」区分开。
    writeFileSync(join(dir, 'c (冲突副本 2026-08-16).json'), '{}', 'utf8');
    expect(listConflicts(dir)).toHaveLength(3);
  });
});

/**
 * **文件名跟里面的 id 对不上的文件不收。**
 *
 * 实测复现过一次真实的数据销毁：同步盘留下一个 `<id> (1).json`（`CONFLICT_RE`
 * 只认「冲突副本」/「conflicted copy」/`.sync-conflict-`，认不出这一种命名），
 * 它按文件名排序**排在原件之前**。于是接口把同一条任务读成两条，`PATCH` 的
 * `.find` 改的是副本，而 `syncAll` 的 `new Map` 认为原件那份「没变」不重写它
 * ——净结果是只改了个优先级，原件的标题被副本的过时内容整个覆盖。
 */
describe('entityStore：文件名和 id 对不上', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dup-')); invalidateAll(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (file: string, obj: unknown) => writeFileSync(join(dir, file), JSON.stringify(obj), 'utf8');

  it('副本被跳过，读出来只有原件那一条', () => {
    put('a.json', { id: 'a', title: '原件' });
    put('a (1).json', { id: 'a', title: '副本' });
    invalidateAll();
    const all = readAll<{ id: string; title: string }>(dir);
    expect(all.map((x) => x.title)).toEqual(['原件']);
  });

  // 归进「坏文件」而不是静默丢弃：那个文件在磁盘上真实存在，人得知道它在，
  // 才谈得上去删或者去改。
  it('副本会挂到坏文件横幅上', () => {
    put('a.json', { id: 'a', title: '原件' });
    put('a (1).json', { id: 'a', title: '副本' });
    invalidateAll();
    readAll(dir);
    expect(listBroken()).toContainEqual({ dir, file: 'a (1).json' });
  });

  /**
   * 这是那次销毁的最后一步：`syncAll` 拿 `readAll` 的结果建索引，副本在前面就
   * 会让它以为原件「没变」而不重写。副本被挡掉之后，改一个字段就只改那一个。
   */
  it('有副本在场时，改一个字段不会把原件的别的字段冲掉', () => {
    put('a.json', { id: 'a', title: '原件', priority: 0 });
    put('a (1).json', { id: 'a', title: '副本', priority: 0 });
    invalidateAll();
    const all = readAll<{ id: string; title: string; priority: number }>(dir);
    syncAll(dir, all.map((x) => ({ ...x, priority: 3 })));
    invalidateAll();
    const back = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')) as { title: string; priority: number };
    expect(back.title, '原件的标题被副本的内容覆盖了').toBe('原件');
    expect(back.priority).toBe(3);
  });
});

/**
 * **两个只差大小写的 id，在 Windows 上是同一个文件。** `isSafeId` 只看单个 id 的
 * 形状；盘上有 `foo.json` 时写 `Foo.json`，NTFS 写的就是那个文件——`foo` 那条被
 * 静默换掉，没有横幅、没有副本。所有平台一律拒（理由见 `assertNoCaseCollision`）。
 * 这条测试在 Linux 上跑也一样红/绿：判的是 id，不是文件系统。
 */
describe('entityStore：只差大小写的 id 拒绝写入', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'case-')); invalidateAll(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('盘上有 foo，再 sync 进一个 Foo：抛错，foo 原封不动，一个字节都没写', () => {
    syncAll(dir, [{ id: 'foo', title: '原件' } as never]);
    expect(() => syncAll(dir, [{ id: 'foo', title: '原件' }, { id: 'Foo', title: '冒名的' }] as never))
      .toThrow(/只差大小写/);
    invalidateAll();
    const all = readAll<{ id: string; title: string }>(dir);
    expect(all).toEqual([{ id: 'foo', title: '原件' }]);
  });

  it('同一批里两个只差大小写的也拒——写到盘上会互相覆盖', () => {
    expect(() => syncAll(dir, [{ id: 'abc' }, { id: 'ABC' }])).toThrow(/只差大小写/);
    expect(readdirSync(dir), '整批查完再写，一个都不该落盘').toEqual([]);
  });

  it('同一个 id 原样重写不算撞——那是正常的更新', () => {
    syncAll(dir, [{ id: 'foo', n: 1 } as never]);
    expect(() => syncAll(dir, [{ id: 'foo', n: 2 } as never])).not.toThrow();
  });
});
