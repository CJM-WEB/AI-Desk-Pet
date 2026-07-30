import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  disclosureCategorySchema,
  type DisclosureCategory,
} from './disclosure-policy';

const identifierSchema = z.string().min(1).max(128);
const eventIdSchema = z.string().uuid();

export const proactivityModeSchema = z.enum([
  'passive',
  'assistive',
  'autonomous',
]);

const approvedEventRegistrationSchema = z
  .object({
    sessionId: identifierSchema,
    eventType: identifierSchema,
    dataSource: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('authorized_root'),
          rootId: identifierSchema,
        })
        .strict(),
      z.object({ kind: z.literal('all_drives') }).strict(),
      z.object({ kind: z.literal('unbounded_source') }).strict(),
    ]),
  })
  .strict();

const explicitEvaluationSchema = z
  .object({
    explicitUserInstruction: z.literal(true),
    toolName: identifierSchema,
  })
  .strict();

const eventEvaluationSchema = z
  .object({
    explicitUserInstruction: z.literal(false),
    eventId: eventIdSchema,
    toolName: identifierSchema,
  })
  .strict();

const evaluationSchema = z.discriminatedUnion('explicitUserInstruction', [
  explicitEvaluationSchema,
  eventEvaluationSchema,
]);

const proactivityRuleSchema = z
  .object({
    id: identifierSchema,
    enabled: z.boolean(),
    eventType: identifierSchema,
    toolName: identifierSchema,
    sourceRootId: identifierSchema,
  })
  .strict();

const requiredDataScopeSchema = z
  .object({
    category: disclosureCategorySchema,
  })
  .strict();

const toolPolicySchema = z
  .object({
    risk: z.enum(['read', 'recoverable', 'high']),
    requiredDataScopes: z
      .array(requiredDataScopeSchema)
      .max(5)
      .superRefine((scopes, context) => {
        const categories = new Set<DisclosureCategory>();
        for (const scope of scopes) {
          if (categories.has(scope.category)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: '数据范围类别不得重复',
            });
          }
          categories.add(scope.category);
        }
      }),
  })
  .strict();

export type ProactivityMode = z.infer<typeof proactivityModeSchema>;

export type ProactivityRule = z.infer<typeof proactivityRuleSchema>;

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export type TrustedToolPolicy = ToolPolicy;

export type ProactivityEvaluation = z.infer<typeof evaluationSchema>;

export type ApprovedEventRegistration = z.infer<
  typeof approvedEventRegistrationSchema
>;

export type ApprovedEvent = {
  eventId: string;
  sessionId: string;
  eventType: string;
  sourceRootId: string;
  expiresAt: number;
};

export type ProactivityDecision =
  | { decision: 'respond'; code: 'PROACTIVITY_USER_DIRECTED' }
  | { decision: 'ignore'; code: 'PROACTIVITY_EXPLICIT_INSTRUCTION_REQUIRED' }
  | { decision: 'suggest'; code: 'PROACTIVITY_SUGGEST_ONLY' }
  | { decision: 'execute'; code: 'PROACTIVITY_RULE_ALLOWED' }
  | {
      decision: 'require_confirmation';
      code: 'PROACTIVITY_CONFIRMATION_REQUIRED';
    }
  | {
      decision: 'deny';
      code:
        | 'PROACTIVITY_INPUT_INVALID'
        | 'PROACTIVITY_EVENT_UNKNOWN'
        | 'PROACTIVITY_EVENT_EXPIRED'
        | 'PROACTIVITY_EVENT_SESSION_MISMATCH'
        | 'PROACTIVITY_TOOL_UNKNOWN'
        | 'PROACTIVITY_TOOL_POLICY_INVALID'
        | 'PROACTIVITY_RULE_NOT_MATCHED'
        | 'PROACTIVITY_DATA_NOT_AUTHORIZED';
    };

type StoredApprovedEvent = ApprovedEvent;

export type ApprovedEventRegistryOptions = {
  now?: () => number;
  eventTtlMs?: number;
  maxEvents?: number;
};

type ApprovedEventResolution =
  | { status: 'ok'; event: ApprovedEvent }
  | { status: 'unknown' | 'expired' | 'session_mismatch' };

