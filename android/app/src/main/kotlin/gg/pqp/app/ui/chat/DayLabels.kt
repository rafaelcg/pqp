package gg.pqp.app.ui.chat

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * What the separator between two calendar days says.
 *
 * `Today` and `Yesterday` are words, so they come back as cases for the screen
 * to look up in resources; everything older is a date the platform can format
 * for the reader's locale, so it comes back already spelled out.
 */
sealed interface DayLabel {
    data object Today : DayLabel
    data object Yesterday : DayLabel
    data class Dated(val text: String) : DayLabel
}

/**
 * The day rows of a transcript, kept the same as the web's `formatDayLabel`
 * in `client/src/lib/utils.ts`.
 *
 * The rule there: "Today", "Yesterday", the weekday for anything inside the
 * last seven days, and a short date beyond that with the year only when it is
 * not this year. Pure, and reading the zone and the clock from the caller, so
 * the one place it can be wrong (a message sent at 23:58 read at 00:02) is
 * pinned by a test rather than by whoever is awake at midnight.
 */
object DayLabels {

    /** The calendar day a server timestamp lands on for this reader. */
    fun localDate(iso: String, zone: ZoneId): LocalDate? =
        runCatching { Instant.parse(iso).atZone(zone).toLocalDate() }.getOrNull()

    /**
     * Whether two timestamps fall on the same local day. False on a timestamp
     * that will not parse, which draws one separator too many rather than
     * silently gluing two days together.
     */
    fun isSameDay(a: String, b: String, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        val first = localDate(a, zone) ?: return false
        val second = localDate(b, zone) ?: return false
        return first == second
    }

    fun labelFor(
        iso: String,
        today: LocalDate = LocalDate.now(),
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): DayLabel? {
        val date = localDate(iso, zone) ?: return null
        val daysAgo = ChronoUnit.DAYS.between(date, today)
        return when (daysAgo) {
            0L -> DayLabel.Today
            1L -> DayLabel.Yesterday
            else -> DayLabel.Dated(
                format(
                    date = date,
                    // `< 7`, not `in 2..6`: the web spells out the weekday for
                    // anything less than a week old, which includes a clock
                    // that is slightly ahead of the server's.
                    withWeekday = daysAgo < 7,
                    withYear = date.year != today.year,
                    locale = locale,
                ),
            )
        }
    }

    /**
     * `toLocaleDateString` with `{ weekday, month: "short", day }` is what the
     * web renders, and there is no skeleton API in `java.time`, so the two
     * shapes the app ships are spelled out per language. Portuguese puts "de"
     * between the parts; everything else reads month first, the way the
     * English CLDR data does.
     */
    private fun format(date: LocalDate, withWeekday: Boolean, withYear: Boolean, locale: Locale): String {
        val portuguese = locale.language.equals("pt", ignoreCase = true)
        val pattern = buildString {
            if (withWeekday) append("EEEE, ")
            append(if (portuguese) "d 'de' MMM" else "MMM d")
            if (withYear) append(if (portuguese) " 'de' yyyy" else ", yyyy")
        }
        val text = DateTimeFormatter.ofPattern(pattern, locale).format(date)
        // Portuguese weekday and month names are lowercase in CLDR. A row that
        // stands on its own reads better with a capital, the way the web's
        // rendering of the same string does.
        return text.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }
    }
}
