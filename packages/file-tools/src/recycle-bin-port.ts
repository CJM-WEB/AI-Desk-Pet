/**
 * 平台无关的系统回收站端口。
 * 生产组合根负责适配 Electron，文件工具包本身不依赖桌面运行时。
 */
export interface RecycleBinPort {
  moveToRecycleBin(absolutePath: string): Promise<void>;
}
