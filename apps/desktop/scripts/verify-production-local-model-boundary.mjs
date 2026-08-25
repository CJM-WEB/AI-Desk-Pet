import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const outputMain = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../out/main', import.meta.url))
);
const forbiddenMarkers = [
  'class MainE2eLocalModelRuntime',
  'new MainE2eLocalModelRuntime',
  'local-model-e2e-runtime',
  'LOCAL_MODEL_TEST_ASSEMBLER_PRIVATE_MARKER'
];

async function ordinaryFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await ordinaryFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

try {
  const contents = await Promise.all((await ordinaryFiles(outputMain)).map(path => readFile(path)));
  for (const marker of forbiddenMarkers) {
    if (contents.some(content => content.includes(Buffer.from(marker, 'utf8')))) {
      console.error(`LOCAL_MODEL_PRODUCTION_BOUNDARY_FAILED ${marker}`);
      process.exitCode = 1;
    }
  }
} catch {
  console.error('LOCAL_MODEL_PRODUCTION_BOUNDARY_FAILED IO_ERROR');
  process.exitCode = 1;
}
