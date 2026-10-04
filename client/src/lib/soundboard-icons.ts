import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Bug,
  Drum,
  Hand,
  Laugh,
  Music2,
  Siren,
  Wine,
} from "lucide-react";

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  "builtin:palmas": Hand,
  "builtin:risada": Laugh,
  "builtin:buzina": Siren,
  "builtin:grilo": Bug,
  "builtin:vidro": Wine,
  "builtin:ba-dum-tss": Drum,
  "builtin:trombone": Music2,
};

export function soundboardIcon(soundId: string): LucideIcon {
  return BUILTIN_ICONS[soundId] ?? AudioLines;
}
