// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import {
  ChannelOverviewSection,
  type ChannelOverviewDraft,
} from "@/components/layout/channel-overview-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CHANNEL_NAME_MAX_LENGTH } from "@/lib/channel-name";
import { PromptDialog } from "./prompt-dialog";

/**
 * The two channel name fields, typed into the way a person types.
 *
 * THE BUGS THIS FILE EXISTS FOR, found by the local E2E sweep: renaming a
 * channel in its settings to "Renomeado Com Espaços" answered a raw
 * "Invalid request", because only the create dialog sanitised what was
 * typed; and creating a channel with a 300-character name failed with the
 * error in a page banner behind the modal, so the dialog looked frozen.
 *
 * jsdom because both are about what a keystroke does to a controlled input
 * and where a rejection lands, which a static render cannot show.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Sets a controlled input's value the way a keystroke or a paste does. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nameInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>("input");
  if (!input) {
    throw new Error("no name field");
  }
  return input;
}

describe("PromptDialog", () => {
  it("caps the name at the schema limit", async () => {
    await mount(
      <PromptDialog
        open
        title="Create text channel"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    const input = nameInput();
    expect(input.maxLength).toBe(CHANNEL_NAME_MAX_LENGTH);
    type(input, "a".repeat(300));
    expect(input.value).toHaveLength(CHANNEL_NAME_MAX_LENGTH);
  });

  it("keeps Criar disabled for a name of only spaces", async () => {
    // srv-4: spaces became hyphens before the empty check ran, so three
    // spaces enabled Criar and created a channel named "-".
    await mount(
      <PromptDialog
        open
        title="Create text channel"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    const input = nameInput();
    const submit = document.body.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    // Key by key, each keystroke sanitising what is already there.
    for (let i = 0; i < 3; i += 1) {
      type(input, `${input.value} `);
    }
    expect(input.value).toBe("");
    expect(submit.disabled).toBe(true);
    // A paste arrives in one go.
    type(input, "   ");
    expect(input.value).toBe("");
    expect(submit.disabled).toBe(true);
  });

  it("shows a refusal inside the dialog and keeps it open", async () => {
    let closed = false;
    await mount(
      <PromptDialog
        open
        title="Create text channel"
        onClose={() => {
          closed = true;
        }}
        onConfirm={() => Promise.reject(new Error("Channel limit reached"))}
      />,
    );
    type(nameInput(), "geral");
    const form = document.body.querySelector("form")!;
    await act(async () => {
      form.requestSubmit();
    });
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Channel limit reached");
    expect(form.contains(alert)).toBe(true);
    expect(closed).toBe(false);
    expect(nameInput().value).toBe("geral");

    // Typing again clears it, so an old refusal never sits under a new name.
    type(nameInput(), "geral-2");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("ChannelOverviewSection name field", () => {
  it("sanitises a rename the way the create dialog does", async () => {
    const channel = {
      id: "22222222-2222-4222-8222-222222222222",
      serverId: "11111111-1111-4111-8111-111111111111",
      kind: "server",
      name: "geral",
      type: "text",
      position: 0,
      parentId: null,
      isPrivate: false,
      topic: null,
      imageUrl: null,
      slowmodeSeconds: 0,
      voiceTransport: null,
    } as Channel;
    const drafts: ChannelOverviewDraft[] = [];
    await mount(
      <TooltipProvider>
        <ChannelOverviewSection
          channel={channel}
          draft={{
            name: "geral",
            topic: "",
            imageUrl: "",
            slowmodeSeconds: 0,
            voiceRoomSize: "auto",
          }}
          onDraftChange={(next) => drafts.push(next)}
          iconOpen={false}
          onIconOpenChange={() => {}}
          showPrivateBridge={false}
          showRecipeBridge={false}
          isPrivate={false}
          recipeKind="everyone"
          recipeRoleNames={[]}
          onJumpPrivate={() => {}}
          onJumpRecipe={() => {}}
        />
      </TooltipProvider>,
    );
    const input = nameInput();
    expect(input.maxLength).toBe(CHANNEL_NAME_MAX_LENGTH);
    type(input, "Renomeado Com Espaços");
    expect(drafts.at(-1)?.name).toBe("renomeado-com-espacos");
  });
});
