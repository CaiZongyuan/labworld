import { describe, expect, test } from 'vitest';
import { BookOpenIcon } from 'lucide-react';
import { assembleApp, CORE_RESERVED_ROUTES } from './app-contract';
import type { ExampleContribution } from './app-contract';
import { coreModuleIcons } from './module-registry';

// The public composition contract: examples declare pages, navigation,
// messages and optional notification parsing under a stable id; the shell
// validates the assembled result and refuses conflicts instead of letting
// the last registration win.

function example(
  overrides: Partial<ExampleContribution> = {},
): ExampleContribution {
  return {
    id: 'notes',
    routes: [{ path: '/notes', component: () => null }],
    navigation: [
      {
        id: 'notes-group',
        labelKey: 'group.label',
        items: [{ id: 'notes-open', labelKey: 'nav.notes', path: '/notes' }],
      },
    ],
    messages: {
      zh: { 'group.label': '便签', 'nav.notes': '便签列表' },
      en: { 'group.label': 'Notes', 'nav.notes': 'Notes list' },
    },
    defaultEntry: '/notes',
    ...overrides,
  };
}

describe('assembleApp', () => {
  test('assembles navigation, routes, namespaced messages and default entry', () => {
    const app = assembleApp({ examples: [example()] });
    expect(app.defaultEntry).toBe('/notes');
    expect(app.routes.map((route) => route.path)).toEqual(['/notes']);
    expect(app.messages.zh['notes.group.label']).toBe('便签');
    expect(app.messages.en['notes.nav.notes']).toBe('Notes list');
    expect(app.navigation).toHaveLength(1);
    expect(app.resolveNotificationTarget).toBeUndefined();
  });

  test('an empty selection assembles a Core-only app at the root entry', () => {
    const app = assembleApp({ examples: [] });
    expect(app.defaultEntry).toBe('/');
    expect(app.routes).toEqual([]);
    expect(app.navigation).toEqual([]);
    // Core's own catalog is always part of the assembly: the universal
    // home, login and settings keep their texts with zero examples.
    expect(Object.keys(app.messages.zh).length).toBeGreaterThan(0);
    expect(Object.keys(app.messages.en).length).toBeGreaterThan(0);
    expect(app.messages.zh['app.name']).toBeTruthy();
  });

  test('an example key colliding with Core message ownership fails at assembly', () => {
    // Core owns 'home.title'; an example whose namespace produces the same
    // fully-qualified key is refused instead of shadowing Core texts.
    const squatter = example({
      id: 'home',
      messages: {
        zh: {
          title: '被抢占的首页',
          'group.label': '分组',
          'nav.notes': '导航项',
        },
        en: {
          title: 'Squatted home',
          'group.label': 'Group',
          'nav.notes': 'Nav item',
        },
      },
    });
    expect(() => assembleApp({ examples: [squatter] })).toThrow(
      /message home\.title is already owned by core/,
    );
  });

  test('an example namespace free of Core keys assembles alongside the Core catalog', () => {
    const app = assembleApp({ examples: [example()] });
    // The example's own namespace and Core's catalog coexist.
    expect(app.messages.zh['notes.group.label']).toBe('便签');
    expect(app.messages.zh['home.title']).toBeTruthy();
  });

  test('empty navigation groups disappear from the assembled navigation', () => {
    const app = assembleApp({
      examples: [
        example({
          navigation: [
            { id: 'empty', labelKey: 'group.label', items: [] },
            {
              id: 'kept',
              labelKey: 'group.label',
              items: [{ id: 'item', labelKey: 'nav.notes', path: '/notes' }],
            },
          ],
        }),
      ],
    });
    expect(app.navigation.map((group) => group.id)).toEqual(['notes:kept']);
  });

  test('duplicate example ids fail the assembly', () => {
    expect(() => assembleApp({ examples: [example(), example()] })).toThrow(
      /duplicate example id: notes/,
    );
  });

  test('route conflicts between examples fail the assembly', () => {
    const other = example({
      id: 'other',
      routes: [{ path: '/notes', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'k',
          items: [{ id: 'i', labelKey: 'k', path: '/notes' }],
        },
      ],
      messages: { zh: { k: '他' }, en: { k: 'Other' } },
    });
    expect(() => assembleApp({ examples: [example(), other] })).toThrow(
      /route \/notes is already contributed/,
    );
  });

  test('occupying a Core reserved route fails the assembly', () => {
    expect(CORE_RESERVED_ROUTES).toContain('/login');
    expect(() =>
      assembleApp({
        examples: [
          example({ routes: [{ path: '/login', component: () => null }] }),
        ],
      }),
    ).toThrow(/Core reserved route \/login/);
  });

  test('navigation labels must resolve in both locales', () => {
    const missing = example();
    missing.messages.en = {};
    expect(() => assembleApp({ examples: [missing] })).toThrow(
      /message notes\.group\.label has no en text/,
    );
  });

  test('a default entry outside the contributed routes fails the assembly', () => {
    expect(() =>
      assembleApp({ examples: [example()], defaultEntry: '/missing' }),
    ).toThrow(/default entry \/missing is not a contributed route/);
    expect(() =>
      assembleApp({ examples: [example()], defaultEntry: '/login' }),
    ).toThrow(/Core reserved route/);
  });

  test('the declared default entry wins over contribution defaults', () => {
    const knowledge = example({
      id: 'knowledge',
      defaultEntry: '/documents',
      routes: [
        { path: '/documents', component: () => null },
        { path: '/knowledge-docs', component: () => null },
      ],
      messages: {
        zh: {
          'group.label': '知识库',
          'nav.notes': '便签列表',
          'nav.documents': '我的文档',
        },
        en: {
          'group.label': 'Knowledge',
          'nav.notes': 'Notes list',
          'nav.documents': 'My documents',
        },
      },
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [
            { id: 'a', labelKey: 'nav.documents', path: '/documents' },
            { id: 'b', labelKey: 'nav.notes', path: '/knowledge-docs' },
          ],
        },
      ],
    });
    const app = assembleApp({
      examples: [example(), knowledge],
      defaultEntry: '/documents',
    });
    expect(app.defaultEntry).toBe('/documents');
  });

  test('the first example declaring a default entry wins the assembled entry', () => {
    const knowledge = example({
      id: 'knowledge',
      defaultEntry: '/documents',
      routes: [{ path: '/documents', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'a', labelKey: 'nav.notes', path: '/documents' }],
        },
      ],
    });
    expect(assembleApp({ examples: [knowledge, example()] }).defaultEntry).toBe(
      '/documents',
    );
    expect(assembleApp({ examples: [example(), knowledge] }).defaultEntry).toBe(
      '/notes',
    );
  });

  test('notification resolvers compose in contribution order', () => {
    const first = example({
      id: 'first',
      resolveNotificationTarget: () => undefined,
    });
    const second = example({
      id: 'second',
      defaultEntry: '/second',
      routes: [{ path: '/second', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'i', labelKey: 'nav.notes', path: '/second' }],
        },
      ],
      resolveNotificationTarget: () => () => undefined,
    });
    const app = assembleApp({ examples: [first, second] });
    expect(app.resolveNotificationTarget).toBeDefined();
  });

  test('notification display composes in contribution order and falls back to undefined', () => {
    const notice = {
      id: 'n',
      subject: ' subject ',
      outcome: 'succeeded',
      created_at: '2026-09-26T00:00:00Z',
      target: { kind: 'second.thing', resource_id: 'r', context: {} },
    } as Parameters<
      NonNullable<ExampleContribution['describeNotification']>
    >[0];
    const first = example({
      id: 'first',
      describeNotification: () => undefined,
    });
    const second = example({
      id: 'second',
      defaultEntry: '/second',
      routes: [{ path: '/second', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'i', labelKey: 'nav.notes', path: '/second' }],
        },
      ],
      describeNotification: (input) =>
        input.target.kind === 'second.thing'
          ? { titleKey: 'second.notifications.thing' }
          : undefined,
    });
    // No example describes anything: the composed resolver stays absent
    // so the Core inbox renders its fallback heading.
    expect(
      assembleApp({ examples: [example()] }).describeNotification,
    ).toBeUndefined();
    const app = assembleApp({ examples: [first, second] });
    expect(app.describeNotification?.(notice)).toEqual({
      titleKey: 'second.notifications.thing',
    });
    expect(
      app.describeNotification?.({
        ...notice,
        target: { ...notice.target, kind: 'other' },
      }),
    ).toBeUndefined();
  });

  test('core module icons ship with every assembly and core-only builds keep only them', () => {
    const app = assembleApp({ examples: [example()] });
    expect(app.moduleIcons['/']).toMatchObject({ variant: 'blue' });
    expect(app.moduleIcons['/settings']).toMatchObject({ variant: 'teal' });
    expect(Object.keys(coreModuleIcons).length).toBeGreaterThan(0);

    const coreOnly = assembleApp({ examples: [] });
    expect(coreOnly.moduleIcons).toEqual(coreModuleIcons);
    // The knowledge module color must never outlive its example.
    expect(coreOnly.moduleIcons['/documents']).toBeUndefined();
  });

  test('example module icons merge by path alongside the core registry', () => {
    const knowledge = example({
      id: 'knowledge',
      defaultEntry: '/documents',
      routes: [{ path: '/documents', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'a', labelKey: 'nav.notes', path: '/documents' }],
        },
      ],
      moduleIcons: { '/documents': { icon: BookOpenIcon, variant: 'teal' } },
    });
    const app = assembleApp({ examples: [knowledge] });
    expect(app.moduleIcons['/documents']).toMatchObject({ variant: 'teal' });
    expect(app.moduleIcons['/']).toMatchObject({ variant: 'blue' });
  });

  test('module icon keys outside the example routes fail the assembly', () => {
    const stray = example({
      id: 'knowledge',
      defaultEntry: '/documents',
      routes: [{ path: '/documents', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'a', labelKey: 'nav.notes', path: '/documents' }],
        },
      ],
      moduleIcons: { '/elsewhere': { icon: BookOpenIcon, variant: 'teal' } },
    });
    expect(() => assembleApp({ examples: [stray] })).toThrow(
      /module icon \/elsewhere .* example knowledge does not contribute/,
    );
  });

  test('a module icon cannot squat a Core reserved path', () => {
    const squatter = example({
      routes: [{ path: '/settings', component: () => null }],
      navigation: [
        {
          id: 'g',
          labelKey: 'group.label',
          items: [{ id: 'a', labelKey: 'nav.notes', path: '/settings' }],
        },
      ],
      moduleIcons: { '/settings': { icon: BookOpenIcon, variant: 'teal' } },
    });
    expect(() => assembleApp({ examples: [squatter] })).toThrow(
      /Core reserved route \/settings/,
    );
  });
});
