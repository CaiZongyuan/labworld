// The bilingual documentation contract shared by the renderer
// (scripts/lib/docs.mjs), the VitePress config and the docs checks:
//
// - Every chapter has a stable `id`; the Chinese declaration is canonical
//   and the English route is always the Chinese route under `en/`.
// - A chapter is either fully bilingual (adjacent `.en.md` source plus an
//   English title) or an explicitly registered translation migration with
//   the published ticket that will deliver the translation.
// - Chapter groups carry an English label so both locales can render the
//   navigation from this one declaration.
//
// Validation throws on violations so `docs:check` and the renderer fail
// the build instead of publishing a half-declared site.

export const LOCALE_ROOTS = { zh: '', en: 'en/' };

export function docsBase(repository, override) {
  if (override !== undefined) return override;
  const project = repository.split('/')[1];
  return project.endsWith('.github.io') ? '/' : `/${project}/`;
}

// Tickets of the published UI plan (docs/plans/ui-redesign.md) that carry
// chapter translations: UI03 reworks the removal chapter, UI06-UI13 rework
// their feature chapters in this round, UI14 completes the remaining
// engineering/operations path.
const TRANSLATION_OWNERS = new Set([
  'UI03',
  'UI06',
  'UI07',
  'UI08',
  'UI09',
  'UI10',
  'UI11',
  'UI12',
  'UI13',
  'UI14',
]);

export function englishRoute(route) {
  return `${LOCALE_ROOTS.en}${route}`;
}

// Markdown route -> the site-absolute path VitePress publishes it under
// (`getting-started/quickstart.md` -> `/getting-started/quickstart`,
// `docs/index.md` -> `/docs/`, the public Landing `index.md` -> `/`).
// Shared by the renderer, the checks and the VitePress config so all three
// agree on published paths.
export function sitePath(route) {
  const withoutExtension = route.replace(/\.md$/, '');
  if (withoutExtension === 'index') return '/';
  return withoutExtension.endsWith('/index')
    ? `/${withoutExtension.replace(/\/index$/, '')}/`
    : `/${withoutExtension}`;
}

function assertBilingualShape(chapter) {
  const { sourceEn, titleEn } = chapter;
  if (sourceEn === undefined && titleEn === undefined)
    throw new Error(
      `chapter ${chapter.id} has no English translation; register it as a translation migration ({ "status": "pending", "owner": ... }) or deliver sourceEn/titleEn`,
    );
  if (titleEn === undefined)
    throw new Error(
      `chapter ${chapter.id} declares an English translation without a titleEn`,
    );
  if (sourceEn === undefined)
    throw new Error(
      `chapter ${chapter.id} declares an English translation without a sourceEn`,
    );
}

// Landing-style pages (`layout: "page"`) opt out of the sidebar and carry
// their own page meta. The meta must ship as complete zh/en pairs so both
// locales get honest titles/descriptions, and it is only meaningful on
// layout pages — a stray field elsewhere is a declaration mistake.
const LAYOUT_META_PAIRS = [
  ['pageTitle', 'pageTitleEn'],
  ['pageDescription', 'pageDescriptionEn'],
];

function assertLayoutDeclaration(chapter) {
  const metaFields = LAYOUT_META_PAIRS.flat();
  if (chapter.layout === undefined) {
    const stray = metaFields.filter((field) => chapter[field] !== undefined);
    if (stray.length)
      throw new Error(
        `chapter ${chapter.id} declares page meta (${stray.join(', ')}) without a layout; only layout pages carry page meta`,
      );
    return;
  }
  if (chapter.layout !== 'page')
    throw new Error(
      `chapter ${chapter.id} declares an unknown layout: ${chapter.layout}`,
    );
  for (const [zhKey, enKey] of LAYOUT_META_PAIRS)
    if ((chapter[zhKey] === undefined) !== (chapter[enKey] === undefined))
      throw new Error(
        `chapter ${chapter.id} declares ${zhKey}/${enKey} incompletely; page meta must ship in both locales`,
      );
}

