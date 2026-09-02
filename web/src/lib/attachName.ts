/**
 * 附件名字上的两个判断：是不是图片、粘贴进来的那份该叫什么。
 *
 * 纯函数，不碰 DOM 也不碰网络——放在 lib 里是为了能单独测，两个判断都有
 * 一堆容易想当然的边界（大小写、没有扩展名、剪贴板给的空文件名）。
 */

/**
 * 认图片只按**扩展名白名单**，不看 MIME。
 *
 * 附件在服务端是按原名存的一个文件，读回来的时候只有名字——`listAttachments`
 * 返回的就是一串文件名，没有类型信息。想按 MIME 判就得为每个附件多问服务端
 * 一次，而这只是决定「要不要画个缩略图」。
 *
 * 白名单不含 `svg`：它是可以带脚本的，直接塞进 `<img>` 虽然不会执行（`<img>`
 * 里的 SVG 不跑脚本），但这一条边界不值得为了预览一个很少见的附件类型去赌。
 */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

export function isImageName(name: string): boolean {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return false;   // 没有扩展名 / 以点结尾
  return IMAGE_EXT.includes(name.slice(i + 1).toLowerCase());
}

/**
 * 粘贴进来的文件叫什么。
 *
 * **剪贴板里的截图通常没有名字**：Chrome 给的是 `image.png`，别的浏览器可能
 * 给空字符串——十张截图全叫 `image.png` 的话，服务端那边同名会互相覆盖
 * （或者被加后缀），列表上也完全分不出哪张是哪张。所以粘贴这条路自己造一个
 * 带时间戳的名字。
 *
 * 时间戳用**本地墙钟**：这个名字是给人看的，`toISOString()` 的 UTC 会让晚上
 * 八点粘的图显示成第二天。
 *
 * 一次粘一批时（剪贴板里好几张图）传 `index`：时间戳只精确到秒，同一次粘贴
 * 里的几张拿到的是同一个秒数，不加序号就全撞在一起——那正是这个函数要解决
 * 的问题本身。**第 0 张不加后缀**，一张图的常见情形名字一个字不变。
 */
export function pastedName(file: File, now: Date, index = 0): string {
  const ext = isImageName(file.name) ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    : file.type === 'image/jpeg' ? 'jpg'
      : file.type.startsWith('image/') ? file.type.slice('image/'.length)
        : 'png';
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `粘贴-${stamp}${index > 0 ? `-${index + 1}` : ''}.${ext}`;
}
