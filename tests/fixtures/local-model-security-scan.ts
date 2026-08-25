import { basename, dirname } from 'node:path';
import ts from 'typescript';

export interface LocalModelCapabilityBoundaryScan {
  forbiddenDependencies: string[];
  unsafeSpawnOptions: string[];
}

const forbiddenDependency = /(?:@myself\/file-tools|file-tool-service|path-policy|powershell|electron(?:\/|$))/iu;
const forbiddenCapabilityIdentifier = /^(?:AuthorizedRoot|authRoot|authorizedRoot|FileToolService|PathPolicy|PowerShellPort|PowerShellTool)$/u;

function compilerOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    return {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      skipLibCheck: true
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error('LOCAL_MODEL_SECURITY_TSCONFIG_INVALID');
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

type ChildProcessCallKind = 'spawn' | 'exec' | 'namespace';

function childProcessBindings(
  sources: readonly ts.SourceFile[],
  checker: ts.TypeChecker
): ReadonlyMap<ts.Symbol, ChildProcessCallKind> {
  const bindings = new Map<ts.Symbol, ChildProcessCallKind>();
  for (const source of sources) {
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || !['node:child_process', 'child_process'].includes(statement.moduleSpecifier.text)
      ) continue;
      const clause = statement.importClause;
      if (!clause?.namedBindings) continue;
      if (ts.isNamespaceImport(clause.namedBindings)) {
        const symbol = checker.getSymbolAtLocation(clause.namedBindings.name);
        if (symbol) bindings.set(symbol, 'namespace');
        continue;
      }
      for (const element of clause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName !== 'spawn' && importedName !== 'exec') continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) bindings.set(symbol, importedName);
      }
    }
  }
  return bindings;
}

function isChildProcessNamespace(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: ReadonlyMap<ts.Symbol, ChildProcessCallKind>,
  visited = new Set<ts.Symbol>()
): boolean {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return isChildProcessNamespace(expression.expression, checker, bindings, visited);
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || visited.has(symbol)) return false;
  if (bindings.get(symbol) === 'namespace') return true;
  visited.add(symbol);
  return (symbol.declarations ?? []).some(declaration => (
    ts.isVariableDeclaration(declaration)
    && declaration.initializer !== undefined
    && isChildProcessNamespace(declaration.initializer, checker, bindings, visited)
  ));
}

function childProcessCallKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: ReadonlyMap<ts.Symbol, ChildProcessCallKind>,
  visited = new Set<ts.Symbol>()
): Exclude<ChildProcessCallKind, 'namespace'> | undefined {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return childProcessCallKind(expression.expression, checker, bindings, visited);
  if (ts.isPropertyAccessExpression(expression)) {
    if (isChildProcessNamespace(expression.expression, checker, bindings)) {
      return expression.name.text === 'spawn' ? 'spawn' : 'exec';
    }
    return undefined;
  }
  if (ts.isElementAccessExpression(expression)) {
    if (!isChildProcessNamespace(expression.expression, checker, bindings)) return undefined;
    return ts.isStringLiteral(expression.argumentExpression)
      && expression.argumentExpression.text === 'spawn'
      ? 'spawn'
      : 'exec';
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = childProcessCallKind(expression.whenTrue, checker, bindings, new Set(visited));
    const whenFalse = childProcessCallKind(expression.whenFalse, checker, bindings, new Set(visited));
    if (!whenTrue && !whenFalse) return undefined;
    return whenTrue === 'spawn' && whenFalse === 'spawn' ? 'spawn' : 'exec';
  }
  if (ts.isBinaryExpression(expression)) {
    const left = childProcessCallKind(expression.left, checker, bindings, new Set(visited));
    const right = childProcessCallKind(expression.right, checker, bindings, new Set(visited));
    if (!left && !right) return undefined;
    return left === 'spawn' && right === 'spawn' ? 'spawn' : 'exec';
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || visited.has(symbol)) return undefined;
  const direct = bindings.get(symbol);
  if (direct === 'spawn' || direct === 'exec') return direct;
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const alias = childProcessCallKind(declaration.initializer, checker, bindings, visited);
      if (alias) return alias;
    }
  }
  return undefined;
}

function unwrapLiteralExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return unwrapLiteralExpression(expression.expression);
  return expression;
}

/** 只有调用点不可变的内联安全字面量可通过；任何间接状态或动态合并均失败关闭。 */
function hasProvablySafeSpawnOptions(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker
): boolean {
  if (!expression) return false;
  const literal = unwrapLiteralExpression(expression);
  if (!ts.isObjectLiteralExpression(literal)) return false;
  let shellSafe = false;
  let windowsHidden = false;
  const seen = new Set<string>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) return false;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return false;
    const name = property.name.text;
    if (seen.has(name)) return false;
    seen.add(name);
    const value = unwrapLiteralExpression(property.initializer);
    if (name === 'shell') {
      if (
        value.kind !== ts.SyntaxKind.FalseKeyword
        || checker.typeToString(checker.getTypeAtLocation(value)) !== 'false'
      ) return false;
      shellSafe = true;
    }
    if (name === 'windowsHide') {
      if (
        value.kind !== ts.SyntaxKind.TrueKeyword
        || checker.typeToString(checker.getTypeAtLocation(value)) !== 'true'
      ) return false;
      windowsHidden = true;
    }
  }
  return shellSafe && windowsHidden;
}

/**
 * 以正式入口建立 TypeScript 语义图，再检查传递依赖与 child_process 调用。
 * exec 固定违规；spawn 未能证明为内联不可变安全字面量时按不安全处理。
 */
export async function scanLocalModelCapabilityBoundary(
  files: readonly string[]
): Promise<LocalModelCapabilityBoundaryScan> {
  const program = ts.createProgram({ rootNames: [...files], options: compilerOptions() });
  const checker = program.getTypeChecker();
  const forbiddenDependencies = new Set<string>();
  const unsafeSpawnOptions = new Set<string>();
  const sources = program.getSourceFiles().filter(source => (
    !source.isDeclarationFile && !/[\\/]node_modules[\\/]/u.test(source.fileName)
  ));
  const processBindings = childProcessBindings(sources, checker);

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const moduleSymbol = resolvedSymbol(checker, node.moduleSpecifier);
        const resolvedFiles = (moduleSymbol?.declarations ?? [])
          .map(declaration => declaration.getSourceFile().fileName);
        if (
          forbiddenDependency.test(node.moduleSpecifier.text)
          || resolvedFiles.some(file => forbiddenDependency.test(file))
        ) forbiddenDependencies.add(`${basename(source.fileName)}:${node.moduleSpecifier.text}`);
      }
      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(checker, node);
        const names = [node.text, symbol?.getName() ?? ''];
        const declarationFiles = (symbol?.declarations ?? [])
          .map(declaration => declaration.getSourceFile().fileName);
        if (
          names.some(name => forbiddenCapabilityIdentifier.test(name))
          || declarationFiles.some(file => forbiddenDependency.test(file))
        ) forbiddenDependencies.add(`${basename(source.fileName)}:${node.text}`);
      }
      if (ts.isCallExpression(node)) {
        const callKind = childProcessCallKind(node.expression, checker, processBindings);
        const safe = callKind === 'spawn'
          && hasProvablySafeSpawnOptions(node.arguments[2], checker);
        if (callKind && !safe) {
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          unsafeSpawnOptions.add(`${basename(source.fileName)}:${location.line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    forbiddenDependencies: [...forbiddenDependencies].sort(),
    unsafeSpawnOptions: [...unsafeSpawnOptions].sort()
  };
}
