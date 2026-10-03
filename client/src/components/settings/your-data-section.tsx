import { useEffect, useState } from "react";
import { deleteConfirmationMatches, expectedDeleteConfirmation, type User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n";
import { deleteMyAccount, exportMyData, OwnedServersError, type BlockingOwnedServer } from "@/lib/api";
import { messageOf } from "@/components/settings/ui";

/* --------------------------------------------------------------- your data */

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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await exportMyData();
      // A Blob has no URL of its own, so one is minted just long enough for the
      // click to fire — the same mechanism the server export uses.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pqp-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(messageOf(err, t("settings.data.exportFailed")));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void download()}
            disabled={exporting || !user}
          >
            {exporting
              ? t("settings.data.exporting")
              : t("settings.data.export")}
          </Button>
          <span className="text-xs text-paper-muted">
            {t("settings.data.exportHint")}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-paper-muted">
          {t("settings.data.exportBody")}
        </p>
        {exportError && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {exportError}
          </p>
        )}
      </div>

      <div className="rounded-md border border-danger/30 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="border border-danger/40 text-danger hover:bg-danger/10"
            onClick={onRequestDelete}
            disabled={!user}
          >
            {t("settings.data.delete")}
          </Button>
          <span className="text-xs text-paper-muted">
            {t("settings.data.deleteHint")}
          </span>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-paper">{t("settings.data.legal")}</p>
        <p className="mt-1 text-xs text-paper-muted">
          {t("settings.data.legalHint")}
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li>
            <a
              href="/privacy"
              target="_blank"
              rel="noreferrer"
              className="text-signal underline-offset-2 hover:underline"
            >
              {t("settings.data.privacy")}
            </a>
          </li>
          <li>
            <a
              href="/terms"
              target="_blank"
              rel="noreferrer"
              className="text-signal underline-offset-2 hover:underline"
            >
              {t("settings.data.terms")}
            </a>
          </li>
          <li>
            <a
              href="/cookies"
              target="_blank"
              rel="noreferrer"
              className="text-signal underline-offset-2 hover:underline"
            >
              {t("settings.data.cookies")}
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * The confirmation itself.
 *
 * Deliberately not a browser `confirm()` and deliberately not a single button.
 * The user has to read what goes and what stays, and then type their own handle
 * — the same value `deleteConfirmationMatches` checks on the server, so the
 * button being enabled and the request being accepted can never disagree.
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

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBlockingServers(null);
    }
  }, [open]);

  const expected = expectedDeleteConfirmation(user?.tag);
  const confirmed = deleteConfirmationMatches(typed, user?.tag);

  async function submit() {
    if (!confirmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setBlockingServers(null);
    try {
      await deleteMyAccount(typed);
      onDeleted();
    } catch (err) {
      if (err instanceof OwnedServersError) {
        setBlockingServers(err.servers);
        setError(null);
      } else {
        setError(messageOf(err, t("settings.delete.failed")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("settings.delete.eyebrow")}
      title={t("settings.delete.title")}
      size="sm"
      onClose={onCancel}
      // A stray click on the backdrop must not be able to dismiss the one
      // screen in the app whose next action cannot be undone.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("settings.delete.keep")}
          </Button>
          <Button
            className="bg-danger text-white hover:bg-danger/90"
            onClick={() => void submit()}
            disabled={!confirmed || busy}
          >
            {busy ? t("settings.delete.deleting") : t("settings.delete.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <p className="text-paper">{t("settings.delete.lead")}</p>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.whatGoes")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-paper-muted">
            <li>{t("settings.delete.goes.profile")}</li>
            <li>{t("settings.delete.goes.messages")}</li>
            <li>{t("settings.delete.goes.files")}</li>
            <li>{t("settings.delete.goes.memberships")}</li>
            <li>{t("settings.delete.goes.signIn")}</li>
            <li>{t("settings.delete.goes.servers")}</li>
          </ul>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.whatStays")}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-paper-muted">
            <li>{t("settings.delete.stays.moderation")}</li>
            <li>{t("settings.delete.stays.bans")}</li>
            <li>{t("settings.delete.stays.reports")}</li>
          </ul>
          <p className="mt-2 text-xs text-paper-muted">
            {t("settings.delete.staysNote")}
          </p>
        </div>

        {blockingServers && blockingServers.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/10 p-3"
          >
            <p className="font-medium text-paper">
              {t("settings.delete.ownedTitle")}
            </p>
            <p className="mt-1 text-xs text-paper-muted">
              {t("settings.delete.ownedBody")}
            </p>
            <ul className="mt-2 space-y-1">
              {blockingServers.map((server) => (
                <li key={server.id} className="text-sm text-paper">
                  {server.name}{" "}
                  <span className="text-xs text-paper-muted">
                    {t("settings.delete.ownedMembers", {
                      count: server.otherMemberCount,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-paper-muted">
            {t("settings.delete.typeLabel")}
          </span>
          <span className="mb-1 block font-mono text-sm text-signal">
            {expected}
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t("settings.delete.typeAria", { handle: expected })}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
