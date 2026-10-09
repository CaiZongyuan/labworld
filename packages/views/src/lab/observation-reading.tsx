import type { ObservationProperty } from '@labos-threejs/sdk';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import type { PropertyReading } from './observation-state';

export function observationValue(property: ObservationProperty) {
  return `${String(property.value)}${property.unit ? ` ${property.unit}` : ''}`;
}
export default function ObservationReading({
  name,
  reading,
  expanded = false,
}: {
  name: string;
  reading: PropertyReading;
  expanded?: boolean;
}) {
  const { property } = reading;
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const labels: Record<string, string> = {
    temperature: 'device.actualTemperature',
    on: 'device.actualPower',
    brightness: 'device.actualBrightness',
    speed: 'task.actualRpm',
    phase: 'task.phase',
    elapsed_seconds: 'task.elapsed',
  };
  const label = labels[name] ? message(labels[name]) : name;
  const time = (value: string | null | undefined) =>
    value ? (
      <time dateTime={value} title={value}>
        {expanded ? value : new Date(value).toLocaleString(locale)}
      </time>
    ) : (
      <span>{message('device.sourceTimeUnknown')}</span>
    );
  const value =
    !reading.hasValue || !property
      ? message('world.unknown')
      : typeof property.value === 'boolean'
        ? message(property.value ? 'device.on' : 'device.off')
        : name === 'phase'
          ? message(`task.${property.value}`)
          : observationValue(property);
  const freshness =
    property?.freshness && property.freshness !== 'current'
      ? property.freshness
      : reading.reason;
  if (!expanded)
    return (
      <section
        aria-label={label}
        className="observation-reading observation-summary"
      >
        <h4>{label}</h4>
        <strong className="observation-value">{value}</strong>
        <div className="observation-status">
          {!reading.currentValid && reading.hasValue ? (
            <span>{message('device.lastReported')}</span>
          ) : null}
          {reading.reason !== 'unknown' ? (
            <span>{message(`device.freshness.${freshness}`)}</span>
          ) : null}
          {freshness !== reading.reason && reading.reason !== 'unknown' ? (
            <span>{message(`device.freshness.${reading.reason}`)}</span>
          ) : null}
          {property ? (
            <span className="observation-quality">
              {message(`device.quality.${property.quality}`)}
            </span>
          ) : null}
        </div>
        {property ? (
          <div className="observation-provenance-summary">
            <span className="observation-source">{property.source}</span>
            <span>
              {message('device.observedAt')}: {time(property.observed_at)}
            </span>
            <span>
              {message('device.receivedAt')}: {time(property.received_at)}
            </span>
          </div>
        ) : null}
      </section>
    );
  return (
    <section aria-label={label} className="observation-reading">
      <h4>{label}</h4>
      {!reading.currentValid && reading.hasValue ? (
        <p>{message('device.lastReported')}</p>
      ) : null}
      <dl className="world-properties">
        <dt>{message('device.value')}</dt>
        <dd>{value}</dd>
        {property ? (
          <>
            <dt>{message('assets.source')}</dt>
            <dd>{property.source}</dd>
            <dt>{message('device.observedAt')}</dt>
            <dd>{time(property.observed_at)}</dd>
            <dt>{message('device.receivedAt')}</dt>
            <dd>{time(property.received_at)}</dd>
            <dt>{message('device.updatedAt')}</dt>
            <dd>{time(property.updated_at)}</dd>
            <dt>Binding</dt>
            <dd>{property.binding_id}</dd>
            <dt>Run</dt>
            <dd>{property.run_id}</dd>
            <dt>{message('detail.sequence')}</dt>
            <dd>{property.sequence}</dd>
            <dt>{message('detail.expiresAt')}</dt>
            <dd>{time(property.expires_at)}</dd>
            <dt>{message('device.quality')}</dt>
            <dd>{message(`device.quality.${property.quality}`)}</dd>
          </>
        ) : null}
        {reading.reason !== 'unknown' ? (
          <>
            <dt>{message('device.freshness')}</dt>
            <dd>{message(`device.freshness.${freshness}`)}</dd>
            {property?.freshness &&
            property.freshness !== 'current' &&
            property.freshness !== reading.reason ? (
              <dd>{message(`device.freshness.${reading.reason}`)}</dd>
            ) : null}
          </>
        ) : null}
      </dl>
    </section>
  );
}
