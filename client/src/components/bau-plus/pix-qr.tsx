import { useMemo } from "react";
import { encode } from "uqr";
import { cn } from "@/lib/utils";

/**
 * A Pix QR, drawn from the copia e cola itself (the QR encodes exactly that
 * text, so no provider image is needed and every provider looks the same).
 *
 * One SVG path, so it stays crisp at any size and on any screen. ALWAYS dark on
 * white, whatever the theme: a bank app's scanner wants the contrast it was
 * built for, and an inverted QR fails on some of them. Medium error correction,
 * with the four-module quiet zone the spec asks for inside the white plate.
 */
export function PixQr({
  code,
  label,
  className,
  dimmed = false,
}: {
  code: string;
  /** The image's accessible name: what it is and how much. */
  label: string;
  className?: string;
  /** An expired code: still drawn (so the screen does not jump), not scannable-looking. */
  dimmed?: boolean;
}) {
  const { path, size } = useMemo(() => {
    const qr = encode(code, { ecc: "M", border: 0 });
    const n = qr.data.length;
    let d = "";
    for (let y = 0; y < n; y += 1) {
      const row = qr.data[y]!;
      let x = 0;
      while (x < n) {
        if (!row[x]) {
          x += 1;
          continue;
        }
        let run = 1;
        while (x + run < n && row[x + run]) {
          run += 1;
        }
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run;
      }
    }
    return { path: d, size: n };
  }, [code]);

  const quiet = 4;
  const box = size + quiet * 2;
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-white p-1 text-black ring-1 ring-black/10 transition-opacity duration-[var(--duration-base)]",
        dimmed && "opacity-25",
        className,
      )}
      data-bau-qr
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
        shapeRendering="crispEdges"
        className="block h-full w-full"
      >
        <path d={path} fill="currentColor" />
      </svg>
    </div>
  );
}
