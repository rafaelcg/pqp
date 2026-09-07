import {
  BarChart3,
  Check,
  Dices,
  Hash,
  Headphones,
  Mic,
  MicOff,
  Minus,
  MonitorUp,
  Pin,
  Play,
  Search,
  Settings,
  Volume2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Product mockups for the landing page, drawn in CSS from the app's own
 * tokens rather than captured as screenshots.
 *
 * WHY NOT SCREENSHOTS. A PNG of the app is stale the week after it is taken,
 * cannot follow the visitor's language, and paints at one density. These
 * frames use the same surface, accent and role colours the app does, so a
 * theme change moves them too, and every visible string goes through the
 * catalogue like the rest of the page.
 *
 * WHAT THEY MAY SHOW. Only things the product does today: a voice channel with
 * a roster, a screen share with tab audio, replies, threads, reactions, pins,
 * polls, the chance commands, and the three-state permission editor. If a
 * feature is removed, remove its frame rather than keeping a picture of it.
 *
 * They are decorative. Every frame is `aria-hidden`; the copy beside it is the
 * accessible statement of the same fact.
 */

interface Person {
  name: string;
  /** Two letters for the avatar. */
  initials: string;
  /** Avatar tint, chosen from the role palette the app seeds. */
  tone: "gold" | "wine" | "blue" | "teal" | "lilac" | "plain";
  speaking?: boolean;
  muted?: boolean;
}

const PEOPLE: Person[] = [
  { name: "Rafa", initials: "RA", tone: "gold", speaking: true },
  { name: "Bia", initials: "BI", tone: "teal" },
  { name: "Caio", initials: "CA", tone: "wine", speaking: true },
  { name: "Nico", initials: "NI", tone: "lilac", muted: true },
  { name: "Dani", initials: "DA", tone: "blue" },
];

const TONE: Record<Person["tone"], string> = {
  gold: "bg-[oklch(0.78_0.14_85)] text-[oklch(0.25_0.05_85)]",
  wine: "bg-[oklch(0.55_0.16_15)] text-white",
  blue: "bg-[oklch(0.62_0.15_250)] text-white",
  teal: "bg-[oklch(0.68_0.12_190)] text-[oklch(0.2_0.04_190)]",
  lilac: "bg-[oklch(0.72_0.12_300)] text-[oklch(0.25_0.05_300)]",
  plain: "bg-ink-3 text-paper",
};

function Avatar({
  person,
  size = "md",
  ring = false,
}: {
  person: Person;
  size?: "sm" | "md" | "lg";
  ring?: boolean;
}) {
  const dim = size === "sm" ? "h-5 w-5 text-[8px]" : size === "lg" ? "h-10 w-10 text-xs" : "h-7 w-7 text-[10px]";
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold",
        dim,
        TONE[person.tone],
        ring &&
          person.speaking &&
          "ring-2 ring-signal ring-offset-2 ring-offset-ink-2 shadow-[var(--shadow-speaking)]",
      )}
    >
      {person.initials}
    </span>
  );
}

