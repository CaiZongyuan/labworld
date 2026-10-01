import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/90',
        destructive:
          'bg-destructive/10 text-destructive [a]:hover:bg-destructive/15',
        outline:
          'border-border text-foreground [a]:hover:bg-accent [a]:hover:text-accent-foreground',
        ghost: '[a]:hover:bg-accent [a]:hover:text-accent-foreground',
        link: 'text-link underline-offset-4 [a]:hover:underline',
        info: 'bg-info/10 text-info',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
