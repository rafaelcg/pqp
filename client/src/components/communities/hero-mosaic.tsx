import { useId } from "react";
import { heroTintStyle } from "@/lib/hero-tint";

/**
 * The default community cover: a tiled pqp.gg mosaic over the hashed hue wash.
 *
 * WHY THIS EXISTS. Most communities never upload a banner. A flat gradient
 * reads as "nothing here yet". Repeating the wordmark as a brick of tiles is
 * the same job a brand wallpaper does on a Patreon or YouTube channel that
 * has not set art: it is obviously ours, and the hue underneath still lets
 * two communities sit apart.
 *
 * COLOUR STAYS IN THE TOKEN LAYER. Tiles and letters read `--hero-mosaic-*`.
 * The wash is still `heroTintStyle`. This file never names a colour.
 *
 * An uploaded cover replaces the whole thing. The icon's initials field is
 * a different surface and keeps the plain tint.
 */

const TILES: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  size: number;
}[] = [
  { x: 4, y: 4, w: 168, h: 48, label: "pqp.gg", size: 20 },
  { x: 180, y: 4, w: 64, h: 48, label: "p", size: 26 },
  { x: 252, y: 4, w: 64, h: 48, label: "q", size: 26 },
  { x: 4, y: 60, w: 64, h: 48, label: "p", size: 26 },
  { x: 76, y: 60, w: 64, h: 48, label: "q", size: 26 },
  { x: 148, y: 60, w: 168, h: 48, label: "pqp.gg", size: 20 },
];

const PATTERN_W = 324;
const PATTERN_H = 116;

export function HeroMosaic({ hue }: { hue: number }) {
  const patternId = `hero-mosaic-${useId().replace(/:/g, "")}`;
  const tilt = -8 - (hue % 9);
  const shiftX = hue % 56;
  const shiftY = (hue * 2) % 40;

  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden"
      data-hero-mosaic
      style={heroTintStyle(hue, 45)}
    >
      <svg
        className="pointer-events-none absolute -inset-[30%] h-[160%] w-[160%]"
      >
        <defs>
          <pattern
            id={patternId}
            width={PATTERN_W}
            height={PATTERN_H}
            patternUnits="userSpaceOnUse"
            patternTransform={`rotate(${tilt}) translate(${shiftX} ${shiftY})`}
          >
            {TILES.map((tile) => (
              <g key={`${tile.x}-${tile.y}-${tile.label}`}>
                <rect
                  className="hero-mosaic-tile"
                  x={tile.x}
                  y={tile.y}
                  width={tile.w}
                  height={tile.h}
                />
                <text
                  className="hero-mosaic-mark"
                  x={tile.x + tile.w / 2}
                  y={tile.y + tile.h / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={tile.size}
                  letterSpacing={tile.label.length > 1 ? "0.04em" : undefined}
                >
                  {tile.label}
                </text>
              </g>
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
}
