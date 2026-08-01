import { z } from 'zod';

import type {
  RelevanceClassifier,
  RelevanceInput,
  RelevanceSuggestion
} from '../ports.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().max(4096)
    }).passthrough()
  }).passthrough()).min(1).max(8)
}).passthrough();

const decisionSchema = z.object({
  decision: z.enum(['pass', 'review', 'reject'])
}).strict();

/** 通过 CloudBase OpenAI 兼容接口产生受约束的相关性信号。 */
export class CloudBaseRelevanceClassifier implements RelevanceClassifier {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async classify(input: RelevanceInput): Promise<RelevanceSuggestion> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            temperature: 0,
            max_tokens: 300,
            messages: [{
              role: 'system',
              content: '判断内容是否与 AI Pet 桌宠产品直接相关，只返回指定 JSON。'
            }, {
              role: 'user',
              content: JSON.stringify({
                title: input.title.slice(0, 500),
                body: input.body.slice(0, 4000)
              })
            }],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'ai_pet_relevance',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    decision: {
                      type: 'string',
                      enum: ['pass', 'review', 'reject']
                    }
                  },
                  required: ['decision']
                }
              }
            }
          }),
          signal: AbortSignal.timeout(20_000)
        }
      );
    } catch {
      throw new Error('RELEVANCE_UNAVAILABLE');
    }
    if (!response.ok) throw new Error('RELEVANCE_UNAVAILABLE');

    try {
      const payload = responseSchema.parse(await response.json());
      return decisionSchema.parse(
        JSON.parse(payload.choices[0]!.message.content)
      ).decision;
    } catch {
      throw new Error('RELEVANCE_RESPONSE_INVALID');
    }
  }
}
