import type { LucideIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

// ModuleIcon — fixed-geometry category icon for small-area module
// identity (docs/ui/design.md §6 Q9). Display-only: interaction and
// business state belong to the enclosing control. Category colors are
// the module-* tokens (styles.css), independent of semantic state
// colors; the pattern follows the confirmed Bio Discovery X reference.

/** The category colors behind the module-* token tables (styles.css). */
export const moduleIconColors = [
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

/** The four container appearances, from bare glyph to glossy chip. */
export const moduleIconAppearances = [
  'bare',
  'flat',
  'soft',
  'glossy',
] as const;

export const moduleIconVariants = cva(
  'module-icon relative isolate inline-flex shrink-0 items-center justify-center overflow-hidden',
  {
    variants: {
      variant: {
        orange:
          '[--module-icon-start:var(--module-orange-start)] [--module-icon-end:var(--module-orange-end)] [--module-icon-foreground:var(--module-orange-foreground)]',
        amber:
          '[--module-icon-start:var(--module-amber-start)] [--module-icon-end:var(--module-amber-end)] [--module-icon-foreground:var(--module-amber-foreground)]',
        green:
          '[--module-icon-start:var(--module-green-start)] [--module-icon-end:var(--module-green-end)] [--module-icon-foreground:var(--module-green-foreground)]',
        teal: '[--module-icon-start:var(--module-teal-start)] [--module-icon-end:var(--module-teal-end)] [--module-icon-foreground:var(--module-teal-foreground)]',
        cyan: '[--module-icon-start:var(--module-cyan-start)] [--module-icon-end:var(--module-cyan-end)] [--module-icon-foreground:var(--module-cyan-foreground)]',
        blue: '[--module-icon-start:var(--module-blue-start)] [--module-icon-end:var(--module-blue-end)] [--module-icon-foreground:var(--module-blue-foreground)]',
        indigo:
          '[--module-icon-start:var(--module-indigo-start)] [--module-icon-end:var(--module-indigo-end)] [--module-icon-foreground:var(--module-indigo-foreground)]',
        violet:
          '[--module-icon-start:var(--module-violet-start)] [--module-icon-end:var(--module-violet-end)] [--module-icon-foreground:var(--module-violet-foreground)]',
        purple:
          '[--module-icon-start:var(--module-purple-start)] [--module-icon-end:var(--module-purple-end)] [--module-icon-foreground:var(--module-purple-foreground)]',
        pink: '[--module-icon-start:var(--module-pink-start)] [--module-icon-end:var(--module-pink-end)] [--module-icon-foreground:var(--module-pink-foreground)]',
      },
      appearance: {
        bare: 'module-icon-bare',
        flat: 'module-icon-flat',
        soft: 'module-icon-soft',
        glossy: 'module-icon-glossy',
      },
      size: {
        sm: 'size-5 rounded-md [--module-icon-glyph-size:12px]',
        md: 'size-6 rounded-[7px] [--module-icon-glyph-size:14px]',
        lg: 'size-8 rounded-lg [--module-icon-glyph-size:18px]',
      },
    },
    defaultVariants: { variant: 'blue', appearance: 'soft', size: 'md' },
  },
);

export type ModuleIconVariant = NonNullable<
  VariantProps<typeof moduleIconVariants>['variant']
>;

export type ModuleIconProps = VariantProps<typeof moduleIconVariants> & {
  icon: LucideIcon;
  label?: string;
  className?: string;
};

export function ModuleIcon({
  icon: Icon,
  label,
  className,
  variant = 'blue',
  appearance = 'soft',
  size = 'md',
}: ModuleIconProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      className={cn(
        moduleIconVariants({ variant, appearance, size }),
        className,
      )}
      data-slot="module-icon"
      data-variant={variant}
      data-appearance={appearance}
      data-size={size}
    >
      <Icon
        aria-hidden="true"
        className="relative size-[var(--module-icon-glyph-size)] shrink-0"
        strokeWidth={1.75}
      />
    </span>
  );
}
