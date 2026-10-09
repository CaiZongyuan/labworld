import { useMemo, useState } from 'react';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BellIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  CompassIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FilterIcon,
  FlagIcon,
  FolderIcon,
  GlobeIcon,
  HouseIcon,
  ImageIcon,
  InfoIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MailIcon,
  MenuIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  Share2Icon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  ZapIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '@labos-threejs/ui/components/input';
import { MaterialFileIcon } from '@labos-threejs/ui/components/material-file-icon';
import {
  ModuleIcon,
  moduleIconColors,
  moduleIconAppearances,
} from '@labos-threejs/ui/components/module-icon';
import { useAppMessage } from '../shell/messages';
import { useCopyStatus } from './copy-status';

// The icon catalog (docs/ui/design.md §6 Q9): a curated subset of the
// bilingual product's Lucide icons plus the ModuleIcon category-color
// matrix and Material file-icon samples, loaded as its own async chunk so
// the icon set never lands in the initial bundle. Categories color
// through production tokens; the copy button carries a localized
// accessible name, and copy feedback is text, never color alone.

type CatalogCategory = {
  id: 'actions' | 'navigation' | 'status' | 'objects';
  colorClass: string;
  icons: { name: string; Icon: LucideIcon }[];
};

const CATALOG: CatalogCategory[] = [
  {
    id: 'actions',
    colorClass: 'text-primary',
    icons: [
      { name: 'Plus', Icon: PlusIcon },
      { name: 'Pencil', Icon: PencilIcon },
      { name: 'Trash2', Icon: Trash2Icon },
      { name: 'Search', Icon: SearchIcon },
      { name: 'Download', Icon: DownloadIcon },
      { name: 'Upload', Icon: UploadIcon },
      { name: 'Copy', Icon: CopyIcon },
      { name: 'RefreshCw', Icon: RefreshCwIcon },
      { name: 'Play', Icon: PlayIcon },
      { name: 'Save', Icon: SaveIcon },
      { name: 'Filter', Icon: FilterIcon },
      { name: 'Share2', Icon: Share2Icon },
    ],
  },
  {
    id: 'navigation',
    colorClass: 'text-link',
    icons: [
      { name: 'ChevronUp', Icon: ChevronUpIcon },
      { name: 'ChevronDown', Icon: ChevronDownIcon },
      { name: 'ChevronLeft', Icon: ChevronLeftIcon },
      { name: 'ChevronRight', Icon: ChevronRightIcon },
      { name: 'ArrowRight', Icon: ArrowRightIcon },
      { name: 'ArrowUpRight', Icon: ArrowUpRightIcon },
      { name: 'Menu', Icon: MenuIcon },
      { name: 'X', Icon: XIcon },
      { name: 'ExternalLink', Icon: ExternalLinkIcon },
      { name: 'House', Icon: HouseIcon },
      { name: 'Compass', Icon: CompassIcon },
      { name: 'Repeat', Icon: RepeatIcon },
    ],
  },
  {
    id: 'status',
    colorClass: 'text-success',
    icons: [
      { name: 'Check', Icon: CheckIcon },
      { name: 'CircleCheck', Icon: CircleCheckIcon },
      { name: 'CircleX', Icon: CircleXIcon },
      { name: 'TriangleAlert', Icon: TriangleAlertIcon },
      { name: 'Info', Icon: InfoIcon },
      { name: 'CircleHelp', Icon: CircleHelpIcon },
      { name: 'LoaderCircle', Icon: LoaderCircleIcon },
      { name: 'Bell', Icon: BellIcon },
      { name: 'Star', Icon: StarIcon },
      { name: 'Flag', Icon: FlagIcon },
      { name: 'Zap', Icon: ZapIcon },
    ],
  },
  {
    id: 'objects',
    colorClass: 'text-warning',
    icons: [
      { name: 'File', Icon: FileIcon },
      { name: 'Folder', Icon: FolderIcon },
      { name: 'Image', Icon: ImageIcon },
      { name: 'Calendar', Icon: CalendarIcon },
      { name: 'Mail', Icon: MailIcon },
      { name: 'User', Icon: UserIcon },
      { name: 'Users', Icon: UsersIcon },
      { name: 'KeyRound', Icon: KeyRoundIcon },
      { name: 'Database', Icon: DatabaseIcon },
      { name: 'Globe', Icon: GlobeIcon },
      { name: 'MessageSquare', Icon: MessageSquareIcon },
      { name: 'Settings', Icon: SettingsIcon },
    ],
  },
];

