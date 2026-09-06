import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ListenerStrip, type StripListener } from "./listener-strip";

/**
 * The row under the stage, rendered.
 *
 * `stage-layout.test.ts` pins who lands here; this pins what a person sees:
 * names and states rather than video boxes, one chip for the tail, and nothing
 * at all in a room where everybody is publishing.
 */

function listener(
  key: string,
  overrides: Partial<StripListener> = {},
): StripListener {
  return {
    key,
    name: key,
    avatarUrl: null,
    speaking: false,
    muted: false,
    serverMuted: false,
    isSelf: false,
    ...overrides,
  };
}

function render(people: StripListener[], limit = 12, open = true) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ListenerStrip
        people={people}
        limit={limit}
        open={open}
        onToggle={() => {}}
        youLabel="(you)"
      />
    </TooltipProvider>,
  );
}

describe("ListenerStrip", () => {
  it("renders nothing when everybody is on the stage", () => {
    expect(render([])).toBe("");
  });

  it("draws a name per listener and no video at all", () => {
    const html = render([listener("Ana"), listener("Bia")]);
    expect(html).toContain('data-call-listener="Ana"');
    expect(html).toContain('data-call-listener="Bia"');
    // The whole point: a listener costs a chip, never a decoder.
    expect(html).not.toContain("<video");
  });

  it("marks us, so a person can find themselves in the room", () => {
    const html = render([listener("Ana", { isSelf: true })]);
    expect(html).toContain("(you)");
  });

  it("says who is muted, and says a moderator mute differently", () => {
    const html = render([
      listener("Ana", { muted: true }),
      listener("Bia", { serverMuted: true }),
    ]);
    expect(html).toContain('aria-label="Microphone muted"');
    expect(html).toContain('aria-label="A moderator muted Bia"');
  });

  it("counts the tail into one chip instead of a long row", () => {
    const html = render(
      Array.from({ length: 200 }, (_, i) => listener(`p${i}`)),
    );
    expect(html).toContain("+188");
    expect(html).toContain('aria-label="188 more listening"');
    // Twelve chips and the counter, not two hundred chips.
    expect(html.match(/data-call-listener=/g)).toHaveLength(12);
  });

  it("keeps the headcount reachable while the row is hidden", () => {
    const html = render([listener("Ana"), listener("Bia")], 12, false);
    expect(html).toContain('data-open="false"');
    expect(html).toContain("Show participants");
    expect(html).not.toContain('data-call-listener="Ana"');
  });
});
