import type { ComponentType, ReactNode } from 'react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Tabs, TabsList, TabsTrigger } from '@labos-threejs/ui/components/tabs';
import centrifugeImage from '../../../packages/views/src/lab/images/centrifuge.png';
import sensorImage from '../../../packages/views/src/lab/images/sensor.png';
import lightImage from '../../../packages/views/src/lab/images/light.png';
import type { Device } from './model';
import { attention, taskActive, taskNames } from './model';

export const images = {
  centrifuge: centrifugeImage,
  sensor: sensorImage,
  light: lightImage,
};

export function Tool({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ComponentType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="tool-with-tip">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        <Icon />
      </Button>
      <span className="tool-tip" role="tooltip">
        {label}
      </span>
    </span>
  );
}

export function Segments({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  items: { value: string; label: ReactNode }[];
  label: string;
}) {
  return (
    <Tabs value={value} onValueChange={onChange}>
      <TabsList aria-label={label}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function DeviceStatus({ device }: { device: Device }) {
  const issue = attention(device);
  if (issue)
    return (
      <Badge variant={issue.tone === 'danger' ? 'destructive' : 'warning'}>
        {device.run === 'interrupted' ? '已中断' : '观测过期'}
      </Badge>
    );
  if (device.run === 'unbound')
    return <Badge variant="outline">尚未接入</Badge>;
  if (device.run === 'stopped')
    return <Badge variant="secondary">正常停止</Badge>;
  if (taskActive(device))
    return <Badge variant="info">{taskNames[device.task!.status]}</Badge>;
  if (device.kind === 'sensor')
    return <Badge variant="success">持续采样</Badge>;
  if (device.kind === 'light')
    return (
      <Badge variant={device.on ? 'success' : 'secondary'}>
        {device.on ? '已开启' : '已关闭'}
      </Badge>
    );
  return <Badge variant="success">空闲</Badge>;
}

export function Thumbnail({
  device,
  large = false,
}: {
  device: Device;
  large?: boolean;
}) {
  return (
    <img
      className={large ? 'device-image large' : 'device-image'}
      src={images[device.kind]}
      alt={
        device.kind === 'sensor'
          ? '温度传感器示意模型'
          : device.kind === 'centrifuge'
            ? '离心机示意模型'
            : '照明示意模型'
      }
    />
  );
}
