import { StickyNoteIcon } from 'lucide-react';
import { useAppMessage } from '../shell/messages';
import type { ExampleContribution } from '../shell/app-contract';

// A deliberately small second example: it exists only to prove that the
// app shell's composition interface does not know about the knowledge
// example (docs/ui/design.md §4.1 "通过真实组合验收解耦"). One accessible
// page, one navigation group, bilingual messages and one demo scene
// declaration — not a second product.

function NotesPage() {
  const message = useAppMessage('notes');
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">{message('page.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {message('page.intro')}
      </p>
      <ul className="mt-4 list-disc pl-5 text-sm">
        <li>{message('item.read')}</li>
        <li>{message('item.write')}</li>
      </ul>
    </div>
  );
}

export function createNotesExample(): ExampleContribution {
  return {
    id: 'notes',
    routes: [
      {
        path: '/notes',
        component: () => <NotesPage />,
      },
    ],
    navigation: [
      {
        id: 'main',
        labelKey: 'nav.group',
        items: [{ id: 'open', labelKey: 'nav.notes', path: '/notes' }],
      },
    ],
    messages: {
      zh: {
        'nav.group': '便签',
        'nav.notes': '便签示例',
        'page.title': '便签示例页',
        'page.intro': '这个页面只用于验证应用壳的组合接口，不承载真实业务。',
        'item.read': '阅读本页即验证页面接入。',
        'item.write': '双语文案与导航声明来自便签示例自己的资源。',
      },
      en: {
        'nav.group': 'Notes',
        'nav.notes': 'Notes example',
        'page.title': 'Notes example page',
        'page.intro':
          'This page exists only to verify the app shell composition interface; it carries no real business.',
        'item.read': 'Reading this page verifies the page wiring.',
        'item.write':
          'Bilingual texts and the navigation entry come from the notes example itself.',
      },
    },
    scenes: [{ id: 'notes-demo', titleKey: 'nav.notes' }],
    moduleIcons: {
      '/notes': { icon: StickyNoteIcon, variant: 'indigo' },
    },
  };
}
