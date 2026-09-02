import { describe, expect, it } from 'vitest';
import { decideLink } from './links.js';

const APP = 'http://localhost:30035';

describe('decideLink', () => {
  it('应用自己那一页：留在窗口里', () => {
    expect(decideLink(`${APP}/`, APP)).toEqual({ kind: 'stay' });
    expect(decideLink(`${APP}/#/today`, APP)).toEqual({ kind: 'stay' });
  });

  it('**同源但不是根路径：交给系统**——只有附件是这种（/api/tasks/:id/attachments/:name），用系统的看图程序打开正是想要的', () => {
    const u = `${APP}/api/tasks/abc/attachments/%E5%9B%BE.png`;
    expect(decideLink(u, APP)).toEqual({ kind: 'external', url: u });
  });

  it('外部 http/https：交给系统浏览器，不在这个应用里开一个没有地址栏的窗口', () => {
    expect(decideLink('https://example.com/a', APP)).toEqual({ kind: 'external', url: 'https://example.com/a' });
    expect(decideLink('http://example.com', APP)).toEqual({ kind: 'external', url: 'http://example.com' });
  });

  it('mailto 也交给系统', () => {
    expect(decideLink('mailto:a@b.c', APP)).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });

  it('**javascript: / data: / file: 一律拦下来什么都不做**——备注是自由文本，AI 也能往里写，把它原样递给系统是在替一段不受信任的文本执行动作', () => {
    expect(decideLink('javascript:alert(1)', APP)).toEqual({ kind: 'block' });
    expect(decideLink('data:text/html,<b>x', APP)).toEqual({ kind: 'block' });
    expect(decideLink('file:///C:/Windows/System32/cmd.exe', APP)).toEqual({ kind: 'block' });
  });

  it('解析不出来的（相对路径、空串）放行——那不是一次真正的跨页导航', () => {
    expect(decideLink('', APP)).toEqual({ kind: 'stay' });
    expect(decideLink('#/today', APP)).toEqual({ kind: 'stay' });
  });

  it('**别的端口不算同源**——同一台机器上另起的服务不是这个应用', () => {
    expect(decideLink('http://localhost:30036/', APP)).toEqual({ kind: 'external', url: 'http://localhost:30036/' });
  });
});
