import { build } from '../../apps/desktop/node_modules/esbuild/lib/main.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 固定诊断场景只使用合成数据；不修改生产源码、用户设置或正在运行的桌宠。
const repository = fileURLToPath(new URL('../../', import.meta.url));
const runnerPath = join(repository, 'apps/desktop/scripts/local-model-acceptance-runner.ts');
const corePath = join(repository, 'packages/coding-task-core/src/index.ts');
const sourceFiles = { runner: runnerPath, core: corePath,
  localModelProvider: join(repository, 'apps/desktop/src/main/providers/local-model-provider.ts'),
  codingModelConnection: join(repository, 'apps/desktop/src/main/providers/coding-model-connection.ts'),
  modelRoute: join(repository, 'packages/coding-task-core/src/model-route.ts') };
const resourceRoot = join(repository, 'apps/desktop/resources/local-model');
const hookName = 'ai-pet.qwen-followup-probe';
const hook = `globalThis[Symbol.for('${hookName}')]`;
const prompts = ['你帮我看看当前目录下都有什么呀', '当然可以让紫小宝看看啦', '那a目录下又有什么呀', '当然让紫小宝去看啦', '看吧，看看里面写了什么'];
const negatives = ['你觉得a目录需要整理吗？', '不要查看a目录，只告诉我如何整理文件夹。'];
const readOnlyCommands = ['dir', 'dir a', 'dir "a"', 'dir a\\*', 'type a\\abc.txt', 'Get-ChildItem', 'Get-ChildItem -LiteralPath a'];
const identity = { name: '紫小宝', description: '可爱、爱撒娇的紫色桌宠', background: '陪伴主人的合成验收角色', traits: ['可爱', '活泼', '爱撒娇'],
  languageStyle: '用温柔可爱的中文，自称紫小宝，称呼用户为主人。', formsOfAddress: ['主人'], likes: ['陪伴主人'], dislikes: [], boundaries: [], exampleLines: [], behavioralTendencies: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const emit = value => console.log(JSON.stringify(value));
const fail = code => { throw new Error(code); };
const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) fail('INJECTION_MATCH_NOT_UNIQUE');
  return source.replace(before, after);
};
const replaceBlock = (source, begin, end, replacement) => {
  if (source.split(begin).length !== 2 || source.split(end).length !== 2) fail('INJECTION_BLOCK_NOT_UNIQUE');
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  if (finish <= start) fail('INJECTION_BLOCK_INVALID');
  return replaceOnce(source, source.slice(start, finish), replacement);
};

// 先检查清单中的文件和大小；正式 Runtime 仍负责哈希、后端及进程校验。
async function checkResources() {
  const manifest = JSON.parse(await readFile(join(resourceRoot, 'manifest.json'), 'utf8'));
  const records = [manifest.notices, manifest.runtime.license, manifest.model.file, manifest.model.license,
    ...manifest.runtime.backends.cpu.files, ...manifest.runtime.backends.vulkan.files];
  for (const item of records) {
    const target = resolve(resourceRoot, item.path);
    if (!target.startsWith(resourceRoot + sep)) fail('RESOURCE_PATH_INVALID');
    const info = await stat(target);
    if (!info.isFile() || info.size !== item.size) fail('RESOURCE_SIZE_MISMATCH');
  }
  for (const file of ['windows-job-helper.exe', 'windows-job-helper.json', 'rg.exe', 'ripgrep.json']) {
    if (!(await stat(join(repository, 'packages/coding-task-core/dist', file))).isFile()) fail('CORE_RESOURCE_MISSING');
  }
  emit({ stage: 'RESOURCES_PRESENT', files: records.length, coreResources: 4, hashesVerified: false });
}

