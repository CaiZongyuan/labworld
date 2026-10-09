import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';
import {
  sitePath,
  docsBase,
  validateSiteModel,
} from '../../../scripts/lib/docs-locales.mjs';

// One bilingual site: the root locale publishes Simplified Chinese on the
// historical paths, the `en` locale mirrors the translated chapters under
// `/en/`. Both navigations derive from the same validated declaration in
// docs/site.json; untranslated chapters stay out of the English sidebar
// instead of linking at pages that do not exist.
const site = validateSiteModel(
  JSON.parse(
    readFileSync(new URL('../../../docs/site.json', import.meta.url), 'utf8'),
  ),
);
const repository = process.env.GITHUB_REPOSITORY ?? site.repository;

const siteLink = (route: string, locale: 'zh' | 'en') => {
  const path = sitePath(route);
  return locale === 'en' && !path.startsWith('/en/') ? '/en' + path : path;
};

function sectionsFor(locale: 'zh' | 'en') {
  const chapters = [...site.pages, ...site.references].filter(
    (chapter) =>
      // Layout pages (the public Landing and the Coming soon pages) are
      // reached from the top navigation, not the documentation sidebar.
      chapter.layout === undefined && (locale === 'zh' || chapter.bilingual),
  );
  const sections = new Map<
    string,
    { text: string; items: { text: string; link: string }[] }
  >();
  for (const chapter of chapters) {
    if (!sections.has(chapter.group))
      sections.set(chapter.group, {
        text: locale === 'en' ? site.groupLabels[chapter.group] : chapter.group,
        items: [],
      });
    sections.get(chapter.group)!.items.push({
      text: locale === 'en' ? chapter.titleEn! : chapter.title,
      link: siteLink(locale === 'en' ? chapter.routeEn : chapter.route, locale),
    });
  }
  return Object.keys(site.groupLabels)
    .filter((group) => sections.has(group))
    .map((group) => ({ ...sections.get(group)!, collapsed: false }));
}

function themeConfigFor(locale: 'zh' | 'en') {
  const en = locale === 'en';
  return {
    // The built-in locale switcher blind-maps paths across locales, which
    // would link untranslated chapters at pages that do not exist. The
    // frontmatter-driven switcher in this theme owns the pairing instead.
    i18nRouting: false,
    // The public site's four top-level entries: Landing, Documentation,
    // Blog and Downloads, mirrored per locale (zh at the root, en under
    // /en/). The quick start and the tutorial path stay reachable through
    // the Documentation entry.
    nav: en
      ? [
          { text: 'Home', link: '/en/' },
          { text: 'Documentation', link: '/en/docs/' },
          { text: 'Blog', link: '/en/blog/' },
          { text: 'Downloads', link: '/en/downloads/' },
        ]
      : [
          { text: '首页', link: '/' },
          { text: '文档', link: '/docs/' },
          { text: '博客', link: '/blog/' },
          { text: '下载', link: '/downloads/' },
        ],
    sidebar: sectionsFor(locale),
    socialLinks: [{ icon: 'github', link: `https://github.com/${repository}` }],
    search: {
      provider: 'local' as const,
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                searchBarPlaceholder: '搜索文档教程（不含应用内数据）',
                noResultsText: '未找到相关结果',
                resetButtonTitle: '清除条件',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭',
                },
              },
            },
          },
          en: {
            translations: {
              button: {
                buttonText: 'Search docs',
                buttonAriaLabel: 'Search docs',
              },
              modal: {
                searchBarPlaceholder:
                  'Search docs and references (not in-app data)',
                noResultsText: 'No results',
                resetButtonTitle: 'Reset',
                footer: {
                  selectText: 'Select',
                  navigateText: 'Switch',
                  closeText: 'Close',
                },
              },
            },
          },
        },
      },
    },
    outline: { label: en ? 'On this page' : '本页内容' },
    docFooter: en
      ? { prev: 'Previous', next: 'Next' }
      : { prev: '上一页', next: '下一页' },
    footer: {
      message: en
        ? 'One source · runnable tutorials · explicit test entries'
        : '同一份源码 · 可运行教程 · 明确的测试入口',
      // One bilingual line for both locales: license and repository only —
      // no year, no badge, no status claims to keep current.
      copyright: `以 MIT 许可证发布 · Released under the MIT license · <a href="https://github.com/${repository}" target="_blank" rel="noreferrer">GitHub</a>`,
    },
  };
}

export default defineConfig({
  srcDir: '.generated',
  // VitePress enables the search bundle from the top-level theme config.
  themeConfig: { search: themeConfigFor('zh').search },
  base: docsBase(repository, process.env.DOCS_BASE),
  cleanUrls: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: site.title,
      description: site.description,
      themeConfig: themeConfigFor('zh'),
    },
    en: {
      label: 'English',
      lang: 'en',
      title: site.titleEn,
      description: site.descriptionEn,
      themeConfig: themeConfigFor('en'),
    },
  },
});
