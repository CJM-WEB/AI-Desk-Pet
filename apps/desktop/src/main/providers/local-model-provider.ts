import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import {
  OpenAICompatibleProvider,
  ProviderError,
  type FetchLike,
  type OpenAIRequestPolicy
} from './openai-provider';
import { ProviderResponseError } from './provider-response-error';
import { conversationTaskInstructions } from '../conversation/conversation-chat-adapter';
import { throwIfCancelled } from '../conversation/character-expression-adapter';
import { createLocalConversationTextStream, LOCAL_DECISION_JSON_BYTE_BUDGET, LOCAL_THINKING_TAG_PATTERN } from './local-conversation-text-stream';

export interface LocalModelConnection {
  generation: string;
  baseUrl: string;
  token: string;
  modelId: string;
}

export interface LocalModelConnectionPort {
  getReadyConnection(): LocalModelConnection;
}

const localRequestBody = {
  stream: false,
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
  parallel_tool_calls: false,
  parse_tool_calls: true
} as const;

const LOCAL_INPUT_TOKEN_BUDGET = 6_400;
const CONSERVATIVE_UTF8_BYTES_PER_TOKEN = 3;
const LOCAL_READ_RESULT_CHARACTER_BUDGET = 4_000;
const conversationDecisionJsonSchema = { anyOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['task'] }, text: { type: 'string', enum: [''] }
  }, required: ['kind', 'text'] },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['chat'] }, text: { type: 'string', minLength: 1, maxLength: 4000 }
  }, required: ['kind', 'text'] }
] };
const conversationDecisionInstructions = '你负责桌宠应用的聊天回复与任务分派。结合当前用户原文和历史，只输出JSON对象。'
  + '用户要求实际查看目录或子目录、读取文件内容、修改文件、执行命令，或同意此前的查看建议时，输出{"kind":"task","text":""}。Main会展示任务范围卡，用户确认后才执行。不能再次口头询问，不能编造已执行的结果。'
  + '直接询问磁盘事实也是查阅任务：“目录下有什么”“a文件夹里有哪些文件”“文件写了什么”都选task。申请时无需先知道当前目录、文件内容或已有许可，Main负责绑定目录并确认范围；不能因为尚未查看而改成chat重复索要许可。'
  + '闲聊、询问是否需要整理、征求整理建议、讨论操作方法、引用示例，以及明确拒绝操作时，输出{"kind":"chat","text":"普通回复"}。角色人设仅影响普通回复的语气。'
  + '“查看这个文件夹里有什么”属于task；“这个目录需要整理吗”属于chat，说明尚未查看并征求同意；“可以，去看看”承接建议属于task；“看吧，看看里面写了什么”承接上文文件属于task；“不要查看，只告诉我如何整理”属于chat。'
  + '历史帮助理解目标，不继承许可，也不证明文件当前内容。';

/** 私有判别仅接纳完整宿主入口；人设、用户文本和其他工具不能触发协议替换。 */
function createConversationDecisionRequest(request: ModelRequest): ModelRequest | undefined {
  const tool = request.tools[0];
  if (request.purpose !== 'conversation' || request.toolChoice !== 'auto'
    || request.responseContract !== undefined
    || request.tools.length !== 1 || tool?.type !== 'function'
    || tool.function.name !== 'request_task_authorization'
    || !isDeepStrictEqual(tool.function.parameters, { type: 'object', additionalProperties: false, properties: {}, required: [] })
    || request.messages.filter(message => message.role === 'system' && message.content === conversationTaskInstructions).length !== 1) return;
  return { ...request, tools: [], toolChoice: 'none', messages: request.messages.map(message =>
    message.role === 'system' && message.content === conversationTaskInstructions
      ? { ...message, content: conversationDecisionInstructions } : message) };
}

/** 完整解析后只保留两字段决定；失败不恢复原文，也不接受任何模型许可字段。 */
function decodeConversationDecision(response: ModelResponse): { kind: 'task' | 'chat'; text: string } {
  const invalid = () => new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
  if (response.type !== 'text' || Buffer.byteLength(response.text, 'utf8') > LOCAL_DECISION_JSON_BYTE_BUDGET) throw invalid();
  let value: unknown;
  try { value = JSON.parse(response.text); } catch { throw invalid(); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 2) throw invalid();
  const kind: unknown = Reflect.get(value, 'kind');
  const text: unknown = Reflect.get(value, 'text');
  if (typeof text !== 'string' || (kind !== 'task' && kind !== 'chat')
    || (kind === 'task' ? text !== '' : !text.trim() || Array.from(text).length > 4000)) throw invalid();
  // 转义后的正文也检查思考标签，防止JSON转义绕过传输层原文检查。
  if (LOCAL_THINKING_TAG_PATTERN.test(text)) throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
  return { kind, text };
}

