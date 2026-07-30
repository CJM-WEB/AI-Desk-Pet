import { describe, expect, test } from 'vitest';
import {
  characterErrorCode,
  characterOperationMessage
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
