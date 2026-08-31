import { z } from 'zod';

const releaseIdentitySchema = {
  version: z.string().regex(/^\d+\.\d+\.\d+-alpha\.\d+$/u),
  platform: z.literal('windows-x64'),
  fileName: z.string().regex(/^AI-Pet-\d+\.\d+\.\d+-alpha\.\d+-windows-x64\.exe$/u)
};

/** 发布清单是网站下载页与安装包生成工具共用的唯一运行时契约。 */
export const publishedReleaseManifestSchema = z.object({
  ...releaseIdentitySchema,
  status: z.literal('published'),
  downloadUrl: z.string().url().regex(/\.exe$/u),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  publishedAt: z.string().datetime(),
  signed: z.literal(false)
}).strict();

export const unpublishedReleaseManifestSchema = z.object({
  ...releaseIdentitySchema,
  status: z.literal('unpublished')
}).strict();

export const releaseManifestSchema = z.discriminatedUnion('status', [
  publishedReleaseManifestSchema,
  unpublishedReleaseManifestSchema
]);

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