/** Qwen 角色模板只允许首条 system；各段保留系统身份，文件工具请求不改布局。 */
function mergeCharacterSystemMessages(request: ModelRequest): ModelRequest {
  if (request.responseContract === undefined && request.purpose !== 'conversation') return request;
  const systems = request.messages.filter(message => message.role === 'system');
  if (systems.length === 0 || systems.length === 1 && request.messages[0]?.role === 'system') return request;
  return {
    ...request,
    messages: [
      { role: 'system', content: systems.map(message => message.content).join('\n\n') },
      ...request.messages.filter(message => message.role !== 'system')
    ]
  };
}

function boundLocalReadResult(content: string): Readonly<{ content: string; lineCount: number }> {
  if (content.length <= LOCAL_READ_RESULT_CHARACTER_BUDGET) {
    return { content, lineCount: content.length === 0 ? 0 : content.split('\n').length };
  }
  const lines = content.split('\n');
  const retained: string[] = [];
  let characters = 0;
  for (const line of lines) {
    const nextCharacters = characters + (retained.length === 0 ? 0 : 1) + line.length;
    if (nextCharacters > LOCAL_READ_RESULT_CHARACTER_BUDGET) {
      // 首行本身超限时仍保留一行的明确字符截断，避免把非空文件伪装成零行。
      if (retained.length === 0) {
        retained.push(line.slice(0, LOCAL_READ_RESULT_CHARACTER_BUDGET));
      }
      break;
    }
    retained.push(line);
    characters = nextCharacters;
  }
  return { content: retained.join('\n'), lineCount: retained.length };
}

/** 仅本地请求压缩当前读取结果；云 Provider 的公开上限保持不变。 */
function applyLocalToolResultBudget(messages: ModelRequest['messages']): ModelRequest['messages'] {
  let changed = false;
  const bounded = messages.map(message => {
    if (message.role !== 'tool') return message;
    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (
      typeof result !== 'object'
      || result === null
      || Array.isArray(result)
      || Reflect.get(result, 'toolName') !== 'read_file'
      || typeof Reflect.get(result, 'content') !== 'string'
    ) return message;
    const originalContent = Reflect.get(result, 'content') as string;
    const next = boundLocalReadResult(originalContent);
    if (next.content === originalContent) return message;
    const startLine = Reflect.get(result, 'startLine');
    changed = true;
    return {
      ...message,
      content: JSON.stringify({
        ...result,
        content: next.content,
        ...(Number.isSafeInteger(startLine)
          ? { endLine: (startLine as number) + next.lineCount - 1 }
          : {}),
        truncated: true
      })
    };
  });
  return changed ? bounded : messages;
}

function estimateInputTokens(request: ModelRequest, messages: readonly ModelRequest['messages'][number][], responseSchema?: Readonly<Record<string, unknown>>): number {
  const serialized = JSON.stringify({
    messages,
    tools: request.tools,
    responseSchema: responseSchema ?? request.responseContract?.jsonSchema ?? null
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / CONSERVATIVE_UTF8_BYTES_PER_TOKEN);
}

/**
 * 本地 8192 上下文只从最早完整回合开始删除；系统、当前用户、最近完整回合与工具链保持原样。
 * 受保护内容自身超预算时仍完整发送，不以截断用户正文换取表面达标。
 */
function applyLocalContextBudget(request: ModelRequest, responseSchema?: Readonly<Record<string, unknown>>): ModelRequest {
  const locallyBoundedMessages = applyLocalToolResultBudget(request.messages);
  const boundedRequest = locallyBoundedMessages === request.messages
    ? request
    : { ...request, messages: locallyBoundedMessages };
  if (estimateInputTokens(boundedRequest, locallyBoundedMessages, responseSchema) <= LOCAL_INPUT_TOKEN_BUDGET) {
    return boundedRequest;
  }

  const groups: number[][] = [];
  let currentGroup: number[] | null = null;
  locallyBoundedMessages.forEach((message, index) => {
    if (message.role === 'system') return;
    if (message.role === 'user') {
      if (currentGroup !== null) groups.push(currentGroup);
      currentGroup = [index];
      return;
    }
    currentGroup ??= [];
    currentGroup.push(index);
  });
  if (currentGroup !== null) groups.push(currentGroup);

  // 最后组包含当前用户及本轮工具链；倒数第二组是最近完整历史回合。
  const removableGroups = groups.slice(0, Math.max(0, groups.length - 2));
  const removed = new Set<number>();
  let messages = locallyBoundedMessages;
  for (const group of removableGroups) {
    if (estimateInputTokens(boundedRequest, messages, responseSchema) <= LOCAL_INPUT_TOKEN_BUDGET) break;
    group.forEach(index => removed.add(index));
    messages = locallyBoundedMessages.filter((_message, index) => !removed.has(index));
  }
  return messages === request.messages ? request : { ...request, messages };
}

function assertCurrentGeneration(
  connectionPort: LocalModelConnectionPort,
  generation: string
): void {
  try {
    if (connectionPort.getReadyConnection().generation === generation) return;
  } catch {
    // 取得初始连接后的任何非 ready 状态都表示本次调用已经失效。
  }
  throw new ProviderError('LOCAL_MODEL_CONNECTION_STALE', false);
}

function assertLocalResponse(raw: unknown, conversationDecision: boolean): void {
  if (typeof raw !== 'object' || raw === null) return;
  const choices = Reflect.get(raw, 'choices');
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = Reflect.get(choice, 'message');
    if (typeof message !== 'object' || message === null) continue;
    const content = Reflect.get(message, 'content');
    if (
      Object.prototype.hasOwnProperty.call(message, 'reasoning_content')
      || (typeof content === 'string' && LOCAL_THINKING_TAG_PATTERN.test(content))
    ) {
      throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
    }
    const toolCalls = Reflect.get(message, 'tool_calls');
    if (conversationDecision && Object.prototype.hasOwnProperty.call(message, 'tool_calls')
      && (!Array.isArray(toolCalls) || toolCalls.length > 0)) {
      throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
    }
  }
}

