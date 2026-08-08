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
}

export function DepoimentosSection({
  depoimentos,
  onRemove,
  busy,
}: DepoimentosSectionProps) {
  const { t, locale } = useTranslation();

  if (depoimentos.length === 0) {
    return null;
  }

  return (
    <section
      data-depoimentos=""
      aria-label={t("depoimentos.section")}
      className="mt-3 border-t border-ink-4/60 pt-3"
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
        {t("depoimentos.section")}
      </h3>
      <ul className="mt-1.5 space-y-1.5">
        {depoimentos.map((one) => (
          <li
            key={one.id}
            data-depoimento={one.id}
            className="group rounded-md bg-ink-3/50 px-2 py-1.5"
          >
            {/* The words first and the byline under them, the way a quotation
                is set — a depoimento is the only thing on a profile written by
                somebody else, and burying it under a name would make it read as
                a message. */}
            <p className="whitespace-pre-wrap break-words text-xs text-paper">
              {one.body}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="truncate text-[11px] text-paper-muted">
                {/* Author's handle when they have one — this is the byline, and
                    "bea#0192" is how the person is actually addressed. */}
                — {one.author.tag ?? one.author.displayName},{" "}
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
}

/**
 * The community chips.
 *
 * Icon-and-name, at chip size, because they are a garnish on an identity block
 * and not a second list. The "icon" is the server's initials — the same glyph
 * the rail draws, since no server has an uploaded image — which keeps a chip
 * recognisable at a glance to somebody who is already in that room.
 *
 * ONLY LISTED COMMUNITIES REACH HERE; the server filters, and a private server
 * can never appear. See `listProfileCommunities`.
 */
export function CommunityBadges({
  communities,
  onOpen,
}: CommunityBadgesProps) {
  const { t } = useTranslation();
  const hidden = communityOverflow(communities);

  if (communities.communities.length === 0) {
    return null;
  }

  return (
    <section
      data-profile-communities={communities.total}
      aria-label={t("depoimentos.communities")}
      className="mt-3 border-t border-ink-4/60 pt-3"
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
        {t("depoimentos.communities")}
      </h3>
      <ul className="mt-1.5 flex flex-wrap gap-1">
        {communities.communities.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              data-profile-community={one.id}
              title={one.name}
              disabled={!onOpen}
              // Capped so two chips fit a row of the 288px card: a community
              // name is often long and a chip that claims the whole row turns
              // six of them into six lines, which is a list and not a garnish.
              className="flex max-w-[7rem] items-center gap-1 rounded-full bg-ink-3 py-0.5 pl-0.5 pr-2 text-[11px] text-paper hover:bg-ink-4 disabled:pointer-events-none"
              onClick={() => onOpen?.(one.id)}
            >
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ink-4 font-display text-[8px] font-bold uppercase"
              >
                {one.name.slice(0, 2)}
              </span>
              <span className="truncate">{one.name}</span>
            </button>
          </li>
        ))}
        {hidden !== null && (
          <li className="flex items-center rounded-full bg-ink-3 px-2 py-0.5 text-[11px] text-paper-muted">
            {t("depoimentos.communities.more", { count: hidden })}
          </li>
        )}
      </ul>
    </section>
  );
}
