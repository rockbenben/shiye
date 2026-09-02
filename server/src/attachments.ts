import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { isSafeId } from './entityStore.js';
import { dataDir } from './store.js';

/**
 * 附件存储层。**这是这个仓库第一次把外部字符串（文件名，来自浏览器）直接当
 * 文件系统路径的一部分用**——`../`、`/`、`\`、NUL、Windows 保留名都可能进来。
 *
 * 两道守卫各自独立：
 * 1. `safeName`——**存**的时候净化，只留安全的基名
 * 2. `resolveAttachment`——**取**的时候兜底，拼出路径后 `resolve()` 确认仍在
 *    `data/attachments/<taskId>/` 里面才放行，就算 `safeName` 被绕过/写错也拦得住
 *
 * 只有一道的话，另一道写错了没人知道——两道都要单独变异验证。
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 净化后基名的字节上限（UTF-8），避免路径超长。 */
const MAX_NAME_BYTES = 120;

/** Windows 保留设备名：大小写不敏感，带扩展名也算（`con.txt` 照样是保留名）。 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 控制字符（含 NUL）。 */
const CONTROL_CHARS_RE = /[\x00-\x1f]/g;

/**
 * Windows 文件名不允许的字符。**不净化的话它们不会报错，而是悄悄落进 NTFS
 * 交替数据流**（`a:b.txt` 实际写进 `a` 这个文件的 `:b.txt` 流）：HTTP 200、
 * `Task.attachments` 里记着 `a:b.txt`，磁盘上 `readdirSync` 却只看得到 `a`——
 * 数组和磁盘从落盘那一刻就对不上，绝大多数同步客户端不复制 ADS，这个附件在
 * 别的设备上就是不存在（final-review.md m5）。尾随的 `.`/空格会被 Windows
 * 自动丢弃，同一类漂移，一并处理。 */
