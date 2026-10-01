import { useState, type ReactNode } from 'react';
import { useBlocker } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@labos-threejs/ui/components/alert-dialog';
import { DocumentGuardContext, useAppMessage } from '@labos-threejs/views';

// The app adapter's router-backed implementation of the knowledge
// example's dirty-document guard: the example consumes the guard through
// its portable context (packages/views/src/knowledge/document-guard.tsx);
// only this adapter knows TanStack Router's blocker API. Copy resolves
// through the example's message catalog so the dialog follows the
// session language like the example's own pages.

export function DocumentGuardProvider({ children }: { children: ReactNode }) {
  const message = useAppMessage('knowledge');
  const [dirty, onDirtyChange] = useState(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
    disabled: !dirty,
  });
  return (
    <DocumentGuardContext.Provider
      value={{
        onDirtyChange,
        prompt: (
          <AlertDialog
            open={blocker.status === 'blocked'}
            onOpenChange={(open) => {
              if (!open) blocker.reset?.();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {message('guard.unsavedTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {message('guard.unsavedDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => blocker.reset?.()}>
                  {message('guard.continueEditing')}
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => blocker.proceed?.()}>
                  {message('guard.confirmLeave')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ),
      }}
    >
      {children}
    </DocumentGuardContext.Provider>
  );
}
