// 从固定提交解析运行期静态导入闭包；不执行上游源码或复制产品目录。
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ts = require('typescript');
const commit = '2a6be0a03b93a6734070e10a6c3b56863475f214';
const read = p => cp.execFileSync('git', ['-C', 'D:/AgentLearning', 'show', `${commit}:${p}`], { maxBuffer: 30e6 });
const all = new Set(cp.execFileSync('git', ['-C', 'D:/AgentLearning', 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf8' }).trim().split('\n'));
const root = path.resolve('vendor/opencode');
const patches = JSON.parse(fs.readFileSync(path.join(root, 'local-patches.json'), 'utf8'));
const catalog = JSON.parse(read('package.json')).workspaces.catalog;
const manifests = {};
for (const f of all) if (/^packages\/[^/]+\/package.json$/.test(f)) { const m = JSON.parse(read(f)); manifests[m.name] = { path: path.posix.dirname(f), data: m }; }
const adapter = ts.createSourceFile('index.ts', fs.readFileSync(path.resolve('packages/coding-task-core/src/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const queue = [];
for (const statement of adapter.statements) {
  const spec = statement.moduleSpecifier?.text;
  if (!spec?.startsWith('@opencode-ai/')) continue;
  const name = spec.split('/').slice(0, 2).join('/');
  const pkg = manifests[name];
  const sub = '.' + spec.slice(name.length);
  const target = pkg.data.exports[sub] ?? pkg.data.exports['./*']?.replace('*', sub.slice(2));
  queue.push(path.posix.join(pkg.path, target));
}
// 宿主类型边界所需的上游类型门面，不引入额外产品服务。
queue.push('packages/core/src/file.ts', 'packages/core/src/integration/connection.ts', 'packages/core/src/v1/permission.ts', 'packages/schema/src/prompt-input.ts');
const seen = new Map();
const dependencies = {};
function resolve(base) { for (const p of [base, base + '.ts', base + '/index.ts', base + '.json']) if (all.has(p)) return p; throw new Error('无法解析 ' + base); }
while (queue.length) {
  const f = resolve(queue.shift()); if (seen.has(f)) continue;
  const raw = read(f); seen.set(f, { source: f, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
  const patch = patches.find(item => item.source === f);
  if (patch && seen.get(f).sha256 !== patch.upstreamSha256) throw new Error('补丁上游指纹不符 ' + f);
  const expected = patch ? Buffer.from(raw.toString().replace(patch.before, patch.after)) : raw;
  const out = path.join(root, f); fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && !fs.readFileSync(out).equals(expected)) throw new Error('本地文件存在未记录改动 ' + f);
  if (!fs.existsSync(out)) fs.writeFileSync(out, expected);
  if (!f.endsWith('.ts')) continue;
  const local = fs.readFileSync(out);
  seen.get(f).localSha256 = crypto.createHash('sha256').update(local).digest('hex');
  const js = ts.transpileModule(local.toString(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const ast = ts.createSourceFile(f, js, ts.ScriptTarget.Latest, true);
  const specs = ast.statements.filter(n => ts.isImportDeclaration(n) || ts.isExportDeclaration(n)).map(n => n.moduleSpecifier?.text).filter(Boolean);
  // 原数据库通过字面量动态导入注册迁移；图片转换器为未启用的可选能力。
  if (f.includes('/database/')) {
    const walk = n => { if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text); ts.forEachChild(n, walk); };
    walk(ast);
  }
  const owner = f.split('/').slice(0, 2).join('/'); dependencies[owner] ??= {};
  for (const spec of specs) {
    if (spec.startsWith('.')) queue.push(resolve(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))));
    else if (spec === '#sqlite') queue.push('packages/core/src/database/sqlite.node.ts');
    else if (spec === '#fff') queue.push('packages/core/src/filesystem/fff.node.ts');
    else if (spec.startsWith('@opencode-ai/')) {
      const name = spec.split('/').slice(0,2).join('/'); const pkg = manifests[name]; if (!pkg) throw new Error(spec);
      const sub = '.' + spec.slice(name.length); const exports = pkg.data.exports;
      let target = typeof exports === 'string' ? exports : exports[sub];
      if (!target && exports['./*']) target = exports['./*'].replace('*', sub.slice(2));
      if (!target) throw new Error('未识别导出 ' + spec);
      queue.push(resolve(path.posix.join(pkg.path, target)));
      if (owner !== pkg.path) dependencies[owner][name] = 'workspace:*';
    } else if (!spec.startsWith('node:') && !require('node:module').isBuiltin(spec)) {
      const name = spec.startsWith('@') ? spec.split('/').slice(0,2).join('/') : spec.split('/')[0];
      const pkg = Object.values(manifests).find(m => m.path === owner).data;
      let version = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? catalog[name];
      if (version === 'catalog:') version = catalog[name];
      if (!version) throw new Error('未固定版本 ' + spec);
      dependencies[owner][name] = version.replace(/^[~^]/, '');
    }
  }
}
for (const [owner, deps] of Object.entries(dependencies)) {
  const original = Object.values(manifests).find(m => m.path === owner).data;
  const exports = Object.fromEntries(Object.entries(original.exports).filter(([k,v]) => typeof v === 'string' && (v.includes('*') || seen.has(path.posix.join(owner,v)))));
  const m = { name: original.name, version: original.version, private: true, type: 'module', license: 'MIT', exports, dependencies: deps };
  if (owner === 'packages/core') m.imports = { '#sqlite': './src/database/sqlite.node.ts', '#fff': './src/filesystem/fff.node.ts' };
  if (owner === 'packages/core') m.devDependencies = {'@types/bun':'1.3.13', '@types/cross-spawn':'6.0.6', '@types/mime-types':'3.0.1', '@types/which':'3.0.4'};
  fs.writeFileSync(path.join(root, owner, 'package.json'), JSON.stringify(m, null, 2)+'\n');
}
fs.writeFileSync(path.join(root, 'LICENSE'), read('LICENSE'));
const packageManifests = Object.keys(dependencies).map(owner => ({ source: owner+'/package.json', sha256: crypto.createHash('sha256').update(read(owner+'/package.json')).digest('hex') }));
fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ commit, repository:'https://github.com/anomalyco/opencode', entry:'packages/coding-task-core/src/index.ts', files:[...seen.values()], packageManifests, dependencies }, null, 2)+'\n');
console.log(JSON.stringify({ files: seen.size, dependencies }, null, 2));
