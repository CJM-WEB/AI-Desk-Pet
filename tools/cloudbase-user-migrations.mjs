const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * 将已经完成命名、排序和校验和检查的 inventory 投影为 manager SDK 输入。
 * 本模块不重新发现或排序迁移，避免产生第二套事实来源。
 */
export function createCloudBaseUserMigrationInputs(inventory) {
  return inventory.map(item => {
    if (!/^\d{14}$/u.test(item.version)
      || !/^[a-z_]+$/u.test(item.name)
      || !Buffer.isBuffer(item.content)
      || item.content.byteLength === 0) {
      throw new Error('迁移 inventory 不符合 manager SDK 输入契约');
    }

    return {
      Version: item.version,
      Name: item.name,
      Query: item.content.toString('utf8')
    };
  });
}

/**
 * 在显式开发环境中编排 preview → push → task poll。
 * 适配器是唯一远端边界；编排器本身不读取凭据，也不加载管理 SDK。
 */
export async function runCloudBaseUserMigrations({
  environmentClass,
  migrations,
  adapter,
  maxPollAttempts = 60,
  pollIntervalMs = 1_000,
  wait = defaultWait
}) {
  if (environmentClass !== 'development') {
    throw new Error('CloudBase 用户迁移只允许显式 development 环境');
  }
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1) {
    throw new Error('迁移任务轮询次数必须是正整数');
  }

  const inputs = createCloudBaseUserMigrationInputs(migrations);
  const preview = await adapter.preview(inputs);
  const conflicts = preview?.Conflicts ?? [];
  const pending = preview?.Pending ?? [];
  if (preview?.Executable !== true
    || !Array.isArray(conflicts)
    || conflicts.length > 0
    || !Array.isArray(pending)) {
    throw new Error('CloudBase 用户迁移预览不可执行');
  }
  if (pending.length === 0) {
    return { outcome: 'up-to-date' };
  }

  const pushed = await adapter.push(inputs);
  if (typeof pushed?.TaskId !== 'string' || pushed.TaskId.length === 0) {
    throw new Error('CloudBase 用户迁移任务缺少任务标识');
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const task = await adapter.describeTask(pushed.TaskId);
    if (task?.Status === 'Succeed') {
      return { outcome: 'applied', taskId: pushed.TaskId };
    }
    if (task?.Status === 'Failed') {
      throw new Error('CloudBase 用户迁移任务失败');
    }
    if (task?.Status !== 'Accepted' && task?.Status !== 'Running') {
      throw new Error('CloudBase 返回未知迁移任务状态');
    }
    if (attempt + 1 < maxPollAttempts) {
      await wait(pollIntervalMs);
    }
  }

  throw new Error('CloudBase 用户迁移任务轮询超时');
}
