import { DM_MAX_RECIPIENTS, type DmSummary, type PublicUser } from "@pqp/shared";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { UserSearch } from "@/components/user/user-search";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, createConversation } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

interface NewDmDialogProps {
  open: boolean;
  /** Excluded from results: a conversation with yourself is not a thing. */
  currentUserId: string | null;
  onClose: () => void;
  onCreated: (conversation: DmSummary) => void;
}

/**
 * Start a conversation with one person or several.
 *
 * One dialog for both, because the model is one thing: naming a second person
 * turns a DM into a group, and nothing else about the flow changes. Splitting
 * it would mean two pickers and a moment where the user has to know which kind
 * of conversation they want before they know who is in it.
 */
export function NewDmDialog({
  open,
  currentUserId,
  onClose,
  onCreated,
}: NewDmDialogProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening starts empty. A half-assembled group left over from last time is
  // one Enter away from being a conversation with people you did not mean to
  // include in this one.
  useEffect(() => {
    if (!open) {
      setPicked([]);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const full = picked.length >= DM_MAX_RECIPIENTS;

  async function create() {
    if (picked.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await createConversation(
        picked.map((person) => person.id),
      );
      onCreated(conversation);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("dm.dialog.failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("dm.dialog.eyebrow")}
      title={t("dm.dialog.title")}
      description={t("dm.dialog.description")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void create()}
            disabled={busy || picked.length === 0}
          >
            {busy
              ? t("dm.dialog.opening")
              : picked.length > 1
                ? t("dm.dialog.startGroup")
                : t("dm.dialog.start")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 px-5 py-4">
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {picked.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  onClick={() =>
                    setPicked((current) =>
                      current.filter((one) => one.id !== person.id),
                    )
                  }
                  className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-text hover:border-border-strong"
                  aria-label={t("dm.dialog.removeAria", {
                    name: person.displayName,
                  })}
                >
                  {person.displayName}
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {full ? (
          <p className="text-xs text-text-muted">
            {t("dm.dialog.full")}
          </p>
        ) : (
          <UserSearch
            label={t("dm.dialog.findPeople")}
            autoFocus
            excludeIds={[
              ...(currentUserId ? [currentUserId] : []),
              ...picked.map((person) => person.id),
            ]}
            onSelect={(person) =>
              setPicked((current) =>
                current.some((one) => one.id === person.id)
                  ? current
                  : [...current, person],
              )
            }
          />
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
