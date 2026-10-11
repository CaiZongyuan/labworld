import { useState } from 'react';
import type { LabWorld } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@labos-threejs/ui/components/dialog';
import {
  Field,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';
import { errorCodeOf } from '@labos-threejs/core';
import type { useMotion } from './use-motion';

export function MotionControls({
  motion,
  world,
  disabled,
}: {
  motion: ReturnType<typeof useMotion>;
  world?: LabWorld;
  disabled: boolean;
}) {
  const message = useAppMessage('lab');
  const [open, setOpen] = useState(false);
  const [representation, setRepresentation] = useState('');
  const [rate, setRate] = useState<15 | 30>(30);
  const busy = motion.state === 'connecting';
  const joined = ['waiting', 'live', 'stale', 'paused', 'interrupted'].includes(
    motion.state,
  );
  const selected = world?.assets.some(
    (asset) => asset.representation.id === representation,
  )
    ? representation
    : (world?.assets[0]?.representation.id ?? '');
  const code = errorCodeOf(motion.error);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!world}
        onClick={() => setOpen(true)}
      >
        {message('motion.title')}
        <Badge
          variant={
            motion.state === 'live'
              ? 'success'
              : motion.state === 'stale'
                ? 'warning'
                : 'secondary'
          }
        >
          {message(`motion.${motion.state}`)}
        </Badge>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex flex-col gap-4">
          <DialogTitle>{message('motion.title')}</DialogTitle>
          <DialogDescription>{message('motion.description')}</DialogDescription>
          <p role="status">
            {message(`motion.${motion.state}`)} · {motion.rate} Hz
          </p>
          {motion.fixture ? (
            <p className="text-sm text-muted-foreground">
              Session {motion.fixture.session_id}
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="motion-rate">
              {message('motion.rate')}
            </FieldLabel>
            <NativeSelect
              id="motion-rate"
              value={rate}
              disabled={busy || joined}
              onChange={(event) =>
                setRate(Number(event.target.value) as 15 | 30)
              }
            >
              <NativeSelectOption value="30">30 Hz</NativeSelectOption>
              <NativeSelectOption value="15">15 Hz</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="motion-representation">
              {message('motion.model')}
            </FieldLabel>
            <NativeSelect
              id="motion-representation"
              value={selected}
              disabled={busy || joined || !world?.assets.length}
              onChange={(event) => setRepresentation(event.target.value)}
            >
              {!world?.assets.length ? (
                <NativeSelectOption value="">
                  {message('motion.noModel')}
                </NativeSelectOption>
              ) : null}
              {world?.assets.map((asset) => (
                <NativeSelectOption
                  key={asset.representation.id}
                  value={asset.representation.id}
                >
                  {asset.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{message('motion.prepareHint')}</FieldDescription>
          </Field>
          {motion.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {message(
                  code === 'lab.motion_fixture_disabled'
                    ? 'motion.disabled'
                    : code === 'lab.motion_fixture_not_found'
                      ? 'motion.notFound'
                      : code === 'auth.unauthorized' || code === 'auth.csrf'
                        ? 'motion.denied'
                        : 'motion.failure',
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || busy || joined}
              onClick={() => {
                void motion.join(rate);
              }}
            >
              {message('motion.join')}
            </Button>
            <Button
              variant="outline"
              disabled={disabled || busy || joined || !selected}
              onClick={() => {
                void motion.join(rate, selected);
              }}
            >
              {message('motion.prepare')}
            </Button>
            <Button
              variant="outline"
              disabled={motion.state === 'disconnected'}
              onClick={motion.leave}
            >
              {message('motion.leave')}
            </Button>
            <DialogClose render={<Button variant="ghost" />}>
              {message('motion.close')}
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
