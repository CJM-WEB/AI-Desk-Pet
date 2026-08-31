import rawManifest from '../content/release-manifest.json';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import { formatReleaseSize } from '../lib/release-manifest';

export function DownloadCard() {
  const release = releaseManifestSchema.parse(rawManifest);

  return (
    <section id="download" className="download" aria-label="Windows 下载">
      <div className="download-copy">
        <p className="section-kicker">版本信息</p>
        <h2>Windows 测试版</h2>
        <p>
          {release.version} · Windows 10/11 x64
        </p>
        <p className="warning">
          {release.status === 'published'
            ? '未签名测试版；安装前请核对文件名和 SHA-256。'
            : '当前版本尚未发布；计划资产生成并上传后才会提供下载。'}
        </p>
      </div>
      <div className="download-card">
        <dl>
          <div>
            <dt>文件名</dt>
            <dd>{release.fileName}</dd>
          </div>
          {release.status === 'published' ? (
            <>
              <div>
                <dt>大小</dt>
                <dd>{formatReleaseSize(release.sizeBytes)}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>
                  <code>{release.sha256}</code>
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        {release.status === 'published' ? (
          <a className="primary" href={release.downloadUrl}>
            下载 AI Pet {release.version}
          </a>
        ) : (
          <span role="status">AI Pet {release.version} 尚未发布</span>
        )}
      </div>
    </section>
  );
}
