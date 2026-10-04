import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { deleteConfirmationMatches, expectedDeleteConfirmation, type User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  inlineErrorMessage,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useInlineSave,
} from "@/components/settings/kit";
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
 * Both requests here go through `request()` itself, not `apiFetch`, so a
 * dropped network arrives as the browser's own `TypeError` ("Failed to
 * fetch") and a timeout as an `AbortError`, not as an `ApiError`. The kit's
 * `inlineErrorMessage` shows a plain `Error`'s message as is, so anything that
 * is not the server's answer becomes the tab's own sentence first.
 */
function localizedFailure(err: unknown, fallback: string): unknown {
  return err instanceof ApiError ? err : new Error(fallback);
}

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
  // A download has no "Salvo": the file appearing is the proof. The line says
  // "Preparando…" while the server builds the copy, and the error after.
  const exp = useInlineSave({
    savingLabel: t("settings.data.exporting"),
    showSaved: false,
  });
  const exporting = exp.state.kind === "saving";

  function download() {
    const failed = t("settings.data.exportFailed");
    void exp.run(async () => {
      const blob = await exportMyData().catch((err: unknown) => {
        throw localizedFailure(err, failed);
      });
      // A Blob has no URL of its own, so one is minted just long enough for the
      // click to fire. The server export uses the same mechanism.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pqp-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }, failed);
  }

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("settings.data.group.export.title")}>
        <SettingsRow
          id="export"
          label={t("settings.data.row.export.label")}
          description={t("settings.data.exportBody")}
          status={<SettingsInlineStatus state={exp.state} />}
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={download}
              disabled={exporting || !user}
              aria-label={t("settings.data.row.export.action")}
            >
              <Download aria-hidden className="h-3.5 w-3.5" />
              {t("settings.data.export")}
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
              variant="danger"
              size="sm"
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
        const failed = t("settings.delete.failed");
        setError(inlineErrorMessage(localizedFailure(err, failed), failed));
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
            variant="danger"
            onClick={() => void submit()}
            disabled={!confirmed || busy}
          >
            {busy ? t("settings.delete.deleting") : t("settings.delete.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <p className="text-pretty text-text">{t("settings.delete.lead")}</p>

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
            {t("settings.delete.staysNote")}
          </p>
        </div>

        {blockingServers && blockingServers.length > 0 && (
          // The list inherits the notice's own foreground: that pair is the
          // one the bench measures on the warning fill. An alert, because it
          // answers the button just pressed and focus stays on that button.
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
        )}

        <label className="block">
          <span className="mb-1 block text-xs text-text-secondary">
            {t("settings.delete.typeLabel")}
          </span>
          <span className="mb-1.5 block font-mono text-sm text-text">
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
