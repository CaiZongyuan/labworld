import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, posix, relative, resolve, sep } from 'node:path';
import { root } from './process.mjs';
import { loadLegacyConfigFields } from './legacy-config.mjs';
import { sitePath, validateSiteModel } from './docs-locales.mjs';

// Renders the public documentation in both locales from one declaration:
//
// - Chinese pages keep their published routes so existing deep links stay
//   valid; English pages mirror them under `en/` for chapters declared
//   bilingual in docs/site.json. Untranslated chapters are registered
//   migration items and appear in the Chinese navigation only.
// - Every generated page carries frontmatter (`docLocale` + `counterpart`)
//   so the site language switcher can land on the same chapter; chapters
//   without a translation fall back to the English documentation entry
//   instead of pretending one exists.
// - The API and configuration references are synthesized from the OpenAPI
//   contract and the Rust settings in both languages; operation ids, keys
//   and defaults stay the single facts they are generated from.

export function siteModel() {
  return validateSiteModel(
    JSON.parse(readFileSync(resolve(root, 'docs/site.json'), 'utf8')),
  );
}

function repositoryFile(source) {
  const absolute = resolve(root, source);
  if (!absolute.startsWith(root + sep) || !existsSync(absolute))
    throw new Error(
      `Missing/outside-repository documentation target: ${source}`,
    );
  return absolute;
}

const SNIPPET_LANGUAGES = {
  '.rs': 'rust',
  '.tsx': 'tsx',
  '.ts': 'ts',
  '.mjs': 'js',
  '.sql': 'sql',
};

// The other-locale path of a route, used by the language switcher.
// Untranslated chapters point at the English documentation entry instead
// of a page that does not exist.
function counterpartPath(route, locale, routePairs) {
  if (locale === 'zh') {
    const pair = routePairs.get(route);
    return pair?.en ? sitePath(pair.en) : '/en/docs/';
  }
  const zh = [...routePairs.entries()].find(([, value]) => value.en === route);
  return zh ? sitePath(zh[0]) : '/docs/';
}

// Page frontmatter: the locale pairing always, plus the layout page's own
// meta (declared per chapter in docs/site.json) so the Landing and the
// Coming soon pages carry honest titles and descriptions in both locales.
// `sidebar: false` is required beside `layout: page`: this VitePress
// version only drops the sidebar column for `layout: home` otherwise.
function frontmatter(docLocale, counterpart, page = {}, navigation = {}) {
  const lines = [`docLocale: ${docLocale}`, `counterpart: ${counterpart}`];
  lines.push(`contentType: ${page.type ?? 'reference'}`);
  lines.push(`prev: ${JSON.stringify(navigation.previous ?? false)}`);
  lines.push(`next: ${JSON.stringify(navigation.next ?? false)}`);
  if (page.layout !== undefined) {
    lines.push(`layout: ${page.layout}`, 'sidebar: false');
  }
  const title = docLocale === 'en' ? page.pageTitleEn : page.pageTitle;
  const description =
    docLocale === 'en' ? page.pageDescriptionEn : page.pageDescription;
  if (title !== undefined) lines.push(`title: "${title}"`);
  if (description !== undefined) lines.push(`description: "${description}"`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

// Resolves one Markdown link of one rendered page to its published href.
// Links resolve against the repository-relative source directory (the
// English `.en.md` files sit next to their Chinese siblings, so sibling
// links keep resolving to the canonical source). When rendering an English
// page whose destination is bilingual, the English route wins; a missing
// translation falls back to the Chinese page and never fabricates one.
function resolveLink({
  target,
  sourceDir,
  locale,
  currentRoute,
  routes,
  sourceLink,
}) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, fragment] = target.split('#');
  const withFragment = (href) => (fragment ? `${href}#${fragment}` : href);
  if (path.startsWith('site:')) {
    const route = path.slice(5);
    const pair = routes.get(route);
    const destination = pair
      ? locale === 'en'
        ? (pair.en ?? pair.zh)
        : pair.zh
      : undefined;
    if (!destination) throw new Error(`Unknown generated reference: ${route}`);
    return withFragment(crossLocaleHref(destination, locale, currentRoute));
  }
  const destination = relative(
    root,
    repositoryFile(resolve(sourceDir, decodeURIComponent(path))),
  );
  const pair = routes.get(destination);
  const route = pair
    ? locale === 'en'
      ? (pair.en ?? pair.zh)
      : pair.zh
    : undefined;
  if (!route) return withFragment(sourceLink(destination));
  return withFragment(crossLocaleHref(route, locale, currentRoute));
}