// Module-icon cells render under a scoped light/dark wrapper so both
// token tables preview under one active theme; colors and appearances
// come from the component's own canonical lists.

function ModuleIconThemeTable({ theme }: { theme: 'light' | 'dark' }) {
  const message = useAppMessage();
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">
        {message(
          theme === 'light'
            ? 'design.icons.moduleLight'
            : 'design.icons.moduleDark',
        )}
      </figcaption>
      <div
        className={`module-icon-theme-${theme} flex flex-col gap-2 rounded-md border border-border p-3`}
        style={{
          backgroundColor: 'var(--module-preview-background)',
          color: 'var(--module-preview-foreground)',
        }}
      >
        {moduleIconColors.map((variant) => (
          <div key={variant} className="flex items-center gap-3">
            <span className="w-14 text-xs text-muted-foreground">
              {variant}
            </span>
            {moduleIconAppearances.map((appearance) => (
              <ModuleIcon
                key={appearance}
                icon={BotIcon}
                variant={variant}
                appearance={appearance}
                size="sm"
              />
            ))}
            <ModuleIcon icon={BotIcon} variant={variant} appearance="glossy" />
            <ModuleIcon
              icon={BotIcon}
              variant={variant}
              appearance="glossy"
              size="lg"
            />
          </div>
        ))}
      </div>
    </figure>
  );
}

// Sample names exercise the resolution chain (filename, extension, MIME)
// in both interface languages.
const FILE_ICON_SAMPLES = [
  '设计规范.md',
  'report.pdf',
  '数据.csv',
  'screenshot.png',
  'main.tsx',
  'schema.d.ts',
  'archive.tar.gz',
  'Dockerfile',
  '.gitignore',
  'query.sql',
  'notes.txt',
  'presentation.pptx',
];

function FileIconSamples() {
  const message = useAppMessage();
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">
        {message('design.icons.filesTitle')}
      </figcaption>
      <p className="text-sm text-muted-foreground">
        {message('design.icons.filesDescription')}
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FILE_ICON_SAMPLES.map((name) => (
          <li
            key={name}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
          >
            <MaterialFileIcon name={name} />
            <span className="truncate">{name}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {message('design.icons.materialLicense')}
      </p>
    </figure>
  );
}

export default function IconCatalog({
  copyText,
}: {
  copyText: (text: string) => Promise<void>;
}) {
  const message = useAppMessage();
  const [query, setQuery] = useState('');
  const { copy, status } = useCopyStatus(copyText);
  const needle = query.trim().toLowerCase();
  const categories = useMemo(
    () =>
      CATALOG.map((category) => ({
        ...category,
        icons: category.icons.filter((icon) =>
          icon.name.toLowerCase().includes(needle),
        ),
      })).filter((category) => category.icons.length > 0),
    [needle],
  );
  const total = categories.reduce(
    (count, category) => count + category.icons.length,
    0,
  );
  return (
    <div className="flex flex-col gap-6">
      <section
        className="flex flex-col gap-3"
        aria-label={message('design.icons.moduleTitle')}
      >
        <h3 className="text-sm font-semibold">
          {message('design.icons.moduleTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {message('design.icons.moduleDescription')}
        </p>
        <ModuleIconThemeTable theme="light" />
        <ModuleIconThemeTable theme="dark" />
      </section>
      <FileIconSamples />
      <section className="flex flex-col gap-4">
        <Input
          type="search"
          aria-label={message('design.icons.search')}
          placeholder={message('design.icons.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          {message('design.icons.count', { count: total })}
          {' · '}
          {message('design.icons.licenseNote')}
        </p>
        {categories.map((category) => (
          <section key={category.id} className="flex flex-col gap-2">
            <h3 className={`text-sm font-semibold ${category.colorClass}`}>
              {message(`design.icons.cat.${category.id}`)}
            </h3>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {category.icons.map(({ name, Icon }) => (
                <li key={name}>
                  <button
                    type="button"
                    aria-label={message('design.icons.copy', { name })}
                    className={`flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-border hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring ${category.colorClass}`}
                    onClick={() => void copy(name)}
                  >
                    <Icon aria-hidden="true" className="size-5" />
                    <span className="text-[10px] text-muted-foreground">
                      {name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            {message('design.icons.empty')}
          </p>
        ) : null}
        {status}
      </section>
    </div>
  );
}
