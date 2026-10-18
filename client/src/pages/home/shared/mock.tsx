import {
  Crown,
  Hash,
  Headphones,
  Lock,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings,
  Shield,
  Star,
  Video,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AVATARS, type AvatarId } from "./avatars";
import "./mock.css";

/**
 * DOM mocks of the pqp app for the homepage previews. Drawn, not
 * screenshotted, so they stay crisp, animate, and can be poked. They follow
 * the real app (see public/images/product/*.webp): ink surfaces, the lime
 * accent for "in call", names tinted by role. Show only shipped features.
 *
 * The cast is the one in the real captures.
 */
export type Tone = "rose" | "sky" | "violet" | "emerald" | "amber" | "plain";

export interface Person {
  name: string;
  tone: Tone;
  badge?: "owner" | "admin" | "vip";
  /**
   * Which picture to draw, by key into `AVATARS`. Never looked up from the
   * name, so renaming a person cannot lose their picture. A person without
   * one is drawn as a letter.
   */
  avatar?: AvatarId;
}

export const CAST = {
  zeca: { name: "Zeca", tone: "rose", badge: "owner", avatar: "zeca" },
  bia: { name: "Bia", tone: "rose", badge: "admin", avatar: "bia" },
  caio: { name: "Caio", tone: "sky", avatar: "caio" },
  nico: { name: "Nico", tone: "violet", badge: "vip", avatar: "nico" },
  leo: { name: "Leo", tone: "plain", avatar: "leo" },
  duda: { name: "Duda", tone: "sky", avatar: "duda" },
  eli: { name: "Eli", tone: "emerald" },
  gabi: { name: "Gabi", tone: "plain" },
  lara: { name: "Lara", tone: "amber" },
  kata: { name: "Kata", tone: "plain" },
} satisfies Record<string, Person>;

/** A faint wash of the person's colour behind their call tile. */
const TONE_WASH: Record<Tone, string> = {
  rose: "from-rose-500/20",
  sky: "from-sky-500/20",
  violet: "from-violet-500/20",
  emerald: "from-emerald-500/20",
  amber: "from-amber-400/20",
  plain: "from-white/10",
};

const TONE_TEXT: Record<Tone, string> = {
  rose: "text-rose-400",
  sky: "text-sky-400",
  violet: "text-violet-400",
  emerald: "text-emerald-400",
  amber: "text-amber-300",
  plain: "text-paper",
};

const BADGE_ICON: Record<NonNullable<Person["badge"]>, LucideIcon> = {
  owner: Crown,
  admin: Shield,
  vip: Star,
};

export function Avatar({
  person,
  size = 32,
  speaking = false,
  status,
  accent = false,
  className,
}: {
  person: Person;
  size?: number;
  speaking?: boolean;
  status?: "online" | "dnd" | "offline";
  /**
   * The lime fill the app uses for people in a call. It shows behind the
   * letter only: a person with a picture shows the picture, as in the app.
   */
  accent?: boolean;
  className?: string;
}) {
  const picture = person.avatar ? AVATARS[person.avatar] : undefined;
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center rounded-full", className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          "grid h-full w-full place-items-center overflow-hidden rounded-full font-display font-bold transition-shadow duration-300",
          accent && !picture ? "bg-signal text-ink" : "bg-ink-3 text-paper",
          speaking && "hp-speaking ring-2 ring-signal ring-offset-2 ring-offset-ink",
        )}
        style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}
        aria-hidden
      >
        {picture ? (
          <img src={picture} alt="" draggable={false} decoding="async" className="hp-avatar-img h-full w-full object-cover" />
        ) : (
          person.name.charAt(0)
        )}
      </span>
      {status && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-ink",
            status === "online" && "bg-success",
            status === "dnd" && "bg-danger",
            status === "offline" && "bg-ink-4",
          )}
          style={{ width: Math.max(8, size * 0.3), height: Math.max(8, size * 0.3) }}
          aria-hidden
        />
      )}
    </span>
  );
}

export function Name({ person, className }: { person: Person; className?: string }) {
  const Badge = person.badge ? BADGE_ICON[person.badge] : null;
  return (
    <span className={cn("inline-flex items-center gap-1 font-semibold", TONE_TEXT[person.tone], className)}>
      {person.name}
      {Badge && <Badge className="h-3 w-3 opacity-70" aria-hidden />}
    </span>
  );
}

/**
 * A browser-ish frame: the product runs at pqp.gg, nothing to install, and
 * the frame says so.
 */
export function AppWindow({
  children,
  url = "pqp.gg/app",
  className,
  bodyClassName,
}: {
  children: ReactNode;
  url?: string;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-white/10 bg-ink shadow-2xl shadow-black/50",
        className,
      )}
    >
      <div className="flex h-9 items-center gap-3 border-b border-white/5 bg-ink-2/80 px-3">
        <span className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </span>
        <span className="mx-auto flex h-6 min-w-0 max-w-[60%] items-center gap-1.5 truncate rounded-full bg-ink px-3 text-[11px] text-paper-muted">
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          {url}
        </span>
        <span className="w-[42px]" aria-hidden />
      </div>
      <div className={cn("relative", bodyClassName)}>{children}</div>
    </div>
  );
}

