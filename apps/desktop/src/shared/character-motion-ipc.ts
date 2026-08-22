import { z } from 'zod';

const finiteNumberSchema = z.number().finite();
const characterMotionIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
const characterPlaybackTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);

export const characterMotionPointSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema
}).strict();

export const characterMotionSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  timestampMs: finiteNumberSchema.nonnegative(),
  position: characterMotionPointSchema,
  target: characterMotionPointSchema,
  direction: z.enum(['left', 'right']),
  moving: z.boolean(),
  carrying: z.boolean()
}).strict();

export const characterMotionSnapshotResultSchema = z.object({
  snapshot: characterMotionSnapshotSchema
}).strict();

export const characterMotionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    snapshot: characterMotionSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal('behavior-authority'),
    characterId: characterMotionIdentifierSchema,
    mode: z.literal('legacy-v1')
  }).strict(),
  z.object({
    type: z.literal('behavior-action'),
    revision: z.number().int().nonnegative(),
    stateId: characterMotionIdentifierSchema,
    modifierStateIds: z.array(characterMotionIdentifierSchema).optional(),
    actionId: characterMotionIdentifierSchema,
    playbackToken: characterPlaybackTokenSchema,
    commitFrameId: characterMotionIdentifierSchema.optional()
  }).strict()
]);

export const characterMotionEmptyInputSchema = z.object({}).strict();
export const characterActionFeedbackInputSchema = z.object({
  playbackToken: characterPlaybackTokenSchema,
  actionId: characterMotionIdentifierSchema,
  status: z.enum(['started', 'completed', 'interrupted', 'failed'])
}).strict();

const characterMotionRectangleSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema.positive(),
  height: finiteNumberSchema.positive()
}).strict().refine(
  rectangle => Number.isFinite(rectangle.x + rectangle.width)
    && Number.isFinite(rectangle.y + rectangle.height),
  { message: '矩形边界必须是有限数值' }
);

/** Renderer 只接收窗口局部渲染数据，Main 的身份、资源和全局放置信息不得越过 IPC。 */
export const petGeometryRenderViewSchema = z.object({
  revision: z.number().int().safe().nonnegative(),
  scale: finiteNumberSchema.min(0.5).max(2),
  visualBoundsInWindowDip: characterMotionRectangleSchema
}).strict();
export const characterActionMilestoneInputSchema = z.object({
  playbackToken: characterPlaybackTokenSchema,
  actionId: characterMotionIdentifierSchema,
  kind: z.literal('commit-frame'),
  frameId: characterMotionIdentifierSchema
}).strict();

export type CharacterMotionPoint = z.output<typeof characterMotionPointSchema>;
export type CharacterMotionSnapshot = z.output<typeof characterMotionSnapshotSchema>;
export type PetGeometryRenderView = z.output<typeof petGeometryRenderViewSchema>;
export type CharacterMotionEvent = z.output<typeof characterMotionEventSchema>;
export type CharacterActionFeedbackInput = z.output<
  typeof characterActionFeedbackInputSchema
>;
export type CharacterActionMilestoneInput = z.output<
  typeof characterActionMilestoneInputSchema
>;

/** E2E 只读行为探针不包含播放令牌、素材标识或本地环境信息。 */
export type CharacterBehaviorProbe = {
  revision: number;
  primaryStateId: string;
  modifierStateIds: string[];
  actionId: string | null;
  playbackStatus: 'scheduled' | 'started' | 'completed' | 'interrupted' | 'failed' | null;
};

/** E2E 只读运动探针仅公开相对首帧的差值，不公开绝对屏幕位置。 */
export const characterMotionDeltaProbeSchema = z.object({
  moved: z.boolean(),
  horizontal: finiteNumberSchema,
  vertical: finiteNumberSchema
}).strict().refine(
  (value) => value.moved === (value.horizontal !== 0 || value.vertical !== 0),
  { message: '运动差值状态不一致' }
);

export type CharacterMotionDeltaProbe = z.output<typeof characterMotionDeltaProbeSchema>;
