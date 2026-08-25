/** 打包脚本与运行期共同读取这一份只读发行身份，Renderer 不接触也不能覆盖。 */
export const BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY = Object.freeze({
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  runtimeRevision: 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9',
  model: Object.freeze({
    id: 'ai-pet-local',
    sourceRepository: 'Qwen/Qwen3.5-4B',
    sourceRevision: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
    quantizationRepository: 'unsloth/Qwen3.5-4B-GGUF',
    quantizationRevision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: 2_740_937_888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'
  }),
  documents: Object.freeze({
    runtimeLicense: Object.freeze({
      path: 'licenses/llama.cpp-LICENSE.txt',
      size: 1_078,
      sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
    }),
    modelLicense: Object.freeze({
      path: 'licenses/Qwen3.5-4B-LICENSE.txt',
      size: 11_343,
      sha256: 'a44a6081c73ad75f0255bb2bb5cab74ef1829565a895a24e53a4f11290ab7655'
    }),
    notices: Object.freeze({
      path: 'THIRD-PARTY-NOTICES.txt',
      size: 1_042,
      sha256: '6799f93063e30809ce60fa3eb5a5784b07a6db79eaadfee7d8acf28b4c96b0a4'
    })
  })
});
