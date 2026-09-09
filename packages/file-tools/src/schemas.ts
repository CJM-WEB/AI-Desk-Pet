import { z } from 'zod';

const RELATIVE_PATH_MAX_LENGTH = 1024;

/** 跨模块只共享授权根内相对路径边界，执行工具参数由当前 Core 自己校验。 */
export const relativePathSchema = z.string().min(1).max(RELATIVE_PATH_MAX_LENGTH);
