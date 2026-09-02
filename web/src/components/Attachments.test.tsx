import { describe, it, expect, vi, afterEach } from 'vitest';
import { App as AntApp } from 'antd';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Attachments, useFileDrop } from './Attachments.js';
import { confirmDialog, btnIn } from '../test-utils.js';

vi.mock('../api.js', () => ({
  api: {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    attachmentUrl: vi.fn((taskId: string, name: string) => `/api/tasks/${taskId}/attachments/${encodeURIComponent(name)}`),
  },
}));

// 必须在 vi.mock 之后 import——vi.mock 会被提升到文件顶部，这里拿到的已经是
// mock 过的那份，跟 SettingsModal.test.tsx 同一个套路。
const { api } = await import('../api.js');
const uploadMock = api.uploadAttachment as ReturnType<typeof vi.fn>;
const deleteMock = api.deleteAttachment as ReturnType<typeof vi.fn>;

/**
 * `Attachments` 自己不再持有拖放状态（over/uploading/upload 搬去了
 * `useFileDrop`，见 Attachments.tsx 顶部注释）——真实场景里那个 hook 由
 * `TaskCard` 调一次、`dropProps` 摊在 `Card` 上。这里用一个最小的外壳模拟
 * 那层：`dropProps` 摊在包一层的 `div` 上，`over`/`uploading`/`upload` 转发
 * 给 `Attachments`。`fireEvent.drop(box, …)` 落在 `.ink-attach-box` 上时会
 * 原生冒泡到这层外壳，效果跟真实场景（冒泡到 Card）一致，下面的测试body
 * 不用跟着搬。
 */
function Harness({
  taskId = 't1', attachments = [] as string[], offline = false,
}: Partial<{ taskId: string; attachments: string[]; offline: boolean }>) {
  const { over, uploading, upload, dropProps } = useFileDrop(taskId);
  return (
    <div {...dropProps}>
      <Attachments taskId={taskId} attachments={attachments} over={over} uploading={uploading} onUpload={upload} offline={offline} />
    </div>
  );
}

const renderIt = (props: Partial<{ taskId: string; attachments: string[]; offline: boolean }> = {}) =>
  render(
    <AntApp>
      <Harness taskId="t1" attachments={[]} {...props} />
    </AntApp>,
  );

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * 判据：`dataTransfer.types` 含 `'Files'` 才是文件，含 `'text/plain'` 是卡片
 * 拖拽（TaskGrid 的格子拖放、TodayView 的排序、CalendarGrid 的改期统一用
 * `setData('text/plain', taskId)`）——两种各要一条断言，别让文件拖放把卡片
 * 拖走，见 task-3-brief 最要紧那条。
 */
