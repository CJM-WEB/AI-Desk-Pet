import { randomUUID } from 'node:crypto';
import { toolRequestSchema, type ToolRequest } from '@myself/shared-types';
import type { AgentEvent, ModelMessage, RunContext } from './types';

type ContinuationState = {
  messages: ModelMessage[];
  nextTurn: number;
  requestId: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class AgentLoop {
  private readonly continuations = new Map<string, ContinuationState>();

  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent> {
    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    yield* this.continueRun(messages, 0, context);
  }

  async *resume(
    continuationToken: string,
    toolResult: unknown,
    context: RunContext
  ): AsyncGenerator<AgentEvent> {
    const continuation = this.continuations.get(continuationToken);
    if (!continuation) throw new Error('ACTION_EXPIRED');
    this.continuations.delete(continuationToken);

    continuation.messages.push({
      role: 'tool',
      toolCallId: continuation.requestId,
      content: JSON.stringify(toolResult)
    });
    if (continuation.nextTurn >= 4) {
      yield { type: 'message', text: '本地文件操作已完成；已达到模型响应轮次上限。' };
      yield { type: 'phase', phase: 'success' };
      return;
    }
    yield* this.continueRun(continuation.messages, continuation.nextTurn, context);
  }

  discard(continuationToken: string): void {
    this.continuations.delete(continuationToken);
  }

  private async *continueRun(
    messages: ModelMessage[],
    startTurn: number,
    context: RunContext
  ): AsyncGenerator<AgentEvent> {
    if (context.signal.aborted) {
      yield { type: 'phase', phase: 'cancelled' };
      return;
    }

    let correctionUsed = false;
    yield { type: 'phase', phase: 'thinking' };

    for (let turn = startTurn; turn < 4; turn += 1) {
      if (context.signal.aborted) {
        yield { type: 'phase', phase: 'cancelled' };
        return;
      }

      let response;
      try {
        response = await context.provider.respond({ messages, tools: context.tools }, context.signal);
      } catch (error) {
        if (context.signal.aborted || isAbortError(error)) {
          yield { type: 'phase', phase: 'cancelled' };
          return;
        }
        throw error;
      }

      if (response.type === 'text') {
        yield { type: 'message', text: response.text };
        yield { type: 'phase', phase: 'success' };
        return;
      }

      const parsedRequest = toolRequestSchema.safeParse(response.request);
      if (!parsedRequest.success) {
        if (correctionUsed) throw new Error('AGENT_INVALID_TOOL_REQUEST');
        correctionUsed = true;
        messages.push({
          role: 'system',
          content: 'INVALID_TOOL_REQUEST：只能调用已提供的工具，并且参数必须符合 Schema。请修正一次。'
        });
        continue;
      }

      const request: ToolRequest = parsedRequest.data;
      messages.push({ role: 'assistant', content: '', toolRequest: request });
      if (context.writeTools.has(request.toolName)) {
        const continuationToken = `continue_${randomUUID()}`;
        this.continuations.set(continuationToken, {
          messages: [...messages],
          nextTurn: turn + 1,
          requestId: request.requestId
        });
        yield { type: 'phase', phase: 'awaiting_confirmation' };
        yield {
          type: 'write_request',
          request,
          continuationToken
        };
        return;
      }

      yield { type: 'phase', phase: 'acting' };
      const result = await context.executor.executeRead(request);
      messages.push({
        role: 'tool',
        toolCallId: request.requestId,
        content: JSON.stringify(result)
      });
    }

    throw new Error('AGENT_MAX_TURNS');
  }
}
