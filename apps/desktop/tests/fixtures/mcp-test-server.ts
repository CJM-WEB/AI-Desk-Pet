import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const stderrBytes = Number(process.env['MCP_STDERR_BYTES'] ?? 0);
if (stderrBytes > 0) process.stderr.write('e'.repeat(stderrBytes));

const server = new McpServer(
  { name: 'myself-mcp-test-server', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  }
);

server.registerTool(
  'echo',
  {
    description: '返回输入文本',
    inputSchema: { text: z.string().min(1) },
    annotations: { readOnlyHint: true }
  },
  async ({ text }) => ({
    content: [{ type: 'text', text }]
  })
);

server.registerTool(
  'environment',
  {
    description: '返回测试环境可见性',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        allowed: process.env['MCP_ALLOWED'] ?? null,
        hasSensitive: process.env['MCP_TEST_SECRET'] !== undefined,
        path: process.env['PATH'] || null,
        cwd: process.cwd()
      })
    }]
  })
);

server.registerTool(
  'delayed',
  {
    description: '延迟返回',
    inputSchema: { delayMs: z.number().int().min(1).max(10_000) }
  },
  async ({ delayMs }, extra) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      extra.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('已取消'));
      }, { once: true });
    });
    return { content: [{ type: 'text', text: 'done' }] };
  }
);

server.registerTool(
  'large-output',
  {
    description: '返回超限输出',
    inputSchema: { size: z.number().int().min(1).max(100_000) }
  },
  async ({ size }) => ({
    content: [{ type: 'text', text: 'x'.repeat(size) }]
  })
);

server.registerTool(
  'crash',
  {
    description: '终止当前测试服务',
    inputSchema: {}
  },
  async () => {
    setTimeout(() => process.exit(23), 0);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    return { content: [{ type: 'text', text: 'unreachable' }] };
  }
);

server.registerResource(
  'test-resource',
  'test://resource',
  { description: '测试资源', mimeType: 'text/plain' },
  async uri => ({
    contents: [{ uri: uri.href, text: 'resource-content' }]
  })
);

server.registerPrompt(
  'test-prompt',
  { description: '测试提示词', argsSchema: { subject: z.string().optional() } },
  async ({ subject }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `prompt:${subject ?? 'default'}` }
    }]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
