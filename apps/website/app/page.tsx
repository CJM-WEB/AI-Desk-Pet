import { Faq } from '../components/Faq';
import { FeatureGrid } from '../components/FeatureGrid';
import { DownloadCard } from '../components/DownloadCard';
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
        <DownloadCard />
        <InstallHelp />
        <Faq />
      </main>
      <SiteFooter />
    </>
  );
}
