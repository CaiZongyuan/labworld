import type { ObservationProperty } from '@labos-threejs/sdk';
import { useAppMessage } from '../shell/messages';

export function observationValue(property: ObservationProperty) {
  return `${String(property.value)}${property.unit ? ` ${property.unit}` : ''}`;
}
export default function ObservationReading({
  name,
  property,
}: {
  name: string;
  property: ObservationProperty;
}) {
  const message = useAppMessage('lab');
  const labels: Record<string, string> = {
    temperature: 'device.actualTemperature',
    on: 'device.actualPower',
    brightness: 'device.actualBrightness',
  };
  const label = labels[name] ? message(labels[name]) : name;
  const time = (value: string | null | undefined) =>
    value ? (
      <time dateTime={value}>{new Date(value).toLocaleString()}</time>
    ) : (
      message('device.sourceTimeUnknown')
    );
  return (
    <section aria-label={label} className="observation-reading">
      <h4>{label}</h4>
      <dl className="world-properties">
        <dt>{message('device.value')}</dt>
        <dd>
          {typeof property.value === 'boolean'
            ? message(property.value ? 'device.on' : 'device.off')
            : observationValue(property)}
        </dd>
        <dt>{message('assets.source')}</dt>
        <dd>{property.source}</dd>
        <dt>{message('device.observedAt')}</dt>
        <dd>{time(property.observed_at)}</dd>
        <dt>{message('device.receivedAt')}</dt>
        <dd>{time(property.received_at)}</dd>
        <dt>{message('device.updatedAt')}</dt>
        <dd>{time(property.updated_at)}</dd>
        <dt>{message('device.quality')}</dt>
        <dd>{message(`device.quality.${property.quality}`)}</dd>
        <dt>{message('device.freshness')}</dt>
        <dd>{message(`device.freshness.${property.freshness}`)}</dd>
      </dl>
    </section>
  );
}