// A rendered link stays relative inside its own locale (VitePress resolves
// `.md` links against the source file path, which the `en/` mirror keeps
// aligned). A link that crosses locales — an English reader opening a
// chapter without a translation — uses the site-absolute Chinese path so
// the reader lands on the real page instead of a broken en/ mirror.
function crossLocaleHref(route, locale, currentRoute) {
  const inLocale = locale === 'zh' || route.startsWith('en/');
  return inLocale
    ? posix.relative(posix.dirname(currentRoute), route)
    : sitePath(route);
}

function transformContent({
  sourcePath,
  route,
  locale,
  routes,
  sourceRef,
  sourceLink,
}) {
  let content = readFileSync(sourcePath, 'utf8');
  content = content.replace(/^<<<\s+(.+)$/gm, (_line, target) => {
    const snippet = repositoryFile(
      relative(root, resolve(dirname(sourcePath), target.trim())),
    );
    const language = SNIPPET_LANGUAGES[extname(snippet)] ?? 'text';
    return `\n\`\`\`${language}\n${readFileSync(snippet, 'utf8').trimEnd()}\n\`\`\`\n`;
  });
  content = content.replace(
    /\]\(([^)]+)\)/g,
    (_match, target) =>
      `](${resolveLink({
        target,
        sourceDir: dirname(sourcePath),
        locale,
        currentRoute: route,
        routes,
        sourceLink,
      })})`,
  );
  const footerLabel = locale === 'en' ? 'Source version' : '源码版本';
  const markdownLabel = locale === 'en' ? 'Page Markdown' : '本页 Markdown';
  content += `\n\n---\n${footerLabel}：\`${sourceRef.slice(0, 12)}\` · [${markdownLabel}](${sourceLink(relative(root, sourcePath))})\n`;
  return content;
}

function localizedReferenceTexts() {
  return {
    zh: {
      currentApiTitle:
        '\n\n## 当前 TypeScript Core\n\n下表直接来自 Node 服务的 Zod/OpenAPI。字节 capability 的 `/objects/:id` 由 FileService 返回；Lab 迁移范围见 [平台指南](../guides/server-platform.md)。',
      legacyApiTitle: '\n\n## 保留的完整冻结合同\n',
      currentConfigTitle:
        '\n\n## 当前 Lab Word Server\n\n默认值由 [config.ts]({{serverConfig}}) 的实际解析器生成。Web 的 `WEB_PORT` 和 `VITE_API_PROXY` 由开发入口和 Vite 读取。',
      legacyConfigTitle: '\n\n## 冻结旧栈元数据\n',

      apiIntro: (version) =>
        `# API 合同\n\n保留的完整 Rust OpenAPI 冻结参考（版本 ${version}）。新服务的已迁移范围见 [TypeScript 服务基础](../guides/server-foundation.md)。完整客户端合同仍待切换。`,
      apiTable:
        '\n\n| 方法 | 路径 | operationId | 响应 |\n| --- | --- | --- | --- |\n',
      apiOutro:
        '\n[下载 OpenAPI JSON](SITE_LINK:public/openapi.json)。新开发服务的 `/api/openapi.json` 当前只包含已迁移端点。响应和 SDK 不维护手写的第二份 DTO。\n',
      configIntro:
        '# API 配置\n\n当前 Node 配置来自运行服务的解析器。下方另列冻结旧栈的 Settings/FIELDS 元数据，并校验旧源码哈希。使用方法见 [平台指南](../guides/server-platform.md)。生产秘密不进入文档。',
      configTable:
        '\n\n| 变量 | 默认值 | 敏感值 | 说明 |\n| --- | --- | --- | --- |\n',
      configDescription: (field) => field.descriptionZh,
      configOutro:
        '\n[.env.example]({{envExample}}) 仍包含冻结旧栈字段。当前 Node 服务不读取 DATABASE_URL、Redis 或 RustFS 配置。服务与 Web 的启动见 [TypeScript 服务基础](../guides/server-foundation.md)。\n',
      required: '必填',
      secretYes: '是',
      secretNo: '否',
    },
    en: {
      currentApiTitle:
        '\n\n## Current TypeScript Core\n\nThis table comes directly from the Node Zod/OpenAPI source. FileService returns byte capabilities at `/objects/:id`. See the [platform guide](../guides/server-platform.md) for migration coverage.',
      legacyApiTitle: '\n\n## Retained complete frozen contract\n',
      currentConfigTitle:
        '\n\n## Current Lab Word Server\n\nDefaults come from the running parser in [config.ts]({{serverConfig}}). The development entrypoint and Vite read `WEB_PORT` and `VITE_API_PROXY`.',
      legacyConfigTitle: '\n\n## Frozen legacy metadata\n',

      apiIntro: (version) =>
        `# API contract\n\nFrozen reference for the retained full Rust OpenAPI (version ${version}). See [TypeScript service foundation](../guides/server-foundation.md) for migrated service coverage. The complete client contract has not switched yet.`,
      apiTable:
        '\n\n| Method | Path | operationId | Responses |\n| --- | --- | --- | --- |\n',
      apiOutro:
        '\n[Download the OpenAPI JSON](SITE_LINK:public/openapi.json). The new development server currently exposes only migrated endpoints at `/api/openapi.json`. Responses and the SDK never maintain a hand-written second copy of the DTOs.\n',
      configIntro:
        '# API configuration\n\nCurrent Node settings come from the running parser. A separate table preserves frozen legacy Settings/FIELDS metadata and checks its source hashes. See the [platform guide](../guides/server-platform.md) for usage. Production secrets never enter the documentation.',
      configTable:
        '\n\n| Variable | Default | Secret | Description |\n| --- | --- | --- | --- |\n',
      configDescription: (field) => field.description,
      configOutro:
        '\n[.env.example]({{envExample}}) still contains frozen legacy fields. The current Node service does not read DATABASE_URL, Redis or RustFS settings. See [TypeScript service foundation](../guides/server-foundation.md) to start the server and Web.\n',
      required: 'required',
      secretYes: 'yes',
      secretNo: 'no',
    },
  };
}

