import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Bug, CircleX, Info, Shield } from "lucide-react";
import { FEEDBACK_BODY_MAX_LENGTH, FEEDBACK_KINDS, type FeedbackKind } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsGroup,
  SettingsKeycap,
  SettingsNotice,
  SettingsResult,
  SettingsRow,
} from "@/components/settings/kit";
import { isApplePlatform } from "@/lib/composer-formatting";
import { cn } from "@/lib/utils";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { ApiError, sendFeedback } from "@/lib/api";
import { buildFeedbackContext, type FeedbackVoiceContext } from "@/lib/feedback-context";

/**
 * The feedback box: bugs, ideas, gripes. A confirmed bug earns the caça-bugs
 * badge, which is the entire gamification budget of this feature: one fun
 * consequence, no points, no leaderboard.
 */
/**
 * The draft outlives the tab. Switching to Ajuda to check something, closing
 * Settings by reflex, or changing the language (which reloads the page) used
 * to throw away a long bug report; it is kept in `sessionStorage` for the
 * session and cleared once it is sent.
 */
interface FeedbackDraft {
  owner: string | null;
  kind: FeedbackKind;
  body: string;
}

const DRAFT_KEY = "pqp:feedback-draft";

function loadDraft(): FeedbackDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FeedbackDraft>;
      if (
        (typeof parsed.owner === "string" || parsed.owner === null) &&
        typeof parsed.body === "string" &&
        FEEDBACK_KINDS.includes(parsed.kind as FeedbackKind)
      ) {
        return {
          owner: parsed.owner,
          kind: parsed.kind as FeedbackKind,
          body: parsed.body.slice(0, FEEDBACK_BODY_MAX_LENGTH),
        };
      }
    }
  } catch {
    // Storage blocked or a malformed value: start empty.
  }
  return { owner: null, kind: "bug", body: "" };
}

const draft: FeedbackDraft = loadDraft();

function persistDraft() {
  try {
    if (draft.body === "" && draft.kind === "bug") {
      sessionStorage.removeItem(DRAFT_KEY);
    } else {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }
  } catch {
    // Private mode or quota: the in-memory copy still covers tab switches.
  }
}

type SendOutcome = "sent" | "rateLimited" | "failed";

/**
 * The send in flight, and how the last one ended if nobody was looking. Both
 * live outside the pane: switching to Ajuda mid-send unmounts it, and coming
 * back must show "Enviando…" (not a fresh Enviar that posts the report a
 * second time), then the thanks or the error.
 */
let inflight: { owner: string | null; promise: Promise<SendOutcome> } | null = null;
let unseen: { owner: string | null; outcome: SendOutcome; visit: number } | null =
  null;

/**
 * Which opening of Settings this is. An outcome nobody saw is shown when the
 * pane comes back in the same visit, never on a later one: an hour later the
 * form is what the person came for, not an old "Obrigado".
 */
let visit = 0;

/** Called by the shell when Settings closes. */
export function endFeedbackVisit(): void {
  visit += 1;
  unseen = null;
}

function startSend(
  owner: string | null,
  payload: Parameters<typeof sendFeedback>[0],
): Promise<SendOutcome> {
  const startedIn = visit;
  const promise = sendFeedback(payload)
    .then(
      (): SendOutcome => {
        if (draft.owner === owner) {
          draft.body = "";
          draft.kind = "bug";
          persistDraft();
        }
        return "sent";
      },
      (err: unknown): SendOutcome =>
        err instanceof ApiError && err.status === 429 ? "rateLimited" : "failed",
    )
    .then((outcome) => {
      inflight = null;
      unseen = { owner, outcome, visit: startedIn };
      return outcome;
    });
  inflight = { owner, promise };
  return promise;
}

/** From this share of the limit the counter turns amber. */
const COUNTER_WARN_RATIO = 0.9;
/** A screen reader hears the count this long after the last keystroke. */
const COUNTER_ANNOUNCE_MS = 800;

export type CounterTone = "" | "warn" | "full";

/**
 * Only text counts: a box of spaces and line breaks is 0, which is why Enviar
 * is off. Past that the count is the raw length, because the box cuts the raw
 * text at the limit.
 */
export function feedbackCount(body: string): number {
  return body.trim().length === 0 ? 0 : body.length;
}

export function counterTone(length: number, max: number): CounterTone {
  if (length >= max) return "full";
  if (length >= max * COUNTER_WARN_RATIO) return "warn";
  return "";
}

