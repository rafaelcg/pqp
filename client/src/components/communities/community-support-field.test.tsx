// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityOfficialLinks } from "./community-official-links";
import { CommunitySupportField, supportDraftOf } from "./community-support-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
});

describe("supportDraftOf", () => {
  it("is the page or the Pix text as the owner typed it", () => {
    expect(supportDraftOf({ url: "https://livepix.gg/rafa" })).toBe(
      "https://livepix.gg/rafa",
    );
    expect(supportDraftOf({ pix: "rafa@pqp.gg" })).toBe("rafa@pqp.gg");
    expect(supportDraftOf(null)).toBe("");
  });
});

describe("CommunitySupportField", () => {
  it("says nothing while empty, complains after blur, and clears when fixed", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    function Harness({ value }: { value: string }) {
      return <CommunitySupportField value={value} onChange={() => {}} />;
    }
    await act(async () => root!.render(<Harness value="https://example.com/x" />));
    // A half-typed value is not an error until the box loses focus.
    expect(host.querySelector("[data-support-error]")).toBeNull();
    const input = host.querySelector<HTMLInputElement>("[data-support-input]")!;
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const error = host.querySelector("[data-support-error]");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error!.id);
    await act(async () => root!.render(<Harness value="https://apoia.se/rafa" />));
    expect(host.querySelector("[data-support-error]")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("support in the official links chips", () => {
  it("draws a support page as an anchor labelled Support", () => {
    const html = renderToStaticMarkup(
      <CommunityOfficialLinks
        links={[{ kind: "support", url: "https://livepix.gg/rafa" }]}
      />,
    );
    expect(html).toContain('href="https://livepix.gg/rafa"');
    expect(html).toContain("Support");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("draws Pix text as a copy button, never an anchor", () => {
    const html = renderToStaticMarkup(
      <CommunityOfficialLinks
        links={[{ kind: "support", pix: "rafa@pqp.gg" }]}
      />,
    );
    expect(html).toContain("data-community-pix");
    expect(html).toContain("Copy Pix");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("rafa@pqp.gg");
  });

  it("skips a link this build cannot draw instead of an empty chip", () => {
    const html = renderToStaticMarkup(
      <CommunityOfficialLinks links={[{ kind: "support" }]} />,
    );
    expect(html).toBe("");
  });
});
