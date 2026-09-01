/**
 * 官方下载统计是链接导航的旁路：任何异常均在此处吞没，绝不改变安装包的原生跳转。
 */
export function recordOfficialDownloadClick(): void {
  try {
    void fetch('/api/v1/official-downloads/windows/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
      credentials: 'omit'
    }).catch(() => undefined);
  } catch {
    // 浏览器同步拒绝 keepalive 请求时，仍保留原始安装包链接的默认行为。
  }
}
