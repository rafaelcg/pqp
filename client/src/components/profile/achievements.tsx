import { CACA_BUGS_BADGE, TURMA_1000_BADGE, type ProfileAchievement } from "@pqp/shared";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Earned marks — caça-bugs, Turma dos 1000. A chip row, not a tile in the
 * community grid: that grid is rooms somebody chose; an achievement is a
 * thing somebody did or was. Hides itself when empty so a profile with none
 * looks like it did before this existed.
 */

const ACHIEVEMENT_GLYPHS: Record<string, string> = {
  [CACA_BUGS_BADGE]: "🐛",
  [TURMA_1000_BADGE]: "✦",
};

export function achievementChipLabel(
  achievement: ProfileAchievement,
  t: Translator["t"],
): string {
  if (achievement.badge === TURMA_1000_BADGE && achievement.ordinal != null) {
    return t("publicProfile.achievements.turma1000.chip", {
      n: achievement.ordinal,
    });
  }
  return achievement.name;
}

function achievementTooltip(
  achievement: ProfileAchievement,
  t: Translator["t"],
): string | undefined {
  if (achievement.badge === CACA_BUGS_BADGE) {
    return t("publicProfile.achievements.cacaBugs");
  }
  if (achievement.badge === TURMA_1000_BADGE) {
    return t("publicProfile.achievements.turma1000");
  }
  return undefined;
}

export function Achievements({
  achievements,
  className,
}: {
  achievements: ProfileAchievement[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (achievements.length === 0) {
    return null;
  }
  return (
    <ul
      className={cn(
        "mt-4 flex flex-wrap gap-2",
        className,
      )}
      aria-label={t("publicProfile.achievements")}
    >
      {achievements.map((achievement) => (
        <li
          key={achievement.badge}
          title={achievementTooltip(achievement, t)}
          className="inline-flex items-center gap-1.5 rounded-full border border-signal/30 bg-signal/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-signal"
        >
          <span aria-hidden>
            {ACHIEVEMENT_GLYPHS[achievement.badge] ?? "⭐"}
          </span>
          {achievementChipLabel(achievement, t)}
        </li>
      ))}
    </ul>
  );
}
