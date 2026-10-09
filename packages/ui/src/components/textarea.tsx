import * as React from 'react';
import { cn } from 'cn';

function Textarea({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'textarea'> & { variant?: 'default' | 'code' }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full transition-colors outline-none selection:bg-selection selection:text-selection-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        variant === 'code'
          ? 'h-[470px] resize-none rounded-none border-0 bg-background px-4 py-4 font-mono text-sm leading-6 focus-visible:ring-inset'
          : 'field-sizing-content rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
