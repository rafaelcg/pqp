import { Check, Eye, EyeOff, Lock, Slash, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Clip, type ClipFocus, type ClipSources, stillImg } from "./cinema";
import "./brinquedos.css";
import { rich } from "./rich";
import { CARD, CONTAINER, Caption, Eyebrow, ExampleTag, H3, HEADER_GAP, Section, SectionHeader } from "./ui";

/**
 * #brinquedos: the details, as a bento of the real app. Every tile is
 * footage or a still recorded from pqp with sample people. The clips take
 * turns: while the bento is on screen one plays at a time, muted, the one
 * nearest the middle of the screen (or the one under the mouse, or the one
 * the visitor pressed play on). One tile stays a toy you can click
 * (per-channel permissions), and the last tile lists the rest in plain words.
 *
 * Nothing in the section reveals on scroll or tilts, and no tile spans the
 * whole row: at xl the rows are 8 + 4, 4 + 8 and 7 + 5.
 *
 * The section also answers the old anchors `/#features`, `/#chat` and
 * `/#roles` (the shared nav and footer link `/#features`), through
 * `Section`'s `aliases`.
 */

/** Older ids that land on this section (PLAN.md decision 19). */
const ALIASES = ["features", "chat", "roles"] as const;

/** The "e também" list, in reading order. Translated at render. */
const ALSO = [
  "home.toys.also.threads",
  "home.toys.also.pins",
  "home.toys.also.gifs",
  "home.toys.also.attachments",
  "home.toys.also.emoji",
  "home.toys.also.mentions",
  "home.toys.also.linkPreviews",
  "home.toys.also.search",
  "home.toys.also.flipDraw",
  "home.toys.also.auditLog",
] as const satisfies readonly MessageKey[];

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink-2";

const MEDIA = "/media/home/";

/** The bento's clips share one turn (see `Clip group`). */
const GROUP = "brinquedos";

type TileClip = "chat" | "raise-hand" | "appearance";

/**
 * A clip's files without its poster: the first frame of these loops is the
 * empty start of the scene, so the base layer stays the richer still (the
 * scene's end state) until the video actually plays.
 */
function footage(name: TileClip): ClipSources {
  return {
    webm: `${MEDIA}${name}.webm`,
    mp4: `${MEDIA}${name}.mp4`,
    webmSmall: `${MEDIA}${name}-960.webm`,
    mp4Small: `${MEDIA}${name}-960.mp4`,
  };
}

/**
 * Where a screen looks, in pixels of the 1920 by 1200 recording: `x0` is the
 * column that sits on the panel's left edge, `y0` to `y1` is the band of rows
 * that fills the panel's height. The panel then shows as much width as it has,
 * so a wider panel never zooms, it only reveals more of the row.
 */
type Lens = { x0: number; y0: number; y1: number; narrow?: { x0: number; y0: number; y1: number } };

function lensStyle(l: Lens): CSSProperties {
  const n = l.narrow;
  return {
    "--x0": l.x0,
    "--y0": l.y0,
    "--y1": l.y1,
    ...(n ? { "--nx0": n.x0, "--ny0": n.y0, "--ny1": n.y1 } : null),
  } as CSSProperties;
}

