interface ReleaseDocumentIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export const BUILTIN_LOCAL_MODEL_RELEASE_IDENTITY: Readonly<{
  schemaVersion: 1;
  platform: 'win32';
  arch: 'x64';
  runtimeRevision: string;
  model: Readonly<{
    id: 'ai-pet-local';
    sourceRepository: string;
    sourceRevision: string;
    quantizationRepository: string;
    quantizationRevision: string;
    fileName: string;
    size: number;
    sha256: string;
  }>;
  documents: Readonly<{
    runtimeLicense: Readonly<ReleaseDocumentIdentity>;
    modelLicense: Readonly<ReleaseDocumentIdentity>;
    notices: Readonly<ReleaseDocumentIdentity>;
  }>;
}>;
