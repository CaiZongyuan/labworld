import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { root } from './lib/process.mjs';
import { checkServerBoundaries } from './lib/server-boundaries.mjs';
checkServerBoundaries(join(root, 'packages/server/src'));

const allowed = {
  contracts: [],
  sdk: ['@labos-threejs/contracts'],
  core: ['@labos-threejs/contracts'],
  ui: [],
  views: [
    '@labos-threejs/contracts',
    '@labos-threejs/sdk',
    '@labos-threejs/core',
    '@labos-threejs/ui',
  ],
};
function files(directory, extension = /\.(ts|tsx)$/) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path, extension)
      : extension.test(path) && !path.includes('.test.')
        ? [path]
        : [];
  });
}
const references = [
  JSON.parse(
    readFileSync(join(root, 'packages/server/src/lab/ownership.json'), 'utf8'),
  ),
];
const serverRoot = join(root, 'packages/server/src');
const tableOwners = new Map();
for (const path of files(serverRoot).filter((path) =>
  path.endsWith(`${sep}schema.ts`),
)) {
  const owner = path.startsWith(join(serverRoot, 'core') + sep)
    ? { name: 'core', schema: 'labos_threejs_core', binding: 'coreSchema' }
    : path.startsWith(join(serverRoot, 'lab') + sep)
      ? { name: 'lab', schema: 'lab', binding: 'labSchema' }
      : undefined;
  if (!owner) continue;
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'table'
    ) {
      if (
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== owner.binding ||
        !node.arguments[0] ||
        !ts.isStringLiteral(node.arguments[0])
      )
        throw new Error(`Table ownership must be explicit: ${path}`);
      const table = `${owner.schema}.${node.arguments[0].text}`;
      if (tableOwners.has(table))
        throw new Error(`Duplicate table ownership: ${table}`);
      tableOwners.set(table, owner.name);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const path of files(join(root, 'packages/server/migrations'), /\.sql$/)) {
  const source = readFileSync(path, 'utf8').replaceAll('"', '');
  for (const match of source.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi,
  )) {
    if (!tableOwners.has(match[1]))
      throw new Error(
        `Migration creates an unowned table ${match[1]}: ${path}`,
      );
  }
}
for (const [name, dependencies] of Object.entries(allowed)) {
  const directory = join(root, 'packages', name);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
  })) {
    if (
      dependency.startsWith('@labos-threejs/') &&
      !dependencies.includes(dependency)
    )
      throw new Error(`${pkg.name} cannot depend on ${dependency}`);
  }
  for (const path of files(join(directory, 'src'))) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const dependency = node.moduleSpecifier.text;
        const internal = dependency.startsWith('@labos-threejs/')
          ? dependency.split('/').slice(0, 2).join('/')
          : null;
        if (
          internal &&
          internal !== pkg.name &&
          !dependencies.includes(internal)
        )
          throw new Error(
            `${pkg.name} imports forbidden package ${internal}: ${path}`,
          );
        for (const reference of references) {
          const viewRoot = resolve(root, reference.viewPath);
          const isReference =
            path.startsWith(viewRoot + sep) ||
            (name === 'sdk' &&
              (reference.sdkPaths ?? []).some(
                (owned) => path === resolve(root, owned),
              ));
          if (!isReference && !path.includes(`${sep}generated${sep}`)) {
            if ((reference.contractSubpaths ?? []).includes(dependency))
              throw new Error(`Core imports a Lab contract subpath: ${path}`);
            const target = dependency.startsWith('.')
              ? resolve(dirname(path), dependency)
              : '';
            if (target === viewRoot || target.startsWith(viewRoot + sep))
              throw new Error(`Core imports Lab Views: ${path}`);
            if (
              ['@labos-threejs/contracts', '@labos-threejs/sdk'].includes(
                internal,
              ) &&
              ts.isImportDeclaration(node) &&
              node.importClause?.namedBindings
            ) {
              const bindings = node.importClause.namedBindings;
              if (
                ts.isNamedImports(bindings) &&
                bindings.elements.some((binding) =>
                  reference.contractSymbols.includes(
                    (binding.propertyName ?? binding.name).text,
                  ),
                )
              )
                throw new Error(`Core imports a Lab contract: ${path}`);
            }
          }
        }
        if (
          name === 'core' &&
          /^(react|react-dom|react-native|electron)(\/|$)/.test(dependency)
        )
          throw new Error(`Core must be platform independent: ${path}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
console.log(
  `Package imports and ${tableOwners.size} Node table ownership declarations verified; TypeScript server boundaries verified. Dynamic SQL still requires review.`,
);
