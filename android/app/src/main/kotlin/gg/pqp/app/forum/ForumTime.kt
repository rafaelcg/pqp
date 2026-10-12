package gg.pqp.app.forum

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** How long ago, in the card's short form ("4 min", "2 h", "2 d", "12 set"). */
sealed interface Ago {
    data object Now : Ago
    data class Minutes(val n: Long) : Ago
    data class Hours(val n: Long) : Ago
    data class Days(val n: Long) : Ago

    /** A week or more: the date itself, already formatted. */
    data class Date(val text: String) : Ago
}

object ForumTime {
    fun ago(iso: String, now: Instant = Instant.now(), locale: Locale = Locale.getDefault()): Ago? {
        val at = runCatching { Instant.parse(iso) }.getOrNull() ?: return null
        val elapsed = Duration.between(at, now).coerceAtLeast(Duration.ZERO)
        return when {
            elapsed.toMinutes() < 1 -> Ago.Now
            elapsed.toHours() < 1 -> Ago.Minutes(elapsed.toMinutes())
            elapsed.toDays() < 1 -> Ago.Hours(elapsed.toHours())
            elapsed.toDays() < 7 -> Ago.Days(elapsed.toDays())
            else -> Ago.Date(
                DateTimeFormatter.ofPattern("d MMM", locale)
                    .withZone(ZoneId.systemDefault())
                    .format(at)
                    .removeSuffix("."),
            )
        }
    }
}
