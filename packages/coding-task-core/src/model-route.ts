import { Effect, Schema } from 'effect';
import * as OpenAIChat from '@opencode-ai/llm/protocols/openai-chat';
import { Auth, Endpoint, HttpTransport, Protocol, Route } from '@opencode-ai/llm/route';
import type { CodingModelConnection } from './index';

const DeepSeekBody = Schema.Struct({
  ...OpenAIChat.bodyFields,
  thinking: Schema.Struct({ type: Schema.Literal('disabled') })
});
type DeepSeekBody = Schema.Schema.Type<typeof DeepSeekBody>;

/** DeepSeek 只扩展协议拥有的请求字段；消息降低与流解析完整复用 OpenAI Chat。 */
const deepSeekProtocol = Protocol.make({
  id: 'deepseek',
  body: {
    schema: DeepSeekBody,
    from: (request) => OpenAIChat.protocol.body.from(request).pipe(
      Effect.map(body => ({ ...body, thinking: { type: 'disabled' as const } }))
    )
  },
  stream: OpenAIChat.protocol.stream
});

const deepSeekRoute = Route.make({
  id: 'deepseek',
  provider: 'deepseek',
  protocol: deepSeekProtocol,
  endpoint: Endpoint.path(OpenAIChat.PATH, { baseURL: OpenAIChat.DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: HttpTransport.sseJson.with<DeepSeekBody>()
});

/** 将宿主连接映射为原 LLM Route，不改变 HTTP overlay 的协议字段禁止表。 */
export async function createCodingModel(connection: CodingModelConnection) {
  const route = connection.protocol === 'deepseek' ? deepSeekRoute : OpenAIChat.route;
  return route.with({
    endpoint: { baseURL: connection.baseUrl },
    auth: Auth.bearer(await connection.readCredential()),
    generation: { maxTokens: connection.outputTokens },
    limits: { context: connection.contextWindow, output: connection.outputTokens },
    http: { body: connection.requestBody ?? {} }
  }).model({ id: connection.modelId });
}