export function Brinquedos() {
  const { t } = useTranslation();
  return (
    <Section id="brinquedos" aliases={ALIASES} labelledBy="brinquedos-title" className="pt-16 sm:pt-20">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow={t("home.toys.eyebrow")}
          titleId="brinquedos-title"
          title={rich(t("home.toys.title"), { accent: t("home.toys.titleAccent") })}
          lede={t("home.toys.lede")}
          aside={
            <Caption example className="mt-0 lg:pb-1.5">
              {t("home.toys.caption")}
            </Caption>
          }
        />

        {/*
          One column on a phone, two from sm, twelve from xl. At xl three rows,
          none of them across the whole row: chat 8 + hand 4, roles 4 +
          appearance 8, permissions 7 + the rest 5. From sm to below xl the
          wide tiles take both columns and the two small ones share a row.
        */}
        <div className={cn(HEADER_GAP, "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-12")}>
          <ChatTile />
          <HandTile />
          <MembersTile />
          <AppearanceTile />
          <PermissionTile />
          <AlsoTile />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* The tile                                                            */
/* ------------------------------------------------------------------ */

/**
 * A `wide` tile turns, from lg, from "text, then the panel" into "text on the
 * left, panel on the right", and is tall enough for footage that runs to the
 * bottom edge. Every other tile keeps the text on top and the panel under it.
 */
const WIDE_TEXT = "lg:flex lg:w-[19rem] lg:shrink-0 lg:flex-col lg:justify-center lg:pb-8 lg:pr-2";
const WIDE_TILE = "lg:min-h-[26rem] lg:flex-row";

function Tile({
  label,
  title,
  body,
  commands,
  className,
  wide = false,
  children,
}: {
  label: string;
  title: ReactNode;
  body?: ReactNode;
  /** Slash commands the tile shows, drawn as small mono chips. */
  commands?: string[];
  /** Grid placement. */
  className?: string;
  /** Puts the panel beside the text from lg instead of under it. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article className={cn(CARD, "bq-tile relative isolate flex h-full flex-col overflow-hidden", wide && WIDE_TILE, className)}>
      <div className={cn("relative p-5 sm:p-8", wide && WIDE_TEXT)}>
        <Eyebrow>{label}</Eyebrow>
        <H3 className="mt-4 text-paper">{title}</H3>
        {body && <p className="mt-3 max-w-[34rem] text-[15px] leading-relaxed text-paper-muted text-pretty">{body}</p>}
        {commands && (
          <p className="mt-4 flex flex-wrap gap-1.5">
            {commands.map((c) => (
              <span
                key={c}
                className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-paper-muted ring-1 ring-inset ring-white/[0.07]"
              >
                {c}
              </span>
            ))}
          </p>
        )}
      </div>
      {children}
    </article>
  );
}

/**
 * A screen inside a tile. The panel is a window onto the recording: the
 * `Lens` says which rows and which column start at its edge (see `.bq-lens`).
 * Its clip takes turns with the bento's others and uses the 960-wide files,
 * so a bento of clips stays light. On a phone `focus` crops in on the
 * action (inside the lens its x and y are points of the panel). The play
 * control sits where the footage is empty (`controlsClassName`), never over
 * the thing the tile is about.
 */
function Screen({
  name,
  label,
  lens,
  focus,
  drawn,
  className,
  controlsClassName = "top-3 right-3 bottom-auto",
}: {
  name: TileClip;
  label: string;
  lens: Lens;
  focus: ClipFocus;
  /**
   * How wide the lens draws the still from lg, in CSS pixels (the panel's
   * height times 1200 over the lens band, times 1.6): the still's `sizes`.
   */
  drawn: number;
  className?: string;
  controlsClassName?: string;
}) {
  return (
    <div className={cn("bq-panel relative shrink-0 overflow-hidden bg-ink", className)}>
      <div className="bq-lens absolute inset-0" style={lensStyle(lens)}>
        <Clip
          src={footage(name)}
          small
          group={GROUP}
          fallbackStill={stillImg(name, label, `${drawn}px`)}
          label={label}
          focus={focus}
          controlsClassName={controlsClassName}
        />
      </div>
      <span aria-hidden className="pointer-events-none absolute inset-0 z-[3] rounded-[inherit] ring-1 ring-inset ring-white/[0.09]" />
    </div>
  );
}

/** Where a wide tile's screen goes: inset under the text, then flush right and bottom beside it. */
const WIDE_PANEL =
  "h-[19rem] rounded-t-2xl sm:mx-auto sm:w-[calc(100%-4rem)] sm:max-w-[30rem] lg:m-0 lg:ml-auto lg:mt-8 lg:h-[24rem] lg:w-auto lg:min-w-0 lg:max-w-[30rem] lg:flex-1 lg:self-end lg:rounded-r-none lg:rounded-tl-[18px]";

/**
 * A tall, narrow capture of one part of the app (a sidebar), standing in the
 * tile like a strip of the real screen. On hover it slides up a little to
 * show more.
 */
function Strip({
  src,
  width,
  height,
  alt,
  className,
  shift = 0,
}: {
  src: string;
  width: number;
  height: number;
  alt: string;
  className?: string;
  /** How far up the capture starts, as a share of its own height (0 to 1). */
  shift?: number;
}) {
  return (
    <div className={cn("bq-panel relative mx-auto mt-auto h-[13rem] w-[17rem] sm:h-[15rem] shrink-0 overflow-hidden rounded-t-[18px] bg-ink", className)}>
      <img
        src={`${MEDIA}${src}`}
        width={width}
        height={height}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="bq-strip absolute inset-x-0 top-0 h-auto w-full"
        style={{ "--strip-y": `${-shift * 100}%` } as CSSProperties}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-20 bg-gradient-to-t from-ink-2 to-transparent"
      />
      <span aria-hidden className="pointer-events-none absolute inset-0 z-[3] rounded-[inherit] ring-1 ring-inset ring-white/[0.09]" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiles                                                               */
/* ------------------------------------------------------------------ */

function ChatTile() {
  const { t } = useTranslation();
  return (
    <Tile
      wide
      label={t("home.toys.chat.label")}
      title={t("home.toys.chat.title")}
      body={t("home.toys.chat.body")}
      // literal-ok: slash commands, typed the same in every language
      commands={["/poll", "/roll 1d20"]}
      className="sm:col-span-2 xl:col-span-8"
    >
      <Screen
        name="chat"
        label={t("home.toys.chat.alt")}
        // From Bia's poll (a message boundary) to just under Leo's roll. The "is typing" line
        // sits on rows 1049 to 1063 and the composer starts near row 1077, so the band ends
        // above both and a half-cut line never shows, on a phone too.
        lens={{ x0: 460, y0: 440, y1: 1046, narrow: { x0: 470, y0: 440, y1: 1046 } }}
        // On a phone: the poll and the roll, at the panel's own size.
        focus={{ x: 0, y: 60, zoom: 1 }}
        drawn={1200}
        controlsClassName="bottom-3 right-3 top-auto"
        className={WIDE_PANEL}
      />
    </Tile>
  );
}

function HandTile() {
  const { t } = useTranslation();
  return (
    <Tile
      label={t("home.toys.hand.label")}
      title={t("home.toys.hand.title")}
      body={t("home.toys.hand.body")}
      className="xl:col-span-4"
    >
      <Screen
        name="raise-hand"
        label={t("home.toys.hand.alt")}
        // Down through the Fila pra falar card, the call bar and the composer. The card is
        // anchored to the bottom and grows upward as hands go up, so its top edge sits at rows
        // 1004, 925 and 896 of the 1920 by 1200 recording (no hand, Caio, Caio and Nico). The band
        // starts at 902, just below the two-hand edge, so the queue heading (rows 923 to 937) has
        // clear card above it in the longest state. Above the card is the call chat, filmed tall
        // (the recorder moves the call's divider up first), so its few lines sit far above the
        // band and the rows over the card are the chat's own empty background in every state
        // and in the still, which comes from the same take.
        lens={{ x0: 216, y0: 902, y1: 1200 }}
        // On a phone: the same band, no crop.
        focus={{ x: 0, y: 30, zoom: 1 }}
        drawn={1340}
        controlsClassName="bottom-3 right-3 top-auto"
        className="mx-4 mt-auto h-[13rem] rounded-t-2xl sm:mx-5"
      />
    </Tile>
  );
}

function MembersTile() {
  const { t } = useTranslation();
  return (
    <Tile
      label={t("home.toys.roles.label")}
      title={t("home.toys.roles.title")}
      body={t("home.toys.roles.body")}
      className="xl:col-span-4"
    >
      <Strip
        src="still-members.webp"
        width={480}
        height={1280}
        alt={t("home.toys.roles.alt")}
        shift={0.1}
      />
    </Tile>
  );
}

function AppearanceTile() {
  const { t } = useTranslation();
  return (
    <Tile
      wide
      label={t("home.toys.looks.label")}
      title={t("home.toys.looks.title")}
      body={t("home.toys.looks.body")}
      className="sm:col-span-2 xl:col-span-8"
    >
      <Screen
        name="appearance"
        label={t("home.toys.looks.alt")}
        // From the Noite and Halloween row (a clean edge) down to the accent colours.
        lens={{ x0: 692, y0: 212, y1: 918, narrow: { x0: 670, y0: 212, y1: 1180 } }}
        // On a phone: the looks and the accent colours, closer.
        focus={{ x: 0, y: 40, zoom: 1.3 }}
        drawn={1050}
        className={WIDE_PANEL}
      />
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/* Per-channel permission (the one toy)                                */
/* ------------------------------------------------------------------ */

type Tri = "allow" | "inherit" | "deny";
const TRI: { id: Tri; label: MessageKey; icon: typeof Check; on: string }[] = [
  { id: "allow", label: "home.toys.perm.allow", icon: Check, on: "bg-success/20 text-paper ring-success/50" },
  { id: "inherit", label: "home.toys.perm.inherit", icon: Slash, on: "bg-white/10 text-paper ring-white/25" },
  { id: "deny", label: "home.toys.perm.deny", icon: X, on: "bg-danger/20 text-paper ring-danger/50" },
];

/**
 * The permissions toy. The tile is stacked at every width (text on top, the
 * panel under it, no empty band between them). The two role groups sit side
 * by side once the panel has about 600 px, and stack below that, by a
 * container query on the panel's own width (not the screen's), so the same
 * panel works in the 7-column tile at xl (about 612 px, side by side) and in
 * a full-width tile below it. In a full-width tile the panel stops growing at
 * 44rem and stays at the text's left edge: wider than that the buttons would
 * stretch, and the empty space beside it is the tile's own.
 */
function PermissionTile() {
  const { t } = useTranslation();
  const [everyone, setEveryone] = useState<Tri>("deny");
  const [vip, setVip] = useState<Tri>("allow");
  // The server default lets everyone see channels. An overwrite on the
  // channel wins; "inherit" falls through to the level above.
  const memberSees = everyone !== "deny";
  const vipSees = vip === "allow" ? true : vip === "deny" ? false : memberSees;

  const row = (role: ReactNode, value: Tri, set: (next: Tri) => void, name: string) => (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{role}</span>
      <div
        role="group"
        aria-label={t("home.toys.perm.group", { role: name })}
        className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.03] p-1"
      >
        {TRI.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => set(option.id)}
            className={cn(
              "inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold transition-colors duration-200 ease-out",
              value === option.id ? cn("ring-1 ring-inset", option.on) : "text-paper-muted hover:text-paper",
              FOCUS,
            )}
          >
            <option.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Tile
      label={t("home.toys.perm.label")}
      title={t("home.toys.perm.title")}
      body={t("home.toys.perm.body")}
      className="sm:col-span-2 xl:col-span-7"
    >
      <div className="@container mx-4 mb-4 mt-auto sm:mx-5 sm:mb-5">
        <div className="bq-panel w-full max-w-[44rem] rounded-2xl bg-ink p-4 ring-1 ring-inset ring-white/[0.09] sm:p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="flex items-center gap-1.5 text-sm text-paper-muted">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {rich(t("home.toys.perm.channel"), {
                  channel: <span className="font-medium text-paper"># {t("home.toys.perm.channelName")}</span>,
                })}
              </span>
            </p>
            <span className="flex shrink-0 items-center gap-2">
              <ExampleTag />
              <span className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-paper-muted ring-1 ring-inset ring-white/[0.07]">
                {t("home.toys.perm.viewChannel")}
              </span>
            </span>
          </div>
          <div className="grid gap-4 @min-[37.5rem]:grid-cols-2 @min-[37.5rem]:gap-5">
            {/* literal-ok:begin role names, the same in every language (the app's own @everyone and a sample VIP role) */}
            {row(<span className="text-paper-muted">@everyone</span>, everyone, setEveryone, "@everyone")}
            {row(<span className="text-violet-300">VIP</span>, vip, setVip, "VIP")}
          </div>
          <div aria-live="polite" className="mt-5 flex flex-wrap gap-2 border-t border-white/[0.06] pt-5 text-xs">
            <Sees who={t("home.toys.perm.member")} yes={memberSees} />
            <Sees who="VIP" yes={vipSees} />
            {/* literal-ok:end */}
          </div>
        </div>
      </div>
    </Tile>
  );
}

function Sees({ who, yes }: { who: string; yes: boolean }) {
  const { t } = useTranslation();
  const Icon = yes ? Eye : EyeOff;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset transition-colors duration-200 ease-out",
        yes ? "bg-success/10 text-paper ring-success/30" : "bg-white/[0.03] text-paper-muted ring-white/10",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(yes ? "home.toys.perm.sees" : "home.toys.perm.blind", { role: who })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* And also                                                            */
/* ------------------------------------------------------------------ */

/**
 * The rest of the features, as the bento's fifth tile: the same chrome as the
 * others and a plain list under a short title (no chips, no icons). The list
 * runs down its columns, in reading order: two columns in the narrow tile
 * (and on a phone), five across when the tile has the whole row.
 */
function AlsoTile() {
  const { t } = useTranslation();
  return (
    <Tile label={t("home.toys.also.label")} title={t("home.toys.also.title")} className="sm:col-span-2 xl:col-span-5">
      <ul className="mx-5 mb-5 mt-auto grid grid-flow-col grid-cols-2 grid-rows-5 gap-x-4 sm:mx-8 sm:mb-8 sm:gap-x-6 lg:grid-cols-5 lg:grid-rows-2 xl:grid-cols-2 xl:grid-rows-5">
        {ALSO.map((key) => (
          <li key={key} className="border-t border-white/[0.06] py-3.5 text-[15px] leading-snug text-paper-muted sm:text-base">
            {t(key)}
          </li>
        ))}
      </ul>
    </Tile>
  );
}
