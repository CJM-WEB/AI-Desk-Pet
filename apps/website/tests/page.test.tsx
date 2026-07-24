import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';
import rawManifest from '../content/release-manifest.json';
import { formatReleaseSize, releaseManifestSchema } from '../lib/release-manifest';

describe('官网首页', () => {
  it('展示产品承诺与主要下载入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('住在桌面上的 AI 文件小助手');
    expect(html).toContain('下载 Windows 测试版');
  });

  it('展示完整的信任、能力和支持区块', () => {
    const html = renderToStaticMarkup(<Page />);

    for (const text of ['它能做什么', '三步开始使用', '文件安全由本地控制', '安装帮助', '常见问题']) {
      expect(html).toContain(text);
    }
  });

  it('保留稳定锚点和可替换的 Hero 演示入口', () => {
    const html = renderToStaticMarkup(<Page />);

    for (const anchor of ['href="#features"', 'href="#safety"', 'href="#download"', 'href="#install"', 'href="#faq"']) {
      expect(html).toContain(anchor);
    }
    expect(html).toContain('aria-label="桌宠确认文件操作演示"');
  });

  it('明确展示本地安全边界和第一阶段限制', () => {
    const html = renderToStaticMarkup(<Page />);

    for (const text of ['模型不能运行 Shell', '写操作必须确认', '不会越过授权目录', '未签名测试版']) {
      expect(html).toContain(text);
    }
  });

  it('从版本清单展示下载元数据', () => {
    const html = renderToStaticMarkup(<Page />);
    const release = releaseManifestSchema.parse(rawManifest);

    for (const text of [
      release.version,
      'Windows 10/11 x64',
      formatReleaseSize(release.sizeBytes),
      release.sha256
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain(`href="${release.downloadUrl}"`);
    expect(html).not.toContain('下载卡片将在版本清单接入后显示');
  });
});
