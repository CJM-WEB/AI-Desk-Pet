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
  coverFileName: string;
  coverMimeType: string;
  coverSizeBytes: number;
  coverFile: Blob;
  likeCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
  likedByCurrentUser: boolean;
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
}

export interface SharedPetDownload {
  file: Blob;
  fileName: string;
  mimeType: string;
}

export interface SharedPetRepository {
  listPage(
    page: number,
    pageSize?: typeof SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage>;
  create(input: CreateSharedPetInput): Promise<SharedPetPackageSummary>;
  getById(id: string): Promise<SharedPetPackageSummary | null>;
  toggleLike(id: string): Promise<SharedPetPackageSummary>;
  getDownload(id: string): Promise<SharedPetDownload>;
  recordDownload(id: string): Promise<SharedPetPackageSummary>;
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
