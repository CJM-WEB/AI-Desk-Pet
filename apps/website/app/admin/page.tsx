import type { Metadata } from 'next';

import { AdminApp } from '../../components/admin/AdminApp';
import { I18nProvider } from '../../components/i18n/I18nProvider';

export const metadata: Metadata = {
  title: 'AI Pet 管理员模式',
  robots: { index: false, follow: false }
};

export default function AdminPage() {
  return <I18nProvider><AdminApp /></I18nProvider>;
}
