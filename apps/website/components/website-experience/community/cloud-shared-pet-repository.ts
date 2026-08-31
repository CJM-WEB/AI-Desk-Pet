import type { SubmissionReceipt } from '@myself/shared-types';
import {
  finalizeSubmissionResponseSchema,
  prepareSubmissionRequestSchema,
  prepareSubmissionResponseSchema,
  publicCommunityItemSchema,
  publicCommunityPageSchema,
  publicDownloadResponseSchema,
  publicLikeResponseSchema,
  type PublicCommunityItem
} from '@myself/shared-types/website-http';
import { ApiClient } from '../../../lib/api-client';
import {
  SHARED_PET_PAGE_SIZE,
  type CreateSharedPetInput,
  type SharedPetDownload,
  type SharedPetPackageSummary,
  type SharedPetPage,
  type SharedPetRepository
} from './shared-pet-types';

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
  private readonly pageCursors = new Map<number, string>();
  private pageGeneration = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly upload: SignedUpload = uploadWithXhr
  ) {}

  async listPage(
    page: number,
    pageSize: typeof SHARED_PET_PAGE_SIZE = SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage> {
    const selectedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    // 第一页刷新取得游标缓存所有权；旧代际响应只可返回给原调用方，不得回写仓库状态。
    const generation = selectedPage === 1 ? ++this.pageGeneration : this.pageGeneration;
    if (selectedPage === 1) this.pageCursors.clear();
    const cursor = selectedPage === 1 ? undefined : this.pageCursors.get(selectedPage);
    if (selectedPage > 1 && cursor === undefined) throw new Error('PAGE_CURSOR_UNAVAILABLE');
    const result = await this.api.request(
      `/community?limit=${pageSize}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      publicCommunityPageSchema
    );
    const ownsState = generation === this.pageGeneration;
    const items = result.items.map(item => this.remember(item, ownsState));
    const hasNext = result.nextCursor !== null;
    const total = (selectedPage - 1) * pageSize + items.length;
    if (ownsState) {
      for (const cachedPage of this.pageCursors.keys()) {
        if (cachedPage > selectedPage + 1) this.pageCursors.delete(cachedPage);
      }
      if (result.nextCursor === null) this.pageCursors.delete(selectedPage + 1);
      else this.pageCursors.set(selectedPage + 1, result.nextCursor);
    }
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
    onProgress?: (percent: number) => void
  ): Promise<SubmissionReceipt> {
    const body = prepareSubmissionRequestSchema.parse({
      kind: 'shared_package',
      title: input.name,
      body: input.description,
      coverFile: fileDescriptor(input.coverFile, input.coverFile.type),
      packageFile: fileDescriptor(input.packageFile, 'application/zip')
    });
    const prepared = await this.api.request('/submissions/prepare', prepareSubmissionResponseSchema, {
      method: 'POST',
      body: JSON.stringify(body)
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
    const finalized = await this.api.request(
      `/submissions/${encodeURIComponent(prepared.submissionId)}/finalize`,
      finalizeSubmissionResponseSchema,
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
      return this.remember(await this.api.request(
        `/community/${encodeURIComponent(id)}`,
        publicCommunityItemSchema
      ));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async toggleLike(id: string): Promise<SharedPetPackageSummary> {
    const liked = await this.api.request(
      `/community/${encodeURIComponent(id)}/like`,
      publicLikeResponseSchema,
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
    const result = await this.api.request(
      `/community/${encodeURIComponent(id)}/download`,
      publicDownloadResponseSchema,
      { method: 'POST', body: '{}' }
    );
    return {
      url: result.url,
      expiresAt: result.expiresAt,
      fileName: current.packageFileName,
      publicationBasis: result.publicationBasis
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private remember(
    item: PublicCommunityItem,
    persist = true
  ): SharedPetPackageSummary {
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
      likedByCurrentUser: this.records.get(item.id)?.likedByCurrentUser ?? false,
      publicationBasis: item.publicationBasis
    };
    if (persist) this.records.set(summary.id, summary);
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
