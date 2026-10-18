import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ClipboardPaste,
  Hash,
  Info,
  Link2,
  LoaderCircle,
  Lock,
  Minus,
  Plus,
  RotateCcw,
  Volume2,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_IMPORT_CATEGORIES,
  MAX_IMPORT_CHANNELS,
  NOT_IN_TEMPLATE_REASONS,
  type MappedAwayItem,
  type MappedAwayReason,
  type NotInTemplateReason,
} from "@pqp/shared";
import type { CreateIntent } from "@/lib/handle-intent";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { IMPORT_INTENT, JoinButton } from "./shared/auth-buttons";
import { useReducedMotion } from "./shared/motion";
import {
  BENCH_SLOTS,
  benchFromPlan,
  checkPaste,
  comesAt,
  countRows,
  fetchTemplatePlan,
  initialsOf,
  prefetchTemplateMapper,
  templateLink,
  type BenchRow,
  type ComesItem,
  type HiddenCounts,
  type PasteFailure,
  type RoleTone,
  type TemplateBench,
  type TemplateFailure,
} from "./discord-template-preview";
import { rich } from "./rich";
import {
  BTN_DEMO,
  BTN_PRIMARY,
  CONTAINER,
  ExampleTag,
  FreeLine,
  H3,
  HEADER_GAP,
  SectionHeader,
  Section,
  useCta,
} from "./ui";
import "./mudanca.css";

/**
 * The second act: the crew in the hero came from Discord, and this is how
 * their server got here. A grey sidebar on the left is the Discord template,
 * and the pqp sidebar on the right assembles row by row in the same order.
 * Then a preview before creating, as the real flow does. Under the bench,
 * one footnote holds the conditions: who makes the link and where, and that
 * the import is web only.
 *
 * Two sources feed the bench:
 *
 * - The sample server, which plays on its own once the bench is on screen.
 *   Its names are catalogue text and its "create" step is a demo: nothing
 *   is created.
 * - The visitor's own template. The field is real: a paste or a submit reads
 *   that template straight from Discord in the visitor's browser
 *   (`discord-template-preview.ts` says why, and what happens when Discord
 *   does not answer), and the bench shows their server. Nothing is stored and
 *   nothing is created. The section's CTA then carries the code through
 *   sign-up (`/app?import=<code>`), and the import dialog opens with the link
 *   filled in. Names from Discord are untrusted: they are drawn as React text
 *   and never reach a URL, the title or a meta tag.
 *
 * What the section does not have, on purpose (the October 17, 2026 review,
 * `ui.tsx` header): no eyebrow, no lime in the headline, no glow, no scroll
 * reveal or fly-in on the bench (it is there when you arrive, and the sample
 * plays once it is on screen), no icon tiles in the two lists, and below sm
 * no outer card, so the sidebars use the whole width instead of sitting in a
 * box in a box. Caps survive only inside the two sidebars, where they copy
 * the apps.
 */

/** Old landing anchors that land here (`/#import`, `/#discord`). */
const MUDANCA_ALIASES = ["import", "discord"] as const;

/* ------------------------------------------------------------ The sample */

type SampleRow =
  | { kind: "server"; name: MessageKey }
  | { kind: "category" | "voice"; name: MessageKey }
  | { kind: "text"; name: MessageKey; private?: true }
  | { kind: "label" }
  | { kind: "role"; name: MessageKey; tone: RoleTone };

/**
 * The sample server, one row per sidebar line. Exactly `BENCH_SLOTS` rows
 * under the server row, so a pasted template is cut or padded to the same
 * height. Names are keys, read at render.
 */
const SAMPLE: readonly SampleRow[] = [
  { kind: "server", name: "home.move.sample.server" },
  { kind: "category", name: "home.move.sample.info" },
  { kind: "text", name: "home.move.sample.rules" },
  { kind: "category", name: "home.move.sample.chat" },
  { kind: "text", name: "home.move.sample.general" },
  { kind: "text", name: "home.move.sample.sheets" },
  { kind: "category", name: "home.move.sample.voice" },
  { kind: "voice", name: "home.move.sample.lobby" },
  { kind: "voice", name: "home.move.sample.session" },
  { kind: "category", name: "home.move.sample.gms" },
  { kind: "text", name: "home.move.sample.backstage", private: true },
  { kind: "label" },
  { kind: "role", name: "home.move.sample.gm", tone: "amber" },
  { kind: "role", name: "home.move.sample.players", tone: "sky" },
  { kind: "role", name: "home.move.sample.newcomers", tone: "emerald" },
];

type Translate = ReturnType<typeof useTranslation>["t"];

/** The sample in the reader's language. Every sample channel stands for one with a topic. */
function sampleRows(t: Translate): BenchRow[] {
  return SAMPLE.map((row): BenchRow => {
    switch (row.kind) {
      case "server": {
        const name = t(row.name);
        return { kind: "server", name, initials: initialsOf(name) };
      }
      case "label":
        return row;
      case "text":
        return { kind: "text", name: t(row.name), private: row.private, topic: true };
      case "role":
        return { kind: "role", name: t(row.name), tone: row.tone };
      default:
        return { kind: row.kind, name: t(row.name) };
    }
  });
}

const ROLE_DOT: Record<RoleTone, string> = {
  amber: "bg-amber-300",
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
};
const ROLE_TEXT: Record<RoleTone, string> = {
  amber: "text-amber-300",
  sky: "text-sky-400",
  emerald: "text-emerald-400",
};

/* Sidebar geometry, shared by both panels and the lane between them, so a
   Discord row sits on the same line as its pqp twin. */
const LABEL_BLOCK = 36; // h-6 label + mb-3
const HEADER_H = 52;
const LIST_PAD = 8;
const ROW_H = 28;
const MARKER = 28;
/** Every list keeps the sample's height, however short the pasted template. */
const LIST_MIN_H = LIST_PAD * 2 + BENCH_SLOTS * ROW_H;

