import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * One line of text that scrolls only when it does not fit.
 *
 * The text is drawn twice with a gap and the pair slides by half its width,
 * so the loop is seamless (`.pqp-marquee` in index.css). Overflow is
 * measured after layout and re-measured on resize; under
 * `prefers-reduced-motion` the CSS turns the animation off and the text
 * simply clips.
 *
 * The measurement is of ONE copy, never of the pair. Measuring the pair
 * latches: the moment it overflows there are two copies to measure, so the
 * answer stays yes until the box is wide enough for BOTH, and a box that
 * grows to fit one and a half shows the spare copy sitting in the open.
 */
export function MarqueeText({
  text,
  className,
  always = false,
}: {
  text: string;
  className?: string;
  /** Scroll all the time, not only while the enclosing `.group` is hovered. */
  always?: boolean;
}) {
  const clipRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const oneRef = useRef<HTMLSpanElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const inner = textRef.current;
    const one = oneRef.current;
    if (!clip || !inner || !one) {
      return;
    }
    const measure = () => setOverflows(one.scrollWidth > clip.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    observer.observe(one);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={clipRef}
      className={cn("block overflow-hidden whitespace-nowrap", className)}
      title={text}
    >
      <span
        ref={textRef}
        className={cn("inline-block", overflows && "pqp-marquee", overflows && always && "pqp-marquee-always")}
        style={
          overflows
            ? ({ "--marquee-s": `${Math.max(6, text.length / 4)}s` } as CSSProperties)
            : undefined
        }
      >
        <span ref={oneRef} data-marquee-copy="" className="inline-block">
          {text}
        </span>
        {overflows && (
          <span aria-hidden="true" className="pl-8">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}
