export function InstallHelp() {
  return (
    <section id="install" className="section-block install-help">
      <p className="section-kicker">安装说明</p>
      <h2>安装帮助</h2>
      <div className="help-grid">
        <article>
          <h3>未签名测试版</h3>
          <p>当前安装包是未签名测试版，Windows 可能显示未知发布者提示。安装前请核对文件名和 SHA-256。</p>
        </article>
        <article>
          <h3>邀请制 Alpha</h3>
          <p>第一阶段面向少量测试者，建议只使用专用测试目录，不要授权系统目录或重要资料目录。</p>
        </article>
      </div>
    </section>
  );
}
