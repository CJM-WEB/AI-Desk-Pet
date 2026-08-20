import { describe, expect, test } from 'vitest';
import {
  characterErrorCode,
  characterOperationMessage,
  characterRecoveryMessage,
  characterRecoveryPresentation
} from '../src/shared/character-recovery';

describe('角色稳定错误反馈', () => {
  test('从 Electron RPC 包装错误中提取稳定码并映射中文说明', () => {
    const message = "Error invoking remote method 'character:package-import': "
      + 'Error: CHARACTER_PACKAGE_PATH_REJECTED';

    expect(characterErrorCode(message)).toBe('CHARACTER_PACKAGE_PATH_REJECTED');
    expect(characterOperationMessage(message))
      .toBe('角色包包含不安全路径，已拒绝导入。');
  });

  test.each([
    ['CHARACTER_ALREADY_EXISTS', '已存在'],
    ['CHARACTER_DEFAULT_DELETE_REJECTED', '内置'],
    ['CHARACTER_SOURCE_TOTAL_BYTES_EXCEEDED', '资源'],
    ['CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED', '角色包'],
    ['CHARACTER_ATLAS_OVERFLOW', '图集'],
    ['CHARACTER_PACKAGE_DESTINATION_EXISTS', '冲突'],
    ['CHARACTER_INDEX_UNAVAILABLE', '索引'],
    ['CHARACTER_ASSET_BUSY', '忙'],
    ['CHARACTER_RUNTIME_UNAVAILABLE', '运行版本']
  ])('稳定错误码 %s 映射为具体中文分类', (code, expectedText) => {
    expect(characterOperationMessage(code)).toContain(expectedText);
  });

  test('未知异常不向界面泄露原始文本', () => {
    expect(characterErrorCode('C:\\Users\\name\\secret.png')).toBe(
      'CHARACTER_OPERATION_FAILED'
    );
    expect(characterOperationMessage('C:\\Users\\name\\secret.png'))
      .toBe('角色操作失败，请在角色工作室检查素材和草稿。');
  });
});

describe('角色恢复问题展示映射', () => {
  test.each([
    ['CHARACTER_DRAFT_RECOVERY_BLOCKED', '角色草稿恢复受阻，当前草稿无法安全保存或发布。', ['draft-save', 'publish'], '请先保留恢复证据，再重试读取或重新导入素材。'],
    ['CHARACTER_PUBLISH_RECOVERY_BLOCKED', '角色发布恢复受阻，当前发布版本无法安全启用。', ['publish', 'activate'], '请重新编译发布；问题持续时先导出恢复包。'],
    ['CHARACTER_RECOVERY_DEFERRED', '角色恢复暂未完成，相关编辑与启用操作已暂停。', ['draft-save', 'publish', 'activate'], '请稍后重新打开角色工作室重试。'],
    ['CHARACTER_IMPORT_RECOVERY_BLOCKED', '角色导入恢复受阻，未完成的导入不会覆盖现有角色。', ['draft-save', 'publish', 'activate'], '请检查角色包后重新导入；问题持续时保留现有恢复证据。'],
    ['CHARACTER_IMPORT_RECOVERY_DEFERRED', '角色导入恢复暂未完成，现有角色数据保持不变。', ['draft-save', 'publish', 'activate'], '请稍后重新打开角色工作室，再重试导入。']
  ] as const)('为 %s 提供唯一的中文说明、能力影响和建议', (
    errorCode,
    text,
    affectedCapabilities,
    suggestion
  ) => {
    const presentation = characterRecoveryPresentation(errorCode);
    expect(presentation).toEqual({ text, affectedCapabilities, suggestion });
  });

  test.each([
    ['CHARACTER_RESOURCE_INTEGRITY_FAILED', '当前角色资源校验失败，已切换到官方默认角色。'],
    ['UNKNOWN', '当前角色无法加载，已切换到官方默认角色。']
  ])('启动恢复错误码 %s 映射为角色工作室修复入口', (errorCode, text) => {
    expect(characterRecoveryMessage(errorCode)).toEqual({ text, actionLabel: '打开角色工作室' });
  });
});
