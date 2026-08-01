import type { Gif } from "@pqp/shared";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

/**
 * Lazy for the same reason the emoji picker is: most sessions never open it,
 * and none of this belongs in the chunk that has to load before the first
 * message can be read.
 */
const LazyPanel = lazy(() =>
  import("./gif-picker-panel").then((module) => ({
    default: module.GifPickerPanel,
  })),
);

interface GifPickerPanelProps {
  onSelect: (gif: Gif) => void;
  onClose: () => void;
  className?: string;
}

export function GifPickerPanel(props: GifPickerPanelProps) {
  return (
    <Suspense
      fallback={
        <div
          className={cn(
            "z-50 h-[22rem] w-[21rem] animate-pulse rounded-lg border border-border bg-surface-1 shadow-lg",
            props.className,
          )}
        />
      }
    >
      <LazyPanel {...props} />
    </Suspense>
  );
}
