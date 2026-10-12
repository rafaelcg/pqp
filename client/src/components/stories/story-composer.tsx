import { ImageIcon, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  STORY_BACKGROUNDS,
  STORY_CAPTION_MAX,
  STORY_TEXT_MAX,
  type StoriesConfig,
  type StoryAudienceOptions,
  type StoryBackground,
  type StorySticker,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Dialog } from "@/components/ui/dialog";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { fetchStoryAudiences } from "@/lib/stories/api";
import { STORIES_CONFIG_OFF, loadStoriesConfig } from "@/lib/stories/config";
import { postStory } from "@/lib/stories/post";
import {
  prepareStoryFile,
  type PreparedStoryMedia,
  type StoryFileProblem,
} from "@/lib/stories/upload";
import type { ComposerRequest } from "@/lib/stories/ui-store";
import { cn } from "@/lib/utils";
import { StoryContent, type StoryDisplay } from "./story-content";

/**
 * "Novo story" on the web (design E3): a modal with the preview on the left
 * and the form on the right. Photo or video by drop, paste or picker; a text
 * card on one of six backgrounds; or "Chama pra call", a text card carrying a
 * live sticker for a voice room of the server it was opened from.
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
  /** Voice rooms of the server the composer was opened from, for the call sticker. */
  voiceRooms: { serverId: string; serverName: string; rooms: ComposerVoiceRoom[] } | null;
  onClose: () => void;
  /** The posted card flies into this ring (design §4, Posting). */
  onPosted?: (preview: HTMLElement | null) => void;
}

type Tab = "media" | "text" | "call";

const PROBLEM_KEY: Record<StoryFileProblem["kind"], MessageKey> = {
  "wrong-type": "stories.compose.wrongType",
  "too-big": "stories.compose.tooBig",
  "too-long": "stories.compose.tooLong",
  unreadable: "stories.compose.unreadable",
};

