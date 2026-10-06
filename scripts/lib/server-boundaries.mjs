import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import ts from 'typescript';
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.(ts|tsx)$/.test(path)
        ? [path]
        : [];
  });
}
export function checkServerBoundaries(directory) {
  if (!existsSync(directory))
    throw new Error('Server source root does not exist');
  const sourcePaths = files(directory);
  const graph = new Map();
  for (const path of sourcePaths) {
    const imports = [];
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
          throw new Error(
            `Dynamic module name defeats boundary validation: ${path}`,
          );
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    const edges = imports.map((name) => {
      const candidate = name.startsWith('.')
        ? resolve(dirname(path), name)
        : undefined;
      const target = candidate
        ? [candidate, candidate + '.ts', join(candidate, 'index.ts')].find(
            (p) => existsSync(p) && sourcePaths.includes(p),
          )
        : undefined;
      return { name, target };
    });
    graph.set(path, edges);
    for (const { name } of edges)
      if (
        /^(@electric-sql\/pglite|pg|postgres|embedded-postgres)(\/|$)/.test(
          name,
        ) &&
        !path.startsWith(join(directory, 'platform/db') + sep)
      )
        throw new Error(`Only platform/db owns the database driver: ${path}`);
  }
  function traverse(path, rule, seen = new Set()) {
    if (seen.has(path)) return;
    seen.add(path);
    for (const edge of graph.get(path) ?? []) {
      rule(edge);
      if (edge.target) traverse(edge.target, rule, seen);
    }
  }
  for (const path of sourcePaths) {
    if (path.startsWith(join(directory, 'core') + sep))
      traverse(path, (edge) => {
        if (
          edge.target?.startsWith(join(directory, 'lab') + sep) ||
          /^@labos-threejs\/server\/lab(\/|$)/.test(edge.name)
        )
          throw new Error(`Core imports Lab: ${path}`);
      });
    if (/(?:^|[/\\])domain(?:[/\\]|\.ts$)/.test(path))
      traverse(path, (edge) => {
        if (
          /^(node:|hono(?:\/|$)|@hono\/|drizzle-orm(?:\/|$)|@electric-sql\/pglite(?:\/|$))/.test(
            edge.name,
          )
        )
          throw new Error(`Pure Domain imports infrastructure: ${path}`);
      });
  }
  return sourcePaths.length;
}
