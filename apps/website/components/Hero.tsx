import { HeroPetDemo } from './HeroPetDemo';

export function Hero() {
  return (
    <section id="hero" className="hero">
      <div className="hero-copy-block">
        <p className="eyebrow">Windows Alpha · 自带模型密钥</p>
        <h1>住在桌面上的 AI 文件小助手</h1>
        <p className="hero-copy">授权一个文件夹，用自然语言安全地查看、新建和重命名文件。</p>
        <div className="hero-actions">
          <a className="primary" href="#download">
            下载 Windows 测试版
          </a>
          <a className="secondary" href="#safety">
            查看安全边界
          </a>
        </div>
      </div>
      <HeroPetDemo />
    </section>
  );
}