let testRoot = '', activeRound = null;
const rounds = [], calls = new Map(), reads = [];
const expectedFiles = new Set(['ab.txt', 'order.txt', 'test.txt', 'a/abc.txt']);
const localPath = value => {
  if (!testRoot || typeof value !== 'string') return null;
  const result = relative(testRoot, resolve(testRoot, value));
  return result === '..' || result.startsWith('..' + sep) || isAbsolute(result) ? null : result.replaceAll('\\', '/') || '.';
};
// 原事件只在当前测试会话内读取；只保存本次合成根的路径、内容和调用关联。
function observe(event) {
  if (event.kind === 'root') { testRoot = event.path; return; }
  if (event.kind === 'round') {
    activeRound = { index: rounds.length + 1, negative: event.negative, prompt: event.prompt, scopes: 0, tools: 0, success: false };
    rounds.push(activeRound);
    return;
  }
  if (event.kind === 'turn') {
    Object.assign(activeRound, { scopes: event.scopes, success: event.success, completedTools: event.completedTools, emptySummaryHint: event.emptySummaryHint });
    emit({ stage: 'ROUND', ...activeRound });
    if ([1, 3, 5].includes(activeRound.index)) emit({ stage: 'ROUND_SUMMARY', round: activeRound.index, text: event.text });
    activeRound = null;
    return;
  }
  if (event.kind === 'call') {
    if (activeRound) activeRound.tools++;
    if (event.tool === 'bash' && event.input?.command === 'dir "a"') {
      calls.set(event.id, { round: activeRound?.index ?? 0, command: event.input.command });
      return;
    }
    if (event.tool !== 'read') return;
    const path = localPath(event.input?.path);
    calls.set(event.id, { round: activeRound?.index ?? 0, path });
    emit({ stage: 'READ_CALL', round: activeRound?.index ?? 0, path: path ?? '<OUTSIDE_TEST_ROOT>',
      ...(Number.isInteger(event.input?.offset) ? { offset: event.input.offset } : {}),
      ...(Number.isInteger(event.input?.limit) ? { limit: event.input.limit } : {}) });
    return;
  }
  if (event.kind === 'bash') {
    const call = calls.get(event.id);
    if (call?.command !== 'dir "a"') return;
    const output = event.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    const listed = event.structured?.exit === 0 && event.structured?.timeout !== true && /\babc\.txt\b/.test(output);
    emit({ stage: 'COMMAND_RESULT', round: call.round, command: call.command, exit: event.structured?.exit ?? null, childListed: listed });
    return;
  }
  if (event.kind !== 'read') return;
  const call = calls.get(event.id), output = event.structured;
  if (!call || call.path === null || !output || typeof output !== 'object') return;
  const record = { round: call.round, path: call.path };
  if (Array.isArray(output.entries) && ['.', 'a'].includes(call.path)) {
    record.entries = output.entries.map(item => ({ path: item.path, type: item.type }));
    record.truncated = output.truncated === true;
  } else if (expectedFiles.has(call.path) && typeof output.content === 'string') {
    const expectedUri = pathToFileURL(join(testRoot, call.path)).href;
    record.uriMatches = output.uri === expectedUri;
    record.paged = output.type === 'text-page' && output.offset === 1;
    record.content = output.content;
    record.encoding = output.encoding ?? null;
  } else return;
  reads.push(record);
  emit({ stage: 'READ_RESULT', ...record });
}

