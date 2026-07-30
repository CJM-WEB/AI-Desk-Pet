const links = [
  ['#features', '能力'],
  ['#safety', '安全'],
  ['#download', '下载'],
  ['#install', '安装'],
  ['#faq', '问题']
];

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="#hero" aria-label="AI Pet 首页">
        <span className="brand-mark" aria-hidden="true" />
        <span>AI Pet</span>
      </a>
      <nav className="site-nav" aria-label="官网导航">
        {links.map(([href, label]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <a className="header-action" href="#download">
        下载 Windows 测试版
      </a>
    </header>
  );
}
