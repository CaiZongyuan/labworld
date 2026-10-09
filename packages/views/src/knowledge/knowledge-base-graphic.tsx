import { EntityGraphic } from '../shell/entity-graphic';
import { GraphicPicker } from '../shell/graphic-picker';
import { useGraphicPreference } from '../shell/graphic-preferences';
import { useAppMessage } from '../shell/messages';

export function KnowledgeBaseGraphic({
  userId,
  baseId,
  name,
  editable = false,
  small = false,
}: {
  userId?: string;
  baseId: string;
  name: string;
  editable?: boolean;
  small?: boolean;
}) {
  const message = useAppMessage('knowledge');
  const entity = `knowledge:base:${baseId}`;
  const [choice, setChoice] = useGraphicPreference(
    userId,
    entity,
    'collection',
  );
  return editable && userId ? (
    <GraphicPicker
      iconOnly
      kind="collection"
      choice={choice}
      name={name}
      seed={`collection:${entity}`}
      label={message('bases.changeIcon', { name })}
      onChange={setChoice}
    />
  ) : (
    <EntityGraphic
      choice={choice}
      name={name}
      size={small ? 'small' : 'default'}
    />
  );
}
