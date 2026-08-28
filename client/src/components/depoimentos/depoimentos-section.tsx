import { Trash2 } from "lucide-react";
import type { Depoimento, ProfileCommunityList } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { communityOverflow, depoimentoDate } from "./depoimentos-model";

/**
 * The two blocks the profile card grew: the depoimentos somebody chose to
 * display, and the communities they are in.
 *
 * BOTH HIDE THEMSELVES WHEN EMPTY, and that is a rule rather than a style
 * choice. §05's risk list: people with zero depoimentos will feel it, and
 * popularity-counting is exactly the "auge ou ostracismo" dynamic Orkut's
 * reputation came from. So there is no "0 depoimentos" heading, no empty state,
 * no count anywhere except the subject's own queue — a card with nothing to
 * show looks precisely like a card from before this feature existed.
 */

interface DepoimentosSectionProps {
  depoimentos: Depoimento[];
  /**
   * Set only on your own card. The subject can take any published one down at
   * any time, without notice — which is what makes publishing safe to do.
   */
  onRemove?: (id: string) => void;
  busy?: boolean;
  /**
   * `plain` is the card's segmented pane: the tab already named this, so
   * another heading and a nested well would be a box in a box.
   */
  chrome?: "well" | "plain";
}

export function DepoimentosSection({
  depoimentos,
  onRemove,
  busy,
  chrome = "well",
}: DepoimentosSectionProps) {
  const { t, locale } = useTranslation();

  if (depoimentos.length === 0) {
    return null;
  }

  const plain = chrome === "plain";

  return (
    <section
      data-depoimentos=""
      aria-label={t("depoimentos.section")}
      className={
        plain ? undefined : "mt-3 overflow-hidden rounded-xl bg-ink-3/60"
      }
    >
      {!plain && (
        <h3 className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
          {t("depoimentos.section")}
        </h3>
      )}
      <ul className="divide-y divide-ink-4/50">
        {depoimentos.map((one) => (
          <li
            key={one.id}
            data-depoimento={one.id}
            className="group px-3 py-2.5"
          >
            {/* The words first and the byline under them, the way a quotation
                is set: a depoimento is the only thing on a profile written by
                somebody else, and burying it under a name would make it read
                as a message. */}
            <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-paper">
              {one.body}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="truncate text-[11px] text-paper-muted">
                {/* Author's handle when they have one: this is the byline, and
                    "bea#0192" is how the person is actually addressed. */}
                {one.author.tag ?? one.author.displayName},{" "}
                {depoimentoDate(one, locale)}
              </span>
              {onRemove && (
                <button
                  type="button"
                  disabled={busy}
                  data-depoimento-remove={one.id}
                  aria-label={t("depoimentos.remove", {
                    name: one.author.displayName,
                  })}
                  className="ml-auto shrink-0 rounded p-0.5 text-paper-muted opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => onRemove(one.id)}
                >
                  <Trash2 aria-hidden className="h-3 w-3" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface CommunityBadgesProps {
  communities: ProfileCommunityList;
  /** Opens the directory on that community, when the viewer has one. */
  onOpen?: (serverId: string) => void;
  chrome?: "well" | "plain";
}

/**
 * The communities this person shows, as a compact set of rooms in the same
 * grouped well as everything else on the card.
 *
 * Two tiles per row, and a name that may take two lines: the old 7rem chip
 * turned "Sala de Espera" into "Sala de Espe...", and a tile that is allowed
 * to wrap shows the whole name in the same footprint. The "icon" is the
 * server's initials, the same glyph the rail draws, since no server has an
 * uploaded image, which keeps a tile recognisable at a glance to somebody who
 * is already in that room.
 *
 * ONLY LISTED COMMUNITIES REACH HERE; the server filters, and a private server
 * can never appear. See `listProfileCommunities`.
 */
export function CommunityBadges({
  communities,
  onOpen,
  chrome = "well",
}: CommunityBadgesProps) {
  const { t } = useTranslation();
  const hidden = communityOverflow(communities);

  if (communities.communities.length === 0) {
    return null;
  }

  const plain = chrome === "plain";

  return (
    <section
      data-profile-communities={communities.total}
      aria-label={t("depoimentos.communities")}
      className={
        plain ? undefined : "mt-3 overflow-hidden rounded-xl bg-ink-3/60"
      }
    >
      {!plain && (
        <h3 className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
          {t("depoimentos.communities")}
        </h3>
      )}
      <ul className="grid grid-cols-2 gap-1 px-1.5 pb-1.5 pt-1">
        {communities.communities.map((one) => (
          <li key={one.id} className="min-w-0">
            <button
              type="button"
              data-profile-community={one.id}
              title={one.name}
              disabled={!onOpen}
              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-ink-3 focus-visible:bg-ink-3 focus-visible:outline-none disabled:pointer-events-none"
              onClick={() => onOpen?.(one.id)}
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-4 font-display text-[10px] font-bold uppercase text-paper"
              >
                {one.name.slice(0, 2)}
              </span>
              <span className="line-clamp-2 min-w-0 text-[11px] font-medium leading-tight text-paper">
                {one.name}
              </span>
            </button>
          </li>
        ))}
        {hidden !== null && (
          <li className="flex min-h-10 items-center px-1.5 text-[11px] font-medium text-paper-muted">
            {t("depoimentos.communities.more", { count: hidden })}
          </li>
        )}
      </ul>
    </section>
  );
}
