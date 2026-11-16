import { Ban, Check, CircleAlert, Cloud, HardDrive, LoaderCircle, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { AppIconTile } from "@/components/apps/app-icon";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import type { JoinSheetFace } from "@/lib/apps/join-model";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What a person reads before they enter an app for the first time (mock 04).
 * Pure over its props; `AppJoinHost` is the part that knows the session, the
 * consent and the socket.
 *
 * TWO FIXED LINES THE APP CANNOT HIDE: "O app vê" and "O app não vê" are the
 * platform's words, always present. The app adds one short notice of its own
 * (its manifest's `notice`, in this person's language) and nothing else, so an
 * app can say "teu jogo fica no teu computador" and cannot say anything that
 * pushes the two lines down.
 *
 * ENTERING LOCKS BOTH BUTTONS and the dialog does not close on a click outside
 * while it waits (`dismissible={false}`): a sheet that disappears mid-join
 * leaves a person wondering whether they are in. A failure comes in at the top
 * as an alert and the button becomes "Tentar de novo" in place, so keyboard
 * focus stays where it was.
 *
 * Tab order is the order in the DOM and the mock's: the id box (when there is
 * one), Agora não, Entrar, then "Como o pqp protege isso". Initial focus is on
 * Entrar because the action is a safe one.
 */

export type JoinFailure = "connection" | "not-allowed" | "rate-limited" | "unavailable";

export interface AppJoinSheetProps {
  open: boolean;
  face: Exclude<JoinSheetFace, "done">;
  app: { name: string; icon: string; notice: string | null };
  /** Who started it. */
  starterName: string;
  /** "3 dentro, cabem 4" as the card says it. */
  countLine: string | null;
  /** The viewer, to show how they appear. */
  viewer: { name: string; avatarUrl: string | null };
  /** The manifest asks for `identity: "user-id"`: the optional box. */
  asksForId: boolean;
  /** The manifest declares `deviceStore`: one more line, "Guarda coisas neste aparelho". */
  keepsOnDevice?: boolean;
  /** Saves na conta is on here: the saves (never the game) also go to the account. */
  keepsOnAccount?: boolean;
  identityChecked: boolean;
  onIdentityChange: (checked: boolean) => void;
  failure: JoinFailure;
  /** On the full face: Assistir is on offer. */
  canWatch: boolean;
  /** On the full face: "4 de 4 jogando. 2 assistindo." */
  fullLine: string | null;
  /** On the ended face: who ended it and how long ago, already written. */
  endedLine: string | null;
  onEnter: () => void;
  onWatch: () => void;
  /** Agora não, Fechar and Escape. */
  onClose: () => void;
}

const FAILURE_KEY: Record<JoinFailure, MessageKey> = {
  connection: "apps.join.failedConnection",
  "not-allowed": "apps.join.failedNotAllowed",
  "rate-limited": "apps.join.failedRateLimited",
  unavailable: "apps.join.failedUnavailable",
};

function AppSpinner() {
  return (
    <LoaderCircle
      aria-hidden
      className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
    />
  );
}

