import rawManifest from '../../../content/release-manifest.json';
import { releaseManifestSchema } from '../../../lib/release-manifest';
import { zhCN } from '../../i18n/messages';
import type { Translate } from '../../i18n/i18n-types';

export type DownloadPlatform =
  | {
      id: string;
      name: string;
      status: 'available';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
      downloadUrl: string;
      fileName: string;
      sizeBytes: number;
      sha256: string;
    }
  | {
      id: string;
      name: string;
      status: 'coming-soon';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
    }
  | {
      id: string;
      name: string;
      status: 'unpublished';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
      fileName: string;
      plannedReleaseTag: string;
    };

export type FaqItem = {
  question: string;
  answer: string;
};

export type InstallNoticeItem = {
  title: string;
  body: string;
};

// 发行清单是 Windows 下载数据的唯一来源，避免页面配置与实际构建产物分叉。
const windowsRelease = releaseManifestSchema.parse(rawManifest);

/** 根据发行清单生成 Windows 平台，未发布版本不会暴露下载地址。 */
function createWindowsPlatform(t: Translate): DownloadPlatform {
  return windowsRelease.status === 'published'
  ? {
      id: 'windows-x64',
      name: 'Windows',
      status: 'available',
      summary: t('download.windows.summary'),
      versionLabel: windowsRelease.version,
      systemRequirements: 'Windows 10/11 x64',
      downloadUrl: windowsRelease.downloadUrl,
      fileName: windowsRelease.fileName,
      sizeBytes: windowsRelease.sizeBytes,
      sha256: windowsRelease.sha256
    }
  : {
      id: 'windows-x64',
      name: 'Windows',
      status: 'unpublished',
      summary: t('download.windows.unpublishedSummary'),
      versionLabel: windowsRelease.version,
      systemRequirements: 'Windows 10/11 x64',
      fileName: windowsRelease.fileName,
      plannedReleaseTag: windowsRelease.plannedReleaseTag
    };
}
export interface DownloadContent {
  platforms: readonly DownloadPlatform[];
  faqItems: readonly FaqItem[];
  installNoticeItems: readonly InstallNoticeItem[];
}
/** 文案由翻译函数生成，发行清单中的版本、文件与下载地址保持原值。 */
export function createDownloadContent(t: Translate): DownloadContent {
  return {
    platforms: [
      createWindowsPlatform(t),
      {
        id: 'macos',
        name: 'macOS',
        status: 'coming-soon',
        summary: t('download.macos.summary'),
        versionLabel: t('download.macos.version'),
        systemRequirements: t('download.macos.requirements')
      }
    ],
    faqItems: [0, 1, 2, 3].map((index) => ({
      question: t(`download.faq.${index}.question` as keyof typeof zhCN),
      answer: t(`download.faq.${index}.answer` as keyof typeof zhCN)
    })),
    installNoticeItems: [0, 1].map((index) => ({
      title: t(`download.notice.${index}.title` as keyof typeof zhCN),
      body: t(`download.notice.${index}.body` as keyof typeof zhCN)
    }))
  };
}

// 兼容现有数据模型测试；界面渲染使用 createDownloadContent(t)。
const zhTranslate: Translate = (key) => zhCN[key];
const zhContent = createDownloadContent(zhTranslate);
export const DOWNLOAD_PLATFORMS = zhContent.platforms;
export const FAQ_ITEMS = zhContent.faqItems;
export const INSTALL_NOTICE_ITEMS = zhContent.installNoticeItems;
