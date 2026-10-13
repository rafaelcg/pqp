import { Camera, ChevronLeft, Headphones, ImageIcon, Loader2, Type, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  STORY_BACKGROUNDS,
  STORY_CAPTION_MAX,
  STORY_TEXT_MAX,
  type StoriesConfig,
  type StoryAudienceOptions,
  type StoryBackground,
  type StorySticker,
} from "@pqp/shared";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { fetchStoryAudiences } from "@/lib/stories/api";
import { STORIES_CONFIG_OFF, loadStoriesConfig } from "@/lib/stories/config";
import { authorInRoom, defaultCallRoom } from "@/lib/stories/call-room";
import { captureStill } from "@/lib/stories/camera";
import { postStory } from "@/lib/stories/post";
import {
  preparedFromStill,
  prepareRecordedClip,
  prepareStoryFile,
  type PreparedStoryMedia,
  type StoryFileProblem,
} from "@/lib/stories/upload";
import { useCamera, useRecorder, type RecordedClip } from "@/lib/stories/use-camera";
import type { ComposerRequest } from "@/lib/stories/ui-store";
import { cn } from "@/lib/utils";
import { AudienceChip, AudienceSheet, audienceSummary } from "./composer-audience";
import { CameraControlsRow, CameraStage } from "./composer-camera";
import { ModeTabs, StoryButton, type ModeOption } from "./composer-ui";
import { StoryContent, TEXT_CARD_BOX_CLASS, textCardSizeClass, type StoryDisplay } from "./story-content";

/**
 * "Novo story" on the web: a phone-shaped column, the same on a desktop and at
 * 390 px. A 9:16 canvas in the middle, chrome above and below it.
 *
 * It opens on the camera. Tap the shutter for a photo, hold it (or press the
 * record button) for a video of up to 30 s; the gallery button, a file dropped
 * anywhere on the composer and Ctrl+V all arrive at the same place, and then
 * the canvas shows the picture with a caption field and "Postar". Text and
 * "Chama pra call" are the other two modes, each a card on one of six
 * backgrounds.
 *
 * "Quem vê" starts ticked where the person was (decision 3), lists every
 * server with stories on, greys out the ones they may not post to with the
 * reason, and adds Amigos when that audience is on. A video over the limit is
 * refused here, with its length, before a byte is uploaded.
 */

export interface ComposerVoiceRoom {
  id: string;
  name: string;
  occupants: { id: string; displayName: string }[];
}

interface StoryComposerProps {
  request: ComposerRequest;
  /** The signed-in account: the call sticker is live only while its author is in the room. */
  meId: string;
  /** Voice rooms of the server the composer was opened from, for the call sticker. */
  voiceRooms: { serverId: string; serverName: string; rooms: ComposerVoiceRoom[] } | null;
  onClose: () => void;
  /** The posted card flies into this ring (design §4, Posting). */
  onPosted?: (preview: HTMLElement | null) => void;
}

type Mode = "camera" | "text" | "call";

const PROBLEM_KEY: Record<StoryFileProblem["kind"], MessageKey> = {
  "wrong-type": "stories.compose.wrongType",
  "too-big": "stories.compose.tooBig",
  "too-long": "stories.compose.tooLong",
  unreadable: "stories.compose.unreadable",
};

function modeFor(tab: ComposerRequest["tab"]): Mode {
  return tab === "text" ? "text" : tab === "call" ? "call" : "camera";
}