export function StoryComposer({ request, voiceRooms, onClose, onPosted }: StoryComposerProps) {
  const { t, locale } = useTranslation();
  const [config, setConfig] = useState<StoriesConfig>(STORIES_CONFIG_OFF);
  const [options, setOptions] = useState<StoryAudienceOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [tab, setTab] = useState<Tab>(request.tab ?? "media");
  const [media, setMedia] = useState<PreparedStoryMedia | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [caption, setCaption] = useState("");
  const [text, setText] = useState("");
  const [callText, setCallText] = useState(() => t("stories.compose.callText"));
  const [background, setBackground] = useState<StoryBackground>("night");
  // The room people are in already is the one worth calling people into.
  const [roomId, setRoomId] = useState<string | null>(() => {
    const rooms = voiceRooms?.rooms ?? [];
    const busiest = [...rooms].sort((a, b) => b.occupants.length - a.occupants.length)[0];
    return busiest?.id ?? null;
  });
  const [serverIds, setServerIds] = useState<string[]>(
    request.context.kind === "server" ? [request.context.serverId] : [],
  );
  const [friends, setFriends] = useState(request.context.kind === "friends");
  const [repliesEnabled, setRepliesEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // The newest file wins: a slow decode of an earlier pick must not replace
  // the one chosen after it.
  const fileTicket = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const loadOptions = () => {
    setOptionsFailed(false);
    fetchStoryAudiences()
      .then(setOptions)
      .catch(() => setOptionsFailed(true));
  };
  useEffect(() => {
    void loadStoriesConfig().then(setConfig);
    loadOptions();
  }, []);

  // No media on this deployment: there is only the text card to offer.
  useEffect(() => {
    if (options && !config.mediaEnabled && tab === "media") {
      setTab("text");
    }
  }, [config.mediaEnabled, options, tab]);

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
      const key =
        result.problem.kind === "wrong-type" && !config.videoEnabled
          ? "stories.compose.wrongTypeNoVideo"
          : PROBLEM_KEY[result.problem.kind];
      setProblem(
        t(key, result.problem.kind === "too-long" ? { seconds: result.problem.seconds } : undefined),
      );
      return;
    }
    setMedia(result.media);
    setFileName(file.name || null);
    setTab("media");
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

  const room = voiceRooms?.rooms.find((entry) => entry.id === roomId) ?? null;
  const sticker: StorySticker | null =
    tab === "call" && room && voiceRooms
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

  const body = tab === "call" ? callText : text;
  const ready =
    !preparing &&
    !submitting &&
    (effectiveServerIds.length > 0 || friends) &&
    (tab === "media" ? Boolean(media) : body.trim().length > 0) &&
    (tab !== "call" || (Boolean(sticker) && lockedServerCanPost));

  const display: StoryDisplay = {
    id: "draft",
    kind: tab === "media" ? (media?.kind ?? "image") : "text",
    text: tab === "media" ? null : body || t("stories.compose.textPlaceholder"),
    background: tab === "media" ? null : tab === "call" ? "lime" : background,
    caption: tab === "media" ? caption.trim() || null : null,
    mediaUrl: media?.previewUrl ?? null,
    posterUrl: null,
    call: null,
    callPreview:
      tab === "call" && room
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
      tab === "media" && media
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
              background: tab === "call" ? ("lime" as const) : background,
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

  const tabs: { value: Tab; label: string; disabled?: boolean }[] = [
    { value: "media", label: t("stories.compose.tabMedia"), disabled: !config.mediaEnabled },
    { value: "text", label: t("stories.compose.modeText") },
    ...(voiceRooms ? [{ value: "call" as const, label: t("stories.compose.modeCall") }] : []),
  ];

  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <Dialog
      open
      size="lg"
      title={t("stories.compose.title")}
      onClose={onClose}
      closeOnBackdrop={false}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-snug text-text-tertiary">
            {t("stories.audience.footer")}
          </p>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button data-story-post="" disabled={!ready} onClick={submit}>
            {t("stories.audience.post")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 px-5 py-4 sm:flex-row">
        <div className="flex shrink-0 justify-center sm:block">
          <div
            ref={previewRef}
            aria-label={t("stories.compose.preview")}
            role="img"
            className="relative aspect-[9/16] w-40 overflow-hidden rounded-[12px] sm:w-[200px]"
            style={{ background: "var(--story-card)" }}
          >
            {tab === "media" && !media ? (
              <div className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--story-on-media-2)" }}>
                <ImageIcon className="h-8 w-8" aria-hidden />
              </div>
            ) : (
              <StoryContent story={display} still={false} playVideo muted paused={false} />
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <RadioGroup
            label={t("stories.compose.title")}
            value={tab}
            onValueChange={(value) => setTab(value)}
            options={tabs}
            size="sm"
          />

          {tab === "media" && (
            <div className="space-y-3">
              {!config.mediaEnabled && options ? (
                <p className="text-sm text-text-secondary">{t("stories.compose.mediaOff")}</p>
              ) : (
                <FileDropZone
                  mode="accept"
                  acceptLabel={t("stories.compose.dropTitle")}
                  size="field"
                  onDrop={(items) => void takeFile(items.files[0])}
                  className="rounded-[var(--radius-card)] border border-dashed border-border-strong"
                >
                  <div className="flex items-center gap-3 p-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface-2 text-text-secondary">
                      <Upload className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text">
                        {fileName ?? t("stories.compose.dropTitle")}
                      </p>
                      <p className="text-xs leading-snug text-text-tertiary">{t("stories.compose.drop")}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={preparing}
                      onClick={() => fileInput.current?.click()}
                    >
                      {media ? t("stories.compose.replace") : t("stories.compose.choose")}
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      className="hidden"
                      accept={config.videoEnabled ? "image/jpeg,image/png,image/webp,video/mp4" : "image/jpeg,image/png,image/webp"}
                      onChange={(event) => {
                        void takeFile(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                  </div>
                </FileDropZone>
              )}
              {problem && (
                <p role="alert" className="text-sm text-danger">
                  {problem}
                </p>
              )}
              {config.mediaEnabled && (
                <Input
                  value={caption}
                  maxLength={STORY_CAPTION_MAX}
                  onChange={(event) => setCaption(event.target.value)}
                  placeholder={t("stories.compose.captionPlaceholder")}
                  aria-label={t("stories.compose.caption")}
                />
              )}
            </div>
          )}

          {tab === "text" && (
            <div className="space-y-3">
              <Textarea
                value={text}
                maxLength={STORY_TEXT_MAX}
                rows={3}
                className="min-h-20"
                autoFocus
                onChange={(event) => setText(event.target.value)}
                placeholder={t("stories.compose.textPlaceholder")}
                aria-label={t("stories.compose.textLabel")}
                data-story-text=""
              />
              <BackgroundPicker value={background} onChange={setBackground} />
            </div>
          )}

          {tab === "call" && voiceRooms && (
            <div className="space-y-3">
              <p className="text-xs leading-snug text-text-secondary">{t("stories.callPicker.body")}</p>
              {voiceRooms.rooms.length === 0 ? (
                <p className="text-sm text-text-tertiary">{t("stories.callPicker.empty")}</p>
              ) : (
                <RadioGroup
                  variant="list"
                  label={t("stories.callPicker.rooms", { server: voiceRooms.serverName })}
                  value={roomId ?? ""}
                  onValueChange={(value) => setRoomId(value || null)}
                  options={voiceRooms.rooms.map((entry) => ({
                    value: entry.id,
                    label: entry.name,
                    description:
                      entry.occupants.length === 0
                        ? t("stories.callPicker.emptyRoom")
                        : t("stories.callPicker.inRoom", { count: entry.occupants.length }),
                  }))}
                />
              )}
              <Input
                value={callText}
                maxLength={STORY_TEXT_MAX}
                onChange={(event) => setCallText(event.target.value)}
                aria-label={t("stories.compose.textLabel")}
              />
            </div>
          )}

          <fieldset className="space-y-1">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
              {t("stories.audience.title")}
            </legend>
            {optionsFailed && (
              <div className="flex items-center gap-3 px-2 py-1">
                <p role="alert" className="flex-1 text-sm text-danger">
                  {t("stories.audience.loadFailed")}
                </p>
                <Button size="sm" variant="secondary" onClick={loadOptions}>
                  {t("stories.viewer.retry")}
                </Button>
              </div>
            )}
            {options?.servers.map((server) => {
              const locked = server.serverId === lockedServerId && server.canPost;
              const checked = effectiveServerIds.includes(server.serverId);
              const reason =
                server.blockedReason === "timed_out"
                  ? t("stories.audience.timedOut")
                  : server.blockedReason === "account_too_new"
                    ? t("stories.audience.tooNew")
                    : server.blockedReason
                      ? t("stories.audience.noPermission")
                      : null;
              return (
                <CheckRow
                  key={server.serverId}
                  checked={checked && server.canPost}
                  disabled={!server.canPost || locked}
                  label={server.serverName}
                  description={
                    reason ??
                    (locked
                      ? t("stories.audience.callServer")
                      : t("stories.audience.members", {
                          count: server.memberCount,
                          countLabel: numberFormat.format(server.memberCount),
                        }))
                  }
                  className={cn(!server.canPost && "opacity-60")}
                  onCheckedChange={(next) =>
                    setServerIds((current) =>
                      next ? [...current, server.serverId] : current.filter((id) => id !== server.serverId),
                    )
                  }
                />
              );
            })}
            {options?.friends.enabled && (
              <CheckRow
                checked={friends}
                disabled={!options.friends.canPost}
                label={t("stories.audience.friends")}
                onCheckedChange={setFriends}
              />
            )}
            {options && effectiveServerIds.length === 0 && !friends && (
              <p className="px-2 pt-1 text-xs text-text-tertiary">{t("stories.audience.none")}</p>
            )}
          </fieldset>

          <Switch
            checked={repliesEnabled}
            onCheckedChange={setRepliesEnabled}
            label={t("stories.audience.replies")}
            description={t("stories.audience.repliesHint")}
          />
        </div>
      </div>
    </Dialog>
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
    <div role="radiogroup" aria-label={t("stories.compose.background")} className="flex flex-wrap gap-2.5">
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
            "story-text-card h-8 w-8 rounded-full ring-offset-2 ring-offset-ring-offset transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            value === key ? "ring-2 ring-text" : "ring-1 ring-border-strong",
          )}
          data-bg={key}
        />
      ))}
    </div>
  );
}

