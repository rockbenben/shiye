import { describe, it, expect } from 'vitest';
import { isImageName, pastedName } from './attachName.js';

describe('isImageName', () => {
  it('常见的几种图片认得出，大小写都认', () => {
    for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.AVIF']) {
      expect(isImageName(n), n).toBe(true);
    }
  });

  it('不是图片的不认', () => {
    for (const n of ['a.pdf', 'b.txt', 'c.zip', 'd.mp4']) expect(isImageName(n), n).toBe(false);
  });

  it('**svg 不认**——它能带脚本，这条边界不值得为了预览一个很少见的类型去赌', () => {
    expect(isImageName('x.svg')).toBe(false);
  });

  it('没有扩展名、以点结尾、以点开头的都不认', () => {
    for (const n of ['README', 'x.', '.png', '']) expect(isImageName(n), JSON.stringify(n)).toBe(false);
  });

  it('名字里有点也只看最后一段', () => {
    expect(isImageName('会议.纪要.png')).toBe(true);
    expect(isImageName('a.png.txt')).toBe(false);
  });
});

describe('pastedName', () => {
  const NOW = new Date(2026, 7, 20, 14, 5, 9);
  const file = (name: string, type: string) => ({ name, type } as File);

  it('带本地墙钟的时间戳——**剪贴板里的截图通常没有名字**，十张都叫 image.png 会互相覆盖', () => {
    expect(pastedName(file('image.png', 'image/png'), NOW)).toBe('粘贴-20260820-140509.png');
  });

  it('用本地时间不是 UTC——这个名字是给人看的，晚上八点粘的图不该显示成第二天', () => {
    const late = new Date(2026, 7, 20, 23, 30, 0);
    expect(pastedName(file('', 'image/png'), late)).toContain('20260820-2330');
  });

  it('没有名字时按 MIME 定扩展名', () => {
    expect(pastedName(file('', 'image/webp'), NOW)).toMatch(/\.webp$/);
  });

  it('image/jpeg 写成 jpg，不是 jpeg——那才是大家认的那个后缀', () => {
    expect(pastedName(file('', 'image/jpeg'), NOW)).toMatch(/\.jpg$/);
  });

  it('认不出来的一律 png，不留一个没有扩展名的文件', () => {
    expect(pastedName(file('', ''), NOW)).toMatch(/\.png$/);
  });
});

describe('pastedName：一次粘一批', () => {
  const at = new Date(2026, 7, 22, 14, 5, 9);
  const png = (n: string) => new File(['x'], n, { type: 'image/png' });

  it('第 0 张不加后缀——一张图的常见情形，名字一个字不变', () => {
    expect(pastedName(png('image.png'), at)).toBe('粘贴-20260822-140509.png');
    expect(pastedName(png('image.png'), at, 0)).toBe('粘贴-20260822-140509.png');
  });

  it('后面几张带序号——时间戳只到秒，同一次粘贴的几张不加序号会全撞在一起，而那正是这个函数要解决的问题', () => {
    expect(pastedName(png('image.png'), at, 1)).toBe('粘贴-20260822-140509-2.png');
    expect(pastedName(png('image.png'), at, 2)).toBe('粘贴-20260822-140509-3.png');
  });
});
