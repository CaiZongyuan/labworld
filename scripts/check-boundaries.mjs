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
const modulesRoot = join(root, 'crates/app/src/modules');
const modules = readdirSync(modulesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(modulesRoot, entry.name);
    const description = JSON.parse(
      readFileSync(join(directory, 'module.json'), 'utf8'),
    );
    return { ...description, name: entry.name, directory };
  });
const references = modules.filter((module) => module.kind === 'reference');
const tableOwners = new Map();
for (const module of modules) {
  for (const table of module.tables) {
    if (tableOwners.has(table))
      throw new Error(`Duplicate table ownership: ${table}`);
    tableOwners.set(table, module.name);
  }
}
for (const path of files(join(root, 'migrations'), /\.sql$/)) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi,
  )) {
    if (!tableOwners.has(match[1]))
      throw new Error(
        `Migration creates an unowned table ${match[1]}: ${path}`,
      );
  }
}
for (const module of modules) {
  for (const path of files(module.directory, /\.rs$/)) {
    const source = readFileSync(path, 'utf8');
    const literals = source.match(/"(?:\\.|[^"\\])*"/gs) ?? [];
    for (const literal of literals.filter((text) =>
      /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text),
    )) {
      for (const [table, owner] of tableOwners) {
        if (
          new RegExp(`\\b${table.replaceAll('.', '\\.')}\\b`).test(literal) &&
          owner !== module.name
        )
          throw new Error(
            `${module.name} reads/writes ${owner}'s table ${table}: ${path}`,
          );
      }
    }
    const code = source
      .replace(/"(?:\\.|[^"\\])*"/gs, '""')
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    if (module.kind === 'core') {
      for (const reference of references) {
        if (
          new RegExp(
            `\\b(?:use[^;]*|(?:crate|super|self)::(?:modules::)?)\\b${reference.name}\\b`,
          ).test(code)
        )
          throw new Error(
            `Core imports reference module ${reference.name}: ${path}`,
          );
      }
    }
    if (
      path.endsWith('/domain.rs') &&
      /\b(axum|sqlx|redis|aws_sdk_s3|opentelemetry)::/.test(code)
    )
      throw new Error(`Pure Domain imports infrastructure: ${path}`);
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
            const target = dependency.startsWith('.')
              ? resolve(dirname(path), dependency)
              : '';
            if (target === viewRoot || target.startsWith(viewRoot + sep))
              throw new Error(`Core imports reference Views: ${path}`);
            if (
              ['@labos-threejs/contracts', '@labos-threejs/sdk'].includes(
                dependency,
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
                throw new Error(`Core imports a reference contract: ${path}`);
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
  `Package imports and ${modules.length} retained module ownership declarations verified; TypeScript server boundaries verified. Dynamic SQL still requires review.`,
);
