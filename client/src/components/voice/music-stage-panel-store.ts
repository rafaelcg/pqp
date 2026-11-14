import { useCallback, useSyncExternalStore } from "react";

/**
 * WHICH CALL DRAWS THE MUSIC ON ITS STAGE.
 *
 * Under the redesign the room stage draws the player and the queue itself
 * (`MusicStagePanel`), and the chat composer must then leave its own music bar
 * out, or the room has two players. Whether the stage draws it depends on
 * things only the stage knows (a wide window, no ring, no picture blown up,
 * the stage neither collapsed nor hidden), so the stage says so here and App
 * reads it.
 *
 * Counted per channel rather than one value: a claim is released by the mount
 * that made it, so an unmount can never wipe a newer mount's claim.
 */

const claims = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** The stage draws the panel for `channelId`. Call the result to let go. */
export function claimStageMusicPanel(channelId: string): () => void {
  claims.set(channelId, (claims.get(channelId) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const left = (claims.get(channelId) ?? 1) - 1;
    if (left > 0) {
      claims.set(channelId, left);
    } else {
      claims.delete(channelId);
    }
    emit();
  };
}

export function isStageMusicPanelDrawn(channelId: string | null): boolean {
  return channelId !== null && (claims.get(channelId) ?? 0) > 0;
}

export function subscribeStageMusicPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStageMusicPanel(channelId: string | null): boolean {
  const read = useCallback(() => isStageMusicPanelDrawn(channelId), [channelId]);
  return useSyncExternalStore(subscribeStageMusicPanel, read, () => false);
}

/**
 * The composer's music bar: the call is on screen here and its stage is not
 * already drawing the player.
 */
export function composerDrawsMusic(
  musicInComposer: boolean,
  stageDrawsMusic: boolean,
): boolean {
  return musicInComposer && !stageDrawsMusic;
}

export function resetStageMusicPanelForTests(): void {
  claims.clear();
  emit();
}
