/** ModuleIcon 默认几何与可访问性，交互留在外层控件。 */
import { renderToStaticMarkup } from 'react-dom/server';
import { Bot } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ModuleIcon, moduleIconColors } from './module-icon';

describe('ModuleIcon', () => {
  it('defaults to a decorative, noninteractive 24px soft icon with a 14px glyph', () => {
    const markup = renderToStaticMarkup(<ModuleIcon icon={Bot} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-appearance="soft"');
    expect(markup).toContain('data-size="md"');
    expect(markup).toContain('size-6');
    expect(markup).toContain('--module-icon-glyph-size:14px');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('tabindex');
  });

  it('can expose an accessible image name without becoming a control', () => {
    const markup = renderToStaticMarkup(
      <ModuleIcon
        icon={Bot}
        label="Agent"
        variant="violet"
        appearance="glossy"
        size="lg"
      />,
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Agent"');
    expect(markup).toContain('data-variant="violet"');
    expect(markup).not.toContain('role="button"');
  });

  it('supports a bare colored glyph without a container surface', () => {
    const markup = renderToStaticMarkup(
      <ModuleIcon appearance="bare" icon={Bot} variant="teal" />,
    );

    expect(markup).toContain('data-appearance="bare"');
    expect(markup).toContain('module-icon-bare');
    expect(markup).toContain(
      '--module-icon-foreground:var(--module-teal-foreground)',
    );
  });

  it('renders every category color through its own token triple', () => {
    for (const variant of moduleIconColors) {
      const markup = renderToStaticMarkup(
        <ModuleIcon icon={Bot} variant={variant} />,
      );
      expect(markup).toContain(
        `--module-icon-foreground:var(--module-${variant}-foreground)`,
      );
    }
  });
});