function createRequestPolicy(
  connectionPort: LocalModelConnectionPort,
  generation: string,
  request: ModelRequest,
  conversationDecision: boolean
): OpenAIRequestPolicy {
  const responseSchema = conversationDecision ? conversationDecisionJsonSchema : request.responseContract?.jsonSchema;
  // 表现是结构化控制选择，复用本地任务判别的确定性采样；普通正文与其他 Provider 不受影响。
  const characterDecision = request.responseContract?.name === 'character_expression'
    || request.responseContract?.name === 'character_autonomy';
  return {
    body: {
      ...localRequestBody,
      stream: conversationDecision && request.onTextDelta !== undefined,
      ...(conversationDecision || characterDecision || request.toolChoice === 'required' ? { temperature: 0 } : {}),
      // 锁定的 llama.cpp 支持在 json_object 中附带 Schema；只约束本地结构化回合。
      ...(responseSchema === undefined
        ? {}
        : {
            response_format: {
              type: 'json_object',
              schema: responseSchema
            }
          })
    },
    validateResponse(raw: unknown): void {
      assertCurrentGeneration(connectionPort, generation);
      assertLocalResponse(raw, conversationDecision);
    }
  };
}

/** 本地模型只复用 OpenAI 传输协议；连接有效性与非思考约束始终由 Main 强制。 */
export class LocalModelProvider implements ModelProvider {
  constructor(
    private readonly connectionPort: LocalModelConnectionPort,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const decisionRequest = createConversationDecisionRequest(request);
    if (decisionRequest) throwIfCancelled(signal);
    const budgetedRequest = applyLocalContextBudget(mergeCharacterSystemMessages(decisionRequest ?? request),
      decisionRequest ? conversationDecisionJsonSchema : undefined);
    const connection = this.connectionPort.getReadyConnection();
    const onTextDelta = decisionRequest && request.onTextDelta
      ? createLocalConversationTextStream(delta => {
        throwIfCancelled(signal);
        assertCurrentGeneration(this.connectionPort, connection.generation);
        request.onTextDelta!(delta);
      }) : undefined;
    const provider = new OpenAICompatibleProvider(
      {
        baseUrl: connection.baseUrl,
        modelId: connection.modelId
      },
      async () => {
        assertCurrentGeneration(this.connectionPort, connection.generation);
        return connection.token;
      },
      this.fetchClient,
      createRequestPolicy(this.connectionPort, connection.generation, budgetedRequest, decisionRequest !== undefined)
    );
    try {
      const response = await provider.respond({
        ...budgetedRequest,
        ...(onTextDelta ? { onTextDelta } : {}),
        reasoningMode: 'disabled'
      }, signal);
      if (!decisionRequest) return response;
      const decision = decodeConversationDecision(response);
      // 决定不继承许可；完整校验及失效检查通过后才生成一次性申请关联ID。
      throwIfCancelled(signal);
      assertCurrentGeneration(this.connectionPort, connection.generation);
      return decision.kind === 'chat' ? { type: 'text', text: decision.text }
        : { type: 'tool_request', request: { requestId: randomUUID(), toolName: 'request_task_authorization', arguments: {} } };
    } catch (error) {
      assertCurrentGeneration(this.connectionPort, connection.generation);
      throw error;
    }
  }
}
