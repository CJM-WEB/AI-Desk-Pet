import type { PublicationBasis } from '@myself/shared-types';

import { ApiError } from '../errors.js';
import type {
  ObjectStorage,
  PublishedCommunityRecord,
  PublicInteractionStore,
  PublicListQuery,
  PublicLikeResult,
  SignedDownload,
  SubmissionStore
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

/** 公开内容读取始终先检查数据库发布状态，再签发私有对象地址。 */
export class PublicContentService {
  constructor(
    private readonly store: SubmissionStore & PublicInteractionStore,
    private readonly storage: ObjectStorage
  ) {}

  async listCommunity(input: PublicListQuery): Promise<{
    items: PublicCommunityItem[];
    nextCursor: string | null;
  }> {
    const page = await this.store.listPublicCommunity(input);
    return {
      items: await Promise.all(page.items.map(item => this.toCommunity(item))),
      nextCursor: page.nextCursor
    };
  }

  async getCommunity(id: string): Promise<PublicCommunityItem> {
    const item = await this.store.findPublicCommunity(id);
    if (!item) throw notFound();
    return this.toCommunity(item);
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
      items: page.items.map(item => ({
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
    await this.requireKind(id, ['feedback', 'suggestion']);
    return this.setPublicLike(id, fingerprint, desiredLiked, operationId);
  }

  async setCommunityLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<PublicLikeResult> {
    await this.requireKind(id, ['shared_package']);
    return this.setPublicLike(id, fingerprint, desiredLiked, operationId);
  }

  async getDownload(
    id: string,
    _fingerprint?: string
  ): Promise<PublicDownload> {
    const submission = await this.store.findById(id);
    if (
      !submission
      || submission.status !== 'published'
      || submission.kind !== 'shared_package'
      || (
        submission.publicationBasis !== 'standard'
        && submission.publicationBasis !== 'admin_override'
      )
    ) {
      throw notFound();
    }

    const packages = submission.assets.filter((asset) => asset.role === 'package');
    const expectedPath = `submissions/${id}/package.zip`;
    if (
      packages.length !== 1
      || packages[0]!.storageKey !== expectedPath
    ) {
      throw notFound();
    }
    await this.store.recordPublicDownload(id);
    const signed = await this.storage.createSignedUrl(
      packages[0]!.storageKey,
      signedDownloadLifetimeSeconds
    );
    return {
      ...signed,
      publicationBasis: submission.publicationBasis
    };
  }

  private async toCommunity(
    item: PublishedCommunityRecord
  ): Promise<PublicCommunityItem> {
    const covers = item.assets.filter(asset => asset.role === 'cover');
    const packages = item.assets.filter(asset => asset.role === 'package');
    if (covers.length !== 1 || packages.length !== 1) throw notFound();
    const cover = covers[0]!;
    const packageAsset = packages[0]!;
    if (
      !cover.storageKey.startsWith(`submissions/${item.id}/cover.`)
      || cover.storageKey.slice(`submissions/${item.id}/cover.`.length)
        .includes('/')
      || packageAsset.storageKey !== `submissions/${item.id}/package.zip`
    ) {
      throw notFound();
    }
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

  /** endpoint 只约束不可变种类；Store 在同一事务中先回放，再校验首次写的发布状态。 */
  private async requireKind(
    id: string,
    kinds: readonly string[]
  ): Promise<void> {
    const submission = await this.store.findById(id);
    if (
      !submission
      || !submission.kind
      || !kinds.includes(submission.kind)
    ) {
      throw notFound();
    }
  }

  private async setPublicLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<PublicLikeResult> {
    return this.store.setPublicLike({
      submissionId: id,
      fingerprintHash: fingerprint,
      desiredLiked,
      operationId
    });
  }
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 404);
}
