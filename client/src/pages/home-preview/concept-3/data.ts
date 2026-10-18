import { Hash, MonitorUp, Volume2, type LucideIcon } from "lucide-react";
import { CAST, type Person } from "../shared/mock";

/** The product talking. A lime "p", same avatar the app gives people in a call. */
export const PQP: Person = { name: "pqp", tone: "plain" };

export { CAST };

/** The chapters of the thread, in order. `id` is the anchor on the first message. */
export const CHAPTERS: readonly { id: string; channel: string; icon: LucideIcon }[] = [
  { id: "cai-na-call", channel: "cai-na-call", icon: Volume2 },
  { id: "passa-a-tela", channel: "passa-a-tela", icon: MonitorUp },
  { id: "traz-o-servidor", channel: "traz-o-servidor", icon: Hash },
  { id: "onde-fica", channel: "onde-fica", icon: Hash },
  { id: "o-que-falta", channel: "o-que-falta", icon: Hash },
];

export const CHAPTER_IDS = CHAPTERS.map((c) => c.id);

/** The page's two buttons. Squarer than the flagship's pills: this is a chat. */
export const BTN_PRIMARY =
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-signal px-5 text-[15px] font-semibold text-ink shadow-[0_10px_30px_-14px_var(--color-accent)] transition-[background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-signal-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink motion-reduce:hover:translate-y-0";

export const BTN_SECONDARY =
  "inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-medium text-paper ring-1 ring-inset ring-white/15 transition-[background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal motion-reduce:hover:translate-y-0";

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink";
