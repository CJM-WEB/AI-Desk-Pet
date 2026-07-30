export interface CharacterRecoveryMessage {
  text: string;
  actionLabel: '打开角色工作室';
}

const RECOVERY_MESSAGES: Readonly<Record<string, string>> = {
  CHARACTER_INDEX_UNAVAILABLE: '角色索引无法读取，已切换到官方默认角色。',
  CHARACTER_MANIFEST_INVALID: '当前角色清单无效，已切换到官方默认角色。',
  CHARACTER_RESOURCE_INTEGRITY_FAILED: '当前角色资源校验失败，已切换到官方默认角色。',
  CHARACTER_RESOURCE_NOT_FOUND: '当前角色资源缺失，已切换到官方默认角色。',
  CHARACTER_RUNTIME_UNAVAILABLE: '当前角色运行版本不可用，已切换到官方默认角色。',
  CHARACTER_VERSION_UNSUPPORTED: '当前角色版本不兼容，已切换到官方默认角色。'
};

const OPERATION_MESSAGES: Readonly<Record<string, string>> = {
  ...RECOVERY_MESSAGES,
  CHARACTER_DRAFT_SAVE_FAILED: '角色草稿保存失败，请检查角色素材后重试。',
  CHARACTER_INCOMPLETE: '该角色动作不完整，需要确认后才能启用。',
  CHARACTER_INCOMPLETE_CONFIRMATION_REQUIRED: '该角色动作不完整，需要确认后才能启用。',
  CHARACTER_PACKAGE_PATH_REJECTED: '角色包包含不安全路径，已拒绝导入。',
  CHARACTER_PACKAGE_INVALID: '角色包格式无效，未修改现有角色。',
  CHARACTER_PACKAGE_STRUCTURE_INVALID: '角色包结构无效，未修改现有角色。',
  CHARACTER_PACKAGE_RESOURCE_INVALID: '角色包资源校验失败，未修改现有角色。',
  CHARACTER_PATH_UNSAFE: '角色路径超出安全边界，操作已拒绝。',
  CHARACTER_RESOURCE_INTEGRITY_FAILED: '角色资源校验失败，已保留原运行版本。'
};

function characterErrorFamilyMessage(errorCode: string): string | null {
  if (errorCode === 'CHARACTER_ALREADY_EXISTS') {
    return '同名或同标识角色已存在，请更换名称后重试。';
  }
  if (
    errorCode === 'CHARACTER_DEFAULT_DELETE_REJECTED'
    || errorCode === 'CHARACTER_ACTIVE_DELETE_REJECTED'
  ) {
    return '内置角色或当前启用角色不能删除，请先切换角色。';
  }
  if (
    errorCode.includes('_PATH_')
    || errorCode.includes('_LINK_')
    || errorCode.includes('_UNSAFE')
  ) {
    return '角色路径或链接不安全，操作已拒绝。';
  }
  if (
    errorCode.includes('_BUSY')
    || errorCode.includes('_LEASE_')
    || errorCode.includes('_TRANSACTION_')
  ) {
    return '角色存储正忙或事务尚未恢复，请稍后重试。';
  }
  if (
    errorCode.includes('_INDEX_')
    || errorCode.includes('_MIGRATION_')
    || errorCode.includes('_CATALOG_')
  ) {
    return '角色索引或存储数据损坏，已保留证据，请打开角色工作室修复。';
  }
  if (
    errorCode.includes('_RUNTIME_')
    || errorCode.includes('_MANIFEST_')
    || errorCode.includes('_VERSION_')
  ) {
    return '角色运行版本不可用或格式不兼容，请重新编译发布。';
  }
  if (
    errorCode.includes('_ATLAS_')
    || errorCode.includes('_FRAME_')
    || errorCode.includes('_SPRITE_')
    || errorCode.includes('_IMAGE_')
  ) {
    return '角色图集或帧格式不符合要求，请检查尺寸、网格和图片格式。';
  }
  if (errorCode.startsWith('CHARACTER_PACKAGE_')) {
    if (
      errorCode.includes('_EXISTS')
      || errorCode.includes('_CONFLICT')
      || errorCode.includes('_MISMATCH')
    ) {
      return '角色包与现有角色冲突，未覆盖任何已有数据。';
    }
    return '角色包格式、路径或容量不符合要求，导入导出已停止。';
  }
  if (
    errorCode.includes('_SOURCE_')
    || errorCode.includes('_RESOURCE_')
    || errorCode.includes('_COMPILED_')
    || errorCode.includes('_ASSET_')
  ) {
    return '角色资源格式、完整性或容量不符合要求，请检查素材后重试。';
  }
  if (
    errorCode.includes('_ALREADY_')
    || errorCode.includes('_CONFLICT')
    || errorCode.includes('_DESTINATION_')
  ) {
    return '角色数据发生冲突，未覆盖现有内容。';
  }
  if (
    errorCode.includes('_INVALID')
    || errorCode.includes('_MISMATCH')
    || errorCode.includes('_UNSUPPORTED')
  ) {
    return '角色输入或文档格式无效，请检查角色配置。';
  }
  if (
    errorCode.includes('_MOTION_')
    || errorCode.includes('_PLAYBACK_')
    || errorCode.includes('_EXTENSION_')
    || errorCode.includes('_STATE_')
  ) {
    return '角色动作或状态请求无效，本次播放已停止。';
  }
  return null;
}

export function characterOperationMessage(errorCode: string): string {
  const code = characterErrorCode(errorCode);
  return OPERATION_MESSAGES[code]
    ?? characterErrorFamilyMessage(code)
    ?? '角色操作失败，请在角色工作室检查素材和草稿。';
}

export function characterRecoveryMessage(errorCode: string): CharacterRecoveryMessage {
  return {
    text: RECOVERY_MESSAGES[errorCode]
      ?? '当前角色无法加载，已切换到官方默认角色。',
    actionLabel: '打开角色工作室'
  };
}

/** 从 Electron RPC 包装文本中提取稳定错误码，避免向界面暴露原始异常。 */
export function characterErrorCode(message: string): string {
  return message.match(/\b(CHARACTER_[A-Z0-9_]+)\b/u)?.[1]
    ?? 'CHARACTER_OPERATION_FAILED';
}