if (process.argv.length > 2) fail('ARGUMENT_INVALID');
const prepareOnly = process.env.AI_PET_QWEN_FOLLOWUP_PREPARE === '1';
let bundleRoot, result, unchanged = false, bundleCleaned = false;
const originals = new Map();
try {
  await checkResources();
  for (const file of Object.values(sourceFiles)) originals.set(file, await readFile(file, 'utf8'));
  let source = originals.get(runnerPath).replaceAll('\r\n', '\n');
  source = replaceBlock(source, '  const note = randomUUID();', '  const events: TaskEvent[] = [];', `  const note = ''; const batch = ''; const kept = ''; const broken = ''; const testSource = '';
  await mkdir(join(authorizedRoot, 'a'));
  await writeFile(join(authorizedRoot, 'ab.txt'), '');
  await writeFile(join(authorizedRoot, 'order.txt'), '合成测试说明');
  await writeFile(join(authorizedRoot, 'test.txt'), '合成测试文件');
  await writeFile(join(authorizedRoot, 'a', 'abc.txt'), '');
  ${hook}({ kind: 'root', path: authorizedRoot });
`);
  source = replaceOnce(source, `identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
          name: '验收角色', description: '验收角色', background: '验收环境', traits: [],
          languageStyle: '简洁', likes: [], behavioralTendencies: []
        }`, `identity: ${JSON.stringify(identity)}`);
  source = replaceOnce(source,
    "          const text = requireSuccess(await turn('帮我看看 note.txt 里写了什么，把内容显示给我。'));\n          if (!text.includes(note) || !facts.slice(start).some(fact => fact.toolName === 'read' && fact.ok)) throw acceptanceError('DISK_CONTENT_MISSING');",
    `          let allPassed = true;
          for (const item of [...${JSON.stringify(prompts)}.map(prompt => ({ prompt, negative: false })), ...${JSON.stringify(negatives)}.map(prompt => ({ prompt, negative: true }))]) {
            if (item.negative) await composition.resetForConfigurationChange();
            const eventStart = events.length, factStart = facts.length;
            ${hook}({ kind: 'round', ...item });
            let success = false, text = '';
            try {
              const observed = await turn(item.prompt, item.negative ? { before: async () => { throw acceptanceError('NEGATIVE_SCOPE_REQUESTED'); } } : {});
              text = requireSuccess(observed);
              success = true;
            } catch { await composition.coordinator.cancelActive(); }
            const scopes = events.slice(eventStart).filter(event => event.type === 'capability_authorization_required').length;
            const completedTools = facts.length - factStart;
            if (!success || item.negative && (scopes !== 0 || completedTools !== 0)) allPassed = false;
            ${hook}({ kind: 'turn', success, scopes, completedTools, text, emptySummaryHint: /空|没有内容|没有任何内容|未写|没.{0,5}内容/.test(text) });
          }
          if (!allPassed) throw acceptanceError('FOLLOWUP_OR_NEGATIVE_FAILED');`);
  source = replaceOnce(source, '    ...(options.permission ? { resolvePermission: options.permission } : {}),',
    `    resolvePermission: options.permission ?? (async event => {
      if (event.request.action !== 'bash' || resolve(event.request.cwd) !== resolve(authorizedRoot)
        || !${JSON.stringify(readOnlyCommands)}.includes(event.request.command)) {
        console.log(JSON.stringify({ stage: 'UNEXPECTED_PERMISSION', action: event.request.action,
          ...(event.request.action === 'bash' ? { command: event.request.command, cwdMatches: resolve(event.request.cwd) === resolve(authorizedRoot) } : {}) }));
        throw acceptanceError('UNEXPECTED_PERMISSION');
      }
      await composition.coordinator.resolveFileAction(event.actionId, 'confirm');
    }),`);
  const core = replaceOnce(originals.get(corePath).replaceAll('\r\n', '\n'),
    '        if (data.sessionID !== sessionID) return;', `        if (data.sessionID !== sessionID) return;
        if (event.type === 'session.next.tool.called') ${hook}({ kind: 'call', id: String(data.callID), tool: data.tool, input: ['read', 'bash'].includes(String(data.tool)) ? data.input : undefined });
        if (event.type === 'session.next.tool.success' && ['read', 'bash'].includes(callNames.get(String(data.callID)) ?? '')) ${hook}({ kind: callNames.get(String(data.callID)), id: String(data.callID), structured: data.structured, content: callNames.get(String(data.callID)) === 'bash' ? data.content : undefined });`);
  bundleRoot = await mkdtemp(join(tmpdir(), 'ai-pet-qwen-followup-bundle-'));
  const output = join(bundleRoot, 'runner.mjs');
  await build({ entryPoints: [runnerPath], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    mainFields: ['module', 'main'], external: ['electron'], logLevel: 'silent',
    banner: { js: "import { createRequire as probeCreateRequire } from 'node:module'; const require = probeCreateRequire(import.meta.url);" },
    plugins: [{ name: 'fixed-qwen-followup-diagnostic', setup(builder) {
      builder.onLoad({ filter: /(?:local-model-acceptance-runner|index)\.ts$/ }, args => {
        const file = resolve(args.path);
        if (file !== runnerPath && file !== corePath) return;
        return { contents: file === runnerPath ? source : core, loader: 'ts', resolveDir: dirname(file) };
      });
    } }] });
  emit({ stage: 'PREPARED', sourceHashes: Object.fromEntries(Object.entries(sourceFiles).map(([name, file]) => [name, hash(originals.get(file))])), bundleHash: hash(await readFile(output)) });
  if (!prepareOnly) {
    if (globalThis[Symbol.for(hookName)] !== undefined) fail('PROBE_ALREADY_ACTIVE');
    globalThis[Symbol.for(hookName)] = observe;
    const runner = await import(pathToFileURL(output).href);
    result = await runner.runLocalModelAcceptance({ requestedBackend: 'vulkan', scenario: 'read', appPath: join(repository, 'apps/desktop'), resourceRoot,
      applicationVersion: '0.1.0-alpha.1' }, stage => emit({ stage }));
  }
} catch (error) {
  emit({ stage: 'PROBE_ERROR', code: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PROBE_FAILED' });
  process.exitCode = 1;
} finally {
  if (globalThis[Symbol.for(hookName)] === observe) delete globalThis[Symbol.for(hookName)];
  try {
    unchanged = originals.size === Object.keys(sourceFiles).length;
    for (const [file, original] of originals) unchanged &&= hash(original) === hash(await readFile(file));
    if (bundleRoot) {
      const actual = await realpath(bundleRoot);
      if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('ai-pet-qwen-followup-bundle-')) fail('BUNDLE_CLEANUP_ROOT_INVALID');
      await rm(actual, { recursive: true, force: true });
    }
    bundleCleaned = true;
  } catch { process.exitCode = 1; }
  // 明确请求必须在该轮申请并读取；后续确认或其他轮的结果不能补足前轮缺失。
  const rootListed = rounds[0]?.scopes > 0 && reads.some(item => item.round === 1 && item.path === '.' && item.truncated === false && item.entries?.length === 4
    && ['a', 'ab.txt', 'order.txt', 'test.txt'].every(name => item.entries.some(entry => entry.path.replace(/[\\/]+$/, '') === name && entry.type === (name === 'a' ? 'directory' : 'file'))));
  const childListed = rounds[2]?.scopes > 0 && reads.some(item => item.round === 3 && item.path === 'a' && item.truncated === false
    && item.entries?.length === 1 && item.entries[0].path === 'abc.txt' && item.entries[0].type === 'file');
  const emptyRead = reads.some(item => item.round === 5 && item.path === 'a/abc.txt' && item.content === '' && (item.uriMatches || item.paged));
  const negativesPassed = rounds.length === 7 && rounds.slice(5).every(item => item.success && item.scopes === 0 && item.tools === 0);
  const passed = prepareOnly ? unchanged && bundleCleaned : unchanged && bundleCleaned && result?.cleanup === true && result?.phase === 'partial'
    && rounds.length === 7 && rounds.every(item => item.success) && rootListed && childListed && emptyRead && rounds[4].emptySummaryHint && negativesPassed;
  emit({ stage: 'RESULT', mode: prepareOnly ? 'prepare' : 'diagnostic', automatedChecksPassed: passed && process.exitCode !== 1, summaryReview: prepareOnly ? 'not_run' : 'required',
    sourceUnchanged: unchanged, bundleCleaned, modelPhase: result?.phase ?? null, modelReason: result?.reasonCode ?? null, modelCleanup: result?.cleanup ?? null,
    rootListed, childListed, emptyRead, negativesPassed });
  if (!passed) process.exitCode = 1;
}
