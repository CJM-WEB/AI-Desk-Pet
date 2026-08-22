import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ProviderProfileV2 } from '@myself/shared-types';
import ts from 'typescript';
import { afterEach, describe, expect, test } from 'vitest';
import {
  SettingsStore,
  type McpServerSettings
} from '../src/main/storage/settings-store';

const temporaryDirectories: string[] = [];

const mcpSettingsFixture: readonly McpServerSettings[] = [
  {
    id: 'remote-tools',
    enabled: true,
    transport: {
      type: 'http',
      url: 'https://mcp.example.com',
      secretNames: ['Authorization']
    },
    tools: {
      search: {
        enabled: true,
        readOnly: true,
        description: '搜索',
        definitionFingerprint: 'a'.repeat(64),
        trustedReadFingerprint: 'b'.repeat(64)
      }
    }
  },
  {
    id: 'local-tools',
    enabled: false,
    transport: {
      type: 'stdio',
      command: 'node.exe',
      args: ['server.js', '--stdio'],
      cwd: 'D:\\mcp-tools',
      secretNames: ['TOKEN'],
      inheritEnv: ['PATH']
    },
    tools: {
      echo: {
        enabled: false,
        readOnly: true,
        description: '回显'
      }
    }
  }
];

const providerProfile: ProviderProfileV2 = {
  id: 'provider-main',
  displayName: '主 Provider',
  mode: 'custom' as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://api.example.com/v1',
  modelId: 'tools-model',
  additionalParameters: {},
  capabilities: ['chat', 'tools'],
  hasStoredSecret: false
};

const secondaryProviderProfile: ProviderProfileV2 = {
  ...providerProfile,
  id: 'provider-secondary',
  displayName: '备用 Provider'
};

type NonMcpMutationCase = Readonly<{
  methodName: string;
  prepare?: (store: SettingsStore) => Promise<void>;
  mutate: (store: SettingsStore) => Promise<unknown>;
  verify?: (store: SettingsStore) => Promise<void>;
}>;

type AtomicWriteMethods = Readonly<{
  settingsRewriteMethods: readonly string[];
  otherSettingsFileWriteMethods: readonly string[];
}>;

/**
 * 使用 TypeScript AST 锁定 SettingsStore 对共享设置文件的真实写调用，避免方法签名、
 * async 修饰符或复杂参数格式变化绕过完整性守卫。
 */
function collectAtomicWriteMethods(source: string): AtomicWriteMethods {
  const sourceFile = ts.createSourceFile(
    'settings-store.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const settingsRewriteMethods = new Set<string>();
  const otherSettingsFileWriteMethods = new Set<string>();
  const isAtomicWrite = (expression: ts.LeftHandSideExpression): boolean => (
    ts.isIdentifier(expression) && expression.text === 'atomicWrite'
  ) || (
    ts.isPropertyAccessExpression(expression)
    && expression.expression.kind === ts.SyntaxKind.ThisKeyword
    && expression.name.text === 'atomicWrite'
  );
  const isSettingsFile = (expression: ts.Expression | undefined): boolean => (
    expression !== undefined
    && ts.isPropertyAccessExpression(expression)
    && expression.expression.kind === ts.SyntaxKind.ThisKeyword
    && expression.name.text === 'file'
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== 'SettingsStore') continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
      const methodName = member.name.text;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && isAtomicWrite(node.expression)
          && isSettingsFile(node.arguments[0])
        ) {
          const value = node.arguments[1];
          if (value && ts.isIdentifier(value) && value.text === 'settings') {
            settingsRewriteMethods.add(methodName);
          } else {
            otherSettingsFileWriteMethods.add(methodName);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(member.body);
    }
  }

  return {
    settingsRewriteMethods: [...settingsRewriteMethods].sort(),
    otherSettingsFileWriteMethods: [...otherSettingsFileWriteMethods].sort()
  };
}

/**
 * 此矩阵锁定 SettingsStore 共享文件的全部普通原子写入口；新增入口必须显式证明
 * 不会在重写 settings.json 时丢失保留的 MCP 数据。
 */
