const defaultLoadManager = () => import('@cloudbase/manager-node');
const fixedRegion = 'ap-singapore';

/**
 * 创建 manager-node 的最小远端适配器。
 * 只接受显式凭据和环境标识，不从环境变量回退凭据，也不使用 SDK 单例。
 * manager-node 会让 TCB_REGION 覆盖显式地域，因此只读取该变量进行失败关闭。
 */
export async function createCloudBaseUserMigrationAdapter(options) {
  const {
    environmentClass,
    envId,
    secretId,
    secretKey,
    token,
    loadManager = defaultLoadManager
  } = options;

  const assertSafeEnvironment = () => {
    if (environmentClass !== 'development') {
      throw new Error('CloudBase 用户迁移只允许显式 development 环境');
    }
    // manager-node 5.6.5 在实际请求时让 TCB_REGION 覆盖构造参数，故每次远端调用前都要复核。
    if (process.env.TCB_REGION && process.env.TCB_REGION !== fixedRegion) {
      throw new Error('TCB_REGION 与固定地域不一致');
    }
  };

  assertSafeEnvironment();
  if (Object.hasOwn(options, 'region')) {
    throw new Error('CloudBase 用户迁移地域固定为 ap-singapore');
  }
  if (![envId, secretId, secretKey].every(value =>
    typeof value === 'string' && value.trim().length > 0)
    || (token !== undefined
      && (typeof token !== 'string' || token.trim().length === 0))) {
    throw new Error('CloudBase 用户迁移适配器配置不完整');
  }
  const loadedModule = await loadManager();
  const CloudBase = loadedModule?.default ?? loadedModule;
  if (typeof CloudBase !== 'function') {
    throw new Error('无法加载 CloudBase manager SDK');
  }

  const normalizedEnvId = envId.trim();
  const config = {
    envId: normalizedEnvId,
    secretId: secretId.trim(),
    secretKey: secretKey.trim(),
    region: fixedRegion
  };
  if (token !== undefined) {
    config.token = token.trim();
  }
  const manager = new CloudBase(config);
  const database = manager.database;

  return Object.freeze({
    preview: migrations => {
      assertSafeEnvironment();
      return database.previewPGUserMigrations({
        EnvId: normalizedEnvId,
        Migrations: migrations
      });
    },
    push: migrations => {
      assertSafeEnvironment();
      return database.pushPGUserMigrations({
        EnvId: normalizedEnvId,
        Migrations: migrations
      });
    },
    describeTask: taskId => {
      assertSafeEnvironment();
      return database.describeTaskResult({
        EnvId: normalizedEnvId,
        TaskId: taskId
      });
    }
  });
}
