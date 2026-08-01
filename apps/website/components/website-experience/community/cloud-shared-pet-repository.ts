import type { CaptchaProof, SubmissionReceipt } from '@myself/shared-types';
import { ApiClient } from '../../../lib/api-client';
import {
  SHARED_PET_PAGE_SIZE,
  type CreateSharedPetInput,
  type SharedPetDownload,
  type SharedPetPackageSummary,
  type SharedPetPage,
  type SharedPetRepository
} from './shared-pet-types';

interface PublicCommunityItem {
  id: string;
  name: string;
  description: string;
  cover: { url: string; expiresAt: string };
  packageFileName: string;
  packageSizeBytes: number;
  likeCount: number;
  downloadCount: number;
  publishedAt: string;
}

interface PublicCommunityPage {
  items: PublicCommunityItem[];
  nextCursor: number | null;
}

interface PreparedSubmission extends SubmissionReceipt {
  coverUpload: { url: string; expiresAt: string };
  packageUpload: { url: string; expiresAt: string };
}

export type SignedUpload = (
  url: string,
  file: File,
  contentType: string,
  onProgress: (loaded: number) => void
) => Promise<void>;

/** 公开共享仓库仅调用 HTTP API 与签名存储地址，绝不创建 CloudBase 用户身份。 */
export class CloudSharedPetRepository implements SharedPetRepository {
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, SharedPetPackageSummary>();

  constructor(
    private readonly api: ApiClient,
    private readonly upload: SignedUpload = uploadWithXhr
  ) {}

  async listPage(
    page: number,
    pageSize: typeof SHARED_PET_PAGE_SIZE = SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage> {
    const selectedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const cursor = (selectedPage - 1) * pageSize;
    const result = await this.api.request<PublicCommunityPage>(
      `/community?limit=${pageSize}&cursor=${cursor}`
    );
    const items = result.items.map(item => this.remember(item));
    const hasNext = result.nextCursor !== null;
    const total = cursor + items.length;
    return {
      items,
      page: selectedPage,
      pageSize,
      total,
      totalPages: hasNext ? selectedPage : Math.ceil(total / pageSize),
      hasPrevious: selectedPage > 1,
      hasNext,
      totalKnown: !hasNext
    };
  }

  /** 先取得服务端上传凭据，再按固定次序上传封面、ZIP 并确认完成。 */
  async submit(
    input: CreateSharedPetInput,
    captcha: CaptchaProof,
    onProgress?: (percent: number) => void
  ): Promise<SubmissionReceipt> {
    const prepared = await this.api.request<PreparedSubmission>('/submissions/prepare', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'shared_package',
        title: input.name,
        body: input.description,
        captcha,
        coverFile: fileDescriptor(input.coverFile, input.coverFile.type),
        packageFile: fileDescriptor(input.packageFile, 'application/zip')
      })
    });
    const totalBytes = input.coverFile.size + input.packageFile.size;
    let coverLoaded = 0;
    let packageLoaded = 0;
    let lastReportedPercent = -1;
    const reportProgress = () => {
      const percent = totalBytes > 0
        ? Math.floor(((coverLoaded + packageLoaded) / totalBytes) * 100)
        : 0;
      if (percent > lastReportedPercent) {
        lastReportedPercent = percent;
        onProgress?.(percent);
      }
    };
    reportProgress();
    await this.upload(
      prepared.coverUpload.url,
      input.coverFile,
      input.coverFile.type,
      loaded => {
        coverLoaded = Math.min(input.coverFile.size, loaded);
        reportProgress();
      }
    );
    coverLoaded = input.coverFile.size;
    reportProgress();
    await this.upload(
      prepared.packageUpload.url,
      input.packageFile,
      'application/zip',
      loaded => {
        packageLoaded = Math.min(input.packageFile.size, loaded);
        reportProgress();
      }
    );
    packageLoaded = input.packageFile.size;
    reportProgress();
    const finalized = await this.api.request<{ status: 'system_reviewing' }>(
      `/submissions/${encodeURIComponent(prepared.submissionId)}/finalize`,
      { method: 'POST', body: '{}' }
    );
    return {
      submissionId: prepared.submissionId,
      statusToken: prepared.statusToken,
      statusPath: prepared.statusPath,
      status: finalized.status
    };
  }

  async getById(id: string): Promise<SharedPetPackageSummary | null> {
    try {
      return this.remember(await this.api.request<PublicCommunityItem>(
        `/community/${encodeURIComponent(id)}`
      ));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async toggleLike(id: string): Promise<SharedPetPackageSummary> {
    const liked = await this.api.request<{ liked: boolean; likeCount: number }>(
      `/community/${encodeURIComponent(id)}/like`,
      { method: 'POST', body: '{}' }
    );
    const current = this.records.get(id) ?? await this.getById(id);
    if (!current) throw new Error('PACKAGE_NOT_FOUND');
    const updated = { ...current, likedByCurrentUser: liked.liked, likeCount: liked.likeCount };
    this.records.set(id, updated);
    this.notify();
    return updated;
  }

  async getDownload(id: string): Promise<SharedPetDownload> {
    const current = this.records.get(id) ?? await this.getById(id);
    if (!current) throw new Error('PACKAGE_NOT_FOUND');
    const result = await this.api.request<{ url: string; expiresAt: string }>(
      `/community/${encodeURIComponent(id)}/download`,
      { method: 'POST', body: '{}' }
    );
    return { ...result, fileName: current.packageFileName };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private remember(item: PublicCommunityItem): SharedPetPackageSummary {
    const summary: SharedPetPackageSummary = {
      id: item.id,
      name: item.name,
      description: item.description,
      packageFileName: item.packageFileName,
      packageSizeBytes: item.packageSizeBytes,
      coverUrl: item.cover.url,
      likeCount: item.likeCount,
      downloadCount: item.downloadCount,
      createdAt: item.publishedAt,
      updatedAt: item.publishedAt,
      likedByCurrentUser: this.records.get(item.id)?.likedByCurrentUser ?? false
    };
    this.records.set(summary.id, summary);
    return summary;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function fileDescriptor(file: File, contentType: string): {
  fileName: string;
  sizeBytes: number;
  contentType: string;
} {
  return { fileName: file.name, sizeBytes: file.size, contentType };
}

/** 使用 XMLHttpRequest 直接上传签名地址，浏览器据真实已发送字节报告进度。 */
export function uploadWithXhr(
  url: string,
  file: File,
  contentType: string,
  onProgress: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('content-type', contentType);
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('UPLOAD_FAILED'));
    });
    request.addEventListener('error', () => reject(new Error('UPLOAD_FAILED')));
    request.send(file);
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'NOT_FOUND';
}
