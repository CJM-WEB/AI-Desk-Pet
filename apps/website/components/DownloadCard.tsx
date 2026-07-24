import rawManifest from '../content/release-manifest.json';
import { formatReleaseSize, releaseManifestSchema } from '../lib/release-manifest';

export function DownloadCard() {
  const release = releaseManifestSchema.parse(rawManifest);
  const size = formatReleaseSize(release.sizeBytes);

  return (
    <section id="download" className="download" aria-label="Windows 下载">
      <div className="download-copy">
        <p className="section-kicker">版本信息</p>
        <h2>Windows 测试版</h2>
        <p>
          {release.version} · Windows 10/11 x64 · {size}
        </p>
        <p className="warning">未签名测试版；安装前请核对文件名和 SHA-256。</p>
      </div>
      <div className="download-card">
        <dl>
          <div>
            <dt>文件名</dt>
            <dd>{release.fileName}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>
              <code>{release.sha256}</code>
            </dd>
          </div>
        </dl>
        <a className="primary" href={release.downloadUrl}>
          下载 Myself {release.version}
        </a>
      </div>
    </section>
  );
}
