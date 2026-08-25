import { z } from 'zod';

export const fileToolLimits = {
  relativePathMaxLength: 1024,
  listMaxDepth: 4,
  listMaxResults: 200,
  readMaxLineCount: 500,
  searchPatternMaxLength: 256,
  searchMaxResults: 200,
  patchMaxLength: 262_144
} as const;

export const relativePathSchema = z.string().min(1).max(fileToolLimits.relativePathMaxLength);

const searchPatternSchema = z.string()
  .min(1)
  .max(fileToolLimits.searchPatternMaxLength)
  .refine(value => (
    !value.includes('\0')
    && !value.split(/[\\/]+/u).includes('..')
    && !/^(?:[a-zA-Z]:|[\\/]{1,2})/u.test(value)
  ), '搜索模式必须位于授权根内');

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
  glob_files: z.object({
    relativePath: relativePathSchema.default('.'),
    pattern: searchPatternSchema,
    maxResults: z.number().int().min(1).max(fileToolLimits.searchMaxResults).default(100)
  }).strict(),
  grep_files: z.object({
    relativePath: relativePathSchema.default('.'),
    pattern: z.string().min(1).max(fileToolLimits.searchPatternMaxLength),
    include: searchPatternSchema.default('**/*'),
    caseSensitive: z.boolean().default(true),
    maxResults: z.number().int().min(1).max(fileToolLimits.searchMaxResults).default(100)
  }).strict(),
  create_file: z.object({
    relativePath: relativePathSchema,
    content: z.string().default('')
  }).strict(),
  create_directory: z.object({
    relativePath: relativePathSchema
  }).strict(),
  apply_patch: z.object({
    relativePath: relativePathSchema.optional(),
    patch: z.string().min(1).max(fileToolLimits.patchMaxLength)
  }).strict(),
  edit_file: z.object({
    relativePath: relativePathSchema,
    oldString: z.string().min(1).max(fileToolLimits.patchMaxLength),
    newString: z.string().max(fileToolLimits.patchMaxLength),
    replaceAll: z.boolean().default(false)
  }).strict(),
  delete_file: z.object({
    relativePath: relativePathSchema
  }).strict(),
  move_file: z.object({
    sourceRelativePath: relativePathSchema,
    targetDirectoryRelativePath: relativePathSchema
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
  glob_files: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength, default: '.' },
      pattern: { type: 'string', minLength: 1, maxLength: fileToolLimits.searchPatternMaxLength },
      maxResults: { type: 'integer', minimum: 1, maximum: fileToolLimits.searchMaxResults, default: 100 }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  grep_files: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength, default: '.' },
      pattern: { type: 'string', minLength: 1, maxLength: fileToolLimits.searchPatternMaxLength },
      include: { type: 'string', minLength: 1, maxLength: fileToolLimits.searchPatternMaxLength, default: '**/*' },
      caseSensitive: { type: 'boolean', default: true },
      maxResults: { type: 'integer', minimum: 1, maximum: fileToolLimits.searchMaxResults, default: 100 }
    },
    required: ['pattern'],
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
  create_directory: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength }
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
    required: ['patch'],
    additionalProperties: false
  },
  edit_file: {
    type: 'object',
    properties: {
      relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength },
      oldString: { type: 'string', minLength: 1, maxLength: fileToolLimits.patchMaxLength },
      newString: { type: 'string', maxLength: fileToolLimits.patchMaxLength },
      replaceAll: { type: 'boolean', default: false }
    },
    required: ['relativePath', 'oldString', 'newString'],
    additionalProperties: false
  },
  delete_file: {
    type: 'object',
    properties: { relativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength } },
    required: ['relativePath'],
    additionalProperties: false
  },
  move_file: {
    type: 'object',
    required: ['sourceRelativePath', 'targetDirectoryRelativePath'],
    properties: {
      sourceRelativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength },
      targetDirectoryRelativePath: { type: 'string', minLength: 1, maxLength: fileToolLimits.relativePathMaxLength }
    },
    additionalProperties: false
  }
} as const;
