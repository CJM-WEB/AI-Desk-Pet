import type { FileParticle } from './swarm-model';

export type RgbColor = readonly [number, number, number];

export interface FilePreviewContentSource {
  getPreview(particle: FileParticle): readonly string[];
}

/** 首页文件预览的默认内容源，不包含任何后续章节语义。 */
export const DEFAULT_FILE_PREVIEW_CONTENT_SOURCE: FilePreviewContentSource = {
  getPreview: (particle) => particle.preview.lines
};
