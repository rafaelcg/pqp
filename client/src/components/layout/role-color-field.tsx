import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { cssColorToRgb, rgbToHex } from "@/lib/oklch";
import {
  FALLBACK_HSV,
  ROLE_COLOR_PRESETS,
  hexToHsv,
  hsvToHex,
  hueTrackGradient,
  hsvFromPointer,
  parseHexColor,
  sameHex,
  type Hsv,
} from "@/lib/role-color";
import { useTranslation } from "@/lib/i18n";

/** Hidden `input[type=color]` still needs a six-digit hex. Read the accent, never a literal. */
function pickerFace(color: string | null): string {
  if (color) {
    return color;
  }
  const raw =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue("--color-accent")
          .trim();
  return rgbToHex(cssColorToRgb(raw, { l: 0.88, c: 0.19, h: 125 }));
}

function hsvFor(color: string | null, previous: Hsv): Hsv {
  if (!color) {
    return {
      ...previous,
      s: previous.s || FALLBACK_HSV.s,
      v: previous.v || FALLBACK_HSV.v,
    };
  }
  const next = hexToHsv(color);
  if (!next) {
    return previous;
  }
  if (next.s === 0) {
    return { ...next, h: previous.h };
  }
  return next;
}

export function RoleColorField({
  color,
  defaultColor,
  onChange,
}: {
  color: string | null;
  defaultColor: string | null;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslation();
  const [hex, setHex] = useState(color ?? "");
  const [hsv, setHsv] = useState<Hsv>(() => hsvFor(color, FALLBACK_HSV));

  useEffect(() => {
    setHex(color ?? "");
    setHsv((current) => hsvFor(color, current));
  }, [color]);

  const extras =
    color && !ROLE_COLOR_PRESETS.some((preset) => sameHex(preset, color))
      ? [color]
      : [];
  const atDefault = Boolean(
    defaultColor && color && sameHex(color, defaultColor),
  );
  const canReset = Boolean(defaultColor);
  const hueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const thumbHex = hsvToHex(hsv);

  function commitHsv(next: Hsv) {
    setHsv(next);
    const value = hsvToHex(next);
    setHex(value);
    onChange(value);
  }

  function commitHex(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const next = parseHexColor(trimmed);
    if (next) {
      onChange(next);
      setHex(next);
      setHsv((current) => hsvFor(next, current));
      return;
    }
    setHex(color ?? "");
  }

  function onPlanePointer(
    event: React.PointerEvent<HTMLDivElement>,
    capture: boolean,
  ) {
    if (event.buttons !== 1 && event.type !== "pointerdown") {
      return;
    }
    if (event.type === "pointerdown" && event.button !== 0) {
      return;
    }
    if (capture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window listeners are not needed; capture is best-effort.
      }
    }
    commitHsv(
      hsvFromPointer(
        hsv,
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      ),
    );
  }

  return (
    <div className="relative space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-paper">{t("roles.color")}</span>
        <span className="flex flex-wrap items-center justify-end gap-3">
          {canReset && defaultColor && (
            <button
              type="button"
              disabled={atDefault}
              className="text-sm text-signal hover:underline disabled:cursor-default disabled:text-paper-muted disabled:no-underline disabled:opacity-60"
              onClick={() => {
                setHex(defaultColor);
                onChange(defaultColor);
              }}
            >
              {t("roles.colorReset")}
            </button>
          )}
          {color && (
            <button
              type="button"
              className="text-sm text-paper-muted hover:text-paper hover:underline"
              onClick={() => {
                setHex("");
                onChange(null);
              }}
            >
              {t("roles.colorClear")}
            </button>
          )}
        </span>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t("roles.colorPicker")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`${Math.round(hsv.s * 100)}, ${Math.round(hsv.v * 100)}`}
        onPointerDown={(event) => onPlanePointer(event, true)}
        onPointerMove={(event) => onPlanePointer(event, false)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.08 : 0.03;
          let next = hsv;
          if (event.key === "ArrowRight") {
            next = { ...hsv, s: Math.min(1, hsv.s + step) };
          } else if (event.key === "ArrowLeft") {
            next = { ...hsv, s: Math.max(0, hsv.s - step) };
          } else if (event.key === "ArrowUp") {
            next = { ...hsv, v: Math.min(1, hsv.v + step) };
          } else if (event.key === "ArrowDown") {
            next = { ...hsv, v: Math.max(0, hsv.v - step) };
          } else {
            return;
          }
          event.preventDefault();
          commitHsv(next);
        }}
        className="relative h-36 w-full cursor-crosshair touch-none overflow-hidden rounded-xl ring-1 ring-ink-4"
        style={{
          backgroundImage: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, ${hueHex})`,
        }}
      >
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-paper"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: thumbHex,
          }}
          aria-hidden
        />
      </div>

      <input
        type="range"
        min={0}
        max={360}
        value={Math.round(hsv.h)}
        aria-label={t("roles.colorHue")}
        onChange={(event) =>
          commitHsv({ ...hsv, h: Number(event.target.value) })
        }
        className="role-hue-slider"
        style={
          {
            "--role-hue-track": hueTrackGradient(),
            "--role-hue-thumb": hueHex,
          } as React.CSSProperties
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {[...ROLE_COLOR_PRESETS, ...extras].map((preset) => {
          const selected = Boolean(color && sameHex(preset, color));
          return (
            <button
              key={preset}
              type="button"
              aria-label={`${t("roles.color")} ${preset}`}
              aria-pressed={selected}
              onClick={() => {
                setHex(preset);
                onChange(preset);
              }}
              className={cn(
                "h-7 w-7 shrink-0 appearance-none rounded-full border-0 p-0 ring-1 ring-ink-4",
                selected && "ring-2 ring-paper",
              )}
              style={{ backgroundColor: preset }}
            />
          );
        })}
        <Input
          value={hex}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={7}
          placeholder="#RRGGBB"
          aria-label={t("roles.color")}
          onChange={(event) => setHex(event.target.value)}
          onBlur={() => commitHex(hex)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitHex(hex);
            }
          }}
          className="h-8 w-[6.75rem] border-0 bg-ink px-2 font-mono text-xs"
        />
      </div>
      {/* E2E sets this; do not let a click open the system colour panel. */}
      <input
        type="color"
        tabIndex={-1}
        aria-hidden
        value={pickerFace(color)}
        onChange={(event) => onChange(event.target.value)}
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
    </div>
  );
}
