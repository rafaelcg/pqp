import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POPOVER_SURFACE } from "@/components/ui/popover";
import { TOAST_CLOSE, TOAST_SURFACE, TOAST_SURFACE_REDESIGN } from "@/components/ui/toast";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Toast recipe", () => {
  it("is the popover's card, so a toast draws today's level-3 card with the toggle off", () => {
    expect(TOAST_SURFACE).toBe(POPOVER_SURFACE);
    expect(TOAST_SURFACE).toContain("elevation-3");
    expect(TOAST_SURFACE).toContain("rounded-[var(--popover-radius,var(--radius-card))]");
  });

  it("moves a toast with its own card onto the popover card only under the redesign", () => {
    for (const cls of TOAST_SURFACE_REDESIGN.split(" ")) {
      expect(cls.startsWith("redesign:")).toBe(true);
    }
  });

  it("keeps today's square close button and adds IconButton's ghost and ring under the redesign", () => {
    expect(TOAST_CLOSE).toContain("rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text");
    expect(TOAST_CLOSE).toContain("redesign:rounded-[var(--icon-button-radius)]");
    expect(TOAST_CLOSE).toContain("redesign:focus-visible:ring-2");
  });

  it("is used by every toast", () => {
    for (const path of [
      "../dm/dm-toasts.tsx",
      "../conversations/friend-accepted-toast.tsx",
      "../forward/forwarded-toast.tsx",
      "../forward/not-in-server-toast.tsx",
      "../apps/app-join-host.tsx",
    ]) {
      expect(read(path)).toContain("TOAST_SURFACE,");
    }
    for (const path of ["../voice/channel-session-toasts.tsx", "../watch-party/waitlist/watch-party-approved-toasts.tsx"]) {
      expect(read(path)).toContain("TOAST_SURFACE_REDESIGN");
    }
  });

  it("gives a whole-card button the dismiss button's ring", () => {
    for (const path of ["../dm/dm-toasts.tsx", "../voice/channel-session-toasts.tsx"]) {
      expect(read(path)).toContain("TOAST_OPEN_REDESIGN)");
    }
  });

  it("sits a 32px leading mark in the 40px slot, so stacked text lines up", () => {
    for (const path of [
      "../forward/forwarded-toast.tsx",
      "../forward/not-in-server-toast.tsx",
      "../apps/app-join-host.tsx",
    ]) {
      expect(read(path)).toMatch(/h-8 w-8[^"]* redesign:mx-1/);
    }
  });

  it("gives every toast's dismiss button the round ghost and its focus ring", () => {
    for (const path of [
      "../dm/dm-toasts.tsx",
      "../conversations/friend-accepted-toast.tsx",
      "../forward/forwarded-toast.tsx",
      "../forward/not-in-server-toast.tsx",
      "../apps/app-join-host.tsx",
    ]) {
      expect(read(path)).toMatch(/className=\{(cn\()?TOAST_CLOSE\b/);
    }
    expect(read("../watch-party/waitlist/watch-party-approved-toasts.tsx")).toContain("TOAST_CLOSE_REDESIGN,");
  });
});
