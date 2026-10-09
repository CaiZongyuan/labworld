import { Avatar, Style } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json';
import marbles from '@dicebear/styles/marbles.json';
import voxelBot from '@dicebear/styles/voxel-bot.json';
import glass from '@dicebear/styles/glass.json';
import type { GeneratedGraphic } from './graphic-choice';

const definitions = { lorelei, marbles, 'voxel-bot': voxelBot, glass };
const styles = new Map<GeneratedGraphic['style'], Style>();
const images = new Map<string, string>();

export default function DiceBearImage({
  choice,
  name,
  onError,
}: {
  choice: GeneratedGraphic;
  name: string;
  onError: () => void;
}) {
  const key = JSON.stringify(choice);
  let source = images.get(key);
  if (!source) {
    let style = styles.get(choice.style);
    if (!style) {
      style = new Style(definitions[choice.style]);
      styles.set(choice.style, style);
    }
    source = new Avatar(style, {
      seed: choice.seed,
      size: 128,
      idRandomization: false,
      ...(choice.style === 'glass' || choice.style === 'voxel-bot'
        ? { animationVariant: 'none' }
        : {}),
      ...(choice.background
        ? { backgroundColor: [`#${choice.background}`] }
        : {}),
    }).toDataUri();
    if (images.size >= 256) images.delete(images.keys().next().value!);
    images.set(key, source);
  }
  return <img src={source} alt={name} onError={onError} />;
}
