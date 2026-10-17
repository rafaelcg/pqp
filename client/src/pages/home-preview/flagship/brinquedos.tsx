import { Check, Eye, EyeOff, Hand, Lock, MessagesSquare, Palette, Shield, Slash, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { Clip, type ClipFocus, type ClipSources, Reveal, Tilt, stillImg } from "./cinema";
import "./brinquedos.css";
import { CARD, CONTAINER, Caption, Chip, Eyebrow, ExampleTag, H3, HEADER_GAP, Hi, Section, SectionHeader } from "./ui";

/**
 * #brinquedos: the details, as a bento of the real app. Every tile is
 * footage or a still recorded from pqp with sample people. The clips take
 * turns: while the bento is on screen one plays at a time, muted, the one
 * nearest the middle of the screen (or the one under the mouse, or the one
 * the visitor pressed play on). One tile stays a toy you can click
 * (per-channel permissions), and a row of "e também" chips carries the rest.
 */

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
  return (
    <Section id="brinquedos" labelledBy="brinquedos-title">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow="Recursos"
          titleId="brinquedos-title"
          title={
            <>
              Os detalhes que seguram a <Hi>bagunça</Hi>.
            </>
          }
          lede="Enquete, dado, fila pra falar, cargo com cor. O que a galera usa de verdade numa noite."
          aside={
            <Caption example className="mt-0 lg:pb-1.5">
              Telas gravadas do app de verdade, com gente de exemplo. As permissões são uma demonstração.
            </Caption>
          }
        />

        {/*
          One column on a phone, two from sm, the 8 and 4 bento from xl: wide,
          narrow | narrow, wide | the permissions toy across the whole row.
        */}
        <Reveal
          variant="scale"
          stagger={110}
          className={cn(HEADER_GAP, "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-12")}
        >
          <ChatTile />
          <HandTile />
          <MembersTile />
          <AppearanceTile />
          <PermissionTile />
        </Reveal>

        <Reveal className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <p className="shrink-0 text-sm font-medium text-paper">E também:</p>
          <ul className="flex flex-wrap gap-2">
            {[
              "threads",
              "mensagens fixadas",
              "GIFs",
              "anexos",
              "emoji do servidor",
              "@menções",
              "prévia de links",
              "busca na comunidade",
              "/flip e /draw",
              "registro de auditoria",
            ].map((item) => (
              <li key={item}>
                <Chip>{item}</Chip>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* The tile                                                            */
/* ------------------------------------------------------------------ */

/**
 * A tile that spans both columns turns, from lg, from "text, then the panel"
 * into "text on the left, panel on the right". A `screen` row is tall enough
 * for footage that runs to the bottom edge; a `toy` row takes its panel's
 * height.
 */
const ROW_TEXT = "lg:flex lg:w-[19rem] lg:shrink-0 lg:flex-col lg:justify-center lg:pb-8 lg:pr-2";
const ROW_FLEX = { screen: "lg:min-h-[26rem] lg:flex-row", toy: "lg:flex-row" } as const;

function Tile({
  icon: Icon,
  label,
  title,
  body,
  commands,
  className,
  row,
  tilt = 4,
  children,
}: {
  icon: typeof Hand;
  label: string;
  title: ReactNode;
  body: ReactNode;
  /** Slash commands the tile shows, drawn as small mono chips. */
  commands?: string[];
  /** Grid placement, on the tilting wrapper. */
  className?: string;
  /** Wide tile: puts the panel beside the text from lg instead of under it. */
  row?: keyof typeof ROW_FLEX;
  tilt?: number;
  children: ReactNode;
}) {
  return (
    <Tilt max={tilt} className={cn("rounded-3xl", className)}>
      <article
        className={cn(CARD, "bq-tile group/tile relative isolate flex h-full flex-col overflow-hidden", row && ROW_FLEX[row])}
      >
        <div className={cn("relative p-5 sm:p-8", row && ROW_TEXT)}>
          <Eyebrow tone="muted">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {label}
          </Eyebrow>
          <H3 className="mt-4 text-paper">{title}</H3>
          <p className="mt-3 max-w-[34rem] text-[15px] leading-relaxed text-paper-muted text-pretty">{body}</p>
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
    </Tilt>
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
  fadeTop = false,
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
  /** Soften the top edge, where a line of the app is cut. */
  fadeTop?: boolean;
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
      {fadeTop && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-8 bg-gradient-to-b from-ink to-transparent" />
      )}
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
  return (
    <Tile
      row="screen"
      tilt={2.5}
      icon={MessagesSquare}
      label="Chat"
      title="Enquete, dado e reação no meio da conversa."
      body="Escreve /poll e a galera vota na hora. /roll rola o dado na frente de todo mundo. Resposta, reação e GIF, como tem que ser."
      commands={["/poll", "/roll 1d20"]}
      className="sm:col-span-2 xl:col-span-8"
    >
      <Screen
        name="chat"
        label="O canal #geral do pqp: mensagens da galera, uma resposta, reações, uma enquete recebendo votos e uma rolagem de 1d20. Gente de exemplo."
        // From Bia's poll (a message boundary) to just under Leo's roll.
        lens={{ x0: 460, y0: 440, y1: 1055, narrow: { x0: 470, y0: 440, y1: 1160 } }}
        // On a phone: the lower part of the chat, where the votes and the roll land.
        focus={{ x: 0, y: 60, zoom: 1.2 }}
        drawn={1200}
        controlsClassName="bottom-3 right-3 top-auto"
        className={WIDE_PANEL}
      />
    </Tile>
  );
}

function HandTile() {
  return (
    <Tile
      icon={Hand}
      label="Na call"
      title="Levantou a mão, entrou na fila."
      body="Em call cheia, quem quer falar levanta a mão. A fila segue a ordem."
      className="xl:col-span-4"
    >
      <Screen
        name="raise-hand"
        label="Uma call com uma tela compartilhada no palco: Caio e depois Nico levantam a mão e a Fila pra falar mostra os dois em ordem. Gente de exemplo."
        // The Fila pra falar card, the call bar and the composer. The chat's last line is cut
        // above them, so the top edge fades out like text scrolling away.
        lens={{ x0: 216, y0: 880, y1: 1200 }}
        // On a phone: the queue card and the people in the call, a little closer.
        focus={{ x: 0, y: 30, zoom: 1.25 }}
        drawn={1250}
        controlsClassName="bottom-3 right-3 top-auto"
        fadeTop
        className="mx-4 mt-auto h-[13rem] rounded-t-2xl sm:mx-5"
      />
    </Tile>
  );
}

function MembersTile() {
  return (
    <Tile
      icon={Shield}
      label="Cargos"
      title="Cada cargo com a sua cor."
      body="Dono, admin, mod, VIP ou o cargo que vocês inventarem. Quem tá na call aparece na lista."
      className="xl:col-span-4"
    >
      <Strip
        src="still-members.webp"
        width={480}
        height={1280}
        alt="A lista de membros de um servidor no pqp, separada por cargo: Dono, Mestre e Jogadores, cada um com a sua cor, e quem está na call. Gente de exemplo."
        shift={0.1}
      />
    </Tile>
  );
}

function AppearanceTile() {
  return (
    <Tile
      row="screen"
      tilt={2.5}
      icon={Palette}
      label="Aparência"
      title="O app com a cara da galera."
      body="Claro, escuro ou do sistema, mais de um visual e a sua cor de destaque. Muda na hora e vale em todo aparelho."
      className="sm:col-span-2 xl:col-span-8"
    >
      <Screen
        name="appearance"
        label="Configurações, Aparência e idioma: o modo claro e o escuro, os visuais Lareira e Harmonia e as cores de destaque mudando o app na hora. Gente de exemplo."
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

type Tri = "permitir" | "herdar" | "negar";
const TRI: { id: Tri; label: string; icon: typeof Check; on: string }[] = [
  { id: "permitir", label: "Permitir", icon: Check, on: "bg-success/20 text-paper ring-success/50" },
  { id: "herdar", label: "Herdar", icon: Slash, on: "bg-white/10 text-paper ring-white/25" },
  { id: "negar", label: "Negar", icon: X, on: "bg-danger/20 text-paper ring-danger/50" },
];

function PermissionTile() {
  const [everyone, setEveryone] = useState<Tri>("negar");
  const [vip, setVip] = useState<Tri>("permitir");
  // The server default lets everyone see channels. An overwrite on the
  // channel wins; "herdar" falls through to the level above.
  const memberSees = everyone !== "negar";
  const vipSees = vip === "permitir" ? true : vip === "negar" ? false : memberSees;

  const row = (role: ReactNode, value: Tri, set: (t: Tri) => void, name: string) => (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{role}</span>
      <div role="group" aria-label={`Ver canal, ${name}`} className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.03] p-1">
        {TRI.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={value === t.id}
            onClick={() => set(t.id)}
            className={cn(
              "inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors",
              value === t.id ? cn("ring-1 ring-inset", t.on) : "text-paper-muted hover:text-paper",
              FOCUS,
            )}
          >
            <t.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Tile
      row="toy"
      tilt={2}
      icon={Lock}
      label="Permissões"
      title="Permitir, herdar ou negar."
      body="Cargo por cargo, canal por canal. É assim que nasce um canal privado. Clica aí e vê quem enxerga o quê."
      className="sm:col-span-2 xl:col-span-12"
    >
      {/* Across the whole row from lg, the two cargos sit side by side, like the app's own settings. */}
      <div className="bq-panel relative mx-4 mb-4 rounded-2xl bg-ink p-5 ring-1 ring-inset ring-white/[0.09] sm:mx-5 sm:mb-5 lg:m-8 lg:ml-4 lg:min-w-0 lg:flex-1 lg:self-center lg:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="flex items-center gap-1.5 text-sm text-paper-muted">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Canal <span className="font-medium text-paper"># planos-secretos</span>
          </p>
          <span className="flex shrink-0 items-center gap-2">
            <ExampleTag />
            <span className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-paper-muted ring-1 ring-inset ring-white/[0.07]">
              Ver canal
            </span>
          </span>
        </div>
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
          {row(<span className="text-paper-muted">@everyone</span>, everyone, setEveryone, "@everyone")}
          {row(<span className="text-violet-300">VIP</span>, vip, setVip, "VIP")}
        </div>
        <div aria-live="polite" className="mt-5 flex flex-wrap gap-2 border-t border-white/[0.06] pt-5 text-xs">
          <Sees who="Membro" yes={memberSees} />
          <Sees who="VIP" yes={vipSees} />
        </div>
      </div>
    </Tile>
  );
}

function Sees({ who, yes }: { who: string; yes: boolean }) {
  const Icon = yes ? Eye : EyeOff;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset transition-colors",
        yes ? "bg-success/10 text-paper ring-success/30" : "bg-white/[0.03] text-paper-muted ring-white/10",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {who} {yes ? "vê o canal" : "não vê"}
    </span>
  );
}
