import { z } from 'zod';

export const relativePathSchema = z.string().min(1).max(1024);

export const toolArguments = {
  list_files: z.object({
    relativePath: relativePathSchema.default('.'),
    maxDepth: z.number().int().min(1).max(4).default(1),
    maxResults: z.number().int().min(1).max(200).default(100)
  }).strict(),
  read_file: z.object({
    relativePath: relativePathSchema,
    startLine: z.number().int().min(1).default(1),
    lineCount: z.number().int().min(1).max(500).default(200)
  }).strict(),
  create_file: z.object({
    relativePath: relativePathSchema,
    content: z.string().default('')
  }).strict(),
  apply_patch: z.object({
    relativePath: relativePathSchema,
    patch: z.string().min(1).max(262_144)
  }).strict(),
  delete_file: z.object({
    relativePath: relativePathSchema
  }).strict()
} as const;
