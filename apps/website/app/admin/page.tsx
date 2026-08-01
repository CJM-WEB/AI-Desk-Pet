import type { Metadata } from 'next';

import { AdminApp } from '../../components/admin/AdminApp';

export const metadata: Metadata = {
  title: 'AI Pet 管理员模式',
  robots: { index: false, follow: false }
};

export default function AdminPage() {
  return <AdminApp />;
}
