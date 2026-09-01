import type { PublicationBasis } from '@myself/shared-types';

import { ApiError } from '../errors.js';
import type {
  ObjectStorage,
  PublicAsset,
  PublicContentStore,
  PublishedCommunityRecord,
  PublicListQuery,
  PublicLikeResult,
  SignedDownload
} from '../ports.js';

const signedDownloadLifetimeSeconds = 300;

export interface PublicCover {
  url: string;
  expiresAt: string;
}

export interface PublicCommunityItem {
  id: string;
  name: string;
  description: string;
  cover: PublicCover;
  packageFileName: string;
  packageSizeBytes: number;
  likeCount: number;
  downloadCount: number;
  publishedAt: string;
  publicationBasis: PublicationBasis;
}

export interface PublicDownload extends SignedDownload {
  publicationBasis: PublicationBasis;
}

export interface PublicFeedbackItem {
  id: string;
  kind: 'feedback' | 'suggestion';
  authorName: string;
  content: string;
  likeCount: number;
  createdAt: string;
}

/** 公开内容只消费已发布投影，并在返回对象地址前完成结构检查。 */
export class PublicContentService {
  constructor(
    private readonly store: PublicContentStore,
    private readonly storage: Pick<ObjectStorage, 'createSignedUrl'>
  ) {}

  async listCommunity(input: PublicListQuery): Promise<{
    items: PublicCommunityItem[];
    nextCursor: string | null;
  }> {
    const page = await this.store.listPublicCommunity(input);
    const candidates = page.items.filter(item =>
      hasValidPublicSubmissionShape(item, 'shared_package')
    );
    const settled = await Promise.allSettled(
      candidates.map(item => this.signCommunity(item))
    );
    const items = settled.flatMap(result => (
      result.status === 'fulfilled' ? [result.value] : []
    ));
    if (candidates.length > 0 && items.length === 0) {
      throw new ApiError('STORAGE_ERROR', 500);
    }
    return {
      items,
      nextCursor: page.nextCursor
    };
  }

  async getCommunity(id: string): Promise<PublicCommunityItem> {
    const item = await this.store.findPublicCommunity(id);
    if (!item || !hasValidPublicSubmissionShape(item, 'shared_package')) {
      throw notFound();
    }
    return this.signCommunity(item);
  }

  async listFeedback(
    kind: 'feedback' | 'suggestion',
    input: PublicListQuery
  ): Promise<{
    items: PublicFeedbackItem[];
    nextCursor: string | null;
  }> {
    const page = await this.store.listPublicFeedback(kind, input);
    return {
      items: page.items
        .filter(item => hasValidPublicSubmissionShape(item, item.kind))
        .map(item => ({
          id: item.id,
          kind: item.kind,
          authorName: item.title,
          content: item.body,
          likeCount: item.likeCount,
          createdAt: item.createdAt
        })),
      nextCursor: page.nextCursor
    };
  }

  async setFeedbackLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<PublicLikeResult> {
    return this.setPublicLike(
      id, fingerprint, desiredLiked, operationId, 'feedback'
    );
  }

  async setCommunityLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<PublicLikeResult> {
    return this.setPublicLike(
      id, fingerprint, desiredLiked, operationId, 'community'
    );
  }

  async getDownload(
    id: string,
    fingerprint: string,
    operationId: string
  ): Promise<PublicDownload> {
    const submission = await this.store.findPublicCommunity(id);
    if (
      !submission
      || (
        submission.publicationBasis !== 'standard'
        && submission.publicationBasis !== 'admin_override'
      )
      || !hasValidPublicSubmissionShape(submission, 'shared_package')
    ) {
      throw notFound();
    }

    const packageAsset = submission.assets.find(asset => asset.role === 'package')!;
    const signed = await this.storage.createSignedUrl(
      packageAsset.storageKey,
      signedDownloadLifetimeSeconds
    );
    await this.store.recordPublicDownload({
      submissionId: id,
      fingerprintHash: fingerprint,
      operationId
    });
    return {
      ...signed,
      publicationBasis: submission.publicationBasis
    };
  }

  private async signCommunity(
    item: PublishedCommunityRecord
  ): Promise<PublicCommunityItem> {
    const cover = item.assets.find(asset => asset.role === 'cover')!;
    const packageAsset = item.assets.find(asset => asset.role === 'package')!;
    const signedCover = await this.storage.createSignedUrl(
      cover.storageKey,
      signedDownloadLifetimeSeconds
    );
    return {
      id: item.id,
      name: item.title,
      description: item.body,
      cover: signedCover,
      packageFileName: packageAsset.fileName,
      packageSizeBytes: packageAsset.sizeBytes,
      likeCount: item.likeCount,
      downloadCount: item.downloadCount,
      publishedAt: item.publishedAt,
      publicationBasis: item.publicationBasis
    };
  }

  private async setPublicLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string,
    endpointKind: 'community' | 'feedback'
  ): Promise<PublicLikeResult> {
    return this.store.setPublicLike({
      submissionId: id,
      fingerprintHash: fingerprint,
      desiredLiked,
      operationId,
      endpointKind
    });
  }
}

/** 读侧只在这一处复现发布结构；列表过滤、详情与下载共同复用。 */
function hasValidPublicSubmissionShape(
  record: {
    id: string;
    title?: string | null;
    body?: string | null;
    assets?: readonly PublicAsset[];
  },
  kind: unknown
): boolean {
  if (
    typeof record.title !== 'string'
    || record.title.trim().length === 0
    || typeof record.body !== 'string'
    || record.body.trim().length === 0
  ) return false;
  if (kind === 'feedback' || kind === 'suggestion') return true;
  if (kind !== 'shared_package' || !record.assets) return false;

  const covers = record.assets.filter(asset => asset.role === 'cover');
  const packages = record.assets.filter(asset => asset.role === 'package');
  if (covers.length !== 1 || packages.length !== 1) return false;
  const cover = covers[0]!;
  const packageAsset = packages[0]!;
  const coverMimeByKey = new Map([
    [`submissions/${record.id}/cover.png`, 'image/png'],
    [`submissions/${record.id}/cover.webp`, 'image/webp'],
    [`submissions/${record.id}/cover.jpg`, 'image/jpeg'],
    [`submissions/${record.id}/cover.jpeg`, 'image/jpeg']
  ]);
  return coverMimeByKey.get(cover.storageKey) === cover.contentType
    && publicAssetSize(cover) > 0
    && packageAsset.storageKey === `submissions/${record.id}/package.zip`
    && packageAsset.contentType === 'application/zip'
    && publicAssetSize(packageAsset) > 0;
}

function publicAssetSize(asset: PublicAsset): number {
  return asset.sizeBytes;
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 404);
}