function renderApiReference(contract, texts, current) {
  let api = texts.apiIntro(contract.info.version);
  api += texts.currentApiTitle + texts.apiTable;
  for (const [path, item] of Object.entries(current.paths))
    for (const [method, operation] of Object.entries(item))
      api += `| ${method.toUpperCase()} | \`${path}\` | \`${operation.operationId}\` | ${Object.keys(operation.responses).join(', ')} |\n`;
  api += texts.legacyApiTitle;
  api += texts.apiTable;
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      api += `| ${method.toUpperCase()} | \`${path}\` | \`${operation.operationId}\` | ${Object.keys(operation.responses).join(', ')} |\n`;
    }
  }
  return api + texts.apiOutro;
}

function renderConfigReference(
  fields,
  exampleText,
  texts,
  sourceLink,
  current,
) {
  let config = texts.configIntro;
  config +=
    texts.currentConfigTitle.replace(
      '{{serverConfig}}',
      sourceLink('apps/server/src/config.ts'),
    ) + texts.configTable;
  for (const field of current)
    config += `| \`${field.name}\` | ${field.default} | ${field.secret ? texts.secretYes : texts.secretNo} | ${texts.configDescription(field)} |\n`;
  config += texts.legacyConfigTitle;
  config += texts.configTable;
  for (const field of fields) {
    if (!new RegExp(`^${field.name}=`, 'm').test(exampleText))
      throw new Error(`.env.example is missing ${field.name}`);
    config += `| \`${field.name}\` | ${field.default ?? texts.required} | ${field.secret ? texts.secretYes : texts.secretNo} | ${texts.configDescription(field)} |\n`;
  }
  return (
    config +
    texts.configOutro.replace('{{envExample}}', sourceLink('.env.example'))
  );
}

