import { z } from 'zod';

/** 展示协议不承接业务请求；所有字段都来自当前聊天界面已可见的信息。 */
export const chatPresentationChannels = {
  publish: 'chat-presentation:publish',
  snapshot: 'chat-presentation:snapshot',
  dispatch: 'chat-presentation:dispatch',
  intent: 'chat-presentation:intent',
  layout: 'chat-presentation:layout',
  command: 'chat-presentation:command',
  ready: 'chat-presentation:ready'
} as const;

const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.string().min(1).max(160);
const epochSchema = z.string().min(1).max(128);

export const chatPresentationSnapshotSchema = z.object({
  epoch: epochSchema,
  revision: revisionSchema,
  conversationRevision: revisionSchema,
  reply: z.object({ id: identitySchema, text: z.string().max(65_536) }).strict().nullable(),
  confirmation: z.object({
    id: identitySchema,
    kind: z.enum(['capability', 'permission', 'disclosure']),
    title: z.string().min(1).max(240),
    details: z.array(z.string().max(16_384)).max(64)
      .refine(lines => lines.reduce((length, line) => length + line.length, 0) <= 65_536),
    approveLabel: z.enum(['授权', '覆盖']),
    approveDescription: z.string().min(1).max(1_024),
    rejectDescription: z.string().min(1).max(1_024),
    busy: z.boolean(),
    error: z.string().max(1_024).nullable()
  }).strict().nullable()
}).strict();

export const chatPresentationIntentSchema = z.object({
  epoch: epochSchema,
  revision: revisionSchema,
  conversationRevision: revisionSchema,
  targetId: identitySchema,
  action: z.enum(['dismiss-reply', 'confirm', 'reject', 'toggle-details'])
}).strict();

const dimensionSchema = z.number().finite().positive().max(4_096);
const coordinateSchema = z.number().finite().min(0).max(4_096);
export const chatPresentationLayoutSchema = z.object({
  surface: z.enum(['island', 'bubble']),
  width: dimensionSchema,
  height: dimensionSchema,
  regions: z.array(z.object({
    x: coordinateSchema,
    y: coordinateSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    radius: coordinateSchema.optional()
  }).strict()).max(32),
  mode: z.enum(['hidden', 'peek', 'opening', 'open', 'closing'])
}).strict().refine(layout => {
  return layout.regions.every(region => region.x + region.width <= layout.width
      && region.y + region.height <= layout.height
      && (region.radius ?? 0) <= Math.min(region.width, region.height) / 2);
});

export const chatPresentationCommandSchema = z.union([
  z.object({ type: z.literal('bubble-anchor'), bodyLeft: coordinateSchema, tailX: coordinateSchema, side: z.enum(['top', 'bottom']) }).strict(),
  z.object({ type: z.enum(['peek', 'conceal', 'open', 'close']) }).strict(),
  z.object({ type: z.enum(['availability', 'pointer-availability']), available: z.boolean() }).strict(),
  z.object({ type: z.literal('reset'), epoch: epochSchema, revisionFloor: revisionSchema,
    preserveConfirmation: z.boolean().optional() }).strict()
]);
export const chatPresentationReadyResultSchema = z.object({ epoch: epochSchema, revisionFloor: revisionSchema }).strict();

export type ChatPresentationSnapshot = z.infer<typeof chatPresentationSnapshotSchema>;
export type ChatPresentationIntent = z.infer<typeof chatPresentationIntentSchema>;
export type ChatPresentationLayout = z.infer<typeof chatPresentationLayoutSchema>;
export type ChatPresentationCommand = z.infer<typeof chatPresentationCommandSchema>;
export type ChatPresentationReadyResult = z.infer<typeof chatPresentationReadyResultSchema>;

export interface ChatPresentationApi {
  publish(snapshot: ChatPresentationSnapshot): Promise<void>;
  /** null 只撤销当前展示，不表示清除原会话历史或取消任务。 */
  onSnapshot(listener: (snapshot: ChatPresentationSnapshot | null) => void): () => void;
  dispatch(intent: ChatPresentationIntent): Promise<void>;
  onIntent(listener: (intent: ChatPresentationIntent) => void): () => void;
  setLayout(layout: ChatPresentationLayout): Promise<void>;
  onCommand(listener: (command: ChatPresentationCommand) => void): () => void;
  /** chat 首次发布前读取代次及水位；reset 后使用新代次，且继续严格递增修订。 */
  ready(): Promise<ChatPresentationReadyResult>;
}

/** 严格拒绝而不裁剪；固定错误不暴露 Zod 路径、原正文或未知私有字段。 */
export function parseChatPresentation<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('CHAT_PRESENTATION_PAYLOAD_INVALID');
  return parsed.data;
}
