import rawManifest from '../../../content/release-manifest.json';
import { releaseManifestSchema } from '../../../lib/release-manifest';

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
      sha256: string;
    }
  | {
      id: string;
      name: string;
      status: 'coming-soon';
      summary: string;
      versionLabel: string;
      systemRequirements: string;
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

export const DOWNLOAD_PLATFORMS: DownloadPlatform[] = [
  {
    id: 'windows-x64',
    name: 'Windows',
    status: 'available',
    summary: 'Windows 10/11 x64 测试版',
    versionLabel: windowsRelease.version,
    systemRequirements: 'Windows 10/11 x64',
    downloadUrl: windowsRelease.downloadUrl,
    fileName: windowsRelease.fileName,
    sha256: windowsRelease.sha256
  },
  {
    id: 'macos',
    name: 'macOS',
    status: 'coming-soon',
    summary: 'macOS 版本正在准备中',
    versionLabel: '即将支持',
    systemRequirements: 'macOS 版本尚未发布'
  }
];

// 复用官网现有 FAQ 文案，供下载体验中的帮助面板直接消费。
export const FAQ_ITEMS: FaqItem[] = [
  {
    question: '支持哪些系统？',
    answer: '第一阶段目标是 Windows 10/11 x64。'
  },
  {
    question: 'API Key 归谁管理？',
    answer: 'API Key 来自你选择的兼容模型服务，本地客户端只保存加密后的密钥。'
  },
  {
    question: '它能访问所有文件吗？',
    answer: '不能。它只处理你授权目录内的相对路径，不会越过授权目录。'
  },
  {
    question: '第一阶段不能做什么？',
    answer: '不支持 Shell、删除、复制、移动、后台自动任务、账号同步或正式自动更新。'
  }
];

// 复用官网现有安装说明，保持下载入口与安装帮助的文案一致。
export const INSTALL_NOTICE_ITEMS: InstallNoticeItem[] = [
  {
    title: '未签名测试版',
    body: '当前安装包是未签名测试版，Windows 可能显示未知发布者提示。安装前请核对文件名和 SHA-256。'
  },
  {
    title: '邀请制 Alpha',
    body: '第一阶段面向少量测试者，建议只使用专用测试目录，不要授权系统目录或重要资料目录。'
  }
];
