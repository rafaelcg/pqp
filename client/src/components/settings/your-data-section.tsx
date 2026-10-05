import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, CircleX, Download, ExternalLink, Info } from "lucide-react";
import { deleteConfirmationMatches, expectedDeleteConfirmation, type User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  inlineErrorMessage,
  SETTINGS_BUSY,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useInlineSave,
  useSettingsAnnounce,
} from "@/components/settings/kit";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import {
  ApiError,
  deleteMyAccount,
  exportMyData,
  OwnedServersError,
  type BlockingOwnedServer,
} from "@/lib/api";

/* --------------------------------------------------------------- your data */

/**
 * The English stand-ins `exportMyData` and `deleteMyAccount` put on a failure
 * whose body carried no `error` (a 429 or 413 answered by the proxy as HTML).
 * They are the client's words, not the server's, so they never reach a reader.
 */
const CLIENT_DEFAULT_MESSAGES = new Set(["Export failed", "Could not delete account"]);

/**
 * Both requests here go through `request()` itself, not `apiFetch`, so a
 * dropped network arrives as the browser's own `TypeError` ("Failed to
 * fetch") and a timeout as an `AbortError`, not as an `ApiError`. The kit's
 * `inlineErrorMessage` shows a plain `Error`'s message as is, so anything that
 * is not the server's own sentence becomes the tab's sentence first.
 */
function localizedFailure(err: unknown, fallback: string): unknown {
  if (err instanceof ApiError && !CLIENT_DEFAULT_MESSAGES.has(err.message)) {
    return err;
  }
  return new Error(fallback);
}

/** How long "Pronto. O arquivo ... foi baixado." stays under the button. */
export const EXPORT_DONE_MS = 6000;

/**
 * The file name of a copy. The date is the reader's own calendar day, not
 * UTC's: `toISOString()` is already tomorrow after 21:00 in Brazil.
 */
export function exportFileName(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `pqp-my-data-${now.getFullYear()}-${month}-${day}.json`;
}

/**
 * "54 s" under a minute, "2 min" above it (rounded up, so the button never
 * comes back before the server would accept it). Unit symbols, not words: they
 * are the same in all three languages.
 */
