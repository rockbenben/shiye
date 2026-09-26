import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 托盘那个「自动检查更新」checkbox 的持久化（D1：默认关——这项目对外承诺
 * 「全部跑在本机、不联网」，定期连 GitHub 必须由用户明说）。
 * 读写两头都兜死：文件坏了当默认值、写失败只 log——一个偏好开关不配
 * 把托盘炸了，也不配把启动卡住。
 */
export function loadAutoCheck(file: string, log: (msg: string) => void): boolean {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { autoCheck?: unknown };
    return raw.autoCheck === true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT 是常态（第一次跑、还没勾过），静默按默认；其余才是真坏了，留一句话。
    if (code !== 'ENOENT') log(`update-prefs.json 读不出来，按默认（关）处理：${(e as Error).message}`);
    return false;
  }
}

export function saveAutoCheck(file: string, value: boolean, log: (msg: string) => void): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ autoCheck: value }, null, 2));
  } catch (e) {
    log(`update-prefs.json 没能写下（这次勾选只活到本进程结束）：${(e as Error).message}`);
  }
}
