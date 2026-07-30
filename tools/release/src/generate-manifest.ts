import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const releaseManifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+-alpha\.\d+$/),
    platform: z.literal('windows-x64'),
    status: z.literal('published'),
    fileName: z.string().regex(/^AI-Pet-\d+\.\d+\.\d+-alpha\.\d+-windows-x64\.exe$/),
    downloadUrl: z.string().url().regex(/\.exe$/),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: z.string().datetime(),
    signed: z.literal(false)
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export interface GenerateReleaseManifestInput {
  installerPath: string;
  downloadBaseUrl: string;
  publishedAt: string;
}

export interface WriteReleaseManifestInput extends GenerateReleaseManifestInput {
  outputPath: string;
}

function versionFromInstallerName(fileName: string): string {
  const match = /^AI-Pet-(\d+\.\d+\.\d+-alpha\.\d+)-windows-x64\.exe$/u.exec(fileName);
  if (!match?.[1]) throw new Error('安装包文件名不符合第一阶段发布契约');
  return match[1];
}

export async function generateReleaseManifest(
  input: GenerateReleaseManifestInput
): Promise<ReleaseManifest> {
  const fileName = basename(input.installerPath);
  const bytes = await readFile(input.installerPath);
  const fileInfo = await stat(input.installerPath);
  const manifest = {
    version: versionFromInstallerName(fileName),
    platform: 'windows-x64',
    status: 'published',
    fileName,
    downloadUrl: new URL(fileName, input.downloadBaseUrl).toString(),
    sizeBytes: fileInfo.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    publishedAt: input.publishedAt,
    signed: false
  };
  return releaseManifestSchema.parse(manifest);
}

export async function writeReleaseManifest(input: WriteReleaseManifestInput): Promise<void> {
  const manifest = await generateReleaseManifest(input);
  await writeFile(input.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function readFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`缺少命令行参数 ${name}`);
  return value;
}

export function parseManifestCommandArgs(args: string[]): WriteReleaseManifestInput {
  const normalizedArgs = args.filter(argument => argument !== '--');
  return {
    installerPath: readFlag(normalizedArgs, '--installer'),
    downloadBaseUrl: readFlag(normalizedArgs, '--base-url'),
    publishedAt: readFlag(normalizedArgs, '--published-at'),
    outputPath: readFlag(normalizedArgs, '--output')
  };
}

async function main(): Promise<void> {
  await writeReleaseManifest(parseManifestCommandArgs(process.argv.slice(2)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
