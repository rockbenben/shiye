import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach } from 'vitest';

/**
 * node 那一档的兜底：**没设 `DATA_DIR` / `DEVICE_CONFIG` 的测试，写进临时目录，
 * 不写进这台机器。**
 *
 * 这不是防御性编程，是修一个真发生过的事故。`server/src/reminder.test.ts` 里
 * `describe('fireReminders：攒了很久的那些只盖章、不响')` 没有自己的
 * `beforeEach`，而它上一个 describe 的 `afterEach` 会 `delete` 这两个环境变量
 * ——于是这一组的 `writeSettings(...)` 和 `writeTasks(...)` 落在了：
 *
 * - `%APPDATA%\shiye\device.json`：**真实的设置**，被整份覆盖成
 *   `DEFAULT_SETTINGS` 加上那条测试的 `webhookUrl: 'http://example.test/hook'`；
 * - 仓库的 `data/tasks/`：被换成那条测试的两个夹具任务（「旧的」「新的」）。
 *   `writeTasks` 是整目录替换，原来有什么就没了，而 `data/` 不进 git。
 *
 * 每跑一次 `npm test` 就重来一遍。单个测试补 `beforeEach` 只能修掉已经发现的
 * 那一处；这个 setup 文件修的是「忘了设就打真机器」这件事本身——以后再有谁
 * 忘了，最坏的结果是写进一个临时目录。
 *
 * 用 `??=` 而不是无条件赋值：自己设了的测试（大多数）照旧用自己那份，这里只
 * 接住没设的。挂在 `beforeEach` 而不是模块顶层，是因为事故的形状正是「上一个
 * describe 的 afterEach 把它删了」——只在文件开头设一次接不住那个删除。
 *
 * 测试体里自己 `delete process.env.DATA_DIR` 再断言默认路径的那种写法不受影响：
 * 这个钩子在用例开跑**之前**就跑完了。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'shiye-test-'));

beforeEach(() => {
  process.env.DATA_DIR ??= join(sandbox, 'data');
  process.env.DEVICE_CONFIG ??= join(sandbox, 'device.json');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
