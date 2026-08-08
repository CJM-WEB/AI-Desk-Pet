import { z } from 'zod';

export const EXPLORER_SPACE_PROTOCOL_VERSION = 1 as const;
export const EXPLORER_SPACE_MAX_LINE_BYTES = 16 * 1024;

const nonceSchema = z.string().regex(/^[a-f0-9]{32,128}$/);
const requestIdSchema = z.string().regex(/^request-[1-9][0-9]{0,15}$/);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const hwndSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
const rectSchema = z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  width: z.number().int().positive().finite(),
  height: z.number().int().positive().finite()
}).strict();

const helloSchema = z.object({
  version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
  type: z.literal('hello'),
  nonce: nonceSchema,
  sequence: z.literal(0)
}).strict();

const heartbeatSchema = z.object({
  version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
  type: z.literal('observer-heartbeat'),
  nonce: nonceSchema,
  sequence: sequenceSchema
}).strict();

const responseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('response'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    requestId: requestIdSchema,
    ok: z.literal(true)
  }).strict(),
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('response'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    requestId: requestIdSchema,
    ok: z.literal(false),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)
  }).strict()
]);

const snapshotSchema = z.discriminatedUnion('status', [
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('explorer-snapshot'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    status: z.literal('ready'),
    windowType: z.literal('explorer'),
    instanceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    hwnd: hwndSchema,
    path: z.string().min(1).max(4096),
    rect: rectSchema,
    foreground: z.literal(true),
    minimized: z.literal(false),
    search: z.literal(false)
  }).strict(),
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('explorer-snapshot'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    status: z.literal('ambiguous')
  }).strict(),
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('explorer-snapshot'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    status: z.literal('none')
  }).strict(),
  z.object({
    version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
    type: z.literal('explorer-snapshot'),
    nonce: nonceSchema,
    sequence: sequenceSchema,
    status: z.literal('unavailable')
  }).strict()
]);

const bridgeLineSchema = z.union([helloSchema, heartbeatSchema, responseSchema, snapshotSchema]);

const commandBase = {
  version: z.literal(EXPLORER_SPACE_PROTOCOL_VERSION),
  nonce: nonceSchema,
  requestId: requestIdSchema
};
const commandSchema = z.discriminatedUnion('command', [
  z.object({ ...commandBase, command: z.literal('start-observing') }).strict(),
  z.object({ ...commandBase, command: z.literal('stop-observing') }).strict(),
  z.object({ ...commandBase, command: z.literal('shutdown') }).strict()
]);

export type ExplorerBridgeLine = z.infer<typeof bridgeLineSchema>;
export type ExplorerBridgeCommand = z.infer<typeof commandSchema>;
export type ExplorerSnapshot = z.infer<typeof snapshotSchema>;

function protocolError(code: string): Error {
  return new Error(code);
}

export function parseBridgeLine(line: string): ExplorerBridgeLine {
  if (Buffer.byteLength(line, 'utf8') > EXPLORER_SPACE_MAX_LINE_BYTES) {
    throw protocolError('BRIDGE_LINE_TOO_LONG');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw protocolError('BRIDGE_JSON_INVALID');
  }
  const parsed = bridgeLineSchema.safeParse(decoded);
  if (!parsed.success) {
    throw protocolError('BRIDGE_PROTOCOL_INVALID');
  }
  return parsed.data;
}

export function serializeBridgeCommand(input: ExplorerBridgeCommand): string {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) {
    throw protocolError('BRIDGE_COMMAND_INVALID');
  }
  const line = `${JSON.stringify(parsed.data)}\n`;
  if (Buffer.byteLength(line, 'utf8') > EXPLORER_SPACE_MAX_LINE_BYTES) {
    throw protocolError('BRIDGE_LINE_TOO_LONG');
  }
  return line;
}

export function parseBridgeStderrLine(line: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(line)) {
    throw protocolError('BRIDGE_STDERR_INVALID');
  }
  return line;
}
