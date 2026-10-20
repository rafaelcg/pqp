import { PqpAppError } from "@pqp/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { createSessionView, loadInitial, type UiState } from "./session";

describe("Eco session view", () => {
  it("follows connection events while the session is live", () => {
    const seen: UiState[] = [];
    const view = createSessionView((s) => seen.push(s));
    expect(view.connection("online")).toBe(true);
    expect(view.connection("reconnecting")).toBe(true);
    expect(seen).toEqual(["online", "reconnecting"]);
  });

  it("keeps ended terminal: a late connection event does not turn the buttons back on", () => {
    const seen: UiState[] = [];
    const view = createSessionView((s) => seen.push(s));
    view.connection("reconnecting");
    view.end();
    expect(view.connection("online")).toBe(false);
    view.end();
    expect(seen).toEqual(["reconnecting", "ended"]);
    expect(view.ended).toBe(true);
  });
});

describe("Eco initial reads", () => {
  it("runs the second read when the first one fails, and reports the failure", async () => {
    const second = vi.fn(async () => {});
    const onFailed = vi.fn();
    await loadInitial([async () => Promise.reject(new PqpAppError("unavailable")), second], () => false, onFailed);
    expect(second).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it("does not report a read refused because the session ended", async () => {
    const onFailed = vi.fn();
    await loadInitial([async () => Promise.reject(new PqpAppError("ended"))], () => false, onFailed);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports nothing once the session is over, so the ended message keeps the screen", async () => {
    const onFailed = vi.fn();
    await loadInitial([async () => Promise.reject(new Error("network"))], () => true, onFailed);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports nothing when every read succeeds", async () => {
    const onFailed = vi.fn();
    await loadInitial([async () => {}, async () => {}], () => false, onFailed);
    expect(onFailed).not.toHaveBeenCalled();
  });
});
