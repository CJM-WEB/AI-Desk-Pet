import { z } from 'zod';

export const fileToolLimits = {
  relativePathMaxLength: 1024,
  listMaxDepth: 4,
  listMaxResults: 200,
  readMaxLineCount: 500,
  patchMaxLength: 262_144
} as const;

export const relativePathSchema = z.string().min(1).max(fileToolLimits.relativePathMaxLength);

export const toolArguments = {
  list_files: z.object({
    relativePath: relativePathSchema.default('.'),
    maxDepth: z.number().int().min(1).max(fileToolLimits.listMaxDepth).default(1),
    maxResults: z.number().int().min(1).max(fileToolLimits.listMaxResults).default(100)
  }).strict(),
  read_file: z.object({
    relativePath: relativePathSchema,
    startLine: z.number().int().min(1).default(1),
    lineCount: z.number().int().min(1).max(fileToolLimits.readMaxLineCount).default(200)
  }).strict(),
  create_file: z.object({
    relativePath: relativePathSchema,
    content: z.string().default('')
  }).strict(),
  apply_patch: z.object({
    relativePath: relativePathSchema,
    patch: z.string().min(1).max(fileToolLimits.patchMaxLength)
  }).strict(),
  delete_file: z.object({
    relativePath: relativePathSchema
  }).strict()
} as const;

/** 公开给模型的 JSON Schema 与同文件的 Zod 边界共用限制常量。 */
export const toolJsonSchemas = {
  list_files: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength, default: '.' },
      maxDepth: { type: 'integer', minimum: 1, maximum: fileToolLimits.listMaxDepth, default: 1 },
      maxResults: { type: 'integer', minimum: 1, maximum: fileToolLimits.listMaxResults, default: 100 }
    },
    additionalProperties: false
  },
  read_file: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength },
      startLine: { type: 'integer', minimum: 1, default: 1 },
      lineCount: { type: 'integer', minimum: 1, maximum: fileToolLimits.readMaxLineCount, default: 200 }
    },
    required: ['relativePath'],
    additionalProperties: false
  },
  create_file: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength },
      content: { type: 'string', default: '' }
    },
    required: ['relativePath'],
    additionalProperties: false
  },
  apply_patch: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength },
      patch: { type: 'string', minLength: 1, maxLength: fileToolLimits.patchMaxLength }
    },
    required: ['relativePath', 'patch'],
    additionalProperties: false
  },
  delete_file: {
    type: 'object',
    properties: { relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength } },
    required: ['relativePath'],
    additionalProperties: false
  }
} as const;
