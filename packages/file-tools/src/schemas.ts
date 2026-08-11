import { posix, win32 } from 'node:path';
import { z } from 'zod';

export const relativePathSchema = z.string().min(1).max(1024);

/** 回收站写操作在进入路径策略前先拒绝两种平台的绝对路径形式。 */
const recycleBinRelativePathSchema = relativePathSchema.refine(
  value => value.trim().length > 0 && !posix.isAbsolute(value) && !win32.isAbsolute(value),
  '回收站目标必须是授权根目录内的相对路径'
);

export const toolArguments = {
  list_directory: z.object({
    relativePath: relativePathSchema.default('.')
  }).strict(),
  read_text_file: z.object({
    relativePath: relativePathSchema
  }).strict(),
  search_entries: z.object({
    relativePath: relativePathSchema.default('.'),
    name: z.string().min(1).max(255),
    type: z.enum(['file', 'directory']).optional(),
    maxDepth: z.number().int().min(1).max(8).default(4),
    maxResults: z.number().int().min(1).max(200).default(100)
  }).strict(),
  create_file: z.object({
    relativePath: relativePathSchema,
    content: z.string().optional()
  }).strict(),
  create_directory: z.object({
    relativePath: relativePathSchema
  }).strict(),
  write_text_file: z.object({
    relativePath: relativePathSchema,
    content: z.string()
  }).strict(),
  copy_entry: z.object({
    sourceRelativePath: relativePathSchema,
    targetRelativePath: relativePathSchema
  }).strict(),
  move_entry: z.object({
    sourceRelativePath: relativePathSchema,
    targetRelativePath: relativePathSchema
  }).strict(),
  rename_entry: z.object({
    sourceRelativePath: relativePathSchema,
    targetRelativePath: relativePathSchema
  }).strict(),
  move_to_recycle_bin: z.object({
    relativePath: recycleBinRelativePathSchema
  }).strict()
} as const;
