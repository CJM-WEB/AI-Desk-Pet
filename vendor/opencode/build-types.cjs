// 上游与宿主分别按自己的编译选项验证；仅导出无 vendor 类型泄漏的宿主契约。
const path = require('node:path');
const ts = require('typescript');
const hostRoot = path.resolve(__dirname, '../../packages/coding-task-core');
const format = diagnostics => ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'
});
function program(configFile, overrides = {}) {
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(format([config.error]));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile), overrides);
  if (parsed.errors.length) throw new Error(format(parsed.errors));
  return ts.createProgram(parsed.fileNames, parsed.options);
}
function check(diagnostics) { if (diagnostics.length) { process.stderr.write(format(diagnostics)); process.exit(1); } }
const upstream = program(path.join(__dirname, 'tsconfig.json'));
check(ts.getPreEmitDiagnostics(upstream));
const host = program(path.join(hostRoot, 'tsconfig.json'), { noEmit: false, declaration: true, emitDeclarationOnly: true });
// 已通过上游规则的源文件不受宿主新增的可选字段/索引策略改写；宿主文件的全部诊断仍是硬门禁。
check(ts.getPreEmitDiagnostics(host).filter(diagnostic => !diagnostic.file || path.resolve(diagnostic.file.fileName).startsWith(hostRoot + path.sep)));
const entry = host.getSourceFile(path.join(hostRoot, 'src/index.ts'));
check(host.getDeclarationDiagnostics(entry));
const emitted = host.emit(entry, undefined, undefined, true);
check(emitted.diagnostics);
if (emitted.emitSkipped) throw new Error('宿主契约声明未生成');
process.stdout.write('上游类型检查、宿主 strict 类型检查与公共声明生成通过\n');
