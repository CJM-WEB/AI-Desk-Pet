import { z } from 'zod';

export const releaseManifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+-alpha\.\d+$/),
    platform: z.literal('windows-x64'),
    fileName: z.string().regex(/^Myself-\d+\.\d+\.\d+-alpha\.\d+-windows-x64\.exe$/),
    downloadUrl: z.string().url().regex(/\.exe$/),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: z.string().datetime(),
    signed: z.literal(false)
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function formatReleaseSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}
