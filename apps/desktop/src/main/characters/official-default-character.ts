import type { CharacterStore } from './character-store';
import type { CharacterGeometryMigrationDependencies } from './character-migrations';
import { readOfficialDefaultBundle } from './official-default-character-installation';

/** 启动升级与激活分开，正常升级不能切换用户选择的其他角色。 */
export async function ensureOfficialDefaultCharacterInstalled(
  store: CharacterStore,
  resourceDirectory: string
): Promise<void> {
  // 先恢复上次中断；本次随包文件损坏也不能留下半安装的草稿与源图。
  await store.installOfficialDefaultCharacter();
  const bundle = await readOfficialDefaultBundle(resourceDirectory);
  await store.installOfficialDefaultCharacter(bundle);
}

/** 应急回退及用户明确启用默认时才改变活动角色；固定 V3 不再猜测帧或迁移几何。 */
export async function ensureOfficialDefaultCharacter(
  store: CharacterStore,
  resourceDirectory: string,
  _geometryMigration?: CharacterGeometryMigrationDependencies
): Promise<void> {
  await ensureOfficialDefaultCharacterInstalled(store, resourceDirectory);
  await store.setActive('builtin-default');
}
