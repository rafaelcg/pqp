// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForumPostSummary, ForumPostViewer } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  readDraft,
  resetComposerDraftsForTests,
  setDraftsAccount,
  writeDraft,
} from "@/lib/composer-drafts";

/**
 * The body of a published post must not come back as the next post's draft.
 *
 * The body is the embedded chat composer's own draft, and that composer
 * writes it one last time from its unmount cleanup. The dialog used to clear
 * it on a zero timer after publishing, which only works when the dialog
 * closes before the timer fires. Opening the new post navigates, so the close
 * can land later than that; the composer's last write then won and "Novo
 * post" reopened with the old body in it. Found in the pre-launch QA pass.
 */

const FORUM_ID = "11111111-1111-4111-8111-111111111111";

const POST = {
  id: "22222222-2222-4222-8222-222222222222",
  forumId: FORUM_ID,
  title: "Microfone some",
} as unknown as ForumPostSummary;
const VIEWER = {
  postId: POST.id,
  lastReadAt: null,
  newReplyCount: 0,
  following: true,
} as ForumPostViewer;

vi.mock("@/lib/forum-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/forum-api")>();
  return {
    ...actual,
    createForumPost: vi.fn(() => Promise.resolve({ post: POST, viewer: VIEWER })),
    fetchSimilarForumPosts: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return {
    ...actual,
    loadAttachmentConfig: () => Promise.resolve({ enabled: false, maxBytes: 0 }),
  };
});

import { ForumComposerDialog, highlightTitleParts } from "./forum-composer-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  resetComposerDraftsForTests();
  setDraftsAccount("00000000-0000-4000-8000-0000000000aa");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

/** The pane's shape: it owns `open`, and closes later than the publish resolves. */
function Harness({
  closeDelayMs,
  discardOnly,
  unmount,
}: {
  closeDelayMs: number;
  discardOnly?: boolean;
  /** The pane goes away instead of closing the dialog. */
  unmount?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [mounted, setMounted] = useState(true);
  if (!mounted) {
    return null;
  }
  return (
    <TooltipProvider>
      <ForumComposerDialog
        open={open}
        forumId={FORUM_ID}
        forumName="ajuda"
        serverId={null}
        tags={[]}
        requireTag={false}
        isStaff={false}
        mentionCandidates={[]}
        onClose={() => {
          if (discardOnly) {
            window.setTimeout(() => setOpen(false), closeDelayMs);
          } else {
            setOpen(false);
          }
        }}
        onPublished={() => {
          window.setTimeout(() => (unmount ? setMounted(false) : setOpen(false)), closeDelayMs);
        }}
        onOpenPost={() => {}}
      />
    </TooltipProvider>
  );
}

async function mount(closeDelayMs: number, discardOnly = false, unmount = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Harness closeDelayMs={closeDelayMs} discardOnly={discardOnly} unmount={unmount} />,
    );
  });
}

function setTitle(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) {
    throw new Error("no title field");
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((one) =>
    one.textContent?.includes(label),
  );
  if (!found) {
    throw new Error(`no button ${label}`);
  }
  return found as HTMLButtonElement;
}

async function settle(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("forum composer body draft", () => {
  it("does not hand a published post's body to the next Novo post", async () => {
    writeDraft(FORUM_ID, "Do nada o microfone para de mandar áudio.");
    await mount(40);
    expect(document.querySelector("textarea")?.value).toBe(
      "Do nada o microfone para de mandar áudio.",
    );
    await act(async () => setTitle("Microfone some"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-publish-placement="footer"]')!.click(),
    );
    await settle(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readDraft(FORUM_ID)).toBe("");
  });

  it("clears the body too when the dialog unmounts instead of closing", async () => {
    writeDraft(FORUM_ID, "Corpo publicado e depois a tela trocou.");
    await mount(40, false, true);
    await act(async () => setTitle("Microfone some"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-publish-placement="footer"]')!.click(),
    );
    await settle(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readDraft(FORUM_ID)).toBe("");
  });

  it("does not keep the body after Descartar, even when the close lands late", async () => {
    writeDraft(FORUM_ID, "Rascunho que a pessoa descartou.");
    await mount(40, true);
    await act(async () => button("Discard").click());
    await settle(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readDraft(FORUM_ID)).toBe("");
  });
});

describe("forum composer validation focus", () => {
  it("moves focus to the body when Publicar is pressed with a title and no body", async () => {
    await mount(0);
    await act(async () => setTitle("Microfone some"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-publish-placement="footer"]')!.click(),
    );

    const body = document.querySelector("[data-forum-composer-body] textarea");
    expect(body).not.toBeNull();
    expect(document.activeElement).toBe(body);
  });
});

describe("highlightTitleParts", () => {
  it("underlines the word, not the punctuation around it", () => {
    expect(highlightTitleParts("Steam Deck: o app abre", "steam deck")).toEqual([
      { text: "Steam", hit: true },
      { text: " ", hit: false },
      { text: "Deck", hit: true },
      { text: ": o app abre", hit: false },
    ]);
  });

  it("matches across accents and keeps brackets plain", () => {
    expect(highlightTitleParts("Tela azul (WHEA) no CS2", "tela whea")).toEqual([
      { text: "Tela", hit: true },
      { text: " azul (", hit: false },
      { text: "WHEA", hit: true },
      { text: ") no CS2", hit: false },
    ]);
    expect(highlightTitleParts("Notebook não liga", "nao").map((part) => part.hit)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
