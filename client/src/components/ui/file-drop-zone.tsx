import type { ReactNode } from "react";
import { FileDropOverlay } from "@/components/ui/file-drop-overlay";
import {
  useFileDropZone,
  type FileDropMode,
} from "@/hooks/use-file-drop-zone";
import type { DroppedItems } from "@/lib/file-drop";
import { cn } from "@/lib/utils";

/**
 * A container that takes dropped files, with the overlay already wired.
 *
 * It is a plain `div` that is `relative` so the overlay can sit inside it.
 * The hook is the real implementation (`useFileDropZone`); this is the
 * shape every surface except the thread panel's own `<aside>` wants, and it
 * keeps the hook's state out of components (like `App`) that are already too
 * large to host more of it.
 */
export function FileDropZone({
  mode,
  onDrop,
  acceptLabel,
  refuseLabel,
  size,
  className,
  children,
  ...rest
}: {
  mode: FileDropMode;
  onDrop?: (items: DroppedItems) => void;
  /** Shown while a file is over a zone that will take it. */
  acceptLabel: string;
  /** Shown while a file is over a zone that cannot, and says why. */
  refuseLabel?: string;
  size?: "pane" | "field";
  className?: string;
  children: ReactNode;
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  | "className"
  | "children"
  | "onDrop"
  | "onDragEnter"
  | "onDragOver"
  | "onDragLeave"
>) {
  const { zoneProps, active } = useFileDropZone({ mode, onDrop });
  return (
    <div className={cn("relative", className)} {...rest} {...zoneProps}>
      {active && (
        <FileDropOverlay
          size={size}
          tone={mode === "accept" ? "accept" : "refuse"}
          label={mode === "accept" ? acceptLabel : (refuseLabel ?? acceptLabel)}
        />
      )}
      {children}
    </div>
  );
}
