export {
  ForgotPasswordView,
  ResetPasswordView,
} from './identity/password-reset-views';
export { ApiKeysView } from './api-keys/api-keys-view';
export { AuditView, auditFilterFields } from './audit/audit-view';
export {
  NotificationsView,
  type NotificationTargetResolver,
} from './notifications/notifications-view';
export { StatusView } from './system/status-view';
export { RegisterView } from './identity/register-view';
export { HomeView } from './identity/home-view';
export { LoginView } from './identity/login-view';
export { JobsView, JobView, filterableStatuses } from './jobs/jobs-view';
export { MembersView } from './organization/members-view';
// The universal shell and its composition contract: Core-owned, imported
// by the app assembly point and never by example code.
export {
  assembleApp,
  CORE_RESERVED_ROUTES,
  type AppPage,
  type AppPageProps,
  type AppScene,
  type AssembledApp,
  type AssembledScene,
  type ExampleContribution,
  type NavigatePort,
  type NavigateTarget,
  type NotificationDisplay,
} from './shell/app-contract';
export { AppMessagesProvider, useAppMessage } from './shell/messages';
export {
  PreferencesProvider,
  useFlowLocaleSetter,
  usePreferences,
  type AppLocale,
  type ThemeChoice,
} from './shell/preferences';
export { useAppFormat } from './shell/format';
export { usePageTitle } from './shell/page-title';
export { docsChapterUrl, docsHomeUrl } from './shell/docs-links';
export { AppShellLayout } from './shell/app-shell';
export { SettingsView } from './shell/settings-view';
export {
  LanguageToggle,
  ThemeToggle,
  AuthPreferencesRow,
} from './shell/appearance-controls';
export { BusinessNavigation } from './shell/app-navigation';
// Session query options for app adapters: the shell's role-aware
// navigation derives from the session the adapter resolves (UI06).
export { sessionQuery } from './identity';
// example:knowledge:views:start
export {
  DocumentExportView,
  KnowledgeBaseView,
  KnowledgeBasesView,
  DocumentsView,
  NewDocumentView,
  DocumentView,
  EditDocumentView,
} from './knowledge';
export type { FileTransfer } from './knowledge';
export { createKnowledgeExample } from './knowledge/app-example';
export {
  DocumentGuardContext,
  useDocumentGuard,
  type DocumentGuardValue,
} from './knowledge/document-guard';
// example:knowledge:views:end
// example:notes:views:start
export { createNotesExample } from './notes/example';
// example:notes:views:end
