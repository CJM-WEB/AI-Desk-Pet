import { createServer } from 'node:http';
import { once } from 'node:events';

import { createMemoryWebsiteApi } from '../memory-website-api.mjs';
import {
  decodeContractResponse,
  runWebsiteApiContract,
  type WebsiteApiDriver,
} from './website-api-contract';

async function createMemoryDriver(): Promise<WebsiteApiDriver> {
  const memoryApi = createMemoryWebsiteApi({ runId: 'website-contract' });
  const server = createServer(async (request, response) => {
    if (!await memoryApi.handle(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合同 HTTP 端口不可用');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    reset: async () => memoryApi.reset(),
    request: async input => {
      const response = await fetch(new URL(input.path, origin), {
        method: input.method,
        headers: {
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(input.headers ?? {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return decodeContractResponse(response.status, await response.json());
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

runWebsiteApiContract('Memory localhost Adapter', createMemoryDriver);
