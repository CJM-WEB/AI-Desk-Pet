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

function symbolComesFromChildProcessSpawn(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): boolean {
  if (!symbol) return false;
  return symbol.getName() === 'spawn'
    && (symbol.declarations ?? []).some(declaration => (
      /(?:^|[\\/])child_process\.d\.ts$/u.test(declaration.getSourceFile().fileName)
    ));
}

function expressionCanCallChildProcessSpawn(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  visited = new Set<ts.Symbol>()
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionCanCallChildProcessSpawn(checker, expression.expression, visited);
  }
  if (ts.isBinaryExpression(expression)) {
    return expressionCanCallChildProcessSpawn(checker, expression.left, visited)
      || expressionCanCallChildProcessSpawn(checker, expression.right, visited);
  }
  if (!ts.isIdentifier(expression)) return false;
  const direct = checker.getSymbolAtLocation(expression);
  const resolved = resolvedSymbol(checker, expression);
  if (symbolComesFromChildProcessSpawn(checker, resolved)) return true;
  if (!direct || visited.has(direct)) return false;
  visited.add(direct);
  return (direct.declarations ?? []).some(declaration => (
    ts.isVariableDeclaration(declaration)
    && declaration.initializer !== undefined
    && expressionCanCallChildProcessSpawn(checker, declaration.initializer, visited)
  ));
}

function symbolInitializer(symbol: ts.Symbol): ts.Expression | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function latestWholeAssignment(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  before: number
): ts.Expression | undefined {
  let latest: ts.BinaryExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(source) >= before) return;
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
      && checker.getSymbolAtLocation(node.left) === symbol
      && (!latest || node.getStart(source) > latest.getStart(source))
    ) latest = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return latest?.right;
}

function resolveBoolean(
  expression: ts.Expression,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  before: number,
  visited = new Set<ts.Symbol>()
): boolean | undefined {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return resolveBoolean(expression.expression, source, checker, before, visited);
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || visited.has(symbol)) return undefined;
  visited.add(symbol);
  const value = latestWholeAssignment(source, checker, symbol, before)
    ?? symbolInitializer(symbol);
  return value ? resolveBoolean(value, source, checker, before, visited) : undefined;
}

function objectExpressionAtCall(
  expression: ts.Expression,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  before: number
): { object: ts.ObjectLiteralExpression; symbol?: ts.Symbol } | undefined {
  if (ts.isObjectLiteralExpression(expression)) return { object: expression };
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  const assigned = latestWholeAssignment(source, checker, symbol, before)
    ?? symbolInitializer(symbol);
  if (!assigned) return undefined;
  const resolved = objectExpressionAtCall(assigned, source, checker, before);
  return resolved ? { ...resolved, symbol } : undefined;
}

function propertyBooleanAtCall(
  options: { object: ts.ObjectLiteralExpression; symbol?: ts.Symbol },
  name: 'shell' | 'windowsHide',
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  before: number
): boolean | undefined {
  let value: ts.Expression | undefined;
  for (const property of options.object.properties) {
    const propertyName = property.name
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : undefined;
    if (propertyName !== name) continue;
    if (ts.isPropertyAssignment(property)) value = property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) {
      const shorthand = checker.getShorthandAssignmentValueSymbol(property);
      value = shorthand ? symbolInitializer(shorthand) : undefined;
    }
  }
  if (options.symbol) {
    let latest: ts.BinaryExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (node.getStart(source) >= before) return;
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && node.left.name.text === name
        && checker.getSymbolAtLocation(node.left.expression) === options.symbol
        && (!latest || node.getStart(source) > latest.getStart(source))
      ) latest = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (latest) value = latest.right;
  }
  return value ? resolveBoolean(value, source, checker, before) : undefined;
}

/**
 * 以正式入口建立 TypeScript 语义图，再检查传递依赖与最终 child_process.spawn 参数。
 * 未能静态证明 shell:false、windowsHide:true 的调用按不安全处理。
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
      if (
        ts.isCallExpression(node)
        && expressionCanCallChildProcessSpawn(checker, node.expression)
      ) {
        const optionsExpression = node.arguments[2];
        const options = optionsExpression
          ? objectExpressionAtCall(optionsExpression, source, checker, node.getStart(source))
          : undefined;
        const safe = options
          && propertyBooleanAtCall(options, 'shell', source, checker, node.getStart(source)) === false
          && propertyBooleanAtCall(options, 'windowsHide', source, checker, node.getStart(source)) === true;
        if (!safe) {
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
