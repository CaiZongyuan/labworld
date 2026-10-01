import { assembleApp, type ExampleContribution } from '@labos-threejs/views';
// example:knowledge:assembly:start
import { createKnowledgeExample } from '@labos-threejs/views';
import { browserFileTransfer } from './knowledge-files';
import { DocumentGuardProvider } from './knowledge-navigation';
// example:knowledge:assembly:end

// The explicit assembly point (docs/ui/design.md §4.1): shared pages,
// navigation, settings, notifications and translations consume the
// assembled result.

export const exampleEntries: ExampleContribution[] = [
  // example:knowledge:entries:start
  createKnowledgeExample({
    fileTransfer: browserFileTransfer,
    provide: (page) => <DocumentGuardProvider>{page}</DocumentGuardProvider>,
  }),
  // example:knowledge:entries:end
];

// Default-entry strategy: the first assembled example that declares a
// default entry wins (the knowledge example today). Pass `defaultEntry`
// here to pin this deployment's entry explicitly; a Core-only app keeps
// the universal home.
export const assembledApp = assembleApp({ examples: exampleEntries });
