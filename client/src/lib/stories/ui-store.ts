import { useSyncExternalStore } from "react";
import type { StoryAuthor } from "@pqp/shared";
import type { PostFailure } from "./post";
import type { ViewerPerson } from "./viewer-state";

/**
 * Which stories surface is open, shared by the strips (which open things) and
 * the one `StoriesHost` App mounts (which draws them).
 *
 * The viewer is a modal over the app, never a route change (design decision
 * 32): closing it puts the person exactly where they were, which is easiest
 * to guarantee when nothing about the route moved.
 */

export type StoryAudienceKey =
  | { kind: "server"; serverId: string; serverName: string }
  | { kind: "friends" };

export interface ViewerRequest {
  audience: StoryAudienceKey;
  people: ViewerPerson[];
  authors: Record<string, StoryAuthor>;
  startIndex: number;
  /** The ring that opened it, for the zoom open and the close back into it. */
  originRect: DOMRect | null;
  /** `data-story-ring` of the opening ring, looked up again at close. */
  originRingId: string | null;
  /**
   * Opened with Enter or Space (a click with `detail === 0`). Only then does
   * closing paint a focus ring on the ring it returns to; after a mouse or a
   * touch the focus goes back quietly, so nothing stays highlighted.
   */
  originByKeyboard?: boolean;
}

export interface ComposerRequest {
  /** Pre-ticked in "Quem vê": where the person was when they opened it. */
  context: { kind: "server"; serverId: string } | { kind: "friends" };
  tab?: "media" | "text" | "call";
  /** A file handed over by a drop or a paste outside the composer. */
  file?: File | null;
}

export interface PostingState {
  id: string;
  /** `server:<id>` and/or `friends`, matching `ringAudienceKey`. */
  audienceKeys: string[];
  /** 0..1 while the bytes go up; null for a text card or once they are up. */
  progress: number | null;
  status: "uploading" | "processing" | "failed" | "done";
  /** Why it failed, while `status` is "failed" (see `PostFailure`). */
  failure: PostFailure | null;
  /** Post again; null when posting again cannot work and a tap only dismisses. */
  retry: (() => void) | null;
}

/**
 * A line said over the app, outside the viewer, so it survives the viewer
 * closing (muting the last person in the walk closes it at once).
 */
export interface StoriesNotice {
  key: number;
  text: string;
  action?: { label: string; run: () => void };
}

export interface StoriesUiState {
  viewer: ViewerRequest | null;
  composer: ComposerRequest | null;
  posting: PostingState | null;
  notice: StoriesNotice | null;
}

let state: StoriesUiState = { viewer: null, composer: null, posting: null, notice: null };
const listeners = new Set<() => void>();

function set(patch: Partial<StoriesUiState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStoriesUi(): StoriesUiState {
  return state;
}

export function useStoriesUi(): StoriesUiState {
  return useSyncExternalStore(subscribe, getStoriesUi, getStoriesUi);
}

export function ringAudienceKey(audience: StoryAudienceKey | ComposerRequest["context"]): string {
  return audience.kind === "server" ? `server:${audience.serverId}` : "friends";
}

export function openStoryViewer(request: ViewerRequest): void {
  if (request.people.length === 0) {
    return;
  }
  set({ viewer: request });
}

export function closeStoryViewer(): void {
  set({ viewer: null });
}

export function openStoryComposer(request: ComposerRequest): void {
  set({ composer: request, viewer: null });
}

export function closeStoryComposer(): void {
  set({ composer: null });
}

export function setPosting(posting: PostingState | null): void {
  set({ posting });
}

export function patchPosting(id: string, patch: Partial<PostingState>): void {
  if (state.posting?.id !== id) {
    return;
  }
  set({ posting: { ...state.posting, ...patch } });
}

export function showStoriesNotice(text: string, action?: StoriesNotice["action"]): void {
  set({ notice: { key: Date.now(), text, action } });
}

export function clearStoriesNotice(key?: number): void {
  if (key === undefined || state.notice?.key === key) {
    set({ notice: null });
  }
}

/** Tests only. */
export function resetStoriesUi(): void {
  state = { viewer: null, composer: null, posting: null, notice: null };
}
