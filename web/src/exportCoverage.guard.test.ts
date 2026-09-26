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
 *
 * ## 对账：导入侧的 `IMPORT_KEYS`（Task 10 补的）
 *
 * 「同一份名单抄两份，总有一份是旧的」——导入侧（`server/src/import.ts` 的
 * `IMPORT_KEYS`）和导出侧（SettingsModal 手写的键名单）现在各有一份，
 * 下面再补两条守卫把它们跟 `paths()` 三方钉死。
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

  /** 导入侧认的那八张表——`server/src/import.ts` 里那行单行字面量。 */
  const importKeys = (): string[] => {
    let importSrc: string;
    try {
      importSrc = readFileSync('server/src/import.ts', 'utf8');
    } catch {
      throw new Error('server/src/import.ts 不存在——对账的导入侧没得比了');
    }
    const m = /export const IMPORT_KEYS = \[([^\]]*)\] as const;/.exec(importSrc);
    if (!m) throw new Error("找不到 `export const IMPORT_KEYS = […] as const;` 那一行——改成拼接或拆成多个常量了？那边注释专门写了别改，这条守卫的锚点也别动");
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  /** 「导入数据」在 web 侧认的键名单——`REQUIRED_KEYS` 派生自 `IMPORT_LABELS` 的字面量键。 */
  const requiredKeys = (): string[] => {
    const m = /const IMPORT_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(modalSrc);
    if (!m) throw new Error('找不到 IMPORT_LABELS 的字面量——改写了就把这条守卫的锚点一起改');
    return [...m[1].matchAll(/([A-Za-z_]\w*) *:/g)].map((x) => x[1]);
  };

  const sorted = (xs: string[]) => [...xs].sort();

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

  it('IMPORT_KEYS 恰好就是 data/ 的八张表——导入侧跟磁盘表名单对不上，多出来的键是假表，少了的键整列悄悄丢', () => {
    expect(importKeys().length, 'IMPORT_KEYS 一个键都没抠到').toBeGreaterThan(4);
    expect(sorted(importKeys()), '导入侧的表名单跟 paths() 对不上（两边必须恰好一样多、一模一样）').toEqual(sorted(tables()));
  });

  it('导出产物能被导入吃回去——exportData 的 payload 和 REQUIRED_KEYS 都得恰好是 IMPORT_KEYS 加一个 settings，一个不多一个不少', () => {
    // 两个名单各管一头：payload 决定导出文件里真的有什么，REQUIRED_KEYS 决定
    // 导入那一屏认什么。 invariant 是「导出的正好是导入认的」，所以两头都钉。
    const expected = sorted([...importKeys(), 'settings']);
    expect(sorted(exported()), '导出 payload 的键 ≠ IMPORT_KEYS ∪ {settings}').toEqual(expected);
    expect(sorted(requiredKeys()), 'REQUIRED_KEYS ≠ IMPORT_KEYS ∪ {settings}').toEqual(expected);
  });
});
