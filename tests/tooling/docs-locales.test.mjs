import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOCALE_ROOTS,
  englishRoute,
  sitePath,
  validateSiteModel,
} from '../../scripts/lib/docs-locales.mjs';

// The bilingual documentation contract: stable chapter ids pair a Chinese
// page with an adjacent `.en.md` translation, pending chapters must be
// explicitly registered migration items, and both locales derive their
// routes from one declaration. These tests pin that contract for UI01 and
// every later bilingual chapter.

const bilingualPage = {
  id: 'quickstart',
  source: 'docs/getting-started/quickstart.md',
  sourceEn: 'docs/getting-started/quickstart.en.md',
  route: 'getting-started/quickstart.md',
  title: '快速开始',
  titleEn: 'Quick start',
  group: '开始',
};

function siteModel(overrides = {}) {
  return {
    repository: 'CaiZongyuan/labos-threejs',
    groupLabels: {
      开始: 'Start',
      跟做教程: 'Tutorials',
      生成参考: 'Generated references',
    },
    pages: [{ ...bilingualPage }],
    references: [
      {
        id: 'api-reference',
        route: 'reference/api.md',
        title: 'API 合同',
        titleEn: 'API contract',
        group: '生成参考',
      },
    ],
    ...overrides,
  };
}

test('every locale writes pages under its fixed route root', () => {
  assert.deepEqual(LOCALE_ROOTS, { zh: '', en: 'en/' });
  assert.equal(
    englishRoute('getting-started/quickstart.md'),
    'en/getting-started/quickstart.md',
  );
});

test('sitePath maps markdown routes to published site paths', () => {
  assert.equal(
    sitePath('getting-started/quickstart.md'),
    '/getting-started/quickstart',
  );
  assert.equal(sitePath('docs/index.md'), '/docs/');
});

test('a bilingual page passes validation and yields both locale routes', () => {
  const model = validateSiteModel(siteModel());
  assert.equal(model.pages[0].id, 'quickstart');
  assert.equal(model.pages[0].routeEn, 'en/getting-started/quickstart.md');
});

test('chapter ids and routes must be unique', () => {
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({
          pages: [bilingualPage, { ...bilingualPage, route: 'other.md' }],
        }),
      ),
    /duplicate chapter id: quickstart/,
  );
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({
          pages: [bilingualPage, { ...bilingualPage, id: 'quickstart-2' }],
        }),
      ),
    /duplicate documentation route: getting-started\/quickstart\.md/,
  );
});

test('a bilingual declaration requires source, title and route together', () => {
  const missingTitle = (page) =>
    validateSiteModel(siteModel({ pages: [page] }));
  assert.throws(
    () => missingTitle({ ...bilingualPage, titleEn: undefined }),
    /chapter quickstart declares an English translation without a titleEn/,
  );
  assert.throws(
    () => missingTitle({ ...bilingualPage, sourceEn: undefined }),
    /chapter quickstart declares an English translation without a sourceEn/,
  );
});

test('untranslated chapters must be registered migration items with a known owner', () => {
  const pending = {
    id: 'members',
    source: 'docs/tutorials/08-members.md',
    route: 'tutorials/members.md',
    title: '成员管理与最后 Owner',
    group: '跟做教程',
  };
  assert.throws(
    () => validateSiteModel(siteModel({ pages: [pending] })),
    /chapter members has no English translation; register it as a translation migration/,
  );
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({
          pages: [
            { ...pending, translation: { status: 'pending', owner: 'UI99' } },
          ],
        }),
      ),
    /chapter members registers translation owner UI99 that is not part of the published UI plan/,
  );
  const model = validateSiteModel(
    siteModel({
      pages: [
        { ...pending, translation: { status: 'pending', owner: 'UI14' } },
      ],
    }),
  );
  assert.equal(model.pages[0].translation.owner, 'UI14');
});

test('a pending chapter must not pretend to carry an English translation', () => {
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({
          pages: [
            {
              ...bilingualPage,
              translation: { status: 'pending', owner: 'UI14' },
            },
          ],
        }),
      ),
    /chapter quickstart is registered as a translation migration but declares sourceEn/,
  );
});

test('both locales require a label for every chapter group', () => {
  assert.throws(
    () => validateSiteModel(siteModel({ groupLabels: {} })),
    /group 开始 has no English label/,
  );
});

test('reference ids stay unique across chapters', () => {
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({
          references: [
            {
              id: 'quickstart',
              route: 'reference/api.md',
              title: 'API 合同',
              titleEn: 'API contract',
              group: '生成参考',
            },
          ],
        }),
      ),
    /duplicate chapter id: quickstart/,
  );
});

test('explicit next chapters must name an existing published chapter', () => {
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({ pages: [{ ...bilingualPage, next: 'missing' }] }),
      ),
    /quickstart.*next.*missing/,
  );
  const model = validateSiteModel(
    siteModel({ pages: [{ ...bilingualPage, next: 'api-reference' }] }),
  );
  assert.equal(model.pages[0].next, 'api-reference');
});

test('content types separate tutorials, guides, concepts and references', () => {
  assert.throws(
    () =>
      validateSiteModel(
        siteModel({ pages: [{ ...bilingualPage, type: 'feature-list' }] }),
      ),
    /quickstart.*content type/,
  );
  const model = validateSiteModel(
    siteModel({ pages: [{ ...bilingualPage, type: 'tutorial' }] }),
  );
  assert.equal(model.pages[0].type, 'tutorial');
  assert.equal(model.references[0].type, 'reference');
});
