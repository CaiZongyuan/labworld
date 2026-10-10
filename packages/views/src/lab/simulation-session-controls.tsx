import { useState } from 'react';
import type { LabWorld } from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
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
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';
import type { useSimulationSession } from './use-simulation-session';

export function SimulationSessionControls({
  simulation,
  world,
  disabled,
  startDisabled,
}: {
  simulation: ReturnType<typeof useSimulationSession>;
  world?: LabWorld;
  disabled: boolean;
  startDisabled: boolean;
}) {
  const message = useAppMessage('lab');
  const [open, setOpen] = useState(false);
  const [installationId, setInstallationId] = useState('');
  const [representationId, setRepresentationId] = useState('');
  const installations =
    simulation.installations.data?.filter((item) => !item.archived_at) ?? [];
  const selectedInstallation = installations.some(
    (item) => item.id === installationId,
  )
    ? installationId
    : (installations[0]?.id ?? '');
  const selectedRepresentation = world?.assets.some(
    (asset) => asset.representation.id === representationId,
  )
    ? representationId
    : (world?.assets[0]?.representation.id ?? '');
  const session = simulation.session;
  const active = !!session && !session.ended_at;
  const status = session?.status ?? 'idle';
  const transitioning = [
    'starting',
    'pausing',
    'resuming',
    'stopping',
  ].includes(status);
  const loading =
    simulation.sessions.isPending || simulation.installations.isPending;
  const busy = simulation.pending || transitioning;
  const controlsDisabled = disabled || simulation.eventState !== 'live';
  const code = errorCodeOf(simulation.error);
  const failure =
    code?.includes('conflict') ||
    code?.includes('revision') ||
    code?.includes('busy')
      ? 'session.conflict'
      : code === 'auth.unauthorized' ||
          code === 'auth.csrf' ||
          code === 'api_keys.scope_forbidden'
        ? 'session.denied'
        : code?.includes('unavailable') || code?.includes('disabled')
          ? 'session.unavailable'
          : 'session.failure';
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!world}
        onClick={() => setOpen(true)}
      >
        {message('session.title')}
        <Badge
          variant={
            status === 'running'
              ? 'success'
              : status === 'interrupted'
                ? 'warning'
                : 'secondary'
          }
        >
          {message(`session.${status}`)}
        </Badge>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex flex-col gap-4">
          <DialogTitle>{message('session.title')}</DialogTitle>
          <DialogDescription>
            {message('session.description')}
          </DialogDescription>
          {startDisabled && !disabled ? (
            <Alert>
              <AlertDescription>{message('session.saveHint')}</AlertDescription>
            </Alert>
          ) : null}
          <p role="status" aria-label={message('session.lifecycle')}>
            {loading
              ? message('session.loading')
              : message(`session.${status}`)}
          </p>
          {session ? (
            <p className="text-sm text-muted-foreground break-all">
              Session {session.id} · {session.snapshot.installation.package_id}@
              {session.snapshot.installation.package_version}
            </p>
          ) : null}
          {session?.reason ? (
            <Alert>
              <AlertDescription>
                {message('session.interruptedHint')} ({session.reason})
              </AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="session-installation">
                {message('session.installation')}
              </FieldLabel>
              <NativeSelect
                id="session-installation"
                value={selectedInstallation}
                disabled={
                  disabled || busy || loading || active || !installations.length
                }
                onChange={(event) => setInstallationId(event.target.value)}
              >
                {!installations.length ? (
                  <NativeSelectOption value="">
                    {message('session.empty')}
                  </NativeSelectOption>
                ) : null}
                {installations.map((item, index) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.package_id}@{item.package_version} · {index + 1} ·{' '}
                    {item.id.slice(0, 8)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {message('session.layoutHint')}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="session-model">
                {message('session.model')}
              </FieldLabel>
              <NativeSelect
                id="session-model"
                value={selectedRepresentation}
                disabled={disabled || busy || !world?.assets.length}
                onChange={(event) => setRepresentationId(event.target.value)}
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
              <FieldDescription>
                {message('session.installHint')}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="session-rate">
                {message('motion.rate')}
              </FieldLabel>
              <NativeSelect
                id="session-rate"
                value={simulation.rate}
                onChange={(event) =>
                  simulation.setRate(Number(event.target.value) as 15 | 30)
                }
              >
                <NativeSelectOption value="30">30 Hz</NativeSelectOption>
                <NativeSelectOption value="15">15 Hz</NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>
          <p role="status" aria-label={message('session.reception')}>
            {message(`motion.${simulation.motionState}`)} · {simulation.rate} Hz
          </p>
          {simulation.eventState === 'offline' ||
          simulation.eventState === 'denied' ? (
            <Alert>
              <AlertDescription>
                {message(
                  simulation.eventState === 'denied'
                    ? 'session.denied'
                    : 'session.offline',
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          {!loading &&
          !simulation.sessions.data?.development_synthetic_enabled ? (
            <Alert>
              <AlertDescription>
                {message('session.unavailable')}
              </AlertDescription>
            </Alert>
          ) : null}
          {simulation.error || simulation.motionError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {message(simulation.error ? failure : 'motion.failure')}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled || busy || loading || !selectedRepresentation}
              onClick={() =>
                void simulation.write('install', selectedRepresentation)
              }
            >
              {message('session.install')}
            </Button>
            <Button
              disabled={
                startDisabled ||
                controlsDisabled ||
                busy ||
                loading ||
                active ||
                !selectedInstallation ||
                !simulation.sessions.data?.development_synthetic_enabled
              }
              onClick={() =>
                void simulation.write('start', selectedInstallation)
              }
            >
              {message('session.start')}
            </Button>
            <Button
              variant="outline"
              disabled={controlsDisabled || busy || status !== 'running'}
              onClick={() => void simulation.write('pause')}
            >
              {message('session.pause')}
            </Button>
            <Button
              variant="outline"
              disabled={controlsDisabled || busy || status !== 'paused'}
              onClick={() => void simulation.write('resume')}
            >
              {message('session.resume')}
            </Button>
            <Button
              variant="outline"
              disabled={controlsDisabled || busy || !active}
              onClick={() => void simulation.write('reset')}
            >
              {message('session.resetAction')}
            </Button>
            <Button
              variant="outline"
              disabled={controlsDisabled || busy || !active}
              onClick={() => void simulation.write('stop')}
            >
              {message('session.stop')}
            </Button>
            <Button
              variant="outline"
              disabled={loading || simulation.pending}
              onClick={simulation.retry}
            >
              {message('session.retry')}
            </Button>
            <Button
              variant="outline"
              disabled={!active}
              onClick={() => simulation.setObserving(!simulation.observing)}
            >
              {message(
                simulation.observing ? 'session.leave' : 'session.observe',
              )}
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
