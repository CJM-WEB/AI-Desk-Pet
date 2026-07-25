import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Pet',
  description: 'AI Pet 是一款面向桌面文件工作的 AI 助手。'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
