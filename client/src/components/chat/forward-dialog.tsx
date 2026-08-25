import { Hash } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

export interface ForwardTarget {
  id: string;
  label: string;
  kind: "channel" | "conversation";
}

export function ForwardDialog({
  open,
  targets,
  onPick,
  onClose,
}: {
  open: boolean;
  targets: readonly ForwardTarget[];
  onPick: (target: ForwardTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      title={t("chat.forward.title")}
      description={t("chat.forward.description")}
      size="sm"
      onClose={onClose}
    >
      {targets.length === 0 ? (
        <p className="text-sm text-paper-muted">{t("chat.forward.empty")}</p>
      ) : (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {targets.map((target) => (
            <li key={target.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-paper hover:bg-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
                onClick={() => onPick(target)}
              >
                {target.kind === "channel" ? (
                  <Hash className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
                ) : (
                  <span className="w-4 shrink-0 text-center text-paper-muted" aria-hidden>
                    @
                  </span>
                )}
                <span className="truncate">{target.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