export function renderDocs() {
  const site = siteModel();
  const chapters = new Map(
    [...site.pages, ...site.references].map((page) => [page.id, page]),
  );
  const navigationFor = (page, locale) =>
    Object.fromEntries(
      ['previous', 'next'].map((direction) => {
        const target = chapters.get(page[direction]);
        const english = locale === 'en' && target?.bilingual;
        return [
          direction,
          target
            ? {
                text: english ? target.titleEn : target.title,
                link: sitePath(english ? target.routeEn : target.route),
              }
            : false,
        ];
      }),
    );
  const pages = new Map();
  const put = (route, content) => {
    if (pages.has(route))
      throw new Error(`duplicate rendered documentation route: ${route}`);
    pages.set(route, content);
  };

  const repo = process.env.GITHUB_REPOSITORY ?? site.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('Invalid documentation repository');
  const sourceRef =
    process.env.DOCS_SOURCE_REF ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  const sourceLink = (source) =>
    `https://github.com/${repo}/blob/${sourceRef}/${source}`;

  // Route tables for the full published set: `routes` maps a repository
  // source path (and each reference route) to its { zh, en } pair so every
  // locale's links resolve against it; `routePairs` indexes the same pairs
  // by Chinese route for counterpart lookup.
  const routes = new Map();
  const routePairs = new Map();
  for (const page of site.pages) {
    if (
      !page.route.endsWith('.md') ||
      page.route.startsWith('/') ||
      page.route.includes('..')
    )
      throw new Error(`Invalid documentation route: ${page.route}`);
    if (page.source === undefined) continue;
    const pair = { zh: page.route, en: page.bilingual ? page.routeEn : null };
    routes.set(page.source, pair);
    if (page.bilingual)
      routes.set(page.sourceEn, { zh: page.route, en: page.routeEn });
    routePairs.set(page.route, pair);
  }
  for (const reference of site.references) {
    const pair = { zh: reference.route, en: reference.routeEn };
    routes.set(reference.route, pair);
    routePairs.set(reference.route, pair);
  }

  for (const page of site.pages) {
    if (page.source === undefined) continue;
    put(
      page.route,
      frontmatter(
        'zh',
        counterpartPath(page.route, 'zh', routePairs),
        page,
        navigationFor(page, 'zh'),
      ) +
        transformContent({
          sourcePath: repositoryFile(page.source),
          route: page.route,
          locale: 'zh',
          routes,
          sourceRef,
          sourceLink,
        }),
    );
    if (page.bilingual)
      put(
        page.routeEn,
        frontmatter(
          'en',
          counterpartPath(page.routeEn, 'en', routePairs),
          page,
          navigationFor(page, 'en'),
        ) +
          transformContent({
            sourcePath: repositoryFile(page.sourceEn),
            route: page.routeEn,
            locale: 'en',
            routes,
            sourceRef,
            sourceLink,
          }),
      );
  }

  const contractPath = repositoryFile('packages/contracts/openapi.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const fields = loadLegacyConfigFields(root);
  const currentFields = JSON.parse(
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/server-config-reference.ts'],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  const currentApi = JSON.parse(
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'apps/server/src/openapi.ts'],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  const example = readFileSync(repositoryFile('.env.example'), 'utf8');
  const texts = localizedReferenceTexts();
  const api = site.references.find((r) => r.id === 'api-reference');
  const config = site.references.find((r) => r.id === 'config-reference');
  for (const locale of ['zh', 'en']) {
    const localized = texts[locale];
    const apiRoute = locale === 'en' ? api.routeEn : api.route;
    const configRoute = locale === 'en' ? config.routeEn : config.route;
    put(
      apiRoute,
      frontmatter(locale, counterpartPath(apiRoute, locale, routePairs)) +
        renderApiReference(contract, localized, currentApi).replaceAll(
          // VitePress publishes the srcDir public/ dir at the site root, so
          // the download lives at /openapi.json, not /public/openapi.json.
          'SITE_LINK:public/openapi.json',
          posix.relative(posix.dirname(apiRoute), 'openapi.json'),
        ),
    );
    put(
      configRoute,
      frontmatter(locale, counterpartPath(configRoute, locale, routePairs)) +
        renderConfigReference(
          fields,
          example,
          localized,
          sourceLink,
          currentFields,
        ),
    );
  }
  put('public/openapi.json', readFileSync(contractPath, 'utf8'));

  for (const page of [...site.pages, ...site.references])
    if (!pages.has(page.route) || (page.bilingual && !pages.has(page.routeEn)))
      throw new Error(`Navigation points at a missing page: ${page.route}`);
  return pages;
}
