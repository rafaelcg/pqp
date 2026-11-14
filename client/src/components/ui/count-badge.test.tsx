import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CountBadge } from "@/components/ui/count-badge";

describe("CountBadge", () => {
  it("draws nothing for zero", () => {
    expect(renderToStaticMarkup(<CountBadge count={0} />)).toBe("");
  });

  it("caps at 99+", () => {
    expect(renderToStaticMarkup(<CountBadge count={140} />)).toContain(">99+<");
  });

  it("is the 18px danger pill the lists drew by hand, with the toggle off", () => {
    const html = renderToStaticMarkup(<CountBadge count={3} pop />);
    for (const c of [
      "inline-flex",
      "h-[18px]",
      "min-w-[18px]",
      "animate-badge-pop",
      "rounded-full",
      "bg-danger",
      "px-1",
      "text-[10px]",
      "font-bold",
      "leading-none",
      "tabular-nums",
      "text-on-danger",
    ]) {
      expect(html).toContain(c);
    }
  });

  it("has a 16px size and an accent tone, and passes attributes through", () => {
    const html = renderToStaticMarkup(
      <CountBadge count={2} size="sm" tone="accent" data-friend-requests={2} aria-hidden="true" />,
    );
    expect(html).toContain("h-4 min-w-4");
    expect(html).toContain("bg-accent text-on-accent");
    expect(html).toContain('data-friend-requests="2"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("animate-badge-pop");
  });
});
