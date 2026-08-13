import { z } from 'zod';

export const CORE_CHARACTER_STATES = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
] as const;

export type CoreCharacterState = typeof CORE_CHARACTER_STATES[number];
export type ExtensionStateId = `custom:${string}`;
export type CharacterStateId = CoreCharacterState | ExtensionStateId;

// 状态标识符和资源文件边界。
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const SAFE_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}\.(?:png|webp|json)$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RESOURCE_BYTE_LENGTH = 512 * 1024 * 1024;
const EXTENSION_STATE_PREFIX = 'custom:';

const safeIdentifierSchema = z.string().regex(SAFE_IDENTIFIER_PATTERN);
const finiteNumberSchema = z.number().finite();

function normalizeExtensionStateName(name: string): string {
  const normalizedName = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '-');

  if (!normalizedName || /[/\\]/u.test(normalizedName)) {
    throw new RangeError('扩展状态名称必须为非空且不含路径分隔符的文本。');
  }

  const stateId = `${EXTENSION_STATE_PREFIX}${normalizedName}`;
  if (stateId.length > 120) {
    throw new RangeError('扩展状态标识符不能超过 120 个字符。');
  }

  return normalizedName;
}

export function createExtensionStateId(name: string): ExtensionStateId {
  return `${EXTENSION_STATE_PREFIX}${normalizeExtensionStateName(name)}`;
}

function isNormalizedExtensionStateId(value: string): boolean {
  if (!value.startsWith(EXTENSION_STATE_PREFIX)) {
    return false;
  }

  try {
    return value === createExtensionStateId(value.slice(EXTENSION_STATE_PREFIX.length));
  } catch {
    return false;
  }
}

const normalizedExtensionStateIdSchema = z.string()
  .min(EXTENSION_STATE_PREFIX.length + 1)
  .max(120)
  .refine(
    isNormalizedExtensionStateId,
    '扩展状态标识符必须使用规范化的 custom: 前缀。'
  )
  .transform((value): ExtensionStateId => value as ExtensionStateId);

// 动作帧、锚点和交互区域。
const anchorPointSchema = z.object({
  x: finiteNumberSchema.min(0).max(1),
  y: finiteNumberSchema.min(0).max(1)
}).strict();

export const anchorSetSchema = z.object({
  ground: anchorPointSchema,
  focus: anchorPointSchema.optional(),
  carry: anchorPointSchema.optional(),
  mouth: anchorPointSchema.optional(),
  seat: anchorPointSchema.optional()
}).strict();

export const interactionRegionSchema = z.object({
  x: finiteNumberSchema.min(0).max(1),
  y: finiteNumberSchema.min(0).max(1),
  width: finiteNumberSchema.min(0).max(1),
  height: finiteNumberSchema.min(0).max(1)
}).strict().superRefine((region, context) => {
  if (region.x + region.width > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '交互区域不能超出逻辑画布的水平方向。',
      path: ['width']
    });
  }

  if (region.y + region.height > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '交互区域不能超出逻辑画布的垂直方向。',
      path: ['height']
    });
  }
});

const extensionTriggerConfigSchema = z.object({
  events: z.array(z.enum([
    'idle',
    'single_click',
    'double_click',
    'context_menu'
  ])).max(4).default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  emotions: z.array(safeIdentifierSchema).max(32).default([])
}).strict();

export const actionFrameSchema = z.object({
  id: safeIdentifierSchema.optional(),
  assetId: safeIdentifierSchema,
  x: finiteNumberSchema.int().nonnegative(),
  y: finiteNumberSchema.int().nonnegative(),
  width: finiteNumberSchema.int().positive(),
  height: finiteNumberSchema.int().positive(),
  durationMs: finiteNumberSchema.int().positive().optional(),
  anchors: anchorSetSchema.partial().strict().optional()
}).strict();

function requireUniqueFrameIds(
  frames: readonly z.output<typeof actionFrameSchema>[],
  context: z.RefinementCtx
): void {
  const ids = new Set<string>();
  frames.forEach((frame, frameIndex) => {
    if (!frame.id) return;
    if (ids.has(frame.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '动作内的帧标识必须唯一。',
        path: [frameIndex, 'id']
      });
    }
    ids.add(frame.id);
  });
}

const draftActionFramesSchema = z.array(actionFrameSchema)
  .superRefine(requireUniqueFrameIds);
const publishedActionFramesSchema = z.array(actionFrameSchema)
  .min(1)
  .superRefine(requireUniqueFrameIds);

const actionClipFields = {
  id: safeIdentifierSchema,
  name: z.string().trim().min(1).max(120),
  fps: finiteNumberSchema.min(1).max(60),
  loop: z.boolean(),
  weight: finiteNumberSchema.positive().max(100),
  direction: z.enum(['left', 'right', 'any']).optional(),
  anchors: anchorSetSchema,
  regions: z.object({
    click: interactionRegionSchema.optional(),
    drag: interactionRegionSchema.optional(),
    collision: interactionRegionSchema.optional()
  }).strict().optional()
};

