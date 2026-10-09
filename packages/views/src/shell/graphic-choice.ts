export const graphicStyles = [
  'lorelei',
  'voxel-bot',
  'marbles',
  'glass',
] as const;
export const graphicColors = [
  'orange',
  'amber',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'purple',
  'pink',
] as const;
export const graphicGlyphs = [
  'users',
  'folder-kanban',
  'workflow',
  'book-open',
  'brain',
  'blocks',
  'flask-conical',
  'microscope',
  'compass',
  'network',
  'lightbulb',
  'layers',
  'target',
  'telescope',
  'chart-no-axes-combined',
  'code',
  'palette',
  'globe',
  'file-text',
  'database',
] as const;
export type GeneratedGraphic = {
  kind: 'generated';
  style: (typeof graphicStyles)[number];
  seed: string;
  background?: string;
};
export type IconGraphic = {
  kind: 'icon';
  glyph: (typeof graphicGlyphs)[number];
  color: (typeof graphicColors)[number];
};
export type GraphicChoice = GeneratedGraphic | IconGraphic;
export type GraphicKind = 'user' | 'collection';

export function defaultGraphic(
  kind: GraphicKind,
  seed: string,
): GeneratedGraphic {
  return {
    kind: 'generated',
    style: kind === 'user' ? 'lorelei' : 'glass',
    seed,
  };
}

export function parseGraphic(
  value: unknown,
  kind: GraphicKind,
): GraphicChoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.kind === 'icon' &&
    kind === 'collection' &&
    graphicGlyphs.some((glyph) => glyph === record.glyph) &&
    graphicColors.some((color) => color === record.color)
  ) {
    return {
      kind: 'icon',
      glyph: record.glyph as IconGraphic['glyph'],
      color: record.color as IconGraphic['color'],
    };
  }
  if (
    record.kind !== 'generated' ||
    !graphicStyles.some((style) => style === record.style) ||
    typeof record.seed !== 'string' ||
    !record.seed ||
    record.seed.length > 200
  )
    return;
  if ((record.style === 'glass') !== (kind === 'collection')) return;
  if (
    record.background !== undefined &&
    (typeof record.background !== 'string' ||
      !/^[0-9a-f]{6}$/i.test(record.background))
  )
    return;
  return {
    kind: 'generated',
    style: record.style as GeneratedGraphic['style'],
    seed: record.seed,
    ...(record.background ? { background: record.background as string } : {}),
  };
}
