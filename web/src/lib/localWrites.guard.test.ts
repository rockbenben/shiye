import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **`LOCAL_WRITES` 那份名单必须跟 `unlocked` 里真正会写盘的方法一字不差。**
 *
 * 锁（`serialized`）只套在名单里的方法上。新加一个离线写方法而忘了进名单，
 * 它就是唯一一个不排队的——两个写交错时静默丢一个，正是这把锁存在的理由
 * （localStore.ts 那段）。反过来把只读方法塞进名单也不对：读排在写后面，
 * 界面刷新会等。
 *
 * 判据是文本的：`unlocked` 对象里每个方法体，含 `.write(` 或 `.mark(` 的算写。
 * `patchTasks` 例外——它只转调 `patchTasksEach`（已在名单里），自己拿锁会等自己。
 */
describe('LOCAL_WRITES 跟真正会写的方法对得上', () => {
  const src = readFileSync('web/src/lib/dataSource.ts', 'utf8');
  const from = src.indexOf('const unlocked = {');
  const to = src.indexOf('\n};', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const body = src.slice(from, to);

  // 顶层方法：两个空格缩进、名字、冒号。切成 [名字, 方法体] 段。
  const heads = [...body.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*):/gm)];
  const methods = heads.map((m, i) => ({
    name: m[1],
    text: body.slice(m.index, heads[i + 1]?.index ?? body.length),
  }));
  const writers = methods.filter((m) => /\.write\(|\.mark\(/.test(m.text)).map((m) => m.name);

  const listed = (): string[] => {
    const m = /export const LOCAL_WRITES = \[([^\]]*)\]/.exec(src);
    if (!m) throw new Error('没找到 LOCAL_WRITES');
    return [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]);
  };

  it('前提：抠得出方法来', () => {
    expect(methods.length).toBeGreaterThan(15);
    expect(writers).toContain('patchTask');
  });

  it('会写的每一个都在名单里', () => {
    expect(writers.filter((w) => !listed().includes(w)), '给 LOCAL_WRITES 补上').toEqual([]);
  });

  it('名单里的每一个都真的会写——只读的排队只会拖慢刷新', () => {
    expect(listed().filter((w) => !writers.includes(w)), '从 LOCAL_WRITES 里去掉').toEqual([]);
  });
});
