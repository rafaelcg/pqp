/**
 * Sourced chance art. Coins and d6 faces are public-domain SVGs.
 * Playing cards are Byron Knoll's public-domain deck, rasterized for size.
 * Polyhedral silhouettes are ivory shapes so the rolled face can sit on top.
 *
 * Cards: Byron Knoll, public domain.
 *   https://github.com/notpeter/Vector-Playing-Cards
 * d6: Firkin, OpenClipArt, 2017, public domain.
 *   https://openclipart.org/detail/282127/die-1 (through die-6)
 * d20 body: notKlaatu, OpenClipArt, 2017, public domain.
 *   https://openclipart.org/detail/285672/d20-blank
 */
import d4Url from "@/assets/chance/dice/d4.svg?url";
import d6_1 from "@/assets/chance/dice/d6-1.svg?url";
import d6_2 from "@/assets/chance/dice/d6-2.svg?url";
import d6_3 from "@/assets/chance/dice/d6-3.svg?url";
import d6_4 from "@/assets/chance/dice/d6-4.svg?url";
import d6_5 from "@/assets/chance/dice/d6-5.svg?url";
import d6_6 from "@/assets/chance/dice/d6-6.svg?url";
import d8Url from "@/assets/chance/dice/d8.svg?url";
import d10Url from "@/assets/chance/dice/d10.svg?url";
import d12Url from "@/assets/chance/dice/d12.svg?url";
import d20Url from "@/assets/chance/dice/d20.svg?url";
import d100Url from "@/assets/chance/dice/d100.svg?url";

const D6_FACES = [d6_1, d6_2, d6_3, d6_4, d6_5, d6_6] as const;

const POLYHEDRAL: Record<number, string> = {
  4: d4Url,
  8: d8Url,
  10: d10Url,
  12: d12Url,
  20: d20Url,
  100: d100Url,
};

const CARD_ART = import.meta.glob("../assets/chance/cards/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export function d6FaceUrl(value: number): string | undefined {
  if (value < 1 || value > 6) {
    return undefined;
  }
  return D6_FACES[value - 1];
}

export function polyhedralDieUrl(sides: number): string | undefined {
  return POLYHEDRAL[sides];
}

export function playingCardUrl(code: string): string | undefined {
  const suffix = `/${code}.png`;
  for (const [path, url] of Object.entries(CARD_ART)) {
    if (path.endsWith(suffix)) {
      return url;
    }
  }
  return undefined;
}