export function FeedbackSection({
  voice,
  userId = null,
}: {
  voice: FeedbackVoiceContext | null;
  /** The signed-in account. The draft belongs to it and is dropped for another. */
  userId?: string | null;
}) {
  if (draft.owner !== userId) {
    // A different account in the same tab (sign out, sign in as someone
    // else) must never see the previous person's unsent report.
    draft.owner = userId;
    draft.kind = "bug";
    draft.body = "";
    persistDraft();
  }
  const { t } = useTranslation();
  const outcomeMessage = (outcome: "rateLimited" | "failed") =>
    outcome === "rateLimited"
      ? t("settings.feedback.rateLimited")
      : t("settings.feedback.error");
  // Read once: a send still running, or one that ended while this pane was
  // away. Cleared in the effect below, never here (React may call this twice).
  const [initial] = useState(() => ({
    pending: inflight !== null && inflight.owner === userId,
    outcome:
      inflight === null && unseen?.owner === userId && unseen.visit === visit
        ? unseen.outcome
        : null,
  }));
  const [kind, setKindState] = useState<FeedbackKind>(draft.kind);
  const [body, setBodyState] = useState(draft.body);
  const setKind = (next: FeedbackKind) => {
    draft.kind = next;
    persistDraft();
    setKindState(next);
  };
  const setBody = (next: string) => {
    draft.body = next;
    persistDraft();
    setBodyState(next);
  };
  const [sending, setSending] = useState(initial.pending);
  const [sent, setSent] = useState(initial.outcome === "sent");
  const [error, setError] = useState<string | null>(
    initial.outcome && initial.outcome !== "sent" ? outcomeMessage(initial.outcome) : null,
  );
  const mounted = useRef(false);
  const messageId = useId();
  const counterId = useId();
  const noteId = useId();
  const hintId = useId();
  const apple = isApplePlatform();
  const paneRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  // Enviar is disabled while the item is in flight, so focus would fall to the
  // page. After a send, hand it to the thanks line (the result is not a live
  // region, so focus is what reads it); after a failure, back to Enviar once
  // it is enabled again; after "Enviar outro", to the message.
  const focusAfter = useRef<"result" | "send" | "message" | null>(null);

  const settle = (outcome: SendOutcome) => {
    if (unseen?.owner === userId) unseen = null;
    setSending(false);
    if (outcome === "sent") {
      focusAfter.current = "result";
      setKindState("bug");
      setBodyState("");
      setSent(true);
    } else {
      focusAfter.current = "send";
      setError(outcomeMessage(outcome));
    }
  };

  useEffect(() => {
    mounted.current = true;
    const current = inflight;
    if (current && current.owner === userId) {
      void current.promise.then((outcome) => {
        if (mounted.current) settle(outcome);
      });
    } else if (initial.pending && unseen?.owner === userId) {
      // Mounted as "Enviando…" and the send ended before this effect ran:
      // its outcome is waiting here, and nothing else would apply it.
      settle(unseen.outcome);
    } else if (unseen?.owner === userId) {
      // Already shown by the initial state.
      unseen = null;
    }
    return () => {
      mounted.current = false;
    };
    // Mount only: a send started here is followed by `submit` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sending) return;
    if (focusAfter.current === "result") {
      paneRef.current
        ?.querySelector<HTMLElement>("[data-settings-result-title]")
        ?.focus();
    } else if (focusAfter.current === "send") {
      sendRef.current?.focus();
    } else if (focusAfter.current === "message") {
      messageRef.current?.focus();
    }
    focusAfter.current = null;
  }, [sent, sending]);

  const count = feedbackCount(body);
  const tone = counterTone(count, FEEDBACK_BODY_MAX_LENGTH);
  const empty = body.trim().length === 0;
  const canSend = !sending && !empty;
  const countText = t("settings.feedback.count", {
    length: count,
    max: FEEDBACK_BODY_MAX_LENGTH,
  });
  const toneText =
    tone === "full"
      ? t("settings.feedback.limit", { max: FEEDBACK_BODY_MAX_LENGTH })
      : tone === "warn"
        ? t("settings.feedback.remaining", {
            count: FEEDBACK_BODY_MAX_LENGTH - count,
          })
        : "";

  // The visible counter changes on every key. A screen reader gets it through
  // a second, hidden live region that settles first, so typing is not a stream
  // of announcements.
  const announceText = toneText ? `${toneText} ${countText}` : countText;
  const [announced, setAnnounced] = useState(announceText);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setAnnounced(announceText),
      COUNTER_ANNOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [announceText]);

  if (sent) {
    return (
      <div ref={paneRef} className="space-y-6">
        <SettingsGroup>
          <SettingsResult
            tone="success"
            title={t("settings.feedback.done")}
            description={t("settings.feedback.doneNote")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  focusAfter.current = "message";
                  setSent(false);
                  setKind("bug");
                  setBody("");
                  setError(null);
                }}
              >
                {t("settings.feedback.again")}
              </Button>
            }
          />
        </SettingsGroup>
      </div>
    );
  }

  const submit = () => {
    if (sending || inflight !== null || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    void startSend(userId, {
      kind,
      body: body.trim(),
      context: buildFeedbackContext(voice),
    }).then((outcome) => {
      if (mounted.current) settle(outcome);
    });
  };

  // Ctrl+Enter, or Cmd+Enter on a Mac, sends from the message box. Not while
  // an IME composition is open: its Enter confirms the candidate.
  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) submit();
  };

  const kindOptions = FEEDBACK_KINDS.map((option) => ({
    value: option,
    label: t(FEEDBACK_KIND_LABELS[option]),
  }));

  return (
    <div ref={paneRef} className="space-y-6">
      <SettingsGroup>
        <SettingsRow
          id="kind"
          label={t("settings.feedback.kind.label")}
          control={
            <RadioGroup
              variant="chips"
              label={t("settings.feedback.kind.label")}
              value={kind}
              onValueChange={setKind}
              options={kindOptions}
              // 44px targets on a narrow pane, the chips' usual 32px beside it.
              className="[&_[role=radio]]:h-11 [&_[role=radio]]:px-4 @lg:[&_[role=radio]]:h-8 @lg:[&_[role=radio]]:px-3"
            />
          }
        >
          <p
            id={hintId}
            className="flex items-start gap-2 text-xs text-pretty text-text-tertiary"
          >
            {kind === "bug" ? (
              <Bug aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
            ) : (
              <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1">{t(FEEDBACK_KIND_HINTS[kind])}</span>
          </p>
        </SettingsRow>
        <SettingsRow
          id="message"
          label={t("settings.feedback.message")}
          htmlFor={messageId}
          stacked
          control={
            <>
              <Textarea
                ref={messageRef}
                id={messageId}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={onMessageKeyDown}
                maxLength={FEEDBACK_BODY_MAX_LENGTH}
                rows={5}
                placeholder={t("settings.feedback.placeholder")}
                aria-describedby={counterId}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                className={cn(tone === "full" && "border-danger")}
              />
              <div
                id={counterId}
                className="mt-1.5 flex items-center justify-between gap-3 text-xs"
              >
                {tone === "full" ? (
                  <span className="flex items-center gap-1.5 text-danger">
                    <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0" />
                    {toneText}
                  </span>
                ) : tone === "warn" ? (
                  <span className="text-on-warning-soft">{toneText}</span>
                ) : (
                  <span />
                )}
                <span
                  data-counter-tone={tone || undefined}
                  className={cn(
                    "shrink-0 tabular-nums",
                    tone === "full"
                      ? "font-semibold text-danger"
                      : tone === "warn"
                        ? "font-semibold text-on-warning-soft"
                        : "text-text-secondary",
                  )}
                >
                  {countText}
                </span>
              </div>
              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {announced}
              </span>
            </>
          }
        />
        {/* What goes along with the message, at full width: it is the most
            important privacy line on the tab, so it is not squeezed beside the
            button. */}
        <div className="flex items-start gap-3 px-4 py-3 text-[13px] leading-normal text-pretty text-text-secondary">
          <Shield aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
          <p className="min-w-0 flex-1">{t("settings.feedback.attached")}</p>
        </div>
        {/* The action row has no status slot, so a failed send is the row
            right above Enviar: a danger notice (role="alert", CircleX). */}
        {error ? (
          <SettingsNotice tone="danger" inGroup>
            {error}
          </SettingsNotice>
        ) : null}
        {/* Local action row: a phone gets a full-width 44px Enviar with the
            hint under it, a wide pane gets the hint, the shortcut and a small
            button on one line. */}
        <div
          data-settings-row="send"
          className="flex min-h-11 flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-x-6"
        >
          <p
            id={noteId}
            hidden={!empty}
            className="order-2 min-w-0 text-center text-xs text-pretty text-text-tertiary @lg:order-1 @lg:flex-1 @lg:text-left"
          >
            {t("settings.feedback.empty")}
          </p>
          <div className="order-1 flex items-center gap-4 @lg:order-2 @lg:ml-auto @lg:shrink-0">
            <span
              aria-hidden
              className={cn(
                "hidden items-center gap-1.5 text-xs text-text-tertiary @lg:flex",
                !canSend && "opacity-60",
              )}
            >
              <SettingsKeycap modifier>{apple ? "⌘" : "Ctrl"}</SettingsKeycap>
              <SettingsKeycap modifier={false}>Enter</SettingsKeycap>
              <span>{t("settings.feedback.shortcut")}</span>
            </span>
            <Button
              ref={sendRef}
              size="sm"
              aria-describedby={empty ? noteId : undefined}
              disabled={!canSend}
              onClick={submit}
              className="h-11 flex-1 text-sm @lg:h-[var(--control-sm)] @lg:flex-none @lg:text-xs"
            >
              {sending ? t("settings.feedback.sending") : t("settings.feedback.send")}
            </Button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}

const FEEDBACK_KIND_LABELS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kind.bug",
  idea: "settings.feedback.kind.idea",
  other: "settings.feedback.kind.other",
};

const FEEDBACK_KIND_HINTS: Record<FeedbackKind, MessageKey> = {
  bug: "settings.feedback.kindHint.bug",
  idea: "settings.feedback.kindHint.idea",
  other: "settings.feedback.kindHint.other",
};
