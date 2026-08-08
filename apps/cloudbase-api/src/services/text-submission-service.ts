import { randomUUID } from 'node:crypto';

import type { SubmissionReceipt } from '@myself/shared-types';

import { createStatusToken, hashStatusToken } from '../crypto/status-token.js';
import { ApiError } from '../errors.js';
import type {
  PublicInteractionStore,
  TextSubmissionKind
} from '../ports.js';
import type { RequestContext } from './submission-service.js';

export interface TextSubmissionInput {
  kind: TextSubmissionKind;
  authorName: string;
  content: string;
}

type CreateId = () => string;

/** 验证并创建无需资产上传的反馈或建议。 */
export class TextSubmissionService {
  constructor(
    private readonly store: Pick<
      PublicInteractionStore,
      'createTextSubmission'
    >,
    private readonly createId: CreateId = randomUUID
  ) {}

  async submit(
    input: TextSubmissionInput,
    context: RequestContext
  ): Promise<SubmissionReceipt> {
    const normalized = validateInput(input, context);

    const submissionId = this.createId();
    const statusToken = createStatusToken();
    await this.store.createTextSubmission({
      id: submissionId,
      kind: normalized.kind,
      title: normalized.authorName || '匿名用户',
      body: normalized.content,
      statusTokenHash: hashStatusToken(statusToken)
    });
    return {
      submissionId,
      statusToken,
      statusPath: '/submission-status/',
      status: 'system_reviewing'
    };
  }
}

function validateInput(
  input: TextSubmissionInput,
  context: RequestContext
): TextSubmissionInput {
  if (
    typeof input !== 'object'
    || input === null
    || typeof context !== 'object'
    || context === null
    || (input.kind !== 'feedback' && input.kind !== 'suggestion')
    || typeof input.authorName !== 'string'
    || typeof input.content !== 'string'
    || typeof context.ip !== 'string'
    || context.ip.trim().length === 0
  ) {
    throw new ApiError('INVALID_REQUEST', 400);
  }

  const authorName = input.authorName.trim();
  const content = input.content.trim();
  if (authorName.length > 30 || content.length < 1 || content.length > 1000) {
    throw new ApiError('INVALID_REQUEST', 400);
  }
  return { ...input, authorName, content };
}
