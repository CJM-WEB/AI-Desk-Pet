import {
  FileText,
  FolderOpen,
  LayoutDashboard,
  MessageCircle,
  ShieldCheck
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AboutFeatureId =
  | 'security'
  | 'file-management'
  | 'text-editor'
  | 'companion-chat'
  | 'desktop-organizer';

export type AboutIllustrationKind = AboutFeatureId;

export interface AboutFeature {
  id: AboutFeatureId;
  title: string;
  eyebrow: string;
  summary: string;
  details: readonly string[];
  layer: number;
  entryOrder: number;
  icon: LucideIcon;
  illustration: AboutIllustrationKind;
}

// 介绍面板的内容与进入顺序集中在此处，视觉组件只消费配置。
export const ABOUT_FEATURES = [
  {
    id: 'security',
    title: '保障系统安全',
    eyebrow: 'PRIVATE BY DESIGN',
    summary: '明确权限边界，让每一次操作都保持可控。',
    details: ['按授权范围访问内容', '关键操作保留可见反馈', '本地数据由你掌握'],
    layer: 10,
    entryOrder: 1,
    icon: ShieldCheck,
    illustration: 'security'
  },
  {
    id: 'file-management',
    title: '文件夹管理',
    eyebrow: 'KEEP IT IN ORDER',
    summary: '在熟悉的目录结构中整理任务与灵感。',
    details: ['快速识别常用位置', '清晰呈现文件关系', '减少重复查找'],
    layer: 20,
    entryOrder: 2,
    icon: FolderOpen,
    illustration: 'file-management'
  },
  {
    id: 'text-editor',
    title: '文本编辑',
    eyebrow: 'WRITE WITHOUT FRICTION',
    summary: '把零散想法留在轻量、专注的编辑空间。',
    details: ['保留简洁的书写界面', '聚焦当前内容', '随时继续未完成的记录'],
    layer: 30,
    entryOrder: 3,
    icon: FileText,
    illustration: 'text-editor'
  },
  {
    id: 'companion-chat',
    title: '聊天陪伴',
    eyebrow: 'ALWAYS READY TO LISTEN',
    summary: '在需要回应的时候，给你自然的交流入口。',
    details: ['用对话整理思路', '提供连续的陪伴感', '让提问与回应保持轻松'],
    layer: 40,
    entryOrder: 4,
    icon: MessageCircle,
    illustration: 'companion-chat'
  },
  {
    id: 'desktop-organizer',
    title: '桌面整理',
    eyebrow: 'MAKE SPACE TO FOCUS',
    summary: '让桌面状态更清晰，把注意力留给重要的事。',
    details: ['聚合常用内容入口', '减少视觉干扰', '维持清爽的工作节奏'],
    layer: 50,
    entryOrder: 5,
    icon: LayoutDashboard,
    illustration: 'desktop-organizer'
  }
] as const satisfies readonly AboutFeature[];
