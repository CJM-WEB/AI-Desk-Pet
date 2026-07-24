import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Myself - AI 桌宠文件助手',
  description: '在授权目录中安全完成基础文件任务的 Windows AI 桌宠。'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
