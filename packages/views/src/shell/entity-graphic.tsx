import { lazy, Suspense, useState, type CSSProperties } from 'react';
import {
  IconUsers,
  IconLayoutKanban,
  IconSchema,
  IconBook,
  IconBrain,
  IconBlocks,
  IconFlask,
  IconMicroscope,
  IconCompass,
  IconNetwork,
  IconBulb,
  IconStack2,
  IconTarget,
  IconTelescope,
  IconChartArrowsVertical,
  IconCode,
  IconPalette,
  IconGlobe,
  IconFileText,
  IconDatabase,
} from '@tabler/icons-react';
import type { GraphicChoice } from './graphic-choice';

const DiceBearImage = lazy(() => import('./dicebear-image'));
const glyphs = {
  users: IconUsers,
  'folder-kanban': IconLayoutKanban,
  workflow: IconSchema,
  'book-open': IconBook,
  brain: IconBrain,
  blocks: IconBlocks,
  'flask-conical': IconFlask,
  microscope: IconMicroscope,
  compass: IconCompass,
  network: IconNetwork,
  lightbulb: IconBulb,
  layers: IconStack2,
  target: IconTarget,
  telescope: IconTelescope,
  'chart-no-axes-combined': IconChartArrowsVertical,
  code: IconCode,
  palette: IconPalette,
  globe: IconGlobe,
  'file-text': IconFileText,
  database: IconDatabase,
};

export function EntityGraphic({
  choice,
  name,
  size = 'default',
  portrait = false,
}: {
  choice: GraphicChoice;
  name: string;
  size?: 'small' | 'default' | 'large';
  portrait?: boolean;
}) {
  const [failedChoice, setFailedChoice] = useState('');
  const key = JSON.stringify(choice);
  const Glyph = choice.kind === 'icon' ? glyphs[choice.glyph] : undefined;
  const fallback = (
    <span className="entity-graphic-fallback" aria-label={name}>
      {name.slice(0, 2)}
    </span>
  );
  return (
    <span
      className={`entity-graphic entity-graphic-${size}${portrait ? ' entity-graphic-portrait' : ''}`}
      style={
        choice.kind === 'icon'
          ? ({
              '--entity-graphic-color': `var(--module-${choice.color}-foreground)`,
            } as CSSProperties)
          : undefined
      }
    >
      {Glyph ? (
        <Glyph aria-label={name} role="img" stroke={1.75} />
      ) : failedChoice === key ? (
        fallback
      ) : (
        <Suspense fallback={fallback}>
          <DiceBearImage
            choice={choice as Extract<GraphicChoice, { kind: 'generated' }>}
            name={name}
            onError={() => setFailedChoice(key)}
          />
        </Suspense>
      )}
    </span>
  );
}
