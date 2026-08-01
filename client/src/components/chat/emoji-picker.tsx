import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

/**
 * `@emoji-mart/data` is ~80 KB gzipped of pure data. Loading it lazily keeps it
 * out of the initial bundle for the (many) sessions that never open the picker.
 */
const LazyPanel = lazy(() =>
  import("./emoji-picker-panel").then((module) => ({
    default: module.EmojiPickerPanel,
  })),
);

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
  className?: string;
}

export function EmojiPickerPanel(props: EmojiPickerPanelProps) {
  return (
    <Suspense
      fallback={
        <div
          className={cn(
            "z-50 h-[22rem] w-[21rem] animate-pulse rounded-lg border border-ink-4 bg-ink-2 shadow-lg",
            props.className,
          )}
        />
      }
    >
      <LazyPanel {...props} />
    </Suspense>
  );
}
