import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoryCallLive } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import {
  clearStoriesNotice,
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

  const notice = ui.notice;
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => clearStoriesNotice(notice.key), notice.action ? 5000 : 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
          meId={me.id}
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
      {notice &&
        createPortal(
          <div
            key={notice.key}
            role="status"
            className="story-pill fixed bottom-6 left-1/2 z-[70] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold text-text shadow-[var(--shadow-2)]"
            style={{ animationDuration: notice.action ? "5s" : "2s" }}
          >
            <span className="min-w-0 truncate">{notice.text}</span>
            {notice.action && (
              <button
                type="button"
                onClick={() => {
                  const run = notice.action?.run;
                  clearStoriesNotice(notice.key);
                  run?.();
                }}
                className="shrink-0 rounded-full px-1 font-bold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {notice.action.label}
              </button>
            )}
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
