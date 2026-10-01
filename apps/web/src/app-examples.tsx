import { assembleApp, type ExampleContribution } from '@labos-threejs/views';
import { createLabExample } from '@labos-threejs/views/lab';
// example:knowledge:assembly:start
import { createKnowledgeExample } from '@labos-threejs/views';
import { browserFileTransfer } from './knowledge-files';
import { DocumentGuardProvider } from './knowledge-navigation';
// example:knowledge:assembly:end

// The explicit assembly point (docs/ui/design.md §4.1): shared pages,
// navigation, settings, notifications and translations consume the
// assembled result.

export const exampleEntries: ExampleContribution[] = [
  createLabExample(),
  // example:knowledge:entries:start
  {
    ...createKnowledgeExample({
      fileTransfer: browserFileTransfer,
      provide: (page) => <DocumentGuardProvider>{page}</DocumentGuardProvider>,
    }),
    navigation: [],
    defaultEntry: undefined,
  },
  // example:knowledge:entries:end
];

// Legacy knowledge routes stay available for existing documents. Lab owns
// the product navigation and post-login entry through this assembly point.
export const assembledApp = assembleApp({ examples: exampleEntries });
assembledApp.messages.zh['app.name'] = 'Lab Word';
assembledApp.messages.en['app.name'] = 'Lab Word';
