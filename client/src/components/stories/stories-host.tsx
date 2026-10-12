import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoryCallLive } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { failedPostNotice } from "@/lib/stories/post";
import {
  closeStoryComposer,
  closeStoryViewer,
  ringAudienceKey,
  useStoriesUi,
} from "@/lib/stories/ui-store";
import { StoryComposer, type ComposerVoiceRoom } from "./story-composer";
import type { StoryViewerSelf } from "./story-strip";
import { StoryViewer } from "./story-viewer";

/**
 * The one place the stories modals live. App mounts this once and hands it
 * the few things only App knows: who is signed in, how to join a voice room,
 * how to open the role editor, and the voice rooms of the open server for
 * the call sticker. Everything else (which strip opened what, what is being
 * posted) goes through `lib/stories/ui-store.ts`.
 */

interface StoriesHostProps {
  me: StoryViewerSelf | null;
  bauEnabled: boolean;
  voiceRooms: { serverId: string; serverName: string; rooms: ComposerVoiceRoom[] } | null;
  onJoinCall: (call: StoryCallLive) => void;
  onOpenRoles: (serverId: string) => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function StoriesHost({ me, bauEnabled, voiceRooms, onJoinCall, onOpenRoles }: StoriesHostProps) {
  const { t } = useTranslation();
  const ui = useStoriesUi();
  const [viewerKey, setViewerKey] = useState(0);
  const [posted, setPosted] = useState<number | null>(null);
  const lastViewer = useRef(ui.viewer);

  useEffect(() => {
    if (ui.viewer && ui.viewer !== lastViewer.current) {
      setViewerKey((key) => key + 1);
    }
    lastViewer.current = ui.viewer;
  }, [ui.viewer]);

  // Reduced motion says "Postado" instead of flying the card into the ring.
  useEffect(() => {
    if (ui.posting?.status === "done" && prefersReducedMotion()) {
      setPosted(Date.now());
    }
  }, [ui.posting?.status]);
  useEffect(() => {
    if (posted === null) {
      return;
    }
    const timer = window.setTimeout(() => setPosted(null), 1500);
    return () => window.clearTimeout(timer);
  }, [posted]);

  // A failed post says why, once, out loud: the red ring alone does not tell
  // "try again" from "not today" from "this one will not go up".
  const failedId = ui.posting?.status === "failed" ? ui.posting.id : null;
  const failure = ui.posting?.status === "failed" ? ui.posting.failure : null;
  const [failedNote, setFailedNote] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!failedId) {
      return;
    }
    const { key, vars } = failedPostNotice(failure);
    setFailedNote({ id: failedId, text: t(key, vars) });
    // `t` changes identity with the locale only; the note is said once per failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedId, failure]);
  // Its own timer: a retry or a dismissal ends the failure, and must not
  // cancel the timer that takes the note away.
  useEffect(() => {
    if (!failedNote) {
      return;
    }
    const timer = window.setTimeout(() => setFailedNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [failedNote]);

  /**
   * "The composed card shrinks into the Teu story ring (400 ms emphasized)":
   * a copy of the preview flies from where it was to the ring, then goes.
   */
  const flyIntoRing = useCallback(
    (preview: HTMLElement | null) => {
      const context = ui.composer?.context;
      if (!preview || !context || prefersReducedMotion()) {
        return;
      }
      const ring = document.querySelector(
        `[data-story-ring="${CSS.escape(`${ringAudienceKey(context)}:own`)}"]`,
      );
      const from = preview.getBoundingClientRect();
      const to = ring?.getBoundingClientRect();
      if (!to || to.width === 0 || typeof preview.animate !== "function") {
        return;
      }
      const ghost = preview.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, {
        position: "fixed",
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        zIndex: "70",
        pointerEvents: "none",
        transformOrigin: "center",
      });
      document.body.appendChild(ghost);
      const scale = to.width / from.width;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const easing =
        getComputedStyle(document.documentElement).getPropertyValue("--ease-emphasized").trim() ||
        "ease-out";
      const animation = ghost.animate(
        [
          { transform: "none", borderRadius: "12px", opacity: 1 },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            borderRadius: `${from.width / 2}px`,
            opacity: 0.4,
          },
        ],
        { duration: 400, easing, fill: "forwards" },
      );
      animation.onfinish = () => ghost.remove();
      animation.oncancel = () => ghost.remove();
    },
    [ui.composer?.context],
  );

  if (!me) {
    return null;
  }

  return (
    <>
      {ui.viewer && (
        <StoryViewer
          key={viewerKey}
          request={ui.viewer}
          me={me}
          bauEnabled={bauEnabled}
          onClosed={closeStoryViewer}
          onJoinCall={onJoinCall}
          onOpenRoles={onOpenRoles}
        />
      )}
      {ui.composer && (
        <StoryComposer
          request={ui.composer}
          voiceRooms={
            ui.composer.context.kind === "server" &&
            voiceRooms?.serverId === ui.composer.context.serverId
              ? voiceRooms
              : null
          }
          onClose={closeStoryComposer}
          onPosted={flyIntoRing}
        />
      )}
      {failedNote &&
        createPortal(
          <div
            key={failedNote.id}
            role="status"
            style={{ animationDuration: "5s" }}
            className="story-pill fixed bottom-6 left-1/2 z-[70] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-full bg-surface-2 px-4 py-2 text-center text-sm font-semibold text-text shadow-[var(--shadow-2)]"
          >
            {failedNote.text}
          </div>,
          document.body,
        )}
      {posted !== null &&
        createPortal(
          <div
            role="status"
            className="story-pill fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold text-text shadow-[var(--shadow-2)]"
          >
            {t("stories.upload.posted")}
          </div>,
          document.body,
        )}
    </>
  );
}
