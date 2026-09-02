import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **「导出数据」必须覆盖 `data/` 下的每一张表。**
 *
 * 这份导出在界面上被说成「自己给自己多买一层」保险，而 `data/` 已经没有 `.bak`
 * 了。照它当唯一备份的人，丢了 `data/` 之后才会发现少了什么——而少的那几样
 * （清单、文件夹、纪念日、观察、垃圾箱）在 JSON 里**连键都没有**，不是空数组，
 * 所以连「导出时是空的还是压根没导」都分不出来。
 *
 * 它真的漏过：上一版只导 inbox/tasks/settings/proposals 四样，而 `paths()` 有八个
 * 目录。`conflicts.ts` 遇到同一个问题时是遍历 `Object.entries(paths())` 解决的，
 * 那边的注释专门讲了「别手抄一份表名单」；web 侧够不着 `paths()`（只有 HTTP
 * 接口），所以名单只能手写——这条守卫就是替它对账的那一份。
 *
 * ## 判据：服务端的 `paths()` ⊆ 导出的键
 *
 * 反过来不要求相等：导出里多一个 `settings` 是对的（设置不在 `data/` 里，
 * 存在设备本地，见 `store.ts` 的 `deviceConfigPath`），那是有意多带的一样。
 */
describe('导出数据的覆盖面', () => {
  const storeSrc = readFileSync('server/src/store.ts', 'utf8');
  const modalSrc = readFileSync('web/src/components/SettingsModal.tsx', 'utf8');

  /** `paths()` 里那几个目录名，就是 `data/` 下的全部表。 */
  const tables = (): string[] => {
    const m = /export const paths = \(\) => \(\{([\s\S]*?)\n\}\)/.exec(storeSrc);
    if (!m) throw new Error('找不到 store.ts 的 paths()——改写了就把这条守卫的锚点一起改');
    return [...m[1].matchAll(/^\s{2}(\w+): join\(dataDir\(\)/gm)].map((x) => x[1]);
  };

  /** 导出时打进 JSON 的那些键。 */
  const exported = (): string[] => {
    const m = /const payload = \{([^}]*)\}/.exec(modalSrc);
    if (!m) throw new Error('找不到 exportData 的 payload——改写了就把这条守卫的锚点一起改');
    return m[1].split(',').map((x) => x.trim()).filter(Boolean);
  };

  it('前提：两份名单都抠得出来，不是拿空集合在比', () => {
    expect(tables().length, 'paths() 一个目录都没抠到').toBeGreaterThan(4);
    expect(exported().length).toBeGreaterThan(4);
  });

  it('data/ 下的每一张表都在导出里——少一张，那份备份就救不回它', () => {
    const keys = new Set(exported());
    for (const t of tables()) {
      expect(keys.has(t), `「${t}」在 data/ 下有一张表，却没进导出`).toBe(true);
    }
  });
});
