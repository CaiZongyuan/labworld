import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  createDocument,
  getDocument,
  listPersonalDocuments,
  updateDocument,
  type Document,
  type ApiClient,
  type CurrentSession,
  type CreateDocument,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import {
  ArrowLeft,
  ArrowRight,
  FileCode2,
  FileSearchIcon,
  Loader2,
  Plus,
  Save,
  X,
} from 'lucide-react';
import { MaterialFileIcon } from '@labos-threejs/ui/components/material-file-icon';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { Textarea } from '@labos-threejs/ui/components/textarea';
import { sessionKey, sessionQuery } from '../identity';
import { useAppMessage } from '../shell/messages';
import { useAppFormat } from '../shell/format';
import { MarkdownPreview } from './markdown-preview';
import { ConflictSection, Failure } from './document-feedback';
import { knowledgeBaseQuery } from './knowledge-base-query';
import { AttachmentsPanel } from './attachments-panel';
import { DeleteResource } from './delete-resource';
import { ExportsPanel } from './exports-panel';
import type { FileTransfer } from './file-transfer';
import { KnowledgeBaseGraphic } from './knowledge-base-graphic';

function permissionDenied(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'knowledge.forbidden' || code === 'knowledge.not_found';
}

function IdentityGate({
  session,
  children,
}: {
  session: UseQueryResult<CurrentSession | null>;
  children: ReactNode;
}) {
  const message = useAppMessage('knowledge');
  if (session.isPending)
    return <p role="status">{message('common.readingSession')}</p>;
  if (session.isError && !session.data)
    return <Failure error={session.error} />;
  if (!session.data)
    return (
      <p>
        {message('documents.signInPrompt')}
        <a href="/login" className="underline">
          {message('documents.signInAction')}
        </a>
        {message('documents.signInSuffix')}
      </p>
    );
  return (
    <>
      {session.isError ? <Failure error={session.error} /> : null}
      <div hidden={session.isError}>{children}</div>
    </>
  );
}

function Page({
  title,
  actions,
  children,
  className = '',
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={'app-page flex flex-col gap-6 ' + className}>
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions}
      </header>
      {children}
    </div>
  );
}

