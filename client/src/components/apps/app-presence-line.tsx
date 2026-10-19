import { useAppPresenceLine } from "@/lib/apps/presence";

/**
 * The profile card's one-line status: the app they are in ("Raf tá na
 * Locadora") while they are in one, their recado the rest of the time. The
 * line stands alone on the card, so it reads as a sentence (`phrase`), not the
 * short label the member lists put under a name.
 *
 * Drawn the way the recado is drawn (two lines at most, centred) so the card
 * does not change shape when somebody opens an app.
 */
export function ProfileStatusLine({
  userId,
  displayName,
  customStatus,
}: {
  userId: string;
  displayName: string;
  customStatus: string | null | undefined;
}) {
  const appLine = useAppPresenceLine(userId, displayName, "phrase");
  if (appLine) {
    return (
      <p
        className="mt-1 line-clamp-2 text-center text-xs text-paper"
        data-profile-app-presence=""
      >
        {appLine}
      </p>
    );
  }
  if (!customStatus) {
    return null;
  }
  return (
    <p
      className="mt-1 line-clamp-2 text-center text-xs text-paper"
      data-profile-custom-status=""
    >
      {customStatus}
    </p>
  );
}
