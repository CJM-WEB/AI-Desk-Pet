import {
  SHARED_PET_PAGE_SIZE,
  type SharedPetDraftInput,
  type SharedPetErrorCode,
  type SharedPetPage,
  type SharedPetPageTransition,
  type SharedPetValidationResult
} from './shared-pet-types';

export { SHARED_PET_PAGE_SIZE } from './shared-pet-types';
export type {
  CreateSharedPetInput,
  SharedPetDownload,
  SharedPetDraftInput,
  SharedPetErrorCode,
  SharedPetPackageSummary,
  SharedPetPage,
  SharedPetPageTransition,
  SharedPetPageTransitionStatus,
  SharedPetRepository,
  SharedPetValidationResult
} from './shared-pet-types';

export const MAX_SHARED_PET_PACKAGE_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_SHARED_PET_COVER_SIZE_BYTES = 5 * 1024 * 1024;

const ZIP_MIME_TYPES = new Set([
  '',
  'application/zip',
  'application/x-compressed',
  'application/x-zip-compressed',
  'multipart/x-zip'
]);

const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot < 0 ? '' : fileName.slice(lastDot + 1).toLowerCase();
}

function isFileLike(value: unknown): value is File {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const file = value as Partial<File>;
  return typeof file.name === 'string'
    && typeof file.size === 'number'
    && typeof file.type === 'string';
}

function hasValidFileSize(size: number): boolean {
  return Number.isFinite(size) && size >= 0;
}

function invalid(code: SharedPetErrorCode): SharedPetValidationResult {
  return { valid: false, code };
}

/** 以统一的字段顺序校验投稿，成功结果只返回清理过的文本和原始文件。 */
export function validateSharedPetDraft(
  input: SharedPetDraftInput
): SharedPetValidationResult {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string'
    ? input.description.trim()
    : '';
  const packageFile = input.packageFile;
  const coverFile = input.coverFile;

  if (!isFileLike(packageFile)) {
    return invalid('PACKAGE_REQUIRED');
  }

  const packageExtension = getExtension(packageFile.name);
  if (packageExtension !== 'zip' || !ZIP_MIME_TYPES.has(packageFile.type.toLowerCase())) {
    return invalid('PACKAGE_TYPE_INVALID');
  }
  if (!hasValidFileSize(packageFile.size)
    || packageFile.size > MAX_SHARED_PET_PACKAGE_SIZE_BYTES) {
    return invalid('PACKAGE_TOO_LARGE');
  }

  if (!isFileLike(coverFile)) {
    return invalid('COVER_REQUIRED');
  }

  const coverExtension = getExtension(coverFile.name);
  const expectedCoverMime = COVER_MIME_BY_EXTENSION[coverExtension];
  if (!expectedCoverMime || coverFile.type.toLowerCase() !== expectedCoverMime) {
    return invalid('COVER_TYPE_INVALID');
  }
  if (!hasValidFileSize(coverFile.size)
    || coverFile.size > MAX_SHARED_PET_COVER_SIZE_BYTES) {
    return invalid('COVER_TOO_LARGE');
  }

  if (name.length === 0) {
    return invalid('NAME_REQUIRED');
  }
  if (name.length > 30) {
    return invalid('NAME_TOO_LONG');
  }
  if (description.length === 0) {
    return invalid('DESCRIPTION_REQUIRED');
  }
  if (description.length > 500) {
    return invalid('DESCRIPTION_TOO_LONG');
  }

  return {
    valid: true,
    value: {
      name,
      description,
      packageFile,
      coverFile
    }
  };
}

/** 开始切页时只记录目标页，当前可见页必须继续保留到离场结束。 */
export function beginPageTransition(
  visiblePage: SharedPetPage,
  pendingPage: SharedPetPage
): Extract<SharedPetPageTransition, { status: 'leaving' }> {
  return {
    status: 'leaving',
    visiblePage,
    pendingPage
  };
}

/** 离场完成后才允许把待切换页提升为可见页。 */
export function completePageLeaving(
  transition: Extract<SharedPetPageTransition, { status: 'leaving' }>
): Extract<SharedPetPageTransition, { status: 'entering' }> {
  return {
    status: 'entering',
    visiblePage: transition.pendingPage
  };
}

/** 进入动画完成后清除过渡状态，但继续保留当前可见页。 */
export function completePageEntering(
  transition: Extract<SharedPetPageTransition, { status: 'entering' }>
): Extract<SharedPetPageTransition, { status: 'idle' }> {
  return {
    status: 'idle',
    visiblePage: transition.visiblePage
  };
}

/** 生成稳定的槽位序号，保证动画顺序与网格阅读顺序一致。 */
export function buildPageTransitionOrder(itemCount: number): number[] {
  const count = Number.isFinite(itemCount)
    ? Math.max(0, Math.floor(itemCount))
    : 0;
  return Array.from({ length: count }, (_, index) => index);
}