export function DocumentsView({
  apiClient,
  onNew,
  onOpen,
}: {
  apiClient: ApiClient;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  return (
    <Page title={message('documents.title')} className="documents-page">
      <IdentityGate session={session}>
        {session.data ? (
          <DocumentList
            key={session.data.user.id}
            apiClient={apiClient}
            identity={session.data}
            onOpen={onOpen}
            onNew={onNew}
            standalone
          />
        ) : null}
      </IdentityGate>
    </Page>
  );
}

export function DocumentList({
  apiClient,
  identity,
  onOpen,
  knowledgeBaseId,
  canCreate = true,
  onNew,
  standalone = false,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  onOpen: (id: string) => void;
  knowledgeBaseId?: string;
  canCreate?: boolean;
  onNew?: () => void;
  standalone?: boolean;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const { formatDateTime } = useAppFormat();
  const [keyword, setKeyword] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const queryKey = [
    'knowledge',
    'documents',
    identity.user.id,
    { scope: knowledgeBaseId ?? 'personal', q: keyword },
  ];
  const documents = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listPersonalDocuments({
          client: apiClient,
          query: {
            cursor: pageParam,
            limit: 50,
            q: keyword,
            knowledge_base_id: knowledgeBaseId,
          },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 10,
    retry: false,
  });
  function search(next: string) {
    if (next === keyword) {
      void queryClient.resetQueries({ queryKey, exact: true });
    } else {
      queryClient.removeQueries({
        queryKey: [
          'knowledge',
          'documents',
          identity.user.id,
          { scope: knowledgeBaseId ?? 'personal', q: next },
        ],
        exact: true,
      });
      setKeyword(next);
    }
  }
  const items = documents.data?.pages.flatMap((page) => page.data) ?? [];
  const canShowResults = !documents.isError || documents.isFetchNextPageError;
  return (
    <div className="flex flex-col gap-4">
      {onNew && documents.data?.pages[0]?.can_create ? (
        <Button
          className={standalone ? 'document-new-action' : 'self-start'}
          onClick={onNew}
        >
          <Plus data-icon="inline-start" />
          {message('common.newDocument')}
        </Button>
      ) : null}
      <form
        className="document-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search(searchInput.current?.value.trim() ?? '');
        }}
      >
        <FieldGroup className="document-search-fields">
          <Field>
            <FieldLabel htmlFor="document-search" className="sr-only">
              {message('documents.searchLabel')}
            </FieldLabel>
            <Input
              ref={searchInput}
              id="document-search"
              name="q"
              maxLength={200}
              placeholder={message('documents.searchPlaceholder')}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={documents.isFetching}
            >
              {message('documents.search')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message('documents.clearSearch')}
              title={message('documents.clearSearch')}
              onClick={() => {
                if (searchInput.current) searchInput.current.value = '';
                search('');
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </FieldGroup>
      </form>
      {documents.isFetching && !documents.isFetchingNextPage ? (
        <p role="status">{message('documents.loading')}</p>
      ) : null}
      {documents.isError ? <Failure error={documents.error} /> : null}
      {documents.isError && !documents.isFetchNextPageError ? (
        <Button variant="outline" onClick={() => search(keyword)}>
          {message('documents.retrySearch')}
        </Button>
      ) : null}
      {!documents.isPending && canShowResults ? (
        items.length === 0 ? (
          <Empty className="document-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileSearchIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {keyword
                  ? message('documents.emptyNoMatch')
                  : message('documents.emptyNone')}
              </EmptyTitle>
              <EmptyDescription>
                {keyword
                  ? message('documents.emptyNoMatchHint')
                  : message('documents.emptyNoneHint')}
              </EmptyDescription>
            </EmptyHeader>
            {!keyword && canCreate ? (
              <EmptyContent>{message('documents.emptyHowTo')}</EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <>
            <p role="status" className="document-results-count">
              {keyword
                ? message('documents.shownWithKeyword', {
                    count: items.length,
                    keyword,
                  })
                : message('documents.shownCount', { count: items.length })}
            </p>
            <div className="document-columns" aria-hidden="true">
              <span>{message('documents.titleLabel')}</span>
              <span>{message('documents.updatedColumn')}</span>
              <span>{message('documents.versionColumn')}</span>
              <span />
            </div>
            <ul className="document-rows">
              {items.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    className="document-row"
                    aria-label={document.title}
                    onClick={() => onOpen(document.id)}
                  >
                    <span className="document-row-name">
                      <span className="document-file-icon">
                        <MaterialFileIcon
                          name="document.md"
                          className="size-6"
                        />
                      </span>
                      <span>
                        <strong>{document.title}</strong>
                        <span className="document-mobile-meta">
                          {formatDateTime(document.updated_at)} · v
                          {document.version}
                        </span>
                      </span>
                    </span>
                    <span
                      className="document-row-date"
                      title={formatDateTime(document.updated_at)}
                    >
                      {formatDateTime(document.updated_at)}
                    </span>
                    <span className="document-row-version">
                      v{document.version}
                    </span>
                    <ArrowRight
                      className="document-row-arrow"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
      {documents.hasNextPage && canShowResults ? (
        <Button
          variant="outline"
          disabled={documents.isFetching}
          onClick={() => {
            void documents.fetchNextPage();
          }}
        >
          {documents.isFetchingNextPage
            ? message('documents.loadingMore')
            : documents.isFetchNextPageError
              ? message('documents.retryLoadMore')
              : message('documents.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function markdownError(markdown: string): string | undefined {
  if (markdown.includes('\0')) return 'knowledge.invalid_text';
  if (new TextEncoder().encode(markdown).length > 1024 * 1024)
    return 'knowledge.too_large';
}

const WIDE_EDITOR_QUERY = '(min-width: 1024px)';

// Follows the house matchMedia guard (shell/preferences): the media query
// decides between the two-pane editor and the tabbed single pane.
function wideEditorSnapshot(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(WIDE_EDITOR_QUERY).matches
  );
}

function subscribeWideEditorQuery(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE_EDITOR_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function useWideEditorLayout(): boolean {
  return useSyncExternalStore(
    subscribeWideEditorQuery,
    wideEditorSnapshot,
    () => false,
  );
}

const EDITOR_MODES = ['edit', 'preview'] as const;
type EditorMode = (typeof EDITOR_MODES)[number];

function DocumentForm({
  apiClient,
  identity,
  onSaved,
  document,
  onReadLatest,
  latestPending,
  onDirtyChange,
  readOnly = false,
  knowledgeBaseId,
  onRefreshPermission,
  fileTransfer,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  onSaved: (id: string) => void;
  document?: Document;
  onReadLatest?: () => Promise<number | undefined>;
  latestPending?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  readOnly?: boolean;
  knowledgeBaseId?: string;
  onRefreshPermission: () => Promise<boolean>;
  fileTransfer?: FileTransfer;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const wide = useWideEditorLayout();
  const attachmentContext =
    document && fileTransfer
      ? {
          apiClient,
          userId: identity.user.id,
          documentId: document.id,
          transfer: fileTransfer,
        }
      : undefined;
  const titleInput = useRef<HTMLInputElement>(null);
  const markdownInput = useRef<HTMLTextAreaElement>(null);
  const [baseline, setBaseline] = useState(() => ({
    title: document?.title ?? '',
    markdown: document?.markdown ?? '',
    version: document?.version,
  }));
  const [latestRead, setLatestRead] = useState<number>();
  const [dirty, setDirty] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');
  // The preview starts from the stored document so the wide layout shows
  // both panes before the first keystroke.
  const [preview, setPreview] = useState(() => document?.markdown ?? '');
  const deferredPreview = useDeferredValue(preview);
  const [inputError, setInputError] = useState<string>();
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async ({
      body,
      key,
    }: {
      body: CreateDocument;
      key: string;
    }) => {
      if (document && baseline.version !== undefined) {
        return (
          await updateDocument({
            client: apiClient,
            path: { id: document.id },
            body: { ...body, version: baseline.version },
            headers: { 'x-csrf-token': identity.csrf_token },
            throwOnError: true,
          })
        ).data;
      }
      return (
        await createDocument({
          client: apiClient,
          body,
          headers: {
            'x-csrf-token': identity.csrf_token,
            'idempotency-key': key,
          },
          throwOnError: true,
        })
      ).data;
    },
    retry: false,
    gcTime: 0,
    onError: (error) => {
      if (permissionDenied(error))
        void onRefreshPermission().catch(() => undefined);
    },
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({
        queryKey: ['knowledge', 'documents', identity.user.id],
      });
      await queryClient.cancelQueries({
        queryKey: ['knowledge', 'document', identity.user.id, document.id],
        exact: true,
      });
      if (
        queryClient.getQueryState(sessionKey(apiClient))?.fetchStatus ===
        'fetching'
      ) {
        try {
          await queryClient.fetchQuery(sessionQuery(apiClient, queryClient));
        } catch {
          return;
        }
      }
      // Check after every await: a session refresh may have changed the identity.
      if (
        queryClient.getQueryData<CurrentSession>(sessionKey(apiClient))?.user
          .id !== identity.user.id
      )
        return;
      queryClient.setQueryData<Document>(
        ['knowledge', 'document', identity.user.id, document.id],
        (cached) =>
          cached && cached.version > document.version ? cached : document,
      );
      if (active.current) {
        setDirty(false);
        onSaved(document.id);
      }
    },
  });
  const denied = permissionDenied(mutation.error);
  const cannotEdit = readOnly || document?.can_edit === false || denied;
  const conflict = errorCodeOf(mutation.error) === 'document.version_conflict';
  const latest = latestRead === document?.version ? document : undefined;
  function reconcile(replace: boolean) {
    if (!latest) return;
    if (replace) {
      if (titleInput.current) titleInput.current.value = latest.title;
      if (markdownInput.current) markdownInput.current.value = latest.markdown;
      setPreview(latest.markdown);
    }
    setBaseline({
      title: latest.title,
      markdown: latest.markdown,
      version: latest.version,
    });
    setDirty(
      !replace &&
        (titleInput.current?.value !== latest.title ||
          markdownInput.current?.value !== latest.markdown),
    );
    mutation.reset();
    setLatestRead(undefined);
  }
  // Switching to the preview validates the body first; invalid text keeps
  // the editor on the source pane and surfaces the error instead.
  function selectEditorMode(next: EditorMode) {
    if (next === editorMode) return;
    if (next === 'preview') {
      const markdown = markdownInput.current?.value ?? '';
      const error = markdownError(markdown);
      setInputError(error);
      if (error) return;
      setPreview(markdown);
    }
    setEditorMode(next);
  }
  function onEditorTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const current = EDITOR_MODES.indexOf(editorMode);
    const offsets: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: -current,
      End: EDITOR_MODES.length - 1 - current,
    };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next =
      EDITOR_MODES[
        (current + offset + EDITOR_MODES.length) % EDITOR_MODES.length
      ];
    event.currentTarget.ownerDocument
      .getElementById(`document-tab-${next}`)
      ?.focus();
    selectEditorMode(next);
  }
  return (
    <form
      className="document-form"
      onChange={() => {
        const markdown = markdownInput.current?.value ?? '';
        setDirty(
          titleInput.current?.value !== baseline.title ||
            markdown !== baseline.markdown,
        );
        // Both layouts live-sync the preview on every keystroke (narrow shows
        // it through the preview tab); invalid text keeps the last good
        // preview and surfaces on save or on a preview switch instead of
        // clobbering other input errors.
        if (!markdownError(markdown)) setPreview(markdown);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (mutation.isPending || conflict || cannotEdit) return;
        const form = new FormData(event.currentTarget);
        const body = {
          title: String(form.get('title')).trim(),
          markdown: String(form.get('markdown')),
          ...(knowledgeBaseId ? { knowledge_base_id: knowledgeBaseId } : {}),
        };
        const error =
          !body.title || [...body.title].length > 200
            ? 'knowledge.invalid_title'
            : body.title.includes('\0')
              ? 'knowledge.invalid_text'
              : markdownError(body.markdown);
        setInputError(error);
        if (error) return;
        const fingerprint = JSON.stringify(body);
        if (attempt.current?.fingerprint !== fingerprint)
          attempt.current = { fingerprint, key: crypto.randomUUID() };
        mutation.mutate({ body, key: attempt.current.key });
      }}
    >
      <div className="document-save-toolbar">
        <span role="status">
          {dirty
            ? message('documents.unsavedChanges')
            : document
              ? message('documents.savedState')
              : message('documents.notSaved')}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={mutation.isPending || conflict || cannotEdit}
        >
          {mutation.isPending ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          {mutation.isPending
            ? message('common.saving')
            : message('documents.save')}
        </Button>
      </div>
      <FieldGroup>
        {cannotEdit ? (
          <p role="status">
            {denied
              ? message('documents.saveDenied')
              : message('documents.readOnly')}
          </p>
        ) : null}
        {cannotEdit ? (
          <Button
            variant="outline"
            disabled={latestPending}
            onClick={() => {
              void onRefreshPermission()
                .then((allowed) => {
                  if (allowed) mutation.reset();
                })
                .catch(() => undefined);
            }}
          >
            {message('documents.retryPermissions')}
          </Button>
        ) : null}
        <Field
          data-disabled={mutation.isPending || cannotEdit}
          data-invalid={inputError === 'knowledge.invalid_title'}
        >
          <FieldLabel htmlFor="document-title">
            {message('documents.titleLabel')}
          </FieldLabel>
          <Input
            ref={titleInput}
            defaultValue={baseline.title}
            id="document-title"
            name="title"
            required
            maxLength={200}
            aria-invalid={inputError === 'knowledge.invalid_title'}
            disabled={mutation.isPending || cannotEdit}
          />
        </Field>
        {/* Both layouts render the same textarea element: crossing the
            breakpoint re-labels the panes but never remounts them, so the
            uncontrolled draft survives a resize. Wide shows the panes side
            by side with a live preview; narrow keeps the tabbed mode. */}
        {document || knowledgeBaseId ? (
          <div className="document-editor-context">
            <KnowledgeBaseGraphic
              userId={identity.user.id}
              baseId={document?.knowledge_base_id ?? knowledgeBaseId!}
              name={message('documents.openBase')}
              small
            />
            <span>{message('documents.openBase')}</span>
            {baseline.version !== undefined ? (
              <span>v{baseline.version}</span>
            ) : null}
          </div>
        ) : null}
        <div
          data-editor-layout={wide ? 'wide' : 'narrow'}
          className="document-editor"
        >
          {wide ? (
            <div className="document-pane-labels grid grid-cols-2 text-sm font-medium text-muted-foreground">
              <span>{message('documents.tabEdit')}</span>
              <span>{message('documents.tabPreview')}</span>
            </div>
          ) : (
            <div
              role="tablist"
              aria-label={message('documents.markdownMode')}
              className="document-mode-tabs flex w-fit gap-1"
            >
              {EDITOR_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  id={`document-tab-${mode}`}
                  aria-selected={editorMode === mode}
                  aria-controls={`document-panel-${mode}`}
                  tabIndex={editorMode === mode ? 0 : -1}
                  onClick={() => selectEditorMode(mode)}
                  onKeyDown={onEditorTabKeyDown}
                  className="min-h-11 rounded-md px-3 text-sm font-medium aria-selected:bg-background aria-selected:shadow-sm lg:min-h-9"
                >
                  {message(
                    mode === 'edit'
                      ? 'documents.tabEdit'
                      : 'documents.tabPreview',
                  )}
                </button>
              ))}
            </div>
          )}
          <div
            className={
              wide
                ? 'document-editor-panes grid grid-cols-2'
                : 'document-editor-panes'
            }
          >
            <div
              role={wide ? undefined : 'tabpanel'}
              id={wide ? undefined : 'document-panel-edit'}
              aria-labelledby={wide ? undefined : 'document-tab-edit'}
              hidden={!wide && editorMode === 'preview'}
            >
              <Field
                data-disabled={mutation.isPending || cannotEdit}
                data-invalid={
                  inputError === 'knowledge.too_large' ||
                  inputError === 'knowledge.invalid_text'
                }
              >
                <FieldLabel htmlFor="document-markdown" className="sr-only">
                  {message('documents.bodyLabel')}
                </FieldLabel>
                <Textarea
                  ref={markdownInput}
                  defaultValue={baseline.markdown}
                  id="document-markdown"
                  name="markdown"
                  rows={16}
                  variant="code"
                  aria-invalid={
                    inputError === 'knowledge.too_large' ||
                    inputError === 'knowledge.invalid_text'
                  }
                  disabled={mutation.isPending || cannotEdit}
                />
                <FieldDescription className="sr-only">
                  {message('documents.bodyHint')}
                </FieldDescription>
              </Field>
            </div>
            <div
              role={wide ? undefined : 'tabpanel'}
              id={wide ? undefined : 'document-panel-preview'}
              aria-label={message('documents.tabPreview')}
              hidden={!wide && editorMode === 'edit'}
            >
              <MarkdownPreview
                markdown={deferredPreview}
                framed={false}
                attachments={attachmentContext}
              />
            </div>
          </div>
        </div>
        {inputError ? (
          <Failure code={inputError} />
        ) : mutation.isError ? (
          <Failure error={mutation.error} />
        ) : null}
        {conflict && onReadLatest ? (
          <ConflictSection
            latest={latest}
            latestPending={latestPending}
            onReadLatest={() => {
              void onReadLatest?.().then(setLatestRead);
            }}
            onKeep={() => reconcile(false)}
            onTake={() => reconcile(true)}
            attachments={attachmentContext}
          />
        ) : null}
        {baseline.version !== undefined ? (
          <p className="text-sm text-muted-foreground">
            {message('documents.baseline', { version: baseline.version })}
          </p>
        ) : null}
      </FieldGroup>
      {document && fileTransfer ? (
        <AttachmentsPanel
          apiClient={apiClient}
          identity={identity}
          documentId={document.id}
          canEdit={!cannotEdit && !mutation.isPending}
          transfer={fileTransfer}
          onInsert={(reference) => {
            if (!markdownInput.current) return;
            markdownInput.current.value += `\n\n${reference}`;
            setPreview(markdownInput.current.value);
            setDirty(true);
          }}
        />
      ) : null}
    </form>
  );
}

export function NewDocumentView({
  apiClient,
  onCreated,
  onBack,
  onDirtyChange,
  knowledgeBaseId,
}: {
  apiClient: ApiClient;
  onCreated: (id: string) => void;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  knowledgeBaseId?: string;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const base = useQuery(
    knowledgeBaseQuery(apiClient, session.data?.user.id, knowledgeBaseId),
  );
  const personal = useQuery({
    queryKey: [
      'knowledge',
      'write-permission',
      session.data?.user.id,
      'personal',
    ],
    enabled: !!session.data && !knowledgeBaseId,
    queryFn: async ({ signal }) =>
      (
        await listPersonalDocuments({
          client: apiClient,
          query: { limit: 1 },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
  });
  const permission = knowledgeBaseId ? base : personal;
  const canCreate = knowledgeBaseId
    ? !!base.data?.can_edit
    : !!personal.data?.can_create;
  return (
    <Page
      title={message('common.newDocument')}
      actions={
        <Button variant="outline" onClick={onBack}>
          {knowledgeBaseId
            ? message('documents.backToBase')
            : message('documents.title')}
        </Button>
      }
    >
      <IdentityGate session={session}>
        {permission.isPending ? (
          <p role="status">{message('documents.readingBasePerms')}</p>
        ) : permission.isError ? (
          <Failure error={permission.error} />
        ) : null}
        {session.data && permission.data ? (
          <DocumentForm
            key={`${session.data.user.id}:${knowledgeBaseId ?? 'personal'}`}
            apiClient={apiClient}
            identity={session.data}
            onSaved={onCreated}
            knowledgeBaseId={knowledgeBaseId}
            readOnly={permission.isError || !canCreate}
            latestPending={permission.isFetching}
            onRefreshPermission={async () => {
              if (knowledgeBaseId) {
                const refreshed = await base.refetch();
                return refreshed.isSuccess && refreshed.data.can_edit;
              }
              const refreshed = await personal.refetch();
              return refreshed.isSuccess && refreshed.data.can_create;
            }}
            onDirtyChange={onDirtyChange}
          />
        ) : null}
      </IdentityGate>
    </Page>
  );
}

function documentQuery(
  apiClient: ApiClient,
  userId: string | undefined,
  documentId: string,
) {
  return queryOptions({
    queryKey: ['knowledge', 'document', userId, documentId],
    enabled: !!userId,
    queryFn: async ({ signal }) =>
      (
        await getDocument({
          client: apiClient,
          path: { id: documentId },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
  });
}

export function DocumentView({
  apiClient,
  documentId,
  onBack,
  onEdit,
  onLibrary,
  fileTransfer,
}: {
  apiClient: ApiClient;
  documentId: string;
  onEdit: () => void;
  onLibrary: (id: string) => void;
  onBack: () => void;
  fileTransfer: FileTransfer;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const document = useQuery(
    documentQuery(apiClient, session.data?.user.id, documentId),
  );
  return (
    <div className="app-page document-reader flex flex-col gap-6">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" />
        {message('documents.title')}
      </Button>
      <IdentityGate session={session}>
        {document.isPending ? (
          <p role="status">{message('documents.readingDocument')}</p>
        ) : document.isError ? (
          <Failure error={document.error} />
        ) : (
          <article className="flex flex-col gap-6">
            <div className="document-reader-heading">
              <div>
                <h1 className="text-2xl font-semibold">
                  {document.data.title}
                </h1>
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  aria-label={message('documents.openBase')}
                  onClick={() => onLibrary(document.data.knowledge_base_id)}
                >
                  <span aria-hidden="true">
                    <KnowledgeBaseGraphic
                      userId={session.data?.user.id}
                      baseId={document.data.knowledge_base_id}
                      name={message('documents.openBase')}
                      small
                    />
                  </span>
                  {message('documents.openBase')}
                </Button>
                <p className="text-sm text-muted-foreground">
                  {message('common.version', {
                    version: document.data.version,
                  })}
                </p>
              </div>
              <div className="document-reader-actions">
                {document.data.can_edit ? (
                  <Button size="sm" onClick={onEdit}>
                    <FileCode2 data-icon="inline-start" />
                    {message('documents.edit')}
                  </Button>
                ) : null}
                {document.data.can_edit && session.data ? (
                  <DeleteResource
                    key={`delete:${session.data.user.id}:${documentId}`}
                    apiClient={apiClient}
                    identity={session.data}
                    resource={{
                      kind: 'document',
                      id: documentId,
                      name: document.data.title,
                    }}
                    onDeleted={onBack}
                  />
                ) : null}
              </div>
            </div>
            <nav
              className="document-reader-navigation"
              aria-label={message('reader.navigation')}
            >
              <a href="#document-body">{message('reader.body')}</a>
              <a href="#document-attachments">
                {message('attachments.heading')}
              </a>
              <a href="#document-exports">{message('exports.heading')}</a>
            </nav>
            <section
              id="document-body"
              className="document-reading-body"
              aria-label={message('reader.body')}
            >
              <MarkdownPreview
                framed={false}
                markdown={document.data.markdown}
                attachments={
                  session.data
                    ? {
                        apiClient,
                        userId: session.data.user.id,
                        documentId,
                        transfer: fileTransfer,
                      }
                    : undefined
                }
              />
            </section>
            {session.data ? (
              <div id="document-exports">
                <ExportsPanel
                  key={`exports:${session.data.user.id}:${documentId}`}
                  apiClient={apiClient}
                  identity={session.data}
                  documentId={documentId}
                  transfer={fileTransfer}
                />
              </div>
            ) : null}
            {session.data ? (
              <div id="document-attachments">
                <AttachmentsPanel
                  key={`${session.data.user.id}:${documentId}`}
                  apiClient={apiClient}
                  identity={session.data}
                  documentId={documentId}
                  canEdit={document.data.can_edit}
                  transfer={fileTransfer}
                />
              </div>
            ) : null}
          </article>
        )}
      </IdentityGate>
    </div>
  );
}

export function EditDocumentView({
  apiClient,
  documentId,
  onSaved,
  onBack,
  onDirtyChange,
  fileTransfer,
}: {
  apiClient: ApiClient;
  documentId: string;
  onSaved: (id: string) => void;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  fileTransfer: FileTransfer;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const document = useQuery(
    documentQuery(apiClient, session.data?.user.id, documentId),
  );
  return (
    <Page
      title={message('documents.edit')}
      actions={
        <Button variant="outline" onClick={onBack}>
          {message('documents.backToDocument')}
        </Button>
      }
    >
      <IdentityGate session={session}>
        {document.isPending ? (
          <p role="status">{message('documents.readingDocument')}</p>
        ) : null}
        {document.isError ? <Failure error={document.error} /> : null}
        {document.data && session.data ? (
          <DocumentForm
            key={`${session.data.user.id}:${documentId}`}
            apiClient={apiClient}
            identity={session.data}
            document={document.data}
            fileTransfer={fileTransfer}
            readOnly={document.isError}
            onSaved={onSaved}
            onDirtyChange={onDirtyChange}
            latestPending={document.isFetching}
            onRefreshPermission={async () => {
              const refreshed = await document.refetch();
              return refreshed.isSuccess && refreshed.data.can_edit;
            }}
            onReadLatest={async () => {
              const result = await document.refetch();
              return result.isSuccess ? result.data.version : undefined;
            }}
          />
        ) : null}
      </IdentityGate>
    </Page>
  );
}
