import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import ts from 'typescript';

export interface LocalModelCapabilityBoundaryScan {
  forbiddenDependencies: string[];
  unsafeShellAssignments: string[];
}

const forbiddenDependency = /(?:@myself\/file-tools|file-tool-service|path-policy|powershell|electron(?:\/|$))/iu;
const forbiddenCapabilityIdentifier = new Set([
  'AuthorizedRoot',
  'FileToolService',
  'PathPolicy',
  'PowerShellPort',
  'PowerShellTool'
]);

/** 静态扫描只验证能力依赖与 shell 开关，不缓存源码或任何运行期敏感值。 */
export async function scanLocalModelCapabilityBoundary(
  files: readonly string[]
): Promise<LocalModelCapabilityBoundaryScan> {
  const forbiddenDependencies: string[] = [];
  const unsafeShellAssignments: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
        && forbiddenDependency.test(node.moduleSpecifier.text)
      ) {
        forbiddenDependencies.push(`${basename(file)}:${node.moduleSpecifier.text}`);
      }
      if (
        ts.isIdentifier(node)
        && forbiddenCapabilityIdentifier.has(node.text)
      ) {
        forbiddenDependencies.push(`${basename(file)}:${node.text}`);
      }
      if (
        ts.isPropertyAssignment(node)
        && (
          (ts.isIdentifier(node.name) && node.name.text === 'shell')
          || (ts.isStringLiteral(node.name) && node.name.text === 'shell')
        )
        && node.initializer.kind !== ts.SyntaxKind.FalseKeyword
      ) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        unsafeShellAssignments.push(`${basename(file)}:${location.line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { forbiddenDependencies, unsafeShellAssignments };
}