describe('拖放区：跟卡片拖拽不打架', () => {
  it('拖一个文件进来触发上传', async () => {
    uploadMock.mockResolvedValue({});
    renderIt();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith('t1', file));
  });

  // 上限断言：诱饵——这个 dataTransfer 标着 'text/plain'（卡片拖拽的判据），
  // 但里面塞了一个真的 File（真实的卡片拖拽不会有，e.dataTransfer.files 天然
  // 是空 FileList）。如果 isFileDrag 那道判断被删掉，代码会读到这个诱饵文件、
  // 照样发起上传——这条断言才不会因为「反正也没有文件」而变成自动通过，跟
  // Task 1/2 报告里「诱饵文件」的手法是同一个道理。
  it('拖一张卡片进来（text/plain）什么都不做，不会被当成文件', () => {
    renderIt();
    const bait = new File(['x'], 'bait.txt');
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    fireEvent.drop(box, { dataTransfer: { types: ['text/plain'], files: [bait] } });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('dragover：文件拖拽会 preventDefault（允许放置）并高亮', () => {
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;

    // fireEvent 返回 dispatchEvent 的结果：事件没被取消（没调用 preventDefault）
    // 时是 true——跟 CalendarGrid.test.tsx/TaskGrid.test.tsx 同一个读法。
    const fileNotCanceled = fireEvent.dragOver(box, { dataTransfer: { types: ['Files'] } });
    expect(fileNotCanceled).toBe(false);
    expect(box.className).toContain('ink-attach-box-over');
  });

  // m1（final-review.md，假绿）：上面那条测试先发了一次文件 dragover，把
  // over 置成了 true；旧版本这条测试紧接着复用同一份渲染再发一次卡片
  // dragover 查 class，那时候 class 已经因为上一条断言而必然含 -over，
  // 「删掉 setOver(true) 之前的判断」这种变异测不出来。这里单开一份新渲染，
  // 只发一次卡片 dragover，断言高亮真的没有被误点亮——这道判断不只是防
  // 误传，也是防误导（isFileDrag 上面的注释）。
  it('dragover：卡片拖拽经过不会 preventDefault、也不会误亮高亮（防误导）', () => {
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    const cardNotCanceled = fireEvent.dragOver(box, { dataTransfer: { types: ['text/plain'] } });
    expect(cardNotCanceled).toBe(true);
    expect(box.className).not.toContain('ink-attach-box-over');
  });

  // I5（final-review.md）：拖多个文件进来，最早的版本静默只传第一个——用户选
  // 三个拖进来，一个出现，两个人间蒸发，界面全程绿色。后来改成传第一个 + 说
  // 一声忽略了几个；现在三个都传，**排队逐个**（并发会让同一条任务的
  // attachments 互相覆盖，见 C1 和 useFileDrop 里 upload 上面那段）。
  it('拖三个文件进来：三个都传，按拖进来的顺序', async () => {
    uploadMock.mockResolvedValue({});
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => new File([n], n));
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files } });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(3));
    expect(uploadMock.mock.calls.map((c) => (c[1] as File).name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('**排队，不并发**：第一个还没回来之前，第二个一个请求都不发', async () => {
    let finishFirst!: () => void;
    uploadMock.mockImplementationOnce(() => new Promise<void>((res) => { finishFirst = res; }));
    uploadMock.mockResolvedValue({});
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    fireEvent.drop(box, {
      dataTransfer: { types: ['Files'], files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
    });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    // 服务端那条路由是「读全部任务 → 改这一条 → 整份写回」，没有写锁：这时候
    // 要是第二个已经在飞，两次写会互相覆盖，先回来的那个附件直接消失。
    expect(uploadMock).toHaveBeenCalledTimes(1);
    await act(async () => { finishFirst(); });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
  });

  it('中间一个失败不挡后面的，最后说清是哪个没成——中断的话后面几个好文件也一起没了，而他只看到一句错误', async () => {
    uploadMock.mockResolvedValueOnce({});
    uploadMock.mockRejectedValueOnce(new Error('附件不能超过 25MB'));
    uploadMock.mockResolvedValueOnce({});
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    const files = ['a.txt', 'big.bin', 'c.txt'].map((n) => new File([n], n));
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files } });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/big\.bin（附件不能超过 25MB）/)).toBeTruthy();
  });
});

describe('上传反馈', () => {
  it('上传中显示「上传中…」，文件选择框被禁用；写完（SSE 回来之前）解禁', async () => {
    let resolveUpload!: () => void;
    uploadMock.mockReturnValue(new Promise<void>((res) => { resolveUpload = res; }));
    renderIt();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'a.txt');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('上传中…')).toBeDefined());
    expect(input.disabled).toBe(true);

    resolveUpload();
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.getByText('拖文件到这里，或点击选择')).toBeDefined();
  });

  it('413：失败要说清具体原因，不是笼统的「上传失败」', async () => {
    uploadMock.mockRejectedValue(new Error('附件不能超过 25MB'));
    renderIt();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'big.bin')] } });
    // 带上文件名：一次传一批的时候，光有原因分不出是哪个没成。
    expect(await screen.findByText(/big\.bin（附件不能超过 25MB）/)).toBeTruthy();
  });

  it('上传中忽略新的拖放——不会同时打两个上传请求', async () => {
    let resolveUpload!: () => void;
    uploadMock.mockReturnValue(new Promise<void>((res) => { resolveUpload = res; }));
    renderIt();
    const box = document.querySelector('.ink-attach-box') as HTMLElement;
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.txt')] } });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [new File(['y'], 'b.txt')] } });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    resolveUpload();
  });
});

