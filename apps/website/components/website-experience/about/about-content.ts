import {
  FileText,
  FolderOpen,
  LayoutDashboard,
  MessageCircle,
  ShieldCheck
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { zhCN } from '../../i18n/messages';
import type { Translate } from '../../i18n/i18n-types';

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

/** 仅将文案交给翻译函数，图标、层级和进场顺序保持固定。 */
export function createAboutFeatures(t: Translate): readonly AboutFeature[] {
  return [
    {
      id: 'security',
      title: t('about.security.title'),
      eyebrow: t('about.security.eyebrow'),
      summary: t('about.security.summary'),
      details: [
        t('about.security.detail.0'),
        t('about.security.detail.1'),
        t('about.security.detail.2')
      ],
      layer: 10,
      entryOrder: 1,
      icon: ShieldCheck,
      illustration: 'security'
    },
    {
      id: 'file-management',
      title: t('about.fileManagement.title'),
      eyebrow: t('about.fileManagement.eyebrow'),
      summary: t('about.fileManagement.summary'),
      details: [
        t('about.fileManagement.detail.0'),
        t('about.fileManagement.detail.1'),
        t('about.fileManagement.detail.2')
      ],
      layer: 20,
      entryOrder: 2,
      icon: FolderOpen,
      illustration: 'file-management'
    },
    {
      id: 'text-editor',
      title: t('about.textEditor.title'),
      eyebrow: t('about.textEditor.eyebrow'),
      summary: t('about.textEditor.summary'),
      details: [
        t('about.textEditor.detail.0'),
        t('about.textEditor.detail.1'),
        t('about.textEditor.detail.2')
      ],
      layer: 30,
      entryOrder: 3,
      icon: FileText,
      illustration: 'text-editor'
    },
    {
      id: 'companion-chat',
      title: t('about.companionChat.title'),
      eyebrow: t('about.companionChat.eyebrow'),
      summary: t('about.companionChat.summary'),
      details: [
        t('about.companionChat.detail.0'),
        t('about.companionChat.detail.1'),
        t('about.companionChat.detail.2')
      ],
      layer: 40,
      entryOrder: 4,
      icon: MessageCircle,
      illustration: 'companion-chat'
    },
    {
      id: 'desktop-organizer',
      title: t('about.desktopOrganizer.title'),
      eyebrow: t('about.desktopOrganizer.eyebrow'),
      summary: t('about.desktopOrganizer.summary'),
      details: [
        t('about.desktopOrganizer.detail.0'),
        t('about.desktopOrganizer.detail.1'),
        t('about.desktopOrganizer.detail.2')
      ],
      layer: 50,
      entryOrder: 5,
      icon: LayoutDashboard,
      illustration: 'desktop-organizer'
    }
  ];
}

// 兼容现有数据模型测试；界面渲染使用 createAboutFeatures(t)。
export const ABOUT_FEATURES = createAboutFeatures((key) => zhCN[key]);