export function StoryComposer({ request, meId, voiceRooms, onClose, onPosted }: StoryComposerProps) {
  const { t, locale } = useTranslation();
  const [config, setConfig] = useState<StoriesConfig>(STORIES_CONFIG_OFF);
  const [options, setOptions] = useState<StoryAudienceOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [mode, setMode] = useState<Mode>(() => modeFor(request.tab));
  const [media, setMedia] = useState<PreparedStoryMedia | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [caption, setCaption] = useState("");
  const [text, setText] = useState("");
  const [callText, setCallText] = useState(() => t("stories.compose.callText"));
  const [background, setBackground] = useState<StoryBackground>("night");
  // The room the author is in (the sticker closes when they are not), else
  // the room people are in already.
  const [roomId, setRoomId] = useState<string | null>(() =>
    defaultCallRoom(voiceRooms?.rooms ?? [], meId),
  );
  const [serverIds, setServerIds] = useState<string[]>(
    request.context.kind === "server" ? [request.context.serverId] : [],
  );
  const [friends, setFriends] = useState(request.context.kind === "friends");
  const [repliesEnabled, setRepliesEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [flash, setFlash] = useState(0);
  const [configReady, setConfigReady] = useState(false);
  const [tabHidden, setTabHidden] = useState(() => document.visibilityState === "hidden");
  const fileInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // The newest file wins: a slow decode of an earlier pick must not replace
  // the one chosen after it.
  const fileTicket = useRef(0);

  const loadOptions = () => {
    setOptionsFailed(false);
    fetchStoryAudiences()
      .then(setOptions)
      .catch(() => setOptionsFailed(true));
  };
  useEffect(() => {
    void loadStoriesConfig().then((loaded) => {
      setConfig(loaded);
      setConfigReady(true);
    });
    loadOptions();
  }, []);

  // No media on this deployment: there is only the text card to offer.
  useEffect(() => {
    if (configReady && !config.mediaEnabled && mode === "camera") {
      setMode("text");
    }
  }, [config.mediaEnabled, configReady, mode]);

  // A context server the person may not post to starts unticked.
  useEffect(() => {
    if (!options) {
      return;
    }
    setServerIds((current) =>
      current.filter((id) => options.servers.some((server) => server.serverId === id && server.canPost)),
    );
    if (!options.friends.enabled || !options.friends.canPost) {
      setFriends(false);
    }
  }, [options]);

  useEffect(() => () => {
    if (media) {
      URL.revokeObjectURL(media.previewUrl);
    }
  }, [media]);

  // The camera light goes out the moment the tab is not looked at.
  useEffect(() => {
    const onVisibility = () => setTabHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---------------------------------------------------------------- camera
  const cameraActive = mode === "camera" && !media && config.mediaEnabled && !tabHidden && !submitting;
  const camera = useCamera(cameraActive);

  const acceptMedia = useCallback((next: PreparedStoryMedia) => {
    setProblem(null);
    setMedia(next);
    setMode("camera");
  }, []);

  const showProblem = useCallback(
    (found: StoryFileProblem) => {
      const key =
        found.kind === "wrong-type" && !config.videoEnabled
          ? "stories.compose.wrongTypeNoVideo"
          : PROBLEM_KEY[found.kind];
      setProblem(t(key, found.kind === "too-long" ? { seconds: found.seconds } : undefined));
    },
    [config.videoEnabled, t],
  );

  const onClip = useCallback(
    (clip: RecordedClip) => {
      const ticket = ++fileTicket.current;
      setPreparing(true);
      void prepareRecordedClip(
        clip,
        { maxBytes: config.maxBytes, maxVideoMs: config.maxVideoMs, videoEnabled: config.videoEnabled },
        camera.size,
      ).then((result) => {
        if (ticket !== fileTicket.current) {
          if (result.ok) {
            URL.revokeObjectURL(result.media.previewUrl);
          }
          return;
        }
        setPreparing(false);
        if (result.ok) {
          acceptMedia(result.media);
        } else {
          showProblem(result.problem);
        }
      });
    },
    [acceptMedia, camera.size, config.maxBytes, config.maxVideoMs, config.videoEnabled, showProblem],
  );
  const recorder = useRecorder(camera.stream, onClip, config.maxVideoMs);

  async function takePhoto() {
    const element = videoRef.current;
    if (!element || camera.status !== "live") {
      return;
    }
    const still = await captureStill(element);
    if (!still) {
      setProblem(t("stories.compose.unreadable"));
      return;
    }
    fileTicket.current += 1;
    setFlash((value) => value + 1);
    acceptMedia(preparedFromStill(still));
  }

  async function takeFile(file: File | null | undefined) {
    if (!file) {
      return;
    }
    const ticket = ++fileTicket.current;
    setPreparing(true);
    setProblem(null);
    const result = await prepareStoryFile(file, {
      maxBytes: config.maxBytes,
      maxVideoMs: config.maxVideoMs,
      videoEnabled: config.videoEnabled,
    });
    if (ticket !== fileTicket.current) {
      if (result.ok) {
        URL.revokeObjectURL(result.media.previewUrl);
      }
      return;
    }
    setPreparing(false);
    if (!result.ok) {
      showProblem(result.problem);
      return;
    }
    acceptMedia(result.media);
  }

  useEffect(() => {
    if (request.file) {
      void takeFile(request.file);
    }
    // Once, for the file the opener handed over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paste a screenshot anywhere in the composer (Ctrl+V).
  useEffect(() => {
    if (!config.mediaEnabled) {
      return;
    }
    function onPaste(event: ClipboardEvent) {
      const file = [...(event.clipboardData?.files ?? [])][0];
      if (file) {
        event.preventDefault();
        void takeFile(file);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mediaEnabled, config.maxBytes, config.maxVideoMs, config.videoEnabled]);

  function retake() {
    fileTicket.current += 1;
    setMedia(null);
    setCaption("");
    setProblem(null);
  }

  // ---------------------------------------------------------------- state
  const room = voiceRooms?.rooms.find((entry) => entry.id === roomId) ?? null;
  const sticker: StorySticker | null =
    mode === "call" && room && voiceRooms
      ? { type: "call", serverId: voiceRooms.serverId, channelId: room.id }
      : null;

  // The call lives in one server: the story has to go there too, which only
  // works where the author may post. Elsewhere the call cannot be posted at
  // all, and the server stays unticked with its reason.
  const lockedServerId = sticker?.serverId ?? null;
  const lockedServerCanPost = Boolean(
    lockedServerId &&
      options?.servers.some((server) => server.serverId === lockedServerId && server.canPost),
  );
  const effectiveServerIds = useMemo(
    () =>
      lockedServerId && lockedServerCanPost && !serverIds.includes(lockedServerId)
        ? [...serverIds, lockedServerId]
        : serverIds,
    [lockedServerId, lockedServerCanPost, serverIds],
  );

  const body = mode === "call" ? callText : text;
  const ready =
    !preparing &&
    !submitting &&
    !recorder.recording &&
    (effectiveServerIds.length > 0 || friends) &&
    (mode === "camera" ? Boolean(media) : body.trim().length > 0) &&
    (mode !== "call" || (Boolean(sticker) && lockedServerCanPost));

  const display: StoryDisplay = {
    id: "draft",
    kind: mode === "camera" ? (media?.kind ?? "image") : "text",
    text: null,
    background: mode === "camera" ? null : mode === "call" ? "lime" : background,
    caption: null,
    mediaUrl: media?.previewUrl ?? null,
    posterUrl: null,
    call: null,
    callPreview:
      mode === "call" && room
        ? { channelName: room.name, names: room.occupants.map((person) => person.displayName.split(/\s+/)[0] ?? "") }
        : null,
  };

  function submit() {
    if (!ready) {
      return;
    }
    setSubmitting(true);
    const audiences = { serverIds: effectiveServerIds, friends };
    const draft =
      mode === "camera" && media
        ? {
            request: {
              kind: media.kind,
              ...(caption.trim() ? { caption: caption.trim() } : {}),
              repliesEnabled,
              audiences,
            },
            media,
          }
        : {
            request: {
              kind: "text" as const,
              text: body.trim(),
              background: mode === "call" ? ("lime" as const) : background,
              ...(sticker ? { sticker } : {}),
              repliesEnabled,
              audiences,
            },
            media: null,
          };
    onPosted?.(previewRef.current);
    // The media's object URL now belongs to the post; do not revoke it here.
    setMedia(null);
    void postStory(draft);
    onClose();
  }

  // ---------------------------------------------------------------- focus + keys
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  function onRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (sheetOpen) {
        setSheetOpen(false);
      } else if (recorder.recording) {
        recorder.stop();
      } else {
        onClose();
      }
      return;
    }
    if (event.key !== "Tab" || !rootRef.current) {
      return;
    }
    const focusable = [
      ...rootRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([tabindex='-1']), input:not([disabled]), textarea:not([disabled]), [tabindex='0']",
      ),
    ].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------- render
  const modes: ModeOption<Mode>[] = [
    {
      value: "camera",
      label: t("stories.compose.modeCamera"),
      icon: <Camera className="h-3.5 w-3.5" aria-hidden />,
      disabled: !config.mediaEnabled,
    },
    { value: "text", label: t("stories.compose.modeText"), icon: <Type className="h-3.5 w-3.5" aria-hidden /> },
    ...(voiceRooms
      ? [
          {
            value: "call" as const,
            label: t("stories.compose.modeCall"),
            icon: <Headphones className="h-3.5 w-3.5" aria-hidden />,
          },
        ]
      : []),
  ];

  const summary = audienceSummary({ options, serverIds: effectiveServerIds, friends }, t);
  const numberFormat = new Intl.NumberFormat(locale);
  const showingCamera = mode === "camera" && !media;
  const canvasText = mode === "text" ? text : callText;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("stories.compose.title")}
      tabIndex={-1}
      data-story-composer=""
      onKeyDown={onRootKeyDown}
      className="story-backdrop-in fixed inset-0 z-[55] flex items-center justify-center overflow-hidden outline-none"
      style={{ background: "var(--story-backdrop)", backdropFilter: "blur(10px)" }}
    >
      <FileDropZone
        mode={config.mediaEnabled ? "accept" : "refuse"}
        acceptLabel={t("stories.compose.dropHere")}
        refuseLabel={t("stories.compose.mediaOff")}
        size="pane"
        className="story-cmp"
        onDrop={(items) => void takeFile(items.files[0])}
      >
        <div className="story-cmp-head">
          <button
            type="button"
            className="story-cbtn"
            data-story-close=""
            aria-label={t("stories.compose.close")}
            onClick={onClose}
          >
            <X className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {media && (
            <button
              type="button"
              className="story-cbtn"
              data-story-retake=""
              onClick={retake}
            >
              <ChevronLeft className="h-[18px] w-[18px]" aria-hidden />
              {t("stories.compose.retake")}
            </button>
          )}
        </div>

        <div
          ref={previewRef}
          className="story-cmp-canvas"
          role="group"
          aria-label={t("stories.compose.preview")}
        >
          {showingCamera ? (
            <CameraStage
              ref={videoRef}
              camera={camera}
              recorder={recorder}
              onChooseFile={() => fileInput.current?.click()}
            />
          ) : (
            <StoryContent story={display} still={false} playVideo muted={false} paused={false} loop />
          )}

          {mode === "camera" && !media && !config.mediaEnabled && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--story-on-media-2)" }}>
              <ImageIcon className="h-8 w-8" aria-hidden />
            </div>
          )}

          {(mode === "text" || mode === "call") && (
            <CanvasText
              value={canvasText}
              onChange={mode === "text" ? setText : setCallText}
              placeholder={t("stories.compose.textPlaceholder")}
              label={t("stories.compose.textLabel")}
              dataAttr={mode === "text" ? "data-story-text" : "data-story-call-text"}
              autoFocus={mode === "text"}
              pinned={mode === "call"}
            />
          )}

          {mode === "text" && (
            <BackgroundPicker value={background} onChange={setBackground} />
          )}

          {mode === "call" && voiceRooms && (
            <CallRoomPanel
              voiceRooms={voiceRooms}
              roomId={roomId}
              onRoom={setRoomId}
              meId={meId}
              room={room}
            />
          )}

          {mode === "camera" && media && config.mediaEnabled && (
            <div className="absolute inset-x-3 bottom-3">
              <input
                value={caption}
                maxLength={STORY_CAPTION_MAX}
                onChange={(event) => setCaption(event.target.value)}
                placeholder={t("stories.compose.captionPlaceholder")}
                aria-label={t("stories.compose.caption")}
                data-story-caption=""
                className="h-11 w-full story-field rounded-full border px-4 text-[16px] font-medium outline-none"
                style={{
                  background: "var(--story-dim)",
                  borderColor: "var(--story-field-edge)",
                  color: "var(--story-on-media)",
                }}
              />
            </div>
          )}

          {preparing && (
            <div
              role="status"
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2"
              style={{ background: "var(--story-dim)", color: "var(--story-on-media)" }}
            >
              <Loader2 className="h-6 w-6 motion-safe:animate-spin" aria-hidden />
              <p className="text-sm font-semibold">{t("stories.compose.preparing")}</p>
            </div>
          )}

          {problem && (
            <p
              role="alert"
              data-story-problem=""
              className="absolute inset-x-3 top-3 z-10 rounded-[14px] px-3.5 py-2.5 text-center text-sm font-semibold leading-snug"
              style={{ background: "var(--story-tray)", color: "var(--story-on-media)", boxShadow: "var(--story-shadow)" }}
            >
              {problem}
            </p>
          )}

          {flash > 0 && <span key={flash} className="story-flash" aria-hidden />}
        </div>

        <div className="story-cmp-foot">
          {showingCamera && config.mediaEnabled && (
            <CameraControlsRow
              camera={camera}
              recorder={recorder}
              shutterDisabled={preparing}
              onChooseFile={() => fileInput.current?.click()}
              onPhoto={() => void takePhoto()}
              onRecordStart={() => void recorder.start()}
              onRecordStop={recorder.stop}
            />
          )}

          {!showingCamera && (
            <div className="flex items-center gap-2.5 px-2">
              <AudienceChip summary={summary} onOpen={() => setSheetOpen(true)} />
              <StoryButton data-story-post="" disabled={!ready} onClick={submit}>
                {t("stories.audience.post")}
              </StoryButton>
            </div>
          )}

          {!media && (
            <ModeTabs
              label={t("stories.compose.title")}
              value={mode}
              options={modes}
              onChange={(next) => {
                if (recorder.recording) {
                  return;
                }
                setProblem(null);
                setMode(next);
              }}
            />
          )}
        </div>

        {sheetOpen && (
          <AudienceSheet
            state={{
              options,
              failed: optionsFailed,
              serverIds: effectiveServerIds,
              friends,
              lockedServerId: lockedServerCanPost ? lockedServerId : null,
              repliesEnabled,
            }}
            numberFormat={numberFormat}
            onClose={() => setSheetOpen(false)}
            onRetry={loadOptions}
            onToggleServer={(serverId, next) =>
              setServerIds((current) =>
                next ? [...current, serverId] : current.filter((id) => id !== serverId),
              )
            }
            onToggleFriends={setFriends}
            onRepliesChange={setRepliesEnabled}
          />
        )}

        <input
          ref={fileInput}
          type="file"
          className="hidden"
          tabIndex={-1}
          data-story-file=""
          accept={
            config.videoEnabled
              ? "image/jpeg,image/png,image/webp,video/mp4"
              : "image/jpeg,image/png,image/webp"
          }
          onChange={(event) => {
            void takeFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </FileDropZone>
    </div>,
    document.body,
  );
}

/**
 * The words on a text card, typed straight onto it. It uses the card's own
 * box and size classes, so what is typed is exactly where it will be posted.
 */
function CanvasText({
  value,
  onChange,
  placeholder,
  label,
  dataAttr,
  autoFocus,
  pinned,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
  dataAttr: string;
  autoFocus: boolean;
  /** The sticker sits under it: keep the box short. */
  pinned: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [value]);
  const extra = { [dataAttr]: "" };
  return (
    <textarea
      ref={ref}
      value={value}
      maxLength={STORY_TEXT_MAX}
      rows={1}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      {...extra}
      className={cn(
        TEXT_CARD_BOX_CLASS,
        textCardSizeClass(value),
        "story-field resize-none overflow-hidden border-0 bg-transparent p-0 outline-none",
        pinned && "max-h-[30%]",
      )}
      style={{ color: "var(--story-on-media)", caretColor: "var(--story-accent)" }}
    />
  );
}

function BackgroundPicker({
  value,
  onChange,
}: {
  value: StoryBackground;
  onChange: (next: StoryBackground) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t("stories.compose.background")}
      className="absolute inset-x-0 bottom-3 flex justify-center gap-2.5 px-3"
    >
      {STORY_BACKGROUNDS.map((key, index) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          aria-label={t("stories.compose.backgroundOption", { n: index + 1 })}
          data-story-bg={key}
          onClick={() => onChange(key)}
          className={cn(
            "story-text-card h-8 w-8 rounded-full transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none",
            value === key ? "scale-110" : "hover:scale-105",
          )}
          style={{
            boxShadow:
              value === key
                ? "0 0 0 2px var(--story-card), 0 0 0 4px var(--story-on-media)"
                : "0 0 0 1.5px var(--story-field-edge)",
          }}
          data-bg={key}
        />
      ))}
    </div>
  );
}

function CallRoomPanel({
  voiceRooms,
  roomId,
  onRoom,
  meId,
  room,
}: {
  voiceRooms: { serverId: string; serverName: string; rooms: ComposerVoiceRoom[] };
  roomId: string | null;
  onRoom: (id: string | null) => void;
  meId: string;
  room: ComposerVoiceRoom | null;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute inset-x-3 bottom-3 max-h-[46%] space-y-2 overflow-y-auto rounded-[16px] p-3"
      style={{ background: "var(--story-tray)", boxShadow: "var(--story-shadow)" }}
    >
      <p className="text-xs leading-snug" style={{ color: "var(--story-on-media-2)" }}>
        {t("stories.callPicker.body")}
      </p>
      {voiceRooms.rooms.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--story-on-media-2)" }}>
          {t("stories.callPicker.empty")}
        </p>
      ) : (
        <div role="radiogroup" aria-label={t("stories.callPicker.rooms", { server: voiceRooms.serverName })} className="space-y-1">
          {voiceRooms.rooms.map((entry) => {
            const selected = entry.id === roomId;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onRoom(entry.id)}
                className="flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-left"
                style={{
                  background: selected ? "var(--story-field-fill)" : "transparent",
                  boxShadow: selected ? "inset 0 0 0 1.5px var(--story-accent)" : "inset 0 0 0 1px var(--story-hairline)",
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold" style={{ color: "var(--story-on-media)" }}>
                    {entry.name}
                  </span>
                  <span className="block truncate text-xs" style={{ color: "var(--story-on-media-2)" }}>
                    {entry.occupants.length === 0
                      ? t("stories.callPicker.emptyRoom")
                      : t("stories.callPicker.inRoom", { count: entry.occupants.length })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {room && !authorInRoom(room, meId) && (
        <p data-story-call-hint="" className="text-xs leading-snug text-warning">
          {t("stories.callPicker.notInRoom", { room: room.name })}
        </p>
      )}
    </div>
  );
}
