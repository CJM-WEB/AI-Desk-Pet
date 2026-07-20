import { randomUUID } from 'node:crypto';
import { toolRequestSchema, type ToolRequest } from '@myself/shared-types';
import type { AgentEvent, RunContext } from './types';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class AgentLoop {
  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent> {
    if (context.signal.aborted) {
      yield { type: 'phase', phase: 'cancelled' };
      return;
    }

    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    let correctionUsed = false;
    yield { type: 'phase', phase: 'thinking' };

    for (let turn = 0; turn < 4; turn += 1) {
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
        yield { type: 'phase', phase: 'awaiting_confirmation' };
        yield {
          type: 'write_request',
          request,
          continuationToken: `continue_${randomUUID()}`
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