describe('附件列表：文件名 + 打开 + 删除，删除要确认', () => {
  it('attachments 为空时不渲染列表——只有拖放区', () => {
    renderIt({ attachments: [] });
    expect(document.querySelector('.ink-attach-list')).toBeNull();
  });

  it('渲染文件名和「打开」链接，href 是 api.attachmentUrl 给的下载地址', () => {
    renderIt({ attachments: ['报告.pdf'] });
    expect(screen.getByText('报告.pdf')).toBeDefined();
    const open = screen.getByRole('link', { name: '打开' }) as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe('/api/tasks/t1/attachments/%E6%8A%A5%E5%91%8A.pdf');
  });

  // task-3-brief：离线时附件的下载地址（api.attachmentUrl）指向服务端文件
  // 系统，点了是死链接——「打开」要换成一句不可点的提示，而不是留一个点了
  // 报错的假链接。文件名/删除按钮照常显示（用户仍然知道这条任务有哪些
  // 附件），只有「打开」这一个元素换掉。
  it('离线时「打开」换成提示文字，不是一个点了报错的死链接', () => {
    renderIt({ attachments: ['报告.pdf'], offline: true });
    expect(screen.queryByRole('link', { name: '打开' })).toBeNull();
    expect(screen.getByText('要连上服务才能看')).toBeTruthy();
    // 文件名和删除按钮不受影响——离线不等于「这条附件不存在了」。
    expect(screen.getByText('报告.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  // 上限断言：连得上时（offline 默认 false，上面几条既有测试全部用的这个
  // 默认值）依然是可点的下载链接，不会被离线提示误顶掉。
  it('上限断言：连得上时（offline=false）还是可点的下载链接，不是离线提示', () => {
    renderIt({ attachments: ['报告.pdf'], offline: false });
    expect(screen.getByRole('link', { name: '打开' })).toBeTruthy();
    expect(screen.queryByText('要连上服务才能看')).toBeNull();
  });

  it('点删除不会立刻删——先弹确认框，取消什么都不发生', async () => {
    renderIt({ attachments: ['报告.pdf'] });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await confirmDialog();
    expect(deleteMock).not.toHaveBeenCalled();

    fireEvent.click(btnIn(dialog, '取消'));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('确认之后才真的调 deleteAttachment(taskId, name)', async () => {
    deleteMock.mockResolvedValue({ ok: true });
    renderIt({ attachments: ['报告.pdf'] });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(btnIn(await confirmDialog(), '删除'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('t1', '报告.pdf'));
  });

  it('删除失败说清具体原因', async () => {
    deleteMock.mockRejectedValue(new Error('没有这个附件'));
    renderIt({ attachments: ['报告.pdf'] });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(btnIn(await confirmDialog(), '删除'));
    expect(await screen.findByText('没有这个附件')).toBeTruthy();
  });
});

/**
 * 图片缩略图 + 粘贴上传。**截图是待办应用里最常见的附件**，而在这之前
 * 唯一的路是「先存成文件、再拖进来或者点选」，看一眼也得点开链接。
 */
describe('Attachments：图片', () => {
  it('图片直接画出来，alt 是文件名', () => {
    renderIt({ attachments: ['屏幕截图.png'] });
    const img = screen.getByAltText('屏幕截图.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('%E5%B1%8F');
    // 一条挂着二十张截图的任务不该在渲染那一刻同时发二十个请求。
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('**文件名照旧留着**——缩略图加载不出来时那一行还认得出是什么，不是只剩一个碎图标', () => {
    renderIt({ attachments: ['屏幕截图.png'] });
    expect(screen.getByText('屏幕截图.png')).toBeTruthy();
  });

  it('不是图片的不画', () => {
    renderIt({ attachments: ['合同.pdf'] });
    expect(screen.queryByAltText('合同.pdf')).toBeNull();
  });

  it('离线时不画——attachmentUrl 那会儿是个死链接，右边那句提示已经说了这件事', () => {
    renderIt({ attachments: ['屏幕截图.png'], offline: true });
    expect(screen.queryByAltText('屏幕截图.png')).toBeNull();
    expect(screen.getByText('要连上服务才能看')).toBeTruthy();
  });
});

describe('Attachments：粘贴上传', () => {
  // jsdom 没有 DataTransfer，跟上面拖放那几条一样用字面量顶——处理器只读
  // `clipboardData.files`，够了。
  const paste = (files: File[]) => {
    const box = document.querySelector('.ink-attach-box')!.parentElement!;
    fireEvent.paste(box, { clipboardData: { files } });
  };
  const png = (name = 'image.png') => new File(['x'], name, { type: 'image/png' });

  it('贴一张图就上传，名字带时间戳——剪贴板里的截图通常没有名字，十张都叫 image.png 会互相覆盖', async () => {
    renderIt();
    paste([png()]);
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalled());
    const sent = vi.mocked(api.uploadAttachment).mock.calls[0][1] as File;
    expect(sent.name).toMatch(/^粘贴-\d{8}-\d{6}\.png$/);
  });

  it('**剪贴板里是文件（不是图片）时不管**——在输入框里 Ctrl+V 的正常语义是粘贴文字', async () => {
    renderIt();
    paste([new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  it('剪贴板里什么文件都没有（纯文字）时不拦——粘文字那条路一个字都不能挡', () => {
    renderIt();
    const box = document.querySelector('.ink-attach-box')!.parentElement!;
    // fireEvent 返回「没有被 preventDefault」——纯文字那次必须是 true。
    expect(fireEvent.paste(box, { clipboardData: { files: [] } })).toBe(true);
  });

  it('贴多张全传，**名字各带各的序号**——时间戳只到秒，同一次粘贴的几张不加序号会全撞在一起', async () => {
    renderIt();
    paste([png('a.png'), png('b.png')]);
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
    const names = (api.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as File).name);
    expect(names[0]).toMatch(/^粘贴-\d{8}-\d{6}\.png$/);
    expect(names[1]).toMatch(/^粘贴-\d{8}-\d{6}-2\.png$/);
  });
});