const WINDOWS_ILLEGAL_CHARS_RE = /[<>:"|?*]/g;
const TRAILING_DOT_SPACE_RE = /[. ]+$/;

/**
 * `saveAttachment` 自己判定的「这次保存本身不合法」——taskId/文件名净化后
 * 拒收。**跟落盘时真的抛出来的 fs 异常（磁盘满、无权限……）分开**：前者是
 * 「你的请求有问题」，该回 400 并带上具体原因；后者是服务器自己的故障，
 * 不该照抄 errno 文本把服务器绝对路径回给客户端（final-review.md I4）。
 * 调用方靠 `instanceof` 区分，不是猜错误信息的措辞。
 */
export class AttachmentValidationError extends Error {}

/** 按字节数截断，不切碎多字节 UTF-8 字符（用码点迭代，而不是按索引切片）。 */
function truncateBytes(s: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/** 截到 120 字节以内，扩展名保留：先分出「最后一个 `.` 之后」那段，只截前半。 */
function truncateName(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES) return name;
  const dotIdx = name.lastIndexOf('.');
  const hasExt = dotIdx > 0 && dotIdx < name.length - 1;
  const ext = hasExt ? name.slice(dotIdx) : '';
  const stem = hasExt ? name.slice(0, dotIdx) : name;
  const stemBudget = Math.max(0, MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8'));
  const truncated = truncateBytes(stem, stemBudget) + ext;
  // 扩展名本身就超过 120 字节时 stemBudget 归 0，上面这行等于「原样返回
  // ext」——长度完全不受控（final-review.md m4）。最后再兜一次，这次不管
  // 扩展名边界，纯按字节数硬切：一个 300 字节的“扩展名”本来就不是真正的
  // 扩展名，切碎它不会比切碎文件名本身更糟。
  return truncateBytes(truncated, MAX_NAME_BYTES);
}

/**
 * 净化成一个安全的基名；净化之后为空返回 null（调用方拒收，不编一个名字）。
 *
 * **只取基名**：手动按 `/` 和 `\` 切（不用 `node:path` 的 `basename`——它的行为
 * 随平台变，这里两种分隔符都要挡，不管服务跑在哪个操作系统上）。
 *
 * **不要用「只允许 ASCII」这种偷懒白名单**——中文文件名（拥有者在用）必须原样保留。
 */
export function safeName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // 只取最后一段：../../etc/passwd → passwd，a/b/c.txt → c.txt，a\b\c.txt → c.txt
  const segments = raw.split(/[/\\]+/);
  let name = segments[segments.length - 1] ?? '';
  name = name.replace(CONTROL_CHARS_RE, '').trim();
  // Windows 非法字符换成 `_`、剥掉尾随的点/空格——不剥的话这几个字符不会让
  // 落盘报错，而是悄悄写进 NTFS 交替数据流或者被系统自动丢弃，`Task.attachments`
  // 里记的名字跟磁盘上真实存在的文件当场就对不上（final-review.md m5）。
  name = name.replace(WINDOWS_ILLEGAL_CHARS_RE, '_').replace(TRAILING_DOT_SPACE_RE, '');
  if (name === '' || name === '.' || name === '..') return null;
  if (RESERVED_NAME_RE.test(name)) return null;
  name = truncateName(name);
  if (name === '' || name === '.' || name === '..') return null;
  return name;
}

function attachmentsDir(taskId: string): string {
  return join(dataDir(), 'attachments', taskId);
}

/** 同名文件加序号：`报告.pdf` → `报告 (2).pdf`，不覆盖。 */
function dedupeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dotIdx = name.lastIndexOf('.');
  const hasExt = dotIdx > 0 && dotIdx < name.length - 1;
  const stem = hasExt ? name.slice(0, dotIdx) : name;
  const ext = hasExt ? name.slice(dotIdx) : '';
  let n = 2;
  let candidate = `${stem} (${n})${ext}`;
  while (existsSync(join(dir, candidate))) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

/**
 * 落盘，返回真正用的文件名（重名会加序号）。`taskId` 不安全（复用
 * `entityStore.ts` 的 `isSafeId`）或者 `name` 净化后为空，一律抛错、不落盘。
 */
export function saveAttachment(taskId: string, name: string, bytes: Uint8Array): string {
  if (!isSafeId(taskId)) {
    throw new AttachmentValidationError(`不安全的 taskId，拒绝保存附件（可能是路径穿越）：${JSON.stringify(taskId)}`);
  }
  const clean = safeName(name);
  if (clean === null) {
    throw new AttachmentValidationError(`不安全的文件名，拒绝保存附件：${JSON.stringify(name)}`);
  }
  const dir = attachmentsDir(taskId);
  mkdirSync(dir, { recursive: true });
  const finalName = dedupeName(dir, clean);
  writeFileSync(join(dir, finalName), bytes);
  return finalName;
}

/** 以磁盘为准列举。目录不存在返回 []，不列子目录。 */
export function listAttachments(taskId: string): string[] {
  if (!isSafeId(taskId)) return [];
  const dir = attachmentsDir(taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * 取一个附件的绝对路径；不安全或不存在返回 null。
 *
 * **独立于 `safeName` 的第二道兜底**：不管 `name` 有没有经过净化，这里都会
 * 自己 `resolve()` 拼出的路径、确认它仍在 `data/attachments/<taskId>/` 目录
 * 内部，就算 `safeName` 被绕过或者写错了，这道照样拦得住。
 */
export function resolveAttachment(taskId: string, name: string): string | null {
  if (!isSafeId(taskId)) return null;
  if (typeof name !== 'string' || name === '') return null;
  const dir = resolve(attachmentsDir(taskId));
  const full = resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/**
 * 删除一个附件，返回磁盘上真正被删掉的那个 basename；没找到返回 null。
 *
 * **返回真正的 basename，不是回声请求里的 `name`**——调用方（app.ts 的 DELETE
 * 路由）要拿它去摘 `Task.attachments` 数组和拼 `Content-Disposition`。请求里的
 * `name` 跟磁盘上的 basename「同一性」的定义不一样（大小写、`./` 前缀……
 * `resolveAttachment` 会把它们都解析到同一个文件上），用请求里的原始 `name`
 * 摘数组会摘不中真正的条目，留下一条文件已经没了、却再也删不掉的死条目
 * （final-review.md m6/m7）。
 */
export function removeAttachment(taskId: string, name: string): string | null {
  const full = resolveAttachment(taskId, name);
  if (full === null) return null;
  unlinkSync(full);
  return basename(full);
}

/**
 * 彻底删除任务时清整个目录。目录不存在时不抛，不碰别的任务的目录。
 *
 * **`isSafeId` 之外再加一道 resolve+containment**：`isSafeId('.')` 是
 * `true`（只挡 `..` 和 `/`/`\`，不挡单独一个 `.`），而
 * `join(dataDir(), 'attachments', '.')` 会被 `path.join` 规范化成
 * `data/attachments` 本身——不加这道的话 `removeAllAttachments('.')`
 * 会把整棵 `attachments/` 目录端掉，不止这一个任务的（final-review.md I2）。
 * `resolveAttachment`/`saveAttachment` 已经在用同一个 resolve-then-contain
 * 模式，这里补上，不是新发明一套。
 */
export function removeAllAttachments(taskId: string): void {
  if (!isSafeId(taskId)) return;
  const root = resolve(join(dataDir(), 'attachments'));
  const dir = resolve(attachmentsDir(taskId));
  if (!dir.startsWith(root + sep)) return; // '.' 会让 dir === root，挡在这里
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
