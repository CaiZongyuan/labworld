import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Separator } from '@labos-threejs/ui/components/separator';
import { useAppMessage } from '../shell/messages';
import { useCopyStatus } from './copy-status';

// The foundation tab reads the production design tokens live from the
// document's computed styles (docs/ui/design.md §6 Q9): no second color
// table is maintained here — the names below only reference the CSS
// custom properties owned by @labos-threejs/ui/src/styles.css, and the displayed
// values follow whatever theme (light/dark) is currently applied.

const TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--destructive',
  '--success',
  '--warning',
  '--link',
  '--sidebar',
  '--border',
  '--input',
  '--ring',
  '--radius',
] as const;

/** A radius token is a length, not a color — the swatch shows shape. */
const RADIUS_TOKEN = '--radius';

const TYPE_SCALE = [
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
] as const;
const SPACING_SCALE = ['p-2', 'p-4', 'p-6'] as const;
const RADIUS_SCALE = ['rounded-sm', 'rounded-md', 'rounded-lg'] as const;

function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function TokenRow({
  name,
  value,
  label,
  onCopy,
  copyLabel,
}: {
  name: string;
  value: string;
  label: string;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <li className="flex items-center gap-3">
      {name === RADIUS_TOKEN ? (
        <span
          aria-hidden="true"
          className="size-8 shrink-0 border border-border bg-muted"
          style={{ borderRadius: `var(${name})` }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="size-8 shrink-0 rounded-md border border-border"
          style={{ background: `var(${name})` }}
        />
      )}
      <code className="text-sm">{name}</code>
      <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {value || '—'}
      </code>
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={copyLabel}
        onClick={onCopy}
      >
        {label}
      </Button>
    </li>
  );
}

export function FoundationSection({
  copyText,
}: {
  copyText: (text: string) => Promise<void>;
}) {
  const message = useAppMessage();
  const [query, setQuery] = useState('');
  const { copy, status } = useCopyStatus(copyText);
  // Read the computed values on every render — the read is cheap, the
  // view re-renders on theme changes through its parent, and each visit
  // lists the styles actually applied (light or dark).
  const values = new Map(TOKENS.map((name) => [name, readToken(name)]));
  const visibleTokens = TOKENS.filter((name) =>
    name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{message('design.foundation.tokens')}</CardTitle>
          <CardDescription>
            {message('design.foundation.tokensHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            type="search"
            aria-label={message('design.search.label')}
            placeholder={message('design.search.label')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="flex flex-col gap-2">
            {visibleTokens.map((name) => (
              <TokenRow
                key={name}
                name={name}
                value={values.get(name) ?? ''}
                label={message('design.copy')}
                copyLabel={message('design.copyToken', { name })}
                onCopy={() => void copy(values.get(name) ?? '', name)}
              />
            ))}
          </ul>
          {status}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.foundation.typography')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {TYPE_SCALE.map((cls) => (
            <p key={cls} className="flex items-baseline gap-4">
              <code className="w-24 shrink-0 text-xs text-muted-foreground">
                {cls}
              </code>
              <span className={cls}>{message('design.typography.sample')}</span>
            </p>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.foundation.spacing')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {SPACING_SCALE.map((cls) => (
              <div
                key={cls}
                aria-hidden="true"
                className="border border-border"
              >
                <div className={`${cls} bg-muted`}>
                  <code className="text-xs">{cls}</code>
                </div>
              </div>
            ))}
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            {RADIUS_SCALE.map((cls) => (
              <div
                key={cls}
                aria-hidden="true"
                className={`${cls} border border-border bg-muted p-4`}
              >
                <code className="text-xs">{cls}</code>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