const draftActionClipSchema = z.object({
  ...actionClipFields,
  frames: draftActionFramesSchema
}).strict();

const actionClipSchema = z.object({
  ...actionClipFields,
  frames: publishedActionFramesSchema
}).strict();

// 发布状态与草稿状态分别绑定其可用动作结构。
const coreCharacterStateDefinitionSchema = z.object({
  id: z.enum(CORE_CHARACTER_STATES),
  kind: z.literal('core'),
  actions: z.array(actionClipSchema)
}).strict();

const extensionCharacterStateDefinitionSchema = z.object({
  id: normalizedExtensionStateIdSchema,
  kind: z.literal('extension'),
  triggers: extensionTriggerConfigSchema.optional(),
  actions: z.array(actionClipSchema)
}).strict();

const characterStateDefinitionSchema = z.discriminatedUnion('kind', [
  coreCharacterStateDefinitionSchema,
  extensionCharacterStateDefinitionSchema
]);

const coreDraftStateDefinitionSchema = z.object({
  id: z.enum(CORE_CHARACTER_STATES),
  kind: z.literal('core'),
  actions: z.array(draftActionClipSchema)
}).strict();

const extensionDraftStateDefinitionSchema = z.object({
  id: normalizedExtensionStateIdSchema,
  kind: z.literal('extension'),
  triggers: extensionTriggerConfigSchema.optional(),
  actions: z.array(draftActionClipSchema)
}).strict();

const characterDraftStateDefinitionSchema = z.discriminatedUnion('kind', [
  coreDraftStateDefinitionSchema,
  extensionDraftStateDefinitionSchema
]);

export const characterResourceSchema = z.object({
  assetId: safeIdentifierSchema,
  fileName: z.string().regex(SAFE_FILE_NAME_PATTERN),
  sha256: z.string().regex(SHA_256_PATTERN),
  byteLength: finiteNumberSchema.int().safe().positive().max(MAX_RESOURCE_BYTE_LENGTH)
}).strict();

const characterIdentityFields = {
  version: z.literal(1),
  id: safeIdentifierSchema,
  name: z.string().trim().min(1).max(120)
};

// 草稿允许未完成动作，发布清单要求完整资源和可播放帧。
export const characterDraftV1Schema = z.object({
  ...characterIdentityFields,
  thumbnailAssetId: safeIdentifierSchema.optional(),
  states: z.array(characterDraftStateDefinitionSchema)
}).strict();

export const characterManifestV1Schema = z.object({
  ...characterIdentityFields,
  thumbnailAssetId: safeIdentifierSchema,
  compilerVersion: z.string().trim().min(1).max(64),
  resources: z.array(characterResourceSchema),
  states: z.array(characterStateDefinitionSchema)
}).strict().superRefine((manifest, context) => {
  const resourceIds = new Set<string>();

  manifest.resources.forEach((resource, resourceIndex) => {
    if (resourceIds.has(resource.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '资源标识符必须唯一。',
        path: ['resources', resourceIndex, 'assetId']
      });
    }
    resourceIds.add(resource.assetId);
  });

  if (!resourceIds.has(manifest.thumbnailAssetId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '缩略图必须引用已声明的资源。',
      path: ['thumbnailAssetId']
    });
  }

  manifest.states.forEach((state, stateIndex) => {
    state.actions.forEach((action, actionIndex) => {
      action.frames.forEach((frame, frameIndex) => {
        if (!resourceIds.has(frame.assetId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '动作帧必须引用已声明的资源。',
            path: ['states', stateIndex, 'actions', actionIndex, 'frames', frameIndex, 'assetId']
          });
        }
      });
    });
  });

  const idleState = manifest.states.find((state) => state.id === 'idle');
  if (!idleState || idleState.actions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '可发布角色清单必须包含至少一个待机动作。',
      path: ['states']
    });
  }
});

export type AnchorPoint = z.output<typeof anchorPointSchema>;
export type AnchorSet = z.output<typeof anchorSetSchema>;
export type InteractionRegion = z.output<typeof interactionRegionSchema>;
export type ActionFrame = z.output<typeof actionFrameSchema>;
export type DraftActionClip = z.output<typeof draftActionClipSchema>;
export type ActionClip = z.output<typeof actionClipSchema>;
export type CoreCharacterStateDefinition = z.output<typeof coreCharacterStateDefinitionSchema>;
export type ExtensionCharacterStateDefinition = z.output<typeof extensionCharacterStateDefinitionSchema>;
export type CharacterStateDefinition = z.output<typeof characterStateDefinitionSchema>;
export type CoreDraftStateDefinition = z.output<typeof coreDraftStateDefinitionSchema>;
export type ExtensionDraftStateDefinition = z.output<typeof extensionDraftStateDefinitionSchema>;
export type CharacterDraftStateDefinition = z.output<typeof characterDraftStateDefinitionSchema>;
export type CharacterResource = z.output<typeof characterResourceSchema>;
export type CharacterDraftV1 = z.output<typeof characterDraftV1Schema>;
export type CharacterManifestV1 = z.output<typeof characterManifestV1Schema>;
