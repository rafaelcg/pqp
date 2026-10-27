import type { Gif } from "@pqp/shared";
import { lazy, Suspense } from "react";
import { ContainedChunkBoundary } from "@/components/error-boundary";
import { cn } from "@/lib/utils";
import { POPOVER_SURFACE } from "@/components/ui/popover";

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
  initialQuery?: string;
}

export function GifPickerPanel(props: GifPickerPanelProps) {
  return (
    // A stale chunk costs this panel and nothing else (`ContainedChunkBoundary`).
    <ContainedChunkBoundary>
      <Suspense
        fallback={
          <div
            className={cn(
              POPOVER_SURFACE,
              "z-50 h-[22rem] w-[21rem] animate-pulse",
              props.className,
            )}
          />
        }
      >
        <LazyPanel {...props} />
      </Suspense>
    </ContainedChunkBoundary>
  );
}
