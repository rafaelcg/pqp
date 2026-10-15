import {
  ArrowUpToLine,
  Camera,
  ChevronLeft,
  Circle,
  Loader2,
  Pen,
  PenLine,
  Redo2,
  RectangleHorizontal,
  Square,
  Sticker,
  Trash2,
  Type,
  Undo2,
  X,
  ImagePlus,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  STORY_BACKGROUND_FAMILIES,
  STORY_CAPTION_MAX,
  STORY_LAYER_IMAGE_SHAPES,
  STORY_LAYER_IMAGES_MAX,
  STORY_LAYERS_MAX,
  STORY_TEXT_MAX,
  type StoriesConfig,
  type StoryAudienceOptions,
  type StoryBackground,
  type StoryBackgroundFamily,
  storyBackgroundFamily,
  storyBackgroundsOf,
} from "@pqp/shared";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { useInertBackground } from "@/lib/use-inert-background";
import { fetchStoryAudiences } from "@/lib/stories/api";
import { STORIES_CONFIG_OFF, loadStoriesConfig } from "@/lib/stories/config";
import { captureStill } from "@/lib/stories/camera";
import { colorFromTokens, hasInk, renderDrawingBlob, type Stroke } from "@/lib/stories/drawing";
import { startEagerUpload, type EagerUpload } from "@/lib/stories/eager-upload";
import {
  DEFAULT_TEXT,
  altTextFor,
  canAddLayer,
  editorReducer,
  initialEditorState,
  newLayerId,
  toLayerInput,
  type EditorLayer,
  type ImageShape,
  type TextLayerFields,
} from "@/lib/stories/layers";
import { loadMentionPeople, type MentionPerson } from "@/lib/stories/mention-people";
import { postStory, type StoryDraft } from "@/lib/stories/post";
import {
  preparedFromStill,
  prepareLayerImage,
  prepareRecordedClip,
  prepareStoryFile,
  type PrepareResult,
  type PreparedStoryMedia,
  type StoryFileProblem,
} from "@/lib/stories/upload";
import { useCamera, useRecorder, type RecordedClip } from "@/lib/stories/use-camera";
import type { ComposerRequest } from "@/lib/stories/ui-store";
import { cn } from "@/lib/utils";
import { AudienceChip, AudienceSheet, audienceSummary } from "./composer-audience";
import { CameraControlsRow, CameraStage } from "./composer-camera";
import { ComposerCanvas } from "./composer-canvas";
import { DEFAULT_DRAW, DrawBar, DrawOverlay, type DrawSettings } from "./composer-draw";
import { CallPickerSheet, MentionSheet, StickerTray } from "./composer-stickers";
import { TextEditor, type TextEditorGeometry } from "./composer-text";
import { ModeTabs, StoryButton, type ModeOption } from "./composer-ui";
import { StoryCallCard } from "./story-call-card";
import { StoryContent, type StoryDisplay } from "./story-content";
import type { DisplayLayer } from "./story-layers";

/**
 * "Novo story" on the web: a phone-shaped column, the same on a desktop and at
 * 390 px. A 9:16 canvas in the middle, chrome above and below it.
 *
 * It opens on the camera. Tap the shutter for a photo, hold it (or press the
 * record button) for a video of up to 30 s; the gallery button, a file dropped
 * anywhere on the composer and Ctrl+V all arrive at the same place. Text is the
 * other starting point, a card on one of six backgrounds.
 *
 * Once there is a base the canvas is an editor: text, photos, a drawing, a
 * mention and the call card are LAYERS, each dragged, pinched, turned and
 * deleted on the canvas itself (`composer-canvas.tsx`). The layers go up as
 * data, not burned into the picture, so every viewer draws them at its own
 * size.
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
  /** The signed-in account: the call card is live only while its author is in the room. */
  meId: string;
  /** Voice rooms of the server the composer was opened from, for the call card. */
  voiceRooms: { serverId: string; serverName: string; serverIconUrl?: string | null; rooms: ComposerVoiceRoom[] } | null;
  onClose: () => void;
  /** The posted card flies into this ring (design §4, Posting). */
  onPosted?: (preview: HTMLElement | null) => void;
}

type Mode = "camera" | "text";
type Panel = "stickers" | "call" | "mention" | "audience" | null;

const PROBLEM_KEY: Record<StoryFileProblem["kind"], MessageKey> = {
  "wrong-type": "stories.compose.wrongType",
  "too-big": "stories.compose.tooBig",
  "too-long": "stories.compose.tooLong",
  "wrong-codec": "stories.compose.wrongCodec",
  unreadable: "stories.compose.unreadable",
};

const SHAPE_KEY: Record<ImageShape, MessageKey> = {
  rect: "stories.editor.shape.rect",
  rounded: "stories.editor.shape.rounded",
  circle: "stories.editor.shape.circle",
};

function modeFor(tab: ComposerRequest["tab"]): Mode {
  return tab === "text" || tab === "call" ? "text" : "camera";
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/");
}