function assertPendingRegistration(chapter) {
  const translation = chapter.translation;
  if (translation === undefined)
    throw new Error(
      `chapter ${chapter.id} has no English translation; register it as a translation migration ({ "status": "pending", "owner": ... }) or deliver sourceEn/titleEn`,
    );
  if (translation.status !== 'pending')
    throw new Error(
      `chapter ${chapter.id} registers an unknown translation status: ${translation.status}`,
    );
  if (!TRANSLATION_OWNERS.has(translation.owner))
    throw new Error(
      `chapter ${chapter.id} registers translation owner ${translation.owner} that is not part of the published UI plan`,
    );
}

function validateChapter(chapter, context, seenIds, seenRoutes) {
  if (chapter.id === undefined)
    throw new Error(`${context} entry is missing its stable id`);
  if (seenIds.has(chapter.id))
    throw new Error(`duplicate chapter id: ${chapter.id}`);
  seenIds.add(chapter.id);
  if (chapter.route === undefined)
    throw new Error(`chapter ${chapter.id} is missing its route`);
  if (seenRoutes.has(chapter.route))
    throw new Error(`duplicate documentation route: ${chapter.route}`);
  seenRoutes.add(chapter.route);
  if (chapter.source === undefined && chapter.reference !== true)
    throw new Error(`chapter ${chapter.id} is missing its source`);
  if (chapter.title === undefined)
    throw new Error(`chapter ${chapter.id} is missing its title`);
  if (chapter.group === undefined)
    throw new Error(`chapter ${chapter.id} is missing its group`);
  const type = chapter.reference
    ? 'reference'
    : (chapter.type ?? (chapter.layout ? 'overview' : 'guide'));
  if (!['overview', 'tutorial', 'guide', 'concept', 'reference'].includes(type))
    throw new Error(
      `chapter ${chapter.id} has an unknown content type: ${type}`,
    );
  chapter = { ...chapter, type };
  assertLayoutDeclaration(chapter);

  // Generated references carry no source file: they are synthesized from
  // the contract/settings in both locales, so only their English title is
  // required.
  if (chapter.reference === true) {
    if (chapter.titleEn === undefined)
      throw new Error(
        `chapter ${chapter.id} is a generated reference without a titleEn`,
      );
    return {
      ...chapter,
      routeEn: englishRoute(chapter.route),
      bilingual: true,
    };
  }

  const pending = chapter.translation !== undefined;
  if (pending) {
    if (chapter.sourceEn !== undefined || chapter.titleEn !== undefined)
      throw new Error(
        `chapter ${chapter.id} is registered as a translation migration but declares sourceEn/titleEn`,
      );
    assertPendingRegistration(chapter);
  } else {
    assertBilingualShape(chapter);
  }
  return {
    ...chapter,
    routeEn: englishRoute(chapter.route),
    bilingual: !pending,
  };
}

// Returns the normalized site model used by the renderer and the VitePress
// config: chapters annotated with their derived English routes and a
// `bilingual` flag, groups labeled for both locales.
export function validateSiteModel(site) {
  if (site.repository === undefined)
    throw new Error('site.json is missing its repository');
  const seenIds = new Set();
  const seenRoutes = new Set();
  const pages = (site.pages ?? []).map((page) =>
    validateChapter(page, 'page', seenIds, seenRoutes),
  );
  const references = (site.references ?? []).map((reference) =>
    validateChapter(
      { ...reference, reference: true },
      'reference',
      seenIds,
      seenRoutes,
    ),
  );
  const groupLabels = site.groupLabels ?? {};
  for (const chapter of [...pages, ...references])
    if (groupLabels[chapter.group] === undefined)
      throw new Error(`group ${chapter.group} has no English label`);
  for (const chapter of [...pages, ...references]) {
    for (const direction of ['previous', 'next']) {
      const target = chapter[direction];
      if (
        target !== undefined &&
        target !== false &&
        (!seenIds.has(target) || target === chapter.id)
      )
        throw new Error(
          `chapter ${chapter.id} has invalid ${direction} chapter: ${target}`,
        );
    }
  }
  return {
    repository: site.repository,
    title: site.title,
    titleEn: site.titleEn ?? site.title,
    description: site.description,
    descriptionEn: site.descriptionEn ?? site.description,
    groupLabels,
    pages,
    references,
  };
}