function rowCenter(i: number) {
  if (i <= 0) return LABEL_BLOCK + 1 + HEADER_H / 2;
  return LABEL_BLOCK + 1 + HEADER_H + LIST_PAD + (i - 1) * ROW_H + ROW_H / 2;
}
const LANE_REST = LABEL_BLOCK + 1 + HEADER_H + LIST_PAD + (BENCH_SLOTS * ROW_H) / 2;

/** A ghost bar's width: as long as the name, up to a point. */
const ghostWidth = (text: string, perChar: number, max: number) => Math.min(text.length * perChar, max);

/* --------------------------------------------------------------- Copy maps */

const COMES: readonly { id: ComesItem; text: MessageKey }[] = [
  { id: "server", text: "home.move.comes.nameIcon" },
  { id: "categories", text: "home.move.comes.categories" },
  { id: "channels", text: "home.move.comes.channels" },
  { id: "topics", text: "home.move.comes.topics" },
  { id: "roles", text: "home.move.comes.roles" },
  { id: "private", text: "home.move.comes.private" },
];

/** What a template never carries, in the import dialog's words (`discord-import-preview.tsx`). */
const DROPPED: Record<NotInTemplateReason, MessageKey> = {
  members: "importDiscord.dropped.members",
  messages: "importDiscord.dropped.messages",
  attachments: "importDiscord.dropped.attachments",
  customEmoji: "importDiscord.dropped.customEmoji",
  webhooks: "importDiscord.dropped.webhooks",
  bans: "importDiscord.dropped.bans",
  discordInvites: "importDiscord.dropped.discordInvites",
};

/** The same keys the import dialog uses for what pqp maps away. */
const MAPPED_AWAY_KEYS: Record<MappedAwayReason, MessageKey> = {
  permissionBits: "importDiscord.mapped.permissionBits",
  overwrites: "importDiscord.mapped.overwrites",
  nsfw: "importDiscord.mapped.nsfw",
  slowmode: "importDiscord.mapped.slowmode",
  bitrate: "importDiscord.mapped.bitrate",
  forumTags: "importDiscord.mapped.forumTags",
  forumTagsTrimmed: "importDiscord.mapped.forumTagsTrimmed",
  forumSettings: "importDiscord.mapped.forumSettings",
  threads: "importDiscord.mapped.threads",
  directory: "importDiscord.mapped.directory",
  serverIcon: "importDiscord.mapped.serverIcon",
  unsanitisableRole: "importDiscord.mapped.unsanitisableRole",
  roleCap: "importDiscord.mapped.roleCap",
  flattenAnnouncement: "importDiscord.mapped.flattenAnnouncement",
  flattenForum: "importDiscord.mapped.flattenForum",
  flattenMedia: "importDiscord.mapped.flattenMedia",
  flattenStage: "importDiscord.mapped.flattenStage",
  topicTruncated: "importDiscord.mapped.topicTruncated",
};

/** Mapped-away lines shown when the list is opened; the rest is "+N". */
const MAPPED_SHOWN = 10;

/** Why a paste or a read failed, in the import dialog's own words. */
const PROBLEM_KEYS: Record<PasteFailure | TemplateFailure, MessageKey> = {
  inviteLink: "importDiscord.error.inviteLink",
  notATemplate: "importDiscord.error.notATemplate",
  notFound: "importDiscord.error.notFound",
  rateLimited: "importDiscord.error.rateLimited",
  unavailable: "importDiscord.error.unavailable",
  tooLarge: "importDiscord.error.tooLarge",
  tooMany: "importDiscord.error.tooMany",
};

/** Slots for `importDiscord.error.tooMany`, so the copy follows the caps. */
const IMPORT_CAPS = { channels: MAX_IMPORT_CHANNELS, categories: MAX_IMPORT_CATEGORIES };

const STEPS = [
  "home.move.steps.link",
  "home.move.steps.preview",
  "home.move.steps.created",
] as const satisfies readonly MessageKey[];