/**
 * Main 内部可信事件注册表。
 *
 * 订阅层只把不透明 eventId 交给后续请求，事件类型、来源根目录和会话归属
 * 始终从此注册表解析，避免请求方伪造自主执行依据。
 */
export class ApprovedEventRegistry {
  private readonly now: () => number;

  private readonly eventTtlMs: number;

  private readonly maxEvents: number;

  private readonly events = new Map<string, StoredApprovedEvent>();

  constructor(options: ApprovedEventRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.eventTtlMs = options.eventTtlMs ?? 60_000;
    this.maxEvents = options.maxEvents ?? 500;

    if (
      !Number.isSafeInteger(this.eventTtlMs) ||
      this.eventTtlMs <= 0 ||
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents <= 0
    ) {
      throw new Error('APPROVED_EVENT_CONFIG_INVALID');
    }
  }

  register(input: ApprovedEventRegistration): string {
    const parsed = approvedEventRegistrationSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('APPROVED_EVENT_INVALID');
    }

    if (parsed.data.dataSource.kind !== 'authorized_root') {
      throw new Error('APPROVED_EVENT_UNBOUNDED_SOURCE_DENIED');
    }

    this.removeExpired();
    if (this.events.size >= this.maxEvents) {
      throw new Error('APPROVED_EVENT_LIMIT_EXCEEDED');
    }

    const eventId = randomUUID();
    this.events.set(eventId, {
      eventId,
      sessionId: parsed.data.sessionId,
      eventType: parsed.data.eventType,
      sourceRootId: parsed.data.dataSource.rootId,
      expiresAt: this.now() + this.eventTtlMs,
    });
    return eventId;
  }

  resolve(eventIdInput: string, sessionIdInput: string): ApprovedEventResolution {
    const eventId = eventIdSchema.safeParse(eventIdInput);
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    if (!eventId.success || !sessionId.success) {
      return { status: 'unknown' };
    }

    const event = this.events.get(eventId.data);
    if (!event) {
      return { status: 'unknown' };
    }
    if (event.expiresAt <= this.now()) {
      this.events.delete(event.eventId);
      return { status: 'expired' };
    }
    if (event.sessionId !== sessionId.data) {
      return { status: 'session_mismatch' };
    }

    return { status: 'ok', event: { ...event } };
  }

  consume(eventId: string, sessionId: string): boolean {
    const resolution = this.resolve(eventId, sessionId);
    if (resolution.status !== 'ok') {
      return false;
    }
    return this.events.delete(resolution.event.eventId);
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [eventId, event] of this.events) {
      if (event.expiresAt <= now) {
        this.events.delete(eventId);
      }
    }
  }
}

export type ProactivityPolicyOptions = {
  mode?: ProactivityMode;
  rules?: readonly ProactivityRule[];
  approvedEvents: ApprovedEventRegistry;
  resolveToolPolicy: (toolName: string) => ToolPolicy | null;
  isScopeAuthorized: (
    sessionId: string,
    category: DisclosureCategory,
    sourceRootId: string,
  ) => boolean;
};

/**
 * 主动性决策只消费 Main 注入的规则、工具风险、数据授权和可信事件。
 * 本模块不改变 Agent Core 的确认或拒绝语义，只返回可复用的策略结果。
 */
export class ProactivityPolicy {
  private mode: ProactivityMode;

  private rules: ProactivityRule[];

  constructor(private readonly options: ProactivityPolicyOptions) {
    this.mode = this.parseMode(
      options.mode === undefined ? 'assistive' : options.mode,
    );
    this.rules = this.parseRules(options.rules ?? []);
  }

  setMode(mode: ProactivityMode): void {
    this.mode = this.parseMode(mode);
  }

  setRules(rules: readonly ProactivityRule[]): void {
    this.rules = this.parseRules(rules);
  }

