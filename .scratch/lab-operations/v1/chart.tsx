import { useEffect, useRef, useState } from 'react';
import type { Device } from './model';
import { clock } from './model';

export default function Trend({
  device,
  hours = 1,
  dark = false,
}: {
  device: Device;
  hours?: number;
  dark?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    time: number;
    value: number;
  } | null>(null);
  const born = useRef(Date.now());
  const samples = useRef<{ x: number; time: number; value: number | null }[]>(
    [],
  );

  useEffect(() => {
    const canvas = ref.current!;
    const context = canvas.getContext('2d')!;
    function draw() {
      const width = canvas.clientWidth,
        height = canvas.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(devicePixelRatio, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const left = 40,
        right = width - 15,
        top = 17,
        bottom = height - 32;
      const speed = device.kind === 'centrifuge';
      const low = speed ? 0 : 21,
        high = speed ? Math.max(8000, device.task?.target ?? 6000) : 26;
      const end = born.current,
        start = end - hours * 3600000;
      context.font = '11px system-ui';
      context.fillStyle = dark ? '#a0a3aa' : '#868b91';
      context.strokeStyle = dark ? '#35373a' : '#e9edef';
      context.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y = top + ((bottom - top) * i) / 4;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.textAlign = 'right';
        context.fillText(
          speed
            ? String(Math.round(high - ((high - low) * i) / 4))
            : (high - ((high - low) * i) / 4).toFixed(1),
          left - 10,
          y + 4,
        );
      }
      for (let i = 0; i < 5; i++) {
        context.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
        const time = start + (hours * 3600000 * i) / 4;
        context.fillText(
          new Date(time).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
          }),
          left + ((right - left) * i) / 4,
          height - 7,
        );
      }
      const color = speed
        ? dark
          ? '#b4acf2'
          : '#8575c5'
        : dark
          ? '#6ac7bb'
          : '#279485';
      const lastIndex = Math.min(
        99,
        Math.max(
          0,
          Math.floor(((device.updated - start) / (end - start)) * 99),
        ),
      );
      const wave = (i: number) =>
        Math.sin(i / 7) * 0.3 + Math.cos(i / 2.7) * 0.07;
      samples.current = Array.from({ length: 100 }, (_, i) => {
        const time = start + (hours * 3600000 * i) / 99;
        const missing =
          device.value === null ||
          (device.fresh !== 'current' && time > device.updated) ||
          (hours === 24 && i > 30 && i < 34);
        const value = speed
          ? Math.max(
              0,
              (device.value ?? 0) * Math.min(1, i / 18) +
                (Math.sin(i / 4) - Math.sin(lastIndex / 4)) * 40,
            )
          : (device.value ?? 23.6) + wave(i) - wave(lastIndex);
        return {
          time,
          x: left + ((right - left) * i) / 99,
          value: missing ? null : value,
        };
      });
      context.strokeStyle = color;
      context.lineWidth = 2;
      let open = false;
      context.beginPath();
      for (const point of samples.current) {
        if (point.value === null) {
          open = false;
          continue;
        }
        const y =
          bottom - ((point.value - low) / (high - low)) * (bottom - top);
        if (open) context.lineTo(point.x, y);
        else context.moveTo(point.x, y);
        open = true;
      }
      context.stroke();
      const last = samples.current.findLast((point) => point.value !== null);
      if (last) {
        const y =
          bottom - ((last.value! - low) / (high - low)) * (bottom - top);
        context.fillStyle = color;
        context.beginPath();
        context.arc(last.x, y, 3.5, 0, Math.PI * 2);
        context.fill();
      }
      if (device.fresh !== 'current' && last && last.x < right - 5) {
        context.fillStyle = dark ? '#e2b565' : '#95600c';
        context.textAlign = 'right';
        context.fillText('观测缺口', right, top + 12);
      }
    }
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [
    device.id,
    device.fresh,
    device.updated,
    device.kind,
    device.value,
    device.task?.target,
    hours,
    dark,
  ]);

  return (
    <div className="trend-canvas">
      <canvas
        ref={ref}
        role="img"
        aria-label={`${device.name}最近${hours}小时${device.kind === 'centrifuge' ? '转速' : '温度'}趋势，观测缺口不连线`}
        onPointerMove={(event) => {
          const x =
            event.clientX - event.currentTarget.getBoundingClientRect().left;
          const point = samples.current.reduce(
            (closest, p) =>
              Math.abs(p.x - x) < Math.abs(closest.x - x) ? p : closest,
            samples.current[0],
          );
          setHover(
            point?.value !== null && point
              ? { x: point.x, value: point.value, time: point.time }
              : null,
          );
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hover ? (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(
              Math.max(hover.x, 72),
              (ref.current?.clientWidth ?? 300) - 72,
            ),
          }}
        >
          <small>{clock(hover.time)}</small>
          <strong>
            {hover.value.toFixed(device.kind === 'sensor' ? 1 : 0)}{' '}
            {device.kind === 'sensor' ? '°C' : 'rpm'}
          </strong>
        </div>
      ) : null}
    </div>
  );
}
