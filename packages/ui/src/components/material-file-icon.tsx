import { cn } from 'cn';

// MaterialFileIcon — local Material Icon Theme file-type icons, fixed at
// 5.38.1 (docs/ui/design.md §6 Q9). The component carries no file access
// or preview logic; each vendored SVG distributes its copyright and MIT
// license header, with provenance in THIRD-PARTY-NOTICES.md.

const icons = {
  file: new URL('../assets/material-file-icons/file.svg', import.meta.url).href,
  folder: new URL('../assets/material-file-icons/folder.svg', import.meta.url)
    .href,
  document: new URL(
    '../assets/material-file-icons/document.svg',
    import.meta.url,
  ).href,
  markdown: new URL(
    '../assets/material-file-icons/markdown.svg',
    import.meta.url,
  ).href,
  pdf: new URL('../assets/material-file-icons/pdf.svg', import.meta.url).href,
  python: new URL('../assets/material-file-icons/python.svg', import.meta.url)
    .href,
  r: new URL('../assets/material-file-icons/r.svg', import.meta.url).href,
  typescript: new URL(
    '../assets/material-file-icons/typescript.svg',
    import.meta.url,
  ).href,
  'typescript-def': new URL(
    '../assets/material-file-icons/typescript-def.svg',
    import.meta.url,
  ).href,
  javascript: new URL(
    '../assets/material-file-icons/javascript.svg',
    import.meta.url,
  ).href,
  react: new URL('../assets/material-file-icons/react.svg', import.meta.url)
    .href,
  json: new URL('../assets/material-file-icons/json.svg', import.meta.url).href,
  yaml: new URL('../assets/material-file-icons/yaml.svg', import.meta.url).href,
  html: new URL('../assets/material-file-icons/html.svg', import.meta.url).href,
  css: new URL('../assets/material-file-icons/css.svg', import.meta.url).href,
  table: new URL('../assets/material-file-icons/table.svg', import.meta.url)
    .href,
  image: new URL('../assets/material-file-icons/image.svg', import.meta.url)
    .href,
  zip: new URL('../assets/material-file-icons/zip.svg', import.meta.url).href,
  database: new URL(
    '../assets/material-file-icons/database.svg',
    import.meta.url,
  ).href,
  console: new URL('../assets/material-file-icons/console.svg', import.meta.url)
    .href,
  powershell: new URL(
    '../assets/material-file-icons/powershell.svg',
    import.meta.url,
  ).href,
  jupyter: new URL('../assets/material-file-icons/jupyter.svg', import.meta.url)
    .href,
  word: new URL('../assets/material-file-icons/word.svg', import.meta.url).href,
  powerpoint: new URL(
    '../assets/material-file-icons/powerpoint.svg',
    import.meta.url,
  ).href,
  xml: new URL('../assets/material-file-icons/xml.svg', import.meta.url).href,
  video: new URL('../assets/material-file-icons/video.svg', import.meta.url)
    .href,
  audio: new URL('../assets/material-file-icons/audio.svg', import.meta.url)
    .href,
  readme: new URL('../assets/material-file-icons/readme.svg', import.meta.url)
    .href,
  license: new URL('../assets/material-file-icons/license.svg', import.meta.url)
    .href,
  git: new URL('../assets/material-file-icons/git.svg', import.meta.url).href,
  docker: new URL('../assets/material-file-icons/docker.svg', import.meta.url)
    .href,
  settings: new URL(
    '../assets/material-file-icons/settings.svg',
    import.meta.url,
  ).href,
};

type IconName = keyof typeof icons;

const fileNames = new Map<string, IconName>([
  ['readme', 'readme'],
  ['readme.md', 'readme'],
  ['readme.txt', 'readme'],
  ['license', 'license'],
  ['license.md', 'license'],
  ['license.txt', 'license'],
  ['copying', 'license'],
  ['dockerfile', 'docker'],
  ['compose.yaml', 'docker'],
  ['compose.yml', 'docker'],
  ['docker-compose.yaml', 'docker'],
  ['docker-compose.yml', 'docker'],
  ['.gitignore', 'git'],
  ['.gitattributes', 'git'],
  ['.gitmodules', 'git'],
  ['.env', 'settings'],
]);

