import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** How long a closing `Reveal` stays mounted: the `chat-reveal-out` animation. */
const EXIT_MS = 200;

/**
 * Something that comes and goes under the conversation (typing, a bot at
 * work, a notice), opening and closing its own height instead of popping in
 * and pushing everything above it. On close it keeps showing what it showed
 * last while it shrinks away, then unmounts. With reduced motion it is
 * simply there or not. CSS: `.chat-reveal` in `index.css`.
 */
export function Reveal({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  const last = useRef<ReactNode>(children);
  if (show) {
    last.current = children;
  }
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show && !mounted) {
    return null;
  }
  return (
    <div className={cn("chat-reveal shrink-0", className)} data-state={show ? "open" : "closed"} aria-hidden={show ? undefined : true}>
      <div>{show ? children : last.current}</div>
    </div>
  );
}