export function StoryComposer({ request, meId, voiceRooms, onClose, onPosted }: StoryComposerProps) {
  const { t, locale } = useTranslation();
  const [config, setConfig] = useState<StoriesConfig>(STORIES_CONFIG_OFF);
  const [configReady, setConfigReady] = useState(false);
  const [options, setOptions] = useState<StoryAudienceOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [mode, setMode] = useState<Mode>(() => modeFor(request.tab));
  const [media, setMedia] = useState<PreparedStoryMedia | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Photos being prepared to place: several can be in flight, and each one holds a layer slot.
  const [photoJobs, setPhotoJobs] = useState(0);
  const pendingPhotos = useRef(0);
  // Bumped when the stage is reset (Back, a tab switch): a photo still being prepared for the old
  // stage is dropped when it finishes instead of landing on the new one.
  const stageEpoch = useRef(0);
  const photoUrls = useRef(new Set<string>());
  const [background, setBackground] = useState<StoryBackground>("night");
  const [editor, dispatch] = useReducer(editorReducer, initialEditorState);
  const { layers, selectedId } = editor;
  const [editing, setEditing] = useState<{ id: string | null; geometry: TextEditorGeometry } | null>(null);
  const [textStyle, setTextStyle] = useState<Omit<TextLayerFields, "text">>(DEFAULT_TEXT);
  const [drawing, setDrawing] = useState(false);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>(DEFAULT_DRAW);
  const [panel, setPanel] = useState<Panel>(null);
  const [mentionPeople, setMentionPeople] = useState<MentionPerson[] | null>(null);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [gestureActive, setGestureActive] = useState(false);
  const [serverIds, setServerIds] = useState<string[]>(
    request.context.kind === "server" ? [request.context.serverId] : [],
  );
  const [friends, setFriends] = useState(request.context.kind === "friends");
  const [repliesEnabled, setRepliesEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState(0);
  // What the discard question is about: closing the composer, or leaving the picture / text card for the camera.
  const [discardFor, setDiscardFor] = useState<null | { kind: "close" } | { kind: "retake" } | { kind: "mode"; mode: Mode }>(null);
  const [tabHidden, setTabHidden] = useState(() => document.visibilityState === "hidden");
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The page behind is unreachable while this is open (Safari tabs out of an aria-modal alone).
  useInertBackground(rootRef);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const autoOpenedText = useRef(false);
  // The newest file wins: a slow decode of an earlier pick must not replace
  // the one chosen after it.
  const fileTicket = useRef(0);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Eager uploads (`eager-upload.ts`): each file starts going to storage the moment it is final, while
  // the author is still editing, so Post only has to create and publish. They live in refs because
  // they are side effects of the draft, not things to render; whatever is still here when the
  // composer goes away was never posted, and is thrown away (aborted, and deleted on the server).
  const baseUpload = useRef<EagerUpload | null>(null);
  const layerUploads = useRef(new Map<string, EagerUpload>());
  // The drawing is only final when the pen is put down: rendered and sent then, and again if it changes.
  const drawingUpload = useRef<{ strokes: unknown; file: { blob: Blob; width: number; height: number }; handle: EagerUpload | null } | null>(null);
  // Set when Post hands the uploads to the draft: from then on they are no longer this component's to cancel.
  const handedOver = useRef(false);
  // The server's runtime switch (`stories_eager_uploads`, in the stories config). Off, or a server that
  // predates it, and every file goes up at Post the way it always did.
  const eagerOn = useRef(false);
  eagerOn.current = config.eagerUploads === true;
  const startEager = useCallback(
    (input: Parameters<typeof startEagerUpload>[0]) => (eagerOn.current ? startEagerUpload(input) : null),
    [],
  );

  const cancelUploads = useCallback(() => {
    baseUpload.current?.cancel();
    baseUpload.current = null;
    for (const handle of layerUploads.current.values()) {
      handle.cancel();
    }
    layerUploads.current.clear();
    drawingUpload.current?.handle?.cancel();
    drawingUpload.current = null;
  }, []);
  useEffect(
    () => () => {
      if (!handedOver.current) {
        cancelUploads();
      }
    },
    [cancelUploads],
  );

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

  // A placed photo's object URL lives as long as something can still show it: the layer, or an
  // undo step that would bring it back. Once none can (the step aged out), it is released.
  useEffect(() => {
    const live = new Set<string>();
    for (const snapshot of [...editor.past, editor.layers, ...editor.future]) {
      for (const layer of snapshot) {
        if (layer.type === "image") {
          live.add(layer.previewUrl);
        }
      }
    }
    for (const url of [...photoUrls.current]) {
      if (!live.has(url)) {
        URL.revokeObjectURL(url);
        photoUrls.current.delete(url);
      }
    }
  }, [editor.past, editor.layers, editor.future]);
  useEffect(
    () => () => {
      for (const url of photoUrls.current) {
        URL.revokeObjectURL(url);
      }
      photoUrls.current.clear();
    },
    [],
  );

  // A placed photo goes up as soon as it is on the canvas and is thrown away when it is taken off (the
  // delete button, or an undo of its adding). Undoing a removal puts the layer back, and it goes up again.
  useEffect(() => {
    if (handedOver.current) {
      return;
    }
    const wanted = new Map<string, Extract<EditorLayer, { type: "image" }>>();
    for (const layer of layers) {
      if (layer.type === "image") {
        wanted.set(layer.id, layer);
      }
    }
    for (const [id, handle] of layerUploads.current) {
      if (!wanted.has(id)) {
        handle.cancel();
        layerUploads.current.delete(id);
      }
    }
    for (const [id, layer] of wanted) {
      if (!layerUploads.current.has(id)) {
        const handle = startEager({ kind: "layer", blob: layer.blob, contentType: layer.contentType });
        if (handle) {
          layerUploads.current.set(id, handle);
        }
      }
    }
  }, [layers, config.eagerUploads, startEager]);

  // The drawing, once the pen is up: rendered to its picture and sent, so Post does not wait for it. Any
  // change to the strokes (another stroke, an undo) throws that copy away and sends the new one.
  const drawingLayerNow = layers.find((layer): layer is Extract<EditorLayer, { type: "drawing" }> => layer.type === "drawing");
  const drawingStrokes = drawingLayerNow?.strokes;
  useEffect(() => {
    if (handedOver.current || drawing) {
      return;
    }
    const known = drawingUpload.current;
    if (known && known.strokes === drawingStrokes) {
      return;
    }
    if (known) {
      known.handle?.cancel();
      drawingUpload.current = null;
    }
    if (!drawingStrokes || !hasInk(drawingStrokes as Stroke[])) {
      return;
    }
    let stale = false;
    void renderDrawingBlob(drawingStrokes as Stroke[], colorFromTokens).then((file) => {
      if (stale || !file || handedOver.current) {
        return;
      }
      drawingUpload.current = {
        strokes: drawingStrokes,
        file,
        handle: startEager({ kind: "layer", blob: file.blob, contentType: "image/png" }),
      };
    });
    return () => {
      stale = true;
    };
  }, [drawing, drawingStrokes, config.eagerUploads, startEager]);

  // The camera light goes out the moment the tab is not looked at.
  useEffect(() => {
    const onVisibility = () => setTabHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const hasBase = (mode === "camera" && Boolean(media)) || mode === "text";
  const showingCamera = mode === "camera" && !media;

  // ---------------------------------------------------------------- camera
  const cameraActive = showingCamera && config.mediaEnabled && !tabHidden && !submitting;
  const camera = useCamera(cameraActive);

  const alive = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode runs the cleanup once before the real mount.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const acceptMedia = useCallback((next: PreparedStoryMedia) => {
    // A photo that finished after the composer closed has nowhere to go: let its URL go.
    if (!alive.current) {
      URL.revokeObjectURL(next.previewUrl);
      return;
    }
    setProblem(null);
    setMedia(next);
    // The bytes are final (a photo is already cropped and encoded, a clip is recorded): start sending
    // them now. A newer file replaces an older one, and the older one's upload is thrown away.
    baseUpload.current?.cancel();
    baseUpload.current = startEager({ kind: "base", blob: next.blob, contentType: next.contentType });
    setMode("camera");
    // Whatever was being typed or drawn on the way here is over: the picture is the base now.
    setEditing(null);
    setDrawing(false);
  }, [startEager]);

  // The config can arrive after a file did (one handed over by a drop opens the composer already
  // holding it): the base starts going up as soon as the server says it may.
  useEffect(() => {
    if (config.eagerUploads === true && media && mode === "camera" && !baseUpload.current && !handedOver.current) {
      baseUpload.current = startEager({ kind: "base", blob: media.blob, contentType: media.contentType });
    }
  }, [config.eagerUploads, media, mode, startEager]);

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
      )
        .catch((): PrepareResult => ({ ok: false, problem: { kind: "unreadable" } }))
        .then((result) => {
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
  const recorder = useRecorder(camera.stream, onClip, config.maxVideoMs, () => videoRef.current);

  async function takePhoto() {
    const element = videoRef.current;
    if (!element || camera.status !== "live") {
      return;
    }
    // Newest wins: a file chosen while this frame is still encoding replaces it, not the other way round.
    const ticket = ++fileTicket.current;
    const still = await captureStill(element);
    if (ticket !== fileTicket.current) {
      return;
    }
    if (!still) {
      setProblem(t("stories.compose.unreadable"));
      return;
    }
    setFlash((value) => value + 1);
    acceptMedia(preparedFromStill(still));
  }

  /** A file to be the story's picture or clip. */
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

  /** A picture to PLACE on the story, anywhere on the canvas. */
  async function placePhoto(file: File | null | undefined) {
    if (!file) {
      return;
    }
    // Slots are claimed before the wait: a batch of photos cannot all see the same free room.
    const reserved = pendingPhotos.current;
    const photos = layersRef.current.filter((layer) => layer.type === "image").length;
    if (layersRef.current.length + reserved >= STORY_LAYERS_MAX || photos + reserved >= STORY_LAYER_IMAGES_MAX) {
      setProblem(
        t(layersRef.current.length + reserved >= STORY_LAYERS_MAX ? "stories.editor.limit.layers" : "stories.editor.limit.image"),
      );
      return;
    }
    pendingPhotos.current += 1;
    setPhotoJobs(pendingPhotos.current);
    setProblem(null);
    const epoch = stageEpoch.current;
    let result: Awaited<ReturnType<typeof prepareLayerImage>>;
    try {
      result = await prepareLayerImage(file);
    } finally {
      pendingPhotos.current -= 1;
      setPhotoJobs(pendingPhotos.current);
    }
    if (epoch !== stageEpoch.current) {
      // The stage was reset while this photo was being prepared: it belongs to work that is gone.
      if (result.ok) {
        URL.revokeObjectURL(result.layer.previewUrl);
      }
      return;
    }
    if (!result.ok) {
      showProblem(result.problem);
      return;
    }
    if (!alive.current) {
      URL.revokeObjectURL(result.layer.previewUrl);
      return;
    }
    photoUrls.current.add(result.layer.previewUrl);
    const spread = (layersRef.current.filter((layer) => layer.type === "image").length % 4) * 0.04;
    dispatch({
      type: "add",
      layer: { id: newLayerId(), type: "image", x: 0.5 + spread, y: 0.45 + spread, scale: 1, rotation: 0, shape: "rect", ...result.layer },
    });
    setPanel(null);
  }

  /**
   * What a dropped or pasted file does. With no picture yet it becomes the
   * picture. With one, a photo is placed on top of it (move it wherever it
   * belongs) and a video replaces it.
   */
  function takeFiles(files: readonly File[]) {
    const [first] = files;
    if (!first || !config.mediaEnabled) {
      return;
    }
    if (media && !isVideoFile(first)) {
      for (const file of files.filter((entry) => !isVideoFile(entry)).slice(0, 6)) {
        void placePhoto(file);
      }
      return;
    }
    void takeFile(first);
  }

  useEffect(() => {
    if (request.file) {
      void takeFile(request.file);
    }
    // Once, for the file the opener handed over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paste a screenshot anywhere in the composer (Ctrl+V), unless a field is taking the paste.
  useEffect(() => {
    if (!config.mediaEnabled) {
      return;
    }
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length > 0) {
        event.preventDefault();
        takeFiles(files);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mediaEnabled, config.maxBytes, config.maxVideoMs, config.videoEnabled, media]);

  function retake() {
    // Whatever was still being prepared is dropped (its ticket is stale now), and so is its overlay.
    fileTicket.current += 1;
    setPreparing(false);
    setMedia(null);
    // The picture is being thrown away, and so is its upload.
    baseUpload.current?.cancel();
    baseUpload.current = null;
    setProblem(null);
    setDrawing(false);
    setEditing(null);
    setPanel(null);
    // The layers were placed on that picture: the camera has none of them.
    stageEpoch.current += 1;
    dispatch({ type: "reset" });
  }

  // ---------------------------------------------------------------- the call card
  const callLayer = layers.find((layer): layer is Extract<EditorLayer, { type: "call" }> => layer.type === "call");
  const lockedServerId = callLayer?.serverId ?? null;
  const lockedServerCanPost = Boolean(
    lockedServerId && options?.servers.some((server) => server.serverId === lockedServerId && server.canPost),
  );
  // The call lives in one server: the story has to go there too, which only
  // works where the author may post. Elsewhere the call cannot be posted at
  // all, and the server stays unticked with its reason.
  const effectiveServerIds = useMemo(
    () =>
      lockedServerId && lockedServerCanPost && !serverIds.includes(lockedServerId)
        ? [...serverIds, lockedServerId]
        : serverIds,
    [lockedServerId, lockedServerCanPost, serverIds],
  );

  const renderCall = useCallback(
    (layer: Extract<DisplayLayer, { type: "call" }>) => {
      const placed = layersRef.current.find((entry) => entry.id === layer.id);
      const room = placed?.type === "call" ? voiceRooms?.rooms.find((entry) => entry.id === placed.channelId) : null;
      const channelName = placed?.type === "call" ? (room?.name ?? placed.channelName) : "";
      return (
        <StoryCallCard
          call={null}
          passThrough
          server={voiceRooms ? { name: voiceRooms.serverName, iconUrl: voiceRooms.serverIconUrl ?? null } : null}
          preview={{
            channelName,
            names: (room?.occupants ?? []).map((person) => person.displayName.split(/\s+/)[0] ?? ""),
          }}
        />
      );
    },
    [voiceRooms],
  );

  const ready =
    !preparing &&
    photoJobs === 0 &&
    !submitting &&
    !recorder.recording &&
    !editing &&
    !drawing &&
    (effectiveServerIds.length > 0 || friends) &&
    (mode === "camera" ? Boolean(media) : layers.length > 0) &&
    (!callLayer || lockedServerCanPost);

  const display: StoryDisplay = {
    id: "draft",
    kind: mode === "camera" ? (media?.kind ?? "image") : "text",
    text: null,
    background: mode === "camera" ? null : background,
    caption: null,
    mediaUrl: media?.previewUrl ?? null,
    mediaWidth: media?.width ?? null,
    mediaHeight: media?.height ?? null,
    posterUrl: null,
    call: null,
    callPreview: null,
  };

  async function submit() {
    if (!ready) {
      return;
    }
    setSubmitting(true);
    const audiences = { serverIds: effectiveServerIds, friends };
    const current = layersRef.current;
    const drawingLayer = current.find((layer): layer is Extract<EditorLayer, { type: "drawing" }> => layer.type === "drawing");
    // Normally the drawing was rendered and is already on its way (the pen went up); only a drawing
    // changed in the last moments is drawn again here.
    const preDrawn = drawingLayer && drawingUpload.current?.strokes === drawingLayer.strokes ? drawingUpload.current : null;
    const drawingFile = preDrawn
      ? preDrawn.file
      : drawingLayer
        ? await renderDrawingBlob(drawingLayer.strokes as Stroke[], colorFromTokens)
        : null;
    if (drawingLayer && hasInk(drawingLayer.strokes) && !drawingFile) {
      // The drawing could not be turned into a picture: posting without it would drop what was drawn.
      setProblem(t("stories.compose.unreadable"));
      setSubmitting(false);
      return;
    }
    const layerFiles = new Map<string, Blob>();
    const inputs = current.flatMap((layer) => {
      if (layer.type === "image") {
        layerFiles.set(layer.id, layer.blob);
      }
      if (layer.type === "drawing" && drawingFile) {
        layerFiles.set(layer.id, drawingFile.blob);
      }
      const input = toLayerInput(layer, drawingFile ?? undefined);
      return input ? [input] : [];
    });
    const altText = altTextFor(current, "", (name) => t("stories.editor.altMention", { name }));
    // The words go up twice: as layers, and as the plain caption older builds still read.
    const words = current
      .filter((layer): layer is Extract<EditorLayer, { type: "text" }> => layer.type === "text")
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((layer) => layer.text.trim().replace(/\s+/g, " "))
      .join(" ")
      .slice(0, STORY_TEXT_MAX);
    const caption = words.slice(0, STORY_CAPTION_MAX);
    const common = {
      ...(altText ? { altText } : {}),
      ...(inputs.length > 0 ? { layers: inputs } : {}),
      repliesEnabled,
      audiences,
    };
    const draft =
      mode === "camera" && media
        ? {
            request: { kind: media.kind, ...(caption ? { caption } : {}), ...common },
            media,
            layerFiles,
          }
        : {
            request: { kind: "text" as const, background, ...(words ? { text: words } : {}), ...common },
            media: null,
            layerFiles,
          };
    // The uploads that are on their way now belong to the draft, which waits for them and, if the
    // author discards it from the ring, throws them away. A base from the other tab is not part of it.
    const eagerLayers = new Map<string, EagerUpload>();
    for (const layer of current) {
      const handle =
        layer.type === "image"
          ? layerUploads.current.get(layer.id)
          : layer.type === "drawing"
            ? preDrawn?.handle
            : null;
      if (handle) {
        eagerLayers.set(layer.id, handle);
      }
    }
    const eagerBase = mode === "camera" && media ? baseUpload.current : null;
    const unused = [
      ...(eagerBase ? [] : [baseUpload.current]),
      ...[...layerUploads.current.entries()].filter(([id]) => !eagerLayers.has(id)).map(([, handle]) => handle),
      ...(drawingUpload.current && drawingUpload.current !== preDrawn ? [drawingUpload.current.handle] : []),
    ];
    for (const handle of unused) {
      handle?.cancel();
    }
    handedOver.current = true;
    baseUpload.current = null;
    layerUploads.current = new Map();
    drawingUpload.current = null;
    const posted: StoryDraft = {
      ...draft,
      eager: { base: eagerBase, layers: eagerLayers },
    };
    onPosted?.(previewRef.current);
    // The media's object URL now belongs to the post; do not revoke it here.
    setMedia(null);
    void postStory(posted);
    onClose();
  }

  // ---------------------------------------------------------------- text
  const editingLayer = editing?.id ? layers.find((layer) => layer.id === editing.id) : null;
  const editingFields: TextLayerFields | null = editing
    ? editingLayer?.type === "text"
      ? editingLayer
      : { text: "", ...textStyle }
    : null;

  /**
   * Edit a text layer where it is, or start a new one at the default spot. The geometry is fixed
   * when editing starts and handed to the editor, which draws the words with it: nothing moves.
   */
  const openText = useCallback((id: string | null) => {
    setPanel(null);
    setDrawing(false);
    const existing = id ? layersRef.current.find((layer) => layer.id === id) : null;
    const count = layersRef.current.filter((layer) => layer.type === "text").length;
    setEditing({
      id,
      geometry: existing
        ? { x: existing.x, y: existing.y, scale: existing.scale, rotation: existing.rotation }
        : { x: 0.5, y: 0.4 + ((count * 0.07) % 0.3), scale: 1, rotation: 0 },
    });
  }, []);

  function finishText(fields: TextLayerFields, scale: number) {
    const trimmed = fields.text.trim();
    const { text: _text, ...style } = fields;
    setTextStyle(style);
    if (editing?.id) {
      if (trimmed) {
        // One history step for the whole edit: the words, their style and the scale together.
        dispatch({ type: "patch", id: editing.id, patch: { ...style, text: trimmed, scale } });
      } else {
        dispatch({ type: "remove", id: editing.id });
      }
    } else if (trimmed) {
      if (!canAddLayer(layersRef.current, "text")) {
        setProblem(t("stories.editor.limit.layers"));
      } else {
        const { x, y, rotation } = editing!.geometry;
        dispatch({
          type: "add",
          layer: { id: newLayerId(), type: "text", x, y, scale, rotation, ...style, text: trimmed },
        });
      }
    }
    setEditing(null);
  }

  // How far a soft keyboard makes the whole stage rise while text is edited (0 almost always).
  const [stageLift, setStageLift] = useState(0);

  // "Chama pra call" from a menu: start on a card with the room picker already open.
  useEffect(() => {
    if (request.tab === "call" && voiceRooms) {
      setPanel("call");
    }
    // Once, for the way the composer was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The text card starts on the keyboard: nothing else to do there until there are words.
  useEffect(() => {
    if (mode === "text" && layers.length === 0 && !autoOpenedText.current && configReady && request.tab !== "call") {
      autoOpenedText.current = true;
      openText(null);
    }
  }, [mode, layers.length, configReady, request.tab, openText]);

  // ---------------------------------------------------------------- draw
  const drawingLayer = layers.find((layer): layer is Extract<EditorLayer, { type: "drawing" }> => layer.type === "drawing");
  const strokes = (drawingLayer?.strokes ?? []) as readonly Stroke[];

  function commitStroke(stroke: Stroke) {
    if (drawingLayer) {
      // Layer order is creation order, so a layer placed since would hide these strokes: drawing again
      // brings the (single) drawing back to the top, in the same undo step as the stroke.
      dispatch({ type: "patch", id: drawingLayer.id, patch: { strokes: [...drawingLayer.strokes, stroke] }, toTop: true });
    } else {
      if (!canAddLayer(layersRef.current, "drawing")) {
        setProblem(t("stories.editor.limit.layers"));
        return;
      }
      dispatch({
        type: "add",
        layer: { id: newLayerId(), type: "drawing", x: 0.5, y: 0.5, scale: 1, rotation: 0, strokes: [stroke] },
      });
    }
  }

  // ---------------------------------------------------------------- mention + call
  function openMention() {
    setPanel("mention");
    setMentionLoading(true);
    void loadMentionPeople({ serverIds: effectiveServerIds, friends }, meId)
      .catch((): MentionPerson[] => [])
      .then((people) => {
        setMentionPeople(people);
        setMentionLoading(false);
      });
  }

  function addMention(person: MentionPerson) {
    if (!canAddLayer(layersRef.current, "mention")) {
      setProblem(t("stories.editor.limit.mention"));
      setPanel(null);
      return;
    }
    const count = layersRef.current.filter((layer) => layer.type === "mention").length;
    dispatch({
      type: "add",
      layer: { id: newLayerId(), type: "mention", x: 0.5, y: 0.56 + count * 0.07, scale: 1, rotation: 0, userId: person.id, name: person.displayName },
    });
    setPanel(null);
  }

  function addCall(room: ComposerVoiceRoom) {
    if (!voiceRooms || !canAddLayer(layersRef.current, "call")) {
      return;
    }
    dispatch({
      type: "add",
      layer: { id: newLayerId(), type: "call", x: 0.5, y: 0.76, scale: 1, rotation: 0, serverId: voiceRooms.serverId, channelId: room.id, channelName: room.name },
    });
    setPanel(null);
  }

  // ---------------------------------------------------------------- mode, discard
  /** Anything the person would lose by closing: a picture or clip, or a layer. */
  const hasContent = Boolean(media) || layers.length > 0;

  function switchMode(next: Mode) {
    setProblem(null);
    setEditing(null);
    setDrawing(false);
    setPanel(null);
    // A text card's layers are not the camera's: each side starts clean.
    stageEpoch.current += 1;
    dispatch({ type: "reset" });
    // The text card opens its editor every time the person lands on it with nothing written.
    autoOpenedText.current = false;
    setMode(next);
  }

  /** The camera / text tabs. Whatever was open in the other mode (the editor, a sheet) closes with it. */
  function changeMode(next: Mode) {
    if (recorder.recording || next === mode) {
      return;
    }
    if (layers.length > 0) {
      setDiscardFor({ kind: "mode", mode: next });
    } else {
      switchMode(next);
    }
  }

  /** Back to the camera. Layers placed on the picture go with it, so a tap that cannot be undone asks first. */
  function requestRetake() {
    if (layers.length > 0) {
      setDiscardFor({ kind: "retake" });
    } else {
      retake();
    }
  }

  /** X and Escape: ask before throwing work away. */
  function requestClose() {
    if (hasContent && !submitting) {
      setDiscardFor({ kind: "close" });
    } else {
      onClose();
    }
  }

  function confirmDiscardAction() {
    const what = discardFor;
    setDiscardFor(null);
    rootRef.current?.focus({ preventScroll: true });
    if (what?.kind === "close") {
      onClose();
    } else if (what?.kind === "retake") {
      retake();
    } else if (what?.kind === "mode") {
      switchMode(what.mode);
    }
  }

  // The camera screen and the text editor never share the stage: if the camera is what is showing,
  // nothing is being edited on top of it.
  useEffect(() => {
    if (showingCamera && (editing || drawing)) {
      setEditing(null);
      setDrawing(false);
    }
  }, [showingCamera, editing, drawing]);

  // ---------------------------------------------------------------- focus + keys
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A field that took focus on its own (the text card's) keeps it.
    if (rootRef.current && !rootRef.current.contains(document.activeElement)) {
      rootRef.current.focus({ preventScroll: true });
    }
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
      if (discardFor) {
        setDiscardFor(null);
        rootRef.current?.focus({ preventScroll: true });
      } else if (panel) {
        setPanel(null);
      } else if (drawing) {
        setDrawing(false);
      } else if (recorder.recording) {
        recorder.stop();
      } else if (selectedId) {
        dispatch({ type: "select", id: null });
      } else {
        requestClose();
      }
      return;
    }
    const typing = (event.target as HTMLElement).tagName === "TEXTAREA" || (event.target as HTMLElement).tagName === "INPUT";
    if ((event.metaKey || event.ctrlKey) && !typing && !editing && !discardFor) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (key === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
    }
    if (event.key !== "Tab" || !rootRef.current) {
      return;
    }
    const focusable = [
      ...rootRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([tabindex='-1']), input:not([disabled]), textarea:not([disabled]), [tabindex='0']",
      ),
    ].filter((element) => element.offsetParent !== null && !element.closest("[inert]"));
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
  ];

  const summary = audienceSummary({ options, serverIds: effectiveServerIds, friends }, t);
  const numberFormat = new Intl.NumberFormat(locale);
  const selected = layers.find((layer) => layer.id === selectedId) ?? null;
  const overlayOpen = Boolean(editing) || drawing || panel !== null;

  // The selection bar stays where it always is, centered at the top of the canvas, so it never
  // lands on a neighbouring layer; it only steps to the foot of the canvas when the selected layer
  // reaches up into the top strip, so it is never ON the words placed there.
  const [barAtFoot, setBarAtFoot] = useState(false);
  useLayoutEffect(() => {
    const canvas = previewRef.current;
    const layer = selected && canvas ? canvas.querySelector<HTMLElement>(`[data-story-layer="${CSS.escape(selected.id)}"]`) : null;
    if (!canvas || !layer) {
      setBarAtFoot(false);
      return;
    }
    const box = layer.getBoundingClientRect();
    // The bar is 40 px tall and sits 12 px down; a layer whose top is above 68 px is in its way.
    setBarAtFoot(box.top - canvas.getBoundingClientRect().top < 12 + 40 + 16);
  }, [selected, gestureActive, overlayOpen]);
  const canUndo = editor.past.length > 0;
  const canRedo = editor.future.length > 0;
  const taken = useMemo(
    () => new Set(layers.flatMap((layer) => (layer.type === "mention" ? [layer.userId] : []))),
    [layers],
  );

  function describe(layer: EditorLayer): string {
    switch (layer.type) {
      case "text":
        return t("stories.editor.layer.text", { text: layer.text });
      case "image":
        return t("stories.editor.layer.image");
      case "drawing":
        return t("stories.editor.layer.drawing");
      case "call":
        return t("stories.editor.layer.call", { room: layer.channelName });
      case "mention":
        return t("stories.editor.layer.mention", { name: layer.name });
    }
  }

  function cycleShape(layer: Extract<EditorLayer, { type: "image" }>) {
    const next = STORY_LAYER_IMAGE_SHAPES[(STORY_LAYER_IMAGE_SHAPES.indexOf(layer.shape) + 1) % STORY_LAYER_IMAGE_SHAPES.length]!;
    dispatch({ type: "patch", id: layer.id, patch: { shape: next } });
  }

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
        className="story-cmp story-cmp-lift"
        style={{ "--story-lift": `${stageLift}px` } as CSSProperties}
        onDrop={(items) => takeFiles(items.files)}
      >
        {/* While words are being typed only the text controls are on screen: the rest comes back on Done. */}
        <div className={cn("story-cmp-head", editing && "invisible")} inert={Boolean(editing) || Boolean(discardFor)}>
          <button
            type="button"
            className="story-cbtn"
            data-story-close=""
            aria-label={t("stories.compose.close")}
            onClick={requestClose}
          >
            <X className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {media && !drawing && (
            <button
              type="button"
              className="story-cbtn"
              data-story-retake=""
              title={t("stories.compose.retake")}
              aria-label={t("stories.compose.retake")}
              onClick={requestRetake}
            >
              <ChevronLeft className="h-[18px] w-[18px]" aria-hidden />
            </button>
          )}
          {hasBase && !drawing && (
            <div role="toolbar" aria-label={t("stories.editor.tools")} className="ml-auto flex min-w-0 shrink items-center gap-1.5">
              <button
                type="button"
                className="story-cbtn"
                data-story-tool-text=""
                aria-label={t("stories.editor.tool.text")}
                onClick={() => openText(null)}
              >
                <Type className="h-[18px] w-[18px]" aria-hidden />
              </button>
              {config.mediaEnabled && (
                <button
                  type="button"
                  className="story-cbtn"
                  data-story-tool-photo=""
                  aria-label={t("stories.editor.tool.photo")}
                  onClick={() => photoInput.current?.click()}
                >
                  <ImagePlus className="h-[18px] w-[18px]" aria-hidden />
                </button>
              )}
              {/* A drawing goes up as a picture: with no object storage there is nowhere to put it. */}
              {config.mediaEnabled && (
                <button
                  type="button"
                  className="story-cbtn"
                  data-story-tool-draw=""
                  aria-label={t("stories.editor.tool.draw")}
                  onClick={() => {
                    setPanel(null);
                    setEditing(null);
                    dispatch({ type: "select", id: null });
                    setDrawing(true);
                  }}
                >
                  <Pen className="h-[18px] w-[18px]" aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="story-cbtn"
                data-story-tool-stickers=""
                aria-label={t("stories.editor.tool.stickers")}
                onClick={() => setPanel("stickers")}
              >
                <Sticker className="h-[18px] w-[18px]" aria-hidden />
              </button>
              <button
                type="button"
                className="story-cbtn"
                data-story-undo=""
                aria-label={t("stories.editor.undo")}
                disabled={!canUndo}
                onClick={() => dispatch({ type: "undo" })}
              >
                <Undo2 className="h-[18px] w-[18px]" aria-hidden />
              </button>
              <button
                type="button"
                className="story-cbtn"
                data-story-redo=""
                aria-label={t("stories.editor.redo")}
                disabled={!canRedo}
                onClick={() => dispatch({ type: "redo" })}
              >
                <Redo2 className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </div>
          )}
        </div>

        <div
          ref={previewRef}
          className="story-cmp-canvas"
          inert={Boolean(discardFor)}
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
            // Muted on purpose: editing is silent, the viewer is where a clip has sound (and a mute button).
            <StoryContent story={display} still={false} playVideo muted paused={false} loop withLayers={false} />
          )}

          {hasBase && (
            <ComposerCanvas
              layers={layers}
              selectedId={selectedId}
              dispatch={dispatch}
              hiddenId={editing?.id ?? (drawing ? (drawingLayer?.id ?? null) : null)}
              interactive={!overlayOpen}
              renderCall={renderCall}
              onEditText={openText}
              describe={describe}
              onGesture={setGestureActive}
            />
          )}

          {mode === "text" && layers.length === 0 && !editing && (
            <p
              className="pointer-events-none absolute inset-x-[12%] top-[40%] text-center text-sm font-semibold"
              style={{ color: "var(--story-on-media-2)" }}
            >
              {t("stories.editor.textCardHint")}
            </p>
          )}

          {mode === "text" && !overlayOpen && <BackgroundPicker value={background} onChange={setBackground} />}

          {drawing && (
            <DrawOverlay strokes={strokes} settings={drawSettings} onStroke={commitStroke} />
          )}

          {selected && hasBase && !gestureActive && !overlayOpen && selected.type !== "drawing" && (
            <div
              role="toolbar"
              aria-label={describe(selected)}
              data-story-layer-bar=""
              className={cn(
                "absolute inset-x-0 z-10 flex justify-center gap-1.5",
                // In the text card the background picker holds the foot row.
                barAtFoot ? (mode === "text" ? "bottom-[108px]" : "bottom-3") : "top-3",
              )}
            >
              {selected.type === "text" && (
                <button type="button" className="story-cbtn" aria-label={t("stories.editor.layer.edit")} onClick={() => openText(selected.id)}>
                  <PenLine className="h-[18px] w-[18px]" aria-hidden />
                </button>
              )}
              {selected.type === "image" && (
                <button
                  type="button"
                  className="story-cbtn"
                  data-story-shape=""
                  aria-label={t("stories.editor.layer.shape", { shape: t(SHAPE_KEY[selected.shape]) })}
                  onClick={() => cycleShape(selected)}
                >
                  {selected.shape === "circle" ? (
                    <Circle className="h-[18px] w-[18px]" aria-hidden />
                  ) : selected.shape === "rounded" ? (
                    <RectangleHorizontal className="h-[18px] w-[18px]" aria-hidden />
                  ) : (
                    <Square className="h-[18px] w-[18px]" aria-hidden />
                  )}
                </button>
              )}
              <button
                type="button"
                className="story-cbtn"
                data-story-forward=""
                aria-label={t("stories.editor.layer.forward")}
                onClick={() => dispatch({ type: "forward", id: selected.id })}
              >
                <ArrowUpToLine className="h-[18px] w-[18px]" aria-hidden />
              </button>
              <button
                type="button"
                className="story-cbtn"
                data-story-delete=""
                aria-label={t("stories.editor.layer.delete")}
                onClick={() => dispatch({ type: "remove", id: selected.id })}
              >
                <Trash2 className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </div>
          )}

          {editingFields && editing && (
            <TextEditor
              key={editing.id ?? "new"}
              initial={editingFields}
              geometry={editing.geometry}
              onDone={finishText}
              onCancel={() => setEditing(null)}
              onLift={setStageLift}
            />
          )}

          {(preparing || photoJobs > 0) && (
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
              className="absolute inset-x-3 top-3 z-50 rounded-[14px] px-3.5 py-2.5 text-center text-sm font-semibold leading-snug"
              style={{ background: "var(--story-tray)", color: "var(--story-on-media)", boxShadow: "var(--story-shadow)" }}
              onClick={() => setProblem(null)}
            >
              {problem}
            </p>
          )}

          {flash > 0 && <span key={flash} className="story-flash" aria-hidden />}
        </div>

        <div className={cn("story-cmp-foot", editing && "invisible")} inert={Boolean(editing) || Boolean(discardFor)}>
          {showingCamera && config.mediaEnabled && (
            <CameraControlsRow
              camera={camera}
              recorder={recorder}
              shutterDisabled={preparing || photoJobs > 0}
              onChooseFile={() => fileInput.current?.click()}
              onPhoto={() => void takePhoto()}
              onRecordStart={() => void recorder.start()}
              onRecordStop={recorder.stop}
            />
          )}

          {drawing && (
            <DrawBar
              settings={drawSettings}
              onChange={setDrawSettings}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={() => dispatch({ type: "undo" })}
              onRedo={() => dispatch({ type: "redo" })}
              onDone={() => setDrawing(false)}
            />
          )}

          {!showingCamera && !drawing && (
            <div className="flex items-center gap-2.5 px-2">
              <AudienceChip summary={summary} onOpen={() => setPanel("audience")} />
              <StoryButton data-story-post="" disabled={!ready} onClick={() => void submit()}>
                {t("stories.audience.post")}
              </StoryButton>
            </div>
          )}

          {!media && !drawing && (
            <ModeTabs
              label={t("stories.compose.title")}
              value={mode}
              options={modes}
              onChange={changeMode}
            />
          )}
        </div>

        {discardFor && (
          <DiscardDialog
            onKeep={() => {
              setDiscardFor(null);
              // The dialog's button is gone: keep the keys (Escape) with the composer.
              rootRef.current?.focus({ preventScroll: true });
            }}
            onDiscard={confirmDiscardAction}
          />
        )}
        {panel === "audience" && (
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
            onClose={() => setPanel(null)}
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
        {panel === "stickers" && (
          <StickerTray
            onClose={() => setPanel(null)}
            onCall={() => setPanel("call")}
            onMention={openMention}
            onPhoto={() => {
              setPanel(null);
              photoInput.current?.click();
            }}
            photoAvailable={config.mediaEnabled}
            callAvailable={Boolean(voiceRooms)}
            callPlaced={Boolean(callLayer)}
            mentionFull={!canAddLayer(layers, "mention")}
          />
        )}
        {panel === "call" && voiceRooms && (
          <CallPickerSheet
            serverName={voiceRooms.serverName}
            rooms={voiceRooms.rooms}
            meId={meId}
            onPick={addCall}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === "mention" && (
          <MentionSheet
            people={mentionPeople}
            loading={mentionLoading}
            taken={taken}
            onPick={addMention}
            onClose={() => setPanel(null)}
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
              ? "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mov"
              : "image/jpeg,image/png,image/webp"
          }
          onChange={(event) => {
            const file = event.target.files?.[0];
            // A picture chosen while editing one is a photo to place; with none yet it is the picture.
            if (file && media && !isVideoFile(file)) {
              void placePhoto(file);
            } else {
              void takeFile(file);
            }
            event.target.value = "";
          }}
        />
        <input
          ref={photoInput}
          type="file"
          multiple
          className="hidden"
          tabIndex={-1}
          data-story-photo-file=""
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => {
            for (const file of [...(event.target.files ?? [])].slice(0, 6)) {
              void placePhoto(file);
            }
            event.target.value = "";
          }}
        />
      </FileDropZone>
    </div>,
    document.body,
  );
}

/** "Descartar story?": asked when X or Escape would throw away a picture or a layer. */
function DiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keep.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center px-6"
      style={{ background: "var(--story-dim)" }}
      data-story-discard=""
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="story-discard-title"
        aria-describedby="story-discard-body"
        className="w-full max-w-[300px] rounded-[18px] p-4 text-center"
        style={{ background: "var(--story-tray)", color: "var(--story-on-media)", boxShadow: "var(--story-shadow)" }}
      >
        <h2 id="story-discard-title" className="text-base font-bold">
          {t("stories.compose.discard.title")}
        </h2>
        <p id="story-discard-body" className="mt-1 text-sm" style={{ color: "var(--story-on-media-2)" }}>
          {t("stories.compose.discard.body")}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <button ref={keep} type="button" className="story-cbtn !h-11 w-full" data-story-discard-keep="" onClick={onKeep}>
            {t("stories.compose.discard.keep")}
          </button>
          <button
            type="button"
            className="story-cbtn !h-11 w-full"
            data-story-discard-confirm=""
            style={{ background: "var(--color-danger)", color: "var(--color-on-danger)" }}
            onClick={onDiscard}
          >
            {t("stories.compose.discard.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

const BACKGROUND_FAMILY_KEY: Record<StoryBackgroundFamily, MessageKey> = {
  glow: "stories.compose.backgroundGlow",
  solid: "stories.compose.backgroundSolid",
  gradient: "stories.compose.backgroundGradient",
};

/**
 * The text card's backgrounds, one family at a time: a row of swatches under a small switch. The
 * switch only changes which row is shown; the chosen key is the author's until they pick another.
 */
function BackgroundPicker({
  value,
  onChange,
}: {
  value: StoryBackground;
  onChange: (next: StoryBackground) => void;
}) {
  const { t } = useTranslation();
  const [family, setFamily] = useState<StoryBackgroundFamily>(() => storyBackgroundFamily(value));
  return (
    <div className="absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-2.5 px-3" data-story-bg-picker="">
      <div role="group" aria-label={t("stories.compose.backgroundFamily")} className="flex gap-1.5">
        {STORY_BACKGROUND_FAMILIES.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={family === key}
            data-story-bg-family={key}
            onClick={() => setFamily(key)}
            className={cn(
              "h-7 rounded-full px-3 text-xs font-semibold transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
              family === key ? "bg-[var(--story-on-media)] text-[var(--story-on-accent)]" : "bg-[var(--story-field-fill)] text-[var(--story-on-media-2)] hover:text-[var(--story-on-media)]",
            )}
          >
            {t(BACKGROUND_FAMILY_KEY[key])}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label={t("stories.compose.background")} className="flex justify-center gap-2.5">
        {storyBackgroundsOf(family).map((key, index) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            aria-label={`${t(BACKGROUND_FAMILY_KEY[family])} ${t("stories.compose.backgroundOption", { n: index + 1 })}`}
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
    </div>
  );
}
