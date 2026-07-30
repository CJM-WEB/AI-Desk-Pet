export const CHARACTER_RESOURCE_LIMITS = {
  maxSourceFilesPerImport: 500,
  maxSourceBytesPerFile: 32 * 1024 * 1024,
  maxTotalSourceBytesPerCharacter: 512 * 1024 * 1024,
  maxFrameDimension: 4096,
  maxFramesPerAction: 500,
  maxStatesPerCharacter: 100,
  maxActionsPerState: 100
} as const;
