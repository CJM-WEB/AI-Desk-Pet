import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createTestMcpServer(toolNames: string[] = ['echo']): McpServer {
  const server = new McpServer({
    name: 'myself-http-test-server',
    version: '1.0.0'
  });
  for (const toolName of toolNames) {
    server.registerTool(
      toolName,
      {
        description: '返回 HTTP 输入文本',
        inputSchema: { text: z.string().min(1) },
        annotations: { readOnlyHint: true }
      },
      async ({ text }) => ({
        content: [{ type: 'text', text }]
      })
    );
  }
  server.registerResource(
    'http-resource',
    'test://http-resource',
    { mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, text: 'http-resource' }] })
  );
  server.registerPrompt(
    'http-prompt',
    { argsSchema: {} },
    async () => ({
      messages: [{
        role: 'user',
        content: { type: 'text', text: 'http-prompt' }
      }]
    })
  );
  return server;
}

export interface HttpMcpTestServer {
  url: string;
  authorizations: string[];
  readonly initializationCount: number;
  close(): Promise<void>;
}

export interface HttpMcpTestServerOptions {
  initializeDelayMs?: number;
  toolNames?: string[];
}

export interface RedirectingHttpTestServer {
  sourceUrl: string;
  authorizations: string[];
  readonly targetHits: number;
  close(): Promise<void>;
}

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('HTTP_TEST_SERVER_START_FAILED'));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise());
    server.closeAllConnections();
  });
}

export async function startRedirectingHttpTestServer(): Promise<RedirectingHttpTestServer> {
  let targetHits = 0;
  const authorizations: string[] = [];
  const targetServer = createServer((_request, response) => {
    targetHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const targetPort = await listenOnLoopback(targetServer);
  const sourceServer = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    response.writeHead(302, {
      location: `http://127.0.0.1:${targetPort}/redirect-target`
    });
    response.end();
  });
  const sourcePort = await listenOnLoopback(sourceServer);

  return {
    sourceUrl: `http://127.0.0.1:${sourcePort}/mcp`,
    authorizations,
    get targetHits() {
      return targetHits;
    },
    close: async () => {
      await closeHttpServer(sourceServer);
      await closeHttpServer(targetServer);
    }
  };
}

export async function startHttpMcpTestServer(
  expectedAuthorization: string,
  options: HttpMcpTestServerOptions = {}
): Promise<HttpMcpTestServer> {
  const authorizations: string[] = [];
  let initializationCount = 0;
  const httpServer = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization ?? '';
    authorizations.push(authorization);
    if (authorization !== expectedAuthorization) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end(`拒绝认证头：${authorization}`);
      return;
    }

    const mcpServer = createTestMcpServer(options.toolNames);
    const transport = new StreamableHTTPServerTransport();
    await mcpServer.connect(transport as unknown as Transport);
    try {
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      if (
        body
        && typeof body === 'object'
        && 'method' in body
        && body.method === 'initialize'
      ) {
        initializationCount += 1;
        if (options.initializeDelayMs) {
          await new Promise(resolvePromise => {
            setTimeout(resolvePromise, options.initializeDelayMs);
          });
        }
      }
      await transport.handleRequest(request, response, body);
    } finally {
      response.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
    }
  });

  const port = await listenOnLoopback(httpServer);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorizations,
    get initializationCount() {
      return initializationCount;
    },
    close: () => closeHttpServer(httpServer)
  };
}