/** "A, B and C" in the reader's language. */
function joinList(locale: string, parts: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

const QUIET_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/* ------------------------------------------------------------- Section */

export function Mudanca() {
  const { t } = useTranslation();
  // The code of the template on the bench, for the CTA under it.
  const [code, setCode] = useState<string | null>(null);
  return (
    <Section
      id="mudanca"
      aliases={MUDANCA_ALIASES}
      labelledBy="mudanca-title"
      divider={false}
      // Follows the night's call to action and ends on its own: half the usual space on
      // both sides, so the page does not stack two 128px paddings after a button.
      className="pb-16 pt-16 sm:pb-20 sm:pt-20"
    >
      <div className={cn(CONTAINER, "relative")}>
        <SectionHeader
          titleId="mudanca-title"
          title={rich(t("home.move.title"), { accent: t("home.move.titleAccent") })}
          lede={t("home.move.lede")}
        />

        <div className={HEADER_GAP}>
          <ImportBench onCode={setCode} />
        </div>

        {/* Under the bench: the conditions, then the section's one real call to action, on the lists' column. */}
        <div className="mt-8 grid gap-10 lg:grid-cols-12 lg:gap-0">
          <p className="flex gap-2.5 text-[13px] leading-relaxed text-paper-muted text-pretty sm:px-1 lg:col-span-8 lg:pr-12">
            <Info className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t("home.move.note")}</span>
          </p>
          <div className="lg:col-span-4 lg:pl-6">
            <ImportCta code={code} />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** The import CTA block carries this id, so the sticky bar can step aside only while it shows. */
export const MUDANCA_CTA_ID = "mudanca-cta";

/**
 * The section's one real call to action. It comes after the demo, so it reads
 * as "now with yours" (the end of the night just above has its own pair), with
 * the line that explains why the demo says comunidade. Once a template of the
 * visitor's is on the bench, it brings that one.
 */
function ImportCta({ code }: { code: string | null }) {
  const { t } = useTranslation();
  const cta = useCta();
  return (
    <div id={MUDANCA_CTA_ID}>
      <p className="max-w-sm text-base leading-snug text-paper text-pretty">{t("home.move.cta.lead")}</p>
      <JoinButton
        intent={code ? { mode: "import", source: templateLink(code) } : IMPORT_INTENT}
        className={cn(BTN_PRIMARY, "mt-5 w-full sm:w-auto")}
      >
        {code ? t("home.move.paste.bring") : cta.importDiscord}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </JoinButton>
      <FreeLine className="mt-3 text-sm text-paper-muted text-pretty" />
    </div>
  );
}

/* --------------------------------------------------------------- Bench */

/**
 * The bench's frame. From sm up it is a raised card. On a phone it has no
 * chrome of its own, so the sidebars and the status line use the page's whole
 * width instead of sitting in a box in a box.
 */
const BENCH_FRAME =
  "relative sm:overflow-hidden sm:rounded-3xl sm:border sm:border-white/[0.07] sm:bg-ink-2/70 sm:shadow-2xl sm:shadow-black/40 sm:ring-1 sm:ring-inset sm:ring-white/[0.03]";

/** What the bench is drawing. `offline`: a valid code Discord could not be read for here. */
type Source =
  | { kind: "sample" }
  | { kind: "template"; code: string; bench: TemplateBench }
  | { kind: "offline"; code: string };

type Phase = "empty" | "building" | "preview" | "done";

type Status = "intro" | "reading" | "building" | "preview" | "done" | "ready" | "offline";

const READ_MS = { sample: 450, template: 150 } as const;
const STEP_MS = 150;

function ImportBench({ onCode }: { onCode: (code: string | null) => void }) {
  const { t, locale } = useTranslation();
  const reduced = useReducedMotion();

  const [source, setSource] = useState<Source>({ kind: "sample" });
  const [phase, setPhase] = useState<Phase>("empty");
  const [built, setBuilt] = useState(0);
  const [run, setRun] = useState(0);
  const [view, setView] = useState<"discord" | "pqp">("discord");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<PasteFailure | TemplateFailure | null>(null);
  const [loading, setLoading] = useState(false);

  const id = useId();
  const inputId = `${id}-link`;
  const messageId = `${id}-message`;

  const timers = useRef<number[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sampleRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<"create" | "done" | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Set the moment the visitor uses any control, so the arrival run never fights them.
  const touched = useRef(false);
  // True for the one input event that a pasted invite link causes (see `onPaste`).
  const keepProblem = useRef(false);
  const autoRun = useRef<() => void>(() => {});
  // One read at a time. `gen` drops an answer that a newer paste or an unmount overtook.
  const request = useRef<{ gen: number; controller: AbortController | null }>({ gen: 0, controller: null });

  const sample = useMemo(() => sampleRows(t), [t]);
  const real = source.kind === "template";
  const rows = real ? source.bench.rows : sample;
  const total = rows.length;
  const counts = real ? source.bench.counts : countRows(sample);
  const code = source.kind === "sample" ? null : source.code;

  useEffect(() => onCode(code), [code, onCode]);

  // Every timer and the read in flight die with the component. The array is
  // mutated in place, so the copy taken here is the live list.
  useEffect(() => {
    const list = timers.current;
    const pending = request.current;
    return () => {
      list.splice(0).forEach((handle) => window.clearTimeout(handle));
      pending.gen += 1;
      pending.controller?.abort();
    };
  }, []);

  // Move focus to the control that replaced the one just used.
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "create") createRef.current?.focus({ preventScroll: true });
    if (target === "done") doneRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const clearTimers = () => timers.current.splice(0).forEach((handle) => window.clearTimeout(handle));
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** Assemble `count` rows on the pqp side, one by one, then show the preview. */
  const assemble = (count: number, from: "sample" | "template") => {
    clearTimers();
    setRun((n) => n + 1);
    setView("pqp");
    const toPreview = () => {
      if (from === "sample" && document.activeElement === sampleRef.current) focusNext.current = "create";
      setPhase("preview");
    };
    if (reduced) {
      setBuilt(count);
      toPreview();
      return;
    }
    setBuilt(0);
    setPhase("building");
    const readMs = READ_MS[from];
    for (let i = 1; i <= count; i++) later(() => setBuilt(i), readMs + (i - 1) * STEP_MS);
    later(toPreview, readMs + count * STEP_MS + 350);
  };

  /** Stop a read in flight, if any. */
  const stopRequest = () => {
    request.current.gen += 1;
    request.current.controller?.abort();
    request.current.controller = null;
    setLoading(false);
  };

  /** A run in the middle of building jumps to its end, so nothing is left half drawn. */
  const settle = () => {
    if (phase !== "building") return;
    clearTimers();
    setBuilt(total);
    setPhase("preview");
  };

  /** Back to the sample, from the start. */
  const playSample = () => {
    if (source.kind === "sample" && phase === "building") return;
    touched.current = true;
    stopRequest();
    setProblem(null);
    setValue("");
    setSource({ kind: "sample" });
    assemble(sample.length, "sample");
  };

  /** Read the visitor's template. Only on a submit or a paste, never per keystroke. */
  const preview = async (text: string) => {
    touched.current = true;
    stopRequest();
    const check = checkPaste(text);
    if (!check.ok) {
      setProblem(check.reason);
      inputRef.current?.focus();
      return;
    }
    settle();
    setProblem(null);
    setLoading(true);
    const gen = ++request.current.gen;
    const controller = new AbortController();
    request.current.controller = controller;
    const outcome = await fetchTemplatePlan(check.code, { signal: controller.signal });
    if (gen !== request.current.gen) return;
    request.current.controller = null;
    setLoading(false);
    if (outcome.status === "ok") {
      const bench = benchFromPlan(outcome.plan);
      setSource({ kind: "template", code: check.code, bench });
      assemble(bench.rows.length, "template");
    } else if (outcome.status === "offline") {
      setSource({ kind: "offline", code: check.code });
    } else if (outcome.status === "failed") {
      setProblem(outcome.reason);
      // Back to the field, unless the visitor has moved on to something else.
      const active = document.activeElement;
      if (!active || active === document.body || formRef.current?.contains(active)) inputRef.current?.focus();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void preview(value);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const check = checkPaste(text);
    if (check.ok) {
      void preview(text);
    } else if (check.reason === "inviteLink") {
      // An invite is the usual wrong paste: name it at once, with no request.
      // Anything else may be half a link, so it waits for a submit.
      touched.current = true;
      stopRequest();
      setProblem("inviteLink");
      // The paste's own input event comes right after this one and must not clear it.
      keepProblem.current = true;
      window.setTimeout(() => {
        keepProblem.current = false;
      }, 0);
    }
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
    if (problem && !keepProblem.current) setProblem(null);
  };

  const create = () => {
    touched.current = true;
    clearTimers();
    focusNext.current = "done";
    setPhase("done");
  };

  // The first time the bench is mostly on screen, play the sample once on the
  // visitor's behalf: the same path as the button, ending on the preview.
  autoRun.current = () => {
    if (touched.current) return;
    assemble(sample.length, "sample");
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        autoRun.current();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const finished = phase === "preview" || phase === "done";
  const shown = finished ? total : phase === "building" ? built : 0;
  const copying = phase === "building" ? built - 1 : -1;
  const animate = phase === "building" && !reduced;
  const step = phase === "done" ? 2 : phase === "preview" ? 1 : 0;

  const status: Status = loading
    ? "reading"
    : source.kind === "offline"
      ? "offline"
      : phase === "building"
        ? "building"
        : real
          ? finished
            ? "ready"
            : "intro"
          : phase === "empty"
            ? "intro"
            : phase;

  const countText = {
    categories: t("home.move.paste.count.categories", { count: counts.categories }),
    channels: t("home.move.paste.count.channels", { count: counts.channels }),
    roles: t("home.move.paste.count.roles", { count: counts.roles }),
  };

  const announce: Record<Status, string> = {
    intro: "",
    reading: t("home.move.paste.announce.reading"),
    building: real ? t("home.move.paste.announce.building") : t("home.move.announce.building"),
    preview: t("home.move.announce.preview"),
    done: t("home.move.announce.done"),
    ready: t("home.move.paste.announce.ready", countText),
    offline: t("home.move.paste.offline"),
  };

  const sampleBusy = source.kind === "sample" && phase === "building";
  const sampleLabel =
    source.kind === "sample" && finished ? t("home.move.paste.replaySample") : t("home.move.paste.useSample");
  const message = problem
    ? t(PROBLEM_KEYS[problem], problem === "tooMany" ? IMPORT_CAPS : undefined)
    : t("home.move.paste.hint");

  const moreText = (hidden: HiddenCounts) =>
    joinList(
      locale,
      [
        hidden.channels > 0 && `+${t("home.move.paste.count.channels", { count: hidden.channels })}`,
        hidden.categories > 0 && `+${t("home.move.paste.count.categories", { count: hidden.categories })}`,
        hidden.roles > 0 && `+${t("home.move.paste.count.roles", { count: hidden.roles })}`,
      ].filter((part): part is string => Boolean(part)),
    );
  const textOf = (row: BenchRow) =>
    row.kind === "label" ? t("home.move.rolesLabel") : row.kind === "more" ? moreText(row.hidden) : row.name;
  const privateLabel = real
    ? t("importDiscord.preview.private")
    : t("home.move.sample.onlyRole", { role: t("home.move.sample.gm") });

  const at = comesAt(rows, counts);
  const comesCount: Record<ComesItem, number | null> = {
    server: null,
    categories: counts.categories,
    channels: counts.channels,
    topics: counts.topics,
    roles: counts.roles,
    private: counts.privateChannels,
  };
  const dropped = real ? source.bench.notInTemplate : NOT_IN_TEMPLATE_REASONS;
  const intent: CreateIntent = code ? { mode: "import", source: templateLink(code) } : IMPORT_INTENT;

  return (
    <div data-bench-source={source.kind} data-bench-phase={phase} className={BENCH_FRAME}>
      <p aria-live="polite" className="sr-only">
        {announce[status]}
      </p>

      {/* The paste bar: the visitor's own link, read only on a submit or a paste. */}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        aria-busy={loading || undefined}
        className="border-b border-white/[0.06] pb-5 sm:px-6 sm:py-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label htmlFor={inputId} className="text-sm font-medium text-paper-muted">
              {t("home.move.paste.label")}
            </label>
            {real ? <ExampleTag>{t("home.move.paste.yourPreview")}</ExampleTag> : <ExampleTag />}
          </div>
          <Stepper step={step} done={phase === "done"} />
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div
            className={cn(
              "flex h-12 min-w-0 items-center gap-2.5 rounded-lg border bg-ink px-3 transition-colors focus-within:border-signal/60 focus-within:ring-2 focus-within:ring-signal/30 sm:flex-1",
              problem ? "border-warning/60" : real ? "border-signal/40" : "border-white/10",
            )}
          >
            <Link2 className={cn("h-4 w-4 shrink-0", real ? "text-signal" : "text-paper-muted")} aria-hidden />
            <input
              ref={inputRef}
              id={inputId}
              name="discord-template"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={value}
              onChange={onChange}
              onFocus={prefetchTemplateMapper}
              onPaste={onPaste}
              placeholder={t("home.move.paste.placeholder")}
              aria-describedby={messageId}
              aria-invalid={problem ? true : undefined}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-paper placeholder:text-paper-muted/70 focus:outline-none sm:text-sm"
            />
            {real && !loading && <Check className="h-4 w-4 shrink-0 text-signal" aria-hidden />}
          </div>
          <button
            type="submit"
            aria-busy={loading || undefined}
            className={cn(BTN_DEMO, "h-12 w-full shrink-0 sm:w-auto sm:min-w-[164px]")}
          >
            {loading ? (
              <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <ArrowRight className="h-4 w-4" aria-hidden />
            )}
            {loading ? t("home.move.paste.reading") : t("home.move.paste.submit")}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4">
          <p
            id={messageId}
            aria-live="polite"
            data-bench-message={problem ?? "hint"}
            className={cn(
              "min-w-0 flex-1 basis-60 py-1 text-[12px] leading-snug text-pretty",
              problem ? "text-warning" : "text-paper-muted",
            )}
          >
            {message}
          </p>
          <button
            ref={sampleRef}
            type="button"
            onClick={playSample}
            aria-disabled={sampleBusy || undefined}
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-paper-muted transition-colors hover:text-paper aria-disabled:opacity-60",
              QUIET_FOCUS,
            )}
          >
            {source.kind === "sample" && finished ? (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ClipboardPaste className="h-3.5 w-3.5" aria-hidden />
            )}
            {sampleLabel}
          </button>
        </div>
      </form>

      <div className="grid lg:grid-cols-12">
        {/* The two sidebars. */}
        <div
          ref={stageRef}
          aria-busy={loading || phase === "building" || undefined}
          className="min-w-0 py-5 sm:p-6 lg:col-span-8"
        >
          <p className="sr-only">{real ? t("home.move.paste.sr") : t("home.move.sr")}</p>

          <div
            role="group"
            aria-label={t("home.move.sides.label")}
            className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-white/[0.07] bg-ink/70 p-1 md:hidden"
          >
            {(["discord", "pqp"] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={view === side}
                onClick={() => setView(side)}
                className={cn(
                  "inline-flex h-11 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors",
                  QUIET_FOCUS,
                  view === side ? "bg-ink-3 text-paper ring-1 ring-inset ring-white/10" : "text-paper-muted",
                )}
              >
                {side === "pqp" && (
                  <span className={cn("h-1.5 w-1.5 rounded-full", finished ? "bg-signal" : "bg-white/25")} aria-hidden />
                )}
                {side === "discord" ? t("home.move.sides.discord") : t("home.move.sides.pqp")}
              </button>
            ))}
          </div>

          <div className="grid md:grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)]">
            <div
              data-bench-panel="discord"
              className={cn("flex min-w-0 flex-col", view === "pqp" && "max-md:hidden")}
            >
              <DiscordPanel rows={rows} copying={copying} textOf={textOf} />
            </div>
            <Lane phase={phase} copying={copying} />
            <div
              data-bench-panel="pqp"
              className={cn("flex min-w-0 flex-col", view === "discord" && "max-md:hidden")}
            >
              <PqpPanel
                rows={rows}
                shown={shown}
                animate={animate}
                run={run}
                textOf={textOf}
                privateLabel={privateLabel}
              />
            </div>
          </div>

          <StatusBar
            status={status}
            shown={shown}
            total={total}
            intent={intent}
            onCreate={create}
            createRef={createRef}
            doneRef={doneRef}
          />
        </div>

        {/* What comes and what stays, in the same frame. */}
        <div className="grid border-t border-white/[0.06] sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1 lg:grid-rows-[auto_auto] lg:content-start lg:border-l lg:border-t-0">
          <ListBlock title={t("home.move.comes.title")} sub={t("home.move.comes.sub")}>
            {COMES.map((item) => {
              const text =
                item.id === "server" && real && !source.bench.hasIcon ? t("home.move.paste.nameOnly") : t(item.text);
              return (
                <Item
                  key={item.id}
                  lit={at[item.id] >= 0 && shown > at[item.id]}
                  count={real ? comesCount[item.id] : null}
                  name={item.id}
                >
                  {text}
                </Item>
              );
            })}
          </ListBlock>
          <ListBlock
            title={t("home.move.stays.title")}
            sub={t("home.move.stays.sub")}
            className="border-t border-white/[0.06] sm:border-l sm:border-t-0 lg:border-l-0 lg:border-t"
          >
            {dropped.map((reason) => (
              <Item key={reason} muted>
                {t(DROPPED[reason])}
              </Item>
            ))}
            {/* A template carries no accounts, and a Discord bot is an account. Page
                only: the shared NOT_IN_TEMPLATE_REASONS list (and the app's import
                dialog) does not carry it. True with the bot switches on or off. */}
            <Item muted name="discordBots">
              {t("home.move.stays.discordBots")}
            </Item>
            {real && source.bench.mappedAway.length > 0 && <MappedAway items={source.bench.mappedAway} />}
          </ListBlock>
        </div>
      </div>
    </div>
  );
}

function Stepper({ step, done }: { step: number; done: boolean }) {
  const { t } = useTranslation();
  return (
    <ol aria-label={t("home.move.steps.label")} className="flex items-center gap-1.5 text-[12px]">
      {STEPS.map((key, i) => {
        const complete = i < step || (done && i === step);
        const current = i === step;
        return (
          <li key={key} className="flex items-center gap-1.5" aria-current={current ? "step" : undefined}>
            {i > 0 && <ChevronRight className="h-3 w-3 text-paper-muted/50" aria-hidden />}
            <span
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold tabular-nums transition-colors",
                complete
                  ? "bg-signal text-ink"
                  : current
                    ? "bg-signal/15 text-signal ring-1 ring-inset ring-signal/40"
                    : "bg-white/[0.05] text-paper-muted",
              )}
            >
              {complete ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
            </span>
            <span className={cn("font-medium", current || complete ? "text-paper" : "text-paper-muted")}>{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The name over a sidebar. Below md the side toggle above already names the
 * one that shows, so the label would say it twice; it hides there. Its height
 * (`h-6` plus `mb-3`) is `LABEL_BLOCK`, which the lane marker's geometry reads.
 */
function PanelLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mb-3 flex h-6 min-w-0 items-center gap-2 whitespace-nowrap text-sm font-medium max-md:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

function serverOf(rows: BenchRow[]) {
  const first = rows[0];
  return first?.kind === "server" ? first : { kind: "server" as const, name: "", initials: "" };
}

function DiscordPanel({
  rows,
  copying,
  textOf,
}: {
  rows: BenchRow[];
  copying: number;
  textOf: (row: BenchRow) => string;
}) {
  const { t } = useTranslation();
  const server = serverOf(rows);
  return (
    <>
      <PanelLabel className="text-paper">
        {t("home.move.sides.discord")}
        <span className="truncate font-normal text-paper-muted">{t("home.move.panel.discordSub")}</span>
      </PanelLabel>
      <div aria-hidden className="flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-zinc-900/70">
        <div
          data-bench-row="server"
          className={cn(
            "flex items-center gap-2.5 border-b border-white/[0.05] px-3 transition-colors duration-150",
            copying === 0 && "bg-white/[0.06]",
          )}
          style={{ height: HEADER_H }}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-700 text-[11px] font-bold text-zinc-300">
            {server.initials}
          </span>
          <span className={cn("truncate text-sm font-semibold", copying === 0 ? "text-zinc-100" : "text-zinc-300")}>
            {server.name}
          </span>
        </div>
        <ul style={{ paddingTop: LIST_PAD, paddingBottom: LIST_PAD, minHeight: LIST_MIN_H }}>
          {rows.slice(1).map((row, k) => (
            <DiscordRow key={k} row={row} text={textOf(row)} active={copying === k + 1} />
          ))}
        </ul>
      </div>
    </>
  );
}

function DiscordRow({ row, text, active }: { row: BenchRow; text: string; active: boolean }) {
  if (row.kind === "category" || row.kind === "label") {
    return (
      <li
        data-bench-row={row.kind}
        className={cn(
          "flex items-end gap-1 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors duration-150",
          active ? "text-zinc-100" : "text-paper-muted",
        )}
        style={{ height: ROW_H }}
      >
        {row.kind === "category" && <ChevronDown className="mb-px h-3 w-3 shrink-0" />}
        <span className="truncate">{text}</span>
      </li>
    );
  }
  const locked = (row.kind === "text" || row.kind === "voice") && row.private;
  return (
    <li
      data-bench-row={row.kind}
      className={cn(
        "mx-2 flex items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150",
        active ? "bg-white/[0.08] text-zinc-100" : row.kind === "more" ? "text-paper-muted" : "text-zinc-400",
      )}
      style={{ height: ROW_H }}
    >
      {row.kind === "text" && <Hash className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
      {row.kind === "voice" && <Volume2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
      {row.kind === "role" && <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-zinc-500" />}
      {row.kind === "more" && <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
      <span className={cn("min-w-0 truncate", row.kind === "more" && "text-[12px]")}>{text}</span>
      {locked && <Lock className="ml-auto h-3 w-3 shrink-0 text-zinc-500" />}
    </li>
  );
}

/** The lane between the sidebars: a marker that follows the row being copied. */
function Lane({ phase, copying }: { phase: Phase; copying: number }) {
  const moving = phase === "building" && copying >= 0;
  const y = (moving ? rowCenter(copying) : LANE_REST) - MARKER / 2;
  const finished = phase === "preview" || phase === "done";
  return (
    <div aria-hidden className="relative hidden md:block">
      <span
        className="absolute bottom-0 left-1/2 border-l border-dashed border-white/10"
        style={{ top: LABEL_BLOCK + 1 }}
      />
      <span
        className={cn(
          "mu-marker absolute left-1/2 top-0 -ml-[14px] grid place-items-center rounded-full border transition-colors duration-300",
          phase === "building" || finished
            ? "border-signal/50 bg-signal text-ink"
            : "border-white/15 bg-ink-3 text-paper-muted",
        )}
        style={{ width: MARKER, height: MARKER, transform: `translateY(${y}px)` }}
      >
        {finished ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <ArrowRight className={cn("h-3.5 w-3.5", phase === "building" && "mu-nudge")} />
        )}
      </span>
    </div>
  );
}

function PqpPanel({
  rows,
  shown,
  animate,
  run,
  textOf,
  privateLabel,
}: {
  rows: BenchRow[];
  shown: number;
  animate: boolean;
  run: number;
  textOf: (row: BenchRow) => string;
  privateLabel: string;
}) {
  const { t } = useTranslation();
  const server = serverOf(rows);

  // No chips beside the label: the status line under the sidebars already says
  // where the run is (reading, building, preview, created) and the one example
  // tag sits on the paste bar above.
  return (
    <>
      <PanelLabel className="text-paper">{t("home.move.sides.pqp")}</PanelLabel>
      <div aria-hidden className="relative flex-1 overflow-hidden rounded-2xl border border-white/10 bg-ink">
        <div key={run}>
          <div
            className="flex items-center gap-2.5 border-b border-white/[0.06] px-3"
            style={{ height: HEADER_H }}
          >
            {shown > 0 ? (
              <span
                data-bench-row="server"
                className={cn("flex min-w-0 flex-1 items-center gap-2.5", animate && "mu-arrive")}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-signal font-display text-[11px] font-bold text-ink">
                  {server.initials}
                </span>
                <span className="truncate font-display text-[15px] font-bold text-paper">{server.name}</span>
              </span>
            ) : (
              <>
                <span className="h-8 w-8 shrink-0 rounded-xl border border-dashed border-white/15" />
                <span className="h-2.5 rounded-full bg-white/[0.07]" style={{ width: ghostWidth(server.name, 9, 160) }} />
              </>
            )}
          </div>
          <ul style={{ paddingTop: LIST_PAD, paddingBottom: LIST_PAD, minHeight: LIST_MIN_H }}>
            {rows.slice(1).map((row, k) => (
              <PqpRow
                key={k}
                row={row}
                text={textOf(row)}
                privateLabel={privateLabel}
                state={shown > k + 1 ? (animate ? "arrive" : "built") : "ghost"}
              />
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function PqpRow({
  row,
  text,
  privateLabel,
  state,
}: {
  row: BenchRow;
  text: string;
  privateLabel: string;
  state: "ghost" | "arrive" | "built";
}) {
  const isLabel = row.kind === "category" || row.kind === "label";
  if (state === "ghost") {
    return isLabel ? (
      <li className="flex items-end px-3 pb-2" style={{ height: ROW_H }}>
        <span className="h-1.5 rounded-full bg-white/[0.06]" style={{ width: ghostWidth(text, 7, 120) }} />
      </li>
    ) : (
      <li className="mx-2 flex items-center gap-2 px-2" style={{ height: ROW_H }}>
        <span className={cn("h-3 w-3 shrink-0 bg-white/[0.06]", row.kind === "role" ? "rounded-full" : "rounded")} />
        <span className="h-2 rounded-full bg-white/[0.06]" style={{ width: ghostWidth(text, 6.5, 130) }} />
      </li>
    );
  }

  const arrive = state === "arrive" && "mu-arrive";
  if (isLabel) {
    return (
      <li
        data-bench-row={row.kind}
        className={cn(
          "flex items-end gap-1 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-paper-muted",
          arrive,
        )}
        style={{ height: ROW_H }}
      >
        {row.kind === "category" && <ChevronDown className="mb-px h-3 w-3 shrink-0" />}
        <span className="truncate">{text}</span>
      </li>
    );
  }
  const locked = (row.kind === "text" || row.kind === "voice") && row.private;
  const tone = row.kind === "role" ? row.tone : undefined;
  return (
    <li
      data-bench-row={row.kind}
      className={cn(
        "mx-2 flex items-center gap-2 rounded-md px-2 text-[13px]",
        row.kind === "more" ? "text-paper-muted" : "text-paper",
        arrive,
      )}
      style={{ height: ROW_H }}
    >
      {row.kind === "text" && <Hash className="h-3.5 w-3.5 shrink-0 text-paper-muted" />}
      {row.kind === "voice" && <Volume2 className="h-3.5 w-3.5 shrink-0 text-signal" />}
      {row.kind === "more" && <Plus className="h-3.5 w-3.5 shrink-0 text-paper-muted" />}
      {row.kind === "role" && (
        <span
          className={cn("mx-[3px] h-2 w-2 shrink-0 rounded-full", tone ? ROLE_DOT[tone] : !row.color && "bg-paper-muted")}
          style={!tone && row.color ? { backgroundColor: row.color } : undefined}
        />
      )}
      <span
        className={cn(
          "min-w-0 truncate",
          row.kind === "role" && cn("font-semibold", tone && ROLE_TEXT[tone]),
          row.kind === "more" && "text-[12px]",
        )}
      >
        {text}
      </span>
      {locked && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-300/10 px-1.5 py-px text-[10px] font-medium text-amber-300">
          <Lock className="h-2.5 w-2.5" />
          {privateLabel}
        </span>
      )}
    </li>
  );
}

/**
 * The line under the sidebars. Every status is drawn in the same grid cell
 * and only the current one is shown, so the cell keeps the tallest one's
 * height and the bench never jumps while a run plays on a phone.
 */
function StatusBar({
  status,
  shown,
  total,
  intent,
  onCreate,
  createRef,
  doneRef,
}: {
  status: Status;
  shown: number;
  total: number;
  intent: CreateIntent;
  onCreate: () => void;
  createRef: React.RefObject<HTMLButtonElement | null>;
  doneRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  const { t } = useTranslation();
  const reading = status === "reading" || shown === 0;
  const bring = (
    <JoinButton intent={intent} className={cn(BTN_DEMO, "h-11 w-full shrink-0 px-4 sm:w-auto")}>
      {t("home.move.paste.bring")}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </JoinButton>
  );
  return (
    <div className="mt-4 grid">
      <PhaseBox name="intro" on={status === "intro"}>
        <p className="flex items-start gap-3 text-sm leading-snug text-paper-muted">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 rotate-[-90deg] text-paper-muted" aria-hidden />
          <span>
            {rich(t("home.move.sample.intro"), {
              sample: <span className="text-paper">{t("home.move.paste.useSample")}</span>,
            })}
          </span>
        </p>
      </PhaseBox>

      <PhaseBox name="building" on={status === "reading" || status === "building"} quiet className="sm:gap-6">
        <p className="flex shrink-0 items-center gap-2 text-sm text-paper">
          <LoaderCircle className="h-4 w-4 text-signal motion-safe:animate-spin" />
          {reading ? t("home.move.status.reading") : t("home.move.status.building")}
        </p>
        <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07] max-sm:w-full max-sm:flex-none">
          <span
            className="mu-progress absolute inset-0 rounded-full bg-signal"
            style={{ transform: `scaleX(${status === "reading" ? 0 : shown / Math.max(total, 1)})` }}
          />
        </span>
      </PhaseBox>

      <PhaseBox name="preview" on={status === "preview"} rise>
        <div className="min-w-0 sm:flex-1">
          <p className="text-sm font-semibold text-paper">{t("home.move.status.previewTitle")}</p>
          <p className="mt-0.5 text-sm text-paper-muted">{t("home.move.status.previewBody")}</p>
        </div>
        <button
          ref={createRef}
          type="button"
          onClick={onCreate}
          className={cn(BTN_DEMO, "h-11 w-full shrink-0 px-4 sm:w-auto")}
        >
          {t("home.move.status.create")}
        </button>
      </PhaseBox>

      <PhaseBox name="done" on={status === "done"} rise>
        <div className="flex min-w-0 items-start gap-3 sm:flex-1">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal" aria-hidden />
          <div className="min-w-0">
            <p ref={doneRef} tabIndex={-1} className="font-semibold text-paper outline-none">
              {rich(t("home.move.status.doneTitle"), {
                note: <span className="font-normal text-paper-muted">{t("home.move.status.doneNote")}</span>,
              })}
            </p>
            <p className="mt-0.5 text-sm text-paper-muted">{t("home.move.status.doneBody")}</p>
          </div>
        </div>
      </PhaseBox>

      {/* The visitor's own template: nothing was created, and the real CTA is right here. */}
      <PhaseBox name="ready" on={status === "ready"} rise>
        <div className="min-w-0 sm:flex-1">
          <p className="text-sm font-semibold text-paper">{t("home.move.paste.yourPreview")}</p>
          <p className="mt-0.5 text-sm text-paper-muted">{t("home.move.paste.readyBody")}</p>
        </div>
        {bring}
      </PhaseBox>

      {/* Discord could not be read from here: no blame on the link, and the code still travels. */}
      <PhaseBox name="offline" on={status === "offline"} rise>
        <p className="flex min-w-0 items-start gap-3 text-sm leading-snug text-paper sm:flex-1">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
          <span>{t("home.move.paste.offline")}</span>
        </p>
        {bring}
      </PhaseBox>
    </div>
  );
}

/**
 * One state of the status line. The others stay in the cell, invisible and
 * inert, so nothing in them can be focused, clicked or read out. `quiet`
 * hides a box from screen readers even while it shows (the live region speaks
 * for it); `rise` replays the entrance each time the state comes back.
 */
function PhaseBox({
  name,
  on,
  quiet = false,
  rise = false,
  className,
  children,
}: {
  name: Status | "building";
  on: boolean;
  quiet?: boolean;
  rise?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      inert={!on}
      aria-hidden={!on || quiet || undefined}
      data-bench-status={name}
      data-on={on || undefined}
      className={cn(
        "flex min-h-[72px] flex-col justify-center gap-3 rounded-2xl border border-white/[0.07] bg-ink/60 px-4 py-3.5 [grid-area:1/1] sm:flex-row sm:items-center sm:justify-start sm:gap-5",
        on ? rise && "mu-rise" : "invisible",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ListBlock({
  title,
  sub,
  className,
  children,
}: {
  title: string;
  sub: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 py-6 sm:p-6", className)}>
      <H3>{title}</H3>
      <p className="mt-1 text-[13px] leading-snug text-paper-muted text-pretty">{sub}</p>
      <ul className="mt-5 grid gap-2.5">{children}</ul>
    </div>
  );
}

const COUNT_BADGE = "ml-auto shrink-0 font-mono text-[12px] leading-[19px] tabular-nums";

/** The marker in front of a list line: a tick for what comes, a minus for what stays. */
const MARK = "mt-[3px] h-3.5 w-3.5 shrink-0 transition-colors duration-300";

/**
 * One line of "comes along" or "stays behind": a small tick or minus and the
 * words, no tile. A line that comes brightens (tick and text) when the build
 * passes the row it belongs to.
 */
function Item({
  lit = false,
  muted = false,
  count = null,
  name,
  children,
}: {
  lit?: boolean;
  /** A line that stays behind: a minus instead of a tick, and always bright. */
  muted?: boolean;
  /** A real template's count for this item; null draws none. */
  count?: number | null;
  /** A stable hook for tests (`data-bench-count`). */
  name?: string;
  children: ReactNode;
}) {
  const bright = lit || muted;
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 text-[14px] leading-snug transition-colors duration-300",
        bright ? "text-paper" : "text-paper-muted",
      )}
      data-bench-item={name}
    >
      {muted ? (
        <Minus className={cn(MARK, "text-paper-muted")} aria-hidden />
      ) : (
        <Check className={cn(MARK, lit ? "text-paper" : "text-paper-muted")} aria-hidden />
      )}
      <span>{children}</span>
      {count !== null && (
        <span data-bench-count={name} className={cn(COUNT_BADGE, count > 0 ? "text-paper" : "text-paper-muted")}>
          {count}
        </span>
      )}
    </li>
  );
}

/**
 * What the import maps away on this template (a slowmode, voice quality, an
 * announcement channel turned to text), folded under one line so the list
 * keeps its height. Open, it reads like the import dialog.
 */
function MappedAway({ items }: { items: MappedAwayItem[] }) {
  const { t } = useTranslation();
  const shown = items.slice(0, MAPPED_SHOWN);
  const rest = items.length - shown.length;
  return (
    <li className="text-[14px] leading-snug text-paper" data-bench-item="mapped">
      <details className="group">
        <summary
          className={cn(
            "-my-2.5 flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-md [&::-webkit-details-marker]:hidden",
            QUIET_FOCUS,
          )}
        >
          <Minus className="h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
          <span>{t("importDiscord.dropped.mappedTitle")}</span>
          <span data-bench-count="mapped" className={cn(COUNT_BADGE, "text-paper-muted")}>
            {items.length}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-paper-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ul className="mt-2.5 grid gap-1.5 pl-6 text-[13px] text-paper-muted">
          {shown.map((item, index) => (
            <li key={`${item.reason}:${item.name ?? index}`}>
              {t(MAPPED_AWAY_KEYS[item.reason], item.name ? { name: item.name } : undefined)}
            </li>
          ))}
          {rest > 0 && <li>{t("home.move.paste.moreAway", { count: rest })}</li>}
        </ul>
      </details>
    </li>
  );
}
