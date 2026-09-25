import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Clapperboard, Clock, PartyPopper } from "lucide-react";
import {
  normalizeStreamChannel,
  WATCH_PARTY_AUDIENCE_BUCKETS,
  WATCH_PARTY_WAITLIST_NOTE_MAX,
  type WatchPartyAudienceBucket,
  type WatchPartyWaitlistState,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WatchPartyFeatureList } from "@/components/watch-party/waitlist/watch-party-features";
import { WatchPartyStageArt } from "@/components/watch-party/waitlist/watch-party-stage-art";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  forgetWatchPartyWaitlist,
  joinWatchPartyWaitlist,
  loadWatchPartyWaitlist,
  rememberWatchPartyWaitlistEntry,
  useWatchPartyWaitlist,
} from "@/lib/watch-party-waitlist";

/**
 * The explainer and the form behind the sidebar's "Watch party · Acesso
 * antecipado" teaser, and behind `?intent=watch-party-waitlist` from the
 * public page.
 *
 * ONE DIALOG, FOUR ENDINGS, and which one is the server's call, never the
 * client's: somebody who may manage the server's channels ASKS for it
 * (`canRequest`), everybody else says they would watch (`interest`), somebody
 * with no server gets told when it opens up, and a row that already exists is
 * shown as what it is (waiting, approved, declined) with a way to edit it.
 * The form asks for what the operator actually uses to decide: which server,
 * roughly how many people, and optionally what and where they stream.
 *
 * Nothing here can create a party or touch a running one. It writes one row.
 */

export interface WaitlistServerOption {
  id: string;
  name: string;
}

type View =
  | "loading"
  | "request"
  | "member"
  | "serverless"
  | "waiting"
  | "declined"
  | "approved";

export function waitlistViewFor(
  serverId: string | null,
  state: WatchPartyWaitlistState | null,
  editing: boolean,
): View {
  if (!state) {
    return "loading";
  }
  if (state.available || state.entry?.status === "approved") {
    return "approved";
  }
  if (state.entry && !editing) {
    return state.entry.status === "declined" ? "declined" : "waiting";
  }
  if (serverId === null) {
    return "serverless";
  }
  return state.canRequest ? "request" : "member";
}

