import { Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/lib/i18n";

/**
 * "Public": the mark a server wears while strangers can walk into it.
 *
 * Drawn wherever the server is named (the top of its channel list), and the rail
 * carries the same word in its tooltip and accessible name. A word and an icon,
 * never a colour alone (DESIGN.md), and `Badge`'s own size so it reads as the
 * same signal everywhere. See `isServerPublic` for when it shows.
 */
export function PublicBadge({
  id,
  className,
}: {
  id?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Badge
      id={id}
      variant="accent"
      icon={Globe}
      data-public-badge=""
      className={className}
    >
      {t("chrome.publicCommunity")}
    </Badge>
  );
}
