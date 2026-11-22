import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The one-row composer on a phone, under the redesign: the +, the field,
 * emoji, and Send only when there is something to send. Formatting moves
 * into the + menu. The old look and the desktop row keep every button.
 */
const state = vi.hoisted(() => ({ redesign: false, phone: false, draft: "" }));

vi.mock("@/lib/redesign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/redesign")>()),
  useRedesign: () => state.redesign,
  isRedesignOn: () => state.redesign,
}));
vi.mock("@/components/ui/use-media-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/use-media-query")>()),
  useMediaQuery: () => state.phone,
}));
vi.mock("@/lib/composer-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composer-drafts")>()),
  readDraft: () => state.draft,
}));

const { MessageComposer } = await import("./message-composer");

function render() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MessageComposer onSend={() => {}} channelId="11111111-1111-4111-8111-111111111111" />
    </TooltipProvider>,
  );
}

const hasSubmit = (html: string) => /<button[^>]*type="submit"/.test(html);
const hasFormatToggle = (html: string) => /<button[^>]*aria-pressed="(true|false)"/.test(html);
const hasEmoji = (html: string) => html.includes("data-composer-emoji");

beforeEach(() => {
  state.redesign = false;
  state.phone = false;
  state.draft = "";
});

describe("composer row on a phone", () => {
  it("under the redesign: no Formatting button, emoji stays, Send only with a draft", () => {
    state.redesign = true;
    state.phone = true;
    const empty = render();
    expect(hasFormatToggle(empty)).toBe(false);
    expect(hasEmoji(empty)).toBe(true);
    expect(hasSubmit(empty)).toBe(false);

    state.draft = "oi";
    const typed = render();
    expect(hasSubmit(typed)).toBe(true);
    expect(typed).toMatch(/<button[^>]*after:-inset-1[^>]*type="submit"/);
  });

  it("under the redesign on desktop: the row is unchanged", () => {
    state.redesign = true;
    const html = render();
    expect(hasFormatToggle(html)).toBe(true);
    expect(hasSubmit(html)).toBe(true);
    expect(html).not.toContain("after:-inset-1");
  });

  it("in the old look on a phone: every button is drawn", () => {
    state.phone = true;
    const html = render();
    expect(hasFormatToggle(html)).toBe(true);
    expect(hasSubmit(html)).toBe(true);
    expect(html).not.toContain("after:-inset-1");
  });

  it("under the redesign the field follows the chat size, floored at 16px where iOS zooms", () => {
    state.redesign = true;
    state.phone = true;
    expect(render()).toContain("font-size:max(16px, var(--chat-font-size))");
    state.phone = false;
    expect(render()).toContain("font-size:var(--chat-font-size)");
    state.redesign = false;
    expect(render()).not.toContain("var(--chat-font-size))");
  });
});
