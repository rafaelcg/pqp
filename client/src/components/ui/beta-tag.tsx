import { cn } from "@/lib/utils";

/**
 * The little "beta" pill that rides next to the wordmark.
 *
 * "beta" is the same word in both of this product's languages, so it is not a
 * catalogue key — like "pqp" itself. The hero variant exists because the
 * landing nav sits on a photograph, where the token colours are invisible.
 */
export function BetaTag({
  variant = "default",
  className,
}: {
  variant?: "default" | "hero";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.14em]",
        variant === "hero"
          ? "border-white/35 bg-white/10 text-white/85"
          : "border-signal/30 bg-signal/10 text-signal",
        className,
      )}
    >
      beta
    </span>
  );
}