export function AppJoinSheet(props: AppJoinSheetProps) {
  const { open, face, app, onClose } = props;
  const { t } = useTranslation();
  const protectId = useId();
  const [protectOpen, setProtectOpen] = useState(false);

  const quiet = face === "ended" || face === "disabled";
  const title =
    face === "full"
      ? t("apps.join.fullTitle", { app: app.name })
      : face === "ended"
        ? t("apps.join.endedTitle")
        : face === "disabled"
          ? t("apps.join.disabledTitle")
          : t("apps.join.title", { app: app.name });
  const description =
    face === "full"
      ? (props.fullLine ?? undefined)
      : face === "ended"
        ? (props.endedLine ?? t("apps.join.endedPlain", { app: app.name }))
        : face === "disabled"
          ? t("apps.join.disabledBody", { app: app.name })
          : [t("apps.join.startedBy", { name: props.starterName }), props.countLine]
              .filter(Boolean)
              .join(" ");

  const entering = face === "entering";

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      size="md"
      closeOnBackdrop={false}
      dismissible={!entering}
      onClose={onClose}
      footer={
        quiet ? (
          <Button type="button" autoFocus onClick={onClose}>
            {t("apps.join.close")}
          </Button>
        ) : (
          <div className="flex w-full flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-between">
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                disabled={entering}
                className="max-sm:h-12"
                onClick={onClose}
              >
                {t("apps.join.notNow")}
              </Button>
              {face === "full" ? (
                props.canWatch ? (
                  <Button type="button" autoFocus className="max-sm:h-12" onClick={props.onWatch}>
                    {t("apps.join.watch")}
                  </Button>
                ) : null
              ) : (
                <Button
                  type="button"
                  autoFocus
                  aria-busy={entering || undefined}
                  disabled={entering}
                  className="max-sm:h-12"
                  onClick={props.onEnter}
                >
                  {entering ? <AppSpinner /> : null}
                  {entering
                    ? t("apps.join.entering")
                    : face === "failed"
                      ? t("apps.join.retry")
                      : t("apps.join.enter")}
                </Button>
              )}
            </div>
            <button
              type="button"
              aria-expanded={protectOpen}
              aria-controls={protectId}
              className="min-h-11 self-start text-xs text-text-secondary underline underline-offset-4 hover:text-text focus-visible:rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:min-h-0"
              onClick={() => setProtectOpen((value) => !value)}
            >
              {t("apps.join.protect")}
            </button>
          </div>
        )
      }
    >
      {quiet ? (
        <DialogBody>
          <span role="status" className="sr-only">
            {title}. {description}
          </span>
        </DialogBody>
      ) : (
        <DialogBody className="flex flex-col gap-4">
          {face === "failed" ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-card)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft"
            >
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {t(FAILURE_KEY[props.failure])}
            </div>
          ) : null}
          {face === "full" ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-[var(--radius-card)] bg-surface-3 px-3 py-2 text-sm text-text-secondary"
            >
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {props.canWatch ? t("apps.join.fullBodyWatch") : t("apps.join.fullBody")}
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <AppIconTile icon={app.icon} className="h-11 w-11 sm:h-11 sm:w-11" />
            <div className="min-w-0">
              <p className="text-xs text-text-tertiary">{t("apps.join.youAppearAs")}</p>
              <div className="mt-0.5 flex items-center gap-2">
                <UserAvatar
                  name={props.viewer.name}
                  avatarUrl={props.viewer.avatarUrl}
                  rounded="full"
                  className="h-6 w-6"
                  fallbackClassName="bg-surface-3 text-[10px] text-text-secondary"
                />
                <span className="truncate text-sm font-semibold text-text">
                  {props.viewer.name}
                </span>
              </div>
              <p className="text-xs text-text-tertiary">{t("apps.join.youLine")}</p>
            </div>
          </div>

          {face !== "full" ? (
            <ul className="flex flex-col gap-2 text-[13px] leading-5 text-text-secondary">
              <li className="flex items-start gap-3">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>
                  <b className="font-semibold text-text">{t("apps.join.seesLead")}</b>{" "}
                  {t("apps.join.sees")}
                </span>
              </li>
              {props.keepsOnDevice ? (
                <li className="flex items-start gap-3">
                  <HardDrive aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>
                    <b className="font-semibold text-text">{t("apps.join.keepsLead")}</b>{" "}
                    {t(props.keepsOnAccount ? "apps.join.keepsSynced" : "apps.join.keeps")}
                  </span>
                </li>
              ) : null}
              {props.keepsOnAccount ? (
                <li className="flex items-start gap-3" data-testid="app-join-account-line">
                  <Cloud aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>
                    <b className="font-semibold text-text">{t("apps.join.accountLead")}</b>{" "}
                    {t("apps.join.account")}
                  </span>
                </li>
              ) : null}
              <li className="flex items-start gap-3">
                <Ban aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
                <span>
                  <b className="font-semibold text-text">{t("apps.join.notLead")}</b>{" "}
                  {t("apps.join.not")}
                </span>
              </li>
              {app.notice ? (
                <li className="flex items-start gap-3">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
                  <span>{app.notice}</span>
                </li>
              ) : null}
            </ul>
          ) : null}

          {props.asksForId && face !== "full" ? (
            <div className="rounded-[var(--radius-card)] border border-border-strong bg-surface-1 p-1">
              <CheckRow
                checked={props.identityChecked}
                onCheckedChange={props.onIdentityChange}
                disabled={entering}
                label={t("apps.join.idLabel")}
                description={t("apps.join.idHint")}
              />
            </div>
          ) : null}

          {face !== "full" ? (
            <p className="text-xs leading-4 text-text-tertiary">{t("apps.join.sandbox")}</p>
          ) : null}

          {entering ? (
            <p role="status" className="text-xs text-text-secondary">
              {t("apps.join.opening")}
            </p>
          ) : null}

          <div
            id={protectId}
            hidden={!protectOpen}
            className={cn(
              "rounded-[var(--radius-card)] bg-surface-2 px-3 py-2 text-xs leading-5 text-text-secondary",
            )}
          >
            {t("apps.join.protectBody")}
          </div>
        </DialogBody>
      )}
    </Dialog>
  );
}