/** The window chrome every frame shares. */
function Frame({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/10 bg-ink-2 text-paper shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]",
        className,
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-white/5 bg-ink px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        {label && (
          <span className="ml-3 truncate text-[10px] font-medium text-paper-muted/70">
            {label}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Rail() {
  return (
    <div className="hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-white/5 bg-rail py-3 sm:flex">
      <span className="h-8 w-8 rounded-xl bg-ink-3" />
      <span className="h-8 w-8 rounded-xl bg-signal font-display text-[10px] font-bold text-ink grid place-items-center">
        RF
      </span>
      <span className="h-8 w-8 rounded-xl bg-ink-3" />
      <span className="h-8 w-8 rounded-xl bg-ink-3" />
    </div>
  );
}

/**
 * The hero: a community with a voice channel in progress, a screen share on
 * the stage and the chat under it. It is the one picture that has to say
 * "voice, screen and chat, in one place" before anyone reads a word.
 */
export function HeroFrame({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Frame className={cn("mx-auto w-full max-w-5xl", className)} label="pqp.gg/app">
      <div className="flex h-[420px] sm:h-[480px]">
        <Rail />
        <div className="hidden w-52 shrink-0 flex-col border-r border-white/5 bg-ink-2 md:flex">
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
            <span className="font-display text-sm font-bold">{t("landing.mock.community")}</span>
            <Settings className="h-3.5 w-3.5 text-paper-muted" />
          </div>
          <div className="px-3 pt-3">
            <div className="flex items-center gap-2 rounded-md bg-ink px-2 py-1.5 text-[11px] text-paper-muted">
              <Search className="h-3 w-3" />
              {t("landing.mock.search")}
            </div>
          </div>
          <div className="mt-3 px-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-paper-muted/70">
              {t("landing.mock.textHeading")}
            </p>
            <ul className="mt-1.5 space-y-0.5 text-[12px]">
              <li className="flex items-center gap-1.5 rounded px-1.5 py-1 text-paper-muted">
                <Hash className="h-3 w-3" /> geral
              </li>
              <li className="flex items-center gap-1.5 rounded px-1.5 py-1 text-paper-muted">
                <Hash className="h-3 w-3" /> clips
              </li>
              <li className="flex items-center gap-1.5 rounded px-1.5 py-1 text-paper-muted">
                <Hash className="h-3 w-3" /> memes
              </li>
            </ul>
            <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-paper-muted/70">
              {t("landing.mock.voiceHeading")}
            </p>
            <ul className="mt-1.5 text-[12px]">
              <li className="flex items-center gap-1.5 rounded bg-signal/10 px-1.5 py-1 font-medium text-signal">
                <Mic className="h-3 w-3" /> {t("landing.mock.voiceChannel")}
                <span className="ml-auto text-[10px] text-paper-muted">5</span>
              </li>
              {PEOPLE.map((p) => (
                <li key={p.name} className="flex items-center gap-2 py-1 pl-5 text-[11px] text-paper-muted">
                  <Avatar person={p} size="sm" ring />
                  <span className={cn(p.speaking && "text-paper")}>{p.name}</span>
                  {p.muted && <MicOff className="ml-auto h-3 w-3 text-danger" />}
                  {p.name === "Rafa" && <MonitorUp className="ml-auto h-3 w-3 text-signal" />}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-auto border-t border-white/5 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {t("landing.mock.connected")}
            </p>
            <p className="mt-0.5 text-[10px] text-paper-muted">
              {t("landing.mock.inChannel")}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-ink">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
            <Mic className="h-3.5 w-3.5 text-paper-muted" />
            <span className="font-display text-sm font-bold">{t("landing.mock.voiceChannel")}</span>
            <span className="text-[11px] text-paper-muted">· 5</span>
            <span className="ml-auto flex items-center gap-1.5 rounded-full bg-signal/15 px-2 py-0.5 text-[10px] font-semibold text-signal">
              <MonitorUp className="h-3 w-3" /> {t("landing.mock.sharing")}
            </span>
          </div>

          <div className="relative m-3 flex-1 overflow-hidden rounded-xl bg-[radial-gradient(120%_100%_at_30%_0%,oklch(0.32_0.06_250)_0%,oklch(0.14_0.02_250)_60%)]">
            <div className="absolute inset-0 grid place-items-center">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-white/10 backdrop-blur">
                <Play className="ml-0.5 h-6 w-6 text-white" />
              </span>
            </div>
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-2 py-1 text-[10px] font-medium text-white backdrop-blur">
              <Avatar person={PEOPLE[0]} size="sm" />
              {t("landing.mock.watchParty")}
              <Volume2 className="h-3 w-3 text-signal" />
            </div>
            <div className="absolute right-3 top-3 rounded-full bg-black/50 px-2 py-1 text-[10px] font-medium text-white/80 backdrop-blur">
              1080p
            </div>
            <div className="absolute bottom-3 right-3 flex gap-1.5">
              {PEOPLE.slice(1, 4).map((p) => (
                <span
                  key={p.name}
                  className="grid h-12 w-16 place-items-center rounded-lg bg-black/45 backdrop-blur"
                >
                  <Avatar person={p} size="md" ring />
                </span>
              ))}
            </div>
          </div>

          <div className="border-t border-white/5 px-4 py-2">
            <div className="flex items-start gap-2 text-[12px]">
              <Avatar person={PEOPLE[2]} size="sm" />
              <p>
                <span className="font-semibold text-[oklch(0.75_0.14_15)]">Caio</span>{" "}
                <span className="text-paper-muted">{t("landing.mock.chatLine1")}</span>
              </p>
            </div>
            <div className="mt-1.5 flex items-start gap-2 text-[12px]">
              <Avatar person={PEOPLE[1]} size="sm" />
              <p>
                <span className="font-semibold text-[oklch(0.78_0.12_190)]">Bia</span>{" "}
                <span className="text-paper-muted">{t("landing.mock.chatLine2")}</span>
                <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full border border-signal/40 bg-signal/10 px-1.5 text-[10px] text-signal">
                  🔥 4
                </span>
              </p>
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-ink-2 px-3 py-1.5 text-[11px] text-paper-muted/60">
              {t("landing.mock.composer")}
              <span className="ml-auto flex items-center gap-2">
                <Headphones className="h-3 w-3" />
                <Mic className="h-3 w-3" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** Two shares side by side, the way a wide window shows them. */
export function ScreenFrame({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Frame className={className} label={t("landing.mock.voiceChannel")}>
      <div className="grid gap-2 bg-ink p-3 sm:grid-cols-2">
        {[
          { person: PEOPLE[0], label: t("landing.mock.shareGame"), q: "1080p", audio: true },
          { person: PEOPLE[4], label: t("landing.mock.shareTab"), q: "720p", audio: true },
        ].map((s) => (
          <div
            key={s.person.name}
            className="relative aspect-video overflow-hidden rounded-lg bg-[linear-gradient(135deg,oklch(0.3_0.05_250),oklch(0.16_0.02_250))]"
          >
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white backdrop-blur">
              <Avatar person={s.person} size="sm" />
              {s.person.name} · {s.label}
              {s.audio && <Volume2 className="h-3 w-3 text-signal" />}
            </div>
            <div className="absolute right-2 top-2 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white/80">
              {s.q}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-white/5 bg-ink-2 px-3 py-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-3"><Mic className="h-3.5 w-3.5" /></span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-3"><Headphones className="h-3.5 w-3.5" /></span>
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-signal px-3 text-[11px] font-semibold text-ink">
          <MonitorUp className="h-3.5 w-3.5" /> {t("landing.mock.shareButton")}
        </span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-danger/25 text-danger"><X className="h-3.5 w-3.5" /></span>
      </div>
    </Frame>
  );
}

/** Replies, a thread, reactions, a pin, a poll and a dice roll in one log. */
export function ChatFrame({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Frame className={className} label="# geral">
      <div className="space-y-3 bg-ink px-4 py-3 text-[12px]">
        <div className="flex items-start gap-2">
          <Avatar person={PEOPLE[3]} />
          <div>
            <p>
              <span className="font-semibold text-[oklch(0.8_0.1_300)]">Nico</span>
              <span className="ml-1.5 text-[10px] text-paper-muted">21:04</span>
              <Pin className="ml-1.5 inline h-3 w-3 text-signal" />
            </p>
            <p className="text-paper-muted">{t("landing.mock.chatPinned")}</p>
            <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-white/10 bg-ink-2 px-1.5 py-0.5 text-[10px] text-paper-muted">
              {t("landing.mock.thread")}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Avatar person={PEOPLE[1]} />
          <div>
            <p className="text-[10px] text-paper-muted">
              ↩ <span className="font-semibold">Nico</span> {t("landing.mock.chatReplyTo")}
            </p>
            <p>
              <span className="font-semibold text-[oklch(0.78_0.12_190)]">Bia</span>
              <span className="ml-1.5 text-[10px] text-paper-muted">21:05</span>
            </p>
            <p className="text-paper-muted">{t("landing.mock.chatReply")}</p>
            <div className="mt-1 flex gap-1">
              <span className="rounded-full border border-signal/40 bg-signal/10 px-1.5 text-[10px] text-signal">😂 7</span>
              <span className="rounded-full border border-white/10 bg-ink-2 px-1.5 text-[10px]">👀 2</span>
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Avatar person={PEOPLE[0]} />
          <div className="w-full max-w-xs">
            <p>
              <span className="font-semibold text-[oklch(0.82_0.12_85)]">Rafa</span>
              <span className="ml-1.5 text-[10px] text-paper-muted">21:06</span>
            </p>
            <div className="mt-1 rounded-lg border border-white/10 bg-ink-2 p-2.5">
              <p className="flex items-center gap-1.5 font-semibold">
                <BarChart3 className="h-3.5 w-3.5 text-signal" /> {t("landing.mock.pollQuestion")}
              </p>
              {[
                [t("landing.mock.pollA"), 70],
                [t("landing.mock.pollB"), 30],
              ].map(([label, pct]) => (
                <div key={String(label)} className="mt-1.5">
                  <div className="flex justify-between text-[10px] text-paper-muted">
                    <span>{label}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="mt-0.5 h-1.5 rounded-full bg-ink-3">
                    <div className="h-1.5 rounded-full bg-signal" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Avatar person={PEOPLE[2]} />
          <div>
            <p>
              <span className="font-semibold text-[oklch(0.75_0.14_15)]">Caio</span>
              <span className="ml-1.5 text-[10px] text-paper-muted">21:07</span>
            </p>
            <div className="mt-1 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-ink-2 px-2.5 py-1.5">
              <Dices className="h-4 w-4 text-signal" />
              <span className="font-mono text-[11px] text-paper-muted">/roll 1d20</span>
              <span className="font-display text-base font-bold text-signal">17</span>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** The channel permission editor: allow, inherit, deny, per cargo. */
export function RolesFrame({ className }: { className?: string }) {
  const { t } = useTranslation();
  const roles: { name: string; tone: Person["tone"] }[] = [
    { name: t("landing.mock.roleOwner"), tone: "gold" },
    { name: t("landing.mock.roleMod"), tone: "teal" },
    { name: "VIP", tone: "lilac" },
    { name: "@everyone", tone: "plain" },
  ];
  const rows: { label: string; states: ("allow" | "inherit" | "deny")[] }[] = [
    { label: t("landing.mock.permView"), states: ["allow", "allow", "allow", "allow"] },
    { label: t("landing.mock.permSend"), states: ["allow", "allow", "inherit", "deny"] },
    { label: t("landing.mock.permSpeak"), states: ["allow", "allow", "allow", "inherit"] },
    { label: t("landing.mock.permStream"), states: ["allow", "allow", "inherit", "deny"] },
    { label: t("landing.mock.permMute"), states: ["allow", "allow", "deny", "deny"] },
  ];
  const cell = {
    allow: "bg-success/20 text-success",
    inherit: "bg-ink-3 text-paper-muted",
    deny: "bg-danger/20 text-danger",
  };
  const icon = { allow: Check, inherit: Minus, deny: X };
  return (
    <Frame className={className} label={`# staff · ${t("landing.mock.permissions")}`}>
      <div className="bg-ink p-3">
        <div className="grid grid-cols-[1.4fr_repeat(4,1fr)] items-center gap-1 text-[10px]">
          <span />
          {roles.map((r) => (
            <span key={r.name} className="flex justify-center">
              <span className={cn("truncate rounded-full px-2 py-0.5 font-semibold", TONE[r.tone])}>
                {r.name}
              </span>
            </span>
          ))}
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <span className="py-1.5 text-[11px] text-paper-muted">{row.label}</span>
              {row.states.map((s, i) => {
                const Icon = icon[s];
                return (
                  <span key={i} className="flex justify-center py-1.5">
                    <span className={cn("grid h-6 w-6 place-items-center rounded-md", cell[s])}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

/** The voice stage: who is in the room, who is talking, and the call bar. */
export function VoiceFrame({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Frame className={className} label={`${t("landing.mock.community")} · ${t("landing.mock.voiceChannel")}`}>
      <div className="bg-ink p-3">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {PEOPLE.map((p) => (
            <div
              key={p.name}
              className={cn(
                "flex aspect-square flex-col items-center justify-center gap-2 rounded-xl bg-ink-2 transition-shadow",
                p.speaking && "ring-1 ring-signal/60",
              )}
            >
              <Avatar person={p} size="lg" ring />
              <span className="flex items-center gap-1 text-[11px] font-medium">
                {p.name}
                {p.muted && <MicOff className="h-3 w-3 text-danger" />}
              </span>
            </div>
          ))}
          <div className="hidden aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/10 text-[10px] text-paper-muted sm:flex">
            +97
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-ink-2 px-3 py-2 text-[11px]">
          <Avatar person={PEOPLE[3]} size="sm" />
          <span className="text-paper-muted">Nico</span>
          <span className="ml-2 h-1.5 flex-1 rounded-full bg-ink-3">
            <span className="block h-1.5 w-[62%] rounded-full bg-signal" />
          </span>
          <Volume2 className="h-3.5 w-3.5 text-paper-muted" />
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-white/5 bg-ink-2 px-3 py-2">
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-ink-3 px-3 text-[11px] font-medium">
          <Mic className="h-3.5 w-3.5 text-signal" /> PTT
        </span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-3"><Headphones className="h-3.5 w-3.5" /></span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-3"><MonitorUp className="h-3.5 w-3.5" /></span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-danger/25 text-danger"><X className="h-3.5 w-3.5" /></span>
      </div>
    </Frame>
  );
}
