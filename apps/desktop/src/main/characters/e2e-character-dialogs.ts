import { join } from 'node:path';
import type { MainE2eBoundary } from '../e2e-boundary';

type OpenResult = { canceled: boolean; filePaths: string[] };
type SaveResult = { canceled: boolean; filePath?: string };

/**
 * 队列仅由已经通过 Main 临时目录校验的 E2E 边界创建，不进入 preload 或生产包接口。
 */
export function createE2eCharacterDialogAdapter(boundary: MainE2eBoundary) {
  const sources = ['idle.png', 'carrying.png', 'acting.png'];
  const packages = [
    boundary.safeCharacterPackage,
    boundary.maliciousCharacterPackage
  ];
  let exportAvailable = true;

  return {
    async chooseSources(): Promise<OpenResult> {
      const name = sources.shift();
      return name
        ? {
            canceled: false,
            filePaths: [join(boundary.characterAssetsDirectory, name)]
          }
        : { canceled: true, filePaths: [] };
    },
    async choosePackage(): Promise<OpenResult> {
      const path = packages.shift();
      return path
        ? { canceled: false, filePaths: [path] }
        : { canceled: true, filePaths: [] };
    },
    async chooseExportDestination(): Promise<SaveResult> {
      if (!exportAvailable) return { canceled: true };
      exportAvailable = false;
      return {
        canceled: false,
        filePath: boundary.characterExportDestination
      };
    }
  };
}
