import { dirname, resolve } from "node:path";
import ts from "typescript";

export interface SchemaDigests { canonical: string; sourceBytes?: string }

/** Unknown schemas, wrong hashes and paths outside the index always fail closed. */
export function schemaMatches(uri: unknown, digest: unknown, index: ReadonlyMap<string, SchemaDigests>): boolean {
  if (typeof uri !== "string" || typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) return false;
  const source = index.get(uri);
  return source !== undefined && (digest === source.canonical || digest === source.sourceBytes);
}

/** Resolve relative imports as well as absolute imports; inspect dynamic import/require too. */
export function siblingImports(source: string, filename: string, repositoryRoot: string): string[] {
  const portable = (path: string) => path.replaceAll("\\", "/");
  const portableFilename = portable(filename);
  const own = portableFilename.match(/(?:^|\/)services\/providers\/([^/]+)/u)?.[1];
  const imports: string[] = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const check = (specifier: ts.Node | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const target = portable(specifier.text.startsWith(".") ? resolve(dirname(filename), specifier.text) : specifier.text);
    const match = target.match(/(?:^|\/)services\/providers\/([^/]+)/u);
    if (match && match[1] !== own) imports.push(specifier.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) check(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}
