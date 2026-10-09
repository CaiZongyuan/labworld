import { lazy, Suspense, useRef, useState, type RefObject } from 'react';
import { Check, Palette, RotateCcw, Shuffle, X } from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@labos-threejs/ui/components/dialog';
import { EntityGraphic } from './entity-graphic';
import {
  defaultGraphic,
  graphicColors,
  graphicGlyphs,
  type GeneratedGraphic,
  type GraphicChoice,
  type GraphicKind,
  type IconGraphic,
} from './graphic-choice';
import { useAppMessage } from './messages';

// The picker only owns a draft. The caller commits the validated preference.
export function GraphicPicker({
  kind,
  choice,
  name,
  seed,
  label,
  onChange,
  iconOnly = false,
}: {
  kind: GraphicKind;
  choice: GraphicChoice;
  name: string;
  seed: string;
  label: string;
  onChange: (choice: GraphicChoice) => void;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        variant={iconOnly ? 'ghost' : 'outline'}
        size={iconOnly ? 'icon-lg' : 'sm'}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        {iconOnly ? (
          <EntityGraphic choice={choice} name={name} />
        ) : (
          <>
            <Palette data-icon="inline-start" />
            {label}
          </>
        )}
      </Button>
      {open ? (
        <GraphicDialog
          kind={kind}
          choice={choice}
          name={name}
          seed={seed}
          label={label}
          trigger={trigger}
          onClose={() => setOpen(false)}
          onConfirm={(value) => {
            onChange(value);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function GraphicDialog({
  kind,
  choice,
  name,
  seed,
  label,
  trigger,
  onClose,
  onConfirm,
}: {
  kind: GraphicKind;
  choice: GraphicChoice;
  name: string;
  seed: string;
  label: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: (choice: GraphicChoice) => void;
}) {
  const message = useAppMessage();
  const [selection, setSelection] = useState(choice);
  const [generated, setGenerated] = useState<GeneratedGraphic>(
    choice.kind === 'generated' ? choice : defaultGraphic(kind, seed),
  );
  const [icon, setIcon] = useState<IconGraphic>(
    choice.kind === 'icon'
      ? choice
      : { kind: 'icon', glyph: 'book-open', color: 'teal' },
  );
  const [round, setRound] = useState(0);
  const seeds = [
    choice.kind === 'generated' ? choice.seed : seed,
    ...Array.from({ length: 11 }, (_, index) => `${seed}:${round}:${index}`),
  ];
  const selectGenerated = (next: GeneratedGraphic) => {
    setGenerated(next);
    setSelection(next);
  };
  const selectIcon = (next: IconGraphic) => {
    setIcon(next);
    setSelection(next);
  };
  const modes =
    kind === 'user'
      ? (['lorelei', 'voxel-bot', 'marbles'] as const)
      : (['glass', 'icon'] as const);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent finalFocus={trigger}>
        <header className="graphic-dialog-heading">
          <DialogTitle>{label}</DialogTitle>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title={message('graphic.close')}
                aria-label={message('graphic.close')}
              />
            }
          >
            <X aria-hidden="true" />
          </DialogClose>
        </header>
        <DialogDescription className="sr-only">
          {message('graphic.description')}
        </DialogDescription>
        <div className="graphic-current">
          <EntityGraphic
            choice={selection}
            name={name}
            size="large"
            portrait={kind === 'user'}
          />
          <div>
            <strong>{name}</strong>
            <span>{message('settings.scope.device')}</span>
          </div>
        </div>
        <fieldset className="graphic-modes">
          <legend className="sr-only">{message('graphic.style')}</legend>
          {modes.map((mode) => {
            const title =
              mode === 'icon'
                ? message('graphic.icon')
                : mode === 'voxel-bot'
                  ? 'Voxel Bot'
                  : mode === 'lorelei'
                    ? 'Lorelei'
                    : mode === 'marbles'
                      ? 'Marbles'
                      : 'Glass';
            const preview: GraphicChoice =
              mode === 'icon' ? icon : { ...generated, style: mode };
            return (
              <label key={mode}>
                <input
                  type="radio"
                  name="graphic-style"
                  aria-label={title}
                  checked={
                    mode === 'icon'
                      ? selection.kind === 'icon'
                      : selection.kind === 'generated' &&
                        selection.style === mode
                  }
                  onChange={() =>
                    mode === 'icon'
                      ? selectIcon(icon)
                      : selectGenerated({ ...generated, style: mode })
                  }
                />
                <span>
                  <span aria-hidden="true">
                    <EntityGraphic
                      choice={preview}
                      name={title}
                      portrait={kind === 'user'}
                    />
                  </span>
                  {title}
                </span>
              </label>
            );
          })}
        </fieldset>
        {selection.kind === 'generated' ? (
          <>
            <div
              className="graphic-candidates"
              role="group"
              aria-label={message('graphic.candidates')}
            >
              {seeds.map((candidate, index) => (
                <button
                  key={candidate}
                  type="button"
                  aria-label={message('graphic.candidate', {
                    index: index + 1,
                  })}
                  aria-pressed={selection.seed === candidate}
                  onClick={() =>
                    selectGenerated({ ...generated, seed: candidate })
                  }
                >
                  <span aria-hidden="true">
                    <EntityGraphic
                      choice={{ ...generated, seed: candidate }}
                      name={name}
                      portrait={kind === 'user'}
                    />
                  </span>
                  {selection.seed === candidate ? (
                    <Check className="graphic-check" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
            <fieldset className="graphic-swatches">
              <legend>{message('graphic.background')}</legend>
              <div>
                {[
                  'default',
                  'b8d8f8',
                  'bce5d3',
                  'f7d48b',
                  'f1bacb',
                  'bdb6ef',
                  'c5d3dd',
                ].map((color) => (
                  <label
                    key={color}
                    title={
                      color === 'default'
                        ? message('graphic.default')
                        : `#${color}`
                    }
                  >
                    <input
                      type="radio"
                      name="graphic-background"
                      aria-label={
                        color === 'default'
                          ? message('graphic.default')
                          : `#${color}`
                      }
                      checked={(generated.background ?? 'default') === color}
                      onChange={() =>
                        selectGenerated({
                          ...generated,
                          background: color === 'default' ? undefined : color,
                        })
                      }
                    />
                    <span
                      style={
                        color === 'default'
                          ? undefined
                          : { backgroundColor: `#${color}` }
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <div
              className="graphic-candidates graphic-glyphs"
              role="group"
              aria-label={message('graphic.glyphs')}
            >
              {graphicGlyphs.map((glyph) => (
                <button
                  key={glyph}
                  type="button"
                  aria-label={message(`graphic.glyph.${glyph}`)}
                  title={message(`graphic.glyph.${glyph}`)}
                  aria-pressed={icon.glyph === glyph}
                  onClick={() => selectIcon({ ...icon, glyph })}
                >
                  <span aria-hidden="true">
                    <EntityGraphic
                      choice={{ ...icon, glyph }}
                      name={message(`graphic.glyph.${glyph}`)}
                    />
                  </span>
                  {icon.glyph === glyph ? (
                    <Check className="graphic-check" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
            <fieldset className="graphic-swatches">
              <legend>{message('graphic.color')}</legend>
              <div>
                {graphicColors.map((color) => (
                  <label key={color} title={message(`graphic.color.${color}`)}>
                    <input
                      type="radio"
                      name="graphic-color"
                      aria-label={message(`graphic.color.${color}`)}
                      checked={icon.color === color}
                      onChange={() => selectIcon({ ...icon, color })}
                    />
                    <span
                      style={{
                        backgroundColor: `var(--module-${color}-foreground)`,
                      }}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <div className="graphic-tools">
          {selection.kind === 'generated' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message('graphic.shuffle')}
              title={message('graphic.shuffle')}
              onClick={() => setRound(round + 1)}
            >
              <Shuffle aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={message('graphic.reset')}
            title={message('graphic.reset')}
            onClick={() => selectGenerated(defaultGraphic(kind, seed))}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <details className="graphic-license">
            <summary>DiceBear</summary>
            <Suspense fallback={null}>
              <GraphicNotice />
            </Suspense>
          </details>
        </div>
        <footer className="graphic-dialog-footer">
          <Button variant="outline" size="sm" onClick={onClose}>
            {message('graphic.cancel')}
          </Button>
          <Button size="sm" onClick={() => onConfirm(selection)}>
            <Check data-icon="inline-start" />
            {message('graphic.use')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

const GraphicNotice = lazy(() => import('./graphic-notice'));
