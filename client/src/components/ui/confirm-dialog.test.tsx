// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<Parameters<typeof ConfirmDialog>[0]>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ConfirmDialog
        open
        title="Pegar @rafa?"
        description="Depois disso, só dá pra trocar em 3 de novembro."
        confirmLabel="Pegar @rafa"
        cancelLabel="Voltar"
        onConfirm={() => {}}
        onClose={() => {}}
        {...props}
      />,
    ),
  );
}

describe("ConfirmDialog initial focus", () => {
  it("starts on confirm for a plain confirm", () => {
    mount({ destructive: false });
    expect(document.activeElement?.textContent).toBe("Pegar @rafa");
  });

  it("starts on cancel when asked, so a second Enter cannot commit", () => {
    mount({ destructive: false, initialFocus: "cancel" });
    expect(document.activeElement?.textContent).toBe("Voltar");
  });
});
