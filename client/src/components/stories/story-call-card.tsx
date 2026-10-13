import { useEffect, useRef, useState } from "react";
import type { StoryCallLive } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Chama pra call": the card a story carries to a voice room.
 *
 * It is the same card on the author's canvas (a preview of the room as it is
 * now), in the viewer (the live roster the server read when it served the
 * story) and on the phones: the room's name and the server's icon, up to three
 * live faces and the count, a pulsing live dot while people are in, one
 * "Entrar" button, and honest states for a room nobody is in, a room that
 * filled up, and one that is over. Every length is a fraction of the canvas
 * width, so it scales with the story and not with the window.
 */

export interface CallCardServer {
  name: string;
  iconUrl: string | null;
}

export type CallCardState = "live" | "empty" | "full" | "ended";

/** What the card says, decided apart from drawing it so the rules have a test. */
export function callCardState(call: StoryCallLive | null, previewCount = 0): CallCardState {
  if (!call) {
    return previewCount > 0 ? "live" : "empty";
  }
  if (call.state === "ended") {
    return "ended";
  }
  if (call.state === "full") {
    return "full";
  }
  return call.count > 0 ? "live" : "empty";
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function formatList(names: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function ServerTile({ server, fallback }: { server: CallCardServer | null; fallback: string }) {
  const [broken, setBroken] = useState(false);
  const label = server?.name ?? fallback;
  return (
    <span
      data-story-call-server=""
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden font-display font-extrabold"
      style={{
        height: "11cqw",
        width: "11cqw",
        borderRadius: "2.8cqw",
        fontSize: "5cqw",
        background: "var(--story-field-fill)",
        color: "var(--story-on-media)",
        boxShadow: "inset 0 0 0 1px var(--story-hairline)",
      }}
    >
      {server?.iconUrl && !broken ? (
        <img
          src={server.iconUrl}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        [...label.trim()][0]?.toUpperCase() ?? "#"
      )}
    </span>
  );
}

export function StoryCallCard({
  call,
  preview,
  server,
  onJoin,
  className,
  passThrough = false,
}: {
  /** The live state, from the story. Null on the author's canvas before posting. */
  call: StoryCallLive | null;
  /** The room as the composer knows it, before there is a live roster. */
  preview: { channelName: string; names: string[]; authorAway?: boolean } | null;
  server: CallCardServer | null;
  onJoin?: (call: StoryCallLive) => void;
  className?: string;
  /** Let pointer events through to whatever holds the card (the editor's layer gestures). */
  passThrough?: boolean;
}) {
  const { t, locale } = useTranslation();
  // The author's preview knows only first names; their initials stand in for faces.
  const people = call
    ? call.participants
    : (preview?.names ?? []).map((name, index) => ({ id: `preview-${index}`, displayName: name, avatarUrl: null }));
  const names = call ? people.map((person) => firstName(person.displayName)) : (preview?.names ?? []);
  const count = call ? call.count : names.length;
  // The server keeps a call open only while its author is in the room, so a card for a room the
  // author is not in is what viewers will see: over.
  const state = !call && preview?.authorAway ? "ended" : callCardState(call, count);
  const channelName = call?.channelName ?? preview?.channelName ?? "";
  const shownNames = names.slice(0, 3);
  const extra = Math.max(0, count - shownNames.length);
  const list = shownNames.length > 0 ? formatList(shownNames, locale) : "";

  // A face that arrives while the card is open pops in, the way the sidebar's does.
  const seenFaces = useRef(new Set(people.map((person) => person.id)));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const arrived = people.filter((person) => !seenFaces.current.has(person.id));
    for (const person of arrived) {
      seenFaces.current.add(person.id);
    }
    if (arrived.length > 0) {
      setFresh(new Set(arrived.map((person) => person.id)));
    }
    // Faces are keyed by id; the array identity changes on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people.map((person) => person.id).join(",")]);

  const label =
    state === "ended"
      ? t("stories.call.ended")
      : state === "full"
        ? t("stories.call.full")
        : state === "empty"
          ? t("stories.call.empty")
          : t("stories.call.live");
  const canJoin = Boolean(call && call.joinable && onJoin && (state === "live" || state === "empty"));
  // The author's preview has no join handler, but still shows the button the card will have.
  const previewButton = !call && Boolean(preview) && state !== "ended";

  const live = state === "live";
  const ended = state === "ended";
  const joinPill = {
    height: "auto",
    gap: "1.4cqw",
    borderRadius: "9999px",
    padding: "1.7cqw 3cqw",
    fontSize: "3.6cqw",
    background: "var(--story-accent)",
    color: "var(--story-on-accent)",
  } as const;

  // One wide, compact row, the same card the phones draw: the server's tile, the status and the
  // room, up to three faces, and the lime "Entrar". It is a share of the canvas width (0.82) and
  // about 12% of its height, so it hides little of the story.
  return (
    <div
      data-story-call=""
      data-story-call-state={state}
      className={cn("flex w-full items-center text-left", className)}
      style={{
        padding: "3cqw",
        borderRadius: "5cqw",
        border: `0.4cqw solid ${ended ? "rgb(255 255 255 / 0.25)" : "color-mix(in oklab, var(--story-accent) 75%, transparent)"}`,
        background: ended ? "rgb(0 0 0 / 0.5)" : "rgb(0 0 0 / 0.66)",
        boxShadow: "var(--story-shadow)",
        opacity: ended ? 0.72 : 1,
      }}
      // In the viewer a tap on the card is its own (it must not turn the page). On the editor's canvas
      // the card is a layer, and the drag belongs to the canvas.
      onPointerDown={passThrough ? undefined : (event) => event.stopPropagation()}
      onClick={passThrough ? undefined : (event) => event.stopPropagation()}
    >
      <ServerTile server={server} fallback={channelName} />
      <div className="min-w-0 flex-1" style={{ padding: "0 2.8cqw" }}>
        <p
          className="flex items-center font-bold uppercase leading-tight"
          style={{
            gap: "1.2cqw",
            fontSize: "2.7cqw",
            letterSpacing: "0.06em",
            color: live ? "var(--story-accent-soft)" : "var(--story-on-media-2)",
          }}
        >
          <span
            aria-hidden
            className={cn("shrink-0 rounded-full", live && "story-live-dot")}
            style={{
              height: "1.8cqw",
              width: "1.8cqw",
              background: live ? "var(--story-accent)" : "var(--story-on-media-2)",
            }}
          />
          <span className="truncate">{label}</span>
        </p>
        <p
          className="truncate font-display font-extrabold leading-tight"
          style={{ fontSize: "5cqw", color: "var(--story-on-media)" }}
        >
          {channelName}
        </p>
        {server && (
          <p className="truncate leading-tight" style={{ fontSize: "2.9cqw", color: "var(--story-on-media-2)" }}>
            {server.name}
          </p>
        )}
      </div>

      {!ended && people.length > 0 && (
        <span
          className="flex shrink-0 items-center"
          data-story-call-faces=""
          role="img"
          aria-label={`${t("stories.call.count", { count })}: ${extra > 0 ? t("stories.call.people", { count: extra, names: list }) : list}`}
          style={{ marginRight: "1.4cqw" }}
        >
          {people.slice(0, 3).map((person, index) => (
            <span
              key={person.id}
              className={cn("rounded-full", fresh.has(person.id) && "animate-badge-pop")}
              style={{ marginLeft: index > 0 ? "-1.4cqw" : 0, boxShadow: "0 0 0 0.4cqw rgb(0 0 0)" }}
            >
              <UserAvatar
                name={person.displayName}
                avatarUrl={person.avatarUrl}
                rounded="full"
                className="!h-[7cqw] !w-[7cqw]"
                fallbackClassName="bg-surface-3 !text-[2.8cqw] text-text"
              />
            </span>
          ))}
          {extra > 0 && (
            <span
              data-story-call-count=""
              className="flex items-center justify-center rounded-full font-display font-extrabold tabular-nums"
              style={{
                marginLeft: "-1.4cqw",
                height: "7cqw",
                width: "7cqw",
                fontSize: "2.8cqw",
                background: "rgb(255 255 255 / 0.22)",
                color: "var(--story-on-media)",
                boxShadow: "0 0 0 0.4cqw rgb(0 0 0)",
              }}
            >
              +{extra}
            </span>
          )}
        </span>
      )}

      {(canJoin || previewButton) &&
        (canJoin && call ? (
          <button
            type="button"
            data-story-join=""
            aria-label={`${t("stories.call.join")}: ${channelName}`}
            onClick={() => onJoin?.(call)}
            className="inline-flex shrink-0 items-center whitespace-nowrap font-display font-extrabold transition-[transform,filter] hover:brightness-105 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
            style={joinPill}
          >
            {t("stories.call.enter")}
          </button>
        ) : (
          <span aria-hidden className="inline-flex shrink-0 items-center whitespace-nowrap font-display font-extrabold" style={joinPill}>
            {t("stories.call.enter")}
          </span>
        ))}
    </div>
  );
}
