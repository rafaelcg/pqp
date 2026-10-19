import { readFile } from "node:fs/promises";
import { BOT_BASE_FACES, BOT_COLORS } from "@pqp/shared";

/**
 * The bot face PNGs, read from `assets/bot-faces/<color>/<face>.png` beside
 * this file's directory (`src/assets` in development, `dist/assets` once
 * built). Rendered by `tools/bot-faces/render.mts`. Thirty small files, kept
 * in memory after the first read.
 */

const ASSETS = new URL("../assets/bot-faces/", import.meta.url);
const cache = new Map<string, Buffer>();

export async function readBotFacePng(color: string, face: string): Promise<Buffer | null> {
  if (
    !(BOT_COLORS as readonly string[]).includes(color) ||
    !(BOT_BASE_FACES as readonly string[]).includes(face)
  ) {
    return null;
  }
  const key = `${color}/${face}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }
  try {
    const png = await readFile(new URL(`${key}.png`, ASSETS));
    cache.set(key, png);
    return png;
  } catch {
    return null;
  }
}
