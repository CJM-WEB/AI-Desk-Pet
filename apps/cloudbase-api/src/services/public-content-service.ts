import { ApiError } from '../errors.js';
import type {
  ObjectStorage,
  SignedDownload,
  SubmissionStore
} from '../ports.js';

const signedDownloadLifetimeSeconds = 300;

/** 公开内容读取始终先检查数据库发布状态，再签发私有对象地址。 */
export class PublicContentService {
  constructor(
    private readonly store: SubmissionStore,
    private readonly storage: ObjectStorage
  ) {}

  async getDownload(id: string, fingerprint: string): Promise<SignedDownload> {
    void fingerprint;
    const submission = await this.store.findById(id);
    if (!submission || submission.status !== 'published') throw notFound();

    const packages = submission.assets.filter((asset) => asset.role === 'package');
    const expectedPath = `submissions/${id}/package.zip`;
    if (
      packages.length !== 1
      || packages[0]!.storageKey !== expectedPath
    ) {
      throw notFound();
    }
    return this.storage.createSignedUrl(
      packages[0]!.storageKey,
      signedDownloadLifetimeSeconds
    );
  }
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 404);
}
