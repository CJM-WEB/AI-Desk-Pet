// ripgrep 只在开发／构建期准备；目标机只消费校验后的固定文件，不联网或搜索 PATH。
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');

const SHA256 = /^[a-f0-9]{64}$/u;

function parseArguments(values) {
  const result = { offline: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--offline') {
      result.offline = true;
      continue;
    }
    if (!['--manifest', '--cache', '--output', '--archive'].includes(value)) {
      throw new Error('RIPGREP_ARGUMENT_INVALID');
    }
    const next = values[index + 1];
    if (!next) throw new Error('RIPGREP_ARGUMENT_INVALID');
    result[value.slice(2)] = path.resolve(next);
    index += 1;
  }
  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new Error('RIPGREP_MANIFEST_INVALID');
  }
  const archive = manifest?.archive;
  const files = manifest?.files;
  if (
    manifest?.schemaVersion !== 1
    || typeof manifest.repository !== 'string'
    || typeof manifest.releaseTag !== 'string'
    || !/^[a-f0-9]{40}$/u.test(manifest.tagObject)
    || !/^[a-f0-9]{40}$/u.test(manifest.commit)
    || typeof archive?.url !== 'string'
    || typeof archive.file !== 'string'
    || !Number.isSafeInteger(archive.size)
    || !SHA256.test(archive.sha256)
    || typeof archive.root !== 'string'
    || !Array.isArray(files)
    || files.length < 2
  ) {
    throw new Error('RIPGREP_MANIFEST_INVALID');
  }
  const outputs = new Set();
  for (const fileEntry of files) {
    if (
      typeof fileEntry?.archivePath !== 'string'
      || !fileEntry.archivePath.startsWith(archive.root)
      || fileEntry.archivePath.includes('..')
      || typeof fileEntry.outputPath !== 'string'
      || path.isAbsolute(fileEntry.outputPath)
      || fileEntry.outputPath.split(/[\\/]/u).includes('..')
      || outputs.has(fileEntry.outputPath)
      || !Number.isSafeInteger(fileEntry.size)
      || !SHA256.test(fileEntry.sha256)
      || !['executable', 'license'].includes(fileEntry.kind)
    ) {
      throw new Error('RIPGREP_MANIFEST_INVALID');
    }
    outputs.add(fileEntry.outputPath);
  }
  if (!files.some(item => item.kind === 'executable' && item.outputPath === 'rg.exe')) {
    throw new Error('RIPGREP_MANIFEST_INVALID');
  }
  return manifest;
}

async function readAndVerifyArchive(file, archive) {
  let value;
  try {
    value = await fsp.readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error('RIPGREP_ARCHIVE_READ_FAILED');
  }
  if (value.length !== archive.size) throw new Error('RIPGREP_ARCHIVE_SIZE_MISMATCH');
  if (sha256(value) !== archive.sha256) throw new Error('RIPGREP_ARCHIVE_HASH_MISMATCH');
  return value;
}

async function writeAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, value);
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function downloadArchive(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch {
    throw new Error('RIPGREP_DOWNLOAD_FAILED');
  }
  if (!response.ok) throw new Error('RIPGREP_DOWNLOAD_FAILED');
  return Buffer.from(await response.arrayBuffer());
}

async function ensureArchive(options, manifest) {
  if (options.archive) {
    const supplied = await readAndVerifyArchive(options.archive, manifest.archive);
    if (!supplied) throw new Error('RIPGREP_ARCHIVE_NOT_FOUND');
    await writeAtomic(options.cache, supplied);
    return options.cache;
  }
  try {
    const cached = await readAndVerifyArchive(options.cache, manifest.archive);
    if (cached) return options.cache;
  } catch (error) {
    if (options.offline) throw error;
  }
  if (options.offline) throw new Error('RIPGREP_ARCHIVE_UNAVAILABLE_OFFLINE');
  const downloaded = await downloadArchive(manifest.archive.url);
  if (downloaded.length !== manifest.archive.size) throw new Error('RIPGREP_ARCHIVE_SIZE_MISMATCH');
  if (sha256(downloaded) !== manifest.archive.sha256) throw new Error('RIPGREP_ARCHIVE_HASH_MISMATCH');
  await writeAtomic(options.cache, downloaded);
  return options.cache;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(new Error('RIPGREP_ARCHIVE_INVALID'));
      else resolve(zip);
    });
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new Error('RIPGREP_ARCHIVE_INVALID'));
        return;
      }
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.once('error', () => reject(new Error('RIPGREP_ARCHIVE_INVALID')));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function extractSelected(archiveFile, manifest) {
  const zip = await openZip(archiveFile);
  const expected = new Map(manifest.files.map(item => [item.archivePath, item]));
  const extracted = new Map();
  return new Promise((resolve, reject) => {
    const fail = () => {
      try { zip.close(); } catch {}
      reject(new Error('RIPGREP_ARCHIVE_INVALID'));
    };
    zip.once('error', fail);
    zip.on('entry', entry => {
      const specification = expected.get(entry.fileName);
      if (!specification) {
        zip.readEntry();
        return;
      }
      if (extracted.has(entry.fileName) || entry.uncompressedSize !== specification.size) {
        fail();
        return;
      }
      readEntry(zip, entry).then(value => {
        if (value.length !== specification.size || sha256(value) !== specification.sha256) {
          fail();
          return;
        }
        extracted.set(entry.fileName, value);
        zip.readEntry();
      }, fail);
    });
    zip.once('end', () => {
      if (extracted.size !== expected.size) {
        fail();
        return;
      }
      resolve(extracted);
    });
    zip.readEntry();
  });
}

async function main(values = process.argv.slice(2)) {
  const arguments_ = parseArguments(values);
  const manifestPath = arguments_.manifest ?? path.join(__dirname, 'resources', 'ripgrep-source.json');
  const manifest = await readManifest(manifestPath);
  const options = {
    ...arguments_,
    cache: arguments_.cache ?? path.join(__dirname, '.cache', manifest.archive.file),
    output: arguments_.output ?? path.join(__dirname, 'dist')
  };
  const archive = await ensureArchive(options, manifest);
  const files = await extractSelected(archive, manifest);
  for (const specification of manifest.files) {
    await writeAtomic(path.join(options.output, specification.outputPath), files.get(specification.archivePath));
  }
  const executable = manifest.files.find(item => item.kind === 'executable');
  await writeAtomic(path.join(options.output, 'ripgrep.json'), Buffer.from(`${JSON.stringify({
    file: executable.outputPath,
    sha256: executable.sha256
  }, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify({ releaseTag: manifest.releaseTag, sha256: executable.sha256 })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'RIPGREP_PREPARE_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
