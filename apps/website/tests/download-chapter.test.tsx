import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

describe('下载安装章节', () => {
  it('渲染配置平台、真实下载和两侧信息', () => {
    const html = renderToStaticMarkup(<DownloadChapter interactive />);

    expect(html).toContain('data-testid="download-chapter"');
    expect(html).toContain('Windows');
    expect(html).toContain('macOS');
    expect(html).toContain('即将支持');
    expect(html).toContain('.exe');
    expect(html).toContain('常见问题');
    expect(html).toContain('安装前须知');
    expect(html).toContain('data-input-scope="local"');
  });
});
