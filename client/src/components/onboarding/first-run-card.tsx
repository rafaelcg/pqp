import { Check, ImagePlus, ServerIcon, UserPlus, X } from "lucide-react";
import {
  Camera,
  Check as CheckBold,
  UserPlus as UserPlusFill,
  UsersThree,
  X as XBold,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import type { CSSProperties } from "react";
import type { User } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { firstRunState, type FirstRunTaskId } from "@/lib/first-run";
import { cn } from "@/lib/utils";

/**
 * The three things a new account has not done yet, offered in the hub.
 *
 * WHY IT EXISTS. Onboarding hands somebody back to the app and the app opens on
 * the hub. For an account with no servers — which is every account that skipped
 * the wizard's last step, and every account that never had a reason not to — the
 * hub is the Friends view with "No friends here yet" in it. That is one of the
 * three things they need, and it is the *only* one the hub has ever mentioned:
 * `Create server` and `Join invite` live in the empty state for a selected
 * server, which an account with no servers can never select, so their only route
 * to a server was an unlabelled 40px `+` in the rail. The avatar was never
 * mentioned anywhere at all.
 *
 * WHY IT IS NOT A TOUR. A multi-step modal over an empty app teaches somebody the
 * layout of a room they have no reason to be in yet. These are three errands with
 * three buttons, in the place the errands get done, and every one of them can be
 * ignored. Nothing here blocks, nothing advances on a timer, and the whole thing
 * takes one click to be rid of forever.
 *
 * WHY THE DONE ROWS STAY. A row that vanishes on completion makes the card jump
 * and re-lays out the page under the cursor that just clicked. Ticked and dimmed
 * costs three lines and reads as progress rather than as the list shrinking.
 * When the third one ticks the whole card goes, which is the only disappearance
 * worth animating anything for.
 */

interface FirstRunCardProps {
  user: User;
  serverCount: number;
  friendCount: number;
  onCreateServer: () => void;
  onJoinServer: () => void;
  /** The Discord door: the create dialog, opened on the layout paste. */
  onImportDiscord?: () => void;
  onAddFriend: () => void;
  onPickAvatar: () => void;
  onDismiss: () => void;
}

interface RowSpec {
  id: FirstRunTaskId;
  icon: typeof ServerIcon;
  /** The filled glyph under the redesign. */
  glyph: PhosphorIcon;
  title: MessageKey;
  body: MessageKey;
  /** One to three buttons. The server row is the only one with more than one. */
  actions: { label: MessageKey; primary: boolean; onClick: () => void }[];
}

export function FirstRunCard({
  user,
  serverCount,
  friendCount,
  onCreateServer,
  onJoinServer,
  onImportDiscord,
  onAddFriend,
  onPickAvatar,
  onDismiss,
}: FirstRunCardProps) {
  const { t } = useTranslation();
  const { tasks } = firstRunState({ user, serverCount, friendCount });

  const rows: RowSpec[] = [
    {
      id: "server",
      icon: ServerIcon,
      glyph: UsersThree,
      title: "firstRun.server.title",
      body: "firstRun.server.body",
      actions: [
        { label: "firstRun.server.create", primary: true, onClick: onCreateServer },
        // The organizer who skipped the wizard had no way back to the import
        // from here except the + in the rail.
        ...(onImportDiscord
          ? [
              {
                label: "firstRun.server.import" as MessageKey,
                primary: false,
                onClick: onImportDiscord,
              },
            ]
          : []),
        { label: "firstRun.server.join", primary: false, onClick: onJoinServer },
      ],
    },
    {
      id: "friend",
      icon: UserPlus,
      glyph: UserPlusFill,
      title: "firstRun.friend.title",
      body: "firstRun.friend.body",
      actions: [
        { label: "firstRun.friend.action", primary: true, onClick: onAddFriend },
      ],
    },
    {
      id: "avatar",
      icon: ImagePlus,
      glyph: Camera,
      title: "firstRun.avatar.title",
      body: "firstRun.avatar.body",
      actions: [
        { label: "firstRun.avatar.action", primary: true, onClick: onPickAvatar },
      ],
    },
  ];

  const doneById = new Map(tasks.map((task) => [task.id, task.done]));

  return (
    <section
      data-first-run
      aria-labelledby="first-run-title"
      className="animate-rise mb-6 max-w-2xl rounded-2xl border border-ink-4 bg-ink-3/40 p-4 sm:p-5 redesign:rounded-[var(--radius-pane)] redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] sm:redesign:p-6"
    >
      <div className="mb-4 flex items-start gap-3 redesign:mb-6">
        <h2
          id="first-run-title"
          className="min-w-0 flex-1 font-display text-lg font-bold"
        >
          {t("firstRun.title")}
        </h2>
        <button
          type="button"
          data-first-run-dismiss
          onClick={onDismiss}
          aria-label={t("firstRun.dismiss")}
          title={t("firstRun.dismiss")}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-paper-muted transition-colors hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 redesign:-mr-1.5 redesign:-mt-1.5 redesign:inline-flex redesign:h-8 redesign:w-8 redesign:items-center redesign:justify-center redesign:rounded-full redesign:p-0 redesign:text-text-tertiary redesign:hover:bg-[color:var(--menu-row-hover)] redesign:hover:text-text redesign:focus-visible:ring-[color:var(--color-focus-ring)]"
        >
          <IconSwap off={X} on={XBold} kind="symbol" offClassName="h-4 w-4" className="h-4 w-4" />
        </button>
      </div>

      <ul className="space-y-3 redesign:space-y-5">
        {rows.map((row, index) => {
          const done = doneById.get(row.id) ?? false;
          const Icon = done ? Check : row.icon;
          return (
            <li
              key={row.id}
              data-first-run-task={row.id}
              data-done={done ? "true" : "false"}
              // Rows land one after another (70 ms apart, see `.animate-rise`),
              // which reads as a list arriving rather than a block appearing.
              style={{ "--stagger": index + 1 } as CSSProperties}
              className="animate-rise flex gap-3"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border redesign:-mt-1 redesign:h-8 redesign:w-8 redesign:border-0",
                  done
                    ? // Done is an outlined green token in dark, so it never reads as a
                      // to-do well; light keeps the plain green fill.
                      "border-success/40 bg-success/15 text-success redesign:bg-success/20 redesign:[:root:not([data-theme=light])_&]:bg-success/15 redesign:[:root:not([data-theme=light])_&]:ring-1 redesign:[:root:not([data-theme=light])_&]:ring-success/35"
                    : "border-ink-4 bg-ink text-signal redesign:bg-accent-soft redesign:text-on-accent-soft",
                )}
              >
                {done ? (
                  <IconSwap off={Check} on={CheckBold} kind="symbol" offClassName="h-4 w-4" className="h-4 w-4" />
                ) : (
                  <IconSwap off={Icon} on={row.glyph} offClassName="h-4 w-4" className="h-[18px] w-[18px]" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-semibold redesign:font-display redesign:text-[0.9375rem]",
                    // Under the redesign the check and "Feito" say done; no strike.
                    done && "text-paper-muted line-through decoration-1 redesign:text-text-tertiary redesign:no-underline",
                  )}
                >
                  {t(row.title)}
                </p>

                {done ? (
                  // No sales pitch for something already done, and no praise for
                  // it either. One quiet word that the row is settled.
                  <p className="mt-0.5 text-xs text-paper-muted redesign:mt-1 redesign:text-text-tertiary">
                    {t("firstRun.done")}
                  </p>
                ) : (
                  <>
                    {/* `break-words` is load-bearing on a phone: the friend row
                        prints a `name#0000` handle, which is one unbreakable
                        token up to 37 characters long, and at 390px a long one
                        ran off the edge of the card rather than wrapping. */}
                    <p className="mt-0.5 break-words text-sm text-paper-muted redesign:mt-1 redesign:leading-relaxed redesign:text-text-secondary">
                      {/* Only the friend row interpolates, and it wants the
                          reader's own tag — see the catalogue comment. */}
                      {t(row.body, { tag: user.tag ?? user.username ?? "" })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {row.actions.map((action) => (
                        <Button
                          key={action.label}
                          size="sm"
                          variant={action.primary ? "default" : "secondary"}
                          onClick={action.onClick}
                        >
                          {t(action.label)}
                        </Button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
