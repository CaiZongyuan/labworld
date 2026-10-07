import { useState } from 'react';
import { InboxIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Field, FieldLabel } from '@labos-threejs/ui/components/field';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { choiceRowClass } from '../shell/rows';
import { useAppMessage } from '../shell/messages';
import type { AppDefinition } from '../shell/app-contract';

// The scenes tab (docs/ui/design.md §6 Q9): generic form/list/empty scenes
// run on isolated fixtures and local state — they never query or write the
// signed-in user's business data. Scenes registered by examples render from
// the assembled result, so they appear and disappear with the example.

export function ScenesSection({ scenes }: { scenes: AppDefinition['scenes'] }) {
  const message = useAppMessage();
  const [formName, setFormName] = useState('');
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState('demo-a');
  const [empty, setEmpty] = useState(true);
  const listItems = [
    { id: 'demo-a', label: message('design.scenes.itemA') },
    { id: 'demo-b', label: message('design.scenes.itemB') },
    { id: 'demo-c', label: message('design.scenes.itemC') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{message('design.scenes.form')}</CardTitle>
          <CardDescription>{message('design.scenes.formHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(true);
            }}
          >
            <Field>
              <FieldLabel htmlFor="scene-form-name">
                {message('design.scenes.formName')}
              </FieldLabel>
              <Input
                id="scene-form-name"
                value={formName}
                maxLength={40}
                onChange={(event) => {
                  setFormName(event.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            <div>
              <Button type="submit">{message('design.scenes.save')}</Button>
            </div>
          </form>
          {saved ? (
            <p role="status" className="text-sm">
              {message('design.scenes.saved')}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.scenes.list')}</CardTitle>
          <CardDescription>{message('design.scenes.listHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{message('design.scenes.list')}</legend>
            {listItems.map((item) => (
              <label key={item.id} className={choiceRowClass}>
                <input
                  type="radio"
                  name="design-scene-list"
                  value={item.id}
                  checked={selected === item.id}
                  onChange={() => setSelected(item.id)}
                  className="accent-[var(--primary)]"
                />
                {item.label}
              </label>
            ))}
          </fieldset>
          <p role="status" className="text-sm text-muted-foreground">
            {message('design.scenes.selected', {
              name: listItems.find((item) => item.id === selected)?.label ?? '',
            })}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.scenes.empty')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {empty ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <InboxIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{message('design.scenes.emptyTitle')}</EmptyTitle>
                <EmptyDescription>
                  {message('design.scenes.emptyDescription')}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="list-disc pl-5 text-sm">
              {listItems.map((item) => (
                <li key={item.id}>{item.label}</li>
              ))}
            </ul>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEmpty(!empty)}
            >
              {empty
                ? message('design.scenes.fill')
                : message('design.scenes.clear')}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{message('design.scenes.business')}</CardTitle>
          <CardDescription>
            {message('design.scenes.businessHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {scenes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {message('design.scenes.businessEmpty')}
            </p>
          ) : (
            scenes.map((scene) => (
              <div
                key={`${scene.moduleId}:${scene.id}`}
                className="rounded-lg border border-border p-4"
              >
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">
                    {message(scene.titleKey)}
                  </h3>
                  <Badge variant="outline">{scene.moduleId}</Badge>
                </div>
                {scene.descriptionKey ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {message(scene.descriptionKey)}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  {message('design.scenes.fromExample', {
                    module: scene.moduleId,
                  })}
                </p>
                {scene.render ? (
                  <div className="mt-3 border-t border-border pt-3">
                    {scene.render()}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