export function ServerRail({ active = "ME", others = ["RP", "CS"] }: { active?: string; others?: string[] }) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-white/5 bg-rail py-3" aria-hidden>
      <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-signal font-display text-xs font-bold text-ink">
        {active}
        <span className="absolute -left-3 h-5 w-1 rounded-r bg-paper" />
      </span>
      {others.map((label) => (
        <span
          key={label}
          className="grid h-9 w-9 place-items-center rounded-full bg-ink-3 font-display text-[11px] font-bold text-paper-muted"
        >
          {label}
        </span>
      ))}
      <span className="grid h-9 w-9 place-items-center rounded-full bg-ink-3 text-lg text-paper-muted">+</span>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-paper-muted">
      {children}
    </p>
  );
}

export function TextChannel({ name, active = false }: { name: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px]",
        active ? "bg-white/[0.06] text-paper" : "text-paper-muted",
      )}
    >
      <Hash className="h-3.5 w-3.5 opacity-70" aria-hidden />
      {name}
    </div>
  );
}

export function VoiceChannel({
  name,
  people = [],
  speaking = [],
  sharing,
  active = false,
}: {
  name: string;
  people?: Person[];
  speaking?: string[];
  sharing?: string;
  active?: boolean;
}) {
  return (
    <div className="mx-2">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px]",
          active ? "border border-signal/50 bg-signal/10 text-signal" : "text-paper-muted",
        )}
      >
        <Volume2 className="h-3.5 w-3.5" aria-hidden />
        <span className="flex-1">{name}</span>
        {active && <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />}
      </div>
      {people.length > 0 && (
        <ul className="ml-3 mt-1 space-y-1 border-l border-white/5 pl-3">
          {people.map((p) => (
            <li key={p.name} className="hp-pop flex items-center gap-2 text-[12px] text-paper-muted">
              <Avatar person={p} size={20} accent speaking={speaking.includes(p.name)} />
              <span className="flex-1">{p.name}</span>
              {sharing === p.name && <MonitorUp className="h-3.5 w-3.5 text-signal" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChatMessage({
  person,
  time = "21:43",
  children,
  reactions,
  className,
}: {
  person: Person;
  time?: string;
  children: ReactNode;
  reactions?: { emoji: string; count: number; mine?: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-3 px-4 py-1.5", className)}>
      <Avatar person={person} size={32} status="online" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-[13px]">
          <Name person={person} />
          <span className="text-[11px] text-paper-muted">{time}</span>
        </p>
        <div className="text-[13.5px] leading-snug text-paper">{children}</div>
        {reactions && (
          <div className="mt-1 flex gap-1">
            {reactions.map((r) => (
              <span
                key={r.emoji}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                  r.mine ? "border-signal/50 bg-signal/10 text-signal" : "border-white/10 bg-white/[0.04] text-paper-muted",
                )}
              >
                <span aria-hidden>{r.emoji}</span>
                {r.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A person's tile on the call stage. */
export function CallTile({
  person,
  speaking = false,
  muted = false,
  className,
}: {
  person: Person;
  speaking?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative grid place-items-center overflow-hidden rounded-xl border bg-ink-2 bg-radial-[at_50%_30%] to-transparent to-70% transition-colors duration-300",
        TONE_WASH[person.tone],
        speaking ? "border-signal/70" : "border-white/5",
        className,
      )}
    >
      <Avatar person={person} size={48} accent speaking={speaking} />
      <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
        {muted && <MicOff className="h-3 w-3 text-danger" aria-hidden />}
        {person.name}
      </span>
    </div>
  );
}

/** Equaliser bars: "sound is going out with this". */
export function SoundBars({ className, bars = 4 }: { className?: string; bars?: number }) {
  return (
    <span className={cn("inline-flex h-3 items-end gap-[2px]", className)} aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="hp-eq-bar w-[3px] rounded-full bg-current"
          style={{ height: "100%", animationDelay: `${i * 0.13}s` }}
        />
      ))}
    </span>
  );
}

/** The bottom bar of the call stage. Decorative: real controls live in the app. */
export function CallControls({ sharing = false, className }: { sharing?: boolean; className?: string }) {
  const item = "grid h-9 w-9 place-items-center rounded-full bg-white/[0.07] text-paper";
  return (
    <div className={cn("flex items-center justify-center gap-2", className)} aria-hidden>
      <span className={item}>
        <Mic className="h-4 w-4" />
      </span>
      <span className={item}>
        <Headphones className="h-4 w-4" />
      </span>
      <span className={item}>
        <Video className="h-4 w-4" />
      </span>
      <span className={cn(item, sharing && "bg-signal text-ink")}>
        <MonitorUp className="h-4 w-4" />
      </span>
      <span className={item}>
        <Settings className="h-4 w-4" />
      </span>
      <span className="grid h-9 w-12 place-items-center rounded-full bg-danger text-white">
        <PhoneOff className="h-4 w-4" />
      </span>
    </div>
  );
}
