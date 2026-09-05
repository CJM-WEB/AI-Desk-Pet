import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { providerCatalog } from '@myself/shared-types';
import { SecretStore } from '../src/main/storage/secret-store';
import { SettingsStore } from '../src/main/storage/settings-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { createCodingModelConnection } from '../src/main/providers/coding-model-connection';
import type { AcceptanceScenario } from './run-local-model-acceptance.mjs';
import { runCodingModelAcceptance, removeAcceptanceRoot } from './local-model-acceptance-runner';

/** 私有 Electron Main 仅连接原密文 Store；源设置先复制再加载，凭据不离开模型回调。 */
async function main(): Promise<void> {
  const [source, profileId, appPath, _bundleRoot, selection] = process.argv.slice(2);
  let root: string | undefined;
  let result: Awaited<ReturnType<typeof runCodingModelAcceptance>> | undefined;
  const send = (message: unknown) => process.send?.(message);
  try {
    if (!source || !profileId || profileId === 'default' || !appPath) throw new Error('ACCEPTANCE_CONFIGURATION_INVALID');
    const settingsSource = join(source, 'settings.json');
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    const originalHash = hash(readFileSync(settingsSource));
    root = mkdtempSync(join(tmpdir(), 'ai-pet-deepseek-acceptance-'));
    copyFileSync(join(source, 'Local State'), join(root, 'Local State'));
    copyFileSync(settingsSource, join(root, 'settings.json'));
    app.setPath('userData', root);
    await app.whenReady();
    const secrets = new SecretStore(join(source, 'provider-secret.bin'), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: value => safeStorage.encryptStringAsync(value),
      decryptString: async value => (await safeStorage.decryptStringAsync(value)).result
    });
    const settings = new SettingsStore(join(root, 'settings.json'), id => secrets.hasStoredSecret(id));
    const snapshot = await settings.getProviderSettings();
    const profile = snapshot.profiles.find(value => value.id === profileId);
    if (!profile || profile.mode !== 'preset' || profile.providerId !== 'deepseek' || !profile.hasStoredSecret) throw new Error('DEEPSEEK_PROFILE_MISSING');
    const selected = { profiles: [profile], route: { primaryProfileId: profile.id, chatProfileId: profile.id, agentProfileId: profile.id,
      visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false } };
    const registry = new ProviderRegistry(providerCatalog);
    result = await runCodingModelAcceptance({ model: 'deepseek', scenario: selection === 'all' ? undefined : selection as AcceptanceScenario['name'], appPath, resourceRoot: '', temporaryRoot: root, catalog: providerCatalog,
      requestedBackend: null, activeBackend: () => null, readSettings: async () => selected,
      createProvider: value => registry.create(value, () => secrets.readForProviderCall(value.id)),
      createConnection: value => createCodingModelConnection(value, { catalog: providerCatalog, readSecret: () => secrets.readForProviderCall(value.id) }),
      assertReady: value => { if (!value.hasStoredSecret) throw new Error('SECRET_NOT_FOUND'); },
      start: async () => undefined, close: async () => undefined,
      progress: stage => send({ type: 'progress', stage })
    });
    root = undefined;
    if (hash(await readFile(settingsSource)) !== originalHash) { result.phase = 'failed'; result.reasonCode = 'SOURCE_SETTINGS_CHANGED'; }
  } catch (error) {
    result = { selection: 'all', model: 'deepseek', modelId: '', requestedBackend: null, activeBackend: null, phase: 'failed',
      reasonCode: error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'DEEPSEEK_MAIN_FAILED', cleanup: false,
      checks: { chineseChat: false, providerAbortRecovery: false, cloudCallsZero: false, cloudRouteRestored: false }, scenarios: [] };
  } finally {
    if (root) {
      try { await removeAcceptanceRoot(root); if (result) result.cleanup = true; }
      catch { if (result) result.reasonCode = 'PROCESS_CLEANUP_FAILED'; }
    }
    send({ type: 'result', result });
    app.exit(result?.phase === 'passed' || result?.phase === 'partial' ? 0 : 1);
  }

}
void main();
