import { useState } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Textarea } from '@labos-threejs/ui/components/textarea';
import { Switch } from '@labos-threejs/ui/components/switch';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { Field, FieldLabel } from '@labos-threejs/ui/components/field';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@labos-threejs/ui/components/alert-dialog';
import { Progress } from '@labos-threejs/ui/components/progress';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';

// The components tab operates real @labos-threejs/ui components in their production
// states — loading, error, disabled, focus — with local state only
// (docs/ui/design.md §6 Q3: the showroom never triggers real writes).

const VARIANTS = [
  { key: 'design.components.btnDefault', variant: 'default' },
  { key: 'design.components.btnOutline', variant: 'outline' },
  { key: 'design.components.btnSecondary', variant: 'secondary' },
  { key: 'design.components.btnGhost', variant: 'ghost' },
  { key: 'design.components.btnDestructive', variant: 'destructive' },
  { key: 'design.components.btnLink', variant: 'link' },
] as const;

export function ComponentsSection() {
  const message = useAppMessage();
  const [loading, setLoading] = useState(false);
  const [errorOn, setErrorOn] = useState(false);
  const [name, setName] = useState('');
  const [subscribed, setSubscribed] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{message('design.components.buttons')}</CardTitle>
          <CardDescription>
            {message('design.components.variantsHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {VARIANTS.map(({ key, variant }) => (
            <Button key={variant} type="button" variant={variant}>
              {message(key)}
            </Button>
          ))}
          <Button
            type="button"
            aria-busy={loading}
            onClick={() => setLoading((value) => !value)}
          >
            {loading ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : null}
            {loading
              ? message('design.components.loadingOn')
              : message('design.components.loadingToggle')}
          </Button>
          <Button type="button" disabled>
            {message('design.components.disabled')}
          </Button>
          <p className="w-full text-sm text-muted-foreground">
            {message('design.components.focusHint')}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.components.forms')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="design-demo-name">
              {message('design.components.nameLabel')}
            </FieldLabel>
            <Input
              id="design-demo-name"
              value={name}
              aria-invalid={errorOn}
              onChange={(event) => setName(event.target.value)}
            />
            {errorOn ? (
              <p role="alert" className="text-sm text-destructive">
                {message('design.components.fieldError')}
              </p>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="design-demo-bio">
              {message('design.components.bioLabel')}
            </FieldLabel>
            <Textarea id="design-demo-bio" rows={3} />
          </Field>
          <Field>
            <FieldLabel htmlFor="design-demo-role">
              {message('design.components.roleLabel')}
            </FieldLabel>
            <NativeSelect id="design-demo-role" defaultValue="member">
              <NativeSelectOption value="member">
                {message('design.components.roleMember')}
              </NativeSelectOption>
              <NativeSelectOption value="admin">
                {message('design.components.roleAdmin')}
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="design-demo-notify">
              {message('design.components.notifyLabel')}
            </FieldLabel>
            <Switch
              id="design-demo-notify"
              checked={subscribed}
              onCheckedChange={setSubscribed}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="design-demo-error">
              {message('design.components.errorToggle')}
            </FieldLabel>
            <Switch
              id="design-demo-error"
              checked={errorOn}
              onCheckedChange={setErrorOn}
            />
          </Field>
          {errorOn ? (
            <Alert variant="destructive">
              <AlertTitle>{message('design.components.errorTitle')}</AlertTitle>
              <AlertDescription>
                {message('design.components.errorDescription')}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.components.overlays')}</CardTitle>
          <CardDescription>
            {message('design.components.dialogHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <AlertDialog
            onOpenChange={(open) => {
              if (open) setConfirmed(false);
            }}
          >
            <AlertDialogTrigger render={<Button variant="destructive" />}>
              {message('design.components.deleteDemo')}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {message('design.components.dialogTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {message('design.components.dialogOverlayHint')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {message('design.components.dialogCancel')}
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => setConfirmed(true)}>
                  {message('design.components.dialogConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {confirmed ? (
            <p role="status" className="text-sm">
              {message('design.components.dialogConfirmed')}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.components.feedback')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Progress
            aria-label={message('design.components.progressLabel')}
            value={60}
          />
          <div
            className="flex flex-col gap-2"
            aria-label={message('design.components.skeletonLabel')}
          >
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge>{message('design.components.badgeDefault')}</Badge>
            <Badge variant="secondary">
              {message('design.components.badgeSecondary')}
            </Badge>
            <Badge variant="destructive">
              {message('design.components.badgeDestructive')}
            </Badge>
            <Badge variant="outline">
              {message('design.components.badgeOutline')}
            </Badge>
          </div>
          <Alert>
            <AlertTitle>{message('design.components.alertTitle')}</AlertTitle>
            <AlertDescription>
              {message('design.components.alertDescription')}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
