import { Dialog as Primitive } from '@base-ui/react/dialog';
import { cn } from 'cn';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;

export function DialogContent({ className, ...props }: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className="fixed inset-0 z-50 bg-black/45" />
      <Primitive.Popup
        className={cn(
          'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-none outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
