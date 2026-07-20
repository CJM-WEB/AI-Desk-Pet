import { z } from 'zod';

export const relativePathSchema = z.string().min(1).max(1024);

export const toolArguments = {
  list_directory: z.object({
    relativePath: relativePathSchema.default('.')
  }).strict(),
  read_text_file: z.object({
    relativePath: relativePathSchema
  }).strict(),
  create_file: z.object({
    relativePath: relativePathSchema
  }).strict(),
  create_directory: z.object({
    relativePath: relativePathSchema
  }).strict(),
  rename_entry: z.object({
    sourceRelativePath: relativePathSchema,
    targetRelativePath: relativePathSchema
  }).strict()
} as const;
