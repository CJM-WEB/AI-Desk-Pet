import {
  createCloudBaseMigrationDryRun,
  inventoryCloudBaseMigrations
} from './cloudbase-migration-inventory.mjs';

/** 仅接受唯一的只读预览参数，防止 CLI 退化为数据库写入口。 */
function assertDryRunArguments(args) {
  if (args.length !== 1 || args[0] !== '--dry-run') {
    throw new Error('当前迁移入口仅允许 --dry-run');
  }
}

async function main() {
  assertDryRunArguments(process.argv.slice(2));
  const directoryUrl = new URL('../cloudbase/migrations/', import.meta.url);
  const inventory = await inventoryCloudBaseMigrations(directoryUrl);
  const plan = createCloudBaseMigrationDryRun(inventory);

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