const extensions = new Map<string, IconName>([
  ...associate('markdown', ['md', 'markdown', 'mdx', 'rmd', 'qmd']),
  ...associate('document', ['txt', 'text', 'log', 'rtf']),
  ...associate('pdf', ['pdf']),
  ...associate('python', ['py', 'pyi', 'pyw', 'pyc']),
  ...associate('r', ['r', 'rdata', 'rds']),
  ...associate('typescript-def', ['d.ts', 'd.mts', 'd.cts']),
  ...associate('typescript', ['ts', 'mts', 'cts']),
  ...associate('javascript', ['js', 'mjs', 'cjs']),
  ...associate('react', ['tsx', 'jsx']),
  ...associate('json', ['json', 'jsonc', 'jsonl', 'ndjson']),
  ...associate('yaml', ['yaml', 'yml']),
  ...associate('html', ['html', 'htm']),
  ...associate('css', ['css', 'scss', 'sass', 'less']),
  ...associate('table', [
    'csv',
    'tsv',
    'xls',
    'xlsx',
    'xlsm',
    'ods',
    'parquet',
    'arrow',
  ]),
  ...associate('image', [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'avif',
    'tif',
    'tiff',
  ]),
  ...associate('zip', ['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar']),
  ...associate('database', ['sql', 'sqlite', 'sqlite3', 'db']),
  ...associate('console', ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd']),
  ...associate('powershell', ['ps1', 'psm1', 'psd1']),
  ...associate('jupyter', ['ipynb']),
  ...associate('word', ['doc', 'docx', 'odt']),
  ...associate('powerpoint', ['ppt', 'pptx', 'odp']),
  ...associate('xml', ['xml', 'xsd', 'xsl']),
  ...associate('video', ['mp4', 'webm', 'mov', 'avi', 'mkv']),
  ...associate('audio', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']),
  ...associate('settings', ['ini', 'cfg', 'conf', 'toml']),
]);

const mimeTypes = new Map<string, IconName>([
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['application/ld+json', 'json'],
  ['application/x-ndjson', 'json'],
  ['application/yaml', 'yaml'],
  ['text/yaml', 'yaml'],
  ['text/markdown', 'markdown'],
  ['text/html', 'html'],
  ['text/css', 'css'],
  ['text/csv', 'table'],
  ['text/tab-separated-values', 'table'],
  ['application/vnd.ms-excel', 'table'],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'table',
  ],
  ['application/msword', 'word'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'word',
  ],
  ['application/vnd.ms-powerpoint', 'powerpoint'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'powerpoint',
  ],
  ['application/zip', 'zip'],
  ['application/gzip', 'zip'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
]);

function associate(icon: IconName, values: string[]): [string, IconName][] {
  return values.map((value) => [value, icon]);
}

function resolveIcon(name: string, mimeType?: string | null): IconName {
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const exact = fileNames.get(basename);
  if (exact) return exact;

  // Longest suffix first, so compound extensions like .d.ts beat .ts.
  for (
    let dot = basename.indexOf('.');
    dot >= 0;
    dot = basename.indexOf('.', dot + 1)
  ) {
    const match = extensions.get(basename.slice(dot + 1));
    if (match) return match;
  }

  const mime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const match = mimeTypes.get(mime);
  if (match) return match;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'document';
  return 'file';
}

export function MaterialFileIcon({
  name,
  kind = 'file',
  mimeType,
  className,
}: {
  name: string;
  kind?: 'file' | 'folder';
  mimeType?: string | null;
  className?: string;
}) {
  const icon = kind === 'folder' ? 'folder' : resolveIcon(name, mimeType);
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn('size-5 shrink-0 object-contain', className)}
      data-material-file-icon={icon}
      draggable={false}
      height={20}
      src={icons[icon]}
      width={20}
    />
  );
}
