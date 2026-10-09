import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deleteAttachment,
  deleteDocument,
  deleteKnowledgeBase,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { RequestErrorAlert } from './request-error';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@labos-threejs/ui/components/alert-dialog';
import { Button } from '@labos-threejs/ui/components/button';
import { sessionKey } from '../identity';
import { useAppMessage } from '../shell/messages';

type Resource =
  | { kind: 'document'; id: string; name: string }
  | { kind: 'base'; id: string; name: string; personal: boolean }
  | { kind: 'attachment'; id: string; documentId: string; name: string };

export function DeleteResource({
  apiClient,
  identity,
  resource,
  onDeleted,
  disabled = false,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  resource: Resource;
  onDeleted?: () => void;
  disabled?: boolean;
}) {
  const message = useAppMessage('knowledge');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentActor = () =>
    queryClient.getQueryData<CurrentSession | null>(sessionKey(apiClient))?.user
      .id === identity.user.id;
  const mutation = useMutation({
    mutationFn: async () => {
      const options = {
        client: apiClient,
        headers: { 'x-csrf-token': identity.csrf_token },
        signal: AbortSignal.timeout(10_000),
        throwOnError: true as const,
      };
      if (resource.kind === 'document')
        await deleteDocument({ ...options, path: { id: resource.id } });
      else if (resource.kind === 'base')
        await deleteKnowledgeBase({ ...options, path: { id: resource.id } });
      else
        await deleteAttachment({
          ...options,
          path: { id: resource.documentId, file_id: resource.id },
        });
    },
    retry: false,
    onSuccess: async () => {
      if (!currentActor()) return;
      if (mounted.current) {
        setOpen(false);
        onDeleted?.();
      }
      if (resource.kind === 'attachment') {
        // Refresh attachment visibility without resetting an unsaved Markdown form.
        await Promise.all(
          ['attachments', 'attachment-preview'].map((kind) =>
            queryClient.resetQueries({
              queryKey: [
                'knowledge',
                kind,
                identity.user.id,
                resource.documentId,
              ],
            }),
          ),
        );
      } else await queryClient.resetQueries({ queryKey: ['knowledge'] });
    },
    onError: (error) => {
      if (!currentActor()) return;
      if (
        [
          'knowledge.not_found',
          'knowledge.forbidden',
          'auth.unauthorized',
        ].includes(errorCodeOf(error) ?? '')
      ) {
        void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
        if (errorCodeOf(error) === 'auth.unauthorized')
          void queryClient.invalidateQueries({
            queryKey: sessionKey(apiClient),
          });
      }
    },
  });
  const label =
    resource.kind === 'document'
      ? message('delete.document')
      : resource.kind === 'base'
        ? message('delete.base')
        : message('delete.attachment', { name: resource.name });
  const errorKeys: Record<string, string> = {
    'knowledge.not_found': 'delete.resourceGone',
    'knowledge.forbidden': 'delete.forbidden',
    'auth.unauthorized': 'errors.unauthorized',
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, event) => {
        if (!next && mutation.isPending) event.cancel();
        else {
          setOpen(next);
          if (next) mutation.reset();
        }
      }}
    >
      <AlertDialogTrigger
        disabled={disabled}
        render={<Button variant="destructive" />}
      >
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {message('delete.confirmTitle', { name: resource.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resource.kind === 'attachment'
              ? message('delete.descAttachment')
              : resource.kind === 'document'
                ? message('delete.descDocument')
                : message('delete.descBase')}
            {resource.kind === 'base' && resource.personal
              ? message('delete.descPersonal')
              : ''}
            {message('delete.descIrreversible')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.isError ? (
          <RequestErrorAlert
            title={message('delete.errorTitle')}
            text={message(
              errorKeys[errorCodeOf(mutation.error) ?? ''] ?? 'delete.fallback',
            )}
            error={mutation.error}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            {message('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending || disabled}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? message('delete.deleting')
              : message('delete.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