function Field({
  label,
  optional,
  htmlFor,
  children,
}: {
  label: string;
  optional?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-text-secondary">
        {label}
        {optional && (
          <span className="ml-1 font-normal text-text-tertiary">
            ({t("watchParty.waitlist.form.optional")})
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

export function WatchPartyWaitlistDialog({
  open,
  onClose,
  servers,
  initialServerId,
  onReload = () => window.location.reload(),
}: {
  open: boolean;
  onClose: () => void;
  /** The servers this person is in, for the "which server" picker. */
  servers: readonly WaitlistServerOption[];
  /** The open server, which the picker starts on. Null with no server open. */
  initialServerId: string | null;
  /** Test seam: what "Recarregar" does once a server is switched on. */
  onReload?: () => void;
}) {
  const { t } = useTranslation();
  const ids = {
    server: useId(),
    note: useId(),
    channel: useId(),
    audience: useId(),
  };
  const firstServer =
    initialServerId && servers.some((server) => server.id === initialServerId)
      ? initialServerId
      : (servers[0]?.id ?? null);
  const [serverId, setServerId] = useState<string | null>(firstServer);
  const [bucket, setBucket] = useState<WatchPartyAudienceBucket | null>(null);
  const [note, setNote] = useState("");
  const [channel, setChannel] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justJoined, setJustJoined] = useState(false);
  const wasOpen = useRef(false);

  // Reset on every open, not on every render: the picker starts on the server
  // somebody is looking at, and a previous visit's half-typed note is gone.
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opened) {
      return;
    }
    setServerId(firstServer);
    setEditing(false);
    setBusy(false);
    setError(null);
    setJustJoined(false);
  }, [open, firstServer]);

  const state = useWatchPartyWaitlist(serverId, open);

  // Prefill from the row, so "Editar pedido" edits rather than starts over.
  useEffect(() => {
    setBucket(state?.entry?.audienceBucket ?? null);
    setNote(state?.entry?.note ?? "");
    setChannel(state?.entry?.streamChannel ?? "");
  }, [state?.entry, serverId]);

  const view = waitlistViewFor(serverId, state, editing);
  const serverName =
    servers.find((server) => server.id === serverId)?.name ?? "";
  const channelInvalid =
    channel.trim() !== "" && normalizeStreamChannel(channel) === null;
  const needsBucket = view === "request";
  const canSubmit =
    !busy && !channelInvalid && (!needsBucket || bucket !== null);

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { entry } = await joinWatchPartyWaitlist({
        serverId,
        audienceBucket: bucket,
        note: note.trim() || null,
        streamChannel: channel.trim() || null,
      });
      rememberWatchPartyWaitlistEntry(serverId, entry);
      setEditing(false);
      setJustJoined(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // Switched on while the dialog was open: ask again, which lands on
        // the "already on" ending.
        forgetWatchPartyWaitlist(serverId);
        void loadWatchPartyWaitlist(serverId).catch(() => {});
      } else {
        setError(t("watchParty.waitlist.form.error"));
      }
    } finally {
      setBusy(false);
    }
  };

  const formView =
    view === "request" || view === "member" || view === "serverless";

  const footer = (() => {
    if (formView) {
      const label =
        view === "member"
          ? t("watchParty.waitlist.member.submit")
          : view === "serverless"
            ? t("watchParty.waitlist.serverless.submit")
            : state?.entry
              ? t("watchParty.waitlist.form.update")
              : t("watchParty.waitlist.form.submit");
      return (
        <Button
          type="submit"
          form="watch-party-waitlist-form"
          disabled={!canSubmit}
          data-watch-party-waitlist-submit=""
          className="w-full sm:w-auto"
        >
          {busy ? t("watchParty.waitlist.form.submitting") : label}
        </Button>
      );
    }
    if (view === "approved") {
      return (
        <Button type="button" onClick={onReload} className="w-full sm:w-auto">
          {t("watchParty.waitlist.approved.reload")}
        </Button>
      );
    }
    return (
      <Button type="button" variant="secondary" onClick={onClose} className="w-full sm:w-auto">
        {t("watchParty.waitlist.done.close")}
      </Button>
    );
  })();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      eyebrow={t("watchParty.waitlist.eyebrow")}
      title={t("watchParty.waitlist.title")}
      description={t("watchParty.waitlist.description")}
      footer={footer}
    >
      <DialogBody className="flex flex-col gap-5" data-watch-party-waitlist-view={view}>
        <WatchPartyStageArt />
        <WatchPartyFeatureList />
        <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
          {t("watchParty.waitlist.why")}
        </p>

        <section
          aria-live="polite"
          className="rounded-[var(--radius-card)] border border-border bg-surface-1 p-4"
        >
          {view === "loading" && (
            <div className="flex flex-col gap-2" aria-busy="true">
              <div className="h-4 w-1/3 animate-pulse rounded bg-surface-3/60" />
              <div className="h-10 w-full animate-pulse rounded bg-surface-3/40" />
            </div>
          )}

          {formView && (
            <form
              id="watch-party-waitlist-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {view === "member" && (
                <div>
                  <p className="text-sm font-semibold text-text">
                    {t("watchParty.waitlist.member.title")}
                  </p>
                  <p className="mt-1 text-pretty text-xs leading-relaxed text-text-secondary">
                    {t("watchParty.waitlist.member.body", { server: serverName })}
                  </p>
                </div>
              )}
              {view === "serverless" && (
                <p className="text-pretty text-sm text-text-secondary">
                  {t("watchParty.waitlist.serverless.body")}
                </p>
              )}

              {servers.length > 1 && (
                <Field label={t("watchParty.waitlist.form.server")} htmlFor={ids.server}>
                  <select
                    id={ids.server}
                    value={serverId ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      setServerId(event.target.value || null);
                      setEditing(false);
                      setError(null);
                    }}
                    className="h-[var(--control-lg)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
                  >
                    {servers.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {view !== "member" && (
                <div className="flex flex-col gap-1.5">
                  <span id={ids.audience} className="text-xs font-semibold text-text-secondary">
                    {t("watchParty.waitlist.form.audience")}
                    {view === "serverless" && (
                      <span className="ml-1 font-normal text-text-tertiary">
                        ({t("watchParty.waitlist.form.optional")})
                      </span>
                    )}
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby={ids.audience}
                    className="flex flex-wrap gap-1.5"
                  >
                    {WATCH_PARTY_AUDIENCE_BUCKETS.map((option) => {
                      const selected = bucket === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          data-audience-bucket={option}
                          disabled={busy}
                          onClick={() => setBucket(selected && view === "serverless" ? null : option)}
                          className={cn(
                            "h-8 rounded-full border px-3 text-xs font-medium transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
                            selected
                              ? "border-accent bg-accent text-on-accent"
                              : "border-border bg-surface-0 text-text-secondary hover:bg-surface-2 hover:text-text",
                          )}
                        >
                          {t(`watchParty.waitlist.bucket.${option}` as never)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {view === "request" && (
                <>
                  <Field label={t("watchParty.waitlist.form.note")} optional htmlFor={ids.note}>
                    <Input
                      id={ids.note}
                      value={note}
                      maxLength={WATCH_PARTY_WAITLIST_NOTE_MAX}
                      disabled={busy}
                      placeholder={t("watchParty.waitlist.form.notePlaceholder")}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </Field>
                  <Field label={t("watchParty.waitlist.form.channel")} optional htmlFor={ids.channel}>
                    <Input
                      id={ids.channel}
                      value={channel}
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={busy}
                      aria-invalid={channelInvalid || undefined}
                      placeholder={t("watchParty.waitlist.form.channelPlaceholder")}
                      className={cn(channelInvalid && "border-danger")}
                      onChange={(event) => setChannel(event.target.value)}
                    />
                    {channelInvalid && (
                      <span className="text-xs text-danger">
                        {t("watchParty.waitlist.form.channelInvalid")}
                      </span>
                    )}
                  </Field>
                </>
              )}

              {error && (
                <p role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
            </form>
          )}

          {view === "waiting" && state?.entry && (
            <div className="flex items-start gap-3" data-watch-party-waitlist-done="">
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-on-success-soft",
                  justJoined && "animate-pop-in",
                )}
              >
                <Check className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">
                  {t("watchParty.waitlist.done.title")}
                </p>
                <p className="mt-0.5 text-pretty text-xs leading-relaxed text-text-secondary">
                  {serverId === null
                    ? t("watchParty.waitlist.done.bodyServerless")
                    : state.entry.kind === "interest"
                      ? t("watchParty.waitlist.done.bodyInterest", { server: serverName })
                      : t("watchParty.waitlist.done.body", { server: serverName })}
                </p>
                {state.entry.kind === "request" || serverId === null ? (
                  <button
                    type="button"
                    className="mt-2 text-xs font-medium text-text underline decoration-text-tertiary/50 underline-offset-4 hover:decoration-text"
                    onClick={() => setEditing(true)}
                  >
                    {t("watchParty.waitlist.done.edit")}
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {view === "declined" && (
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning-soft text-on-warning-soft">
                <Clapperboard className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">
                  {t("watchParty.waitlist.declined.title")}
                </p>
                <p className="mt-0.5 text-pretty text-xs leading-relaxed text-text-secondary">
                  {t("watchParty.waitlist.declined.body", { server: serverName })}
                </p>
              </div>
            </div>
          )}

          {view === "approved" && (
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft">
                <PartyPopper className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">
                  {t("watchParty.waitlist.approved.title")}
                </p>
                <p className="mt-0.5 text-pretty text-xs leading-relaxed text-text-secondary">
                  {t("watchParty.waitlist.approved.body", { server: serverName })}
                </p>
              </div>
            </div>
          )}
        </section>
      </DialogBody>
    </Dialog>
  );
}
