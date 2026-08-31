import type { PublicationBasis, SubmissionReceipt } from '@myself/shared-types';

/** 共享仓库列表固定使用八个展示槽位。 */
export const SHARED_PET_PAGE_SIZE = 8 as const;

export type SharedPetErrorCode =
  | 'INDEXED_DB_UNAVAILABLE'
  | 'DATABASE_OPEN_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'PACKAGE_REQUIRED'
  | 'PACKAGE_TYPE_INVALID'
  | 'PACKAGE_TOO_LARGE'
  | 'COVER_REQUIRED'
  | 'COVER_TYPE_INVALID'
  | 'COVER_TOO_LARGE'
  | 'NAME_REQUIRED'
  | 'NAME_TOO_LONG'
  | 'DESCRIPTION_REQUIRED'
  | 'DESCRIPTION_TOO_LONG'
  | 'PACKAGE_NOT_FOUND'
  | 'FILE_READ_FAILED'
  | 'DOWNLOAD_FAILED';

/** 列表摘要只包含展示所需的元数据，不包含 ZIP 文件。 */
export interface SharedPetPackageSummary {
  id: string;
  name: string;
  description: string;
  packageFileName: string;
  packageSizeBytes: number;
  /** 云端公开 DTO 不包含封面文件元数据，本地适配器才提供。 */
  coverFileName?: string;
  coverMimeType?: string;
  coverSizeBytes?: number;
  /** 本地测试适配器提供 Blob，云端记录只提供短期封面地址。 */
  coverFile?: Blob;
  coverUrl?: string;
  likeCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
  likedByCurrentUser: boolean;
  /** 本地历史适配器没有云端发布裁决，云端仓储会严格补齐。 */
  publicationBasis?: PublicationBasis;
}

export interface CreateSharedPetInput {
  name: string;
  description: string;
  packageFile: File;
  coverFile: File;
}

/** 表单校验阶段允许文件尚未选择，仓储创建阶段则要求完整文件。 */
export type SharedPetDraftInput = {
  name?: string | null;
  description?: string | null;
  packageFile?: File | null;
  coverFile?: File | null;
};

export interface SharedPetPage {
  items: readonly SharedPetPackageSummary[];
  page: number;
  pageSize: typeof SHARED_PET_PAGE_SIZE;
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** 公开游标 API 未返回总数时，不把下界伪装为精确页数。 */
  totalKnown?: boolean;
}

export interface SharedPetDownload {
  /** 云端仓库使用签名 URL；本地历史适配器仅用于旧测试。 */
  url?: string;
  fileName: string;
  expiresAt?: string;
  file?: Blob;
  mimeType?: string;
  publicationBasis?: PublicationBasis;
}

export interface SharedPetRepository {
  listPage(
    page: number,
    pageSize?: typeof SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage>;
  submit(
    input: CreateSharedPetInput,
    onProgress?: (percent: number) => void
  ): Promise<SubmissionReceipt>;
  /** 历史 IndexedDB 测试适配器保留的同步创建入口。 */
  create?(input: CreateSharedPetInput): Promise<SharedPetPackageSummary>;
  getById(id: string): Promise<SharedPetPackageSummary | null>;
  toggleLike(id: string): Promise<SharedPetPackageSummary>;
  getDownload(id: string): Promise<SharedPetDownload>;
  /** 历史 IndexedDB 测试适配器保留的下载计数入口。 */
  recordDownload?(id: string): Promise<SharedPetPackageSummary>;
  subscribe(listener: () => void): () => void;
}

export type SharedPetPageTransitionStatus = 'idle' | 'leaving' | 'entering';

/** 离场阶段保留旧页面，进入和稳定阶段禁止携带待切换页面。 */
export type SharedPetPageTransition =
  | {
    status: 'idle';
    visiblePage: SharedPetPage;
    pendingPage?: never;
  }
  | {
    status: 'leaving';
    visiblePage: SharedPetPage;
    pendingPage: SharedPetPage;
  }
  | {
    status: 'entering';
    visiblePage: SharedPetPage;
    pendingPage?: never;
  };

export type SharedPetValidationResult =
  | { valid: true; value: CreateSharedPetInput }
  | { valid: false; code: SharedPetErrorCode };