const nonMcpMutationCases: readonly NonMcpMutationCase[] = [
  {
    methodName: 'saveProviderProfile',
    mutate: store => store.saveProviderProfile(providerProfile)
  },
  {
    methodName: 'saveModelRoute',
    prepare: store => store.saveProviderProfile(providerProfile),
    mutate: store => store.saveModelRoute({
      primaryProfileId: 'provider-main',
      chatProfileId: 'provider-main',
      agentProfileId: 'provider-main',
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    })
  },
  {
    methodName: 'deleteProviderProfile',
    prepare: async store => {
      await store.saveProviderProfile(providerProfile);
      await store.saveProviderProfile(secondaryProviderProfile);
      await store.saveModelRoute({
        primaryProfileId: 'provider-main',
        chatProfileId: 'provider-main',
        agentProfileId: 'provider-main',
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      });
    },
    mutate: store => store.deleteProviderProfile('provider-secondary'),
    verify: async store => {
      const snapshot = await store.getProviderSettings();
      expect(snapshot.profiles.map(profile => profile.id)).toEqual(['provider-main']);
      expect(snapshot.route).toEqual({
        primaryProfileId: 'provider-main',
        chatProfileId: 'provider-main',
        agentProfileId: 'provider-main',
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      });
    }
  },
  {
    methodName: 'savePrivacySettings',
    mutate: store => store.savePrivacySettings({
      dataCategories: {
        file: true,
        screenshot: false,
        clipboard: true,
        memory: false
      },
      longTermMemory: false,
      proactivityMode: 'passive'
    })
  },
  {
    methodName: 'saveMovementStopped',
    mutate: store => store.saveMovementStopped(true)
  },
  {
    methodName: 'savePetAlwaysOnTop',
    mutate: store => store.savePetAlwaysOnTop(true)
  },
  {
    methodName: 'revokeAuthorizedRoot',
    prepare: store => store.saveAuthorizedRoot({
      id: 'root-before-revoke',
      displayName: '授权目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    }),
    mutate: store => store.revokeAuthorizedRoot()
  },
  {
    methodName: 'saveProviderMetadata',
    mutate: store => store.saveProviderMetadata({
      id: 'legacy-provider',
      displayName: '兼容 Provider',
      baseUrl: 'https://legacy.example.com/v1',
      model: 'legacy-model'
    })
  },
  {
    methodName: 'saveAuthorizedRoot',
    mutate: store => store.saveAuthorizedRoot({
      id: 'root-main',
      displayName: '授权目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    })
  },
  {
    methodName: 'savePetPosition',
    mutate: store => store.savePetPosition({ x: 320, y: 240 })
  }
];

async function createStore(hasStoredSecret = false) {
  const directory = await mkdtemp(join(tmpdir(), 'myself-settings-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'settings.json');
  return {
    directory,
    file,
    store: new SettingsStore(file, async () => hasStoredSecret)
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SettingsStore', () => {
  test.each(nonMcpMutationCases)(
    '$methodName 原子重写共享设置时完整保留 MCP 配置',
    async ({ prepare, mutate, verify }) => {
      const { store } = await createStore();
      for (const settings of mcpSettingsFixture) {
        await store.saveMcpServerSettings(settings);
      }
      await prepare?.(store);

      await mutate(store);

      await expect(store.getMcpServerSettings()).resolves.toEqual(mcpSettingsFixture);
      await verify?.(store);
    }
  );

  test('普通原子写入口矩阵与 SettingsStore 生产方法保持完整对应', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/main/storage/settings-store.ts', import.meta.url)),
      'utf8'
    );
    const writes = collectAtomicWriteMethods(source);
    const mcpMethods = ['deleteMcpServerSettings', 'saveMcpServerSettings'];
    const productionMethods = writes.settingsRewriteMethods.filter(
      name => !mcpMethods.includes(name)
    );
    const matrixMethods = nonMcpMutationCases.map(item => item.methodName).sort();

    expect(productionMethods).toEqual(matrixMethods);
    expect(writes.settingsRewriteMethods.filter(name => mcpMethods.includes(name))).toEqual(
      mcpMethods
    );
    expect(writes.settingsRewriteMethods).toEqual([...matrixMethods, ...mcpMethods].sort());
    expect(writes.otherSettingsFileWriteMethods).toEqual(['clearAll', 'load']);
  });

  test('完整性守卫识别 async 与复杂参数的方法', () => {
    const source = `
export class SettingsStore {
  async futureMutation(
    { value }: Readonly<{ value: string }>
  ): Promise<void> {
    const settings = { value };
    await atomicWrite(this.file, settings);
  }
}`;
    expect(collectAtomicWriteMethods(source)).toEqual({
      settingsRewriteMethods: ['futureMutation'],
      otherSettingsFileWriteMethods: []
    });
  });

  test('首次读取返回版本化的安全默认值', async () => {
    const { store } = await createStore();

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
  });

  test('原子保存提供商元数据且绝不把密钥写入设置文件', async () => {
    const fixtureSecret = 'sk-task-five-fixture-never-persist';
    const { file, store } = await createStore(true);

    await store.saveProviderMetadata({
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      secret: fixtureSecret
    });

    const serialized = await readFile(file, 'utf8');
    expect(serialized).toContain('"version": 2');
    expect(serialized).not.toContain(fixtureSecret);
    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: {
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
        hasStoredSecret: true
      }
    }));
  });

  test('授权目录完整路径仅在 Main 存储中可读', async () => {
    const { store } = await createStore();

    await store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      authorizedRoot: {
        id: 'root-1',
        displayName: '工作目录',
        pathHint: 'D:\\…\\project'
      }
    }));
    await expect(store.getAuthorizedRootPath()).resolves.toBe('D:\\private\\project');
  });

  test('保存桌宠位置时保留其他设置', async () => {
    const { store } = await createStore(true);
    await store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });

    await store.savePetPosition({ x: 320, y: 240 });

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: { x: 320, y: 240 }
    }));
  });

  test('并发保存提供商与桌宠位置时不会丢失任一字段', async () => {
    const { store } = await createStore(true);
    await store.clearAll();

    await Promise.all([
      store.saveProviderMetadata({
        id: 'default',
        displayName: '示例服务',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model'
      }),
      store.savePetPosition({ x: 640, y: 480 })
    ]);

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: { x: 640, y: 480 }
    }));
  });

  test('并发保存授权目录与桌宠位置时不会丢失任一字段', async () => {
    const { store } = await createStore();
    await store.clearAll();

    await Promise.all([
      store.saveAuthorizedRoot({
        id: 'root-1',
        displayName: '工作目录',
        pathHint: 'D:\\…\\project',
        absolutePath: 'D:\\private\\project'
      }),
      store.savePetPosition({ x: 720, y: 540 })
    ]);

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      authorizedRoot: expect.objectContaining({ id: 'root-1' }),
      petPosition: { x: 720, y: 540 }
    }));
  });

  test('保存后紧接清除不会复活已清除的数据', async () => {
    const { store } = await createStore(true);

    const save = store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    const clear = store.clearAll();
    await Promise.all([save, clear]);

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
  });

  test('一次写入失败后后续事务仍可执行', async () => {
    const { file, store } = await createStore(true);
    const temporaryFile = `${file}.tmp`;
    await mkdir(temporaryFile, { recursive: true });

    await expect(store.savePetPosition({ x: 10, y: 20 })).rejects.toBeDefined();
    await rm(temporaryFile, { recursive: true, force: true });

    await expect(store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    })).resolves.toBeUndefined();
    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: null
    }));
  });

  test('公开读取会等待此前写事务稳定', async () => {
    const { store } = await createStore();
    const save = store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });

    const [publicSettings, authorizedRootPath] = await Promise.all([
      store.getPublic(),
      store.getAuthorizedRootPath()
    ]);
    await save;

    expect(publicSettings.authorizedRoot).toEqual({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project'
    });
    expect(authorizedRootPath).toBe('D:\\private\\project');
  });

  test('MCP 本地只读授权指纹可原子持久化并读取', async () => {
    const { store } = await createStore();
    const fingerprint = 'a'.repeat(64);

    await store.saveMcpServerSettings({
      id: 'local-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        secretNames: []
      },
      tools: {
        echo: {
          enabled: true,
          readOnly: true,
          description: '返回文本',
          definitionFingerprint: fingerprint,
          trustedReadFingerprint: fingerprint
        }
      }
    });

    await expect(store.getMcpServerSettings()).resolves.toEqual([
      expect.objectContaining({
        tools: {
          echo: expect.objectContaining({
            trustedReadFingerprint: fingerprint
          })
        }
      })
    ]);
  });

  test('损坏设置被隔离并回退到安全默认值', async () => {
    const { directory, file, store } = await createStore();
    await writeFile(file, '{broken-json', 'utf8');

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      version: 1,
      provider: null
    }));
    const files = await readdir(directory);
    expect(files.some(name => name.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  test('清除全部设置会移除 Provider、授权目录和窗口状态', async () => {
    const { store } = await createStore(true);
    await store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    await store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });
    await store.saveMcpServerSettings(mcpSettingsFixture[0]!);

    await store.clearAll();

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
    await expect(store.getAuthorizedRootPath()).resolves.toBeNull();
    await expect(store.getMcpServerSettings()).resolves.toEqual([]);
  });
});
