import { Faq } from '../components/Faq';
import { FeatureGrid } from '../components/FeatureGrid';
import { Hero } from '../components/Hero';
import { HowItWorks } from '../components/HowItWorks';
import { InstallHelp } from '../components/InstallHelp';
import { SafetySection } from '../components/SafetySection';
import { SiteFooter } from '../components/SiteFooter';
import { SiteHeader } from '../components/SiteHeader';

export default function Page() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <FeatureGrid />
        <HowItWorks />
        <SafetySection />
        <section id="download" className="download" aria-label="Windows 下载">
          <p className="section-kicker">版本信息</p>
          <h2>Windows 测试版</h2>
          <p>下载卡片将在版本清单接入后显示安装包大小、SHA-256 和正式下载链接。</p>
        </section>
        <InstallHelp />
        <Faq />
      </main>
      <SiteFooter />
    </>
  );
}
