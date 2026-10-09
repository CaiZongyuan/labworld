import { createContext, useContext, type ReactNode } from 'react';

// The dirty-document guard is example-owned UI, but blocking navigation is
// a router capability. The knowledge module only defines the portable
// contract: pages consume the guard through this context, and the app
// adapter provides the router-backed implementation.

export type DocumentGuardValue = {
  prompt: ReactNode;
  onDirtyChange: (dirty: boolean) => void;
};

export const DocumentGuardContext = createContext<DocumentGuardValue>({
  prompt: null,
  onDirtyChange: () => {},
});

export function useDocumentGuard(): DocumentGuardValue {
  return useContext(DocumentGuardContext);
}
