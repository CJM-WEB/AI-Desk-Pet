import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ProviderProfileV2 } from '@myself/shared-types';
import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_WORKSHOP_LAYOUT,
  workshopLayoutSettingsSchema
} from '../src/shared/workshop-layout-ipc';
import {
  SettingsStore,
  type McpServerSettings
} from '../src/main/storage/settings-store';
import { localModelPublicStatusSchema } from '../src/shared/local-model-ipc';

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
  prepare?: (store: SettingsStore, file: string) => Promise<void>;
  mutate: (store: SettingsStore, file: string) => Promise<unknown>;
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
        memory: false
      },
      longTermMemory: false,
      proactivityMode: 'passive'
    })
  },
  {
    methodName: 'saveMovementMode',
    mutate: store => store.saveMovementMode(0)
  },
  {
    methodName: 'savePetAlwaysOnTop',
    mutate: store => store.savePetAlwaysOnTop(true)
  },
  {
    methodName: 'saveLocalModelEnabled',
    mutate: store => store.saveLocalModelEnabled(false)
  },
  {
    methodName: 'saveWorkshopLayout',
    mutate: store => store.saveWorkshopLayout({
      leftWidth: 320,
      rightWidth: 280,
      sidebarTopHeight: 260,
      stageHeight: 420
    })
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
    methodName: 'savePetPlacement',
    mutate: store => store.savePetPlacement({
      characterId: 'pet-a',
      scale: 1,
      footAnchorDip: { x: 410, y: 460 },
      displayId: 'display-1'
    })
  },
  {
    methodName: 'commitPetPlacementMigration',
    prepare: async (_store, file) => writeLegacyV2Position(file, { x: 320, y: 240 }),
    mutate: store => store.commitPetPlacementMigration({
      expectedWindowPosition: { x: 320, y: 240 },
      placement: {
        characterId: 'pet-a',
        scale: 1,
        footAnchorDip: { x: 410, y: 420 },
        displayId: 'display-1'
      }
    })
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

/** 兼容迁移测试只构造历史磁盘格式，不重新暴露已退役的运行时写入口。 */
async function writeLegacyV2Position(
  file: string,
  petPosition: Readonly<{ x: number; y: number }>
): Promise<void> {
  await writeFile(file, JSON.stringify({
    version: 2,
    providerProfiles: [],
    modelRoute: {
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    },
    authorizedRoot: null,
    petPosition,
    fileDisclosureAccepted: false,
    mcpServers: mcpSettingsFixture
  }), 'utf8');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SettingsStore', () => {
  test('本地模型公开状态拒绝未声明字段', () => {
    expect(localModelPublicStatusSchema.parse({
      enabled: true,
      phase: 'ready',
      backend: 'vulkan',
      reasonCode: null
    })).toEqual(expect.objectContaining({ phase: 'ready' }));
    expect(() => localModelPublicStatusSchema.parse({
      enabled: true,
      phase: 'ready',
      backend: 'vulkan',
      reasonCode: null,
      port: 61234
    })).toThrow();
  });

  test.each(nonMcpMutationCases)(
    '$methodName 原子重写共享设置时完整保留 MCP 配置',
    async ({ prepare, mutate, verify }) => {
      const { file, store } = await createStore();
      for (const settings of mcpSettingsFixture) {
        await store.saveMcpServerSettings(settings);
      }
      await prepare?.(store, file);

      await mutate(store, file);

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
      authorizedRoot: null
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
    expect(serialized).toContain('"version": 6');
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
      authorizedRoot: null
    });
  });

  test('一次写入失败后后续事务仍可执行', async () => {
    const { file, store } = await createStore(true);
    const temporaryFile = `${file}.tmp`;
    await mkdir(temporaryFile, { recursive: true });

    await expect(store.savePetPlacement({
      characterId: 'pet-a', scale: 1,
      footAnchorDip: { x: 10, y: 20 }, displayId: 'display-main'
    })).rejects.toBeDefined();
    await rm(temporaryFile, { recursive: true, force: true });

    await expect(store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    })).resolves.toBeUndefined();
    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' })
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
      authorizedRoot: null
    });
    await expect(store.getAuthorizedRootPath()).resolves.toBeNull();
    await expect(store.getMcpServerSettings()).resolves.toEqual([]);
  });

  test('按角色独立保存 placement，并把有限 scale 钳制到支持范围', async () => {
    const { file, store } = await createStore();
    await store.savePetPlacement({
      characterId: 'pet-a',
      scale: 0.1,
      footAnchorDip: { x: -320, y: 240 },
      displayId: 'display-left'
    });
    await store.savePetPlacement({
      characterId: 'pet-b',
      scale: 4,
      footAnchorDip: { x: 1320, y: 740 },
      displayId: 'display-main'
    });

    const petAState = await store.getPetPlacementState('pet-a');
    expect(petAState).toEqual({
      kind: 'ready',
      placement: {
        characterId: 'pet-a',
        scale: 0.5,
        footAnchorDip: { x: -320, y: 240 },
        displayId: 'display-left'
      }
    });
    expect(Object.isFrozen(petAState)).toBe(true);
    expect(petAState.kind === 'ready' && Object.isFrozen(petAState.placement)).toBe(true);
    expect(petAState.kind === 'ready' && petAState.placement !== null
      && Object.isFrozen(petAState.placement.footAnchorDip)).toBe(true);
    await expect(new SettingsStore(file, async () => false)
      .getPetPlacementState('pet-b')).resolves.toEqual({
      kind: 'ready',
      placement: {
        characterId: 'pet-b',
        scale: 2,
        footAnchorDip: { x: 1320, y: 740 },
        displayId: 'display-main'
      }
    });
    await expect(store.getPetPlacementState('pet-c')).resolves.toEqual({
      kind: 'ready',
      placement: null
    });
  });

  test('本地模型开关默认开启，保存关闭后重启仍保持关闭', async () => {
    const { file, store } = await createStore();

    await expect(store.getLocalModelSettings()).resolves.toEqual({ enabled: true });
    await expect(store.saveLocalModelEnabled(false)).resolves.toBeUndefined();
    await expect(
      new SettingsStore(file, async () => false).getLocalModelSettings()
    ).resolves.toEqual({ enabled: false });
  });

  test('旧设置缺失工作台布局时返回默认值并回写持久化字段', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 6,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPlacementState: { kind: 'ready', placements: [] },
      petAlwaysOnTop: false,
      privacy: {
        dataCategories: { memory: false },
        longTermMemory: false,
        proactivityMode: 'autonomous'
      },
      movementMode: 2,
      mcpServers: [],
      localModel: { enabled: true }
    }), 'utf8');

    await expect(store.getWorkshopLayout()).resolves.toEqual(DEFAULT_WORKSHOP_LAYOUT);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      workshopLayout: DEFAULT_WORKSHOP_LAYOUT
    });
  });

  test('工作台布局可原子保存并在新实例中重载', async () => {
    const { file, store } = await createStore();
    const layout = {
      leftWidth: 320,
      rightWidth: 280,
      sidebarTopHeight: 260,
      stageHeight: 420
    } as const;

    await expect(store.saveWorkshopLayout(layout)).resolves.toEqual(layout);
    await expect(store.getWorkshopLayout()).resolves.toEqual(layout);
    await expect(
      new SettingsStore(file, async () => false).getWorkshopLayout()
    ).resolves.toEqual(layout);
  });

  test.each([
    {
      label: 'NaN',
      input: {
        leftWidth: Number.NaN,
        rightWidth: 280,
        sidebarTopHeight: 260,
        stageHeight: 420
      }
    },
    {
      label: 'Infinity',
      input: {
        leftWidth: 320,
        rightWidth: Number.POSITIVE_INFINITY,
        sidebarTopHeight: 260,
        stageHeight: 420
      }
    },
    {
      label: 'negative',
      input: {
        leftWidth: -1,
        rightWidth: 280,
        sidebarTopHeight: 260,
        stageHeight: 420
      }
    },
    {
      label: 'over-budget',
      input: {
        leftWidth: 320,
        rightWidth: 10_000,
        sidebarTopHeight: 260,
        stageHeight: 420
      }
    }
  ])('工作台布局 Schema 拒绝非法值：$label', ({ input }) => {
    expect(() => workshopLayoutSettingsSchema.parse(input)).toThrow();
  });

  test('迁移旧文件披露值时丢弃已退役 Gate 并保留其他隐私设置', async () => {
    const { file, store } = await createStore();
    await store.savePetAlwaysOnTop(true);
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.workshopLayout;
    legacy.version = 5;
    delete legacy.privacy.autonomousMoodEnabled;
    legacy.fileDisclosureAccepted = false;
    legacy.privacy.dataCategories.file = false;
    await writeFile(file, JSON.stringify(legacy), 'utf8');

    await expect(store.getPrivacySettings()).resolves.toEqual({
      dataCategories: { memory: false },
      longTermMemory: false,
      autonomousMoodEnabled: true,
      proactivityMode: 'autonomous'
    });
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted).not.toHaveProperty('fileDisclosureAccepted');
    expect(persisted.privacy.dataCategories).toEqual({ memory: false });
    expect(persisted.petAlwaysOnTop).toBe(true);
  });

  test.each([
    {
      name: 'V1',
      stored: {
        version: 1,
        provider: {
          id: 'legacy-provider',
          displayName: '旧 Provider',
          baseUrl: 'https://legacy.example.com/v1',
          model: 'legacy-model'
        },
        authorizedRoot: {
          id: 'legacy-root',
          displayName: '旧目录',
          pathHint: 'D:\\…\\legacy',
          absolutePath: 'D:\\private\\legacy'
        },
        petPosition: { x: 12, y: 34 },
        fileDisclosureAccepted: true
      },
      expected: {
        route: {
          primaryProfileId: 'legacy-provider',
          chatProfileId: null,
          agentProfileId: null,
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        },
        placement: { kind: 'pending-legacy', windowPosition: { x: 12, y: 34 } },
        privacy: { movementMode: 2, proactivityMode: 'assistive' },
        mcpServers: []
      }
    },
    {
      name: 'V2',
      stored: {
        version: 2,
        providerProfiles: [{
          id: 'provider-main',
          displayName: '主 Provider',
          mode: 'custom',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          modelId: 'tools-model',
          additionalParameters: {},
          capabilities: ['chat', 'tools']
        }],
        modelRoute: {
          primaryProfileId: 'provider-main',
          chatProfileId: 'provider-main',
          agentProfileId: 'provider-main',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        },
        authorizedRoot: null,
        petPosition: { x: 56, y: 78 },
        fileDisclosureAccepted: true,
        petAlwaysOnTop: true,
        privacy: {
          dataCategories: { file: true, screenshot: false, clipboard: true, memory: false },
          longTermMemory: true,
          proactivityMode: 'passive'
        },
        movementStopped: true,
        mcpServers: mcpSettingsFixture
      },
      expected: {
        route: {
          primaryProfileId: 'provider-main',
          chatProfileId: 'provider-main',
          agentProfileId: 'provider-main',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        },
        placement: { kind: 'pending-legacy', windowPosition: { x: 56, y: 78 } },
        privacy: { movementMode: 0, proactivityMode: 'passive' },
        mcpServers: mcpSettingsFixture
      }
    },
    {
      name: 'V3',
      stored: {
        version: 3,
        providerProfiles: [{
          id: 'provider-main',
          displayName: '主 Provider',
          mode: 'custom',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          modelId: 'tools-model',
          additionalParameters: {},
          capabilities: ['chat', 'tools']
        }],
        modelRoute: {
          primaryProfileId: 'provider-main',
          chatProfileId: 'provider-main',
          agentProfileId: 'provider-main',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        },
        authorizedRoot: null,
        petPlacementState: {
          kind: 'ready',
          placements: [{
            characterId: 'pet-a',
            scale: 1,
            footAnchorDip: { x: 90, y: 120 },
            displayId: 'display-main'
          }]
        },
        fileDisclosureAccepted: true,
        petAlwaysOnTop: true,
        privacy: {
          dataCategories: { file: true, screenshot: false, clipboard: true, memory: false },
          longTermMemory: true,
          proactivityMode: 'passive'
        },
        movementStopped: true,
        mcpServers: mcpSettingsFixture
      },
      expected: {
        route: {
          primaryProfileId: 'provider-main',
          chatProfileId: 'provider-main',
          agentProfileId: 'provider-main',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        },
        placement: {
          kind: 'ready',
          placement: {
            characterId: 'pet-a',
            scale: 1,
            footAnchorDip: { x: 90, y: 120 },
            displayId: 'display-main'
          }
        },
        privacy: { movementMode: 0, proactivityMode: 'passive' },
        mcpServers: mcpSettingsFixture
      }
    }
  ])('迁移 $name 时保留既有设置并注入本地模型默认开关', async ({ stored, expected }) => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify(stored), 'utf8');

    await expect(store.getLocalModelSettings()).resolves.toEqual({ enabled: true });
    await expect(store.getProviderSettings()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ id: expected.route.primaryProfileId })],
      route: expected.route
    });
    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual(expected.placement);
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual(expected.privacy);
    await expect(store.getMcpServerSettings()).resolves.toEqual(expected.mcpServers);
    await expect(store.getPetAlwaysOnTop()).resolves.toBe(stored.version === 1 ? false : true);
    await expect(store.getPublic()).resolves.toMatchObject({
      authorizedRoot: stored.version === 1
        ? { id: 'legacy-root', displayName: '旧目录', pathHint: 'D:\\…\\legacy' }
        : null
    });
    await expect(readFile(file, 'utf8')).resolves.toContain('"version": 6');
  });

  test('V2 旧位置只解析一次并原子迁移为不含 windowPosition 的 ready V3', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 2,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPosition: { x: -500, y: 120 },
      fileDisclosureAccepted: true,
      petAlwaysOnTop: true,
      privacy: {
        dataCategories: { file: true, screenshot: false, clipboard: true, memory: false },
        longTermMemory: false,
        proactivityMode: 'passive'
      },
      movementStopped: true,
      mcpServers: mcpSettingsFixture
    }), 'utf8');
    const pendingState = await store.getPetPlacementState('pet-a');
    expect(pendingState).toEqual({
      kind: 'pending-legacy',
      windowPosition: { x: -500, y: 120 }
    });
    expect(Object.isFrozen(pendingState)).toBe(true);
    expect(pendingState.kind === 'pending-legacy'
      && Object.isFrozen(pendingState.windowPosition)).toBe(true);
    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
      kind: 'pending-legacy',
      windowPosition: { x: -500, y: 120 }
    });
    await store.commitPetPlacementMigration({
      expectedWindowPosition: { x: -500, y: 120 },
      placement: {
        characterId: 'pet-a',
        scale: 1,
        footAnchorDip: { x: -410, y: 300 },
        displayId: 'display-left'
      }
    });
    await expect(store.getPetPlacementState('pet-a')).resolves.toMatchObject({
      kind: 'ready',
      placement: { characterId: 'pet-a' }
    });

    const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 6,
      petPlacementState: {
        kind: 'ready',
        placements: [{ characterId: 'pet-a', scale: 1 }]
      },
      petAlwaysOnTop: true,
      privacy: { proactivityMode: 'passive' },
      movementMode: 0,
      mcpServers: mcpSettingsFixture
    });
    expect(persisted).not.toHaveProperty('fileDisclosureAccepted');
    expect(JSON.stringify(persisted)).not.toContain('windowPosition');
    expect(persisted).not.toHaveProperty('petPosition');
  });

  test('CAS 期望坐标过期时稳定拒绝且保持 pending', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({
      version: 2,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPosition: { x: 20, y: 30 },
      fileDisclosureAccepted: false
    }), 'utf8');

    await expect(store.commitPetPlacementMigration({
      expectedWindowPosition: { x: 21, y: 30 },
      placement: {
        characterId: 'pet-a', scale: 1,
        footAnchorDip: { x: 110, y: 210 }, displayId: 'display-main'
      }
    })).rejects.toMatchObject({ code: 'PET_PLACEMENT_MIGRATION_STALE' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 6,
      petPlacementState: {
        kind: 'pending-legacy',
        windowPosition: { x: 20, y: 30 }
      }
    });

    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
      kind: 'pending-legacy', windowPosition: { x: 20, y: 30 }
    });
  });

  test('savePetPlacement 遇到 pending 时稳定拒绝且只能由 CAS 完成迁移', async () => {
    const { file, store } = await createStore();
    await writeLegacyV2Position(file, { x: 40, y: 50 });
    await expect(store.savePetPlacement({
      characterId: 'pet-a',
      scale: 1,
      footAnchorDip: { x: 130, y: 230 },
      displayId: 'display-main'
    })).rejects.toMatchObject({ code: 'PET_PLACEMENT_MIGRATION_REQUIRED' });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.petPlacementState).toEqual({
      kind: 'pending-legacy',
      windowPosition: { x: 40, y: 50 }
    });
  });

  test('V3 单条损坏 placement 被清理且保留 Provider、隐私、主动性和 MCP', async () => {
    const { file, store } = await createStore(true);
    await writeFile(file, JSON.stringify({
      version: 3,
      providerProfiles: [{
        id: 'provider-main',
        displayName: 'Provider Main',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model',
        additionalParameters: {}
      }],
      modelRoute: {
        primaryProfileId: 'provider-main',
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPlacementState: {
        kind: 'ready',
        placements: [
          {
            characterId: 'pet-a', scale: 1,
            footAnchorDip: { x: 100, y: 200 }, displayId: 'display-main'
          },
          {
            characterId: '../bad', scale: 'huge',
            footAnchorDip: { x: 'bad', y: 0 }, displayId: ''
          }
        ]
      },
      fileDisclosureAccepted: true,
      petAlwaysOnTop: true,
      privacy: {
        dataCategories: { file: true, screenshot: true, clipboard: false, memory: false },
        longTermMemory: false,
        proactivityMode: 'assistive'
      },
      movementStopped: true,
      mcpServers: mcpSettingsFixture
    }), 'utf8');

    await expect(store.getPetPlacementState('pet-a')).resolves.toMatchObject({
      kind: 'ready', placement: { characterId: 'pet-a' }
    });
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 0,
      proactivityMode: 'assistive'
    });
    await expect(store.getProviderSettings()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ id: 'provider-main' })]
    });
    await expect(store.getMcpServerSettings()).resolves.toEqual(mcpSettingsFixture);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.petPlacementState.placements).toEqual([
      expect.objectContaining({ characterId: 'pet-a' })
    ]);
    expect(persisted.privacy.proactivityMode).toBe('assistive');
    expect(persisted.movementMode).toBe(0);
    expect(persisted).not.toHaveProperty('movementStopped');
  });

  test('V6 单条损坏 placement 只被清理且不隔离其他合法设置', async () => {
    const { directory, file, store } = await createStore(true);
    await store.saveProviderProfile(providerProfile);
    await store.saveModelRoute({
      primaryProfileId: providerProfile.id,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    });
    await store.saveAuthorizedRoot({
      id: 'root-main',
      displayName: '授权目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });
    await store.savePetAlwaysOnTop(true);
    await store.saveLocalModelEnabled(false);

    const legacy = JSON.parse(await readFile(file, 'utf8'));
    legacy.petPlacementState = {
      kind: 'ready',
      placements: [
        {
          characterId: 'pet-a', scale: 1,
          footAnchorDip: { x: 100, y: 200 }, displayId: 'display-main'
        },
        {
          characterId: '../bad', scale: 'huge',
          footAnchorDip: { x: 'bad', y: 0 }, displayId: ''
        }
      ]
    };
    await writeFile(file, JSON.stringify(legacy), 'utf8');

    await expect(store.getPetPlacementState('pet-a')).resolves.toMatchObject({
      kind: 'ready', placement: { characterId: 'pet-a' }
    });
    await expect(store.getProviderSettings()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ id: providerProfile.id })],
      route: expect.objectContaining({ primaryProfileId: providerProfile.id })
    });
    await expect(store.getAuthorizedRootPath()).resolves.toBe('D:\\private\\project');
    await expect(store.getPetAlwaysOnTop()).resolves.toBe(true);
    await expect(store.getLocalModelSettings()).resolves.toEqual({ enabled: false });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted).toMatchObject({
      version: 6,
      authorizedRoot: expect.objectContaining({ id: 'root-main' }),
      petAlwaysOnTop: true,
      localModel: { enabled: false },
      petPlacementState: {
        kind: 'ready',
        placements: [expect.objectContaining({ characterId: 'pet-a' })]
      }
    });
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  test('ready 原始数组超过 256 条时只清空 placement 并保留其余严格 V3 设置', async () => {
    const { directory, file, store } = await createStore();
    const placements = Array.from({ length: 257 }, (_, index) => ({
      characterId: `pet-${index}`,
      scale: 1,
      footAnchorDip: { x: index, y: index },
      displayId: 'display-main'
    }));
    await writeFile(file, JSON.stringify({
      version: 3,
      providerProfiles: [{
        id: 'provider-main', displayName: 'Provider Main', mode: 'custom',
        protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model', additionalParameters: {}
      }],
      modelRoute: {
        primaryProfileId: 'provider-main', chatProfileId: null, agentProfileId: null,
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPlacementState: { kind: 'ready', placements },
      fileDisclosureAccepted: true,
      petAlwaysOnTop: true,
      privacy: {
        dataCategories: { file: true, screenshot: false, clipboard: true, memory: false },
        longTermMemory: false,
        proactivityMode: 'passive'
      },
      movementStopped: true,
      mcpServers: mcpSettingsFixture
    }), 'utf8');

    await expect(store.getPetPlacementState('pet-0')).resolves.toEqual({
      kind: 'ready', placement: null
    });
    await expect(store.getProviderSettings()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ id: 'provider-main' })]
    });
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 0,
      proactivityMode: 'passive'
    });
    await expect(store.getMcpServerSettings()).resolves.toEqual(mcpSettingsFixture);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      petPlacementState: { kind: 'ready', placements: [] },
      privacy: { proactivityMode: 'passive' },
      movementMode: 0,
      mcpServers: mcpSettingsFixture
    });
    expect((await readdir(directory)).some(name => name.startsWith('settings.json.corrupt-')))
      .toBe(false);
  });

  test('超过 1 MiB 的设置文件在 JSON 解析前隔离并恢复安全默认值', async () => {
    const { directory, file, store } = await createStore();
    await writeFile(file, `{"padding":"${'x'.repeat(1024 * 1024)}"}`, 'utf8');
    const parse = vi.spyOn(JSON, 'parse');

    try {
      await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
        kind: 'ready', placement: null
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect((await readdir(directory)).some(name => name.startsWith('settings.json.corrupt-')))
      .toBe(true);
  });

  test('ready 已满 256 条时允许更新已有角色但稳定拒绝新增角色', async () => {
    const { file, store } = await createStore();
    const placements = Array.from({ length: 256 }, (_, index) => ({
      characterId: `pet-${index}`,
      scale: 1,
      footAnchorDip: { x: index, y: index },
      displayId: 'display-main'
    }));
    await writeFile(file, JSON.stringify({
      version: 3,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null, chatProfileId: null, agentProfileId: null,
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPlacementState: { kind: 'ready', placements },
      fileDisclosureAccepted: false,
      petAlwaysOnTop: false,
      privacy: {
        dataCategories: { file: false, screenshot: false, clipboard: false, memory: false },
        longTermMemory: false,
        proactivityMode: 'autonomous'
      },
      movementStopped: false,
      mcpServers: []
    }), 'utf8');

    await expect(store.savePetPlacement({
      characterId: 'pet-0', scale: 1.5,
      footAnchorDip: { x: 500, y: 600 }, displayId: 'display-main'
    })).resolves.toBeUndefined();
    await expect(store.getPetPlacementState('pet-0')).resolves.toMatchObject({
      kind: 'ready',
      placement: { characterId: 'pet-0', scale: 1.5, footAnchorDip: { x: 500, y: 600 } }
    });

    await expect(store.savePetPlacement({
      characterId: 'pet-new', scale: 1,
      footAnchorDip: { x: 10, y: 20 }, displayId: 'display-main'
    })).rejects.toMatchObject({ code: 'PET_PLACEMENT_CAPACITY_REACHED' });
    expect((JSON.parse(await readFile(file, 'utf8')).petPlacementState.placements as unknown[]))
      .toHaveLength(256);
  });

  test('损坏 pending 只重置 placement 并保留 Provider、隐私、主动性和 MCP', async () => {
    const { directory, file, store } = await createStore(true);
    await writeFile(file, JSON.stringify({
      version: 3,
      providerProfiles: [{
        id: 'provider-main', displayName: 'Provider Main', mode: 'custom',
        protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model', additionalParameters: {}
      }],
      modelRoute: {
        primaryProfileId: 'provider-main', chatProfileId: null, agentProfileId: null,
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPlacementState: {
        kind: 'pending-legacy',
        windowPosition: { x: 'broken', y: 20 }
      },
      fileDisclosureAccepted: true,
      petAlwaysOnTop: true,
      privacy: {
        dataCategories: { file: true, screenshot: false, clipboard: true, memory: false },
        longTermMemory: false,
        proactivityMode: 'passive'
      },
      movementStopped: true,
      mcpServers: mcpSettingsFixture
    }), 'utf8');

    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
      kind: 'ready', placement: null
    });
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted).toMatchObject({
      providerProfiles: [expect.objectContaining({ id: 'provider-main' })],
      petPlacementState: { kind: 'ready', placements: [] },
      privacy: { proactivityMode: 'passive' },
      movementMode: 0,
      mcpServers: mcpSettingsFixture
    });
    expect((await readdir(directory)).some(name => name.startsWith('settings.json.corrupt-')))
      .toBe(false);
  });

  test('pending 转 ready 最终原子写失败时保持 pending 并可重试', async () => {
    const { file, store } = await createStore();
    await writeLegacyV2Position(file, { x: 20, y: 30 });
    const temporaryFile = `${file}.tmp`;
    await mkdir(temporaryFile, { recursive: true });
    const commit = () => store.commitPetPlacementMigration({
      expectedWindowPosition: { x: 20, y: 30 },
      placement: {
        characterId: 'pet-a', scale: 1,
        footAnchorDip: { x: 110, y: 210 }, displayId: 'display-main'
      }
    });

    await expect(commit()).rejects.toBeDefined();
    // 首次 V2→V3 原子重写失败时，历史文件本身仍完整保留待迁移坐标。
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 2,
      petPosition: { x: 20, y: 30 }
    });
    await rm(temporaryFile, { recursive: true, force: true });
    await expect(commit()).resolves.toBeUndefined();
    await expect(store.getPetPlacementState('pet-a')).resolves.toMatchObject({
      kind: 'ready', placement: { characterId: 'pet-a' }
    });
  });

  test('V1 非空位置迁移为 pending 且保留旧 Provider', async () => {
    const { file, store } = await createStore(true);
    await writeFile(file, JSON.stringify({
      version: 1,
      provider: {
        id: 'legacy-provider', displayName: '旧 Provider',
        baseUrl: 'https://legacy.example.com/v1', model: 'legacy-model'
      },
      authorizedRoot: null,
      petPosition: { x: -500, y: 120 },
      fileDisclosureAccepted: true
    }), 'utf8');

    await expect(store.getPublic()).resolves.toMatchObject({
      provider: { id: 'legacy-provider' }
    });
    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
      kind: 'pending-legacy', windowPosition: { x: -500, y: 120 }
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 6,
      petPlacementState: {
        kind: 'pending-legacy',
        windowPosition: { x: -500, y: 120 }
      },
      privacy: { proactivityMode: 'assistive' },
      movementMode: 2
    });
  });

  test('V2 缺失 optional 设置迁移时补旧用户默认且不覆盖 Provider', async () => {
    const { file, store } = await createStore(true);
    await writeFile(file, JSON.stringify({
      version: 2,
      providerProfiles: [{
        id: 'provider-main', displayName: 'Provider Main', mode: 'custom',
        protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model', additionalParameters: {}
      }],
      modelRoute: {
        primaryProfileId: 'provider-main', chatProfileId: null, agentProfileId: null,
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: true
    }), 'utf8');

    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 2,
      proactivityMode: 'assistive'
    });
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted).toMatchObject({
      version: 6,
      providerProfiles: [expect.objectContaining({ id: 'provider-main' })],
      petPlacementState: { kind: 'ready', placements: [] },
      petAlwaysOnTop: false,
      privacy: { proactivityMode: 'assistive' },
      movementMode: 2,
      mcpServers: []
    });
  });
});

test('加载旧设置时移除截图与剪贴板隐私占位并保留其余设置', async () => {
  const { file, store } = await createStore();
  await store.savePetAlwaysOnTop(true);
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  delete legacy.workshopLayout;
  legacy.version = 5;
  delete legacy.privacy.autonomousMoodEnabled;
  legacy.fileDisclosureAccepted = true;
  legacy.privacy.dataCategories.file = true;
  legacy.privacy.dataCategories.memory = false;
  legacy.privacy.dataCategories.screenshot = true;
  legacy.privacy.dataCategories.clipboard = true;
  await writeFile(file, JSON.stringify(legacy), 'utf8');

  await expect(store.getPrivacySettings()).resolves.toMatchObject({
    dataCategories: { memory: false },
    longTermMemory: false,
    proactivityMode: 'autonomous'
  });
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  expect(persisted.petAlwaysOnTop).toBe(true);
  expect(persisted.privacy.dataCategories).toEqual({ memory: false });
});