  evaluate(
    sessionIdInput: string,
    input: ProactivityEvaluation,
  ): ProactivityDecision {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    const evaluation = evaluationSchema.safeParse(input);
    if (!sessionId.success || !evaluation.success) {
      return { decision: 'deny', code: 'PROACTIVITY_INPUT_INVALID' };
    }

    if (evaluation.data.explicitUserInstruction) {
      return {
        decision: 'respond',
        code: 'PROACTIVITY_USER_DIRECTED',
      };
    }

    const eventResolution = this.options.approvedEvents.resolve(
      evaluation.data.eventId,
      sessionId.data,
    );
    if (eventResolution.status !== 'ok') {
      return {
        decision: 'deny',
        code: this.eventResolutionCode(eventResolution.status),
      };
    }

    switch (this.mode) {
      case 'passive':
        return {
          decision: 'ignore',
          code: 'PROACTIVITY_EXPLICIT_INSTRUCTION_REQUIRED',
        };
      case 'assistive':
        return { decision: 'suggest', code: 'PROACTIVITY_SUGGEST_ONLY' };
      case 'autonomous':
        break;
      default:
        return this.assertNeverMode(this.mode);
    }

    let rawToolPolicy: ToolPolicy | null;
    try {
      rawToolPolicy = this.options.resolveToolPolicy(evaluation.data.toolName);
    } catch {
      return { decision: 'deny', code: 'PROACTIVITY_TOOL_UNKNOWN' };
    }
    if (!rawToolPolicy) {
      return { decision: 'deny', code: 'PROACTIVITY_TOOL_UNKNOWN' };
    }

    const toolPolicy = toolPolicySchema.safeParse(rawToolPolicy);
    if (!toolPolicy.success) {
      return { decision: 'deny', code: 'PROACTIVITY_TOOL_POLICY_INVALID' };
    }

    const event = eventResolution.event;
    const matchedRule = this.rules.some(
      (rule) =>
        rule.enabled &&
        rule.eventType === event.eventType &&
        rule.toolName === evaluation.data.toolName &&
        rule.sourceRootId === event.sourceRootId,
    );
    if (!matchedRule) {
      return { decision: 'deny', code: 'PROACTIVITY_RULE_NOT_MATCHED' };
    }

    const scopesAuthorized = toolPolicy.data.requiredDataScopes.every(
      ({ category }) => {
        try {
          return this.options.isScopeAuthorized(
            sessionId.data,
            category,
            event.sourceRootId,
          );
        } catch {
          return false;
        }
      },
    );
    if (!scopesAuthorized) {
      return { decision: 'deny', code: 'PROACTIVITY_DATA_NOT_AUTHORIZED' };
    }

    if (toolPolicy.data.risk !== 'read') {
      return {
        decision: 'require_confirmation',
        code: 'PROACTIVITY_CONFIRMATION_REQUIRED',
      };
    }

    if (
      !this.options.approvedEvents.consume(
        evaluation.data.eventId,
        sessionId.data,
      )
    ) {
      return { decision: 'deny', code: 'PROACTIVITY_EVENT_UNKNOWN' };
    }

    return { decision: 'execute', code: 'PROACTIVITY_RULE_ALLOWED' };
  }

  private parseRules(rules: readonly ProactivityRule[]): ProactivityRule[] {
    return rules.map((rule) => {
      const parsed = proactivityRuleSchema.safeParse(rule);
      if (!parsed.success) {
        throw new Error('PROACTIVITY_RULE_INVALID');
      }
      return parsed.data;
    });
  }

  private parseMode(mode: unknown): ProactivityMode {
    const parsed = proactivityModeSchema.safeParse(mode);
    if (!parsed.success) {
      throw new Error('PROACTIVITY_MODE_INVALID');
    }
    return parsed.data;
  }

  private assertNeverMode(mode: never): never {
    throw new Error('PROACTIVITY_MODE_INVALID');
  }

  private eventResolutionCode(
    status: Exclude<ApprovedEventResolution['status'], 'ok'>,
  ):
    | 'PROACTIVITY_EVENT_UNKNOWN'
    | 'PROACTIVITY_EVENT_EXPIRED'
    | 'PROACTIVITY_EVENT_SESSION_MISMATCH' {
    if (status === 'expired') {
      return 'PROACTIVITY_EVENT_EXPIRED';
    }
    if (status === 'session_mismatch') {
      return 'PROACTIVITY_EVENT_SESSION_MISMATCH';
    }
    return 'PROACTIVITY_EVENT_UNKNOWN';
  }
}