export function formatWait(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * Set when the delete dialog is dismissed. The dialog replaces Settings while
 * it is open (Settings unmounts), so when Settings comes back its first
 * control would take focus. The Seus dados tab reads this on mount and puts
 * focus back on the button the person came from.
 */
let deleteFocusReturnAt = 0;
const DELETE_FOCUS_RETURN_MS = 3000;

/**
 * Everything the two download buttons share (the row and the shortcut in the
 * delete dialog): the request, the file, the line under the button, and the
 * wait after the server's "too many requests".
 *
 * A download has no "Salvo": the file appearing is the proof, but the browser's
 * download UI is easy to miss, so a "Pronto" line names the file for a few
 * seconds. Without it people click again and hit the limiter.
 */
function useDataExport(enabled: boolean) {
  const { t } = useTranslation();
  const exp = useInlineSave({
    savingLabel: t("settings.data.exporting"),
    showSaved: false,
  });
  const exporting = exp.state.kind === "saving";
  const [doneFile, setDoneFile] = useState<string | null>(null);
  const doneTimer = useRef<number | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The wait as it read when the limiter answered. Screen readers hear this
  // once; the visible countdown ticks every second and is hidden from them.
  const [announcedWait, setAnnouncedWait] = useState<number>(0);

  useEffect(
    () => () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (until === null) {
      return;
    }
    const tick = window.setInterval(() => {
      const current = Date.now();
      if (current >= until) {
        setUntil(null);
      }
      setNow(current);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [until]);

  const waitSeconds =
    until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  const waiting = until !== null && waitSeconds > 0;

  // Busy, not disabled: a disabled button drops keyboard focus on the page
  // while the file is built and after every outcome. The button stays focusable
  // with `aria-disabled`, and this guard refuses the click instead.
  const busy = exporting || waiting;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const download = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    const failed = t("settings.data.exportFailed");
    if (doneTimer.current !== null) {
      window.clearTimeout(doneTimer.current);
      doneTimer.current = null;
    }
    setDoneFile(null);
    void exp.run(async () => {
      let blob: Blob;
      try {
        blob = await exportMyData();
      } catch (err: unknown) {
        // The limiter says how long to wait: show it on the button instead of
        // an error the person can only answer by clicking again.
        if (
          err instanceof ApiError &&
          err.status === 429 &&
          err.retryAfterMs !== null &&
          err.retryAfterMs > 0
        ) {
          const current = Date.now();
          setNow(current);
          setUntil(current + err.retryAfterMs);
          setAnnouncedWait(Math.ceil(err.retryAfterMs / 1000));
          return;
        }
        throw localizedFailure(err, failed);
      }
      // A Blob has no URL of its own, so one is minted just long enough for the
      // click to fire. The server export uses the same mechanism.
      const url = URL.createObjectURL(blob);
      const name = exportFileName();
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setDoneFile(name);
      doneTimer.current = window.setTimeout(() => {
        doneTimer.current = null;
        setDoneFile(null);
      }, EXPORT_DONE_MS);
    }, failed);
  }, [t, exp.run]);

  // "Pronto" goes through the dialog's announcer, mounted before it speaks:
  // a region inserted already holding its text is often not read. Outside
  // Settings (the delete dialog's shortcut) the line is its own region.
  const announce = useSettingsAnnounce();
  const doneText = doneFile ? t("settings.data.exportDone", { file: doneFile }) : null;
  useEffect(() => {
    if (announce && doneText) announce(doneText);
  }, [announce, doneText]);
  const doneLive = announce ? {} : ({ role: "status", "aria-live": "polite" } as const);

  const status = waiting ? (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
      <CircleX aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span aria-hidden className="min-w-0 text-pretty">
        {t("settings.data.exportCooldown", { time: formatWait(waitSeconds) })}
      </span>
      <span role="alert" className="sr-only">
        {t("settings.data.exportCooldown", { time: formatWait(announcedWait) })}
      </span>
    </p>
  ) : exp.state.kind === "idle" && doneFile ? (
    <p
      {...doneLive}
      className="mt-1.5 flex animate-fade-in items-start gap-1.5 text-xs text-text-secondary"
    >
      <Check aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
      <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">
        {t("settings.data.exportDone", { file: doneFile })}
      </span>
    </p>
  ) : (
    <SettingsInlineStatus state={exp.state} />
  );

  return {
    download,
    status,
    exporting,
    waiting,
    waitLabel: waiting ? formatWait(waitSeconds) : null,
    disabled: !enabled,
    busy,
  };
}

/** Touch targets: 44px on a phone or a touch screen, the kit's `sm` otherwise. */
const TOUCH = "max-sm:h-11 pointer-coarse:h-11";

/**
 * The two rights the privacy policy promises, as buttons.
 *
 * Until these existed the only route was emailing an address and waiting for
 * somebody to run SQL by hand inside a 15-day statutory deadline. They have a
 * section of their own now rather than a footer at the end of a scroll: the
 * right to leave belongs somewhere a person can find it on purpose.
 */
export function YourDataSection({
  user,
  onRequestDelete,
}: {
  user: User | null;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const data = useDataExport(user !== null);
  const deleteButton = useRef<HTMLButtonElement>(null);

  // Back from the delete dialog: focus the button that opened it.
  useEffect(() => {
    if (Date.now() - deleteFocusReturnAt < DELETE_FOCUS_RETURN_MS) {
      deleteFocusReturnAt = 0;
      deleteButton.current?.focus();
    }
  }, []);

  return (
    // The control stays at the top of its row: a status line growing under
    // the text must not push the button down while the person is reading it.
    <div className="space-y-6 @lg:[&_[data-settings-row]]:items-start">
      <SettingsGroup title={t("settings.data.group.export.title")}>
        <SettingsRow
          id="export"
          label={t("settings.data.row.export.label")}
          description={t("settings.data.exportBody")}
          status={data.status}
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={data.download}
              disabled={data.disabled}
              aria-disabled={data.busy || undefined}
              className={cn(TOUCH, data.busy && SETTINGS_BUSY)}
              aria-label={
                data.waitLabel
                  ? t("settings.data.row.export.waitAction", { time: data.waitLabel })
                  : t("settings.data.row.export.action")
              }
            >
              <Download aria-hidden className="h-3.5 w-3.5" />
              {data.waitLabel
                ? t("settings.data.exportIn", { time: data.waitLabel })
                : t("settings.data.export")}
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.data.group.delete.title")}>
        <SettingsRow
          id="delete-account"
          label={t("settings.data.row.delete.label")}
          description={t("settings.data.deleteHint")}
          control={
            <Button
              ref={deleteButton}
              variant="danger"
              size="sm"
              className={TOUCH}
              onClick={onRequestDelete}
              disabled={!user}
              aria-label={t("settings.data.row.delete.action")}
            >
              {t("settings.data.delete")}
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.data.legal")}>
        <SettingsLinkRow
          id="privacy-policy"
          label={t("settings.data.privacy")}
          description={t("settings.data.row.privacy.description")}
          href="/privacy"
          external
        />
      </SettingsGroup>
    </div>
  );
}

/**
 * The confirmation itself.
 *
 * Deliberately not a browser `confirm()` and deliberately not a single button.
 * The user has to read what goes and what stays, and then type their own handle.
 * That is the same value `deleteConfirmationMatches` checks on the server, so
 * the button being enabled and the request being accepted can never disagree.
 *
 * It states what survives as plainly as what is destroyed. A deletion screen
 * that only lists what disappears is quietly misleading: audit entries, bans
 * this account issued, and reports filed about it all remain, and somebody
 * deleting their account specifically to erase a moderation record deserves to
 * learn that here rather than afterwards.
 */
export function DeleteAccountDialog({
  open,
  user,
  onCancel,
  onDeleted,
}: {
  open: boolean;
  user: User | null;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingServers, setBlockingServers] = useState<
    BlockingOwnedServer[] | null
  >(null);
  const data = useDataExport(user !== null);
  const typeId = useId();
  const hintId = useId();

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBlockingServers(null);
    }
  }, [open]);

  const expected = expectedDeleteConfirmation(user?.tag);
  // The hint says "type the rest", and people complete "@name" the way the
  // handle is written elsewhere, so one leading "@" is not a mismatch. The
  // server gets the form it accepts, without it.
  const answer = typed.trim().replace(/^@/, "");
  const confirmed = deleteConfirmationMatches(answer, user?.tag);
  // The name typed without its number: the one near miss worth naming, because the name
  // is what the person sees everywhere and the number is what they forget.
  const hashAt = expected.indexOf("#");
  const missing =
    !confirmed && hashAt > 0
      ? answer.toLowerCase() === expected.slice(0, hashAt).toLowerCase()
        ? expected.slice(hashAt)
        : null
      : null;

  // Settings is unmounted while this dialog is open; tell it to put focus back
  // on "Apagar conta…" when it returns.
  function cancel() {
    // Leaving while the delete is in flight would not stop it: the account
    // would still go, after the person believed they had backed out.
    if (busy) {
      return;
    }
    deleteFocusReturnAt = Date.now();
    onCancel();
  }

  async function submit() {
    if (!confirmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setBlockingServers(null);
    try {
      await deleteMyAccount(answer);
      onDeleted();
    } catch (err) {
      if (err instanceof OwnedServersError) {
        setBlockingServers(err.servers);
        setError(null);
      } else {
        const failed = t("settings.delete.failed");
        setError(
          inlineErrorMessage(
            localizedFailure(err, failed),
            failed,
            t("settings.status.rateLimited"),
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t("settings.delete.title")}
      size="sm"
      onClose={cancel}
      // A stray click on the backdrop must not be able to dismiss the one
      // screen in the app whose next action cannot be undone.
      closeOnBackdrop={false}
      dismissible={!busy}
      // The long text scrolls; the one thing the person has to do does not.
      // The typed confirmation and whatever the delete answered sit above the
      // buttons, so they are on screen however short the window is.
      footer={
        <>
          <div className="w-full space-y-3">
            {blockingServers && blockingServers.length > 0 && (
              // The list inherits the notice's own foreground: that pair is the
              // one the bench measures on the warning fill. An alert, because it
              // answers the button just pressed and focus stays on that button.
              <div className="max-h-40 overflow-y-auto">
                <SettingsNotice
                  tone="warning"
                  role="alert"
                  title={t("settings.delete.ownedTitle")}
                >
                  <p>{t("settings.delete.ownedBody")}</p>
                  <ul className="mt-2 space-y-1">
                    {blockingServers.map((server) => (
                      <li key={server.id} className="text-sm">
                        <span className="font-medium">{server.name}</span>{" "}
                        <span className="text-xs">
                          {t("settings.delete.ownedMembers", {
                            count: server.otherMemberCount,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </SettingsNotice>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div>
              <label
                htmlFor={typeId}
                className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text"
              >
                {t("settings.delete.typeLabel")}
                <span className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm">
                  {expected}
                </span>
              </label>
              <Input
                id={typeId}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="font-mono"
                aria-label={t("settings.delete.typeAria", { handle: expected })}
                aria-describedby={missing ? hintId : undefined}
              />
              {missing && (
                <p
                  id={hintId}
                  role="status"
                  className="mt-1.5 flex items-center gap-1.5 text-xs text-text-secondary"
                >
                  <Info aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  {t("settings.delete.typeMissing", { rest: missing })}
                </p>
              )}
            </div>
          </div>
          {/* Busy but focusable: `disabled` here would drop keyboard focus on
              the page while the delete runs, and after a failure. */}
          <Button
            variant="ghost"
            onClick={cancel}
            aria-disabled={busy || undefined}
            className={busy ? SETTINGS_BUSY : undefined}
          >
            {t("settings.delete.keep")}
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            disabled={!confirmed}
            aria-disabled={busy || undefined}
            className={busy ? SETTINGS_BUSY : undefined}
          >
            {busy ? t("settings.delete.deleting") : t("settings.delete.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <p className="text-pretty text-text">{t("settings.delete.lead")}</p>

        <div>
          <SettingsNotice
            tone="info"
            role="note"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={data.download}
                disabled={data.disabled}
                aria-disabled={data.busy || undefined}
                className={data.busy ? SETTINGS_BUSY : undefined}
              >
                <Download aria-hidden className="h-3.5 w-3.5" />
                {data.waitLabel
                  ? t("settings.data.exportIn", { time: data.waitLabel })
                  : t("settings.delete.saveCopyAction")}
              </Button>
            }
          >
            {t("settings.delete.saveCopy")}
          </SettingsNotice>
          {data.status}
        </div>

        <div>
          <p className="text-sm font-semibold text-text">
            {t("settings.delete.whatGoes")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
            <li>{t("settings.delete.goes.profile")}</li>
            <li>{t("settings.delete.goes.messages")}</li>
            <li>{t("settings.delete.goes.files")}</li>
            <li>{t("settings.delete.goes.memberships")}</li>
            <li>{t("settings.delete.goes.signIn")}</li>
            <li>{t("settings.delete.goes.servers")}</li>
          </ul>
        </div>

        <div>
          <p className="text-sm font-semibold text-text">
            {t("settings.delete.whatStays")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
            <li>{t("settings.delete.stays.moderation")}</li>
            <li>{t("settings.delete.stays.bans")}</li>
            <li>{t("settings.delete.stays.reports")}</li>
          </ul>
          <p className="mt-2 text-xs text-pretty text-text-tertiary">
            {t("settings.delete.staysNote")}{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-text underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {t("settings.delete.staysLink")}
              <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
            </a>
          </p>
        </div>
      </div>
    </Dialog>
  );
}
