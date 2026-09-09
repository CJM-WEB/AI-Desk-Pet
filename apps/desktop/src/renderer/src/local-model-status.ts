import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';

const localModelReasonTexts: Readonly<Record<NonNullable<LocalModelPublicStatus['reasonCode']>, string>> = {
  RESOURCE_MISSING: '内置资源缺失',
  RESOURCE_HASH_MISMATCH: '内置资源校验失败',
  RUNTIME_INCOMPATIBLE: '运行时不兼容',
  VULKAN_UNAVAILABLE: 'Vulkan 不可用',
  CPU_START_FAILED: 'CPU 兼容模式启动失败',
  MODEL_LOAD_TIMEOUT: '模型加载超时',
  PORT_CONFLICT: '本地端口冲突',
  PROCESS_CRASHED: '本地模型进程意外退出',
  PROTOCOL_INCOMPATIBLE: '本地模型协议不兼容',
  PROCESS_CLEANUP_FAILED: '本地模型进程清理失败'
};

/** 将公开故障码转为稳定中文文案，不向 Renderer 暴露运行时私有细节。 */
export function localModelReasonText(reasonCode: LocalModelPublicStatus['reasonCode']): string {
  return reasonCode ? localModelReasonTexts[reasonCode] : '本地模型启动失败';
}
